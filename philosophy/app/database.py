"""SQLite database connection and initialization."""
import os
import sqlite3
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "philosophy.db"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def _ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "exports").mkdir(exist_ok=True)


def get_db() -> sqlite3.Connection:
    """Return a synchronous SQLite connection with row_factory set."""
    _ensure_dirs()
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create all tables if they don't exist (idempotent)."""
    _ensure_dirs()
    schema = SCHEMA_PATH.read_text()
    conn = get_db()
    try:
        conn.executescript(schema)
        conn.commit()
    finally:
        conn.close()
