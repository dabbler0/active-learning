/**
 * Application entry point.
 *
 * Responsibilities:
 *  - Instantiate storage backend
 *  - Wire tab navigation (Notes | Citations | Search)
 *  - Initialise UI modules (including Bluetooth)
 *  - Handle Export / Import
 *  - Handle Settings modal
 *  - Handle mobile bottom navigation
 */

import { IndexedDBBackend } from './storage/indexeddb.js';
import { initNotes, openNote, refreshNoteList } from './ui/notes.js';
import { initCitations, updateCitationSettings, openCitation, refreshCitationList } from './ui/citations.js';
import { initSearch } from './ui/search.js';
import { initBluetooth } from './ui/bluetooth.js';

// ── Storage ────────────────────────────────────────────────────────────────

const storage = new IndexedDBBackend();

// ── Settings (persisted in localStorage — lightweight key/value) ───────────

const SETTINGS_KEY = 'philosophy-js-settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// ── Resizable panels (desktop only) ───────────────────────────────────────

function initResizePanels() {
  const main = document.getElementById('main');
  const s    = loadSettings();
  let leftW  = s.leftPanelWidth  ?? 280;
  let rightW = s.rightPanelWidth ?? 360;

  function applyColumns() {
    // Only apply grid columns on desktop (> 768px)
    if (window.innerWidth > 768) {
      main.style.gridTemplateColumns = `${leftW}px 4px 1fr 4px ${rightW}px`;
    }
  }
  applyColumns();

  function attachDrag(handleId, onMousedown) {
    document.getElementById(handleId)?.addEventListener('mousedown', e => {
      e.preventDefault();
      document.getElementById(handleId).classList.add('dragging');
      const startX     = e.clientX;
      const startLeft  = leftW;
      const startRight = rightW;

      const onMove = e2 => { onMousedown(e2.clientX - startX, startLeft, startRight); applyColumns(); };
      const onUp   = ()  => {
        document.getElementById(handleId).classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        saveSettings({ leftPanelWidth: leftW, rightPanelWidth: rightW });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  attachDrag('resize-left',  (dx, startL) => { leftW  = Math.max(180, Math.min(600, startL + dx)); });
  attachDrag('resize-right', (dx, _sl, startR) => { rightW = Math.max(180, Math.min(700, startR - dx)); });

  // Re-apply grid on resize (e.g. rotating a tablet)
  window.addEventListener('resize', applyColumns);
}

// ── Tab switching ──────────────────────────────────────────────────────────

function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.list-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `${tab}-panel`);
  });
}

// ── Mobile bottom navigation ───────────────────────────────────────────────

function initMobileNav() {
  const main       = document.getElementById('main');
  const mobileNav  = document.getElementById('mobile-nav');

  if (!mobileNav) return;

  function activateMobilePanel(panel) {
    main.dataset.mobilePanel = panel;
    mobileNav.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.panel === panel);
    });
    // Show the bt-send-log / bt-recv-log divs when panel contains logs
  }

  mobileNav.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => activateMobilePanel(btn.dataset.panel));
  });

  // After opening a note or citation, switch to the edit panel on mobile
  window.addEventListener('mobile-open-edit', () => {
    if (window.innerWidth <= 768) activateMobilePanel('edit');
  });

  // After list tab switching, switch to list panel on mobile
  window.addEventListener('mobile-open-list', () => {
    if (window.innerWidth <= 768) activateMobilePanel('list');
  });
}

// ── Import / Export ────────────────────────────────────────────────────────

async function exportData() {
  const dump = await storage.exportAll();
  const json = JSON.stringify(dump, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);

  const date = new Date().toISOString().slice(0, 10);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `philosophy-notes-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported successfully');
}

function importData() {
  const input = document.createElement('input');
  input.type  = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const dump = JSON.parse(text);
      if (!dump.notes || !dump.citations) throw new Error('Invalid backup file format.');
      if (!confirm(`This will replace ALL notes and citations with data from "${file.name}". Continue?`)) return;
      await storage.importAll(dump);
      await refreshNoteList();
      await refreshCitationList();
      showToast('Import successful');
    } catch (e) {
      alert(`Import failed: ${e.message}`);
    }
  };
  input.click();
}

// ── Settings modal ─────────────────────────────────────────────────────────

function openSettings() {
  const s = loadSettings();
  document.getElementById('s-author').value = s.author ?? '';
  document.getElementById('s-crossref').checked     = s.crossrefEnabled     !== false;
  document.getElementById('s-openlibrary').checked  = s.openlibraryEnabled  !== false;
  document.getElementById('settings-modal')?.classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal')?.classList.add('hidden');
}

function applySettings() {
  const next = saveSettings({
    author:             document.getElementById('s-author').value.trim(),
    crossrefEnabled:    document.getElementById('s-crossref').checked,
    openlibraryEnabled: document.getElementById('s-openlibrary').checked,
  });
  updateCitationSettings({
    crossrefEnabled:    next.crossrefEnabled,
    openlibraryEnabled: next.openlibraryEnabled,
  });
  closeSettings();
  showToast('Settings saved');
}

// ── Toast ──────────────────────────────────────────────────────────────────

let _toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  const settings = loadSettings();

  // ── Initialise modules ──
  await Promise.all([
    initNotes(storage, {
      getCitations: () => storage.listCitations(),
    }),
    initCitations(storage, {
      crossrefEnabled:    settings.crossrefEnabled !== false,
      openlibraryEnabled: settings.openlibraryEnabled !== false,
    }),
  ]);

  initSearch(storage, {
    onNoteClick: note => {
      activateTab('notes');
      openNote(note);
      window.dispatchEvent(new Event('mobile-open-edit'));
    },
    onCitationClick: c => {
      activateTab('citations');
      openCitation(c);
      window.dispatchEvent(new Event('mobile-open-edit'));
    },
  });

  // ── Tab buttons ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
      window.dispatchEvent(new Event('mobile-open-list'));
    });
  });

  // ── Settings ──
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('settings-btn-more')?.addEventListener('click', openSettings);
  document.getElementById('save-settings-btn')?.addEventListener('click', applySettings);
  document.getElementById('cancel-settings-btn')?.addEventListener('click', closeSettings);
  document.getElementById('settings-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('settings-modal')) closeSettings();
  });

  // ── Export / Import ──
  document.getElementById('export-btn')?.addEventListener('click', exportData);
  document.getElementById('import-btn')?.addEventListener('click', importData);
  // Mobile "More" panel buttons mirror the toolbar
  document.getElementById('export-btn-more')?.addEventListener('click', exportData);
  document.getElementById('import-btn-more')?.addEventListener('click', importData);

  // ── Bluetooth ──
  initBluetooth(storage, { showToast });

  // ── Resizable panels ──
  initResizePanels();

  // ── Mobile navigation ──
  initMobileNav();

  // ── Storage backend info ──
  const beLabel = document.getElementById('backend-label');
  if (beLabel) beLabel.textContent = storage.name;
  const beLabelMore = document.getElementById('backend-label-more');
  if (beLabelMore) beLabelMore.textContent = storage.name;
}

boot().catch(err => {
  console.error('Boot error:', err);
  alert(`Fatal error during startup: ${err.message}`);
});
