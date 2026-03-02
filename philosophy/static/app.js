/**
 * Philosophy Notes — Main application module.
 * Handles tab switching, note list, settings modal, and coordinates other modules.
 */

import { initEditor, setEditorContent, getEditorContent, destroyEditor } from './editor.js';
import { initCitations, loadCitationList } from './citations.js';
import { initSearch } from './search.js';

// ── Global state ─────────────────────────────────────────────────────────────
export const state = {
  activeTab: 'notes',
  currentNoteSlug: null,
  currentCitekey: null,
  notes: [],
  notesDirty: false,
  settings: {},
  templates: [],
};

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
export function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ── API helper ────────────────────────────────────────────────────────────────
export async function api(path, options = {}) {
  const resp = await fetch(`/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Note list ─────────────────────────────────────────────────────────────────
export async function loadNoteList(q = '') {
  const url = q ? `/notes?q=${encodeURIComponent(q)}&limit=100` : '/notes?limit=100';
  const { notes } = await api(url);
  state.notes = notes;
  renderNoteList(notes);
}

function renderNoteList(notes) {
  const ul = document.getElementById('note-list');
  ul.innerHTML = '';
  if (!notes.length) {
    ul.innerHTML = '<li style="padding:12px;color:var(--text2);font-size:12px">No notes yet. Click + Note to create one.</li>';
    return;
  }
  notes.forEach(n => {
    const li = document.createElement('li');
    if (n.slug === state.currentNoteSlug) li.classList.add('active');
    li.innerHTML = `
      <div class="item-title">${esc(n.title)}</div>
      <div class="item-meta">${n.updated_at.slice(0,10)}</div>
      ${n.tags.length ? `<div class="item-tags">${n.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    `;
    li.addEventListener('click', () => openNote(n.slug));
    ul.appendChild(li);
  });
}

