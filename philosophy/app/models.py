"""Pydantic models for request/response validation."""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, field_validator
import re


# ── Helpers ──────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    """Convert a title to a URL-safe slug."""
    s = text.lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s)
    s = s.strip("-")
    return s or "untitled"


# ── Notes ────────────────────────────────────────────────────────────────────

class NoteCreate(BaseModel):
    title: str
    body: str = ""
    tags: list[str] = []
    slug: Optional[str] = None

    @field_validator("title")
    @classmethod
    def title_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be empty")
        return v

    @field_validator("slug")
    @classmethod
    def slug_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if not re.match(r"^[a-z0-9][a-z0-9-]*$", v):
                raise ValueError("slug must contain only lowercase letters, digits, and hyphens")
        return v


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    tags: Optional[list[str]] = None
    slug: Optional[str] = None

    @field_validator("slug")
    @classmethod
    def slug_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            v = v.strip()
            if not re.match(r"^[a-z0-9][a-z0-9-]*$", v):
                raise ValueError("slug must contain only lowercase letters, digits, and hyphens")
        return v


class NoteRef(BaseModel):
    slug: str
    title: str


class NoteListItem(BaseModel):
    id: int
    slug: str
    title: str
    tags: list[str]
    created_at: str
    updated_at: str
    excerpt: str


class Note(BaseModel):
    id: int
    slug: str
    title: str
    body: str
    tags: list[str]
    backlinks: list[NoteRef]
    citations_used: list[str]
    created_at: str
    updated_at: str


# ── Citations ─────────────────────────────────────────────────────────────────

class CitationCreate(BaseModel):
    raw_input: str  # any format — bibtex, DOI, ISBN, free-text


class CitationUpdate(BaseModel):
    bibtex_raw: str
    tags: Optional[list[str]] = None


class CitationNoteUpdate(BaseModel):
    body: str


class CitationListItem(BaseModel):
    id: int
    citekey: str
    entry_type: str
    title: str
    authors: list[str]
    year: Optional[int]
    tags: list[str]
    has_note: bool


class Citation(BaseModel):
    id: int
    citekey: str
    entry_type: str
    title: str
    authors: list[str]
    year: Optional[int]
    bibtex_raw: str
    doi: Optional[str]
    isbn: Optional[str]
    tags: list[str]
    note_body: Optional[str]
    created_at: str
    updated_at: str


class CitationNote(BaseModel):
    body: str
    updated_at: str


class ParsedCitation(BaseModel):
    citekey: str
    entry_type: str
    title: str
    authors: list[str]
    year: Optional[int]
    bibtex_raw: str
    doi: Optional[str] = None
    isbn: Optional[str] = None
    parsed_from: str  # "bibtex" | "doi" | "isbn" | "crossref" | "free_text"
    warnings: list[str] = []


# ── Compile ───────────────────────────────────────────────────────────────────

class CompileRequest(BaseModel):
    note_slug: str
    template: str = "article"
    title: Optional[str] = None
    author: Optional[str] = None
    date: Optional[str] = None
    include_bibliography: bool = True
    bib_style: str = "authoryear"


class CompileResponse(BaseModel):
    pdf_url: Optional[str]
    filename: Optional[str]
    compile_log: str
    success: bool
    error: Optional[str] = None


class TemplateInfo(BaseModel):
    name: str
    description: str
    filename: str


# ── Search ────────────────────────────────────────────────────────────────────

class SearchResult(BaseModel):
    type: str  # "note" | "citation"
    id: int
    slug: Optional[str] = None        # for notes
    citekey: Optional[str] = None     # for citations
    title: str
    excerpt: str
    authors: Optional[list[str]] = None
    year: Optional[int] = None


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    default_template: Optional[str] = None
    default_author: Optional[str] = None
    default_institution: Optional[str] = None
    crossref_enabled: Optional[bool] = None
    openlibrary_enabled: Optional[bool] = None
