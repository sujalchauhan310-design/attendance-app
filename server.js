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
 * HOW TO RUN:
 *   1. npm install
 *   2. Set these environment variables (see the CONFIG block below):
 *        MONGODB_URI        — MongoDB Atlas connection string (required)
 *        TEACHER_PASSWORD   — password for the teacher page (strongly advised)
 *        RESEND_API_KEY     — enables automatic PDF emails
 *        TEACHER_EMAIL      — inbox that receives the PDFs
 *        CRON_SECRET        — locks down the two /api/check-and-send-* endpoints
 *        CLASSROOM_LAT / CLASSROOM_LNG / CLASSROOM_RADIUS_METERS
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
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- CONFIG ----------
const CODE_EXPIRY_MS = 7 * 60 * 1000; // code is valid for 7 minutes
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
const REPORT_DAYS = { Annual: 365, Semester: 180 };
// Up to this many days the report shows the day-by-day P/A grid. Longer
// ranges (Annual/Semester) don't fit on a page as a grid, so they use a
// compact summary table instead.
const GRID_MAX_DAYS = 45;
// Attendance records are auto-deleted after this many days. Must be longer
// than the longest report window (Annual = 365 days), otherwise the Annual
// report would silently be missing older data.
const ATTENDANCE_RETENTION_DAYS = 400;

// If a student's phone can't give a location, they must retry. After this many
// failed-location submissions in a day from the same device, the next one is
// accepted anyway (silently — the student just sees the normal success message).
const MAX_LOCATION_ATTEMPTS = 15;

// Resend sends over HTTPS (not SMTP), so it isn't blocked on Render's free tier
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Gmail address that RECEIVES the PDF (the teacher/sir's inbox)
const TEACHER_EMAIL = process.env.TEACHER_EMAIL;

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


if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI environment variable is not set.");
  console.error("Set it to your MongoDB Atlas connection string before starting the server.");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });

// ---------- DATABASE MODELS ----------

// Remembers a student's name, class and major subject against their roll
// number, so it can auto-fill (and lock) next time — permanently, across any device.
const studentSchema = new mongoose.Schema({
  roll_no: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  class_name: { type: String, default: "" },
  major_subject: { type: String, default: "" },
});
const Student = mongoose.model("Student", studentSchema);

