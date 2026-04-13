/**
 * IndexedDB storage backend.
 *
 * Why not localStorage? localStorage is limited to ~5 MB per origin and
 * stores everything synchronously in the main thread. IndexedDB has no
 * practical size limit for a local notes app and is async.
 *
 * DB schema:
 *   notes      — keyPath: id
 *   citations  — keyPath: citekey
 */
import { StorageBackend } from './interface.js';

const DB_NAME    = 'philosophy-js';
const DB_VERSION = 1;

function uuid() {
  // crypto.randomUUID() requires a secure context (HTTPS/localhost).
  // The getRandomValues fallback works everywhere including file:// URLs.
  if (crypto.randomUUID) return crypto.randomUUID();
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function now() {
  return new Date().toISOString();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('slug',       'slug',       { unique: true });
        notes.createIndex('updated_at', 'updated_at', { unique: false });
      }
      if (!db.objectStoreNames.contains('citations')) {
        const cites = db.createObjectStore('citations', { keyPath: 'citekey' });
        cites.createIndex('updated_at', 'updated_at', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function txGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

function txPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve(value);
    req.onerror   = e => reject(e.target.error);
  });
}

function txDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function txGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function txClear(store) {
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}


export class IndexedDBBackend extends StorageBackend {
  get id()   { return 'indexeddb'; }
  get name() { return 'Browser Storage (IndexedDB)'; }

  constructor() {
    super();
    this._db = null;
  }

  async _open() {
    if (!this._db) this._db = await openDB();
    return this._db;
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  async listNotes() {
    const db = await this._open();
    const tx = db.transaction('notes', 'readonly');
    const all = await txGetAll(tx.objectStore('notes'));
    return all.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  }

  async getNote(id) {
    const db = await this._open();
    const tx = db.transaction('notes', 'readonly');
    return txGet(tx.objectStore('notes'), id);
  }

  async getNoteBySlug(slug) {
    const notes = await this.listNotes();
    return notes.find(n => n.slug === slug) ?? null;
  }

  async saveNote(note) {
    const db  = await this._open();
    const tx  = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');

    let existing = note.id ? await txGet(store, note.id) : null;
    const ts = now();
    const saved = {
      id:         existing?.id ?? uuid(),
      slug:       note.slug ?? slugify(note.title ?? 'untitled'),
      title:      note.title ?? '',
      body:       note.body  ?? '',
      tags:       note.tags  ?? [],
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
    };

    // Ensure slug uniqueness if it changed
    if (!existing || saved.slug !== existing.slug) {
      saved.slug = await this._uniqueSlug(store, saved.slug, saved.id);
    }

    await txPut(store, saved);
    return saved;
  }

  async _uniqueSlug(store, base, excludeId) {
    let slug = base, n = 1;
    while (true) {
      const req = store.index('slug').get(slug);
      const hit = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = e => rej(e.target.error);
      });
      if (!hit || hit.id === excludeId) return slug;
      slug = `${base}-${n++}`;
    }
  }

  async deleteNote(id) {
    const db = await this._open();
    const tx = db.transaction('notes', 'readwrite');
    return txDelete(tx.objectStore('notes'), id);
  }

  // ── Citations ────────────────────────────────────────────────────────────

  async listCitations() {
    const db = await this._open();
    const tx = db.transaction('citations', 'readonly');
    const all = await txGetAll(tx.objectStore('citations'));
    return all.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  }

  async getCitation(citekey) {
    const db = await this._open();
    const tx = db.transaction('citations', 'readonly');
    return txGet(tx.objectStore('citations'), citekey);
  }

  async saveCitation(c) {
    const db    = await this._open();
    const tx    = db.transaction('citations', 'readwrite');
    const store = tx.objectStore('citations');
    const existing = await txGet(store, c.citekey);
    const ts = now();
    const saved = {
      citekey:    c.citekey,
      entry_type: c.entry_type ?? 'misc',
      title:      c.title      ?? '',
      authors:    c.authors    ?? [],
      year:       c.year       ?? null,
      bibtex_raw: c.bibtex_raw ?? '',
      doi:        c.doi        ?? null,
      isbn:       c.isbn       ?? null,
      note_body:  c.note_body  ?? '',
      tags:       c.tags       ?? [],
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
    };
    await txPut(store, saved);
    return saved;
  }

  async deleteCitation(citekey) {
    const db = await this._open();
    const tx = db.transaction('citations', 'readwrite');
    return txDelete(tx.objectStore('citations'), citekey);
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────

  async exportAll() {
    const [notes, citations] = await Promise.all([
      this.listNotes(),
      this.listCitations(),
    ]);
    return {
      version:     1,
      exported_at: now(),
      backend:     this.id,
      notes,
      citations,
    };
  }

  async importAll(dump) {
    const db   = await this._open();
    const tx   = db.transaction(['notes', 'citations'], 'readwrite');
    const ns   = tx.objectStore('notes');
    const cs   = tx.objectStore('citations');
    await txClear(ns);
    await txClear(cs);
    for (const n of (dump.notes     ?? [])) await txPut(ns, n);
    for (const c of (dump.citations ?? [])) await txPut(cs, c);
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }
}
