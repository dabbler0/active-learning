/**
 * CodeMirror 6 editor setup with:
 *  - Markdown syntax highlighting
 *  - [[ autocomplete → note-link insertion
 *  - [@ autocomplete → citation insertion
 *  - Save-on-idle (2 s) + Ctrl+S
 *  - Word count callback
 */

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import {
  autocompletion,
  completionKeymap,
  CompletionContext,
} from '@codemirror/autocomplete';

// ── Autocomplete sources ───────────────────────────────────────────────────

function makeNoteCompletions(getNotes) {
  return async function noteSource(context) {
    // Trigger: [[ with any characters after (no ]] yet)
    const m = context.matchBefore(/\[\[[^\]]*$/);
    if (!m) return null;
    const query = m.text.slice(2).toLowerCase();

    const notes = await getNotes();
    const options = notes
      .filter(n => !query || n.title.toLowerCase().includes(query) || n.slug.includes(query))
      .slice(0, 12)
      .map(n => ({
        label:        `[[note:${n.slug}|${n.title}]]`,
        displayLabel: n.title,
        detail:       n.slug,
        type:         'keyword',
        apply(view, _completion, from, to) {
          view.dispatch({ changes: { from, to, insert: `[[note:${n.slug}|${n.title}]]` } });
        },
      }));

    if (!options.length) return null;
    return { from: m.from, filter: false, options };
  };
}

function makeCiteCompletions(getCitations) {
  return async function citeSource(context) {
    // Trigger: [@ with any characters after (no ]] yet)
    const m = context.matchBefore(/\[@[^\]]*$/);
    if (!m) return null;
    const query = m.text.slice(2).toLowerCase();

    const citations = await getCitations();
    const options = citations
      .filter(c => {
        if (!query) return true;
        return c.citekey.toLowerCase().includes(query)
          || (c.title ?? '').toLowerCase().includes(query)
          || (c.authors ?? []).some(a => a.toLowerCase().includes(query));
      })
      .slice(0, 12)
      .map(c => {
        const auth = (c.authors ?? [])[0]?.split(',')[0] ?? '';
        const yr   = c.year ?? '';
        const detail = [auth, yr].filter(Boolean).join(', ');
        return {
          label:        `[@${c.citekey}]`,
          displayLabel: c.citekey,
          detail,
          info:         c.title ?? '',
          type:         'function',
          apply(view, _completion, from, to) {
            view.dispatch({ changes: { from, to, insert: `[@${c.citekey}]` } });
          },
        };
      });

    if (!options.length) return null;
    return { from: m.from, filter: false, options };
  };
}

// ── Theme ──────────────────────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  '&': {
    fontSize:   '14px',
    height:     '100%',
  },
  '.cm-content': {
    fontFamily: '"DejaVu Sans Mono", "Consolas", "Menlo", monospace',
    padding:    '8px 12px',
    lineHeight: '1.6',
  },
  '.cm-scroller': {
    fontFamily: '"DejaVu Sans Mono", "Consolas", "Menlo", monospace',
    overflow:   'auto',
  },
  '.cm-line': { paddingLeft: '0' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-gutters': { backgroundColor: '#f8f8f8', borderRight: '1px solid #ddd' },
  // Autocomplete popup
  '.cm-tooltip.cm-tooltip-autocomplete': {
    fontFamily: '"DejaVu Sans Mono", "Consolas", "Menlo", monospace',
    fontSize:   '13px',
  },
});

// ── Editor factory ─────────────────────────────────────────────────────────

/**
 * Create a CodeMirror 6 editor.
 *
 * @param {HTMLElement} mount       - DOM element to mount into
 * @param {object}      opts
 * @param {string}      opts.initialDoc
 * @param {Function}    opts.getNotes       - async () => Note[]
 * @param {Function}    opts.getCitations   - async () => Citation[]
 * @param {Function}    opts.onSave         - async (content: string) => void
 * @param {Function}    opts.onUpdate       - (wordCount: number) => void
 * @returns {EditorView}
 */
export function createEditor(mount, { initialDoc = '', getNotes, getCitations, onSave, onUpdate }) {
  let saveTimer = null;

  const saveExtension = EditorView.updateListener.of(update => {
    if (!update.docChanged) return;

    // Word count
    const text = update.state.doc.toString();
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    onUpdate?.(words);

    // Debounced auto-save
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => onSave?.(text), 2000);
  });

  const ctrlS = keymap.of([{
    key: 'Ctrl-s',
    mac: 'Cmd-s',
    run(view) {
      clearTimeout(saveTimer);
      onSave?.(view.state.doc.toString());
      return true;
    },
  }]);

  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      editorTheme,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      lineNumbers(),
      highlightActiveLine(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      autocompletion({
        override: [
          makeNoteCompletions(getNotes),
          makeCiteCompletions(getCitations),
        ],
        activateOnTyping: true,
      }),
      saveExtension,
      ctrlS,
    ],
  });

  return new EditorView({ state, parent: mount });
}

/**
 * Replace the editor document without triggering save.
 */
export function setEditorContent(view, text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

/**
 * Get the current editor content.
 */
export function getEditorContent(view) {
  return view.state.doc.toString();
}
