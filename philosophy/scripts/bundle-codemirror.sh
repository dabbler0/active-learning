#!/usr/bin/env bash
# Bundle CodeMirror 6 into a single local ESM file.
# Run this once after install, or again to update CodeMirror versions.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
OUT="$APP_DIR/static/lib/codemirror-bundle.js"

echo "Installing CodeMirror npm packages…"
cd "$SCRIPT_DIR"
npm install --save-dev \
    @codemirror/state \
    @codemirror/view \
    @codemirror/commands \
    @codemirror/language \
    @codemirror/autocomplete \
    @codemirror/search \
    @codemirror/lang-markdown \
    2>/dev/null

echo "Bundling with esbuild…"
mkdir -p "$APP_DIR/static/lib"
npx esbuild codemirror-entry.js \
    --bundle \
    --format=esm \
    --outfile="$OUT" \
    --minify

echo "Bundle written to $OUT ($(du -sh "$OUT" | cut -f1))"
