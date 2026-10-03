// ============================================================================
// ON-DEMAND SINGLE RELAY TEST — tools/relay-test.js
// Ye test server ke relay core (pure functions) ko COPY karta hai (server.js me
// functions non-exported hain). Server.js me relay logic badle to yahan bhi wahi
// copy update karni padegi — jaan-boojh kar rakha hai, taaki ye nazuk decision
// bina DB/server ke test ho sake.
//
// Zaroori kyun: yahaan ek galti (jaise apni hi request khud relay kar dena, ya
// "ek request = ek relay" na hona) ka matlab hai 120 students ka phone ek saath
// baj kar poora chirp kachra kar dega — aur wo bug classroom me hi pata chalta
// hai. Isliye usko yahin pakadte hain.
const RELAY_REQUEST_TTL_MS = 25 * 1000;

function relaySessionKey(class_name, subject, course_type, system) {
  return [class_name, subject, course_type, system]
    .map((v) => String(v || "").trim().toLowerCase())
    .join("|");
}

function relayAlive(entry, nowMs) {
  if (!entry) return false;
  const expiresAt = Number(entry.expires_at) || 0;
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function relayPickDecision(entry, deviceId, nowMs, ttlMs) {
  const ttl = Number(ttlMs) || RELAY_REQUEST_TTL_MS;
  if (!entry) return { play: false, reason: "no_request" };
  const expiresAt = Number(entry.expires_at) || (Number(entry.created_at) + ttl);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return { play: false, reason: "expired" };
  if (!deviceId || entry.requester === deviceId) return { play: false, reason: "self" };
  return { play: true, reason: "" };
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

const NOW = 1700000000000;
function req(requester, atMs, ttlMs) {
  return { requester, created_at: atMs, expires_at: atMs + (ttlMs || RELAY_REQUEST_TTL_MS) };
}

// 1) Session key — case/space insensitive, alag-alag sessions alag
check("session key ek hai (case/space ignore)",
  relaySessionKey("BA 1st", "Math", "DSC", "Annual") === relaySessionKey(" ba 1st ", " math ", "dsc", "annual"));
check("subject badalne par alag key",
  relaySessionKey("BA 1st", "Math", "DSC", "Annual") !== relaySessionKey("BA 1st", "Physics", "DSC", "Annual"));
check("course_type badalne par alag key",
  relaySessionKey("BA 1st", "Math", "DSC", "Annual") !== relaySessionKey("BA 1st", "Math", "GE", "Annual"));
check("system badalne par alag key",
  relaySessionKey("BA 1st", "Math", "DSC", "Annual") !== relaySessionKey("BA 1st", "Math", "DSC", "Semester"));
check("empty values crash nahi karte",
  typeof relaySessionKey(undefined, null, "", undefined) === "string");

// 2) relayAlive
check("koi entry nahi -> alive false", relayAlive(undefined, NOW) === false);
check("taaza entry -> alive true", relayAlive(req("devA", NOW), NOW) === true);
check("expired entry -> alive false", relayAlive(req("devA", NOW - 30000), NOW) === false);
check("thik expiry boundary (abhi) -> false", relayAlive({ requester: "d", expires_at: NOW }, NOW) === false);

// 3) relayPickDecision — har branch
check("entry nahi -> no_request, no play",
  relayPickDecision(undefined, "devB", NOW).play === false &&
  relayPickDecision(undefined, "devB", NOW).reason === "no_request");
check("expired request -> play nahi",
  relayPickDecision(req("devA", NOW - 30000), "devB", NOW).play === false);
check("expired request ka reason 'expired'",
  relayPickDecision(req("devA", NOW - 30000), "devB", NOW).reason === "expired");
check("khud ki request khud relay -> play NAHI (self)",
  relayPickDecision(req("devA", NOW), "devA", NOW).play === false);
check("self ka reason 'self'",
  relayPickDecision(req("devA", NOW), "devA", NOW).reason === "self");
check("device id khaali -> play nahi (self safety)",
  relayPickDecision(req("devA", NOW), "", NOW).play === false);
check("DOOSRA device, taaza request -> PLAY",
  relayPickDecision(req("devA", NOW), "devB", NOW).play === true);
check("play par reason khaali",
  relayPickDecision(req("devA", NOW), "devB", NOW).reason === "");

// 4) created_at se expiry derive (expires_at missing) — crash nahi
{
  const d = relayPickDecision({ requester: "devA", created_at: NOW }, "devB", NOW + 1000);
  check("expires_at missing -> created_at+ttl se decide (andhar) -> play", d.play === true);
  const d2 = relayPickDecision({ requester: "devA", created_at: NOW - 40000 }, "devB", NOW);
  check("expires_at missing -> created_at+ttl se decide (bahar) -> no play", d2.play === false);
}

// 5) "Ek request = ek relay" — consume ka asar: entry hata do to koi aur bajana na
{
  const key = relaySessionKey("BA 1st", "Math", "DSC", "Annual");
  const map = new Map();
  map.set(key, req("devA", NOW));
  const first = relayPickDecision(map.get(key), "devB", NOW);
  map.delete(key); // consume
  const second = relayPickDecision(map.get(key), "devC", NOW);
  check("pehla relay decide hua", first.play === true);
  check("consume ke baad dusra NAHI bajata (chaos band)", second.play === false && second.reason === "no_request");
}

console.log(`\n${fail === 0 ? "ALL RELAY TESTS PASSED" : `${fail} FAILED`} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
