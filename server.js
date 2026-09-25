/**
 * College Attendance System — Backend
 * -------------------------------------------------
 * Features:
 *  - Teacher generates a rotating 5-digit code (server-side, expires in 7 min)
 *  - Teacher can close a code early ("End code now") and see, for any past day,
 *    either the register, a present/absent list, or an attendance-% PDF
 *  - Server time is always used (client device time is never trusted)
 *  - One roll number can mark attendance only ONCE per class + subject +
 *    course type per day (DSC / SEC / GE / AEC / VAC / MDC of the same
 *    subject each count as a separate class)
 *  - All validation happens on the server, never trusting client JS
 *  - Data stored permanently in MongoDB (survives server restarts)
 *
 * ANTI-PROXY (fake attendance) PROTECTION:
 *  - Two-step marking: the phone first asks for a one-time location token and
 *    only receives one if the server itself confirms a fresh, accurate GPS fix
 *    INSIDE the classroom radius. mark-attendance then requires that token.
 *  - There is NO "give up and accept anyway" fallback (the old 15-attempt
 *    fallback was removed — it let anyone mark from home just by retrying).
 *  - A phone whose GPS is too imprecise is refused instead of trusted.
 *  - Optional manual-approval mode per session: every mark arrives as "pending"
 *    and only counts once the teacher approves it.
 *  - Suspicious entries (identical coordinates from different phones, 0 m / very
 *    poor accuracy, one device marking many roll numbers) are flagged and shown
 *    in the teacher's Review tab.
 *  - Teachers can manually mark a genuine student whose phone cannot get a fix.
 *
 * HOW TO RUN:
 *   1. npm install
 *   2. Set these environment variables (see the CONFIG block below):
 *        MONGODB_URI        — MongoDB Atlas connection string (required)
 *        TEACHER_PASSWORD   — password for the teacher page (strongly advised)
 *        RESEND_API_KEY     — enables automatic PDF emails
 *        TEACHER_EMAIL      — inbox that receives the PDFs
 *        CRON_SECRET        — locks down the two /api/check-and-send-* endpoints
 *        CLASSROOM_LAT / CLASSROOM_LNG / CLASSROOM_RADIUS_METERS
 *      Optional anti-proxy tuning:
 *        STRICT_LOCATION           (default true)  location check cannot be
 *                                  switched off from the teacher page
 *        MAX_ACCURACY_METERS       (default 60)    reject vaguer GPS fixes
 *        GEOFENCE_STRICT_CIRCLE    (default true)  distance + accuracy <= radius
 *        LOCATION_TOKEN_TTL_SEC    (default 150)   token lifetime
 *        REQUIRE_APPROVAL_DEFAULT  (default false) new sessions need approval
 *        TEACHER_MAX_FAILED_LOGINS (default 5) / TEACHER_LOCKOUT_MINUTES (15)
 *   3. node server.js
 *   4. Open http://localhost:3000/teacher.html   (for teacher)
 *      Open http://localhost:3000/student.html   (for student)
 *      Health check: http://localhost:3000/api/health
 */

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const PDFDocument = require("pdfkit");
const { Resend } = require("resend");
const dns = require("dns");
const crypto = require("crypto"); // used to hash one-time location tokens
dns.setDefaultResultOrder("ipv4first"); //render's IPv6 route to gmail is broken; force ipv4

// Body size limit for JSON requests. The roster upload posts a whole class in
// one request, so Express's 100kb default is too tight for a big college.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "2mb";

const app = express();
app.disable("x-powered-by"); // don't advertise the framework to the internet
app.set("trust proxy",1);
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Baseline security headers — no extra dependency (helmet) needed for these.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // The student page needs the phone's GPS; allow only our own origin to ask.
  res.setHeader("Permissions-Policy", "geolocation=(self)");
  // XSS purane browsers me bhi rokne ke liye (modern browsers CSP use karte hain).
  res.setHeader("X-XSS-Protection", "0"); // 0 = purana buggy filter off, CSP par bharosa
  // HTTPS par (Render ke peeche) 1 saal tak sirf HTTPS — MITM/downgrade attack band.
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Content Security Policy: sirf apni site ka code/style/font chale.
  // (teacher.html/student.html me inline onclick/script hain, isliye
  // 'unsafe-inline' chahiye — bahar ka koi script phir bhi load nahi ho sakta.)
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
    ].join("; ")
  );
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// DB down hone par /api routes se HTML error page ke bajaye saaf JSON mile
// (frontend ke liye "data side crash" jaisa kuch nahi hona chahiye).
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/health/")) return next();
  if (req.path === "/teacher/login") return next(); // login ko DB ki zaroorat nahi
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Database se connection nahi hai. Thodi der baad try karein — aapka data safe hai.",
      db: ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState] || "unknown",
    });
  }
  next();
});

// ---------- CONFIG ----------
const MONGODB_URI = process.env.MONGODB_URI;

// Simple shared password so only the teacher can generate codes / see attendance.
// Set this in Render's Environment tab. If not set, falls back to a default —
// change it via the environment variable for real use.
const DEFAULT_TEACHER_PASSWORD = "changeme123";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || DEFAULT_TEACHER_PASSWORD;

// Optional shared secret for the two cron-only endpoints
// (/api/check-and-send-pdfs and /api/check-and-send-monthly-report). Set
// CRON_SECRET in Render's Environment tab and either append ?secret=... to the
// cron-job.org URL or send an x-cron-secret header — then nobody else can
// trigger an email blast or burn the Resend quota. If it is left unset the
// endpoints stay reachable (so an existing cron keeps working) but a loud
// warning is printed at startup.
const CRON_SECRET = process.env.CRON_SECRET;

// Classroom GPS centre + allowed radius. Override with env vars on the server
// instead of editing code (Google Maps → right-click the spot → copy lat/long).
const CLASSROOM = {
  lat: Number(process.env.CLASSROOM_LAT) || 31.10648, // <-- set CLASSROOM_LAT
  lng: Number(process.env.CLASSROOM_LNG) || 77.15175, // <-- set CLASSROOM_LNG
};
const RADIUS_METERS = Number(process.env.CLASSROOM_RADIUS_METERS) || 150; // a bit generous, since network-based location
                            // (used for weak signal) is less precise than GPS
// How long after a code is generated the attendance PDF is auto-emailed
const PDF_EMAIL_DELAY_MS = 20 * 60 * 1000; // 20 minutes

// India Standard Time = UTC+5:30 (no daylight saving). Render's servers run in
// UTC, so every "today" / "start of day" / displayed time must be shifted to IST.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const IST_TIMEZONE = "Asia/Kolkata";

// Annual vs Semester system. Each has its own report window.
// (Attendance data ab 90 din tak rehta hai, isliye Semester ka window bhi 90
// hi hai — warna Semester report adhoori/khali aati.)
const REPORT_DAYS = { Annual: 30, Semester: 90 };
// Up to this many days the report shows the day-by-day P/A grid. Longer
// ranges (Annual/Semester) don't fit on a page as a grid, so they use a
// compact summary table instead.
const GRID_MAX_DAYS = 45;
// Attendance records are auto-deleted after this many days. Ab default 90 din
// hai: 2,500 marks/day x 90 = ~2.25 lakh docs ≈ 170 MB (data+index) — Atlas ke
// FREE M0 (512 MB) me bhi aaram se fit. Report windows (30/90 din) isi ke andar
// rehte hain. Purana TTL index boot par khud naya ban jata hai.
const ATTENDANCE_RETENTION_DAYS = Number(process.env.ATTENDANCE_RETENTION_DAYS) || 90;

// GPS proof na milne par student ko kitni koshish milti hai. Iske andar mark
// SAVE nahi hota — sirf student ko "Koshish X/5" dikhta hai — taki wo sach me
// GPS ON karne ki koshish kare. Poori koshishein khatam hone ke BAAD hi entry
// teacher ke paas (pending/approval) jati hai.
const LOCATION_ATTEMPTS_ALLOWED = Number(process.env.LOCATION_ATTEMPTS_ALLOWED) || 5;

// -----------------------------------------------------------------------
// DATA RETENTION (12 mahine wala rule)
// -----------------------------------------------------------------------
// Student ki identity data (name, class, major subject, email) aur
// device <-> roll number binding kitne din tak rakhi jaye: 365 din = 12 mahine.
// Ye ROLLING window hai — jab bhi us roll number par activity hoti hai
// (attendance mark, roster upload, name lookup, my-attendance), uska timer
// reset ho jata hai. Isliye padhai karne wale students kabhi delete nahi honge;
// sirf 12 mahine se bilkul inactive records hi hatenge.
const STUDENT_RETENTION_DAYS = Number(process.env.STUDENT_RETENTION_DAYS) || 365;
// Device <-> roll binding ka bhi wahi 12 mahine ka rolling window.
const DEVICE_LOCK_RETENTION_DAYS = Number(process.env.DEVICE_LOCK_RETENTION_DAYS) || STUDENT_RETENTION_DAYS;
// Audit log (kaun, kab, kya badla) — 2 saal, taki baad me bhi saboot rahe.
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 730;

// -----------------------------------------------------------------------
// ANTI-PROXY SETTINGS (fake attendance rokne ke liye)
// -----------------------------------------------------------------------
// STRICT mode: attendance sirf tab mark hoti hai jab server ne khud verify kar
// liya ho ki student classroom radius ke andar hai aur uska GPS fix bharosemand
// hai. Purana "15 baar fail hone par chup-chaap accept kar lo" wala fallback
// poori tarah HATA diya gaya hai — wahi proxy ka sabse bada darwaza tha.
const STRICT_LOCATION = boolWithDefault(process.env.STRICT_LOCATION, true);

// GPS accuracy (metres) jitni hum maan sakte hain. Network/wifi based location
// (cell tower / wifi) 1-3 km tak galat ho sakti hai, isliye badi accuracy ko
// trust karne ke bajaye reject kiya jaata hai.
const MAX_ACCURACY_METERS = Number(process.env.MAX_ACCURACY_METERS) || 60;

// true hone par poora GPS uncertainty circle radius ke andar hona chahiye
// (distance + accuracy <= radius) — sirf reported point nahi.
const GEOFENCE_STRICT_CIRCLE = boolWithDefault(process.env.GEOFENCE_STRICT_CIRCLE, true);

// Verified location token kitni der valid rahega (client usi window me submit kare).
const LOCATION_TOKEN_TTL_MS = (Number(process.env.LOCATION_TOKEN_TTL_SEC) || 150) * 1000;

// Sabse kam "asli" GPS accuracy. Asli phone ka GPS kabhi exactly 0 m nahi
// hota; mock/fake-location apps (aur devtools se chipkaya gaya fix) aksar
// 0 m ya 1 m se kam accuracy dete hain. Isse chhota fix = nakli, reject.
const MIN_REAL_ACCURACY_METERS = Number(process.env.MIN_REAL_ACCURACY_METERS) || 1;

// GPS fix itna purana nahi hona chahiye. Purana/cached fix = replay ka shak.
const MAX_FIX_AGE_MS = (Number(process.env.MAX_FIX_AGE_SEC) || 45) * 1000;

// Chrome DevTools / Selenium / Puppeteer jaise automation se aayi request:
// true hone par poori tarah BLOCK (403), warna sirf flag.
const BLOCK_AUTOMATION = boolWithDefault(process.env.BLOCK_AUTOMATION, true);

// Teacher login brute-force protection (galat password attempts).
const TEACHER_LOCKOUT_MINUTES = Number(process.env.TEACHER_LOCKOUT_MINUTES) || 15;
const TEACHER_MAX_FAILED_LOGINS = Number(process.env.TEACHER_MAX_FAILED_LOGINS) || 5;

// Code kitne minute zinda rahega — teacher in options me se chun sakta hai.
// Chhota window = code share hokar bahar use hone ka mauka kam.
const CODE_EXPIRY_OPTIONS_MIN = [2, 5, 7];

// Naya session by default manual-approval mode me khulega ya nahi (server-wide default).
const REQUIRE_APPROVAL_DEFAULT = boolWithDefault(process.env.REQUIRE_APPROVAL_DEFAULT, false);

// Ek bhi anti-proxy flag (mock location, shared coordinates, reused device,
// automation) lage to wo mark chup-chaap count nahi hoga — "pending" jayega
// aur teacher ke approve karne par hi register me judega. Ye ek chhoti class
// me bhi proxy ko bekaar bana deta hai.
// Ek bhi anti-proxy flag lage to wo mark chup-chaap count nahi hoga — "pending"
// jayega aur teacher ke approve karne par hi register me judega.
//
// SMART APPROVAL (default): location verified + koi flag nahi => SEEDHA PRESENT
// (teacher ko tap nahi karna padta). Sirf in cases me pending:
//   - location proof hi nahi mili (GPS fail / net off)  -> teacher approve kare
//   - is session me location check OFF tha               -> teacher approve kare
//   - koi anti-proxy flag laga                            -> teacher review kare
//   - teacher ne khud "approval mode" ON kiya             -> sab pending
const AUTO_REVIEW_FLAGGED = boolWithDefault(process.env.AUTO_REVIEW_FLAGGED, true);
const SMART_APPROVAL_DEFAULT = boolWithDefault(process.env.SMART_APPROVAL_DEFAULT, true);

// Teacher page se location check OFF karne ki permission. Agar aap ise false
// kar dein to location check server par hamesha ON rahega (purana strict
// behaviour) — koi teacher browser se ise band nahi kar payega.
const ALLOW_TEACHER_LOCATION_OFF = boolWithDefault(process.env.ALLOW_TEACHER_LOCATION_OFF, true);

// PDF auto-email ka default (teacher checkbox se per-session badal sakta hai).
const SEND_PDF_DEFAULT = boolWithDefault(process.env.SEND_PDF_DEFAULT, true);

// Student khud apna report (PDF) download kar sakta hai — by default OPEN hai
// (roll number daal kar), par rate-limited, aur sirf PDF (koi list/JSON nahi).
const STUDENT_PDF_OPEN = boolWithDefault(process.env.STUDENT_PDF_OPEN, true);

// Resend sends over HTTPS (not SMTP), so it isn't blocked on Render's free tier
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// DEFAULT inbox. Ye do kaam karta hai:
//   1) subject-wise mapping (teacher page > Data & Alerts > Email routing) me
//      jo subject set nahi hai, uska report yahan aata hai.
//   2) jis student ka apna email save nahi hai, uska report bhi yahan aata hai.
const TEACHER_EMAIL = process.env.TEACHER_EMAIL;

// College ka naam — PDF header aur email heading me chhapta hai.
const COLLEGE_NAME = process.env.COLLEGE_NAME || "College Attendance System";
// Email bhejne wala address. Apna domain Resend par verify karke
// EMAIL_FROM="Attendance <no-reply@yourcollege.in>" set kar sakte hain.
const EMAIL_FROM = process.env.EMAIL_FROM || "Attendance App <onboarding@resend.dev>";

// MongoDB storage quota (MB) — Data & Alerts tab "kitne din me full ho jayega"
// projection ke liye. Atlas M0 = 512 MB, M2 = 2048, M5 = 5120, M10 = 10240.
const MONGO_QUOTA_MB = Number(process.env.MONGO_QUOTA_MB) || 512;

// DB down hone par bhi process zinda rahe (crash-loop ke bajaye saaf 503 JSON).
// Default false = purana behaviour (turant exit) — production me isko true
// rakhna behtar hai taki ek network hiccup poori site na gira de.
const ALLOW_START_WITHOUT_DB = boolWithDefault(process.env.ALLOW_START_WITHOUT_DB, false);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!resend) {
  console.warn("RESEND_API_KEY not set — automatic PDF emails are disabled.");
}

if (TEACHER_PASSWORD === DEFAULT_TEACHER_PASSWORD) {
  console.warn("WARNING: TEACHER_PASSWORD is not set — the default password is in use.");
  console.warn("         Anyone who finds the teacher page link can generate codes and read the register.");
  console.warn("         Set the TEACHER_PASSWORD environment variable to a private password.");
}

if (!CRON_SECRET) {
  console.warn("WARNING: CRON_SECRET is not set — /api/check-and-send-pdfs and");
  console.warn("         /api/check-and-send-monthly-report can be triggered by anyone who knows the URL.");
  console.warn("         Set CRON_SECRET and add ?secret=... to your cron-job.org URLs to lock them down.");
}

if (ATTENDANCE_RETENTION_DAYS <= 120) {
  console.warn(`NOTE: attendance retention ${ATTENDANCE_RETENTION_DAYS} din hai — MongoDB is se purane`);
  console.warn("      saare marks ~60 second me delete kar dega. Purana data ka backup chahiye to");
  console.warn("      PEHLE ek baar chala lein:  node tools/backup-attendance.js");
}


if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI environment variable is not set.");
  console.error("Set it to your MongoDB Atlas connection string before starting the server.");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    if (ALLOW_START_WITHOUT_DB) {
      // Server chalu rahega; DB wale routes saaf-saaf 503 JSON denge aur
      // mongoose khud background me dobara connect karne ki koshish karta hai.
      console.error("ALLOW_START_WITHOUT_DB=true — server chalu rahega, DB routes 503 denge.");
      return;
    }
    console.error("Set ALLOW_START_WITHOUT_DB=true to keep the server up while the DB is down.");
    process.exit(1);
  });

// ---------- DATABASE MODELS ----------

// Remembers a student's name, class and major subject against their roll
// number, so it can auto-fill (and lock) next time — permanently, across any device.
// 12-mahine wala rule: `updatedAtDate` ek TTL field hai. Har activity par ye
// abhi ke time par refresh hota hai, isliye jo student padhai kar raha hai uska
// record kabhi delete nahi hota — sirf 365 din se inactive records MongoDB
// khud hata deta hai (name/class/email/device data sab saath me).
const studentSchema = new mongoose.Schema({
  roll_no: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  class_name: { type: String, default: "" },
  major_subject: { type: String, default: "" },
  // Optional student email. Isi par student ka apna report PDF jata hai;
  // na hone par DEFAULT email (TEACHER_EMAIL) par chala jata hai.
  email: { type: String, default: "" },
  updatedAtDate: { type: Date, default: Date.now, expires: STUDENT_RETENTION_DAYS * 24 * 60 * 60 },
});
// Reports register ko class-wise filter karte hain — isliye class par index.
studentSchema.index({ class_name: 1 });
const Student = mongoose.model("Student", studentSchema);

// A device is permanently bound to whichever roll number first uses it to
// mark attendance. Once bound, that device can never mark attendance as a
// different roll number — until a teacher unlocks it from the dashboard.
// Binding bhi 12 mahine ke rolling window me rehti hai (har use par refresh).
const deviceLockSchema = new mongoose.Schema({
  device_id: { type: String, required: true, unique: true },
  roll_no: { type: String, required: true },
  locked_at: Number,
  last_seen_at: Number, // last time this device marked/read something
  updatedAtDate: { type: Date, default: Date.now, expires: DEVICE_LOCK_RETENTION_DAYS * 24 * 60 * 60 },
});
const DeviceLock = mongoose.model("DeviceLock", deviceLockSchema);

// Prevents the automatic monthly combined-report email from being sent twice
// for the same month (e.g. if the server restarts or the cron pings us more
// than once around the 1st of the month).
const monthlyReportLogSchema = new mongoose.Schema({
  month: { type: String, required: true, unique: true }, // "YYYY-MM"
  sent_at: Number,
});
const MonthlyReportLog = mongoose.model("MonthlyReportLog", monthlyReportLogSchema);

// Subject-wise email routing. Teacher page se manage hota hai, code change ya
// redeploy ki zaroorat nahi. Match ka rule: subject zaroori, course_type/
// class_name optional ("khaali = sab"). Sabse specific match jeetta hai; koi
// match na mile to DEFAULT email (TEACHER_EMAIL) par report jati hai.
const emailSettingSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  course_type: { type: String, default: "" }, // "" = har course type
  class_name: { type: String, default: "" }, // "" = har class
  emails: { type: [String], default: [] },
  updated_at: Number,
});
emailSettingSchema.index({ subject: 1, course_type: 1, class_name: 1 }, { unique: true });
const EmailSetting = mongoose.model("EmailSetting", emailSettingSchema);

// Audit trail — kis teacher ne kab kya badla (delete/edit/manual mark/unlock/
// generate code/email settings). Isse data chupke se badalna pakda jata hai;
// entry sirf server likh sakta hai, teacher page se edit/delete nahi hoti.
const auditLogSchema = new mongoose.Schema({
  at: { type: Number, default: Date.now },
  action: { type: String, required: true },
  actor: { type: String, default: "" }, // IP (aur aage chale to teacher name)
  target: { type: String, default: "" },
  details: { type: String, default: "" },
  atDate: { type: Date, default: Date.now, expires: AUDIT_RETENTION_DAYS * 24 * 60 * 60 },
});
auditLogSchema.index({ at: -1 });
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

