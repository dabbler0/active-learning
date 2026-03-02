/**
 * Font metrics for the six standard PDF Type 1 fonts used by the typesetter.
 *
 * All widths are in 1/1000 of an em (the PDF standard unit).
 * To get the width in points: (width / 1000) * fontSize.
 *
 * Font keys: 'R' Times-Roman, 'B' Times-Bold,
 *            'I' Times-Italic, 'BI' Times-BoldItalic,
 *            'H' Helvetica,    'HB' Helvetica-Bold
 */

// ── Width tables: indices are (codePoint - 32) for chars 0x20–0x7E ─────────
// prettier-ignore
const W_R = [ // Times-Roman
  250,333,408,500,500,833,778,333,333,333,500,564,250,333,250,278, // 32-47
  500,500,500,500,500,500,500,500,500,500,                         // 48-57
  278,278,564,564,564,444,921,                                     // 58-64
  722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,
  722,667,556,611,722,722,944,722,722,611,                         // 65-90
  333,278,333,469,500,333,                                         // 91-96
  444,500,444,500,444,278,500,500,278,278,500,278,778,500,500,500,
  500,333,389,278,500,500,722,500,500,444,                         // 97-122
  480,200,480,541,                                                  // 123-126
];
// prettier-ignore
const W_B = [ // Times-Bold
  250,333,555,500,500,1000,833,333,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,
  333,333,570,570,570,500,930,
  722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,
  778,722,556,667,722,722,1000,722,722,667,
  333,278,333,581,500,333,
  500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,
  556,444,389,333,556,500,722,556,500,444,
  394,220,394,520,
];
// prettier-ignore
const W_I = [ // Times-Italic
  250,333,420,500,500,833,778,333,333,333,500,675,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,
  333,333,675,675,675,500,920,
  611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,
  722,611,500,556,722,611,833,611,556,556,
  389,278,389,422,500,333,
  444,500,444,500,444,278,500,500,278,278,444,278,722,500,500,500,
  500,389,389,278,500,444,667,444,444,389,
  400,275,400,541,
];
// prettier-ignore
const W_BI = [ // Times-BoldItalic
  250,389,555,500,500,833,778,333,333,333,500,570,250,333,250,278,
  500,500,500,500,500,500,500,500,500,500,
  333,333,570,570,570,500,832,
  667,667,667,722,667,667,722,778,389,500,667,611,889,722,722,611,
  722,667,556,611,722,667,889,667,611,611,
  333,278,333,570,500,333,
  500,500,444,500,444,333,500,556,278,278,500,278,778,556,500,500,
  500,389,389,278,556,444,667,500,444,389,
  348,220,348,570,
];
// prettier-ignore
const W_H = [ // Helvetica
  278,278,355,556,556,889,667,222,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,
  278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,
  778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,222,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,
  556,333,500,278,556,500,722,500,500,500,
  334,260,334,584,
];
// prettier-ignore
const W_HB = [ // Helvetica-Bold
  278,333,474,556,556,889,722,278,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,
  333,333,584,584,584,611,975,
  722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,
  778,722,667,611,722,667,944,667,667,611,
  333,278,333,584,556,278,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,
  611,389,556,333,611,556,778,556,556,500,
  389,280,389,584,
];

const TABLES = { R: W_R, B: W_B, I: W_I, BI: W_BI, H: W_H, HB: W_HB };

// Extended Unicode characters common in typeset text → WinAnsi byte values
// WinAnsi byte → approximate width per font
const EXTENDED_WIDTHS = {
  0x2013: { R:500, B:500, I:500, BI:500, H:556, HB:556 }, // en-dash
  0x2014: { R:1000,B:1000,I:1000,BI:1000,H:1000,HB:1000 }, // em-dash
  0x2018: { R:333, B:333, I:333, BI:333, H:222, HB:278 }, // '
  0x2019: { R:333, B:333, I:333, BI:333, H:222, HB:278 }, // '
  0x201C: { R:444, B:500, I:444, BI:500, H:333, HB:333 }, // "
  0x201D: { R:444, B:500, I:444, BI:500, H:333, HB:333 }, // "
  0x2026: { R:1000,B:1000,I:1000,BI:1000,H:1000,HB:1000 }, // …
  0x00A0: { R:250, B:250, I:250, BI:250, H:278, HB:278 }, // NBSP
  0x00E9: { R:444, B:444, I:444, BI:444, H:556, HB:556 }, // é
  0x00E8: { R:444, B:444, I:444, BI:444, H:556, HB:556 }, // è
  0x00EA: { R:444, B:444, I:444, BI:444, H:556, HB:556 }, // ê
  0x00E0: { R:444, B:500, I:444, BI:500, H:556, HB:556 }, // à
  0x00E2: { R:444, B:500, I:444, BI:500, H:556, HB:556 }, // â
  0x00FC: { R:500, B:556, I:500, BI:556, H:556, HB:611 }, // ü
  0x00F6: { R:500, B:500, I:500, BI:500, H:556, HB:611 }, // ö
  0x00E4: { R:444, B:500, I:444, BI:500, H:556, HB:556 }, // ä
  0x00DF: { R:500, B:556, I:500, BI:500, H:611, HB:611 }, // ß
};

/**
 * Width of a single character in 1000-unit font space.
 * @param {string} ch   single character
 * @param {string} font 'R'|'B'|'I'|'BI'|'H'|'HB'
 */
export function charWidth(ch, font) {
  const cp = ch.codePointAt(0);
  if (cp >= 32 && cp <= 126) {
    return (TABLES[font] ?? W_R)[cp - 32] ?? 500;
  }
  const ext = EXTENDED_WIDTHS[cp];
  if (ext) return ext[font] ?? ext.R ?? 500;
  return 500; // fallback
}

/**
 * Width of a string in points.
 * @param {string} text
 * @param {string} font
 * @param {number} size  font size in points
 */
export function measureText(text, font, size) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, font);
  return (w / 1000) * size;
}

/**
 * Decompose text into small-caps runs.
 * Lowercase letters → uppercase glyph at scRatio * size.
 * Other chars → original glyph at full size.
 * @returns {{ text:string, font:string, size:number }[]}
 */
export function smallCapsRuns(text, font, size, scRatio = 0.8) {
  const runs = [];
  let cur = null;
  for (const ch of text) {
    const lower = ch >= 'a' && ch <= 'z';
    const glyph = lower ? ch.toUpperCase() : ch;
    const sz    = lower ? size * scRatio : size;
    if (!cur || cur.size !== sz) {
      cur = { text: glyph, font, size: sz };
      runs.push(cur);
    } else {
      cur.text += glyph;
    }
  }
  return runs.length ? runs : [{ text, font, size }];
}

/** Measure width of small-caps text in points. */
export function measureSmallCaps(text, font, size, scRatio = 0.8) {
  return smallCapsRuns(text, font, size, scRatio)
    .reduce((acc, r) => acc + measureText(r.text, r.font, r.size), 0);
}

/** PDF font resource names keyed by our shorthand. */
export const FONT_NAMES = {
  R:  'Times-Roman',
  B:  'Times-Bold',
  I:  'Times-Italic',
  BI: 'Times-BoldItalic',
  H:  'Helvetica',
  HB: 'Helvetica-Bold',
};
