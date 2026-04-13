/**
 * BibTeX parsing and citation metadata services.
 *
 * Cascade:
 *  1. BibTeX (regex parser — no dependency)
 *  2. DOI → CrossRef API
 *  3. ISBN → OpenLibrary API
 *  4. Free-text fallback (preserves detected identifiers)
 */

// ── Helpers ────────────────────────────────────────────────────────────────

const STOP = new Set(['the','a','an','of','in','on','and','or','for','to','is','are']);

export function generateCitekey(authors, year, title) {
  const last = authors.length
    ? authors[0].split(',')[0].trim().toLowerCase().replace(/[^a-z]/g, '') || 'unknown'
    : 'unknown';
  const yr = year ? String(year) : 'nd';
  const word = (title ?? '').toLowerCase().replace(/[^a-z ]/g, '').split(' ')
    .find(w => w && !STOP.has(w)) ?? '';
  return `${last}${yr}${word}`;
}

export function ensureUniqueCitekey(base, existingKeys) {
  if (!existingKeys.has(base)) return base;
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    const k = base + ch;
    if (!existingKeys.has(k)) return k;
  }
  return base + Date.now();
}

function parseAuthors(field) {
  if (!field) return [];
  return field.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
}

function bibtexField(raw, name) {
  // Handles = { ... } and = "..." with reasonable nesting
  const re = new RegExp(`${name}\\s*=\\s*(?:\\{([\\s\\S]*?)\\}|"([^"]*)")`, 'i');
  const m = re.exec(raw);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').replace(/^\{|\}$/g, '').trim();
}

// ── Step 1: BibTeX regex parser ────────────────────────────────────────────

export function parseBibtex(raw) {
  const m = raw.match(/@(\w+)\s*\{\s*([^,]+),/);
  if (!m) return null;

  const entryType = m[1].toLowerCase();
  const citekey   = m[2].trim();
  const title     = bibtexField(raw, 'title').replace(/[{}]/g, '');
  const author    = bibtexField(raw, 'author');
  const yearStr   = bibtexField(raw, 'year');
  const yearMatch = yearStr.match(/\d{4}/);
  const year      = yearMatch ? parseInt(yearMatch[0]) : null;
  const doi       = bibtexField(raw, 'doi') || null;
  const isbn      = bibtexField(raw, 'isbn') || null;

  return {
    citekey,
    entry_type: entryType,
    title,
    authors: parseAuthors(author),
    year,
    doi,
    isbn,
    bibtex_raw: raw.trim(),
    parsed_from: 'bibtex',
    warnings: [],
  };
}

// ── Step 2: DOI → CrossRef ─────────────────────────────────────────────────

const DOI_RE = /10\.\d{4,}[/\w.%()\-]+/;

function extractDoi(text) {
  const m = text.match(DOI_RE);
  return m ? m[0].replace(/[.),;]+$/, '') : null;
}

function crossrefToResult(data, doi) {
  const msg = data.message ?? {};
  const title = (msg.title ?? [''])[0];
  const typeMap = {
    'journal-article':      'article',
    'book':                 'book',
    'book-chapter':         'incollection',
    'proceedings-article':  'inproceedings',
    'dissertation':         'phdthesis',
    'report':               'techreport',
  };
  const entryType = typeMap[msg.type] ?? 'misc';

  const authors = (msg.author ?? []).map(a => {
    if (a.family && a.given) return `${a.family}, ${a.given}`;
    return a.family ?? a.name ?? '';
  }).filter(Boolean);

  const parts = (msg.published ?? msg['published-print'] ?? {})['date-parts'];
  const year  = parts?.[0]?.[0] ?? null;
  const journal = (msg['container-title'] ?? [])[0] ?? '';
  const volume  = msg.volume ?? '';
  const issue   = msg.issue  ?? '';
  const pages   = (msg.page  ?? '').replace('-', '--');
  const pub     = msg.publisher ?? '';

  const citekey = generateCitekey(authors, year, title);
  const lines   = [`@${entryType}{${citekey},`];
  lines.push(`  title     = {${title}},`);
  if (authors.length) lines.push(`  author    = {${authors.join(' and ')}},`);
  if (year)           lines.push(`  year      = {${year}},`);
  if (journal)        lines.push(`  journal   = {${journal}},`);
  if (volume)         lines.push(`  volume    = {${volume}},`);
  if (issue)          lines.push(`  number    = {${issue}},`);
  if (pages)          lines.push(`  pages     = {${pages}},`);
  if (pub)            lines.push(`  publisher = {${pub}},`);
  lines.push(`  doi       = {${doi}},`);
  lines.push('}');

  return { citekey, entry_type: entryType, title, authors, year,
    doi, isbn: null, bibtex_raw: lines.join('\n'),
    parsed_from: 'crossref', warnings: [] };
}

