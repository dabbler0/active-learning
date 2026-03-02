/**
 * Layout engine — converts a document model into placed elements ready for
 * the PDF writer.
 *
 * Coordinate system: origin at page top-left, y increases downward.
 * The PDF writer flips y when drawing.
 *
 * Layout config shape (see amsart.js for an example):
 * {
 *   pageWidth, pageHeight,
 *   marginTop, marginBottom, marginLeft, marginRight,
 *   bodyFont, boldFont, italicFont, boldItalicFont,  // 'R'|'B'|'I'|'BI'
 *   fontSize, leading,          // pt; leading = full line height (pt)
 *   paraIndent,                 // first-line indent (pt)
 *   paraSpacing,                // extra space between paragraphs (pt)
 *   blockQuoteIndent,           // left indent for blockquotes (pt)
 *   headings: {
 *     1: { font, size, align, smallCaps, spaceBefore, spaceAfter, inline },
 *     2: { ... inline:true  → run-in bold heading style },
 *     3: { ... inline:true  },
 *   },
 *   bibHangingIndent,           // pt
 *   footerSize,                 // pt  (for page number)
 *   headerSize,                 // pt  (for running title)
 *   headerFont,                 // 'R'|'I'|...
 *   footnoteSize,               // pt
 *   footnoteLead,               // leading for footnote lines (pt)
 *   footnoteSepLength,          // length of the rule above footnotes (pt)
 *   footnoteIndent,             // hanging indent for fn entries (pt)
 *   scRatio,                    // small-caps scale ratio (default 0.8)
 * }
 */

import { measureText, measureSmallCaps, smallCapsRuns, charWidth } from './fonts.js';
import { PdfWriter } from './pdf.js';

// ── Inline span rendering helpers ──────────────────────────────────────────

/**
 * Map an Inline node to { font, size } given the current context fonts.
 */
function spanFont(inline, cfg, contextFont) {
  const base = contextFont ?? cfg.bodyFont;
  switch (inline.type) {
    case 'em':       return base === cfg.boldFont ? cfg.boldItalicFont : cfg.italicFont;
    case 'strong':   return base === cfg.italicFont ? cfg.boldItalicFont : cfg.boldFont;
    case 'em-strong':return cfg.boldItalicFont;
    case 'code':     return 'H';   // Helvetica for code
    default:         return base;
  }
}

function spanSize(inline, cfg) {
  return inline.type === 'code' ? cfg.fontSize * 0.9 : cfg.fontSize;
}

// ── Word / token splitting ─────────────────────────────────────────────────

/**
 * Break a list of Inline nodes into "tokens" — the smallest units that can
 * be placed on a line. Each token has { text, font, size, breakable, fnData }.
 * cite inlines become fn-ref tokens (superscript digit) + register footnote.
 */
function inlinesToTokens(inlines, cfg, fnState, contextFont) {
  const tokens = [];

  function pushWords(text, font, size) {
    // Split on spaces, keeping them attached to the preceding word.
    const parts = text.split(/(\s+)/);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const isSpace = /^\s+$/.test(p);
      if (isSpace) {
        // Add a "space" breakable token — width is one space width
        const spW = (charWidth(' ', font) / 1000) * size;
        tokens.push({ text: ' ', font, size, width: spW, breakable: true, space: true });
      } else {
        const w = measureText(p, font, size);
        tokens.push({ text: p, font, size, width: w, breakable: false, space: false });
      }
    }
  }

  for (const il of inlines) {
    if (il.type === 'hardbreak') {
      tokens.push({ hardbreak: true });
      continue;
    }
    if (il.type === 'cite') {
      // Assign a footnote number and create a superscript token
      const n = ++fnState.counter;
      fnState.entries.push({ n, key: il.key, locator: il.locator });
      const sup = String(n);
      const supFont = cfg.bodyFont;
      const supSize = cfg.fontSize * 0.65;
      const w = measureText(sup, supFont, supSize);
      tokens.push({ text: sup, font: supFont, size: supSize, width: w,
                    breakable: false, space: false, fnNum: n, superscript: true });
      continue;
    }
    if (il.type === 'superscript') {
      const supSize = cfg.fontSize * 0.65;
      pushWords(il.text, cfg.bodyFont, supSize);
      continue;
    }

    const font = spanFont(il, cfg, contextFont);
    const size = spanSize(il, cfg);
    const text = il.text ?? '';

    if (il.type === 'code') {
      tokens.push({ text, font, size, width: measureText(text, font, size),
                    breakable: false, space: false });
    } else {
      pushWords(text, font, size);
    }
  }

  return tokens;
}

