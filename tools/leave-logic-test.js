/**
 * Leave + percentage logic ka unit test (koi test framework nahi).
 * computePercentages() decide karta hai ki student ka % kya hoga jab teacher ne
 * approved leave lagayi ho. Do rules test hote hain:
 *   1) Leave attendance me COUNT nahi hoti (present fixed rehta hai).
 *   2) Leave din denominator se GHAT jaati hai (isliye % girta nahi).
 * Sabse khatarnaak galti: effectivePct = 0 return karna jab effectiveHeld = 0 ho
 * — student ko "0%" dikhta aur college use default case kar deta, jabki usne koi
 * bhi class miss nahi ki thi. Isliye wo case hamesha null (n/a) rehta hai.
 * Chalao: node tools/leave-logic-test.js
 */
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=500&connectTimeoutMS=500";
process.env.ALLOW_START_WITHOUT_DB = "true";
process.env.PORT = "3997";
process.env.TEACHER_PASSWORD = "test-password-123";

const {
  computePercentages,
  normalizeLeaveReason,
  leaveReasonText,
  leaveSummaryText,
  shortDateForDisplay,
  LEAVE_REASONS,
} = require("../server.js");

let failures = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS | ${name} -> ${a}`);
  } else {
    console.log(`FAIL | ${name} -> got ${a}, want ${e}`);
    failures++;
  }
}

// Sirf kuch fields nikalne ka chhota helper (poora object compare karne se
// test ka output unreadable ho jaata tha).
function pick(source, keys) {
  const out = {};
  for (const k of keys) out[k] = source[k];
  return out;
}

// ---------- 1) Percentage maths ----------
check(
  "leave ke bina: raw aur effective % same (purana behaviour back-compat)",
  pick(computePercentages({ present: 8, rawHeld: 10, leaveDays: 0 }), ["rawPct", "effectivePct", "effectiveHeld"]),
  { rawPct: 80, effectivePct: 80, effectiveHeld: 10 }
);

check(
  "2 din medical leave: present same rehta (8), raw 80%, effective 100%",
  pick(computePercentages({ present: 8, rawHeld: 10, leaveDays: 2 }), ["present", "rawPct", "effectivePct", "leaveDays", "effectiveHeld"]),
  { present: 8, rawPct: 80, effectivePct: 100, leaveDays: 2, effectiveHeld: 8 }
);

check(
  "sirf 1 din leave: raw 8/10 = 80%, effective 8/9 = 88.9%",
  pick(computePercentages({ present: 8, rawHeld: 10, leaveDays: 1 }), ["rawPct", "effectivePct"]),
  { rawPct: 80, effectivePct: 88.9 }
);

check(
  "POORA period leave: effectivePct = null (0% NAHI — student ne kuch miss nahi kiya)",
  pick(computePercentages({ present: 0, rawHeld: 5, leaveDays: 5 }), ["effectivePct", "effectiveHeld", "effectivePossible"]),
  { effectivePct: null, effectiveHeld: 0, effectivePossible: false }
);

check(
  "koi class hi nahi hui (held=0): dono % null, crash nahi",
  pick(computePercentages({ present: 0, rawHeld: 0, leaveDays: 0 }), ["rawPct", "effectivePct"]),
  { rawPct: null, effectivePct: null }
);

check(
  "absent + leave mix: raw 6/12 = 50%, effective 6/10 = 60%",
  pick(computePercentages({ present: 6, rawHeld: 12, leaveDays: 2 }), ["rawPct", "effectivePct"]),
  { rawPct: 50, effectivePct: 60 }
);

check(
  "garbage input safe: negative leaveDays se denominator barhna nahi chahiye",
  pick(computePercentages({ present: 5, rawHeld: 10, leaveDays: -5 }), ["leaveDays", "effectiveHeld"]),
  { leaveDays: 0, effectiveHeld: 10 }
);

check(
  "NaN/string input crash nahi karta: 'abc' present => 0",
  pick(computePercentages({ present: "abc", rawHeld: 10, leaveDays: 0 }), ["present", "rawPct"]),
  { present: 0, rawPct: 0 }
);

check(
  "1 decimal round: 1/3 = 33.3 (33.3333 nahi)",
  pick(computePercentages({ present: 1, rawHeld: 3, leaveDays: 0 }), ["effectivePct"]),
  { effectivePct: 33.3 }
);

check(
  "leave zyada ho held se (garbage data): effective denominator kabhi negative nahi",
  pick(computePercentages({ present: 3, rawHeld: 5, leaveDays: 9 }), ["effectiveHeld", "effectivePct"]),
  { effectiveHeld: 0, effectivePct: null }
);

// ---------- 2) Leave reason normalize + text ----------
check("valid reason medical normalize hota hai", normalizeLeaveReason("medical"), "medical");
check("reason UPPERCASE bhi chalta hai", normalizeLeaveReason("MEDICAL"), "medical");
check("unknown reason -> other (crash nahi)", normalizeLeaveReason("xyz-unknown"), "other");
check("empty reason -> other", normalizeLeaveReason(""), "other");
check("khaali spaces hat jaate hain", normalizeLeaveReason("  family  "), "family");
check("reason text: medical", leaveReasonText("medical"), LEAVE_REASONS.medical);
check("unknown reason ka text bhi readable label deta hai", leaveReasonText("nonsense"), LEAVE_REASONS.other);

// ---------- 3) Reason summary (ek subject me mix ho sakta hai) ----------
check("same reason 3 din: ek hi label", leaveSummaryText(["medical", "medical", "medical"]), "Medical");
check("mix reasons: dono labels, order me", leaveSummaryText(["medical", "sports"]), "Medical, Sports / tournament");
check("duplicate hat jaata hai mix me bhi", leaveSummaryText(["medical", "sports", "medical"]), "Medical, Sports / tournament");
check("koi leave nahi: khaali string", leaveSummaryText([]), "");

// ---------- 4) Short date (DD-MM) ----------
check("date -> DD-MM", shortDateForDisplay("2026-09-05"), "05-09");
check("single digit day bhi 2-digit pad kare", shortDateForDisplay("2026-12-01"), "01-12");
check("kharab input crash nahi karta", shortDateForDisplay("garbage"), "garbage");

console.log("");
if (failures) {
  console.log(`LEAVE LOGIC TEST FAILED - ${failures} case(s) galat`);
  // Zaruri hai: server.js require karte hi app.listen() chalu ho jata hai, isliye
  // bina is exit ke node process kabhi khatam nahi hoga aur test hang ho jayega.
  process.exit(1);
}
console.log("LEAVE LOGIC TEST PASSED");
process.exit(0);
