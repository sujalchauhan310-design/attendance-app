// TEMP debug (deleted at the end of the session): pdfkit text auto-page-break check.
const PDFDocument = require("pdfkit");
function probe(y, lineBreak) {
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  doc.text("x", 40, y, { width: 300, lineBreak });
  console.log(`y=${y} lineBreak=${lineBreak} pages=${doc.bufferedPageRange().count}`);
  doc.end();
}
[801.89, 795, 790, 785, 780, 770].forEach((y) => probe(y, false));
probe(801.89, true);
