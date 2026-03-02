-- Philosophy Notes App — SQLite Schema

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- NOTES
-- ============================================================
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT slug_format CHECK (slug GLOB '[a-z0-9][a-z0-9-]*')
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    content='notes',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;

-- ============================================================
-- NOTE-TO-NOTE LINKS  (backlink graph)
-- ============================================================
CREATE TABLE IF NOT EXISTS note_links (
    source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, target_id)
);

-- ============================================================
-- CITATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS citations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    citekey    TEXT NOT NULL UNIQUE,
    entry_type TEXT NOT NULL DEFAULT 'misc',
    title      TEXT NOT NULL DEFAULT '',
    authors    TEXT NOT NULL DEFAULT '[]',   -- JSON array of author strings
    year       INTEGER,
    bibtex_raw TEXT NOT NULL,
    doi        TEXT,
    isbn       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS citations_fts USING fts5(
    citekey,
    title,
    authors,
    content='citations',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS citations_ai AFTER INSERT ON citations BEGIN
    INSERT INTO citations_fts(rowid, citekey, title, authors)
    VALUES (new.id, new.citekey, new.title, new.authors);
END;

CREATE TRIGGER IF NOT EXISTS citations_au AFTER UPDATE ON citations BEGIN
    INSERT INTO citations_fts(citations_fts, rowid, citekey, title, authors)
    VALUES ('delete', old.id, old.citekey, old.title, old.authors);
    INSERT INTO citations_fts(rowid, citekey, title, authors)
    VALUES (new.id, new.citekey, new.title, new.authors);
END;

CREATE TRIGGER IF NOT EXISTS citations_ad AFTER DELETE ON citations BEGIN
    INSERT INTO citations_fts(citations_fts, rowid, citekey, title, authors)
    VALUES ('delete', old.id, old.citekey, old.title, old.authors);
END;

-- ============================================================
-- CITATION ANNOTATION NOTES
-- ============================================================
CREATE TABLE IF NOT EXISTS citation_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    citation_id INTEGER NOT NULL UNIQUE REFERENCES citations(id) ON DELETE CASCADE,
    body        TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- TAGS
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS citation_tags (
    citation_id INTEGER NOT NULL REFERENCES citations(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
    PRIMARY KEY (citation_id, tag_id)
);

-- ============================================================
-- SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('default_template',    'article'),
    ('default_author',      ''),
    ('default_institution', ''),
    ('crossref_enabled',    'true'),
    ('openlibrary_enabled', 'true');
