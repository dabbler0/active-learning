# Philosophy Notes — Developer Guide (CLAUDE.md)

## Project Overview

A personal knowledge-management SPA for academic philosophy. Pure vanilla
JavaScript — no framework, no server. All data is stored in the browser via
IndexedDB. The built artefact is a handful of static files that can be
served from any web server or GitHub Pages.

---

## Tech Stack

| Layer       | Technology                                         |
|-------------|----------------------------------------------------|
| Bundler     | esbuild (`build.js`)                               |
| Editor      | CodeMirror 6 (source) + Milkdown (WYSIWYG)         |
| Markdown    | markdown-it                                        |
| Storage     | IndexedDB (abstracted behind `StorageBackend`)      |
| Settings    | localStorage                                       |
| Deployment  | Static files (GitHub Pages via Actions)            |

---

## Directory Layout

```
philosophy-js/
├── index.html              # Single HTML entry point
├── package.json
├── build.js                # esbuild config + asset copy script
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Pages CI/CD
└── src/
    ├── main.js             # Boot, tab-switching, import/export, settings, theme
    ├── app.css             # All UI styles (light + dark theme, mobile responsive)
    ├── ui/
    │   ├── notes.js        # Notes list + dual-mode editor (CodeMirror / Milkdown)
    │   ├── citations.js    # Citations list + editor + Add Citation modal
    │   ├── editor.js       # CodeMirror 6 setup + autocomplete
    │   ├── milkdown-editor.js          # Milkdown WYSIWYG editor setup
    │   ├── milkdown-citation-plugin.js # [@citekey] → atomic chip in WYSIWYG
    │   ├── milkdown-notelink-plugin.js # [[note:slug]] → atomic chip in WYSIWYG
    │   ├── search.js       # Global full-text search
    │   └── webrtc.js       # QR-code-based peer-to-peer sync UI
    ├── services/
    │   ├── markdown.js     # markdown-it + custom citation/link rules
    │   ├── bibtex.js       # BibTeX/DOI/ISBN parsing pipeline
    │   ├── crossref.js     # CrossRef API client (keyword search for citations)
    │   ├── pdf.js          # Print window + theme injection
    │   └── print-themes/   # CSS files imported as text for print windows
    │       ├── academic.css
    │       ├── essay.css
    │       ├── draft.css
    │       └── minimal.css
    └── storage/
        ├── interface.js    # Abstract StorageBackend class
        └── indexeddb.js    # Concrete IndexedDB implementation
```

---

## Build & Dev

```bash
npm install          # install esbuild + codemirror + milkdown + markdown-it
npm run build        # production → dist/
npm run dev          # watch mode with source maps → dist/
```

Serve the output:
```bash
python3 -m http.server --directory dist
```

Build output (`dist/`):
- `index.html` — copied verbatim from root
- `app.css`    — copied verbatim from `src/app.css`
- `bundle.js`  — esbuild bundle of `src/main.js` + all imports

**CSS loader note:** All `*.css` files imported from JS are loaded as raw
text strings (esbuild `loader: { '.css': 'text' }`). This is only used for
the print-theme CSS which is injected into print popup windows. `app.css`
is NOT imported from JS — it is served as a normal stylesheet linked in HTML.

---

## Data Model

### Notes (IndexedDB store: `notes`, keyPath: `id`)
```
id          : UUID string
slug        : URL-safe unique identifier
title       : string
body        : markdown string
tags        : string[]
created_at  : ISO 8601
updated_at  : ISO 8601
```

### Citations (IndexedDB store: `citations`, keyPath: `citekey`)
```
citekey     : string (BibTeX key, e.g. "Smith2020")
entry_type  : string (article, book, misc, …)
title       : string
authors     : string[]
year        : number | null
bibtex_raw  : string (full raw BibTeX)
doi         : string | null
isbn        : string | null
note_body   : string (annotation markdown)
tags        : string[]
created_at  : ISO 8601
updated_at  : ISO 8601
```

