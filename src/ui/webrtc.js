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
 *      (use ‹ / › to step through them)
 *   2. Other device scans all N QR codes with its camera
 *   3. Other device displays answer QR codes
 *   4. Click "Scan Answer QR" → scan all answer QR codes
 *   5. Connection opens → Push / Pull buttons appear
 *
 * "Scan QR" tab (join / answer side):
 *   1. Click "Scan QR Code" → open camera, scan all offer QR codes
 *      (scanner automatically collects chunks in any order)
 *   2. Answer SDP split into N small QR codes — step through with ‹ / ›
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

// ── Multi-QR display ──────────────────────────────────────────────────────────

/**
 * Render a QR sequence onto a canvas with prev/next navigation buttons.
 * Nav elements are hidden when there is only one QR code.
 */
async function setupQRNav(canvasEl, counterEl, prevBtn, nextBtn, payloads) {
  let idx = 0;

  async function show(i) {
    idx = i;
    await QRCode.toCanvas(canvasEl, payloads[i], {
      width:                Math.min(300, window.innerWidth - 40),
      errorCorrectionLevel: 'L',
      margin:               2,
      color:                { dark: '#000000', light: '#ffffff' },
    });
    const single = payloads.length === 1;
    prevBtn.classList.toggle('hidden', single);
    nextBtn.classList.toggle('hidden', single);
    counterEl.classList.toggle('hidden', single);
    if (!single) {
      counterEl.textContent = `${i + 1} of ${payloads.length}`;
      prevBtn.disabled = i === 0;
      nextBtn.disabled = i === payloads.length - 1;
    }
  }

  prevBtn.onclick = () => { if (idx > 0)                     show(idx - 1); };
  nextBtn.onclick = () => { if (idx < payloads.length - 1)   show(idx + 1); };

  await show(0);
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

  function stopScan() {
    scanAbort?.abort();
    scanAbort = null;
  }

  function closeModal() {
    modal.classList.add('hidden');
    stopScan();
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
    transfer?.abort();
    transfer = null;
    resetHostPanel();
    resetJoinPanel();
  }

  hostTab?.addEventListener('click', () => activateTab('host'));
  joinTab?.addEventListener('click', () => activateTab('join'));

  // ── Shared event wiring ──

  function wireEvents(prefix, t) {
    const logEl  = $(`${prefix}-log`);
    const wrapEl = $(`${prefix}-progress-wrap`);
    const barEl  = $(`${prefix}-progress-bar`);

    t.addEventListener('log',         e => appendLog(logEl, e.message));
    t.addEventListener('progress',    e => setProgress(wrapEl, barEl, e.sent, e.total));
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
  }

  function wireTransferButtons(prefix, t) {
    const logEl   = $(`${prefix}-log`);
    const pushBtn = $(`${prefix}-push-btn`);
    const pullBtn = $(`${prefix}-pull-btn`);

    pushBtn.onclick = async () => {
      pushBtn.disabled = pullBtn.disabled = true;
      try {
        await t.push(storage);
        showToast('Push complete — other device has your data!');
      } catch (err) {
        appendLog(logEl, 'Error: ' + err.message);
        showToast('Push failed: ' + err.message);
      } finally {
        pushBtn.disabled = pullBtn.disabled = false;
      }
    };

    pullBtn.onclick = async () => {
      pushBtn.disabled = pullBtn.disabled = true;
      try {
        const dump = await t.pull(storage);
        const { refreshNoteList }     = await import('./notes.js');
        const { refreshCitationList } = await import('./citations.js');
        await Promise.all([refreshNoteList(), refreshCitationList()]);
        showToast(`Pulled ${dump.notes.length} notes, ${dump.citations.length} citations!`);
      } catch (err) {
        appendLog(logEl, 'Error: ' + err.message);
        showToast('Pull failed: ' + err.message);
      } finally {
        pushBtn.disabled = pullBtn.disabled = false;
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
    showHostState('step1');
    if (hostLog)      { hostLog.textContent = ''; hostLog.style.display = 'none'; }
    if (hostProgWrap)   hostProgWrap.classList.add('hidden');
    if (hostProgBar)    hostProgBar.style.width = '0%';
  }

  $('qr-gen-btn')?.addEventListener('click', async () => {
    stopScan();
    transfer?.abort();
    transfer = new WebRTCTransfer();
    wireEvents('qr-host', transfer);

    try {
      const encoded  = await transfer.createOffer();
      const payloads = encodeForQRs('offer', encoded);
      await setupQRNav(
        $('qr-host-canvas'), $('qr-host-counter'),
        $('qr-host-prev'),   $('qr-host-next'),
        payloads,
      );
      showHostState('qr');
      if (payloads.length > 1) {
        appendLog(hostLog, `Offer split into ${payloads.length} QR codes — use ‹ / › to step through them.`);
      }
    } catch (err) {
      appendLog(hostLog, 'Error: ' + err.message);
      showToast('Failed to create offer: ' + err.message);
      showHostState('step1');
    }
  });

  $('qr-scan-answer-btn')?.addEventListener('click', async () => {
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
      showHostState('qr');
      appendLog(hostLog, 'Answer scanned. Connecting…');
      await transfer.acceptAnswer(compressedSdp);
      showHostState('connected');
      wireTransferButtons('qr-host', transfer);
    } catch (err) {
      if (err.message !== 'Cancelled.') {
        appendLog(hostLog, 'Error: ' + err.message);
        showToast('Connection failed: ' + err.message);
      }
      showHostState('qr');
    }
  });

  $('qr-host-cancel-scan-btn')?.addEventListener('click', () => {
    stopScan();
    showHostState('qr');
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
      const encoded  = await transfer.acceptOffer(compressedSdp);
      const payloads = encodeForQRs('answer', encoded);
      await setupQRNav(
        $('qr-join-canvas'), $('qr-join-counter'),
        $('qr-join-prev'),   $('qr-join-next'),
        payloads,
      );
      showJoinState('answer');
      if (payloads.length > 1) {
        appendLog(joinLog, `Answer split into ${payloads.length} QR codes — use ‹ / › to step through them.`);
      } else {
        appendLog(joinLog, 'Show this answer QR to the other device.');
      }

      // Wait for the host to scan the answer QR (resolves when channel opens)
      transfer.waitForConnection()
        .then(() => {
          showJoinState('connected');
          wireTransferButtons('qr-join', transfer);
        })
        .catch(err => {
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