// ── Line breaker ───────────────────────────────────────────────────────────

/**
 * Break tokens into lines within a given column width.
 *
 * @param {object[]} tokens
 * @param {number}   colWidth     available width in pts
 * @param {number}   firstIndent  extra left indentation for the first line
 * @param {number}   hangIndent   extra left indentation for subsequent lines (negative = hanging)
 * @param {number}   leading      line height in pts
 * @returns {{ spans, height, fnNums }[]}
 *   spans: [{x, text, font, size, superscript?}], height, fnNums (footnote numbers on this line)
 */
function breakIntoLines(tokens, colWidth, firstIndent, hangIndent, leading) {
  const lines = [];
  let lineTokens = [];
  let lineWidth  = 0;
  let curIndent  = firstIndent;
  let avail      = colWidth - curIndent;

  function flushLine(hard = false) {
    // Trim trailing spaces
    while (lineTokens.length && lineTokens[lineTokens.length - 1].space) {
      lineWidth -= lineTokens.pop().width;
    }
    if (!lineTokens.length && !hard) return;

    // Build spans with x positions
    let x = curIndent;
    const spans = [];
    const fnNums = [];
    for (const tok of lineTokens) {
      if (tok.space) {
        x += tok.width;
      } else {
        spans.push({ x, text: tok.text, font: tok.font, size: tok.size,
                     superscript: tok.superscript ?? false });
        if (tok.fnNum != null) fnNums.push(tok.fnNum);
        x += tok.width;
      }
    }
    lines.push({ spans, height: leading, fnNums });

    // Prepare next line
    lineTokens = [];
    lineWidth  = 0;
    curIndent  = hangIndent;
    avail      = colWidth - hangIndent;
  }

  for (const tok of tokens) {
    if (tok.hardbreak) {
      flushLine(true);
      continue;
    }
    // Leading space at start of line: skip
    if (tok.space && lineTokens.length === 0) continue;

    if (!tok.space && lineWidth + tok.width > avail + 0.01 && lineTokens.length > 0) {
      // Word doesn't fit → flush and start new line
      flushLine();
    }
    lineTokens.push(tok);
    lineWidth += tok.width;
  }
  flushLine(true);

  return lines;
}

// ── Small-caps line renderer ───────────────────────────────────────────────

/**
 * For a small-caps heading text, produce spans with mixed sizes.
 * @returns {number} total width
 */
function smallCapsSpans(text, font, size, startX, scRatio) {
  const runs = smallCapsRuns(text, font, size, scRatio);
  const spans = [];
  let x = startX;
  for (const r of runs) {
    spans.push({ x, text: r.text, font: r.font, size: r.size, superscript: false });
    x += measureText(r.text, r.font, r.size);
  }
  return spans;
}

// ── Footnote height calculator ─────────────────────────────────────────────

/**
 * Estimate the height (pts) of a footnote entry given its text.
 * @param {string} entryText  formatted citation string (plain text approx)
 * @param {object} cfg
 */
function footnoteEntryHeight(entryText, cfg) {
  const colW  = cfg.pageWidth - cfg.marginLeft - cfg.marginRight - cfg.footnoteIndent;
  const words = entryText.split(/\s+/).filter(Boolean);
  let lineW = 0;
  let lines = 1;
  for (const w of words) {
    const ww = measureText(w + ' ', cfg.bodyFont, cfg.footnoteSize);
    if (lineW + ww > colW && lineW > 0) { lines++; lineW = ww; }
    else lineW += ww;
  }
  return lines * cfg.footnoteLead;
}

