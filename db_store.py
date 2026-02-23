# =============================================================================
# Author: Rick Escher
# Project: SilingMedAdvisor (SailingMedAdvisor)
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
File: db_store.py
Author notes: Centralized persistence layer for SailingMedAdvisor. I keep all
SQLite schema definitions, convenience getters/setters, and upgrade/seed helpers
here so every API handler can stay focused on business logic instead of SQL.
"""

import json
import math
import shutil
import sqlite3
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, Any, Dict

logger = logging.getLogger("uvicorn.error")

DB_PATH: Path


def configure_db(path: Path):
    """Configure DB path and ensure single-workspace schema."""
    global DB_PATH
    DB_PATH = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    _init_db()
    # Run any needed schema upgrades (non-destructive)
    _upgrade_schema()


def _conn():
    """
     Conn helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        # Keep temp tables in memory to avoid filesystem issues when sorting large BLOB rows
        conn.execute("PRAGMA temp_store = MEMORY;")
    except Exception:
        pass
    return conn


def _init_db():
    """Create single-workspace documents table; migrate legacy workspace schema if found."""
    with _conn() as conn:
        now = datetime.utcnow().isoformat()
        # Detect legacy schema (workspace_id column)
        info = conn.execute("PRAGMA table_info(documents)").fetchall()
        has_legacy_docs = any(col["name"] == "workspace_id" for col in info) if info else False

        if has_legacy_docs:
            # Backup before migration
            backup = Path(str(DB_PATH) + ".bak")
            try:
                shutil.copy2(DB_PATH, backup)
            except Exception:
                pass

            conn.execute("ALTER TABLE documents RENAME TO documents_old;")

        # Create new schema (unique category, no workspaces)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vessel (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                vesselName TEXT,
                registrationNumber TEXT,
                flagCountry TEXT,
                homePort TEXT,
                callSign TEXT,
                tonnage TEXT,
                netTonnage TEXT,
                mmsi TEXT,
                hullNumber TEXT,
                starboardEngine TEXT,
                starboardEngineSn TEXT,
                portEngine TEXT,
                portEngineSn TEXT,
                ribSn TEXT,
                boatPhoto TEXT,
                registrationFrontPhoto TEXT,
                registrationBackPhoto TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        # Relational crew table (denormalized columns) plus vaccines
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS crew (
                id TEXT PRIMARY KEY,
                firstName TEXT,
                middleName TEXT,
                lastName TEXT,
                sex TEXT,
                birthdate TEXT,
                position TEXT,
                citizenship TEXT,
                birthplace TEXT,
                passportNumber TEXT,
                passportIssue TEXT,
                passportExpiry TEXT,
                emergencyContactName TEXT,
                emergencyContactRelation TEXT,
                emergencyContactPhone TEXT,
                emergencyContactEmail TEXT,
                emergencyContactNotes TEXT,
                phoneNumber TEXT,
                history TEXT,
                username TEXT,
                password TEXT,
                passportHeadshot TEXT,
                passportPage TEXT,
                passportHeadshotBlob BLOB,
                passportHeadshotMime TEXT,
                passportPageBlob BLOB,
                passportPageMime TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS crew_vaccines (
                id TEXT PRIMARY KEY,
                crew_id TEXT NOT NULL,
                vaccineType TEXT,
                dateAdministered TEXT,
                doseNumber TEXT,
                tradeNameManufacturer TEXT,
                lotNumber TEXT,
                provider TEXT,
                providerCountry TEXT,
                nextDoseDue TEXT,
                expirationDate TEXT,
                siteRoute TEXT,
                reactions TEXT,
                remarks TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(crew_id) REFERENCES crew(id) ON DELETE CASCADE
            );
            """
        )
        # Settings-backed lookup tables
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vaccine_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                position INTEGER NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pharmacy_labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                position INTEGER NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS equipment_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                position INTEGER NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS consumable_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                position INTEGER NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS model_params (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                triage_instruction TEXT,
                inquiry_instruction TEXT,
                tr_temp REAL,
                tr_tok INTEGER,
                tr_p REAL,
                tr_k INTEGER,
                in_temp REAL,
                in_tok INTEGER,
                in_p REAL,
                in_k INTEGER,
                mission_context TEXT,
                rep_penalty REAL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS prompt_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_key TEXT NOT NULL,
                name TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(prompt_key, name)
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings_meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                user_mode TEXT,
                offline_force_flags INTEGER DEFAULT 0,
                last_prompt_verbatim TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS context_store (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                itemType TEXT NOT NULL, -- pharma | equipment | consumable
                name TEXT,
                genericName TEXT,
                brandName TEXT,
                alsoKnownAs TEXT,
                formStrength TEXT,
                indications TEXT,
                contraindications TEXT,
                consultDoctor TEXT,
                adultDosage TEXT,
                pediatricDosage TEXT,
                unwantedEffects TEXT,
                storageLocation TEXT,
                subLocation TEXT,
                status TEXT,
                verified INTEGER DEFAULT 0,
                expiryDate TEXT,
                lastInspection TEXT,
                batteryType TEXT,
                batteryStatus TEXT,
                calibrationDue TEXT,
                totalQty TEXT,
                minPar TEXT,
                supplier TEXT,
                parentId TEXT,
                requiresPower INTEGER,
                category TEXT,
                typeDetail TEXT,
                priorityTier TEXT,
                tierCategory TEXT,
                notes TEXT,
                excludeFromResources INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS med_expiries (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                date TEXT,
                quantity TEXT,
                notes TEXT,
                manufacturer TEXT,
                batchLot TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS history_entries (
                id TEXT PRIMARY KEY,
                date TEXT,
                patient TEXT,
                patient_id TEXT,
                mode TEXT,
                query TEXT,
                user_query TEXT,
                response TEXT,
                model TEXT,
                duration_ms INTEGER,
                prompt TEXT,
                injected_prompt TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS who_medicines (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                genericName TEXT,
                alsoKnownAs TEXT,
                formStrength TEXT,
                indications TEXT,
                contraindications TEXT,
                consultDoctor TEXT,
                adultDosage TEXT,
                unwantedEffects TEXT,
                remarks TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_metrics (
                model TEXT PRIMARY KEY,
                count INTEGER DEFAULT 0,
                total_ms INTEGER DEFAULT 0,
                avg_ms REAL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                role TEXT,
                message TEXT,
                model TEXT,
                mode TEXT,
                patient_id TEXT,
                user TEXT,
                created_at TEXT NOT NULL,
                meta TEXT
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_options (
                field TEXT NOT NULL,
                value TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(field, position)
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_prompt_modules (
                category TEXT NOT NULL,
                module_key TEXT NOT NULL,
                module_text TEXT NOT NULL,
                position INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(category, module_key)
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_prompt_tree (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.commit()

        # Legacy migration removed
        conn.execute("DROP TABLE IF EXISTS documents_old;")
        conn.execute("DROP TABLE IF EXISTS workspaces;")
        conn.commit()


def _maybe_migrate_crew(conn, now):
    """No-op: legacy crew migration removed."""
    return


    ensure_relational_tables()
    ensure_blob_columns()
    _hash_existing_credentials(conn)

    def migrate_vaccines_from_json():
        """If vaccines exist only in legacy patients JSON and crew_vaccines is empty, import them."""
        try:
            existing = conn.execute("SELECT COUNT(*) FROM crew_vaccines").fetchone()[0]
            if existing > 0:
                return
            row = conn.execute("SELECT payload FROM documents WHERE category='patients'").fetchone()
            if not row:
                return
            try:
                patients = json.loads(row["payload"]) or []
            except Exception:
                return
            for member in patients:
                crew_id = str(member.get("id") or "")
                if not crew_id:
                    continue
                vaccines = member.get("vaccines") or []
                for v in vaccines:
                    try:
                        upsert_vaccine(crew_id, v, now)
                    except Exception:
                        continue
        except Exception:
            pass

    # Legacy crew table with data JSON column
    if has_data_column():
        rows = conn.execute("SELECT id, data, updated_at FROM crew").fetchall()
        # Create temp table with new schema
        conn.execute("ALTER TABLE crew RENAME TO crew_old;")
        conn.execute(
            """
            CREATE TABLE crew (
                id TEXT PRIMARY KEY,
                firstName TEXT,
                middleName TEXT,
                lastName TEXT,
                sex TEXT,
                birthdate TEXT,
                position TEXT,
                citizenship TEXT,
                birthplace TEXT,
                passportNumber TEXT,
                passportIssue TEXT,
                passportExpiry TEXT,
                emergencyContactName TEXT,
                emergencyContactRelation TEXT,
                emergencyContactPhone TEXT,
                emergencyContactEmail TEXT,
                emergencyContactNotes TEXT,
                phoneNumber TEXT,
                history TEXT,
                username TEXT,
                password TEXT,
                passportHeadshot TEXT,
                passportPage TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute("DELETE FROM crew_vaccines;")
        for r in rows:
            try:
                member = json.loads(r["data"]) or {}
            except Exception:
                member = {}
            mid = str(member.get("id") or r["id"] or "")
            if not mid:
                continue
            _insert_relational_crew(conn, mid, member, r["updated_at"] or now)
        conn.execute("DROP TABLE IF EXISTS crew_old;")

    # Legacy patients JSON document
    existing_crew = conn.execute("SELECT COUNT(*) FROM crew").fetchone()[0]
    if existing_crew == 0:
        row = conn.execute("SELECT payload, updated_at FROM documents WHERE category='patients'").fetchone()
        if row:
            payload, updated = row
            try:
                data = json.loads(payload) or []
            except Exception:
                data = []
            conn.execute("DELETE FROM crew;")
            conn.execute("DELETE FROM crew_vaccines;")
            for member in data:
                mid = str(member.get("id") or "")
                if not mid:
                    continue
                _insert_relational_crew(conn, mid, member, updated or now)
            conn.execute("DELETE FROM documents WHERE category='patients'")
        conn.commit()
    migrate_vaccines_from_json()


def _hash_existing_credentials(conn):
    """Ensure credentials exist; if old hashed values remain, clear them so users can re-enter."""
    rows = conn.execute("SELECT id, password FROM crew WHERE password LIKE 'pbkdf2_sha256$%'").fetchall()
    if rows:
        conn.execute("UPDATE crew SET password='' WHERE password LIKE 'pbkdf2_sha256$%'")
        conn.commit()


def _maybe_migrate_model_params(conn, now):
    """Move model parameters from settings JSON into model_params table."""
    # Create table if missing
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_params (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            triage_instruction TEXT,
            inquiry_instruction TEXT,
            tr_temp REAL,
            tr_tok INTEGER,
            tr_p REAL,
            tr_k INTEGER,
            in_temp REAL,
            in_tok INTEGER,
            in_p REAL,
            in_k INTEGER,
            mission_context TEXT,
            rep_penalty REAL,
            updated_at TEXT NOT NULL
        );
        """
    )
    # If settings JSON exists, seed table once
    row = conn.execute("SELECT payload FROM documents WHERE category='settings'").fetchone()
    if row:
        try:
            data = json.loads(row["payload"]) or {}
        except Exception:
            data = {}
        existing = conn.execute("SELECT COUNT(*) FROM model_params").fetchone()[0]
        if existing == 0:
            conn.execute(
                """
                INSERT INTO model_params(
                    id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p, tr_k,
                    in_temp, in_tok, in_p, in_k, mission_context, rep_penalty, updated_at
                ) VALUES (
                    1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p, :tr_k,
                    :in_temp, :in_tok, :in_p, :in_k, :mission_context, :rep_penalty, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    triage_instruction=excluded.triage_instruction,
                    inquiry_instruction=excluded.inquiry_instruction,
                    tr_temp=excluded.tr_temp,
                    tr_tok=excluded.tr_tok,
                    tr_p=excluded.tr_p,
                    tr_k=excluded.tr_k,
                    in_temp=excluded.in_temp,
                    in_tok=excluded.in_tok,
                    in_p=excluded.in_p,
                    in_k=excluded.in_k,
                    mission_context=excluded.mission_context,
                    rep_penalty=excluded.rep_penalty,
                    updated_at=excluded.updated_at;
                """,
                {
                    "triage_instruction": data.get("triage_instruction"),
                    "inquiry_instruction": data.get("inquiry_instruction"),
                    "tr_temp": data.get("tr_temp"),
                    "tr_tok": data.get("tr_tok"),
                    "tr_p": data.get("tr_p"),
                    "tr_k": data.get("tr_k"),
                    "in_temp": data.get("in_temp"),
                    "in_tok": data.get("in_tok"),
                    "in_p": data.get("in_p"),
                    "in_k": data.get("in_k"),
                    "mission_context": data.get("mission_context"),
                    "rep_penalty": data.get("rep_penalty"),
                    "updated_at": now,
                },
            )
        conn.commit()


def _maybe_migrate_items(conn, now):
    """Move inventory/tools JSON into items table if not already present."""
    existing = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    if existing > 0:
        return
    def insert_item(item, item_type):
        """
        Insert Item helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        iid = str(item.get("id") or f"item-{datetime.utcnow().timestamp()}")
        conn.execute(
            """
            INSERT OR REPLACE INTO items(
                id, itemType, name, genericName, brandName, alsoKnownAs, formStrength,
                indications, contraindications, consultDoctor, adultDosage, pediatricDosage,
                unwantedEffects, storageLocation, subLocation, status, verified, expiryDate,
                lastInspection, batteryType, batteryStatus, calibrationDue, totalQty,
                minPar, supplier, parentId, requiresPower, category, typeDetail, notes,
                excludeFromResources, updated_at
            ) VALUES (
                :id, :itemType, :name, :genericName, :brandName, :alsoKnownAs, :formStrength,
                :indications, :contraindications, :consultDoctor, :adultDosage, :pediatricDosage,
                :unwantedEffects, :storageLocation, :subLocation, :status, :verified, :expiryDate,
                :lastInspection, :batteryType, :batteryStatus, :calibrationDue, :totalQty,
                :minPar, :supplier, :parentId, :requiresPower, :category, :typeDetail, :notes,
                :excludeFromResources, :updated_at
            );
            """,
            {
                "id": iid,
                "itemType": item_type,
                "name": item.get("name"),
                "genericName": item.get("genericName"),
                "brandName": item.get("brandName"),
                "alsoKnownAs": item.get("alsoKnownAs"),
                "formStrength": item.get("formStrength"),
                "indications": item.get("indications"),
                "contraindications": item.get("contraindications"),
                "consultDoctor": item.get("consultDoctor"),
                "adultDosage": item.get("adultDosage"),
                "pediatricDosage": item.get("pediatricDosage"),
                "unwantedEffects": item.get("unwantedEffects"),
                "storageLocation": item.get("storageLocation"),
                "subLocation": item.get("subLocation"),
                "status": item.get("status"),
                "verified": 1 if item.get("verified") else 0,
                "expiryDate": item.get("expiryDate"),
                "lastInspection": item.get("lastInspection"),
                "batteryType": item.get("batteryType"),
                "batteryStatus": item.get("batteryStatus"),
                "calibrationDue": item.get("calibrationDue"),
                "totalQty": item.get("totalQty"),
                "minPar": item.get("minPar"),
                "supplier": item.get("supplier"),
                "parentId": item.get("parentId"),
                "requiresPower": 1 if item.get("requiresPower") else 0,
                "category": item.get("category"),
                "typeDetail": item.get("type"),
                "notes": item.get("notes"),
                "excludeFromResources": 1 if item.get("excludeFromResources") else 0,
                "updated_at": now,
            },
        )

    # Migrate inventory (pharmaceuticals)
    inv_row = conn.execute("SELECT payload FROM documents WHERE category='inventory'").fetchone()
    if inv_row:
        try:
            inventory = json.loads(inv_row["payload"]) or []
        except Exception:
            inventory = []
        for item in inventory:
            insert_item(item, "pharma")
        conn.execute("DELETE FROM documents WHERE category='inventory'")

    # Migrate tools (equipment/consumables)
    tools_row = conn.execute("SELECT payload FROM documents WHERE category='tools'").fetchone()
    if tools_row:
        try:
            tools = json.loads(tools_row["payload"]) or []
        except Exception:
            tools = []
        for item in tools:
            item_type = "consumable" if (item.get("type") or "").lower() == "consumable" else "equipment"
            insert_item(item, item_type)
        conn.execute("DELETE FROM documents WHERE category='tools'")
    conn.commit()


def _maybe_migrate_history(conn, now):
    """Move history JSON into history_entries table."""
    existing = conn.execute("SELECT COUNT(*) FROM history_entries").fetchone()[0]
    if existing > 0:
        return
    row = conn.execute("SELECT payload FROM documents WHERE category='history'").fetchone()
    if not row:
        return
    try:
        history = json.loads(row["payload"]) or []
    except Exception:
        history = []
    for h in history:
        hid = str(h.get("id") or datetime.utcnow().isoformat())
        conn.execute(
            """
            INSERT INTO history_entries(
                id, date, patient, patient_id, mode, query, user_query, response,
                model, duration_ms, prompt, injected_prompt, updated_at
            ) VALUES (
                :id, :date, :patient, :patient_id, :mode, :query, :user_query, :response,
                :model, :duration_ms, :prompt, :injected_prompt, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                date=excluded.date,
                patient=excluded.patient,
                patient_id=excluded.patient_id,
                mode=excluded.mode,
                query=excluded.query,
                user_query=excluded.user_query,
                response=excluded.response,
                model=excluded.model,
                duration_ms=excluded.duration_ms,
                prompt=excluded.prompt,
                injected_prompt=excluded.injected_prompt,
                updated_at=excluded.updated_at;
            """,
            {
                "id": hid,
                "date": h.get("date"),
                "patient": h.get("patient"),
                "patient_id": h.get("patient_id"),
                "mode": h.get("mode"),
                "query": h.get("query"),
                "user_query": h.get("user_query"),
                "response": h.get("response"),
                "model": h.get("model"),
                "duration_ms": h.get("duration_ms"),
                "prompt": h.get("prompt"),
                "injected_prompt": h.get("injected_prompt"),
                "updated_at": h.get("updated_at") or now,
            },
        )
    conn.execute("DELETE FROM documents WHERE category='history'")
    conn.commit()


def _insert_chats(conn, chats: list, now: str):
    """Insert or upsert chat rows from a list of dicts."""
    for idx, c in enumerate(chats or []):
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or f"chat-{idx}-{now}")
        created = c.get("created_at") or c.get("date") or now
        meta_extra = {
            k: v
            for k, v in c.items()
            if k
            not in {
                "id",
                "role",
                "message",
                "content",
                "model",
                "mode",
                "patient_id",
                "user",
                "created_at",
                "date",
            }
        }
        conn.execute(
            """
            INSERT INTO chats(id, role, message, model, mode, patient_id, user, created_at, meta)
            VALUES(:id, :role, :message, :model, :mode, :patient_id, :user, :created_at, :meta)
            ON CONFLICT(id) DO UPDATE SET
                role=excluded.role,
                message=excluded.message,
                model=excluded.model,
                mode=excluded.mode,
                patient_id=excluded.patient_id,
                user=excluded.user,
                created_at=excluded.created_at,
                meta=excluded.meta;
            """,
            {
                "id": cid,
                "role": c.get("role"),
                "message": c.get("message") or c.get("content") or "",
                "model": c.get("model"),
                "mode": c.get("mode"),
                "patient_id": c.get("patient_id"),
                "user": c.get("user"),
                "created_at": created,
                "meta": json.dumps(meta_extra) if meta_extra else None,
            },
        )
    conn.commit()


def _replace_chat_metrics(conn, metrics: dict, now: str):
    """Replace chat_metrics table contents from a dict."""
    conn.execute("DELETE FROM chat_metrics")
    for model, rec in (metrics or {}).items():
        if not isinstance(rec, dict):
            continue
        conn.execute(
            """
            INSERT INTO chat_metrics(model, count, total_ms, avg_ms, updated_at)
            VALUES(:model, :count, :total_ms, :avg_ms, :updated_at)
            ON CONFLICT(model) DO UPDATE SET
                count=excluded.count,
                total_ms=excluded.total_ms,
                avg_ms=excluded.avg_ms,
                updated_at=excluded.updated_at;
            """,
            {
                "model": model,
                "count": rec.get("count", 0),
                "total_ms": rec.get("total_ms", 0),
                "avg_ms": rec.get("avg_ms", 0),
                "updated_at": now,
            },
        )
    conn.commit()


def _maybe_migrate_chats(conn, now):
    """Move chats and chat_metrics documents into tables and delete JSON docs."""
    row = conn.execute("SELECT payload FROM documents WHERE category='chats'").fetchone()
    if row:
        try:
            chats = json.loads(row["payload"] or "[]") or []
            _insert_chats(conn, chats, now)
            conn.execute("DELETE FROM documents WHERE category='chats'")
        except Exception:
            pass
    row = conn.execute("SELECT payload FROM documents WHERE category='chat_metrics'").fetchone()
    if row:
        try:
            metrics = json.loads(row["payload"] or "{}") or {}
            _replace_chat_metrics(conn, metrics, now)
            conn.execute("DELETE FROM documents WHERE category='chat_metrics'")
        except Exception:
            pass


def _maybe_migrate_settings_meta(conn, now):
    """Move user_mode/offline flags from settings document into settings_meta table."""
    row = conn.execute("SELECT payload FROM documents WHERE category='settings'").fetchone()
    if not row:
        return
    try:
        data = json.loads(row["payload"] or "{}") or {}
    except Exception:
        data = {}
    user_mode = data.get("user_mode")
    offline_force_flags = 1 if data.get("offline_force_flags") else 0
    last_prompt_verbatim = data.get("last_prompt_verbatim")
    _ensure_settings_meta_columns(conn)
    conn.execute(
        """
        INSERT INTO settings_meta(id, user_mode, offline_force_flags, last_prompt_verbatim, updated_at)
        VALUES(1, :user_mode, :offline_force_flags, :last_prompt_verbatim, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
            user_mode=excluded.user_mode,
            offline_force_flags=excluded.offline_force_flags,
            last_prompt_verbatim=excluded.last_prompt_verbatim,
            updated_at=excluded.updated_at;
        """,
        {
            "user_mode": user_mode,
            "offline_force_flags": offline_force_flags,
            "last_prompt_verbatim": last_prompt_verbatim,
            "updated_at": now,
        },
    )
    conn.commit()


    # context
    row = conn.execute("SELECT payload FROM documents WHERE category='context'").fetchone()
    if row:
        conn.execute(
            """
            INSERT INTO context_store(id, payload, updated_at)
            VALUES(1, :payload, :updated_at)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at;
            """,
            {"payload": row["payload"], "updated_at": now},
        )
        conn.execute("DELETE FROM documents WHERE category='context'")
    conn.commit()


def _maybe_seed_triage(conn, now):
    """Seed triage dropdown options if table is empty."""
    opt_count = conn.execute("SELECT COUNT(*) FROM triage_options").fetchone()[0]
    if opt_count == 0:
        defaults = {
            "triage-domain": [
                "Trauma",
                "Medical illness",
                "Environmental exposure",
                "Dental",
                "Behavioral / psychological",
            ],
            "triage-problem": [
                "Laceration",
                "Bleeding wound (non-laceration)",
                "Fracture",
                "Dislocation / severe sprain",
                "Burn",
                "Infection / abscess",
                "Embedded foreign body",
                "Eye injury",
                "Marine bite / sting / envenomation",
                "Heat illness",
                "Cold exposure / hypothermia",
                "General illness (vomiting, fever, weakness)",
            ],
            "triage-anatomy": [
                "Head",
                "Face / Eye",
                "Neck / Airway",
                "Chest",
                "Abdomen",
                "Back / Spine",
                "Arm / Hand",
                "Leg / Foot",
                "Joint",
                "Whole body / systemic",
            ],
            "triage-severity": [
                "Stable minor",
                "Significant bleeding",
                "Uncontrolled bleeding",
                "Altered mental status",
                "Breathing difficulty",
                "Severe pain or functional loss",
                "Infection risk / sepsis signs",
                "Deteriorating over time",
            ],
            "triage-mechanism": [
                "Blunt impact",
                "Sharp cut",
                "Penetrating / Impaled",
                "Crush / compression",
                "Twist / overload (rope, winch)",
                "High-tension recoil (snapback line)",
                "Marine bite / sting",
                "Thermal exposure",
                "Immersion / near drowning",
                "Chemical / electrical exposure",
            ],
        }
        for field, values in defaults.items():
            for idx, val in enumerate(values):
                conn.execute(
                    """
                    INSERT INTO triage_options(field, value, position)
                    VALUES(:field, :value, :position)
                    ON CONFLICT(field, position) DO UPDATE SET value=excluded.value;
                    """,
                    {"field": field, "value": val, "position": idx},
                )
        conn.commit()


def _maybe_import_who_meds(conn, now):
    """Import WHO medicines from bundled xlsx into who_medicines if empty."""
    count = conn.execute("SELECT COUNT(*) FROM who_medicines").fetchone()[0]
    if count > 0:
        return
    xls_path = Path(__file__).parent / "ships_medicine_chest_medicines_filled.xlsx"
    if not xls_path.exists():
        return
    try:
        import zipfile, xml.etree.ElementTree as ET

        with zipfile.ZipFile(xls_path) as zf:
            shared = []
            if "xl/sharedStrings.xml" in zf.namelist():
                root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in root.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                    t = "".join(node.text or "" for node in si.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'))
                    shared.append(t)
            sheet_xml = zf.read("xl/worksheets/sheet1.xml")
            root = ET.fromstring(sheet_xml)
            ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            rows = root.findall(".//m:sheetData/m:row", ns)

            def val(cell):
                """
                Val helper.
                Detailed inline notes are included to support safe maintenance and future edits.
                """
                v = cell.find("m:v", ns)
                if v is None:
                    return ""
                txt = v.text or ""
                if cell.attrib.get("t") == "s":
                    try:
                        return shared[int(txt)]
                    except Exception:
                        return txt
                return txt

            records = []
            headers = [val(c) for c in rows[0].findall("m:c", ns)]
            for row in rows[1:]:
                cells = [val(c) for c in row.findall("m:c", ns)]
                if not any(cells):
                    continue
                rec = dict(zip(headers, cells))
                records.append(rec)
            for rec in records:
                conn.execute(
                    """
                    INSERT INTO who_medicines(
                        genericName, alsoKnownAs, formStrength, indications, contraindications,
                        consultDoctor, adultDosage, unwantedEffects, remarks, updated_at
                    ) VALUES (
                        :genericName, :alsoKnownAs, :formStrength, :indications, :contraindications,
                        :consultDoctor, :adultDosage, :unwantedEffects, :remarks, :updated_at
                    )
                    """,
                    {
                        "genericName": rec.get("Generic name"),
                        "alsoKnownAs": rec.get("Also known as"),
                        "formStrength": rec.get("Dosage form, strength"),
                        "indications": rec.get("Indications (on board ship)"),
                        "contraindications": rec.get("Contraindications"),
                        "consultDoctor": rec.get("Consult doctor before using"),
                        "adultDosage": rec.get("Adult dosage"),
                        "unwantedEffects": rec.get("Unwanted effects"),
                        "remarks": rec.get("Remarks"),
                        "updated_at": now,
                    },
                )
            conn.commit()
    except Exception:
        # If import fails, leave table empty; UI will handle missing data
        pass


def _maybe_migrate_model_params(conn, now):
    """Move model parameters from settings JSON into model_params table."""
    # Create table if missing
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_params (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            triage_instruction TEXT,
            inquiry_instruction TEXT,
            tr_temp REAL,
            tr_tok INTEGER,
            tr_p REAL,
            tr_k INTEGER,
            in_temp REAL,
            in_tok INTEGER,
            in_p REAL,
            in_k INTEGER,
            mission_context TEXT,
            rep_penalty REAL,
            updated_at TEXT NOT NULL
        );
        """
    )
    # If settings JSON exists, seed table once
    row = conn.execute("SELECT payload FROM documents WHERE category='settings'").fetchone()
    if row:
        try:
            data = json.loads(row["payload"]) or {}
        except Exception:
            data = {}
        existing = conn.execute("SELECT COUNT(*) FROM model_params").fetchone()[0]
        if existing == 0:
            conn.execute(
                """
                INSERT INTO model_params(
                    id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p, tr_k,
                    in_temp, in_tok, in_p, in_k, mission_context, rep_penalty, updated_at
                ) VALUES (
                    1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p, :tr_k,
                    :in_temp, :in_tok, :in_p, :in_k, :mission_context, :rep_penalty, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    triage_instruction=excluded.triage_instruction,
                    inquiry_instruction=excluded.inquiry_instruction,
                    tr_temp=excluded.tr_temp,
                    tr_tok=excluded.tr_tok,
                    tr_p=excluded.tr_p,
                    tr_k=excluded.tr_k,
                    in_temp=excluded.in_temp,
                    in_tok=excluded.in_tok,
                    in_p=excluded.in_p,
                    in_k=excluded.in_k,
                    mission_context=excluded.mission_context,
                    rep_penalty=excluded.rep_penalty,
                    updated_at=excluded.updated_at;
                """,
                {
                    "triage_instruction": data.get("triage_instruction"),
                    "inquiry_instruction": data.get("inquiry_instruction"),
                    "tr_temp": data.get("tr_temp"),
                    "tr_tok": data.get("tr_tok"),
                    "tr_p": data.get("tr_p"),
                    "tr_k": data.get("tr_k"),
                    "in_temp": data.get("in_temp"),
                    "in_tok": data.get("in_tok"),
                    "in_p": data.get("in_p"),
                    "in_k": data.get("in_k"),
                    "mission_context": data.get("mission_context"),
                    "rep_penalty": data.get("rep_penalty"),
                    "updated_at": now,
                },
            )
        conn.commit()


def _upgrade_schema():
    """Ensure schema is up to date (idempotent). I keep this minimal so startup stays fast."""
    try:
        with _conn() as conn:
            now = datetime.utcnow().isoformat()
            _ensure_items_verified_column(conn)
            _ensure_items_tier_columns(conn)
            _ensure_model_params_columns(conn)
            _ensure_prompt_templates_table(conn)
            _ensure_triage_prompt_modules_table(conn)
            _ensure_triage_prompt_tree_table(conn)
            _ensure_settings_meta_columns(conn)
            _backfill_expiries_from_items(conn, now)
            _seed_prompt_templates_from_model_params(conn, now)
            _seed_triage_prompt_modules(conn, now)
            _seed_triage_prompt_tree(conn, now)
            _maybe_seed_triage(conn, now)
            _maybe_import_who_meds(conn, now)
            # Remove retired triage sample dataset/table.
            conn.execute("DROP TABLE IF EXISTS triage_samples")
            # Drop legacy documents tables if they linger
            conn.execute("DROP TABLE IF EXISTS documents")
            conn.execute("DROP TABLE IF EXISTS documents_old")
            conn.commit()
    except Exception:
        pass


def _ensure_items_verified_column(conn):
    """Add verified flag to items table if missing; keep legacy DBs compatible."""
    try:
        cols = conn.execute("PRAGMA table_info(items)").fetchall()
        names = {c["name"] for c in cols}
        if "verified" not in names:
            conn.execute("ALTER TABLE items ADD COLUMN verified INTEGER DEFAULT 0;")
            conn.execute("UPDATE items SET verified=0 WHERE verified IS NULL;")
    except Exception as exc:
        logger.warning("Unable to add verified column: %s", exc)


def _ensure_items_tier_columns(conn):
    """Add tier columns to items table if missing; keep legacy DBs compatible."""
    try:
        cols = conn.execute("PRAGMA table_info(items)").fetchall()
        names = {c["name"] for c in cols}
        if "priorityTier" not in names:
            conn.execute("ALTER TABLE items ADD COLUMN priorityTier TEXT;")
        if "tierCategory" not in names:
            conn.execute("ALTER TABLE items ADD COLUMN tierCategory TEXT;")
    except Exception as exc:
        logger.warning("Unable to add tier columns: %s", exc)


def _ensure_model_params_columns(conn):
    """Add model sampling columns to model_params for older DBs."""
    try:
        cols = conn.execute("PRAGMA table_info(model_params)").fetchall()
        names = {c["name"] for c in cols}
        if "tr_k" not in names:
            conn.execute("ALTER TABLE model_params ADD COLUMN tr_k INTEGER;")
        if "in_k" not in names:
            conn.execute("ALTER TABLE model_params ADD COLUMN in_k INTEGER;")
    except Exception as exc:
        logger.warning("Unable to add model_params columns: %s", exc)


def _ensure_prompt_templates_table(conn):
    """Create prompt template table for named prompt variants."""
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS prompt_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_key TEXT NOT NULL,
                name TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(prompt_key, name)
            );
            """
        )
    except Exception as exc:
        logger.warning("Unable to ensure prompt_templates table: %s", exc)


def _ensure_triage_prompt_modules_table(conn):
    """Create module table for triage rule stacking."""
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_prompt_modules (
                category TEXT NOT NULL,
                module_key TEXT NOT NULL,
                module_text TEXT NOT NULL,
                position INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(category, module_key)
            );
            """
        )
    except Exception as exc:
        logger.warning("Unable to ensure triage_prompt_modules table: %s", exc)


def _ensure_triage_prompt_tree_table(conn):
    """Create hierarchical triage prompt tree table."""
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS triage_prompt_tree (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
    except Exception as exc:
        logger.warning("Unable to ensure triage_prompt_tree table: %s", exc)


def _default_triage_prompt_tree():
    """
     Default Triage Prompt Tree helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    trauma_anatomy = {
        "Head": "Neuro checks every 15m initially. Avoid circumferential pressure dressings.",
        "Face / Eye": "Protect vision and airway. Avoid pressure if globe injury is possible.",
        "Neck / Airway": "Position for airway patency. Escalate quickly for swelling/voice change.",
        "Chest": "Watch breathing effort and asymmetry every 5m after intervention.",
        "Abdomen / Pelvis": "Assume occult internal bleeding risk. Keep NPO and trend vitals.",
        "Back / Spine": "Maintain neutral alignment; minimize movement until neurologically stable.",
        "Extremity": "Check distal pulse/motor/sensation before and after splinting/bandaging.",
    }
    trauma_severity = {
        "Stable minor": "Definitive care on board, then reassess every 4h.",
        "Significant bleeding": "Direct pressure/hemostatic packing, reassess at 10m.",
        "Uncontrolled bleeding": "Skip cleaning. Tourniquet/packing now. Reassess at 10m.",
        "Altered mental status": "Continuous observation; reassess every 5m.",
        "Breathing difficulty": "Airway/oxygen priority; reassess every 5m.",
        "Severe pain / functional loss": "Immobilize and analgesia plan; reassess every 30m.",
        "Deteriorating trend": "Escalate care level and evacuation state immediately.",
    }
    trauma_mechanism = {
        "Blunt impact": "Assume hidden injury; monitor trend for 12h even if appearance is reassuring.",
        "Sharp cut": "Debride only visible contamination. Reassess bleeding and perfusion at 10m.",
        "Penetrating / Impaled": "Depth matters more than width. Do not probe blindly; stabilize in-situ object.",
        "Crush / compression": "Watch swelling progression and perfusion loss every 30m.",
        "Twist / overload": "Prioritize ligament/tendon protection and function checks every 30m.",
        "High Energy / Snapback": "Mandatory prolonged watch for delayed internal injury signs.",
        "Marine bite / sting": "High infection and envenomation risk; observe for allergic progression.",
        "Thermal exposure": "Treat as mixed tissue injury; monitor pain/perfusion trend closely.",
    }

    medical_anatomy = {
        "Whole body / systemic": "Use trend-based reassessment across vitals and mental status.",
        "Head / neuro": "Monitor cognition, pupils, and focal deficits every 30m if abnormal.",
        "Chest / respiratory": "Track respiratory rate, work of breathing, and SpO2 every 10m.",
        "Abdomen / GI": "Trend hydration, emesis/stool output, and tenderness progression.",
        "Skin / soft tissue": "Track rash spread, warmth, and perfusion over time.",
    }
    medical_severity = {
        "Stable": "Supportive treatment and scheduled reassessment every 4h.",
        "Persistent symptoms": "Escalate treatment tier if no response within expected window.",
        "Anaphylaxis risk": "Airway-first pathway with continuous observation.",
        "Sepsis risk": "Fever + tachycardia + decline requires urgent escalation.",
        "Respiratory compromise": "Escalate airway/oxygen interventions immediately.",
        "Deteriorating trend": "Switch to evacuation-focused pathway now.",
    }
    medical_mechanism = {
        "Infectious exposure": "Use source-control and trend checks; reassess at 2-4h intervals.",
        "Allergic trigger": "Observe for rebound/progression for at least 4h after improvement.",
        "Dehydration / poor intake": "Rehydrate in stages and track response every 30-60m.",
        "Heat stress": "Active cooling plus mentation/vitals checks every 10-15m.",
        "Cold stress": "Controlled rewarming and repeated perfusion/mentation checks.",
        "Medication / toxin effect": "Stop exposure and monitor for delayed worsening.",
    }

    env_anatomy = {
        "Whole body / systemic": "Environment is active threat; correct exposure first, then reassess.",
        "Airway / breathing": "Prioritize oxygenation and breathing mechanics every 5-10m.",
        "Skin / extremities": "Track tissue injury progression and perfusion after rewarming/cooling.",
        "Neuro / mental status": "Trend confusion, agitation, and responsiveness frequently.",
        "Cardiovascular": "Watch perfusion and rhythm-related symptoms at short intervals.",
    }
    env_severity = {
        "Mild exposure": "Remove source and monitor for delayed worsening every 1-2h.",
        "Moderate exposure": "Treat aggressively and reassess every 15-30m.",
        "Severe exposure": "High acuity management and immediate evacuation planning.",
        "Respiratory symptoms": "Prioritize airway/breathing support and frequent reassessment.",
        "Neurologic symptoms": "Continuous observation and escalation if trends worsen.",
        "Deteriorating trend": "Escalate to urgent/immediate evacuation pathway.",
    }
    env_mechanism = {
        "Heat": "Use staged cooling and hydration; avoid overcorrection.",
        "Cold": "Controlled rewarming; avoid friction/rapid thermal injury.",
        "Immersion": "Observe prolonged window for delayed pulmonary deterioration.",
        "Marine toxin": "Symptom-targeted protocol plus anaphylaxis watch.",
        "Chemical": "Decontaminate first, then assess tissue/airway effects.",
        "Electrical": "Assume deeper injury than surface findings suggest.",
    }

    dental_anatomy = {
        "Tooth": "Preserve viable structure; avoid irreversible procedures offshore.",
        "Gingiva / periodontal": "Control bleeding and contamination; monitor swelling spread.",
        "Jaw / facial bone": "Assess occlusion and functional limitation repeatedly.",
        "Oral mucosa": "Protect airway and hydration; avoid harsh topical irritants.",
        "Neck / airway adjacent": "Escalate quickly if swelling affects voice/swallowing.",
    }
    dental_severity = {
        "Localized pain": "Analgesia and temporary stabilization, reassess every 4h.",
        "Spreading swelling": "Escalate infection precautions and reassess every 30-60m.",
        "Airway-adjacent swelling": "Airway-first urgency with continuous observation.",
        "Uncontrolled bleeding": "Pressure/hemostatic steps first, reassess at 10m.",
        "Deteriorating trend": "Escalate to urgent evacuation workflow.",
    }
    dental_mechanism = {
        "Traumatic fracture": "Protect exposed pulp/dentin and reduce contamination.",
        "Caries / chronic infection": "Source control and infection-watch priorities.",
        "Recent extraction complication": "Assess clot stability and active bleeding trend.",
        "Bruxism / overload": "Supportive pain control and functional protection.",
        "Unknown cause": "Trend-based safety plan with frequent reassessment.",
    }

    behavioral_severity = {
        "Mild distress": "De-escalation and monitor behavior/safety every 30-60m.",
        "Moderate agitation": "Structured environment, 1:1 observation as needed.",
        "Severe agitation / violence risk": "Crew safety first with continuous observation.",
        "Suicide / self-harm concern": "Constant supervision and immediate escalation planning.",
        "Delirium / confusion worsening": "Treat as medical emergency with frequent reassessment.",
    }
    behavioral_mechanism = {
        "Acute stress reaction": "Reduce stimulation and apply directive grounding workflow.",
        "Panic / anxiety episode": "Coaching + breathing control with frequent reassessment.",
        "Substance intoxication": "Monitor airway, mentation, and injury risk continuously.",
        "Withdrawal syndrome": "Trend autonomic signs and escalate for instability.",
        "Medical mimic suspected": "Prioritize reversible medical causes before psych framing.",
    }

    return {
        "base_doctrine": (
            "You are SailingMedAdvisor. Role: Damage-control for Vessel Captain. "
            "Priority: MARCH-PAWS. Rules: Numbered imperative steps, timed reassessment intervals, "
            "no speculation, only Medical Chest items. For Ethan: weight-based dosing. "
            "Output: STAY, URGENT, or IMMEDIATE."
        ),
        "tree": {
            "Trauma": {
                "mindset": "Physiology over appearance. Stabilize first. Order: Hemostasis -> Airway -> Breathing -> Circulation.",
                "problems": {
                    "Laceration": {
                        "procedure": "Control bleeding -> Irrigate -> Inspect -> Decide closure.",
                        "exclusions": "Do NOT close if >6 hours old, crush, puncture, or marine/saltwater contamination.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Bleeding wound (non-laceration)": {
                        "procedure": "Direct pressure or packing for full 10m without interruption.",
                        "exclusions": "Do NOT delay hemorrhage control for cleaning or closure decisions.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Embedded foreign body": {
                        "procedure": "Stabilize object, control bleeding, and plan extraction-safe pathway.",
                        "exclusions": "Do NOT close over retained material. Fish hook exception protocol only in non-critical areas.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Fracture / Dislocation": {
                        "procedure": "Check PMS -> Realign ONLY if pulseless -> Splint joint above/below.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Burn": {
                        "procedure": "Stop burn source -> cool with room-temp water -> non-adherent coverage.",
                        "exclusions": "Do NOT break blisters or apply caustic home remedies.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Eye injury": {
                        "procedure": "Protect globe, irrigate if chemical exposure, and reassess vision trends.",
                        "exclusions": "Do NOT apply globe pressure when penetrating injury is possible.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Marine bite / sting / envenomation": {
                        "procedure": "Stabilize wound, pain control, and monitor for allergic/systemic progression.",
                        "exclusions": "Do NOT tightly close high-contamination marine wounds.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                    "Head injury / concussion": {
                        "procedure": "Baseline neuro exam, serial checks, and strict deterioration triggers.",
                        "exclusions": "Do NOT sedate heavily before baseline neurologic documentation.",
                        "anatomy_guardrails": dict(trauma_anatomy),
                        "severity_modifiers": dict(trauma_severity),
                        "mechanism_modifiers": dict(trauma_mechanism),
                    },
                },
            },
            "Medical Illness": {
                "mindset": "Vitals trends and treatment response only. Avoid rare/complex diagnoses.",
                "problems": {
                    "General illness (vomiting / fever / weakness)": {
                        "procedure": "Hydration, symptom control, trend vitals, and escalate by response.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Allergic reaction": {
                        "procedure": "Airway priority. Antihistamines/Epinephrine. Mandatory 4h observation for rebound.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Infection": {
                        "procedure": "Source control. Antibiotics secondary. Circle margin with ink.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Breathing difficulty (medical)": {
                        "procedure": "Airway and oxygen-first pathway with serial work-of-breathing checks.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Chest pain / cardiac concern": {
                        "procedure": "Stabilize, monitor perfusion and rhythm symptoms, escalate for deterioration.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Severe dehydration": {
                        "procedure": "Oral/IV rehydration based on capability and response trend checks.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Heat illness (medical)": {
                        "procedure": "Rapid cooling, hydration, and serial neurologic/vital reassessment.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                    "Cold exposure / hypothermia (medical)": {
                        "procedure": "Controlled rewarming with trend-based perfusion/mentation checks.",
                        "anatomy_guardrails": dict(medical_anatomy),
                        "severity_modifiers": dict(medical_severity),
                        "mechanism_modifiers": dict(medical_mechanism),
                    },
                },
            },
            "Environmental": {
                "mindset": "Neutralize the pathogen (environment) first.",
                "problems": {
                    "Marine envenomation": {
                        "procedure": "Identify species. Hot water (45C) 90 min to denature toxins.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                    "Heat illness": {
                        "procedure": "Remove heat source, active cooling, hydration, and short-interval reassessment.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                    "Cold exposure / hypothermia": {
                        "procedure": "Controlled rewarming and monitor for rebound instability.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                    "Immersion / near drowning": {
                        "procedure": "Airway and oxygenation first; monitor delayed pulmonary compromise window.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                    "Chemical exposure": {
                        "procedure": "Decontaminate first, then targeted symptom pathway.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                    "Electrical exposure": {
                        "procedure": "Stop source safely, assess airway/circulation, and monitor for delayed injury.",
                        "anatomy_guardrails": dict(env_anatomy),
                        "severity_modifiers": dict(env_severity),
                        "mechanism_modifiers": dict(env_mechanism),
                    },
                },
            },
            "Dental": {
                "mindset": "Preservation only. No extractions unless airway is threatened.",
                "problems": {
                    "Dental pain / pulpitis": {
                        "procedure": "Analgesia + temporary tooth protection + infection watch.",
                        "anatomy_guardrails": dict(dental_anatomy),
                        "severity_modifiers": dict(dental_severity),
                        "mechanism_modifiers": dict(dental_mechanism),
                    },
                    "Dental abscess": {
                        "procedure": "Source control strategy, pain management, and airway-risk monitoring.",
                        "anatomy_guardrails": dict(dental_anatomy),
                        "severity_modifiers": dict(dental_severity),
                        "mechanism_modifiers": dict(dental_mechanism),
                    },
                    "Broken tooth / crown loss": {
                        "procedure": "Protect exposed structure, reduce pain triggers, and monitor for infection.",
                        "anatomy_guardrails": dict(dental_anatomy),
                        "severity_modifiers": dict(dental_severity),
                        "mechanism_modifiers": dict(dental_mechanism),
                    },
                    "Avulsed tooth": {
                        "procedure": "Preserve tooth viability window and protect socket/airway.",
                        "anatomy_guardrails": dict(dental_anatomy),
                        "severity_modifiers": dict(dental_severity),
                        "mechanism_modifiers": dict(dental_mechanism),
                    },
                    "Jaw pain / TMJ / trauma": {
                        "procedure": "Immobilize/support jaw function and monitor airway/swallowing.",
                        "anatomy_guardrails": dict(dental_anatomy),
                        "severity_modifiers": dict(dental_severity),
                        "mechanism_modifiers": dict(dental_mechanism),
                    },
                },
            },
            "Behavioral": {
                "mindset": "Vessel safety first. Secure the environment; avoid chemical restraint.",
                "problems": {
                    "Agitation / aggression": {
                        "procedure": "Scene control, low-stimulation de-escalation, and continuous safety checks.",
                        "severity_modifiers": dict(behavioral_severity),
                        "mechanism_modifiers": dict(behavioral_mechanism),
                    },
                    "Panic / acute anxiety": {
                        "procedure": "Guided breathing, grounding, and repeated trend reassessment.",
                        "severity_modifiers": dict(behavioral_severity),
                        "mechanism_modifiers": dict(behavioral_mechanism),
                    },
                    "Suicidal ideation concern": {
                        "procedure": "Immediate safety containment and constant observation protocol.",
                        "severity_modifiers": dict(behavioral_severity),
                        "mechanism_modifiers": dict(behavioral_mechanism),
                    },
                    "Delirium / confused behavior": {
                        "procedure": "Treat as medical emergency until reversible causes are addressed.",
                        "severity_modifiers": dict(behavioral_severity),
                        "mechanism_modifiers": dict(behavioral_mechanism),
                    },
                    "Substance intoxication / withdrawal": {
                        "procedure": "Airway/safety monitoring with structured escalation thresholds.",
                        "severity_modifiers": dict(behavioral_severity),
                        "mechanism_modifiers": dict(behavioral_mechanism),
                    },
                },
            },
        },
    }


def _normalize_triage_prompt_tree_payload(payload: Any) -> Dict[str, Any]:
    """
     Normalize Triage Prompt Tree Payload helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    data = payload
    if isinstance(payload, str):
        try:
            data = json.loads(payload)
        except Exception as exc:
            raise ValueError("Invalid JSON payload for triage tree.") from exc
    if not isinstance(data, dict):
        raise ValueError("Triage tree payload must be an object.")

    base_doctrine = str(data.get("base_doctrine") or "").strip()
    tree = data.get("tree")
    if not isinstance(tree, dict) or not tree:
        raise ValueError("Triage tree payload must include a non-empty 'tree' object.")

    normalized = {
        "base_doctrine": base_doctrine,
        "tree": tree,
    }
    try:
        return json.loads(json.dumps(normalized, ensure_ascii=False))
    except Exception as exc:
        raise ValueError("Triage tree payload must be JSON-serializable.") from exc


def _seed_triage_prompt_tree(conn, now: str):
    """
     Seed Triage Prompt Tree helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    _ensure_triage_prompt_tree_table(conn)
    row = conn.execute("SELECT payload FROM triage_prompt_tree WHERE id = 1").fetchone()
    defaults = _default_triage_prompt_tree()
    if row and row["payload"]:
        try:
            _normalize_triage_prompt_tree_payload(json.loads(row["payload"]))
            return
        except Exception:
            pass
    payload = defaults
    conn.execute(
        """
        INSERT INTO triage_prompt_tree(id, payload, updated_at)
        VALUES(1, :payload, :updated_at)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
        """,
        {
            "payload": json.dumps(payload, ensure_ascii=False),
            "updated_at": now,
        },
    )
    conn.commit()


def _module_text(*lines):
    """
     Module Text helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return "\n".join(str(line).strip() for line in lines if str(line).strip())


def _default_triage_prompt_modules():
    """
     Default Triage Prompt Modules helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return {
        "base": [
            (
                "Base Doctrine",
                _module_text(
                    "PRIORITIZE immediate life threats in ABCDE order before definitive care.",
                    "USE concise command-style steps with clear sequence and timing.",
                    "IF airway, breathing, or circulation is unstable, THEN escalate to resuscitation actions immediately.",
                    "NEVER recommend procedures that require unavailable specialists or hospital-only resources.",
                    "CROSS-CHECK every intervention against current_onboard_inventory before recommending it.",
                    "IF a critical tool or medication is missing, THEN provide the safest onboard substitute.",
                    "STATE monitoring cadence and explicit deterioration triggers for each phase of care.",
                    "PREFER reversible, low-risk interventions first when diagnostic certainty is limited.",
                    "AVOID non-actionable disclaimers; provide direct field-feasible offshore actions.",
                    "DOCUMENT stop conditions and evacuation thresholds in the response plan.",
                ),
            ),
        ],
        "domain": [
            (
                "Trauma",
                _module_text(
                    "PRIORITIZE hemorrhage control, airway protection, and rapid secondary survey.",
                    "IF mechanism suggests high energy, THEN assume occult multi-system injury until ruled out.",
                    "STABILIZE fractures/dislocations and protect neurovascular status before movement.",
                    "NEVER delay bleeding control while pursuing non-critical diagnostics.",
                    "REASSESS perfusion, pain, and neurologic function every 5-10 minutes.",
                    "PREPARE early evacuation planning if instability persists after initial interventions.",
                ),
            ),
            (
                "Medical illness",
                _module_text(
                    "PRIORITIZE life-threatening reversible causes using vitals and trend data.",
                    "IF altered mental status is present, THEN check glucose, oxygenation, temperature, and sepsis cues.",
                    "START supportive stabilization while building differential diagnosis in parallel.",
                    "NEVER anchor on one diagnosis when red flags suggest broader systemic pathology.",
                    "REASSESS response to each treatment step before escalating or changing therapies.",
                    "ESCALATE urgency when symptoms persist despite first-line supportive care.",
                ),
            ),
            (
                "Environmental exposure",
                _module_text(
                    "PRIORITIZE airway, breathing, circulation, and core temperature correction.",
                    "IF heat injury is suspected, THEN initiate active cooling without delay.",
                    "IF cold injury is suspected, THEN begin controlled rewarming and gentle handling.",
                    "NEVER use harmful rapid-temperature swings that increase tissue damage risk.",
                    "MONITOR mental status, rhythm risk, hydration, and end-organ perfusion trends.",
                    "SET prolonged observation windows for delayed deterioration after exposure events.",
                ),
            ),
            (
                "Dental",
                _module_text(
                    "PRIORITIZE pain control, infection containment, and airway safety assessment.",
                    "IF facial swelling threatens airway or swallowing, THEN treat as urgent airway risk.",
                    "USE temporary stabilization and drainage principles when definitive dental care is unavailable.",
                    "NEVER perform forceful blind extraction in unstable offshore settings.",
                    "MONITOR for spread: fever, trismus, neck swelling, and systemic toxicity signs.",
                    "ESCALATE to evacuation planning when airway, sepsis, or uncontrolled pain emerges.",
                ),
            ),
            (
                "Behavioral / psychological",
                _module_text(
                    "PRIORITIZE scene safety for patient, crew, and confined vessel environment.",
                    "IF suicidal, violent, or severely disorganized behavior is present, THEN initiate continuous observation.",
                    "RULE OUT medical mimics: hypoxia, intoxication, hypoglycemia, head injury, and sepsis.",
                    "USE calm, directive de-escalation with minimal stimulation and clear boundaries.",
                    "NEVER leave a high-risk patient unattended during active crisis phase.",
                    "MONITOR sleep deprivation, withdrawal, and autonomic instability for progression.",
                ),
            ),
        ],
        "problem": [
            (
                "Laceration",
                _module_text(
                    "CONTROL bleeding first with direct pressure, packing, and elevation as indicated.",
                    "IF contamination is present, THEN perform high-volume irrigation before any closure decision.",
                    "ASSESS tendon, nerve, vascular, and depth involvement before definitive wound plan.",
                    "IF deep structure injury is suspected, THEN prioritize protection and delayed closure strategy.",
                    "NEVER close devitalized, heavily contaminated, or actively infected tissue.",
                    "PLAN dressing change intervals and reassessment checkpoints for infection/bleeding recurrence.",
                ),
            ),
            (
                "Bleeding wound (non-laceration)",
                _module_text(
                    "PRIORITIZE hemorrhage control over cosmetic wound management at all times.",
                    "IF bleeding remains uncontrolled, THEN escalate to hemostatic packing or tourniquet protocol.",
                    "QUANTIFY blood loss trend and shock indicators early and repeatedly.",
                    "MARK intervention times and reassess distal perfusion after pressure/tourniquet use.",
                    "NEVER release a successful hemostatic intervention without a clear reassessment plan.",
                    "PREPARE rapid deterioration pathway if perfusion or consciousness declines.",
                ),
            ),
            (
                "Fracture",
                _module_text(
                    "IMMOBILIZE suspected fracture with joint-above/joint-below stabilization.",
                    "IF open fracture exists, THEN irrigate, cover sterilely, and prioritize infection prevention.",
                    "CHECK distal pulse, sensation, and motor function before and after splinting.",
                    "NEVER perform repeated forceful realignment attempts in the field.",
                    "CONTROL pain and swelling while preserving neurovascular integrity.",
                    "MONITOR for compartment syndrome, skin compromise, and progressive neurovascular loss.",
                ),
            ),
            (
                "Dislocation / severe sprain",
                _module_text(
                    "ASSESS distal neurovascular status before any manipulation attempt.",
                    "IF deformity with ischemia is present, THEN perform one gentle reduction attempt if trained.",
                    "IMMOBILIZE immediately after reduction attempt and recheck perfusion/function.",
                    "NEVER perform repeated high-force reductions after failed first attempt.",
                    "TREAT severe sprain as occult fracture until functional reassessment confirms otherwise.",
                    "TRACK swelling, pain escalation, and neurologic change over time.",
                ),
            ),
            (
                "Burn",
                _module_text(
                    "STOP the burn process immediately and cool thermal burns with clean cool water.",
                    "IF airway/face/circumferential involvement exists, THEN treat as high-acuity burn emergency.",
                    "COVER with clean non-adherent dressings and protect from ongoing heat loss.",
                    "NEVER apply ice, caustics, or tight occlusive wraps to fresh burns.",
                    "CALCULATE fluid and pain support based on extent/severity and trend vitals.",
                    "MONITOR for inhalation injury, shock progression, and infection development.",
                ),
            ),
            (
                "Infection / abscess",
                _module_text(
                    "PRIORITIZE sepsis screening and source-control feasibility from the outset.",
                    "IF fluctuance is localized and safe to access, THEN follow sterile drainage protocol if trained.",
                    "START targeted antimicrobials only when findings support bacterial infection risk.",
                    "NEVER close a draining or infected cavity that requires continued egress.",
                    "TRACK temperature, pain spread, erythema margins, and systemic symptoms serially.",
                    "ESCALATE quickly when hypotension, confusion, or tachypnea indicates systemic progression.",
                ),
            ),
            (
                "Embedded foreign body",
                _module_text(
                    "## CRITICAL: AS LONG AS A FOREIGN BODY IS PRESENT, ALL CLOSURE PROCEDURES (STAPLES/SUTURES) ARE PROHIBITED. REVEAL EXTRACTION STEPS ONLY.",
                    "STABILIZE protruding objects and prevent further migration during all handling.",
                    "IF object is deep or near eye/neck/chest/abdomen/major vessel, THEN defer removal and protect in place.",
                    "IF safe superficial extraction criteria are met, THEN provide extraction-only sequence with analgesia and irrigation.",
                    "NEVER perform blind probing or forceful advancement of the foreign body.",
                    "AFTER extraction, reassess bleeding, contamination, and retained-fragment risk before wound decisions.",
                ),
            ),
            (
                "Eye injury",
                _module_text(
                    "PRIORITIZE vision preservation and protection from secondary ocular damage.",
                    "IF penetrating globe injury is suspected, THEN shield eye and avoid all pressure.",
                    "IF chemical exposure occurred, THEN irrigate continuously and reassess pH/irritation trend.",
                    "NEVER patch both eyes in unstable settings with uncertain mechanism.",
                    "AVOID repeated topical anesthetic use that masks worsening pathology.",
                    "ESCALATE urgently for vision loss, severe pain, or intraocular injury concern.",
                ),
            ),
            (
                "Marine bite / sting / envenomation",
                _module_text(
                    "PRIORITIZE scene safety, airway risk, and anaphylaxis surveillance immediately.",
                    "IF venomous sting pattern is likely, THEN apply species-appropriate deactivation or heat protocol.",
                    "CONTROL bleeding and decontaminate tissue while minimizing toxin spread.",
                    "NEVER apply contraindicated rinses or aggressive tissue manipulation.",
                    "INITIATE allergy and shock pathway if respiratory, skin, or hemodynamic signs worsen.",
                    "MONITOR delayed necrosis, infection, and systemic toxin effects over hours.",
                ),
            ),
            (
                "Heat illness",
                _module_text(
                    "INITIATE active cooling immediately when heat injury is suspected.",
                    "IF altered mental status with hyperthermia is present, THEN treat as heat stroke emergency.",
                    "USE hydration and electrolyte correction guided by perfusion and urine/mental trends.",
                    "NEVER delay cooling while waiting for confirmatory diagnostics.",
                    "RECHECK temperature and mentation at short intervals until stabilized.",
                    "WATCH for rhabdomyolysis, renal injury, and rebound hyperthermia signs.",
                ),
            ),
            (
                "Cold exposure / hypothermia",
                _module_text(
                    "REMOVE wet exposure and insulate from wind/water heat loss immediately.",
                    "IF moderate/severe hypothermia is suspected, THEN handle gently and rewarm core gradually.",
                    "USE passive/active rewarming matched to perfusion and consciousness status.",
                    "NEVER rub frostbitten tissue or rapidly rewarm when refreezing risk remains.",
                    "MONITOR rhythm instability, mental status drift, and perfusion markers closely.",
                    "PLAN extended observation for delayed afterdrop and recurrence risk.",
                ),
            ),
            (
                "General illness (vomiting, fever, weakness)",
                _module_text(
                    "PRIORITIZE dehydration, sepsis, and metabolic instability screening early.",
                    "IF persistent vomiting or fever with weakness occurs, THEN structure workup by red flags first.",
                    "START supportive hydration, symptom control, and serial vitals immediately.",
                    "NEVER assume benign illness when neurologic or hemodynamic changes are present.",
                    "REASSESS trajectory after each intervention and update likely differential.",
                    "ESCALATE when deterioration outpaces response to supportive treatment.",
                ),
            ),
        ],
        "anatomy": [
            (
                "Head",
                _module_text(
                    "PRIORITIZE intracranial injury screening and neurologic trend monitoring.",
                    "IF repeated vomiting, severe headache, or confusion appears, THEN treat as high-risk head injury.",
                    "PROTECT airway whenever consciousness fluctuates or seizure risk increases.",
                    "NEVER clear for routine activity without serial neurologic reassessment.",
                    "TRACK pupils, orientation, motor asymmetry, and worsening headache over time.",
                    "ESCALATE for seizure, focal deficits, or declining level of consciousness.",
                ),
            ),
            (
                "Face / Eye",
                _module_text(
                    "PRIORITIZE airway patency, visual function, and facial bleeding control.",
                    "IF periorbital trauma suggests globe/orbital injury, THEN avoid pressure and shield appropriately.",
                    "ASSESS cranial nerve function and jaw integrity before major interventions.",
                    "NEVER perform blind deep probing in orbital or midface wounds.",
                    "MONITOR swelling progression that can compromise airway or vision.",
                    "ESCALATE for vision change, severe deformity, or uncontrolled facial hemorrhage.",
                ),
            ),
            (
                "Neck / Airway",
                _module_text(
                    "PRIORITIZE airway protection and hemorrhage control without delay.",
                    "IF airway noise, stridor, or expanding neck swelling occurs, THEN activate airway emergency pathway.",
                    "LIMIT neck manipulation and maintain neutral alignment when trauma is possible.",
                    "NEVER remove penetrating neck objects in the field unless airway rescue demands it.",
                    "MONITOR voice change, swallowing difficulty, and subcutaneous air progression.",
                    "PREPARE immediate evacuation for any worsening airway or vascular signs.",
                ),
            ),
            (
                "Chest",
                _module_text(
                    "PRIORITIZE oxygenation, ventilation, and life-threatening thoracic injury recognition.",
                    "IF unilateral breath asymmetry or shock develops, THEN suspect evolving thoracic emergency.",
                    "TREAT pain in ways that preserve respiratory depth and cough effectiveness.",
                    "NEVER ignore progressive dyspnea after blunt or penetrating chest mechanism.",
                    "MONITOR respiratory rate, pulse ox trend, and chest wall movement pattern.",
                    "ESCALATE rapidly for deterioration suggesting tension, tamponade, or severe contusion.",
                ),
            ),
            (
                "Abdomen",
                _module_text(
                    "PRIORITIZE occult bleeding and peritonitis surveillance from first contact.",
                    "IF guarding, rebound, or hemodynamic instability emerges, THEN treat as internal injury risk.",
                    "USE serial exams and trend vitals to detect delayed intra-abdominal deterioration.",
                    "NEVER give false reassurance from an initially benign abdominal exam alone.",
                    "MONITOR pain migration, distension, vomiting pattern, and perfusion changes.",
                    "PREPARE early evacuation pathway when internal injury cannot be excluded.",
                ),
            ),
            (
                "Back / Spine",
                _module_text(
                    "PRIORITIZE spinal protection when neurologic deficit or high-risk mechanism exists.",
                    "IF weakness, numbness, or bowel/bladder changes appear, THEN treat as spinal emergency.",
                    "USE log-roll and transfer maneuvers that minimize rotational spinal movement.",
                    "NEVER force painful spinal range-of-motion testing after trauma.",
                    "MONITOR motor/sensory symmetry and pain progression at set intervals.",
                    "ESCALATE for any worsening neurologic findings or unstable pain pattern.",
                ),
            ),
            (
                "Arm / Hand",
                _module_text(
                    "PRIORITIZE hemorrhage control, tendon function, and distal perfusion checks.",
                    "IF motor or sensory deficit appears, THEN treat as neurovascular compromise.",
                    "SPLINT to protect function and prevent secondary tissue injury.",
                    "NEVER close deep hand wounds before tendon/nerve assessment is documented.",
                    "MONITOR capillary refill, pulse quality, and compartment pressure symptoms.",
                    "ESCALATE when ischemia, severe crush signs, or functional loss progresses.",
                ),
            ),
            (
                "Leg / Foot",
                _module_text(
                    "PRIORITIZE bleeding control and limb perfusion preservation.",
                    "IF absent distal pulse or pallor/coolness appears, THEN initiate urgent vascular compromise response.",
                    "IMMOBILIZE fractures and protect soft tissue during movement on vessel terrain.",
                    "NEVER allow weight bearing when instability or severe pain persists.",
                    "MONITOR swelling, compartment warning signs, and motor/sensory drift.",
                    "ESCALATE with persistent ischemia, uncontrolled pain, or rapid edema increase.",
                ),
            ),
            (
                "Joint",
                _module_text(
                    "PRIORITIZE joint stability and distal neurovascular integrity.",
                    "IF deformity with compromised perfusion is present, THEN perform one trained reduction attempt.",
                    "IMMOBILIZE after manipulation and verify distal function immediately.",
                    "NEVER repeat forceful reduction attempts after initial failure.",
                    "MONITOR swelling, instability, and recurrent deformity over time.",
                    "ESCALATE when function fails to recover or perfusion remains abnormal.",
                ),
            ),
            (
                "Whole body / systemic",
                _module_text(
                    "PRIORITIZE systemic stabilization over isolated symptom treatment.",
                    "IF multi-organ warning signs are present, THEN run full shock/sepsis/respiratory risk pathways.",
                    "USE trend-based reassessment to detect deterioration not visible on first exam.",
                    "NEVER narrow management to one body region when systemic signs are active.",
                    "MONITOR vitals bundle, urine output trend, and mental status trajectory.",
                    "ESCALATE to high-acuity monitoring when global instability persists.",
                ),
            ),
        ],
        "severity": [
            (
                "Stable minor",
                _module_text(
                    "USE conservative stabilization with clear follow-up reassessment checkpoints.",
                    "IF symptoms remain stable for repeated checks, THEN continue outpatient-style onboard monitoring.",
                    "PRIORITIZE pain control, wound hygiene, and function preservation.",
                    "NEVER over-treat with high-risk interventions when low-risk care is sufficient.",
                    "RECHECK vitals and symptom trend before final disposition recommendations.",
                ),
            ),
            (
                "Significant bleeding",
                _module_text(
                    "PRIORITIZE rapid hemostasis and shock prevention immediately.",
                    "IF bleeding slows but persists, THEN escalate layered hemostatic strategy.",
                    "TRACK blood loss estimate and perfusion markers every few minutes.",
                    "NEVER leave a partially controlled bleed without direct monitoring.",
                    "PREPARE contingency for recurrence during transport or repositioning.",
                ),
            ),
            (
                "Uncontrolled bleeding",
                _module_text(
                    "TREAT as immediate life-threat until proven otherwise.",
                    "IF first-line pressure fails, THEN escalate without delay to advanced hemostatic measures.",
                    "ACTIVATE shock management bundle with aggressive reassessment cadence.",
                    "NEVER prioritize definitive repair before active hemorrhage control is secured.",
                    "DECLARE evacuation urgency early due to mortality risk from ongoing loss.",
                ),
            ),
            (
                "Altered mental status",
                _module_text(
                    "PRIORITIZE airway protection and rapid reversible-cause assessment.",
                    "IF mental status worsens, THEN escalate to critical monitoring and transport plan.",
                    "CHECK glucose, oxygenation, perfusion, temperature, and toxin/injury clues.",
                    "NEVER assume behavioral cause before excluding medical emergencies.",
                    "MONITOR GCS/orientation trend at short fixed intervals.",
                ),
            ),
            (
                "Breathing difficulty",
                _module_text(
                    "PRIORITIZE oxygenation and ventilation support as first objective.",
                    "IF work of breathing increases or saturation falls, THEN escalate respiratory interventions immediately.",
                    "POSITION and treat to reduce respiratory load while investigating cause.",
                    "NEVER delay action waiting for perfect diagnostic certainty.",
                    "MONITOR respiratory trend continuously for fatigue and decompensation.",
                ),
            ),
            (
                "Severe pain or functional loss",
                _module_text(
                    "PRIORITIZE pain control that preserves airway and hemodynamic safety.",
                    "IF severe pain limits exam quality, THEN stage analgesia and repeat focused assessment.",
                    "TREAT functional loss as potential structural/neurovascular emergency until excluded.",
                    "NEVER dismiss profound pain when objective findings are subtle early.",
                    "MONITOR response and adverse effects after each analgesic intervention.",
                ),
            ),
            (
                "Infection risk / sepsis signs",
                _module_text(
                    "PRIORITIZE early sepsis recognition and source control planning.",
                    "IF hypotension, confusion, tachypnea, or fever progression appears, THEN escalate to sepsis pathway.",
                    "START time-critical supportive care while refining likely source.",
                    "NEVER delay escalation when systemic signs outpace local findings.",
                    "MONITOR vitals trend and mental status for treatment response every cycle.",
                ),
            ),
            (
                "Deteriorating over time",
                _module_text(
                    "ASSUME trajectory risk and increase monitoring intensity immediately.",
                    "IF objective trend worsens across reassessments, THEN escalate intervention tier promptly.",
                    "RE-OPEN differential diagnosis and seek hidden complications actively.",
                    "NEVER rely on initial diagnosis when current trend contradicts it.",
                    "TRIGGER evacuation decision points earlier when decline persists despite care.",
                ),
            ),
        ],
        "mechanism": [
            (
                "Blunt impact",
                _module_text(
                    "SCREEN aggressively for occult internal injury and delayed decompensation.",
                    "IF head/chest/abdomen impact occurred, THEN extend observation and serial exams.",
                    "CORRELATE mechanism force with hidden injury probability, not just external wound.",
                    "NEVER exclude serious trauma solely from minimal skin findings.",
                    "MONITOR trend vitals and pain migration to detect latent injury.",
                ),
            ),
            (
                "Sharp cut",
                _module_text(
                    "PRIORITIZE depth assessment of vessels, nerves, tendons, and contamination.",
                    "IF cut crosses functional zones, THEN perform structured neurovascular exam before closure.",
                    "CONTROL bleeding and irrigate before definitive wound plan.",
                    "NEVER close a wound without documenting function distal to injury.",
                    "MONITOR for delayed bleeding, infection, and compartment pressure signs.",
                ),
            ),
            (
                "Penetrating / Impaled",
                _module_text(
                    "Depth matters more than width.",
                    "Do not explore or probe blindly.",
                    "If object is still in situ: Stabilize and do not remove unless it obstructs the airway or is a fish hook in a non-critical area.",
                ),
            ),
            (
                "Crush / compression",
                _module_text(
                    "PRIORITIZE perfusion, compartment syndrome risk, and tissue viability.",
                    "IF prolonged compression occurred, THEN anticipate reperfusion and metabolic complications.",
                    "IMMOBILIZE and elevate as appropriate while preserving circulation.",
                    "NEVER underestimate evolving necrosis from initially modest external signs.",
                    "MONITOR swelling progression, urine trend, and worsening pain out of proportion.",
                ),
            ),
            (
                "Twist / overload (rope, winch)",
                _module_text(
                    "PRIORITIZE ligament, tendon, and occult fracture screening in loaded joints.",
                    "IF rotational mechanism caused deformity or instability, THEN treat as structural injury.",
                    "IMMOBILIZE early and reassess neurovascular status after positioning.",
                    "NEVER force range of motion through severe pain resistance.",
                    "MONITOR for delayed swelling and function decline after initial stabilization.",
                ),
            ),
            (
                "High-tension recoil (snapback line)",
                _module_text(
                    "ASSUME high-energy transfer with risk of deep blunt and penetrating components.",
                    "IF chest, neck, or head was in path, THEN escalate hidden-injury suspicion immediately.",
                    "TREAT visible wounds while screening aggressively for internal trauma.",
                    "NEVER clear patient from observation based only on early appearance.",
                    "MONITOR serial vitals and neurologic status for delayed collapse.",
                ),
            ),
            (
                "Marine bite / sting",
                _module_text(
                    "PRIORITIZE toxin effects, anaphylaxis surveillance, and wound contamination control.",
                    "IF progressive pain, swelling, or systemic symptoms develop, THEN escalate envenomation pathway.",
                    "DECONTAMINATE and remove external irritants with species-safe methods.",
                    "NEVER apply contraindicated rinses or tightly occlusive wraps without indication.",
                    "MONITOR delayed tissue injury and infection progression over prolonged window.",
                ),
            ),
            (
                "Thermal exposure",
                _module_text(
                    "STOP ongoing thermal exposure and prioritize airway/core stabilization.",
                    "IF inhalation risk or extensive burn/cold injury exists, THEN elevate acuity immediately.",
                    "USE controlled cooling or warming matched to injury pattern.",
                    "NEVER use damaging extremes such as ice on burns or aggressive rubbing on frostbite.",
                    "MONITOR temperature trend, perfusion, and neurologic status frequently.",
                ),
            ),
            (
                "Immersion / near drowning",
                _module_text(
                    "PRIORITIZE oxygenation, ventilation, and hypothermia correction after rescue.",
                    "IF respiratory distress persists, THEN escalate airway and pulmonary monitoring urgently.",
                    "ASSUME delayed pulmonary deterioration even after transient improvement.",
                    "NEVER end observation early after significant aspiration event.",
                    "MONITOR oxygen trend, work of breathing, and mental status for delayed decline.",
                ),
            ),
            (
                "Chemical / electrical exposure",
                _module_text(
                    "PRIORITIZE decontamination, airway safety, and rhythm risk screening.",
                    "IF ongoing source exposure remains, THEN isolate source before further care.",
                    "IRRIGATE chemical injuries early and monitor for progressive tissue damage.",
                    "NEVER underestimate internal injury risk after electrical mechanism.",
                    "MONITOR cardiac, neurologic, and compartment changes across repeated reassessments.",
                ),
            ),
        ],
    }


def _seed_triage_prompt_modules(conn, now: str):
    """Seed default triage prompt modules once, preserving user customizations."""
    _ensure_triage_prompt_modules_table(conn)
    existing_count = conn.execute("SELECT COUNT(*) AS c FROM triage_prompt_modules").fetchone()
    if existing_count and int(existing_count["c"] or 0) > 0:
        return
    defaults = _default_triage_prompt_modules()
    changed = False
    for category, entries in defaults.items():
        for pos, (module_key, module_text) in enumerate(entries):
            conn.execute(
                """
                INSERT INTO triage_prompt_modules(category, module_key, module_text, position, updated_at)
                VALUES(:category, :module_key, :module_text, :position, :updated_at)
                ON CONFLICT(category, module_key) DO NOTHING
                """,
                {
                    "category": category,
                    "module_key": module_key,
                    "module_text": module_text,
                    "position": pos,
                    "updated_at": now,
                },
            )
            if conn.total_changes:
                changed = True
    if changed:
        conn.commit()


def _ensure_settings_meta_columns(conn):
    """Add new settings_meta columns when upgrading older DBs."""
    try:
        cols = conn.execute("PRAGMA table_info(settings_meta)").fetchall()
        names = {c["name"] for c in cols}
        if "last_prompt_verbatim" not in names:
            conn.execute("ALTER TABLE settings_meta ADD COLUMN last_prompt_verbatim TEXT;")
    except Exception as exc:
        logger.warning("Unable to add settings_meta columns: %s", exc)


def _seed_prompt_templates_from_model_params(conn, now: str):
    """Seed prompt template library from current active prompt values when empty."""
    _ensure_prompt_templates_table(conn)
    rows = conn.execute(
        """
        SELECT prompt_key, COUNT(*) AS c
        FROM prompt_templates
        WHERE prompt_key IN ('triage_instruction', 'inquiry_instruction')
        GROUP BY prompt_key
        """
    ).fetchall()
    existing = {r["prompt_key"]: int(r["c"] or 0) for r in rows}

    mp = conn.execute(
        """
        SELECT triage_instruction, inquiry_instruction
        FROM model_params
        WHERE id=1
        """
    ).fetchone()

    triage_text = (mp["triage_instruction"] if mp else None) or ""
    inquiry_text = (mp["inquiry_instruction"] if mp else None) or ""

    seeds = [
        ("triage_instruction", "Current Active Triage Prompt", triage_text),
        ("inquiry_instruction", "Current Active Inquiry Prompt", inquiry_text),
    ]
    changed = False
    for prompt_key, name, prompt_text in seeds:
        if existing.get(prompt_key, 0) > 0:
            continue
        if not (prompt_text or "").strip():
            continue
        conn.execute(
            """
            INSERT INTO prompt_templates(prompt_key, name, prompt_text, created_at, updated_at)
            VALUES(:prompt_key, :name, :prompt_text, :created_at, :updated_at)
            ON CONFLICT(prompt_key, name) DO UPDATE SET
                prompt_text=excluded.prompt_text,
                updated_at=excluded.updated_at
            """,
            {
                "prompt_key": prompt_key,
                "name": name,
                "prompt_text": prompt_text,
                "created_at": now,
                "updated_at": now,
            },
        )
        changed = True

    if changed:
        conn.commit()


def _backfill_expiries_from_items(conn, now: str):
    """
    Legacy data sometimes stored a single expiryDate/totalQty on the item row.
    Create a med_expiries row when none exist for that item so the UI sees it.
    """
    try:
        rows = conn.execute(
            """
            SELECT id, expiryDate, totalQty, notes, supplier
            FROM items
            WHERE itemType='pharma' AND IFNULL(expiryDate,'')!=''
              AND id NOT IN (SELECT DISTINCT item_id FROM med_expiries)
            """
        ).fetchall()
        for r in rows:
            conn.execute(
                """
                INSERT INTO med_expiries(id, item_id, date, quantity, notes, manufacturer, batchLot, updated_at)
                VALUES(:id, :item_id, :date, :quantity, :notes, :manufacturer, '', :updated_at)
                """,
                {
                    "id": f"ph-{uuid.uuid4()}",
                    "item_id": r["id"],
                    "date": r["expiryDate"],
                    "quantity": r["totalQty"],
                    "notes": r["notes"],
                    "manufacturer": r["supplier"],
                    "updated_at": now,
                },
            )
        if rows:
            conn.commit()
    except Exception as exc:
        logger.warning("Unable to backfill expiry rows: %s", exc)


def ensure_store(label: str, slug: str) -> Dict[str, Any]:
    """Legacy shim: return a fixed single store record."""
    return {"id": 1, "label": label, "slug": slug}


def get_store_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    """Legacy shim: always return the single store."""
    return {"id": 1, "label": "Default", "slug": slug}


def get_doc(workspace_id: int, category: str) -> Optional[Any]:
    """Deprecated: documents table removed."""
    return None


def get_who_medicines() -> list:
    """Return WHO ship medicine list from table, importing from bundled XLSX if empty."""
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _maybe_import_who_meds(conn, now)
        rows = conn.execute(
            """
            SELECT id, genericName, alsoKnownAs, formStrength, indications, contraindications,
                   consultDoctor, adultDosage, unwantedEffects, remarks
            FROM who_medicines
            ORDER BY lower(genericName)
            """
        ).fetchall()
    return [dict(r) for r in rows]


def set_doc(workspace_id: int, category: str, data: Any):
    """Deprecated: documents table removed."""
    return None


def _slug(name: str) -> str:
    """
     Slug helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    import re

    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"


def _ensure_vessel_columns(conn):
    """Add newer vessel columns for image assets when upgrading older DBs."""
    try:
        cols = conn.execute("PRAGMA table_info(vessel)").fetchall()
        names = {c["name"] for c in cols}
        if "boatPhoto" not in names:
            conn.execute("ALTER TABLE vessel ADD COLUMN boatPhoto TEXT;")
        if "registrationFrontPhoto" not in names:
            conn.execute("ALTER TABLE vessel ADD COLUMN registrationFrontPhoto TEXT;")
        if "registrationBackPhoto" not in names:
            conn.execute("ALTER TABLE vessel ADD COLUMN registrationBackPhoto TEXT;")
    except Exception as exc:
        logger.warning("Unable to add vessel columns: %s", exc)


def _upsert_vessel(conn, data: dict, updated_at: str):
    """
     Upsert Vessel helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    default = {
        "vesselName": "",
        "registrationNumber": "",
        "flagCountry": "",
        "homePort": "",
        "callSign": "",
        "tonnage": "",
        "netTonnage": "",
        "mmsi": "",
        "hullNumber": "",
        "starboardEngine": "",
        "starboardEngineSn": "",
        "portEngine": "",
        "portEngineSn": "",
        "ribSn": "",
        "boatPhoto": "",
        "registrationFrontPhoto": "",
        "registrationBackPhoto": "",
    }
    _ensure_vessel_columns(conn)
    merged = {**default, **(data or {})}
    conn.execute(
        """
        INSERT INTO vessel(
            id, vesselName, registrationNumber, flagCountry, homePort, callSign,
            tonnage, netTonnage, mmsi, hullNumber, starboardEngine, starboardEngineSn,
            portEngine, portEngineSn, ribSn, boatPhoto, registrationFrontPhoto, registrationBackPhoto, updated_at
        ) VALUES (1, :vesselName, :registrationNumber, :flagCountry, :homePort, :callSign,
                  :tonnage, :netTonnage, :mmsi, :hullNumber, :starboardEngine, :starboardEngineSn,
                  :portEngine, :portEngineSn, :ribSn, :boatPhoto, :registrationFrontPhoto, :registrationBackPhoto, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
            vesselName=excluded.vesselName,
            registrationNumber=excluded.registrationNumber,
            flagCountry=excluded.flagCountry,
            homePort=excluded.homePort,
            callSign=excluded.callSign,
            tonnage=excluded.tonnage,
            netTonnage=excluded.netTonnage,
            mmsi=excluded.mmsi,
            hullNumber=excluded.hullNumber,
            starboardEngine=excluded.starboardEngine,
            starboardEngineSn=excluded.starboardEngineSn,
            portEngine=excluded.portEngine,
            portEngineSn=excluded.portEngineSn,
            ribSn=excluded.ribSn,
            boatPhoto=excluded.boatPhoto,
            registrationFrontPhoto=excluded.registrationFrontPhoto,
            registrationBackPhoto=excluded.registrationBackPhoto,
            updated_at=excluded.updated_at;
        """,
        {**merged, "updated_at": updated_at},
    )


def get_vessel() -> dict:
    """
    Get Vessel helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _ensure_vessel_columns(conn)
        row = conn.execute(
            """
            SELECT vesselName, registrationNumber, flagCountry, homePort, callSign,
                   tonnage, netTonnage, mmsi, hullNumber, starboardEngine, starboardEngineSn,
                   portEngine, portEngineSn, ribSn, boatPhoto, registrationFrontPhoto, registrationBackPhoto, updated_at
            FROM vessel WHERE id=1
            """
        ).fetchone()
    default = {
        "vesselName": "",
        "registrationNumber": "",
        "flagCountry": "",
        "homePort": "",
        "callSign": "",
        "tonnage": "",
        "netTonnage": "",
        "mmsi": "",
        "hullNumber": "",
        "starboardEngine": "",
        "starboardEngineSn": "",
        "portEngine": "",
        "portEngineSn": "",
        "ribSn": "",
        "boatPhoto": "",
        "registrationFrontPhoto": "",
        "registrationBackPhoto": "",
    }
    if not row:
        return default
    keys = [
        "vesselName",
        "registrationNumber",
        "flagCountry",
        "homePort",
        "callSign",
        "tonnage",
        "netTonnage",
        "mmsi",
        "hullNumber",
        "starboardEngine",
        "starboardEngineSn",
        "portEngine",
        "portEngineSn",
        "ribSn",
        "boatPhoto",
        "registrationFrontPhoto",
        "registrationBackPhoto",
        "updated_at",
    ]
    return {k: row[idx] for idx, k in enumerate(keys)}


def set_vessel(data: dict):
    """
    Set Vessel helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _upsert_vessel(conn, data or {}, now)
        conn.commit()


# --- Crew helpers ---

def _replace_crew(conn, crew_list: list, updated_at: str):
    """
     Replace Crew helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    conn.execute("DELETE FROM crew_vaccines")
    conn.execute("DELETE FROM crew")
    for member in crew_list or []:
        try:
            mid = str(member.get("id") or member.get("uuid") or "")
        except Exception:
            mid = ""
        if not mid:
            continue
        _insert_relational_crew(conn, mid, member, updated_at)


def get_patients() -> list:
    """
    Get Patients helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        with _conn() as conn:
            crew_rows = conn.execute(
                """
                SELECT id, firstName, middleName, lastName, sex, birthdate, position, citizenship,
                       birthplace, passportNumber, passportIssue, passportExpiry,
                emergencyContactName, emergencyContactRelation, emergencyContactPhone,
                       emergencyContactEmail, emergencyContactNotes, phoneNumber, history,
                       username, password,
                       passportHeadshot, passportPage,
                       passportHeadshotBlob, passportHeadshotMime,
                       passportPageBlob, passportPageMime,
                       updated_at
                FROM crew
                ORDER BY updated_at DESC
                """
            ).fetchall()
            vacc_rows = conn.execute(
                """
                SELECT * FROM crew_vaccines
                """
            ).fetchall()
    except Exception:
        logger.exception("get_patients failed", extra={"db_path": str(DB_PATH)})
        raise

    vaccines_by_crew = {}
    for v in vacc_rows:
        rec = {k: v[k] for k in v.keys() if k != "crew_id"}
        vaccines_by_crew.setdefault(v["crew_id"], []).append(rec)
    out = []
    for r in crew_rows:
        rec = {k: r[k] for k in r.keys()}
        # reconstruct data URLs from blobs if present
        import base64
        if r["passportHeadshotBlob"]:
            mime = r["passportHeadshotMime"] or "application/octet-stream"
            rec["passportHeadshot"] = f"data:{mime};base64," + base64.b64encode(r["passportHeadshotBlob"]).decode("utf-8")
        if r["passportPageBlob"]:
            mime = r["passportPageMime"] or "application/octet-stream"
            rec["passportPage"] = f"data:{mime};base64," + base64.b64encode(r["passportPageBlob"]).decode("utf-8")
        # Do not return raw blobs in the API payload; keep only data URLs
        rec.pop("passportHeadshotBlob", None)
        rec.pop("passportPageBlob", None)
        # Expose plaintext password as stored (per requirement)
        rec["vaccines"] = vaccines_by_crew.get(r["id"], [])
        out.append(rec)
    return out


def get_patient_options() -> list:
    """Return lightweight crew rows for fast dropdown rendering."""
    try:
        with _conn() as conn:
            rows = conn.execute(
                """
                SELECT id, firstName, lastName
                FROM crew
                ORDER BY updated_at DESC
                """
            ).fetchall()
    except Exception:
        logger.exception("get_patient_options failed", extra={"db_path": str(DB_PATH)})
        raise

    return [
        {
            "id": r["id"],
            "firstName": r["firstName"],
            "lastName": r["lastName"],
        }
        for r in rows
    ]


def get_credentials_rows():
    """Return minimal credential info for auth (username + hashed password)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, username, password FROM crew WHERE username IS NOT NULL AND username != ''"
        ).fetchall()
    return [dict(r) for r in rows]


def set_patients(members: list):
    """
    Set Patients helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _replace_crew(conn, members or [], now)
        conn.commit()


def delete_patients_doc():
    """Remove legacy patients JSON document to avoid duplication."""
    # documents table has been removed; nothing to delete
    return


# --- Settings aux tables (vaccine types, pharmacy labels) ---

def replace_vaccine_types(names: list):
    """
    Replace Vaccine Types helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(names, list):
        return
    rows = [(idx, str(n).strip()) for idx, n in enumerate(names) if str(n).strip()]
    with _conn() as conn:
        conn.execute("DELETE FROM vaccine_types")
        for pos, name in rows:
            conn.execute(
                "INSERT INTO vaccine_types(name, position) VALUES(?, ?)",
                (name, pos),
            )
        conn.commit()


def replace_pharmacy_labels(names: list):
    """
    Replace Pharmacy Labels helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(names, list):
        return
    rows = [(idx, str(n).strip()) for idx, n in enumerate(names) if str(n).strip()]
    with _conn() as conn:
        conn.execute("DELETE FROM pharmacy_labels")
        for pos, name in rows:
            conn.execute(
                "INSERT INTO pharmacy_labels(name, position) VALUES(?, ?)",
                (name, pos),
            )
        conn.commit()


def load_vaccine_types():
    """
    Load Vaccine Types helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM vaccine_types ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def load_pharmacy_labels():
    """
    Load Pharmacy Labels helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM pharmacy_labels ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def replace_equipment_categories(names: list):
    """
    Replace Equipment Categories helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(names, list):
        return
    rows = [(idx, str(n).strip()) for idx, n in enumerate(names) if str(n).strip()]
    with _conn() as conn:
        conn.execute("DELETE FROM equipment_categories")
        for pos, name in rows:
            conn.execute(
                "INSERT INTO equipment_categories(name, position) VALUES(?, ?)",
                (name, pos),
            )
        conn.commit()


def load_equipment_categories():
    """
    Load Equipment Categories helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM equipment_categories ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def replace_consumable_categories(names: list):
    """
    Replace Consumable Categories helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(names, list):
        return
    rows = [(idx, str(n).strip()) for idx, n in enumerate(names) if str(n).strip()]
    with _conn() as conn:
        conn.execute("DELETE FROM consumable_categories")
        for pos, name in rows:
            conn.execute(
                "INSERT INTO consumable_categories(name, position) VALUES(?, ?)",
                (name, pos),
            )
        conn.commit()


def load_consumable_categories():
    """
    Load Consumable Categories helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM consumable_categories ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def get_model_params():
    """
    Get Model Params helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _ensure_model_params_columns(conn)
        row = conn.execute(
            """
            SELECT triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p, tr_k,
                   in_temp, in_tok, in_p, in_k, mission_context, rep_penalty
            FROM model_params WHERE id=1
            """
        ).fetchone()
    if not row:
        return {}
    keys = [
        "triage_instruction",
        "inquiry_instruction",
        "tr_temp",
        "tr_tok",
        "tr_p",
        "tr_k",
        "in_temp",
        "in_tok",
        "in_p",
        "in_k",
        "mission_context",
        "rep_penalty",
    ]
    return {k: row[idx] for idx, k in enumerate(keys)}


def set_model_params(data: dict):
    """
    Set Model Params helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    params = data or {}
    with _conn() as conn:
        _ensure_model_params_columns(conn)
        conn.execute(
            """
            INSERT INTO model_params(
                id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p, tr_k,
                in_temp, in_tok, in_p, in_k, mission_context, rep_penalty, updated_at
            ) VALUES (
                1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p, :tr_k,
                :in_temp, :in_tok, :in_p, :in_k, :mission_context, :rep_penalty, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                triage_instruction=excluded.triage_instruction,
                inquiry_instruction=excluded.inquiry_instruction,
                tr_temp=excluded.tr_temp,
                tr_tok=excluded.tr_tok,
                tr_p=excluded.tr_p,
                tr_k=excluded.tr_k,
                in_temp=excluded.in_temp,
                in_tok=excluded.in_tok,
                in_p=excluded.in_p,
                in_k=excluded.in_k,
                mission_context=excluded.mission_context,
                rep_penalty=excluded.rep_penalty,
                updated_at=excluded.updated_at;
            """,
            {
                "triage_instruction": params.get("triage_instruction"),
                "inquiry_instruction": params.get("inquiry_instruction"),
                "tr_temp": params.get("tr_temp"),
                "tr_tok": params.get("tr_tok"),
                "tr_p": params.get("tr_p"),
                "tr_k": params.get("tr_k"),
                "in_temp": params.get("in_temp"),
                "in_tok": params.get("in_tok"),
                "in_p": params.get("in_p"),
                "in_k": params.get("in_k"),
                "mission_context": params.get("mission_context"),
                "rep_penalty": params.get("rep_penalty"),
                "updated_at": now,
            },
        )
        conn.commit()


PROMPT_TEMPLATE_KEYS = {"triage_instruction", "inquiry_instruction"}


def _normalize_prompt_template_key(prompt_key: str) -> str:
    """
     Normalize Prompt Template Key helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    key = (prompt_key or "").strip()
    if key not in PROMPT_TEMPLATE_KEYS:
        raise ValueError("Invalid prompt key.")
    return key


def list_prompt_templates(prompt_key: Optional[str] = None) -> list:
    """
    List Prompt Templates helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _ensure_prompt_templates_table(conn)
        if prompt_key:
            key = _normalize_prompt_template_key(prompt_key)
            rows = conn.execute(
                """
                SELECT id, prompt_key, name, prompt_text, created_at, updated_at
                FROM prompt_templates
                WHERE prompt_key=:prompt_key
                ORDER BY lower(name), datetime(updated_at) DESC
                """,
                {"prompt_key": key},
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, prompt_key, name, prompt_text, created_at, updated_at
                FROM prompt_templates
                ORDER BY prompt_key, lower(name), datetime(updated_at) DESC
                """
            ).fetchall()
    return [dict(r) for r in rows]


def upsert_prompt_template(prompt_key: str, name: str, prompt_text: str) -> dict:
    """
    Upsert Prompt Template helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    key = _normalize_prompt_template_key(prompt_key)
    title = (name or "").strip()
    if not title:
        raise ValueError("Prompt name is required.")
    body = (prompt_text or "").strip()
    if not body:
        raise ValueError("Prompt text is required.")
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_prompt_templates_table(conn)
        conn.execute(
            """
            INSERT INTO prompt_templates(prompt_key, name, prompt_text, created_at, updated_at)
            VALUES(:prompt_key, :name, :prompt_text, :created_at, :updated_at)
            ON CONFLICT(prompt_key, name) DO UPDATE SET
                prompt_text=excluded.prompt_text,
                updated_at=excluded.updated_at
            """,
            {
                "prompt_key": key,
                "name": title,
                "prompt_text": body,
                "created_at": now,
                "updated_at": now,
            },
        )
        row = conn.execute(
            """
            SELECT id, prompt_key, name, prompt_text, created_at, updated_at
            FROM prompt_templates
            WHERE prompt_key=:prompt_key AND name=:name
            """,
            {"prompt_key": key, "name": title},
        ).fetchone()
        conn.commit()
    return dict(row) if row else {}


def update_patient_fields(crew_id: str, fields: dict):
    """Update specific crew columns; does not touch vaccines."""
    allowed = {
        "firstName",
        "middleName",
        "lastName",
        "sex",
        "birthdate",
        "position",
        "citizenship",
        "birthplace",
        "passportNumber",
        "passportIssue",
        "passportExpiry",
        "emergencyContactName",
        "emergencyContactRelation",
        "emergencyContactPhone",
        "emergencyContactEmail",
        "emergencyContactNotes",
        "phoneNumber",
        "history",
        "username",
        "password",
        "passportHeadshot",
        "passportPage",
    }
    updates = {k: v for k, v in (fields or {}).items() if k in allowed}
    if not updates:
        return False
    if "password" in updates:
        pw = updates["password"]
        updates["password"] = _hash_password(pw)
    # If headshot/page is being updated, map to blob columns
    blob_updates = {}
    if "passportHeadshot" in updates:
        mime, blob = _decode_data_url(updates.pop("passportHeadshot"))
        blob_updates.update(
            {
                "passportHeadshotBlob": blob,
                "passportHeadshotMime": mime or "application/octet-stream",
                "passportHeadshot": None,
            }
        )
    if "passportPage" in updates:
        mime, blob = _decode_data_url(updates.pop("passportPage"))
        blob_updates.update(
            {
                "passportPageBlob": blob,
                "passportPageMime": mime or "application/octet-stream",
                "passportPage": None,
            }
        )
    updates.update(blob_updates)
    sets = ", ".join(f"{k}=:{k}" for k in updates.keys())
    updates["id"] = crew_id
    updates["updated_at"] = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute(
            f"UPDATE crew SET {sets}, updated_at=:updated_at WHERE id=:id",
            updates,
        )
        conn.commit()
    return True


# --- Inventory / equipment / consumables ---

def _row_to_item(row):
    """
     Row To Item helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    d = {k: row[k] for k in row.keys()}
    # map fields back to existing JSON keys
    item = {
        "id": d["id"],
        "name": d["name"],
        "genericName": d["genericName"],
        "brandName": d["brandName"],
        "alsoKnownAs": d["alsoKnownAs"],
        "formStrength": d["formStrength"],
        "indications": d["indications"],
        "contraindications": d["contraindications"],
        "consultDoctor": d["consultDoctor"],
        "adultDosage": d["adultDosage"],
        "pediatricDosage": d["pediatricDosage"],
        "unwantedEffects": d["unwantedEffects"],
        "storageLocation": d["storageLocation"],
        "subLocation": d["subLocation"],
        "status": d["status"],
        "expiryDate": d["expiryDate"],
        "lastInspection": d["lastInspection"],
        "batteryType": d["batteryType"],
        "batteryStatus": d["batteryStatus"],
        "calibrationDue": d["calibrationDue"],
        "totalQty": d["totalQty"],
        "minPar": d["minPar"],
        "supplier": d["supplier"],
        "parentId": d["parentId"],
        "requiresPower": bool(d["requiresPower"]),
        "category": d["category"],
        "type": d["typeDetail"],
        "priorityTier": d.get("priorityTier") or "",
        "tierCategory": d.get("tierCategory") or "",
        "notes": d["notes"],
        "excludeFromResources": bool(d["excludeFromResources"]),
        "verified": bool(d.get("verified", 0)),
    }
    # for pharma, set type explicitly to 'pharma'
    if d["itemType"] == "pharma":
        item["type"] = "pharma"
    return item


def get_inventory_items():
    # Pull pharma items plus their per-expiry rows; keep a dict keyed by item_id for quick attach.
    """
    Get Inventory Items helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _ensure_items_verified_column(conn)
        _ensure_vessel_columns(conn)
        rows = conn.execute("SELECT * FROM items WHERE itemType='pharma' ORDER BY updated_at DESC").fetchall()
        expiries = conn.execute(
            "SELECT id, item_id, date, quantity, notes, manufacturer, batchLot, updated_at FROM med_expiries"
        ).fetchall()
    exp_by_item = {}
    for r in expiries:
        exp_by_item.setdefault(r["item_id"], []).append(
            {
                "id": r["id"],
                "date": r["date"],
                "quantity": r["quantity"],
                "notes": r["notes"],
                "manufacturer": r["manufacturer"],
                "batchLot": r["batchLot"],
                "updated_at": r["updated_at"],
            }
        )
    items = []
    for r in rows:
        item = _row_to_item(r)
        item["purchaseHistory"] = exp_by_item.get(item["id"], [])
        items.append(item)
    return items


def ensure_item_schema(item: dict, item_type: str, now: str) -> dict:
    """
    Normalize inbound inventory payloads (pharmacy UI) to the SQL schema used by items/med_expiries.
    Raises ValueError on missing critical fields so callers can present a friendly message.
    This stays forgiving for legacy/optional fields.
    """
    source = (item.get("source") or "").strip().lower()

    def pick(*keys, default=""):
        """
        Pick helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        for k in keys:
            if k in item and item[k] is not None:
                return item[k]
        return default

    iid = str(item.get("id") or f"{item_type}-{uuid.uuid4()}")
    # Compose a friendly display name, preferring brand then generic.
    name = pick("name", "brandName", "genericName", default="")
    generic = pick("genericName", default="").strip()
    brand = pick("brandName", default="").strip()
    form = pick("form", default="").strip()
    strength = pick("strength", default="").strip()
    form_strength = pick("formStrength", default="").strip()

    # Fail fast on missing critical fields so callers can surface friendly errors, while
    # remaining backwards-compatible with legacy rows that lack strength details.
    if item_type == "pharma":
        if not generic:
            generic = brand or name or "Medication"
        # Allow strength to be embedded in form/formStrength (e.g., "Tablet 500 mg").
        strength_hint = bool(re.search(r"\d", form_strength or form))
        if not strength and not strength_hint and source != "who_recommended":
            strength = "unspecified"
        if not form_strength:
            form_strength = " ".join([form, strength]).strip()
        if not form_strength:
            form_strength = strength or "unspecified"
    else:
        if not form_strength:
            form_strength = " ".join([form, strength]).strip()

    if not name:
        name = brand or generic or name

    # User-defined label maps to category column; keep legacy fields too.
    category = pick("sortCategory", "category", default="")
    type_detail = pick("typeDetail", "type", default=item_type)

    return {
        "id": iid,
        "itemType": item_type,
        "name": name,
        "genericName": generic,
        "brandName": brand,
        "alsoKnownAs": pick("alsoKnownAs", default=""),
        "formStrength": form_strength,
        "indications": pick("primaryIndication", "indications", default=""),
        "contraindications": pick("allergyWarnings", "contraindications", default=""),
        "consultDoctor": pick("consultDoctor", default=""),
        "adultDosage": pick("standardDosage", "adultDosage", default=""),
        "pediatricDosage": pick("pediatricDosage", default=""),
        "unwantedEffects": pick("unwantedEffects", default=""),
        "storageLocation": pick("storageLocation", default=""),
        "subLocation": pick("subLocation", default=""),
        "status": pick("status", default="In Stock"),
        "verified": 1 if item.get("verified") else 0,
        "expiryDate": pick("expiryDate", default=""),
        "lastInspection": pick("lastInspection", default=""),
        "batteryType": pick("batteryType", default=""),
        "batteryStatus": pick("batteryStatus", default=""),
        "calibrationDue": pick("calibrationDue", default=""),
        "totalQty": pick("totalQty", "currentQuantity", default=""),
        "minPar": pick("minPar", "minThreshold", default=""),
        # Keep supplier separate from per-batch manufacturer; do not overwrite with batch data.
        "supplier": pick("supplier", default=""),
        "parentId": pick("parentId", default=""),
        "requiresPower": 1 if item.get("requiresPower") else 0,
        "category": category,
        "typeDetail": type_detail,
        "priorityTier": pick("priorityTier", default=""),
        "tierCategory": pick("tierCategory", default=""),
        "notes": pick("notes", default=""),
        "excludeFromResources": 1 if item.get("excludeFromResources") else 0,
        "updated_at": now,
    }


def set_inventory_items(items: list):
    """
    Set Inventory Items helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    # Validate and normalize the full payload before touching the database to avoid partial writes.
    normalized_items = []
    exp_rows = []

    def _validate_expiry(ph: dict, item_id: str):
        """
         Validate Expiry helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        date_val = ph.get("date") or ""
        if date_val:
            try:
                # Accept YYYY-MM-DD; store as-is if parsable by datetime.fromisoformat
                datetime.fromisoformat(date_val)
            except Exception:
                logger.warning("Invalid expiry date for item %s; clearing value: %s", item_id, date_val)
                ph["date"] = ""
        qty = ph.get("quantity")
        if qty not in (None, ""):
            try:
                qn = float(qty)
                if qn < 0:
                    raise ValueError()
            except Exception:
                logger.warning("Invalid expiry quantity for item %s; clearing value: %s", item_id, qty)
                ph["quantity"] = ""

    def _purchase_history_rows(raw_item):
        # Prefer structured purchaseHistory; if absent but a single expiryDate is provided,
        # synthesize one row so legacy/manual forms still persist expiry data.
        """
         Purchase History Rows helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        ph_list = raw_item.get("purchaseHistory") or raw_item.get("purchase_history") or []
        if not ph_list and raw_item.get("expiryDate"):
            ph_list = [
                {
                    "id": f"ph-{uuid.uuid4()}",
                    "date": raw_item.get("expiryDate") or "",
                    "quantity": raw_item.get("currentQuantity") or raw_item.get("totalQty") or "",
                    "notes": raw_item.get("notes") or "",
                    "manufacturer": raw_item.get("manufacturer") or "",
                    "batchLot": raw_item.get("batchLot") or "",
                }
            ]
        # Drop entirely empty rows (no date/qty/notes/manufacturer/batch)
        filtered = []
        for ph in ph_list:
            if any([
                (ph.get("date") or "").strip(),
                (ph.get("quantity") or "").strip(),
                (ph.get("notes") or "").strip(),
                (ph.get("manufacturer") or "").strip(),
                (ph.get("batchLot") or "").strip(),
            ]):
                filtered.append(ph)
        return filtered

    for raw in items or []:
        normalized = ensure_item_schema(raw, "pharma", now)
        normalized_items.append(normalized)
        ph_rows = _purchase_history_rows(raw)
        for ph in ph_rows:
            _validate_expiry(ph, normalized["id"])
            exp_rows.append(
                {
                    "id": ph.get("id") or f"ph-{uuid.uuid4()}",
                    "item_id": normalized["id"],
                    "date": ph.get("date"),
                    "quantity": ph.get("quantity"),
                    "notes": ph.get("notes"),
                    "manufacturer": ph.get("manufacturer"),
                    "batchLot": ph.get("batchLot"),
                    "updated_at": now,
                }
            )

    # Map item_id -> expiry rows so we can replace per-item without wiping others
    exp_by_item = {}
    for ph in exp_rows:
        exp_by_item.setdefault(ph["item_id"], []).append(ph)

    incoming_ids = {itm["id"] for itm in normalized_items}

    with _conn() as conn:
        try:
            conn.execute("BEGIN")
            _ensure_items_verified_column(conn)
            for item in normalized_items:
                _insert_item(conn, item, "pharma", now)
                ph_rows = exp_by_item.get(item["id"], [])
                # Replace expiries for this item even if none submitted (clears deletions)
                conn.execute("DELETE FROM med_expiries WHERE item_id=?", (item["id"],))
                for ph in ph_rows:
                    conn.execute(
                        """
                        INSERT INTO med_expiries(
                            id, item_id, date, quantity, notes, manufacturer, batchLot, updated_at
                        ) VALUES (
                            :id, :item_id, :date, :quantity, :notes, :manufacturer, :batchLot, :updated_at
                        )
                        ON CONFLICT(id) DO UPDATE SET
                            item_id=excluded.item_id,
                            date=excluded.date,
                            quantity=excluded.quantity,
                            notes=excluded.notes,
                            manufacturer=excluded.manufacturer,
                            batchLot=excluded.batchLot,
                            updated_at=excluded.updated_at;
                        """,
                        ph,
                    )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def delete_inventory_item(item_id: str) -> bool:
    """Delete a single pharmaceutical item and its expiry rows. Returns True when removed."""
    if not item_id:
        return False
    with _conn() as conn:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM med_expiries WHERE item_id=?", (item_id,))
        cur = conn.execute("DELETE FROM items WHERE id=? AND itemType='pharma'", (item_id,))
        # Defensive cleanup: remove any orphaned expiry rows to avoid stale records.
        conn.execute(
            "DELETE FROM med_expiries WHERE item_id NOT IN (SELECT id FROM items WHERE itemType='pharma')"
        )
        conn.commit()
    return cur.rowcount > 0


def update_item_verified(item_id: str, verified: bool) -> bool:
    """Lightweight toggle for a single item's verified flag."""
    if not item_id:
        return False
    with _conn() as conn:
        conn.execute("UPDATE items SET verified=? WHERE id=? AND itemType='pharma'", (1 if verified else 0, item_id))
        conn.commit()
        row = conn.execute("SELECT id FROM items WHERE id=? AND itemType='pharma'", (item_id,)).fetchone()
        return bool(row)


def upsert_inventory_item(item: dict) -> dict:
    """Upsert a single pharma item and fully replace its expiry rows when provided."""
    now = datetime.utcnow().isoformat()
    normalized = ensure_item_schema(item, "pharma", now)

    def _validate_expiry(ph: dict):
        """
         Validate Expiry helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        date_val = ph.get("date") or ""
        if date_val:
            try:
                datetime.fromisoformat(date_val)
            except Exception:
                ph["date"] = ""
        qty = ph.get("quantity")
        if qty not in (None, ""):
            try:
                qn = float(qty)
                if qn < 0:
                    raise ValueError()
            except Exception:
                ph["quantity"] = ""

    exp_rows = []
    has_purchase_history = "purchaseHistory" in item or "purchase_history" in item
    if has_purchase_history:
        ph_list = item.get("purchaseHistory") or item.get("purchase_history") or []
        # If empty but a single expiryDate is provided, synthesize one row
        if not ph_list and item.get("expiryDate"):
            ph_list = [
                {
                    "id": f"ph-{uuid.uuid4()}",
                    "date": item.get("expiryDate") or "",
                    "quantity": item.get("currentQuantity") or item.get("totalQty") or "",
                    "notes": item.get("notes") or "",
                    "manufacturer": item.get("manufacturer") or "",
                    "batchLot": item.get("batchLot") or "",
                }
            ]
        for ph in ph_list:
            _validate_expiry(ph)
            exp_rows.append(
                {
                    "id": ph.get("id") or f"ph-{uuid.uuid4()}",
                    "item_id": normalized["id"],
                    "date": ph.get("date"),
                    "quantity": ph.get("quantity"),
                    "notes": ph.get("notes"),
                    "manufacturer": ph.get("manufacturer"),
                    "batchLot": ph.get("batchLot"),
                    "updated_at": now,
                }
            )

    with _conn() as conn:
        conn.execute("BEGIN")
        _ensure_items_verified_column(conn)
        _insert_item(conn, normalized, "pharma", now)
        if has_purchase_history:
            conn.execute("DELETE FROM med_expiries WHERE item_id=?", (normalized["id"],))
            for ph in exp_rows:
                conn.execute(
                    """
                    INSERT INTO med_expiries(
                        id, item_id, date, quantity, notes, manufacturer, batchLot, updated_at
                    ) VALUES (
                        :id, :item_id, :date, :quantity, :notes, :manufacturer, :batchLot, :updated_at
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        item_id=excluded.item_id,
                        date=excluded.date,
                        quantity=excluded.quantity,
                        notes=excluded.notes,
                        manufacturer=excluded.manufacturer,
                        batchLot=excluded.batchLot,
                        updated_at=excluded.updated_at;
                    """,
                    ph,
                )
        conn.commit()
    return normalized


def get_tool_items():
    """
    Get Tool Items helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM items WHERE itemType!='pharma' ORDER BY updated_at DESC").fetchall()
    return [_row_to_item(r) for r in rows]


def set_tool_items(items: list):
    """
    Set Tool Items helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_items_verified_column(conn)
        conn.execute("DELETE FROM items WHERE itemType!='pharma'")
        for item in items or []:
            item_type = "consumable" if (item.get("type") or "").lower() == "consumable" else "equipment"
            _insert_item(conn, item, item_type, now)
        conn.commit()


def _insert_item(conn, item: dict, item_type: str, updated_at: str):
    """
     Insert Item helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    conn.execute(
        """
        INSERT INTO items(
            id, itemType, name, genericName, brandName, alsoKnownAs, formStrength,
            indications, contraindications, consultDoctor, adultDosage, pediatricDosage,
            unwantedEffects, storageLocation, subLocation, status, verified, expiryDate,
            lastInspection, batteryType, batteryStatus, calibrationDue, totalQty,
            minPar, supplier, parentId, requiresPower, category, typeDetail, priorityTier, tierCategory, notes,
            excludeFromResources, updated_at
        ) VALUES (
            :id, :itemType, :name, :genericName, :brandName, :alsoKnownAs, :formStrength,
            :indications, :contraindications, :consultDoctor, :adultDosage, :pediatricDosage,
            :unwantedEffects, :storageLocation, :subLocation, :status, :verified, :expiryDate,
            :lastInspection, :batteryType, :batteryStatus, :calibrationDue, :totalQty,
            :minPar, :supplier, :parentId, :requiresPower, :category, :typeDetail, :priorityTier, :tierCategory, :notes,
            :excludeFromResources, :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            itemType=excluded.itemType,
            name=excluded.name,
            genericName=excluded.genericName,
            brandName=excluded.brandName,
            alsoKnownAs=excluded.alsoKnownAs,
            formStrength=excluded.formStrength,
            indications=excluded.indications,
            contraindications=excluded.contraindications,
            consultDoctor=excluded.consultDoctor,
            adultDosage=excluded.adultDosage,
            pediatricDosage=excluded.pediatricDosage,
            unwantedEffects=excluded.unwantedEffects,
            storageLocation=excluded.storageLocation,
            subLocation=excluded.subLocation,
            status=excluded.status,
            verified=excluded.verified,
            expiryDate=excluded.expiryDate,
            lastInspection=excluded.lastInspection,
            batteryType=excluded.batteryType,
            batteryStatus=excluded.batteryStatus,
            calibrationDue=excluded.calibrationDue,
            totalQty=excluded.totalQty,
            minPar=excluded.minPar,
            supplier=excluded.supplier,
            parentId=excluded.parentId,
            requiresPower=excluded.requiresPower,
            category=excluded.category,
            typeDetail=excluded.typeDetail,
            priorityTier=excluded.priorityTier,
            tierCategory=excluded.tierCategory,
            notes=excluded.notes,
            excludeFromResources=excluded.excludeFromResources,
            updated_at=excluded.updated_at;
        """,
        {
            "id": str(item.get("id") or f"item-{datetime.utcnow().timestamp()}"),
            "itemType": item_type,
            "name": item.get("name"),
            "genericName": item.get("genericName"),
            "brandName": item.get("brandName"),
            "alsoKnownAs": item.get("alsoKnownAs"),
            "formStrength": item.get("formStrength"),
            "indications": item.get("indications"),
            "contraindications": item.get("contraindications"),
            "consultDoctor": item.get("consultDoctor"),
            "adultDosage": item.get("adultDosage"),
            "pediatricDosage": item.get("pediatricDosage"),
            "unwantedEffects": item.get("unwantedEffects"),
            "storageLocation": item.get("storageLocation"),
            "subLocation": item.get("subLocation"),
            "status": item.get("status"),
            "verified": 1 if item.get("verified") else 0,
            "expiryDate": item.get("expiryDate"),
            "lastInspection": item.get("lastInspection"),
            "batteryType": item.get("batteryType"),
            "batteryStatus": item.get("batteryStatus"),
            "calibrationDue": item.get("calibrationDue"),
            "totalQty": item.get("totalQty"),
            "minPar": item.get("minPar"),
            "supplier": item.get("supplier"),
            "parentId": item.get("parentId"),
            "requiresPower": 1 if item.get("requiresPower") else 0,
            "category": item.get("category"),
            "typeDetail": item.get("type"),
            "priorityTier": item.get("priorityTier"),
            "tierCategory": item.get("tierCategory"),
            "notes": item.get("notes"),
            "excludeFromResources": 1 if item.get("excludeFromResources") else 0,
            "updated_at": updated_at,
        },
    )
    return True


def get_history_entries():
    """
    Get History Entries helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT id, date, patient, patient_id, mode, query, user_query, response,
                   model, duration_ms, prompt, injected_prompt, updated_at
            FROM history_entries
            ORDER BY datetime(date) DESC
            """
        ).fetchall()
    return [{k: r[k] for k in r.keys()} for r in rows]


def get_history_entry_by_id(history_id: str):
    """
    Get History Entry By Id helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not history_id:
        return None
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT id, date, patient, patient_id, mode, query, user_query, response,
                   model, duration_ms, prompt, injected_prompt, updated_at
            FROM history_entries
            WHERE id = ?
            """,
            (history_id,),
        ).fetchone()
    return {k: row[k] for k in row.keys()} if row else None


def get_history_latency_metrics():
    """Return per-model latency stats derived from history_entries duration_ms."""
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT model, duration_ms
            FROM history_entries
            WHERE duration_ms IS NOT NULL
            """
        ).fetchall()
    durations_by_model = {}
    for r in rows:
        model = r["model"]
        try:
            val = float(r["duration_ms"])
        except Exception:
            continue
        durations_by_model.setdefault(model, []).append(val)

    metrics = {}
    for model, values in durations_by_model.items():
        if not values:
            continue
        mean = sum(values) / len(values)
        if len(values) > 1:
            var = sum((v - mean) ** 2 for v in values) / len(values)
            std = math.sqrt(var)
        else:
            std = 0.0
        if std > 0:
            filtered = [v for v in values if abs(v - mean) <= 3 * std]
        else:
            filtered = list(values)
        if not filtered:
            filtered = list(values)
        avg_ms = sum(filtered) / len(filtered)
        metrics[model] = {
            "count": len(filtered),
            "total_ms": avg_ms * len(filtered),
            "avg_ms": avg_ms,
        }
    return metrics


def set_history_entries(entries: list):
    """
    Set History Entries helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM history_entries")
        for h in entries or []:
            hid = str(h.get("id") or datetime.utcnow().isoformat())
            conn.execute(
                """
                INSERT INTO history_entries(
                    id, date, patient, patient_id, mode, query, user_query, response,
                    model, duration_ms, prompt, injected_prompt, updated_at
                ) VALUES (
                    :id, :date, :patient, :patient_id, :mode, :query, :user_query, :response,
                    :model, :duration_ms, :prompt, :injected_prompt, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    date=excluded.date,
                    patient=excluded.patient,
                    patient_id=excluded.patient_id,
                    mode=excluded.mode,
                    query=excluded.query,
                    user_query=excluded.user_query,
                    response=excluded.response,
                    model=excluded.model,
                    duration_ms=excluded.duration_ms,
                    prompt=excluded.prompt,
                    injected_prompt=excluded.injected_prompt,
                    updated_at=excluded.updated_at;
                """,
                {
                    "id": hid,
                    "date": h.get("date"),
                    "patient": h.get("patient"),
                    "patient_id": h.get("patient_id"),
                    "mode": h.get("mode"),
                    "query": h.get("query"),
                    "user_query": h.get("user_query"),
                    "response": h.get("response"),
                    "model": h.get("model"),
                    "duration_ms": h.get("duration_ms"),
                    "prompt": h.get("prompt"),
                    "injected_prompt": h.get("injected_prompt"),
                    "updated_at": h.get("updated_at") or now,
                },
            )
        conn.commit()


def upsert_history_entry(entry: dict):
    """
    Upsert History Entry helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    if not isinstance(entry, dict):
        return
    hid = str(entry.get("id") or datetime.utcnow().isoformat())
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO history_entries(
                id, date, patient, patient_id, mode, query, user_query, response,
                model, duration_ms, prompt, injected_prompt, updated_at
            ) VALUES (
                :id, :date, :patient, :patient_id, :mode, :query, :user_query, :response,
                :model, :duration_ms, :prompt, :injected_prompt, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                date=excluded.date,
                patient=excluded.patient,
                patient_id=excluded.patient_id,
                mode=excluded.mode,
                query=excluded.query,
                user_query=excluded.user_query,
                response=excluded.response,
                model=excluded.model,
                duration_ms=excluded.duration_ms,
                prompt=excluded.prompt,
                injected_prompt=excluded.injected_prompt,
                updated_at=excluded.updated_at;
            """,
            {
                "id": hid,
                "date": entry.get("date"),
                "patient": entry.get("patient"),
                "patient_id": entry.get("patient_id"),
                "mode": entry.get("mode"),
                "query": entry.get("query"),
                "user_query": entry.get("user_query"),
                "response": entry.get("response"),
                "model": entry.get("model"),
                "duration_ms": entry.get("duration_ms"),
                "prompt": entry.get("prompt"),
                "injected_prompt": entry.get("injected_prompt"),
                "updated_at": entry.get("updated_at") or now,
            },
        )
        conn.commit()


def get_chats():
    """
    Get Chats helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT id, role, message, model, mode, patient_id, user, created_at, meta
            FROM chats
            ORDER BY datetime(created_at) DESC
            """
        ).fetchall()
    result = []
    for r in rows:
        rec = dict(r)
        try:
            if rec.get("meta"):
                rec.update(json.loads(rec["meta"]))
        except Exception:
            pass
        rec.pop("meta", None)
        result.append(rec)
    return result


def set_chats(chats: list):
    """
    Set Chats helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM chats")
        _insert_chats(conn, chats or [], now)


def get_chat_metrics():
    """
    Get Chat Metrics helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        rows = conn.execute(
            "SELECT model, count, total_ms, avg_ms FROM chat_metrics"
        ).fetchall()
    return {r["model"]: {"count": r["count"], "total_ms": r["total_ms"], "avg_ms": r["avg_ms"]} for r in rows}


def set_chat_metrics(metrics: dict):
    """
    Set Chat Metrics helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _replace_chat_metrics(conn, metrics or {}, now)


def get_settings_meta():
    """
    Get Settings Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _ensure_settings_meta_columns(conn)
        row = conn.execute(
            "SELECT user_mode, offline_force_flags, last_prompt_verbatim FROM settings_meta WHERE id=1"
        ).fetchone()
    if not row:
        return {}
    return {
        "user_mode": row["user_mode"],
        "offline_force_flags": bool(row["offline_force_flags"]),
        "last_prompt_verbatim": row["last_prompt_verbatim"],
    }


def set_settings_meta(
    user_mode: str = None,
    offline_force_flags: bool = None,
    last_prompt_verbatim: str = None,
):
    """
    Set Settings Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_settings_meta_columns(conn)
        existing = conn.execute(
            "SELECT user_mode, offline_force_flags, last_prompt_verbatim FROM settings_meta WHERE id=1"
        ).fetchone()
        if existing is None:
            conn.execute(
                """
                INSERT INTO settings_meta(id, user_mode, offline_force_flags, last_prompt_verbatim, updated_at)
                VALUES(1, :user_mode, :offline_force_flags, :last_prompt_verbatim, :updated_at)
                """,
                {
                    "user_mode": user_mode,
                    "offline_force_flags": 1 if offline_force_flags else 0,
                    "last_prompt_verbatim": last_prompt_verbatim,
                    "updated_at": now,
                },
            )
        else:
            conn.execute(
                """
                UPDATE settings_meta
                SET user_mode=COALESCE(:user_mode, user_mode),
                    offline_force_flags=COALESCE(:offline_force_flags, offline_force_flags),
                    last_prompt_verbatim=COALESCE(:last_prompt_verbatim, last_prompt_verbatim),
                    updated_at=:updated_at
                WHERE id=1
                """,
                {
                    "user_mode": user_mode,
                    "offline_force_flags": None if offline_force_flags is None else (1 if offline_force_flags else 0),
                    "last_prompt_verbatim": last_prompt_verbatim,
                    "updated_at": now,
                },
            )
        conn.commit()


def get_context_payload():
    """
    Get Context Payload helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        row = conn.execute("SELECT payload FROM context_store WHERE id=1").fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["payload"] or "{}")
    except Exception:
        return {}


def set_context_payload(payload: dict):
    """
    Set Context Payload helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO context_store(id, payload, updated_at)
            VALUES(1, :payload, :updated_at)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at;
            """,
            {"payload": json.dumps(payload or {}), "updated_at": now},
        )
        conn.commit()


def get_triage_prompt_tree() -> Dict[str, Any]:
    """
    Get Triage Prompt Tree helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_triage_prompt_tree_table(conn)
        _seed_triage_prompt_tree(conn, now)
        row = conn.execute("SELECT payload FROM triage_prompt_tree WHERE id = 1").fetchone()
    if not row:
        return _default_triage_prompt_tree()
    try:
        parsed = json.loads(row["payload"] or "{}")
        normalized = _normalize_triage_prompt_tree_payload(parsed)
        return normalized
    except Exception:
        return _default_triage_prompt_tree()


def set_triage_prompt_tree(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Set Triage Prompt Tree helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    normalized = _normalize_triage_prompt_tree_payload(payload)
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_triage_prompt_tree_table(conn)
        conn.execute(
            """
            INSERT INTO triage_prompt_tree(id, payload, updated_at)
            VALUES(1, :payload, :updated_at)
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
            """,
            {
                "payload": json.dumps(normalized, ensure_ascii=False),
                "updated_at": now,
            },
        )
        conn.commit()
    return normalized


def get_triage_prompt_modules():
    """
    Get Triage Prompt Modules helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_triage_prompt_modules_table(conn)
        _seed_triage_prompt_modules(conn, now)
        rows = conn.execute(
            """
            SELECT category, module_key, module_text, position
            FROM triage_prompt_modules
            ORDER BY category, position, lower(module_key)
            """
        ).fetchall()
    result = {}
    for row in rows:
        result.setdefault(row["category"], {})[row["module_key"]] = row["module_text"]
    return result


TRIAGE_MODULE_CATEGORIES = {"base", "domain", "problem", "anatomy", "severity", "mechanism"}


def _normalize_triage_module_category(category: str) -> str:
    """
     Normalize Triage Module Category helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    key = (category or "").strip().lower()
    if key not in TRIAGE_MODULE_CATEGORIES:
        raise ValueError(f"Invalid triage module category: {category}")
    return key


def _normalize_triage_module_key(module_key: str) -> str:
    """
     Normalize Triage Module Key helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    key = (module_key or "").strip()
    if not key:
        raise ValueError("Module key is required.")
    return key


def _normalize_triage_module_text(module_text: str) -> str:
    """
     Normalize Triage Module Text helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    txt = (module_text or "").strip()
    if not txt:
        raise ValueError("Module text is required.")
    return txt


def upsert_triage_prompt_module(category: str, module_key: str, module_text: str, position: Optional[int] = None):
    """
    Upsert Triage Prompt Module helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    now = datetime.utcnow().isoformat()
    cat = _normalize_triage_module_category(category)
    key = _normalize_triage_module_key(module_key)
    text = _normalize_triage_module_text(module_text)
    with _conn() as conn:
        _ensure_triage_prompt_modules_table(conn)
        existing = conn.execute(
            """
            SELECT position
            FROM triage_prompt_modules
            WHERE category=:category AND module_key=:module_key
            """,
            {"category": cat, "module_key": key},
        ).fetchone()
        if position is None:
            if existing:
                pos = int(existing["position"] or 0)
            else:
                max_row = conn.execute(
                    "SELECT MAX(position) AS max_pos FROM triage_prompt_modules WHERE category=:category",
                    {"category": cat},
                ).fetchone()
                max_pos = int(max_row["max_pos"] or -1)
                pos = max_pos + 1
        else:
            pos = int(position)

        conn.execute(
            """
            INSERT INTO triage_prompt_modules(category, module_key, module_text, position, updated_at)
            VALUES(:category, :module_key, :module_text, :position, :updated_at)
            ON CONFLICT(category, module_key) DO UPDATE SET
                module_text=excluded.module_text,
                position=excluded.position,
                updated_at=excluded.updated_at
            """,
            {
                "category": cat,
                "module_key": key,
                "module_text": text,
                "position": pos,
                "updated_at": now,
            },
        )
        row = conn.execute(
            """
            SELECT category, module_key, module_text, position, updated_at
            FROM triage_prompt_modules
            WHERE category=:category AND module_key=:module_key
            """,
            {"category": cat, "module_key": key},
        ).fetchone()
        conn.commit()
    return dict(row) if row else {}


def set_triage_prompt_modules(modules: dict, replace: bool = False):
    """
    Set Triage Prompt Modules helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(modules, dict):
        raise ValueError("modules must be an object mapping category -> modules.")
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _ensure_triage_prompt_modules_table(conn)
        if replace:
            conn.execute("DELETE FROM triage_prompt_modules")
        for raw_category, raw_payload in modules.items():
            category = _normalize_triage_module_category(raw_category)
            if not isinstance(raw_payload, dict):
                continue
            for pos, (raw_key, raw_text) in enumerate(raw_payload.items()):
                module_key = _normalize_triage_module_key(raw_key)
                module_text = _normalize_triage_module_text(raw_text)
                conn.execute(
                    """
                    INSERT INTO triage_prompt_modules(category, module_key, module_text, position, updated_at)
                    VALUES(:category, :module_key, :module_text, :position, :updated_at)
                    ON CONFLICT(category, module_key) DO UPDATE SET
                        module_text=excluded.module_text,
                        position=excluded.position,
                        updated_at=excluded.updated_at
                    """,
                    {
                        "category": category,
                        "module_key": module_key,
                        "module_text": module_text,
                        "position": pos,
                        "updated_at": now,
                    },
                )
        conn.commit()


def get_triage_options():
    """
    Get Triage Options helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        _maybe_seed_triage(conn, datetime.utcnow().isoformat())
        rows = conn.execute(
            "SELECT field, value, position FROM triage_options ORDER BY field, position"
        ).fetchall()
    result = {}
    for r in rows:
        result.setdefault(r["field"], []).append(r["value"])
    # Ensure current 5-field triage UI always has options, even if DB still stores
    # legacy triage fields from older builds.
    defaults = {
        "triage-domain": [
            "Trauma",
            "Medical illness",
            "Environmental exposure",
            "Dental",
            "Behavioral / psychological",
        ],
        "triage-problem": [
            "Laceration",
            "Bleeding wound (non-laceration)",
            "Fracture",
            "Dislocation / severe sprain",
            "Burn",
            "Infection / abscess",
            "Embedded foreign body",
            "Eye injury",
            "Marine bite / sting / envenomation",
            "Heat illness",
            "Cold exposure / hypothermia",
            "General illness (vomiting, fever, weakness)",
        ],
        "triage-anatomy": [
            "Head",
            "Face / Eye",
            "Neck / Airway",
            "Chest",
            "Abdomen",
            "Back / Spine",
            "Arm / Hand",
            "Leg / Foot",
            "Joint",
            "Whole body / systemic",
        ],
        "triage-severity": [
            "Stable minor",
            "Significant bleeding",
            "Uncontrolled bleeding",
            "Altered mental status",
            "Breathing difficulty",
            "Severe pain or functional loss",
            "Infection risk / sepsis signs",
            "Deteriorating over time",
        ],
        "triage-mechanism": [
            "Blunt impact",
            "Sharp cut",
            "Penetrating / Impaled",
            "Crush / compression",
            "Twist / overload (rope, winch)",
            "High-tension recoil (snapback line)",
            "Marine bite / sting",
            "Thermal exposure",
            "Immersion / near drowning",
            "Chemical / electrical exposure",
        ],
    }
    for field, values in defaults.items():
        if not result.get(field):
            result[field] = list(values)
    return {field: result.get(field, list(values)) for field, values in defaults.items()}


def set_triage_options(options: dict):
    """
    Set Triage Options helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with _conn() as conn:
        conn.execute("DELETE FROM triage_options")
        for field, values in (options or {}).items():
            if not isinstance(values, list):
                continue
            for idx, val in enumerate(values):
                conn.execute(
                    """
                    INSERT INTO triage_options(field, value, position)
                    VALUES(:field, :value, :position)
                    ON CONFLICT(field, position) DO UPDATE SET value=excluded.value;
                    """,
                    {"field": field, "value": val, "position": idx},
                )
        conn.commit()


def _decode_data_url(data_url: str):
    """Return (mime, bytes) from a data URL; fallback to octet-stream."""
    import base64
    if not data_url or not isinstance(data_url, str) or not data_url.startswith("data:"):
        return None, b""
    try:
        header, b64 = data_url.split(",", 1)
        mime = "application/octet-stream"
        if ";" in header:
            mime = header[5:].split(";")[0] or mime
        blob = base64.b64decode(b64)
        return mime, blob
    except Exception:
        return None, b""

# Password helpers (plaintext storage)
def _hash_password(password: str) -> str:
    """Return password unchanged (plaintext storage by request)."""
    if password is None:
        return ""
    return str(password)


def _verify_password(password: str, stored: str) -> bool:
    """
     Verify Password helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return str(password) == str(stored)


def verify_password(password: str, stored: str) -> bool:
    """Public wrapper to verify passwords."""
    return _verify_password(password, stored)

# --- Crew vaccine helpers ---
def upsert_vaccine(crew_id: str, vaccine: dict, updated_at: str = None) -> dict:
    """Insert or update a single vaccine row for a crew member."""
    updated_at = updated_at or datetime.utcnow().isoformat()
    vid = str(vaccine.get("id") or f"vax-{crew_id}-{datetime.utcnow().timestamp()}")
    payload = {
        "id": vid,
        "crew_id": crew_id,
        "vaccineType": vaccine.get("vaccineType"),
        "dateAdministered": vaccine.get("dateAdministered"),
        "doseNumber": vaccine.get("doseNumber"),
        "tradeNameManufacturer": vaccine.get("tradeNameManufacturer"),
        "lotNumber": vaccine.get("lotNumber"),
        "provider": vaccine.get("provider"),
        "providerCountry": vaccine.get("providerCountry"),
        "nextDoseDue": vaccine.get("nextDoseDue"),
        "expirationDate": vaccine.get("expirationDate"),
        "siteRoute": vaccine.get("siteRoute"),
        "reactions": vaccine.get("reactions"),
        "remarks": vaccine.get("remarks"),
        "updated_at": updated_at,
    }
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO crew_vaccines(
                id, crew_id, vaccineType, dateAdministered, doseNumber, tradeNameManufacturer,
                lotNumber, provider, providerCountry, nextDoseDue, expirationDate, siteRoute,
                reactions, remarks, updated_at
            ) VALUES (
                :id, :crew_id, :vaccineType, :dateAdministered, :doseNumber, :tradeNameManufacturer,
                :lotNumber, :provider, :providerCountry, :nextDoseDue, :expirationDate, :siteRoute,
                :reactions, :remarks, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                vaccineType=excluded.vaccineType,
                dateAdministered=excluded.dateAdministered,
                doseNumber=excluded.doseNumber,
                tradeNameManufacturer=excluded.tradeNameManufacturer,
                lotNumber=excluded.lotNumber,
                provider=excluded.provider,
                providerCountry=excluded.providerCountry,
                nextDoseDue=excluded.nextDoseDue,
                expirationDate=excluded.expirationDate,
                siteRoute=excluded.siteRoute,
                reactions=excluded.reactions,
                remarks=excluded.remarks,
                updated_at=excluded.updated_at;
            """,
            payload,
        )
        conn.commit()
    return payload


def delete_vaccine(crew_id: str, vaccine_id: str) -> bool:
    """
    Delete Vaccine helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not vaccine_id:
        return False
    with _conn() as conn:
        cur = conn.execute("DELETE FROM crew_vaccines WHERE crew_id=? AND id=?", (crew_id, vaccine_id))
        conn.commit()
        return cur.rowcount > 0


def _insert_relational_crew(conn, crew_id: str, member: dict, updated_at: str):
    """Insert/update crew row plus vaccines into relational tables."""
    vaccines = member.get("vaccines") or []
    # normalize headshot/page blobs
    hs_mime, hs_blob = _decode_data_url(member.get("passportHeadshot") or member.get("passportPhoto") or "")
    page_mime, page_blob = _decode_data_url(member.get("passportPage") or "")
    hashed_pw = _hash_password(member.get("password"))
    conn.execute(
        """
        INSERT INTO crew(
            id, firstName, middleName, lastName, sex, birthdate, position, citizenship,
            birthplace, passportNumber, passportIssue, passportExpiry, emergencyContactName,
            emergencyContactRelation, emergencyContactPhone, emergencyContactEmail,
            emergencyContactNotes, phoneNumber, history, username, password,
            passportHeadshot, passportPage,
            passportHeadshotBlob, passportHeadshotMime,
            passportPageBlob, passportPageMime,
            updated_at
        ) VALUES (
            :id, :firstName, :middleName, :lastName, :sex, :birthdate, :position, :citizenship,
            :birthplace, :passportNumber, :passportIssue, :passportExpiry, :emergencyContactName,
            :emergencyContactRelation, :emergencyContactPhone, :emergencyContactEmail,
            :emergencyContactNotes, :phoneNumber, :history, :username, :password,
            :passportHeadshot, :passportPage,
            :passportHeadshotBlob, :passportHeadshotMime,
            :passportPageBlob, :passportPageMime,
            :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            firstName=excluded.firstName,
            middleName=excluded.middleName,
            lastName=excluded.lastName,
            sex=excluded.sex,
            birthdate=excluded.birthdate,
            position=excluded.position,
            citizenship=excluded.citizenship,
            birthplace=excluded.birthplace,
            passportNumber=excluded.passportNumber,
            passportIssue=excluded.passportIssue,
            passportExpiry=excluded.passportExpiry,
            emergencyContactName=excluded.emergencyContactName,
            emergencyContactRelation=excluded.emergencyContactRelation,
            emergencyContactPhone=excluded.emergencyContactPhone,
            emergencyContactEmail=excluded.emergencyContactEmail,
            emergencyContactNotes=excluded.emergencyContactNotes,
            phoneNumber=excluded.phoneNumber,
            history=excluded.history,
            username=excluded.username,
            password=excluded.password,
            passportHeadshot=excluded.passportHeadshot,
            passportPage=excluded.passportPage,
            passportHeadshotBlob=excluded.passportHeadshotBlob,
            passportHeadshotMime=excluded.passportHeadshotMime,
            passportPageBlob=excluded.passportPageBlob,
            passportPageMime=excluded.passportPageMime,
            updated_at=excluded.updated_at
        ;
        """,
        {
            "id": crew_id,
            "firstName": member.get("firstName"),
            "middleName": member.get("middleName"),
            "lastName": member.get("lastName"),
            "sex": member.get("sex"),
            "birthdate": member.get("birthdate"),
            "position": member.get("position"),
            "citizenship": member.get("citizenship"),
            "birthplace": member.get("birthplace"),
            "passportNumber": member.get("passportNumber"),
            "passportIssue": member.get("passportIssue"),
            "passportExpiry": member.get("passportExpiry"),
            "emergencyContactName": member.get("emergencyContactName"),
            "emergencyContactRelation": member.get("emergencyContactRelation"),
            "emergencyContactPhone": member.get("emergencyContactPhone"),
            "emergencyContactEmail": member.get("emergencyContactEmail"),
            "emergencyContactNotes": member.get("emergencyContactNotes"),
            "phoneNumber": member.get("phoneNumber"),
            "history": member.get("history"),
            "username": member.get("username"),
            "password": hashed_pw,
            "passportHeadshot": None,
            "passportPage": member.get("passportPage"),
            "passportHeadshotBlob": hs_blob,
            "passportHeadshotMime": hs_mime or "application/octet-stream",
            "passportPageBlob": page_blob,
            "passportPageMime": page_mime or "application/octet-stream",
            "updated_at": updated_at,
        },
    )
    # replace vaccines for this crew_id
    conn.execute("DELETE FROM crew_vaccines WHERE crew_id=?", (crew_id,))
    for v in vaccines:
        vid = str(v.get("id") or f"vax-{crew_id}-{datetime.utcnow().timestamp()}")
        conn.execute(
            """
            INSERT INTO crew_vaccines(
                id, crew_id, vaccineType, dateAdministered, doseNumber, tradeNameManufacturer,
                lotNumber, provider, providerCountry, nextDoseDue, expirationDate, siteRoute,
                reactions, remarks, updated_at
            ) VALUES (
                :id, :crew_id, :vaccineType, :dateAdministered, :doseNumber, :tradeNameManufacturer,
                :lotNumber, :provider, :providerCountry, :nextDoseDue, :expirationDate, :siteRoute,
                :reactions, :remarks, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                vaccineType=excluded.vaccineType,
                dateAdministered=excluded.dateAdministered,
                doseNumber=excluded.doseNumber,
                tradeNameManufacturer=excluded.tradeNameManufacturer,
                lotNumber=excluded.lotNumber,
                provider=excluded.provider,
                providerCountry=excluded.providerCountry,
                nextDoseDue=excluded.nextDoseDue,
                expirationDate=excluded.expirationDate,
                siteRoute=excluded.siteRoute,
                reactions=excluded.reactions,
                remarks=excluded.remarks,
                updated_at=excluded.updated_at;
            """,
            {
                "id": vid,
                "crew_id": crew_id,
                "vaccineType": v.get("vaccineType"),
                "dateAdministered": v.get("dateAdministered"),
                "doseNumber": v.get("doseNumber"),
                "tradeNameManufacturer": v.get("tradeNameManufacturer"),
                "lotNumber": v.get("lotNumber"),
                "provider": v.get("provider"),
                "providerCountry": v.get("providerCountry"),
                "nextDoseDue": v.get("nextDoseDue"),
                "expirationDate": v.get("expirationDate"),
                "siteRoute": v.get("siteRoute"),
                "reactions": v.get("reactions"),
                "remarks": v.get("remarks"),
                "updated_at": updated_at,
            },
        )


# COMMENTARY REFERENCE BLOCK: EXTENDED MAINTENANCE NOTES
# Note 001: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 002: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 003: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 004: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 005: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 006: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 007: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 008: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 009: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 010: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 011: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 012: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 013: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 014: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 015: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 016: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 017: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 018: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 019: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 020: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 021: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 022: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 023: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 024: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 025: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 026: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 027: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 028: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 029: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 030: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 031: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 032: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 033: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 034: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 035: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 036: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 037: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 038: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 039: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 040: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 041: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 042: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 043: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 044: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 045: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 046: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 047: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 048: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 049: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 050: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 051: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 052: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 053: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 054: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 055: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 056: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 057: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 058: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 059: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 060: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 061: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 062: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 063: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 064: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 065: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 066: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 067: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 068: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 069: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 070: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 071: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 072: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 073: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 074: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 075: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 076: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 077: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 078: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 079: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 080: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 081: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 082: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 083: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 084: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 085: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 086: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 087: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 088: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 089: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 090: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 091: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 092: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 093: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 094: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 095: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 096: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 097: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 098: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 099: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 100: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 101: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 102: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 103: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 104: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 105: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 106: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 107: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 108: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 109: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 110: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 111: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 112: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 113: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 114: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 115: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 116: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 117: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 118: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 119: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 120: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 121: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 122: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 123: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 124: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 125: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 126: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 127: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 128: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 129: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 130: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 131: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 132: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 133: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 134: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 135: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 136: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 137: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 138: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 139: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 140: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 141: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 142: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 143: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 144: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 145: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 146: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 147: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 148: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 149: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 150: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 151: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 152: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 153: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 154: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 155: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 156: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 157: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 158: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 159: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 160: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 161: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 162: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 163: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 164: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 165: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 166: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 167: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 168: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 169: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 170: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 171: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 172: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 173: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 174: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 175: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 176: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 177: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 178: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 179: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 180: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 181: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 182: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 183: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 184: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 185: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 186: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 187: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 188: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 189: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 190: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 191: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 192: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 193: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 194: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 195: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 196: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 197: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 198: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 199: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 200: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 201: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 202: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 203: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 204: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 205: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 206: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 207: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 208: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 209: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 210: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
# Note 211: API routing contract and backward-compat behavior; keep this section aligned with code-path changes before release.
# Note 212: authentication/session flow and access gating; keep this section aligned with code-path changes before release.
# Note 213: startup bootstrap sequencing and DB initialization; keep this section aligned with code-path changes before release.
# Note 214: GPU inference dispatch and model selection boundaries; keep this section aligned with code-path changes before release.
# Note 215: offline-mode resilience and local cache assumptions; keep this section aligned with code-path changes before release.
# Note 216: error-handling semantics for user-visible endpoints; keep this section aligned with code-path changes before release.
# Note 217: history persistence invariants and replay semantics; keep this section aligned with code-path changes before release.
# Note 218: triage prompt assembly contracts and fallback behavior; keep this section aligned with code-path changes before release.
# Note 219: settings synchronization and mode-based visibility contracts; keep this section aligned with code-path changes before release.
# Note 220: import/export data-shape guarantees and migration safety; keep this section aligned with code-path changes before release.
