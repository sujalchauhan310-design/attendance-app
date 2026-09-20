/**
 * College Attendance System — Backend
 * -------------------------------------------------
 * Features:
 *  - Teacher generates a rotating 5-digit code (server-side, expires in 5 min)
 *  - Server time is always used (client device time is never trusted)
 *  - One roll number can mark attendance only ONCE per class + subject +
 *    course type per day (DSC / SEC / GE / AEC / VAC / MDC of the same
 *    subject each count as a separate class)
 *  - All validation happens on the server, never trusting client JS
 *  - Data stored permanently in MongoDB (survives server restarts)
 *
 * HOW TO RUN:
 *   1. npm install
 *   2. Set the MONGODB_URI environment variable to your MongoDB Atlas connection string
 *   3. node server.js
 *   4. Open http://localhost:3000/teacher.html   (for teacher)
 *      Open http://localhost:3000/student.html   (for student)
 */

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const PDFDocument = require("pdfkit");
const { Resend } = require("resend");
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first"); //render's IPv6 route to gmail is broken; force ipv4

const app = express();
app.set("trust proxy",1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- CONFIG ----------
const CODE_EXPIRY_MS = 7 * 60 * 1000; // code is valid for 5 minutes
const MONGODB_URI = process.env.MONGODB_URI;

// Simple shared password so only the teacher can generate codes / see attendance.
// Set this in Render's Environment tab. If not set, falls back to a default —
// change it via the environment variable for real use.
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "changeme123";

// TODO: Set this to your actual classroom's GPS coordinates
// (Google Maps → right-click the spot → copy lat/long)
const CLASSROOM = {
  lat: 31.10648, // <-- change this
  lng: 77.15175, // <-- change this
};
const RADIUS_METERS = 150; // a bit generous, since network-based location
                            // (used for weak signal) is less precise than GPS
// How long after a code is generated the attendance PDF is auto-emailed
const PDF_EMAIL_DELAY_MS = 20 * 60 * 1000; // 20 minutes

// Resend sends over HTTPS (not SMTP), so it isn't blocked on Render's free tier
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Gmail address that RECEIVES the PDF (the teacher/sir's inbox)
const TEACHER_EMAIL = process.env.TEACHER_EMAIL;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!resend) {
  console.warn("RESEND_API_KEY not set — automatic PDF emails are disabled.");
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

const activeCodeSchema = new mongoose.Schema({
  code: String,
  class_name: String,
  subject: String,
  course_type: String, // DSC / SEC / GE / AEC / VAC / MDC — same subject under
                        // a different type is a different class, no clash
require_location: {type: Boolean, default: true },
send_pdf: { type: Boolean, default: true }, // auto-email attendance PDF 20 min after generation
pdf_sent: { type: Boolean, default: false }, // prevents sending twice if server restarts
  created_at: Number,
  expires_at: Number,
});
const ActiveCode = mongoose.model("ActiveCode", activeCodeSchema);

const attendanceSchema = new mongoose.Schema({
  roll_no: String,
  student_name: String,
  subject: String,       // the subject actually being taught in this session (from the teacher's code)
  course_type: String,   // DSC / SEC / GE / AEC / VAC / MDC for this session
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
attendanceSchema.index(
  { roll_no: 1, class_name: 1, subject: 1, course_type: 1, date: 1 },
  { unique: true }
);
// Auto-delete attendance records 60 days after they were created. IMPORTANT:
// the monthly combined report (sent on/around the 1st of each month, covering
// the previous month) always runs well within this 60-day window, so the PDF
// is generated and emailed long before MongoDB deletes the underlying data.
attendanceSchema.index({ createdAtDate: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });
const Attendance = mongoose.model("Attendance", attendanceSchema);
// One-time cleanup: an old unique index (roll_no+class_name+period+date) is
// still sitting in the database from before subject/course_type existed.
// Mongoose never drops old indexes on its own, so it was silently blocking
// every second attendance for the same roll_no+class_name+date, no matter
// what subject/course_type the student picked. Drop it once at startup.
mongoose.connection.once("open", async () => {
  try {
    const indexes = await Attendance.collection.indexes();
    for (const idx of indexes) {
      if (idx.key && idx.key.period !== undefined) {
        await Attendance.collection.dropIndex(idx.name);
        console.log("Dropped stale index:", idx.name);
      }
    }
  } catch (e) {
    console.error("Index cleanup failed:", e.message);
  }
});

// ---------- HELPERS ----------
function todayDateString() {
  // Uses SERVER date, not client date
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function generateCode() {
  return Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit code
}

// Returns the last n YYYY-MM-DD date strings (server/UTC date, same convention
// as todayDateString), oldest first, ending today.
function lastNDates(n) {
  const dates = [];
  const now = new Date();
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
  const now = new Date();
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
      `Attendance Register — ${session.class_name} — ${session.subject} (${session.course_type})`,
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
        [idx + 1, r.student_name || "-", r.roll_no, r.subject || "-", r.course_type || "-", new Date(r.marked_at).toLocaleTimeString()],
        y,
        false
      );
      y += 16;
    });

    doc.end();
  });
}

