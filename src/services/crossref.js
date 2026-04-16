/**
 * CrossRef API client for searching academic works by keyword.
 * https://api.crossref.org/
 *
 * Used by the citation quick-add modal to let users search for papers
 * by title/author/keyword and import them directly into the citation database.
 *
 * Supports CrossRef's "polite pool" via an optional mailto address, which
 * grants faster and more reliable responses from CrossRef's servers.
 */

import { generateCitekey, ensureUniqueCitekey } from './bibtex.js';

const CROSSREF_BASE = 'https://api.crossref.org';

// Map CrossRef work types to BibTeX entry types
const TYPE_MAP = {
  'journal-article':     'article',
  'book':                'book',
  'monograph':           'book',
  'book-chapter':        'incollection',
  'proceedings-article': 'inproceedings',
  'proceedings':         'inproceedings',
  'dissertation':        'phdthesis',
  'report':              'techreport',
  'dataset':             'misc',
  'preprint':            'misc',
  'posted-content':      'misc',
  'other':               'misc',
};

/**
 * Search CrossRef for works matching the query string.
 *
 * @param {string} query      - Keywords, title, author, or DOI
 * @param {number} [limit=10]
 * @param {string} [email]    - Optional email for CrossRef polite pool
 * @returns {Promise<Array>}  CrossRef work objects
 */
export async function searchCrossRef(query, limit = 10, email = '') {
  const params = new URLSearchParams({
    query,
    rows:   String(limit),
    select: 'DOI,title,author,issued,type,container-title,volume,issue,page,publisher',
  });
  if (email) params.set('mailto', email);
  const res = await fetch(`${CROSSREF_BASE}/works?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`CrossRef returned ${res.status}`);
  const data = await res.json();
  return data.message?.items ?? [];
}

/**
 * Convert a CrossRef work object into a citation record ready for storage.
 *
 * Generates a unique citekey and builds a BibTeX string from the
 * structured metadata CrossRef provides.
 *
 * @param {object}      work         - CrossRef work object
 * @param {Set<string>} existingKeys - already-used citekeys to avoid collision
 * @returns {object}  citation-compatible record (no created_at/updated_at needed;
 *                    the storage backend adds those on save)
 */
export function crossRefToCitation(work, existingKeys = new Set()) {
  const entryType = TYPE_MAP[work.type] ?? 'misc';

  // Authors stored as { family, given } objects; fall back to name string
  const authors = (work.author ?? []).map(a => {
    if (a.family && a.given) return `${a.family}, ${a.given}`;
    if (a.family) return a.family;
    return a.name ?? '';
  }).filter(Boolean);

  const year  = work.issued?.['date-parts']?.[0]?.[0] ?? null;
  const title = work.title?.[0] ?? 'Untitled';
  const doi   = work.DOI ?? null;

  const journal   = work['container-title']?.[0] ?? null;
  const volume    = work.volume ?? null;
  const issue     = work.issue ?? null;
  const pages     = work.page ?? null;

  // Extract surnames for citekey generation (handles "Family, Given" format)
  const surnames = authors.map(a => {
    const parts = a.split(',');
    return parts.length > 1 ? parts[0].trim() : (a.split(' ').pop() ?? a);
  });

  const base    = generateCitekey(surnames, year, title);
  const citekey = ensureUniqueCitekey(base, existingKeys);

  // Build BibTeX field lines
  const fields = [];
  if (title)          fields.push(`  title     = {${title}}`);
  if (authors.length) fields.push(`  author    = {${authors.join(' and ')}}`);
  if (year)           fields.push(`  year      = {${year}}`);
  if (journal)        fields.push(`  journal   = {${journal}}`);
  if (volume)         fields.push(`  volume    = {${volume}}`);
  if (issue)          fields.push(`  number    = {${issue}}`);
  if (pages)          fields.push(`  pages     = {${pages}}`);
  if (doi)            fields.push(`  doi       = {${doi}}`);

  const bibtex_raw = `@${entryType}{${citekey},\n${fields.join(',\n')}\n}`;

  return {
    citekey,
    entry_type: entryType,
    title,
    authors,
    year,
    doi,
    isbn:      null,
    bibtex_raw,
    note_body: '',
    tags:      [],
  };
}
