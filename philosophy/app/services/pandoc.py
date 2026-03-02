"""Pandoc + XeLaTeX + biber compilation pipeline."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).parent.parent.parent
TEMPLATES_DIR = BASE_DIR / "latex" / "templates"
EXPORTS_DIR = BASE_DIR / "data" / "exports"

TEMPLATES = {
    "article": {"description": "Standard academic article", "filename": "article.tex"},
    "essay":   {"description": "Readable essay (wider margins, Garamond)", "filename": "essay.tex"},
    "draft":   {"description": "Double-spaced draft with line numbers", "filename": "draft.tex"},
    "beamer":  {"description": "Presentation slides (Beamer)", "filename": "beamer.tex"},
    "minimal": {"description": "Minimal output for excerpts", "filename": "minimal.tex"},
}


def get_templates() -> list[dict]:
    return [
        {"name": name, "description": info["description"], "filename": info["filename"]}
        for name, info in TEMPLATES.items()
    ]


def _run(cmd: list[str], cwd: str, timeout: int = 120) -> tuple[int, str]:
    """Run a subprocess and return (returncode, combined_output)."""
    result = subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    output = result.stdout.decode("utf-8", errors="replace")
    return result.returncode, output


def compile_note(
    markdown_content: str,
    bib_path: str,
    template: str = "article",
    output_filename: str = "output.pdf",
) -> tuple[bool, str, Optional[str]]:
    """
    Compile markdown_content to PDF.

    Args:
        markdown_content: Complete pandoc markdown (with YAML front matter already injected).
        bib_path: Path to the .bib file.
        template: Template name (key of TEMPLATES).
        output_filename: Desired filename for the output PDF.

    Returns:
        (success, compile_log, pdf_path_or_None)
    """
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

    template_info = TEMPLATES.get(template)
    if template_info is None:
        template_info = TEMPLATES["article"]
    template_path = TEMPLATES_DIR / template_info["filename"]

    if not template_path.exists():
        return False, f"Template file not found: {template_path}", None

    log_parts: list[str] = []

    with tempfile.TemporaryDirectory(prefix="philosophy-compile-") as tmpdir:
        md_path = os.path.join(tmpdir, "input.md")
        tex_path = os.path.join(tmpdir, "compiled.tex")
        pdf_src = os.path.join(tmpdir, "compiled.pdf")

        # Write markdown
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(markdown_content)

        # Step 1: pandoc → .tex
        pandoc_cmd = [
            "pandoc",
            md_path,
            "--from", "markdown+citations",
            "--to", "latex",
            f"--template={template_path}",
            "--biblatex",
            "--output", tex_path,
        ]
        log_parts.append("=== pandoc ===")
        rc, out = _run(pandoc_cmd, tmpdir)
        log_parts.append(out or "(no output)")
        if rc != 0:
            return False, "\n".join(log_parts), None

        # Step 2: xelatex (first pass — generates .aux)
        xelatex_cmd = [
            "xelatex",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "compiled.tex",
        ]
        log_parts.append("\n=== xelatex (pass 1) ===")
        rc, out = _run(xelatex_cmd, tmpdir)
        log_parts.append(out[-3000:] if len(out) > 3000 else out)
        if rc != 0 and not os.path.exists(pdf_src):
            # xelatex sometimes exits non-zero for minor warnings but still produces PDF
            return False, "\n".join(log_parts), None

        # Step 3: biber
        biber_cmd = ["biber", "compiled"]
        log_parts.append("\n=== biber ===")
        rc, out = _run(biber_cmd, tmpdir)
        log_parts.append(out or "(no output)")
        # biber failure is non-fatal if there are no citations

        # Step 4: xelatex (second pass — resolves bibliography references)
        log_parts.append("\n=== xelatex (pass 2) ===")
        rc, out = _run(xelatex_cmd, tmpdir)
        log_parts.append(out[-3000:] if len(out) > 3000 else out)

        if not os.path.exists(pdf_src):
            return False, "\n".join(log_parts), None

        # Move PDF to exports directory
        dest = EXPORTS_DIR / output_filename
        shutil.copy2(pdf_src, str(dest))

    return True, "\n".join(log_parts), str(dest)


def cleanup_old_pdfs(note_slug: str, keep: int = 20) -> None:
    """Keep only the most recent `keep` PDFs for a given note slug."""
    pdfs = sorted(
        EXPORTS_DIR.glob(f"{note_slug}-*.pdf"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in pdfs[keep:]:
        old.unlink(missing_ok=True)
