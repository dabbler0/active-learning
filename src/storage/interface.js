/**
 * Storage backend interface.
 *
 * All backends must implement this class. The app only ever calls methods
 * defined here, making it straightforward to swap backends (e.g. Google Drive).
 *
 * Data shapes
 * -----------
 * Note: { id, slug, title, body, tags, created_at, updated_at }
 * Citation: { citekey, entry_type, title, authors, year,
 *             bibtex_raw, doi, isbn, note_body, tags,
 *             created_at, updated_at }
 * DatabaseDump: { version, exported_at, notes, citations }
 */
export class StorageBackend {
  /** Human-readable identifier shown in the UI */
  get id()   { return 'abstract'; }
  get name() { return 'Abstract Storage'; }

  // ── Notes ──────────────────────────────────────────────────────────────────

  /** @returns {Promise<Note[]>} all notes, newest first */
  async listNotes()         { throw new Error('not implemented'); }

  /** @returns {Promise<Note|null>} */
  async getNote(id)         { throw new Error('not implemented'); }

  /** Create or update. If note.id is absent a new id is assigned.
   *  @returns {Promise<Note>} the saved note */
  async saveNote(note)      { throw new Error('not implemented'); }

  /** @returns {Promise<void>} */
  async deleteNote(id)      { throw new Error('not implemented'); }

  // ── Citations ──────────────────────────────────────────────────────────────

  /** @returns {Promise<Citation[]>} all citations */
  async listCitations()     { throw new Error('not implemented'); }

  /** @returns {Promise<Citation|null>} */
  async getCitation(citekey){ throw new Error('not implemented'); }

  /** @returns {Promise<Citation>} */
  async saveCitation(c)     { throw new Error('not implemented'); }

  /** @returns {Promise<void>} */
  async deleteCitation(citekey) { throw new Error('not implemented'); }

  // ── Bulk operations ────────────────────────────────────────────────────────

  /** @returns {Promise<DatabaseDump>} full snapshot for export */
  async exportAll() { throw new Error('not implemented'); }

  /** Replaces all data with the given dump. */
  async importAll(dump) { throw new Error('not implemented'); }
}