// Builds S.No/Name/Roll-No/day-by-day P-A rows for one class+subject+course
// combination, over the given list of YYYY-MM-DD dates.
async function buildOverallReportRows(class_name, subject, course_type, dates) {
  const records = await Attendance.find({
    class_name,
    subject,
    course_type,
    date: { $in: dates },
  }).lean();

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
    const pct = dates.length ? ((totalPresent / dates.length) * 100).toFixed(1) : "0.0";
    return {
      roll_no: s.roll_no,
      student_name: s.student_name,
      dayMarks: dates.map((d) => (s.present.has(d) ? "P" : "A")),
      totalPresent,
      pct,
    };
  });

  rows.sort((a, b) => {
    const numA = parseFloat(a.roll_no);
    const numB = parseFloat(b.roll_no);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
    return String(a.roll_no).localeCompare(String(b.roll_no));
  });

  return rows;
}

// Builds the landscape "N-day overall attendance %" PDF (as a Buffer) for one
// class+subject+course combination.
function buildOverallReportPdfBuffer(meta, rows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(14).font("Helvetica-Bold").text(
      `${meta.dates.length}-Day Attendance % Report — ${meta.class_name} — ${meta.subject} (${meta.course_type})`,
      { align: "center" }
    );
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica").fillColor("#555").text(
      `Period: ${meta.dates[0]} to ${meta.dates[meta.dates.length - 1]}   |   Students: ${rows.length}`,
      { align: "center" }
    );
    doc.moveDown(0.8);
    doc.fillColor("#000");

    const startX = 30;
    const pageWidth = doc.page.width - 60;
    const fixed = { sno: 22, name: 110, roll: 45, total: 34, pct: 34 };
    const fixedSum = fixed.sno + fixed.name + fixed.roll + fixed.total + fixed.pct;
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
      doc.text(String(cells.pct), x, y, { width: fixed.pct, align: "center" });
    }

    let y = doc.y;
    drawRow(y, true, {
      sno: "S.No",
      name: "Name",
      roll: "Roll No",
      days: meta.dates.map((d) => String(new Date(d + "T00:00:00Z").getUTCDate())),
      total: "Total",
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
    { $group: { _id: { class_name: "$class_name", subject: "$subject", course_type: "$course_type" } } },
  ]);
  const combos = combosAgg.map((c) => c._id);

  const attachments = [];
  for (const combo of combos) {
    const rows = await buildOverallReportRows(combo.class_name, combo.subject, combo.course_type, dates);
    if (!rows.length) continue;
    const pdfBuffer = await buildOverallReportPdfBuffer(
      { class_name: combo.class_name, subject: combo.subject, course_type: combo.course_type, dates },
      rows
    );
    attachments.push({
      filename: `${label}-${combo.class_name}-${combo.subject}-${combo.course_type}.pdf`.replace(/\s+/g, "_"),
      content: pdfBuffer,
    });
  }

  if (!attachments.length) {
    await MonthlyReportLog.create({ month: label, sent_at: Date.now() });
    return { skipped: true, reason: "no attendance data for " + label };
  }

  await resend.emails.send({
    from: "Attendance App <onboarding@resend.dev>",
    to: TEACHER_EMAIL,
    subject: `Monthly Attendance Reports — ${label}`,
    text: `Attached: ${attachments.length} attendance report(s) covering ${label}, one PDF per class/subject/course-type combination.`,
    attachments,
  });

  await MonthlyReportLog.create({ month: label, sent_at: Date.now() });
  console.log(`Monthly combined report emailed for ${label} (${attachments.length} attachment(s))`);
  return { sent: true, month: label, count: attachments.length };
}


