/**
 * Milkdown plugin for inline note-link syntax: [[note:slug|Label]] and [[note:slug]]
 *
 * Storage format is preserved exactly. Round-trip:
 *   Markdown text  ─(remark parse transform)→  mdast `noteLink` node
 *   mdast node     ─(parseMarkdown runner)→     ProseMirror `noteLink` node
 *   PM node        ─(toMarkdown runner)→         mdast `noteLink` node
 *   mdast node     ─(remark-stringify handler)→  Markdown text (original syntax)
 */

import { $node, $remark } from '@milkdown/utils';
import { visit } from 'unist-util-visit';

const NOTELINK_RE = /\[\[note:([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;

// ── Remark plugin ──────────────────────────────────────────────────────────

function remarkNoteLinkPlugin() {
  const data = this.data();
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = [];
  data.toMarkdownExtensions.push({
    handlers: {
      noteLink(node) {
        const label = node.label ? `|${node.label}` : '';
        return `[[note:${node.slug}${label}]]`;
      },
    },
  });

  return function transformer(tree) {
    visit(tree, 'text', function (node, index, parent) {
      if (!parent || index == null) return;

      NOTELINK_RE.lastIndex = 0;
      const matches = [...node.value.matchAll(NOTELINK_RE)];
      if (!matches.length) return;

      const parts = [];
      let last = 0;
      for (const m of matches) {
        if (m.index > last) {
          parts.push({ type: 'text', value: node.value.slice(last, m.index) });
        }
        parts.push({
          type: 'noteLink',
          slug: m[1],
          label: m[2] ?? null,
        });
        last = m.index + m[0].length;
      }
      if (last < node.value.length) {
        parts.push({ type: 'text', value: node.value.slice(last) });
      }

      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

// ── Milkdown plugin wrappers ────────────────────────────────────────────────

export const noteLinkRemark = $remark('notelink-remark', () => remarkNoteLinkPlugin);

export const noteLinkNode = $node('noteLink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    slug: { default: '' },
    label: { default: '' },
  },
  parseDOM: [
    {
      tag: 'a.mk-notelink',
      getAttrs: (el) => ({
        slug: el.dataset.slug ?? '',
        label: el.textContent ?? '',
      }),
    },
  ],
  toDOM: (node) => {
    const { slug, label } = node.attrs;
    return [
      'a',
      {
        class: 'mk-notelink',
        'data-slug': slug,
        href: '#',
        title: `Note: ${slug}`,
        contenteditable: 'false',
      },
      label || slug,
    ];
  },

  parseMarkdown: {
    match: (node) => node.type === 'noteLink',
    runner: (state, node, type) => {
      state.addNode(type, {
        slug: node.slug ?? '',
        label: node.label ?? '',
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'noteLink',
    runner: (state, node) => {
      state.addNode('noteLink', null, null, {
        slug: node.attrs.slug,
        label: node.attrs.label,
      });
    },
  },
}));
