// dev.js — nodemon jaisa auto-restart, BINA kisi dependency ke.
// `npm run dev` se chalayein: server.js ya lib/ me kuch bhi save karo → server
// apne aap restart ho jata hai. (Production/Render par `npm start` kaafi hai —
// dev.js sirf local development ke liye hai.)
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const WATCH = ["server.js", "lib"];
let child = null;
let restartTimer = null;

function start() {
  child = spawn(process.execPath, ["server.js"], { stdio: "inherit", cwd: __dirname });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.log(`[dev] server exited (code ${code}) — fix karke save karo, dobara start hoga.`);
  });
}
function restart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log("[dev] file change → restarting server…");
    if (child) { try { child.kill(); } catch (e) {} }
    start();
  }, 300);
}
for (const p of WATCH) {
  try {
    fs.statSync(path.join(__dirname, p));
    fs.watch(path.join(__dirname, p), { recursive: true }, () => restart());
    console.log(`[dev] watching ${p}`);
  } catch (e) {
    console.log(`[dev] cannot watch ${p}: ${e.message}`);
  }
}
console.log("[dev] starting server (auto-restart on server.js / lib change)…");
start();