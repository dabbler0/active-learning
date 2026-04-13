/**
 * Citations panel UI module.
 *
 * Manages:
 *  - Left-panel citation list with search filter
 *  - Citation detail/editor view (right)
 *  - "Add Citation" modal (BibTeX / DOI / ISBN / free-text input → parse → confirm)
 */

import { parseCitation } from '../services/bibtex.js';

// ── State ──────────────────────────────────────────────────────────────────

let _storage     = null;
let _currentCite = null;
let _citations   = [];
let _settings    = { crossrefEnabled: true, openlibraryEnabled: true };

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

  // Populate detail list
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

// ── Save ───────────────────────────────────────────────────────────────────

async function saveCurrentCitation() {
  if (!_currentCite) return;
  const bibtex = $('cite-bibtex-edit').value.trim();
  const tags   = tagsFromString($('cite-tags').value);

  // Re-parse citekey from edited BibTeX if possible
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

// ── Delete ─────────────────────────────────────────────────────────────────

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

// ── Add Citation modal ─────────────────────────────────────────────────────

let _parsedResult = null;

function openAddModal() {
  $('add-cite-modal')?.classList.remove('hidden');
  $('add-cite-input').value = '';
  $('add-cite-parsed')?.classList.add('hidden');
  $('add-cite-bibtex').value = '';
  $('add-cite-warnings').textContent = '';
  $('add-cite-warnings')?.classList.add('hidden');
  $('confirm-cite-btn')?.classList.add('hidden');
  $('parse-cite-btn')?.classList.remove('hidden');
  _parsedResult = null;
  $('add-cite-input').focus();
}

function closeAddModal() {
  $('add-cite-modal')?.classList.add('hidden');
}

async function parseCiteInput() {
  const raw = $('add-cite-input').value.trim();
  if (!raw) return;

  $('parse-cite-btn').disabled = true;
  $('parse-cite-btn').textContent = 'Parsing…';

  try {
    const existingKeys = new Set(_citations.map(c => c.citekey));
    _parsedResult = await parseCitation(raw, {
      existingKeys,
      crossrefEnabled:    _settings.crossrefEnabled,
      openlibraryEnabled: _settings.openlibraryEnabled,
    });

    $('add-cite-bibtex').value = _parsedResult.bibtex_raw ?? '';
    $('add-cite-parsed')?.classList.remove('hidden');

    if (_parsedResult.warnings?.length) {
      $('add-cite-warnings').textContent = _parsedResult.warnings.join('\n');
      $('add-cite-warnings')?.classList.remove('hidden');
    } else {
      $('add-cite-warnings')?.classList.add('hidden');
    }

    $('confirm-cite-btn')?.classList.remove('hidden');
    $('parse-cite-btn')?.classList.add('hidden');
  } catch (err) {
    alert(`Parse error: ${err.message}`);
  } finally {
    $('parse-cite-btn').disabled = false;
    $('parse-cite-btn').textContent = 'Parse';
  }
}

async function confirmCiteSave() {
  if (!_parsedResult) return;

  // Use the (possibly hand-edited) BibTeX from the textarea
  const editedBibtex = $('add-cite-bibtex').value.trim();
  const m = editedBibtex.match(/@\w+\s*\{\s*([^,]+),/);
  const citekey = m ? m[1].trim() : _parsedResult.citekey;

  await _storage.saveCitation({
    ..._parsedResult,
    citekey,
    bibtex_raw: editedBibtex,
  });

  closeAddModal();
  await refreshList();
  showToast(`Citation "${citekey}" added`);

  // Open the newly saved citation
  const c = await _storage.getCitation(citekey);
  if (c) openCitation(c);
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

  $('new-cite-btn')?.addEventListener('click',     openAddModal);
  $('parse-cite-btn')?.addEventListener('click',   parseCiteInput);
  $('confirm-cite-btn')?.addEventListener('click', confirmCiteSave);
  $('cancel-cite-btn')?.addEventListener('click',  closeAddModal);

  // Allow dismiss by clicking the overlay backdrop
  $('add-cite-modal')?.addEventListener('click', e => {
    if (e.target === $('add-cite-modal')) closeAddModal();
  });

  $('save-cite-btn')?.addEventListener('click',      saveCurrentCitation);
  $('save-cite-note-btn')?.addEventListener('click', saveCurrentAnnotation);
  $('delete-cite-btn')?.addEventListener('click',    deleteCurrentCitation);

  $('cite-search')?.addEventListener('input', e => refreshList(e.target.value));

  await refreshList();
}

export function updateCitationSettings(settings) {
  _settings = { ..._settings, ...settings };
}

export { refreshList as refreshCitationList, openCitation };
