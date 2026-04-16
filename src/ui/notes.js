/**
 * Notes panel UI module.
 *
 * Manages the left-panel note list, the note editor view (title + tags +
 * either CodeMirror or Milkdown WYSIWYG), the live preview panel, and
 * print/PDF output.
 *
 * Editor modes
 * ────────────
 * • "codemirror" (default) — plain-text source with syntax highlighting.
 * • "milkdown"             — rich-text WYSIWYG; custom [[note:]] and [@cite]
 *   syntax is preserved in storage but rendered as atomic chips in the editor.
 *
 * The toggle button (#editor-mode-btn) switches between modes, transferring
 * the current content and persisting the preference to localStorage.
 *
 * Depends on: storage backend (injected), createEditor, renderFull, printNote,
 *             createMilkdownEditor.
 */

import { createEditor, setEditorContent, getEditorContent } from './editor.js';
import { createMilkdownEditor } from './milkdown-editor.js';
import { openAddModal } from './citations.js';
import { renderFull, extractCitekeys } from '../services/markdown.js';
import { printNote, themeList } from '../services/pdf.js';

// ── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'philosophy-js-settings';

// ── State ──────────────────────────────────────────────────────────────────

let _storage     = null;
let _editorView  = null;           // CodeMirror EditorView (always present)
let _mkEditor    = null;           // Milkdown editor handle (created on first switch)
let _editorMode  = 'codemirror';   // 'codemirror' | 'milkdown'
let _currentNote = null;
let _notes       = [];
let _cachedCitations = [];         // kept fresh for Milkdown autocomplete

// ── Autosave state ─────────────────────────────────────────────────────────
// Pattern: save at most once per AUTO_SAVE_INTERVAL ms while dirty.
// When a change arrives, schedule a save for (interval − time_since_last_save)
// ms in the future. If another change arrives before that fires, do nothing
// (timer already set). After each successful save, reset _lastSavedAt so the
// next burst of typing will again wait a full interval.

const AUTO_SAVE_INTERVAL = 3000;   // ms
let _lastSavedAt   = Date.now();   // treat app load as a recent save
let _dirty         = false;
let _autoSaveTimer = null;
let _previewTimer  = null;         // debounced preview refresh

// DOM refs
const $ = id => document.getElementById(id);

// ── Settings helpers ───────────────────────────────────────────────────────

function loadEditorMode() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return s.editorMode === 'milkdown' ? 'milkdown' : 'codemirror';
  } catch {
    return 'codemirror';
  }
}

function saveEditorMode(mode) {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, editorMode: mode }));
  } catch { /* ignore */ }
}

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

// ── Autosave ───────────────────────────────────────────────────────────────

function markDirty() {
  _dirty = true;
  if (_autoSaveTimer !== null) return; // save already scheduled
  const delay = Math.max(0, AUTO_SAVE_INTERVAL - (Date.now() - _lastSavedAt));
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    if (_dirty) saveCurrentNote(getActiveContent());
  }, delay);
}

// ── Active editor access ───────────────────────────────────────────────────

function getActiveContent() {
  if (_editorMode === 'milkdown' && _mkEditor) return _mkEditor.getValue();
  return _editorView ? getEditorContent(_editorView) : '';
}

function setActiveContent(text) {
  if (_editorMode === 'milkdown' && _mkEditor) {
    _mkEditor.setValue(text);
  } else if (_editorView) {
    setEditorContent(_editorView, text);
  }
}

// ── Live preview ───────────────────────────────────────────────────────────

async function updatePreview(markdown) {
  const previewEl = $('note-preview');
  if (!previewEl) return;

  const citekeys = extractCitekeys(markdown);
  const citationMap = new Map();
  if (citekeys.length) {
    const all = await _storage.listCitations();
    for (const c of all) {
      if (citekeys.includes(c.citekey)) citationMap.set(c.citekey, c);
    }
  }
  previewEl.innerHTML = renderFull(markdown, citationMap, 'authoryear');
  previewEl.querySelectorAll('a.note-link[data-slug]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const note = _notes.find(n => n.slug === a.dataset.slug);
      if (note) openNote(note);
    });
  });
}

// ── List ───────────────────────────────────────────────────────────────────