// Generates the PDF for a session and emails it to TEACHER_EMAIL.
async function sendAttendancePdfEmail(sessionId) {
  try {
    const session = await ActiveCode.findById(sessionId);
    if (!session || session.pdf_sent || !session.send_pdf) return;
        if (!resend || !TEACHER_EMAIL) {
      console.warn(`Skipping PDF email for session ${sessionId} — email is not configured.`);
      return;
    }

    const records = await Attendance.find({ session_id: sessionId }).lean();
    records.sort((a, b) => {
      const numA = parseFloat(a.roll_no);
      const numB = parseFloat(b.roll_no);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
      return String(a.roll_no).localeCompare(String(b.roll_no));
    });

    const pdfBuffer = await buildAttendancePdfBuffer(
      { ...session.toObject(), dateForPdf: todayDateString() },
      records
    );

        await resend.emails.send({
      from: "Attendance App <onboarding@resend.dev>",
      to: TEACHER_EMAIL,
      subject: `Attendance — ${session.class_name} — ${session.subject} (${session.course_type})`,
      text: `Attached: attendance for ${session.class_name} — ${session.subject} (${session.course_type}), ${records.length} student(s) marked present. Generated automatically 20 minutes after the code was created.`,
      attachments: [{
        filename: `attendance-${session.class_name}-${session.subject}-${session.course_type}.pdf`.replace(/\s+/g, "_"),
        content: pdfBuffer,
      }],
    });

    session.pdf_sent = true;
    await session.save();
    console.log(`Attendance PDF emailed for session ${sessionId}`);
  } catch (err) {
    console.error(`Failed to email attendance PDF for session ${sessionId}:`, err.message);
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
const markAttendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 attendance attempts per device per window
  message: { error: "Too many attempts from this device. Please wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.device_id) || req.ip,
});

const generateCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // teachers may generate several codes across periods
  message: { error: "Too many code generations. Please wait a few minutes." },
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
    const code = generateCode();
    const now = Date.now(); // SERVER time
    const session = await ActiveCode.create({
      code,
      class_name,
      subject,
      course_type,
require_location: require_location !== false, // defaults to true unless explicitly turned off
send_pdf: send_pdf !== false, // defaults to true unless explicitly turned off
created_at: now,
      expires_at: now + CODE_EXPIRY_MS,
    });
  // Auto-email the attendance PDF 20 minutes after this code was generated
if (session.send_pdf) {
  setTimeout(() => sendAttendancePdfEmail(session._id.toString()), PDF_EMAIL_DELAY_MS);
} 
 res.json({
      code,
      session_id: session._id.toString(),
      expires_in_seconds: CODE_EXPIRY_MS / 1000,
      class_name,
      subject,
      course_type,
  require_location: session.require_location,
  send_pdf: session.send_pdf,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the code." });
  }
});

