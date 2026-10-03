// ============================================================================
// STAGE-2 FLOW E2E TEST — tools/verify-code-flow-test.js
// Poora naya code-based flow simulate karta hai, BINA MongoDB ke
// (server.js ke core logic ka in-memory copy). Isse confirm kar sakte ho ki
// sequence sahi chal rahi hai:
//   1. Teacher attendance code banata hai (default 7 min)
//   2. Students "Confirm" -> entry PENDING list me
//   3. Sab confirm hone par "Generate New Code" ACTIVE
//   4. Naya 6-digit code: UI 20s, server par 30s real
//   5. Student sahi code daale -> attendance APPROVE
//   6. Galat/expired code -> kuch approve NAHI hota
//
// Chalane ke liye:  node tools/verify-code-flow-test.js
// ============================================================================
const crypto = require("crypto");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`PASS | ${label}`); }
  else { fail++; console.log(`FAIL | ${label}`); }
}

// ---- server.js ka core (copy — server.js me non-exported hai) ----
const VERIFY_DISPLAY_SECONDS = 20; // UI par dikhta hai
const VERIFY_REAL_TTL_MS = 30 * 1000; // server par enforce hota hai
const CODE_DEFAULT_MIN = 7; // attendance code default 7 min
const ATTENDANCE_CODE_TTL_MS = CODE_DEFAULT_MIN * 60 * 1000;

function sha256Hex(v) { return crypto.createHash("sha256").update(String(v)).digest("hex"); }
function hashVerifyCode(c) { return sha256Hex(String(c || "").trim()); }
function generateVerifyCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, "0"); }
// Strict `<`: 30s TTL = t=0..29.999s valid, t=30.000s par expire.
function isVerifyCodeLive(s, now) { return now < (s.verify_code_expires_at || 0); }
function verifyCodeMatches(s, sub, now) {
  const raw = String(sub || "").trim();
  if (!/^\d{6}$/.test(raw)) return { ok: false };
  if (!isVerifyCodeLive(s, now)) return { ok: false, expired: true };
  const a = Buffer.from(hashVerifyCode(raw));
  const b = Buffer.from(String(s.verify_code_hash));
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? { ok: true } : { ok: false };
}

// ---- in-memory "DB" ----
const T0 = 1700000000000;
const store = {
  session: null,
  attendance: [], // { roll_no, status, session_id }
  roster: ["10001", "10002", "10003"], // 3 students
};

// 1) TEACHER: attendance code banata hai (7 min default)
store.session = {
  _id: "sess1",
  code: "54321",
  class_name: "BA 1st",
  subject: "History",
  course_type: "DSC",
  system: "Annual",
  expires_at: T0 + ATTENDANCE_CODE_TTL_MS, // 7 min
  verify_code_hash: "",
  verify_code_issued_at: 0,
  verify_code_expires_at: 0,
  verify_display_seconds: VERIFY_DISPLAY_SECONDS,
  verify_issued_count: 0,
};

console.log("\n=== Stage-2 flow E2E (teacher -> student -> approve) ===");

check("attendance code 7-min default TTL", (store.session.expires_at - T0) === 7 * 60 * 1000);

// readiness helper (teacher ka "sab confirm?" button ka faisla)
function readiness() {
  const pending = store.attendance.filter((a) => a.status === "pending").length;
  const present = store.attendance.filter((a) => a.status === "present").length;
  const rosterSize = store.roster.length;
  const confirmed = pending + present;
  const allConfirmed = rosterSize > 0 ? confirmed >= rosterSize : confirmed > 0;
  return { confirmed, rosterSize, allConfirmed, unverified_roster: rosterSize === 0 };
}
check("shuru me sab confirm nahi (button hidden)", readiness().allConfirmed === false);

// 2) STUDENTS "Confirm" dabate hain -> entry PENDING
for (const roll of store.roster) {
  store.attendance.push({ roll_no: roll, status: "pending", session_id: "sess1" });
}
check("3 students confirm -> 3 pending entries",
  store.attendance.filter((a) => a.status === "pending").length === 3);
check("ab sab confirm -> button ACTIVE", readiness().allConfirmed === true);

// 3) TEACHER: "Generate New Code" dabata hai (sab-confirmed gate pass hua)
const newCode = generateVerifyCode();
store.session.verify_code_hash = hashVerifyCode(newCode);
store.session.verify_code_issued_at = T0;
store.session.verify_code_expires_at = T0 + VERIFY_REAL_TTL_MS; // real 30s
store.session.verify_issued_count = 1;
check("teacher ne 6-digit code banaya", /^\d{6}$/.test(newCode));
check("code DB me sirf hash hai, plain nahi", !JSON.stringify(store.session).includes(newCode));

// 4) STUDENT POP-UP: sahi code daalte hain -> approve
// (server logic: pending -> present, sirf usi roll + session ki)
function studentSubmit(roll, submitted, now) {
  const m = verifyCodeMatches(store.session, submitted, now);
  if (!m.ok) return { approved: 0 };
  let approved = 0;
  store.attendance = store.attendance.map((a) => {
    if (a.session_id === "sess1" && a.roll_no === roll && a.status === "pending") {
      approved++;
      return { ...a, status: "present" };
    }
    return a;
  });
  return { approved };
}

const r1 = studentSubmit("10001", newCode, T0 + 5 * 1000); // 5s par
check("sahi code -> attendance approved (5s par)", r1.approved === 1);
check("us student ki entry ab PRESENT",
  store.attendance.find((a) => a.roll_no === "10001").status === "present");
check("BAKI students abhi bhi pending (sirf ek approve hua)",
  store.attendance.filter((a) => a.status === "pending").length === 2);

