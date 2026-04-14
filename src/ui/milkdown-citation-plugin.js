/**
 * Milkdown plugin for inline citation syntax: [@citekey] and [@citekey, p. N]
 *
 * Storage format is preserved exactly. Milkdown renders the raw syntax as
 * a styled atomic chip during editing. Round-trip:
 *   Markdown text  ─(remark parse transform)→  mdast `citation` node
 *   mdast node     ─(parseMarkdown runner)→     ProseMirror `citation` node
 *   PM node        ─(toMarkdown runner)→         mdast `citation` node
 *   mdast node     ─(remark-stringify handler)→  Markdown text (original syntax)
 */

import { $node, $remark } from '@milkdown/utils';
import { visit } from 'unist-util-visit';

const CITATION_RE = /\[@([^\]@,]+?)(?:,\s*([^\]]+))?\]/g;

// ── Remark plugin ──────────────────────────────────────────────────────────
// Runs as a unified plugin. Sets up:
//   1. A toMarkdown handler so remark-stringify can serialize citation nodes.
//   2. A tree transformer that converts text nodes containing [@...] into
//      custom `citation` mdast nodes.

function remarkCitationPlugin() {
  // Register the stringify handler via remark-stringify's data extension API
  const data = this.data();
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = [];
  data.toMarkdownExtensions.push({
    handlers: {
      citation(node) {
        const loc = node.locator ? `, ${node.locator}` : '';
        return `[@${node.citekey}${loc}]`;
      },
    },
  });

  // Return the mdast transform that runs after remark-parse
  return function transformer(tree) {
    visit(tree, 'text', function (node, index, parent) {
      if (!parent || index == null) return;

      CITATION_RE.lastIndex = 0;
      const matches = [...node.value.matchAll(CITATION_RE)];
      if (!matches.length) return;

      const parts = [];
      let last = 0;
      for (const m of matches) {
        if (m.index > last) {
          parts.push({ type: 'text', value: node.value.slice(last, m.index) });
        }
        parts.push({
          type: 'citation',
          citekey: m[1],
          locator: m[2] ? m[2].trim() : null,
        });
        last = m.index + m[0].length;
      }
      if (last < node.value.length) {
        parts.push({ type: 'text', value: node.value.slice(last) });
      }

      parent.children.splice(index, 1, ...parts);
      // Resume traversal after the newly inserted nodes
      return index + parts.length;
    });
  };
}

// ── Milkdown plugin wrappers ────────────────────────────────────────────────

export const citationRemark = $remark('citation-remark', () => remarkCitationPlugin);

export const citationNode = $node('citation', () => ({
  // ProseMirror schema
  group: 'inline',
  inline: true,
  atom: true,   // non-editable; treated as a single cursor position
  attrs: {
    citekey: { default: '' },
    locator: { default: '' },
  },
  parseDOM: [
    {
      tag: 'cite.mk-citation',
      getAttrs: (el) => ({
        citekey: el.dataset.citekey ?? '',
        locator: el.dataset.locator ?? '',
      }),
    },
  ],
  toDOM: (node) => {
    const { citekey, locator } = node.attrs;
    const label = locator ? `[@${citekey}, ${locator}]` : `[@${citekey}]`;
    return [
      'cite',
      {
        class: 'mk-citation',
        'data-citekey': citekey,
        'data-locator': locator,
        title: `Citation: ${citekey}`,
        contenteditable: 'false',
      },
      label,
    ];
  },

  // Milkdown mdast ↔ ProseMirror conversion
  parseMarkdown: {
    match: (node) => node.type === 'citation',
    runner: (state, node, type) => {
      state.addNode(type, {
        citekey: node.citekey ?? '',
        locator: node.locator ?? '',
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'citation',
    runner: (state, node) => {
      state.addNode('citation', null, null, {
        citekey: node.attrs.citekey,
        locator: node.attrs.locator,
      });
    },
  },
}));
