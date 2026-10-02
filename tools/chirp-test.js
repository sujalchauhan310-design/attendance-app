// ============================================================================
// CHIRP CORE TEST — tools/chirp-test.js
// Ye test server ke chirp codec ko COPY karta hai (server.js me functions
// non-exported hain). Server.js me chirp constants badle to yahan bhi wahi
// copy update karni padegi — jaan-boojh kar rakha hai, taaki SOUND ENCODING
// ka poora logic bina browser/mic/server ke test ho sake.
//
// Yahan sabse zaroori cheez ye hai: *round-trip*. Agar encode->decode galat ho
// jaye to teacher ka chirp bajta rahega aur student ka phone kabhi sahi code
// nahi nikaalega — aur ye bug classroom me hi pata chalta hai (jahan debug
// karna sabse mushkil hai). Isliye usko yahin pakadte hain.
const CHIRP_TONE_MIN_HZ = 16500;
const CHIRP_TONE_STEP_HZ = 240;
const CHIRP_TONE_MS = 150;
const CHIRP_GAP_MS = 40;
const CHIRP_LEAD_HZ = 16000;
const CHIRP_LEAD_MS = 300;

function chirpToneForDigit(digit, opts) {
  const o = opts || {};
  const min = Number.isFinite(o.min_hz) ? o.min_hz : CHIRP_TONE_MIN_HZ;
  const step = Number.isFinite(o.step_hz) ? o.step_hz : CHIRP_TONE_STEP_HZ;
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return null;
  return min + d * step;
}

function chirpDigitForTone(hz, opts) {
  const o = opts || {};
  const min = Number.isFinite(o.min_hz) ? o.min_hz : CHIRP_TONE_MIN_HZ;
  const step = Number.isFinite(o.step_hz) ? o.step_hz : CHIRP_TONE_STEP_HZ;
  const n = Number(hz);
  if (!Number.isFinite(n)) return null;
  const d = Math.round((n - min) / step);
  if (d < 0 || d > 9) return null;
  if (Math.abs(n - (min + d * step)) > step / 2) return null;
  return d;
}

function chirpSequenceFor(code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length !== 6) return null;
  const tones = [{ hz: CHIRP_LEAD_HZ, ms: CHIRP_LEAD_MS, lead: true }];
  for (const ch of digits) {
    tones.push({ hz: chirpToneForDigit(ch), ms: CHIRP_TONE_MS, lead: false });
  }
  tones.push({ hz: CHIRP_LEAD_HZ, ms: CHIRP_LEAD_MS, lead: true });
  return tones;
}

function chirpCodeFromTones(hzList) {
  if (!Array.isArray(hzList) || hzList.length !== 6) return null;
  let out = "";
  for (const hz of hzList) {
    const d = chirpDigitForTone(hz);
    if (d === null) return null;
    out += String(d);
  }
  return out;
}

function chirpSpecFor(code) {
  const tones = chirpSequenceFor(code);
  if (!tones) return null;
  return {
    lead_hz: CHIRP_LEAD_HZ,
    lead_ms: CHIRP_LEAD_MS,
    tone_ms: CHIRP_TONE_MS,
    gap_ms: CHIRP_GAP_MS,
    tone_min_hz: CHIRP_TONE_MIN_HZ,
    tone_step_hz: CHIRP_TONE_STEP_HZ,
    hz: tones.filter((t) => !t.lead).map((t) => t.hz),
    sequence: tones,
    total_ms: tones.reduce((sum, t) => sum + t.ms + CHIRP_GAP_MS, 0),
  };
}