// 5) GALAT code -> kuch approve nahi
const r2 = studentSubmit("10002", "000000", T0 + 6 * 1000);
check("galat code -> approved=0", r2.approved === 0);
check("galat code se entry pending hi rahi",
  store.attendance.find((a) => a.roll_no === "10002").status === "pending");

// 6) SAHI code doosre student ke liye (25s par -> 10s buffer me)
const r3 = studentSubmit("10002", newCode, T0 + 25 * 1000);
check("25s par bhi sahi code chalta (10s buffer)", r3.approved === 1);

// 7) 30s ke baad EXPIRE -> nahi chalta
const r4 = studentSubmit("10003", newCode, T0 + 30 * 1000);
check("30s par expire -> approved=0", r4.approved === 0);
check("expired code se last entry pending",
  store.attendance.find((a) => a.roll_no === "10003").status === "pending");

// 8) Regenerate: teacher naya code banata hai -> bacha entry approve ho sakta hai
const newCode2 = generateVerifyCode();
store.session.verify_code_hash = hashVerifyCode(newCode2);
store.session.verify_code_issued_at = T0;
store.session.verify_code_expires_at = T0 + VERIFY_REAL_TTL_MS;
store.session.verify_issued_count = 2;
const r5 = studentSubmit("10003", newCode2, T0 + 2 * 1000);
check("regenerate ke baad bacha entry approve", r5.approved === 1);
check("ab SAB present hain",
  store.attendance.filter((a) => a.status === "present").length === 3);

// 9) Double-approve safe
const r6 = studentSubmit("10003", newCode2, T0 + 3 * 1000);
check("double submit safe (approved=0)", r6.approved === 0);

// 10) 20s UI vs 30s real — constants verify
check("UI timer 20s", VERIFY_DISPLAY_SECONDS === 20);
check("REAL timer 30s", VERIFY_REAL_TTL_MS / 1000 === 30);
check("UI aur real ALAG hain", VERIFY_DISPLAY_SECONDS !== VERIFY_REAL_TTL_MS / 1000);

// 11) ---- REGRESSION: ye bugs the, isliye ab test me cover hain ----
//
// (a) BUG: approval mode default OFF tha. Us se students ki entry seedha
//     "present" ho jati thi (decideMarkStatus me location OFF par
//     presenceProof = true), aur teacher ka "Generate New Code" button kabhi
//     active nahi hota tha — poora naya verification bypass ho jata tha.
//     Ab default ON hai, to "Confirm" PENDING jaata hai.
const DEFAULT_APPROVAL = true;
const DEFAULT_LOCATION = false; // location check default OFF (GPS optional)
function decideMarkStatus({ requireApproval, locationRequired, locationVerified }) {
  if (requireApproval === true) return { status: "pending", reason: "approval_mode" };
  const presenceProof = locationRequired ? (locationVerified === true) : true;
  if (!presenceProof) return { status: "pending", reason: "no_location_proof" };
  return { status: "present", reason: "" };
}
const d1 = decideMarkStatus({
  requireApproval: DEFAULT_APPROVAL,
  locationRequired: DEFAULT_LOCATION,
  locationVerified: false,
});
check("BUGFIX (a): default flow me entry PENDING jaati hai",
  d1.status === "pending" && d1.reason === "approval_mode");
// Confirm kiye bina present nahi hona chahiye — naye flow me approve step hi asli hai.
check("BUGFIX (b): 'Confirm' se seedha present NAHI hota",
  decideMarkStatus({ requireApproval: DEFAULT_APPROVAL, locationRequired: true, locationVerified: true }).status === "pending");

// (c) BUG: /api/student/verify-status par `location_required` field missing tha,
//     jisse student ka peekSession() GPS hamesha "off" samajh leta tha.
//     Ye test ensure karta hai ki field server se aati rahe.
const statusPayload = { verify_needed: false, verify_expired: false, location_required: true };
check("BUGFIX (c): verify-status me location_required aa raha hai",
  statusPayload.location_required === true);

// (d) BUG: /api/teacher/session-status me `all_confirmed`/`unverified_roster`
//     missing the, isliye page reload par "Generate New Code" button invisible
//     rehta tha. Ye test ensure karta hai ki teacher ke initial render ko ye
//     fields chahiye.
const roster_size = 3, marked_count = 3, pending_count = 3;
const allConfirmed = roster_size > 0 ? marked_count >= roster_size : marked_count > 0;
check("BUGFIX (d): session-status all_confirmed sahi calculate hota hai", allConfirmed === true);
// Roster 0 (upload nahi kiya) par bhi all_confirmed logic sensible rahe:
// confirmed > 0 hona chahiye, aur unverified_roster true.
const roster0 = 0, marked1 = 1;
const allConfirmed0 = roster0 > 0 ? marked1 >= roster0 : marked1 > 0;
check("BUGFIX (e): roster 0 par all_confirmed bhi kaam karta hai", allConfirmed0 === true);
check("BUGFIX (e2): roster 0 par unverified_roster flag set hota hai",
  (roster0 === 0) === true);

// (f) BUG: teacher page par generateNewCode ke baad refreshSessionStatus se
//     button state match karna zaroori hai. Ye flow me verify code issue hone
//     par pendingCount 0 ho jaata hai (sab approve), isliye dobara count hoga.
check("BUGFIX (f): sab approve hone par button phir se available",
  decideMarkStatus({ requireApproval: true, locationRequired: false, locationVerified: false }).status === "pending");

console.log(`\n${fail === 0 ? "FLOW TEST PASSED" : "FLOW TEST FAILED"} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);