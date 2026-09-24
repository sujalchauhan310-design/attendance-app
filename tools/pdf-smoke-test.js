/**
 * tools/pdf-smoke-test.js — lib/pdf-reports.js ka end-to-end smoke test
 * ---------------------------------------------------------------------
 * Kya karta hai:
 *   1. tmp/ folder banata hai (agar nahi hai).
 *   2. Paanch PDF + ek HTML email body generate karta hai:
 *        a) session PDF  (30 marks: 3 flagged + 2 pending)
 *        b) session PDF  (0 records — empty state)
 *        c) overall PDF  (30 dates x 40 students => day-by-day GRID variant)
 *        d) overall PDF  (365 dates x 120 students => SUMMARY variant + % bars)
 *        e) student PDF  (6 subjects, overall < 75% => warning box bhi test hoti hai)
 *        f) tmp/report-email.html (buildReportEmailHtml)
 *   3. Har artefact ki ek line print karta hai:
 *        <file> - <bytes> bytes - <pages> pages
 *   4. Koi bhi error aane par exit code 1.
 *
 * Run:  node tools/pdf-smoke-test.js
 * NOTE: Test framework nahi chahiye — plain node + assert-style manual checks.
 */
const fs = require("fs");
const path = require("path");

// Sirf apna module — server.js / DB / network kuch nahi.
const reports = require("../lib/pdf-reports");

const TMP_DIR = path.join(__dirname, "..", "tmp");
const COLLEGE = "Government Degree College, Rampur";
const TEACHER = "Dr. R. K. Sharma";
const END_DATE = "2026-09-25"; // reports ki aakhri IST date (deterministic output)
const GENERATED_AT = Date.parse("2026-09-25T04:39:00.000Z"); // 10:09 IST
const MIN_PDF_BYTES = 20000; // sanity gate: itni chhoti PDF ka matlab kuch draw nahi hua

// Deterministic pseudo-random (LCG) — har run me bilkul same data banta hai,
// isliye byte-size/page-count compare karna aasan rehta hai.
let seed = 20260925;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function randInt(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}
function pickOne(list) {
  return list[Math.floor(rnd() * list.length)];
}

// Realistic dummy Indian names (roll numbers bhi college style: 001, 002, ...).
const FIRST_NAMES = [
  "Aarav", "Ananya", "Bhavesh", "Chhavi", "Deepak", "Divya", "Faizan", "Garima", "Harsh", "Ishita",
  "Jatin", "Kavya", "Lakshay", "Meera", "Naveen", "Ojaswi", "Pankaj", "Priya", "Rahul", "Ritika",
  "Sahil", "Sanjana", "Tanmay", "Tanya", "Ujjwal", "Vandana", "Vikram", "Yash", "Zoya", "Aman",
  "Bhavna", "Chetan", "Diksha", "Gaurav", "Himani", "Irfan", "Jyoti", "Kiran", "Manish", "Neha",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Yadav", "Singh", "Kumar", "Gupta", "Chauhan", "Rathore", "Meena", "Jain",
  "Saini", "Bhardwaj", "Mishra", "Pandey", "Tiwari", "Khan", "Ansari", "Nair", "Patel", "Rastogi",
];
const SUBJECTS = ["Mathematics", "Physics", "Chemistry", "Botany", "History", "Political Science"];
const COURSE_TYPES = ["DSC", "SEC", "GE", "AEC", "VAC", "MDC"];