function refreshCitationsCache() {
  _storage.listCitations().then(cs => { _cachedCitations = cs; });
}

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
  // Cancel any pending autosave for the previous note
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
  _dirty = false;
  _lastSavedAt = Date.now();

  _currentNote = note;
  $('welcome-screen')?.classList.add('hidden');
  $('note-editor')?.classList.remove('hidden');
  $('citation-editor')?.classList.add('hidden');
  $('right-note-info')?.classList.remove('hidden');
  $('right-cite-info')?.classList.add('hidden');

  $('note-title').value = note.title ?? '';
  $('note-tags').value  = tagsToString(note.tags);
  $('word-count').textContent = `${wordCount(note.body ?? '')} words`;

  const body = note.body ?? '';

  if (_editorMode === 'milkdown') {
    if (_mkEditor) {
      _mkEditor.setValue(body);
    } else {
      await mountMilkdown(body);
    }
  } else {
    if (_editorView) setEditorContent(_editorView, body);
  }

  document.querySelectorAll('#note-list .item').forEach(li => {
    li.classList.toggle('active', li.dataset.id === String(note.id));
  });

  await updatePreview(body);

  // On mobile, automatically switch to the edit panel when a note is opened
  window.dispatchEvent(new Event('mobile-open-edit'));
}

// ── Milkdown mount / tear-down ─────────────────────────────────────────────

async function mountMilkdown(initialContent) {
  const mountEl = $('mk-editor-mount');
  if (!mountEl) return;

  _mkEditor = await createMilkdownEditor(mountEl, {
    initialContent,
    onChange: (markdown) => {
      if (_editorMode !== 'milkdown') return; // guard while switching
      $('word-count').textContent = `${wordCount(markdown)} words`;
      markDirty();
      // Refresh preview on a short debounce (independent of save timing)
      clearTimeout(_previewTimer);
      _previewTimer = setTimeout(() => updatePreview(markdown), 600);
    },
    getNotes: () => _notes,
    getCitations: () => _cachedCitations,
    onNoteClick: (slug) => {
      const note = _notes.find(n => n.slug === slug);
      if (note) openNote(note);
    },
    onCitationClick: (_citekey) => {
      // Citation clicking in WYSIWYG mode: do nothing extra for now.
      // The right preview panel already shows the resolved bibliography.
    },
    onCreateCitation: (query, onInsert) => openAddModal({ prefillQuery: query, onInsert }),
  });
}

// ── Editor mode toggle ─────────────────────────────────────────────────────

async function toggleEditorMode() {
  const content = getActiveContent();
  _editorMode = _editorMode === 'codemirror' ? 'milkdown' : 'codemirror';
  saveEditorMode(_editorMode);
  await applyEditorMode(content);
}

async function applyEditorMode(content) {
  const cmMount = $('cm-editor-mount');
  const mkMount = $('mk-editor-mount');
  const btn     = $('editor-mode-btn');

  if (_editorMode === 'milkdown') {
    // Show Milkdown, hide CodeMirror
    cmMount?.classList.add('hidden');
    mkMount?.classList.remove('hidden');
    if (btn) btn.textContent = 'Source';

    if (!_mkEditor) {
      await mountMilkdown(content);
    } else {
      _mkEditor.setValue(content);
      _mkEditor.focus();
    }
  } else {
    // Show CodeMirror, hide Milkdown
    cmMount?.classList.remove('hidden');
    mkMount?.classList.add('hidden');
    if (btn) btn.textContent = 'Rich Text';

    if (_editorView) {
      setEditorContent(_editorView, content);
      _editorView.focus();
    }
  }
}

// ── Save ───────────────────────────────────────────────────────────────────

async function saveCurrentNote(body) {
  if (!_currentNote && !$('note-title').value.trim()) return;

  // Mark clean and cancel any pending autosave before the async work begins
  _dirty = false;
  _lastSavedAt = Date.now();
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;

  const title = $('note-title').value.trim() || 'Untitled';
  const tags  = tagsFromString($('note-tags').value);
  const text  = body ?? getActiveContent();

  const saved = await _storage.saveNote({
    ..._currentNote,
    title,
    body: text,
    tags,
  });

  const isNew = !_currentNote?.id;
  _currentNote = saved;

  showSaveIndicator();
  $('word-count').textContent = `${wordCount(saved.body)} words`;
  refreshCitationsCache(); // keep Milkdown autocomplete fresh
  await refreshList($('note-search').value);

  if (isNew) {
    document.querySelectorAll('#note-list .item').forEach(li => {
      li.classList.toggle('active', li.dataset.id === String(saved.id));
    });
  }

  await updatePreview(saved.body);
}

