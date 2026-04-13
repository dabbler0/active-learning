/**
 * Browser-based PDF generation via window.print().
 *
 * Strategy: open a new window with a complete HTML document (inlined CSS),
 * call window.print(), then close. The CSS controls print layout.
 *
 * CSS is imported as text via esbuild's `loader: {'.css': 'text'}` config,
 * so each theme is a plain string literal — no external requests needed.
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
 * Open a print dialog for the given rendered HTML.
 *
 * @param {string} html        - The rendered body HTML (from renderFull())
 * @param {string} title       - Document title shown in header
 * @param {string} themeId     - Key in THEMES
 * @param {string} [author]    - Optional author line shown in header
 */
export function printNote(html, title, themeId = 'academic', author = '') {
  const theme  = THEMES[themeId] ?? THEMES.academic;
  const date   = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const authorLine = author
    ? `<p class="print-author">${escHtml(author)}</p>`
    : '';

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escHtml(title)}</title>
  <style>
${theme.css}
  </style>
</head>
<body>
  <header class="print-header">
    <h1 class="print-title">${escHtml(title)}</h1>
    ${authorLine}
    <p class="print-date">${date}</p>
  </header>
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

  // Wait for images/fonts to load before printing
  win.onload = () => {
    win.focus();
    win.print();
    // Don't auto-close — let user save / cancel
  };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