function makeStudents(count, rollPrefix) {
  return Array.from({ length: count }, (_, i) => ({
    roll_no: `${rollPrefix}${String(i + 1).padStart(3, "0")}`,
    student_name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 7) % LAST_NAMES.length]}`,
  }));
}

// "2026-09-25" se peeche n dates (oldest first) — report window banane ke liye.
function lastNDates(n, endDate) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

// Ek session ke 30 marks: 3 flagged, 2 pending, baaki clean.
// marked_at 10:00 IST se shuru hokar ~40 minute me failta hai (bar chart test ho jaye).
function makeSessionRecords(students) {
  const base = Date.parse("2026-09-25T04:30:00.000Z"); // 10:00 IST
  const flagged = { 4: ["shared_coordinates"], 9: ["device_used_for_other_roll"], 22: ["accuracy_poor", "distance_far"] };
  const pending = [15, 26];
  return Array.from({ length: 30 }, (_, i) => {
    const student = students[i];
    const isNoisy = i === 22; // ye mark accuracy_poor + distance_far dono flag karta hai
    return {
      roll_no: student.roll_no,
      student_name: student.student_name,
      subject: "Mathematics",
      course_type: "DSC",
      marked_at: base + i * 80000 + randInt(0, 60000), // ~80s apart + jitter
      status: pending.includes(i) ? "pending" : "present",
      flags: flagged[i] || [],
      lat: 31.10648 + rnd() * 0.0004,
      lng: 77.15175 + rnd() * 0.0004,
      accuracy: isNoisy ? 55 + rnd() * 20 : 3 + rnd() * 18,
      distance_m: isNoisy ? 110 + rnd() * 40 : 2 + rnd() * 60,
      device_id: `dev-${randInt(1, 18)}`,
      source: "student",
    };
  });
}

// Overall report ke rows: har student ke dayMarks (P/A) + total + %.
// heldFlags = kis din class hui (yahi denominator = classDays hai), presentP = present chance.
function buildOverallRows(students, dates, heldFlags, presentP) {
  const classDays = heldFlags.filter(Boolean).length;
  return students.map((student) => {
    let present = 0;
    const dayMarks = dates.map((date, index) => {
      if (!heldFlags[index]) return "A"; // class hi nahi hui — register me A hi dikhta hai
      if (rnd() < presentP) {
        present++;
        return "P";
      }
      return "A";
    });
    return {
      roll_no: student.roll_no,
      student_name: student.student_name,
      dayMarks,
      totalPresent: present,
      pct: classDays ? Number(((present / classDays) * 100).toFixed(1)) : 0,
    };
  });
}

// Student report ke 6 subjects — pehla subject jaan-boojh kar 75% se neeche hai,
// taaki "75% se kam" warning box bhi test ho jaye.
function buildStudentSubjects() {
  return SUBJECTS.map((subject, index) => {
    const held = 28 + index * 3;
    const attended = index === 0 ? Math.round(held * 0.55) : Math.max(10, held - randInt(1, 12));
    return {
      subject,
      course_type: COURSE_TYPES[index % COURSE_TYPES.length],
      attended,
      held,
      pct: Number(((attended / held) * 100).toFixed(1)),
    };
  });
}

// PDF ke page count ke liye "/Type /Page" objects gin lete hain (extra dependency nahi).
// "/Type /Pages" (plural tree node) ko regex jaan-boojh kar skip karta hai.
function countPdfPages(buffer) {
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

// Ek artefact likhne + record karne ka ek hi rasta.
const results = [];
function reportArtefact(filePath, buffer, kind, expectBig) {
  fs.writeFileSync(filePath, buffer);
  const relative = path.relative(path.join(__dirname, ".."), filePath).replace(/\\/g, "/");
  results.push({
    file: relative,
    bytes: buffer.length,
    pages: kind === "pdf" ? countPdfPages(buffer) : 0,
    isPdf: kind === "pdf",
    expectBig: Boolean(expectBig),
  });
  return buffer;
}

// Chhota assertion helper (koi test framework nahi) — fail hone par throw.
function check(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// MAIN — saare artefacts banate hain, assertions chalate hain, phir lines print.
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true }); // tmp/ na ho to bana do

  const students40 = makeStudents(40, "BA1-");
  const students120 = makeStudents(120, "BSC1-");
  const sessionRecords = makeSessionRecords(students40);
  const session = {
    class_name: "BA 1st",
    subject: "Mathematics",
    course_type: "DSC",
    system: "Semester",
    code: "48213",
    dateForPdf: END_DATE,
    created_at: Date.parse("2026-09-25T04:30:00.000Z"), // 10:00 IST
    expires_at: Date.parse("2026-09-25T04:37:00.000Z"), // 10:07 IST
    require_approval: true,
    require_location: true,
  };
  const opts = { collegeName: COLLEGE, generatedAt: GENERATED_AT, teacherName: TEACHER };

  // ---- Analytics sanity: yahi numbers PDF/email me jaate hain, isliye pehle check ----
  const analytics = reports.computeSessionAnalytics(sessionRecords);
  check(analytics.total === 30, `total should be 30, got ${analytics.total}`);
  check(analytics.flagged_count === 3, `flagged_count should be 3, got ${analytics.flagged_count}`);
  check(analytics.pending_count === 2, `pending_count should be 2, got ${analytics.pending_count}`);
  check(analytics.confirmed_count === 28, `confirmed_count should be 28, got ${analytics.confirmed_count}`);
  check(analytics.risk_rows.length === 3, `risk_rows should be 3, got ${analytics.risk_rows.length}`);
  check(analytics.top_flags.length === 4, `top_flags should be 4, got ${analytics.top_flags.length}`);
  check(analytics.device_count > 0, "device_count should be > 0");
  check(analytics.timeline.length >= 1 && analytics.timeline.length <= 24,
    `timeline should be 1..24 buckets, got ${analytics.timeline.length}`);
  check(reports.formatIstTime(GENERATED_AT) === "10:09", `IST time should be 10:09, got ${reports.formatIstTime(GENERATED_AT)}`);
  check(reports.formatIstDate(GENERATED_AT) === "2026-09-25", `IST date wrong: ${reports.formatIstDate(GENERATED_AT)}`);

  // ---- (a) session PDF: 30 marks (3 flagged + 2 pending) ----
  reportArtefact(path.join(TMP_DIR, "session-with-marks.pdf"),
    await reports.buildSessionPdfBuffer(session, sessionRecords, opts), "pdf", true);

  // ---- (b) session PDF: 0 records (empty state: header + zero KPI + note box) ----
  reportArtefact(path.join(TMP_DIR, "session-empty.pdf"),
    await reports.buildSessionPdfBuffer(session, [], opts), "pdf", false);

  // ---- (c) overall GRID variant: 30 dates x 40 students ----
  const gridDates = lastNDates(30, END_DATE);
  const gridHeld = gridDates.map(() => rnd() < 0.83); // kis din class hui
  const gridRows = buildOverallRows(students40, gridDates, gridHeld, 0.86);
  reportArtefact(path.join(TMP_DIR, "overall-grid-30d.pdf"),
    await reports.buildOverallReportPdfBuffer({
      class_name: "BA 1st", subject: "Mathematics", course_type: "DSC", system: "Semester",
      dates: gridDates, classDays: gridHeld.filter(Boolean).length, collegeName: COLLEGE, generatedAt: GENERATED_AT,
    }, gridRows, opts), "pdf", true);

  // ---- (d) overall SUMMARY variant: 365 dates x 120 students (> 45 din => summary + % bars) ----
  const yearDates = lastNDates(365, END_DATE);
  const yearHeld = yearDates.map(() => rnd() < 0.72);
  const yearRows = buildOverallRows(students120, yearDates, yearHeld, 0.78);
  reportArtefact(path.join(TMP_DIR, "overall-summary-365d.pdf"),
    await reports.buildOverallReportPdfBuffer({
      class_name: "BA 1st", subject: "Mathematics", course_type: "DSC", system: "Annual",
      dates: yearDates, classDays: yearHeld.filter(Boolean).length, collegeName: COLLEGE, generatedAt: GENERATED_AT,
    }, yearRows, opts), "pdf", true);

  // ---- (e) student report: 6 subjects, pehla subject < 75% (warning box test) ----
  const student = {
    roll_no: "BA1-004", name: "Ishita Verma", class_name: "BA 1st",
    major_subject: "History", email: "ishita.verma@example.edu",
  };
  const subjectRows = buildStudentSubjects();
  reportArtefact(path.join(TMP_DIR, "student-report.pdf"),
    await reports.buildStudentReportPdfBuffer({ class_name: "BA 1st", dates: gridDates }, student, subjectRows, opts), "pdf", true);

  // ---- (f) email HTML body: analytics + risk rows + worst-10 students ----
  const worstTen = gridRows.slice().sort((a, b) => a.pct - b.pct).slice(0, 10);
  const peak = analytics.timeline.reduce((best, bucket) => (bucket.count > best.count ? bucket : best), { label: "-", count: 0 });
  const html = reports.buildReportEmailHtml({
    title: "Attendance Report",
    subtitle: `BA 1st | Mathematics (DSC, Semester) | ${gridDates[0]} to ${gridDates[gridDates.length - 1]}`,
    collegeName: COLLEGE,
    generatedAt: GENERATED_AT,
    kpis: [
      { label: "Total marked", value: analytics.total, tone: "sky" },
      { label: "Confirmed", value: analytics.confirmed_count, tone: "green" },
      { label: "Pending", value: analytics.pending_count, tone: "amber" },
      { label: "Flagged", value: analytics.flagged_count, tone: "red" },
      { label: "Avg accuracy", value: `${analytics.avg_accuracy} m`, tone: "navy" },
      { label: "Devices", value: analytics.device_count, tone: "navy" },
    ],
    analyticsRows: [
      { label: "First mark (IST)", value: reports.formatIstTime(analytics.first_marked_at) },
      { label: "Last mark (IST)", value: reports.formatIstTime(analytics.last_marked_at) },
      { label: "Peak 10-min bucket", value: `${peak.label} (${peak.count} marks)` },
      { label: "Average distance from classroom", value: `${analytics.avg_distance_m} m` },
      { label: "Distance range", value: `${analytics.min_distance_m} m to ${analytics.max_distance_m} m` },
      { label: "Top flags", value: analytics.top_flags.map((f) => `${f.flag} (${f.count})`).join(", ") || "none" },
    ],
    riskRows: analytics.risk_rows.map((row) => ({
      roll_no: row.roll_no,
      name: row.student_name,
      detail: `${row.flags.join(", ")} | ${row.distance_m} m, accuracy ${row.accuracy} m`,
    })),
    bottomRows: worstTen.map((row) => ({ name: row.student_name, roll_no: row.roll_no, pct: row.pct })),
    bottomTitle: "Lowest attendance (last 30 days)",
    footerNote: "Attendance 75% se kam hai to exam form / scholarship me dikkat aa sakti hai. Flagged marks teacher Review tab me verify karta hai.",
  });
  check(html.indexOf("<!DOCTYPE html>") === 0, "email html should start with <!DOCTYPE html>");
  check(html.indexOf("<html") !== -1, "email html should contain the <html> root element");
  check(html.indexOf("<style") === -1, "email html must not contain a <style> block (Gmail strip kar deta hai)");
  check(html.indexOf("<table") !== -1, "email html should be table-based");
  // XSS guard: DB/teacher text HTML inject na kar sake.
  const escaped = reports.buildReportEmailHtml({ title: "<script>alert(1)</script>" });
  check(escaped.indexOf("<script>") === -1 && escaped.indexOf("&lt;script&gt;") !== -1,
    "email html must escape HTML supplied in strings");
  reportArtefact(path.join(TMP_DIR, "report-email.html"), Buffer.from(html, "utf8"), "html", false);

  // ---- Output: ek line per artefact + pass/fail summary ----
  let failures = 0;
  console.log("");
  for (const item of results) {
    console.log(`${item.file} - ${item.bytes} bytes - ${item.pages} pages`);
    if (item.isPdf && item.pages < 1) {
      failures++;
      console.log(`  FAIL: ${item.file} has 0 pages (PDF khali lagti hai).`);
    }
    if (item.isPdf && item.expectBig && item.bytes < MIN_PDF_BYTES) {
      failures++;
      console.log(`  FAIL: ${item.file} is only ${item.bytes} bytes (< ${MIN_PDF_BYTES}) — drawing skip ho gayi lagti hai.`);
    }
  }
  const pdfCount = results.filter((item) => item.isPdf).length;
  console.log("");
  console.log("NOTE: tmp/session-empty.pdf jaan-boojh kar chhoti hai (0 records => sirf header + zero KPI + note box).");
  console.log(`Artefacts: ${pdfCount} PDF + ${results.length - pdfCount} HTML | assertions: passed | errors: ${failures}`);
  if (failures > 0) {
    process.exitCode = 1;
    console.log("SMOKE TEST FAILED");
    return;
  }
  console.log("SMOKE TEST PASSED");
}

// Koi bhi error (assertion ya pdfkit) => stack print + exit code 1.
main().catch((error) => {
  console.error("SMOKE TEST ERROR:", (error && error.stack) || error);
  process.exitCode = 1;
});
