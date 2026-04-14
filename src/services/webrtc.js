/**
 * WebRTC transfer service for Philosophy Notes.
 *
 * Establishes a serverless peer-to-peer connection using WebRTC data channels.
 * Signaling is performed by exchanging SDP offers/answers via QR codes —
 * no server, no account, no cloud.
 *
 * ── Connection flow ──────────────────────────────────────────────────────────
 *
 * Device A (host / offer side):         Device B (join / answer side):
 *   createOffer()  → encoded SDP
 *   [show offer QR] ──── scan ────────▶ acceptOffer(encoded) → encoded SDP
 *                                        [show answer QR]
 *   [scan answer QR]
 *   acceptAnswer(encoded) ────────────▶ waitForConnection()
 *   → connected                         → connected
 *   [push / pull available]             [push / pull available]
 *
 * ── Data-channel message protocol ────────────────────────────────────────────
 *
 * All messages are JSON strings.  A full transfer looks like:
 *
 *   sender  → { type: 'push_start', total: <bytes>, chunks: <n> }
 *   sender  → { type: 'chunk', i: <index>, d: '<base64>' }   × n
 *   sender  → { type: 'push_end' }
 *
 * To request data from the remote peer:
 *   requester → { type: 'pull_request' }
 *   remote    → push_start … chunk … push_end  (same as above, reversed)
 *
 * ── SDP encoding ─────────────────────────────────────────────────────────────
 *
 * SDP strings are compressed with deflate-raw (CompressionStream, available in
 * Chrome 80+, Firefox 113+, Safari 16.4+) then base64url-encoded.
 * The QR payload is:  JSON.stringify({ v: 1, r: 'offer'|'answer', s: '<b64>' })
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB per data-channel message

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── SDP compression ───────────────────────────────────────────────────────────

async function compressSDP(sdp) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(enc.encode(sdp));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  // base64url — no + / = characters that confuse QR decoders
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function decompressSDP(b64url) {
  const b64    = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds     = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Response(ds.readable).text();
}

// ── ICE gathering ─────────────────────────────────────────────────────────────

function waitForIceGathering(pc, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
    // Resolve after timeout with whatever candidates we have
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', handler);
      resolve();
    }, timeoutMs);
  });
}

// ── Chunking helpers ──────────────────────────────────────────────────────────

function splitBytes(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(bytes.slice(i, i + CHUNK_SIZE));
  }
  return chunks.length ? chunks : [new Uint8Array(0)];
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── WebRTCTransfer ────────────────────────────────────────────────────────────

/**
 * Manages a single WebRTC peer-to-peer transfer session.
 *
 * @fires log         { message: string }
 * @fires progress    { sent: number, total: number }
 * @fires statechange { state: 'idle'|'scanning'|'connected'|'transferring' }
 * @fires pull_request                    — remote is requesting our data
 */
export class WebRTCTransfer extends EventTarget {
  constructor() {
    super();
    this._pc      = null;
    this._channel = null;
    this._aborted = false;

    // Channel-open promise (created in _makePeerConnection)
    this._channelOpenPromise = null;
    this._channelOpenResolve = null;
    this._channelOpenReject  = null;

    // Incoming data buffer
    this._recvMeta    = null;
    this._recvChunks  = [];
    this._recvResolve = null;
    this._recvReject  = null;
  }

  // ── Event helpers ─────────────────────────────────────────────────────────

  _log(msg)            { this.dispatchEvent(Object.assign(new Event('log'),         { message: msg })); }
  _progress(sent, tot) { this.dispatchEvent(Object.assign(new Event('progress'),    { sent, total: tot })); }
  _setState(s)         { this.dispatchEvent(Object.assign(new Event('statechange'), { state: s })); }

  // ── Internals ─────────────────────────────────────────────────────────────

  _makePeerConnection() {
    this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this._channelOpenPromise = new Promise((res, rej) => {
      this._channelOpenResolve = res;
      this._channelOpenReject  = rej;
    });

    this._pc.addEventListener('connectionstatechange', () => {
      if (this._pc.connectionState === 'failed') {
        this._channelOpenReject?.(new Error('WebRTC connection failed.'));
      }
    });
  }

  _initChannel(ch) {
    this._channel = ch;
    ch.addEventListener('message', e => this._handleMessage(JSON.parse(e.data)));
    ch.addEventListener('close',   () => this._setState('idle'));
    if (ch.readyState === 'open') {
      this._channelOpenResolve?.();
    } else {
      ch.addEventListener('open',  () => this._channelOpenResolve?.());
      ch.addEventListener('error', () => this._channelOpenReject?.(new Error('Data channel error.')));
    }
  }