// ── Citation formatter (plain text for footnote / bib) ────────────────────

function shortAuthorText(c) {
  const authors = c?.authors ?? [];
  if (!authors.length) return c?.title?.slice(0, 20) ?? '?';
  const first = authors[0].split(',')[0].trim();
  return authors.length > 1 ? first + ' et al.' : first;
}

function formatFootnoteText(citation, style) {
  if (!citation) return '(unknown reference)';
  const authors = (citation.authors ?? []).join(', ') || 'Unknown';
  const year    = citation.year ? `(${citation.year})` : '(n.d.)';
  const title   = citation.title ?? '(no title)';
  return `${authors} ${year}. ${title}.`;
}

// ── Page state ─────────────────────────────────────────────────────────────

function makePageState(cfg) {
  const textHeight = cfg.pageHeight - cfg.marginTop - cfg.marginBottom
                     - cfg.footerSize * 2;  // rough footer clearance
  return {
    // baseline of the next line to be placed (top-left coords, y down)
    curY:        cfg.marginTop + cfg.leading,
    fnEntries:   [],      // { n, text } footnote entries for this page
    fnHeight:    0,       // total height reserved for footnotes on this page
    textBottom:  cfg.pageHeight - cfg.marginBottom - cfg.footerSize * 2,
  };
}

function availBottom(state, cfg) {
  const sep = state.fnEntries.length > 0
    ? cfg.footnoteSepLength > 0 ? cfg.leading : 0
    : 0;
  return state.textBottom - state.fnHeight - sep;
}

// ── Main layout engine ─────────────────────────────────────────────────────

/**
 * Layout a document into pages.
 *
 * @param {{
 *   title: string,
 *   author: string,
 *   date: string,
 *   blocks: Block[],
 *   citedKeys: string[],
 *   citationMap: Map,
 *   citationStyle: string,
 * }} doc
 * @param {object} cfg  layout configuration (see amsart.js)
 * @returns {PdfWriter}
 */