export async function openNote(slug) {
  state.currentNoteSlug = slug;
  state.currentCitekey = null;

  try {
    const note = await api(`/notes/${slug}`);
    showEditorView('note');

    document.getElementById('note-title').value = note.title;
    document.getElementById('note-tags').value = note.tags.join(', ');
    setEditorContent(note.body);

    // Right panel
    document.getElementById('right-note-info').classList.remove('hidden');
    document.getElementById('right-cite-info').classList.add('hidden');

    renderBacklinks(note.backlinks);
    renderCitationsUsed(note.citations_used);

    // Mark list item active
    document.querySelectorAll('#note-list li').forEach(li => li.classList.remove('active'));
    const items = document.querySelectorAll('#note-list li');
    state.notes.forEach((n, i) => {
      if (n.slug === slug) items[i]?.classList.add('active');
    });
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

function renderBacklinks(backlinks) {
  const ul = document.getElementById('backlinks-list');
  ul.innerHTML = '';
  if (!backlinks.length) {
    ul.innerHTML = '<li style="color:var(--text2);font-size:12px">No backlinks</li>';
    return;
  }
  backlinks.forEach(b => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="#" data-slug="${esc(b.slug)}">${esc(b.title)}</a>`;
    li.querySelector('a').addEventListener('click', e => { e.preventDefault(); openNote(b.slug); });
    ul.appendChild(li);
  });
}

function renderCitationsUsed(citekeys) {
  const ul = document.getElementById('citations-used-list');
  ul.innerHTML = '';
  if (!citekeys.length) {
    ul.innerHTML = '<li style="color:var(--text2);font-size:12px">None</li>';
    return;
  }
  citekeys.forEach(k => {
    const li = document.createElement('li');
    li.innerHTML = `<code>${esc(k)}</code>`;
    ul.appendChild(li);
  });
}

// ── Save note ─────────────────────────────────────────────────────────────────
async function saveCurrentNote() {
  if (!state.currentNoteSlug) {
    await createNewNote();
    return;
  }
  const title = document.getElementById('note-title').value.trim();
  const body = getEditorContent();
  const tags = document.getElementById('note-tags').value.split(',').map(t => t.trim()).filter(Boolean);

  try {
    const updated = await api(`/notes/${state.currentNoteSlug}`, {
      method: 'PUT',
      body: { title, body, tags },
    });
    state.currentNoteSlug = updated.slug;
    renderBacklinks(updated.backlinks);
    renderCitationsUsed(updated.citations_used);
    state.notesDirty = false;
    await loadNoteList(document.getElementById('note-search').value);
    toast('Saved');
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  }
}

async function createNewNote() {
  const title = document.getElementById('note-title').value.trim() || 'Untitled';
  const body = getEditorContent();
  const tags = document.getElementById('note-tags').value.split(',').map(t => t.trim()).filter(Boolean);

  try {
    const note = await api('/notes', {
      method: 'POST',
      body: { title, body, tags },
    });
    state.currentNoteSlug = note.slug;
    await loadNoteList();
    toast('Note created');
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

// ── New note ──────────────────────────────────────────────────────────────────
function newNote() {
  state.currentNoteSlug = null;
  state.currentCitekey = null;
  showEditorView('note');
  document.getElementById('note-title').value = '';
  document.getElementById('note-tags').value = '';
  setEditorContent('');
  document.getElementById('right-note-info').classList.remove('hidden');
  document.getElementById('right-cite-info').classList.add('hidden');
  renderBacklinks([]);
  renderCitationsUsed([]);
  document.getElementById('note-title').focus();
}

// ── View switching ─────────────────────────────────────────────────────────────
function showEditorView(which) {
  document.getElementById('note-editor').classList.toggle('hidden', which !== 'note');
  document.getElementById('citation-editor').classList.toggle('hidden', which !== 'citation');
  document.getElementById('welcome-screen').classList.toggle('hidden', which !== 'welcome');
}

// ── Compile ───────────────────────────────────────────────────────────────────
let compileDropdownOpen = false;
document.getElementById('compile-btn').addEventListener('click', () => {
  compileDropdownOpen = !compileDropdownOpen;
  document.getElementById('compile-dropdown').classList.toggle('hidden', !compileDropdownOpen);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.compile-wrapper')) {
    document.getElementById('compile-dropdown').classList.add('hidden');
    compileDropdownOpen = false;
  }
});

document.getElementById('do-compile-btn').addEventListener('click', async () => {
  if (!state.currentNoteSlug) { toast('Save the note first'); return; }

  // Auto-save before compile
  await saveCurrentNote();

  const template = document.getElementById('template-select').value;
  const author = document.getElementById('compile-author').value.trim() || state.settings.default_author || '';
  const bibStyle = document.getElementById('bibstyle-select').value;

  const statusEl = document.getElementById('compile-status');
  const logWrapper = document.getElementById('compile-log-wrapper');
  const logEl = document.getElementById('compile-log');
  const pdfEl = document.getElementById('pdf-viewer');

  statusEl.textContent = 'Compiling…';
  statusEl.className = 'compiling';
  logWrapper.classList.add('hidden');
  pdfEl.classList.add('hidden');
  document.getElementById('compile-dropdown').classList.add('hidden');
  compileDropdownOpen = false;

  try {
    const result = await api('/compile', {
      method: 'POST',
      body: {
        note_slug: state.currentNoteSlug,
        template,
        author,
        bib_style: bibStyle,
      },
    });

    logEl.textContent = result.compile_log;
    logWrapper.classList.remove('hidden');

    if (result.success) {
      statusEl.textContent = '✓ Compiled successfully';
      statusEl.className = 'success';
      pdfEl.src = result.pdf_url;
      pdfEl.classList.remove('hidden');
    } else {
      statusEl.textContent = '✗ Compilation failed';
      statusEl.className = 'error';
    }
  } catch (e) {
    statusEl.textContent = `✗ Error: ${e.message}`;
    statusEl.className = 'error';
  }
});

// ── Templates ─────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { templates } = await api('/compile/templates');
  state.templates = templates;
  const sel = document.getElementById('template-select');
  const settingsSel = document.getElementById('s-template');
  sel.innerHTML = '';
  settingsSel.innerHTML = '';
  templates.forEach(t => {
    const opt = new Option(`${t.name} — ${t.description}`, t.name);
    sel.appendChild(opt.cloneNode(true));
    settingsSel.appendChild(opt);
  });
  if (state.settings.default_template) sel.value = state.settings.default_template;
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  state.settings = await api('/settings');
  document.getElementById('s-author').value = state.settings.default_author || '';
  document.getElementById('s-crossref').checked = state.settings.crossref_enabled !== 'false';
  document.getElementById('s-openlibrary').checked = state.settings.openlibrary_enabled !== 'false';
  if (state.settings.default_author) document.getElementById('compile-author').value = state.settings.default_author;
}

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.remove('hidden');
});
document.getElementById('cancel-settings-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.add('hidden');
});
document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const payload = {
    default_author: document.getElementById('s-author').value.trim(),
    default_template: document.getElementById('s-template').value,
    crossref_enabled: document.getElementById('s-crossref').checked,
    openlibrary_enabled: document.getElementById('s-openlibrary').checked,
  };
  try {
    state.settings = await api('/settings', { method: 'PUT', body: payload });
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('template-select').value = state.settings.default_template;
    toast('Settings saved');
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('notes-panel').classList.toggle('hidden', tab !== 'notes');
    document.getElementById('citations-panel').classList.toggle('hidden', tab !== 'citations');
    document.getElementById('search-panel').classList.toggle('hidden', tab !== 'search');
    if (tab === 'citations') loadCitationList();
  });
});

// ── Note search ───────────────────────────────────────────────────────────────
let noteSearchTimer = null;
document.getElementById('note-search').addEventListener('input', e => {
  clearTimeout(noteSearchTimer);
  noteSearchTimer = setTimeout(() => loadNoteList(e.target.value), 300);
});

// ── New note button ───────────────────────────────────────────────────────────
document.getElementById('new-note-btn').addEventListener('click', newNote);

// ── Save button + Ctrl+S ─────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', saveCurrentNote);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentNote();
  }
});

// ── Note title Enter key ──────────────────────────────────────────────────────
document.getElementById('note-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    // Focus the editor
    document.querySelector('.cm-editor')?.dispatchEvent(new MouseEvent('click'));
  }
});

// ── Escape closes modals ──────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('add-cite-modal').classList.add('hidden');
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('compile-dropdown').classList.add('hidden');
    compileDropdownOpen = false;
  }
});

// ── Export openNote for other modules ─────────────────────────────────────────
window.__app = { openNote, state, toast, api };

// ── Escape HTML ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  await loadTemplates();
  await loadNoteList();
  initEditor({
    mountId: 'cm-editor-mount',
    onSave: saveCurrentNote,
    onWordCount: (n) => { document.getElementById('word-count').textContent = `${n} word${n===1?'':'s'}`; },
  });
  initCitations({ api, toast, openNote: (slug) => openNote(slug) });
  initSearch({ api, toast, openNote: (slug) => openNote(slug) });
  showEditorView('welcome');
}

init().catch(e => console.error('Init error:', e));
