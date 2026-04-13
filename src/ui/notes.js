/**
 * Notes panel UI module.
 *
 * Manages the left-panel note list, the note editor view (title + tags + CodeMirror),
 * the live preview panel, and print/PDF output.
 *
 * Depends on: storage backend (injected), createEditor, renderFull, printNote.
 */

import { createEditor, setEditorContent, getEditorContent } from './editor.js';
import { renderFull, extractCitekeys } from '../services/markdown.js';
import { printNote, themeList } from '../services/pdf.js';

// ── State ──────────────────────────────────────────────────────────────────

let _storage    = null;
let _editorView = null;
let _currentNote = null;   // full note object being edited
let _notes       = [];     // cached list for sidebar

// DOM refs (populated by init())
const $ = id => document.getElementById(id);

// ── Helpers ────────────────────────────────────────────────────────────────

function tagsFromString(str) {
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function tagsToString(arr) {
  return (arr ?? []).join(', ');
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function renderNoteItem(note, activeId) {
  const li = document.createElement('li');
  li.className = 'item' + (note.id === activeId ? ' active' : '');
  li.dataset.id = note.id;
  li.innerHTML = `
    <span class="item-title">${escHtml(note.title || 'Untitled')}</span>
    <span class="item-meta">${escHtml(note.updated_at?.slice(0, 10) ?? '')}</span>
  `;
  return li;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Live preview ───────────────────────────────────────────────────────────

async function updatePreview(markdown) {
  const previewEl = $('note-preview');
  if (!previewEl) return;

  // Collect citations for rendering
  const citekeys = extractCitekeys(markdown);
  const citationMap = new Map();
  if (citekeys.length) {
    const all = await _storage.listCitations();
    for (const c of all) {
      if (citekeys.includes(c.citekey)) citationMap.set(c.citekey, c);
    }
  }
  previewEl.innerHTML = renderFull(markdown, citationMap, 'authoryear');
  // Make internal note-links clickable
  previewEl.querySelectorAll('a.note-link[data-slug]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const slug = a.dataset.slug;
      const note = _notes.find(n => n.slug === slug);
      if (note) openNote(note);
    });
  });
}

// ── List ───────────────────────────────────────────────────────────────────

async function refreshList(filterText = '') {
  _notes = await _storage.listNotes();
  const filtered = filterText
    ? _notes.filter(n =>
        n.title.toLowerCase().includes(filterText.toLowerCase()) ||
        (n.body ?? '').toLowerCase().includes(filterText.toLowerCase()))
    : _notes;

  const listEl = $('note-list');
  listEl.innerHTML = '';
  filtered.forEach(note => {
    const li = renderNoteItem(note, _currentNote?.id);
    li.addEventListener('click', () => openNote(note));
    listEl.appendChild(li);
  });
}

// ── Open / edit ────────────────────────────────────────────────────────────

async function openNote(note) {
  _currentNote = note;
  $('welcome-screen')?.classList.add('hidden');
  $('note-editor')?.classList.remove('hidden');
  $('citation-editor')?.classList.add('hidden');
  $('right-note-info')?.classList.remove('hidden');
  $('right-cite-info')?.classList.add('hidden');

  $('note-title').value = note.title ?? '';
  $('note-tags').value  = tagsToString(note.tags);
  $('word-count').textContent = `${wordCount(note.body ?? '')} words`;

  if (_editorView) {
    setEditorContent(_editorView, note.body ?? '');
  }

  // Refresh sidebar highlight
  document.querySelectorAll('#note-list .item').forEach(li => {
    li.classList.toggle('active', li.dataset.id === String(note.id));
  });

  await updatePreview(note.body ?? '');
}

// ── Save ───────────────────────────────────────────────────────────────────

