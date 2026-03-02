/**
 * Philosophy Notes — CodeMirror 6 editor with [[note: and [@ autocomplete.
 */

import {
  EditorState,
  EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine,
  defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage,
  syntaxHighlighting, defaultHighlightStyle,
  autocompletion, completionKeymap,
  searchKeymap,
} from '/static/lib/codemirror-bundle.js';

let view = null;
let onSaveFn = null;
let onWordCountFn = null;

// ── Autocomplete sources ────────────────────────────────────────────────────

/**
 * [[note: autocomplete — triggers as soon as the user types "[[".
 * Searches the note title/slug and inserts [[note:slug|Title]].
 */
function noteCompletionSource(context) {
  // Match [[ followed by anything that isn't a closing bracket.
  // The * quantifier means this fires immediately after [[ with no prefix.
  const m = context.matchBefore(/\[\[[^\]]*$/);
  if (!m) return null;

  // Text after the opening [[ is the search query
  const query = m.text.slice(2).trim();

  return fetch(`/api/v1/search/notes?q=${encodeURIComponent(query)}&limit=10`)
    .then(r => r.json())
    .then(notes => {
      if (!notes.length) return null;
      return {
        from: m.from,            // replace from the opening [[
        filter: false,           // we do our own server-side filtering
        options: notes.map(n => ({
          label: `[[note:${n.slug}|${n.title}]]`,
          displayLabel: n.title,
          detail: n.slug,
          type: 'keyword',
          apply(view, _completion, from, to) {
            view.dispatch({
              changes: { from, to, insert: `[[note:${n.slug}|${n.title}]]` },
            });
          },
        })),
      };
    });
}

/**
 * [@ autocomplete — triggers as soon as the user types "[@".
 * Searches the citation database and inserts [@citekey].
 */
function citeCompletionSource(context) {
  // Match [@ followed by a partial citekey (word chars, colon, hyphen).
  // The * quantifier means this fires immediately after [@.
  const m = context.matchBefore(/\[@[\w:-]*$/);
  if (!m) return null;

  const query = m.text.slice(2); // strip [@

  return fetch(`/api/v1/search/citations?q=${encodeURIComponent(query)}&limit=10`)
    .then(r => r.json())
    .then(cites => {
      if (!cites.length) return null;
      return {
        from: m.from,
        filter: false,
        options: cites.map(c => {
          const authorStr = c.authors.length ? c.authors[0].split(',')[0] : '';
          const meta = [authorStr, c.year].filter(Boolean).join(', ');
          return {
            label: `[@${c.citekey}]`,
            displayLabel: c.citekey,
            detail: meta ? `${c.title.slice(0, 40)} — ${meta}` : c.title.slice(0, 50),
            type: 'variable',
            apply(view, _completion, from, to) {
              view.dispatch({
                changes: { from, to, insert: `[@${c.citekey}]` },
              });
            },
          };
        }),
      };
    });
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
    fontFamily: '"DejaVu Sans Mono", "Consolas", "Menlo", monospace',
    lineHeight: '1.65',
    caretColor: 'var(--accent)',
  },
  '.cm-scroller': {
    fontFamily: '"DejaVu Sans Mono", "Consolas", "Menlo", monospace',
  },
  '.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'rgba(74, 124, 110, 0.2)',
  },
  '.cm-activeLine': {
    background: 'rgba(0,0,0,0.03)',
  },
  '.cm-gutters': {
    background: 'var(--bg2)',
    border: 'none',
    color: 'var(--text2)',
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
    fontStyle: 'normal',
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
      syntaxHighlighting(defaultHighlightStyle),
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
