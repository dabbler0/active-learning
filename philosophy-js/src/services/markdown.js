/**
 * Markdown rendering with inline citation and note-link support.
 *
 * Citation syntax: [@citekey] or [@citekey, p. 23]
 * Note-link syntax: [[note:slug|Display Text]] or [[note:slug]]
 *
 * Two-pass approach:
 *  1. Pre-scan the markdown for all citekeys
 *  2. Resolve citation metadata from the provided citations map
 *  3. Render with inline substitution + appended bibliography
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html:    false,
  linkify: true,
  typographer: true,
});

// ── Custom inline rules ────────────────────────────────────────────────────

/**
 * Rule for [@citekey] and [@citekey, p. N]
 * Produces: <cite class="citation" data-citekey="KEY">...</cite>
 */
md.core.ruler.after('linkify', 'citations', state => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline') continue;
    const children = [];
    for (const tok of blockToken.children) {
      if (tok.type !== 'text') { children.push(tok); continue; }

      let lastIdx = 0;
      const re = /\[@([^\]@,]+?)(?:,\s*([^\]]+))?\]/g;
      let m;
      while ((m = re.exec(tok.content)) !== null) {
        if (m.index > lastIdx) {
          const t = new state.Token('text', '', 0);
          t.content = tok.content.slice(lastIdx, m.index);
          children.push(t);
        }
        const [full, key, locator] = m;
        const open  = new state.Token('cite_open',  'cite', 1);
        open.attrSet('class', 'citation');
        open.attrSet('data-citekey', key.trim());
        const inner = new state.Token('text', '', 0);
        inner.content = locator ? `${key.trim()}, ${locator.trim()}` : key.trim();
        const close = new state.Token('cite_close', 'cite', -1);
        children.push(open, inner, close);
        lastIdx = m.index + full.length;
      }
      if (lastIdx < tok.content.length) {
        const t = new state.Token('text', '', 0);
        t.content = tok.content.slice(lastIdx);
        children.push(t);
      }
    }
    blockToken.children = children;
  }
});

/**
 * Rule for [[note:slug|Display]] and [[note:slug]]
 * Produces: <a class="note-link" data-slug="...">Display</a>
 */
md.core.ruler.after('citations', 'note_links', state => {
  for (const blockToken of state.tokens) {
    if (blockToken.type !== 'inline') continue;
    const children = [];
    for (const tok of blockToken.children) {
      if (tok.type !== 'text') { children.push(tok); continue; }

      let lastIdx = 0;
      const re = /\[\[note:([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
      let m;
      while ((m = re.exec(tok.content)) !== null) {
        if (m.index > lastIdx) {
          const t = new state.Token('text', '', 0);
          t.content = tok.content.slice(lastIdx, m.index);
          children.push(t);
        }
        const [full, slug, display] = m;
        const open  = new state.Token('link_open',  'a', 1);
        open.attrSet('class', 'note-link');
        open.attrSet('data-slug', slug);
        open.attrSet('href', '#');
        const inner = new state.Token('text', '', 0);
        inner.content = display || slug;
        const close = new state.Token('link_close', 'a', -1);
        children.push(open, inner, close);
        lastIdx = m.index + full.length;
      }
      if (lastIdx < tok.content.length) {
        const t = new state.Token('text', '', 0);
        t.content = tok.content.slice(lastIdx);
        children.push(t);
      }
    }
    blockToken.children = children;
  }
});

// ── Citation styles catalogue ──────────────────────────────────────────────

export const CITATION_STYLES = [
  { id: 'authoryear', label: 'Author-Year (generic)' },
  { id: 'apa',        label: 'APA 7th edition' },
  { id: 'mla',        label: 'MLA 9th edition' },
  { id: 'chicago',    label: 'Chicago (author-date)' },
  { id: 'numeric',    label: 'Numeric [1]' },
  { id: 'alpha',      label: 'Alpha [Smi20]' },
];

// ── Author-name helpers ────────────────────────────────────────────────────

/** "Smith, John A." → "Smith, J. A." (APA initials) */
function apaInitials(nameStr) {
  const parts = nameStr.split(',');
  if (parts.length >= 2) {
    const last   = parts[0].trim();
    const firsts = parts[1].trim().split(/\s+/).filter(Boolean)
      .map(w => w[0].toUpperCase() + '.').join(' ');
    return `${last}, ${firsts}`;
  }
  const words = nameStr.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const last   = words[words.length - 1];
    const firsts = words.slice(0, -1).map(w => w[0].toUpperCase() + '.').join(' ');
    return `${last}, ${firsts}`;
  }
  return nameStr;
}

/** Format an author list for APA bibliography: "Smith, J., & Doe, J." */
function formatAuthorsApa(authors) {
  if (!authors.length) return 'Unknown';
  const fmt = authors.map(apaInitials);
  if (fmt.length === 1) return fmt[0];
  return fmt.slice(0, -1).join(', ') + ', & ' + fmt[fmt.length - 1];
}

/** "Last, First" → "First Last" */
function mlaToFirstLast(nameStr) {
  const parts = nameStr.split(',');
  if (parts.length >= 2) return `${parts[1].trim()} ${parts[0].trim()}`;
  return nameStr;
}

/** Format an author list for MLA Works Cited: "Smith, John, and Jane Doe" */
function formatAuthorsMla(authors) {
  if (!authors.length) return 'Unknown';
  if (authors.length > 3) return `${authors[0]}, et al.`;
  if (authors.length === 1) return authors[0];
  const rest = authors.slice(1).map(mlaToFirstLast);
  if (authors.length === 2) return `${authors[0]}, and ${rest[0]}`;
  return `${authors[0]}, ${rest[0]}, and ${rest[1]}`;
}

// ── BibTeX field extraction (for enriched bibliography output) ─────────────

function bibtexFieldFrom(raw, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:\\{([^{}]*)\\}|"([^"]*)")`, 'i');
  const m  = re.exec(raw ?? '');
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

// ── Citation resolution ────────────────────────────────────────────────────

/** Extract all unique citekeys from a markdown string. */
export function extractCitekeys(markdown) {
  const re = /\[@([^\]@,]+)/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(markdown)) !== null) keys.add(m[1].trim());
  return [...keys];
}

