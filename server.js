/**
 * College Attendance System — Backend
 * -------------------------------------------------
 * Features:
 *  - Teacher generates a rotating 5-digit code (server-side, expires in 5 min)
 *  - Server time is always used (client device time is never trusted)
 *  - One roll number can mark attendance only ONCE per date+period
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- CONFIG ----------
const CODE_EXPIRY_MS = 5 * 60 * 1000; // code is valid for 5 minutes
const MONGODB_URI = process.env.MONGODB_URI;

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

// Remembers a student's name against their roll number, so it can
// auto-fill next time — permanently, across any device.
const studentSchema = new mongoose.Schema({
  roll_no: { type: String, required: true, unique: true },
  name: { type: String, required: true },
});
const Student = mongoose.model("Student", studentSchema);

const activeCodeSchema = new mongoose.Schema({
  code: String,
  class_name: String,
  period: String,
  created_at: Number,
  expires_at: Number,
});
const ActiveCode = mongoose.model("ActiveCode", activeCodeSchema);

const attendanceSchema = new mongoose.Schema({
  roll_no: String,
  student_name: String,
  subject: String,
  class_name: String,
  period: String,
  date: String, // YYYY-MM-DD
  marked_at: Number,
  device_id: String,
});
// Same roll number can't mark attendance twice for the same class/period/date
attendanceSchema.index({ roll_no: 1, class_name: 1, period: 1, date: 1 }, { unique: true });
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

// ---------- TEACHER ROUTES ----------

// Generate a new attendance code for a class/period
app.post("/api/teacher/generate-code", async (req, res) => {
  try {
    const { class_name, period } = req.body;
    if (!class_name || !period) {
      return res.status(400).json({ error: "class_name and period are required" });
    }

    const code = generateCode();
    const now = Date.now(); // SERVER time

    await ActiveCode.create({
      code,
      class_name,
      period,
      created_at: now,
      expires_at: now + CODE_EXPIRY_MS,
    });

    res.json({
      code,
      expires_in_seconds: CODE_EXPIRY_MS / 1000,
      class_name,
      period,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong generating the code." });
  }
});

// Look up a student's saved name from their roll number (for auto-fill)
app.get("/api/student/lookup-name", async (req, res) => {
  try {
    const { roll_no } = req.query;
    if (!roll_no) return res.json({ name: "" });
    const student = await Student.findOne({ roll_no: roll_no.trim() });
    res.json({ name: student ? student.name : "" });
  } catch (err) {
    console.error(err);
    res.json({ name: "" });
  }
});

// Get today's attendance list for a class/period
app.get("/api/teacher/attendance", async (req, res) => {
  try {
    const { class_name, period } = req.query;
    const date = todayDateString();

    const filter = { date };
    if (class_name) filter.class_name = class_name;
    if (period) filter.period = period;

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

// ---------- STUDENT ROUTE ----------

app.post("/api/student/mark-attendance", async (req, res) => {
  try {
    const { roll_no, class_name, period, code, device_id, name, subject } = req.body;

    if (!roll_no || !class_name || !period || !code) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (!device_id) {
      return res.status(400).json({ error: "Device could not be identified. Please reload the page and try again." });
    }

    const now = Date.now(); // SERVER time — client can't fake this
    const cleanRoll = roll_no.trim();

    // 1. Find the latest active code for this class/period
    const activeCode = await ActiveCode.findOne({ class_name, period }).sort({ created_at: -1 });

    if (!activeCode) {
      return res.status(400).json({ error: "No active code found for this class/period. Ask your teacher to generate one." });
    }
    if (now > activeCode.expires_at) {
      return res.status(400).json({ error: "This code has expired. Ask your teacher for the current code." });
    }
    if (activeCode.code !== String(code).trim()) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    // 2. Check for duplicate attendance (roll_no + class + date + period)
    const date = todayDateString();
    const alreadyMarked = await Attendance.findOne({ roll_no: cleanRoll, class_name, period, date });
    if (alreadyMarked) {
      return res.status(409).json({ error: "Attendance already marked for this roll number today." });
    }

    // 2b. Check if this same device already marked someone's attendance for this class/period/date
    const deviceAlreadyUsed = await Attendance.findOne({ device_id, class_name, period, date });
    if (deviceAlreadyUsed) {
      return res.status(409).json({ error: "Attendance has already been marked from this device for this period today." });
    }

    // 3. Save/update the student's name (so future roll-no entries auto-fill it, on any device)
    let student_name = name ? name.trim() : "";
    if (student_name) {
      await Student.findOneAndUpdate(
        { roll_no: cleanRoll },
        { roll_no: cleanRoll, name: student_name },
        { upsert: true }
      );
    } else {
      const existing = await Student.findOne({ roll_no: cleanRoll });
      student_name = existing ? existing.name : "";
    }

    // 4. Save attendance
    await Attendance.create({
      roll_no: cleanRoll,
      student_name,
      subject: subject ? subject.trim() : "",
      class_name,
      period,
      date,
      marked_at: now,
      device_id,
    });

    res.json({ success: true, message: "Attendance marked successfully!", roll_no, date, period });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key error from the unique index — a race condition safety net
      return res.status(409).json({ error: "Attendance already marked for this roll number today." });
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
