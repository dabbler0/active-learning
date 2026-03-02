/**
 * Philosophy Notes — CodeMirror 6 editor with [[note: and [@ autocomplete.
 */

import {
  EditorState,
  EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage,
  autocompletion, completionKeymap,
  searchKeymap,
} from '/static/lib/codemirror-bundle.js';

let view = null;
let onSaveFn = null;
let onWordCountFn = null;

// ── Autocomplete sources ────────────────────────────────────────────────────

/**
 * [[note: autocomplete — triggered after typing "[["
 */
function noteCompletionSource(context) {
  // Match [[note: followed by optional partial slug
  const m = context.matchBefore(/\[\[note:[a-z0-9-]*/);
  if (!m) return null;

  const prefix = m.text.slice('[[note:'.length);

  return fetch(`/api/v1/search/notes?q=${encodeURIComponent(prefix)}&limit=10`)
    .then(r => r.json())
    .then(notes => ({
      from: m.from,
      options: notes.map(n => ({
        label: `[[note:${n.slug}|${n.title}]]`,
        displayLabel: n.title,
        detail: n.slug,
        type: 'keyword',
        apply: (view, completion, from, to) => {
          view.dispatch({
            changes: { from, to, insert: `[[note:${n.slug}|${n.title}]]` },
          });
        },
      })),
    }));
}

/**
 * [@ autocomplete — triggered after typing "[@"
 */
function citeCompletionSource(context) {
  // Match [@ followed by optional partial citekey
  const m = context.matchBefore(/\[@[\w:-]*/);
  if (!m) return null;

  const prefix = m.text.slice(2); // strip [@

  return fetch(`/api/v1/search/citations?q=${encodeURIComponent(prefix)}&limit=10`)
    .then(r => r.json())
    .then(cites => ({
      from: m.from,
      options: cites.map(c => {
        const authorStr = c.authors.length ? c.authors[0].split(',')[0] : '';
        const detail = [authorStr, c.year].filter(Boolean).join(', ');
        return {
          label: `[@${c.citekey}]`,
          displayLabel: c.citekey,
          detail: detail ? `${c.title.slice(0,40)} — ${detail}` : c.title.slice(0,50),
          type: 'variable',
          apply: (view, completion, from, to) => {
            view.dispatch({
              changes: { from, to, insert: `[@${c.citekey}]` },
            });
          },
        };
      }),
    }));
}

// ── Word count ──────────────────────────────────────────────────────────────

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

// ── Custom theme ─────────────────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  '.cm-content': {
    padding: '16px 20px',
    fontFamily: '"Linux Libertine O", "Georgia", serif',
    lineHeight: '1.7',
    caretColor: 'var(--accent)',
  },
  '.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-selectionBackground': {
    background: 'rgba(74, 124, 110, 0.2)',
  },
  '.cm-activeLine': {
    background: 'rgba(0,0,0,0.03)',
  },
  '.cm-scroller': {
    fontFamily: '"Linux Libertine O", "Georgia", serif',
  },
  '.cm-tooltip': {
    background: 'var(--bg2)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: '13px',
  },
  '.cm-completionDetail': {
    color: 'var(--text2)',
    fontSize: '11px',
  },
  '.cm-completionLabel': {
    fontFamily: '"DejaVu Sans Mono", monospace',
    fontSize: '12px',
  },
});

// ── Auto-save debounce ────────────────────────────────────────────────────────

let autoSaveTimer = null;

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (onSaveFn) onSaveFn();
  }, 3000);
}

// ── Editor init ───────────────────────────────────────────────────────────────

export function initEditor({ mountId, onSave, onWordCount }) {
  onSaveFn = onSave;
  onWordCountFn = onWordCount;

  const mount = document.getElementById(mountId);
  if (!mount) return;

  const startState = EditorState.create({
    doc: '',
    extensions: [
      history(),
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      markdown({ base: markdownLanguage }),
      autocompletion({
        override: [noteCompletionSource, citeCompletionSource],
        activateOnTyping: true,
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...searchKeymap,
        indentWithTab,
        { key: 'Ctrl-s', run: () => { if (onSaveFn) onSaveFn(); return true; } },
        { key: 'Meta-s', run: () => { if (onSaveFn) onSaveFn(); return true; } },
      ]),
      editorTheme,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          if (onWordCountFn) onWordCountFn(countWords(text));
          scheduleAutoSave();
        }
      }),
      EditorView.lineWrapping,
    ],
  });

  view = new EditorView({ state: startState, parent: mount });
}

export function setEditorContent(content) {
  if (!view) return;
  clearTimeout(autoSaveTimer);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
  });
  if (onWordCountFn) onWordCountFn(countWords(content));
}

export function getEditorContent() {
  if (!view) return '';
  return view.state.doc.toString();
}

export function destroyEditor() {
  if (view) {
    view.destroy();
    view = null;
  }
}

export function focusEditor() {
  view?.focus();
}