// Counts failed mark attempts per device per day — ab isme STUDENT ki detail
// bhi rehti hai (roll_no, naam, ASLI karan), taki teacher ko "kaun fail hua aur
// kyun" ki list mil sake aur wahin se present mark kar sake.
// Auto-deleted after 2 days (kal-parso ka bhi dikhta hai).
const locationAttemptSchema = new mongoose.Schema({
  device_id: { type: String, required: true },
  date: { type: String, required: true },
  // Ek din me ek student multiple subjects ke liye try kar sakta hai, isliye
  // attempts per SESSION (class|subject|course_type) ginte hain — Subject A me
  // 3 fail hone se Subject B ke koshish khatam nahi hote.
  session_key: { type: String, default: "" },
  roll_no: { type: String, default: "" },
  student_name: { type: String, default: "" },
  class_name: { type: String, default: "" },
  subject: { type: String, default: "" },
  course_type: { type: String, default: "" },
  // no_gps | denied | outside_radius | stale_fix | mock_location | automation |
  // net_off | expired_code | location_off | bad_fix_time
  reason: { type: String, default: "" },
  count: { type: Number, default: 0 },
  last_at: { type: Number, default: 0 },
  ignored: { type: Boolean, default: false }, // teacher ne "Ignore" dabaya
  resolved_at: { type: Number, default: 0 }, // teacher ne present mark kar diya
  resolved_by: { type: String, default: "" },
  createdAtDate: { type: Date, default: Date.now, expires: 2 * 24 * 60 * 60 },
});
locationAttemptSchema.index({ device_id: 1, date: 1, session_key: 1 }, { unique: true });
const LocationAttempt = mongoose.model("LocationAttempt", locationAttemptSchema);

const activeCodeSchema = new mongoose.Schema({
  code: String,
  class_name: String,
  subject: String,
  course_type: String, // DSC / SEC / GE / AEC / VAC / MDC — same subject under
                        // a different type is a different class, no clash
system: { type: String, enum: ["Annual", "Semester"], default: "Annual" }, // Annual / Semester system
require_location: {type: Boolean, default: true },
require_approval: { type: Boolean, default: false }, // teacher approves each mark (highest anti-proxy setting)
// SMART APPROVAL (default ON): location verified + koi flag nahi => seedha
// present. Fail/flag wale marks apne aap "pending" hote hain (teacher approve
// kare) — isliye teacher ko roz 60 bacchon par tap nahi karna padta.
auto_review: { type: Boolean, default: true },
send_pdf: { type: Boolean, default: true }, // auto-email attendance PDF 20 min after generation
pdf_sent: { type: Boolean, default: false }, // prevents sending twice if server restarts
  created_at: Number,
  expires_at: Number,
  // Real Date object used only to auto-delete old sessions, so the collection
  // does not grow forever (every generated code = one document).
  createdAtDate: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
});
const ActiveCode = mongoose.model("ActiveCode", activeCodeSchema);

// One-time proof that a device really was inside the classroom when it asked to
// mark attendance. The student's phone first sends its GPS fix to
// /api/student/location-token; only if the server itself confirms the fix is
// inside the radius (and accurate enough) does it hand back a random token.
// mark-attendance refuses to save anything without a matching, unused, unexpired
// token bound to the SAME device + session + code. That kills three common
// proxy tricks: replaying a copied request body, scripting the endpoint from
// home, and editing lat/lng in the browser's network tab.
const locationTokenSchema = new mongoose.Schema({
  token_hash: { type: String, required: true, unique: true }, // SHA-256 of the raw token
  device_id: { type: String, required: true },
  session_id: { type: String, required: true },
  code: String,
  lat: Number,
  lng: Number,
  accuracy: Number,
  distance_m: Number,
  ip: String,
  used: { type: Boolean, default: false },
  expires_at: Number,
  // Phone se aaye hint flags (advisory) + server ka automation detection.
  // Ye token ke saath mark-attendance tak carry hote hain, taki entry par
  // flag lag sake aur "flag wale mark auto-pending" rule kaam kare.
  hint_flags: { type: [String], default: [] },
  automation: { type: Boolean, default: false },
  createdAtDate: { type: Date, default: Date.now, expires: 30 * 60 }, // auto-clean after 30 min
});
const LocationToken = mongoose.model("LocationToken", locationTokenSchema);


const attendanceSchema = new mongoose.Schema({
  roll_no: String,
  student_name: String,
  subject: String,       // the subject actually being taught in this session (from the teacher's code)
  course_type: String,   // DSC / SEC / GE / AEC / VAC / MDC for this session
  system: { type: String, enum: ["Annual", "Semester"], default: "Annual" }, // Annual / Semester system
  major_subject: String, // the student's own primary/major subject (persisted, separate concept)
  class_name: String,    // course + year, e.g. "BA 1st"
  session_id: String,    // which code-generation session this attendance belongs to
  date: String,           // YYYY-MM-DD
  marked_at: Number,
  device_id: String,
  // ---- anti-proxy audit trail ----
  // "present" = counted. "pending" = location verified but the teacher is using
  // manual-approval mode, so it only counts after the teacher approves it.
  status: { type: String, enum: ["present", "pending"], default: "present" },
  // Pending hone ka ASLI karan (teacher ko dashboard par dikhta hai):
  // approval_mode | no_location_proof | location_check_off | flagged
  pending_reason: { type: String, default: "" },
  // Server ne is mark ke liye GPS proof verify kiya tha ya nahi.
  location_verified: { type: Boolean, default: false },
  // Exactly how the server verified presence (kept so a teacher can review and
  // spot anything suspicious later). distance_m/accuracy come from the one-time
  // location token, never straight from the client.
  lat: Number,
  lng: Number,
  accuracy: Number,
  distance_m: Number,
  ip: String,
  flags: { type: [String], default: [] }, // e.g. ["shared_coordinates","accuracy_poor"]
  source: { type: String, default: "student" }, // "student" | "teacher-manual"
  approved_at: Number,
  // Real Date object (separate from the display-only `date` string) used
  // purely to drive the 60-day auto-delete below.
  createdAtDate: { type: Date, default: Date.now },
});
// Same roll number can't mark attendance twice for the same
// class + subject + course type on the same day.
// (roll_no + subject + course_type + class_name + date, as requested)
// `system` is part of the key so the same roll number in the Annual and
// Semester systems never clash.
attendanceSchema.index(
  { roll_no: 1, class_name: 1, subject: 1, course_type: 1, system: 1, date: 1 },
  { unique: true }
);
// Live dashboard / session report / review in sab ke query patterns ke liye
// indexes — bina in ke collection badhne par queries slow (aur time-out) hone lagti hain.
attendanceSchema.index({ session_id: 1 });
attendanceSchema.index({ date: 1, class_name: 1 });
attendanceSchema.index({ device_id: 1, date: 1 });
attendanceSchema.index({ roll_no: 1, date: 1 });
// Auto-delete attendance records ATTENDANCE_RETENTION_DAYS (400) days after they were created. IMPORTANT:
// the monthly combined report (sent on/around the 1st of each month, covering
// the previous month) always runs well within this 60-day window, so the PDF
// is generated and emailed long before MongoDB deletes the underlying data.
attendanceSchema.index({ createdAtDate: 1 }, { expireAfterSeconds: ATTENDANCE_RETENTION_DAYS * 24 * 60 * 60 });
const Attendance = mongoose.model("Attendance", attendanceSchema);
// One-time cleanup: an old unique index (roll_no+class_name+period+date) is
// still sitting in the database from before subject/course_type existed.
// Mongoose never drops old indexes on its own, so it was silently blocking
// every second attendance for the same roll_no+class_name+date, no matter
// what subject/course_type the student picked. Drop it once at startup.
// One-time/maintenance cleanup at startup. Mongoose kabhi purane indexes khud
// nahi hatata, aur TTL window badalne par purana index chalta rehta hai —
// isliye har boot par "jo chahiye wahi hai kya" check karke sudhaar lete hain.
//
// TTL (auto-delete) ka matlab yahan:
//   Attendance   -> ATTENDANCE_RETENTION_DAYS (default 400) din
//   Student      -> STUDENT_RETENTION_DAYS (default 365 = 12 mahine, rolling)
//   DeviceLock   -> DEVICE_LOCK_RETENTION_DAYS (365 = 12 mahine, rolling)
//   AuditLog     -> AUDIT_RETENTION_DAYS (default 730 din)
// MongoDB TTL monitor har ~60 second me chalta hai, isliye delete halka-halka
// hota hai — server par koi load nahi padta.

// Ensures a TTL index exists with exactly the wanted window, and backfills the
// TTL field for documents created before this feature existed (a document
// without the field is NEVER auto-deleted by Mongo).
async function ensureTtlWindow(Model, field, seconds, label, backfill) {
  const indexes = await Model.collection.indexes().catch(() => []);
  for (const idx of indexes) {
    const k = idx.key || {};
    const sameField = k[field] !== undefined;
    const isTtl = idx.expireAfterSeconds !== undefined;
    if (sameField && isTtl && idx.expireAfterSeconds !== seconds) {
      await Model.collection.dropIndex(idx.name);
      console.log(`Dropped stale TTL index on ${label}:`, idx.name);
    }
  }
  if (backfill) {
    // Purane documents me ye field nahi hai — ek fixed date daal dete hain
    // (aaj), warna wo kabhi expire hi nahi hote.
    const res = await Model.updateMany({ [field]: { $exists: false } }, { $set: { [field]: new Date() } });
    if (res.modifiedCount) console.log(`Backfilled ${field} on ${res.modifiedCount} ${label} document(s)`);
  }
  await Model.createIndexes().catch((e) => console.error(`${label} index create failed:`, e.message));
}

mongoose.connection.once("open", async () => {
  try {
    const indexes = await Attendance.collection.indexes();
    const wantedTtl = ATTENDANCE_RETENTION_DAYS * 24 * 60 * 60;
    for (const idx of indexes) {
      const k = idx.key || {};
      const isOldPeriodIndex = k.period !== undefined;
      // Old unique index from before `system` existed — it would wrongly block
      // the same roll number in Annual vs Semester on the same day.
      const isOldUniqueWithoutSystem =
        idx.unique && k.roll_no !== undefined && k.date !== undefined && k.system === undefined;
      // Old 60-day TTL index — replaced by the longer retention window.
      const isOldTtl =
        k.createdAtDate !== undefined && idx.expireAfterSeconds !== undefined && idx.expireAfterSeconds !== wantedTtl;
      if (isOldPeriodIndex || isOldUniqueWithoutSystem || isOldTtl) {
        await Attendance.collection.dropIndex(idx.name);
        console.log("Dropped stale index:", idx.name);
      }
    }
    await Attendance.createIndexes(); // (re)create the current indexes from the schema

    // LocationAttempt: pehle unique index (device_id + date) tha. Ab attempts
    // per SESSION ginte hain, isliye (device_id + date + session_key) chahiye —
    // purana index hata do, warna ek din me dusre subject ke attempts clash.
    try {
      const attemptIndexes = await LocationAttempt.collection.indexes();
      for (const idx of attemptIndexes) {
        const k = idx.key || {};
        const stale =
          idx.unique &&
          k.device_id !== undefined &&
          k.date !== undefined &&
          k.session_key === undefined;
        if (stale) {
          await LocationAttempt.collection.dropIndex(idx.name);
          console.log("Dropped stale LocationAttempt index:", idx.name);
        }
      }
    } catch (e) {
      console.error("LocationAttempt index cleanup failed:", e.message);
    }
    await LocationAttempt.createIndexes().catch((e) => console.error("LocationAttempt index create failed:", e.message));

    // 12-mahine wala rolling retention (Student + DeviceLock) aur 2-saal ka
    // audit log. Pehli baar chalne par purane documents ka timer aaj se
    // shuru hota hai, uske baad ye sirf drift fix karta hai.
    await ensureTtlWindow(Student, "updatedAtDate", STUDENT_RETENTION_DAYS * 24 * 60 * 60, "Student", true);
    await ensureTtlWindow(DeviceLock, "updatedAtDate", DEVICE_LOCK_RETENTION_DAYS * 24 * 60 * 60, "DeviceLock", true);
    await ensureTtlWindow(AuditLog, "atDate", AUDIT_RETENTION_DAYS * 24 * 60 * 60, "AuditLog", false);
    await EmailSetting.createIndexes().catch(() => {});
  } catch (e) {
    console.error("Index cleanup failed:", e.message);
  }
});

// ---------- HELPERS ----------
// A Date shifted so that its getUTC*/toISOString values read as IST wall-clock.
function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function todayDateString() {
  // Uses SERVER date in IST, not client date and not UTC
  return istNow().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Same YYYY-MM-DD (IST) format as todayDateString(), but for any moment.
// Used so a PDF/email sent after midnight still shows the date of the class.
function istDateStringFromMs(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// First and last epoch ms of a YYYY-MM-DD IST day (end is exclusive).
function istDayRangeMs(dateStr) {
  const start = new Date(dateStr + "T00:00:00Z").getTime() - IST_OFFSET_MS;
  return { start, end: start + 86400000 };
}

// Validates an optional YYYY-MM-DD the teacher may pass to look at a past day.
// Malformed values, future dates and anything older than the retention window
// (the data is already deleted by then) are rejected with a clear message.
// No value at all → today, so existing callers keep working unchanged.
function parseReportDate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { date: todayDateString() };
  }
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { error: "date must be in YYYY-MM-DD format." };
  }
  const parsed = new Date(s + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) {
    return { error: "That is not a real calendar date." };
  }
  const today = todayDateString();
  if (s > today) {
    return { error: "Attendance cannot be shown for a future date." };
  }
  const oldestMs = new Date(today + "T00:00:00Z").getTime() - (ATTENDANCE_RETENTION_DAYS - 1) * 86400000;
  if (s < new Date(oldestMs).toISOString().slice(0, 10)) {
    return { error: `Attendance records older than ${ATTENDANCE_RETENTION_DAYS} days are deleted automatically.` };
  }
  return { date: s };
}

// Roll numbers are digits, but Mongo sorts them as text (so "99" > "100").
// Every list in this app is sorted with this comparator instead.
function compareRollNo(a, b) {
  const numA = parseFloat(a.roll_no);
  const numB = parseFloat(b.roll_no);
  if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
  return String(a.roll_no).localeCompare(String(b.roll_no));
}

// Checkbox-style flags sent as JSON. undefined/null/"" means "use the default",
// and "false"/"0"/"no"/"off" (strings) are understood too, so a client that
// stringifies booleans can't accidentally switch a safety check back on.
function boolWithDefault(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}

function formatIstTime(ms) {
  return new Date(ms).toLocaleTimeString("en-IN", { timeZone: IST_TIMEZONE, hour: "2-digit", minute: "2-digit" });
}

// Accepts "Annual" / "Semester" (any case). Missing/empty → "Annual" (older
// cached pages that don't send it yet). Anything else → null (invalid).
function normalizeSystem(raw) {
  if (raw === undefined || raw === null || raw === "") return "Annual";
  const s = String(raw).trim().toLowerCase();
  if (s === "annual") return "Annual";
  if (s === "semester") return "Semester";
  return null;
}

// Mongo filter value for `system`. Records saved before this feature existed
// have no `system` field at all — they were all Annual, so Annual also matches those.
function systemMatch(system) {
  return system === "Annual" ? { $in: ["Annual", null] } : system;
}

function generateCode() {
  return Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit code
}

// Returns the last n YYYY-MM-DD date strings (IST date, same convention
// as todayDateString), oldest first, ending today.
function lastNDates(n) {
  const dates = [];
  const now = istNow();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Returns every YYYY-MM-DD date in the previous calendar month, plus a
// "YYYY-MM" label for that month — used by the automatic monthly report.
function datesInPreviousMonth() {
  const now = istNow();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
  const year = lastOfPrevMonth.getUTCFullYear();
  const month = lastOfPrevMonth.getUTCMonth(); // 0-indexed, already "previous month"
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dates.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return { dates, label: `${year}-${String(month + 1).padStart(2, "0")}` };
}

// Haversine formula: distance (in meters) between two lat/long points
function distanceInMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
// ---------- RETENTION / AUDIT / EMAIL-ROUTING HELPERS ----------

// 12-mahine wale rolling timer ko refresh karta hai. Har activity par call
// hota hai (attendance mark, name lookup, my-attendance, roster upload) —
// isliye jo student roz aata hai uska data kabhi delete nahi hota, aur jo
// 12 mahine se gayab hai uska record apne aap hat jata hai.
// Ye best-effort hai: yahan fail hone par asli request kabhi na ruke.
async function touchStudentActivity(roll_no) {
  try {
    await Student.updateOne({ roll_no: String(roll_no) }, { $set: { updatedAtDate: new Date() } });
  } catch (e) {
    console.error("touchStudentActivity failed (non-fatal):", e.message);
  }
}

async function touchDeviceActivity(device_id, roll_no) {
  try {
    const set = { updatedAtDate: new Date(), last_seen_at: Date.now() };
    if (roll_no) set.roll_no = String(roll_no);
    await DeviceLock.updateOne({ device_id: String(device_id) }, { $set: set });
  } catch (e) {
    console.error("touchDeviceActivity failed (non-fatal):", e.message);
  }
}

// Audit trail (chupke se data badalna pakadne ke liye). Fire-and-forget —
// audit log likhne me dikkat aaye to asli kaam nahi rukna chahiye.
function audit(action, req, target, details) {
  try {
    AuditLog.create({
      action,
      actor: (req && (req.ip || "")) || "",
      target: target ? String(target).slice(0, 200) : "",
      details: details ? String(details).slice(0, 500) : "",
    }).catch((e) => console.error("Audit log write failed:", e.message));
  } catch (e) {
    console.error("Audit log write failed:", e.message);
  }
}

// Subject-wise email routing.
//   - setting.subject zaroori hai (exact, case-insensitive)
//   - course_type / class_name khali ("") = "har ek ke liye"
//   - sabse specific match jeetta hai; barabar specific wale sab mila diye jate hain
//   - kuch bhi match na ho -> DEFAULT email (TEACHER_EMAIL)
// Return: { emails: [...], source: "subject-mapping" | "default" }
async function resolveReportRecipients({ class_name, subject, course_type }) {
  const s = String(subject || "").trim().toLowerCase();
  const ct = String(course_type || "").trim().toLowerCase();
  const cn = String(class_name || "").trim().toLowerCase();
  const fallback = TEACHER_EMAIL ? [TEACHER_EMAIL] : [];

  if (!s) return { emails: fallback, source: "default" };
  try {
    const all = await EmailSetting.find({}).lean();
    const matching = all.filter((r) => {
      if (String(r.subject || "").trim().toLowerCase() !== s) return false;
      const rct = String(r.course_type || "").trim().toLowerCase();
      const rcn = String(r.class_name || "").trim().toLowerCase();
      if (rct && rct !== ct) return false;
      if (rcn && rcn !== cn) return false;
      return true;
    });
    if (matching.length) {
      const best = Math.max(...matching.map((r) => (r.course_type ? 2 : 0) + (r.class_name ? 1 : 0)));
      const emails = new Set();
      for (const r of matching) {
        if ((r.course_type ? 2 : 0) + (r.class_name ? 1 : 0) !== best) continue;
        (r.emails || []).forEach((e) => emails.add(String(e).trim()));
      }
      const list = [...emails].filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (list.length) return { emails: list, source: "subject-mapping" };
    }
  } catch (e) {
    console.error("Email routing lookup failed:", e.message);
  }
  return { emails: fallback, source: "default" };
}

// MongoDB storage ka asli hisaab + "kitne din me full hoga" projection.
// 500 students x 5 classes = 2500 marks/day par Atlas M0 (512 MB) kaise bharta
// hai — ye number teacher ko seedha dashboard par dikhta hai.
async function getStorageStats() {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const dbStats = await mongoose.connection.db.stats();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const [att, students, locks, sessions, mails, recentMarks] = await Promise.all([
      Attendance.estimatedDocumentCount(),
      Student.estimatedDocumentCount(),
      DeviceLock.estimatedDocumentCount(),
      ActiveCode.estimatedDocumentCount(),
      EmailSetting.estimatedDocumentCount(),
      Attendance.countDocuments({ createdAtDate: { $gte: since } }),
    ]);
    const dataSize = Number(dbStats.dataSize) || 0;
    const indexSize = Number(dbStats.indexSize) || 0;
    const objects = Number(dbStats.objects) || 0;
    const avgDocBytes = objects ? Math.round(dataSize / objects) : 0;
    const docsPerDay = Math.round(recentMarks / 14);
    const quotaBytes = MONGO_QUOTA_MB * 1024 * 1024;
    const usedBytes = dataSize + indexSize;
    const remainingBytes = Math.max(0, quotaBytes - usedBytes);
    const growPerDayBytes = docsPerDay * Math.max(avgDocBytes, 1);
    const daysLeft = growPerDayBytes > 0 ? Math.floor(remainingBytes / growPerDayBytes) : null;
    return {
      quota_mb: MONGO_QUOTA_MB,
      used_mb: Number((usedBytes / (1024 * 1024)).toFixed(2)),
      data_mb: Number((dataSize / (1024 * 1024)).toFixed(2)),
      index_mb: Number((indexSize / (1024 * 1024)).toFixed(2)),
      used_percent: Number(((usedBytes / quotaBytes) * 100).toFixed(1)),
      avg_doc_bytes: avgDocBytes,
      docs_per_day_estimate: docsPerDay,
      days_left_estimate: daysLeft,
      projected_full_date:
        daysLeft === null ? null : new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      counts: { attendance: att, students, device_locks: locks, sessions, email_settings: mails },
    };
  } catch (e) {
    console.error("Storage stats failed:", e.message);
    return null;
  }
}

