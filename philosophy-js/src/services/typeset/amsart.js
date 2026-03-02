/**
 * amsart layout configuration.
 *
 * Mimics the LaTeX \amsart document class:
 *  • Centered bold small-caps article title
 *  • Centered bold small-caps section (h1) headings
 *  • Bold run-in subsection (h2) headings (inline with first paragraph)
 *  • Italic run-in sub-subsection (h3) headings
 *  • Page-number footer on every page
 *  • Running title header on pages 2+ (alternating alignment)
 *  • Hanging-indent bibliography
 *  • Footnotes collected at bottom of each page with thin separator rule
 *
 * All dimensions in points (72 pt = 1 inch).
 * Page: US Letter 8.5 × 11 in = 612 × 792 pt.
 */

export const AMSART = {
  // ── Page geometry ───────────────────────────────────────────────────────
  pageWidth:       612,
  pageHeight:      792,
  marginTop:       108,   // 1.5 in — leaves room for running header
  marginBottom:    90,    // 1.25 in
  marginLeft:      90,    // 1.25 in
  marginRight:     90,    // 1.25 in

  // ── Body typography ─────────────────────────────────────────────────────
  bodyFont:        'R',
  boldFont:        'B',
  italicFont:      'I',
  boldItalicFont:  'BI',
  fontSize:        11,
  leading:         16.5,  // 11 × 1.5

  // ── Paragraph spacing ───────────────────────────────────────────────────
  paraIndent:      18,    // ~0.25 in first-line indent
  paraSpacing:     0,     // no extra inter-paragraph space (LaTeX \amsart default)
  blockQuoteIndent:24,

  // ── Heading styles ──────────────────────────────────────────────────────
  // headings[0] = article title, headings[1..3] = h1..h3
  headings: {
    0: {  // Article title
      font:        'B',
      size:        17,
      align:       'center',
      smallCaps:   true,
      inline:      false,
      spaceBefore: 0,
      spaceAfter:  10,
    },
    1: {  // Section  \section{}
      font:        'B',
      size:        11,
      align:       'center',
      smallCaps:   true,
      inline:      false,
      spaceBefore: 20,
      spaceAfter:  6,
    },
    2: {  // Subsection  \subsection{}  — run-in bold
      font:        'B',
      size:        11,
      align:       'left',
      smallCaps:   false,
      inline:      true,
      spaceBefore: 12,
      spaceAfter:  0,
    },
    3: {  // Sub-subsection  \subsubsection{}  — run-in italic
      font:        'I',
      size:        11,
      align:       'left',
      smallCaps:   false,
      inline:      true,
      spaceBefore: 8,
      spaceAfter:  0,
    },
  },

  // ── Small-caps ratio ─────────────────────────────────────────────────────
  scRatio:         0.8,   // lowercase → uppercase at 80% of heading size

  // ── Bibliography ─────────────────────────────────────────────────────────
  bibHangingIndent:  24,  // hanging indent for wrapped lines

  // ── Header / footer ──────────────────────────────────────────────────────
  headerFont:      'I',
  headerSize:      9,
  footerSize:      9,

  // ── Footnotes ─────────────────────────────────────────────────────────────
  footnoteSize:      9,
  footnoteLead:     12,
  footnoteSepLength: 72,  // 1-inch rule
  footnoteIndent:   12,   // indent for wrapped footnote lines
};

/**
 * Catalogue of available layouts for the UI dropdown.
 * Add more configs here to expose them as options.
 */
export const LAYOUTS = [
  { id: 'amsart', label: 'AMSart (LaTeX-style)', config: AMSART },
];
