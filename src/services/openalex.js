/**
 * OpenAlex API client for searching academic works.
 * https://openalex.org/
 *
 * Used by the citation quick-add modal to let users search for papers
 * by title/author/DOI and import them directly into the citation database.
 */

import { generateCitekey, ensureUniqueCitekey } from './bibtex.js';

const OPENALEX_BASE = 'https://api.openalex.org';

// Map OpenAlex work types to BibTeX entry types
const TYPE_MAP = {
  article:               'article',
  'book-chapter':        'incollection',
  book:                  'book',
  proceedings:           'inproceedings',
  'proceedings-article': 'inproceedings',
  dissertation:          'phdthesis',
  report:                'techreport',
  preprint:              'misc',
  dataset:               'misc',
  other:                 'misc',
};

/**
 * Search OpenAlex for works matching the query string.
 *
 * @param {string} query   - Title, author name, or DOI
 * @param {number} [limit=10]
 * @returns {Promise<Array>}  OpenAlex work objects
 */
export async function searchOpenAlex(query, limit = 10) {
  const params = new URLSearchParams({
    search:     query,
    'per-page': String(limit),
    select:     'id,title,authorships,publication_year,doi,primary_location,type,biblio',
  });
  const res = await fetch(`${OPENALEX_BASE}/works?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`);
  const data = await res.json();
  return data.results ?? [];
}

/**
 * Convert an OpenAlex work object into a citation record ready for storage.
 *
 * Generates a unique citekey and builds a BibTeX string from the
 * structured metadata OpenAlex provides.
 *
 * @param {object}     work          - OpenAlex work object
 * @param {Set<string>} existingKeys - already-used citekeys to avoid collision
 * @returns {object}  citation-compatible record (no created_at/updated_at needed;
 *                    the storage backend adds those on save)
 */
export function openAlexToCitation(work, existingKeys = new Set()) {
  const entryType = TYPE_MAP[work.type] ?? 'misc';

  // Authors come as display_name strings ("Given Family" or "Family, Given")
  const authors = (work.authorships ?? [])
    .map(a => a.author?.display_name ?? '')
    .filter(Boolean);

  const year    = work.publication_year ?? null;
  const title   = work.title ?? 'Untitled';

  // Strip the resolver prefix OpenAlex prepends to DOIs
  let doi = work.doi ?? null;
  if (doi?.startsWith('https://doi.org/')) doi = doi.slice('https://doi.org/'.length);

  const journal   = work.primary_location?.source?.display_name ?? null;
  const volume    = work.biblio?.volume     ?? null;
  const issue     = work.biblio?.issue      ?? null;
  const firstPage = work.biblio?.first_page ?? null;
  const lastPage  = work.biblio?.last_page  ?? null;
  const pages     = (firstPage && lastPage)
    ? `${firstPage}--${lastPage}`
    : (firstPage ?? null);

  // Extract surnames for citekey generation (handles both "Family, Given" and "Given Family")
  const surnames = authors.map(a => {
    const parts = a.split(',');
    return parts.length > 1
      ? parts[0].trim()
      : (a.split(' ').pop() ?? a);
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
