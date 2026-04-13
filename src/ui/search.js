/**
 * Unified full-text search panel.
 *
 * Searches notes (title + body) and citations (title + authors + citekey)
 * entirely in-memory — no server needed.
 */

let _storage = null;
const $ = id => document.getElementById(id);

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Very small in-browser "FTS" — case-insensitive substring match, ranked by occurrence count. */
function searchItems(items, query, getFields) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return items
    .map(item => {
      const text = getFields(item).join(' ').toLowerCase();
      const score = terms.reduce((s, t) => {
        let idx = 0, count = 0;
        while ((idx = text.indexOf(t, idx)) !== -1) { count++; idx += t.length; }
        return s + count;
      }, 0);
      return { item, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.item);
}

function highlight(text, query) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return escHtml(text);
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return escHtml(text).replace(re, '<mark>$1</mark>');
}

function snippet(body, query, maxLen = 160) {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length || !body) return '';
  const lower = body.toLowerCase();
  let best = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return escHtml(body.slice(0, maxLen));
  const start = Math.max(0, best - 60);
  const end   = Math.min(body.length, start + maxLen);
  const raw   = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
  return highlight(raw, query);
}

// ── Render results ─────────────────────────────────────────────────────────

/**
 * @param {string}   query
 * @param {Note[]}   notes
 * @param {Citation[]} citations
 * @param {Function} onNoteClick     - (note) => void
 * @param {Function} onCitationClick - (citation) => void
 */
function renderResults(query, notes, citations, onNoteClick, onCitationClick) {
  const container = $('search-results');
  if (!container) return;

  if (!notes.length && !citations.length) {
    container.innerHTML = '<p class="search-empty">No results.</p>';
    return;
  }

  const sections = [];

  if (notes.length) {
    const items = notes.map(n => `
      <li class="search-result-item" data-type="note" data-id="${escHtml(String(n.id))}">
        <span class="sr-type-badge">Note</span>
        <span class="sr-title">${highlight(n.title || 'Untitled', query)}</span>
        <p class="sr-snippet">${snippet(n.body, query)}</p>
      </li>
    `).join('');
    sections.push(`<ul class="search-result-list">${items}</ul>`);
  }

  if (citations.length) {
    const items = citations.map(c => {
      const auth = (c.authors ?? []).slice(0, 2).map(a => a.split(',')[0]).join(', ');
      return `
        <li class="search-result-item" data-type="citation" data-citekey="${escHtml(c.citekey)}">
          <span class="sr-type-badge sr-type-cite">Citation</span>
          <span class="sr-title">${highlight(c.title || c.citekey, query)}</span>
          <p class="sr-snippet">${highlight(auth + (c.year ? ` (${c.year})` : ''), query)}</p>
        </li>
      `;
    }).join('');
    sections.push(`<ul class="search-result-list">${items}</ul>`);
  }

  container.innerHTML = sections.join('');

  container.querySelectorAll('.search-result-item').forEach(li => {
    li.addEventListener('click', async () => {
      if (li.dataset.type === 'note') {
        const notes = await _storage.listNotes();
        const n = notes.find(n => String(n.id) === li.dataset.id);
        if (n) onNoteClick(n);
      } else {
        const c = await _storage.getCitation(li.dataset.citekey);
        if (c) onCitationClick(c);
      }
    });
  });
}

// ── Debounced search ───────────────────────────────────────────────────────

let _searchTimer = null;

async function runSearch(query, onNoteClick, onCitationClick) {
  if (!query.trim()) {
    const container = $('search-results');
    if (container) container.innerHTML = '';
    return;
  }

  const [allNotes, allCitations] = await Promise.all([
    _storage.listNotes(),
    _storage.listCitations(),
  ]);

  const matchedNotes = searchItems(allNotes, query,
    n => [n.title ?? '', n.body ?? '']);
  const matchedCites = searchItems(allCitations, query,
    c => [c.title ?? '', c.citekey, ...(c.authors ?? [])]);

  renderResults(query, matchedNotes, matchedCites, onNoteClick, onCitationClick);
}

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * @param {StorageBackend} storage
 * @param {object} callbacks
 * @param {Function} callbacks.onNoteClick     - called when user clicks a note result
 * @param {Function} callbacks.onCitationClick - called when user clicks a citation result
 */
export function initSearch(storage, { onNoteClick, onCitationClick } = {}) {
  _storage = storage;

  $('global-search')?.addEventListener('input', e => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(
      () => runSearch(e.target.value, onNoteClick, onCitationClick), 250
    );
  });
}