### Export / Import format
```json
{
  "version": 1,
  "exported_at": "<ISO>",
  "backend": "indexeddb",
  "notes": [...],
  "citations": [...]
}
```

---

## Key Architecture Patterns

### Tab switching (main.js)
`activateTab(tab)` toggles `.active` on `.tab-btn` elements and `.hidden`
on `.list-panel` elements. Active tab = `notes | citations | search`.

### Dual-mode note editor (notes.js)
The note editor supports two modes toggled by `#editor-mode-btn`:
- **CodeMirror** (default) — plain-text source with Markdown syntax
  highlighting, `[[` / `[@` autocomplete.
- **Milkdown** — rich-text WYSIWYG; `[[note:slug|Label]]` and `[@citekey]`
  are rendered as atomic inline chips in the editor.

The current mode is persisted to localStorage. Switching modes transfers
content between editors without data loss.

### Autosave (notes.js)
Both editor modes use a **throttled autosave** pattern rather than a plain
debounce. State: `_dirty` (boolean), `_lastSavedAt` (timestamp),
`_autoSaveTimer` (handle).

On every edit, `markDirty()` is called. It schedules a save for
`max(0, AUTO_SAVE_INTERVAL − elapsed_since_last_save)` ms. If a timer is
already pending, it does nothing. After each save (auto or manual),
`_dirty` is reset and `_lastSavedAt` is updated. This guarantees a save
fires at most once per `AUTO_SAVE_INTERVAL` (3 s) even during continuous
typing, while avoiding the "never saves while typing" problem of pure
debounce. `Ctrl+S` / Save button bypass the timer and save immediately.

Preview refresh runs on an independent 600 ms debounce.

### Markdown inline extensions (markdown.js)
- `[[note:slug|Label]]` → `<a class="note-link">` (rendered in preview)
- `[@citekey]` / `[@citekey, p. 5]` → `<cite>` + bibliography section

### Resize handles (main.js)
CSS grid `grid-template-columns` is overwritten inline via JS during
mousedown drag. Settings persist widths to localStorage.
On mobile the resize handles are hidden and layout switches to single-column.

### StorageBackend interface (storage/interface.js)
Abstract class with methods:
- `listNotes()`, `getNote(id)`, `saveNote(note)`, `deleteNote(id)`
- `listCitations()`, `getCitation(ck)`, `saveCitation(c)`, `deleteCitation(ck)`
- `exportAll()` → dump object, `importAll(dump)`

---

## Dark Mode

Dark mode is toggled via **Settings → Dark mode** checkbox. The preference
is stored in localStorage (`darkMode: true/false`).

`applyTheme(darkMode)` in `main.js` sets `document.documentElement.dataset.theme`
to `"dark"` or `""`. The CSS in `app.css` defines a `[data-theme="dark"]`
block that overrides all `--color-*` custom properties. Because CodeMirror's
theme in `editor.js` references `var(--color-surface2)`, `var(--color-border)`,
and `var(--color-cm-activeline)`, the editor adapts automatically.

QR canvas backgrounds are intentionally kept `#fff` regardless of theme since
QR codes require a white background to be scannable.

---

## Mobile Layout

At `≤ 768px` the five-column grid collapses to a single-column view.
A **bottom navigation bar** (`#mobile-nav`) with four buttons appears:
- **List** — shows the left panel (notes/citations list)
- **Edit** — shows the editor panel
- **Preview** — shows the right panel (markdown preview / citation details)
- **More** — shows the toolbar actions (export, import, settings)

The active panel is tracked via `data-mobile-panel` attribute on `#main`.
Resize handles are hidden on mobile (`display: none`).
The fixed top toolbar hides its tab-nav and right buttons on mobile — those
actions move to the bottom bar.

**Auto-navigate:** When a note is opened (from list click or search), the
`mobile-open-edit` window event is dispatched. `initMobileNav()` in
`main.js` listens for this and switches to the `edit` panel automatically,
so the user lands in the editor without an extra tap.

---

## QR / WebRTC Sync

