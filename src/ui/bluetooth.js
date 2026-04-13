/**
 * Bluetooth transfer UI.
 *
 * Exposes initBluetooth(storage, { showToast }) which wires the Bluetooth
 * modal button and the modal itself.  Call this once from main.js after
 * the DOM is ready.
 */

import { BluetoothTransfer } from '../services/bluetooth.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function setDot(dotEl, state) {
  dotEl.className = 'bt-dot ' + state;
}

function appendLog(logEl, msg) {
  logEl.style.display = 'block';
  logEl.textContent += (logEl.textContent ? '\n' : '') + msg;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(barEl, sent, total) {
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  barEl.style.width = pct + '%';
}

// ── initBluetooth ─────────────────────────────────────────────────────────

/**
 * @param {import('../storage/interface.js').StorageBackend} storage
 * @param {{ showToast: (msg: string) => void }} opts
 */
export function initBluetooth(storage, { showToast }) {
  const modal        = $('bt-modal');
  const openBtn      = $('bt-open-btn');
  const closeBtn     = $('bt-close-btn');
  const supported    = BluetoothTransfer.isSupported();

  if (!modal || !openBtn) return; // HTML not present — skip silently

  // ── Unsupported warning ──

  const unsupportedEl = $('bt-unsupported');
  if (unsupportedEl) {
    unsupportedEl.classList.toggle('hidden', supported);
  }

  // Disable action buttons if not supported
  if (!supported) {
    [$('bt-send-btn'), $('bt-receive-btn')].forEach(b => {
      if (b) { b.disabled = true; b.title = 'Web Bluetooth not available'; }
    });
  }

  // ── Modal open / close ──

  function openModal() {
    modal.classList.remove('hidden');
  }
  function closeModal() {
    modal.classList.add('hidden');
  }

  openBtn.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Close modal also from mobile More panel button
  $('bt-open-btn-more')?.addEventListener('click', openModal);

  // ── Tab switching within the modal ──

  const sendTab    = $('bt-tab-send');
  const receiveTab = $('bt-tab-receive');
  const sendPanel  = $('bt-panel-send');
  const recvPanel  = $('bt-panel-receive');

  function activateBtTab(which) {
    sendTab?.classList.toggle('active',   which === 'send');
    receiveTab?.classList.toggle('active', which === 'receive');
    sendPanel?.classList.toggle('active',  which === 'send');
    recvPanel?.classList.toggle('active',  which === 'receive');
  }

  sendTab?.addEventListener('click',    () => activateBtTab('send'));
  receiveTab?.addEventListener('click', () => activateBtTab('receive'));
  activateBtTab('send'); // default

  // ── Transfer logic ──

  let activeTransfer = null;

  /**
   * Run a transfer (send or receive), updating the relevant panel UI.
   * @param {'send'|'receive'} direction
   * @param {{ dotEl, statusEl, progressBarEl, logEl, actionBtn, cancelBtn }} els
   */
  async function runTransfer(direction, els) {
    const { dotEl, statusEl, progressBarEl, logEl, actionBtn, cancelBtn } = els;

    if (activeTransfer) {
      showToast('A transfer is already in progress.');
      return;
    }

    // Reset UI
    logEl.textContent = '';
    setProgress(progressBarEl, 0, 1);
    setDot(dotEl, 'idle');

    const bt = new BluetoothTransfer();
    activeTransfer = bt;

    // Wire events
    bt.addEventListener('log', e => {
      appendLog(logEl, e.message);
      statusEl.textContent = e.message;
    });
    bt.addEventListener('progress', e => {
      setProgress(progressBarEl, e.sent, e.total);
    });
    bt.addEventListener('statechange', e => {
      setDot(dotEl, e.state === 'done' ? 'connected' : e.state);
    });

    actionBtn.disabled = true;
    cancelBtn.classList.remove('hidden');

    cancelBtn.onclick = () => {
      bt.abort();
      cancelBtn.classList.add('hidden');
      actionBtn.disabled = false;
      activeTransfer = null;
    };

    try {
      if (direction === 'send') {
        await bt.send(storage);
        showToast('Bluetooth send complete!');
      } else {
        const dump = await bt.receive(storage);
        showToast(`Received ${dump.notes.length} notes, ${dump.citations.length} citations.`);
        // Refresh the UI lists so new data appears immediately
        const { refreshNoteList }     = await import('./notes.js');
        const { refreshCitationList } = await import('./citations.js');
        await Promise.all([refreshNoteList(), refreshCitationList()]);
      }
      setDot(dotEl, 'connected');
    } catch (err) {
      setDot(dotEl, 'error');
      appendLog(logEl, `Error: ${err.message}`);
      statusEl.textContent = 'Transfer failed.';
      showToast('Bluetooth transfer failed.');
    } finally {
      activeTransfer = null;
      actionBtn.disabled = false;
      cancelBtn.classList.add('hidden');
    }
  }

  // ── Send button ──

  $('bt-send-btn')?.addEventListener('click', () => {
    runTransfer('send', {
      dotEl:         $('bt-send-dot'),
      statusEl:      $('bt-send-status-text'),
      progressBarEl: $('bt-send-progress-bar'),
      logEl:         $('bt-send-log'),
      actionBtn:     $('bt-send-btn'),
      cancelBtn:     $('bt-send-cancel-btn'),
    });
  });

  // ── Receive button ──

  $('bt-receive-btn')?.addEventListener('click', () => {
    runTransfer('receive', {
      dotEl:         $('bt-recv-dot'),
      statusEl:      $('bt-recv-status-text'),
      progressBarEl: $('bt-recv-progress-bar'),
      logEl:         $('bt-recv-log'),
      actionBtn:     $('bt-receive-btn'),
      cancelBtn:     $('bt-recv-cancel-btn'),
    });
  });
}
