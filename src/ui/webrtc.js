/**
 * WebRTC / QR Sync UI.
 *
 * Exposes initWebRTC(storage, { showToast }) which wires the QR sync
 * modal. Call once from main.js after the DOM is ready.
 *
 * ── Two-tab flow ─────────────────────────────────────────────────────────────
 *
 * "Show QR" tab (host / offer side):
 *   1. Click "Generate QR Code" → offer SDP split into N small QR codes
 *      that cycle automatically every 2 s
 *   2. Other device scans all N QR codes with its camera (any order)
 *   3. Other device displays cycling answer QR codes
 *   4. Click "Scan Answer QR" → scan all answer QR codes
 *   5. Connection opens → Push / Pull buttons appear
 *
 * "Scan QR" tab (join / answer side):
 *   1. Click "Scan QR Code" → open camera, scan all offer QR codes
 *      (scanner automatically collects chunks in any order)
 *   2. Answer SDP split into N small QR codes that cycle automatically
 *   3. Other device scans all answer QR codes
 *   4. Connection opens → Push / Pull buttons appear
 *
 * ── QR payload format ────────────────────────────────────────────────────────
 *
 * Each QR code encodes a JSON string:
 *   { "v": 1, "r": "offer"|"answer", "i": <index>, "n": <total>, "s": "<chunk>" }
 *
 * where "s" is a slice of the base64url-encoded compressed SDP (at most
 * MAX_SDP_CHUNK characters), keeping each QR code at a low density so it
 * scans reliably even on low-resolution laptop cameras.
 */

import QRCode from 'qrcode';
import jsQR   from 'jsqr';
import { WebRTCTransfer } from '../services/webrtc.js';

// Maximum characters of compressed SDP per QR code.
// Keeping this small produces low-density QR codes (≈ version 8–9, 49–53
// modules) that are easy to scan at modest camera resolutions.
const MAX_SDP_CHUNK = 150;

// ── Helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function appendLog(logEl, msg) {
  if (!logEl) return;
  logEl.style.display = 'block';
  logEl.textContent  += (logEl.textContent ? '\n' : '') + msg;
  logEl.scrollTop     = logEl.scrollHeight;
}

function setProgress(wrapEl, barEl, sent, total) {
  wrapEl?.classList.remove('hidden');
  if (barEl) barEl.style.width = (total > 0 ? Math.round((sent / total) * 100) : 0) + '%';
}

// ── QR chunking ───────────────────────────────────────────────────────────────

/**
 * Split a compressed SDP string into an array of JSON QR payloads,
 * each containing at most MAX_SDP_CHUNK characters of data.
 */
function encodeForQRs(role, compressedSdp) {
  const chunks = [];
  for (let i = 0; i < compressedSdp.length; i += MAX_SDP_CHUNK) {
    chunks.push(compressedSdp.slice(i, i + MAX_SDP_CHUNK));
  }
  if (!chunks.length) chunks.push('');
  const n = chunks.length;
  return chunks.map((s, i) => JSON.stringify({ v: 1, r: role, i, n, s }));
}

// ── Auto-cycling QR display ───────────────────────────────────────────────────

const QR_CYCLE_MS = 200; // milliseconds per QR code

/**
 * Render a QR sequence onto a canvas, cycling automatically every QR_CYCLE_MS.
 * The counter element shows "1 of N" and is hidden when N = 1.
 * Returns a stop() function — call it to cancel the cycle.
 */
async function startQRCycle(canvasEl, counterEl, payloads) {
  let idx      = 0;
  let timerId  = null;

  async function show(i) {
    idx = i;
    await QRCode.toCanvas(canvasEl, payloads[i], {
      width:                Math.min(300, window.innerWidth - 40),
      errorCorrectionLevel: 'L',
      margin:               2,
      color:                { dark: '#000000', light: '#ffffff' },
    });
    const single = payloads.length === 1;
    counterEl.classList.toggle('hidden', single);
    if (!single) counterEl.textContent = `${i + 1} of ${payloads.length}`;
  }

  await show(0);
  if (payloads.length > 1) {
    timerId = setInterval(() => show((idx + 1) % payloads.length), QR_CYCLE_MS);
  }

  return function stop() {
    clearInterval(timerId);
    timerId = null;
  };
}