async function lookupDoi(doi) {
  const url  = `https://api.crossref.org/works/${doi}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'PhilosophyNotesApp/1.0 (mailto:user@localhost)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`CrossRef HTTP ${resp.status}`);
  return crossrefToResult(await resp.json(), doi);
}

function doiStub(doi, reason) {
  const citekey = 'doi' + doi.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  return {
    citekey, entry_type: 'misc', title: `(DOI: ${doi})`, authors: [], year: null,
    doi, isbn: null,
    bibtex_raw: `@misc{${citekey},\n  doi  = {${doi}},\n  note = {Retrieved from DOI},\n}`,
    parsed_from: 'doi_stub',
    warnings: [reason],
  };
}

// ── Step 3: ISBN → OpenLibrary ─────────────────────────────────────────────

const ISBN_RE = /\b(?:ISBN[:\s]*)?(97[89][\d\-X]{10,}|\d[\d\-X]{8,12})\b/i;

function normalizeIsbn(raw) {
  return raw.replace(/[-\s]/g, '').toUpperCase();
}

function extractIsbn(text) {
  const m = text.match(ISBN_RE);
  return m ? normalizeIsbn(m[1]) : null;
}

async function lookupIsbn(isbn) {
  const url  = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=details`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`OpenLibrary HTTP ${resp.status}`);
  const data = await resp.json();
  const entry   = Object.values(data)[0];
  if (!entry)   throw new Error('No data from OpenLibrary');
  const details = entry.details ?? {};
  const title   = details.title ?? '';
  const authors = (details.authors ?? []).map(a => a.name).filter(Boolean);
  const yearM   = (details.publish_date ?? '').match(/\d{4}/);
  const year    = yearM ? parseInt(yearM[0]) : null;
  const pub     = (details.publishers ?? [])[0] ?? '';
  const citekey = generateCitekey(authors, year, title);
  const lines   = [`@book{${citekey},`];
  lines.push(`  title     = {${title}},`);
  if (authors.length) lines.push(`  author    = {${authors.join(' and ')}},`);
  if (year)           lines.push(`  year      = {${year}},`);
  if (pub)            lines.push(`  publisher = {${pub}},`);
  lines.push(`  isbn      = {${isbn}},`);
  lines.push('}');
  return { citekey, entry_type: 'book', title, authors, year,
    doi: null, isbn, bibtex_raw: lines.join('\n'),
    parsed_from: 'isbn', warnings: [] };
}

function isbnStub(isbn, reason) {
  const citekey = 'isbn' + isbn.toLowerCase().replace(/[^0-9x]/g, '').slice(0, 13);
  return {
    citekey, entry_type: 'book', title: `(ISBN: ${isbn})`, authors: [], year: null,
    doi: null, isbn,
    bibtex_raw: `@book{${citekey},\n  isbn = {${isbn}},\n  note = {Retrieved from ISBN},\n}`,
    parsed_from: 'isbn_stub',
    warnings: [reason],
  };
}

// ── Step 4: Free-text fallback ─────────────────────────────────────────────

function freeTextFallback(text) {
  const yearM  = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  const year   = yearM ? parseInt(yearM[0]) : null;
  const titleM = text.match(/"([^"]{5,})"/) ?? text.match(/'([^']{5,})'/);
  const title  = titleM ? titleM[1] : text.slice(0, 80).split('.')[0].trim();
  const authors = [];
  if (year) {
    const before = text.slice(0, text.indexOf(String(year))).trim();
    const am = before.match(/^([A-Z][^\d,.(]+(?:,\s*[A-Z][^\d,.(]+)*)/);
    if (am) authors.push(am[1].trim().replace(/,$/, ''));
  }
  const citekey = generateCitekey(authors, year, title);
  const lines = [`@misc{${citekey},`];
  lines.push(`  title  = {${title}},`);
  if (authors.length) lines.push(`  author = {${authors.join(' and ')}},`);
  if (year)           lines.push(`  year   = {${year}},`);
  lines.push(`  note   = {Original: ${text.slice(0, 200).trim()}},`);
  lines.push('}');
  return {
    citekey, entry_type: 'misc', title, authors, year,
    doi: null, isbn: null,
    bibtex_raw: lines.join('\n'),
    parsed_from: 'free_text',
    warnings: ['Could not detect a structured format. Please review and correct the BibTeX.'],
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse any citation input into a result object.
 * Always returns something the user can review and edit.
 */
export async function parseCitation(raw, {
  existingKeys = new Set(),
  crossrefEnabled = true,
  openlibraryEnabled = true,
} = {}) {
  const text = raw.trim();

  // 1. BibTeX
  if (/@\w+\s*\{/.test(text)) {
    const r = parseBibtex(text);
    if (r) {
      r.citekey = ensureUniqueCitekey(r.citekey, existingKeys);
      return r;
    }
  }

  // 2. DOI
  const doi = extractDoi(text);
  if (doi) {
    if (crossrefEnabled) {
      try {
        const r = await lookupDoi(doi);
        r.citekey = ensureUniqueCitekey(r.citekey, existingKeys);
        return r;
      } catch (e) {
        const stub = doiStub(doi,
          `Could not reach CrossRef (offline?): ${e.message}. DOI saved — re-paste when online.`);
        stub.citekey = ensureUniqueCitekey(stub.citekey, existingKeys);
        return stub;
      }
    }
    const stub = doiStub(doi, 'CrossRef lookup disabled. Enable in Settings to fetch metadata.');
    stub.citekey = ensureUniqueCitekey(stub.citekey, existingKeys);
    return stub;
  }

  // 3. ISBN
  const isbn = extractIsbn(text);
  if (isbn) {
    if (openlibraryEnabled) {
      try {
        const r = await lookupIsbn(isbn);
        r.citekey = ensureUniqueCitekey(r.citekey, existingKeys);
        return r;
      } catch (e) {
        const stub = isbnStub(isbn,
          `Could not reach OpenLibrary (offline?): ${e.message}. ISBN saved — re-paste when online.`);
        stub.citekey = ensureUniqueCitekey(stub.citekey, existingKeys);
        return stub;
      }
    }
    const stub = isbnStub(isbn, 'OpenLibrary lookup disabled.');
    stub.citekey = ensureUniqueCitekey(stub.citekey, existingKeys);
    return stub;
  }

  // 4. Free-text
  const r = freeTextFallback(text);
  r.citekey = ensureUniqueCitekey(r.citekey, existingKeys);
  return r;
}
