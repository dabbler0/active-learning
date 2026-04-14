/**
 * Milkdown WYSIWYG editor factory.
 *
 * Provides a rich-text editing experience that:
 *  - Preserves the custom [[note:slug|Label]] and [@citekey] storage syntax.
 *  - Renders those patterns as styled atomic chips inside the editor.
 *  - Shows an autocomplete dropdown when the user types [[ or [@ .
 *  - Fires an onChange callback with the raw markdown (custom syntax intact).
 *
 * Usage:
 *   const editor = await createMilkdownEditor(container, {
 *     initialContent, onChange, getNotes, getCitations, onNoteClick, onCitationClick,
 *   });
 *   editor.getValue()    // → raw markdown string
 *   editor.setValue(md)  // replace content
 *   editor.focus()
 *   editor.destroy()
 */

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  serializerCtx,
} from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { $prose, getMarkdown, replaceAll } from '@milkdown/utils';
import { Plugin } from 'prosemirror-state';

import { citationRemark, citationNode } from './milkdown-citation-plugin.js';
import { noteLinkRemark, noteLinkNode } from './milkdown-notelink-plugin.js';

// ── Autocomplete ───────────────────────────────────────────────────────────

/**
 * Detect whether the cursor is inside an open [@ or [[ pattern that should
 * trigger the autocomplete dropdown.  Returns a context object or null.
 *
 * Uses leafText='\x01' for atom nodes so they occupy the correct number of
 * ProseMirror positions without inflating text lengths used in offset math.
 */
function getCompletionCtx(state) {
  const { from, empty } = state.selection;
  if (!empty) return null;

  const $pos = state.selection.$from;
  const blockStart = $pos.start();

  // Build text from block start to cursor; atom nodes become '\x01'
  // so each character in `raw` maps 1-to-1 with a ProseMirror position.
  const raw = state.doc.textBetween(blockStart, from, '\n', '\x01');

  // Only look at the segment after the last atom placeholder —
  // that portion is guaranteed to be pure text with correct position offsets.
  const seg = raw.split('\x01').pop() ?? '';

  // [@citekey] or [@citekey, locator]
  const citM = seg.match(/\[@([^\]@,\n]*)(?:,\s*([^\]\n]*))?$/);
  if (citM) {
    return {
      type: 'citation',
      query: citM[1],
      locator: citM[2] != null ? citM[2].trim() : null,
      from: from - citM[0].length,
    };
  }

  // [[note:slug|Label]] or [[slug
  const noteM = seg.match(/\[\[(?:note:)?([^\]|\n]*)(?:\|([^\]\n]*))?$/);
  if (noteM) {
    return {
      type: 'notelink',
      query: noteM[1].replace(/^note:/, ''),
      label: noteM[2] ?? '',
      from: from - noteM[0].length,
    };
  }

  return null;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the ProseMirror plugin that drives autocomplete.
 * getNotes / getCitations are called synchronously; they should return the
 * currently cached arrays (not Promises) for snappy UI.
 */
