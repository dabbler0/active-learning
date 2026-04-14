/**
 * WebRTC / QR Sync UI.
 *
 * Exposes initWebRTC(storage, { showToast }) which wires the QR sync
 * modal. Call once from main.js after the DOM is ready.
 *
 * ── Two-tab flow ─────────────────────────────────────────────────────────────
 *
 * "Show QR" tab (host / offer side):
 *   1. Click "Generate QR Code" → shows offer QR
 *   2. Other device scans it and displays an answer QR
 *   3. Click "Scan Answer QR" → open camera, scan answer QR
 *   4. Connection opens → Push / Pull buttons appear
 *
 * "Scan QR" tab (join / answer side):
 *   1. Click "Scan QR Code" → open camera, scan offer QR
 *   2. Automatically generates answer, displays answer QR
 *   3. Other device scans the answer QR
 *   4. Connection opens → Push / Pull buttons appear
 */

import QRCode from 'qrcode';
import jsQR   from 'jsqr';
import { WebRTCTransfer } from '../services/webrtc.js';

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

async function renderQR(canvasEl, text) {
  await QRCode.toCanvas(canvasEl, text, {
    width:                Math.min(260, window.innerWidth - 96),
    errorCorrectionLevel: 'L',   // Low: maximises data capacity for large SDPs
    margin:               2,
    color:                { dark: '#000000', light: '#ffffff' },
  });
}

// ── Camera / QR-scan helpers ──────────────────────────────────────────────────

/**
 * Open the device camera, run jsQR on each frame, resolve with the first
 * decoded QR string, then stop the stream.
 * @param {HTMLVideoElement} videoEl
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
function scanQRFromCamera(videoEl, signal) {
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

    if (signal.aborted) { stream.getTracks().forEach(t => t.stop()); reject(new Error('Cancelled.')); return; }

    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch { /* autoplay may throw on some browsers */ }

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d', { willReadFrequently: true });
    let   done   = false;

    const cleanup = () => {
      done = true;
      stream.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    };

    signal.addEventListener('abort', () => { cleanup(); reject(new Error('Cancelled.')); });

    const tick = () => {
      if (done) return;
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        canvas.width  = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result    = jsQR(imageData.data, imageData.width, imageData.height);
        if (result?.data) {
          cleanup();
          resolve(result.data);
          return;
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

  // ── Transfer state ──

  let transfer   = null;
  let scanAbort  = null;   // AbortController for the active camera scan

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

  // ── Shared event wiring ───────────────────────────────────────────────────

  function wireEvents(prefix, t) {
    const logEl   = $(`${prefix}-log`);
    const wrapEl  = $(`${prefix}-progress-wrap`);
    const barEl   = $(`${prefix}-progress-bar`);

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
    const logEl  = $(`${prefix}-log`);
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

  // ── Host panel helpers ────────────────────────────────────────────────────

  const hostStep1      = $('qr-host-step1');
  const hostQrWrap     = $('qr-host-qr-wrap');
  const hostScanWrap   = $('qr-host-scan-wrap');
  const hostConnected  = $('qr-host-connected');
  const hostLog        = $('qr-host-log');
  const hostProgWrap   = $('qr-host-progress-wrap');
  const hostProgBar    = $('qr-host-progress-bar');

  function showHostState(state) {
    hostStep1?.classList.toggle('hidden',     state !== 'step1');
    hostQrWrap?.classList.toggle('hidden',    state !== 'qr');
    hostScanWrap?.classList.toggle('hidden',  state !== 'scan');
    hostConnected?.classList.toggle('hidden', state !== 'connected');
  }

  function resetHostPanel() {
    showHostState('step1');
    if (hostLog)     { hostLog.textContent = ''; hostLog.style.display = 'none'; }
    if (hostProgWrap) hostProgWrap.classList.add('hidden');
    if (hostProgBar)  hostProgBar.style.width = '0%';
  }

  // Generate offer QR
  $('qr-gen-btn')?.addEventListener('click', async () => {
    stopScan();
    transfer?.abort();
    transfer = new WebRTCTransfer();
    wireEvents('qr-host', transfer);

    try {
      const encoded = await transfer.createOffer();
      const qrText  = JSON.stringify({ v: 1, r: 'offer', s: encoded });
      await renderQR($('qr-host-canvas'), qrText);
      showHostState('qr');
    } catch (err) {
      appendLog(hostLog, 'Error: ' + err.message);
      showToast('Failed to create offer: ' + err.message);
      showHostState('step1');
    }
  });

  // Scan the answer QR shown by the join device
  $('qr-scan-answer-btn')?.addEventListener('click', async () => {
    showHostState('scan');
    scanAbort = new AbortController();

    try {
      const raw     = await scanQRFromCamera($('qr-host-video'), scanAbort.signal);
      const payload = JSON.parse(raw);
      if (payload.v !== 1 || payload.r !== 'answer') throw new Error('Not a valid answer QR code.');

      showHostState('qr'); // hide camera while processing
      appendLog(hostLog, 'Answer QR scanned. Connecting…');

      await transfer.acceptAnswer(payload.s);
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

  // ── Join panel helpers ────────────────────────────────────────────────────

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
    joinAnswerWrap?.classList.toggle('hidden', state !== 'answer' && state !== 'connected');
    joinConnected?.classList.toggle('hidden',  state !== 'connected');
  }

  function resetJoinPanel() {
    showJoinState('step1');
    if (joinLog)     { joinLog.textContent = ''; joinLog.style.display = 'none'; }
    if (joinProgWrap) joinProgWrap.classList.add('hidden');
    if (joinProgBar)  joinProgBar.style.width = '0%';
  }

  function resetUI() {
    resetHostPanel();
    resetJoinPanel();
  }

  // Scan the offer QR shown by the host device
  $('qr-scan-offer-btn')?.addEventListener('click', async () => {
    showJoinState('scan');
    scanAbort = new AbortController();

    try {
      const raw = await scanQRFromCamera($('qr-join-video'), scanAbort.signal);
      showJoinState('step1'); // hide camera while processing

      const payload = JSON.parse(raw);
      if (payload.v !== 1 || payload.r !== 'offer') throw new Error('Not a valid offer QR code.');

      // New transfer for this session
      transfer?.abort();
      transfer = new WebRTCTransfer();
      wireEvents('qr-join', transfer);

      appendLog(joinLog, 'Offer QR scanned. Generating answer…');

      const encoded = await transfer.acceptOffer(payload.s);
      const qrText  = JSON.stringify({ v: 1, r: 'answer', s: encoded });
      await renderQR($('qr-join-canvas'), qrText);

      showJoinState('answer');
      appendLog(joinLog, 'Show this answer QR to the other device, then wait…');

      // Wait for the host to scan the answer QR (runs in background)
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