// Look up a student's saved name, class and major subject from their roll
// number (for auto-fill + lock on the student form)
app.get("/api/student/lookup-name", async (req, res) => {
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
    let added = 0;
    let skipped = 0;
    for (const line of lines) {
      const parts = line.split(/,|\t/).map((p) => p.trim());
      const [roll_no, name, class_name, major_subject] = parts;
      if (!roll_no || !name) {
        skipped++;
        continue;
      }
      await Student.findOneAndUpdate(
        { roll_no },
        { roll_no, name, class_name: class_name || "", major_subject: major_subject || "" },
        { upsert: true }
      );
      added++;
    }
    res.json({ success: true, added, skipped, total: lines.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong uploading the list." });
  }
});

// List today's code-generation sessions, newest first, so the teacher can pick
// which one's attendance list to view. Each generated code = one separate session.
app.get("/api/teacher/sessions", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type } = req.query;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const filter = { created_at: { $gte: startOfDay.getTime() } };
    if (class_name) filter.class_name = class_name;
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    const sessions = await ActiveCode.find(filter).sort({ created_at: -1 }).lean();
    res.json({
      sessions: sessions.map((s) => ({
        session_id: s._id.toString(),
        class_name: s.class_name,
        subject: s.subject,
        course_type: s.course_type,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading sessions." });
  }
});

// Get today's attendance list for a class + subject + course type (optionally one specific session)
app.get("/api/teacher/attendance", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type, session_id } = req.query;
    const date = todayDateString();
    const filter = { date };
    if (class_name) filter.class_name = class_name;
    if (subject) filter.subject = subject;
    if (course_type) filter.course_type = course_type;
    if (session_id) filter.session_id = session_id;
    const rows = await Attendance.find(filter).lean();
    // Sort by roll number, ascending (numeric if possible, else alphabetic)
    rows.sort((a, b) => {
      const numA = parseFloat(a.roll_no);
      const numB = parseFloat(b.roll_no);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
      return String(a.roll_no).localeCompare(String(b.roll_no));
    });
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
      date: existing.date,
    });
    if (clash) {
      return res.status(409).json({ error: "That roll number already has an entry for this class, subject and course type today." });
    }

    existing.roll_no = cleanRoll;
    if (student_name !== undefined) existing.student_name = student_name.trim();
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

// Manual download: the last N days' (default 30) overall attendance % PDF
// for one class + subject + course type combination.
app.get("/api/teacher/reports/overall-download", requireTeacherAuth, async (req, res) => {
  try {
    const { class_name, subject, course_type, days } = req.query;
    if (!class_name || !subject || !course_type) {
      return res.status(400).json({ error: "class_name, subject and course_type are required." });
    }
    const n = Math.min(90, Math.max(1, parseInt(days, 10) || 30));
    const dates = lastNDates(n);
    const rows = await buildOverallReportRows(class_name, subject, course_type, dates);
    const pdfBuffer = await buildOverallReportPdfBuffer({ class_name, subject, course_type, dates }, rows);
    const filename = `${n}day-report-${class_name}-${subject}-${course_type}.pdf`.replace(/\s+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the report." });
  }
});

// ---------- STUDENT ROUTE ----------
app.post("/api/student/mark-attendance", markAttendanceLimiter, async (req, res) => {
  try {
    const { roll_no, class_name, code, device_id, name, subject, course_type, major_subject, lat, lng } = req.body;

    if (!roll_no || !class_name || !code || !subject || !course_type) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!/^[0-9]+$/.test(roll_no.trim())) {
      return res.status(400).json({ error: "Roll number must contain digits only." });
    }
    if (!device_id) {
      return res.status(400).json({ error: "Device could not be identified. Please reload the page and try again." });
    }
    

    const now = Date.now(); // SERVER time — client can't fake this
    const cleanRoll = roll_no.trim();

    // 1. Find the active code matching this exact class + subject + course type
    //    (the session the teacher is running)
    const activeCode = await ActiveCode.findOne({ class_name, subject, course_type }).sort({ created_at: -1 });
    if (!activeCode) {
      return res.status(400).json({ error: "No active code found for this class, subject and course type. Ask your teacher to generate one." });
    }
    if (now > activeCode.expires_at) {
      return res.status(400).json({ error: "This code has expired. Ask your teacher for the current code." });
    }
    if (activeCode.code !== String(code).trim()) {
      return res.status(400).json({ error: "Incorrect code." });
    }

   // 1b. Location is only required when the teacher turned the toggle ON for this session
    if (activeCode.require_location) {
      if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "Location is required for this session. Please allow location access and try again." });
      }
      const dist = distanceInMeters(CLASSROOM.lat, CLASSROOM.lng, lat, lng);
      if (dist > RADIUS_METERS) {
        return res.status(403).json({
          error: `You appear to be too far from the classroom (${Math.round(dist)}m away). Attendance can only be marked inside class.`,
        });
      }
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
    const alreadyMarked = await Attendance.findOne({ roll_no: cleanRoll, class_name, subject, course_type, date });
    if (alreadyMarked) {
      return res.status(409).json({ error: "Attendance already marked for this subject and course type today." });
    }

    // 2b. Check if this same device already marked someone's attendance for
    //     this exact class + subject + course_type + date
    const deviceAlreadyUsed = await Attendance.findOne({ device_id, class_name, subject, course_type, date });
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
// Checks for any session whose 20-minute PDF window has passed but the PDF
// hasn't been sent yet, and sends it. Meant to be called every few minutes by
// an external cron service (like cron-job.org) — unlike setTimeout, this
// survives the server spinning down and restarting before the timer fires.
app.get("/api/check-and-send-pdfs", async (req, res) => {
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
app.get("/api/check-and-send-monthly-report", async (req, res) => {
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