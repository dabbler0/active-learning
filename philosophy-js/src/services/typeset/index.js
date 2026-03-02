/**
 * Public API for the philosophy-js typesetter.
 *
 * generatePdf(options) → Blob
 *
 * options:
 *   body          {string}  raw Markdown source
 *   title         {string}
 *   author        {string}
 *   date          {string}
 *   citationMap   {Map<string,object>}  citekey → citation object
 *   citationStyle {string}  'apa'|'mla'|'chicago'|'authoryear'|'numeric'|'alpha'
 *   layoutConfig  {object}  layout configuration (default: AMSART)
 *   formatBibEntry {Function}  (citation, style, num) → HTML string
 *   renderRaw     {Function}  (markdown) → HTML string
 */

export { LAYOUTS } from './amsart.js';

import { AMSART }       from './amsart.js';
import { htmlToBlocks } from './parse.js';
import { layout }       from './layout.js';

/**
 * Generate a PDF from a Markdown document.
 * @returns {Blob}  application/pdf
 */
export function generatePdf({
  body          = '',
  title         = 'Untitled',
  author        = '',
  date          = '',
  citationMap   = new Map(),
  citationStyle = 'authoryear',
  layoutConfig  = AMSART,
  formatBibEntry,
  renderRaw,
}) {
  // 1. Render markdown → HTML (no citation substitution)
  const html   = renderRaw ? renderRaw(body) : body;

  // 2. Parse HTML → document model
  const { blocks, citedKeys } = htmlToBlocks(html);

  // 3. Build layout config with injected formatBibEntry
  const cfg = { ...layoutConfig, formatBibEntry: formatBibEntry ?? defaultFormatBibEntry };

  // 4. Run layout engine
  const pdfWriter = layout(
    { title, author, date, blocks, citedKeys, citationMap, citationStyle },
    cfg
  );

  // 5. Generate PDF bytes
  const bytes = pdfWriter.generate();

  return new Blob([bytes], { type: 'application/pdf' });
}

function defaultFormatBibEntry(c) {
  if (!c) return '(unknown)';
  const authors = (c.authors ?? []).join(', ') || 'Unknown';
  const year    = c.year ? `(${c.year})` : '(n.d.)';
  const title   = c.title ?? '(no title)';
  return `${authors} ${year}. ${title}.`;
}
