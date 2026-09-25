# College Attendance System — poori guide (Hinglish)

Ek hi codebase: **teacher page se code banta hai, student phone se classroom ke andar se hi attendance mark kar sakta hai**, aur report/PDF/email sab automatically teacher ko mil jati hai. Har important check **server par** hota hai — client (browser/phone) par bharosa nahi kiya jata.

```
Teacher (teacher.html)                Student (student.html)
   │ code generate (5-digit)              │ code + roll no + GPS
   │ 2 / 5 / 7 minute wala window         │ (location server par verify)
   ▼                                      ▼
        server.js  ───────────────►  MongoDB (Atlas)
   │ anti-proxy + device lock + duplicate check
   │ 20 min baad PDF email │ raat ko/monthly report │ live dashboard
```

---

## 1. Quick start (local)

```bash
npm install
node server.js
# teacher:  http://localhost:3000/teacher.html
# student:  http://localhost:3000/student.html
# health:   http://localhost:3000/api/health
```

Minimum env vars (Render → Environment tab):

| Variable | Kaam | Default |
|---|---|---|
| `MONGODB_URI` | Atlas connection string (**zaroori**) | — (na ho to server band) |
| `TEACHER_PASSWORD` | Teacher page ka password | `changeme123` (warn karta hai) |
| `TEACHER_EMAIL` | **DEFAULT inbox** — jahan report jati hai jab subject ka email set na ho (aur student ka email na ho) | — |
| `RESEND_API_KEY` | Email bhejne ke liye | — (na ho to email band, baaki sab chalu) |
| `CRON_SECRET` | Do cron URLs ko lock karne ke liye | — |
| `CLASSROOM_LAT` / `CLASSROOM_LNG` | Classroom ka centre | 31.10648 / 77.15175 |
| `CLASSROOM_RADIUS_METERS` | Allowed radius (m) | 150 |
| `COLLEGE_NAME` | PDF/email header par naam | College Attendance System |
| `EMAIL_FROM` | Bhejne wala address (Resend par verified domain) | Attendance App &lt;onboarding@resend.dev&gt; |

---

## 2. Anti-proxy / security settings

| Variable | Kaam | Default |
|---|---|---|
| `STRICT_LOCATION` | `true` = GPS check server owner ke bina band nahi ho sakta | `true` |
| `MAX_ACCURACY_METERS` | Isse dhundhla fix reject | 60 |
| `MIN_REAL_ACCURACY_METERS` | Isse **zyada** precise fix = nakli (mock) → reject | 1 |
| `MAX_FIX_AGE_SEC` | Iss se purana GPS fix reject (replay band) | 45 |
| `GEOFENCE_STRICT_CIRCLE` | distance + accuracy ≤ radius (poora uncertainty circle andar) | `true` |
| `LOCATION_TOKEN_TTL_SEC` | One-time location token ki life | 150 |
| `BLOCK_AUTOMATION` | DevTools/selenium/puppeteer/curl se mark **block** | `true` |
| `AUTO_REVIEW_FLAGGED` | Koi bhi flag wali entry **auto-pending** (teacher approve kare tab count) | `true` |
| `REQUIRE_APPROVAL_DEFAULT` | Naya session by default approval mode | `false` |
| `TEACHER_MAX_FAILED_LOGINS` / `TEACHER_LOCKOUT_MINUTES` | Login brute-force lock | 5 / 15 |
| `TEACHER_TOKEN_TTL_HOURS` | Login token ki life (password har request me nahi bhejna padta) | 12 |
| `TOKEN_SALT` | Token HMAC me extra salt (koi random text) | `default-salt` |

### Fake location / DevTools se attendance kyun nahi ho paati
1. **GPS pehle server par verify** hota hai (`/api/student/location-token`) — server khud geofence check karta hai, phir **one-time token** deta hai (DB me sirf uska SHA-256 hash).
2. `mark-attendance` bina us token ke kuch save **nahi** karta. Token **device + session + code** se bandha hai, single-use hai, 150 sec me expire hota hai → **copied request body replay nahi hoti**, lat/lng browser me badalne ka faayda nahi.
3. **Accuracy 1 m se kam = mock location** → reject (asli phone ka GPS itna precise nahi hota).
4. **45 sec se purana fix** → reject (purana/cached fix bhej kar mark karna band).
5. **Automation block**: headless/user-agent patterns + `navigator.webdriver` → 403 (DevTools console se script chalane par bhi band).
6. **Auto-review**: ek bhi flag (mock, shared coordinates, ek device se dusre roll ki entry, poor accuracy) → entry `pending`, register me count nahi hoti jab tak teacher approve na kare.
7. **Device ↔ roll binding**: ek phone ek hi roll number par bandh hota hai (teacher dashboard se unlock).
8. **Audit log**: delete/edit/manual-mark/unlock/code-generate/email-settings sab likha jata hai — "Data & Alerts" tab me dikhta hai.