/**
 * Given rendered HTML containing <cite data-citekey="..."> elements,
 * replace their inner text with formatted citation labels and return
 * a bibliography section to append.
 *
 * @param {string} html       - rendered HTML from md.render()
 * @param {Map<string,object>} citationMap - citekey → citation object
 * @param {string} style      - 'authoryear' | 'numeric' | 'alpha'
 */
export function applyCitations(html, citationMap, style = 'authoryear') {
  if (!citationMap.size) return { html, bibliography: '' };

  // Collect cited keys in order of appearance
  const orderedKeys = [];
  const seen = new Set();
  const scanRe = /data-citekey="([^"]+)"/g;
  let m;
  while ((m = scanRe.exec(html)) !== null) {
    const k = m[1];
    if (!seen.has(k)) { seen.add(k); orderedKeys.push(k); }
  }

  // Build index (1-based for numeric/alpha)
  const index = new Map(orderedKeys.map((k, i) => [k, i + 1]));

  function label(key, locator) {
    const c = citationMap.get(key);
    if (!c) return `${key}${locator ? `, ${locator}` : ''}`;
    if (style === 'numeric') {
      return `[${index.get(key) ?? '?'}]${locator ? `, ${locator}` : ''}`;
    }
    if (style === 'alpha') {
      const alpha = alphaLabel(c);
      return `[${alpha}]${locator ? `, ${locator}` : ''}`;
    }
    if (style === 'mla') {
      // MLA: (Smith 42) — author + locator/page, no year
      const auth = shortAuthor(c);
      return locator ? `(${auth} ${locator})` : `(${auth})`;
    }
    if (style === 'chicago') {
      // Chicago author-date: (Smith 2020) or (Smith 2020, 42)
      const auth = shortAuthor(c);
      const yr   = c.year ?? 'n.d.';
      return locator ? `(${auth} ${yr}, ${locator})` : `(${auth} ${yr})`;
    }
    // authoryear or apa: (Smith, 2020) or (Smith, 2020, p. 5)
    const auth = shortAuthor(c);
    const yr   = c.year ?? 'n.d.';
    return locator ? `(${auth}, ${yr}, ${locator})` : `(${auth}, ${yr})`;
  }

  // Replace <cite ...>KEY, locator</cite> with formatted text
  const replaced = html.replace(
    /<cite class="citation" data-citekey="([^"]+)">([^<]*)<\/cite>/g,
    (_, key, inner) => {
      // inner is "key" or "key, locator"
      const comma = inner.indexOf(',');
      const locator = comma > -1 ? inner.slice(comma + 1).trim() : null;
      return `<cite class="citation" data-citekey="${key}">${label(key, locator)}</cite>`;
    }
  );

  // Build bibliography
  const bibLines = orderedKeys
    .map(key => {
      const c = citationMap.get(key);
      if (!c) return `<li id="ref-${key}"><code>${key}</code> — not found in library</li>`;
      return `<li id="ref-${key}">${formatBibEntry(c, style, index.get(key))}</li>`;
    })
    .join('\n');

  const sectionTitle = style === 'mla' ? 'Works Cited' : 'References';
  const bibliography = bibLines
    ? `<section class="bibliography"><h2>${sectionTitle}</h2><ol>${bibLines}</ol></section>`
    : '';

  return { html: replaced, bibliography };
}