// ── Camera QR scanner ─────────────────────────────────────────────────────────

/**
 * Open the device camera and scan QR codes until all N chunks in the
 * sequence have been received (in any order).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {(received: number, total: number|null) => void} onProgress
 * @param {AbortSignal} signal
 * @returns {Promise<{ compressedSdp: string, role: string }>}
 */
function scanAllQRChunks(videoEl, onProgress, signal) {
  return new Promise(async (resolve, reject) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
    } catch (err) {
      reject(new Error('Camera access denied: ' + err.message));
      return;
    }

    if (signal.aborted) {
      stream.getTracks().forEach(t => t.stop());
      reject(new Error('Cancelled.'));
      return;
    }

    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch { /* some browsers require a user gesture */ }

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });
    let   done   = false;

    const cleanup = () => {
      done = true;
      stream.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    };

    signal.addEventListener('abort', () => { cleanup(); reject(new Error('Cancelled.')); });

    const received = new Map(); // chunk index → chunk string
    let   total    = null;
    let   role     = null;

    onProgress(0, null);

    const tick = () => {
      if (done) return;
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        canvas.width  = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        const img    = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(img.data, img.width, img.height);

        if (result?.data) {
          try {
            const p = JSON.parse(result.data);
            if (p.v === 1 && typeof p.i === 'number' && typeof p.n === 'number') {
              if (total === null) total = p.n;
              if (role  === null) role  = p.r;
              if (!received.has(p.i)) {
                received.set(p.i, p.s ?? '');
                onProgress(received.size, total);
              }
              if (received.size === total) {
                const compressedSdp = Array.from(
                  { length: total }, (_, i) => received.get(i) ?? ''
                ).join('');
                cleanup();
                resolve({ compressedSdp, role });
                return;
              }
            }
          } catch { /* not our QR format — ignore */ }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ── initWebRTC ────────────────────────────────────────────────────────────────

/**
 * @param {import('../storage/interface.js').StorageBackend} storage
 * @param {{ showToast: (msg: string) => void }} opts
 */
export function initWebRTC(storage, { showToast }) {
  const modal   = $('qr-modal');
  const openBtn = $('qr-open-btn');
  if (!modal || !openBtn) return;

  let transfer  = null;
  let scanAbort = null;
  let stopCycle = null; // cancel function returned by startQRCycle

  // Stored payloads so the cycle can restart if a scan is cancelled mid-way
  let hostOfferPayloads = null;
  let joinAnswerPayloads = null;

  function stopScan() {
    scanAbort?.abort();
    scanAbort = null;
  }

  function stopCycler() {
    stopCycle?.();
    stopCycle = null;
  }

  function closeModal() {
    modal.classList.add('hidden');
    stopScan();
    stopCycler();
    transfer?.abort();
    transfer = null;
    resetUI();
  }

  openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
  $('qr-open-btn-more')?.addEventListener('click', () => modal.classList.remove('hidden'));
  $('qr-close-btn')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // ── Tab switching ──

  const hostTab   = $('qr-tab-host');
  const joinTab   = $('qr-tab-join');
  const hostPanel = $('qr-panel-host');
  const joinPanel = $('qr-panel-join');

  function activateTab(which) {
    hostTab?.classList.toggle('active', which === 'host');
    joinTab?.classList.toggle('active', which === 'join');
    hostPanel?.classList.toggle('active', which === 'host');
    joinPanel?.classList.toggle('active', which === 'join');
    stopScan();
    stopCycler();
    transfer?.abort();
    transfer = null;
    resetHostPanel();
    resetJoinPanel();
  }

  hostTab?.addEventListener('click', () => activateTab('host'));
  joinTab?.addEventListener('click', () => activateTab('join'));

  // ── Merge helpers ─────────────────────────────────────────────────────────

  function newUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Show a conflict-resolution dialog for a single overlapping item.
   * Resolves with 'newer' (discard the older copy) or 'both' (keep both).
   */
  function showConflictDialog({ kind, title, localUpdated, remoteUpdated, isNewerLocal }) {
    return new Promise(resolve => {
      const newerSide = isNewerLocal ? 'local'  : 'remote';
      const olderSide = isNewerLocal ? 'remote' : 'local';
      const newerDate = new Date(isNewerLocal ? localUpdated : remoteUpdated).toLocaleString();
      const olderDate = new Date(isNewerLocal ? remoteUpdated : localUpdated).toLocaleString();

      const overlay = document.createElement('div');
      overlay.className = 'conflict-overlay';
      overlay.innerHTML = `
        <div class="conflict-dialog">
          <p class="conflict-label">Sync conflict &mdash; ${kind === 'note' ? 'Note' : 'Citation'}</p>
          <p class="conflict-item-name">&ldquo;${escapeHtml(title)}&rdquo;</p>
          <p class="conflict-desc">
            Both devices have this ${kind}. The <strong>${newerSide} version</strong> is newer.
          </p>
          <table class="conflict-table">
            <tr>
              <td class="conflict-side newer">Newer &mdash; ${newerSide}</td>
              <td class="conflict-date">${newerDate}</td>
            </tr>
            <tr>
              <td class="conflict-side older">Older &mdash; ${olderSide}</td>
              <td class="conflict-date">${olderDate}</td>
            </tr>
          </table>
          <p class="conflict-question">Keep only the newer version, or duplicate both?</p>
          <div class="conflict-btns">
            <button class="btn-primary conflict-newer-btn">Use newer version</button>
            <button class="btn-ghost conflict-both-btn">Keep both</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);

      overlay.querySelector('.conflict-newer-btn').onclick = () => {
        document.body.removeChild(overlay);
        resolve('newer');
      };
      overlay.querySelector('.conflict-both-btn').onclick = () => {
        document.body.removeChild(overlay);
        resolve('both');
      };
    });
  }

  /**
   * Compute the merged database from two dumps, showing a conflict dialog
   * for each overlapping item.  Returns a new dump ready for importAll().
   */
  async function performMerge(localDump, remoteDump) {
    const mergedNotes      = [];
    const mergedCitations  = [];

    // ── Notes (keyed by id / UUID) ──────────────────────────────────────────
    const localNoteMap  = new Map((localDump.notes  ?? []).map(n => [n.id, n]));
    const remoteNoteMap = new Map((remoteDump.notes ?? []).map(n => [n.id, n]));

    // Items only on one side — take as-is
    for (const [id, n] of localNoteMap)  if (!remoteNoteMap.has(id)) mergedNotes.push(n);
    for (const [id, n] of remoteNoteMap) if (!localNoteMap.has(id))  mergedNotes.push(n);

    // Items on both sides — resolve conflicts
    for (const [id, localNote] of localNoteMap) {
      if (!remoteNoteMap.has(id)) continue;
      const remoteNote = remoteNoteMap.get(id);

      if (localNote.updated_at === remoteNote.updated_at) {
        // Same timestamp → treat as identical, keep one copy
        mergedNotes.push(localNote);
        continue;
      }

      const isNewerLocal = localNote.updated_at > remoteNote.updated_at;
      const newerNote    = isNewerLocal ? localNote  : remoteNote;
      const olderNote    = isNewerLocal ? remoteNote : localNote;

      const choice = await showConflictDialog({
        kind: 'note',
        title: localNote.title || localNote.id,
        localUpdated:  localNote.updated_at,
        remoteUpdated: remoteNote.updated_at,
        isNewerLocal,
      });

      mergedNotes.push(newerNote);
      if (choice === 'both') {
        mergedNotes.push({
          ...olderNote,
          id:    newUUID(),
          title: `[Older copy] ${olderNote.title}`,
          slug:  `older-copy-${olderNote.slug || olderNote.id}`,
        });
      }
    }

    // ── Citations (keyed by citekey) ─────────────────────────────────────────
    const localCiteMap  = new Map((localDump.citations  ?? []).map(c => [c.citekey, c]));
    const remoteCiteMap = new Map((remoteDump.citations ?? []).map(c => [c.citekey, c]));

    for (const [k, c] of localCiteMap)  if (!remoteCiteMap.has(k)) mergedCitations.push(c);
    for (const [k, c] of remoteCiteMap) if (!localCiteMap.has(k))  mergedCitations.push(c);

    for (const [key, localCite] of localCiteMap) {
      if (!remoteCiteMap.has(key)) continue;
      const remoteCite = remoteCiteMap.get(key);

      if (localCite.updated_at === remoteCite.updated_at) {
        mergedCitations.push(localCite);
        continue;
      }

      const isNewerLocal = localCite.updated_at > remoteCite.updated_at;
      const newerCite    = isNewerLocal ? localCite  : remoteCite;
      const olderCite    = isNewerLocal ? remoteCite : localCite;

      const choice = await showConflictDialog({
        kind: 'citation',
        title: localCite.title || localCite.citekey,
        localUpdated:  localCite.updated_at,
        remoteUpdated: remoteCite.updated_at,
        isNewerLocal,
      });

      mergedCitations.push(newerCite);
      if (choice === 'both') {
        mergedCitations.push({
          ...olderCite,
          citekey: `${olderCite.citekey}-old`,
        });
      }
    }

    return {
      version:     1,
      exported_at: new Date().toISOString(),
      backend:     'indexeddb',
      notes:       mergedNotes,
      citations:   mergedCitations,
    };
  }

  /**
   * Run the full merge pipeline: compute merged dump (with user dialogs),
   * write to storage, then refresh both list panels.
   */
  async function runMerge(localDump, remoteDump, logEl) {
    appendLog(logEl, 'Resolving conflicts…');
    const mergedDump = await performMerge(localDump, remoteDump);
    await storage.importAll(mergedDump);
    const { refreshNoteList }     = await import('./notes.js');
    const { refreshCitationList } = await import('./citations.js');
    await Promise.all([refreshNoteList(), refreshCitationList()]);
    const nc = mergedDump.notes.length;
    const cc = mergedDump.citations.length;
    appendLog(logEl, `Merge complete: ${nc} note${nc !== 1 ? 's' : ''}, ${cc} citation${cc !== 1 ? 's' : ''}.`);
    showToast(`Sync complete: ${nc} notes, ${cc} citations.`);
  }

  // ── Shared event wiring ──

  function wireEvents(prefix, t) {
    const logEl  = $(`${prefix}-log`);
    const wrapEl = $(`${prefix}-progress-wrap`);
    const barEl  = $(`${prefix}-progress-bar`);

    t.addEventListener('log',      e => appendLog(logEl, e.message));
    t.addEventListener('progress', e => setProgress(wrapEl, barEl, e.sent, e.total));

    // Legacy: respond if the remote uses the old pull_request protocol
    t.addEventListener('pull_request', async () => {
      appendLog(logEl, 'Remote is pulling our data…');
      try {
        await t.respondToPull(storage);
        showToast('Remote device received your data!');
      } catch (err) {
        appendLog(logEl, 'Error responding to pull: ' + err.message);
        showToast('Failed to send data to remote.');
      }
    });

    // New merge-sync: remote initiated — send our data back then merge
    t.addEventListener('sync_received', async e => {
      const remoteDump = e.dump;
      appendLog(logEl, 'Remote started merge sync. Sending local data back…');
      const syncBtn = $(`${prefix}-sync-btn`);
      if (syncBtn) syncBtn.disabled = true;
      try {
        // Snapshot local state before any merge (push() re-exports internally,
        // but we need the same snapshot for the merge step below)
        const localDump = await storage.exportAll();
        // Respond to the initiator with our pre-merge state
        await t.push(storage);
        appendLog(logEl, 'Local data sent. Merging…');
        await runMerge(localDump, remoteDump, logEl);
      } catch (err) {
        appendLog(logEl, 'Merge error: ' + err.message);
        showToast('Merge failed: ' + err.message);
      } finally {
        if (syncBtn) syncBtn.disabled = false;
      }
    });
  }

  function wireSyncButton(prefix, t) {
    const logEl   = $(`${prefix}-log`);
    const syncBtn = $(`${prefix}-sync-btn`);

    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      try {
        const { localDump, remoteDump } = await t.sync(storage);
        appendLog(logEl, 'Both databases received. Merging…');
        await runMerge(localDump, remoteDump, logEl);
      } catch (err) {
        appendLog(logEl, 'Error: ' + err.message);
        showToast('Sync failed: ' + err.message);
      } finally {
        syncBtn.disabled = false;
      }
    };
  }

  // ── Host panel (offer side) ───────────────────────────────────────────────

  const hostStep1     = $('qr-host-step1');
  const hostQrWrap    = $('qr-host-qr-wrap');
  const hostScanWrap  = $('qr-host-scan-wrap');
  const hostConnected = $('qr-host-connected');
  const hostLog       = $('qr-host-log');
  const hostProgWrap  = $('qr-host-progress-wrap');
  const hostProgBar   = $('qr-host-progress-bar');

  function showHostState(state) {
    hostStep1?.classList.toggle('hidden',     state !== 'step1');
    hostQrWrap?.classList.toggle('hidden',    state !== 'qr');
    hostScanWrap?.classList.toggle('hidden',  state !== 'scan');
    hostConnected?.classList.toggle('hidden', state !== 'connected');
  }

  function resetHostPanel() {
    stopCycler();
    hostOfferPayloads = null;
    showHostState('step1');
    if (hostLog)      { hostLog.textContent = ''; hostLog.style.display = 'none'; }
    if (hostProgWrap)   hostProgWrap.classList.add('hidden');
    if (hostProgBar)    hostProgBar.style.width = '0%';
  }

  async function startHostCycle(payloads) {
    stopCycler();
    stopCycle = await startQRCycle($('qr-host-canvas'), $('qr-host-counter'), payloads);
    showHostState('qr');
  }

  $('qr-gen-btn')?.addEventListener('click', async () => {
    stopScan();
    stopCycler();
    transfer?.abort();
    transfer = new WebRTCTransfer();
    wireEvents('qr-host', transfer);

    try {
      const encoded  = await transfer.createOffer();
      hostOfferPayloads = encodeForQRs('offer', encoded);
      await startHostCycle(hostOfferPayloads);
      if (hostOfferPayloads.length > 1) {
        appendLog(hostLog, `Offer split into ${hostOfferPayloads.length} QR codes, cycling automatically.`);
      }
    } catch (err) {
      appendLog(hostLog, 'Error: ' + err.message);
      showToast('Failed to create offer: ' + err.message);
      showHostState('step1');
    }
  });

  $('qr-scan-answer-btn')?.addEventListener('click', async () => {
    stopCycler(); // pause cycle while camera is open
    showHostState('scan');
    scanAbort = new AbortController();
    const statusEl = $('qr-host-scan-status');

    try {
      const { compressedSdp, role } = await scanAllQRChunks(
        $('qr-host-video'),
        (rcvd, tot) => {
          if (!statusEl) return;
          if (tot === null)    statusEl.textContent = 'Scanning…';
          else if (rcvd < tot) statusEl.textContent = `Scanned ${rcvd} of ${tot} QR codes — show the next one.`;
          else                 statusEl.textContent = `All ${tot} QR code${tot !== 1 ? 's' : ''} scanned!`;
        },
        scanAbort.signal,
      );

      if (role !== 'answer') throw new Error('Not a valid answer QR code.');
      showHostState('qr'); // briefly visible while acceptAnswer runs
      appendLog(hostLog, 'Answer scanned. Connecting…');
      await transfer.acceptAnswer(compressedSdp);
      stopCycler(); // connected — no need to keep cycling
      showHostState('connected');
      wireSyncButton('qr-host', transfer);
    } catch (err) {
      if (err.message !== 'Cancelled.') {
        appendLog(hostLog, 'Error: ' + err.message);
        showToast('Connection failed: ' + err.message);
      }
      // Resume cycling the offer QR so the other device can re-scan
      if (hostOfferPayloads) await startHostCycle(hostOfferPayloads);
      else showHostState('qr');
    }
  });

  $('qr-host-cancel-scan-btn')?.addEventListener('click', async () => {
    stopScan();
    // Resume cycling so the other device can keep scanning
    if (hostOfferPayloads) await startHostCycle(hostOfferPayloads);
    else showHostState('qr');
  });

  // ── Join panel (answer side) ──────────────────────────────────────────────

  const joinStep1      = $('qr-join-step1');
  const joinScanWrap   = $('qr-join-scan-wrap');
  const joinAnswerWrap = $('qr-join-answer-wrap');
  const joinConnected  = $('qr-join-connected');
  const joinLog        = $('qr-join-log');
  const joinProgWrap   = $('qr-join-progress-wrap');
  const joinProgBar    = $('qr-join-progress-bar');

  function showJoinState(state) {
    joinStep1?.classList.toggle('hidden',      state !== 'step1');
    joinScanWrap?.classList.toggle('hidden',   state !== 'scan');
    joinAnswerWrap?.classList.toggle('hidden', state !== 'answer');
    joinConnected?.classList.toggle('hidden',  state !== 'connected');
  }

  function resetJoinPanel() {
    stopCycler();
    joinAnswerPayloads = null;
    showJoinState('step1');
    if (joinLog)      { joinLog.textContent = ''; joinLog.style.display = 'none'; }
    if (joinProgWrap)   joinProgWrap.classList.add('hidden');
    if (joinProgBar)    joinProgBar.style.width = '0%';
  }

  function resetUI() {
    resetHostPanel();
    resetJoinPanel();
  }

  $('qr-scan-offer-btn')?.addEventListener('click', async () => {
    showJoinState('scan');
    scanAbort = new AbortController();
    const statusEl = $('qr-join-scan-status');

    try {
      const { compressedSdp, role } = await scanAllQRChunks(
        $('qr-join-video'),
        (rcvd, tot) => {
          if (!statusEl) return;
          if (tot === null)    statusEl.textContent = 'Scanning…';
          else if (rcvd < tot) statusEl.textContent = `Scanned ${rcvd} of ${tot} QR codes — show the next one.`;
          else                 statusEl.textContent = `All ${tot} QR code${tot !== 1 ? 's' : ''} scanned!`;
        },
        scanAbort.signal,
      );

      if (role !== 'offer') throw new Error('Not a valid offer QR code.');

      showJoinState('step1');
      transfer?.abort();
      transfer = new WebRTCTransfer();
      wireEvents('qr-join', transfer);

      appendLog(joinLog, 'Offer scanned. Generating answer…');
      const encoded   = await transfer.acceptOffer(compressedSdp);
      joinAnswerPayloads = encodeForQRs('answer', encoded);
      stopCycler();
      stopCycle = await startQRCycle($('qr-join-canvas'), $('qr-join-counter'), joinAnswerPayloads);
      showJoinState('answer');
      if (joinAnswerPayloads.length > 1) {
        appendLog(joinLog, `Answer split into ${joinAnswerPayloads.length} QR codes, cycling automatically.`);
      } else {
        appendLog(joinLog, 'Show this answer QR to the other device.');
      }

      // Wait for the host to scan the answer QR (resolves when channel opens)
      transfer.waitForConnection()
        .then(() => {
          stopCycler(); // connected — stop cycling
          showJoinState('connected');
          wireSyncButton('qr-join', transfer);
        })
        .catch(err => {
          stopCycler();
          appendLog(joinLog, 'Connection failed: ' + err.message);
          showToast('Connection failed: ' + err.message);
          showJoinState('step1');
        });

    } catch (err) {
      if (err.message !== 'Cancelled.') {
        appendLog(joinLog, 'Error: ' + err.message);
        showToast(err.message);
      }
      showJoinState('step1');
    }
  });

  $('qr-join-cancel-scan-btn')?.addEventListener('click', () => {
    stopScan();
    showJoinState('step1');
  });

  // ── Initialise ──

  resetUI();
  activateTab('host');
}