// ── New note ───────────────────────────────────────────────────────────────

async function newNote() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = null;
  _dirty = false;
  _lastSavedAt = Date.now();

  _currentNote = null;
  $('welcome-screen')?.classList.add('hidden');
  $('note-editor')?.classList.remove('hidden');
  $('citation-editor')?.classList.add('hidden');
  $('right-note-info')?.classList.remove('hidden');
  $('right-cite-info')?.classList.add('hidden');

  $('note-title').value = '';
  $('note-tags').value  = '';
  $('word-count').textContent = '0 words';

  setActiveContent('');
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
  const body    = getActiveContent();
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

// ── Save indicator (inline, next to word count) ────────────────────────────

let _saveIndicatorTimer = null;
function showSaveIndicator() {
  const el = $('save-indicator');
  if (!el) return;
  el.textContent = '· Saved';
  el.classList.add('visible');
  clearTimeout(_saveIndicatorTimer);
  _saveIndicatorTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 2000);
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

  // Prime the citation cache (used by Milkdown autocomplete).
  // refreshCitationsCache() is also called after saves to stay fresh.
  refreshCitationsCache();

  // Restore persisted editor mode
  _editorMode = loadEditorMode();

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

  // Always create the CodeMirror editor (it lives in the background when
  // Milkdown mode is active).
  const cmMount = $('cm-editor-mount');
  if (cmMount) {
    _editorView = createEditor(cmMount, {
      initialDoc:   '',
      getNotes:     () => storage.listNotes(),
      getCitations: () => (getCitations ?? (() => storage.listCitations()))(),
      onSave:       body => {
        if (_editorMode === 'codemirror') saveCurrentNote(body);
      },
      onUpdate: count => {
        if (_editorMode !== 'codemirror') return;
        $('word-count').textContent = `${count} words`;
        markDirty();
        clearTimeout(_previewTimer);
        _previewTimer = setTimeout(
          () => updatePreview(getEditorContent(_editorView)), 600,
        );
      },
      onCreateCitation: (query, onInsert) => openAddModal({ prefillQuery: query, onInsert }),
    });
  }

  // Apply the initial mode (show/hide mounts, set button label)
  const cmMountEl = $('cm-editor-mount');
  const mkMountEl = $('mk-editor-mount');
  const modeBtn   = $('editor-mode-btn');

  if (_editorMode === 'milkdown') {
    cmMountEl?.classList.add('hidden');
    mkMountEl?.classList.remove('hidden');
    if (modeBtn) modeBtn.textContent = 'Source';
    // The Milkdown editor itself is created lazily in openNote()
  } else {
    cmMountEl?.classList.remove('hidden');
    mkMountEl?.classList.add('hidden');
    if (modeBtn) modeBtn.textContent = 'Rich Text';
  }

  // Bind UI events
  $('new-note-btn')?.addEventListener('click', newNote);
  $('save-btn')?.addEventListener('click', () => saveCurrentNote());
  $('delete-note-btn')?.addEventListener('click', deleteCurrentNote);
  $('print-btn')?.addEventListener('click', printCurrentNote);
  $('note-search')?.addEventListener('input', e => refreshList(e.target.value));

  // Mode toggle
  modeBtn?.addEventListener('click', toggleEditorMode);

  // Note title: move focus to editor on Enter
  $('note-title')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_editorMode === 'milkdown' && _mkEditor) {
        _mkEditor.focus();
      } else {
        _editorView?.focus();
      }
    }
  });

  // Ctrl+S in Milkdown mode (CodeMirror mode has its own built-in Ctrl+S keymap)
  document.addEventListener('keydown', e => {
    if (_editorMode !== 'milkdown') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentNote();
    }
  });

  await refreshList();
}

export { openNote, refreshList as refreshNoteList };