function shortAuthor(c) {
  const authors = c.authors ?? [];
  if (!authors.length) return c.title?.slice(0, 20) ?? c.citekey;
  const first = authors[0].split(',')[0].trim();
  return authors.length > 1 ? `${first} et al.` : first;
}

function alphaLabel(c) {
  const authors = c.authors ?? [];
  const auth = authors.length
    ? authors[0].split(',')[0].trim().slice(0, 3)
    : (c.title ?? c.citekey).slice(0, 3);
  const yr = c.year ? String(c.year).slice(-2) : 'nd';
  return auth + yr;
}

function formatBibEntry(c, style, num) {
  const authors   = c.authors ?? [];
  const year      = c.year;
  const title     = c.title ?? '(no title)';
  const raw       = c.bibtex_raw ?? '';
  const entryType = c.entry_type ?? 'misc';
  const isBook    = ['book', 'phdthesis', 'techreport'].includes(entryType);

  // Extra fields extracted from raw BibTeX
  const journal   = bibtexFieldFrom(raw, 'journal');
  const volume    = bibtexFieldFrom(raw, 'volume');
  const number    = bibtexFieldFrom(raw, 'number');
  const pages     = bibtexFieldFrom(raw, 'pages').replace(/--/, '–');
  const publisher = bibtexFieldFrom(raw, 'publisher');

  if (style === 'apa') {
    const authStr  = formatAuthorsApa(authors);
    const yearStr  = year ? `(${year})` : '(n.d.)';
    const titleStr = isBook ? `<em>${title}</em>` : title;
    let source = '';
    if (journal) {
      source = `<em>${journal}</em>`;
      if (volume) source += `, <em>${volume}</em>`;
      if (number) source += `(${number})`;
      if (pages)  source += `, ${pages}`;
    } else if (publisher) {
      source = publisher;
    }
    return `<span class="bib-authors">${authStr}</span> ${yearStr}. ${titleStr}.${source ? ' ' + source + '.' : ''}`;
  }

  if (style === 'mla') {
    const authStr  = formatAuthorsMla(authors);
    const yearStr  = year ? String(year) : 'n.d.';
    const titleStr = isBook ? `<em>${title}</em>` : `"${title}"`;
    let source = '';
    if (journal) {
      source = `<em>${journal}</em>`;
      if (volume) source += `, vol. ${volume}`;
      if (number) source += `, no. ${number}`;
      source += `, ${yearStr}`;
      if (pages)  source += `, pp. ${pages}`;
    } else if (publisher) {
      source = `${publisher}, ${yearStr}`;
    } else {
      source = yearStr;
    }
    return `<span class="bib-authors">${authStr}</span>. ${titleStr}. ${source}.`;
  }

  if (style === 'chicago') {
    const authStr  = authors.join(', ') || 'Unknown';
    const yearStr  = year ? String(year) : 'n.d.';
    const titleStr = isBook ? `<em>${title}</em>` : `"${title}"`;
    let source = '';
    if (journal) {
      source = `<em>${journal}</em>`;
      if (volume) source += ` ${volume}`;
      if (number) source += ` (${number})`;
      if (pages)  source += `: ${pages}`;
    } else if (publisher) {
      source = publisher;
    }
    return `<span class="bib-authors">${authStr}</span>. ${yearStr}. ${titleStr}.${source ? ' ' + source + '.' : ''}`;
  }

  // authoryear / numeric / alpha
  const authStr = authors.join(', ') || 'Unknown';
  const yearStr = year ? `(${year})` : '(n.d.)';
  const prefix  = style === 'numeric'
    ? `<span class="bib-num">[${num}]</span> `
    : style === 'alpha'
    ? `<span class="bib-num">[${alphaLabel(c)}]</span> `
    : '';
  return `${prefix}<span class="bib-authors">${authStr}</span> ${yearStr}. <em>${title}</em>.`;
}

// ── Main render function ───────────────────────────────────────────────────

/**
 * Render markdown to an HTML object ready to inject into the DOM.
 *
 * @param {string}            markdown
 * @param {Map<string,object>|object} citations  - Map or plain object of citekey→citation
 * @param {string}            bibStyle           - 'authoryear'|'numeric'|'alpha'
 * @returns {{ html: string, bibliography: string, citekeys: string[] }}
 */
export function renderMarkdown(markdown, citations = new Map(), bibStyle = 'authoryear') {
  const citationMap = citations instanceof Map
    ? citations
    : new Map(Object.entries(citations));

  const rawHtml = md.render(markdown);
  const citekeys = extractCitekeys(markdown);
  const { html, bibliography } = applyCitations(rawHtml, citationMap, bibStyle);

  return { html, bibliography, citekeys };
}

/**
 * Render markdown and return a single combined HTML string for display.
 */
export function renderFull(markdown, citations, bibStyle) {
  const { html, bibliography } = renderMarkdown(markdown, citations, bibStyle);
  return html + bibliography;
}
