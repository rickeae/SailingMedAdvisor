"""
File: db_store.py
Author notes: Centralized persistence layer for SailingMedAdvisor. I keep all
SQLite schema definitions, convenience getters/setters, and upgrade/seed helpers
here so every API handler can stay focused on business logic instead of SQL.
"""

import json
import shutil
import sqlite3
import logging
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Any, Dict

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
            CREATE TABLE IF NOT EXISTS model_params (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                triage_instruction TEXT,
                inquiry_instruction TEXT,
                tr_temp REAL,
                tr_tok INTEGER,
                tr_p REAL,
                in_temp REAL,
                in_tok INTEGER,
                in_p REAL,
                mission_context TEXT,
                rep_penalty REAL,
                med_photo_model TEXT,
                med_photo_prompt TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings_meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                user_mode TEXT,
                offline_force_flags INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS med_photo_queue (
                id TEXT PRIMARY KEY,
                status TEXT,
                data TEXT,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS med_photo_jobs (
                id TEXT PRIMARY KEY,
                status TEXT,
                data TEXT,
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
            CREATE TABLE IF NOT EXISTS triage_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                situation TEXT,
                chat_text TEXT,
                responsive TEXT,
                breathing TEXT,
                pain TEXT,
                main_problem TEXT,
                temp TEXT,
                circulation TEXT,
                cause TEXT,
                updated_at TEXT NOT NULL
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
            in_temp REAL,
            in_tok INTEGER,
            in_p REAL,
            mission_context TEXT,
            rep_penalty REAL,
            med_photo_model TEXT,
            med_photo_prompt TEXT,
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
                    id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p,
                    in_temp, in_tok, in_p, mission_context, rep_penalty,
                    med_photo_model, med_photo_prompt, updated_at
                ) VALUES (
                    1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p,
                    :in_temp, :in_tok, :in_p, :mission_context, :rep_penalty,
                    :med_photo_model, :med_photo_prompt, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    triage_instruction=excluded.triage_instruction,
                    inquiry_instruction=excluded.inquiry_instruction,
                    tr_temp=excluded.tr_temp,
                    tr_tok=excluded.tr_tok,
                    tr_p=excluded.tr_p,
                    in_temp=excluded.in_temp,
                    in_tok=excluded.in_tok,
                    in_p=excluded.in_p,
                    mission_context=excluded.mission_context,
                    rep_penalty=excluded.rep_penalty,
                    med_photo_model=excluded.med_photo_model,
                    med_photo_prompt=excluded.med_photo_prompt,
                    updated_at=excluded.updated_at;
                """,
                {
                    "triage_instruction": data.get("triage_instruction"),
                    "inquiry_instruction": data.get("inquiry_instruction"),
                    "tr_temp": data.get("tr_temp"),
                    "tr_tok": data.get("tr_tok"),
                    "tr_p": data.get("tr_p"),
                    "in_temp": data.get("in_temp"),
                    "in_tok": data.get("in_tok"),
                    "in_p": data.get("in_p"),
                    "mission_context": data.get("mission_context"),
                    "rep_penalty": data.get("rep_penalty"),
                    "med_photo_model": data.get("med_photo_model"),
                    "med_photo_prompt": data.get("med_photo_prompt"),
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
        iid = str(item.get("id") or f"item-{datetime.utcnow().timestamp()}")
        conn.execute(
            """
            INSERT OR REPLACE INTO items(
                id, itemType, name, genericName, brandName, alsoKnownAs, formStrength,
                indications, contraindications, consultDoctor, adultDosage, pediatricDosage,
                unwantedEffects, storageLocation, subLocation, status, expiryDate,
                lastInspection, batteryType, batteryStatus, calibrationDue, totalQty,
                minPar, supplier, parentId, requiresPower, category, typeDetail, notes,
                excludeFromResources, updated_at
            ) VALUES (
                :id, :itemType, :name, :genericName, :brandName, :alsoKnownAs, :formStrength,
                :indications, :contraindications, :consultDoctor, :adultDosage, :pediatricDosage,
                :unwantedEffects, :storageLocation, :subLocation, :status, :expiryDate,
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
    conn.execute(
        """
        INSERT INTO settings_meta(id, user_mode, offline_force_flags, updated_at)
        VALUES(1, :user_mode, :offline_force_flags, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
            user_mode=excluded.user_mode,
            offline_force_flags=excluded.offline_force_flags,
            updated_at=excluded.updated_at;
        """,
        {"user_mode": user_mode, "offline_force_flags": offline_force_flags, "updated_at": now},
    )
    conn.commit()


def _maybe_migrate_med_photo(conn, now):
    """Move med_photo_queue/jobs and context from documents into dedicated tables."""
    for cat, table in (("med_photo_queue", "med_photo_queue"), ("med_photo_jobs", "med_photo_jobs")):
        row = conn.execute("SELECT payload FROM documents WHERE category=?", (cat,)).fetchone()
        if row:
            try:
                items = json.loads(row["payload"] or "[]") or []
            except Exception:
                items = []
            conn.execute(f"DELETE FROM {table}")
            for item in items:
                conn.execute(
                    f"""
                    INSERT INTO {table}(id, status, data, updated_at)
                    VALUES(:id, :status, :data, :updated_at)
                    ON CONFLICT(id) DO UPDATE SET
                        status=excluded.status,
                        data=excluded.data,
                        updated_at=excluded.updated_at;
                    """,
                    {
                        "id": str(item.get("id") or item.get("job_id") or item.get("file") or f"{table}-{now}"),
                        "status": item.get("status"),
                        "data": json.dumps(item),
                        "updated_at": now,
                    },
                )
            conn.execute("DELETE FROM documents WHERE category=?", (cat,))
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
    """Seed triage samples/options from bundled JSON if tables are empty."""
    count = conn.execute("SELECT COUNT(*) FROM triage_samples").fetchone()[0]
    if count == 0:
        json_path = Path(__file__).parent / "static" / "data" / "triage_samples.json"
        if json_path.exists():
            try:
                samples = json.loads(json_path.read_text())
                for s in samples:
                    conn.execute(
                        """
                        INSERT INTO triage_samples(
                            id, situation, chat_text, responsive, breathing, pain, main_problem,
                            temp, circulation, cause, updated_at
                        ) VALUES (
                            :id, :situation, :chat_text, :responsive, :breathing, :pain, :main_problem,
                            :temp, :circulation, :cause, :updated_at
                        )
                        ON CONFLICT(id) DO UPDATE SET
                            situation=excluded.situation,
                            chat_text=excluded.chat_text,
                            responsive=excluded.responsive,
                            breathing=excluded.breathing,
                            pain=excluded.pain,
                            main_problem=excluded.main_problem,
                            temp=excluded.temp,
                            circulation=excluded.circulation,
                            cause=excluded.cause,
                            updated_at=excluded.updated_at;
                        """,
                        {
                            "id": s.get("id"),
                            "situation": s.get("situation"),
                            "chat_text": s.get("chat_text"),
                            "responsive": s.get("responsive"),
                            "breathing": s.get("breathing"),
                            "pain": s.get("pain"),
                            "main_problem": s.get("main_problem"),
                            "temp": s.get("temp"),
                            "circulation": s.get("circulation"),
                            "cause": s.get("cause"),
                            "updated_at": now,
                        },
                    )
            except Exception:
                pass
    opt_count = conn.execute("SELECT COUNT(*) FROM triage_options").fetchone()[0]
    if opt_count == 0:
        defaults = {
            "triage-consciousness": [
                "Awake and acting normally",
                "Awake but confused or very drowsy",
                "Responds only when spoken to",
                "Responds only to pain (pinch, pressure)",
                "Not responding at all",
            ],
            "triage-breathing-status": [
                "Breathing normally on their own",
                "Breathing fast or struggling",
                "Wheezing / gasping / very noisy",
                "Using oxygen (nasal prongs or mask)",
                "On breathing machine (CPAP / ventilator)",
                "Not breathing",
            ],
            "triage-pain-level": [
                "No pain",
                "Mild pain",
                "Moderate pain",
                "Severe pain",
                "Worst pain imaginable",
            ],
            "triage-main-problem": [
                "Chest pain / heart problem",
                "Trouble breathing",
                "Stroke-like symptoms (weakness, speech, face)",
                "Severe headache or seizure",
                "Abdominal pain / vomiting / bleeding",
                "Major bleeding or amputation",
                "Severe injury (crush, fracture, impalement)",
                "Allergic reaction / anaphylaxis",
                "Severe infection or sepsis signs",
                "Eye injury or vision loss",
                "Severe burn",
                "Other / not listed",
            ],
            "triage-temperature": [
                "Very low / hypothermic (<35°C)",
                "Low (35–36°C)",
                "Normal (36–37.5°C)",
                "Mild fever (37.6–38.4°C)",
                "High fever (≥38.5°C)",
                "Unknown",
            ],
            "triage-circulation": [
                "Normal color, warm skin, strong pulse",
                "Pale/clammy, weak pulse",
                "Blue/purple lips or fingers",
                "Heavy external bleeding",
                "No pulse / cardiac arrest",
            ],
            "triage-cause": [
                "Fall / blunt trauma",
                "Penetrating object",
                "Burn / electrical / lightning",
                "Allergic reaction / sting",
                "Infection / fever",
                "Dehydration / heat illness",
                "Cold exposure / hypothermia",
                "Cardiac cause",
                "Stroke / neuro",
                "Poisoning / toxin / gas",
                "Other / unclear",
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
            in_temp REAL,
            in_tok INTEGER,
            in_p REAL,
            mission_context TEXT,
            rep_penalty REAL,
            med_photo_model TEXT,
            med_photo_prompt TEXT,
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
                    id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p,
                    in_temp, in_tok, in_p, mission_context, rep_penalty,
                    med_photo_model, med_photo_prompt, updated_at
                ) VALUES (
                    1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p,
                    :in_temp, :in_tok, :in_p, :mission_context, :rep_penalty,
                    :med_photo_model, :med_photo_prompt, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    triage_instruction=excluded.triage_instruction,
                    inquiry_instruction=excluded.inquiry_instruction,
                    tr_temp=excluded.tr_temp,
                    tr_tok=excluded.tr_tok,
                    tr_p=excluded.tr_p,
                    in_temp=excluded.in_temp,
                    in_tok=excluded.in_tok,
                    in_p=excluded.in_p,
                    mission_context=excluded.mission_context,
                    rep_penalty=excluded.rep_penalty,
                    med_photo_model=excluded.med_photo_model,
                    med_photo_prompt=excluded.med_photo_prompt,
                    updated_at=excluded.updated_at;
                """,
                {
                    "triage_instruction": data.get("triage_instruction"),
                    "inquiry_instruction": data.get("inquiry_instruction"),
                    "tr_temp": data.get("tr_temp"),
                    "tr_tok": data.get("tr_tok"),
                    "tr_p": data.get("tr_p"),
                    "in_temp": data.get("in_temp"),
                    "in_tok": data.get("in_tok"),
                    "in_p": data.get("in_p"),
                    "mission_context": data.get("mission_context"),
                    "rep_penalty": data.get("rep_penalty"),
                    "med_photo_model": data.get("med_photo_model"),
                    "med_photo_prompt": data.get("med_photo_prompt"),
                    "updated_at": now,
                },
            )
        conn.commit()


def _upgrade_schema():
    """Ensure schema is up to date (idempotent). I keep this minimal so startup stays fast."""
    try:
        with _conn() as conn:
            now = datetime.utcnow().isoformat()
            _maybe_seed_triage(conn, now)
            _maybe_import_who_meds(conn, now)
            # Drop legacy documents tables if they linger
            conn.execute("DROP TABLE IF EXISTS documents")
            conn.execute("DROP TABLE IF EXISTS documents_old")
            conn.commit()
    except Exception:
        pass


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
    import re

    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"


def _upsert_vessel(conn, data: dict, updated_at: str):
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
    }
    merged = {**default, **(data or {})}
    conn.execute(
        """
        INSERT INTO vessel(
            id, vesselName, registrationNumber, flagCountry, homePort, callSign,
            tonnage, netTonnage, mmsi, hullNumber, starboardEngine, starboardEngineSn,
            portEngine, portEngineSn, ribSn, updated_at
        ) VALUES (1, :vesselName, :registrationNumber, :flagCountry, :homePort, :callSign,
                  :tonnage, :netTonnage, :mmsi, :hullNumber, :starboardEngine, :starboardEngineSn,
                  :portEngine, :portEngineSn, :ribSn, :updated_at)
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
            updated_at=excluded.updated_at;
        """,
        {**merged, "updated_at": updated_at},
    )


def get_vessel() -> dict:
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT vesselName, registrationNumber, flagCountry, homePort, callSign,
                   tonnage, netTonnage, mmsi, hullNumber, starboardEngine, starboardEngineSn,
                   portEngine, portEngineSn, ribSn, updated_at
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
        "updated_at",
    ]
    return {k: row[idx] for idx, k in enumerate(keys)}


def set_vessel(data: dict):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _upsert_vessel(conn, data or {}, now)
        conn.commit()


# --- Crew helpers ---

def _replace_crew(conn, crew_list: list, updated_at: str):
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


def get_credentials_rows():
    """Return minimal credential info for auth (username + hashed password)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, username, password FROM crew WHERE username IS NOT NULL AND username != ''"
        ).fetchall()
    return [dict(r) for r in rows]


def set_patients(members: list):
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
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM vaccine_types ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def load_pharmacy_labels():
    with _conn() as conn:
        rows = conn.execute("SELECT name FROM pharmacy_labels ORDER BY position ASC").fetchall()
    return [r["name"] for r in rows]


def get_model_params():
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p,
                   in_temp, in_tok, in_p, mission_context, rep_penalty,
                   med_photo_model, med_photo_prompt
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
        "in_temp",
        "in_tok",
        "in_p",
        "mission_context",
        "rep_penalty",
        "med_photo_model",
        "med_photo_prompt",
    ]
    return {k: row[idx] for idx, k in enumerate(keys)}


def set_model_params(data: dict):
    now = datetime.utcnow().isoformat()
    params = data or {}
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO model_params(
                id, triage_instruction, inquiry_instruction, tr_temp, tr_tok, tr_p,
                in_temp, in_tok, in_p, mission_context, rep_penalty,
                med_photo_model, med_photo_prompt, updated_at
            ) VALUES (
                1, :triage_instruction, :inquiry_instruction, :tr_temp, :tr_tok, :tr_p,
                :in_temp, :in_tok, :in_p, :mission_context, :rep_penalty,
                :med_photo_model, :med_photo_prompt, :updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                triage_instruction=excluded.triage_instruction,
                inquiry_instruction=excluded.inquiry_instruction,
                tr_temp=excluded.tr_temp,
                tr_tok=excluded.tr_tok,
                tr_p=excluded.tr_p,
                in_temp=excluded.in_temp,
                in_tok=excluded.in_tok,
                in_p=excluded.in_p,
                mission_context=excluded.mission_context,
                rep_penalty=excluded.rep_penalty,
                med_photo_model=excluded.med_photo_model,
                med_photo_prompt=excluded.med_photo_prompt,
                updated_at=excluded.updated_at;
            """,
            {
                "triage_instruction": params.get("triage_instruction"),
                "inquiry_instruction": params.get("inquiry_instruction"),
                "tr_temp": params.get("tr_temp"),
                "tr_tok": params.get("tr_tok"),
                "tr_p": params.get("tr_p"),
                "in_temp": params.get("in_temp"),
                "in_tok": params.get("in_tok"),
                "in_p": params.get("in_p"),
                "mission_context": params.get("mission_context"),
                "rep_penalty": params.get("rep_penalty"),
                "med_photo_model": params.get("med_photo_model"),
                "med_photo_prompt": params.get("med_photo_prompt"),
                "updated_at": now,
            },
        )
        conn.commit()


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
        "notes": d["notes"],
        "excludeFromResources": bool(d["excludeFromResources"]),
    }
    # for pharma, set type explicitly to 'pharma'
    if d["itemType"] == "pharma":
        item["type"] = "pharma"
    return item


def get_inventory_items():
    # Pull pharma items plus their per-expiry rows; keep a dict keyed by item_id for quick attach.
    with _conn() as conn:
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
    This is intentionally forgiving so legacy keys keep working.
    """
    def pick(*keys, default=""):
        for k in keys:
            if k in item and item[k] is not None:
                return item[k]
        return default

    iid = str(item.get("id") or f"{item_type}-{datetime.utcnow().timestamp()}")
    # Compose a friendly display name, preferring brand then generic.
    name = pick("name", "brandName", "genericName", default="")
    generic = pick("genericName", default="")
    brand = pick("brandName", default="")
    form = pick("form", default="")
    strength = pick("strength", default="")
    form_strength = pick("formStrength", default="").strip()
    if not form_strength:
        form_strength = " ".join([form, strength]).strip()

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
        "expiryDate": pick("expiryDate", default=""),
        "lastInspection": pick("lastInspection", default=""),
        "batteryType": pick("batteryType", default=""),
        "batteryStatus": pick("batteryStatus", default=""),
        "calibrationDue": pick("calibrationDue", default=""),
        "totalQty": pick("totalQty", "currentQuantity", default=""),
        "minPar": pick("minPar", "minThreshold", default=""),
        "supplier": pick("supplier", "manufacturer", default=""),
        "parentId": pick("parentId", default=""),
        "requiresPower": 1 if item.get("requiresPower") else 0,
        "category": category,
        "typeDetail": type_detail,
        "notes": pick("notes", default=""),
        "excludeFromResources": 1 if item.get("excludeFromResources") else 0,
        "updated_at": now,
    }


def set_inventory_items(items: list):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM items WHERE itemType='pharma'")
        conn.execute("DELETE FROM med_expiries")
        for item in items or []:
            # Normalize incoming dict, then upsert the parent row and its child expiry rows.
            item = ensure_item_schema(item, "pharma", now)
            _insert_item(conn, item, "pharma", now)
            for ph in item.get("purchaseHistory") or []:
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
                    {
                        "id": ph.get("id") or f"ph-{datetime.utcnow().timestamp()}",
                        "item_id": item["id"],
                        "date": ph.get("date"),
                        "quantity": ph.get("quantity"),
                        "notes": ph.get("notes"),
                        "manufacturer": ph.get("manufacturer"),
                        "batchLot": ph.get("batchLot"),
                        "updated_at": now,
                    },
                )
        conn.commit()


def get_tool_items():
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM items WHERE itemType!='pharma' ORDER BY updated_at DESC").fetchall()
    return [_row_to_item(r) for r in rows]


def set_tool_items(items: list):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM items WHERE itemType!='pharma'")
        for item in items or []:
            item_type = "consumable" if (item.get("type") or "").lower() == "consumable" else "equipment"
            _insert_item(conn, item, item_type, now)
        conn.commit()


def _insert_item(conn, item: dict, item_type: str, updated_at: str):
    conn.execute(
        """
        INSERT INTO items(
            id, itemType, name, genericName, brandName, alsoKnownAs, formStrength,
            indications, contraindications, consultDoctor, adultDosage, pediatricDosage,
            unwantedEffects, storageLocation, subLocation, status, expiryDate,
            lastInspection, batteryType, batteryStatus, calibrationDue, totalQty,
            minPar, supplier, parentId, requiresPower, category, typeDetail, notes,
            excludeFromResources, updated_at
        ) VALUES (
            :id, :itemType, :name, :genericName, :brandName, :alsoKnownAs, :formStrength,
            :indications, :contraindications, :consultDoctor, :adultDosage, :pediatricDosage,
            :unwantedEffects, :storageLocation, :subLocation, :status, :expiryDate,
            :lastInspection, :batteryType, :batteryStatus, :calibrationDue, :totalQty,
            :minPar, :supplier, :parentId, :requiresPower, :category, :typeDetail, :notes,
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
            "updated_at": updated_at,
        },
    )
    return True


def get_history_entries():
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


def set_history_entries(entries: list):
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


def get_chats():
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
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM chats")
        _insert_chats(conn, chats or [], now)


def get_chat_metrics():
    with _conn() as conn:
        rows = conn.execute(
            "SELECT model, count, total_ms, avg_ms FROM chat_metrics"
        ).fetchall()
    return {r["model"]: {"count": r["count"], "total_ms": r["total_ms"], "avg_ms": r["avg_ms"]} for r in rows}


def set_chat_metrics(metrics: dict):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        _replace_chat_metrics(conn, metrics or {}, now)


def get_settings_meta():
    with _conn() as conn:
        row = conn.execute(
            "SELECT user_mode, offline_force_flags FROM settings_meta WHERE id=1"
        ).fetchone()
    if not row:
        return {}
    return {
        "user_mode": row["user_mode"],
        "offline_force_flags": bool(row["offline_force_flags"]),
    }


def set_settings_meta(user_mode: str = None, offline_force_flags: bool = None):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        existing = conn.execute("SELECT user_mode, offline_force_flags FROM settings_meta WHERE id=1").fetchone()
        if existing is None:
            conn.execute(
                """
                INSERT INTO settings_meta(id, user_mode, offline_force_flags, updated_at)
                VALUES(1, :user_mode, :offline_force_flags, :updated_at)
                """,
                {"user_mode": user_mode, "offline_force_flags": 1 if offline_force_flags else 0, "updated_at": now},
            )
        else:
            conn.execute(
                """
                UPDATE settings_meta
                SET user_mode=:user_mode,
                    offline_force_flags=:offline_force_flags,
                    updated_at=:updated_at
                WHERE id=1
                """,
                {"user_mode": user_mode, "offline_force_flags": 1 if offline_force_flags else 0, "updated_at": now},
            )
        conn.commit()


def get_med_photo_queue_rows():
    with _conn() as conn:
        rows = conn.execute("SELECT id, status, data, updated_at FROM med_photo_queue ORDER BY datetime(updated_at) DESC").fetchall()
    result = []
    for r in rows:
        try:
            parsed = json.loads(r["data"] or "{}")
        except Exception:
            parsed = {}
        parsed.setdefault("id", r["id"])
        parsed.setdefault("status", r["status"])
        parsed["updated_at"] = r["updated_at"]
        result.append(parsed)
    return result


def set_med_photo_queue_rows(items: list):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM med_photo_queue")
        for item in items or []:
            conn.execute(
                """
                INSERT INTO med_photo_queue(id, status, data, updated_at)
                VALUES(:id, :status, :data, :updated_at)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    data=excluded.data,
                    updated_at=excluded.updated_at;
                """,
                {
                    "id": str(item.get("id") or item.get("job_id") or item.get("file") or f"queue-{now}"),
                    "status": item.get("status"),
                    "data": json.dumps(item),
                    "updated_at": item.get("updated_at") or now,
                },
            )
        conn.commit()


def get_med_photo_jobs_rows():
    with _conn() as conn:
        rows = conn.execute("SELECT id, status, data, updated_at FROM med_photo_jobs ORDER BY datetime(updated_at) DESC").fetchall()
    result = []
    for r in rows:
        try:
            parsed = json.loads(r["data"] or "{}")
        except Exception:
            parsed = {}
        parsed.setdefault("id", r["id"])
        parsed.setdefault("status", r["status"])
        parsed["updated_at"] = r["updated_at"]
        result.append(parsed)
    return result


def set_med_photo_jobs_rows(items: list):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM med_photo_jobs")
        for item in items or []:
            conn.execute(
                """
                INSERT INTO med_photo_jobs(id, status, data, updated_at)
                VALUES(:id, :status, :data, :updated_at)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    data=excluded.data,
                    updated_at=excluded.updated_at;
                """,
                {
                    "id": str(item.get("id") or item.get("job_id") or item.get("file") or f"job-{now}"),
                    "status": item.get("status"),
                    "data": json.dumps(item),
                    "updated_at": item.get("updated_at") or now,
                },
            )
        conn.commit()


def get_context_payload():
    with _conn() as conn:
        row = conn.execute("SELECT payload FROM context_store WHERE id=1").fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["payload"] or "{}")
    except Exception:
        return {}


def set_context_payload(payload: dict):
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


def get_triage_samples():
    with _conn() as conn:
        _maybe_seed_triage(conn, datetime.utcnow().isoformat())
        rows = conn.execute(
            """
            SELECT id, situation, chat_text, responsive, breathing, pain, main_problem,
                   temp, circulation, cause, updated_at
            FROM triage_samples
            ORDER BY id
            """
        ).fetchall()
    return [dict(r) for r in rows]


def set_triage_samples(samples: list):
    now = datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("DELETE FROM triage_samples")
        for s in samples or []:
            conn.execute(
                """
                INSERT INTO triage_samples(
                    id, situation, chat_text, responsive, breathing, pain, main_problem,
                    temp, circulation, cause, updated_at
                ) VALUES (
                    :id, :situation, :chat_text, :responsive, :breathing, :pain, :main_problem,
                    :temp, :circulation, :cause, :updated_at
                )
                ON CONFLICT(id) DO UPDATE SET
                    situation=excluded.situation,
                    chat_text=excluded.chat_text,
                    responsive=excluded.responsive,
                    breathing=excluded.breathing,
                    pain=excluded.pain,
                    main_problem=excluded.main_problem,
                    temp=excluded.temp,
                    circulation=excluded.circulation,
                    cause=excluded.cause,
                    updated_at=excluded.updated_at;
                """,
                {
                    "id": s.get("id"),
                    "situation": s.get("situation"),
                    "chat_text": s.get("chat_text"),
                    "responsive": s.get("responsive"),
                    "breathing": s.get("breathing"),
                    "pain": s.get("pain"),
                    "main_problem": s.get("main_problem"),
                    "temp": s.get("temp"),
                    "circulation": s.get("circulation"),
                    "cause": s.get("cause"),
                    "updated_at": s.get("updated_at") or now,
                },
            )
        conn.commit()


def get_triage_options():
    with _conn() as conn:
        _maybe_seed_triage(conn, datetime.utcnow().isoformat())
        rows = conn.execute(
            "SELECT field, value, position FROM triage_options ORDER BY field, position"
        ).fetchall()
    result = {}
    for r in rows:
        result.setdefault(r["field"], []).append(r["value"])
    return result


def set_triage_options(options: dict):
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
