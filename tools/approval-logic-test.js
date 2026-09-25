/**
 * Smart-approval logic ka unit test (koi test framework nahi).
 * decideMarkStatus() decide karta hai ki mark "present" hoga ya "pending".
 * Sabse zaroori baat: location VERIFIED + koi flag nahi => present (teacher ko
 * tap nahi karna padta), aur fail/flag wale pending. Agar ye logic toote to
 * ya to proxy nikal jayega ya genuine students pending me atak jayenge.
 * Chalao: node tools/approval-logic-test.js
 */
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=500&connectTimeoutMS=500";
process.env.ALLOW_START_WITHOUT_DB = "true";
process.env.PORT = "3998";
process.env.TEACHER_PASSWORD = "test-password-123";

const { decideMarkStatus, PENDING_REASON_TEXT } = require("../server.js");

const cases = [
  {
    name: "verified + koi flag nahi -> seedha present",
    input: { requireApproval: false, autoReview: true, locationRequired: true, locationVerified: true, flags: [] },
    expect: { status: "present", reason: "" },
  },
  {
    name: "location proof nahi mili (GPS fail / net off) -> pending",
    input: { requireApproval: false, autoReview: true, locationRequired: true, locationVerified: false, flags: [] },
    expect: { status: "pending", reason: "no_location_proof" },
  },
  {
    name: "session me location check OFF -> pending (proof hi nahi)",
    input: { requireApproval: false, autoReview: true, locationRequired: false, locationVerified: false, flags: [] },
    expect: { status: "pending", reason: "location_check_off" },
  },
  {
    name: "verified par flag laga (shared coordinates) -> pending",
    input: {
      requireApproval: false, autoReview: true, locationRequired: true, locationVerified: true,
      flags: ["shared_coordinates"],
    },
    expect: { status: "pending", reason: "flagged" },
  },
  {
    name: "teacher ne approval mode ON kiya -> sab pending",
    input: { requireApproval: true, autoReview: true, locationRequired: true, locationVerified: true, flags: [] },
    expect: { status: "pending", reason: "approval_mode" },
  },
  {
    name: "approval mode ON + verified: pending hi rahega (approval mode sabse upar)",
    input: { requireApproval: true, autoReview: false, locationRequired: true, locationVerified: true, flags: ["accuracy_poor"] },
    expect: { status: "pending", reason: "approval_mode" },
  },
  {
    name: "smart approval OFF (autoReview=false) + verified + flag -> present",
    input: { requireApproval: false, autoReview: false, locationRequired: true, locationVerified: true, flags: ["accuracy_poor"] },
    expect: { status: "present", reason: "" },
  },
  {
    name: "flags me khaali string ho to bhi present (junk flag galti se pending na kare)",
    input: { requireApproval: false, autoReview: true, locationRequired: true, locationVerified: true, flags: ["", null] },
    expect: { status: "present", reason: "" },
  },
];

let failures = 0;
for (const c of cases) {
  const got = decideMarkStatus(c.input);
  const ok = got.status === c.expect.status && got.reason === c.expect.reason;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${c.name} -> ${got.status}/${got.reason || "-"}` +
    (ok ? "" : `  (expected ${c.expect.status}/${c.expect.reason || "-"})`));
}

// Har pending reason ke liye teacher/student ko dikhne wala text hona chahiye.
for (const reason of ["approval_mode", "no_location_proof", "location_check_off", "flagged"]) {
  const ok = typeof PENDING_REASON_TEXT[reason] === "string" && PENDING_REASON_TEXT[reason].length > 5;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | reason text present: ${reason}`);
}

console.log(failures ? `APPROVAL LOGIC TEST FAILED (${failures})` : "APPROVAL LOGIC TEST PASSED");
process.exit(failures ? 1 : 0);