  async _waitForChannelOpen(timeoutMs = 60000) {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        'Connection timed out (60 s). Make sure both devices scanned each other\'s QR codes.'
      )), timeoutMs)
    );
    await Promise.race([this._channelOpenPromise, timeout]);
  }

  // ── Offer side (host) ─────────────────────────────────────────────────────

  /**
   * Create a WebRTC offer.
   * @returns {Promise<string>} Encoded offer string — put this in a QR code.
   */
  async createOffer() {
    this._aborted = false;
    this._setState('scanning');
    this._log('Creating WebRTC offer…');

    this._makePeerConnection();
    // The offer side creates the data channel
    this._initChannel(this._pc.createDataChannel('db', { ordered: true }));

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    this._log('Gathering ICE candidates…');
    await waitForIceGathering(this._pc);

    this._log('Offer ready — show QR code to the other device.');
    return compressSDP(this._pc.localDescription.sdp);
  }

  /**
   * Accept the answer QR from the remote and wait for the channel to open.
   * @param {string} encoded - encoded answer SDP from the answer QR.
   */
  async acceptAnswer(encoded) {
    if (!this._pc) throw new Error('No active offer — call createOffer() first.');
    this._log('Processing answer…');
    const sdp = await decompressSDP(encoded);
    await this._pc.setRemoteDescription({ type: 'answer', sdp });
    this._log('Answer set — waiting for connection…');
    await this._waitForChannelOpen();
    this._log('Connected!');
    this._setState('connected');
  }

  // ── Answer side (join) ────────────────────────────────────────────────────

  /**
   * Accept the offer QR and generate an answer.
   * @param {string} encoded - encoded offer SDP from the offer QR.
   * @returns {Promise<string>} Encoded answer string — put this in a QR code.
   */
  async acceptOffer(encoded) {
    this._aborted = false;
    this._log('Processing offer…');
    const sdp = await decompressSDP(encoded);

    this._makePeerConnection();
    // The answer side receives the data channel from the offerer
    this._pc.addEventListener('datachannel', e => this._initChannel(e.channel));

    await this._pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);

    this._log('Gathering ICE candidates…');
    await waitForIceGathering(this._pc);

    this._log('Answer ready — show answer QR to the other device.');
    return compressSDP(this._pc.localDescription.sdp);
  }

  /**
   * Wait for the data channel to open (call this on the answer/join side
   * after displaying the answer QR, while the host scans it).
   */
  async waitForConnection() {
    await this._waitForChannelOpen();
    this._log('Connected!');
    this._setState('connected');
  }

  // ── Message handling ──────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'pull_request':
        this.dispatchEvent(new Event('pull_request'));
        break;

      case 'push_start':
        this._recvMeta   = msg;
        this._recvChunks = [];
        this._log(`Receiving ${msg.chunks} chunks (${msg.total} bytes)…`);
        this._progress(0, msg.chunks);
        break;

      case 'chunk':
        this._recvChunks.push(msg.d);
        this._progress(this._recvChunks.length, this._recvMeta?.chunks ?? 1);
        break;

      case 'push_end': {
        const total    = this._recvMeta?.total ?? 0;
        const allBytes = new Uint8Array(total);
        let pos = 0;
        for (const d of this._recvChunks) {
          const chunk = b64ToBytes(d);
          allBytes.set(chunk, pos);
          pos += chunk.length;
        }
        let dump;
        try { dump = JSON.parse(dec.decode(allBytes)); }
        catch { this._recvReject?.(new Error('Received data is not valid JSON.')); return; }
        this._recvResolve?.(dump);
        break;
      }
    }
  }

  // ── Data transfer ─────────────────────────────────────────────────────────

  _assertConnected() {
    if (this._channel?.readyState !== 'open') {
      throw new Error('Not connected. Establish a WebRTC connection first.');
    }
  }

  /**
   * Export local storage and push it to the remote peer.
   * @param {import('../storage/interface.js').StorageBackend} storage
   */
  async push(storage) {
    this._assertConnected();
    this._setState('transferring');
    this._log('Exporting local data…');

    const dump  = await storage.exportAll();
    const bytes = enc.encode(JSON.stringify(dump));
    const parts = splitBytes(bytes);

    this._log(`Sending ${bytes.length} bytes in ${parts.length} chunks…`);
    this._channel.send(JSON.stringify({
      type: 'push_start', total: bytes.length, chunks: parts.length,
    }));
    this._progress(0, parts.length);

    for (let i = 0; i < parts.length; i++) {
      if (this._aborted) throw new Error('Transfer aborted.');
      this._channel.send(JSON.stringify({ type: 'chunk', i, d: bytesToB64(parts[i]) }));
      this._progress(i + 1, parts.length);
      if ((i + 1) % 10 === 0) this._log(`Sent ${i + 1}/${parts.length} chunks…`);
    }

    this._channel.send(JSON.stringify({ type: 'push_end' }));
    this._log('Push complete!');
    this._setState('connected');
  }

  /**
   * Request data from the remote peer and import it into local storage.
   * @param {import('../storage/interface.js').StorageBackend} storage
   * @returns {Promise<object>} The received dump object.
   */
  async pull(storage) {
    this._assertConnected();
    this._setState('transferring');
    this._log('Requesting data from remote…');

    const dump = await new Promise((res, rej) => {
      this._recvResolve = res;
      this._recvReject  = rej;
      this._channel.send(JSON.stringify({ type: 'pull_request' }));
    });

    if (!dump.notes || !dump.citations) {
      throw new Error('Received data is not a valid Philosophy Notes backup.');
    }

    this._log(`Importing ${dump.notes.length} notes and ${dump.citations.length} citations…`);
    await storage.importAll(dump);
    this._log('Pull complete!');
    this._setState('connected');
    return dump;
  }

  /**
   * Respond to a pull_request from the remote by sending our data.
   * @param {import('../storage/interface.js').StorageBackend} storage
   */
  async respondToPull(storage) {
    await this.push(storage);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  close() {
    this._aborted = true;
    try { this._channel?.close(); } catch { /* ignore */ }
    try { this._pc?.close();      } catch { /* ignore */ }
    this._channel = null;
    this._pc      = null;
    this._setState('idle');
  }

  abort() {
    this.close();
    this._log('Disconnected.');
  }

  get isConnected() {
    return this._channel?.readyState === 'open';
  }

  /** True if WebRTC is available in this browser. */
  static isSupported() {
    return typeof RTCPeerConnection !== 'undefined'
        && typeof CompressionStream !== 'undefined';
  }
}