### Honest limitations (jhooth nahi)
- Web par **absolute** guarantee nahi hoti: rooted phone + custom GPS app, ya teacher ka password share karna, in par 100% rok nahi lagti. Isliye combo use hota hai: **verified location + device binding + chhota code window + approval mode + audit**.
- Shortest code window (**2 minute**) + approval mode ON = link/code WhatsApp par share karna **bekaar** ban jata hai.

---

## 3. Data retention — 12 mahine wala rule

| Data | Kitne din tak | Variable |
|---|---|---|
| Attendance marks | **400 din** (365-din report se lamba, warna annual report adhoori) | `ATTENDANCE_RETENTION_DAYS` |
| Student ki identity (naam, class, major subject, **email**) | **365 din (12 mahine)** — **rolling** | `STUDENT_RETENTION_DAYS` |
| Device ↔ roll binding | **365 din (12 mahine)** — rolling | `DEVICE_LOCK_RETENTION_DAYS` |
| Teacher audit log | **730 din (2 saal)** | `AUDIT_RETENTION_DAYS` |
| Code sessions (ActiveCode) | 90 din | (code me fix) |
| Location tokens | 30 minute | (code me fix) |

**Rolling ka matlab:** jab bhi us roll number par activity hoti hai (attendance mark, name lookup, my-attendance, roster upload) uska 12-mahine ka timer **reset** ho jata hai. Isliye regular padhne wale students ka data kabhi delete nahi hota — sirf **12 mahine se bilkul inactive** records MongoDB khud hata deta hai (TTL index).

Purane documents jisme TTL field nahi hai, unhe startup par **backfill** kar diya jata hai (warna Mongo unhe kabhi delete nahi karta).

---

## 4. MongoDB capacity — 500 students × 5 classes roz (365 din)

| Hisaab | Value |
|---|---|
| Marks per din | 500 × 5 = **2,500** |
| Marks per saal | **9,12,500** |
| 1 record ka size (roll, naam, subject, course, session, lat/lng, accuracy, distance, flags, status, ip) | ~380–450 bytes |
| 1 saal ka data | **~350–400 MB** |
| Indexes (unique 6-field + TTL + spread indexes) | **~200–250 MB** |
| **Total ~1 saal baad** | **~550–650 MB** |

- ❌ **Atlas M0 (FREE, 512 MB)** me ye 7–9 mahine me full ho jayega — full hone par **writes fail** hoti hain (yahi asli "data side crash" ban sakta hai).
- ✅ **Atlas M2 (2 GB)** ya **M5 (5 GB)** par 400-din retention (= ~9–10 lakh docs) aaram se chalta hai.
- 400-din steady state = ~1M docs ≈ **500–600 MB**, isliye M2 minimum rakhein.
- **Live numbers** kahan dekhein:
  - `GET /api/health?storage=1` → used MB, data MB, index MB, avg doc size, docs/day.
  - Teacher page → **⚙️ Data & Alerts → "Data policy & storage"** → used %, **days left estimate** aur **projected full date**.
- Quota galat lage to `MONGO_QUOTA_MB` set karein (M0=512, M2=2048, M5=5120, M10=10240).

Storage bachane ke tips: 400 → 200 din retention (Semester system), ya purane saal ka data CSV/PDF me nikaal kar delete (report se pehle nikaal lo, kyunki 400 din baad data chala jata hai).

---

## 5. Emails — subject-wise + default fallback

**Setting kahan:** Teacher page → **⚙️ Data & Alerts → Email routing**. Code change ya redeploy ki zaroorat nahi.

| Field | Rule |
|---|---|
| `Subject` | **zaroori** (exact match, case-insensitive) |
| `Course type` | khaali chhodo = *har* course type ke liye |
| `Class` | khaali chhodo = *har* class ke liye |
| `Emails` | comma/space se alag-alag, ek se zyada chalte hain |