function makeAutocompletePlugin({ getNotes, getCitations, onNoteClick, onCitationClick }) {
  let dropdown = null;
  let acState = null; // { type, query, from, selected, items }

  // ── DOM helpers ──────────────────────────────────────────────────────────

  function ensureDropdown() {
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'mk-autocomplete';
      dropdown.setAttribute('role', 'listbox');
      document.body.appendChild(dropdown);
    }
    return dropdown;
  }

  function renderDropdown(view, ctx, items) {
    const el = ensureDropdown();
    const coords = view.coordsAtPos(ctx.from);
    const scrollY = window.scrollY;
    // Keep dropdown inside viewport horizontally
    const left = Math.min(coords.left, window.innerWidth - 300);
    el.style.cssText = `display:block;left:${left}px;top:${coords.bottom + scrollY + 4}px`;

    el.innerHTML = '';
    items.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'mk-autocomplete-item' + (i === acState.selected ? ' mk-ac-selected' : '');
      div.setAttribute('role', 'option');
      div.innerHTML =
        `<span class="mk-ac-label">${escHtml(item.label)}</span>` +
        (item.sub ? `<span class="mk-ac-sub">${escHtml(item.sub)}</span>` : '');
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertItem(view, ctx, item);
      });
      el.appendChild(div);
    });
  }

  function hideDropdown() {
    if (dropdown) dropdown.style.display = 'none';
    acState = null;
  }

  // ── Item insertion ───────────────────────────────────────────────────────

  function insertItem(view, ctx, item) {
    const to = view.state.selection.from;
    const { schema } = view.state;
    let node;
    if (ctx.type === 'citation') {
      node = schema.nodes.citation.create({
        citekey: item.citekey,
        locator: ctx.locator ?? '',
      });
    } else {
      node = schema.nodes.noteLink.create({
        slug: item.slug,
        label: item.label ?? item.slug,
      });
    }
    view.dispatch(view.state.tr.replaceWith(ctx.from, to, node));
    hideDropdown();
    view.focus();
  }

  // ── Filtering ────────────────────────────────────────────────────────────

  function filterItems(ctx) {
    const q = (ctx.query ?? '').toLowerCase();
    if (ctx.type === 'citation') {
      const citations = getCitations ? getCitations() : [];
      return citations
        .filter(
          (c) =>
            !q ||
            c.citekey.toLowerCase().includes(q) ||
            (c.title ?? '').toLowerCase().includes(q) ||
            (c.authors ?? []).some((a) => a.toLowerCase().includes(q)),
        )
        .slice(0, 10)
        .map((c) => {
          const auth = (c.authors ?? [])[0]?.split(',')[0] ?? '';
          const yr = c.year ?? '';
          return {
            label: c.citekey,
            sub: [auth, yr, c.title].filter(Boolean).join(', ').slice(0, 70),
            citekey: c.citekey,
          };
        });
    } else {
      const notes = getNotes ? getNotes() : [];
      return notes
        .filter(
          (n) =>
            !q ||
            (n.title ?? '').toLowerCase().includes(q) ||
            n.slug.toLowerCase().includes(q),
        )
        .slice(0, 10)
        .map((n) => ({ label: n.title || n.slug, sub: n.slug, slug: n.slug }));
    }
  }

  // ── ProseMirror plugin ────────────────────────────────────────────────────

  return $prose((_ctx) => {
    let editorView = null;

    const outsideClick = (e) => {
      if (
        dropdown &&
        !dropdown.contains(e.target) &&
        editorView &&
        !editorView.dom.contains(e.target)
      ) {
        hideDropdown();
      }
    };

    return new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (!acState || !dropdown || dropdown.style.display === 'none') return false;
          const items = dropdown.querySelectorAll('.mk-autocomplete-item');
          if (!items.length) return false;

          if (event.key === 'ArrowDown') {
            acState.selected = Math.min(acState.selected + 1, items.length - 1);
            items.forEach((el, i) =>
              el.classList.toggle('mk-ac-selected', i === acState.selected),
            );
            items[acState.selected]?.scrollIntoView({ block: 'nearest' });
            event.preventDefault();
            return true;
          }
          if (event.key === 'ArrowUp') {
            acState.selected = Math.max(acState.selected - 1, 0);
            items.forEach((el, i) =>
              el.classList.toggle('mk-ac-selected', i === acState.selected),
            );
            items[acState.selected]?.scrollIntoView({ block: 'nearest' });
            event.preventDefault();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const completionCtx = getCompletionCtx(view.state);
            if (completionCtx && acState.items[acState.selected]) {
              event.preventDefault();
              insertItem(view, completionCtx, acState.items[acState.selected]);
              return true;
            }
          }
          if (event.key === 'Escape') {
            hideDropdown();
            event.preventDefault();
            return true;
          }
          return false;
        },

        handleClick(view, _pos, event) {
          const citEl = event.target.closest?.('.mk-citation');
          if (citEl) {
            const citekey = citEl.dataset.citekey;
            if (citekey && onCitationClick) onCitationClick(citekey);
            return true;
          }
          const noteEl = event.target.closest?.('.mk-notelink');
          if (noteEl) {
            const slug = noteEl.dataset.slug;
            if (slug && onNoteClick) onNoteClick(slug);
            return true;
          }
          return false;
        },
      },

      view(view) {
        editorView = view;
        document.addEventListener('mousedown', outsideClick, true);
        return {
          update(v) {
            const ctx = getCompletionCtx(v.state);
            if (!ctx) {
              hideDropdown();
              return;
            }
            const items = filterItems(ctx);
            acState = { ...ctx, selected: 0, items };
            if (items.length) {
              renderDropdown(v, ctx, items);
            } else {
              hideDropdown();
            }
          },
          destroy() {
            document.removeEventListener('mousedown', outsideClick, true);
            if (dropdown) {
              dropdown.remove();
              dropdown = null;
            }
            editorView = null;
          },
        };
      },
    });
  });
}

// ── Editor factory ─────────────────────────────────────────────────────────

/**
 * Create a Milkdown WYSIWYG editor.
 *
 * @param {HTMLElement} container  - Empty mount element
 * @param {object}      opts
 * @param {string}      [opts.initialContent='']
 * @param {Function}    [opts.onChange]          - Called with markdown string on change
 * @param {Function}    [opts.getNotes]          - Sync: () => Note[]
 * @param {Function}    [opts.getCitations]      - Sync: () => Citation[]
 * @param {Function}    [opts.onNoteClick]       - (slug: string) => void
 * @param {Function}    [opts.onCitationClick]   - (citekey: string) => void
 * @returns {Promise<{ getValue, setValue, destroy, focus }>}
 */
export async function createMilkdownEditor(container, opts = {}) {
  const {
    initialContent = '',
    onChange,
    getNotes,
    getCitations,
    onNoteClick,
    onCitationClick,
  } = opts;

  const autocomplete = makeAutocompletePlugin({
    getNotes,
    getCitations,
    onNoteClick,
    onCitationClick,
  });

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, container);
      ctx.set(defaultValueCtx, initialContent);
      if (onChange) {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prev) => {
          if (markdown !== prev) onChange(markdown);
        });
      }
    })
    .use(commonmark)
    .use(listener)
    .use(citationRemark)
    .use(citationNode)
    .use(noteLinkRemark)
    .use(noteLinkNode)
    .use(autocomplete)
    .create();

  return {
    /** Return the current document as a markdown string (custom syntax preserved). */
    getValue() {
      return editor.action(getMarkdown());
    },
    /** Replace the entire document with the given markdown string. */
    setValue(markdown) {
      editor.action(replaceAll(markdown));
    },
    focus() {
      editor.action((ctx) => ctx.get(editorViewCtx).focus());
    },
    destroy() {
      editor.destroy();
    },
  };
}