// A device is permanently bound to whichever roll number first uses it to
// mark attendance. Once bound, that device can never mark attendance as a
// different roll number — until a teacher unlocks it from the dashboard.
const deviceLockSchema = new mongoose.Schema({
  device_id: { type: String, required: true, unique: true },
  roll_no: { type: String, required: true },
  locked_at: Number,
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

// Counts "no location came through" submissions per device per day (stored in
// the DB so a server restart doesn't reset the count). Auto-deleted after 2 days.
const locationAttemptSchema = new mongoose.Schema({
  device_id: { type: String, required: true },
  date: { type: String, required: true },
  count: { type: Number, default: 0 },
  createdAtDate: { type: Date, default: Date.now, expires: 2 * 24 * 60 * 60 },
});
locationAttemptSchema.index({ device_id: 1, date: 1 }, { unique: true });
const LocationAttempt = mongoose.model("LocationAttempt", locationAttemptSchema);

const activeCodeSchema = new mongoose.Schema({
  code: String,
  class_name: String,
  subject: String,
  course_type: String, // DSC / SEC / GE / AEC / VAC / MDC — same subject under
                        // a different type is a different class, no clash
system: { type: String, enum: ["Annual", "Semester"], default: "Annual" }, // Annual / Semester system
require_location: {type: Boolean, default: true },
send_pdf: { type: Boolean, default: true }, // auto-email attendance PDF 20 min after generation
pdf_sent: { type: Boolean, default: false }, // prevents sending twice if server restarts
  created_at: Number,
  expires_at: Number,
  // Real Date object used only to auto-delete old sessions, so the collection
  // does not grow forever (every generated code = one document).
  createdAtDate: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
});
const ActiveCode = mongoose.model("ActiveCode", activeCodeSchema);

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

  if (!resend || !TEACHER_EMAIL) {
    console.warn("Skipping monthly report — email is not configured.");
    return { skipped: true, reason: "email not configured" };
  }

  const combosAgg = await Attendance.aggregate([
    { $match: { date: { $in: dates } } },
    { $group: { _id: { class_name: "$class_name", subject: "$subject", course_type: "$course_type", system: { $ifNull: ["$system", "Annual"] } } } },
  ]);
  const combos = combosAgg.map((c) => c._id);

  const attachments = [];
  for (const combo of combos) {
    const { rows, classDays } = await buildOverallReportRows(combo.class_name, combo.subject, combo.course_type, combo.system, dates);
    if (!rows.length) continue;
    const pdfBuffer = await buildOverallReportPdfBuffer(
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

  const { error: monthlyError } = await resend.emails.send({
    from: "Attendance App <onboarding@resend.dev>",
    to: TEACHER_EMAIL,
    subject: `Monthly Attendance Reports — ${label}`,
    text: `Attached: ${attachments.length} attendance report(s) covering ${label}, one PDF per class/subject/course-type/system combination.`,
    attachments,
  });

  if (monthlyError) throw new Error(monthlyError.message || "Resend rejected the email");
  await MonthlyReportLog.create({ month: label, sent_at: Date.now() });
  console.log(`Monthly combined report emailed for ${label} (${attachments.length} attachment(s))`);
  return { sent: true, month: label, count: attachments.length };
}


// Generates the PDF for a session and emails it to TEACHER_EMAIL.
async function sendAttendancePdfEmail(sessionId) {
  let claimed = false;
  try {
    if (!resend || !TEACHER_EMAIL) {
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

    const records = await Attendance.find({ session_id: sessionId }).lean();
    records.sort(compareRollNo);

    const pdfBuffer = await buildAttendancePdfBuffer(
      // The date shown on the PDF is the date the class actually happened
      // (the session's own timestamp, in IST) — not "today". Otherwise a code
      // generated at 11:55pm and emailed at 12:15am would print the wrong day.
      { ...session.toObject(), dateForPdf: istDateStringFromMs(session.created_at || Date.now()) },
      records
    );

    const { error: sendError } = await resend.emails.send({
      from: "Attendance App <onboarding@resend.dev>",
      to: TEACHER_EMAIL,
      subject: `Attendance — ${session.class_name} — ${session.subject} (${session.course_type}, ${session.system || "Annual"})`,
      text: `Attached: attendance for ${session.class_name} — ${session.subject} (${session.course_type}), ${records.length} student(s) marked present. Generated automatically 20 minutes after the code was created.`,
      attachments: [{
        filename: `attendance-${session.class_name}-${session.subject}-${session.course_type}.pdf`.replace(/\s+/g, "_"),
        content: pdfBuffer,
      }],
    });

    if (sendError) throw new Error(sendError.message || "Resend rejected the email");
    console.log(`Attendance PDF emailed for session ${sessionId}`);
  } catch (err) {
    console.error(`Failed to email attendance PDF for session ${sessionId}:`, err.message);
    // Un-claim so the cron retries it later
    if (claimed) await ActiveCode.updateOne({ _id: sessionId }, { pdf_sent: false }).catch(() => {});
  }
}

// ---------- TEACHER AUTH ----------
// A simple shared password, sent as a header on every teacher request.
// Keeps random people who find the link from generating codes or seeing attendance.
function requireTeacherAuth(req, res, next) {
  const provided = req.headers["x-teacher-password"];
  if (provided !== TEACHER_PASSWORD) {
    return res.status(401).json({ error: "Incorrect teacher password." });
  }
  next();
}

// ---------- RATE LIMITING ----------
// Keyed by device_id (not IP) so one phone can't spam attempts, without
// blocking an entire college's worth of students who share the same WiFi IP.
//
// Deliberately set high (15) so this NEVER fires for normal use — typos,
// retries, a slow network causing a few genuine re-submits. It's only meant
// to catch a genuinely abusive pattern (e.g. a script hammering the code
// guess). And when it does fire, the response is worded identically to the
// app's ordinary generic error, and the RateLimit-* headers are turned off —
// nothing here reveals that a limiter exists or was tripped. Someone
// running a script gets the same non-answer a normal server hiccup gives,
// with no signal to slow down, back off differently, or that they've been
// specifically detected.
const markAttendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // must stay well above MAX_LOCATION_ATTEMPTS, else it would cut off students before the location fallback can apply
  statusCode: 500, // matches the app's ordinary error status — 429 would give it away
  message: { error: "Something went wrong. Try again." },
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.device_id) || req.ip,
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
  max: 80, // a student typing roll numbers on the form will never come close
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
    const code = generateCode();
    const now = Date.now(); // SERVER time
    const session = await ActiveCode.create({
      code,
      class_name,
      subject,
      course_type,
      system,
      require_location: boolWithDefault(require_location, true), // on unless explicitly turned off
      send_pdf: boolWithDefault(send_pdf, true),                 // on unless explicitly turned off
      created_at: now,
      expires_at: now + CODE_EXPIRY_MS,
    });
    // Auto-email the attendance PDF 20 minutes after this code was generated.
    // The cron endpoint (/api/check-and-send-pdfs) is the safety net for when
    // this Render instance sleeps before the timer fires.
    if (session.send_pdf) {
      setTimeout(() => sendAttendancePdfEmail(session._id.toString()), PDF_EMAIL_DELAY_MS);
    }
    res.json({
      code,
      session_id: session._id.toString(),
      expires_in_seconds: CODE_EXPIRY_MS / 1000,
      expires_at: session.expires_at,
      server_now: now,
      class_name,
      subject,
      course_type,
      system,
      require_location: session.require_location,
      send_pdf: session.send_pdf,
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
      send_pdf: session.send_pdf !== false,
      created_at: session.created_at,
      expires_at: session.expires_at,
      server_now: now,
      seconds_left: Math.max(0, Math.round((session.expires_at - now) / 1000)),
      active: now <= session.expires_at,
      marked_count,
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

    const [present, roster] = await Promise.all([
      Attendance.find(filter).lean(),
      Student.find({ class_name }).lean(),
    ]);
    present.sort(compareRollNo);

    const presentRolls = new Set(present.map((r) => String(r.roll_no)));
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
      absent_count: absent.length,
      present,
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
    res.json({
      name: student ? student.name : "",
      class_name: student ? student.class_name || "" : "",
      major_subject: student ? student.major_subject || "" : "",
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
    // One bulkWrite instead of one query per line — a 500-student roster used to
    // mean 500 sequential round-trips to Atlas (slow, and easy to time out).
    const ops = [];
    for (const line of lines) {
      const parts = line.split(/,|\t/).map((p) => p.trim());
      const [roll_no, name, class_name, major_subject] = parts;
      if (!roll_no || !name) {
        skipped++;
        continue;
      }
      ops.push({
        updateOne: {
          filter: { roll_no },
          update: { $set: { roll_no, name, class_name: class_name || "", major_subject: major_subject || "" } },
          upsert: true,
        },
      });
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
    res.json({ success: true, added, skipped, total: lines.length });
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
    res.json({ success: true, removed: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong unlocking the device." });
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
    const pdfBuffer = await buildOverallReportPdfBuffer({ class_name, subject, course_type, system, dates, classDays }, rows);
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

    const student = await Student.findOne({ roll_no: cleanRoll }).lean();
    const days = REPORT_DAYS[system];
    const dates = lastNDates(days);

    const records = await Attendance.find({
      roll_no: cleanRoll,
      system: systemMatch(system),
      date: { $in: dates },
    }).lean();

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
      subjects,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading your attendance." });
  }
});

// ---------- STUDENT ROUTE ----------
app.post("/api/student/mark-attendance", markAttendanceLimiter, async (req, res) => {
  try {
    const { roll_no, class_name, code, device_id, name, subject, course_type, major_subject, lat, lng } = req.body;

    if (!roll_no || !class_name || !code || !subject || !course_type) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!/^[0-9]+$/.test(String(roll_no).trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }
    if (!device_id) {
      return res.status(400).json({ error: "Device could not be identified. Please reload the page and try again." });
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

    // 1b. Location.
    //   (a) A location came through and is outside the radius → ALWAYS reject.
    //   (b) A location came through and is inside → fine.
    //   (c) NO location came through (denied / timed out / Safari quirk) and
    //       the teacher has location check ON → ask the student to retry. Once
    //       the same device has failed MAX_LOCATION_ATTEMPTS times today, the
    //       next submission is accepted silently, with the normal success
    //       message (nothing tells the student location wasn't used).
    //   (d) NO location and the teacher turned location check OFF → accept.
    const hasLocation =
      typeof lat === "number" && typeof lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (hasLocation) {
      const dist = distanceInMeters(CLASSROOM.lat, CLASSROOM.lng, lat, lng);
      if (dist > RADIUS_METERS) {
        return res.status(403).json({
          error: `You appear to be too far from the classroom (${Math.round(dist)}m away). Attendance can only be marked inside class.`,
        });
      }
    } else if (activeCode.require_location !== false) {
      const attempt = await LocationAttempt.findOneAndUpdate(
        { device_id, date: todayDateString() },
        { $inc: { count: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (attempt.count <= MAX_LOCATION_ATTEMPTS) {
        return res.status(403).json({
          error: "Your location could not be verified. Turn on location for your browser, tap \"Retry Location\", and try again.",
        });
      }
      // else: over the limit → fall through and mark attendance normally
    }

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
      return res.status(409).json({ error: "Attendance already marked for this subject and course type today." });
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
   } else {
      student_name = name ? name.trim() : "";
      if (!student_name) {
        return res.status(400).json({ error: "Please enter your name — this is your first time marking attendance." });
      }
      try {
        await Student.create({ roll_no: cleanRoll, name: student_name, class_name, major_subject: student_major_subject });
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

    // 4. Save attendance
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
    });

    // 5. Lock this device to this roll number permanently, if not already locked
    if (!deviceLock) {
      try {
        await DeviceLock.create({ device_id, roll_no: cleanRoll, locked_at: now });
      } catch (lockErr) {
        // Extremely rare race (e.g. a double-tap creating two requests at once).
        // Attendance above is already saved successfully — don't fail the
        // whole request or show a misleading error over this.
        console.error("DeviceLock create failed (non-fatal):", lockErr.message);
      }
    }

    res.json({ success: true, message: "Attendance marked successfully!", roll_no, date });
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
app.get("/api/health", (req, res) => {
  const STATES = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    ok: mongoose.connection.readyState === 1,
    db: STATES[mongoose.connection.readyState] || "unknown",
    ist_date: todayDateString(),
    server_time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    emails_configured: Boolean(resend && TEACHER_EMAIL),
  });
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
// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance server running at http://localhost:${PORT}`);
  console.log(`Teacher page: http://localhost:${PORT}/teacher.html`);
  console.log(`Student page: http://localhost:${PORT}/student.html`);
});