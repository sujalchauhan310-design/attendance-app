// ============================================================================
// SOUND CODE — letter beacon + chirp (tone) + relay. PURE + testable.
// Code = 6 same letters (a..z), jaise "aaaaaa" ya "kkkkkk".
//   * Teacher ka phone ek letter-tone bajata hai (lead ... tone ... lead).
//   * Student ka phone mic se letter sunta hai -> code = letter x6.
//   * Verified student phir wahi tone dobara bajata hai (relay).
// ============================================================================
const crypto = require("crypto");

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
// Code = 3 SAME letters (jaise "aaa") — chhota aur phone aaram se sun leta hai.
const CODE_LEN = 3;
const BEACON_SLOT_MS = 45 * 1000; // code har 45 se badalta hai
const BEACON_GRACE_SLOTS = 1;     // 1 purana slot bhi chalta hai (typing/relay lag)
// Audible band (9.0-15.2 kHz): 26 letters x 250 Hz. Sasta speaker/mic bhi handle
// karte hain (ultrasonic 16k+ par kai phone fail ho jate hain).
const TONE_MIN_HZ = 9000;
const TONE_STEP_HZ = 250;
const TONE_MS = 600;   // ek tone ki lambai — 600ms (phone ko pakadne ke liye 15 samples)
const GAP_MS = 150;
const LEAD_HZ = 8400;  // "shuru/khatam" marker — digit band se alag
const LEAD_MS = 300;
const RELAY_TTL_MS = 25000;

function slotAt(nowMs, slotMs) {
  const s = Number(slotMs) || BEACON_SLOT_MS;
  const n = Number(nowMs);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n / s);
}

// Secret + slot -> letter (deterministic; aage ke codes guess nahi ho sakte).
function letterForSlot(secret, slot) {
  const digest = crypto.createHmac("sha256", String(secret || "")).update(`beacon.${BEACON_SLOT_MS}.${slot}`).digest();
  return LETTERS[digest[0] % 26];
}
function codeForSlot(secret, slot) { return letterForSlot(secret, slot).repeat(CODE_LEN); }

function currentBeacon(secret, nowMs) {
  const slot = slotAt(nowMs);
  return {
    slot,
    letter: letterForSlot(secret, slot),
    code: codeForSlot(secret, slot),
    rotates_in_ms: Math.max(0, (slot + 1) * BEACON_SLOT_MS - Number(nowMs || 0)),
  };
}

// Student ke bheje code ko validate (current slot ya 1 grace slot).
function verifyBeaconCode(secret, submitted, nowMs) {
  const raw = String(submitted || "").trim().toLowerCase();
  if (!new RegExp("^[a-z]{" + CODE_LEN + "}$").test(raw)) return { ok: false, reason: `Sound code ${CODE_LEN} letters ka hona chahiye.` };
  // Same-letter hi accept karte hain (jaan-boojh kar simple).
  if (raw[0].repeat(CODE_LEN) !== raw) return { ok: false, reason: "Sound code galat hai." };
  const slot = slotAt(nowMs);
  for (let back = 0; back <= BEACON_GRACE_SLOTS; back++) {
    if (codeForSlot(secret, slot - back) === raw) return { ok: true, slot: slot - back, stale: back > 0 };
  }
  return { ok: false, reason: "Sound code galat ya purana ho gaya." };
}

function letterToneHz(letter) {
  const i = LETTERS.indexOf(String(letter || "").toLowerCase());
  return i < 0 ? null : TONE_MIN_HZ + i * TONE_STEP_HZ;
}
function letterForTone(hz) {
  const n = Number(hz);
  if (!Number.isFinite(n)) return null;
  const i = Math.round((n - TONE_MIN_HZ) / TONE_STEP_HZ);
  if (i < 0 || i > 25) return null;
  if (Math.abs(n - (TONE_MIN_HZ + i * TONE_STEP_HZ)) > TONE_STEP_HZ / 2) return null;
  return LETTERS[i];
}
function codeFromTone(hz) { const l = letterForTone(hz); return l ? l.repeat(CODE_LEN) : null; }

// code -> play karne layak sequence: lead ... tone ... lead
function chirpSpecFor(code) {
  const letter = String(code || "").toLowerCase()[0];
  const hz = letterToneHz(letter);
  if (hz === null) return null;
  return {
    lead_hz: LEAD_HZ, lead_ms: LEAD_MS,
    tone_min_hz: TONE_MIN_HZ, tone_step_hz: TONE_STEP_HZ, tone_ms: TONE_MS, gap_ms: GAP_MS,
    letter, hz,
    sequence: [
      { hz: LEAD_HZ, ms: LEAD_MS, lead: true },
      { hz, ms: TONE_MS, lead: false },
      { hz: LEAD_HZ, ms: LEAD_MS, lead: true },
    ],
    total_ms: LEAD_MS * 2 + TONE_MS + GAP_MS * 2,
  };
}

function relaySessionKey(class_name, subject, course_type, system) {
  return [class_name, subject, course_type, system].map((v) => String(v || "").trim().toLowerCase()).join("|");
}
function relayAlive(entry, nowMs) { return Boolean(entry) && Number(entry.expires_at) > nowMs; }
function relayPickDecision(entry, deviceId, nowMs) {
  if (!entry) return { play: false, reason: "no_request" };
  if (!(Number(entry.expires_at) > nowMs)) return { play: false, reason: "expired" };
  if (!deviceId || entry.requester === deviceId) return { play: false, reason: "self" };
  return { play: true, reason: "" };
}

module.exports = {
  LETTERS, CODE_LEN, BEACON_SLOT_MS, BEACON_GRACE_SLOTS, RELAY_TTL_MS,
  TONE_MIN_HZ, TONE_STEP_HZ, TONE_MS, GAP_MS, LEAD_HZ, LEAD_MS,
  slotAt, letterForSlot, codeForSlot, currentBeacon, verifyBeaconCode,
  letterToneHz, letterForTone, codeFromTone, chirpSpecFor,
  relaySessionKey, relayAlive, relayPickDecision,
};
