# Philosophy Notes

A local note-taking, reference-tracking, and academic writing app, served through the browser via `localhost`.

## Features

- **Note editor** — Markdown notes with cross-note links (`[[note:slug|text]]`) and inline citations (`[@citekey]`)
- **Citation database** — Add BibTeX, DOIs, ISBNs, or any citation format; full-text searchable
- **PDF compilation** — Compile any note to PDF via pandoc + XeLaTeX with biblatex bibliography
- **Five LaTeX styles** — article, essay, draft (double-spaced, line-numbered), beamer slides, minimal
- **Full-text search** — SQLite FTS5 search across all notes and citations
- **Autocomplete** — `[[` triggers note-link search; `[@` triggers citation search in the editor

## Quick Start

```bash
cd philosophy

# 1. Install dependencies (requires sudo for system packages)
bash scripts/install.sh

# 2. Run the server
python run.py

# 3. Open http://localhost:8000 in your browser
```

## Requirements

**System** (installed by `scripts/install.sh`):
- `pandoc` — Markdown to LaTeX conversion
- `texlive-xetex`, `texlive-latex-extra`, `texlive-bibtex-extra` — LaTeX/PDF
- `biber` — BibLaTeX bibliography processor

**Python** (installed by `pip install -r requirements.txt`):
- `fastapi`, `uvicorn` — web server
- `aiosqlite` — async SQLite
- `bibtexparser` — BibTeX parsing
- `httpx` — HTTP client for CrossRef/OpenLibrary lookups

## Usage

### Notes

Create and edit markdown notes in the centre editor panel.

**Linking to another note:**
```
See my earlier discussion [[note:hegel-phenomenology|the Phenomenology]].
```
While typing `[[`, an autocomplete dropdown appears to search and select notes.

**Citing a reference:**
```
As Hegel argues [@hegel1807, p. 23], consciousness becomes...
```
While typing `[@`, an autocomplete dropdown appears to search and select citations.

**Saving:** Ctrl+S or the Save button. Notes auto-save after 3 seconds of inactivity.

### Citations

Add citations by clicking **+ Citation**. You can paste:
- A BibTeX entry (`@article{...}`)
- A DOI (`10.XXXX/XXXX` or a full `https://doi.org/...` URL)
- An ISBN
- Any citation format (APA, MLA, etc.) — the app will attempt to parse it

The app looks up DOIs via [CrossRef](https://www.crossref.org/) and ISBNs via [OpenLibrary](https://openlibrary.org/) when enabled in Settings.

### Compiling to PDF

1. Open a note
2. Click **Compile PDF ▾** and select a template
3. Click **Compile** — the PDF appears in the right panel

Templates:
| Name | Description |
|------|-------------|
| `article` | Standard academic article (Linux Libertine, 1in margins) |
| `essay` | Readable essay (EB Garamond, wider margins, 1.4 spacing) |
| `draft` | Double-spaced with line numbers and wide left margin |
| `beamer` | Presentation slides (Beamer/Madrid theme) |
| `minimal` | Bare output, no headers |

### Data Storage

Your notes and citations are stored in `data/philosophy.db` (SQLite). This directory is gitignored — it is not committed to the repository. Back it up with `cp data/philosophy.db data/philosophy.db.bak`.

Compiled PDFs are stored in `data/exports/` (the last 20 per note are kept automatically).

## Architecture

```
philosophy/
├── app/              # FastAPI backend
│   ├── routers/      # API endpoints (notes, citations, compile, search)
│   └── services/     # pandoc pipeline, citation parser, link rewriter
├── static/           # Browser frontend (vanilla JS + CodeMirror 6)
├── latex/templates/  # LaTeX document templates
└── data/             # Runtime data (gitignored)
```

The API is documented at [http://localhost:8000/docs](http://localhost:8000/docs) when the server is running.