const BEACON_CHANNELS = ["manual", "chirp", "qr"];
function normalizeBeaconChannel(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return BEACON_CHANNELS.includes(v) ? v : "manual";
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

// 1) Digit -> tone -> digit (poora round trip, saare 10 digits)
{
  let allOk = true;
  const seen = new Set();
  for (let d = 0; d <= 9; d++) {
    const hz = chirpToneForDigit(d);
    if (hz === null || chirpDigitForTone(hz) !== d) allOk = false;
    seen.add(hz);
  }
  check("saare 10 digit -> tone -> digit wapas wahi digit", allOk);
  check("saare 10 tones alag-alag hain (koi collision nahi)", seen.size === 10);
}

// 2) Tone spacing + range — FFT me pakadne aur sasta mic sun-ne ke liye
{
  const gap = chirpToneForDigit(5) - chirpToneForDigit(4);
  check(`tone spacing ${gap} Hz hai (>=200 Hz chahiye)`, gap >= 200);
  const top = chirpToneForDigit(9);
  check(`sabse upar wala tone ${top} Hz < 19000 Hz (sasta mic bhi sun lega)`, top < 19000);
  check(`sabse neeche wala tone ${CHIRP_TONE_MIN_HZ} Hz audible band se upar hai`, CHIRP_TONE_MIN_HZ > 16000);
}

// 3) ROUND TRIP — poore 6-digit code par, random 200 codes. Yehi asli test hai.
{
  let allOk = true;
  for (let i = 0; i < 200; i++) {
    const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    const spec = chirpSpecFor(code);
    if (!spec) { allOk = false; break; }
    if (chirpCodeFromTones(spec.hz) !== code) { allOk = false; break; }
  }
  check("200 random 6-digit codes ka round trip sahi (encode -> decode)", allOk);
}

// 4) Kuch khaas codes jo aksar test kiye jate hain
{
  const cases = ["000000", "999999", "123456", "100001", "505050"];
  let allOk = true;
  for (const c of cases) {
    const spec = chirpSpecFor(c);
    if (!spec || chirpCodeFromTones(spec.hz) !== c) allOk = false;
  }
  check("khaas codes (000000 / 999999 / 123456 / ...) sahi decode hote hain", allOk);
}

// 5) Mic ka reading thoda idhar-udhar hota hai — ±100 Hz par bhi digit theek
//    nikalna chahiye, warna chhoti frequency drift par attendance fail ho jati.
{
  let allOk = true;
  for (const drift of [-100, -60, -20, 20, 60, 100]) {
    for (let d = 0; d <= 9; d++) {
      if (chirpDigitForTone(chirpToneForDigit(d) + drift) !== d) allOk = false;
    }
  }
  check("±100 Hz drift par bhi digit sahi (mic ka drift tolerate hota hai)", allOk);
}

// 6) Range se bahar ki awaaz = reject. Bahut zyada dheel dena galat tone ko
//    galat digit bana dega, aur student ka poora code bigad jayega.
{
  check("20000 Hz (range ke bahar) -> null", chirpDigitForTone(20000) === null);
  check("10000 Hz (range ke bahar) -> null", chirpDigitForTone(10000) === null);
  check("0 Hz -> null", chirpDigitForTone(0) === null);
  check("NaN -> null", chirpDigitForTone(NaN) === null);
}

// 7) Kharab / junk input par crash nahi — sirf null
{
  check("null input -> null", chirpCodeFromTones(null) === null);
  check("khali array -> null", chirpCodeFromTones([]) === null);
  check("5 tones (6 chahiye) -> null", chirpCodeFromTones([16500, 16500, 16500, 16500, 16500]) === null);
  check("7 tones -> null", chirpCodeFromTones([16500, 16500, 16500, 16500, 16500, 16500, 16500]) === null);
  check("NaN tone -> null", chirpCodeFromTones([16500, NaN, 16500, 16500, 16500, 16500]) === null);
  check("string junk -> null", chirpCodeFromTones(["abc", "x", 1, 2, 3, 4]) === null);
  check("undefined -> null", chirpCodeFromTones(undefined) === null);
}

// 8) Sequence ki shakal: lead + 6 digit tones + lead = 8 tones
{
  const seq = chirpSequenceFor("123456");
  check("sequence me 8 tone hain (lead + 6 digits + lead)", seq.length === 8);
  check("pehla tone lead marker hai", seq[0].hz === CHIRP_LEAD_HZ && seq[0].lead === true);
  check("aakhri tone bhi lead marker hai", seq[seq.length - 1].hz === CHIRP_LEAD_HZ && seq[seq.length - 1].lead === true);
  check("beech ke 6 tones lead nahi hain", seq.slice(1, 7).every((t) => t.lead === false));
}

// 9) Lead marker digit range se ALAG hai — warna decoder use digit samajh lega
{
  const lowestDigit = chirpToneForDigit(0);
  check(`lead (${CHIRP_LEAD_HZ} Hz) digit range (${lowestDigit}+) se alag hai`, CHIRP_LEAD_HZ < lowestDigit);
  check("lead tone digit range me map hota hi nahi", chirpDigitForTone(CHIRP_LEAD_HZ) === null);
}

// 10) Galat code / khaali code par sequence nahi banta
{
  check("'12345' (5 digit) -> null", chirpSequenceFor("12345") === null);
  check("'1234567' (7 digit) -> null", chirpSequenceFor("1234567") === null);
  check("'' -> null", chirpSequenceFor("") === null);
  check("null -> null", chirpSequenceFor(null) === null);
  check("'abcdef' -> null", chirpSequenceFor("abcdef") === null);
  check("'12-34-56' (junk ke saath 6 digit) -> sequence banta hai", chirpSequenceFor("12-34-56") !== null);
}

// 11) total_ms classroom ke liye theek hai — 3 second se kam, warna 120
//     students ke liye sunna slow ho jata hai.
{
  const spec = chirpSpecFor("123456");
  check(`poora chirp ${spec.total_ms} ms me bajta hai (<3000 ms)`, spec.total_ms < 3000);
  check(`chirp 1 second se zyada hai (${spec.total_ms} ms) — pura bajne ka time milna chahiye`, spec.total_ms > 1000);
}

// 12) beacon_channel allowlist — client random string DB me na bhej sake
{
  check("'chirp' allowed", normalizeBeaconChannel("chirp") === "chirp");
  check("'QR' (bada letter) -> 'qr'", normalizeBeaconChannel("QR") === "qr");
  check("' manual ' (space) -> 'manual'", normalizeBeaconChannel(" manual ") === "manual");
  check("junk -> safe default 'manual'", normalizeBeaconChannel("hacker<script>") === "manual");
  check("null -> 'manual'", normalizeBeaconChannel(null) === "manual");
  check("undefined -> 'manual'", normalizeBeaconChannel(undefined) === "manual");
}

console.log(`\n${fail === 0 ? "ALL CHIRP TESTS PASSED" : `${fail} FAILED`} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);