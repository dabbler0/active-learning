"""FastAPI application entry point."""
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .database import init_db, DATA_DIR
from .routers import notes, citations, compile, search, settings as settings_router

BASE_DIR = Path(__file__).parent.parent

app = FastAPI(title="Philosophy Notes", version="1.0.0")


@app.on_event("startup")
def startup() -> None:
    init_db()


# ── API routers ───────────────────────────────────────────────────────────────
app.include_router(notes.router, prefix="/api/v1")
app.include_router(citations.router, prefix="/api/v1")
app.include_router(compile.router, prefix="/api/v1")
app.include_router(search.router, prefix="/api/v1")
app.include_router(settings_router.router, prefix="/api/v1")


# ── PDF serving ───────────────────────────────────────────────────────────────
@app.get("/pdf/{filename}")
def serve_pdf(filename: str) -> FileResponse:
    pdf_path = DATA_DIR / "exports" / filename
    return FileResponse(str(pdf_path), media_type="application/pdf")


# ── Static files ──────────────────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/{full_path:path}")
def serve_spa(full_path: str) -> FileResponse:
    """Serve the SPA for all non-API routes."""
    return FileResponse(str(BASE_DIR / "static" / "index.html"))
