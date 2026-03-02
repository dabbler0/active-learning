/**
 * Philosophy Notes — Citations panel and add-citation modal.
 */

let _api, _toast, _openNote;
let currentCitekey = null;

// ── Init ─────────────────────────────────────────────────────────────────────
export function initCitations({ api, toast, openNote }) {
  _api = api;
  _toast = toast;
  _openNote = openNote;

  document.getElementById('new-cite-btn').addEventListener('click', openAddModal);
  document.getElementById('cancel-cite-btn').addEventListener('click', closeAddModal);
  document.getElementById('parse-cite-btn').addEventListener('click', parseCitation);
  document.getElementById('confirm-cite-btn').addEventListener('click', confirmCitation);

  // Search
  let searchTimer = null;
  document.getElementById('cite-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCitationList(e.target.value), 300);
  });

  // Citation editor save buttons
  document.getElementById('save-cite-btn').addEventListener('click', saveCurrentCitation);
  document.getElementById('save-cite-note-btn').addEventListener('click', saveCurrentCitationNote);

  // Close modal on backdrop click
  document.getElementById('add-cite-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-cite-modal')) closeAddModal();
  });
}

// ── Citation list ─────────────────────────────────────────────────────────────
export async function loadCitationList(q = '') {
  const url = q ? `/citations?q=${encodeURIComponent(q)}&limit=100` : '/citations?limit=100';
  const { citations } = await _api(url);
  renderCitationList(citations);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderCitationList(citations) {
  const ul = document.getElementById('cite-list');
  ul.innerHTML = '';
  if (!citations.length) {
    ul.innerHTML = '<li style="padding:12px;color:var(--text2);font-size:12px">No citations yet. Click + Citation to add one.</li>';
    return;
  }
  citations.forEach(c => {
    const li = document.createElement('li');
    if (c.citekey === currentCitekey) li.classList.add('active');
    const authorStr = c.authors.length ? c.authors[0].split(',')[0] : '';
    const meta = [authorStr, c.year, c.entry_type].filter(Boolean).join(' · ');
    li.innerHTML = `
      <div class="item-title">${esc(c.title || c.citekey)}</div>
      <div class="item-meta">${esc(meta)} &nbsp;<code style="font-size:10px">${esc(c.citekey)}</code></div>
      ${c.tags.length ? `<div class="item-tags">${c.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    `;
    li.addEventListener('click', () => openCitation(c.citekey));
    ul.appendChild(li);
  });
}

// ── Open a citation ──────────────────────────────────────────────────────────
async function openCitation(citekey) {
  currentCitekey = citekey;
  const cite = await _api(`/citations/${citekey}`);

  // Show citation editor panel
  const noteEditor = document.getElementById('note-editor');
  const citEditor = document.getElementById('citation-editor');
  const welcome = document.getElementById('welcome-screen');
  noteEditor.classList.add('hidden');
  welcome.classList.add('hidden');
  citEditor.classList.remove('hidden');

  document.getElementById('cite-title-display').textContent = cite.title || cite.citekey;
  document.getElementById('cite-citekey-display').textContent = cite.citekey;
  document.getElementById('cite-bibtex-edit').value = cite.bibtex_raw;
  document.getElementById('cite-tags').value = cite.tags.join(', ');
  document.getElementById('cite-note-edit').value = cite.note_body || '';

  // Right panel
  document.getElementById('right-note-info').classList.add('hidden');
  const rightCite = document.getElementById('right-cite-info');
  rightCite.classList.remove('hidden');

  const dl = document.getElementById('cite-detail-list');
  dl.innerHTML = '';
  const fields = [
    ['Type', cite.entry_type],
    ['Authors', cite.authors.join('; ')],
    ['Year', cite.year],
    ['DOI', cite.doi],
    ['ISBN', cite.isbn],
  ];
  fields.forEach(([k, v]) => {
    if (v) {
      dl.innerHTML += `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`;
    }
  });

  // Update active state in list
  document.querySelectorAll('#cite-list li').forEach(li => li.classList.remove('active'));
}

// ── Save citation edits ────────────────────────────────────────────────────────
async function saveCurrentCitation() {
  if (!currentCitekey) return;
  const bibtex = document.getElementById('cite-bibtex-edit').value.trim();
  const tags = document.getElementById('cite-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  try {
    const updated = await _api(`/citations/${currentCitekey}`, {
      method: 'PUT',
      body: { bibtex_raw: bibtex, tags },
    });
    currentCitekey = updated.citekey;
    document.getElementById('cite-title-display').textContent = updated.title || updated.citekey;
    document.getElementById('cite-citekey-display').textContent = updated.citekey;
    await loadCitationList(document.getElementById('cite-search').value);
    _toast('Citation saved');
  } catch (e) {
    _toast(`Error: ${e.message}`);
  }
}

async function saveCurrentCitationNote() {
  if (!currentCitekey) return;
  const body = document.getElementById('cite-note-edit').value;
  try {
    await _api(`/citations/${currentCitekey}/note`, { method: 'PUT', body: { body } });
    _toast('Annotation saved');
  } catch (e) {
    _toast(`Error: ${e.message}`);
  }
}

// ── Add citation modal ─────────────────────────────────────────────────────────
function openAddModal() {
  document.getElementById('add-cite-modal').classList.remove('hidden');
  document.getElementById('add-cite-input').value = '';
  document.getElementById('add-cite-parsed').classList.add('hidden');
  document.getElementById('add-cite-bibtex').value = '';
  document.getElementById('add-cite-warnings').classList.add('hidden');
  document.getElementById('add-cite-warnings').textContent = '';
  document.getElementById('confirm-cite-btn').classList.add('hidden');
  document.getElementById('parse-cite-btn').classList.remove('hidden');
  document.getElementById('add-cite-input').focus();
}

function closeAddModal() {
  document.getElementById('add-cite-modal').classList.add('hidden');
}

let _pendingParsed = null;

async function parseCitation() {
  const raw = document.getElementById('add-cite-input').value.trim();
  if (!raw) { _toast('Please enter a citation'); return; }

  const btn = document.getElementById('parse-cite-btn');
  btn.textContent = 'Parsing…';
  btn.disabled = true;

  try {
    const result = await _api('/citations', { method: 'POST', body: { raw_input: raw } });
    _pendingParsed = result.citation;

    // Show parsed bibtex for user to review/edit
    document.getElementById('add-cite-bibtex').value = result.citation.bibtex_raw;
    document.getElementById('add-cite-parsed').classList.remove('hidden');

    const warningsEl = document.getElementById('add-cite-warnings');
    if (result.warnings && result.warnings.length) {
      warningsEl.textContent = result.warnings.join(' ');
      warningsEl.classList.remove('hidden');
    } else {
      warningsEl.classList.add('hidden');
    }

    document.getElementById('parse-cite-btn').classList.add('hidden');
    document.getElementById('confirm-cite-btn').classList.remove('hidden');

    // Reload citation list and open the new citation
    await loadCitationList();
    closeAddModal();
    openCitation(result.citation.citekey);
    _toast(`Added: ${result.citation.citekey}`);
  } catch (e) {
    _toast(`Parse error: ${e.message}`);
  } finally {
    btn.textContent = 'Parse';
    btn.disabled = false;
  }
}

async function confirmCitation() {
  // The citation was already created by parseCitation (POST /citations).
  // If user edited the bibtex, update it.
  if (!_pendingParsed) { closeAddModal(); return; }
  const editedBibtex = document.getElementById('add-cite-bibtex').value.trim();
  if (editedBibtex !== _pendingParsed.bibtex_raw) {
    try {
      await _api(`/citations/${_pendingParsed.citekey}`, {
        method: 'PUT',
        body: { bibtex_raw: editedBibtex },
      });
    } catch (e) {
      _toast(`Update error: ${e.message}`);
    }
  }
  _pendingParsed = null;
  closeAddModal();
  await loadCitationList();
}
