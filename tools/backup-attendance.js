/**
 * Attendance data ka CSV BACKUP (retention badalne se pehle chala lein).
 *
 * Kyun chahiye: attendance retention ab 90 din hai — MongoDB 90 din se purane
 * saare marks khud delete kar deta hai. Agar purana data chahiye to ye script
 * PEHLE ek baar chala lein, poori `attendances` collection CSV me aa jayegi.
 *
 * Chalane ka tarika (PowerShell):
 *   $env:MONGODB_URI="mongodb+srv://..."; node tools/backup-attendance.js
 *   (ya .env na ho to: MONGODB_URI=... node tools/backup-attendance.js)
 *
 * Output: backups/attendance-backup-<date>.csv  (Excel me seedha khulti hai)
 * Note: bade DB par ye minutes le sakta hai — beech me rokna nahi.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("ERROR: MONGODB_URI set nahi hai.");
  console.error('PowerShell: $env:MONGODB_URI="mongodb+srv://..."; node tools/backup-attendance.js');
  process.exit(1);
}

// Chhote hisson me likhne ke liye ek helper (bade DB par memory na bhare).
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "Roll No", "Name", "Class", "Subject", "Course Type", "System", "Date",
  "Marked At (IST)", "Status", "Source", "Distance (m)", "Accuracy (m)",
  "Flags", "Device", "Lat", "Lng", "Session Id", "Created At (IST)",
];

function istTime(ms) {
  try {
    return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  } catch (e) {
    return String(ms);
  }
}

async function main() {
  const outDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(outDir, `attendance-backup-${stamp}.csv`);
  const stream = fs.createWriteStream(file, { encoding: "utf8" });
  stream.write("\uFEFF" + HEADER.join(",") + "\r\n"); // BOM: Excel ke liye

  console.log("MongoDB se connect ho rahe hain…");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  // Collection ka naam mongoose se "attendances" banta hai. Kisi purane DB me
  // naam alag ho to yahan fallback lag jata hai (khali CSV na bane).
  let collectionName = "attendances";
  let probe = await mongoose.connection.collection(collectionName).estimatedDocumentCount().catch(() => 0);
  if (!probe) {
    const names = await mongoose.connection.db.listCollections().toArray().catch(() => []);
    const candidate = names
      .map((c) => c.name)
      .find((n) => n.toLowerCase().includes("attendance"));
    if (candidate && candidate !== collectionName) {
      collectionName = candidate;
      probe = await mongoose.connection.collection(collectionName).estimatedDocumentCount().catch(() => 0);
      console.log(`Note: collection "${collectionName}" use kar rahe hain.`);
    }
    if (!probe) {
      console.log("Is database me attendance collection khali/nahi mili. Available collections:");
      names.forEach((c) => console.log("  - " + c.name));
    }
  }
  const collection = mongoose.connection.collection(collectionName);
  const total = await collection.estimatedDocumentCount().catch(() => null);
  console.log(total === null ? "Documents: (count nahi mila)" : `Documents: ${total}`);

  let count = 0;
  const cursor = collection.find({}).batchSize(500);
  for await (const doc of cursor) {
    stream.write([
      doc.roll_no, doc.student_name, doc.class_name, doc.subject, doc.course_type,
      doc.system || "Annual", doc.date, istTime(doc.marked_at), doc.status || "present",
      doc.source || "student", doc.distance_m, doc.accuracy, (doc.flags || []).join("|"),
      doc.device_id, doc.lat, doc.lng, doc.session_id, doc.createdAtDate ? istTime(doc.createdAtDate) : "",
    ].map(csvCell).join(",") + "\r\n");
    count++;
    if (count % 5000 === 0) console.log(`  … ${count} rows likhi gayi`);
  }

  await new Promise((resolve) => stream.end(resolve));
  console.log(`\nBACKUP DONE: ${count} rows`);
  console.log(`File: ${file}`);
  console.log("Ab is file ko safe jagah rakh lein (Google Drive / pen drive).");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Backup FAILED:", (err && err.message) || err);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
