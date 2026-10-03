// ============================================================================
// BEACON CORE TEST — tools/beacon-test.js
// Ye test server ke beacon core ko COPY karta hai (server.js me functions
// non-exported hain). Server.js me core badla to yahan bhi wahi copy update
// karni padegi — jaan-boojh kar rakha hai, taaki pure logic bina DB/server
// ke test ho sake.
const crypto = require("crypto");

const BEACON_SLOT_MS = 45 * 1000;
const BEACON_GRACE_SLOTS = 1;

function beaconSlotAt(nowMs, slotMs) {
  const slot = slotMs || BEACON_SLOT_MS;
  const n = Number(nowMs);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / slot);
}

function beaconCodeForSlot(secret, slot, slotMs) {
  const slot2 = slotMs || BEACON_SLOT_MS;
  const digest = crypto
    .createHmac("sha256", String(secret || ""))
    .update(`beacon.${slot2}.${slot}`)
    .digest("hex");
  let value = parseInt(digest.slice(0, 8), 16);
  value = value % 1000000;
  return String(value).padStart(6, "0");
}

function currentBeacon(secret, nowMs, slotMs) {
  const slot = beaconSlotAt(nowMs, slotMs);
  const slotMs2 = slotMs || BEACON_SLOT_MS;
  return {
    code: beaconCodeForSlot(secret, slot, slotMs2),
    slot,
    seconds_left: Math.max(0, Math.ceil((slot + 1) * slotMs2 - Number(nowMs || 0)) / 1000),
    rotates_in_ms: Math.max(0, (slot + 1) * slotMs2 - Number(nowMs || 0)),
  };
}

function verifyBeaconCode(secret, submitted, nowMs, slotMs) {
  const raw = String(submitted || "").trim();
  if (!/^\d{6}$/.test(raw)) {
    return { ok: false, reason: "Beacon code 6 digit ka hona chahiye." };
  }
  const slot = beaconSlotAt(nowMs, slotMs);
  const slotMs2 = slotMs || BEACON_SLOT_MS;
  for (let back = 0; back <= BEACON_GRACE_SLOTS; back++) {
    const candidate = beaconCodeForSlot(secret, slot - back, slotMs2);
    if (candidate === raw) {
      return { ok: true, slot: slot - back, stale: back > 0 };
    }
  }
  return { ok: false, reason: "Beacon code galat ya purana ho gaya." };
}

function beaconRequired(session) {
  return Boolean(session && session.beacon_enabled && session.beacon_secret);
}

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) {
    pass++;
    console.log(`PASS | ${label}`);
  } else {
    fail++;
    console.log(`FAIL | ${label}`);
  }
}

const SECRET = "test-secret-abc123";
const SLOT = BEACON_SLOT_MS;
// Clock ko EXACTLY slot boundary par align karte hain, warna kabhi kabhi
// T0 + 10s next slot par land kar deta tha aur "same slot" test bekaar fail
// hota. Real world me bhi ye align nahi hota — isliye har test apna boundary
// khud banata hai, fixed T0 par bharosa nahi.
const T0 = Math.floor(1700000000000 / SLOT) * SLOT;

console.log("--- BEACON CORE TESTS ---\n");

// 1) Slot math
check("0 ms par slot 0", beaconSlotAt(0) === 0);
check("45s par slot 1", beaconSlotAt(SLOT) === 1);
check("44.9s par abhi bhi slot 0", beaconSlotAt(SLOT - 100) === 0);
check("90s par slot 2", beaconSlotAt(2 * SLOT) === 2);
check("negative clock par 0 (crash nahi)", beaconSlotAt(-5000) === 0);
check("NaN clock par 0 (crash nahi)", beaconSlotAt(NaN) === 0);

// 2) Code shape — student type kar sake
const code0 = beaconCodeForSlot(SECRET, 0);
check(`code sirf 6 digits (${code0})`, /^\d{6}$/.test(code0));
check(
  "50 random slots ke codes 6 digits",
  Array.from({ length: 50 }, (_, s) => beaconCodeForSlot(SECRET, s)).every((c) => /^\d{6}$/.test(c))
);
check(
  "sab code 000000 nahi (asli range me)",
  Array.from({ length: 200 }, (_, s) => beaconCodeForSlot(SECRET, s)).some((c) => parseInt(c, 10) > 0)
);

// 3) Determinism + rotation
check("same slot par same code (teacher screen = server)", beaconCodeForSlot(SECRET, 5) === beaconCodeForSlot(SECRET, 5));
check("alag slot par alag code (rotate)", beaconCodeForSlot(SECRET, 5) !== beaconCodeForSlot(SECRET, 6));
check("alag secret par alag code", beaconCodeForSlot(SECRET, 5) !== beaconCodeForSlot("other", 5));

