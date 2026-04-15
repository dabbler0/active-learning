/**
 * Citations panel UI module.
 *
 * Manages:
 *  - Left-panel citation list with search filter
 *  - Citation detail/editor view (right)
 *  - "Add Citation" modal with two panes:
 *      • Search (default) — queries OpenAlex by title/author/DOI
 *      • Manual Entry     — accepts BibTeX / DOI / ISBN / free-text
 *
 * openAddModal() is exported so the note editor can open it inline when
 * the user types [@ and picks "+ Create new citation" from autocomplete.
 * An optional onInsert callback receives the saved citekey, allowing the
 * editor to insert [@citekey] at the cursor position automatically.
 */

import { parseCitation } from '../services/bibtex.js';
import { searchOpenAlex, openAlexToCitation } from '../services/openalex.js';

// ── State ──────────────────────────────────────────────────────────────────

let _storage     = null;
let _currentCite = null;
let _citations   = [];
let _settings    = { crossrefEnabled: true, openlibraryEnabled: true };

// Modal state
let _parsedResult         = null;      // manual-entry parsed result
let _openAlexResults      = [];        // last OpenAlex search results
let _selectedOpenAlexWork = null;      // result the user clicked on
let _insertCallback       = null;      // set when opened from the note editor

const $ = id => document.getElementById(id);

// ── Helpers ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tagsFromString(str) {
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function tagsToString(arr) {
  return (arr ?? []).join(', ');
}

function renderCiteItem(c, activeKey) {
  const li = document.createElement('li');
  li.className = 'item' + (c.citekey === activeKey ? ' active' : '');
  li.dataset.citekey = c.citekey;

  const authors = (c.authors ?? []).slice(0, 2).map(a => a.split(',')[0]).join(', ');
  const yr = c.year ? ` (${c.year})` : '';
  li.innerHTML = `
    <span class="item-title">${escHtml(c.title || c.citekey)}</span>
    <span class="item-meta">${escHtml(authors + yr)}</span>
  `;
  return li;
}

// ── List ───────────────────────────────────────────────────────────────────

async function refreshList(filterText = '') {
  _citations = await _storage.listCitations();
  const filtered = filterText
    ? _citations.filter(c =>
        (c.title ?? '').toLowerCase().includes(filterText.toLowerCase()) ||
        c.citekey.toLowerCase().includes(filterText.toLowerCase()) ||
        (c.authors ?? []).some(a => a.toLowerCase().includes(filterText.toLowerCase())))
    : _citations;

  const listEl = $('cite-list');
  listEl.innerHTML = '';
  filtered.forEach(c => {
    const li = renderCiteItem(c, _currentCite?.citekey);
    li.addEventListener('click', () => openCitation(c));
    listEl.appendChild(li);
  });
}

// ── Open / edit ────────────────────────────────────────────────────────────

function openCitation(c) {
  _currentCite = c;
  $('welcome-screen')?.classList.add('hidden');
  $('note-editor')?.classList.add('hidden');
  $('citation-editor')?.classList.remove('hidden');
  $('right-note-info')?.classList.add('hidden');
  $('right-cite-info')?.classList.remove('hidden');

  $('cite-title-display').textContent = c.title || c.citekey;
  $('cite-citekey-display').textContent = c.citekey;
  $('cite-bibtex-edit').value  = c.bibtex_raw ?? '';
  $('cite-tags').value          = tagsToString(c.tags);
  $('cite-note-edit').value     = c.note_body ?? '';

  populateDetailList(c);

  document.querySelectorAll('#cite-list .item').forEach(li => {
    li.classList.toggle('active', li.dataset.citekey === c.citekey);
  });
}

function populateDetailList(c) {
  const dl = $('cite-detail-list');
  if (!dl) return;
  const fields = [
    ['Type',     c.entry_type],
    ['Authors',  (c.authors ?? []).join('; ')],
    ['Year',     c.year],
    ['DOI',      c.doi],
    ['ISBN',     c.isbn],
    ['Citekey',  c.citekey],
    ['Added',    c.created_at?.slice(0, 10)],
  ].filter(([, v]) => v);

  dl.innerHTML = fields.map(([k, v]) =>
    `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`
  ).join('');
}

