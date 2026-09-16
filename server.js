/**
 * College Attendance System — Backend
 * -------------------------------------------------
 * Features:
 *  - Teacher generates a rotating 5-digit code (server-side, expires in 5 min)
 *  - Server time is always used (client device time is never trusted)
 *  - One roll number can mark attendance only ONCE per date+period
 *  - All validation happens on the server, never trusting client JS
 *  - Data stored in a simple JSON file (no native database compilation needed)
 *
 * HOW TO RUN:
 *   1. npm install
 *   2. node server.js
 *   3. Open http://localhost:3000/teacher.html   (for teacher)
 *      Open http://localhost:3000/student.html   (for student)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- CONFIG ----------
const CODE_EXPIRY_MS = 5 * 60 * 1000; // code is valid for 5 minutes
const DB_FILE = path.join(__dirname, "data.json");

// ---------- SIMPLE JSON "DATABASE" ----------
function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    return { activeCodes: [], attendance: [] };
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read data file, starting fresh:", err);
    return { activeCodes: [], attendance: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

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
app.post("/api/teacher/generate-code", (req, res) => {
  const { class_name, period } = req.body;
  if (!class_name || !period) {
    return res.status(400).json({ error: "class_name and period are required" });
  }

  const code = generateCode();
  const now = Date.now(); // SERVER time

  const data = loadData();
  data.activeCodes.push({
    code,
    class_name,
    period,
    created_at: now,
    expires_at: now + CODE_EXPIRY_MS,
  });
  saveData(data);

  res.json({
    code,
    expires_in_seconds: CODE_EXPIRY_MS / 1000,
    class_name,
    period,
  });
});

// Get today's attendance list for a class/period
app.get("/api/teacher/attendance", (req, res) => {
  const { class_name, period } = req.query;
  const date = todayDateString();
  const data = loadData();

  let rows = data.attendance.filter((r) => r.date === date);
  if (class_name) rows = rows.filter((r) => r.class_name === class_name);
  if (period) rows = rows.filter((r) => r.period === period);

  rows.sort((a, b) => a.marked_at - b.marked_at);

  res.json({ date, count: rows.length, records: rows });
});

// ---------- STUDENT ROUTE ----------

app.post("/api/student/mark-attendance", (req, res) => {
  const { roll_no, class_name, period, code } = req.body;

  if (!roll_no || !class_name || !period || !code) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const now = Date.now(); // SERVER time — client can't fake this
  const data = loadData();

  // 1. Find the latest active code for this class/period
  const matchingCodes = data.activeCodes
    .filter((c) => c.class_name === class_name && c.period === period)
    .sort((a, b) => b.created_at - a.created_at);

  const activeCode = matchingCodes[0];

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
  const alreadyMarked = data.attendance.some(
    (r) =>
      r.roll_no === roll_no.trim() &&
      r.class_name === class_name &&
      r.period === period &&
      r.date === date
  );
  if (alreadyMarked) {
    return res.status(409).json({ error: "Attendance already marked for this roll number today." });
  }

  // 3. Save attendance
  data.attendance.push({
    roll_no: roll_no.trim(),
    class_name,
    period,
    date,
    marked_at: now,
  });
  saveData(data);

  res.json({ success: true, message: "Attendance marked successfully!", roll_no, date, period });
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance server running at http://localhost:${PORT}`);
  console.log(`Teacher page: http://localhost:${PORT}/teacher.html`);
  console.log(`Student page: http://localhost:${PORT}/student.html`);
});
