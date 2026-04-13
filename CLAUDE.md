# Philosophy Notes — Developer Guide (CLAUDE.md)

## Project Overview

A personal knowledge-management SPA for academic philosophy. Pure vanilla
JavaScript — no framework, no server. All data is stored in the browser via
IndexedDB. The built artefact is a handful of static files that can be
served from any web server or GitHub Pages.

---

## Tech Stack

| Layer       | Technology                                  |
|-------------|---------------------------------------------|
| Bundler     | esbuild (`build.js`)                        |
| Editor      | CodeMirror 6                                |
| Markdown    | markdown-it                                 |
| Storage     | IndexedDB (abstracted behind `StorageBackend`) |
| Settings    | localStorage                                |
| Deployment  | Static files (GitHub Pages via Actions)     |

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
    ├── main.js             # Boot, tab-switching, import/export, settings
    ├── app.css             # All UI styles (includes mobile responsive)
    ├── ui/
    │   ├── notes.js        # Notes list + editor
    │   ├── citations.js    # Citations list + editor
    │   ├── editor.js       # CodeMirror 6 setup + autocomplete
    │   ├── search.js       # Global full-text search
    │   └── bluetooth.js    # Bluetooth transfer UI
    ├── services/
    │   ├── markdown.js     # markdown-it + custom citation/link rules
    │   ├── bibtex.js       # BibTeX/DOI/ISBN parsing pipeline
    │   ├── pdf.js          # Print window + theme injection
    │   ├── bluetooth.js    # Web Bluetooth GATT transfer protocol
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
npm install          # install esbuild + codemirror + markdown-it
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

### Auto-save (notes.js / citations.js)
A 2-second debounce timer triggers `saveNote()` after the user stops typing.
`Ctrl+S` forces an immediate save. Both call `storage.saveNote(note)`.

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

## Mobile Layout

At `≤ 768px` the five-column grid collapses to a single-column view.
A **bottom navigation bar** (`#mobile-nav`) with four buttons appears:
- **List** — shows the left panel (notes/citations list)
- **Edit** — shows the editor panel
- **Preview** — shows the right panel (markdown preview / citation details)
- **More** — shows the toolbar actions (export, import, settings)

The active panel is tracked via CSS class `mobile-active-panel` on `#main`.
Resize handles are hidden on mobile (`display: none`).
The fixed top toolbar hides its tab-nav and right buttons on mobile — those
actions move to the bottom bar.

---

## Bluetooth Transfer

Feature file: `src/services/bluetooth.js` + `src/ui/bluetooth.js`

### Protocol overview
Uses the **Web Bluetooth API** (Chrome/Edge, HTTPS required).

Custom GATT service UUID: `a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6`

Characteristics:
| UUID suffix | Name        | Properties       | Description                          |
|-------------|-------------|------------------|--------------------------------------|
| `...c5d7`   | META        | read             | JSON: `{ size, chunks, version }`   |
| `...c5d8`   | CHUNK       | read / write     | 512-byte data chunk                  |
| `...c5d9`   | OFFSET      | write            | uint32 chunk index to seek to        |
| `...c5da`   | CONTROL     | write / notify   | 0x01=start, 0x02=ack, 0xFF=done     |

Because browsers currently **cannot act as a GATT peripheral**, this feature
implements the **central (client) role only** and requires the remote device
to expose the custom GATT service. On Android, Chrome Canary with the
"Experimental Web Platform Features" flag enables peripheral simulation.

For transfer between two desktop browsers, users should use the
JSON **Export / Import** flow instead, which has no browser restrictions.

### UI flow
1. User clicks **Bluetooth** button in toolbar → Bluetooth modal opens.
2. **Send tab**: calls `storage.exportAll()`, encodes to JSON bytes, then
   `navigator.bluetooth.requestDevice()` to scan for the GATT service.
   Connects and writes chunks via the CHUNK characteristic.
3. **Receive tab**: same scan, connects, reads META then reads all chunks
   in order, reconstructs JSON, calls `storage.importAll()`.

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
  "leftPanelWidth":     280,
  "rightPanelWidth":    360,
  "crossrefEnabled":    true,
  "openlibraryEnabled": true
}
```

---

## Common Gotchas

1. **CSS text loader** — Any new `*.css` file imported from JS will be
   inlined as a string by esbuild, not injected as a `<style>` tag.
   Only print-theme CSS should be imported from JS. App styles go in
   `src/app.css` and are linked in `index.html`.

2. **IndexedDB transactions** — Transactions auto-close after the last
   queued request. Do not await unrelated async operations inside a
   transaction; open a new one instead.

3. **HTTPS for Web Bluetooth + crypto.randomUUID** — Both APIs require a
   secure context. `localhost` counts as secure for development.
   GitHub Pages serves over HTTPS automatically.

4. **Mobile viewport** — `overflow: hidden` on `html, body` prevents bounce
   scroll on iOS. On mobile the main grid uses `height: 100dvh` to account
   for the dynamic viewport (browser chrome show/hide).

5. **Print CSS** — Print CSS files are imported with esbuild's `text` loader
   and become JS string variables. They are injected into a `<style>` tag
   inside a new `window.open()` popup for printing. Do NOT add `*.css` to
   JS imports unless you intend this behaviour.