// ── Save / delete ──────────────────────────────────────────────────────────

async function saveCurrentCitation() {
  if (!_currentCite) return;
  const bibtex = $('cite-bibtex-edit').value.trim();
  const tags   = tagsFromString($('cite-tags').value);

  let citekey = _currentCite.citekey;
  const m = bibtex.match(/@\w+\s*\{\s*([^,]+),/);
  if (m) citekey = m[1].trim();

  const saved = await _storage.saveCitation({
    ..._currentCite,
    citekey,
    bibtex_raw: bibtex,
    tags,
  });
  _currentCite = saved;
  $('cite-title-display').textContent  = saved.title || saved.citekey;
  $('cite-citekey-display').textContent = saved.citekey;
  showToast('Citation saved');
  await refreshList($('cite-search').value);
}

async function saveCurrentAnnotation() {
  if (!_currentCite) return;
  const note_body = $('cite-note-edit').value;
  const saved = await _storage.saveCitation({ ..._currentCite, note_body });
  _currentCite = saved;
  showToast('Annotation saved');
}

async function deleteCurrentCitation() {
  if (!_currentCite) return;
  if (!confirm(`Delete citation "${_currentCite.citekey}"?`)) return;
  await _storage.deleteCitation(_currentCite.citekey);
  _currentCite = null;
  $('citation-editor')?.classList.add('hidden');
  $('welcome-screen')?.classList.remove('hidden');
  await refreshList();
  showToast('Citation deleted');
}

// ── Modal — shared helpers ─────────────────────────────────────────────────

/**
 * Open the "Add Citation" modal.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.prefillQuery]  - pre-populate the OpenAlex search bar
 * @param {Function} [opts.onInsert]      - called with citekey after save;
 *                                          when provided, the citation panel is
 *                                          NOT opened (caller handles insertion)
 */
export function openAddModal({ prefillQuery = '', onInsert = null } = {}) {
  _insertCallback = onInsert;

  $('add-cite-modal')?.classList.remove('hidden');

  // Always start on the search pane
  activateCitePane('search');

  // Reset search pane
  const q = $('cite-openalex-q');
  if (q) q.value = prefillQuery;
  $('cite-search-status')?.classList.add('hidden');
  if ($('cite-openalex-results')) $('cite-openalex-results').innerHTML = '';
  $('cite-openalex-preview')?.classList.add('hidden');
  _openAlexResults = [];
  _selectedOpenAlexWork = null;

  // Reset manual pane
  if ($('add-cite-input'))    $('add-cite-input').value = '';
  $('add-cite-parsed')?.classList.add('hidden');
  if ($('add-cite-bibtex'))   $('add-cite-bibtex').value = '';
  if ($('add-cite-warnings')) { $('add-cite-warnings').textContent = ''; }
  $('add-cite-warnings')?.classList.add('hidden');
  $('confirm-cite-btn')?.classList.add('hidden');
  $('parse-cite-btn')?.classList.remove('hidden');
  _parsedResult = null;

  // If a query was supplied, kick off the search immediately
  if (prefillQuery) {
    runOpenAlexSearch();
  } else {
    q?.focus();
  }
}

function closeAddModal() {
  $('add-cite-modal')?.classList.add('hidden');
  _insertCallback = null;
}

function activateCitePane(pane) {
  // Toggle tab buttons
  document.querySelectorAll('.cite-modal-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pane === pane);
  });
  // Toggle panes
  $('cite-pane-search')?.classList.toggle('hidden', pane !== 'search');
  $('cite-pane-manual')?.classList.toggle('hidden', pane !== 'manual');
}

/**
 * Shared post-save logic: close modal, refresh list, fire insert callback or
 * open the newly saved citation in the detail view.
 */
