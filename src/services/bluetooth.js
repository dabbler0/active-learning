/**
 * Bluetooth transfer service for Philosophy Notes.
 *
 * Uses the Web Bluetooth API (Central / GATT Client role).
 * Transfers the full notes + citations database as a chunked JSON payload
 * over a custom GATT service.
 *
 * ── Custom GATT UUIDs ────────────────────────────────────────────────────
 *
 * Service:  a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6
 *
 * Characteristics:
 *   META    a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d7  (read)
 *             → JSON: { version, size, chunks, chunkSize }
 *   CHUNK   a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d8  (read + write + notify)
 *             → raw bytes of one chunk
 *   OFFSET  a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d9  (write)
 *             → uint32LE: index of chunk the central wants to read
 *   CONTROL a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5da  (write + notify)
 *             → 0x01 = start,  0x02 = ack,  0xFF = done/abort
 *
 * ── Transfer flow (send from remote peripheral → receive in browser) ─────
 *
 *   browser (Central)         remote device (Peripheral)
 *       │                            │
 *       │── requestDevice ──────────▶│  user selects device
 *       │── connect GATT server ────▶│
 *       │── read META ◀─────────────│  { size, chunks, chunkSize }
 *       │                            │
 *       │  for i = 0..chunks-1:      │
 *       │── write OFFSET(i) ────────▶│
 *       │── read  CHUNK  ◀──────────│  512 bytes (or less for last chunk)
 *       │                            │
 *       │── write CONTROL(0xFF) ────▶│  done
 *
 * ── Send flow (browser → remote peripheral) ──────────────────────────────
 *
 * Because current browsers do not expose the GATT Server (Peripheral) role,
 * the "send" direction works by writing all chunks directly to the CHUNK
 * characteristic on the remote device — the remote device must already be
 * set up to accept incoming chunks on that characteristic.
 *
 *   browser (Central)         remote device (Peripheral)
 *       │                            │
 *       │── requestDevice ──────────▶│
 *       │── connect GATT server ────▶│
 *       │── write CONTROL(0x01) ────▶│  signal: incoming transfer
 *       │── write META ─────────────▶│  { size, chunks, chunkSize }
 *       │                            │
 *       │  for i = 0..chunks-1:      │
 *       │── write CHUNK(bytes) ─────▶│
 *       │                            │
 *       │── write CONTROL(0xFF) ────▶│  done
 *
 * ── Fallback ─────────────────────────────────────────────────────────────
 *
 * When Web Bluetooth is unavailable (non-Chrome browsers, HTTP origins) the
 * service gracefully degrades: all methods reject with a descriptive error
 * so the UI can display a helpful message.
 */

// ── GATT UUID constants ───────────────────────────────────────────────────

export const BT_SERVICE_UUID  = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
export const BT_CHAR_META     = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d7';
export const BT_CHAR_CHUNK    = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d8';
export const BT_CHAR_OFFSET   = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d9';
export const BT_CHAR_CONTROL  = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5da';

const CHUNK_SIZE = 512; // bytes per BLE chunk (safe below typical MTU)

const CTRL_START = new Uint8Array([0x01]);
const CTRL_ACK   = new Uint8Array([0x02]);
const CTRL_DONE  = new Uint8Array([0xFF]);

// ── Helpers ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function supported() {
  return typeof navigator !== 'undefined' &&
         typeof navigator.bluetooth !== 'undefined';
}

/** Split a Uint8Array into fixed-size chunks. */
function chunkBytes(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out.length > 0 ? out : [new Uint8Array(0)];
}

/** Write a uint32 LE value into a DataView. */
function writeU32LE(view, offset, value) {
  view.setUint32(offset, value, true);
}

/** Encode metadata as JSON bytes. */
function encodeMeta(size, chunks, chunkSize) {
  return enc.encode(JSON.stringify({ version: 1, size, chunks, chunkSize }));
}

/** Sleep for `ms` milliseconds (for retry back-off). */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BluetoothTransfer class ───────────────────────────────────────────────

/**
 * Manages a single Bluetooth data transfer session.
 *
 * @fires progress  { sent, total }   — updated during chunk transfer
 * @fires log       string            — human-readable status message
 * @fires statechange string          — 'idle'|'scanning'|'connected'|'transferring'|'done'|'error'
 */
export class BluetoothTransfer extends EventTarget {
  constructor() {
    super();
    this._device = null;
    this._server = null;
    this._service = null;
    this._aborted = false;
  }

  // ── Event helpers ─────────────────────────────────────────────────────

  _log(msg) {
    this.dispatchEvent(Object.assign(new Event('log'), { message: msg }));
  }

  _progress(sent, total) {
    this.dispatchEvent(Object.assign(new Event('progress'), { sent, total }));
  }

  _setState(state) {
    this.dispatchEvent(Object.assign(new Event('statechange'), { state }));
  }

  // ── Connection ────────────────────────────────────────────────────────

