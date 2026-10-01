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

// 10) Leak check — aage ke 1000 slots me current code nahi
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