async function finalizeSave(citekey) {
  const cb = _insertCallback;
  _insertCallback = null;

  closeAddModal();
  await refreshList();
  showToast(`Citation "${citekey}" added`);

  if (cb) {
    cb(citekey);
  } else {
    const c = await _storage.getCitation(citekey);
    if (c) openCitation(c);
  }
}

// ── Modal — OpenAlex search pane ──────────────────────────────────────────

async function runOpenAlexSearch() {
  const query = $('cite-openalex-q')?.value.trim();
  if (!query) return;

  const statusEl  = $('cite-search-status');
  const resultsEl = $('cite-openalex-results');
  const searchBtn = $('cite-openalex-search-btn');

  if (statusEl)  { statusEl.textContent = 'Searching OpenAlex…'; statusEl.classList.remove('hidden'); }
  if (resultsEl) resultsEl.innerHTML = '';
  $('cite-openalex-preview')?.classList.add('hidden');
  _selectedOpenAlexWork = null;
  if (searchBtn) searchBtn.disabled = true;

  try {
    _openAlexResults = await searchOpenAlex(query);

    if (!_openAlexResults.length) {
      if (statusEl) { statusEl.textContent = 'No results found. Try a different query.'; statusEl.classList.remove('hidden'); }
      return;
    }

    if (statusEl) statusEl.classList.add('hidden');
    renderOpenAlexResults();
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Search failed: ${err.message}`; statusEl.classList.remove('hidden'); }
  } finally {
    if (searchBtn) searchBtn.disabled = false;
  }
}

function renderOpenAlexResults() {
  const ul = $('cite-openalex-results');
  if (!ul) return;
  ul.innerHTML = '';

  _openAlexResults.forEach(work => {
    const li = document.createElement('li');
    li.className = 'cite-result-item';

    const surnames = (work.authorships ?? []).slice(0, 3)
      .map(a => {
        const name = a.author?.display_name ?? '';
        const parts = name.split(',');
        return parts.length > 1 ? parts[0].trim() : (name.split(' ').pop() ?? name);
      })
      .filter(Boolean);
    const authorStr = surnames.join(', ') + ((work.authorships?.length ?? 0) > 3 ? ' et al.' : '');
    const yr      = work.publication_year ?? '';
    const journal = work.primary_location?.source?.display_name ?? '';
    const metaParts = [authorStr + (yr ? ` (${yr})` : ''), journal].filter(Boolean);

    li.innerHTML = `
      <span class="cite-result-title">${escHtml(work.title ?? 'Untitled')}</span>
      <span class="cite-result-meta">${escHtml(metaParts.join(' · '))}</span>
    `;
    li.addEventListener('click', () => selectOpenAlexWork(work, li));
    ul.appendChild(li);
  });
}

function selectOpenAlexWork(work, liEl) {
  _selectedOpenAlexWork = work;

  // Highlight
  $('cite-openalex-results')?.querySelectorAll('.cite-result-item').forEach(el => {
    el.classList.remove('active');
  });
  liEl.classList.add('active');

  // Show preview
  const previewEl = $('cite-openalex-preview');
  if (!previewEl) return;

  const authors = (work.authorships ?? [])
    .map(a => a.author?.display_name ?? '')
    .filter(Boolean);
  const authorStr = authors.slice(0, 3).join('; ') + (authors.length > 3 ? ' et al.' : '');
  const yr      = work.publication_year ?? '';
  const journal = work.primary_location?.source?.display_name ?? '';
  const metaParts = [authorStr, yr ? String(yr) : '', journal].filter(Boolean);

  const titleEl = $('cite-preview-title');
  const metaEl  = $('cite-preview-meta');
  if (titleEl) titleEl.textContent = work.title ?? 'Untitled';
  if (metaEl)  metaEl.textContent  = metaParts.join(' · ');

  previewEl.classList.remove('hidden');
}

async function saveOpenAlexWork() {
  if (!_selectedOpenAlexWork) return;

  const existingKeys = new Set(_citations.map(c => c.citekey));
  const citation = openAlexToCitation(_selectedOpenAlexWork, existingKeys);

  await _storage.saveCitation(citation);
  await finalizeSave(citation.citekey);
}

// ── Modal — Manual entry pane ─────────────────────────────────────────────

async function parseCiteInput() {
  const raw = $('add-cite-input')?.value.trim();
  if (!raw) return;

  const btn = $('parse-cite-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Parsing…'; }

  try {
    const existingKeys = new Set(_citations.map(c => c.citekey));
    _parsedResult = await parseCitation(raw, {
      existingKeys,
      crossrefEnabled:    _settings.crossrefEnabled,
      openlibraryEnabled: _settings.openlibraryEnabled,
    });

    if ($('add-cite-bibtex')) $('add-cite-bibtex').value = _parsedResult.bibtex_raw ?? '';
    $('add-cite-parsed')?.classList.remove('hidden');

    if (_parsedResult.warnings?.length) {
      if ($('add-cite-warnings')) $('add-cite-warnings').textContent = _parsedResult.warnings.join('\n');
      $('add-cite-warnings')?.classList.remove('hidden');
    } else {
      $('add-cite-warnings')?.classList.add('hidden');
    }

    $('confirm-cite-btn')?.classList.remove('hidden');
    $('parse-cite-btn')?.classList.add('hidden');
  } catch (err) {
    alert(`Parse error: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Parse'; }
  }
}