Feature file: `src/ui/webrtc.js`

Uses **WebRTC** with a QR-code-based signalling channel (no server).

**Protocol:**
1. Host device exports its database as JSON, encodes the WebRTC offer as a
   sequence of QR codes.
2. Join device scans the offer QR codes, creates an answer QR code sequence.
3. Host scans the answer QR codes to complete the WebRTC handshake.
4. Once the peer DataChannel is open, both devices exchange full database
   dumps and merge them with conflict resolution.

**Conflict resolution:** When a note or citation exists on both devices with
different `updated_at` timestamps, the user is shown a dialog to choose
which version to keep.

The QR tab in the toolbar opens `#qr-modal`. The UI uses `.bt-*` CSS classes.

---

## Add Citation Modal

The **Add Citation** modal (`#add-cite-modal`) has two panes:

1. **Search pane** — queries the **CrossRef** API (`src/services/crossref.js`)
   by title, author, or keyword. Results are displayed in a list; clicking one
   shows a preview and allows saving. Supports CrossRef's polite pool via a
   user-configured email address (Settings → CrossRef email).

2. **Manual Entry pane** — accepts raw BibTeX, a DOI (fetched via CrossRef),
   an ISBN (fetched via OpenLibrary), or free-text. Parsing is done by
   `parseCitation()` in `src/services/bibtex.js`.

The modal can be opened from the Citations tab ("+ Citation" button) or
inline from the note editor when the user types `[@` and picks
"+ Create new citation" from the autocomplete.

---

## GitHub Pages Deployment

Workflow: `.github/workflows/deploy.yml`

Trigger: push to `main` branch.

Steps:
1. `npm ci` + `npm run build`
2. Upload `dist/` as GitHub Pages artefact
3. Deploy via `actions/deploy-pages`

The built app is fully static; no base-path changes are needed because
all asset links are relative (`app.css`, `bundle.js`).

---

## Settings (localStorage key: `philosophy-js-settings`)

```json
{
  "author":             "",
  "crossrefEmail":      "",
  "darkMode":           false,
  "leftPanelWidth":     280,
  "rightPanelWidth":    360,
  "editorMode":         "codemirror",
  "crossrefEnabled":    true,
  "openlibraryEnabled": true
}
```

`crossrefEmail` — when set, is passed as the `mailto` query parameter in
CrossRef API requests, placing the client in CrossRef's polite pool for
faster and more reliable responses.

---

## Common Gotchas

1. **CSS text loader** — Any new `*.css` file imported from JS will be
   inlined as a string by esbuild, not injected as a `<style>` tag.
   Only print-theme CSS should be imported from JS. App styles go in
   `src/app.css` and are linked in `index.html`.

2. **IndexedDB transactions** — Transactions auto-close after the last
   queued request. Do not await unrelated async operations inside a
   transaction; open a new one instead.

3. **HTTPS for WebRTC + crypto.randomUUID** — Both APIs require a
   secure context. `localhost` counts as secure for development.
   GitHub Pages serves over HTTPS automatically.

4. **Mobile viewport** — `overflow: hidden` on `html, body` prevents bounce
   scroll on iOS. On mobile the main grid uses `height: 100dvh` to account
   for the dynamic viewport (browser chrome show/hide).

5. **Print CSS** — Print CSS files are imported with esbuild's `text` loader
   and become JS string variables. They are injected into a `<style>` tag
   inside a new `window.open()` popup for printing. Do NOT add `*.css` to
   JS imports unless you intend this behaviour.

6. **Dark mode + CodeMirror** — The CM editor theme in `editor.js` uses
   CSS custom properties (`var(--color-surface2)` etc.) rather than hardcoded
   hex values, so it adapts automatically when `[data-theme="dark"]` is set
   on `<html>`. Syntax highlighting colours (from `defaultHighlightStyle`)
   do not change with dark mode.

7. **QR canvas background** — Always `#fff` regardless of theme. QR scanners
   require a light background; do not apply `var(--color-bg)` to the canvas.
