/**
 * Page verification script (koi test framework nahi) — dono HTML pages ke liye:
 *   1) inline <script> nikalta hai -> tmp/<page>-inline.js (node --check ke liye)
 *   2) duplicate ids dhundhta hai
 *   3) JS me $('id') se use hue lekin HTML me na hone wale ids dhundhta hai
 *   4) JS me call kiye gaye /api paths list karta hai + server.js se match karta hai
 *   5) chhota XSS guard: innerHTML me raw data paste karne wale patterns flag karta hai
 * Chalao: node tools/verify-pages.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PAGES = ["public/teacher.html", "public/student.html"];
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
fs.mkdirSync(path.join(ROOT, "tmp"), { recursive: true });

let failures = 0;

for (const rel of PAGES) {
  console.log(`\n=== ${rel} ===`);
  const html = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const js = scripts.join("\n;\n");
  const inlineFile = path.join(ROOT, "tmp", `${path.basename(rel, ".html")}-inline.js`);
  fs.writeFileSync(inlineFile, js, "utf8");
  console.log(`scripts: ${scripts.length} | inline JS lines: ${js.split("\n").length} -> ${path.relative(ROOT, inlineFile)}`);
  if (scripts.length === 0) {
    failures++;
    console.log("FAIL: koi inline <script> nahi mila (regex ya HTML check karein)");
  }

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  console.log(`ids: ${ids.length} | duplicates: ${JSON.stringify(duplicates)}`);
  if (duplicates.length) failures++;

  const usedIds = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = usedIds.filter((id) => !ids.includes(id));
  console.log(`ids used by JS but missing in HTML: ${JSON.stringify(missing)}`);
  if (missing.length) failures++;

  const apiPaths = [...new Set([...js.matchAll(/\/api\/[A-Za-z0-9_\-./]+/g)].map((m) => m[0]))].sort();
  const notOnServer = apiPaths.filter((p) => !server.includes(p));
  console.log(`API paths used: ${apiPaths.length} | referenced but NOT in server.js: ${JSON.stringify(notOnServer)}`);
  if (notOnServer.length) failures++;

  // XSS guard: innerHTML me seedha variable paste karna (esc() ke bina) — manual
  // review ke liye list, hard fail nahi (kuch jagah numbers/aapke apne strings hain).
  const rawInnerHtml = [...js.matchAll(/\.innerHTML\s*=\s*`[^`]*\$\{([a-zA-Z_$][\w.$]*)\}/g)]
    .map((m) => m[1])
    .filter((v) => !/^(esc|data|p|h|_)/.test(v));
  console.log(`innerHTML me direct variable (review karein): ${JSON.stringify([...new Set(rawInnerHtml)].slice(0, 12))}`);
}

console.log("");
if (failures) {
  console.log(`VERIFY FAILED (${failures} issue(s))`);
  process.exitCode = 1;
} else {
  console.log("VERIFY PASSED");
}
