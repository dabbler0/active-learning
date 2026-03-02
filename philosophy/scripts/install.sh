#!/usr/bin/env bash
# Install system dependencies and Python packages for the Philosophy app.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Installing system packages ==="
apt-get update -q
apt-get install -y --no-install-recommends \
    pandoc \
    texlive-xetex \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    texlive-bibtex-extra \
    biber \
    fonts-liberation \
    fonts-ebgaramond \
    2>/dev/null || {
    echo "Warning: Some system packages may not have installed. Install manually if needed."
}

echo "=== Installing Python packages ==="
# Note: install pybtex separately first to avoid build issues with bibtexparser
pip3 install pybtex
pip3 install -r "$APP_DIR/requirements.txt"

echo "=== Building CodeMirror bundle ==="
bash "$SCRIPT_DIR/bundle-codemirror.sh"

echo ""
echo "=== Installation complete ==="
echo "Run with: python run.py"
echo "Then open http://localhost:8000 in your browser."