async function saveCurrentNote(body) {
  if (!_currentNote && !$('note-title').value.trim()) return;

  const title = $('note-title').value.trim() || 'Untitled';
  const tags  = tagsFromString($('note-tags').value);

  const saved = await _storage.saveNote({
    ..._currentNote,
    title,
    body: body ?? getEditorContent(_editorView),
    tags,
  });

  const isNew = !_currentNote?.id;
  _currentNote = saved;

  showToast('Saved');
  $('word-count').textContent = `${wordCount(saved.body)} words`;
  await refreshList($('note-search').value);

  if (isNew) {
    // Highlight new note in list
    document.querySelectorAll('#note-list .item').forEach(li => {
      li.classList.toggle('active', li.dataset.id === String(saved.id));
    });
  }

  await updatePreview(saved.body);
}

// ── New note ───────────────────────────────────────────────────────────────

async function newNote() {
  _currentNote = null;
  $('welcome-screen')?.classList.add('hidden');
  $('note-editor')?.classList.remove('hidden');
  $('citation-editor')?.classList.add('hidden');
  $('right-note-info')?.classList.remove('hidden');
  $('right-cite-info')?.classList.add('hidden');

  $('note-title').value = '';
  $('note-tags').value  = '';
  $('word-count').textContent = '0 words';

  if (_editorView) setEditorContent(_editorView, '');
  $('note-title').focus();
  document.querySelectorAll('#note-list .item').forEach(li => li.classList.remove('active'));

  const previewEl = $('note-preview');
  if (previewEl) previewEl.innerHTML = '';
}

// ── Delete ─────────────────────────────────────────────────────────────────

async function deleteCurrentNote() {
  if (!_currentNote?.id) return;
  if (!confirm(`Delete "${_currentNote.title}"?`)) return;
  await _storage.deleteNote(_currentNote.id);
  _currentNote = null;
  $('note-editor')?.classList.add('hidden');
  $('welcome-screen')?.classList.remove('hidden');
  await refreshList();
  showToast('Note deleted');
}

// ── Print ──────────────────────────────────────────────────────────────────

async function printCurrentNote() {
  if (!_editorView) return;
  const body    = getEditorContent(_editorView);
  const title   = $('note-title').value.trim() || 'Untitled';
  const themeId = $('print-theme-select')?.value ?? 'academic';
  const author  = $('compile-author')?.value ?? '';

  const citekeys = extractCitekeys(body);
  const citationMap = new Map();
  if (citekeys.length) {
    const all = await _storage.listCitations();
    for (const c of all) citationMap.set(c.citekey, c);
  }

  const html = renderFull(body, citationMap, 'authoryear');
  printNote(html, title, themeId, author);
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
 * Initialise the notes panel.
 *
 * @param {StorageBackend} storage
 * @param {object} callbacks
 * @param {Function} callbacks.getCitations - async () => Citation[]
 */
export async function initNotes(storage, { getCitations } = {}) {
  _storage = storage;

  // Populate print theme selector
  const themeSelect = $('print-theme-select');
  if (themeSelect) {
    themeList().forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      themeSelect.appendChild(opt);
    });
  }

  // Create CodeMirror editor
  const mountEl = $('cm-editor-mount');
  if (mountEl) {
    _editorView = createEditor(mountEl, {
      initialDoc:   '',
      getNotes:     () => _storage.listNotes(),
      getCitations: getCitations ?? (() => _storage.listCitations()),
      onSave:       body => saveCurrentNote(body),
      onUpdate:     count => {
        $('word-count').textContent = `${count} words`;
        // Debounce preview refresh
        clearTimeout(_editorView._previewTimer);
        _editorView._previewTimer = setTimeout(
          () => updatePreview(getEditorContent(_editorView)), 600
        );
      },
    });
  }

  // Bind UI events
  $('new-note-btn')?.addEventListener('click', newNote);
  $('save-btn')?.addEventListener('click', () => saveCurrentNote());
  $('delete-note-btn')?.addEventListener('click', deleteCurrentNote);
  $('print-btn')?.addEventListener('click', printCurrentNote);

  $('note-search')?.addEventListener('input', e => refreshList(e.target.value));

  // Note title: save on Enter
  $('note-title')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _editorView?.focus(); }
  });

  await refreshList();
}

export { openNote, refreshList as refreshNoteList };
