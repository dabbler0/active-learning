/**
 * Raw PDF 1.4 byte-stream writer.
 *
 * Design
 * ──────
 * • All content is accumulated as JavaScript strings (ASCII-safe).
 * • Text strings are encoded via toWinAnsiLiteral() which converts
 *   Unicode → WinAnsiEncoding bytes written as octal escapes where needed,
 *   so the final PDF is entirely ASCII and TextEncoder(UTF-8) is safe.
 * • The six standard Type 1 fonts (Times-Roman, Times-Bold, etc.) are
 *   referenced without embedding — every PDF viewer supplies them.
 * • Coordinates: callers supply (x, y) in "page-top-left" space
 *   (y increases downward). The writer flips to PDF space internally.
 *
 * Usage
 * ─────
 *   const w = new PdfWriter();
 *   const p = w.addPage(612, 792);
 *   p.text('Hello', 90, 108, 'R', 11);
 *   p.line(90, 760, 522, 760, 0.5);
 *   const bytes = w.generate();
 */

import { FONT_NAMES } from './fonts.js';

// ── WinAnsiEncoding map: Unicode → byte value ─────────────────────────────

const TO_WINANSI = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93],
  [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);

/** Convert a Unicode char to a WinAnsi byte value (or 63 = '?' if unknown). */
function unicodeToWinAnsi(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7E) return cp;          // printable ASCII
  if (cp >= 0xA0 && cp <= 0xFF) return cp;          // Latin-1 Supplement
  return TO_WINANSI.get(cp) ?? 63;                  // '?' for unknowns
}

/**
 * Encode a string as a PDF literal string `(...)`.
 * Non-ASCII bytes are written as octal escapes so the output is pure ASCII.
 */
function toWinAnsiLiteral(text) {
  let out = '(';
  for (const ch of text) {
    const b = unicodeToWinAnsi(ch);
    if      (b === 0x28) out += '\\(';               // (
    else if (b === 0x29) out += '\\)';               // )
    else if (b === 0x5C) out += '\\\\';              // \
    else if (b >= 0x20 && b <= 0x7E) out += ch;     // plain ASCII
    else out += '\\' + b.toString(8).padStart(3,'0'); // \ddd octal
  }
  return out + ')';
}

// ── Page content builder ──────────────────────────────────────────────────

class PageStream {
  constructor(width, height) {
    this.width  = width;
    this.height = height;
    this._cmds  = [];       // PDF operator strings
    this._curFont = null;
    this._curSize = null;
    this._inText  = false;
  }

  /** Open a BT block (lazy). */
  _beginText() {
    if (!this._inText) { this._cmds.push('BT'); this._inText = true; }
  }

  /** Close BT block if open. */
  _endText() {
    if (this._inText) { this._cmds.push('ET'); this._inText = false; }
    this._curFont = null;
    this._curSize = null;
  }

  /** Set font (emits Tf only when changed). */
  _setFont(fontKey, size) {
    if (fontKey !== this._curFont || size !== this._curSize) {
      this._cmds.push(`/F${fontKey} ${size} Tf`);
      this._curFont = fontKey;
      this._curSize = size;
    }
  }

  /**
   * Draw text at page-top-left coords (x right, y down from page top).
   * @param {string} text
   * @param {number} x
   * @param {number} y  baseline in page-top coords
   * @param {string} fontKey
   * @param {number} size
   */
  text(text, x, y, fontKey, size) {
    if (!text) return;
    this._beginText();
    this._setFont(fontKey, size);
    const pdfX = x;
    const pdfY = this.height - y;  // flip y axis
    this._cmds.push(`${fmt(pdfX)} ${fmt(pdfY)} Td`);
    this._cmds.push(`${toWinAnsiLiteral(text)} Tj`);
    // Reset Td to origin after each text piece (simplest approach)
    this._cmds.push(`${fmt(-pdfX)} ${fmt(-pdfY)} Td`);
  }

  /**
   * Draw a horizontal or diagonal rule.
   * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
   * @param {number} lineWidth
   */
  line(x1, y1, x2, y2, lineWidth = 0.5) {
    this._endText();
    const py1 = this.height - y1;
    const py2 = this.height - y2;
    this._cmds.push(
      `${fmt(lineWidth)} w`,
      `${fmt(x1)} ${fmt(py1)} m`,
      `${fmt(x2)} ${fmt(py2)} l`,
      'S',
    );
  }

  /** Produce the PDF content stream string. */
  content() {
    this._endText();
    return this._cmds.join('\n');
  }
}