  /**
   * Prompt the user to select a nearby BLE device advertising the custom
   * GATT service, then connect and resolve the service object.
   */
  async connect() {
    if (!supported()) {
      throw new Error(
        'Web Bluetooth is not available in this browser.\n' +
        'Use Chrome or Edge on desktop/Android, served over HTTPS or localhost.'
      );
    }

    this._aborted = false;
    this._setState('scanning');
    this._log('Opening device picker…');

    this._device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BT_SERVICE_UUID] }],
      optionalServices: [BT_SERVICE_UUID],
    });

    this._log(`Connecting to "${this._device.name || 'unnamed device'}"…`);
    this._setState('connected');

    this._server  = await this._device.gatt.connect();
    this._service = await this._server.getPrimaryService(BT_SERVICE_UUID);

    this._log('Connected. Service found.');
    return this._service;
  }

  /** Disconnect cleanly. */
  disconnect() {
    this._aborted = true;
    if (this._device?.gatt?.connected) {
      this._device.gatt.disconnect();
    }
    this._device  = null;
    this._server  = null;
    this._service = null;
    this._setState('idle');
    this._log('Disconnected.');
  }

  // ── Send (Central writes to Peripheral) ───────────────────────────────

  /**
   * Export `storage` data and send it to a connected BLE peripheral.
   * @param {StorageBackend} storage
   */
  async send(storage) {
    const service = await this.connect();

    this._setState('transferring');
    this._log('Exporting local data…');
    const dump  = await storage.exportAll();
    const json  = JSON.stringify(dump);
    const bytes = enc.encode(json);
    const parts = chunkBytes(bytes, CHUNK_SIZE);

    this._log(`Sending ${bytes.length} bytes in ${parts.length} chunks…`);
    this._progress(0, parts.length);

    const charControl = await service.getCharacteristic(BT_CHAR_CONTROL);
    const charChunk   = await service.getCharacteristic(BT_CHAR_CHUNK);
    const charMeta    = await service.getCharacteristic(BT_CHAR_META);

    // Signal start + send metadata
    await charControl.writeValue(CTRL_START);
    await charMeta.writeValue(encodeMeta(bytes.length, parts.length, CHUNK_SIZE));
    this._log('Metadata sent. Sending chunks…');

    for (let i = 0; i < parts.length; i++) {
      if (this._aborted) throw new Error('Transfer aborted.');
      await charChunk.writeValue(parts[i]);
      this._progress(i + 1, parts.length);
      if ((i + 1) % 10 === 0) {
        this._log(`Sent ${i + 1}/${parts.length} chunks…`);
      }
    }

    await charControl.writeValue(CTRL_DONE);
    this._log('Transfer complete!');
    this._setState('done');
    this.disconnect();
  }

  // ── Receive (Central reads from Peripheral) ───────────────────────────

  /**
   * Connect to a BLE peripheral hosting the data, read all chunks, and
   * import into `storage`.
   * @param {StorageBackend} storage
   */
  async receive(storage) {
    const service = await this.connect();

    this._setState('transferring');
    this._log('Reading metadata from remote device…');

    const charMeta    = await service.getCharacteristic(BT_CHAR_META);
    const charChunk   = await service.getCharacteristic(BT_CHAR_CHUNK);
    const charOffset  = await service.getCharacteristic(BT_CHAR_OFFSET);
    const charControl = await service.getCharacteristic(BT_CHAR_CONTROL);

    // Read metadata
    const metaValue = await charMeta.readValue();
    const metaText  = dec.decode(metaValue);
    let meta;
    try {
      meta = JSON.parse(metaText);
    } catch {
      throw new Error('Invalid metadata from remote device. Is it running Philosophy Notes?');
    }

    const { size, chunks } = meta;
    this._log(`Remote has ${size} bytes in ${chunks} chunks. Receiving…`);
    this._progress(0, chunks);

    const allBytes = new Uint8Array(size);
    let pos = 0;

    for (let i = 0; i < chunks; i++) {
      if (this._aborted) throw new Error('Transfer aborted.');

      // Tell peripheral which chunk we want
      const offsetBuf = new ArrayBuffer(4);
      writeU32LE(new DataView(offsetBuf), 0, i);
      await charOffset.writeValue(offsetBuf);

      // Small delay to let peripheral seek
      await sleep(20);

      const chunkValue = await charChunk.readValue();
      const chunkBytes = new Uint8Array(chunkValue.buffer);
      allBytes.set(chunkBytes, pos);
      pos += chunkBytes.length;

      this._progress(i + 1, chunks);
      if ((i + 1) % 10 === 0) {
        this._log(`Received ${i + 1}/${chunks} chunks…`);
      }
    }

    // Signal done
    await charControl.writeValue(CTRL_DONE);

    this._log('Parsing received data…');
    let dump;
    try {
      dump = JSON.parse(dec.decode(allBytes));
    } catch {
      throw new Error('Received data is not valid JSON.');
    }

    if (!dump.notes || !dump.citations) {
      throw new Error('Received data does not look like a Philosophy Notes backup.');
    }

    this._log(`Importing ${dump.notes.length} notes and ${dump.citations.length} citations…`);
    await storage.importAll(dump);

    this._log('Import complete!');
    this._setState('done');
    this.disconnect();

    return dump;
  }

  /** Abort any in-progress transfer. */
  abort() {
    this._aborted = true;
    this._log('Aborting…');
    this.disconnect();
  }

  /** True if the Web Bluetooth API is available in this browser. */
  static isSupported() { return supported(); }
}