async function confirmCiteSave() {
  if (!_parsedResult) return;

  const editedBibtex = $('add-cite-bibtex')?.value.trim();
  const m = editedBibtex?.match(/@\w+\s*\{\s*([^,]+),/);
  const citekey = m ? m[1].trim() : _parsedResult.citekey;

  await _storage.saveCitation({
    ..._parsedResult,
    citekey,
    bibtex_raw: editedBibtex,
  });

  await finalizeSave(citekey);
}

// ── Toast ──────────────────────────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 2000);
}

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialise the citations panel.
 *
 * @param {StorageBackend} storage
 * @param {object} [settings]
 * @param {boolean} [settings.crossrefEnabled]
 * @param {boolean} [settings.openlibraryEnabled]
 */
export async function initCitations(storage, settings = {}) {
  _storage  = storage;
  _settings = { ..._settings, ...settings };

  // ── List panel ──
  $('new-cite-btn')?.addEventListener('click', () => openAddModal());
  $('cite-search')?.addEventListener('input', e => refreshList(e.target.value));

  // ── Detail / editor ──
  $('save-cite-btn')?.addEventListener('click',      saveCurrentCitation);
  $('save-cite-note-btn')?.addEventListener('click', saveCurrentAnnotation);
  $('delete-cite-btn')?.addEventListener('click',    deleteCurrentCitation);

  // ── Modal — tab switching ──
  document.querySelectorAll('.cite-modal-tab').forEach(btn => {
    btn.addEventListener('click', () => activateCitePane(btn.dataset.pane));
  });

  // ── Modal — search pane ──
  $('cite-openalex-search-btn')?.addEventListener('click', runOpenAlexSearch);
  $('cite-openalex-q')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runOpenAlexSearch();
  });
  $('cite-openalex-save-btn')?.addEventListener('click', saveOpenAlexWork);
  $('cite-openalex-back-btn')?.addEventListener('click', () => {
    $('cite-openalex-preview')?.classList.add('hidden');
    $('cite-openalex-results')?.querySelectorAll('.cite-result-item').forEach(el => {
      el.classList.remove('active');
    });
    _selectedOpenAlexWork = null;
  });

  // ── Modal — manual pane ──
  $('parse-cite-btn')?.addEventListener('click',   parseCiteInput);
  $('confirm-cite-btn')?.addEventListener('click', confirmCiteSave);

  // ── Modal — cancel / backdrop ──
  $('cancel-cite-btn')?.addEventListener('click', closeAddModal);
  $('add-cite-modal')?.addEventListener('click', e => {
    if (e.target === $('add-cite-modal')) closeAddModal();
  });

  await refreshList();
}

export function updateCitationSettings(settings) {
  _settings = { ..._settings, ...settings };
}

export { refreshList as refreshCitationList, openCitation };