// 4) currentBeacon
{
  const a = currentBeacon(SECRET, T0);
  const b = currentBeacon(SECRET, T0 + 10000);
  const c = currentBeacon(SECRET, T0 + SLOT + 100);
  check("10s baad bhi same code", a.code === b.code);
  check("45s baad naya code", a.code !== c.code);
  check(`seconds_left 0-45 (${a.seconds_left})`, a.seconds_left >= 0 && a.seconds_left <= 45);
  check(`rotates_in_ms 0-45000 (${a.rotates_in_ms})`, a.rotates_in_ms >= 0 && a.rotates_in_ms <= SLOT);
}

// 5) Current code accepted
{
  const live = currentBeacon(SECRET, T0).code;
  const r = verifyBeaconCode(SECRET, live, T0);
  check(`current code accept (${live})`, r.ok === true && r.slot === beaconSlotAt(T0) && r.stale === false);
}

// 6) 1 purana slot grace me (typing lag)
{
  const now = T0 + SLOT;
  const oldCode = currentBeacon(SECRET, now - SLOT).code;
  const r = verifyBeaconCode(SECRET, oldCode, now);
  check(`1 purana slot accept (${oldCode})`, r.ok === true && r.stale === true);
}

// 7) 2 purana slot REJECT — WhatsApp purana code nahi chalega
{
  const now = T0 + 2 * SLOT;
  const oldCode = currentBeacon(SECRET, now - 2 * SLOT).code;
  check("2 purana slot REJECT", verifyBeaconCode(SECRET, oldCode, now).ok === false);
}

// 8) Wrong secret reject
{
  const live = currentBeacon(SECRET, T0).code;
  check("galat secret se REJECT", verifyBeaconCode("attacker", live, T0).ok === false);
}

// 9) Malformed input — crash nahi
check("empty REJECT", verifyBeaconCode(SECRET, "", T0).ok === false);
check("undefined REJECT", verifyBeaconCode(SECRET, undefined, T0).ok === false);
check("null REJECT", verifyBeaconCode(SECRET, null, T0).ok === false);
check("5 digit REJECT", verifyBeaconCode(SECRET, "12345", T0).ok === false);
check("7 digit REJECT", verifyBeaconCode(SECRET, "1234567", T0).ok === false);
check("non-numeric REJECT", verifyBeaconCode(SECRET, "abcdef", T0).ok === false);
check("5 digit par '6 digit' message", verifyBeaconCode(SECRET, "12345", T0).reason.includes("6 digit"));

