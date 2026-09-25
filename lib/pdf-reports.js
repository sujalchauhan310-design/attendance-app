/**
 * lib/pdf-reports.js — modern, analytics-rich attendance PDFs + report email HTML
 * ------------------------------------------------------------------------------
 * Why this file exists:
 *  - server.js pehle se ek simple attendance PDF bhejta hai. Ye module uske
 *    upar "analytics rich" reports deta hai: KPI tiles, 10-minute bucket bar
 *    chart, flagged/pending rows colour-coded, colour-coded % + progress bars,
 *    aur ek Gmail-safe HTML email body.
 *  - Self-contained hai: sirf `pdfkit` (already installed) chahiye, server.js ko
 *    require nahi karta, aur koi file/DB side-effect nahi karta.
 *
 * RULES JO YAHAN FOLLOW HOTE HAIN:
 *  - Sirf Helvetica family (koi font file ship nahi karni padti) => PDF me jaane
 *    wali HAR string asciiSafe() se guzarti hai, taaki emoji / Devanagari /
 *    em-dash silently garbage glyph na ban jaye.
 *  - Har date/time IST (Asia/Kolkata) me. Render ka server UTC par chalta hai,
 *    isliye sab kuch formatIstTime()/formatIstDate() se hi render hota hai.
 *  - Pure Promise + Buffer API. PDFDocument stream handlers ke andar async/await
 *    nahi hai — sirf synchronous drawing, aur ek Promise jo "end" par resolve hota hai.
 *
 * NOTE: PDFKit ka doc.save()/restore() sirf graphics state (CTM) bachata hai,
 * colours/fonts nahi — isliye har text/fill se pehle font + fillColor explicitly
 * set kiya jata hai. Isi wajah se output deterministic rehta hai.
 *
 * EXPORTS (server.js exactly inhi naam se wire karega):
 *   computeSessionAnalytics(records, opts)
 *   buildSessionPdfBuffer(session, records, opts)          -> Promise<Buffer>  (A4 portrait)
 *   buildOverallReportPdfBuffer(meta, rows, opts)          -> Promise<Buffer>  (A4 landscape)
 *   buildStudentReportPdfBuffer(meta, student, rows, opts) -> Promise<Buffer>  (A4 portrait)
 *   buildReportEmailHtml(summary)                          -> string (email-safe HTML)
 */

const PDFDocument = require("pdfkit");

// ---------------------------------------------------------------------------
// IST DATE / TIME HELPERS (locale-based, no manual UTC math)
// ---------------------------------------------------------------------------
const IST_TIMEZONE = "Asia/Kolkata";
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// HH:MM in IST. toLocaleTimeString use karte hain aur regex se normalize,
// kyunki kuch ICU builds "24:00" ya odd spacing de dete hain.
function formatIstTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "-";
  const raw = new Date(value).toLocaleTimeString("en-IN", {
    timeZone: IST_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const match = /(\d{1,2}):(\d{2})/.exec(raw);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : raw;
}

// YYYY-MM-DD in IST. en-CA locale ISO-jaisa date deta hai; agar koi ICU usse
// ignore kare to parts se compose kar dete hain (fallback).
function formatIstDate(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "-";
  const iso = new Date(value).toLocaleDateString("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const pick = (type) => {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : "00";
  };
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// Ek hi line me "2026-09-25 10:07 IST" — footers aur "Generated ..." ke liye.
function formatIstStamp(ms) {
  const value = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  return `${formatIstDate(value)} ${formatIstTime(value)} IST`;
}

// "2026-09-25" -> "Sep" (grid header ke month row ke liye).
function istMonthShort(dateStr) {
  const idx = Number(String(dateStr).slice(5, 7)) - 1;
  return MONTH_SHORT[idx] || "";
}

// "2026-09-05" -> "5" (grid header me sirf din ka number dikhana hai).
function istDayNumber(dateStr) {
  const day = Number(String(dateStr).slice(8, 10));
  return Number.isFinite(day) && day > 0 ? String(day) : String(dateStr);
}

// ---------------------------------------------------------------------------
// SHARED PALETTE + LAYOUT (ek hi jagah se poore reports ka look control hota hai)
// ---------------------------------------------------------------------------
const PALETTE = {
  navy: "#0f172a",
  slate: "#64748b",
  light: "#f1f5f9",
  green: "#16a34a",
  amber: "#f59e0b",
  red: "#dc2626",
  sky: "#0ea5e9",
  white: "#ffffff",
  border: "#e2e8f0",
  zebra: "#f8fafc",
  flagBg: "#fee2e2", // flagged row: red tint
  pendingBg: "#fef3c7", // pending row: amber tint
  noteBg: "#fffbeb",
  noteText: "#78350f",
  noteBorder: "#fde68a",
};
const PAGE_MARGIN = 40;
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

// Page ki usable width (portrait/landscape dono ke liye dynamic).
function contentWidth(doc) {
  return doc.page.width - PAGE_MARGIN * 2;
}
// Table/paragraph ka last safe y — neeche footer ke liye jagah chhodta hai.
function contentBottom(doc) {
  return doc.page.height - PAGE_MARGIN - 30;
}

// ---------------------------------------------------------------------------
// TINY TEXT / NUMBER HELPERS
// ---------------------------------------------------------------------------
// Helvetica sirf Latin-1/ASCII reliably draw karta hai. Common "smart" chars ko
// readable ASCII me map karte hain, baaki sab "?" — isse PDF me tofu boxes nahi aate.
const ASCII_MAP = {
  "\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"',
  "\u201d": '"', "\u2022": "*", "\u2026": "...", "\u00a0": " ", "\u00b7": "-",
};
function asciiSafe(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return text
    .replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u00a0\u00b7]/g, (ch) => ASCII_MAP[ch] || ch)
    .replace(/[^\x20-\x7e]/g, "?"); // kuch bhi non-ASCII -> "?"
}