// Email addresses ko screen/API par poora kabhi dikhaye bina mask kar dete hain
// (default inbox sujal... jaisa personal mail kisi ko nahi dikhna chahiye).
function maskEmail(address) {
  const value = String(address || "").trim();
  const at = value.indexOf("@");
  if (at <= 0) return value ? "hidden" : "";
  const name = value.slice(0, at);
  const domain = value.slice(at);
  const head = name.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, Math.min(6, name.length - 1)))}${domain}`;
}

function maskEmails(list) {
  return (Array.isArray(list) ? list : [list]).map((e) => maskEmail(e)).filter(Boolean);
}

// ETag-free simple IST stamp for short notes ("25-09-2026 10:24").
function istShortStamp(ms) {
  try {
    return new Date(ms).toLocaleString("en-IN", {
      timeZone: IST_TIMEZONE,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return String(ms);
  }
}

// Robots / automation (devtools script, Selenium, Puppeteer, curl) se aayi
// request. Browser se aane wali normal request me ye pattern nahi hota.
const AUTOMATION_UA_RE =
  /headless|phantomjs|puppeteer|playwright|selenium|webdriver|curl\/|wget\/|python-requests|python-urllib|node-fetch|axios\/|okhttp|go-http-client|libwww-perl|postmanruntime|insomnia/i;

function isAutomationRequest(req, clientHints) {
  const ua = String((req.headers && req.headers["user-agent"]) || "");
  if (AUTOMATION_UA_RE.test(ua)) return true;
  if (Array.isArray(clientHints) && clientHints.includes("webdriver")) return true;
  return false;
}

// Client (phone) se aane wale "hint" flags — ye ADVISORY hain, proof nahi.
// In par sirf flag lagta hai (aur AUTO_REVIEW_FLAGGED on hone par mark pending
// ho jata hai), kyunki client ko koi bhi cheez bolne ka haq hai.
const ALLOWED_CLIENT_HINT_FLAGS = ["webdriver", "mock_location_suspected", "screen_off", "devtools_suspected"];

function readClientHintFlags(body) {
  const raw = body && Array.isArray(body.client_flags) ? body.client_flags : [];
  const out = [];
  for (const f of raw) {
    const v = String(f || "").trim().slice(0, 40).toLowerCase();
    if (ALLOWED_CLIENT_HINT_FLAGS.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

// IST wall-clock "HH:MM" — dashboard/CSV ke liye.
function istHHMM(ms) {
  try {
    return new Date(ms).toLocaleTimeString("en-IN", { timeZone: IST_TIMEZONE, hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "--:--";
  }
}

// CSV ke liye safe cell (comma/quote/newline handle karta hai).
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------- GEOFENCE / ANTI-PROXY HELPERS ----------

// Kisi bhi value ko SHA-256 hex me badalta hai (location token store karne ke
// liye — DB me kabhi raw token nahi rakha jata).
function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Reads a GPS fix out of a request body and decides whether it is good enough
// to prove "this student is inside the classroom".
//  - Real numbers only, in valid lat/lng range.
//  - A reported accuracy is MANDATORY: wifi/cell based location can be 1-3 km
//    off, so an imprecise fix is refused instead of trusted.
//  - The whole uncertainty circle must fit inside the radius (distance +
//    accuracy <= radius) — otherwise "120 m away, ±200 m accuracy" would pass.
function readGpsFix(body) {
  const lat = typeof body.lat === "number" ? body.lat : parseFloat(body.lat);
  const lng = typeof body.lng === "number" ? body.lng : parseFloat(body.lng);
  const accuracyRaw = typeof body.accuracy === "number" ? body.accuracy : parseFloat(body.accuracy);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return {
      ok: false,
      code: "no_location",
      error: "Your location could not be read. Turn on GPS/Location for your browser, tap \"Get location again\" and try once more.",
    };
  }
  const accuracy = Number.isFinite(accuracyRaw) && accuracyRaw > 0 ? accuracyRaw : null;
  if (accuracy === null) {
    return {
      ok: false,
      code: "no_accuracy",
      error: "Your phone did not report an accurate location. Step near a window or outside for a moment, then try again.",
    };
  }
  if (accuracy > MAX_ACCURACY_METERS) {
    return {
      ok: false,
      code: "accuracy_too_low",
      error: `Your location is too imprecise (about ${Math.round(accuracy)} m off). Move near a window or an open area and try again — attendance needs a clear GPS fix.`,
    };
  }

  // MOCK / FAKE LOCATION CHECK.
  // Asli phone ka GPS kabhi itna precise nahi hota (1 metre se kam). Mock
  // location apps, "developer options > mock location", aur devtools se
  // chipkaye gaye fix aksar 0 m / 0.5 m accuracy dete hain. Aise fix par
  // attendance bilkul nahi banegi — pehla darwaza yahin band.
  if (accuracy < MIN_REAL_ACCURACY_METERS) {
    return {
      ok: false,
      code: "mock_location",
      error:
        "Your phone reported a location that a real GPS cannot produce (fake/mock location). Turn OFF any fake-location app or Developer options > Mock location, then try again.",
    };
  }

  // FIX FRESHNESS CHECK.
  // Phone se fix ka timestamp aata hai (pos.timestamp). Purana ya cache kiya
  // hua fix bhej kar (replay) attendance banane ka rasta band. Purane pages
  // jo timestamp nahi bhejte, unke liye ye step chhup-chaap skip ho jata hai
  // — baaki checks (token, radius) waise bhi lage rehte hain.
  const fixAt = Number(body.fix_timestamp);
  if (Number.isFinite(fixAt) && fixAt > 0) {
    const ageMs = Date.now() - fixAt;
    if (ageMs > MAX_FIX_AGE_MS) {
      return {
        ok: false,
        code: "stale_fix",
        error: "Your location reading is too old. Tap \"Get location again\" and submit immediately.",
      };
    }
    // Phone ki clock aage ho sakti hai, isliye sirf bahut bada future jump
    // (2 minute se zyada) hi reject karte hain — warna genuine students block ho jayenge.
    if (ageMs < -120000) {
      return {
        ok: false,
        code: "bad_fix_time",
        error: "Your phone's clock/time is out of sync. Set the date & time to automatic and try again.",
      };
    }
  }

  const distance = distanceInMeters(CLASSROOM.lat, CLASSROOM.lng, lat, lng);
  const effective = GEOFENCE_STRICT_CIRCLE ? distance + accuracy : distance;
  if (effective > RADIUS_METERS) {
    return {
      ok: false,
      code: "outside_radius",
      error: `You are not inside the classroom (about ${Math.round(distance)} m away). Attendance can only be marked from inside the class.`,
      distance,
    };
  }
  return { ok: true, lat, lng, accuracy, distance };
}

// ---------- MARK STATUS DECISION (pure function — unit-testable) ----------
// Mark "present" hoga ya "pending", ye EK hi jagah decide hota hai.
// tools/approval-logic-test.js isi function ko test karta hai.
const PENDING_REASON_TEXT = {
  approval_mode: "Approval mode ON — teacher approve karega",
  no_location_proof: "Location proof nahi mili (GPS fail / net off)",
  location_check_off: "Is session me location check OFF tha",
  flagged: "Anti-proxy flag laga — teacher review kare",
};

// Failure list me teacher ko Hinglish me ASLI karan dikhta hai.
const FAILURE_REASON_TEXT = {
  no_gps: "Location nahi mili (GPS band / weak signal)",
  denied: "Phone me location permission band hai",
  unsupported: "Is phone/browser me GPS support nahi hai",
  outside_radius: "Classroom radius se bahar tha",
  accuracy_too_low: "GPS fix bahut dhundhla tha",
  no_accuracy: "Phone ne accurate location nahi di",
  stale_fix: "Purani (cached) location bheji gayi",
  bad_fix_time: "Phone ka date/time galat set hai",
  mock_location: "Fake/mock location detect hui",
  automation_blocked: "DevTools/automation se try kiya",
  net_off: "Internet nahi tha (offline entry)",
  expired_code: "Code expire ho gaya tha",
  location_off: "Session me location check OFF tha",
};

function decideMarkStatus({ requireApproval, autoReview, locationRequired, locationVerified, flags }) {
  const activeFlags = Array.isArray(flags) ? flags.filter(Boolean) : [];
  // 1) Teacher ne khud approval mode ON kiya -> sab pending.
  if (requireApproval === true) return { status: "pending", reason: "approval_mode" };
  // 2) Location proof nahi mili (GPS fail / net off / is session me location off tha).
  if (!locationVerified) {
    return { status: "pending", reason: locationRequired ? "no_location_proof" : "location_check_off" };
  }
  // 3) Smart approval: location verify hui par koi flag laga hai -> pending.
  if (activeFlags.length && autoReview !== false) return { status: "pending", reason: "flagged" };
  // 4) Sab theek — seedha present (teacher ko tap nahi karna padta).
  return { status: "present", reason: "" };
}

// Ek "session" ki pehchaan — attempts isi par ginte hain (class|subject|course).
function failureSessionKey(class_name, subject, course_type) {
  return [class_name, subject, course_type].map((v) => String(v || "").trim().toLowerCase()).join("|");
}

// GPS proof na milne par: mark ko teacher ke paas (pending) jane dena hai ya
// student ko ek aur koshish deni hai? Ye EK jagah decide hota hai taaki
// student 1 tap me teacher ki list na bhar de (wahi bug tha).
function attemptsDecision(attemptsUsed, allowed) {
  const used = Math.max(0, Number(attemptsUsed) || 0);
  const limit = Math.max(1, Number(allowed) || LOCATION_ATTEMPTS_ALLOWED);
  return { allowPending: used >= limit, attemptsLeft: Math.max(0, limit - used) };
}

// Failed mark attempt ko DB me darj karta hai — teacher ki "location/net fail
// hue students" list isi se banti hai. Best-effort: yahan dikkat aaye to asli
// request kabhi na ruke.
async function recordMarkFailure({ device_id, roll_no, name, class_name, subject, course_type, reason }) {
  if (!device_id) return 0;
  try {
    const now = Date.now();
    const date = todayDateString();
    const session_key = failureSessionKey(class_name, subject, course_type);
    const set = { last_at: now, ignored: false, reason: String(reason || "no_gps").slice(0, 40), session_key };
    if (roll_no) set.roll_no = String(roll_no).slice(0, 30);
    if (name) set.student_name = String(name).slice(0, 80);
    if (class_name) set.class_name = String(class_name).slice(0, 40);
    if (subject) set.subject = String(subject).slice(0, 60);
    if (course_type) set.course_type = String(course_type).slice(0, 20);
    const doc = await LocationAttempt.findOneAndUpdate(
      { device_id, date, session_key },
      { $set: set, $inc: { count: 1 } },
      { upsert: true, setDefaultsOnInsert: true, new: true }
    );
    // Kitni koshish ho gayi — isi se decide hota hai ki mark ab teacher ke paas
    // jayega ya student ko ek aur koshish milegi.
    return doc && Number.isFinite(Number(doc.count)) ? Number(doc.count) : 1;
  } catch (e) {
    console.error("recordMarkFailure failed (non-fatal):", e.message);
    // DB dikkat de rahi ho to student ko block na karo — purana behaviour
    // (age limit lage hone par teacher ke paas) chalta rahe.
    return LOCATION_ATTEMPTS_ALLOWED;
  }
}

// Spots patterns that usually mean a faked or shared location. Nothing here
// blocks a student on its own — it tags the entry so the teacher can review it
// in the Review tab (and so approval mode has something to act on).
// `extraFlags` = client hints + automation flags jo route ne pehle hi detect kar liye.
async function computeAntiProxyFlags({ sessionId, device_id, roll_no, date, lat, lng, accuracy, extraFlags }) {
  const flags = [];
  if (Array.isArray(extraFlags)) {
    for (const f of extraFlags) if (f && !flags.includes(f)) flags.push(f);
  }
  if (!Number.isFinite(accuracy)) flags.push("accuracy_missing");
  else if (accuracy === 0) flags.push("accuracy_zero"); // a real GPS fix is never exactly 0 m
  else if (accuracy < 4) flags.push("accuracy_too_perfect"); // phone GPS itna shudh nahi hota
  else if (accuracy > 35) flags.push("accuracy_poor");

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const EPS = 0.00002; // ~2 metres
    const samePoint = await Attendance.findOne({
      session_id: sessionId,
      device_id: { $ne: device_id },
      lat: { $gte: lat - EPS, $lte: lat + EPS },
      lng: { $gte: lng - EPS, $lte: lng + EPS },
    }).lean();
    // Two different phones never report the exact same 5-decimal coordinate —
    // when they do, the same fix was almost certainly copied/handed around.
    if (samePoint) flags.push("shared_coordinates");
  }

  const reusedDevice = await Attendance.findOne({ date, device_id, roll_no: { $ne: roll_no } }).lean();
  if (reusedDevice) flags.push("device_used_for_other_roll");

  return flags;
}

// Builds a simple attendance-table PDF (as a Buffer) for one session.
function buildAttendancePdfBuffer(session, records) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).font("Helvetica-Bold").text(
      `Attendance Register — ${session.class_name} — ${session.subject} (${session.course_type}, ${session.system || "Annual"})`,
      { align: "center" }
    );
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica").fillColor("#555").text(
      `Date: ${session.dateForPdf}   |   Total present: ${records.length}`,
      { align: "center" }
    );
    doc.moveDown(1);
    doc.fillColor("#000");

    const startX = 40;
    const colWidths = [40, 150, 70, 110, 50, 80];
    const headers = ["S.No", "Name", "Roll No", "Subject", "Type", "Marked At"];

    function drawRow(values, y, bold) {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      let x = startX;
      values.forEach((v, i) => {
        doc.text(String(v), x, y, { width: colWidths[i] });
        x += colWidths[i];
      });
    }

    let y = doc.y;
    drawRow(headers, y, true);
    y += 18;
    doc.moveTo(startX, y - 4).lineTo(555, y - 4).strokeColor("#999").stroke();

    records.forEach((r, idx) => {
      if (y > 760) { doc.addPage(); y = 40; }
      drawRow(
        [idx + 1, r.student_name || "-", r.roll_no, r.subject || "-", r.course_type || "-", formatIstTime(r.marked_at)],
        y,
        false
      );
      y += 16;
    });

    doc.end();
  });
}

// Builds one row per student for one class+subject+course+system combination,
// over the given list of YYYY-MM-DD dates. Also returns how many distinct days
// a class was actually held (used as the denominator for long-range reports).
async function buildOverallReportRows(class_name, subject, course_type, system, dates) {
  const records = await Attendance.find({
    class_name,
    subject,
    course_type,
    system: systemMatch(system),
    date: { $in: dates },
    status: { $ne: "pending" }, // pending marks are not counted until approved
  }).lean();

  const classDays = new Set(records.map((r) => r.date)).size;
  // The denominator is ALWAYS the number of days this class was actually held.
  // Dividing by calendar days would drag every student's % down with Sundays,
  // holidays and vacations — and would make a 30-day report and a 365-day
  // report of the same student disagree wildly. Attended ÷ Held is also the
  // number a college actually asks for.
  const denominator = classDays;

  const byRoll = new Map();
  for (const r of records) {
    if (!byRoll.has(r.roll_no)) {
      byRoll.set(r.roll_no, { roll_no: r.roll_no, student_name: r.student_name, present: new Set() });
    }
    const entry = byRoll.get(r.roll_no);
    entry.present.add(r.date);
    if (r.student_name) entry.student_name = r.student_name; // keep most recent known name
  }

  const rows = Array.from(byRoll.values()).map((s) => {
    const totalPresent = s.present.size;
    const pct = denominator ? ((totalPresent / denominator) * 100).toFixed(1) : "0.0";
    return {
      roll_no: s.roll_no,
      student_name: s.student_name,
      dayMarks: dates.map((d) => (s.present.has(d) ? "P" : "A")),
      totalPresent,
      pct,
    };
  });

  rows.sort(compareRollNo);

  return { rows, classDays };
}

// Builds the landscape "N-day overall attendance %" PDF (as a Buffer) for one
// class+subject+course+system combination. Up to GRID_MAX_DAYS it shows the
// day-by-day P/A grid; beyond that (Annual = 365, Semester = 180 days) it
// shows a compact summary table, since that many columns can't fit on a page.
function buildOverallReportPdfBuffer(meta, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const grid = meta.dates.length <= GRID_MAX_DAYS;
    const sysLabel = meta.system ? ` (${meta.system})` : "";

    doc.fontSize(14).font("Helvetica-Bold").text(
      `${meta.dates.length}-Day Attendance % Report${sysLabel} — ${meta.class_name} — ${meta.subject} (${meta.course_type})`,
      { align: "center" }
    );
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica").fillColor("#555").text(
      `Period: ${meta.dates[0]} to ${meta.dates[meta.dates.length - 1]}   |   Classes held: ${meta.classDays || 0}   |   Students: ${rows.length}   |   % = attended / held`,
      { align: "center" }
    );
    doc.moveDown(0.8);
    doc.fillColor("#000");

    const startX = 30;

    if (!grid) {
      // ---- Summary table (long ranges) ----
      const cols = { sno: 35, name: 260, roll: 80, present: 110, held: 110, pct: 80 };
      function drawSummaryRow(y, bold, c) {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 9 : 8.5);
        let x = startX;
        doc.text(String(c.sno), x, y, { width: cols.sno }); x += cols.sno;
        doc.text(String(c.name), x, y, { width: cols.name }); x += cols.name;
        doc.text(String(c.roll), x, y, { width: cols.roll }); x += cols.roll;
        doc.text(String(c.present), x, y, { width: cols.present, align: "center" }); x += cols.present;
        doc.text(String(c.held), x, y, { width: cols.held, align: "center" }); x += cols.held;
        doc.text(String(c.pct), x, y, { width: cols.pct, align: "center" });
      }
      const header = { sno: "S.No", name: "Name", roll: "Roll No", present: "Classes Attended", held: "Classes Held", pct: "%" };
      let y = doc.y;
      drawSummaryRow(y, true, header);
      y += 16;
      doc.moveTo(startX, y - 4).lineTo(doc.page.width - 30, y - 4).strokeColor("#999").stroke();
      rows.forEach((r, idx) => {
        if (y > doc.page.height - 40) {
          doc.addPage();
          y = 30;
          drawSummaryRow(y, true, header);
          y += 16;
          doc.moveTo(startX, y - 4).lineTo(doc.page.width - 30, y - 4).strokeColor("#999").stroke();
        }
        drawSummaryRow(y, false, {
          sno: idx + 1,
          name: r.student_name || "-",
          roll: r.roll_no,
          present: r.totalPresent,
          held: meta.classDays || 0,
          pct: r.pct + "%",
        });
        y += 14;
      });
      doc.end();
      return;
    }

    // ---- Day-by-day grid (short ranges) ----
    const pageWidth = doc.page.width - 60;
    const fixed = { sno: 22, name: 110, roll: 45, total: 34, held: 30, pct: 34 };
    const fixedSum = fixed.sno + fixed.name + fixed.roll + fixed.total + fixed.held + fixed.pct;
    const dayColWidth = Math.max(10, (pageWidth - fixedSum) / meta.dates.length);

    function drawRow(y, bold, cells) {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 7 : 6.5);
      let x = startX;
      doc.text(String(cells.sno), x, y, { width: fixed.sno }); x += fixed.sno;
      doc.text(String(cells.name), x, y, { width: fixed.name }); x += fixed.name;
      doc.text(String(cells.roll), x, y, { width: fixed.roll }); x += fixed.roll;
      cells.days.forEach((d) => {
        doc.text(d, x, y, { width: dayColWidth, align: "center" });
        x += dayColWidth;
      });
      doc.text(String(cells.total), x, y, { width: fixed.total, align: "center" }); x += fixed.total;
      doc.text(String(cells.held), x, y, { width: fixed.held, align: "center" }); x += fixed.held;
      doc.text(String(cells.pct), x, y, { width: fixed.pct, align: "center" });
    }

    let y = doc.y;
    drawRow(y, true, {
      sno: "S.No",
      name: "Name",
      roll: "Roll No",
      days: meta.dates.map((d) => String(new Date(d + "T00:00:00Z").getUTCDate())),
      total: "Att.",
      held: "Held",
      pct: "%",
    });
    y += 14;
    doc.moveTo(startX, y - 3).lineTo(doc.page.width - 30, y - 3).strokeColor("#999").stroke();

    rows.forEach((r, idx) => {
      if (y > doc.page.height - 40) {
        doc.addPage();
        y = 30;
      }
      drawRow(y, false, {
        sno: idx + 1,
        name: r.student_name || "-",
        roll: r.roll_no,
        days: r.dayMarks,
        total: r.totalPresent,
        held: meta.classDays || 0,
        pct: r.pct + "%",
      });
      y += 13;
    });

    doc.end();
  });
}

// Generates every combo's report PDF for the given month and emails them all
// as ONE combined message. Idempotent via MonthlyReportLog — safe to call
// repeatedly (e.g. from a daily cron hit) without double-sending.
async function sendMonthlyCombinedReport() {
  const { dates, label } = datesInPreviousMonth();

  const already = await MonthlyReportLog.findOne({ month: label });
  if (already) return { skipped: true, reason: "already sent for " + label };

  if (!resend) {
    console.warn("Skipping monthly report — email is not configured.");
    return { skipped: true, reason: "email not configured" };
  }

  const combosAgg = await Attendance.aggregate([
    { $match: { date: { $in: dates }, status: { $ne: "pending" } } },
    { $group: { _id: { class_name: "$class_name", subject: "$subject", course_type: "$course_type", system: { $ifNull: ["$system", "Annual"] } } } },
  ]);
  const combos = combosAgg.map((c) => c._id);

  const attachments = [];
  for (const combo of combos) {
    const { rows, classDays } = await buildOverallReportRows(combo.class_name, combo.subject, combo.course_type, combo.system, dates);
    if (!rows.length) continue;
    const pdfBuffer = await buildOverallPdf(
      { class_name: combo.class_name, subject: combo.subject, course_type: combo.course_type, system: combo.system, dates, classDays },
      rows
    );
    attachments.push({
      filename: `${label}-${combo.class_name}-${combo.subject}-${combo.course_type}-${combo.system}.pdf`.replace(/\s+/g, "_"),
      content: pdfBuffer,
    });
  }

  if (!attachments.length) {
    await MonthlyReportLog.create({ month: label, sent_at: Date.now() });
    return { skipped: true, reason: "no attendance data for " + label };
  }

  // Monthly report sab configured inboxes par jata hai: subject-wise mapping
  // wale saare emails + DEFAULT email (dedupe karke). Koi email configure na
  // ho to sendReportEmail saaf error deta hai (silent fail nahi).
  const allSettings = await EmailSetting.find({}).lean().catch(() => []);
  const monthlyRecipients = [
    ...new Set(
      [
        ...allSettings.flatMap((s) => s.emails || []),
        ...(TEACHER_EMAIL ? [TEACHER_EMAIL] : []),
      ]
        .map((e) => String(e || "").trim())
        .filter(Boolean)
    ),
  ];

  const monthlySent = await sendReportEmail({
    to: monthlyRecipients,
    subject: `Monthly Attendance Reports — ${label}`,
    text: `Attached: ${attachments.length} attendance report(s) covering ${label}, one PDF per class/subject/course-type/system combination.`,
    attachments,
  });
  if (!monthlySent.ok) throw new Error(monthlySent.error || "Email send failed");
  await MonthlyReportLog.create({ month: label, sent_at: Date.now() });
  console.log(`Monthly combined report emailed for ${label} (${attachments.length} attachment(s))`);
  return { sent: true, month: label, count: attachments.length, recipients: monthlySent.recipients };
}


// Generates the PDF for a session and emails it to TEACHER_EMAIL.
async function sendAttendancePdfEmail(sessionId) {
  let claimed = false;
  try {
    if (!resend) {
      console.warn(`Skipping PDF email for session ${sessionId} — email is not configured.`);
      return;
    }
    // Atomically claim this session, so the setTimeout and the cron endpoint
    // can never both send the same PDF.
    const session = await ActiveCode.findOneAndUpdate(
      { _id: sessionId, send_pdf: true, pdf_sent: false },
      { pdf_sent: true },
      { new: true }
    );
    if (!session) return;
    claimed = true;

    // Only counted (non-pending) marks go on the emailed PDF.
    const records = await Attendance.find({ session_id: sessionId, status: { $ne: "pending" } }).lean();
    records.sort(compareRollNo);

    // Subject-wise routing: is subject ke liye email set hai to wahan, warna
    // DEFAULT email (TEACHER_EMAIL) par. Dono na ho to sendReportEmail saaf
    // error deta hai aur session wapas "un-claimed" ho jata hai (cron retry).
    const routing = await resolveReportRecipients({
      class_name: session.class_name,
      subject: session.subject,
      course_type: session.course_type,
    });

    const dateForPdf = istDateStringFromMs(session.created_at || Date.now());
    const pdfBuffer = await buildSessionPdf({ ...session.toObject(), dateForPdf }, records);

    // Email body me sirf "PDF attached" nahi — analytics summary bhi jati hai.
    const mod = getPdfReports();
    const analytics = typeof mod.computeSessionAnalytics === "function" ? mod.computeSessionAnalytics(records, {}) : null;
    const html =
      typeof mod.buildReportEmailHtml === "function"
        ? mod.buildReportEmailHtml({
            title: "Attendance Register",
            subtitle: `${session.class_name} — ${session.subject} (${session.course_type}, ${session.system || "Annual"}) — ${dateForPdf}`,
            collegeName: COLLEGE_NAME,
            kpis: [
              { label: "Present", value: records.length, tone: "green" },
              {
                label: "Flagged",
                value: analytics ? analytics.flagged_count : 0,
                tone: analytics && analytics.flagged_count ? "red" : "green",
              },
              {
                label: "Avg accuracy",
                value: analytics && analytics.avg_accuracy ? Math.round(analytics.avg_accuracy) + " m" : "-",
                tone: "sky",
              },
              { label: "Devices", value: analytics ? analytics.device_count : 0, tone: "sky" },
            ],
            analyticsRows: analytics
              ? [
                  { label: "First mark", value: analytics.first_marked_at ? istHHMM(analytics.first_marked_at) : "-" },
                  { label: "Last mark", value: analytics.last_marked_at ? istHHMM(analytics.last_marked_at) : "-" },
                  {
                    label: "Closest / farthest",
                    value: `${Math.round(analytics.min_distance_m || 0)} m / ${Math.round(analytics.max_distance_m || 0)} m`,
                  },
                  { label: "Email routed", value: routing.source === "subject-mapping" ? "subject-wise mapping" : "default inbox" },
                ]
              : [],
            riskRows: analytics
              ? analytics.risk_rows.slice(0, 10).map((r) => ({
                  roll_no: r.roll_no,
                  name: r.student_name,
                  detail: (r.flags || []).join(", "),
                }))
              : [],
            bottomRows: [],
            footerNote:
              "Ye report code generate hone ke 20 minute baad automatically bheji gayi hai. Pending (approval ka intezaar) marks is PDF me count nahi hote.",
            generatedAt: Date.now(),
          })
        : null;

    const sent = await sendReportEmail({
      to: routing.emails,
      subject: `Attendance — ${session.class_name} — ${session.subject} (${session.course_type}, ${session.system || "Annual"}) — ${dateForPdf}`,
      text: `Attached: attendance for ${session.class_name} — ${session.subject} (${session.course_type}) on ${dateForPdf}. ${records.length} student(s) marked present${
        analytics && analytics.flagged_count ? `, ${analytics.flagged_count} flagged for review` : ""
      }. Email route: ${routing.source === "subject-mapping" ? "subject-wise mapping" : "default inbox"}.`,
      html,
      attachments: [
        {
          filename: `attendance-${session.class_name}-${session.subject}-${session.course_type}-${dateForPdf}.pdf`.replace(/\s+/g, "_"),
          content: pdfBuffer,
        },
      ],
    });
    if (!sent.ok) throw new Error(sent.error || "Email send failed");
    console.log(`Attendance PDF emailed for session ${sessionId} to ${sent.recipients.join(", ")}`);
  } catch (err) {
    console.error(`Failed to email attendance PDF for session ${sessionId}:`, err.message);
    // Un-claim so the cron retries it later
    if (claimed) await ActiveCode.updateOne({ _id: sessionId }, { pdf_sent: false }).catch(() => {});
  }
}

// ---------- ADVANCED PDF + EMAIL REPORTS ----------
// `lib/pdf-reports.js` (naya analytics-rich PDF module) available ho to wahi
// use hota hai; nahi ho to purane simple builder par fallback — taki module
// missing/error hone par reporting bilkul band na ho jaye.
let pdfReportsModule = null;
function getPdfReports() {
  if (pdfReportsModule) return pdfReportsModule;
  try {
    pdfReportsModule = require("./lib/pdf-reports");
  } catch (e) {
    console.warn("lib/pdf-reports.js load nahi hua — purane simple PDF par fallback:", e.message);
    pdfReportsModule = {};
  }
  return pdfReportsModule;
}

function pdfOpts(extra) {
  return Object.assign({ collegeName: COLLEGE_NAME, generatedAt: Date.now() }, extra || {});
}

async function buildSessionPdf(session, records) {
  const mod = getPdfReports();
  if (typeof mod.buildSessionPdfBuffer === "function") {
    try {
      return await mod.buildSessionPdfBuffer(session, records, pdfOpts());
    } catch (e) {
      console.error("Advanced session PDF fail hua, purana use kar rahe hain:", e.message);
    }
  }
  return buildAttendancePdfBuffer(session, records);
}

async function buildOverallPdf(meta, rows) {
  const mod = getPdfReports();
  if (typeof mod.buildOverallReportPdfBuffer === "function") {
    try {
      return await mod.buildOverallReportPdfBuffer(meta, rows, pdfOpts());
    } catch (e) {
      console.error("Advanced overall PDF fail hua, purana use kar rahe hain:", e.message);
    }
  }
  return buildOverallReportPdfBuffer(meta, rows);
}

// Student ka personal report PDF (single student, subject-wise). Module na ho
// to purane session-PDF builder se simple report ban jati hai.
async function buildStudentPdf(meta, student, rows) {
  const mod = getPdfReports();
  if (typeof mod.buildStudentReportPdfBuffer === "function") {
    try {
      return await mod.buildStudentReportPdfBuffer(meta, student, rows, pdfOpts());
    } catch (e) {
      console.error("Student report PDF fail hua, simple fallback:", e.message);
    }
  }
  const fakeRecords = rows.map((r, i) => ({
    student_name: student.name || "",
    roll_no: student.roll_no || "",
    subject: r.subject,
    course_type: `${r.course_type} (${r.attended}/${r.held} = ${r.pct}%)`,
    marked_at: Date.now() - i * 1000,
  }));
  return buildAttendancePdfBuffer(
    {
      class_name: student.class_name || "-",
      subject: "Overall attendance",
      course_type: meta.system || "Annual",
      system: meta.system || "Annual",
      dateForPdf: istDateStringFromMs(Date.now()),
    },
    fakeRecords
  );
}

// Ek hi jagah se email bhejna: recipients, HTML body + text, attachments,
// aur saaf error handling (throw nahi — {ok:false, error} return).
async function sendReportEmail({ to, subject, text, html, attachments }) {
  if (!resend) return { ok: false, error: "RESEND_API_KEY set nahi hai — automatic email band hai." };
  const recipients = (Array.isArray(to) ? to : [to]).map((e) => String(e || "").trim()).filter(Boolean);
  if (!recipients.length) {
    return { ok: false, error: "Koi email address configured nahi hai (TEACHER_EMAIL ya subject mapping set karein)." };
  }
  try {
    const payload = { from: EMAIL_FROM, to: recipients, subject, text };
    if (html) payload.html = html;
    if (attachments && attachments.length) payload.attachments = attachments;
    const { error } = await resend.emails.send(payload);
    if (error) throw new Error(error.message || "Resend rejected the email");
    return { ok: true, recipients };
  } catch (e) {
    console.error("Email send failed:", e.message);
    return { ok: false, error: e.message };
  }
}


// ---------- TEACHER AUTH ----------
// A simple shared password, sent as a header on every teacher request.
// Keeps random people who find the link from generating codes or seeing attendance.
// Wrong passwords are rate-limited per IP: without this, someone could sit and
// brute-force the password and then read (or delete) the whole register.
const teacherLoginAttempts = new Map(); // ip -> { fails, lockedUntil }

// Password ko constant-time compare karna (timing attack se bachne ke liye).
// Dono taraf SHA-256 lagakar length bhi barabar kar dete hain, kyunki
// crypto.timingSafeEqual alag length par throw karta hai.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a === undefined || a === null ? "" : a)).digest();
  const hb = crypto.createHash("sha256").update(String(b === undefined || b === null ? "" : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- TEACHER SESSION TOKEN ----------
// Har request me password bhejne ki zaroorat nahi: ek baar login karo, phir ek
// signed token use karo. Token HMAC-SHA256 se banta hai (secret = password se
// nikalta hai), isliye koi usko na ban kar sakta hai na badal kar — aur 12
// ghante me khud expire ho jata hai (leaked token hamesha ke liye kaam nahi karega).
const TEACHER_TOKEN_TTL_MS = (Number(process.env.TEACHER_TOKEN_TTL_HOURS) || 12) * 60 * 60 * 1000;
const TEACHER_TOKEN_SECRET = crypto
  .createHash("sha256")
  .update(`${TEACHER_PASSWORD}|teacher-token-v1|${process.env.TOKEN_SALT || "default-salt"}`)
  .digest("hex");

function makeTeacherToken() {
  const payload = `v1.${Date.now() + TEACHER_TOKEN_TTL_MS}`;
  const sig = crypto.createHmac("sha256", TEACHER_TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyTeacherToken(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [v, exp, sig] = parts;
  if (v !== "v1") return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= Date.now()) return false;
  const expected = crypto.createHmac("sha256", TEACHER_TOKEN_SECRET).update(`v1.${exp}`).digest("hex");
  return safeEqual(sig, expected);
}

// Login: password check karke token deta hai. Purane teacher pages jo har
// request me password bhejte hain, wo bhi chalta rahega (neeche fallback).
app.post("/api/teacher/login", async (req, res) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const state = teacherLoginAttempts.get(ip);
  if (state && state.lockedUntil > now) {
    const mins = Math.ceil((state.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many wrong password attempts. Try again in ${mins} minute(s).` });
  }
  const provided = req.body && req.body.password;
  if (!safeEqual(provided, TEACHER_PASSWORD)) {
    const fails = (state && state.lockedUntil <= now ? state.fails : 0) + 1;
    const locked = fails >= TEACHER_MAX_FAILED_LOGINS;
    teacherLoginAttempts.set(ip, {
      fails: locked ? 0 : fails,
      lockedUntil: locked ? now + TEACHER_LOCKOUT_MINUTES * 60000 : 0,
    });
    audit("teacher.login.failed", req, "", "wrong password");
    return res.status(401).json({
      error: locked
        ? `Too many wrong password attempts. Locked for ${TEACHER_LOCKOUT_MINUTES} minute(s).`
        : "Incorrect teacher password.",
    });
  }
  if (state) teacherLoginAttempts.delete(ip);
  audit("teacher.login", req, "", "login ok");
  res.json({
    ok: true,
    token: makeTeacherToken(),
    expires_in_seconds: Math.round(TEACHER_TOKEN_TTL_MS / 1000),
    server_now: now,
  });
});

