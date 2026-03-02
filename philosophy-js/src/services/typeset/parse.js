/**
 * HTML → Document model converter.
 *
 * Accepts the raw HTML produced by markdown-it (without citation resolution)
 * and converts it into a flat array of Block nodes with typed Inline content.
 *
 * Block kinds
 * ───────────
 *   heading   level 1|2|3, inlines
 *   para      inlines
 *   blockquote inlines
 *   verbatim  text (string)
 *   list      ordered (bool), items (Inline[][])
 *   hr        (horizontal rule)
 *
 * Inline types
 * ────────────
 *   text      text
 *   em        text
 *   strong    text
 *   em-strong text
 *   code      text
 *   cite      key, locator (string|null)
 *   hardbreak (no fields)
 */

// ── Inline helpers ─────────────────────────────────────────────────────────

function walkInlines(node, wrapType, acc) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {              // TEXT_NODE
      const t = child.textContent;
      if (t) acc.push({ type: wrapType ?? 'text', text: t });
    } else if (child.nodeType === 1) {      // ELEMENT_NODE
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') {
        acc.push({ type: 'hardbreak' });
      } else if (tag === 'em' || tag === 'i') {
        walkInlines(child, wrapType === 'strong' ? 'em-strong' : 'em', acc);
      } else if (tag === 'strong' || tag === 'b') {
        walkInlines(child, wrapType === 'em' ? 'em-strong' : 'strong', acc);
      } else if (tag === 'code') {
        acc.push({ type: 'code', text: child.textContent });
      } else if (tag === 'cite' && child.classList.contains('citation')) {
        const key     = child.dataset.citekey ?? child.textContent.split(',')[0].trim();
        const inner   = child.textContent.trim();
        const comma   = inner.indexOf(',');
        const locator = comma > -1 ? inner.slice(comma + 1).trim() : null;
        acc.push({ type: 'cite', key, locator });
      } else if (tag === 'a' && child.classList.contains('note-link')) {
        // Render note links as plain text
        acc.push({ type: 'text', text: child.textContent || child.dataset.slug });
      } else if (tag === 'sup') {
        acc.push({ type: 'superscript', text: child.textContent });
      } else {
        // Fallback: treat as transparent wrapper
        walkInlines(child, wrapType, acc);
      }
    }
  }
}

function getInlines(el, wrapType) {
  const acc = [];
  walkInlines(el, wrapType, acc);
  return acc;
}

// ── Block helpers ──────────────────────────────────────────────────────────

function getListItems(el) {
  const items = [];
  for (const child of el.children) {
    if (child.tagName.toLowerCase() === 'li') {
      items.push(getInlines(child));
    }
  }
  return items;
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Convert HTML string to a document model.
 *
 * @param {string} html  — raw output of md.render() (no citation resolution)
 * @returns {{ blocks: Block[], citedKeys: string[] }}
 */
export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`, 'text/html'
  );
  const body   = doc.body;
  const blocks = [];
  const citedKeys = [];
  const seenKeys  = new Set();

  function collectCitekeys(inlines) {
    for (const il of inlines) {
      if (il.type === 'cite' && !seenKeys.has(il.key)) {
        seenKeys.add(il.key);
        citedKeys.push(il.key);
      }
    }
  }

  for (const el of body.children) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'h1') {
      const inlines = getInlines(el);
      blocks.push({ kind: 'heading', level: 1, inlines });
      collectCitekeys(inlines);
    } else if (tag === 'h2') {
      const inlines = getInlines(el);
      blocks.push({ kind: 'heading', level: 2, inlines });
      collectCitekeys(inlines);
    } else if (tag === 'h3') {
      const inlines = getInlines(el);
      blocks.push({ kind: 'heading', level: 3, inlines });
      collectCitekeys(inlines);
    } else if (tag === 'p') {
      const inlines = getInlines(el);
      blocks.push({ kind: 'para', inlines });
      collectCitekeys(inlines);
    } else if (tag === 'blockquote') {
      const inlines = getInlines(el);
      blocks.push({ kind: 'blockquote', inlines });
      collectCitekeys(inlines);
    } else if (tag === 'pre') {
      blocks.push({ kind: 'verbatim', text: el.textContent });
    } else if (tag === 'ul') {
      const items = getListItems(el);
      items.forEach(ils => collectCitekeys(ils));
      blocks.push({ kind: 'list', ordered: false, items });
    } else if (tag === 'ol' && !el.closest('section.bibliography')) {
      const items = getListItems(el);
      items.forEach(ils => collectCitekeys(ils));
      blocks.push({ kind: 'list', ordered: true, items });
    } else if (tag === 'hr') {
      blocks.push({ kind: 'hr' });
    } else if (tag === 'section' && el.classList.contains('bibliography')) {
      // Bibliography injected by applyCitations — skip in raw mode,
      // we build our own from the citedKeys + citationMap.
    }
    // Ignore unknown tags
  }

  return { blocks, citedKeys };
}