- **Sabse specific mapping jeetti hai** (subject + course_type + class > sirf subject). Barabar specific wali sab merge ho jati hain.
- **Kuch match na ho → DEFAULT email** = `TEACHER_EMAIL`. Isliye ek bhi mapping na banayein to bhi har report teacher ko milti hi rahegi.
- **Student ka apna email**: roster upload me 5th column (`rollno,name,class,major,email`) ya student page par ek baar bhar dein → us bande ka personal report uske email par jata hai. **Email na ho to report DEFAULT email par** chali jati hai (teacher ko pata chal jata hai).

Kaun-kaun se email jate hain:
1. **Session PDF** — code banne ke 20 minute baad automatically (subject-wise mapping / default).
2. **Monthly combined report** — pichhle mahine ke saare class+subject+course-type combos, ek hi mail me (cron se).
3. **Manual “Email now”** — Reports tab / Live tab se: session, overall (365/180 din), ya ek student ka personal report.

---

## 6. Reports, PDF aur CSV

- **Session PDF** (automatic + manual): college header band, session info strip, KPI tiles (marked/confirmed/pending/flagged/avg accuracy/devices), **10-minute marks ka bar chart**, student table (distance, accuracy, status, flags) — flagged rows **laal**, pending **amber**, colour-coded status, footer me flag legend + "Page X of Y".
- **Overall PDF** (365 din / 180 din): 45 din tak **day-by-day P/A grid**, usse zyada din par **summary table + colour-coded % bar** (75% par navy tick), KPI tiles (students, classes held, average %, below-75 count).
- **Student PDF**: overall % bada colour-coded + progress bar, subject-wise table, 75% se kam hone par **warning box** (kitni classes aur chahiye).
- **Email body bhi HTML analytics** ke saath jati hai (KPI chips, first/last mark, distance range, top risky entries) — sirf "PDF attached" nahi.
- **CSV export** (Excel/Sheets): `Reports tab / Live tab → Download CSV` ya `GET /api/teacher/export.csv?...` — roll, naam, class, subject, type, system, date, IST time, status, distance, accuracy, flags, device.
- PDF module `lib/pdf-reports.js` me hai; agar usme koi error aaye to server **purane simple PDF par fallback** kar deta hai — reporting kabhi band nahi hoti.

---

## 7. Teacher page ke tabs

| Tab | Kya kar sakte hain |
|---|---|
| ⚡ **Live** | Code generate (2/5/7 min), live countdown, marked/pending/flagged/roster counters, **live feed (5 sec refresh)** — naye marks wahin dikhte hain, pending ko wahin se Approve/Reject, 10-minute activity bars, "Email report now", "Download CSV", End session, approval-mode toggle |
| 📋 **Register** | Us din ka register, entry edit/delete, present/absent list (roster ke against) |
| 👥 **Roster** | Poori class ka roster paste upload (`rollno,name,class,major,email`), manual mark (jinka GPS kaam na kare), device unlock |
| 📄 **Reports** | Overall % PDF download + **Email overall** + **Email student** (roll number daalein) + **Download CSV** |
| 🛡 **Review** | Pending approvals, flagged entries, aur jinke phone se location baar-baar fail hui |
| ⚙️ **Data & Alerts** | Subject-wise email routing, data policy + storage (kitne din me Mongo full hoga), **audit log** (kisne kab kya badla) |

---

## 8. API endpoints (reference)

**Teacher (auth: `X-Teacher-Token` ya purana `X-Teacher-Password`)**
```
POST   /api/teacher/login                 → { token, expires_in_seconds }
POST   /api/teacher/generate-code         → naya 5-digit code + session_id
GET    /api/teacher/session-status        → countdown + counters
GET    /api/teacher/session-live          → live feed (since_ms se sirf naye marks)
POST   /api/teacher/end-session
GET    /api/teacher/session-report        → present / pending / absent
GET    /api/teacher/sessions              → us din ke saare sessions
GET    /api/teacher/attendance            → register (date=YYYY-MM-DD)
PATCH  /api/teacher/attendance/update
DELETE /api/teacher/attendance/delete
POST   /api/teacher/attendance/manual-mark
POST   /api/teacher/attendance/approve | /reject | /approve-all
POST   /api/teacher/session/set-approval
DELETE /api/teacher/device-lock
POST   /api/teacher/upload-roster         → email 5th column (optional)
GET    /api/teacher/roster
GET    /api/teacher/review
GET    /api/teacher/reports/overall-download   → PDF
GET    /api/teacher/export.csv                 → CSV
POST   /api/teacher/email-reports              → mode: session | overall | student
GET    /api/teacher/email-settings | POST | DELETE
GET    /api/teacher/audit                      → ?limit=50
GET    /api/teacher/data-policy                → retention + storage projection
```