function requireTeacherAuth(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const state = teacherLoginAttempts.get(ip);

  // 1) Naya tarika: 12-ghante ka signed token.
  const token = req.headers["x-teacher-token"];
  if (token) {
    if (verifyTeacherToken(token)) return next();
    return res.status(401).json({ error: "Teacher session expire ho gaya — dobara sign in karein." });
  }

  if (state && state.lockedUntil > now) {
    const mins = Math.ceil((state.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many wrong password attempts. Try again in ${mins} minute(s).` });
  }

  // 2) Purana tarika (backward compatible): password header.
  const provided = req.headers["x-teacher-password"];
  if (!safeEqual(provided, TEACHER_PASSWORD)) {
    const fails = (state && state.lockedUntil <= now ? state.fails : 0) + 1;
    const locked = fails >= TEACHER_MAX_FAILED_LOGINS;
    teacherLoginAttempts.set(ip, {
      fails: locked ? 0 : fails,
      lockedUntil: locked ? now + TEACHER_LOCKOUT_MINUTES * 60000 : 0,
    });
    return res.status(401).json({
      error: locked
        ? `Too many wrong password attempts. Locked for ${TEACHER_LOCKOUT_MINUTES} minute(s).`
        : "Incorrect teacher password.",
    });
  }

  if (state) teacherLoginAttempts.delete(ip);
  next();
}

// ---------- RATE LIMITING ----------
// Keyed by device_id AND IP together. The old version used only the
// client-supplied device_id, which a script could simply randomise on every
// request to bypass the limiter completely. Now every request is counted
// against both, so a randomised device_id no longer buys anything.
const combinedKey = (req) => {
  const device = (req.body && req.body.device_id) || (req.query && req.query.device_id) || "nodevice";
  return `${device}|${req.ip || "noip"}`;
};

const markAttendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // generous: a whole class marking on shared WiFi must never be cut off
  statusCode: 500, // matches the app's ordinary error status — 429 would give it away
  message: { error: "Something went wrong. Try again." },
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: combinedKey,
});

// Location verification gets its own, more forgiving limiter (students genuinely
// retry GPS a few times when a signal is weak) — but still bounded, so the
// endpoint can't be hammered by a script trying to guess its way in.
const locationTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  statusCode: 429,
  message: { error: "Too many location checks. Please wait a minute and try again." },
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: combinedKey,
});

const generateCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // teachers may generate several codes across periods
  statusCode: 500,
  message: { error: "Something went wrong. Try again." },
  standardHeaders: false,
  legacyHeaders: false,
});

const studentLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Was 80 per IP — a whole college behind one NAT/WiFi IP would trip it and
  // lock out genuine students. Keyed per device+IP now and set much higher.
  max: 300,
  statusCode: 429,
  message: { error: "Too many lookups. Please wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- TEACHER ROUTES ----------

// Generate a new attendance code for a class + subject + course type
app.post("/api/teacher/generate-code", requireTeacherAuth, generateCodeLimiter, async (req, res) => {
  try {
    const { class_name, subject, course_type, require_location, send_pdf } = req.body;
    if (!class_name || !subject || !course_type) {
      return res.status(400).json({ error: "class_name, subject and course_type are required" });
    }
    const system = normalizeSystem(req.body.system);
    if (!system) {
      return res.status(400).json({ error: "system must be either Annual or Semester" });
    }

    // Location check: teacher ise session ke liye off kar sakta hai — par sirf
    // tab jab server owner ne allow kiya ho (ALLOW_TEACHER_LOCATION_OFF).
    // OFF hone par us session ke SAARE marks approval ke liye pending jate hain
    // (decideMarkStatus), isliye bina proof ke kuch chupke se count nahi hota.
    const locationOn = ALLOW_TEACHER_LOCATION_OFF ? boolWithDefault(require_location, true) : true;

    // Optional shorter code window. A code that dies in 2 minutes is far less
    // useful to a student who is not in the room and got it on WhatsApp.
    const requestedMin = Number(req.body.expiry_minutes);
    const expiryMinutes = CODE_EXPIRY_OPTIONS_MIN.includes(requestedMin) ? requestedMin : CODE_EXPIRY_OPTIONS_MIN[CODE_EXPIRY_OPTIONS_MIN.length - 1];
    const expiryMs = expiryMinutes * 60 * 1000;

    const code = generateCode();
    const now = Date.now(); // SERVER time
    const session = await ActiveCode.create({
      code,
      class_name,
      subject,
      course_type,
      system,
      require_location: locationOn,
      require_approval: boolWithDefault(req.body.require_approval, REQUIRE_APPROVAL_DEFAULT),
      auto_review: boolWithDefault(req.body.auto_review, SMART_APPROVAL_DEFAULT),
      send_pdf: boolWithDefault(send_pdf, SEND_PDF_DEFAULT), // default ON (env se badal sakte hain)
      created_at: now,
      expires_at: now + expiryMs,
    });
    // Auto-email the attendance PDF 20 minutes after this code was generated.
    // The cron endpoint (/api/check-and-send-pdfs) is the safety net for when
    // this Render instance sleeps before the timer fires.
    if (session.send_pdf) {
      setTimeout(() => sendAttendancePdfEmail(session._id.toString()), PDF_EMAIL_DELAY_MS);
    }
    audit(
      "session.generate",
      req,
      `${class_name}/${subject}/${course_type}`,
      `code=${code} system=${system} expiry=${expiryMinutes}m location=${locationOn ? "ON" : "OFF"} smart_approval=${session.auto_review} pdf=${session.send_pdf}`
    );
    res.json({
      code,
      session_id: session._id.toString(),
      expires_in_seconds: expiryMs / 1000,
      expires_at: session.expires_at,
      server_now: now,
      class_name,
      subject,
      course_type,
      system,
      require_location: session.require_location,
      require_approval: session.require_approval,
      auto_review: session.auto_review !== false,
      allow_location_off: ALLOW_TEACHER_LOCATION_OFF,
      send_pdf: session.send_pdf,
      strict_location: STRICT_LOCATION,
      expiry_options_minutes: CODE_EXPIRY_OPTIONS_MIN,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the code." });
  }
});

// Live status of one generated code. The teacher page uses this on reload so
// the countdown comes from SERVER time — a phone whose clock is a few minutes
// off would otherwise show the wrong remaining time for a still-valid code.
app.get("/api/teacher/session-status", requireTeacherAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
      return res.status(400).json({ error: "A valid session_id is required." });
    }
    const session = await ActiveCode.findById(session_id).lean();
    if (!session) return res.json({ found: false });
    const marked_count = await Attendance.countDocuments({ session_id });
    // Pending = location verified, waiting for the teacher's approval (only used
    // when this session is in manual-approval mode).
    const pending_count = await Attendance.countDocuments({ session_id, status: "pending" });
    // Roster size + flagged entries let the dashboard show "18 / 42 present" and
    // a review badge without extra round-trips.
    const [roster_size, flagged_count] = await Promise.all([
      session.class_name ? Student.countDocuments({ class_name: session.class_name }) : Promise.resolve(0),
      Attendance.countDocuments({ session_id, flags: { $exists: true, $ne: [] } }),
    ]);
    const now = Date.now();
    res.json({
      found: true,
      session_id: session._id.toString(),
      code: session.code,
      class_name: session.class_name,
      subject: session.subject,
      course_type: session.course_type,
      system: session.system || "Annual",
      require_location: session.require_location !== false,
      require_approval: session.require_approval === true,
      auto_review: session.auto_review !== false,
      location_off: session.require_location === false,
      allow_location_off: ALLOW_TEACHER_LOCATION_OFF,
      send_pdf: session.send_pdf !== false,
      created_at: session.created_at,
      expires_at: session.expires_at,
      server_now: now,
      seconds_left: Math.max(0, Math.round((session.expires_at - now) / 1000)),
      active: now <= session.expires_at,
      marked_count,
      confirmed_count: marked_count - pending_count,
      pending_count,
      roster_size,
      flagged_count,
      strict_location: STRICT_LOCATION,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading the session." });
  }
});

// Close a code early — the period finished sooner than expected, the code was
// read out too loudly, etc. The record stays in the database (its list and PDF
// are unaffected) but stops accepting new marks straight away; students then
// see the normal "This code has expired" message.
app.post("/api/teacher/end-session", requireTeacherAuth, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
      return res.status(400).json({ error: "A valid session_id is required." });
    }
    const session = await ActiveCode.findById(session_id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const now = Date.now();
    if (session.expires_at > now) {
      session.expires_at = now;
      await session.save();
    }
    const marked_count = await Attendance.countDocuments({ session_id });
    audit("session.end", req, session_id, `code=${session.code} marked=${marked_count}`);
    res.json({ success: true, code: session.code, marked_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong ending the session." });
  }
});

// Present / absent view: who marked attendance and — from the uploaded roster —
// who did NOT. Absentees were invisible before this: the teacher could only see
// the list of students who had marked.
app.get("/api/teacher/session-report", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type, session_id, system } = req.query;
    if (!class_name) {
      return res.status(400).json({ error: "class_name is required." });
    }
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const systemFilter = system ? normalizeSystem(system) : null;
    if (system && !systemFilter) {
      return res.status(400).json({ error: "system must be either Annual or Semester." });
    }

    const filter = { class_name, date: day.date };
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    if (systemFilter) filter.system = systemMatch(systemFilter);
    if (session_id) {
      if (!mongoose.Types.ObjectId.isValid(session_id)) {
        return res.status(400).json({ error: "Invalid session_id." });
      }
      filter.session_id = session_id;
    }

    const [allMarks, roster] = await Promise.all([
      Attendance.find(filter).lean(),
      Student.find({ class_name }).lean(),
    ]);
    allMarks.sort(compareRollNo);

    // Split the day's marks: confirmed present vs waiting for approval.
    const present = allMarks.filter((r) => r.status !== "pending");
    const pending = allMarks.filter((r) => r.status === "pending");
    // A pending mark still means the student turned up (their fix was inside the
    // room), so they are not listed as absent while a teacher decides.
    const presentRolls = new Set(allMarks.map((r) => String(r.roll_no)));
    // Only roll numbers we know about can be "absent" — a number that has never
    // been seen anywhere cannot be counted as missing from a class.
    const absent = roster
      .filter((s) => !presentRolls.has(String(s.roll_no)))
      .map((s) => ({ roll_no: s.roll_no, student_name: s.name, major_subject: s.major_subject || "" }))
      .sort(compareRollNo);

    res.json({
      date: day.date,
      class_name,
      subject: subject || "",
      course_type: course_type || "",
      system: systemFilter || "",
      roster_size: roster.length,
      present_count: present.length,
      pending_count: pending.length,
      absent_count: absent.length,
      present,
      pending,
      absent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong building the present/absent list." });
  }
});

// Look up a student's saved name, class and major subject from their roll
// number (for auto-fill + lock on the student form)
app.get("/api/student/lookup-name", studentLookupLimiter, async (req, res) => {
  try {
    const { roll_no } = req.query;
    if (!roll_no) return res.json({ name: "", class_name: "", major_subject: "" });
    const student = await Student.findOne({ roll_no: roll_no.trim() });
    // Lookup bhi activity hai — 12-mahine wala rolling timer refresh ho jata hai.
    if (student) await touchStudentActivity(roll_no.trim());
    res.json({
      name: student ? student.name : "",
      class_name: student ? student.class_name || "" : "",
      major_subject: student ? student.major_subject || "" : "",
      email: student ? student.email || "" : "",
    });
  } catch (err) {
    console.error(err);
    res.json({ name: "", class_name: "", major_subject: "" });
  }
});

// Teacher uploads the full class roster in one go: roll_no, name, class_name,
// major_subject per line. Any roll number already known gets updated; new
// ones get added. This is also how a teacher FIXES a locked name/class/major
// subject later — just re-upload the corrected line for that roll number.
// Accepted format per line: "rollno,name,class_name,major_subject"
// (tab-separated also works; class_name and major_subject may be left blank).
app.post("/api/teacher/upload-roster", requireTeacherAuth, async (req, res) => {
  try {
    const { roster_text } = req.body;
    if (!roster_text || !roster_text.trim()) {
      return res.status(400).json({ error: "Paste the student list first." });
    }
    const lines = roster_text.split("\n").map((l) => l.trim()).filter(Boolean);
    let skipped = 0;
    let withEmail = 0;
    // One bulkWrite instead of one query per line — a 500-student roster used to
    // mean 500 sequential round-trips to Atlas (slow, and easy to time out).
    // Column order: roll_no, name, class_name, major_subject, email(optional)
    // (email na ho to report DEFAULT email par jati hai — student ka data phir
    // bhi kaam karta hai, kuch toot-ta nahi.)
    const ops = [];
    for (const line of lines) {
      const parts = line.split(/,|\t/).map((p) => p.trim());
      const [roll_no, name, class_name, major_subject, emailRaw] = parts;
      if (!roll_no || !name) {
        skipped++;
        continue;
      }
      const email = emailRaw && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : "";
      if (emailRaw && !email) skipped++; // line saved, sirf galat email skip hui
      if (email) withEmail++;
      const set = {
        roll_no,
        name,
        class_name: class_name || "",
        major_subject: major_subject || "",
        // 12-mahine wala rolling timer — upload bhi activity hai.
        updatedAtDate: new Date(),
      };
      // Email sirf tab set karo jab diya gaya ho, warna pehle se saved email
      // galti se blank ho jayega.
      if (email) set.email = email;
      ops.push({ updateOne: { filter: { roll_no }, update: { $set: set }, upsert: true } });
    }

    let added = 0;
    if (ops.length) {
      let result = null;
      try {
        result = await Student.bulkWrite(ops, { ordered: false });
      } catch (bulkErr) {
        // A duplicate roll number inside the same paste makes Mongo report a
        // BulkWriteError — the rest of the list is still saved, so report what
        // actually went through instead of failing the whole upload.
        result = bulkErr.result || null;
        if (!result) throw bulkErr;
      }
      added = (result.upsertedCount || 0) + (result.matchedCount || 0);
    }
    audit("roster.upload", req, `${lines.length} line(s)`, `added=${added} skipped=${skipped} with_email=${withEmail}`);
    res.json({ success: true, added, skipped, with_email: withEmail, total: lines.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong uploading the list." });
  }
});

// See what is currently saved in the roster — either one class, or one student.
// Lets the teacher verify an upload (and see the roll numbers/classes the
// student form will auto-fill from) without re-pasting anything.
app.get("/api/teacher/roster", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, roll_no } = req.query;
    const filter = {};
    if (class_name) filter.class_name = class_name;
    if (roll_no) filter.roll_no = String(roll_no).trim();
    const students = await Student.find(filter).lean();
    students.sort(compareRollNo);
    res.json({
      count: students.length,
      students: students.map((s) => ({
        roll_no: s.roll_no,
        name: s.name,
        class_name: s.class_name || "",
        major_subject: s.major_subject || "",
        email: s.email || "",
        updated_at: s.updatedAtDate ? new Date(s.updatedAtDate).toISOString().slice(0, 10) : "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading the roster." });
  }
});

// List the code-generation sessions of one day (default: today, IST), newest
// first, so the teacher can pick which one's attendance list to view. Each
// generated code = one separate session.
app.get("/api/teacher/sessions", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type, system } = req.query;
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const { start, end } = istDayRangeMs(day.date);
    const filter = { created_at: { $gte: start, $lt: end } };
    if (class_name) filter.class_name = class_name;
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    if (system) {
      const sys = normalizeSystem(system);
      if (sys) filter.system = systemMatch(sys);
    }
    const sessions = await ActiveCode.find(filter).sort({ created_at: -1 }).lean();
    // How many students marked in each session (one small aggregation instead of
    // a count query per session), so the dropdown can show it at a glance.
    const counts = await Attendance.aggregate([
      { $match: { date: day.date } },
      { $group: { _id: "$session_id", count: { $sum: 1 } } },
    ]);
    const countBySession = new Map(counts.map((c) => [String(c._id), c.count]));
    res.json({
      date: day.date,
      sessions: sessions.map((s) => ({
        session_id: s._id.toString(),
        class_name: s.class_name,
        subject: s.subject,
        course_type: s.course_type,
        system: s.system || "Annual",
        created_at: s.created_at,
        expires_at: s.expires_at,
        marked_count: countBySession.get(s._id.toString()) || 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading sessions." });
  }
});

// Get the attendance list for a class + subject + course type (optionally one
// specific session). Defaults to today; pass ?date=YYYY-MM-DD to open an older
// register (marks are kept for ATTENDANCE_RETENTION_DAYS days).
app.get("/api/teacher/attendance", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type, session_id, system } = req.query;
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const date = day.date;
    const filter = { date };
    if (class_name) filter.class_name = class_name;
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    if (system) {
      const sys = normalizeSystem(system);
      if (sys) filter.system = systemMatch(sys);
    }
    if (session_id) {
      if (!mongoose.Types.ObjectId.isValid(session_id)) {
        return res.status(400).json({ error: "Invalid session_id." });
      }
      filter.session_id = session_id;
    }
    const rows = await Attendance.find(filter).lean();
    // Sort by roll number, ascending (numeric if possible, else alphabetic)
    rows.sort(compareRollNo);
    res.json({ date, count: rows.length, records: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading the list." });
  }
});

// Edit a single attendance entry (e.g. student mistyped their roll number).
// Keeps the same duplicate-safety net: if the corrected roll_no already has an
// entry for this exact class+subject+course_type+date, the edit is rejected
// instead of silently creating a clash.
app.patch("/api/teacher/attendance/update", requireTeacherAuth, async (req, res) => {
  try {
    const { record_id, roll_no, student_name, subject } = req.body;
    if (!record_id) {
      return res.status(400).json({ error: "record_id is required." });
    }
    if (!roll_no || !/^[0-9]+$/.test(String(roll_no).trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }

    const existing = await Attendance.findById(record_id);
    if (!existing) {
      return res.status(404).json({ error: "Attendance entry not found." });
    }

    const cleanRoll = String(roll_no).trim();
    const finalSubject = subject && subject.trim() ? subject.trim() : existing.subject;

    // Guard against creating a duplicate under the corrected roll number
    const clash = await Attendance.findOne({
      _id: { $ne: existing._id },
      roll_no: cleanRoll,
      class_name: existing.class_name,
      subject: finalSubject,
      course_type: existing.course_type,
      system: systemMatch(existing.system || "Annual"),
      date: existing.date,
    });
    if (clash) {
      return res.status(409).json({ error: "That roll number already has an entry for this class, subject and course type today." });
    }

    existing.roll_no = cleanRoll;
    if (student_name !== undefined) existing.student_name = String(student_name || "").trim();
    existing.subject = finalSubject;
    await existing.save();

    audit("attendance.update", req, `id=${existing._id}`, `roll_no=${cleanRoll} subject=${finalSubject} date=${existing.date}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the changes." });
  }
});

// Delete a single attendance entry
app.delete("/api/teacher/attendance/delete", requireTeacherAuth, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) {
      return res.status(400).json({ error: "record_id is required." });
    }
    const deleted = await Attendance.findByIdAndDelete(record_id);
    if (!deleted) {
      return res.status(404).json({ error: "Attendance entry not found." });
    }
    audit(
      "attendance.delete",
      req,
      `id=${record_id}`,
      `roll_no=${deleted.roll_no} ${deleted.class_name}/${deleted.subject}/${deleted.course_type} date=${deleted.date}`
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the entry." });
  }
});