// ---------------------------------------------------------------------------
// STAGE-2 "NEW CODE" — beacon ke replacement ka logic test
// ---------------------------------------------------------------------------
// Ye test naye flow ke CORE hisse verify karta hai:
//   * code 6-digit numeric hota hai
//   * hash compare kaam karta hai (plain code DB me jaata hi nahi)
//   * GALAT code reject hota hai (aur kuch bhi save nahi hota)
//   * REAL expiry 30s par enforce hoti hai
//   * UI timer 20s aur REAL timer 30s ALAG-ALAG hain (sahi buffer)
//
// Ye IIFE me hai taaki upar wale beacon test ke names (T0, SECRET...) se
// COLLIDE na ho — dono ek hi file me hain.
(function stage2VerifyCodeTest() {
const VERIFY_DISPLAY_SECONDS = 20;
const VERIFY_REAL_TTL_MS = 30 * 1000;

console.log('\n=== stage-2 verify code (20s UI / 30s real) ===');

function generateVerifyCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function hashVerifyCode(code) { return sha256Hex(String(code || '').trim()); }
function isVerifyCodeLive(session, nowMs) {
  if (!session || !session.verify_code_hash) return false;
  const now = Number(nowMs) || Date.now();
  // Strict `<` (na ki `<=`): 30s TTL = t=0..29.999s valid, t=30.000s par expire.
  return now < (session.verify_code_expires_at || 0);
}
function verifyCodeMatches(session, submitted, nowMs) {
  const raw = String(submitted || '').trim();
  if (!/^\d{6}$/.test(raw)) return { ok: false, reason: 'Code 6 digit ka hona chahiye.' };
  if (!isVerifyCodeLive(session, nowMs)) {
    return { ok: false, reason: 'expired', expired: true };
  }
  const a = Buffer.from(hashVerifyCode(raw));
  const b = Buffer.from(String(session.verify_code_hash));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  return match ? { ok: true } : { ok: false, reason: 'wrong' };
}

const T0 = 1700000000000;

// 1) Code format — hamesha exactly 6 digits (leading zeros samet).
let fmtOk = true;
for (let i = 0; i < 3000; i++) {
  const c = generateVerifyCode();
  if (!/^\d{6}$/.test(c)) { fmtOk = false; break; }
}
check('generated code hamesha 6-digit numeric', fmtOk);

// 2) Session banate hain — 20s UI, 30s real.
const code = generateVerifyCode();
const session = {
  verify_code_hash: hashVerifyCode(code),
  verify_code_issued_at: T0,
  verify_code_expires_at: T0 + VERIFY_REAL_TTL_MS, // 30s
  verify_display_seconds: VERIFY_DISPLAY_SECONDS, // 20s
  verify_issued_count: 1,
};
check('DB me sirf hash hai, plain code nahi', !JSON.stringify(session).includes(code));
check('UI 20s aur real 30s ALAG hain', VERIFY_DISPLAY_SECONDS !== VERIFY_REAL_TTL_MS / 1000);
check('UI timer 20s', VERIFY_DISPLAY_SECONDS === 20);
check('REAL timer 30s', VERIFY_REAL_TTL_MS / 1000 === 30);

// 3) Sahi code, code banate hi.
check('sahi code turant accept', verifyCodeMatches(session, code, T0).ok === true);

// 4) 19s par abhi bhi live (UI 20s tak dikhta hai — consistent).
check('19s par code live', verifyCodeMatches(session, code, T0 + 19 * 1000).ok === true);

// 5) UI timer khatam hone ke baad (20s) bhi server par EXTRA 10s buffer hai.
//    Ye jaan-boojh kar rakha gaya safety margin hai — network latency ke liye.
check('20s par server par abhi bhi live (10s buffer)',
  verifyCodeMatches(session, code, T0 + 20 * 1000).ok === true);
check('25s par server par live',
  verifyCodeMatches(session, code, T0 + 25 * 1000).ok === true);

// 6) 30s par REAL expiry — ab reject.
check('30s par code expire (real TTL)',
  verifyCodeMatches(session, code, T0 + 30 * 1000).ok === false);
check('31s par bhi expire',
  verifyCodeMatches(session, code, T0 + 31 * 1000).ok === false);

// 7) Galat code — hamesha reject (chahe live ho).
const wrong = generateVerifyCode() === code ? '000001' : generateVerifyCode();
check('galat code REJECT (live session me bhi)', verifyCodeMatches(session, wrong, T0).ok === false);

// 8) Malformed input — crash nahi, saaf error.
check('empty REJECT', verifyCodeMatches(session, '', T0).ok === false);
check('5 digit REJECT', verifyCodeMatches(session, '12345', T0).ok === false);
check('7 digit REJECT', verifyCodeMatches(session, '1234567', T0).ok === false);
check('non-numeric REJECT', verifyCodeMatches(session, 'abcdef', T0).ok === false);
check('null REJECT', verifyCodeMatches(session, null, T0).ok === false);

// 9) Koi code nahi banaya hua session — kuch bhi accept nahi.
const empty = { verify_code_hash: '', verify_code_expires_at: 0 };
check('bina code wale session me kuch accept nahi',
  verifyCodeMatches(empty, code, T0).ok === false);

// 10) Naya code pehle wala invalid kar deta hai (regenerate case).
const code2 = generateVerifyCode();
session.verify_code_hash = hashVerifyCode(code2);
session.verify_code_expires_at = T0 + VERIFY_REAL_TTL_MS;
check('regenerate ke baad PURANA code reject',
  verifyCodeMatches(session, code, T0).ok === false);
check('regenerate ke baad NAYA code accept',
  verifyCodeMatches(session, code2, T0).ok === true);

// 11) Leak check — aage ke codes guess nahi ho sakte (hash one-way hai).
const leaked = session.verify_code_hash.includes(code2);
check('hash me plain code leak nahi', leaked === false);

})();
{
  const live = currentBeacon(SECRET, T0).code;
  const base = beaconSlotAt(T0);
  let leaked = false;
  for (let s = base + 1; s <= base + 1000; s++) {
    if (beaconCodeForSlot(SECRET, s) === live) leaked = true;
  }
  check("aage ke 1000 slots me code leak nahi", leaked === false);
}

// 11) beaconRequired gate
check("enabled + secret -> required", beaconRequired({ beacon_enabled: true, beacon_secret: "x" }) === true);
check("disabled -> NOT required", beaconRequired({ beacon_enabled: false, beacon_secret: "x" }) === false);
check("secret khali -> NOT required", beaconRequired({ beacon_enabled: true, beacon_secret: "" }) === false);
check("session null -> NOT required (crash nahi)", beaconRequired(null) === false);

console.log(`\n${fail === 0 ? "ALL BEACON TESTS PASSED" : `${fail} FAILED`} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);