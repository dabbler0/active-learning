"""Citation parsing cascade: BibTeX → DOI → ISBN → free-text fallback."""
from __future__ import annotations

import json
import re
import unicodedata
from typing import Optional

# pybtex for BibTeX parsing
try:
    from pybtex.database.input import bibtex as pybtex_bibtex
    import pybtex.database
    HAS_PYBTEX = True
except ImportError:
    HAS_PYBTEX = False

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False


# ── Citekey generation ────────────────────────────────────────────────────────

_STOP_WORDS = {"the", "a", "an", "of", "in", "on", "and", "or", "for", "to", "is", "are"}


def generate_citekey(authors: list[str], year: Optional[int], title: str) -> str:
    if authors:
        last = authors[0].split(",")[0].strip()
        last = unicodedata.normalize("NFKD", last)
        last = re.sub(r"[^\x00-\x7F]", "", last).lower()
        last = re.sub(r"[^a-z]", "", last) or "unknown"
    else:
        last = "unknown"

    year_str = str(year) if year else "nd"

    words = [w for w in re.sub(r"[^a-z ]", "", title.lower()).split() if w not in _STOP_WORDS]
    keyword = words[0] if words else ""

    return f"{last}{year_str}{keyword}"


def ensure_unique_citekey(base: str, existing_keys: set[str]) -> str:
    if base not in existing_keys:
        return base
    for ch in "abcdefghijklmnopqrstuvwxyz":
        candidate = f"{base}{ch}"
        if candidate not in existing_keys:
            return candidate
    import time
    return f"{base}{int(time.time())}"


# ── BibTeX authors ────────────────────────────────────────────────────────────

