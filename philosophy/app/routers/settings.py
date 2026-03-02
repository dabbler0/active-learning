"""App settings endpoints."""
from fastapi import APIRouter
from ..database import get_db
from ..models import SettingsUpdate

router = APIRouter(tags=["settings"])


@router.get("/settings", response_model=dict)
def get_settings():
    conn = get_db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


@router.put("/settings", response_model=dict)
def update_settings(data: SettingsUpdate):
    conn = get_db()
    try:
        updates = data.model_dump(exclude_none=True)
        for key, value in updates.items():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value).lower() if isinstance(value, bool) else str(value)),
            )
        conn.commit()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()
