// ============================================================================
// CODE WINDOW (SOFT DEADLINE) TEST — tools/code-window-test.js
// Ye test server ke resolveCodeWindow() ko COPY karta hai (server.js me function
// non-exported hai). Server.js me display/accept constants ya logic badle to
// yahan bhi wahi copy update karni padegi — jaan-boojh kar rakha hai.
//
// Zaroori kyun: yahaan ek galti (jaise quick code par displayMs > acceptMs, ya
// normal code par display != accept) ka matlab hai — ya to UI 10s par jhooth
// bolega jo server 30s tak maan raha hai (contradiction, app "buggy" lagega),
// ya soft-deadline hona hi band ho jayega. Isliye usko yahin pakadte hain.
const CODE_DISPLAY_SEC = 10;
const CODE_ACCEPT_SEC = 20;

// server.js: resolveCodeWindow() ki exact copy.
function resolveCodeWindow(expiryMinutes, opts) {
  const o = opts || {};
  const displaySec = Number.isFinite(o.display_sec) ? o.display_sec : CODE_DISPLAY_SEC;
  const acceptSec = Number.isFinite(o.accept_sec) ? o.accept_sec : CODE_ACCEPT_SEC;
  const minutes = Number(expiryMinutes);
  const isQuick = Number.isFinite(minutes) && minutes <= 0.5;
  const acceptMs = isQuick
    ? Math.max(acceptSec, displaySec) * 1000
    : Math.max(1000, (Number.isFinite(minutes) ? minutes : 1) * 60 * 1000);
  const displayMs = isQuick ? Math.min(displaySec * 1000, acceptMs) : acceptMs;
  return { isQuick, acceptMs, displayMs };
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

console.log("--- CODE WINDOW (SOFT DEADLINE) TESTS ---\n");

// 1) Quick (0.5m) = asli 20s, par dikhta 10s.
{
  const w = resolveCodeWindow(0.5);
  check("quick code quick flag true", w.isQuick === true);
  check(`quick accept = 20s (${w.acceptMs})`, w.acceptMs === 20000);
  check(`quick display = 10s (${w.displayMs})`, w.displayMs === 10000);
  check("quick: display < accept (soft deadline asli hai)", w.displayMs < w.acceptMs);
}

// 2) Normal windows: koi bluff nahi (display == accept).
for (const [min, ms] of [[2, 120000], [5, 300000], [7, 420000]]) {
  const w = resolveCodeWindow(min);
  check(`${min} min normal: accept = ${ms}ms`, w.acceptMs === ms);
  check(`${min} min normal: display == accept (no bluff)`, w.displayMs === w.acceptMs);
  check(`${min} min normal: quick flag false`, w.isQuick === false);
}

// 3) Env override (display/accept tunable).
{
  const w = resolveCodeWindow(0.5, { display_sec: 12, accept_sec: 45 });
  check("override: accept = 45s", w.acceptMs === 45000);
  check("override: display = 12s", w.displayMs === 12000);
}

// 4) Galat config safety: acceptSec < displaySec -> accept itna hi bada ho jata
// hai ki display usse bada na ho (warna contradiction).
{
  // "kill-switch": galat config (accept < display) par bhi screen par jhooth
  // nahi — asli accept display tak barh jata hai.
  const w = resolveCodeWindow(0.5, { display_sec: 20, accept_sec: 5 });
  check("kill-switch: display accept se bada nahi hota", w.displayMs <= w.acceptMs);
  check("clamp: accept display tak barh gaya (20s)", w.acceptMs === 20000);
}

// 5) Koi bhi quick value par display > accept NAHI.
{
  let allOk = true;
  for (let d = 1; d <= 40; d++) {
    const w = resolveCodeWindow(0.5, { display_sec: d, accept_sec: 30 });
    if (w.displayMs > w.acceptMs) { allOk = false; break; }
  }
  check("display kabhi accept se bada nahi (10-40s sweep)", allOk);
}

// 6) Boundary: 0.5 quick hai, 0.51 normal hai (0.51m = 30600ms).
{
  check("0.5 -> quick", resolveCodeWindow(0.5).isQuick === true);
  const w = resolveCodeWindow(0.51);
  check("0.51 -> normal", w.isQuick === false);
  check("0.51 -> accept 30600ms", w.acceptMs === 30600);
}

// 7) Malformed / zero: crash nahi, positive window milta hai.
{
  const w = resolveCodeWindow(0);
  check("0 minute crash nahi + positive window", Number.isFinite(w.acceptMs) && w.acceptMs > 0);
  const w2 = resolveCodeWindow(undefined);
  check("undefined crash nahi + positive window", Number.isFinite(w2.acceptMs) && w2.acceptMs > 0);
  const w3 = resolveCodeWindow(NaN);
  check("NaN crash nahi + positive window", Number.isFinite(w3.acceptMs) && w3.acceptMs > 0);
}

console.log(`\n${fail === 0 ? "ALL CODE-WINDOW TESTS PASSED" : `${fail} FAILED`} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
