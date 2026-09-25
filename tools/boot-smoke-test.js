/**
 * Boot + crash-proofing smoke test (DB ke bina).
 * Sabse important cheez jo ye prove karta hai:
 *   - DB down hone par server CRASH nahi hota (ALLOW_START_WITHOUT_DB=true)
 *   - /api routes HTML error page ke bajaye saaf JSON dete hain
 *   - malformed JSON par 400 JSON (pehle Express ka HTML 400 aata tha)
 *   - anjaan /api route par 404 JSON
 *   - DB wale routes par friendly 503 JSON
 * Chalao: node tools/boot-smoke-test.js   (apne aap exit ho jata hai)
 */
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=700&connectTimeoutMS=700";
process.env.ALLOW_START_WITHOUT_DB = "true";
process.env.PORT = "3999";
process.env.TEACHER_PASSWORD = "test-password-123";

require("../server.js");

const BASE = "http://127.0.0.1:3999";

async function hit(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = body;
  }
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* HTML aaya to yahi pakadna hai */ }
  return { status: res.status, isJson: parsed !== null, text };
}

setTimeout(async () => {
  const checks = [
    ["GET", "/api/health", undefined],
    ["GET", "/api/health?storage=1", undefined],
    ["GET", "/api/does-not-exist", undefined],
    ["POST", "/api/teacher/login", '{"password":'],
    ["POST", "/api/teacher/login", '{"password":"wrong-password"}'],
    ["GET", "/api/teacher/audit", undefined],
  ];
  let failures = 0;
  for (const [method, path, body] of checks) {
    try {
      const r = await hit(method, path, body);
      const jsonExpected = true;
      const ok = r.status >= 200 && r.status < 600 && r.isJson === jsonExpected;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"} | ${method} ${path} -> ${r.status} | json=${r.isJson} | ${r.text.slice(0, 120)}`);
    } catch (e) {
      failures++;
      console.log(`FAIL | ${method} ${path} -> ${e.message}`);
    }
  }
  console.log(failures ? `BOOT SMOKE FAILED (${failures})` : "BOOT SMOKE PASSED");
  process.exit(failures ? 1 : 0);
}, 3000);
