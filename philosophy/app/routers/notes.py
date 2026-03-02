"""Notes CRUD and search endpoints."""
import json
import re
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from ..database import get_db
from ..models import Note, NoteCreate, NoteListItem, NoteRef, NoteUpdate, slugify

router = APIRouter(tags=["notes"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ensure_unique_slug(conn, base_slug: str, exclude_id: Optional[int] = None) -> str:
    slug = base_slug
    suffix = 1
    while True:
        row = conn.execute(
            "SELECT id FROM notes WHERE slug = ?", (slug,)
        ).fetchone()
        if row is None or (exclude_id is not None and row["id"] == exclude_id):
            return slug
        slug = f"{base_slug}-{suffix}"
        suffix += 1


def _get_tags(conn, note_id: int) -> list[str]:
    rows = conn.execute(
        "SELECT t.name FROM tags t JOIN note_tags nt ON t.id=nt.tag_id WHERE nt.note_id=?",
        (note_id,),
    ).fetchall()
    return [r["name"] for r in rows]


def _set_tags(conn, note_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM note_tags WHERE note_id=?", (note_id,))
    for tag in tags:
        tag = tag.strip().lower()
        if not tag:
            continue
        conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (tag,))
        tag_id = conn.execute("SELECT id FROM tags WHERE name=?", (tag,)).fetchone()["id"]
        conn.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?,?)",
            (note_id, tag_id),
        )


def _get_backlinks(conn, note_id: int) -> list[NoteRef]:
    rows = conn.execute(
        """SELECT n.slug, n.title FROM notes n
           JOIN note_links nl ON n.id=nl.source_id
           WHERE nl.target_id=?""",
        (note_id,),
    ).fetchall()
    return [NoteRef(slug=r["slug"], title=r["title"]) for r in rows]


def _extract_note_links(body: str) -> list[str]:
    """Return all slugs referenced by [[note:slug]] patterns in body."""
    return re.findall(r"\[\[note:([a-z0-9-]+)(?:\|[^\]]+)?\]\]", body)


def _update_note_links(conn, source_id: int, body: str) -> None:
    slugs = _extract_note_links(body)
    conn.execute("DELETE FROM note_links WHERE source_id=?", (source_id,))
    for slug in set(slugs):
        row = conn.execute("SELECT id FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is not None and row["id"] != source_id:
            conn.execute(
                "INSERT OR IGNORE INTO note_links(source_id, target_id) VALUES (?,?)",
                (source_id, row["id"]),
            )


def _extract_citekeys(body: str) -> list[str]:
    return list(set(re.findall(r"@([\w:-]+)", body)))


def _excerpt(body: str, length: int = 200) -> str:
    text = re.sub(r"\[\[note:[^\]]+\]\]", "", body)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[#*`_~>|]", "", text)
    text = " ".join(text.split())
    return text[:length] + ("…" if len(text) > length else "")


def _row_to_note(conn, row) -> Note:
    return Note(
        id=row["id"],
        slug=row["slug"],
        title=row["title"],
        body=row["body"],
        tags=_get_tags(conn, row["id"]),
        backlinks=_get_backlinks(conn, row["id"]),
        citations_used=_extract_citekeys(row["body"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/notes", response_model=dict)
def list_notes(
    q: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    conn = get_db()
    try:
        if q:
            rows = conn.execute(
                """SELECT n.id, n.slug, n.title, n.body, n.created_at, n.updated_at
                   FROM notes n
                   JOIN notes_fts f ON n.id=f.rowid
                   WHERE notes_fts MATCH ?
                   ORDER BY rank
                   LIMIT ? OFFSET ?""",
                (q, limit, offset),
            ).fetchall()
        elif tag:
            rows = conn.execute(
                """SELECT n.id, n.slug, n.title, n.body, n.created_at, n.updated_at
                   FROM notes n
                   JOIN note_tags nt ON n.id=nt.note_id
                   JOIN tags t ON t.id=nt.tag_id
                   WHERE t.name=?
                   ORDER BY n.updated_at DESC
                   LIMIT ? OFFSET ?""",
                (tag, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, slug, title, body, created_at, updated_at FROM notes
                   ORDER BY updated_at DESC LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()

        total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        items = [
            NoteListItem(
                id=r["id"],
                slug=r["slug"],
                title=r["title"],
                tags=_get_tags(conn, r["id"]),
                created_at=r["created_at"],
                updated_at=r["updated_at"],
                excerpt=_excerpt(r["body"]),
            )
            for r in rows
        ]
        return {"notes": [i.model_dump() for i in items], "total": total}
    finally:
        conn.close()


@router.post("/notes", response_model=dict, status_code=201)
def create_note(data: NoteCreate):
    conn = get_db()
    try:
        base_slug = data.slug or slugify(data.title)
        slug = _ensure_unique_slug(conn, base_slug)
        conn.execute(
            "INSERT INTO notes(slug, title, body) VALUES (?,?,?)",
            (slug, data.title.strip(), data.body),
        )
        note_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        _set_tags(conn, note_id, data.tags)
        _update_note_links(conn, note_id, data.body)
        conn.commit()
        row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        return _row_to_note(conn, row).model_dump()
    finally:
        conn.close()


@router.get("/notes/{slug}", response_model=dict)
def get_note(slug: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Note '{slug}' not found")
        return _row_to_note(conn, row).model_dump()
    finally:
        conn.close()


@router.put("/notes/{slug}", response_model=dict)
def update_note(slug: str, data: NoteUpdate):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Note '{slug}' not found")

        note_id = row["id"]
        new_title = data.title.strip() if data.title is not None else row["title"]
        new_body = data.body if data.body is not None else row["body"]

        # Handle slug rename
        new_slug = slug
        if data.slug is not None and data.slug != slug:
            new_slug = _ensure_unique_slug(conn, data.slug, exclude_id=note_id)
            # Rewrite [[note:old-slug]] references in all other notes
            old_pattern = f"[[note:{slug}]]"
            old_pattern_with_text = f"[[note:{slug}|"
            all_notes = conn.execute(
                "SELECT id, body FROM notes WHERE id != ?", (note_id,)
            ).fetchall()
            for other in all_notes:
                new_body_other = other["body"].replace(
                    f"[[note:{slug}|", f"[[note:{new_slug}|"
                ).replace(
                    f"[[note:{slug}]]", f"[[note:{new_slug}]]"
                )
                if new_body_other != other["body"]:
                    conn.execute(
                        "UPDATE notes SET body=?, updated_at=datetime('now') WHERE id=?",
                        (new_body_other, other["id"]),
                    )

        conn.execute(
            """UPDATE notes SET slug=?, title=?, body=?, updated_at=datetime('now')
               WHERE id=?""",
            (new_slug, new_title, new_body, note_id),
        )
        if data.tags is not None:
            _set_tags(conn, note_id, data.tags)
        _update_note_links(conn, note_id, new_body)
        conn.commit()

        updated = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        return _row_to_note(conn, updated).model_dump()
    finally:
        conn.close()


@router.delete("/notes/{slug}", response_model=dict)
def delete_note(slug: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Note '{slug}' not found")
        conn.execute("DELETE FROM notes WHERE id=?", (row["id"],))
        conn.commit()
        return {"deleted": True}
    finally:
        conn.close()


@router.get("/notes/{slug}/backlinks", response_model=dict)
def note_backlinks(slug: str):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Note '{slug}' not found")
        backlinks = _get_backlinks(conn, row["id"])
        return {"backlinks": [b.model_dump() for b in backlinks]}
    finally:
        conn.close()