**Student**
```
GET    /api/student/lookup-name      → naam/class/major/email auto-fill
POST   /api/student/location-token   → GPS verify → one-time token
POST   /api/student/mark-attendance  → token ke bina kuch save nahi hota
GET    /api/student/my-attendance    → sirf usi phone/roll ki subject-wise %
```

**Cron / monitoring**
```
GET    /api/health                   → db state + anti-proxy + data policy (+?storage=1)
GET    /api/check-and-send-pdfs      → 20-min baad wali PDF bhejta hai (har 5-10 min ping karein)
GET    /api/check-and-send-monthly-report → pichhle mahine ka combined report (roz 1 baar)
```

---

## 9. Cron setup (Render free instance ke liye zaroori)

Render ka free instance ~15 min idle ke baad sota hai, isliye [cron-job.org](https://cron-job.org) par 3 jobs banayein:

| URL | Kitni baar |
|---|---|
| `https://YOUR-APP.onrender.com/api/health` | har **10 minute** (server jaagta rahe) |
| `https://YOUR-APP.onrender.com/api/check-and-send-pdfs?secret=CRON_SECRET` | har **5–10 minute** |
| `https://YOUR-APP.onrender.com/api/check-and-send-monthly-report?secret=CRON_SECRET` | roz **1 baar** (report 1 tareekh ke baad kisi bhi din chali jayegi) |

`CRON_SECRET` set na ho to ye endpoints khule rehte hain (sirf warning milti hai) — isliye production me set karein.

---

## 10. Tools / tests (jo repo me hain)

```bash
node tools/pdf-smoke-test.js      # 5 sample PDF + email HTML -> tmp/ (page-count regression check)
node tools/boot-smoke-test.js     # DB ke bina server boot + JSON error handling check
node tools/verify-teacher-ui.js   # teacher.html: JS syntax, duplicate ids, API paths server se match
```

`paye3 → `tmp/` folder test output ke liye hai (repo me commit karne ki zaroorat nahi).

---

## 11. Deploy checklist (Render + Atlas)

1. Atlas par cluster banayein — **M2 ya M5** (500 × 5 daily ke liye M0 kam padta hai).
2. Atlas → Network Access me `0.0.0.0/0` (ya Render ke IPs) allow karein.
3. Render → Environment me `MONGODB_URI`, `TEACHER_PASSWORD`, `TEACHER_EMAIL`, `RESEND_API_KEY`, `CRON_SECRET`, `COLLEGE_NAME`, `CLASSROOM_LAT/LNG`, `ALLOW_START_WITHOUT_DB=true`, `MONGO_QUOTA_MB=2048`.
4. Resend par apna domain verify karke `EMAIL_FROM` set karein (warna sirf apne hi email par bhej paayenge).
5. Deploy → `/api/health` khol kar dekhein: `ok:true`, `db:"connected"`, `anti_proxy.strict_location: true`, `data_policy.student_retention_days: 365`.
6. Teacher page par sign in → ek test code bana kar mobile se mark karke poora flow check karein, phir **Register → delete** se test entry hata dein (audit log me record rahega).

## 12. Aage ke sujhav (Phase 2 — abhi nahi hua)

1. **Multi-room geofence** — har room/block ki apni lat-lng, teacher room chune (ek hi college-wide radius ki jagah).
2. **Attendance shortage alert** — 75% se neeche jate hi student + teacher ko mail/SMS.
3. **Yearly archive collection** — 12 mahine se purane marks ka monthly aggregate (present/held) rakh kar full docs delete → storage bachega, analytics bachi rahegi.
4. **WhatsApp/SMS notification** (Absent alert / code delivery) — MSG91 ya Twilio.
5. **BLE beacon proximity** — phone ko room ke Bluetooth beacon ke paas hona zaroori (sabse strong anti-proxy, par web-only me limited).
6. **Student self-service PDF** — apna report khud download kar sake.
7. **Timetable-based auto session** — period ke hisaab se code khud ban jaye.
8. **Per-teacher login** (shared password ki jagah) — har teacher ka apna account + subject-wise access.