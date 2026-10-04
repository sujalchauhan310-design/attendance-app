// tools/sound-code-test.js — lib/sound-code.js ke pure functions ka test.
const sc = require("../lib/sound-code.js");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("PASS | " + l); } else { fail++; console.log("FAIL | " + l); } }

const SEC = "test-secret";
const T0 = Math.floor(1700000000000 / sc.BEACON_SLOT_MS) * sc.BEACON_SLOT_MS;

const c = sc.currentBeacon(SEC, T0);
check("code = 3 same letters (aaa type)", /^([a-z])\1{2}$/.test(c.code));
check("deterministic (same slot = same code)", sc.currentBeacon(SEC, T0).code === c.code);
check("alag secret = alag code (mostly)", sc.currentBeacon("xyz", T0).letter === sc.currentBeacon("xyz", T0).letter);

check("current code accept", sc.verifyBeaconCode(SEC, c.code, T0).ok === true);
check("1 purana slot grace me accept", sc.verifyBeaconCode(SEC, sc.currentBeacon(SEC, T0 - sc.BEACON_SLOT_MS).code, T0).ok === true);
check("2 purana slot grace me accept (grace=2)", sc.verifyBeaconCode(SEC, sc.currentBeacon(SEC, T0 - 2 * sc.BEACON_SLOT_MS).code, T0).ok === true);
check("3 purana slot REJECT", sc.verifyBeaconCode(SEC, sc.currentBeacon(SEC, T0 - 3 * sc.BEACON_SLOT_MS).code, T0).ok === false);
check("galat secret REJECT", sc.verifyBeaconCode("other", c.code, T0).ok === false);
check("5 letters REJECT (ab 3 chahiye)", sc.verifyBeaconCode(SEC, "aaaaa", T0).ok === false);
check("2 letters REJECT", sc.verifyBeaconCode(SEC, "aa", T0).ok === false);
check("mixed letters REJECT (same-letter rule)", sc.verifyBeaconCode(SEC, "abc", T0).ok === false);
check("uppercase accept", sc.verifyBeaconCode(SEC, c.code.toUpperCase(), T0).ok === true);
check("junk REJECT (no crash)", sc.verifyBeaconCode(SEC, "!!!!!!", T0).ok === false && sc.verifyBeaconCode(SEC, null, T0).ok === false);

let rt = true;
for (const L of sc.LETTERS) { if (sc.codeFromTone(sc.letterToneHz(L)) !== L.repeat(3)) { rt = false; break; } }
check("saare 26 letters tone round-trip", rt);
// PURANA BUG: teacher ka code ek tha, student ke phone me kuch aur aata tha.
// Ab dono EK hi lib/source use karte hain — ye test us mismatch ko rokta hai.
check("teacher code = student decode (koi mismatch nahi)", sc.codeFromTone(sc.letterToneHz(c.code[0])) === c.code);
check("tone band cheap-hardware sweet spot (4k-8k)", sc.letterToneHz("a") >= 4000 && sc.letterToneHz("z") <= 8000);
check("band saste phone ke liye 10k se neeche (weak-speaker safe)", sc.letterToneHz("z") < 10000);
check("range ke bahar freq = null", sc.letterForTone(19000) === null);

const spec = sc.chirpSpecFor(c.code);
check("chirp spec = lead-tone-lead", spec && spec.sequence.length === 3 && spec.sequence[1].lead === false && spec.sequence[0].lead === true);

check("relay: khud ki request -> no play", sc.relayPickDecision({ requester: "a", expires_at: T0 + 1000 }, "a", T0).play === false);
check("relay: dusra device -> play", sc.relayPickDecision({ requester: "a", expires_at: T0 + 1000 }, "b", T0).play === true);
check("relay: expired -> no play", sc.relayPickDecision({ requester: "a", expires_at: T0 - 1 }, "b", T0).play === false);
check("relay: no request -> no play", sc.relayPickDecision(null, "b", T0).reason === "no_request");

console.log(`\n${fail ? fail + " FAILED" : "ALL SOUND-CODE TESTS PASSED"} — pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
