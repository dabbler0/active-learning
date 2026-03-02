"""PDF compilation endpoints."""
import os
from datetime import datetime
from fastapi import APIRouter, HTTPException

from ..database import get_db
from ..models import CompileRequest, CompileResponse, TemplateInfo
from ..services import pandoc as pandoc_svc
from ..services.link_rewriter import extract_citekeys, prepare_pandoc_input, write_bib_file

router = APIRouter(tags=["compile"])


@router.get("/compile/templates", response_model=dict)
def list_templates():
    templates = pandoc_svc.get_templates()
    return {"templates": templates}


@router.post("/compile", response_model=dict)
def compile_note(req: CompileRequest):
    conn = get_db()
    try:
        # Fetch note
        row = conn.execute("SELECT * FROM notes WHERE slug=?", (req.note_slug,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Note '{req.note_slug}' not found")

        # Fetch settings for defaults
        settings = {
            r["key"]: r["value"]
            for r in conn.execute("SELECT key, value FROM settings").fetchall()
        }

        title = req.title or row["title"]
        author = req.author or settings.get("default_author", "")
        date = req.date or datetime.now().strftime("%Y-%m-%d")
        template = req.template if req.template in pandoc_svc.TEMPLATES else "article"

        body = row["body"]

        # Write .bib file
        import tempfile, os
        tmpbib = tempfile.NamedTemporaryFile(suffix=".bib", delete=False)
        bib_path = tmpbib.name
        tmpbib.close()

        try:
            if req.include_bibliography:
                citekeys = extract_citekeys(body)
                write_bib_file(citekeys, conn, bib_path)
            else:
                with open(bib_path, "w") as f:
                    f.write("")

            # Build pandoc input
            md_content = prepare_pandoc_input(
                body=body,
                title=title,
                author=author,
                date=date,
                bib_path=bib_path,
                bib_style=req.bib_style,
                conn=conn,
            )

            # Filename for the output PDF
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            output_filename = f"{req.note_slug}-{template}-{ts}.pdf"

            success, compile_log, pdf_path = pandoc_svc.compile_note(
                markdown_content=md_content,
                bib_path=bib_path,
                template=template,
                output_filename=output_filename,
            )
        finally:
            os.unlink(bib_path)

        if success and pdf_path:
            pandoc_svc.cleanup_old_pdfs(req.note_slug)
            return CompileResponse(
                pdf_url=f"/pdf/{output_filename}",
                filename=output_filename,
                compile_log=compile_log,
                success=True,
            ).model_dump()
        else:
            return CompileResponse(
                pdf_url=None,
                filename=None,
                compile_log=compile_log,
                success=False,
                error="Compilation failed. See compile_log for details.",
            ).model_dump()
    finally:
        conn.close()