/** Format a number for PDF (max 3 decimal places, no trailing zeros). */
function fmt(n) {
  return parseFloat(n.toFixed(3)).toString();
}

// ── PDF Writer ────────────────────────────────────────────────────────────

export class PdfWriter {
  constructor() {
    this._objs    = [];    // object bodies indexed by (objNum - 1)
    this._pages   = [];    // PageStream instances
    this._pageObjNums = [];
  }

  /**
   * Add a new page and return its PageStream for drawing.
   * @param {number} width   points
   * @param {number} height  points
   */
  addPage(width, height) {
    const ps = new PageStream(width, height);
    this._pages.push({ ps, width, height });
    return ps;
  }

  /**
   * Generate the complete PDF and return it as a Uint8Array.
   */
  generate() {
    const chunks = [];
    let pos = 0;
    const offsets = [];   // offsets[objNum] = byte offset

    function write(s) {
      chunks.push(s);
      pos += s.length;
    }

    // Header
    write('%PDF-1.4\n');

    // Font objects (one per unique font key, starting at obj 1)
    const fontKeys = Object.keys(FONT_NAMES); // R, B, I, BI, H, HB
    const fontObjNums = {};
    fontKeys.forEach((key, i) => {
      const objNum = i + 1;
      fontObjNums[key] = objNum;
      offsets[objNum] = pos;
      write(`${objNum} 0 obj\n`);
      write(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[key]} /Encoding /WinAnsiEncoding >>\n`);
      write('endobj\n');
    });

    const fontCount = fontKeys.length; // 6

    // Pages dictionary (obj 7) — we'll patch /Kids and /Count after
    // We don't know page obj nums yet, so build after pages.
    // Strategy: pages dict = obj (fontCount+1), each page = obj (fontCount+2+2*i)
    //           each content stream = obj (fontCount+3+2*i)

    const pagesDictNum = fontCount + 1;
    const pageObjBase  = fontCount + 2; // first page obj num

    // Build page objects and content streams
    const pageContentObjs = [];
    const pageObjNums = [];
    this._pages.forEach(({ ps, width, height }, i) => {
      const contentNum = pageObjBase + i * 2;
      const pageNum    = pageObjBase + i * 2 + 1;
      pageObjNums.push(pageNum);

      // Content stream
      const content = ps.content();
      offsets[contentNum] = pos;
      write(`${contentNum} 0 obj\n`);
      write(`<< /Length ${content.length} >>\n`);
      write('stream\n');
      write(content);
      write('\nendstream\n');
      write('endobj\n');

      // Font refs dict
      const fontRefs = fontKeys
        .map(k => `/F${k} ${fontObjNums[k]} 0 R`)
        .join(' ');

      offsets[pageNum] = pos;
      write(`${pageNum} 0 obj\n`);
      write(`<< /Type /Page /Parent ${pagesDictNum} 0 R `);
      write(`/MediaBox [0 0 ${width} ${height}] `);
      write(`/Contents ${contentNum} 0 R `);
      write(`/Resources << /Font << ${fontRefs} >> >> >>\n`);
      write('endobj\n');
    });

    // Pages dictionary
    const kids  = pageObjNums.map(n => `${n} 0 R`).join(' ');
    offsets[pagesDictNum] = pos;
    write(`${pagesDictNum} 0 obj\n`);
    write(`<< /Type /Pages /Kids [${kids}] /Count ${this._pages.length} >>\n`);
    write('endobj\n');

    // Catalog (last obj)
    const catalogNum = pagesDictNum + this._pages.length * 2 + 1;
    offsets[catalogNum] = pos;
    write(`${catalogNum} 0 obj\n`);
    write(`<< /Type /Catalog /Pages ${pagesDictNum} 0 R >>\n`);
    write('endobj\n');

    // Cross-reference table
    const xrefPos = pos;
    const maxObj  = catalogNum;
    write(`xref\n0 ${maxObj + 1}\n`);
    write('0000000000 65535 f \n');
    for (let n = 1; n <= maxObj; n++) {
      const off = offsets[n] ?? 0;
      write(off.toString().padStart(10, '0') + ' 00000 n \n');
    }

    // Trailer
    write(`trailer\n<< /Size ${maxObj + 1} /Root ${catalogNum} 0 R >>\n`);
    write(`startxref\n${xrefPos}\n%%EOF\n`);

    // Combine and encode as UTF-8 (safe because all content is ASCII)
    const full = chunks.join('');
    return new TextEncoder().encode(full);
  }
}