// Unlocks a device that was permanently bound to a roll number, so that
// device can register (bind) to a different roll number next time it's used.
app.delete("/api/teacher/device-lock", requireTeacherAuth, async (req, res) => {
  try {
    const { roll_no } = req.body;
    if (!roll_no || !String(roll_no).trim()) {
      return res.status(400).json({ error: "roll_no is required." });
    }
    const cleanRoll = String(roll_no).trim();
    const result = await DeviceLock.deleteMany({ roll_no: cleanRoll });
    audit("device.unlock", req, `roll_no=${cleanRoll}`, `removed=${result.deletedCount}`);
    res.json({ success: true, removed: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong unlocking the device." });
  }
});

// ---------- APPROVAL MODE + MANUAL MARK (anti-proxy helpers) ----------

// Turn manual-approval mode on/off for a session that is already running.
// ON = every new mark arrives as "pending" and only counts once the teacher
// approves it. Useful for a class where proxy attempts are known to happen.
app.post("/api/teacher/session/set-approval", requireTeacherAuth, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
      return res.status(400).json({ error: "A valid session_id is required." });
    }
    const require_approval = boolWithDefault(req.body.require_approval, false);
    const session = await ActiveCode.findByIdAndUpdate(session_id, { require_approval }, { new: true });
    if (!session) return res.status(404).json({ error: "Session not found." });
    const pending_count = await Attendance.countDocuments({ session_id, status: "pending" });
    audit("session.set-approval", req, session_id, `require_approval=${require_approval} pending=${pending_count}`);
    res.json({ success: true, require_approval: session.require_approval, pending_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating approval mode." });
  }
});

// Approve one pending mark — the teacher saw the student in class.
app.post("/api/teacher/attendance/approve", requireTeacherAuth, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) return res.status(400).json({ error: "record_id is required." });
    const record = await Attendance.findByIdAndUpdate(
      record_id,
      { status: "present", approved_at: Date.now() },
      { new: true }
    );
    if (!record) return res.status(404).json({ error: "Attendance entry not found." });
    audit("attendance.approve", req, `id=${record_id}`, `roll_no=${record.roll_no} ${record.class_name}/${record.subject}`);
    res.json({ success: true, status: record.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong approving the entry." });
  }
});

// Reject (remove) one pending mark — the student was not actually in class.
// The row is deleted so the student can submit again if this was a mistake.
app.post("/api/teacher/attendance/reject", requireTeacherAuth, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) return res.status(400).json({ error: "record_id is required." });
    const deleted = await Attendance.findOneAndDelete({ _id: record_id, status: "pending" });
    if (!deleted) {
      return res.status(404).json({ error: "No pending entry found for that id (already approved or deleted?)." });
    }
    audit("attendance.reject", req, `id=${record_id}`, `roll_no=${deleted.roll_no} ${deleted.class_name}/${deleted.subject} flags=${(deleted.flags || []).join("|")}`);
    res.json({ success: true, removed: 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong rejecting the entry." });
  }
});

// Approve every pending mark of one session in a single tap.
app.post("/api/teacher/attendance/approve-all", requireTeacherAuth, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
      return res.status(400).json({ error: "A valid session_id is required." });
    }
    const result = await Attendance.updateMany(
      { session_id, status: "pending" },
      { status: "present", approved_at: Date.now() }
    );
    audit("attendance.approve-all", req, session_id, `approved=${result.modifiedCount || 0}`);
    res.json({ success: true, approved: result.modifiedCount || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong approving the entries." });
  }
});