def parse_authors(author_field: str) -> list[str]:
    """Split BibTeX 'author' field on ' and ' into a list."""
    if not author_field:
        return []
    parts = re.split(r"\s+and\s+", author_field, flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


# ── Step 1: BibTeX ────────────────────────────────────────────────────────────

def _try_parse_bibtex(raw: str) -> Optional[dict]:
    if not re.search(r"@\w+\s*\{", raw):
        return None

    if HAS_PYBTEX:
        return _pybtex_parse(raw)

    # Fallback: minimal regex parser
    return _regex_bibtex_parse(raw)


def _pybtex_parse(raw: str) -> Optional[dict]:
    """Parse BibTeX using pybtex."""
    import io
    try:
        parser = pybtex_bibtex.Parser()
        bib_data = parser.parse_stream(io.StringIO(raw))
        if not bib_data.entries:
            return None
        citekey = list(bib_data.entries.keys())[0]
        entry = bib_data.entries[citekey]
        fields = {k.lower(): str(v) for k, v in entry.fields.items()}

        # Authors from persons
        persons = entry.persons.get("author", [])
        authors = []
        for p in persons:
            last = " ".join(p.last_names)
            first = " ".join(p.first_names + p.middle_names)
            if last and first:
                authors.append(f"{last}, {first}")
            elif last:
                authors.append(last)

        year_str = fields.get("year", "")
        year_match = re.search(r"\d{4}", year_str)
        year = int(year_match.group()) if year_match else None

        title = fields.get("title", "").strip("{}")
        doi = fields.get("doi") or None
        isbn = fields.get("isbn") or None

        return {
            "citekey": citekey,
            "entry_type": entry.type.lower(),
            "title": title,
            "authors": authors,
            "year": year,
            "doi": doi,
            "isbn": isbn,
            "bibtex_raw": raw.strip(),
            "parsed_from": "bibtex",
            "warnings": [],
        }
    except Exception:
        return _regex_bibtex_parse(raw)


def _regex_bibtex_parse(raw: str) -> Optional[dict]:
    """Minimal BibTeX parser using regex, for when bibtexparser isn't installed."""
    m = re.match(r"@(\w+)\s*\{([^,]+),", raw, re.DOTALL)
    if not m:
        return None
    entry_type = m.group(1).lower()
    citekey = m.group(2).strip()

    def field(name: str) -> str:
        fm = re.search(rf"{name}\s*=\s*[{{\"](.*?)[}}\"]", raw, re.IGNORECASE | re.DOTALL)
        return fm.group(1).strip() if fm else ""

    title = field("title").strip("{}")
    author = field("author")
    year_str = field("year")
    year_match = re.search(r"\d{4}", year_str)
    year = int(year_match.group()) if year_match else None
    doi = field("doi") or None
    isbn = field("isbn") or None

    return {
        "citekey": citekey,
        "entry_type": entry_type,
        "title": title,
        "authors": parse_authors(author),
        "year": year,
        "doi": doi,
        "isbn": isbn,
        "bibtex_raw": raw.strip(),
        "parsed_from": "bibtex",
        "warnings": [],
    }


# ── Step 2: DOI → CrossRef ────────────────────────────────────────────────────

_DOI_RE = re.compile(r"10\.\d{4,}[/\w.%-]+")


def _extract_doi(text: str) -> Optional[str]:
    m = _DOI_RE.search(text)
    return m.group() if m else None


def _crossref_to_bibtex(data: dict, doi: str) -> dict:
    message = data.get("message", {})
    titles = message.get("title", [""])
    title = titles[0] if titles else ""
    entry_type_map = {
        "journal-article": "article",
        "book": "book",
        "book-chapter": "incollection",
        "proceedings-article": "inproceedings",
        "report": "techreport",
        "dataset": "misc",
        "dissertation": "phdthesis",
        "posted-content": "misc",
    }
    cr_type = message.get("type", "misc")
    entry_type = entry_type_map.get(cr_type, "misc")

    authors_raw = message.get("author", [])
    authors = []
    for a in authors_raw:
        family = a.get("family", "")
        given = a.get("given", "")
        if family and given:
            authors.append(f"{family}, {given}")
        elif family:
            authors.append(family)

    pub_date = message.get("published", message.get("published-print", {}))
    date_parts = pub_date.get("date-parts", [[]])
    year = date_parts[0][0] if date_parts and date_parts[0] else None

    journal = (message.get("container-title") or [""])[0]
    volume = message.get("volume", "")
    issue = message.get("issue", "")
    pages = message.get("page", "").replace("-", "--")
    publisher = message.get("publisher", "")

    citekey = generate_citekey(authors, year, title)

    bib_lines = [f"@{entry_type}{{{citekey},"]
    bib_lines.append(f"  title     = {{{title}}},")
    if authors:
        bib_lines.append(f"  author    = {{{' and '.join(authors)}}},")
    if year:
        bib_lines.append(f"  year      = {{{year}}},")
    if journal:
        bib_lines.append(f"  journal   = {{{journal}}},")
    if volume:
        bib_lines.append(f"  volume    = {{{volume}}},")
    if issue:
        bib_lines.append(f"  number    = {{{issue}}},")
    if pages:
        bib_lines.append(f"  pages     = {{{pages}}},")
    if publisher:
        bib_lines.append(f"  publisher = {{{publisher}}},")
    bib_lines.append(f"  doi       = {{{doi}}},")
    bib_lines.append("}")
    bibtex_raw = "\n".join(bib_lines)

    return {
        "citekey": citekey,
        "entry_type": entry_type,
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "isbn": None,
        "bibtex_raw": bibtex_raw,
        "parsed_from": "crossref",
        "warnings": [],
    }


def _try_doi(text: str, crossref_enabled: bool = True) -> Optional[dict]:
    doi = _extract_doi(text)
    if not doi:
        return None
    if not crossref_enabled or not HAS_HTTPX:
        return None
    try:
        url = f"https://api.crossref.org/works/{doi}"
        headers = {"User-Agent": "PhilosophyNotesApp/1.0 (mailto:user@localhost)"}
        resp = httpx.get(url, headers=headers, timeout=8.0)
        if resp.status_code == 200:
            return _crossref_to_bibtex(resp.json(), doi)
    except Exception:
        pass
    return None


# ── Step 3: ISBN → OpenLibrary ────────────────────────────────────────────────

_ISBN_RE = re.compile(r"\b(?:ISBN[:\s]*)?(97[89][\d\-X]{10,}|\d[\d\-X]{8,12})\b", re.IGNORECASE)


def _normalize_isbn(raw: str) -> str:
    return re.sub(r"[-\s]", "", raw).upper()


def _extract_isbn(text: str) -> Optional[str]:
    m = _ISBN_RE.search(text)
    if not m:
        return None
    return _normalize_isbn(m.group(1))


def _openlibrary_to_bibtex(data: dict, isbn: str) -> Optional[dict]:
    # OpenLibrary returns {key: {info_url, thumbnail_url, details, ...}}
    entry = next(iter(data.values()), {})
    details = entry.get("details", {})
    title = details.get("title", "") or entry.get("title", "")
    if not title:
        return None

    authors_raw = details.get("authors", [])
    authors = [a.get("name", "") for a in authors_raw if a.get("name")]

    year = None
    pub_date = details.get("publish_date", "")
    year_m = re.search(r"\d{4}", pub_date)
    if year_m:
        year = int(year_m.group())

    publisher_list = details.get("publishers", [])
    publisher = publisher_list[0] if publisher_list else ""

    citekey = generate_citekey(authors, year, title)

    bib_lines = [f"@book{{{citekey},"]
    bib_lines.append(f"  title     = {{{title}}},")
    if authors:
        bib_lines.append(f"  author    = {{{' and '.join(authors)}}},")
    if year:
        bib_lines.append(f"  year      = {{{year}}},")
    if publisher:
        bib_lines.append(f"  publisher = {{{publisher}}},")
    bib_lines.append(f"  isbn      = {{{isbn}}},")
    bib_lines.append("}")

    return {
        "citekey": citekey,
        "entry_type": "book",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": None,
        "isbn": isbn,
        "bibtex_raw": "\n".join(bib_lines),
        "parsed_from": "isbn",
        "warnings": [],
    }


def _try_isbn(text: str, openlibrary_enabled: bool = True) -> Optional[dict]:
    isbn = _extract_isbn(text)
    if not isbn:
        return None
    if not openlibrary_enabled or not HAS_HTTPX:
        return None
    try:
        url = f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=details"
        resp = httpx.get(url, timeout=8.0)
        if resp.status_code == 200 and resp.json():
            return _openlibrary_to_bibtex(resp.json(), isbn)
    except Exception:
        pass
    return None


# ── Step 5: Free-text fallback ────────────────────────────────────────────────

def _free_text_parse(text: str) -> dict:
    warnings = ["Could not detect a structured format. Please review and edit the BibTeX."]

    # Try to find year
    year_m = re.search(r"\b(1[5-9]\d{2}|20\d{2})\b", text)
    year = int(year_m.group()) if year_m else None

    # Try to find title: text in quotes or after a period
    title_m = re.search(r'"([^"]{5,})"', text) or re.search(r"'([^']{5,})'", text)
    title = title_m.group(1) if title_m else text[:80].split(".")[0].strip()

    # Authors: text before year or before a period
    authors = []
    if year:
        before_year = text[:text.index(str(year))].strip()
        # Heuristic: if starts with capital word(s) before year
        author_m = re.match(r"^([A-Z][^,.(]+(?:,\s*[A-Z][^,.(]+)*)", before_year)
        if author_m:
            raw_author = author_m.group(1).strip().rstrip(",")
            authors = [raw_author]

    citekey = generate_citekey(authors, year, title)

    bib_lines = [f"@misc{{{citekey},"]
    bib_lines.append(f"  title  = {{{title}}},")
    if authors:
        bib_lines.append(f"  author = {{{' and '.join(authors)}}},")
    if year:
        bib_lines.append(f"  year   = {{{year}}},")
    bib_lines.append(f"  note   = {{Original input: {text[:200].strip()}}},")
    bib_lines.append("}")

    return {
        "citekey": citekey,
        "entry_type": "misc",
        "title": title,
        "authors": authors,
        "year": year,
        "doi": None,
        "isbn": None,
        "bibtex_raw": "\n".join(bib_lines),
        "parsed_from": "free_text",
        "warnings": warnings,
    }


# ── Main entry point ──────────────────────────────────────────────────────────

def parse_citation(
    raw_input: str,
    existing_keys: Optional[set[str]] = None,
    crossref_enabled: bool = True,
    openlibrary_enabled: bool = True,
) -> dict:
    """
    Attempt to parse raw_input into a citation dict.
    Always returns a dict (may be incomplete); caller should show warnings to user.
    """
    if existing_keys is None:
        existing_keys = set()

    text = raw_input.strip()

    # 1. BibTeX
    result = _try_parse_bibtex(text)
    if result:
        result["citekey"] = ensure_unique_citekey(result["citekey"], existing_keys)
        return result

    # 2. DOI (also catches URLs containing a DOI)
    result = _try_doi(text, crossref_enabled)
    if result:
        result["citekey"] = ensure_unique_citekey(result["citekey"], existing_keys)
        return result

    # 3. ISBN
    result = _try_isbn(text, openlibrary_enabled)
    if result:
        result["citekey"] = ensure_unique_citekey(result["citekey"], existing_keys)
        return result

    # 4. Free-text fallback
    result = _free_text_parse(text)
    result["citekey"] = ensure_unique_citekey(result["citekey"], existing_keys)
    return result
