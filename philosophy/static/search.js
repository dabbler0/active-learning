/**
 * Philosophy Notes — Unified search panel.
 */

let _api, _toast, _openNote;

export function initSearch({ api, toast, openNote }) {
  _api = api;
  _toast = toast;
  _openNote = openNote;

  let searchTimer = null;
  document.getElementById('global-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) {
      document.getElementById('search-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function runSearch(q) {
  const container = document.getElementById('search-results');
  container.innerHTML = '<div style="padding:8px;color:var(--text2);font-size:12px">Searching…</div>';

  try {
    const { results } = await _api(`/search?q=${encodeURIComponent(q)}`);
    if (!results.length) {
      container.innerHTML = '<div style="padding:8px;color:var(--text2);font-size:12px">No results.</div>';
      return;
    }

    container.innerHTML = '';
    results.forEach(r => {
      const div = document.createElement('div');
      div.className = 'search-result';

      if (r.type === 'note') {
        div.innerHTML = `
          <div class="sr-type">Note</div>
          <div class="sr-title">${esc(r.title)}</div>
          <div class="sr-excerpt">${esc(r.excerpt)}</div>
        `;
        div.addEventListener('click', () => {
          _openNote(r.slug);
          // Switch to notes tab
          document.querySelector('[data-tab="notes"]').click();
        });
      } else {
        const authorStr = r.authors?.length ? r.authors[0].split(',')[0] : '';
        const meta = [authorStr, r.year].filter(Boolean).join(', ');
        div.innerHTML = `
          <div class="sr-type">Citation</div>
          <div class="sr-title">${esc(r.title)}</div>
          <div class="sr-excerpt">${esc(r.citekey)}${meta ? ` — ${esc(meta)}` : ''}</div>
        `;
        div.addEventListener('click', async () => {
          // Import lazily to avoid circular deps
          const { loadCitationList } = await import('./citations.js');
          document.querySelector('[data-tab="citations"]').click();
          await loadCitationList();
          // Small delay so the list renders
          setTimeout(async () => {
            const { default: openCitationFn } = await import('./citations.js').catch(() => ({}));
          }, 100);
          _toast(`Navigate to Citations tab to view ${r.citekey}`);
        });
      }

      container.appendChild(div);
    });
  } catch (e) {
    container.innerHTML = `<div style="padding:8px;color:var(--danger);font-size:12px">Error: ${esc(e.message)}</div>`;
  }
}