// Number ya null (NaN/undefined ko null kar dete hain, taaki averages clean rahe).
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function round1(value) {
  return Math.round(value * 10) / 10;
}
// Average of a numeric list -> 1 decimal, empty list -> null.
function meanOf(list) {
  return list.length ? round1(list.reduce((sum, v) => sum + v, 0) / list.length) : null;
}
function fmtMeters(value) {
  const n = num(value);
  return n === null ? "-" : `${Math.round(n)} m`;
}
function fmtAccuracy(value) {
  const n = num(value);
  return n === null ? "-" : `${round1(n)} m`;
}
// 75%+ green, 60-74.9 amber, niche red — PDF aur email dono me same rule.
function pctColor(pct) {
  const p = num(pct) === null ? 0 : num(pct);
  if (p >= 75) return PALETTE.green;
  if (p >= 60) return PALETTE.amber;
  return PALETTE.red;
}
// Text ko cell width me fit karta hai (".." ke saath) — table columns tootne nahi chahiye.
function fitText(doc, value, maxWidth) {
  const text = asciiSafe(value);
  if (maxWidth <= 0) return "";
  if (doc.widthOfString(text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(`${cut}..`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}..`;
}

// ---------------------------------------------------------------------------
// REUSABLE DRAWING BLOCKS
// ---------------------------------------------------------------------------
// Navy header band: college (left) + report title (right) + sub-line.
// Returns the next free y.
function drawHeaderBand(doc, options) {
  const o = options || {};
  const height = o.height || 62;
  const width = contentWidth(doc);
  doc.rect(0, 0, doc.page.width, height).fill(PALETTE.navy);
  doc.rect(0, height, doc.page.width, 3).fill(PALETTE.sky);

  doc.font(FONT_BOLD).fontSize(o.titleSize || 14).fillColor(PALETTE.white);
  doc.text(fitText(doc, o.college || "College", width * 0.62), PAGE_MARGIN, 15, { width: width * 0.62, lineBreak: false });
  doc.font(FONT_BOLD).fontSize(9.5).fillColor("#7dd3fc"); // sky-300: navy par readable
  doc.text(fitText(doc, o.title || "Attendance Register", width * 0.35), PAGE_MARGIN, 19, { width, align: "right", lineBreak: false });
  doc.font(FONT).fontSize(7.5).fillColor("#cbd5e1");
  doc.text(asciiSafe(o.sub || ""), PAGE_MARGIN, 39, { width, lineBreak: false });
  return height + 16;
}

// Light rounded strip: [label, value] pairs grid me (max 3 rows tak).
function drawInfoStrip(doc, y, items, cols) {
  const width = contentWidth(doc);
  const colCount = cols || 3;
  const colW = width / colCount;
  const rowH = 25;
  const rows = Math.max(1, Math.ceil(items.length / colCount));
  const height = rows * rowH + 12;
  doc.roundedRect(PAGE_MARGIN, y, width, height, 6).fill(PALETTE.light);
  items.forEach((item, i) => {
    const cx = PAGE_MARGIN + 12 + (i % colCount) * colW;
    const cy = y + 9 + Math.floor(i / colCount) * rowH;
    doc.font(FONT).fontSize(6.5).fillColor(PALETTE.slate);
    doc.text(fitText(doc, String(item[0]).toUpperCase(), colW - 20), cx, cy, { width: colW - 20, lineBreak: false });
    doc.font(FONT_BOLD).fontSize(9).fillColor(PALETTE.navy);
    doc.text(fitText(doc, item[1], colW - 20), cx, cy + 9, { width: colW - 20, lineBreak: false });
  });
  return y + height + 14;
}

// KPI tiles: white card + coloured left accent + big tone-coloured value.
// tiles: [{ label, value, tone }], ek hi row me `cols` tiles.
function drawKpiTiles(doc, y, tiles, cols) {
  const width = contentWidth(doc);
  const gap = 8;
  const colCount = cols || tiles.length || 1;
  const tileW = (width - gap * (colCount - 1)) / colCount;
  const height = 46;
  tiles.forEach((tile, i) => {
    const tx = PAGE_MARGIN + i * (tileW + gap);
    const tone = tile.tone || PALETTE.navy;
    doc.roundedRect(tx, y, tileW, height, 6).fillAndStroke(PALETTE.white, PALETTE.border);
    doc.rect(tx, y + 8, 4, height - 16).fill(tone);
    doc.font(FONT).fontSize(6.5).fillColor(PALETTE.slate);
    doc.text(fitText(doc, tile.label, tileW - 18), tx + 12, y + 9, { width: tileW - 18, lineBreak: false });
    doc.font(FONT_BOLD).fontSize(15).fillColor(tone);
    doc.text(fitText(doc, tile.value, tileW - 18), tx + 12, y + 20, { width: tileW - 18, lineBreak: false });
  });
  return y + height + 14;
}

// Section heading (navy title + optional right-side note + sky underline).
function drawSectionTitle(doc, y, title, note) {
  const width = contentWidth(doc);
  doc.font(FONT_BOLD).fontSize(10).fillColor(PALETTE.navy);
  doc.text(fitText(doc, title, width * 0.55), PAGE_MARGIN, y, { width: width * 0.6, lineBreak: false });
  if (note) {
    doc.font(FONT).fontSize(6.5).fillColor(PALETTE.slate);
    doc.text(fitText(doc, note, width * 0.55), PAGE_MARGIN, y + 3, { width, align: "right", lineBreak: false });
  }
  doc.moveTo(PAGE_MARGIN, y + 14).lineTo(PAGE_MARGIN + width, y + 14).lineWidth(0.8).strokeColor(PALETTE.sky).stroke();
  return y + 24;
}

// Total width of a column set (rows ka background isi se banta hai).
function tableWidth(columns) {
  return columns.reduce((sum, col) => sum + col.width, 0);
}

// Table header band (navy). Grid me columns dynamically banti hain (1 per day).
function drawTableHeader(doc, y, columns) {
  const height = 16;
  doc.rect(PAGE_MARGIN, y, tableWidth(columns), height).fill(PALETTE.navy);
  doc.font(FONT_BOLD).fontSize(6.8).fillColor(PALETTE.white);
  let x = PAGE_MARGIN;
  columns.forEach((col) => {
    doc.text(fitText(doc, col.label, col.width - 6), x + 3, y + 4.5, {
      width: col.width - 6,
      align: col.align || "left",
      lineBreak: false,
    });
    x += col.width;
  });
  return height;
}

// Ek table row (zebra/flag background + per-cell colour + alignment).
// style: { bold, fontSize, bg, colors[], color, height, blank }
function drawTableRow(doc, y, columns, cells, style) {
  const s = style || {};
  const height = s.height || 15;
  const fontSize = s.fontSize || 7.5;
  if (s.bg) doc.rect(PAGE_MARGIN, y, tableWidth(columns), height).fill(s.bg);
  doc.font(s.bold ? FONT_BOLD : FONT).fontSize(fontSize);
  let x = PAGE_MARGIN;
  columns.forEach((col, i) => {
    const raw = cells[i];
    const value = raw === undefined || raw === null || raw === "" ? s.blank || "-" : String(raw);
    const color = (s.colors && s.colors[i]) || s.color || PALETTE.navy;
    doc.fillColor(color);
    doc.text(fitText(doc, value, col.width - 6), x + 3, y + (height - fontSize) / 2 - 0.5, {
      width: col.width - 6,
      align: col.align || "left",
      lineBreak: false,
    });
    x += col.width;
  });
  return height;
}

// Amber info/warning box with a coloured left rail. Page break khud handle karta hai.
function drawNoteBox(doc, y, text, options) {
  const o = options || {};
  const width = contentWidth(doc);
  const inner = width - 30;
  doc.font(FONT).fontSize(7.5);
  const body = asciiSafe(text);
  const height = doc.heightOfString(body, { width: inner, align: "left", lineGap: 1 }) + 16;
  let top = y;
  if (top + height > contentBottom(doc)) {
    doc.addPage();
    top = PAGE_MARGIN;
  }
  doc.roundedRect(PAGE_MARGIN, top, width, height, 5)
    .fillAndStroke(o.bg || PALETTE.noteBg, o.border || PALETTE.noteBorder);
  doc.rect(PAGE_MARGIN, top, 4, height).fill(o.tone || PALETTE.amber);
  doc.font(FONT).fontSize(7.5).fillColor(o.textColor || PALETTE.noteText);
  doc.text(body, PAGE_MARGIN + 14, top + 8, { width: inner, align: "left", lineGap: 1 });
  return top + height + 12;
}

// Neutral "kuch nahi mila" placeholder box (empty sessions/reports ke liye).
function drawEmptyBox(doc, y, text) {
  const width = contentWidth(doc);
  const height = 54;
  doc.roundedRect(PAGE_MARGIN, y, width, height, 6).fillAndStroke(PALETTE.zebra, PALETTE.border);
  doc.font(FONT_BOLD).fontSize(9).fillColor(PALETTE.slate);
  doc.text(asciiSafe(text), PAGE_MARGIN, y + 22, { width, align: "center", lineBreak: false });
  return y + height + 14;
}

// "Page X of Y" + left note, HAR buffered page par. doc.end() se PEHLE call karo,
// warna pages flush ho chuke honge aur footer kisi page par nahi pahunchega.
//
// BUG FIX (important): PDFKit text ko tab bhi "page se bahar" maan kar ek NAYA
// page add kar deta hai jab wo page ke bottom MARGIN ke bahar shuru ho. Pehle
// footer `height - margin + 2` par draw hota tha, isliye har page ke footer ke
// baad ek extra khaali page ban jata tha (30-row register 6 page ki ban jati
// thi). Ab footer draw karne se pehle bottom margin 0 kar dete hain aur text ko
// page ke andar (height - 30) rakhte hain — extra pages nahi bante.
function stampPageFooters(doc, leftText) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // footer ke waqt poora page usable
    const y = doc.page.height - 30;
    doc.moveTo(PAGE_MARGIN, y - 6).lineTo(doc.page.width - PAGE_MARGIN, y - 6)
      .lineWidth(0.5).strokeColor(PALETTE.border).stroke();
    doc.font(FONT).fontSize(6.5).fillColor(PALETTE.slate);
    doc.text(fitText(doc, leftText, contentWidth(doc) - 90), PAGE_MARGIN, y, {
      width: contentWidth(doc) - 90,
      lineBreak: false,
      height: 8,
    });
    doc.text(`Page ${i - range.start + 1} of ${total}`, PAGE_MARGIN, y, {
      width: contentWidth(doc),
      align: "right",
      lineBreak: false,
      height: 8,
    });
    doc.page.margins.bottom = savedBottom;
  }
}

// 10-minute bucket BAR CHART. Koi chart library nahi — doc.rect() se seedha draw.
// timeline: [{ label: "10:00", count: 4 }] (computeSessionAnalytics bana ke deta hai).
function drawBarChart(doc, y, timeline) {
  const width = contentWidth(doc);
  const plotH = 96;
  const gutter = 18; // y-axis labels ke liye jagah
  const max = Math.max(1, ...timeline.map((b) => b.count));
  const bottom = y + plotH;

  // Gridlines + y-axis ticks (0 / 25 / 50 / 75 / 100 % of peak).
  [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
    const gy = bottom - frac * plotH;
    doc.moveTo(PAGE_MARGIN + gutter, gy).lineTo(PAGE_MARGIN + width, gy)
      .lineWidth(0.5).strokeColor(frac === 0 ? PALETTE.slate : PALETTE.border).stroke();
    doc.font(FONT).fontSize(6).fillColor(PALETTE.slate);
    doc.text(String(Math.round(max * frac)), PAGE_MARGIN, gy - 3, { width: gutter - 3, align: "right", lineBreak: false });
  });

  const slot = (width - gutter) / timeline.length;
  const barW = Math.max(2, Math.min(26, slot * 0.6));
  const peak = timeline.reduce((best, b, i) => (b.count > timeline[best].count ? i : best), 0);
  timeline.forEach((bucket, i) => {
    const x = PAGE_MARGIN + gutter + i * slot + (slot - barW) / 2;
    if (bucket.count <= 0) {
      doc.rect(x, bottom - 1.5, barW, 1.5).fill(PALETTE.border); // khaali bucket ka hint
      return;
    }
    const h = Math.max(3, (bucket.count / max) * (plotH - 4));
    doc.rect(x, bottom - h, barW, h).fill(i === peak && timeline.length > 1 ? PALETTE.navy : PALETTE.sky);
  });

  // X-axis labels: sirf itne jo overlap na karein (last bucket hamesha dikhta hai).
  const step = Math.max(1, Math.ceil((timeline.length * 26) / (width - gutter)));
  timeline.forEach((bucket, i) => {
    if (i % step !== 0 && i !== timeline.length - 1) return;
    doc.font(FONT).fontSize(5.8).fillColor(PALETTE.slate);
    doc.text(bucket.label, PAGE_MARGIN + gutter + i * slot, bottom + 4, { width: slot, align: "center", lineBreak: false });
  });
  return bottom + 18;
}

// ---------------------------------------------------------------------------
// 1) computeSessionAnalytics(records, opts) — pure function, zero side effects
// ---------------------------------------------------------------------------
const DEFAULT_BUCKET_MINUTES = 10;
const MAX_TIMELINE_BUCKETS = 24;

// Bucket size: default 10 min. Agar first->last mark ka span 24 buckets se
// zyada ho jaye to step 20/30/40... min kar dete hain, taaki chart readable rehе.
// Label hamesha bucket ke ASLI start ka IST time hota hai, isliye label kabhi jhoot nahi bolta.
function pickBucketMs(firstMs, lastMs, baseMinutes, maxBuckets) {
  const base = baseMinutes * 60 * 1000;
  const spanBuckets = Math.floor(lastMs / base) - Math.floor(firstMs / base) + 1;
  if (spanBuckets <= maxBuckets) return base;
  return base * Math.ceil(spanBuckets / maxBuckets);
}

/**
 * records: [{ roll_no, student_name, subject, course_type, marked_at, status,
 *             flags[], lat, lng, accuracy, distance_m, device_id, source }]
 * opts:    { bucketMinutes = 10, maxBuckets = 24 }
 * Returns: total, flagged_count, pending_count, confirmed_count, avg_accuracy,
 *          min/max/avg_distance_m, first/last_marked_at, device_count,
 *          timeline[{label,count}], top_flags[{flag,count}],
 *          risk_rows[{roll_no, student_name, flags, accuracy, distance_m}]
 */
function computeSessionAnalytics(records, opts) {
  const options = opts || {};
  const bucketMinutes = num(options.bucketMinutes) > 0 ? num(options.bucketMinutes) : DEFAULT_BUCKET_MINUTES;
  const maxBuckets = num(options.maxBuckets) > 0 ? num(options.maxBuckets) : MAX_TIMELINE_BUCKETS;
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];

  const distances = [];
  const accuracies = [];
  const marks = [];
  const devices = new Set();
  const flagTotals = new Map();
  const riskRows = [];
  let flagged = 0;
  let pending = 0;
  let confirmed = 0;

  for (const r of list) {
    const flags = Array.isArray(r.flags) ? r.flags.map(String).filter(Boolean) : [];
    const isPending = String(r.status || "").toLowerCase() === "pending";
    if (flags.length) flagged++; // 1 record = 1 flagged mark (chahe 3 flags hon)
    if (isPending) pending++;
    else confirmed++; // counted in attendance
    flags.forEach((f) => flagTotals.set(f, (flagTotals.get(f) || 0) + 1));
    const d = num(r.distance_m);
    if (d !== null) distances.push(d);
    const a = num(r.accuracy);
    if (a !== null) accuracies.push(a);
    if (r.device_id) devices.add(String(r.device_id));
    const t = num(r.marked_at);
    if (t !== null) marks.push(t);
    if (flags.length) {
      riskRows.push({
        roll_no: r.roll_no || "-",
        student_name: r.student_name || "-",
        flags,
        accuracy: num(r.accuracy),
        distance_m: num(r.distance_m),
      });
    }
  }
  marks.sort((a, b) => a - b); // timeline ke liye chronological chahiye

  // 10-minute buckets, first mark se last mark tak (khaali buckets bhi count 0 se aate hain).
  const timeline = [];
  if (marks.length) {
    const step = pickBucketMs(marks[0], marks[marks.length - 1], bucketMinutes, maxBuckets);
    const counts = new Map();
    marks.forEach((t) => {
      const key = Math.floor(t / step) * step;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    for (let key = Math.floor(marks[0] / step) * step; key <= marks[marks.length - 1]; key += step) {
      timeline.push({ label: formatIstTime(key), count: counts.get(key) || 0 });
    }
  }

  // Worst first: sabse zyada flags, phir sabse vague GPS.
  riskRows.sort((a, b) => b.flags.length - a.flags.length || (b.accuracy || 0) - (a.accuracy || 0));
  const topFlags = Array.from(flagTotals.entries())
    .map(([flag, count]) => ({ flag, count }))
    .sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag));

  return {
    total: list.length,
    flagged_count: flagged,
    pending_count: pending,
    confirmed_count: confirmed,
    avg_accuracy: meanOf(accuracies),
    min_distance_m: distances.length ? round1(Math.min.apply(null, distances)) : null,
    max_distance_m: distances.length ? round1(Math.max.apply(null, distances)) : null,
    avg_distance_m: meanOf(distances),
    first_marked_at: marks.length ? marks[0] : null,
    last_marked_at: marks.length ? marks[marks.length - 1] : null,
    device_count: devices.size,
    timeline,
    top_flags: topFlags,
    risk_rows: riskRows,
  };
}

// ---------- FLAG LEGEND (PDF footer note + email "how to read" ke liye) ----------
const FLAG_MEANING = {
  shared_coordinates: "same GPS fix as another phone",
  device_used_for_other_roll: "one phone marked more than one roll number",
  accuracy_poor: "GPS fix was too vague to trust",
  accuracy_too_perfect: "GPS fix was suspiciously precise (mock-location apps aise dete hain)",
  accuracy_missing: "phone did not report any accuracy",
  accuracy_zero: "phone reported 0 m accuracy (real GPS never does)",
  distance_far: "marked from outside the classroom radius",
  no_location_proof: "no verified location (GPS failed / net off) - pending review",
  automation_suspected: "marked from an automated/devtools browser",
  webdriver: "browser was under automation (navigator.webdriver)",
  mock_location_suspected: "fake/mock location app ka signal",
  devtools_suspected: "DevTools khula hone ka signal",
  screen_off: "screen off ho kar bheja gaya",
};
// ["shared_coordinates", ...] -> "shared_coordinates = same GPS fix as another phone; ..."
function flagLegendLines(flags) {
  const names = Array.isArray(flags) ? flags : [];
  return names.map((name) => {
    const flag = typeof name === "string" ? name : name && name.flag;
    return `${flag} = ${FLAG_MEANING[flag] || "see the teacher Review tab"}`;
  });
}

// ---------------------------------------------------------------------------
// 2) buildSessionPdfBuffer(session, records, opts) — A4 portrait, one session
// ---------------------------------------------------------------------------
// Columns ka total = 515 = A4 portrait content width (595.28 - 2*40). Isse zyada
// nahi ho sakta warna table page se bahar chala jayega.
const SESSION_COLUMNS = [
  { label: "S.No", width: 24 }, { label: "Name", width: 96 },
  { label: "Roll No", width: 52 }, { label: "Subject", width: 76 },
  { label: "Type", width: 30 }, { label: "Marked At", width: 48, align: "center" },
  { label: "Distance", width: 44, align: "center" }, { label: "Accuracy", width: 44, align: "center" },
  { label: "Status", width: 47, align: "center" }, { label: "Flags", width: 54 },
];

// Student table: zebra rows + red tint (flagged) + amber tint (pending).
// Naya page aane par header dobara print hota hai.
function drawSessionTable(doc, y, list) {
  const rowH = 14;
  let top = y + drawTableHeader(doc, y, SESSION_COLUMNS) + 1;
  list.forEach((record, index) => {
    if (top + rowH > contentBottom(doc)) {
      doc.addPage();
      top = PAGE_MARGIN + drawTableHeader(doc, PAGE_MARGIN, SESSION_COLUMNS) + 1;
    }
    const flags = Array.isArray(record.flags) ? record.flags.filter(Boolean) : [];
    const isPending = String(record.status || "").toLowerCase() === "pending";
    let bg = index % 2 === 1 ? PALETTE.zebra : PALETTE.white; // zebra
    if (isPending) bg = PALETTE.pendingBg;
    if (flags.length) bg = PALETTE.flagBg; // flags sab se important: red jeet gaya
    const colors = [];
    colors[0] = flags.length ? PALETTE.red : PALETTE.slate;
    colors[8] = isPending ? "#92400e" : PALETTE.green;
    colors[9] = flags.length ? PALETTE.red : PALETTE.slate;
    drawTableRow(doc, top, SESSION_COLUMNS, [
      index + 1,
      record.student_name || "-",
      record.roll_no || "-",
      record.subject || "-",
      record.course_type || "-",
      formatIstTime(record.marked_at),
      fmtMeters(record.distance_m),
      fmtAccuracy(record.accuracy),
      isPending ? "PENDING" : "CONFIRMED",
      flags.length ? flags.join(", ") : "-",
    ], { bg, height: rowH, fontSize: 7, colors });
    top += rowH;
  });
  return top + 6;
}

/**
 * session: { class_name, subject, course_type, system, code, dateForPdf,
 *            created_at, expires_at, require_approval, require_location }
 * opts:    { collegeName, generatedAt(ms), teacherName, title }
 * Empty records => header + KPI tiles (zeros) + clean "No attendance was recorded" box.
 */
function buildSessionPdfBuffer(session, records, opts) {
  const s = session || {};
  const options = opts || {};
  const generatedAt = num(options.generatedAt) === null ? Date.now() : num(options.generatedAt);
  const list = (Array.isArray(records) ? records.slice() : [])
    .filter((r) => r && typeof r === "object")
    .sort((a, b) => (num(a.marked_at) || 0) - (num(b.marked_at) || 0));
  const stats = computeSessionAnalytics(list);

  // Promise + Buffer API: stream par chunks ikattha karke "end" par resolve.
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      const sessionDate = s.dateForPdf || formatIstDate(num(s.created_at) === null ? generatedAt : s.created_at);
      const codeWindow = `${formatIstTime(s.created_at)} - ${formatIstTime(s.expires_at)}`;
      let y = drawHeaderBand(doc, {
        college: options.collegeName,
        title: options.title || "Attendance Register",
        sub: `Generated ${formatIstStamp(generatedAt)}${options.teacherName ? `   |   Teacher: ${options.teacherName}` : ""}`,
      });

      // Session info strip: missing field apne aap "-" ban jata hai (drawInfoStrip).
      y = drawInfoStrip(doc, y, [
        ["Date", sessionDate], ["Class", s.class_name], ["Subject", s.subject],
        ["Course type", s.course_type], ["System", s.system || "Annual"], ["Code", s.code],
        ["Code window (IST)", codeWindow],
        ["Approval", s.require_approval ? "Pending marks need approval" : "Auto approved"],
        ["Location", s.require_location ? "GPS verified in classroom" : "GPS check off"],
      ], 3);

      // KPI tiles: empty session me bhi ye row zeros ke saath dikhti hai.
      y = drawKpiTiles(doc, y, [
        { label: "Total marked", value: stats.total, tone: PALETTE.sky },
        { label: "Confirmed", value: stats.confirmed_count, tone: PALETTE.green },
        { label: "Pending", value: stats.pending_count, tone: PALETTE.amber },
        { label: "Flagged", value: stats.flagged_count, tone: PALETTE.red },
        { label: "Avg accuracy", value: fmtAccuracy(stats.avg_accuracy), tone: PALETTE.navy },
        { label: "Devices", value: stats.device_count, tone: PALETTE.navy },
      ], 6);

      // Bar chart sirf tab jab koi mark ho (khaali chart ka koi matlab nahi).
      if (stats.total) {
        const stepMinutes = Math.round(
          pickBucketMs(stats.first_marked_at, stats.last_marked_at, DEFAULT_BUCKET_MINUTES, MAX_TIMELINE_BUCKETS) / 60000
        );
        const peak = Math.max.apply(null, stats.timeline.map((b) => b.count));
        y = drawSectionTitle(doc, y, "Marking activity (IST)", `${stepMinutes}-minute buckets | peak ${peak} mark(s)`);
        y = drawBarChart(doc, y, stats.timeline);
      }

      y = drawSectionTitle(doc, y, "Student-wise register", `${stats.total} mark(s) from ${stats.device_count} device(s)`);
      if (!stats.total) {
        y = drawEmptyBox(doc, y, "No attendance was recorded for this session.");
      } else {
        y = drawSessionTable(doc, y, list);
      }

      // Footer note: flags ka matlab + pending ka reminder (plain ASCII, no emoji).
      const flaggedNames = stats.top_flags.map((f) => f.flag);
      const legend = flaggedNames.length
        ? `Flag legend: ${flagLegendLines(flaggedNames).join("; ")}. Pending marks are NOT counted until the teacher approves them.`
        : "No flags were raised for this session. Pending marks (if any) are NOT counted until the teacher approves them.";
      drawNoteBox(doc, y, legend, { tone: stats.flagged_count ? PALETTE.red : PALETTE.amber });

      // Footer har page par — doc.end() se pehle.
      stampPageFooters(doc, `${options.collegeName || "College"} | ${s.class_name || "-"} | ${s.subject || "-"} | Generated ${formatIstStamp(generatedAt)}`);
      doc.end();
    } catch (error) {
      reject(error); // drawing error bhi promise reject karega, process crash nahi
    }
  });
}

// ---------------------------------------------------------------------------
// 3) buildOverallReportPdfBuffer(meta, rows, opts) — A4 landscape
// ---------------------------------------------------------------------------
// Isse zyada din ho jayein to grid page par fit nahi hota => summary table.
const GRID_MAX_DAYS = 45;

// Overall KPI numbers ek jagah (PDF + email + tests sab isi ko use karte hain).
function summarizeOverall(meta, rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
  const pcts = list.map((r) => num(r.pct)).filter((p) => p !== null);
  return {
    students: list.length,
    classDays: num(meta && meta.classDays) || 0,
    avgPct: meanOf(pcts),
    below75: pcts.filter((p) => p < 75).length,
  };
}

// Short range (<= 45 dates): day-by-day P/A grid. Har din ek patli column, header
// me sirf din ka number + upar month ka naam (jab month badle).
function drawOverallGrid(doc, y, meta, rows) {
  const dates = meta.dates;
  const fixed = { sno: 24, name: 110, roll: 52, att: 32, held: 34, pct: 34 };
  const fixedSum = fixed.sno + fixed.name + fixed.roll + fixed.att + fixed.held + fixed.pct;
  let available = contentWidth(doc) - fixedSum;
  let dayWidth = available / dates.length;
  let nameWidth = fixed.name;
  if (dayWidth > 20) {
    // Kam din => din ki columns ko 20px par cap karo aur bacha hua space Name ko do
    // (warna 5 din ke liye table me aadha page khaali dikhta hai).
    const extra = available - 20 * dates.length;
    dayWidth = 20;
    nameWidth = Math.min(320, fixed.name + extra);
  }
  const columns = [
    { label: "S.No", width: fixed.sno },
    { label: "Name", width: nameWidth },
    { label: "Roll No", width: fixed.roll },
  ];
  dates.forEach((d) => columns.push({ label: istDayNumber(d), width: dayWidth, align: "center" }));
  columns.push({ label: "Att.", width: fixed.att, align: "center" });
  columns.push({ label: "Held", width: fixed.held, align: "center" });
  columns.push({ label: "%", width: fixed.pct, align: "center" });

  // Month strip: har month ka label uske days ke upar, ek hi baar.
  let runStart = 0;
  for (let i = 1; i <= dates.length; i++) {
    if (i === dates.length || istMonthShort(dates[i]) !== istMonthShort(dates[runStart])) {
      const x = PAGE_MARGIN + fixed.sno + nameWidth + fixed.roll + runStart * dayWidth;
      const w = (i - runStart) * dayWidth;
      doc.rect(x, y, w, 10).fill(PALETTE.light);
      doc.font(FONT).fontSize(5.6).fillColor(PALETTE.slate);
      doc.text(istMonthShort(dates[runStart]), x, y + 2, { width: w, align: "center", lineBreak: false });
      runStart = i;
    }
  }
  y += 11;

  const rowH = 13;
  const pctIndex = columns.length - 1;
  let top = y + drawTableHeader(doc, y, columns) + 1;
  rows.forEach((row, index) => {
    if (top + rowH > contentBottom(doc)) {
      doc.addPage();
      top = PAGE_MARGIN + drawTableHeader(doc, PAGE_MARGIN, columns) + 1;
    }
    const marks = Array.isArray(row.dayMarks) ? row.dayMarks : [];
    const colors = [];
    const cells = [index + 1, row.student_name || "-", row.roll_no || "-"];
    dates.forEach((d, i) => {
      const mark = String(marks[i] || "A").toUpperCase() === "P" ? "P" : "A";
      cells.push(mark);
      colors[3 + i] = mark === "P" ? PALETTE.green : PALETTE.red; // colour-coded P/A
    });
    cells.push(row.totalPresent, meta.classDays || 0, `${row.pct}%`);
    colors[pctIndex] = pctColor(row.pct);
    drawTableRow(doc, top, columns, cells, {
      bg: index % 2 === 1 ? PALETTE.zebra : PALETTE.white,
      height: rowH, fontSize: 6, colors,
    });
    top += rowH;
  });
  return top + 6;
}

// Long range (> 45 dates): summary table + colour-coded horizontal % bar
// (doc.rect() se, aur 75% par ek navy marker line jise student compare kar sake).
function drawOverallSummary(doc, y, meta, rows) {
  const widths = { sno: 34, name: 150, roll: 70, att: 95, held: 80, pct: 50 };
  const fixedSum = widths.sno + widths.name + widths.roll + widths.att + widths.held + widths.pct;
  const barColumn = contentWidth(doc) - fixedSum;
  const columns = [
    { label: "S.No", width: widths.sno },
    { label: "Name", width: widths.name },
    { label: "Roll No", width: widths.roll },
    { label: "Classes Attended", width: widths.att, align: "center" },
    { label: "Classes Held", width: widths.held, align: "center" },
    { label: "%", width: widths.pct, align: "center" },
    { label: "Attendance bar (navy tick = 75%)", width: barColumn },
  ];
  const rowH = 16;
  const barX = PAGE_MARGIN + fixedSum + 8;
  const barW = barColumn - 16;
  const colors = [];
  let top = y + drawTableHeader(doc, y, columns) + 1;
  rows.forEach((row, index) => {
    if (top + rowH > contentBottom(doc)) {
      doc.addPage();
      top = PAGE_MARGIN + drawTableHeader(doc, PAGE_MARGIN, columns) + 1;
    }
    const pct = num(row.pct) === null ? 0 : num(row.pct);
    colors[5] = pctColor(pct); // % column ka colour
    // 7th cell " " hai: bar yahan manually draw hoti hai, cell me text nahi chahiye.
    drawTableRow(doc, top, columns, [
      index + 1, row.student_name || "-", row.roll_no || "-",
      row.totalPresent, meta.classDays || 0, `${row.pct}%`, " ",
    ], { bg: index % 2 === 1 ? PALETTE.zebra : PALETTE.white, height: rowH, fontSize: 7, colors, blank: " " });

    const barY = top + rowH / 2 - 3.5;
    doc.rect(barX, barY, barW, 7).fill(PALETTE.light); // track
    doc.rect(barX, barY, Math.max(1, (Math.min(100, Math.max(0, pct)) / 100) * barW), 7).fill(colors[5]); // fill
    const markX = barX + 0.75 * barW; // 75% marker
    doc.moveTo(markX, barY - 2).lineTo(markX, barY + 9).lineWidth(0.6).strokeColor(PALETTE.navy).stroke();
    top += rowH;
  });
  return top + 6;
}

/**
 * meta: { class_name, subject, course_type, system, dates[YYYY-MM-DD oldest->newest],
 *         classDays, collegeName, generatedAt }
 * rows: [{ roll_no, student_name, dayMarks: ["P"|"A", ...], totalPresent, pct }]
 * dates.length <= 45 => day-by-day grid; warna summary table + % bars.
 * opts: { collegeName, generatedAt(ms), teacherName, title }
 */
function buildOverallReportPdfBuffer(meta, rows, opts) {
  const m = meta || {};
  const options = opts || {};
  const list = (Array.isArray(rows) ? rows.slice() : []).filter((r) => r && typeof r === "object");
  const dates = Array.isArray(m.dates) ? m.dates.map(String) : [];
  const optionsMs = num(options.generatedAt);
  const generatedAt = optionsMs === null ? (num(m.generatedAt) === null ? Date.now() : num(m.generatedAt)) : optionsMs;
  const stats = summarizeOverall(m, list);
  const useGrid = dates.length > 0 && dates.length <= GRID_MAX_DAYS;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      let y = drawHeaderBand(doc, {
        college: options.collegeName || m.collegeName,
        title: options.title || "Overall Attendance Report",
        sub: `Generated ${formatIstStamp(generatedAt)}${options.teacherName ? `   |   Teacher: ${options.teacherName}` : ""}`,
      });

      const range = dates.length ? `${dates[0]} to ${dates[dates.length - 1]} (${dates.length} day(s))` : "-";
      y = drawInfoStrip(doc, y, [
        ["Class", m.class_name], ["Subject", m.subject], ["Course type", m.course_type],
        ["System", m.system || "Annual"], ["Classes held", stats.classDays], ["Date range (IST)", range],
      ], 3);

      // KPI tiles: tone seedha 75% rule follow karta hai (red/amber/green).
      y = drawKpiTiles(doc, y, [
        { label: "Students", value: stats.students, tone: PALETTE.sky },
        { label: "Classes held", value: stats.classDays, tone: PALETTE.navy },
        { label: "Average attendance", value: `${stats.avgPct === null ? "0.0" : stats.avgPct}%`, tone: pctColor(stats.avgPct) },
        { label: "Below 75%", value: stats.below75, tone: stats.below75 > 0 ? PALETTE.red : PALETTE.green },
      ], 4);

      if (!list.length) {
        y = drawEmptyBox(doc, y, "No students to report for this class / subject / course type.");
      } else if (useGrid) {
        y = drawSectionTitle(doc, y, "Day-by-day register (P = present, A = absent)", `${dates.length} day(s), oldest to newest`);
        y = drawOverallGrid(doc, y, { dates, classDays: m.classDays }, list);
      } else {
        y = drawSectionTitle(doc, y, "Attendance summary", `${dates.length} day(s) in range | bar me navy tick = 75%`);
        y = drawOverallSummary(doc, y, m, list);
      }

      drawNoteBox(doc, y,
        `Percentage = classes attended / classes held (${stats.classDays}). Colour rule: 75%+ green, 60-74.9 amber, below 60 red. ` +
        "Pending marks count nahi hote jab tak teacher approve na kare. Kisi bhi doubt par teacher se verify karein.",
        { tone: stats.below75 > 0 ? PALETTE.red : PALETTE.green });

      stampPageFooters(doc, `Generated ${formatIstStamp(generatedAt)} | ${m.class_name || "-"} - ${m.subject || "-"} - ${m.course_type || "-"} (${m.system || "Annual"})`);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// 4) buildStudentReportPdfBuffer(meta, student, rows, opts) — A4 portrait
// ---------------------------------------------------------------------------
// Subject-wise table + har row me colour-coded % aur ek chhoti progress bar.
function drawStudentSubjectTable(doc, y, list) {
  const widths = { subject: 170, type: 50, attended: 60, held: 50, pct: 45 };
  const fixedSum = widths.subject + widths.type + widths.attended + widths.held + widths.pct;
  const barColumn = contentWidth(doc) - fixedSum; // 515 - 375 = 140
  const columns = [
    { label: "Subject", width: widths.subject },
    { label: "Type", width: widths.type },
    { label: "Attended", width: widths.attended, align: "center" },
    { label: "Held", width: widths.held, align: "center" },
    { label: "%", width: widths.pct, align: "center" },
    { label: "Progress (navy tick = 75%)", width: barColumn },
  ];
  const rowH = 18;
  const barX = PAGE_MARGIN + fixedSum + 8;
  const barW = barColumn - 16;
  const colors = [];
  let top = y + drawTableHeader(doc, y, columns) + 1;
  list.forEach((row, index) => {
    if (top + rowH > contentBottom(doc)) {
      doc.addPage();
      top = PAGE_MARGIN + drawTableHeader(doc, PAGE_MARGIN, columns) + 1;
    }
    const pct = num(row.pct) === null ? 0 : num(row.pct);
    colors[4] = pctColor(pct);
    // Aakhri cell " ": bar manual draw hoti hai.
    drawTableRow(doc, top, columns, [
      row.subject || "-", row.course_type || "-", num(row.attended) || 0, num(row.held) || 0, `${row.pct}%`, " ",
    ], { bg: index % 2 === 1 ? PALETTE.zebra : PALETTE.white, height: rowH, fontSize: 7.5, colors, blank: " " });

    const barY = top + rowH / 2 - 3.5;
    doc.rect(barX, barY, barW, 7).fill(PALETTE.light);
    doc.rect(barX, barY, Math.max(1, (Math.min(100, Math.max(0, pct)) / 100) * barW), 7).fill(colors[4]);
    const markX = barX + 0.75 * barW;
    doc.moveTo(markX, barY - 2).lineTo(markX, barY + 9).lineWidth(0.6).strokeColor(PALETTE.navy).stroke();
    top += rowH;
  });
  return top + 6;
}

/**
 * student: { roll_no, name, class_name, major_subject, email }
 * rows:    [{ subject, course_type, attended, held, pct }]
 * meta:    { class_name, subject, dates, collegeName, generatedAt } (optional)
 * opts:    { collegeName, generatedAt(ms), teacherName, title }
 * Overall % = total attended / total held (subject-wise rows ka sum) — isliye
 * alag-alag held wale subjects ka combined % bhi sahi nikalta hai (simple average nahi).
 */
function buildStudentReportPdfBuffer(meta, student, rows, opts) {
  const m = meta || {};
  const st = student || {};
  const options = opts || {};
  const list = (Array.isArray(rows) ? rows.slice() : []).filter((r) => r && typeof r === "object");
  const optionsMs = num(options.generatedAt);
  const generatedAt = optionsMs === null ? (num(m.generatedAt) === null ? Date.now() : num(m.generatedAt)) : optionsMs;
  const attended = list.reduce((sum, r) => sum + (num(r.attended) || 0), 0);
  const held = list.reduce((sum, r) => sum + (num(r.held) || 0), 0);
  const overall = held > 0 ? round1((attended / held) * 100) : 0;
  const tone = pctColor(overall);
  const dates = Array.isArray(m.dates) ? m.dates.map(String) : [];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      let y = drawHeaderBand(doc, {
        college: options.collegeName || m.collegeName,
        title: options.title || "Student Attendance Report",
        sub: `Generated ${formatIstStamp(generatedAt)}${options.teacherName ? `   |   Teacher: ${options.teacherName}` : ""}`,
      });

      // Student info card.
      y = drawInfoStrip(doc, y, [
        ["Student name", st.name], ["Roll no", st.roll_no], ["Class", st.class_name || m.class_name],
        ["Major subject", st.major_subject], ["Email", st.email],
        ["Report window", dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "All recorded sessions"],
      ], 3);

      // Big overall % + progress bar (75% marker ke saath).
      const cardH = 68;
      doc.roundedRect(PAGE_MARGIN, y, contentWidth(doc), cardH, 6).fillAndStroke(PALETTE.white, PALETTE.border);
      doc.font(FONT).fontSize(7).fillColor(PALETTE.slate);
      doc.text("OVERALL ATTENDANCE", PAGE_MARGIN + 14, y + 10, { lineBreak: false });
      doc.font(FONT_BOLD).fontSize(28).fillColor(tone);
      doc.text(`${overall}%`, PAGE_MARGIN + 14, y + 18, { lineBreak: false });
      doc.font(FONT).fontSize(8.5).fillColor(PALETTE.navy);
      doc.text(`${attended} of ${held} classes attended`, PAGE_MARGIN + 132, y + 22, { width: 180, lineBreak: false });
      doc.font(FONT).fontSize(7).fillColor(PALETTE.slate);
      doc.text("College rule: 75% ya usse zyada chahiye", PAGE_MARGIN + 132, y + 36, { width: 180, lineBreak: false });
      const barX = PAGE_MARGIN + 330;
      const barW = contentWidth(doc) - 344;
      doc.rect(barX, y + 30, barW, 9).fill(PALETTE.light);
      doc.rect(barX, y + 30, Math.max(1, (Math.min(100, overall) / 100) * barW), 9).fill(tone);
      doc.moveTo(barX + 0.75 * barW, y + 26).lineTo(barX + 0.75 * barW, y + 43)
        .lineWidth(0.8).strokeColor(PALETTE.navy).stroke();
      y += cardH + 14;

      // 75% se kam => red warning box (plain ASCII "!" marker, koi emoji nahi).
      if (overall < 75) {
        const shortBy = Math.max(0, Math.ceil(0.75 * held - attended));
        y = drawNoteBox(doc, y,
          `! Warning: attendance 75% se kam hai (${overall}%). Aur ${shortBy} class(es) attend karne par 75% ho jayega. ` +
          "Kam attendance par exam form / scholarship me dikkat aa sakti hai - teacher se milein.",
          { tone: PALETTE.red, bg: "#fef2f2", border: "#fecaca", textColor: "#991b1b" });
      }

      y = drawSectionTitle(doc, y, "Subject-wise attendance", `${list.length} subject(s)`);
      if (!list.length) {
        y = drawEmptyBox(doc, y, "No subject-wise attendance found for this student.");
      } else {
        y = drawStudentSubjectTable(doc, y, list);
      }

      drawNoteBox(doc, y,
        "How to read: % = classes attended / classes held us subject ke liye (sirf wahi din jab class hui). " +
        "Colour rule: 75%+ green, 60-74.9 amber, below 60 red. Pending marks teacher approve karne ke baad hi count hote hain.",
        { tone: PALETTE.sky, bg: PALETTE.light, border: PALETTE.border, textColor: PALETTE.navy });

      stampPageFooters(doc, `Generated ${formatIstStamp(generatedAt)} | ${st.name || "-"} (${st.roll_no || "-"}) | ${st.class_name || m.class_name || "-"}`);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// 5) buildReportEmailHtml(summary) — inline-styles-only HTML (Gmail/client safe)
// ---------------------------------------------------------------------------
const TONE_HEX = {
  green: PALETTE.green, amber: PALETTE.amber, red: PALETTE.red,
  sky: PALETTE.sky, navy: PALETTE.navy, slate: PALETTE.slate,
};
function toneHex(tone) {
  return TONE_HEX[String(tone || "").toLowerCase()] || PALETTE.navy;
}
// HTML escape — DB/user se aaya naam ya flag kabhi raw inject na ho (XSS se bachao).
function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Ek 2-column row (label left, value right) — analytics section ke liye.
function emailValueRow(label, value, index) {
  const top = index === 0 ? "none" : "1px solid #e2e8f0";
  return `<tr>
      <td style="padding:7px 14px;border-top:${top};font:13px Arial,Helvetica,sans-serif;color:${PALETTE.slate};">${escapeHtml(label)}</td>
      <td style="padding:7px 14px;border-top:${top};font:bold 13px Arial,Helvetica,sans-serif;color:${PALETTE.navy};text-align:right;">${escapeHtml(value)}</td>
    </tr>`;
}
// KPI chips row: tone colour se border + number (Gmail nested tables ko pasand karta hai).
function emailKpiChips(kpis) {
  if (!kpis.length) return "";
  const cells = kpis.map((chip) => {
    const tone = toneHex(chip.tone);
    return `<td style="padding:4px;" valign="top">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PALETTE.white};border:1px solid ${PALETTE.border};border-radius:8px;">
        <tr><td style="padding:10px 12px;border-left:4px solid ${tone};font-family:Arial,Helvetica,sans-serif;">
          <div style="font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:${PALETTE.slate};">${escapeHtml(chip.label)}</div>
          <div style="font-size:20px;font-weight:bold;color:${tone};">${escapeHtml(chip.value)}</div>
        </td></tr>
      </table>
    </td>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 14px;"><tr>${cells}</tr></table>`;
}
// Risk (flagged) rows table — red tint, taaki teacher ki nazar turant pahunche.
function emailRiskTable(riskRows) {
  if (!riskRows.length) {
    return `<div style="padding:10px 14px;background:#f8fafc;border:1px solid ${PALETTE.border};border-radius:8px;font:13px Arial,Helvetica,sans-serif;color:${PALETTE.slate};">No suspicious mark in this report.</div>`;
  }
  const head = `<div style="font:bold 11px Arial,Helvetica,sans-serif;letter-spacing:.5px;text-transform:uppercase;color:${PALETTE.red};margin:0 0 6px;">Needs a second look (flagged)</div>`;
  const rows = riskRows.map((row) => `<tr style="background:#fef2f2;">
      <td style="padding:6px 10px;border-top:1px solid #fecaca;font:13px Arial,Helvetica,sans-serif;color:${PALETTE.navy};">${escapeHtml(row.roll_no)}</td>
      <td style="padding:6px 10px;border-top:1px solid #fecaca;font:13px Arial,Helvetica,sans-serif;color:${PALETTE.navy};">${escapeHtml(row.name)}</td>
      <td style="padding:6px 10px;border-top:1px solid #fecaca;font:13px Arial,Helvetica,sans-serif;color:${PALETTE.red};">${escapeHtml(row.detail)}</td>
    </tr>`).join("");
  return `${head}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #fecaca;border-radius:8px;overflow:hidden;margin:0 0 14px;">
      <tr style="background:${PALETTE.red};">
        <th align="left" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Roll No</th>
        <th align="left" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Student</th>
        <th align="left" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Detail</th>
      </tr>${rows}</table>`;
}

/**
 * summary: { title, subtitle, collegeName, kpis:[{label,value,tone}],
 *            analyticsRows:[{label,value}], riskRows:[{roll_no,name,detail}],
 *            bottomRows:[{name,roll_no,pct}], footerNote, generatedAt }
 * Returns: HTML string — sirf inline styles (koi <style> block nahi, kyunki Gmail
 * usse strip kar deta hai), table-based layout, saara dynamic text escaped.
 */
function buildReportEmailHtml(summary) {
  const s = summary || {};
  const kpis = Array.isArray(s.kpis) ? s.kpis : [];
  const analytics = Array.isArray(s.analyticsRows) ? s.analyticsRows : [];
  const riskRows = Array.isArray(s.riskRows) ? s.riskRows : [];
  const bottomRows = Array.isArray(s.bottomRows) ? s.bottomRows : [];
  const generatedAt = num(s.generatedAt) === null ? Date.now() : num(s.generatedAt);
  const cellPad = `padding:6px 10px;border-top:1px solid ${PALETTE.border};font:13px Arial,Helvetica,sans-serif;color:${PALETTE.navy};`;

  // Analytics (label -> value) rows.
  const analyticsHtml = analytics.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${PALETTE.border};border-radius:8px;overflow:hidden;margin:0 0 14px;">${analytics
        .map((row, i) => emailValueRow(row.label, row.value, i)).join("")}</table>`
    : "";

  // Bottom rows: name / roll no / % (colour 75% rule se).
  const bottomHtml = bottomRows.length
    ? `<div style="font:bold 11px Arial,Helvetica,sans-serif;letter-spacing:.5px;text-transform:uppercase;color:${PALETTE.slate};margin:0 0 6px;">${escapeHtml(s.bottomTitle || "Students")}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${PALETTE.border};border-radius:8px;overflow:hidden;margin:0 0 14px;">
        <tr style="background:${PALETTE.navy};">
          <th align="left" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Name</th>
          <th align="left" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Roll No</th>
          <th align="right" style="padding:7px 10px;font:bold 11px Arial,Helvetica,sans-serif;color:${PALETTE.white};">Attendance</th>
        </tr>${bottomRows.map((row) => `<tr>
          <td style="${cellPad}">${escapeHtml(row.name)}</td>
          <td style="${cellPad}">${escapeHtml(row.roll_no)}</td>
          <td style="${cellPad}text-align:right;font-weight:bold;color:${pctColor(row.pct)};">${escapeHtml(row.pct)}${String(row.pct).includes("%") ? "" : "%"}</td>
        </tr>`).join("")}</table>`
    : "";

  // Chhota "how to read" note — colours ka matlab pehle hi bata dete hain.
  const howToRead = `<div style="padding:12px 14px;background:${PALETTE.light};border-left:4px solid ${PALETTE.sky};border-radius:6px;font:12px Arial,Helvetica,sans-serif;color:${PALETTE.navy};margin:0 0 14px;">
      <div style="font-weight:bold;margin:0 0 4px;">How to read this report</div>
      <div>1) Attendance % = classes attended / classes held (sirf wahi din jab class hui).</div>
      <div>2) Colour rule: 75%+ green, 60-74.9 amber, below 60 red.</div>
      <div>3) Pending marks count nahi hote jab tak teacher approve na kare; flagged marks review me jaate hain.</div>
    </div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.title || "Attendance Report")}</title></head>
