"""Citations CRUD and search endpoints."""
import json
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from ..database import get_db
from ..models import (
    Citation, CitationCreate, CitationListItem, CitationNote,
    CitationNoteUpdate, CitationUpdate,
)
from ..services.citation_parser import parse_citation

router = APIRouter(tags=["citations"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_tags(conn, citation_id: int) -> list[str]:
    rows = conn.execute(
        "SELECT t.name FROM tags t JOIN citation_tags ct ON t.id=ct.tag_id WHERE ct.citation_id=?",
        (citation_id,),
    ).fetchall()
    return [r["name"] for r in rows]


def _set_tags(conn, citation_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM citation_tags WHERE citation_id=?", (citation_id,))
    for tag in tags:
        tag = tag.strip().lower()
        if not tag:
            continue
        conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
        tag_id = conn.execute("SELECT id FROM tags WHERE name=?", (tag,)).fetchone()["id"]
        conn.execute(
            "INSERT OR IGNORE INTO citation_tags(citation_id, tag_id) VALUES (?,?)",
            (citation_id, tag_id),
        )


def _get_note_body(conn, citation_id: int) -> Optional[str]:
    row = conn.execute(
        "SELECT body FROM citation_notes WHERE citation_id=?", (citation_id,)
    ).fetchone()
    return row["body"] if row else None


def _row_to_citation(conn, row) -> Citation:
    authors = json.loads(row["authors"]) if row["authors"] else []
    return Citation(
        id=row["id"],
        citekey=row["citekey"],
        entry_type=row["entry_type"],
        title=row["title"],
        authors=authors,
        year=row["year"],
        bibtex_raw=row["bibtex_raw"],
        doi=row["doi"],
        isbn=row["isbn"],
        tags=_get_tags(conn, row["id"]),
        note_body=_get_note_body(conn, row["id"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _get_existing_keys(conn) -> set[str]:
    rows = conn.execute("SELECT citekey FROM citations").fetchall()
    return {r["citekey"] for r in rows}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/citations", response_model=dict)
def list_citations(
    q: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    year_min: Optional[int] = Query(None),
    year_max: Optional[int] = Query(None),
    entry_type: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    conn = get_db()
    try:
        conditions = []
        params: list = []

        if q:
            rows_fts = conn.execute(
                """SELECT c.id, c.citekey, c.entry_type, c.title, c.authors, c.year, c.created_at, c.updated_at
                   FROM citations c JOIN citations_fts f ON c.id=f.rowid
                   WHERE citations_fts MATCH ?
                   ORDER BY rank LIMIT ? OFFSET ?""",
                (q, limit, offset),
            ).fetchall()
        else:
            if tag:
                conditions.append("EXISTS (SELECT 1 FROM citation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.citation_id=c.id AND t.name=?)")
                params.append(tag)
            if year_min:
                conditions.append("c.year >= ?")
                params.append(year_min)
            if year_max:
                conditions.append("c.year <= ?")
                params.append(year_max)
            if entry_type:
                conditions.append("c.entry_type=?")
                params.append(entry_type)

            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            rows_fts = conn.execute(
                f"""SELECT c.id, c.citekey, c.entry_type, c.title, c.authors, c.year, c.created_at, c.updated_at
                    FROM citations c {where}
                    ORDER BY c.updated_at DESC LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()

        total = conn.execute("SELECT COUNT(*) FROM citations").fetchone()[0]
        has_note_ids = {
            r["citation_id"]
            for r in conn.execute("SELECT citation_id FROM citation_notes WHERE body != ''").fetchall()
        }

        items = [
            CitationListItem(
                id=r["id"],
                citekey=r["citekey"],
                entry_type=r["entry_type"],
                title=r["title"],
                authors=json.loads(r["authors"]) if r["authors"] else [],
                year=r["year"],
                tags=_get_tags(conn, r["id"]),
                has_note=r["id"] in has_note_ids,
            )
            for r in rows_fts
        ]
        return {"citations": [i.model_dump() for i in items], "total": total}
    finally:
        conn.close()


@router.post("/citations", response_model=dict, status_code=201)
def create_citation(data: CitationCreate):
    conn = get_db()
    try:
        settings_row = conn.execute("SELECT key, value FROM settings").fetchall()
        settings = {r["key"]: r["value"] for r in settings_row}
        crossref_enabled = settings.get("crossref_enabled", "true") == "true"
        openlibrary_enabled = settings.get("openlibrary_enabled", "true") == "true"

        existing_keys = _get_existing_keys(conn)
        parsed = parse_citation(
            data.raw_input,
            existing_keys=existing_keys,
            crossref_enabled=crossref_enabled,
            openlibrary_enabled=openlibrary_enabled,
        )

        existing = conn.execute(
            "SELECT id FROM citations WHERE citekey=?", (parsed["citekey"],)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail=f"Citekey '{parsed['citekey']}' already exists")

        conn.execute(
            """INSERT INTO citations(citekey, entry_type, title, authors, year, bibtex_raw, doi, isbn)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                parsed["citekey"],
                parsed["entry_type"],
                parsed["title"],
                json.dumps(parsed["authors"]),
                parsed["year"],
                parsed["bibtex_raw"],
                parsed.get("doi"),
                parsed.get("isbn"),
            ),
        )
        citation_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()

        row = conn.execute("SELECT * FROM citations WHERE id=?", (citation_id,)).fetchone()
        return {
            "citation": _row_to_citation(conn, row).model_dump(),
            "parsed_from": parsed["parsed_from"],
            "warnings": parsed.get("warnings", []),
        }
    finally:
        conn.close()


@router.get("/citations/{citekey}", response_model=dict)
def get_citation(citekey: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM citations WHERE citekey=?", (citekey,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Citation '{citekey}' not found")
        return _row_to_citation(conn, row).model_dump()
    finally:
        conn.close()


@router.put("/citations/{citekey}", response_model=dict)
def update_citation(citekey: str, data: CitationUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM citations WHERE citekey=?", (citekey,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Citation '{citekey}' not found")

        # Re-parse the updated bibtex to extract fields
        existing_keys = _get_existing_keys(conn) - {citekey}
        parsed = parse_citation(data.bibtex_raw, existing_keys=existing_keys)

        conn.execute(
            """UPDATE citations SET
               citekey=?, entry_type=?, title=?, authors=?, year=?,
               bibtex_raw=?, doi=?, isbn=?, updated_at=datetime('now')
               WHERE citekey=?""",
            (
                parsed["citekey"],
                parsed["entry_type"],
                parsed["title"],
                json.dumps(parsed["authors"]),
                parsed["year"],
                parsed["bibtex_raw"],
                parsed.get("doi"),
                parsed.get("isbn"),
                citekey,
            ),
        )
        citation_id = row["id"]
        if data.tags is not None:
            _set_tags(conn, citation_id, data.tags)
        conn.commit()

        updated = conn.execute("SELECT * FROM citations WHERE id=?", (citation_id,)).fetchone()
        return _row_to_citation(conn, updated).model_dump()
    finally:
        conn.close()


@router.delete("/citations/{citekey}", response_model=dict)
def delete_citation(citekey: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM citations WHERE citekey=?", (citekey,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Citation '{citekey}' not found")
        conn.execute("DELETE FROM citations WHERE id=?", (row["id"],))
        conn.commit()
        return {"deleted": True}
    finally:
        conn.close()


@router.get("/citations/{citekey}/note", response_model=dict)
def get_citation_note(citekey: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM citations WHERE citekey=?", (citekey,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Citation '{citekey}' not found")
        note = conn.execute(
            "SELECT body, updated_at FROM citation_notes WHERE citation_id=?", (row["id"],)
        ).fetchone()
        if note is None:
            return {"body": "", "updated_at": ""}
        return {"body": note["body"], "updated_at": note["updated_at"]}
    finally:
        conn.close()


@router.put("/citations/{citekey}/note", response_model=dict)
def upsert_citation_note(citekey: str, data: CitationNoteUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM citations WHERE citekey=?", (citekey,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Citation '{citekey}' not found")
        citation_id = row["id"]
        conn.execute(
            """INSERT INTO citation_notes(citation_id, body, updated_at)
               VALUES (?,?,datetime('now'))
               ON CONFLICT(citation_id) DO UPDATE SET body=excluded.body, updated_at=datetime('now')""",
            (citation_id, data.body),
        )
        conn.commit()
        note = conn.execute(
            "SELECT body, updated_at FROM citation_notes WHERE citation_id=?", (citation_id,)
        ).fetchone()
        return {"body": note["body"], "updated_at": note["updated_at"]}
    finally:
        conn.close()
