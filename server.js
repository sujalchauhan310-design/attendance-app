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

const app = express();
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

// Remembers a student's name and major subject against their roll number,
// so it can auto-fill next time — permanently, across any device.
const studentSchema = new mongoose.Schema({
  roll_no: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  major_subject: { type: String, default: "" },
});
const Student = mongoose.model("Student", studentSchema);

const activeCodeSchema = new mongoose.Schema({
  code: String,
  class_name: String,
  subject: String,
  course_type: String, // DSC / SEC / GE / AEC / VAC / MDC — same subject under
                        // a different type is a different class, no clash
require_location: {type: Boolean, default: true },
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
});
// Same roll number can't mark attendance twice for the same
// class + subject + course type on the same day.
// (roll_no + subject + course_type + class_name + date, as requested)
attendanceSchema.index(
  { roll_no: 1, class_name: 1, subject: 1, course_type: 1, date: 1 },
  { unique: true }
);
const Attendance = mongoose.model("Attendance", attendanceSchema);

// ---------- HELPERS ----------
function todayDateString() {
  // Uses SERVER date, not client date
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function generateCode() {
  return Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit code
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
    const { class_name, subject, course_type, require_location } = req.body;
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
require_location: require_location !==false,
      created_at: now,
      expires_at: now + CODE_EXPIRY_MS,
    });
    res.json({
      code,
      session_id: session._id.toString(),
      expires_in_seconds: CODE_EXPIRY_MS / 1000,
      class_name,
      subject,
      course_type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the code." });
  }
});

// Look up a student's saved name and major subject from their roll number (for auto-fill)
app.get("/api/student/lookup-name", async (req, res) => {
  try {
    const { roll_no } = req.query;
    if (!roll_no) return res.json({ name: "", major_subject: "" });
    const student = await Student.findOne({ roll_no: roll_no.trim() });
    res.json({
      name: student ? student.name : "",
      major_subject: student ? student.major_subject || "" : "",
    });
  } catch (err) {
    console.error(err);
    res.json({ name: "", major_subject: "" });
  }
});

// Teacher uploads the full class roster in one go: roll_no, name, major_subject per line.
// Any roll number already known gets updated; new ones get added.
// Accepted format per line: "rollno,name,major_subject" or "rollno,name" (tab-separated also works).
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
      const [roll_no, name, major_subject] = parts;
      if (!roll_no || !name) {
        skipped++;
        continue;
      }
      await Student.findOneAndUpdate(
        { roll_no },
        { roll_no, name, major_subject: major_subject || "" },
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

    // 3. Save/update the student's name & major subject (so future roll-no entries auto-fill, on any device)
    let student_name = name ? name.trim() : "";
    let student_major_subject = major_subject ? major_subject.trim() : "";
    if (student_name) {
      await Student.findOneAndUpdate(
        { roll_no: cleanRoll },
        { roll_no: cleanRoll, name: student_name, major_subject: student_major_subject || undefined },
        { upsert: true }
      );
    } else {
      const existing = await Student.findOne({ roll_no: cleanRoll });
      student_name = existing ? existing.name : "";
      if (!student_major_subject) student_major_subject = existing ? existing.major_subject || "" : "";
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

    res.json({ success: true, message: "Attendance marked successfully!", roll_no, date });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key error from the unique index — a race condition safety net
      return res.status(409).json({ error: "Attendance already marked for this subject and course type today." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance server running at http://localhost:${PORT}`);
  console.log(`Teacher page: http://localhost:${PORT}/teacher.html`);
  console.log(`Student page: http://localhost:${PORT}/student.html`);
});