export function layout(doc, cfg) {
  const writer   = new PdfWriter();
  const colW     = cfg.pageWidth - cfg.marginLeft - cfg.marginRight;
  const fnState  = { counter: 0, entries: [] };   // global footnote counter

  // Per-footnote-number, look up the formatted footnote text
  function fnTextFor(entry) {
    const c = doc.citationMap.get(entry.key);
    const text = formatFootnoteText(c, doc.citationStyle);
    return entry.locator ? `${text} [${entry.locator}]` : text;
  }

  // Track pages
  const pages  = [];
  let   curPage = null;
  let   state   = null;
  let   pageNum = 0;

  function newPage() {
    const ps = writer.addPage(cfg.pageWidth, cfg.pageHeight);
    curPage  = ps;
    state    = makePageState(cfg);
    pageNum++;
    pages.push({ ps, num: pageNum, title: doc.title });
  }

  // ── Place a single rendered line onto the current (or next) page ──────

  function placeLine(line, fnEntries) {
    // How much footnote height will this line add?
    const extraFnH = fnEntries.reduce((sum, entry) => {
      return sum + footnoteEntryHeight(fnTextFor(entry), cfg) + cfg.footnoteLead * 0.3;
    }, 0);
    const sepH = (state.fnEntries.length === 0 && fnEntries.length > 0) ? cfg.leading : 0;

    const needed = line.height + extraFnH + sepH;
    if (state.curY + needed > availBottom(state, cfg) + 0.01) {
      flushPage();
      newPage();
    }

    // Place the spans of this line
    const baseline = state.curY;
    for (const sp of line.spans) {
      // Superscript: shift baseline upward (y decreases toward top)
      const y = sp.superscript ? baseline - cfg.fontSize * 0.35 : baseline;
      curPage.text(sp.text, cfg.marginLeft + sp.x, y, sp.font, sp.size);
    }
    state.curY += line.height;

    // Register footnotes triggered by this line
    for (const entry of fnEntries) {
      state.fnEntries.push({ n: entry.n, text: fnTextFor(entry) });
      state.fnHeight += footnoteEntryHeight(fnTextFor(entry), cfg) + cfg.footnoteLead * 0.3;
    }
  }

  // ── Flush footnotes, header, footer onto the current page ─────────────

  function flushPage() {
    if (!curPage) return;
    const ps  = curPage;
    const pn  = pageNum;
    const w   = cfg.pageWidth;
    const h   = cfg.pageHeight;
    const ml  = cfg.marginLeft;
    const mr  = cfg.marginRight;
    const mb  = cfg.marginBottom;
    const fsz = cfg.footnoteSize;
    const fl  = cfg.footnoteLead;

    // ── Footnotes ────────────────────────────────────────────────────────
    if (state.fnEntries.length) {
      const sepY    = h - mb - state.fnHeight - cfg.leading;
      const sepLen  = cfg.footnoteSepLength;
      ps.line(ml, sepY, ml + sepLen, sepY, 0.4);

      let fnY = sepY + fl * 0.5;
      for (const { n, text } of state.fnEntries) {
        const numStr = String(n);
        // Footnote number (superscript-style, small)
        ps.text(numStr, ml, fnY - fsz * 0.3, cfg.bodyFont, fsz * 0.75);
        const numW  = measureText(numStr, cfg.bodyFont, fsz * 0.75) + 2;
        const fnColW = w - ml - mr - cfg.footnoteIndent;

        // Wrap footnote text
        const fnTokens = text.split(/(\s+)/).filter(Boolean).map(p => {
          const isSpace = /^\s+$/.test(p);
          return { text: p, font: cfg.bodyFont, size: fsz,
                   width: measureText(p, cfg.bodyFont, fsz), space: isSpace };
        });

        const fnLines = breakIntoLines(fnTokens, fnColW, numW, 0, fl);
        for (const fline of fnLines) {
          for (const sp of fline.spans) {
            ps.text(sp.text, ml + cfg.footnoteIndent + sp.x, fnY, sp.font, sp.size);
          }
          fnY += fl;
        }
      }
    }

    // ── Footer: page number (centered) ───────────────────────────────────
    const footerY   = h - mb / 2 + cfg.footerSize / 2;
    const pageStr   = String(pn);
    const pageStrW  = measureText(pageStr, cfg.headerFont, cfg.footerSize);
    ps.text(pageStr, (w - pageStrW) / 2, footerY, cfg.headerFont, cfg.footerSize);

    // ── Header: running title on even pages (amsart convention) ──────────
    if (pn > 1) {
      const shortTitle = doc.title.length > 55
        ? doc.title.slice(0, 52) + '…'
        : doc.title;
      const hFont = cfg.headerFont;
      const hSz   = cfg.headerSize;
      const hY    = cfg.marginTop / 2;
      const hW    = measureText(shortTitle, hFont, hSz);
      // even pages: title at left; odd pages (>1): title at right
      const hX = (pn % 2 === 0) ? ml : (w - mr - hW);
      ps.text(shortTitle, hX, hY, hFont, hSz);

      // Thin rule under header
      ps.line(ml, hY + hSz * 0.6, w - mr, hY + hSz * 0.6, 0.3);
    }
  }

  // ── Layout helpers for block types ───────────────────────────────────────

  function addVSpace(pts) {
    if (!curPage) return;
    state.curY += pts;
    // If the vspace pushes past the page, just start a new page
    if (state.curY > availBottom(state, cfg)) {
      flushPage();
      newPage();
    }
  }

  function layoutLines(lines, fnStateEntries) {
    // fnStateEntries: the entries collected during inlinesToTokens for these lines
    // We need to know which entries belong to which line (by fnNum)
    for (const line of lines) {
      const lineFnEntries = fnStateEntries.filter(e => line.fnNums.includes(e.n));
      placeLine(line, lineFnEntries);
    }
  }

  function layoutPara(inlines, opts = {}) {
    const indent   = opts.indent   ?? cfg.paraIndent;
    const hang     = opts.hang     ?? 0;
    const colWidth = colW - (opts.extraIndent ?? 0);
    const preSpace = opts.spaceBefore ?? 0;
    const postSpace= opts.spaceAfter  ?? cfg.paraSpacing;
    const font     = opts.font     ?? cfg.bodyFont;

    const prevCount = fnState.entries.length;
    const tokens    = inlinesToTokens(inlines, cfg, fnState, font);
    const newEntries= fnState.entries.slice(prevCount);
    const lines     = breakIntoLines(tokens, colWidth, indent, hang, cfg.leading);

    if (preSpace > 0) addVSpace(preSpace);
    layoutLines(lines, newEntries);
    if (postSpace > 0) addVSpace(postSpace);
  }

  // ── Centered small-caps heading ─────────────────────────────────────────

  function layoutCenteredSmallCapsHeading(inlines, hcfg) {
    addVSpace(hcfg.spaceBefore);

    // Build text (plain), measure, center
    const rawText = inlines.map(il => il.text ?? '').join('');
    const font    = hcfg.font;
    const size    = hcfg.size;
    const totalW  = measureSmallCaps(rawText, font, size, cfg.scRatio);
    const startX  = (colW - totalW) / 2;
    const spans   = smallCapsSpans(rawText, font, size, startX, cfg.scRatio);

    // Ensure it fits on the page
    if (state.curY + cfg.leading > availBottom(state, cfg)) {
      flushPage(); newPage();
    }
    for (const sp of spans) {
      curPage.text(sp.text, cfg.marginLeft + sp.x, state.curY, sp.font, sp.size);
    }
    state.curY += cfg.leading;
    addVSpace(hcfg.spaceAfter);
  }

  // ── Left-aligned small-caps or bold heading ─────────────────────────────

  function layoutLeftHeading(inlines, hcfg) {
    addVSpace(hcfg.spaceBefore);
    const rawText = inlines.map(il => il.text ?? '').join('');
    const font    = hcfg.font;
    const size    = hcfg.size;

    const spans = hcfg.smallCaps
      ? smallCapsSpans(rawText, font, size, 0, cfg.scRatio)
      : [{ x: 0, text: rawText, font, size, superscript: false }];

    if (state.curY + cfg.leading > availBottom(state, cfg)) {
      flushPage(); newPage();
    }
    for (const sp of spans) {
      curPage.text(sp.text, cfg.marginLeft + sp.x, state.curY, sp.font, sp.size);
    }
    state.curY += cfg.leading;
    addVSpace(hcfg.spaceAfter);
  }

  /**
   * Inline (run-in) heading: render heading text at start of following paragraph.
   * Returns the prefix tokens to prepend to the paragraph inlines.
   */
  function inlineHeadingPrefix(inlines, hcfg) {
    const rawText = inlines.map(il => il.text ?? '').join('');
    const text    = rawText + '.';
    const font    = hcfg.font;
    const size    = hcfg.size;
    const w       = measureText(text + ' ', font, size);
    const spW     = measureText(' ', font, size);
    return [
      { text, font, size, width: w - spW, breakable: false, space: false },
      { text: ' ', font, size, width: spW, breakable: true, space: true },
    ];
  }

  // ── Bibliography entries with hanging indent ────────────────────────────

  function layoutBibEntry(key, citation, num) {
    const { formatBibEntry } = cfg;  // injected formatter
    const entryHtml = formatBibEntry(citation, doc.citationStyle, num);

    // Parse lightweight HTML → [{text, font}] preserving <em> and <strong>
    const bibInlines = [];
    const tagRe = /(<em>|<\/em>|<strong>|<\/strong>|<[^>]*>)|([^<]+)/g;
    let bibFont = cfg.bodyFont;
    let emActive = false, strongActive = false;
    let m;
    while ((m = tagRe.exec(entryHtml)) !== null) {
      if (m[1]) {
        const tag = m[1].toLowerCase();
        if      (tag === '<em>')      { emActive = true; }
        else if (tag === '</em>')     { emActive = false; }
        else if (tag === '<strong>')  { strongActive = true; }
        else if (tag === '</strong>') { strongActive = false; }
        // derive font
        bibFont = (emActive && strongActive) ? cfg.boldItalicFont
                : emActive                   ? cfg.italicFont
                : strongActive               ? cfg.boldFont
                :                             cfg.bodyFont;
      } else if (m[2]) {
        bibInlines.push({ type: 'text', text: m[2], _font: bibFont });
      }
    }

    const dummyFn = { counter: 0, entries: [] };
    const tokens  = bibInlines.flatMap(il => {
      const font  = il._font ?? cfg.bodyFont;
      const parts = il.text.split(/(\s+)/).filter(Boolean);
      return parts.map(p => {
        const isSpace = /^\s+$/.test(p);
        return { text: p, font, size: cfg.fontSize,
                 width: measureText(p, font, cfg.fontSize),
                 breakable: isSpace, space: isSpace };
      });
    });

    const lines = breakIntoLines(tokens, colW, 0, cfg.bibHangingIndent, cfg.leading);
    for (const line of lines) placeLine(line, []);
    addVSpace(cfg.leading * 0.3);
  }

  // ── Block-level loop ──────────────────────────────────────────────────

  newPage();

  // Title block (centered, small-caps)
  if (doc.title) {
    const titleCfg = cfg.headings[0]; // heading[0] = title style
    layoutCenteredSmallCapsHeading(
      [{ type: 'text', text: doc.title }], titleCfg
    );
  }
  if (doc.author) {
    const aFont = cfg.italicFont;
    const aSize = cfg.fontSize;
    const aW    = measureText(doc.author, aFont, aSize);
    const aX    = (colW - aW) / 2;
    curPage.text(doc.author, cfg.marginLeft + aX, state.curY, aFont, aSize);
    state.curY += cfg.leading;
    addVSpace(cfg.leading * 0.5);
  }
  if (doc.date) {
    const dFont = cfg.bodyFont;
    const dSize = cfg.fontSize * 0.9;
    const dW    = measureText(doc.date, dFont, dSize);
    const dX    = (colW - dW) / 2;
    curPage.text(doc.date, cfg.marginLeft + dX, state.curY, dFont, dSize);
    state.curY += cfg.leading;
    addVSpace(cfg.leading * 1.5);
  }

  // Content blocks
  let i = 0;
  while (i < doc.blocks.length) {
    const block = doc.blocks[i];

    if (block.kind === 'heading') {
      const hcfg = cfg.headings[block.level];
      if (!hcfg) { i++; continue; }

      if (hcfg.inline) {
        // Run-in heading: grab next paragraph and prepend heading tokens
        const prefixTokens = inlineHeadingPrefix(block.inlines, hcfg);
        i++;
        const nextBlock = doc.blocks[i];
        if (nextBlock?.kind === 'para') {
          // Convert the paragraph inlines but prepend the heading tokens
          const prevCount  = fnState.entries.length;
          const bodyTokens = inlinesToTokens(nextBlock.inlines, cfg, fnState, cfg.bodyFont);
          const newEntries = fnState.entries.slice(prevCount);
          const allTokens  = [...prefixTokens, ...bodyTokens];
          addVSpace(hcfg.spaceBefore);
          const lines = breakIntoLines(allTokens, colW, cfg.paraIndent, 0, cfg.leading);
          layoutLines(lines, newEntries);
          addVSpace(cfg.paraSpacing);
          i++;
        } else {
          // No following paragraph — render heading alone
          layoutLeftHeading(block.inlines, hcfg);
          // don't increment i (nextBlock will be processed next iteration)
        }
      } else if (hcfg.align === 'center') {
        layoutCenteredSmallCapsHeading(block.inlines, hcfg);
        i++;
      } else {
        layoutLeftHeading(block.inlines, hcfg);
        i++;
      }

    } else if (block.kind === 'para') {
      layoutPara(block.inlines);
      i++;

    } else if (block.kind === 'blockquote') {
      const bi = cfg.blockQuoteIndent;
      const prevCount  = fnState.entries.length;
      const tokens     = inlinesToTokens(block.inlines, cfg, fnState, cfg.italicFont);
      const newEntries = fnState.entries.slice(prevCount);
      const lines      = breakIntoLines(tokens, colW - 2 * bi, 0, 0, cfg.leading);
      addVSpace(cfg.paraSpacing);
      // Shift all x by blockquote indent
      for (const line of lines) {
        line.spans.forEach(sp => sp.x += bi);
        const lineFnEntries = newEntries.filter(e => line.fnNums.includes(e.n));
        placeLine(line, lineFnEntries);
      }
      addVSpace(cfg.paraSpacing);
      i++;

    } else if (block.kind === 'list') {
      addVSpace(cfg.paraSpacing * 0.5);
      block.items.forEach((item, idx) => {
        const bullet = block.ordered ? `${idx + 1}.` : '•';
        const bW = measureText(bullet + ' ', cfg.bodyFont, cfg.fontSize);
        const prevCount  = fnState.entries.length;
        const tokens     = inlinesToTokens(item, cfg, fnState, cfg.bodyFont);
        const newEntries = fnState.entries.slice(prevCount);
        // Bullet token prepended
        const allTok = [
          { text: bullet, font: cfg.bodyFont, size: cfg.fontSize,
            width: measureText(bullet, cfg.bodyFont, cfg.fontSize),
            breakable: false, space: false },
          { text: ' ', font: cfg.bodyFont, size: cfg.fontSize,
            width: measureText(' ', cfg.bodyFont, cfg.fontSize),
            breakable: true, space: true },
          ...tokens,
        ];
        const lines = breakIntoLines(allTok, colW, 0, bW, cfg.leading);
        layoutLines(lines, newEntries);
      });
      addVSpace(cfg.paraSpacing * 0.5);
      i++;

    } else if (block.kind === 'verbatim') {
      addVSpace(cfg.paraSpacing);
      const lines = block.text.split('\n');
      for (const line of lines) {
        if (state.curY + cfg.leading > availBottom(state, cfg)) {
          flushPage(); newPage();
        }
        curPage.text(line, cfg.marginLeft + 8, state.curY, 'H', cfg.fontSize * 0.85);
        state.curY += cfg.leading * 0.9;
      }
      addVSpace(cfg.paraSpacing);
      i++;

    } else if (block.kind === 'hr') {
      addVSpace(cfg.leading * 0.5);
      const hrY = state.curY;
      curPage.line(cfg.marginLeft, hrY, cfg.pageWidth - cfg.marginRight, hrY, 0.4);
      state.curY += cfg.leading * 0.5;
      i++;

    } else {
      i++;
    }
  }

  // ── Bibliography ─────────────────────────────────────────────────────────

  if (doc.citedKeys.length && doc.citationMap.size) {
    addVSpace(cfg.leading * 1.5);
    const bibTitle  = doc.citationStyle === 'mla' ? 'Works Cited' : 'References';
    const bhcfg     = cfg.headings[1];  // section-style for bib heading
    layoutCenteredSmallCapsHeading([{ type: 'text', text: bibTitle }], bhcfg);

    doc.citedKeys.forEach((key, idx) => {
      const c = doc.citationMap.get(key);
      if (c) layoutBibEntry(key, c, idx + 1);
    });
  }

  // Flush the final page
  flushPage();

  return writer;
}
