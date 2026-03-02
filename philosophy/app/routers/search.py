"""Unified search and lightweight autocomplete endpoints."""
import json
import re
from typing import Optional
from fastapi import APIRouter, Query

from ..database import get_db
from ..models import SearchResult

router = APIRouter(tags=["search"])


def _excerpt(text: str, query: str = "", length: int = 200) -> str:
    text = re.sub(r"\[\[note:[^\]]+\]\]", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[#*`_~>|]", "", text)
    text = " ".join(text.split())
    # Try to center on the query term
    if query:
        term = query.split()[0] if query.split() else ""
        idx = text.lower().find(term.lower())
        if idx > 50:
            text = "…" + text[max(0, idx - 50):]
    return text[:length] + ("…" if len(text) > length else "")


@router.get("/search", response_model=dict)
def unified_search(
    q: str = Query(..., min_length=1),
    types: str = Query("notes,citations"),
    limit: int = Query(20, ge=1, le=100),
):
    want_notes = "notes" in types
    want_citations = "citations" in types
    results: list[dict] = []

    conn = get_db()
    try:
        if want_notes:
            rows = conn.execute(
                """SELECT n.id, n.slug, n.title, n.body, rank
                   FROM notes n JOIN notes_fts f ON n.id=f.rowid
                   WHERE notes_fts MATCH ?
                   ORDER BY rank LIMIT ?""",
                (q, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "type": "note",
                    "id": r["id"],
                    "slug": r["slug"],
                    "citekey": None,
                    "title": r["title"],
                    "excerpt": _excerpt(r["body"], q),
                    "authors": None,
                    "year": None,
                    "score": r["rank"],
                })

        if want_citations:
            rows = conn.execute(
                """SELECT c.id, c.citekey, c.title, c.authors, c.year, rank
                   FROM citations c JOIN citations_fts f ON c.id=f.rowid
                   WHERE citations_fts MATCH ?
                   ORDER BY rank LIMIT ?""",
                (q, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "type": "citation",
                    "id": r["id"],
                    "slug": None,
                    "citekey": r["citekey"],
                    "title": r["title"],
                    "excerpt": r["title"],
                    "authors": json.loads(r["authors"]) if r["authors"] else [],
                    "year": r["year"],
                    "score": r["rank"],
                })

        # Sort by score (FTS5 rank is negative; lower = better match)
        results.sort(key=lambda x: x["score"])
        results = results[:limit]
        return {"results": results, "total": len(results)}
    finally:
        conn.close()


@router.get("/search/notes", response_model=list)
def search_notes_autocomplete(
    q: str = Query("", min_length=0),
    limit: int = Query(10, ge=1, le=50),
):
    """Lightweight endpoint for note-link autocomplete in the editor."""
    conn = get_db()
    try:
        if q.strip():
            rows = conn.execute(
                """SELECT n.slug, n.title FROM notes n JOIN notes_fts f ON n.id=f.rowid
                   WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?""",
                (q, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT slug, title FROM notes ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [{"slug": r["slug"], "title": r["title"]} for r in rows]
    finally:
        conn.close()


@router.get("/search/citations", response_model=list)
def search_citations_autocomplete(
    q: str = Query("", min_length=0),
    limit: int = Query(10, ge=1, le=50),
):
    """Lightweight endpoint for citation autocomplete in the editor."""
    conn = get_db()
    try:
        if q.strip():
            rows = conn.execute(
                """SELECT c.citekey, c.title, c.authors, c.year
                   FROM citations c JOIN citations_fts f ON c.id=f.rowid
                   WHERE citations_fts MATCH ? ORDER BY rank LIMIT ?""",
                (q, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT citekey, title, authors, year FROM citations ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "citekey": r["citekey"],
                "title": r["title"],
                "authors": json.loads(r["authors"]) if r["authors"] else [],
                "year": r["year"],
            }
            for r in rows
        ]
    finally:
        conn.close()
