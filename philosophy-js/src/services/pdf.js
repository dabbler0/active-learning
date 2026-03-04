/**
 * Browser-based PDF generation via paged.js + window.print().
 *
 * Strategy: open a new window with a complete HTML document (inlined CSS
 * + paged.js polyfill), let paged.js paginate the content with running
 * headers and page-number footers, then auto-trigger the system print
 * dialog so the user can save as PDF.
 *
 * CSS is imported as text via esbuild's `loader: {'.css': 'text'}` config,
 * so each theme is a plain string literal — no external requests needed.
 *
 * paged.js is served from the same origin as the app bundle (build.js
 * copies it from node_modules to dist/pagedjs.polyfill.js).
 */

// Print theme CSS files (imported as strings by esbuild)
import academicCss  from './print-themes/academic.css';
import essayCss     from './print-themes/essay.css';
import draftCss     from './print-themes/draft.css';
import minimalCss   from './print-themes/minimal.css';

export const THEMES = {
  academic: { label: 'Academic',  css: academicCss  },
  essay:    { label: 'Essay',     css: essayCss      },
  draft:    { label: 'Draft',     css: draftCss      },
  minimal:  { label: 'Minimal',   css: minimalCss    },
};

export function themeList() {
  return Object.entries(THEMES).map(([id, { label }]) => ({ id, label }));
}

/**
 * Open a paged.js print preview for the given rendered HTML, then
 * auto-trigger the system print dialog.
 *
 * Features provided by paged.js:
 *   • Running header (note title) on every page after the first
 *   • Centred page-number footer on every page
 *   • Footnote citations via CSS `float: footnote` (when the caller has
 *     rendered citations as `<span class="footnote">…</span>`)
 *   • Hanging-indent (reverse-indent) reference list
 *
 * @param {string} html     - The rendered body HTML (citations already resolved)
 * @param {string} title    - Document title used as the running header
 * @param {string} themeId  - Key in THEMES
 * @param {string} [author] - Optional author line shown on the title block
 */
export function printNote(html, title, themeId = 'academic', author = '') {
  const theme = THEMES[themeId] ?? THEMES.academic;
  const date  = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const authorLine = author
    ? `<p class="print-author">${escHtml(author)}</p>`
    : '';

  // Resolve the paged.js polyfill URL relative to the app's base URL so it
  // works whether the app is served from a web server or opened as a file.
  const pagedJsUrl = new URL('pagedjs.polyfill.js', document.baseURI).href;

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escHtml(title)}</title>

  <!-- Load paged.js before content so the handler can be registered. -->
  <script src="${pagedJsUrl}"></script>
  <script>
    /* Auto-trigger the system print dialog after paged.js finishes. */
    class TriggerPrint extends Paged.Handler {
      afterRendered() {
        window.focus();
        window.print();
      }
    }
    Paged.registerHandlers(TriggerPrint);
  </script>

  <style>
/* ── Base print theme ─────────────────────────────────────────────────── */
${theme.css}

/* ── Running header: source the title from the .print-title element ───── */
.print-title { string-set: doc-title content(text); }

/* ── Page geometry with margin boxes ─────────────────────────────────── */
@page {
  @top-center {
    content:        string(doc-title);
    font-style:     italic;
    font-size:      9pt;
    color:          #555;
    vertical-align: bottom;
    padding-bottom: 4pt;
    border-bottom:  0.4pt solid #bbb;
  }
  @bottom-center {
    content:   counter(page);
    font-size: 9pt;
    color:     #444;
  }
}

/* Suppress running header on the first (title) page */
@page :first {
  @top-center { content: none; border: none; padding: 0; }
}

/* ── Footnote citations (paged.js float:footnote) ─────────────────────── */
span.footnote {
  float:       footnote;
  font-size:   9pt;
  line-height: 1.4;
  font-style:  normal;
}

/* Style the footnote area that paged.js generates */
.pagedjs_footnote_content {
  border-top:  0.4pt solid #999;
  padding-top: 4pt;
  margin-top:  4pt;
}

/* ── Bibliography: hanging indent (reverse-indent) ─────────────────────── */
/* Override any legacy numbered-list styles from the theme */
.bibliography ol { display: none; }

.bib-list { margin: 0; padding: 0; }

.bib-entry {
  padding-left:  2.5em;
  text-indent:   -2.5em;
  margin-bottom: 0.55em;
  font-size:     11pt;
  line-height:   1.5;
}
  </style>
</head>
<body>
  <div class="print-header">
    <h1 class="print-title">${escHtml(title)}</h1>
    ${authorLine}
    <p class="print-date">${date}</p>
  </div>
  <article class="print-body">
    ${html}
  </article>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this page to generate PDFs.');
    return;
  }
  win.document.open();
  win.document.write(doc);
  win.document.close();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