<body style="margin:0;padding:0;background:${PALETTE.light};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PALETTE.light};padding:22px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;background:${PALETTE.white};border:1px solid ${PALETTE.border};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${PALETTE.navy};padding:18px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td align="left" style="font:bold 16px Arial,Helvetica,sans-serif;color:${PALETTE.white};">${escapeHtml(s.collegeName || "College")}</td>
            <td align="right" style="font:bold 12px Arial,Helvetica,sans-serif;color:#7dd3fc;">${escapeHtml(s.title || "Attendance Report")}</td>
          </tr></table>
          <div style="font:12px Arial,Helvetica,sans-serif;color:#cbd5e1;padding-top:5px;">${escapeHtml(s.subtitle || "")}</div>
        </td></tr>
        <tr><td style="padding:16px 14px 4px;">
          ${emailKpiChips(kpis)}
          ${analyticsHtml}
          ${emailRiskTable(riskRows)}
          ${bottomHtml}
          ${howToRead}
          <div style="font:12px Arial,Helvetica,sans-serif;color:${PALETTE.slate};padding:0 2px 6px;">${escapeHtml(s.footerNote || "")}</div>
          <div style="font:11px Arial,Helvetica,sans-serif;color:${PALETTE.slate};border-top:1px solid ${PALETTE.border};padding:10px 2px 4px;">Generated ${escapeHtml(formatIstStamp(generatedAt))} | College Attendance System</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// EXPORTS — server.js inhi exact naam se wire karega (naam kabhi na badlein).
// ---------------------------------------------------------------------------
module.exports = {
  computeSessionAnalytics, // (records, opts) -> analytics object
  buildSessionPdfBuffer, // (session, records, opts) -> Promise<Buffer>   A4 portrait
  buildOverallReportPdfBuffer, // (meta, rows, opts) -> Promise<Buffer>       A4 landscape
  buildStudentReportPdfBuffer, // (meta, student, rows, opts) -> Promise<Buffer> A4 portrait
  buildReportEmailHtml, // (summary) -> HTML string
  // Chhote helpers jo smoke test / diagnostics me kaam aate hain:
  formatIstTime, // (ms) -> "HH:MM"
  formatIstDate, // (ms) -> "YYYY-MM-DD"
  formatIstStamp, // (ms) -> "YYYY-MM-DD HH:MM IST"
};