// Manual mark — the safety valve for a genuine student whose phone cannot get a
// usable GPS fix (old handset, basement room, no signal). Only a logged-in
// teacher can do this, and the entry is tagged "teacher-manual" so the register
// always shows it as a human decision rather than a verified fix.
app.post("/api/teacher/attendance/manual-mark", requireTeacherAuth, async (req, res) => {
  try {
    const { roll_no, class_name, subject, course_type, name } = req.body;
    if (!roll_no || !class_name || !subject || !course_type) {
      return res.status(400).json({ error: "Roll number, class, subject and course type are required." });
    }
    if (!/^[0-9]+$/.test(String(roll_no).trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }
    const system = normalizeSystem(req.body.system);
    if (!system) return res.status(400).json({ error: "system must be either Annual or Semester." });

    const day = parseReportDate(req.body.date);
    if (day.error) return res.status(400).json({ error: day.error });

    const cleanRoll = String(roll_no).trim();
    const now = Date.now();

    // A roster/previous record always wins over anything typed in now, so a
    // teacher cannot accidentally rename a student from this screen.
    const existingStudent = await Student.findOne({ roll_no: cleanRoll });
    const student_name = existingStudent ? existingStudent.name : (name ? String(name).trim() : "");
    if (!student_name) {
      return res.status(400).json({ error: "This roll number is new — enter the student's name as well." });
    }
    if (!existingStudent) {
      try {
        await Student.create({ roll_no: cleanRoll, name: student_name, class_name, major_subject: "" });
      } catch (e) {
        if (e.code !== 11000) throw e; // 11000 = a retry already created it, fine
      }
    }

    const clash = await Attendance.findOne({ roll_no: cleanRoll, class_name, subject, course_type, system: systemMatch(system), date: day.date });
    if (clash) {
      if (clash.status === "pending") {
        // They had already verified their location and were only waiting for a tap.
        clash.status = "present";
        clash.approved_at = now;
        await clash.save();
        return res.json({ success: true, marked: false, approved: true, message: `${student_name} was already waiting for approval — approved now.` });
      }
      return res.status(409).json({ error: `${student_name} already has an entry for this subject and course type on ${day.date}.` });
    }

    await Attendance.create({
      roll_no: cleanRoll,
      student_name,
      subject,
      course_type,
      system,
      major_subject: existingStudent ? existingStudent.major_subject || "" : "",
      class_name,
      session_id: "",
      date: day.date,
      marked_at: now,
      device_id: "teacher-manual",
      status: "present",
      source: "teacher-manual",
      flags: [],
      approved_at: now,
    });

    res.json({ success: true, marked: true, message: `${student_name} (Roll No ${cleanRoll}) marked present by you for ${day.date}.` });
    audit("attendance.manual-mark", req, `roll_no=${cleanRoll}`, `${class_name}/${subject}/${course_type} date=${day.date}`);
    await touchStudentActivity(cleanRoll);
    // Is roll ke failure rows "resolved" mark kar do — teacher ki list se hat
    // jayenge (unka kaam khatam ho gaya).
    await LocationAttempt.updateMany(
      { date: day.date, roll_no: cleanRoll, resolved_at: { $in: [null, 0] } },
      { $set: { resolved_at: now, resolved_by: `teacher:${req.ip || ""}` } }
    ).catch(() => {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong marking attendance manually." });
  }
});

// Everything a teacher needs to judge one day at a glance: marks waiting for
// approval, entries flagged by the anti-proxy checks, and which devices failed
// location verification (a device failing 10 times today deserves a look).
app.get("/api/teacher/review", requireTeacherAuth, async (req, res) => {
  try {
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const classFilter = req.query.class_name ? { class_name: req.query.class_name } : {};

    const [pending, flagged, failures] = await Promise.all([
      Attendance.find({ date: day.date, status: "pending", ...classFilter }).lean(),
      Attendance.find({ date: day.date, flags: { $exists: true, $ne: [] }, ...classFilter }).lean(),
      LocationAttempt.find({ date: day.date, count: { $gt: 0 } }).sort({ count: -1 }).limit(25).lean(),
    ]);

    // Map failing devices to their roll numbers so the teacher can tell who it is.
    const locks = await DeviceLock.find({ device_id: { $in: failures.map((f) => f.device_id) } }).lean();
    const rollByDevice = new Map(locks.map((l) => [l.device_id, l.roll_no]));
    const studentRolls = [...new Set(locks.map((l) => l.roll_no))];
    const students = await Student.find({ roll_no: { $in: studentRolls } }).lean();
    const nameByRoll = new Map(students.map((s) => [s.roll_no, s.name]));

    pending.sort(compareRollNo);
    flagged.sort(compareRollNo);

    res.json({
      date: day.date,
      pending_count: pending.length,
      flagged_count: flagged.length,
      pending,
      flagged,
      location_failures: failures.map((f) => {
        const roll = rollByDevice.get(f.device_id) || "";
        return { device_id: f.device_id, roll_no: roll, student_name: roll ? nameByRoll.get(roll) || "" : "", count: f.count };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading the review list." });
  }
});

// ---------- TEACHER: LOCATION / NET FAILURE LIST ----------
// Us din ke wo students jinki location verify nahi ho payi (GPS band, net off,
// radius ke bahar) — teacher yahin se ek tap me present mark kar sakta hai ya
// ignore kar sakta hai. POORI class ko approve karne ki zaroorat nahi.
app.get("/api/teacher/failures", requireTeacherAuth, async (req, res) => {
  try {
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const filter = { date: day.date, ignored: { $ne: true }, resolved_at: { $in: [null, 0] } };
    if (req.query.class_name) filter.class_name = { $in: [req.query.class_name, ""] };

    const rows = await LocationAttempt.find(filter).sort({ last_at: -1 }).limit(200).lean();
    const rolls = [...new Set(rows.map((r) => r.roll_no).filter(Boolean))];
    const marked = rolls.length
      ? await Attendance.find({ date: day.date, roll_no: { $in: rolls } }).select("roll_no").lean()
      : [];
    const markedSet = new Set(marked.map((m) => String(m.roll_no)));

    res.json({
      ok: true,
      date: day.date,
      count: rows.length,
      failures: rows.map((f) => ({
        attempt_id: f._id.toString(),
        roll_no: f.roll_no || "",
        student_name: f.student_name || "",
        class_name: f.class_name || "",
        subject: f.subject || "",
        course_type: f.course_type || "",
        reason: f.reason || "no_gps",
        reason_text: FAILURE_REASON_TEXT[f.reason] || "Location verify nahi ho payi",
        attempts: f.count || 1,
        last_at: f.last_at || 0,
        last_at_hhmm: f.last_at ? istHHMM(f.last_at) : "",
        device_short: f.device_id ? String(f.device_id).slice(-6) : "",
        already_marked: f.roll_no ? markedSet.has(String(f.roll_no)) : false,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failure list load nahi hui." });
  }
});

// "Ignore" — ye entry teacher ki list se hata do (student ne galti se try kiya
// ya baad me khud hi mark kar liya).
app.post("/api/teacher/failures/ignore", requireTeacherAuth, async (req, res) => {
  try {
    const { attempt_id } = req.body;
    if (!attempt_id || !mongoose.Types.ObjectId.isValid(attempt_id)) {
      return res.status(400).json({ error: "A valid attempt_id is required." });
    }
    const updated = await LocationAttempt.findByIdAndUpdate(attempt_id, { $set: { ignored: true } }, { new: true });
    if (!updated) return res.status(404).json({ error: "Entry nahi mili (shayad 2 din purani ho gayi)." });
    audit("failure.ignore", req, `id=${attempt_id}`, `roll_no=${updated.roll_no || ""} reason=${updated.reason || ""}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Entry ignore nahi ho payi." });
  }
});

// Manual download: overall attendance % PDF for one class + subject + course
// type + system combination. The window depends on the system:
// Annual = last 365 days, Semester = last 180 days.
app.get("/api/teacher/reports/overall-download", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type } = req.query;
    if (!class_name || !subject || !course_type) {
      return res.status(400).json({ error: "class_name, subject and course_type are required." });
    }
    const system = normalizeSystem(req.query.system);
    if (!system) {
      return res.status(400).json({ error: "system must be either Annual or Semester." });
    }
    const n = REPORT_DAYS[system];
    const dates = lastNDates(n);
    const { rows, classDays } = await buildOverallReportRows(class_name, subject, course_type, system, dates);
    const pdfBuffer = await buildOverallPdf({ class_name, subject, course_type, system, dates, classDays }, rows);
    const filename = `${n}day-report-${class_name}-${subject}-${course_type}-${system}.pdf`.replace(/\s+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the report." });
  }
});

// A student's own subject-wise attendance summary. Identity comes from the
// device lock the app already uses everywhere else: only the phone registered
// to this roll number can read its percentages, so one student cannot look up
// another by guessing roll numbers.
app.get("/api/student/my-attendance", studentLookupLimiter, async (req, res) => {
  try {
    const { roll_no, device_id } = req.query;
    if (!roll_no || !/^[0-9]+$/.test(String(roll_no).trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }
    if (!device_id) {
      return res.status(400).json({ error: "This phone could not be identified. Reload the page and try again." });
    }
    const cleanRoll = String(roll_no).trim();
    const system = normalizeSystem(req.query.system);
    if (req.query.system && !system) {
      return res.status(400).json({ error: "system must be either Annual or Semester." });
    }

    const lock = await DeviceLock.findOne({ device_id });
    if (!lock) {
      return res.status(403).json({
        error: "Mark attendance once from this phone first — after that you can check your percentage here.",
      });
    }
    if (String(lock.roll_no) !== cleanRoll) {
      return res.status(403).json({
        error: "This phone is registered to a different roll number, so it can only show that student's attendance.",
      });
    }

    // Active student + active device ke 12-mahine wale timer refresh.
    await touchStudentActivity(cleanRoll);
    await touchDeviceActivity(device_id, cleanRoll);

    const student = await Student.findOne({ roll_no: cleanRoll }).lean();
    const days = REPORT_DAYS[system];
    const dates = lastNDates(days);

    const records = await Attendance.find({
      roll_no: cleanRoll,
      system: systemMatch(system),
      date: { $in: dates },
      status: { $ne: "pending" }, // not counted until the teacher approves (if approval mode is on)
    }).lean();

    // Marks that are still waiting for the teacher's approval — shown to the
    // student so an approval-mode session doesn't look like lost attendance.
    const pendingCount = await Attendance.countDocuments({
      roll_no: cleanRoll,
      system: systemMatch(system),
      date: { $in: dates },
      status: "pending",
    });

    // Group the student's own marks by class + subject + course type — the same
    // subject taught as DSC and as SEC is two classes with two percentages.
    const groups = new Map();
    for (const r of records) {
      const key = [r.class_name, r.subject, r.course_type].join("|");
      if (!groups.has(key)) {
        groups.set(key, {
          class_name: r.class_name,
          subject: r.subject,
          course_type: r.course_type,
          present: new Set(),
        });
      }
      groups.get(key).present.add(r.date);
    }

    // How many times each of those classes was actually held (a date on which
    // any student of that class marked counts as one class held).
    const heldAgg = await Attendance.aggregate([
      { $match: { system: systemMatch(system), date: { $in: dates } } },
      { $group: { _id: { class_name: "$class_name", subject: "$subject", course_type: "$course_type", date: "$date" } } },
      { $group: { _id: { class_name: "$_id.class_name", subject: "$_id.subject", course_type: "$_id.course_type" }, held: { $sum: 1 } } },
    ]);
    const heldMap = new Map(
      heldAgg.map((h) => [[h._id.class_name, h._id.subject, h._id.course_type].join("|"), h.held])
    );

    const subjects = Array.from(groups.entries()).map(([key, g]) => {
      const attended = g.present.size;
      const held = heldMap.get(key) || attended; // fall back to own marks if oldest data was purged
      return {
        class_name: g.class_name,
        subject: g.subject,
        course_type: g.course_type,
        attended,
        held,
        pct: held ? Number(((attended / held) * 100).toFixed(1)) : 0,
      };
    });
    subjects.sort((a, b) =>
      String(a.class_name + a.subject + a.course_type).localeCompare(String(b.class_name + b.subject + b.course_type))
    );

    const totalAttended = subjects.reduce((sum, s) => sum + s.attended, 0);
    const totalHeld = subjects.reduce((sum, s) => sum + s.held, 0);

    res.json({
      roll_no: cleanRoll,
      name: student ? student.name : "",
      class_name: student ? student.class_name || "" : "",
      major_subject: student ? student.major_subject || "" : "",
      system,
      window_days: days,
      from_date: dates[0],
      to_date: dates[dates.length - 1],
      total_attended: totalAttended,
      total_held: totalHeld,
      overall_pct: totalHeld ? Number(((totalAttended / totalHeld) * 100).toFixed(1)) : 0,
      pending_count: pendingCount,
      subjects,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading your attendance." });
  }
});

// ---------- STUDENT: FAILURE REPORT + APNA PDF ----------

// Phone me GPS hi na chale (weak net / purana phone / basement room) to student
// "Teacher se approve karwao" dabata hai — entry turant teacher ki failure list
// me chali jati hai aur wahin se ek tap me present mark ho jata hai.
app.post("/api/student/report-failure", studentLookupLimiter, async (req, res) => {
  try {
    const { roll_no, name, class_name, subject, course_type, device_id } = req.body;
    if (!device_id) {
      return res.status(400).json({ error: "Device identify nahi hua. Page reload kar ke dobara try karein." });
    }
    const reason = String(req.body.reason || "no_gps").slice(0, 40);
    if (!FAILURE_REASON_TEXT[reason]) {
      return res.status(400).json({ error: "Reason theek nahi hai." });
    }
    // Bypass rok: "no_gps" bhej kar student seedha teacher ki list me nahi ghus
    // sakta — pehle us device ko apni koshishein khatam karni padengi. (Warna
    // 1 tap me teacher ki list bhar jati thi — wahi bug tha.)
    if (reason === "no_gps") {
      const key = failureSessionKey(class_name, subject, course_type);
      const existing = await LocationAttempt.findOne({ device_id, date: todayDateString(), session_key: key }).lean();
      const used = existing ? Number(existing.count) || 0 : 0;
      const gate = attemptsDecision(used, LOCATION_ATTEMPTS_ALLOWED);
      if (!gate.allowPending) {
        return res.status(403).json({
          error: `Pehle GPS se koshish karein — koshish ${used}/${LOCATION_ATTEMPTS_ALLOWED}.`,
          reason: "need_location",
          attempts_used: used,
          attempts_left: gate.attemptsLeft,
        });
      }
    }
    await recordMarkFailure({ device_id, roll_no, name, class_name, subject, course_type, reason });
    res.json({
      ok: true,
      message: "Aapki request teacher ke paas pahunch gayi. Wo present mark karenge to attendance count hogi.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Request bhejne me dikkat aayi. Dobara try karein." });
  }
});

// Student khud apna report (PDF) download kare — roll number daal kar. Ye
// route rate-limited hai aur SIRF PDF deta hai (koi list/JSON nahi), isliye
// koi student data ka dump nahi nikal sakta.
app.get("/api/student/my-report.pdf", studentLookupLimiter, async (req, res) => {
  try {
    if (!STUDENT_PDF_OPEN) {
      return res.status(403).json({ error: "Report download band hai. Apna report teacher se lein." });
    }
    const cleanRoll = String(req.query.roll_no || "").trim();
    if (!/^[0-9]+$/.test(cleanRoll)) {
      return res.status(400).json({ error: "Roll number me sirf digits chahiye." });
    }
    const system = normalizeSystem(req.query.system);
    if (!system) {
      return res.status(400).json({ error: "Annual ya Semester chunein." });
    }

    const student = await Student.findOne({ roll_no: cleanRoll }).lean();
    const { rows, days, dates } = await collectStudentSubjectRows(cleanRoll, system);
    if (!rows.length) {
      return res.status(404).json({
        error: `Roll No ${cleanRoll} ki last ${days} din me koi attendance nahi mili. Roll number check karein.`,
      });
    }
    const pdf = await buildStudentPdf(
      {
        system,
        days,
        from_date: dates[0],
        to_date: dates[dates.length - 1],
        class_name: student ? student.class_name || "" : "",
      },
      {
        roll_no: cleanRoll,
        name: student ? student.name : "",
        class_name: student ? student.class_name || "" : "",
        major_subject: student ? student.major_subject || "" : "",
        email: "",
      },
      rows
    );
    audit("student.report.download", req, `roll_no=${cleanRoll}`, `system=${system} rows=${rows.length}`);
    const filename = `my-attendance-${cleanRoll}-${system}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Report banane me dikkat aayi. Thodi der baad try karein." });
  }
});

// ---------- LOCATION VERIFICATION (step 1 of marking attendance) ----------
// The student's phone sends its GPS fix here. The server checks that the code is
// live, that the fix is inside the classroom radius AND that the fix is accurate
// enough to believe — only then does it return a short-lived, single-use,
// device-bound token. mark-attendance refuses to save anything without that
// token, so three classic proxy tricks all fail:
//   1. copying the request body out of DevTools and replaying it elsewhere,
//   2. scripting this endpoint from home (no fix → no token),
//   3. hand-editing lat/lng in the browser's network tab (token is bound to the
//      exact fix the server itself validated).
app.post("/api/student/location-token", locationTokenLimiter, async (req, res) => {
  try {
    const { device_id, code, class_name, subject, course_type } = req.body;
    if (!device_id) {
      return res.status(400).json({ error: "Device could not be identified. Please reload the page and try again." });
    }
    if (!class_name || !code || !subject || !course_type) {
      return res.status(400).json({ error: "Fill in your class, subject, course type and the code first." });
    }
    const system = normalizeSystem(req.body.system);
    if (!system) {
      return res.status(400).json({ error: "Please choose Annual or Semester." });
    }

    const now = Date.now();
    const activeCode = await ActiveCode.findOne({ class_name, subject, course_type, system: systemMatch(system) }).sort({ created_at: -1 });
    if (!activeCode) {
      return res.status(400).json({ error: "No active code found for this class, subject, course type and system. Check your selections, or ask your teacher to generate a code." });
    }
    if (now > activeCode.expires_at) {
      return res.status(400).json({ error: "This code has expired. Ask your teacher for the current code." });
    }
    if (activeCode.code !== String(code).trim()) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    // The teacher explicitly turned location check off for this session (only
    // possible when the server allows it) → nothing to verify, no token needed.
    if (activeCode.require_location === false) {
      return res.json({ success: true, token: null, location_not_required: true, require_approval: activeCode.require_approval === true });
    }

    // ---- AUTOMATION / DEVTOOLS CHECK ----
    // DevTools console se script chalana, Selenium/Puppeteer/Playwright, ya
    // curl se endpoint hit karna — in sab se attendance banane ka rasta band.
    // Server browser ke User-Agent ka pattern dekhta hai aur phone se aaye
    // advisory hints (navigator.webdriver) bhi leta hai.
    const hintFlags = readClientHintFlags(req.body);
    const automation = isAutomationRequest(req, hintFlags);
    if (automation && BLOCK_AUTOMATION) {
      return res.status(403).json({
        error:
          "Attendance cannot be marked from this browser setup (automation/devtools detected). Student page ko Chrome ya Safari me normally kholein.",
        reason: "automation_blocked",
      });
    }
    if (automation) hintFlags.push("automation_suspected");

    const fix = readGpsFix(req.body);
    if (!fix.ok) {
      // Teacher ki failure list ke liye record — roll_no/naam/reason ke saath,
      // taki teacher ko pata chale "kaun fail hua aur kyun".
      await recordMarkFailure({
        device_id,
        roll_no: req.body.roll_no,
        name: req.body.name,
        class_name,
        subject,
        course_type,
        reason: fix.code,
      });
      return res.status(403).json({ error: fix.error, reason: fix.code, distance_m: Math.round(fix.distance || 0), radius_m: RADIUS_METERS });
    }

    // Random token; only its SHA-256 hash is stored, so even a database leak
    // cannot be used to mark attendance.
    const rawToken = crypto.randomBytes(24).toString("hex");
    await LocationToken.create({
      token_hash: sha256Hex(rawToken),
      device_id: String(device_id),
      session_id: activeCode._id.toString(),
      code: activeCode.code,
      lat: fix.lat,
      lng: fix.lng,
      accuracy: fix.accuracy,
      distance_m: Math.round(fix.distance * 100) / 100,
      ip: req.ip,
      expires_at: now + LOCATION_TOKEN_TTL_MS,
      hint_flags: hintFlags,
      automation,
    });

    res.json({
      success: true,
      token: rawToken,
      expires_in_seconds: Math.round(LOCATION_TOKEN_TTL_MS / 1000),
      distance_m: Math.round(fix.distance),
      accuracy_m: Math.round(fix.accuracy),
      radius_m: RADIUS_METERS,
      require_approval: activeCode.require_approval === true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong checking your location. Try again." });
  }
});

// ---------- STUDENT ROUTE ----------
app.post("/api/student/mark-attendance", markAttendanceLimiter, async (req, res) => {
  try {
    const { roll_no, class_name, code, device_id, name, subject, course_type, major_subject, lat, lng } = req.body;
    // Optional student email (report yahin bheja jayega; na ho to DEFAULT email).
    const cleanEmail = req.body.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(req.body.email).trim())
      ? String(req.body.email).trim()
      : "";

    if (!roll_no || !class_name || !code || !subject || !course_type) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!/^[0-9]+$/.test(String(roll_no).trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }
    if (!device_id) {
      return res.status(400).json({ error: "Device could not be identified. Please reload the page and try again." });
    }
    // Automation/devtools se direct API call? Block (jaisa location-token route me).
    const clientHints = readClientHintFlags(req.body);
    if (isAutomationRequest(req, clientHints) && BLOCK_AUTOMATION) {
      return res.status(403).json({
        error:
          "Attendance cannot be marked from this browser setup (automation/devtools detected). Student page ko Chrome ya Safari me normally kholein.",
        reason: "automation_blocked",
      });
    }
    const system = normalizeSystem(req.body.system);
    if (!system) {
      return res.status(400).json({ error: "Please choose Annual or Semester." });
    }

    const now = Date.now(); // SERVER time — client can't fake this
    const cleanRoll = String(roll_no).trim();

    // 1. Find the active code matching this exact class + subject + course type
    //    (the session the teacher is running)
    const activeCode = await ActiveCode.findOne({ class_name, subject, course_type, system: systemMatch(system) }).sort({ created_at: -1 });
    if (!activeCode) {
      return res.status(400).json({ error: "No active code found for this class, subject, course type and system (Annual/Semester). Check your selections, or ask your teacher to generate a code." });
    }
    if (now > activeCode.expires_at) {
      return res.status(400).json({ error: "This code has expired. Ask your teacher for the current code." });
    }
    if (activeCode.code !== String(code).trim()) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    // 1b. Location — anti-proxy ka core, par weak-net friendly.
    //     Do raste chalte hain:
    //       (a) INLINE FIX (aaj ka default = ek hi request): phone apna GPS fix
    //           seedha yahin bhejta hai aur SERVER khud verify karta hai
    //           (radius + accuracy + mock + freshness). Weak net par ek round
    //           trip bachana bahut bada farak hota hai.
    //       (b) ONE-TIME TOKEN (purana rasta, backward compatible).
    //     Location proof na milne par mark REJECT nahi hota — wo PENDING ban
    //     jata hai aur teacher ke "Location/net fail hue students" card me
    //     dikhta hai (GPS band / net off / bahar khada tha).
    //     CHEATING signals alag hain: mock/fake location aur automation (devtools)
    //     ab bhi seedha BLOCK hote hain.
    const locationRequired = activeCode.require_location !== false;
    let location = {
      lat: null,
      lng: null,
      accuracy: null,
      distance_m: null,
      verified: false,
      reason: locationRequired ? "no_gps" : "location_off",
      flags: [],
    };

    if (locationRequired) {
      // (a) page ne token bheja ho to pehle wahi try karo (single-use claim).
      const rawToken = typeof req.body.location_token === "string" ? req.body.location_token.trim() : "";
      let claim = null;
      if (rawToken) {
        claim = await LocationToken.findOneAndUpdate(
          {
            token_hash: sha256Hex(rawToken),
            device_id: String(device_id),
            session_id: activeCode._id.toString(),
            code: activeCode.code,
            used: false,
            expires_at: { $gt: now },
          },
          { used: true },
          { new: true }
        );
      }

      let fix = null; // verified fix (token se ya inline se)
      let hintFlags = [];
      if (claim) {
        // Token ke andar wahi fix hai jo server ne pehle validate kiya tha —
        // belt-and-braces: yahan dobara check.
        const recheck = readGpsFix({ lat: claim.lat, lng: claim.lng, accuracy: claim.accuracy });
        if (recheck.ok) {
          fix = { lat: claim.lat, lng: claim.lng, accuracy: claim.accuracy, distance: claim.distance_m };
          hintFlags = [...(claim.hint_flags || []), ...(claim.automation ? ["automation_suspected"] : [])];
        } else {
          location.reason = recheck.code;
        }
      }
      // (b) token na ho / invalid ho to inline fix se verify karo.
      if (!fix) {
        const inline = readGpsFix(req.body);
        if (inline.ok) {
          fix = { lat: inline.lat, lng: inline.lng, accuracy: inline.accuracy, distance: inline.distance };
        } else {
          location.reason = inline.code || location.reason;
          // Mock/fake location aur automation cheating hai, weak-net problem nahi
          // — inhe seedha block karo (bhejne wale app/devtools ke liye rasta band).
          if (inline.code === "mock_location") {
            await recordMarkFailure({ device_id, roll_no: cleanRoll, name, class_name, subject, course_type, reason: "mock_location" });
            return res.status(403).json({
              error: inline.error,
              reason: "mock_location",
              message: "Aapke teacher ko is koshish ki jaankari dikhegi. Fake location hata kar dobara try karein.",
            });
          }
        }
      }

      if (fix) {
        location.verified = true;
        location.reason = "";
        location.lat = fix.lat;
        location.lng = fix.lng;
        location.accuracy = fix.accuracy;
        location.distance_m = fix.distance === undefined || fix.distance === null ? null : Math.round(fix.distance * 100) / 100;
        location.flags = await computeAntiProxyFlags({
          sessionId: activeCode._id.toString(),
          device_id: String(device_id),
          roll_no: cleanRoll,
          date: todayDateString(),
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
          // Token ke hints/automation + abhi ke client hints (advisory).
          extraFlags: [...hintFlags, ...clientHints],
        });
      } else {
        // Proof nahi mili: pehle student ko KOshish karne do — jab tak uske
        // attempts baaki hain, mark SAVE hi nahi hota (teacher ki list bharne se
        // pehle student khud GPS ON karke try kare). Poori 5 koshish ke BAAD hi
        // entry teacher ke paas (pending) jayegi.
        const attemptsUsed = await recordMarkFailure({
          device_id,
          roll_no: cleanRoll,
          name,
          class_name,
          subject,
          course_type,
          reason: location.reason || "no_gps",
        });
        const gate = attemptsDecision(attemptsUsed, LOCATION_ATTEMPTS_ALLOWED);
        if (!gate.allowPending) {
          return res.status(403).json({
            error:
              `Location nahi mili. Koshish ${attemptsUsed}/${LOCATION_ATTEMPTS_ALLOWED} — ` +
              "phone ka GPS/Location ON karein, window ya darwaze ke paas jaakar 20-30 second rukein, phir \"Get location again\" dabakar dobara try karein.",
            reason: "need_location",
            attempts_used: attemptsUsed,
            attempts_allowed: LOCATION_ATTEMPTS_ALLOWED,
            attempts_left: gate.attemptsLeft,
            can_ask_teacher: false,
          });
        }
        // Koshishein khatam -> ab entry teacher ke paas (pending) jayegi.
        location.flags = [...new Set([...clientHints, "no_location_proof"])];
      }
    }

    // 2. Status ka faisla PEHLE kar lete hain (duplicate/upgrade logic ko chahiye).
    const decision = decideMarkStatus({
      requireApproval: activeCode.require_approval === true,
      autoReview: activeCode.auto_review !== false,
      locationRequired,
      locationVerified: location.verified,
      flags: location.flags,
    });
    const status = decision.status;

    // 1c. Permanent device lock — a device binds to whichever roll number
    //     first uses it. If it's already bound to a DIFFERENT roll number,
    //     reject (a teacher can unlock it from the dashboard if needed).
    const deviceLock = await DeviceLock.findOne({ device_id });
    if (deviceLock && deviceLock.roll_no !== cleanRoll) {
      return res.status(403).json({
        error: "This device is already registered to a different roll number. Ask your teacher to unlock it if this is a mistake.",
      });
    }

    // 2. Check for duplicate attendance
    //    (roll_no + class_name + subject + course_type + date — DSC and SEC of
    //    the same subject are different classes and never clash)
    const date = todayDateString();
    const alreadyMarked = await Attendance.findOne({ roll_no: cleanRoll, class_name, subject, course_type, system: systemMatch(system), date });
    if (alreadyMarked) {
      // UPGRADE: pehle entry "pending" bani thi kyunki location proof nahi mili
      // thi (GPS fail / net off). Ab student ne sahi GPS ke saath try kiya hai aur
      // location verify ho gayi — to usi entry ko PRESENT kar do. Isse student ko
      // dobara mark karne ki zaroorat nahi, aur teacher ko approve karne ki bhi.
      if (alreadyMarked.status === "pending" && location.verified === true && status === "present") {
        alreadyMarked.status = "present";
        alreadyMarked.pending_reason = "";
        alreadyMarked.location_verified = true;
        alreadyMarked.lat = location.lat;
        alreadyMarked.lng = location.lng;
        alreadyMarked.accuracy = location.accuracy;
        alreadyMarked.distance_m = location.distance_m;
        alreadyMarked.flags = location.flags;
        alreadyMarked.approved_at = now;
        await alreadyMarked.save();
        // Uske failure entries bhi "resolved" — teacher ki list saaf.
        await LocationAttempt.updateMany(
          { date, roll_no: cleanRoll, resolved_at: { $in: [null, 0] } },
          { $set: { resolved_at: now, resolved_by: "location-verified" } }
        ).catch(() => {});
        audit("attendance.auto-confirm", req, `roll_no=${cleanRoll}`, `${class_name}/${subject}/${course_type} date=${date}`);
        return res.json({
          success: true,
          pending: false,
          status: "present",
          confirmed_after_retry: true,
          location_verified: true,
          flags: location.flags || [],
          message: "Location verify ho gayi — aapki attendance CONFIRM ho gayi (teacher approval ki zaroorat nahi).",
          roll_no,
          date,
          distance_m: location.distance_m,
        });
      }
      return res.status(409).json({
        error: alreadyMarked.status === "pending"
          ? "Your attendance for this subject and course type is already recorded — it is waiting for your teacher's approval."
          : "Attendance already marked for this subject and course type today.",
      });
    }

    // 2b. Check if this same device already marked someone's attendance for
    //     this exact class + subject + course_type + date
    const deviceAlreadyUsed = await Attendance.findOne({ device_id, class_name, subject, course_type, system: systemMatch(system), date });
    if (deviceAlreadyUsed) {
      return res.status(409).json({ error: "Attendance has already been marked from this device for this subject and course type today." });
    }

    // 3. Roster locks: if this roll number already exists (student has
    //    marked attendance before / was in an uploaded roster):
    //      - Name is ALWAYS the stored one — client's name field is ignored.
    //      - Major subject is ALWAYS the stored one, once set — ignored too.
    //      - Class is checked for a match, not silently swapped (silently
    //        overriding it here could point this attendance at the wrong
    //        session/class than what was actually validated above).
    //    First time we see this roll number, whatever the student sends is
    //    saved and becomes the locked value from then on.
    const existingStudent = await Student.findOne({ roll_no: cleanRoll });
    let student_name;
    let student_major_subject = major_subject ? major_subject.trim() : "";

    if (existingStudent) {
      student_name = existingStudent.name;

      if (existingStudent.class_name) {
        if (existingStudent.class_name !== class_name) {
          return res.status(403).json({
            error: `Your class is locked to "${existingStudent.class_name}". If this is wrong, ask your teacher to correct it.`,
          });
        }
      } else {
        // First time we're seeing a class for this roll number — lock it in.
        await Student.findOneAndUpdate({ roll_no: cleanRoll }, { class_name });
      }

      if (existingStudent.major_subject) {
        student_major_subject = existingStudent.major_subject;
      } else if (student_major_subject) {
        await Student.findOneAndUpdate({ roll_no: cleanRoll }, { major_subject: student_major_subject });
      }

      // Email: pehli baar diya gaya ho to save kar lo (naam/class ki tarah
      // ek baar lock). Iske baad student ka report isi email par jayega.
      if (cleanEmail && !existingStudent.email) {
        await Student.findOneAndUpdate({ roll_no: cleanRoll }, { email: cleanEmail });
      }
   } else {
      student_name = name ? name.trim() : "";
      if (!student_name) {
        return res.status(400).json({ error: "Please enter your name — this is your first time marking attendance." });
      }
      try {
        await Student.create({ roll_no: cleanRoll, name: student_name, class_name, major_subject: student_major_subject, email: cleanEmail });
      } catch (createErr) {
        if (createErr.code === 11000) {
          // A retry from a flaky connection already created this student a
          // moment ago — that's fine, just continue with the existing record
          // instead of failing the whole request.
          const raceStudent = await Student.findOne({ roll_no: cleanRoll });
          student_name = raceStudent ? raceStudent.name : student_name;
        } else {
          throw createErr;
        }
      }
    }

    // 4. Status decide ho chuka hai (upar) — yahan sirf save karte hain.
    await Attendance.create({
      roll_no: cleanRoll,
      student_name,
      subject,
      course_type,
      system,
      major_subject: student_major_subject,
      class_name,
      session_id: activeCode._id.toString(),
      date,
      marked_at: now,
      device_id,
      status,
      pending_reason: decision.reason || "",
      location_verified: location.verified === true,
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      distance_m: location.distance_m,
      ip: req.ip,
      flags: location.flags,
      source: "student",
    });

    // 5. Lock this device to this roll number permanently, if not already locked
    if (!deviceLock) {
      try {
        await DeviceLock.create({ device_id, roll_no: cleanRoll, locked_at: now, last_seen_at: now });
      } catch (lockErr) {
        // Extremely rare race (e.g. a double-tap creating two requests at once).
        // Attendance above is already saved successfully — don't fail the
        // whole request or show a misleading error over this.
        console.error("DeviceLock create failed (non-fatal):", lockErr.message);
      }
    }

    // 12-mahine wale rolling retention timer ko refresh karo: active student
    // aur active device kabhi auto-delete nahi honge.
    await touchStudentActivity(cleanRoll);
    await touchDeviceActivity(device_id);

    res.json({
      success: true,
      pending: status === "pending",
      status,
      pending_reason: decision.reason || "",
      pending_reason_text: decision.reason ? PENDING_REASON_TEXT[decision.reason] || "" : "",
      location_verified: location.verified === true,
      auto_review: activeCode.auto_review !== false,
      attempts_allowed: LOCATION_ATTEMPTS_ALLOWED,
      can_ask_teacher: status === "pending",
      flags: location.flags || [],
      message:
        status === "pending"
          ? decision.reason === "approval_mode"
            ? "Location verified — attendance aapke teacher ke approve karne par count hogi."
            : decision.reason === "flagged"
              ? "Aapki entry teacher ke review par hai — thodi der me confirm ho jayegi."
              : "Aapki entry teacher ke paas chali gayi hai (location verify nahi ho payi). Teacher present mark karega to count hogi."
          : "Attendance marked successfully!",
      roll_no,
      date,
      distance_m: location.distance_m,
    });
 } catch (err) {
    if (err.code === 11000) {
      // Figure out WHICH unique index actually clashed — don't always blame
      // "subject and course type", since that was misleading whenever the
      // real clash was something else (e.g. a duplicate roll_no/device_id
      // race from a double submit).
      const dupFields = err.keyPattern
        ? Object.keys(err.keyPattern)
        : (err.keyValue ? Object.keys(err.keyValue) : []);
      console.error("Duplicate key on fields:", dupFields, err.keyValue);
      if (dupFields.includes("subject") && dupFields.includes("course_type")) {
        return res.status(409).json({ error: "Attendance already marked for this subject and course type today." });
      }
      return res.status(409).json({ error: "That didn't go through due to a temporary conflict. Please try submitting again." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});
// ---------- LIVE SESSION DASHBOARD ----------
// Teacher page is endpoint ko har ~5 second me poll karta hai (classroom me
// projector par live chalane ke liye). Ek hi call me: counters, 10-minute
// timeline, naye marks ka feed aur pending approvals — isliye server par
// bhaari load nahi padta.
app.get("/api/teacher/session-live", requireTeacherAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
      return res.status(400).json({ error: "A valid session_id is required." });
    }
    const session = await ActiveCode.findById(session_id).lean();
    if (!session) return res.json({ ok: true, found: false });

    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const sinceMs = Number(req.query.since_ms);
    const now = Date.now();

    // Feed: since_ms diya ho to sirf uske baad ke naye marks (polling ke liye
    // perfect — purane marks dobara nahi aate).
    const feedFilter = { session_id };
    if (Number.isFinite(sinceMs) && sinceMs > 0) feedFilter.marked_at = { $gt: sinceMs };

    const [feed, pending, marked_count, pending_count, flagged_count, roster_size, failureRows] = await Promise.all([
      Attendance.find(feedFilter).sort({ marked_at: -1 }).limit(limit).lean(),
      Attendance.find({ session_id, status: "pending" }).sort({ marked_at: -1 }).limit(50).lean(),
      Attendance.countDocuments({ session_id }),
      Attendance.countDocuments({ session_id, status: "pending" }),
      Attendance.countDocuments({ session_id, flags: { $exists: true, $ne: [] } }),
      session.class_name ? Student.countDocuments({ class_name: session.class_name }) : Promise.resolve(0),
      // WO students jinki location/net fail hui — teacher wahin se "Present
      // mark karo" kar sakta hai (poori class ko approve karne ki zaroorat nahi).
      LocationAttempt.find({
        date: todayDateString(),
        ignored: { $ne: true },
        resolved_at: { $in: [null, 0] },
        ...(session.class_name ? { class_name: { $in: [session.class_name, ""] } } : {}),
      })
        .sort({ last_at: -1 })
        .limit(40)
        .lean(),
    ]);

    // Timeline: last 60 minute (ya session shuru hone se ab tak) ke 10-minute
    // buckets — "kab-kab marks aaye" ka live pattern.
    const bucketMs = 10 * 60 * 1000;
    const windowStart = Math.max(Number(session.created_at) || now, now - 60 * 60 * 1000);
    const firstBucket = Math.floor(windowStart / bucketMs) * bucketMs;
    const buckets = [];
    for (let from = firstBucket; from <= now; from += bucketMs) {
      buckets.push({ from, to: from + bucketMs, label: istHHMM(from), count: 0 });
    }
    const stamps = await Attendance.find({ session_id, marked_at: { $gte: firstBucket } })
      .select("marked_at")
      .lean();
    for (const s of stamps) {
      const idx = Math.floor((Number(s.marked_at) - firstBucket) / bucketMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].count++;
    }

    const confirmed_count = marked_count - pending_count;
    const toFeedRow = (m) => ({
      record_id: m._id.toString(),
      roll_no: m.roll_no,
      student_name: m.student_name || "",
      subject: m.subject || "",
      course_type: m.course_type || "",
      marked_at: m.marked_at,
      marked_at_hhmm: istHHMM(m.marked_at),
      status: m.status || "present",
      pending_reason: m.pending_reason || "",
      pending_reason_text: m.pending_reason ? PENDING_REASON_TEXT[m.pending_reason] || "Teacher review chahiye" : "",
      flags: m.flags || [],
      location_verified: m.location_verified === true,
      distance_m: m.distance_m === null || m.distance_m === undefined ? null : Math.round(m.distance_m),
      accuracy: m.accuracy === null || m.accuracy === undefined ? null : Math.round(m.accuracy),
      source: m.source || "student",
      device_short: m.device_id ? String(m.device_id).slice(-6) : "",
    });

    // Failure list ke rolls me se kaun aaj already mark ho chuka hai (unka kaam
    // khatam) — unhe "already present" dikhana hai, button dabana nahi.
    const failureRolls = [...new Set(failureRows.map((f) => f.roll_no).filter(Boolean))];
    const markedToday = failureRolls.length
      ? await Attendance.find({
          date: todayDateString(),
          roll_no: { $in: failureRolls },
          ...(session.class_name ? { class_name: session.class_name } : {}),
        })
          .select("roll_no")
          .lean()
      : [];
    const markedSet = new Set(markedToday.map((r) => String(r.roll_no)));

    res.json({
      ok: true,
      found: true,
      session_id: session._id.toString(),
      code: session.code,
      class_name: session.class_name,
      subject: session.subject,
      course_type: session.course_type,
      system: session.system || "Annual",
      require_approval: session.require_approval === true,
      auto_review: session.auto_review !== false,
      location_off: session.require_location === false,
      active: now <= session.expires_at,
      seconds_left: Math.max(0, Math.round((session.expires_at - now) / 1000)),
      server_now: now,
      marked_count,
      confirmed_count,
      pending_count,
      flagged_count,
      roster_size,
      attendance_pct: roster_size ? Number(((confirmed_count / roster_size) * 100).toFixed(1)) : 0,
      timeline: buckets.map((b) => ({ label: b.label, count: b.count })),
      marks: feed.map(toFeedRow),
      pending: pending.map(toFeedRow),
      failures: failureRows.map((f) => ({
        attempt_id: f._id.toString(),
        roll_no: f.roll_no || "",
        student_name: f.student_name || "",
        reason: f.reason || "no_gps",
        reason_text: FAILURE_REASON_TEXT[f.reason] || "Location verify nahi ho payi",
        attempts: f.count || 1,
        last_at: f.last_at || 0,
        last_at_hhmm: f.last_at ? istHHMM(f.last_at) : "",
        device_short: f.device_id ? String(f.device_id).slice(-6) : "",
        already_marked: f.roll_no ? markedSet.has(String(f.roll_no)) : false,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Live session load nahi hui. Dobara try karein." });
  }
});


// ---------- SUBJECT-WISE EMAIL ROUTING (teacher page se manage) ----------

// Kahan-kahan report jayegi, ye list. DEFAULT email bhi bhejta hai taki
// teacher ko pata rahe ki fallback kya hai.
app.get("/api/teacher/email-settings", requireTeacherAuth, async (req, res) => {
  try {
    const settings = await EmailSetting.find({}).sort({ subject: 1, course_type: 1, class_name: 1 }).lean();
    res.json({
      ok: true,
      // Default inbox ka ADDRESS kabhi nahi bhejte — sirf ye ki set hai ya nahi.
      // (Personal Gmail teacher page par dikhna nahi chahiye.)
      default_inbox_configured: Boolean(TEACHER_EMAIL),
      email_configured: Boolean(resend),
      settings: settings.map((s) => ({
        id: s._id.toString(),
        subject: s.subject,
        course_type: s.course_type || "",
        class_name: s.class_name || "",
        emails: s.emails || [],
        updated_at: s.updated_at || null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email settings load nahi hui." });
  }
});

// Ek mapping save/update: subject zaroori, course_type/class_name optional
// ("khaali = sab ke liye"). Emails comma ya space se alag-alag bhej sakte hain.
app.post("/api/teacher/email-settings", requireTeacherAuth, async (req, res) => {
  try {
    const subject = String(req.body.subject || "").trim();
    const course_type = String(req.body.course_type || "").trim();
    const class_name = String(req.body.class_name || "").trim();
    if (!subject) return res.status(400).json({ error: "Subject likhna zaroori hai." });

    const rawEmails = Array.isArray(req.body.emails) ? req.body.emails.join(",") : String(req.body.emails || "");
    const emails = [
      ...new Set(
        rawEmails
          .split(/[,;\s]+/)
          .map((e) => e.trim())
          .filter(Boolean)
      ),
    ];
    const invalid = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (invalid.length) {
      return res.status(400).json({ error: `Ye email address theek nahi: ${invalid.join(", ")}` });
    }
    if (!emails.length) {
      return res.status(400).json({ error: "Kam se kam ek email address daalein (jahan report jani chahiye)." });
    }

    const setting = await EmailSetting.findOneAndUpdate(
      { subject, course_type, class_name },
      { $set: { subject, course_type, class_name, emails, updated_at: Date.now() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    audit("email-settings.save", req, `${subject}/${course_type || "*"}/${class_name || "*"}`, emails.join(", "));
    res.json({
      ok: true,
      setting: {
        id: setting._id.toString(),
        subject: setting.subject,
        course_type: setting.course_type || "",
        class_name: setting.class_name || "",
        emails: setting.emails || [],
        updated_at: setting.updated_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email mapping save nahi hui." });
  }
});

// Mapping delete — us subject ka report wapas DEFAULT email par chala jayega.
app.delete("/api/teacher/email-settings", requireTeacherAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "A valid id is required." });
    }
    const removed = await EmailSetting.findByIdAndDelete(id);
    if (!removed) return res.status(404).json({ error: "Mapping nahi mili (shayad pehle hi delete ho chuki hai)." });
    audit("email-settings.delete", req, `${removed.subject}/${removed.course_type || "*"}`, (removed.emails || []).join(", "));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Email mapping delete nahi hui." });
  }
});

// "Test email bhejo" — teacher apna address type karke check kar sakta hai ki
// email setup chal raha hai ya nahi (default inbox ka address dikhane ki
// zaroorat nahi).
app.post("/api/teacher/email-test", requireTeacherAuth, async (req, res) => {
  try {
    const to = String(req.body.email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return res.status(400).json({ error: "Sahi email address daalein." });
    }
    const sent = await sendReportEmail({
      to,
      subject: `${COLLEGE_NAME} — test email`,
      text: "Ye ek test email hai — aapka attendance app ka email setup sahi chal raha hai. Koi action ki zaroorat nahi.",
    });
    audit("email.test", req, maskEmail(to), sent.ok ? "sent" : `failed: ${sent.error}`);
    if (!sent.ok) return res.status(500).json({ error: sent.error });
    res.json({ ok: true, message: `Test email bhej diya (${maskEmail(to)}). Inbox/spam dono check karein.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Test email bhejne me dikkat aayi." });
  }
});

// ---------- AUDIT LOG (kisne kab kya badla) ----------
app.get("/api/teacher/audit", requireTeacherAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
    const entries = await AuditLog.find({}).sort({ at: -1 }).limit(limit).lean();
    res.json({
      ok: true,
      count: entries.length,
      entries: entries.map((e) => ({
        at: e.at,
        at_hhmm: istHHMM(e.at),
        at_date: istDateStringFromMs(e.at),
        action: e.action,
        actor: e.actor || "",
        target: e.target || "",
        details: e.details || "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Activity log load nahi hua." });
  }
});

// ---------- DATA POLICY + STORAGE ----------
// 12-mahine wala rule, retention windows aur MongoDB ka "kitne din me full
// hoga" projection — sab ek jagah, teacher page par dikhane ke liye.
app.get("/api/teacher/data-policy", requireTeacherAuth, async (req, res) => {
  try {
    const [oldest, storage] = await Promise.all([
      Attendance.find({}).sort({ date: 1 }).limit(1).select("date").lean(),
      getStorageStats(),
    ]);
    res.json({
      ok: true,
      attendance_retention_days: ATTENDANCE_RETENTION_DAYS,
      student_retention_days: STUDENT_RETENTION_DAYS,
      device_lock_retention_days: DEVICE_LOCK_RETENTION_DAYS,
      audit_retention_days: AUDIT_RETENTION_DAYS,
      session_retention_days: 90,
      // Report windows (Annual = 30 din, Semester = 90 din) + GPS attempts.
      report_windows: { Annual: REPORT_DAYS.Annual, Semester: REPORT_DAYS.Semester },
      location_attempts_allowed: LOCATION_ATTEMPTS_ALLOWED,
      oldest_attendance_date: oldest && oldest[0] ? oldest[0].date : null,
      storage,
      notes: [
        `Attendance marks ${ATTENDANCE_RETENTION_DAYS} din baad automatically delete hote hain.`,
        `Student ka naam/class/email aur device binding ${STUDENT_RETENTION_DAYS} din (12 mahine) ki activity ke baad delete hoti hai — roz attendance mark karne wale students ka data delete nahi hota (rolling window).`,
        `Teacher ki har badlav (delete/edit/manual mark) ${AUDIT_RETENTION_DAYS} din tak audit log me rehti hai.`,
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Data policy load nahi hui." });
  }
});


// ---------- MANUAL "EMAIL REPORT NOW" ----------

// Ek student ke saare subjects ka summary (attended/held/pct).
async function collectStudentSubjectRows(roll_no, system) {
  const days = REPORT_DAYS[system];
  const dates = lastNDates(days);
  const records = await Attendance.find({
    roll_no,
    system: systemMatch(system),
    date: { $in: dates },
    status: { $ne: "pending" },
  }).lean();

  const groups = new Map();
  for (const r of records) {
    const key = [r.class_name, r.subject, r.course_type].join("|");
    if (!groups.has(key)) {
      groups.set(key, { class_name: r.class_name, subject: r.subject, course_type: r.course_type, present: new Set() });
    }
    groups.get(key).present.add(r.date);
  }

  const heldAgg = await Attendance.aggregate([
    { $match: { system: systemMatch(system), date: { $in: dates } } },
    { $group: { _id: { class_name: "$class_name", subject: "$subject", course_type: "$course_type", date: "$date" } } },
    { $group: { _id: { class_name: "$_id.class_name", subject: "$_id.subject", course_type: "$_id.course_type" }, held: { $sum: 1 } } },
  ]);
  const heldMap = new Map(heldAgg.map((h) => [[h._id.class_name, h._id.subject, h._id.course_type].join("|"), h.held]));

  const rows = [...groups.entries()].map(([key, g]) => {
    const attended = g.present.size;
    const held = heldMap.get(key) || attended;
    return {
      class_name: g.class_name,
      subject: g.subject,
      course_type: g.course_type,
      attended,
      held,
      pct: held ? Number(((attended / held) * 100).toFixed(1)) : 0,
    };
  });
  rows.sort((a, b) => String(a.subject + a.course_type).localeCompare(String(b.subject + b.course_type)));
  return { dates, days, rows };
}

// Ek session ka register PDF — subject-wise routing (na mile to DEFAULT email).
async function emailSessionReportNow(req, session_id) {
  if (!session_id || !mongoose.Types.ObjectId.isValid(session_id)) {
    return { status: 400, body: { error: "A valid session_id is required." } };
  }
  const session = await ActiveCode.findById(session_id).lean();
  if (!session) return { status: 404, body: { error: "Session nahi mila." } };

  const records = await Attendance.find({ session_id, status: { $ne: "pending" } }).lean();
  records.sort(compareRollNo);
  const routing = await resolveReportRecipients({
    class_name: session.class_name,
    subject: session.subject,
    course_type: session.course_type,
  });
  const dateForPdf = istDateStringFromMs(session.created_at || Date.now());
  const pdf = await buildSessionPdf({ ...session, dateForPdf }, records);
  const sent = await sendReportEmail({
    to: routing.emails,
    subject: `Attendance — ${session.class_name} — ${session.subject} (${session.course_type}) — ${dateForPdf}`,
    text: `${records.length} student(s) marked present in ${session.class_name} — ${session.subject} (${session.course_type}) on ${dateForPdf}.`,
    attachments: [
      {
        filename: `attendance-${session.class_name}-${session.subject}-${session.course_type}-${dateForPdf}.pdf`.replace(/\s+/g, "_"),
        content: pdf,
      },
    ],
  });
  const masked = maskEmails(sent.recipients);
  audit("report.email.session", req, session_id, `${sent.ok ? "sent" : "failed"}: ${masked.join(", ")}`);
  if (!sent.ok) return { status: 500, body: { error: sent.error } };
  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      recipients_masked: masked,
      attachments: 1,
      records: records.length,
      source: routing.source,
      message: `Report bhej di gayi (${masked.join(", ")}) — ${routing.source === "subject-mapping" ? "subject-wise mapping" : "default inbox"}.`,
    },
  };
}

// Overall (365/180 din) % report us subject ke email par.
async function emailOverallReportNow(req, { class_name, subject, course_type, system }) {
  if (!class_name || !subject || !course_type) {
    return { status: 400, body: { error: "class_name, subject and course_type are required." } };
  }
  const dates = lastNDates(REPORT_DAYS[system]);
  const { rows, classDays } = await buildOverallReportRows(class_name, subject, course_type, system, dates);
  const pdf = await buildOverallPdf({ class_name, subject, course_type, system, dates, classDays }, rows);
  const routing = await resolveReportRecipients({ class_name, subject, course_type });
  const sent = await sendReportEmail({
    to: routing.emails,
    subject: `${REPORT_DAYS[system]}-Day Attendance Report — ${class_name} — ${subject} (${course_type}, ${system})`,
    text: `${rows.length} student(s), classes held: ${classDays}. Attached PDF me har student ka attendance % (attended / held) hai.`,
    attachments: [
      {
        filename: `${REPORT_DAYS[system]}day-report-${class_name}-${subject}-${course_type}-${system}.pdf`.replace(/\s+/g, "_"),
        content: pdf,
      },
    ],
  });
  const masked = maskEmails(sent.recipients);
  audit("report.email.overall", req, `${class_name}/${subject}/${course_type}`, `${sent.ok ? "sent" : "failed"}: ${masked.join(", ")}`);
  if (!sent.ok) return { status: 500, body: { error: sent.error } };
  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      recipients_masked: masked,
      attachments: 1,
      students: rows.length,
      classes_held: classDays,
      source: routing.source,
      message: `Overall report bhej di gayi (${masked.join(", ")}).`,
    },
  };
}

// Ek student ka personal report: uske apne email par, warna DEFAULT email par.
async function emailStudentReportNow(req, { roll_no, system }) {
  const cleanRoll = String(roll_no || "").trim();
  if (!/^[0-9]+$/.test(cleanRoll)) return { status: 400, body: { error: "Roll number digits me hona chahiye." } };
  const student = await Student.findOne({ roll_no: cleanRoll }).lean();
  if (!student) {
    return { status: 404, body: { error: `Roll No ${cleanRoll} roster me nahi hai. Pehle roster upload karein.` } };
  }
  const { rows, days, dates } = await collectStudentSubjectRows(cleanRoll, system);
  if (!rows.length) {
    return { status: 404, body: { error: `Roll No ${cleanRoll} ki last ${days} din me koi attendance nahi mili.` } };
  }
  const pdf = await buildStudentPdf(
    { system, days, from_date: dates[0], to_date: dates[dates.length - 1], class_name: student.class_name || "", subject: student.major_subject || "All subjects", course_type: "-" },
    { roll_no: student.roll_no, name: student.name, class_name: student.class_name || "", major_subject: student.major_subject || "", email: student.email || "" },
    rows
  );
  const usedStudentEmail = Boolean(student.email);
  const recipients = usedStudentEmail ? [student.email] : TEACHER_EMAIL ? [TEACHER_EMAIL] : [];
  const sent = await sendReportEmail({
    to: recipients,
    subject: `Attendance Report — ${student.name} (Roll No ${cleanRoll}) — ${system}`,
    text: `${student.name} (Roll No ${cleanRoll}) ka ${days}-din ka attendance: ${rows.map((r) => `${r.subject} ${r.pct}%`).join(", ")}.`,
    attachments: [{ filename: `student-report-${cleanRoll}-${system}.pdf`.replace(/\s+/g, "_"), content: pdf }],
  });
  const masked = maskEmails(sent.recipients);
  audit("report.email.student", req, `roll_no=${cleanRoll}`, `${sent.ok ? "sent" : "failed"}: ${masked.join(", ")}`);
  if (!sent.ok) return { status: 500, body: { error: sent.error } };
  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      recipients_masked: masked,
      attachments: 1,
      used_student_email: usedStudentEmail,
      message: usedStudentEmail
        ? `Student ka report uske email (${masked.join(", ")}) par bhej diya.`
        : "Student ka email saved nahi hai — report default inbox par bhej di gayi.",
    },
  };
}

// Manual "Email now" — teen mode: session / overall / student.
app.post("/api/teacher/email-reports", requireTeacherAuth, async (req, res) => {
  try {
    const mode = String((req.body && req.body.mode) || "").trim().toLowerCase();
    const system = normalizeSystem(req.body.system);
    if (!system) return res.status(400).json({ error: "system must be either Annual or Semester." });

    let result;
    if (mode === "session") {
      result = await emailSessionReportNow(req, req.body.session_id);
    } else if (mode === "overall") {
      result = await emailOverallReportNow(req, {
        class_name: req.body.class_name,
        subject: req.body.subject,
        course_type: req.body.course_type,
        system,
      });
    } else if (mode === "student") {
      result = await emailStudentReportNow(req, { roll_no: req.body.roll_no, system });
    } else {
      return res.status(400).json({ error: "mode must be session, overall or student." });
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Report email nahi ja payi. Dobara try karein." });
  }
});

// ---------- CSV EXPORT (Excel/Sheets me kholne ke liye) ----------
app.get("/api/teacher/export.csv", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type } = req.query;
    const day = parseReportDate(req.query.date);
    if (day.error) return res.status(400).json({ error: day.error });
    const system = normalizeSystem(req.query.system);
    const filter = { date: day.date };
    if (class_name) filter.class_name = class_name;
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    if (system) filter.system = systemMatch(system);

    // Bada din = bahut rows; cap laga kar memory bachate hain.
    const MAX_ROWS = 5000;
    const rows = await Attendance.find(filter).limit(MAX_ROWS).lean();
    rows.sort(compareRollNo);

    const header = [
      "Roll No",
      "Name",
      "Class",
      "Subject",
      "Course Type",
      "System",
      "Date",
      "Marked At (IST)",
      "Status",
      "Source",
      "Distance (m)",
      "Accuracy (m)",
      "Flags",
      "Device",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.roll_no,
          r.student_name,
          r.class_name,
          r.subject,
          r.course_type,
          r.system || "Annual",
          r.date,
          istHHMM(r.marked_at),
          r.status || "present",
          r.source || "student",
          r.distance_m === null || r.distance_m === undefined ? "" : Math.round(r.distance_m),
          r.accuracy === null || r.accuracy === undefined ? "" : Math.round(r.accuracy),
          (r.flags || []).join("|"),
          String(r.device_id || "").slice(-6),
        ]
          .map(csvCell)
          .join(",")
      );
    }
    // BOM (U+FEFF) — Excel me accents/naam theek dikhein.
    const csv = "\uFEFF" + lines.join("\r\n");
    const filename = `attendance-${class_name || "all"}-${day.date}.csv`.replace(/[^\w.\-]+/g, "_");
    audit("report.csv", req, `${class_name || "all"}/${subject || "*"}`, `date=${day.date} rows=${rows.length}`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "CSV export nahi ho paya." });
  }
});

// 90-din ka "matrix" CSV: ek row = ek student, ek column = ek DATE (P/A).
// Excel/Sheets me filter-sort-print sab aaram se hota hai — 90 date columns
// bhi fit ho jate hain, aur teacher ko har din ka saaf pata chalta hai.
app.get("/api/teacher/export-matrix.csv", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type } = req.query;
    if (!class_name || !subject || !course_type) {
      return res.status(400).json({ error: "class_name, subject and course_type are required." });
    }
    const system = normalizeSystem(req.query.system);
    if (!system) return res.status(400).json({ error: "system must be either Annual or Semester." });

    const dates = lastNDates(REPORT_DAYS[system]);
    const { rows, classDays } = await buildOverallReportRows(class_name, subject, course_type, system, dates);
    const header = ["Roll No", "Name", ...dates, "Attended", "Held", "%"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [r.roll_no, r.student_name, ...(r.dayMarks || []), r.totalPresent, classDays, `${r.pct}%`].map(csvCell).join(",")
      );
    }
    const csv = "\uFEFF" + lines.join("\r\n"); // BOM: Excel me headings sahi dikhen
    const filename = `attendance-matrix-${class_name}-${subject}-${course_type}-${system}.csv`.replace(/[^\w.\-]+/g, "_");
    audit("report.csv.matrix", req, `${class_name}/${subject}/${course_type}`, `system=${system} days=${dates.length} students=${rows.length}`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Matrix CSV export nahi ho paya." });
  }
});

// ---------- CRON / MONITORING ----------
// Shared guard for the two cron endpoints below. If CRON_SECRET is not set the
// endpoints behave exactly as before (open), so an existing cron-job.org setup
// keeps working until the secret is configured.
function requireCronAuth(req, res, next) {
  if (!CRON_SECRET) return next();
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (provided !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// Lightweight health/keep-alive endpoint. A free Render instance sleeps after
// ~15 minutes idle, so pinging this every 10 minutes from a cron keeps the
// server (and the code-generating teacher) responsive — and unlike the cron
// endpoints above it can never send an email.
app.get("/api/health", async (req, res) => {
  const STATES = ["disconnected", "connected", "connecting", "disconnecting"];
  const body = {
    ok: mongoose.connection.readyState === 1,
    db: STATES[mongoose.connection.readyState] || "unknown",
    ist_date: todayDateString(),
    server_time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    emails_configured: Boolean(resend && TEACHER_EMAIL),
    // Anti-proxy settings, so a deploy can be checked without reading the code.
    anti_proxy: {
      strict_location: STRICT_LOCATION,
      max_accuracy_meters: MAX_ACCURACY_METERS,
      strict_circle: GEOFENCE_STRICT_CIRCLE,
      radius_meters: RADIUS_METERS,
      location_token_ttl_sec: Math.round(LOCATION_TOKEN_TTL_MS / 1000),
      approval_default: REQUIRE_APPROVAL_DEFAULT,
      code_expiry_options_minutes: CODE_EXPIRY_OPTIONS_MIN,
      // Naye anti-proxy switches (dev-option / fake-location rokne ke liye).
      mock_min_accuracy_meters: MIN_REAL_ACCURACY_METERS,
      max_fix_age_sec: Math.round(MAX_FIX_AGE_MS / 1000),
      block_automation: BLOCK_AUTOMATION,
      auto_review_flagged: AUTO_REVIEW_FLAGGED,
      // Smart approval + location switch + PDF default + student PDF download.
      smart_approval_default: SMART_APPROVAL_DEFAULT,
      allow_teacher_location_off: ALLOW_TEACHER_LOCATION_OFF,
      send_pdf_default: SEND_PDF_DEFAULT,
      student_pdf_open: STUDENT_PDF_OPEN,
    },
    // 12-mahine wala retention + token window.
    data_policy: {
      attendance_retention_days: ATTENDANCE_RETENTION_DAYS,
      student_retention_days: STUDENT_RETENTION_DAYS,
      device_lock_retention_days: DEVICE_LOCK_RETENTION_DAYS,
      audit_retention_days: AUDIT_RETENTION_DAYS,
      teacher_token_hours: Math.round(TEACHER_TOKEN_TTL_MS / 3600000),
      report_days: { Annual: REPORT_DAYS.Annual, Semester: REPORT_DAYS.Semester },
      location_attempts_allowed: LOCATION_ATTEMPTS_ALLOWED,
    },
    email_routing: {
      default_inbox_configured: Boolean(TEACHER_EMAIL),
      subject_mapping_supported: true,
    },
  };
  // Storage ka bhaari hisaab sirf maangne par (?storage=1) — health ko halka
  // aur fast rakhna zaroori hai, kyunki cron isi ko ping karta hai.
  if (String(req.query.storage) === "1") body.storage = await getStorageStats();
  res.json(body);
});

// Checks for any session whose 20-minute PDF window has passed but the PDF
// hasn't been sent yet, and sends it. Meant to be called every few minutes by
// an external cron service (like cron-job.org) — unlike setTimeout, this
// survives the server spinning down and restarting before the timer fires.
app.get("/api/check-and-send-pdfs", requireCronAuth, async (req, res) => {
  try {
    const now = Date.now();
    const dueSessions = await ActiveCode.find({
      send_pdf: true,
      pdf_sent: false,
      created_at: { $lte: now - PDF_EMAIL_DELAY_MS },
    }).limit(3);

    console.log(`check-and-send-pdfs: ${dueSessions.length} session(s) is baar process ho rahe hain`);

    // Respond immediately so cron-job.org's short timeout never trips — the
    // actual email sending continues in the background after this.
    res.json({ checked: dueSessions.length });

    for (const session of dueSessions) {
      try {
        await sendAttendancePdfEmail(session._id.toString());
      } catch (err) {
        console.error(`Session ${session._id} fail hua:`, err.message);
      }
    }
  } catch (err) {
    console.error("check-and-send-pdfs failed:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong checking pending PDFs." });
    }
  }
});
// Meant to be hit once a day by an external cron (e.g. cron-job.org). On the
// 1st of a new month (or any day after, if it was missed) it generates every
// class/subject/course-type combo's report for the PREVIOUS month and emails
// them all as one combined message. Safe to call every day — MonthlyReportLog
// makes it a no-op once that month's report has already gone out.
app.get("/api/check-and-send-monthly-report", requireCronAuth, async (req, res) => {
  try {
    const result = await sendMonthlyCombinedReport();
    res.json(result);
  } catch (err) {
    console.error("check-and-send-monthly-report failed:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong checking the monthly report." });
    }
  }
});
// ---------- ERROR HANDLING (crash-proofing) ----------
// Ye handlers LAST me hone chahiye, isliye neeche (START SERVER se pehle) lagte
// hain. Bina in ke: malformed JSON par Express HTML error page bhejta tha →
// frontend ka res.json() fail hota tha aur "data side crash" jaisa dikhta tha.

// /api par anjaan route → HTML ke bajaye saaf JSON 404.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Ye API route exist nahi karta." });
});

// Saare request errors ek jagah: always JSON, never a stack trace to the client.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({
      error: "Bheja gaya data theek nahi tha (invalid JSON). Page reload karke dobara try karein.",
    });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Bheja gaya data bahut bada hai. Roster ko chhote-chhote hisson me upload karein.",
    });
  }
  console.error("Request error:", (err && err.message) || err);
  res.status(500).json({ error: "Server par kuch gadbad hui. Dobara try karein." });
});

// Process-level safety nets: ek unexpected error poori site na gira de.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", (reason && reason.message) || reason);
});
process.on("uncaughtException", (err) => {
  // Log karke server chalta rehta hai — attendance app ke liye availability
  // zyada zaroori hai, aur har route apna error khud handle karta hai.
  console.error("Uncaught exception:", (err && err.message) || err);
});

// ---------- TEST HOOKS ----------
// tools/approval-logic-test.js (aur koi bhi test) server ko require karke ye
// pure functions use kar sakta hai. Server ka behaviour isse badalta nahi.
module.exports = {
  decideMarkStatus,
  attemptsDecision,
  PENDING_REASON_TEXT,
  FAILURE_REASON_TEXT,
  maskEmail,
};

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance server running at http://localhost:${PORT}`);
  console.log(`Teacher page: http://localhost:${PORT}/teacher.html`);
  console.log(`Student page: http://localhost:${PORT}/student.html`);
});