"""Transform [[note:slug]] links and extract citation keys before pandoc."""
import re
import sqlite3
from typing import Optional

NOTE_LINK_RE = re.compile(r"\[\[note:([a-z0-9-]+)(?:\|([^\]]+))?\]\]")
CITE_RE = re.compile(r"@([\w:-]+)")


def rewrite_note_links(body: str, conn: sqlite3.Connection, base_url: str = "http://localhost:8000") -> str:
    """Replace [[note:slug]] and [[note:slug|text]] with markdown hyperlinks."""
    def replace(m: re.Match) -> str:
        slug = m.group(1)
        display = m.group(2)
        row = conn.execute("SELECT title FROM notes WHERE slug=?", (slug,)).fetchone()
        if row is None:
            return f"**[broken link: {slug}]**"
        label = display or row["title"]
        return f"[{label}]({base_url}/note/{slug})"

    return NOTE_LINK_RE.sub(replace, body)


def extract_citekeys(body: str) -> list[str]:
    """Return all unique citation keys referenced in the body with [@key] syntax."""
    return list(set(CITE_RE.findall(body)))


def write_bib_file(citekeys: list[str], conn: sqlite3.Connection, path: str) -> int:
    """Write a .bib file containing entries for the given citekeys. Returns count written."""
    if not citekeys:
        with open(path, "w") as f:
            f.write("")
        return 0

    placeholders = ",".join("?" * len(citekeys))
    rows = conn.execute(
        f"SELECT bibtex_raw FROM citations WHERE citekey IN ({placeholders})", citekeys
    ).fetchall()

    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(row["bibtex_raw"].strip())
            f.write("\n\n")

    return len(rows)


def prepare_pandoc_input(
    body: str,
    title: str,
    author: str,
    date: str,
    bib_path: str,
    bib_style: str,
    conn: sqlite3.Connection,
    base_url: str = "http://localhost:8000",
) -> str:
    """
    Return a complete pandoc markdown document:
    1. YAML front matter with metadata + bibliography path
    2. Body with [[note:slug]] links rewritten to hyperlinks
    """
    rewritten = rewrite_note_links(body, conn, base_url)

    # Escape quotes in YAML values
    safe_title = title.replace('"', '\\"')
    safe_author = author.replace('"', '\\"')

    yaml_block = f"""---
title: "{safe_title}"
author: "{safe_author}"
date: "{date}"
bibliography: "{bib_path}"
biblatex: true
link-citations: true
colorlinks: true
---

"""
    return yaml_block + rewritten
