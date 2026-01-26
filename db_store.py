import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Any, Dict

DB_PATH: Path


def configure_db(path: Path):
    global DB_PATH
    DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    _init_db()


def _conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT UNIQUE NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id INTEGER NOT NULL,
                category TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(workspace_id, category),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            """
        )
        conn.commit()


def init_workspaces(labels):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        for label in labels:
            slug = _slug(label)
            conn.execute(
                """
                INSERT OR IGNORE INTO workspaces(label, slug, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (label, slug, now, now),
            )
        conn.commit()


def ensure_workspace(label: str, slug: str) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO workspaces(label, slug, created_at, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(label) DO UPDATE SET slug=excluded.slug, updated_at=excluded.updated_at
            """,
            (label, slug, now, now),
        )
        row = conn.execute("SELECT id, label, slug FROM workspaces WHERE label=?", (label,)).fetchone()
    return {"id": row["id"], "label": row["label"], "slug": row["slug"]}


def get_workspace_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    with _conn() as conn:
        row = conn.execute("SELECT id, label, slug FROM workspaces WHERE slug=?", (slug,)).fetchone()
    if not row:
        return None
    return {"id": row["id"], "label": row["label"], "slug": row["slug"]}


def get_doc(workspace_id: int, category: str) -> Optional[Any]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT payload FROM documents WHERE workspace_id=? AND category=?",
            (workspace_id, category),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["payload"])
    except Exception:
        return None


def set_doc(workspace_id: int, category: str, data: Any):
    payload = json.dumps(data, indent=4)
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO documents(workspace_id, category, payload, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(workspace_id, category) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
            """,
            (workspace_id, category, payload, now),
        )
        conn.commit()


def _slug(name: str) -> str:
    import re

    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"
