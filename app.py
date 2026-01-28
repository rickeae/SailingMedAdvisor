"""
File: app.py
Author notes: FastAPI entrypoint for SailingMedAdvisor. I define all routes,
startup wiring, and UI-serving helpers here. Keeps the rest of the codebase
focused on domain logic while this file glues HTTP -> db_store + static assets.
"""

import os
import json
import uuid
import sqlite3
import secrets
import shutil
import zipfile
import asyncio
import threading
import base64
import time
import re
import subprocess
import io
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from db_store import (
    configure_db,
    ensure_store,
    get_vessel,
    set_vessel,
    get_patients,
    set_patients,
    delete_patients_doc,
    update_patient_fields,
    upsert_vaccine,
    delete_vaccine,
    get_credentials_rows,
    verify_password,
    replace_vaccine_types,
    replace_pharmacy_labels,
    load_vaccine_types,
    load_pharmacy_labels,
    get_model_params,
    set_model_params,
    get_inventory_items,
    set_inventory_items,
    get_tool_items,
    set_tool_items,
    get_history_entries,
    set_history_entries,
    get_who_medicines,
    get_chats,
    set_chats,
    get_chat_metrics,
    set_chat_metrics,
    get_triage_samples,
    set_triage_samples,
    get_triage_options,
    set_triage_options,
    get_settings_meta,
    set_settings_meta,
    get_med_photo_queue_rows,
    set_med_photo_queue_rows,
    get_med_photo_jobs_rows,
    set_med_photo_jobs_rows,
    get_context_payload,
    set_context_payload,
)

logger = logging.getLogger("uvicorn.error")

# --- Optional startup cleanup (disabled by default to speed launch) ---
def _cleanup_and_report():
    try:
        import subprocess as _sp
        _sp.run("rm -rf ~/.cache/huggingface ~/.cache/torch ~/.cache/pip ~/.cache/*", shell=True, check=False)
        _sp.run("df -h && du -sh /home/user /home/user/* ~/.cache 2>/dev/null | sort -hr | head -30", shell=True, check=False)
    except Exception as exc:
        print(f"[startup-cleanup] failed: {exc}")

if os.environ.get("STARTUP_CLEANUP") == "1":
    _cleanup_and_report()

# --- Environment tuning for model runtime (VRAM, offline flags, cache paths) ---
# Encourage less fragmentation on GPUs with limited VRAM (e.g., RTX 5000)
# Use the current environment variable name to avoid deprecation warnings
os.environ.pop("PYTORCH_CUDA_ALLOC_CONF", None)
os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")
# Allow online downloads by default (HF Spaces first run needs this). You can set these to "1" after caches are warm.
os.environ.setdefault("HF_HUB_OFFLINE", "0")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
AUTO_DOWNLOAD_MODELS = os.environ.get("AUTO_DOWNLOAD_MODELS", "1" if os.environ.get("HUGGINGFACE_SPACE_ID") else "0") == "1"
# Default off for faster startup; set to "1" when you explicitly want cache verification
VERIFY_MODELS_ON_START = os.environ.get("VERIFY_MODELS_ON_START", "0") == "1"
# Background model verification/download when online (non-blocking) — default off for speed
AUTO_VERIFY_ONLINE = os.environ.get("AUTO_VERIFY_ONLINE", "0") == "1"
# On HF Spaces, avoid local inference; edge/offline installs keep it enabled.
IS_HF_SPACE = bool(
    os.environ.get("HUGGINGFACE_SPACE_ID")
    or os.environ.get("SPACE_ID")
    or os.environ.get("HF_SPACE")
    or os.environ.get("HUGGINGFACE_SPACE")
)
DISABLE_LOCAL_INFERENCE = os.environ.get("DISABLE_LOCAL_INFERENCE") == "1" or IS_HF_SPACE

# Remote inference (used when local is disabled, e.g., on HF Space)
HF_REMOTE_TOKEN = (
    os.environ.get("HF_REMOTE_TOKEN")
    or os.environ.get("HUGGINGFACE_TOKEN")
    or os.environ.get("MEDGEMMA_TOKEN")
    or ""
)
# Default remote text model; when MedGemma 4B/27B is selected we pass that through instead.
REMOTE_MODEL = os.environ.get("REMOTE_MODEL") or "google/medgemma-1.5-4b-it"

import torch

from fastapi import Body, FastAPI, Request, HTTPException, status, Depends, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image
from functools import lru_cache
from starlette.middleware.sessions import SessionMiddleware
from transformers import (
    AutoConfig,
    AutoProcessor,
    AutoModelForImageTextToText,
    AutoTokenizer,
    AutoModelForCausalLM,
    BitsAndBytesConfig,
)
from huggingface_hub import snapshot_download
from huggingface_hub import InferenceClient

# Core config
# Use the repo directory as the application home to avoid unwritable mount points
BASE_DIR = Path(__file__).parent.resolve()
APP_HOME = BASE_DIR
# Default persistence root to a writable local data directory unless explicitly overridden
PERSIST_ROOT = Path(os.environ.get("PERSIST_ROOT") or (BASE_DIR / "data")).resolve()


def _choose_root(preferred: Path, fallback: Path) -> Path:
    """Pick a writable root, preferring a persistent mount when available."""
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        test = preferred / ".write_test"
        test.write_text("ok", encoding="utf-8")
        test.unlink(missing_ok=True)
        return preferred
    except Exception:
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


BASE_STORE = _choose_root(PERSIST_ROOT, APP_HOME / ".localdata")
# Data + uploads live inside persistent storage when available
DATA_ROOT = BASE_STORE / "data"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
UPLOAD_ROOT = BASE_STORE / "uploads"
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

# Model cache/offload locations (I keep these stable so downloads are reusable)
OFFLOAD_DIR = APP_HOME / "offload"
OFFLOAD_DIR.mkdir(parents=True, exist_ok=True)

CACHE_DIR = BASE_STORE / "models_cache"
# Prefer external mounted cache if present
EXTERNAL_CACHE = Path("/mnt/modelcache/models_cache")
if EXTERNAL_CACHE.exists() and EXTERNAL_CACHE.is_dir():
    CACHE_DIR = EXTERNAL_CACHE
CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Point Hugging Face cache to the chosen directory to avoid network dependency
os.environ["HF_HOME"] = str(CACHE_DIR)
os.environ["HUGGINGFACE_HUB_CACHE"] = str(CACHE_DIR / "hub")
(CACHE_DIR / "hub").mkdir(parents=True, exist_ok=True)
LEGACY_CACHE = APP_HOME / "models_cache"
if LEGACY_CACHE.exists() and not (CACHE_DIR / ".migrated").exists() and CACHE_DIR != LEGACY_CACHE:
    try:
        shutil.copytree(LEGACY_CACHE, CACHE_DIR, dirs_exist_ok=True)
        (CACHE_DIR / ".migrated").write_text("ok", encoding="utf-8")
        print(f"[startup] migrated legacy model cache from {LEGACY_CACHE} to {CACHE_DIR}")
    except Exception as exc:
        # If legacy cache is partially missing, skip silently to avoid noisy logs
        pass

BACKUP_ROOT = BASE_STORE / "backups"
BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
# Prefer keeping the DB alongside app.py; migrate from legacy data/ path if present
DB_PATH = APP_HOME / "app.db"
LEGACY_DB = APP_HOME / "data" / "app.db"
PREVIOUS_DATA_ROOT_DB = DATA_ROOT / "app.db"
SEED_DB_LOCAL = APP_HOME / "seed" / "app.db"
# Remote seeding disabled by default to avoid unintended downloads; set SEED_DB_URL to enable.
SEED_DB_URL = os.environ.get("SEED_DB_URL") or None


def _is_valid_sqlite(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            header = f.read(16)
        return header.startswith(b"SQLite format 3")
    except Exception:
        return False


def _db_is_populated(path: Path) -> bool:
    try:
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        vessel_rows = 0
        crew_rows = 0
        try:
            cur.execute("SELECT COUNT(*) FROM vessel")
            vessel_rows = cur.fetchone()[0] or 0
        except Exception:
            pass
        try:
            cur.execute("SELECT COUNT(*) FROM crew")
            crew_rows = cur.fetchone()[0] or 0
        except Exception:
            pass
        conn.close()
        return (vessel_rows + crew_rows) > 0
    except Exception:
        return False


def _bootstrap_db(force: bool = False):
    """
    Ensure app.db sits beside app.py. I prefer existing data, fall back to local seeds,
    and intentionally skip remote seeding unless explicitly enabled.
    """
    if DB_PATH.exists():
        if (
            not force
            and DB_PATH.stat().st_size > 0
            and _is_valid_sqlite(DB_PATH)
            and _db_is_populated(DB_PATH)
        ):
            return
        # drop the stale/empty DB before seeding
        try:
            DB_PATH.unlink()
        except Exception:
            pass
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 1) migrate from the previous persisted location (data/data/app.db)
    if (
        PREVIOUS_DATA_ROOT_DB != DB_PATH
        and PREVIOUS_DATA_ROOT_DB.exists()
        and PREVIOUS_DATA_ROOT_DB.stat().st_size > 0
        and _is_valid_sqlite(PREVIOUS_DATA_ROOT_DB)
    ):
        try:
            shutil.copy2(PREVIOUS_DATA_ROOT_DB, DB_PATH)
            print(f"[startup] migrated DB from previous data root {PREVIOUS_DATA_ROOT_DB}")
            return
        except Exception as exc:
            print(f"[startup] failed previous data-root DB copy: {exc}")
    # 2) migrate legacy packaged DB
    if LEGACY_DB.exists() and LEGACY_DB.stat().st_size > 0 and _is_valid_sqlite(LEGACY_DB):
        try:
            shutil.copy2(LEGACY_DB, DB_PATH)
            print(f"[startup] migrated legacy DB from {LEGACY_DB}")
            return
        except Exception as exc:
            print(f"[startup] failed legacy DB copy: {exc}")
    # 3) bundled seed
    if SEED_DB_LOCAL.exists() and SEED_DB_LOCAL.stat().st_size > 0 and _is_valid_sqlite(SEED_DB_LOCAL):
        try:
            shutil.copy2(SEED_DB_LOCAL, DB_PATH)
            print(f"[startup] seeded DB from {SEED_DB_LOCAL}")
            return
        except Exception as exc:
            print(f"[startup] failed local seed DB copy: {exc}")
    print("[startup] no seed DB found; creating new empty DB (remote seed disabled)")


_bootstrap_db()
configure_db(DB_PATH)

DEFAULT_store_LABEL = "Default"
DEFAULT_store = None

def _list_stores():
    """Legacy shim: single store only."""
    return [DEFAULT_store] if DEFAULT_store else []





REQUIRED_MODELS = [
    "google/medgemma-1.5-4b-it",
    "google/medgemma-27b-text-it",
    "Qwen/Qwen2.5-VL-7B-Instruct",
]
# Photo job worker is currently disabled; keep flags to avoid accidental startup.
PHOTO_JOB_WORKER_STARTED = False
PHOTO_JOB_LOCK = threading.Lock()


def _update_chat_metrics(store, model_name: str, duration_ms: int):
    metrics = db_op("chat_metrics", store=store)
    if not isinstance(metrics, dict):
        metrics = {}
    rec = metrics.get(model_name) or {"count": 0, "total_ms": 0, "avg_ms": 0}
    rec["count"] = rec.get("count", 0) + 1
    rec["total_ms"] = rec.get("total_ms", 0) + duration_ms
    rec["avg_ms"] = rec["total_ms"] / rec["count"]
    metrics[model_name] = rec
    db_op("chat_metrics", metrics, store=store)
    return rec


def _strip_inventory_photos(stores=None):
    """No-op placeholder; photo retention is disabled."""
    return []


def log_job(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[PHOTO-JOB] {ts} | {msg}", flush=True)

# FastAPI app
app = FastAPI(title="SailingMedAdvisor")
session_cfg = {"secret_key": SECRET_KEY, "same_site": "lax"}
if IS_HF_SPACE:
    # Hugging Face runs inside an iframe on huggingface.co, so we need a third-party cookie
    session_cfg.update({"same_site": "none", "https_only": True})
app.add_middleware(SessionMiddleware, **session_cfg)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_ROOT)), name="uploads")
templates = Jinja2Templates(directory="templates")
templates.env.auto_reload = True

@app.on_event("startup")
async def _log_db_path():
    """Print the fully-resolved database path at startup for operational visibility."""
    try:
        print(f"[startup] Database path: {DB_PATH.resolve()}", flush=True)
    except Exception as exc:
        print(f"[startup] Database path unavailable: {exc}", flush=True)

# Model state
device = "cuda" if torch.cuda.is_available() else "cpu"
# Prefer bf16 when supported; fall back to fp16 on older GPUs (e.g., RTX 5000)
if device == "cuda" and torch.cuda.is_bf16_supported():
    dtype = torch.bfloat16
elif device == "cuda":
    dtype = torch.float16
else:
    dtype = torch.float32
models = {"active_name": "", "model": None, "processor": None, "tokenizer": None, "is_text": False}
MODEL_MUTEX = threading.Lock()
quant_config = None
if device == "cuda":
    quant_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
    )
    # Allow TF32 for some perf/VRAM savings
    torch.backends.cuda.matmul.allow_tf32 = True


def _sanitize_store(name: str) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"

def _label_from_slug(slug: str) -> str:
    cleaned = _sanitize_store(slug)
    return DEFAULT_store_LABEL if _sanitize_store(DEFAULT_store_LABEL) == cleaned else ""


def _store_dirs(store_label: str):
    slug = _sanitize_store(store_label)
    ws_rec = ensure_store(store_label, slug)
    data_dir = DATA_ROOT / slug
    uploads_dir = UPLOAD_ROOT / slug
    med_dir = uploads_dir / "medicines"
    backup_dir = BACKUP_ROOT / slug
    for path in [data_dir, uploads_dir, med_dir, backup_dir]:
        path.mkdir(parents=True, exist_ok=True)
    return {
        "label": store_label,
        "slug": slug,
        "data": data_dir,
        "uploads": uploads_dir,
        "med_uploads": med_dir,
        "backup": backup_dir,
        "db_id": ws_rec["id"],
    }

DEFAULT_store = _store_dirs(DEFAULT_store_LABEL)
_migrate_existing_to_default(DEFAULT_store)

def _apply_offline_env_from_settings():
    """Honor persisted offline flags at startup so model loading respects cached-only mode."""
    try:
        settings = db_op("settings", store=DEFAULT_store) or {}
        if settings.get("offline_force_flags"):
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
    except Exception:
        pass

_apply_offline_env_from_settings()


def _get_store(_request: Request = None, required: bool = True):
    """Return the single store used by the app."""
    return DEFAULT_store


def _startup_model_check():
    if not VERIFY_MODELS_ON_START or DISABLE_LOCAL_INFERENCE:
        return
    print("[offline] Verifying required model cache...")
    results = verify_required_models(download_missing=AUTO_DOWNLOAD_MODELS and not is_offline_mode())
    missing = [m for m in results if not m["cached"]]
    for r in results:
        status_txt = "cached" if r["cached"] else "missing"
        dl_txt = " (downloaded)" if r.get("downloaded") else ""
        print(f"[offline] {r['model']}: {status_txt}{dl_txt}{' ERR:'+r['error'] if r.get('error') else ''}")
    if missing:
        print(
            f"[offline] Missing model cache for {len(missing)} model(s). Run Offline Readiness in Settings or ensure internet to download."
        )


def _background_verify_models():
    """Non-blocking model cache verify/download when online."""
    if DISABLE_LOCAL_INFERENCE or IS_HF_SPACE or not AUTO_VERIFY_ONLINE:
        return
    # Quick check: skip if nothing is missing
    missing = [m for m in verify_required_models(download_missing=False) if not m["cached"]]
    if not missing:
        return
    if is_offline_mode():
        print("[offline] Skipping background verify (offline mode).")
        return

    def _runner():
        try:
            print("[offline] Background verify: checking/downloading MedGemma caches...")
            verify_required_models(download_missing=True)
            print("[offline] Background verify complete.")
        except Exception as exc:
            print(f"[offline] Background verify failed: {exc}")

    t = threading.Thread(target=_runner, daemon=True)
    t.start()


def _heartbeat(label: str, interval: float = 2.0, stop_event: threading.Event = None):
    """No-op heartbeat placeholder (previously printed progress dots)."""
    return stop_event or threading.Event()

def unload_model():
    """Free GPU/CPU memory for previously loaded model."""
    models["model"] = None
    models["processor"] = None
    models["tokenizer"] = None
    models["active_name"] = ""
    models["is_text"] = False
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _same_med(a, b):
    """Decide if two meds are the same item.

    We require a real generic name match; placeholders/empties don't dedupe to avoid swallowing new imports.
    Strength must match when both are provided.
    """

    def norm(val):
        v = (val or "").strip().lower()
        return "" if v in {"", "medication", "med"} else v

    ga, gb = norm(a.get("genericName")), norm(b.get("genericName"))
    sa, sb = norm(a.get("strength")), norm(b.get("strength"))
    if not ga or not gb:
        return False
    if ga != gb:
        return False
    if sa and sb:
        return sa == sb
    return True


def _is_blank(val):
    """Return True when a value is effectively empty for merge purposes."""
    if val is None:
        return True
    if isinstance(val, bool):
        return False
    if isinstance(val, (int, float)):
        return False
    if isinstance(val, str):
        return not val.strip()
    if isinstance(val, (list, dict, set, tuple)):
        return len(val) == 0
    return False


def load_model(model_name: str, allow_cpu_large: bool = False):
    """Lazy-load and cache the selected model."""
    if DISABLE_LOCAL_INFERENCE:
        raise RuntimeError("LOCAL_INFERENCE_DISABLED")
    if models["active_name"] == model_name:
        return
    local_dir = _resolve_local_model_dir(model_name)
    # Free previous model to avoid VRAM exhaustion when switching
    unload_model()
    # Warn on CPU usage for large model unless explicitly allowed
    if "28b" in model_name.lower() and device != "cuda" and not allow_cpu_large:
        raise RuntimeError("SLOW_28B_CPU")

    # Ensure cache exists (attempt download if allowed and online)
    cached, cache_err = model_cache_status(model_name)
    if not cached and AUTO_DOWNLOAD_MODELS and not is_offline_mode():
        downloaded, err = download_model_cache(model_name)
        if downloaded:
            cached, cache_err = model_cache_status(model_name)
        elif err:
            print(f"[offline] auto-download failed for {model_name}: {err}")
    if not cached:
        raise RuntimeError(
            f"Missing model cache for {model_name}. "
            f"{cache_err or 'Open Settings → Offline Readiness to download and back up models.'}"
        )

    is_text_only = "text" in model_name.lower()
    # Balanced mapping with capped GPU memory; spill the rest to CPU/offload
    device_map = "balanced_low_0" if device == "cuda" else None
    max_memory = {0: "10GiB", "cpu": "64GiB"} if device == "cuda" else None
    load_path = local_dir or model_name
    if is_text_only:
        models["tokenizer"] = AutoTokenizer.from_pretrained(load_path, use_fast=True, local_files_only=True)
        models["processor"] = None
        models["model"] = AutoModelForCausalLM.from_pretrained(
            load_path,
            torch_dtype=dtype,
            device_map=device_map,
            max_memory=max_memory,
            low_cpu_mem_usage=True,
            offload_folder=str(OFFLOAD_DIR),
            quantization_config=quant_config,
            local_files_only=True,
        )
    else:
        models["processor"] = AutoProcessor.from_pretrained(load_path, use_fast=True, local_files_only=True)
        models["tokenizer"] = None
        models["model"] = AutoModelForImageTextToText.from_pretrained(
            load_path,
            torch_dtype=dtype,
            device_map=device_map,
            max_memory=max_memory,
            low_cpu_mem_usage=True,
            offload_folder=str(OFFLOAD_DIR),
            quantization_config=quant_config,
            local_files_only=True,
        )
    models["is_text"] = is_text_only
    models["active_name"] = model_name


def get_defaults():
    return {
        "triage_instruction": "Act as Lead Clinician. Priority: Life-saving protocols. Format: ## ASSESSMENT, ## PROTOCOL.",
        "inquiry_instruction": "Act as Medical Librarian. Focus: Academic research and pharmacology.",
        "tr_temp": 0.1,
        "tr_tok": 1024,
        "tr_p": 0.9,
        "in_temp": 0.6,
        "in_tok": 2048,
        "in_p": 0.95,
        "rep_penalty": 1.1,
        "mission_context": "Isolated Medical Station offshore.",
        "user_mode": "user",
        "med_photo_model": "qwen",
        "med_photo_prompt": (
            "You are a pharmacy intake assistant on a sailing vessel. "
            "Look at the medication photo and return JSON only with keys: "
            "generic_name, brand_name, form, strength, expiry_date, batch_lot, "
            "storage_location, manufacturer, indication, allergy_warnings, dosage, notes."
        ),
        "vaccine_types": [
            "Diphtheria, Tetanus, and Pertussis (DTaP/Tdap)",
            "Polio (IPV/OPV)",
            "Measles, Mumps, Rubella (MMR)",
            "HPV (Human Papillomavirus)",
            "Influenza",
            "Haemophilus influenzae type b (Hib)",
            "Hepatitis B",
            "Varicella (Chickenpox)",
            "Pneumococcal (PCV)",
            "Rotavirus",
            "COVID-19",
            "Yellow Fever",
            "Typhoid",
            "Hepatitis A",
            "Japanese Encephalitis",
            "Rabies",
            "Cholera",
        ],
    }


def db_op(cat, data=None, store=None):
    """
    Central shim for data access. Everything is single-store now; I keep the
    existing signature so the rest of the app doesn't need to change. Each
    category maps straight to SQL tables in db_store (no documents table).
    """
    allowed_categories = [
        "settings",
        "patients",
        "inventory",
        "tools",
        "history",
        "chats",
        "med_photo_queue",
        "med_photo_jobs",
        "chat_metrics",
        "vessel",
    ]
    if cat not in allowed_categories:
        raise ValueError(f"Invalid category: {cat}")

    def default_for(category):
        if category == "settings":
            return get_defaults()
        if category == "vessel":
            return {
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
        if category == "chat_metrics":
            return {}
        if category == "chats":
            return []
        return []

    def load_legacy(category):
        legacy_path = (DEFAULT_store or {}).get("data", DATA_ROOT) / f"{category}.json"
        if legacy_path.exists():
            try:
                return json.loads(legacy_path.read_text() or "[]")
            except Exception:
                return None
        return None

    if cat == "vessel":
        if data is not None:
            if not isinstance(data, dict):
                raise ValueError("Vessel payload must be a JSON object.")
            merged = {**default_for("vessel"), **(data or {})}
            set_vessel(merged)
            return merged
        loaded = get_vessel() or {}
        merged = {**default_for("vessel"), **(loaded if isinstance(loaded, dict) else {})}
        set_vessel(merged)
        return merged

    if cat == "patients":
        if data is not None:
            if not isinstance(data, list):
                raise ValueError("Patients payload must be a JSON array.")
            try:
                set_patients(data)
                delete_patients_doc()
                return data
            except Exception:
                logger.exception("patients save failed", extra={"db_path": str(DB_PATH)})
                raise
        try:
            loaded = get_patients()
        except Exception:
            logger.exception("patients load failed", extra={"db_path": str(DB_PATH)})
            raise
        if loaded is None:
            legacy = load_legacy(cat)
            loaded = legacy if legacy is not None else default_for(cat)
            set_patients(loaded)
        delete_patients_doc()
        return loaded

    if data is not None:
        if cat == "settings":
            if not isinstance(data, dict):
                raise ValueError("Settings payload must be a JSON object.")
            # Persist lookup lists to their own tables
            if "vaccine_types" in data:
                replace_vaccine_types(data.get("vaccine_types") or [])
            if "pharmacy_labels" in data:
                replace_pharmacy_labels(data.get("pharmacy_labels") or [])
            # Persist model params to table
            set_model_params(data)
            # Persist meta settings to table
            set_settings_meta(
                user_mode=data.get("user_mode"),
                offline_force_flags=data.get("offline_force_flags"),
            )
            return {**get_defaults(), **data}
        if cat == "inventory":
            if not isinstance(data, list):
                raise ValueError("Inventory payload must be a JSON array.")
            set_inventory_items(data)
            return data
        if cat == "tools":
            if not isinstance(data, list):
                raise ValueError("Tools payload must be a JSON array.")
            set_tool_items(data)
            return data
        if cat == "history":
            if not isinstance(data, list):
                raise ValueError("History payload must be a JSON array.")
            set_history_entries(data)
            return data
        if cat == "chats":
            if not isinstance(data, list):
                raise ValueError("Chats payload must be a JSON array.")
            set_chats(data)
            return data
        if cat == "chat_metrics":
            if not isinstance(data, dict):
                raise ValueError("Chat metrics payload must be a JSON object.")
            set_chat_metrics(data)
            return data
        if cat == "med_photo_queue":
            if not isinstance(data, list):
                raise ValueError("med_photo_queue payload must be a JSON array.")
            set_med_photo_queue_rows(data)
            return data
        if cat == "med_photo_jobs":
            if not isinstance(data, list):
                raise ValueError("med_photo_jobs payload must be a JSON array.")
            set_med_photo_jobs_rows(data)
            return data
        if cat == "context":
            if not isinstance(data, dict):
                raise ValueError("Context payload must be a JSON object.")
            set_context_payload(data)
            return data
        return data

    loaded = None
    # For legacy compatibility, load JSON once if present, then migrate to tables where applicable
    legacy = load_legacy(cat)
    loaded = legacy if legacy is not None else default_for(cat)
    if cat == "chats":
        set_chats(loaded if isinstance(loaded, list) else [])
        return get_chats()
    if cat == "chat_metrics":
        set_chat_metrics(loaded if isinstance(loaded, dict) else {})
        return get_chat_metrics()

    if cat == "settings":
        loaded = {}
        # Overlay lookup lists from tables
        try:
            vt = load_vaccine_types()
            if vt:
                loaded["vaccine_types"] = vt
        except Exception:
            pass
        try:
            pl = load_pharmacy_labels()
            if pl:
                loaded["pharmacy_labels"] = pl
        except Exception:
            pass
        try:
            mp = get_model_params()
            loaded.update({k: v for k, v in mp.items() if v is not None})
        except Exception:
            pass
        try:
            meta = get_settings_meta()
            loaded.update({k: v for k, v in meta.items() if v is not None})
        except Exception:
            pass
        return {**get_defaults(), **loaded}
    if cat == "inventory":
        return get_inventory_items()
    if cat == "tools":
        return get_tool_items()
    if cat == "history":
        return get_history_entries()
    if cat == "chats":
        chats = get_chats()
        if not chats:
            return default_for(cat)
        return chats
    if cat == "chat_metrics":
        metrics = get_chat_metrics()
        if not metrics:
            return default_for(cat)
        return metrics
    if cat == "med_photo_queue":
        return get_med_photo_queue_rows()
    if cat == "med_photo_jobs":
        return get_med_photo_jobs_rows()
    if cat == "context":
        return get_context_payload()
    if cat == "settings":
        return {**get_defaults(), **loaded}
    return loaded


def safe_float(val, default):
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def safe_int(val, default):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _is_resource_excluded(item):
    val = item.get("excludeFromResources")
    if isinstance(val, str):
        return val.strip().lower() in {"true", "1", "yes"}
    return bool(val)


def _patient_display_name(record, fallback):
    if not record:
        return fallback
    name = record.get("name") or record.get("fullName") or ""
    if name and name.strip():
        return name
    parts = [
        record.get("firstName") or "",
        record.get("middleName") or "",
        record.get("lastName") or "",
    ]
    combined = " ".join(part for part in parts if part).strip()
    return combined or fallback


def lookup_patient_display_name(p_name, store, default="Unnamed Crew"):
    if not p_name:
        return default
    try:
        patients = db_op("patients", store=store)
    except Exception:
        return default
    rec = next(
        (
            p
            for p in patients
            if (p.get("id") and p.get("id") == p_name)
            or (p.get("name") and p.get("name") == p_name)
        ),
        None,
    )
    return _patient_display_name(rec, p_name or default)


def build_prompt(settings, mode, msg, p_name, store):
    rep_penalty = safe_float(settings.get("rep_penalty", 1.1) or 1.1, 1.1)
    mission_context = settings.get("mission_context", "")

    if mode == "inquiry":
        instruction = settings.get("inquiry_instruction")
        prompt_sections = [
            f"MISSION CONTEXT: {mission_context}" if mission_context else "",
            f"INQUIRY INSTRUCTION:\n{instruction}",
            f"QUERY:\n{msg}",
        ]
        prompt = "\n\n".join(section for section in prompt_sections if section.strip())
        cfg = {
            "t": safe_float(settings.get("in_temp", 0.6), 0.6),
            "tk": safe_int(settings.get("in_tok", 2048), 2048),
            "p": safe_float(settings.get("in_p", 0.95), 0.95),
            "rep_penalty": rep_penalty,
        }
    else:
        pharma_items = {}
        equip_items = {}
        consumable_items = {}
        for m in db_op("inventory", store=store):
            item_name = m.get("name") or m.get("genericName") or m.get("brandName")
            if _is_resource_excluded(m):
                continue
            if not item_name:
                continue
            cat = (m.get("type") or "medication").strip().lower()
            key = (item_name or "").strip().lower()
            if not key:
                continue
            if cat in {"medication", ""}:
                pharma_items[key] = item_name
            elif cat == "consumable":
                consumable_items[key] = item_name
            elif cat == "equipment":
                equip_items[key] = item_name
            else:
                # Default unknown types to medication so they are not dropped
                pharma_items[key] = item_name
        pharma_list = [pharma_items[k] for k in sorted(pharma_items)]
        equip_list = [equip_items[k] for k in sorted(equip_items)]
        consumable_list = [consumable_items[k] for k in sorted(consumable_items)]
        pharma_str = ", ".join(pharma_list)
        equip_str = ", ".join(equip_list)
        consumable_str = ", ".join(consumable_list)

        tool_items = []
        for t in db_op("tools", store=store):
            tool_name = t.get("name")
            if tool_name:
                tool_items.append(tool_name)
        tool_items.sort(key=lambda s: (s or "").lower())
        equipment_extra = ", ".join(tool_items)

        patient_record = next(
            (
                p
                for p in db_op("patients", store=store)
                if (p_name and p.get("id") == p_name) or (p_name and p.get("name") == p_name)
            ),
            {},
        )
        display_name = _patient_display_name(patient_record, p_name or "Unnamed Crew")
        p_hist = patient_record.get("history", "No records.")
        p_sex = patient_record.get("sex") or patient_record.get("gender") or "Unknown"
        p_birth = patient_record.get("birthdate") or "Unknown"
        vaccines = patient_record.get("vaccines") or []

        def _format_vaccines(vax_list):
            if not isinstance(vax_list, list) or not vax_list:
                return "No vaccines recorded."
            formatted = []
            for v in vax_list:
                if not isinstance(v, dict):
                    continue
                parts = []
                v_type = v.get("vaccineType") or "Vaccine"
                date = v.get("dateAdministered")
                dose = v.get("doseNumber")
                trade = v.get("tradeNameManufacturer")
                lot = v.get("lotNumber")
                provider = v.get("provider")
                provider_country = v.get("providerCountry")
                next_due = v.get("nextDoseDue")
                exp = v.get("expirationDate")
                site = v.get("siteRoute")
                reactions = v.get("reactions")
                if date:
                    parts.append(f"Date: {date}")
                if dose:
                    parts.append(f"Dose: {dose}")
                if trade:
                    parts.append(f"Trade/Manufacturer: {trade}")
                if lot:
                    parts.append(f"Lot: {lot}")
                if provider:
                    parts.append(f"Provider: {provider}")
                if provider_country:
                    parts.append(f"Provider Country: {provider_country}")
                if next_due:
                    parts.append(f"Next Dose Due: {next_due}")
                if exp:
                    parts.append(f"Expiration: {exp}")
                if site:
                    parts.append(f"Site/Route: {site}")
                if reactions:
                    parts.append(f"Reactions: {reactions}")
                details = "; ".join(parts)
                if details:
                    formatted.append(f"{v_type} ({details})")
                else:
                    formatted.append(v_type)
            return "; ".join(formatted) if formatted else "No vaccines recorded."

        prompt_sections = [
            f"MISSION CONTEXT: {mission_context}" if mission_context else "",
            f"TRIAGE INSTRUCTION:\n{settings.get('triage_instruction')}",
            "RESOURCES:\n"
            f"- Pharmaceuticals: {pharma_str or 'None listed'}\n"
            f"- Medical Equipment: {equip_str or equipment_extra or 'None listed'}\n"
            f"- Consumables: {consumable_str or 'None listed'}",
            "PATIENT:\n"
            f"- Name: {display_name}\n"
            f"- Sex: {p_sex}\n"
            f"- Date of Birth: {p_birth}\n"
            f"- Medical History (profile): {p_hist or 'No records.'}\n"
            f"- Vaccines: {_format_vaccines(vaccines)}",
            f"SITUATION:\n{msg}",
        ]
        prompt = "\n\n".join(section for section in prompt_sections if section.strip())
        cfg = {
            "t": safe_float(settings.get("tr_temp", 0.1), 0.1),
            "tk": safe_int(settings.get("tr_tok", 1024), 1024),
            "p": safe_float(settings.get("tr_p", 0.9), 0.9),
            "rep_penalty": rep_penalty,
        }

    return prompt, cfg


def get_credentials(store):
    """Return list of crew entries that have username/password set."""
    return get_credentials_rows()


def load_context(store):
    """Return static/inline sidebar context; external context.json no longer used."""
    return {}


def get_med_photo_queue(store):
    queue = db_op("med_photo_queue", store=store)
    return queue if isinstance(queue, list) else []


def _resolve_med_model(store):
    """Pick a preferred vision model for medicine photo parsing; fall back if cache missing."""
    settings = db_op("settings", store=store)
    model_pref = (settings.get("med_photo_model") or "qwen").lower()
    primary = "Qwen/Qwen2.5-VL-7B-Instruct"
    has_cache, _ = model_cache_status(primary)
    if not has_cache:
        logger.warning("Preferred medicine photo model cache missing; continuing with %s", primary)
    return primary


def _merge_inventory_record(med_record: dict, photo_urls: List[str], store):
    inventory = db_op("inventory", store=store)
    existing = next((m for m in inventory if _same_med(m, med_record)), None)
    entry = {"status": "completed", "urls": []}
    if existing:
        existing.setdefault("purchaseHistory", [])
        med_record_ph = med_record.get("purchaseHistory") or []
        if med_record_ph:
            existing["purchaseHistory"].extend(med_record_ph)
        for key, val in med_record.items():
            if key in {"id", "purchaseHistory"}:
                continue
            if _is_blank(existing.get(key)) and not _is_blank(val):
                existing[key] = val
        entry["inventory_id"] = existing.get("id")
    else:
        inventory.append(med_record)
        entry["inventory_id"] = med_record["id"]
    db_op("inventory", inventory, store=store)
    return entry


def _load_photo_jobs(store):
    jobs = db_op("med_photo_jobs", store=store)
    if not isinstance(jobs, list):
        jobs = []
    return jobs


def _save_photo_jobs(store, jobs):
    db_op("med_photo_jobs", jobs, store=store)
    log_job(f"[{store['label']}] saved {len(jobs)} job(s)")


def _update_job(store, job_id, updater):
    jobs = _load_photo_jobs(store)
    updated = None
    for job in jobs:
        if job.get("id") == job_id:
            updated = updater(job)
            break
    _save_photo_jobs(store, jobs)
    return updated, jobs


def _process_photo_job(job, store):
    paths = [Path(p) for p in job.get("paths") or [] if p]
    urls = job.get("urls") or []
    if not paths:
        raise RuntimeError("No image paths found for job")
    log_job(f"[{store['label']}] processing job {job.get('id')} ({len(paths)} photo(s), mode={job.get('mode')})")
    entry = asyncio.run(_process_photo_group(paths, urls, store))
    for path in paths:
        try:
            if path.exists():
                path.unlink()
        except Exception:
            continue
    job.update(
        {
            "status": "completed",
            "completed_at": datetime.now().isoformat(),
            "result": entry.get("result") or {},
            "inventory_id": entry.get("inventory_id"),
            "used_model": entry.get("used_model"),
            "paths": [],
            "urls": [],
            "error": "",
        }
    )
    log_job(f"[{store['label']}] job {job.get('id')} completed; inventory_id={job.get('inventory_id')}")


def _photo_job_worker():
    while True:
        processed = False
        try:
            ws = DEFAULT_store
            jobs = _load_photo_jobs(ws)
            job = next((j for j in jobs if j.get("status") == "queued"), None)
            if not job:
                # prune old completed jobs to keep file small
                now = datetime.now()
                filtered = []
                for j in jobs:
                    if j.get("status") != "completed":
                        filtered.append(j)
                        continue
                    try:
                        ts = datetime.fromisoformat(j.get("completed_at", ""))
                        # keep recent completions for UI refresh (approx 2 minutes)
                        if (now - ts).total_seconds() < 120:
                            filtered.append(j)
                    except Exception:
                        # if timestamp missing, keep it so UI can see it once
                        filtered.append(j)
                if len(filtered) != len(jobs):
                    _save_photo_jobs(ws, filtered)
                continue
            processed = True
            job["status"] = "processing"
            job["started_at"] = datetime.now().isoformat()
            _save_photo_jobs(ws, jobs)
            try:
                _process_photo_job(job, ws)
            except Exception as e:
                job["status"] = "failed"
                job["error"] = str(e)
                log_job(f"[{ws['label']}] job {job.get('id')} failed: {e}")
            _save_photo_jobs(ws, jobs)
        except Exception:
            # Avoid worker crash; sleep briefly then retry
            pass
        if not processed:
            time.sleep(2)


def _start_photo_worker():
    global PHOTO_JOB_WORKER_STARTED
    if PHOTO_JOB_WORKER_STARTED:
        return
    PHOTO_JOB_WORKER_STARTED = True
    t = threading.Thread(target=_photo_job_worker, daemon=True)
    t.start()


def _safe_suffix(name: str, mime: str = "") -> str:
    suffix = ""
    try:
        suffix = Path(name or "").suffix.lower()
    except Exception:
        suffix = ""
    mime = (mime or "").lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        return suffix
    if "jpeg" in mime or "jpg" in mime:
        return ".jpg"
    if "png" in mime:
        return ".png"
    if "webp" in mime:
        return ".webp"
    if "bmp" in mime:
        return ".bmp"
    return ".png"


def extract_json_payload(text: str):
    if not text:
        return {}
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
    except Exception:
        return {}
    return {}


def normalize_medicine_fields(raw: dict, fallback_notes: str):
    raw = raw or {}
    return {
        "genericName": raw.get("generic_name") or raw.get("generic") or raw.get("name") or "",
        "brandName": raw.get("brand_name") or raw.get("brand") or "",
        "form": raw.get("form") or "",
        "strength": raw.get("strength") or "",
        "currentQuantity": raw.get("quantity") or "",
        "minThreshold": raw.get("min_threshold") or "",
        "unit": raw.get("unit") or "",
        "storageLocation": raw.get("storage_location") or raw.get("storage") or "",
        "expiryDate": raw.get("expiry_date") or "",
        "batchLot": raw.get("batch_lot") or raw.get("lot") or "",
        "controlled": bool(raw.get("controlled") or False),
        "manufacturer": raw.get("manufacturer") or "",
        "primaryIndication": raw.get("indication") or raw.get("use_case") or "",
        "allergyWarnings": raw.get("allergy_warnings") or raw.get("allergy") or raw.get("warnings") or "",
        "standardDosage": raw.get("dosage") or raw.get("dose") or fallback_notes or "",
        "notes": raw.get("notes") or fallback_notes or "",
    }


def build_inventory_record(extracted: dict, photo_urls: List[str]):
    now_id = f"med-{int(datetime.now().timestamp() * 1000)}"
    note = extracted.get("notes") or "Imported from medication photo."
    purchase_row = {
        "id": f"ph-{uuid.uuid4().hex}",
        "date": datetime.now().strftime("%Y-%m-%d"),
        "quantity": "",
        "notes": note,
    }
    # Tag source for traceability without polluting the display name
    source = "photo_import"
    return {
        "id": now_id,
        "genericName": extracted.get("genericName") or extracted.get("brandName") or "Medication",
        "brandName": extracted.get("brandName") or "",
        "form": extracted.get("form") or "",
        "strength": extracted.get("strength") or "",
        "currentQuantity": extracted.get("currentQuantity") or "",
        "minThreshold": extracted.get("minThreshold") or "",
        "unit": extracted.get("unit") or "",
        "storageLocation": extracted.get("storageLocation") or "",
        "expiryDate": extracted.get("expiryDate") or "",
        "batchLot": extracted.get("batchLot") or "",
        "controlled": bool(extracted.get("controlled") or False),
        "manufacturer": extracted.get("manufacturer") or "",
        "primaryIndication": extracted.get("primaryIndication") or "",
        "allergyWarnings": extracted.get("allergyWarnings") or "",
        "standardDosage": extracted.get("standardDosage") or "",
        "purchaseHistory": [purchase_row],
        "source": source,
        "photoImported": True,
    }


def decode_generated_text(out, inputs, processor):
    try:
        prompt_len = inputs["input_ids"].shape[-1]
        trimmed = out[0][prompt_len:]
        # Prefer processor.decode when available
        if hasattr(processor, "decode"):
            return processor.decode(trimmed, skip_special_tokens=True).strip()
        decoded = processor.batch_decode(trimmed.unsqueeze(0), skip_special_tokens=True)
        return decoded[0].strip() if decoded else ""
    except Exception:
        try:
            decoded = processor.batch_decode(out, skip_special_tokens=True)
            return decoded[0].strip() if decoded else ""
        except Exception:
            return ""


def run_medicine_photo_inference(image_path: Path, model_name: str, prompt_text: str = ""):
    if not image_path.exists():
        raise FileNotFoundError("Image not found on disk")
    with MODEL_MUTEX:
        load_model(model_name, allow_cpu_large=True)
        image = Image.open(image_path).convert("RGB")
        # Limit resolution to reduce VRAM/KV cache size
        image.thumbnail((1024, 1024))
        base_prompt = prompt_text.strip() or get_defaults().get("med_photo_prompt", "")
        strict_prompt = (
            "Extract medicine/package info. Respond with ONLY JSON like "
            '{"generic_name":"","brand_name":"","form":"","strength":"","expiry_date":"","batch_lot":"","storage_location":"",'
            '"manufacturer":"","indication":"","allergy_warnings":"","dosage":"","notes":""}. '
            "Fill what you can from the image text; leave others \"\". Translate any non-English text to English before returning. "
            "No prose, markdown, or apologies.\n"
            + base_prompt
        )
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": strict_prompt},
                ],
            }
        ]
        processor = models["processor"]
        if processor is None:
            raise RuntimeError("Vision processor not initialized")
        device_target = models["model"].device

        def generate_once(text_prompt: str, strict: bool = False):
            try:
                if hasattr(processor, "apply_chat_template"):
                    chat = processor.apply_chat_template(messages, add_generation_prompt=True)
                    inputs = processor(text=[chat], images=[image], return_tensors="pt").to(device_target)
                else:
                    raise AttributeError("apply_chat_template missing")
            except Exception:
                # Fallback for processors without usable chat templates
                inputs = processor(images=[image], text=[text_prompt], return_tensors="pt").to(device_target)
            gen_kwargs = {
                "max_new_tokens": 160,
                "temperature": 0.1 if not strict else 0.0,
                "top_p": 0.9 if not strict else 1.0,
                "do_sample": False,
                "use_cache": True,
            }
            with torch.no_grad():
                out = models["model"].generate(**inputs, **gen_kwargs)
            return decode_generated_text(out, inputs, processor)

        decoded = generate_once(strict_prompt, strict=True)
    payload = extract_json_payload(decoded)
    refusal_markers = ["sorry", "not trained", "as a base vlm", "cannot"]
    if (not payload) and any(marker in decoded.lower() for marker in refusal_markers):
        raise RuntimeError("PHOTO_MODEL_REFUSAL")
    if not payload:
        payload = {"notes": decoded}
    normalized = normalize_medicine_fields(payload, decoded)
    normalized["raw"] = decoded
    return normalized


def _has_creds(store):
    if not store:
        return False
    creds = get_credentials(store)
    return bool(creds)


def require_auth(request: Request):
    """Enforce auth only when credentials are configured."""
    store = DEFAULT_store
    request.state.store = store
    if not _has_creds(store):
        # No credentials configured, allow pass-through
        return True
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return True


@app.post("/api/default/export")
async def export_default_dataset(request: Request, _=Depends(require_auth)):
    try:
        store = request.state.store
        if not store:
            return JSONResponse({"error": "store not set"}, status_code=status.HTTP_400_BAD_REQUEST)
        default_root = DATA_ROOT / "default"
        default_root.mkdir(parents=True, exist_ok=True)
        default_uploads = default_root / "uploads" / "medicines"
        default_uploads.mkdir(parents=True, exist_ok=True)
        categories = ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "med_photo_queue", "med_photo_jobs", "context"]
        written = []
        for cat in categories:
            data = db_op(cat, store=store)
            dest = default_root / f"{cat}.json"
            dest.write_text(json.dumps(data, indent=4))
            written.append(dest.name)
        # Copy medicine uploads
        src_med = store["uploads"] / "medicines"
        if src_med.exists():
            for item in src_med.iterdir():
                if item.is_file():
                    shutil.copy2(item, default_uploads / item.name)
        return {"status": "ok", "written": written}
    except Exception as e:
        return JSONResponse({"error": f"Unable to export default dataset: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    store = DEFAULT_store
    request.state.store = store
    return templates.TemplateResponse("login.html", {"request": request, "store": store})


@app.post("/login")
async def login(request: Request):
    # Auth model: if no crew credentials configured, auto-admit; otherwise require username/password
    store = DEFAULT_store
    payload = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
    else:
        form = await request.form()
        payload = dict(form)

    crew_creds = get_credentials(store)
    # If no credentials are configured, transparently log in.
    if not crew_creds:
        request.session["authenticated"] = True
        request.session["user"] = "auto"
        return {"success": True, "auto": True}

    username = payload.get("username", "").strip()
    password = payload.get("password", "").strip()
    if not username or not password:
        return JSONResponse({"error": "Username and password required"}, status_code=status.HTTP_400_BAD_REQUEST)

    match = next(
        (p for p in crew_creds if p.get("username") == username and verify_password(password, p.get("password"))),
        None,
    )
    if not match:
        return JSONResponse({"error": "Invalid credentials"}, status_code=status.HTTP_401_UNAUTHORIZED)

    request.session["authenticated"] = True
    request.session["user"] = username
    return {"success": True}


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    store = DEFAULT_store
    request.state.store = store
    # Preload vessel data so UI can render even if API fetch fails
    try:
        vessel_prefill = db_op("vessel", store=store) or {}
    except Exception:
        vessel_prefill = {}
    if not request.session.get("authenticated"):
        if _has_creds(store):
            return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
        # When no credentials, show onboarding/login screen instead of auto-admit
        return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "store": store, "vessel_prefill": vessel_prefill},
    )


@app.get("/api/auth/meta")
async def auth_meta(request: Request):
    store = DEFAULT_store
    creds = get_credentials(store)
    return {"has_credentials": bool(creds), "count": len(creds), "store": store["label"]}


@app.get("/api/chat/metrics")
async def chat_metrics(request: Request, _=Depends(require_auth)):
    """Quick peek at per-model latency/count stats collected during chats."""
    try:
        store = DEFAULT_store
        metrics = db_op("chat_metrics", store=store)
        return {"metrics": metrics if isinstance(metrics, dict) else {}}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/triage/samples")
async def triage_samples(_=Depends(require_auth)):
    """Expose triage test cases (now stored in triage_samples table)."""
    try:
        return get_triage_samples()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/triage/samples")
async def triage_samples_save(request: Request, _=Depends(require_auth)):
    try:
        payload = await request.json()
        if not isinstance(payload, list):
            return JSONResponse({"error": "Payload must be an array"}, status_code=status.HTTP_400_BAD_REQUEST)
        set_triage_samples(payload)
        return {"status": "ok", "count": len(payload)}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/triage/options")
async def triage_options(_=Depends(require_auth)):
    """Expose dropdown options for triage form (table-backed)."""
    try:
        return get_triage_options()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/triage/options")
async def triage_options_save(request: Request, _=Depends(require_auth)):
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Payload must be an object"}, status_code=status.HTTP_400_BAD_REQUEST)
        set_triage_options(payload)
        return {"status": "ok", "fields": list(payload.keys())}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/db/status")
async def db_status():
    """Health check for DB presence and a quick row count sanity check."""
    try:
        exists = DB_PATH.exists()
        size = DB_PATH.stat().st_size if exists else 0
        crew = vessel = 0
        if exists and size > 0:
            try:
                with sqlite3.connect(DB_PATH) as conn:
                    cur = conn.cursor()
                    cur.execute("SELECT COUNT(*) FROM crew")
                    crew = cur.fetchone()[0] or 0
                    cur.execute("SELECT COUNT(*) FROM vessel")
                    vessel = cur.fetchone()[0] or 0
            except Exception:
                pass
        return {
            "exists": bool(exists and size > 0),
            "size": size,
            "stores": 1,
            "crew_rows": crew,
            "vessel_rows": vessel,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/db/seed")
async def db_seed():
    """Force reseed from bundled/remote seed DB."""
    try:
        _bootstrap_db(force=True)
        _store_dirs(DEFAULT_store_LABEL)
        return {"status": "seeded"}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/db/create")
async def db_create():
    """Create a fresh database and seed stores."""
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        if DB_PATH.exists():
            DB_PATH.unlink()
        configure_db(DB_PATH)
        _store_dirs(DEFAULT_store_LABEL)
        return {"status": "created"}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/db/upload")
async def db_upload(file: UploadFile = File(...)):
    """Upload a SQLite DB to replace the current one."""
    import tempfile

    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.NamedTemporaryFile(delete=False)
        try:
            head = await file.read(100)
            if not head.startswith(b"SQLite format 3"):
                tmp.close()
                Path(tmp.name).unlink(missing_ok=True)
                return JSONResponse({"error": "Invalid SQLite file"}, status_code=status.HTTP_400_BAD_REQUEST)
            tmp.write(head)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        finally:
            tmp.close()
        shutil.move(tmp.name, DB_PATH)
        configure_db(DB_PATH)
        _store_dirs(DEFAULT_store_LABEL)
        return {"status": "uploaded"}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/who/medicines")
async def who_medicines(_=Depends(require_auth)):
    """Return WHO ship medicine list sourced from the database table."""
    try:
        meds = get_who_medicines()
        return meds
    except Exception as e:
        logger.exception("who_medicines failed")
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.api_route("/api/data/{cat}", methods=["GET", "POST"])
async def manage(cat: str, request: Request, _=Depends(require_auth)):
    """Generic data endpoint; delegates to db_op which is table-backed."""
    try:
        if request.method == "POST":
            try:
                payload = await request.json()
            except Exception:
                form = await request.form()
                payload = dict(form)
            if cat == "vessel":
                try:
                    from db_store import DB_PATH as _DB_PATH
                    logger.info(f"[vessel] save request payload={payload} db_path={_DB_PATH}")
                except Exception:
                    logger.info(f"[vessel] save request payload={payload}")
            return JSONResponse(db_op(cat, payload))
        result = db_op(cat)
        if cat == "vessel":
            try:
                from db_store import DB_PATH as _DB_PATH
                logger.info(f"[vessel] load result={result} db_path={_DB_PATH}")
            except Exception:
                logger.info(f"[vessel] load result={result}")
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("api/data failed", extra={"cat": cat, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/context")
async def get_context(request: Request, _=Depends(require_auth)):
    """Context endpoint retained for compatibility; now returns empty payload since sidebar content is static."""
    return {}


@app.get("/api/medicines/queue")
async def get_medicine_queue(request: Request, _=Depends(require_auth)):
    # Queue is deprecated; return empty for compatibility
    try:
        return {"queue": []}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/medicines/jobs")
async def list_photo_jobs(request: Request, _=Depends(require_auth)):
    """Legacy endpoint for medicine photo jobs; returns queue from table (may be empty)."""
    try:
        store = request.state.store
        jobs = _load_photo_jobs(store)
        return {"jobs": jobs}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/crew/photo")
async def update_crew_photo(request: Request, _=Depends(require_auth)):
    try:
        payload = await request.json()
        crew_id = str(payload.get("id") or "").strip()
        field = payload.get("field")
        data = payload.get("data") or ""
        if field not in {"passportHeadshot", "passportPage"}:
            return JSONResponse({"error": "Invalid field"}, status_code=status.HTTP_400_BAD_REQUEST)
        if not crew_id:
            return JSONResponse({"error": "Missing id"}, status_code=status.HTTP_400_BAD_REQUEST)
        ok = update_patient_fields(crew_id, {field: data})
        if not ok:
            return JSONResponse({"error": "Update failed"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return {"status": "ok"}
    except Exception as e:
        logger.exception("crew photo update failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/crew/credentials")
async def update_crew_credentials(request: Request, _=Depends(require_auth)):
    """Update plaintext crew credentials (per owner request)."""
    try:
        payload = await request.json()
        crew_id = str(payload.get("id") or "").strip()
        username = payload.get("username")
        password = payload.get("password")
        if not crew_id:
            return JSONResponse({"error": "Missing id"}, status_code=status.HTTP_400_BAD_REQUEST)
        ok = update_patient_fields(crew_id, {"username": username, "password": password})
        if not ok:
            return JSONResponse({"error": "Update failed"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)
        return {"status": "ok"}
    except Exception:
        logger.exception("crew credential update failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/crew/vaccine")
async def upsert_crew_vaccine(request: Request, _=Depends(require_auth)):
    try:
        payload = await request.json()
        crew_id = str(payload.get("crew_id") or "").strip()
        if not crew_id:
            return JSONResponse({"error": "Missing crew_id"}, status_code=status.HTTP_400_BAD_REQUEST)
        vaccine = payload.get("vaccine") or {}
        rec = upsert_vaccine(crew_id, vaccine)
        return {"vaccine": rec}
    except Exception:
        logger.exception("crew vaccine upsert failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.delete("/api/crew/vaccine/{crew_id}/{vaccine_id}")
async def delete_crew_vaccine(crew_id: str, vaccine_id: str, _=Depends(require_auth)):
    try:
        ok = delete_vaccine(crew_id, vaccine_id)
        if not ok:
            return JSONResponse({"error": "Not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return {"status": "ok"}
    except Exception:
        logger.exception("crew vaccine delete failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.delete("/api/medicines/jobs/{job_id}")
async def delete_photo_job(job_id: str, request: Request, _=Depends(require_auth)):
    store = request.state.store
    jobs = _load_photo_jobs(store)
    jobs = [j for j in jobs if j.get("id") != job_id]
    _save_photo_jobs(store, jobs)
    return {"jobs": jobs}


@app.post("/api/medicines/jobs/{job_id}/retry")
async def retry_photo_job(job_id: str, request: Request, _=Depends(require_auth)):
    store = request.state.store
    updated, jobs = _update_job(
        store,
        job_id,
        lambda j: j.update(
            {
                "status": "queued",
                "error": "",
                "started_at": "",
                "completed_at": "",
            }
        ),
    )
    if updated is None:
        return JSONResponse({"error": "Job not found"}, status_code=status.HTTP_404_NOT_FOUND)
    return {"jobs": jobs}


async def _process_photo_group(photo_paths: List[Path], photo_urls: List[str], store):
    primary_model = _resolve_med_model(store)
    image_path = Path(photo_paths[0])
    settings = db_op("settings", store=store)
    photo_prompt = settings.get("med_photo_prompt") or get_defaults().get("med_photo_prompt", "")

    try:
        result = await asyncio.to_thread(run_medicine_photo_inference, image_path, primary_model, photo_prompt)
        used_model = primary_model
    except Exception as e:
        raise RuntimeError(f"Photo inference failed for {primary_model}: {e}") from e

    med_record = build_inventory_record(result, photo_urls)
    entry = _merge_inventory_record(med_record, photo_urls, store)
    entry.update({"result": result, "used_model": used_model})
    return entry


@app.post("/api/medicines/photos")
async def enqueue_medicine_photos(request: Request, files: List[UploadFile] = File(...), group: bool = False, _=Depends(require_auth)):
    try:
        store = request.state.store
        med_dir = store["med_uploads"]
        if not files:
            return JSONResponse({"error": "No files uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)

        mode = request.query_params.get("mode") or ("grouped" if group else "single")
        grouped = mode.lower().startswith("group")
        new_jobs = []
        selected_model = _resolve_med_model(store)
        if grouped:
            filenames = []
            paths = []
            urls = []
            for idx, file in enumerate(files):
                content_type = (file.content_type or "").lower()
                if not content_type.startswith("image/"):
                    continue
                suffix = _safe_suffix(file.filename, content_type)
                new_id = f"medimg-{uuid.uuid4().hex}"
                filename = f"{new_id}{suffix}"
                raw = await file.read()
                if not raw:
                    continue
                save_path = med_dir / filename
                save_path.write_bytes(raw)
                filenames.append(filename)
                paths.append(str(save_path))
                urls.append(f"/uploads/{store['slug']}/medicines/{filename}")
            if not urls:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
            job_id = f"job-{uuid.uuid4().hex}"
            new_jobs.append(
                {
                    "id": job_id,
                    "mode": "grouped",
                    "paths": paths,
                    "urls": urls,
                    "created_at": datetime.now().isoformat(),
                    "status": "queued",
                    "preferred_model": selected_model,
                    "error": "",
                    "result": {},
                }
            )
            log_job(f"[{store['label']}] queued grouped job {job_id} with {len(paths)} photo(s)")
        else:
            for idx, file in enumerate(files):
                content_type = (file.content_type or "").lower()
                if not content_type.startswith("image/"):
                    continue
                suffix = _safe_suffix(file.filename, content_type)
                new_id = f"medimg-{uuid.uuid4().hex}"
                filename = f"{new_id}{suffix}"
                raw = await file.read()
                if not raw:
                    continue
                save_path = med_dir / filename
                save_path.write_bytes(raw)
                url = f"/uploads/{store['slug']}/medicines/{filename}"
                job_id = f"job-{uuid.uuid4().hex}"
                new_jobs.append(
                    {
                        "id": job_id,
                        "mode": "single",
                        "paths": [str(save_path)],
                        "urls": [url],
                        "created_at": datetime.now().isoformat(),
                        "status": "queued",
                        "preferred_model": selected_model,
                        "error": "",
                        "result": {},
                    }
                )
                log_job(f"[{store['label']}] queued single job {job_id} for photo {filename}")
            if not new_jobs:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
        jobs = _load_photo_jobs(store)
        jobs.extend(new_jobs)
        _save_photo_jobs(store, jobs)
        log_job(f"[{store['label']}] total jobs queued: {len(jobs)}")
        return {"jobs": new_jobs}
    except Exception as e:
        # Return the underlying error so the client can surface a useful message
        return JSONResponse({"error": f"Unable to queue photos: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _decode_data_url(data_str: str, fallback_mime: str = "image/png"):
    if not data_str:
        return b"", fallback_mime
    text = data_str.strip()
    if text.startswith("data:") and "," in text:
        try:
            header, b64 = text.split(",", 1)
            mime = fallback_mime
            parts = header.split(";")[0].split(":")
            if len(parts) == 2 and parts[1]:
                mime = parts[1]
            raw = base64.b64decode(b64)
            return raw, mime or fallback_mime
        except Exception:
            pass
    try:
        return base64.b64decode(text), fallback_mime
    except Exception:
        return b"", fallback_mime


@app.post("/api/medicines/photos/base64")
async def enqueue_medicine_photos_base64(request: Request, payload: dict = Body(...), group: bool = False, _=Depends(require_auth)):
    try:
        store = request.state.store
        med_dir = store["med_uploads"]
        selected_model = _resolve_med_model(store)
        files = payload.get("files") if isinstance(payload, dict) else None
        if not files or not isinstance(files, list):
            return JSONResponse({"error": "No files uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
        mode = request.query_params.get("mode") or ("grouped" if group else "single")
        grouped = mode.lower().startswith("group")
        jobs_to_add = []
        if grouped:
            filenames = []
            paths = []
            urls = []
            for idx, file in enumerate(files):
                name = ""
                mime = ""
                data = ""
                if isinstance(file, dict):
                    name = file.get("name") or ""
                    mime = file.get("type") or ""
                    data = file.get("data") or ""
                elif isinstance(file, str):
                    data = file
                raw, detected_mime = _decode_data_url(data, mime or "image/png")
                if not raw:
                    continue
                suffix = _safe_suffix(name, detected_mime)
                new_id = f"medimg-{uuid.uuid4().hex}"
                filename = f"{new_id}{suffix}"
                save_path = med_dir / filename
                save_path.write_bytes(raw)
                filenames.append(filename)
                paths.append(str(save_path))
                urls.append(f"/uploads/{store['slug']}/medicines/{filename}")
            if not urls:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
            job_id = f"job-{uuid.uuid4().hex}"
            jobs_to_add = [
                {
                    "id": job_id,
                    "mode": "grouped",
                    "paths": paths,
                    "urls": urls,
                    "created_at": datetime.now().isoformat(),
                    "status": "queued",
                    "preferred_model": selected_model,
                    "error": "",
                    "result": {},
                }
            ]
            log_job(f"[{store['label']}] queued grouped job {job_id} with {len(paths)} photo(s)")
        else:
            for idx, file in enumerate(files):
                name = ""
                mime = ""
                data = ""
                if isinstance(file, dict):
                    name = file.get("name") or ""
                    mime = file.get("type") or ""
                    data = file.get("data") or ""
                elif isinstance(file, str):
                    data = file
                raw, detected_mime = _decode_data_url(data, mime or "image/png")
                if not raw:
                    continue
                suffix = _safe_suffix(name, detected_mime)
                new_id = f"medimg-{uuid.uuid4().hex}"
                filename = f"{new_id}{suffix}"
                save_path = med_dir / filename
                save_path.write_bytes(raw)
                url = f"/uploads/{store['slug']}/medicines/{filename}"
                jobs_to_add.append(
                    {
                        "id": f"job-{uuid.uuid4().hex}",
                        "mode": "single",
                        "paths": [str(save_path)],
                        "urls": [url],
                        "created_at": datetime.now().isoformat(),
                        "status": "queued",
                        "preferred_model": selected_model,
                        "error": "",
                        "result": {},
                    }
                )
                log_job(f"[{store['label']}] queued single job for photo {filename}")
            if not jobs_to_add:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
        jobs = _load_photo_jobs(store)
        jobs.extend(jobs_to_add)
        _save_photo_jobs(store, jobs)
        log_job(f"[{store['label']}] total jobs queued: {len(jobs)}")
        return {"jobs": jobs_to_add}
    except Exception as e:
        return JSONResponse({"error": f"Unable to queue photos: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/medicines/photos/{item_id}/process")
async def process_medicine_photo(item_id: str, request: Request, _=Depends(require_auth)):
    return JSONResponse({"error": "Manual queue processing is disabled; photos are processed automatically."}, status_code=status.HTTP_400_BAD_REQUEST)


@app.delete("/api/medicines/queue/{item_id}")
async def delete_medicine_queue_item(item_id: str, request: Request, _=Depends(require_auth)):
    return {"queue": []}


def _generate_response(model_choice: str, force_cpu_slow: bool, prompt: str, cfg: dict):
    # If local inference is disabled (HF Space), fall back to HF Inference API
    if DISABLE_LOCAL_INFERENCE:
        if not HF_REMOTE_TOKEN:
            raise RuntimeError("REMOTE_TOKEN_MISSING")
        client = InferenceClient(token=HF_REMOTE_TOKEN)
        # Use requested model when provided (e.g., MedGemma) else default
        model_name = model_choice or REMOTE_MODEL
        resp = client.text_generation(
            prompt,
            model=model_name,
            max_new_tokens=cfg["tk"],
            temperature=cfg["t"],
            top_p=cfg["p"],
        )
        return resp.strip()

    with MODEL_MUTEX:
        load_model(model_choice, allow_cpu_large=force_cpu_slow)
        if models["is_text"]:
            tok = models["tokenizer"]
            messages = [{"role": "user", "content": prompt}]
            inputs = tok.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            ).to(models["model"].device)
            out = models["model"].generate(
                **inputs,
                max_new_tokens=cfg["tk"],
                temperature=cfg["t"],
                top_p=cfg["p"],
                repetition_penalty=cfg.get("rep_penalty", 1.1),
                do_sample=(cfg["t"] > 0),
            )
            res = models["tokenizer"].decode(out[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True).strip()
        else:
            processor = models["processor"]
            if processor is None:
                raise RuntimeError("Vision processor not initialized")
            inputs = processor.apply_chat_template(
                [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                add_generation_prompt=True,
                tokenize=True,
                return_dict=True,
                return_tensors="pt",
            ).to(models["model"].device)
            out = models["model"].generate(
                **inputs,
                max_new_tokens=cfg["tk"],
                temperature=cfg["t"],
                top_p=cfg["p"],
                repetition_penalty=cfg.get("rep_penalty", 1.1),
                do_sample=(cfg["t"] > 0),
            )
            res = processor.decode(out[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True).strip()
    return res


@app.post("/api/chat")
async def chat(request: Request, _=Depends(require_auth)):
    """Main chat endpoint (triage + inquiry); logs history and updates chat metrics."""
    try:
        store = request.state.store
        start_time = datetime.now()
        form = await request.form()
        msg = form.get("message")
        user_msg_raw = msg
        p_name = form.get("patient")
        mode = form.get("mode")
        is_priv = form.get("private") == "true"
        model_choice = form.get("model_choice")
        force_cpu_slow = form.get("force_28b") == "true"
        override_prompt = form.get("override_prompt") or ""
        triage_consciousness = form.get("triage_consciousness") or ""
        triage_breathing_status = form.get("triage_breathing_status") or ""
        triage_pain_level = form.get("triage_pain_level") or ""
        triage_main_problem = form.get("triage_main_problem") or ""
        triage_temperature = form.get("triage_temperature") or ""
        triage_circulation = form.get("triage_circulation") or ""
        triage_cause = form.get("triage_cause") or ""
        s = db_op("settings", store=store)

        if mode == "triage":
            meta_lines = []
            if triage_consciousness:
                meta_lines.append(f"Consciousness/Responsiveness: {triage_consciousness}")
            if triage_breathing_status:
                meta_lines.append(f"Breathing: {triage_breathing_status}")
            if triage_pain_level:
                meta_lines.append(f"Pain Level: {triage_pain_level}")
            if triage_main_problem:
                meta_lines.append(f"Main Problem: {triage_main_problem}")
            if triage_temperature:
                meta_lines.append(f"Body Temperature: {triage_temperature}")
            if triage_circulation:
                meta_lines.append(f"Circulation/BP: {triage_circulation}")
            if triage_cause:
                meta_lines.append(f"Cause: {triage_cause}")
            if meta_lines:
                meta_text = "\n".join(f"- {line}" for line in meta_lines)
                msg = f"{msg}\n\nTRIAGE INTAKE:\n{meta_text}"

        prompt, cfg = build_prompt(s, mode, msg, p_name, store)
        if override_prompt.strip():
            prompt = override_prompt.strip()

        try:
            res = await asyncio.to_thread(_generate_response, model_choice, force_cpu_slow, prompt, cfg)
        except RuntimeError as e:
            if str(e) == "SLOW_28B_CPU":
                return JSONResponse(
                    {
                        "error": "The 28B MedGemma model on CPU can take an hour or more. Continue?",
                        "confirm_28b": True,
                    },
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            if "Missing model cache" in str(e) or str(e) in {"REMOTE_TOKEN_MISSING", "LOCAL_INFERENCE_DISABLED"}:
                return JSONResponse(
                    {"error": str(e), "offline_missing": True},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
        elapsed_ms = max(int((datetime.now() - start_time).total_seconds() * 1000), 0)
        metrics = _update_chat_metrics(store, models["active_name"], elapsed_ms)

        if not is_priv:
            patient_display = (
                lookup_patient_display_name(p_name, store, default="Unnamed Crew")
                if mode == "triage"
                else "Inquiry"
            )
            entry = {
                "id": datetime.now().isoformat(),
                "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "patient": patient_display,
                "patient_id": p_name or "",
                "mode": mode,
                "query": msg,
                "user_query": user_msg_raw,
                "response": res,
                "model": models["active_name"],
                "duration_ms": elapsed_ms,
                "prompt": prompt,
                "injected_prompt": prompt,
            }
            existing = db_op("history", store=store)
            existing.append(entry)
            db_op("history", existing, store=store)

        return JSONResponse(
            {
                "response": f"{res}\n\n(Response time: {elapsed_ms} ms)",
                "model": models["active_name"],
                "duration_ms": elapsed_ms,
                "model_metrics": metrics,
            }
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/chat/preview")
async def chat_preview(request: Request, _=Depends(require_auth)):
    form = await request.form()
    msg = form.get("message")
    p_name = form.get("patient")
    mode = form.get("mode")
    store = request.state.store
    if mode == "triage":
        triage_consciousness = form.get("triage_consciousness") or ""
        triage_breathing_status = form.get("triage_breathing_status") or ""
        triage_pain_level = form.get("triage_pain_level") or ""
        triage_main_problem = form.get("triage_main_problem") or ""
        triage_temperature = form.get("triage_temperature") or ""
        triage_circulation = form.get("triage_circulation") or ""
        triage_cause = form.get("triage_cause") or ""
        meta_lines = []
        if triage_consciousness:
            meta_lines.append(f"Consciousness/Responsiveness: {triage_consciousness}")
        if triage_breathing_status:
            meta_lines.append(f"Breathing: {triage_breathing_status}")
        if triage_pain_level:
            meta_lines.append(f"Pain Level: {triage_pain_level}")
        if triage_main_problem:
            meta_lines.append(f"Main Problem: {triage_main_problem}")
        if triage_temperature:
            meta_lines.append(f"Body Temperature: {triage_temperature}")
        if triage_circulation:
            meta_lines.append(f"Circulation/BP: {triage_circulation}")
        if triage_cause:
            meta_lines.append(f"Cause: {triage_cause}")
        if meta_lines:
            meta_text = "\n".join(f"- {line}" for line in meta_lines)
            msg = f"{msg}\n\nTRIAGE INTAKE:\n{meta_text}"
    s = db_op("settings", store=store)
    prompt, cfg = build_prompt(s, mode, msg, p_name, store)
    return {"prompt": prompt, "mode": mode, "patient": p_name, "cfg": cfg}


def has_model_cache(model_name: str):
    ok, _ = model_cache_status(model_name)
    return ok


def model_cache_status(model_name: str):
    """Lightweight check: is the huggingface snapshot for this model present locally?"""
    safe = model_name.replace("/", "--")
    base = CACHE_DIR / "hub" / f"models--{safe}"
    if not base.exists():
        return False, "cache directory missing"
    snap_dir = base / "snapshots"
    if not snap_dir.exists():
        return False, "snapshots directory missing"
    last_err = "config/weights missing in cache"
    for child in snap_dir.iterdir():
        if not child.is_dir():
            continue
        cfg = child / "config.json"
        weights_present = any(child.glob("model-*.safetensors")) or (child / "model.safetensors").exists() or (child / "model.safetensors.index.json").exists()
        if cfg.exists() and weights_present:
            try:
                AutoConfig.from_pretrained(child, local_files_only=True)
            except Exception as e:
                last_err = f"config load failed: {e}"
                continue
            return True, ""
        if not cfg.exists():
            last_err = "config.json missing"
        elif not weights_present:
            last_err = "weights missing"
    return False, last_err


def is_offline_mode() -> bool:
    return os.environ.get("HF_HUB_OFFLINE") == "1" or os.environ.get("TRANSFORMERS_OFFLINE") == "1"


def _resolve_hf_token() -> Optional[str]:
    """Return a usable HF token even when HF_HOME points to a custom cache."""
    env_candidates = [
        os.environ.get("HUGGINGFACE_TOKEN"),
        os.environ.get("HF_TOKEN"),
        os.environ.get("HUGGINGFACEHUB_API_TOKEN"),
        os.environ.get("HUGGINGFACE_HUB_TOKEN"),
    ]
    for tok in env_candidates:
        if tok:
            cleaned = tok.strip()
            if cleaned:
                return cleaned
    # Fallback to the default login location (~/.cache/huggingface/token)
    default_token = Path.home() / ".cache" / "huggingface" / "token"
    try:
        if default_token.exists():
            token_text = default_token.read_text().strip()
            if token_text:
                return token_text
    except Exception:
        pass
    return None


def download_model_cache(model_name: str):
    """Attempt to download a model snapshot into the shared cache."""
    try:
        safe = model_name.replace("/", "--")
        base = CACHE_DIR / "hub" / f"models--{safe}"
        no_exist = base / ".no_exist"
        if no_exist.exists():
            shutil.rmtree(no_exist, ignore_errors=True)
        already_cached = has_model_cache(model_name)
        token = _resolve_hf_token()
        # Ensure core files are pulled (config + weights + tokenizer/processor)
        allow_patterns = [
            "config.json",
            "generation_config.json",
            "tokenizer_config.json",
            "tokenizer.json",
            "tokenizer.model",
            "vocab.json",
            "merges.txt",
            "preprocessor_config.json",
            "processor_config.json",
            "special_tokens_map.json",
            "model.safetensors",
            "model.safetensors.index.json",
            "model-*.safetensors",
            "chat_template*",
            "README*",
        ]
        snapshot_download(
            repo_id=model_name,
            cache_dir=str(CACHE_DIR / "hub"),
            local_dir=None,
            local_dir_use_symlinks=False,
            resume_download=True,
            force_download=not already_cached,
            allow_patterns=allow_patterns,
            token=token,
        )
        return True, ""
    except Exception as e:
        return False, str(e)


def _resolve_local_model_dir(model_name: str):
    """Return the latest cached snapshot directory for a model if present."""
    safe = model_name.replace("/", "--")
    snap_dir = CACHE_DIR / "hub" / f"models--{safe}" / "snapshots"
    if not snap_dir.exists():
        return None
    candidates = sorted([p for p in snap_dir.iterdir() if p.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
    return str(candidates[0]) if candidates else None


def verify_required_models(download_missing: bool = False):
    """Check cache presence for required models; optionally download missing if online."""
    results = []
    offline = is_offline_mode()
    for m in REQUIRED_MODELS:
        cached, cache_err = model_cache_status(m)
        downloaded = False
        error = ""
        # Allow download attempt unless offline flags are set
        if not cached and download_missing and AUTO_DOWNLOAD_MODELS and not offline:
            downloaded, error = download_model_cache(m)
            cached, cache_err = model_cache_status(m)
        if not cached and not error:
            error = cache_err or "config/weights missing in cache"
        results.append({"model": m, "cached": cached, "downloaded": downloaded, "error": error})
    return results


@app.get("/api/offline/check")
async def offline_check(_=Depends(require_auth)):
    """Report cache status/disk usage without downloading models."""
    try:
        model_status = verify_required_models(download_missing=False)
        usage = shutil.disk_usage(CACHE_DIR)
        disk = {
            "path": str(CACHE_DIR.resolve()),
            "free_gb": round(usage.free / (1024**3), 2),
            "total_gb": round(usage.total / (1024**3), 2),
        }
        env_flags = {
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
            "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
            "HF_HOME": os.environ.get("HF_HOME"),
            "HUGGINGFACE_HUB_CACHE": os.environ.get("HUGGINGFACE_HUB_CACHE"),
            "AUTO_DOWNLOAD_MODELS": str(AUTO_DOWNLOAD_MODELS),
        }
        missing = [m for m in model_status if not m["cached"]]
        return {
            "models": model_status,
            "missing": missing,
            "env": env_flags,
            "cache_dir": str(CACHE_DIR.resolve()),
            "offline_mode": is_offline_mode(),
            "disk": disk,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _parse_bool(val):
    if isinstance(val, bool):
        return val
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return bool(val)
    if isinstance(val, str):
        lowered = val.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return None


@app.post("/api/offline/backup")
async def offline_backup(request: Request, _=Depends(require_auth)):
    """Zip the model cache so it can be carried onboard or restored later."""
    try:
        store = request.state.store
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = store["backup"] / f"offline_backup_{ts}.zip"
        base = APP_HOME.resolve()
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for root in [store["data"], store["uploads"], CACHE_DIR]:
                for path in root.rglob("*"):
                    if path.is_file():
                        try:
                            arcname = path.resolve().relative_to(base)
                        except Exception:
                            # Fallback to basename if the file is unexpectedly outside APP_HOME
                            arcname = path.name
                        zf.write(path, arcname=str(arcname))
        return {"backup": str(dest.resolve())}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/offline/flags")
async def offline_flags(request: Request, _=Depends(require_auth)):
    """Toggle or set offline env flags for HF downloads."""
    try:
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        raw_enable = payload.get("enable", None)
        if raw_enable is None:
            raw_enable = request.query_params.get("enable")
        enable = _parse_bool(raw_enable)
        if enable is None:
            enable = not is_offline_mode()
        val = "1" if enable else "0"
        os.environ["HF_HUB_OFFLINE"] = val
        os.environ["TRANSFORMERS_OFFLINE"] = val
        # Persist preference in settings so it sticks across restarts
        try:
            existing = db_op("settings", store=request.state.store) or {}
            existing["offline_force_flags"] = enable
            db_op("settings", existing, store=request.state.store)
        except Exception:
            pass
        # Return a status payload identical to offline_check for UI reuse
        model_status = verify_required_models(download_missing=False)
        usage = shutil.disk_usage(CACHE_DIR)
        disk = {
            "path": str(CACHE_DIR.resolve()),
            "free_gb": round(usage.free / (1024**3), 2),
            "total_gb": round(usage.total / (1024**3), 2),
        }
        env_flags = {
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
            "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
            "HF_HOME": os.environ.get("HF_HOME"),
            "HUGGINGFACE_HUB_CACHE": os.environ.get("HUGGINGFACE_HUB_CACHE"),
            "AUTO_DOWNLOAD_MODELS": str(AUTO_DOWNLOAD_MODELS),
        }
        missing = [m for m in model_status if not m["cached"]]
        return {
            "models": model_status,
            "missing": missing,
            "env": env_flags,
            "cache_dir": str(CACHE_DIR.resolve()),
            "offline_mode": is_offline_mode(),
            "disk": disk,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/offline/restore")
async def offline_restore(request: Request, _=Depends(require_auth)):
    """Restore the latest offline backup (or a specified one) into the app root."""
    try:
        store = request.state.store
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        filename = (payload.get("filename") or "").strip()
        backup_dir = store["backup"]
        candidates = sorted(backup_dir.glob("offline_backup_*.zip"))
        target = None
        if filename:
            candidate = backup_dir / filename
            if candidate.exists() and candidate.is_file():
                target = candidate
        elif candidates:
            target = candidates[-1]
        if not target:
            return JSONResponse({"error": "No backup found to restore"}, status_code=status.HTTP_400_BAD_REQUEST)
        # Safety: ensure extraction stays inside app root
        with zipfile.ZipFile(target, "r") as zf:
            zf.extractall(Path("."))
        return {"restored": str(target.resolve())}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/offline/ensure")
async def offline_ensure(_=Depends(require_auth)):
    """Check cache and attempt to download any missing models (if online and allowed)."""
    try:
        results = verify_required_models(download_missing=True)
        missing = [m for m in results if not m["cached"]]
        return {
            "models": results,
            "missing": missing,
            "offline_mode": is_offline_mode(),
            "auto_download": AUTO_DOWNLOAD_MODELS,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/photos/cleanup")
async def cleanup_pharmacy_photos():
    """Legacy endpoint retained for compatibility; no action needed."""
    return {"cleared": 0, "details": []}


hb_models = _heartbeat("Housekeeping", interval=2.0)
_startup_model_check()
_background_verify_models()
_start_photo_worker()
hb_models.set()

if __name__ == "__main__":
    import uvicorn

    print("=" * 50)
    print("🏥 SailingMedAdvisor Starting (FastAPI)...")
    print("=" * 50)
    # Surface the absolute database location on startup for debugging/ops visibility
    print(f"Database path: {DB_PATH.resolve()}")
    print("Access via: http://0.0.0.0:5000 (all network interfaces)")
    print("=" * 50)

    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=False)
def _clear_store_data(store):
    """Remove data and uploads for a store to start fresh."""
    if not store:
        return
    # Clear data directory
    for path in store["data"].iterdir():
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        except Exception:
            continue
    # Clear uploads (including medicine photos)
    for path in store["uploads"].iterdir():
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        except Exception:
            continue
    # Recreate expected files with defaults
    db_op("settings", get_defaults(), store=store)
    db_op("patients", [], store=store)
    db_op("inventory", [], store=store)
    db_op("tools", [], store=store)
    db_op("history", [], store=store)
    db_op("vessel", {}, store=store)
    db_op("med_photo_queue", [], store=store)
    db_op("med_photo_jobs", [], store=store)
    db_op("chats", [], store=store)
    db_op("context", {}, store=store)


def _apply_default_dataset(store):
    """Copy default data + uploads into the given store."""
    if not store:
        return
    default_root = DATA_ROOT / "default"
    default_uploads = default_root / "uploads"
    default_root.mkdir(parents=True, exist_ok=True)
    default_uploads.mkdir(parents=True, exist_ok=True)
    (default_uploads / "medicines").mkdir(parents=True, exist_ok=True)
    # Copy data files
    for name in ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "med_photo_queue", "med_photo_jobs", "context"]:
        src = default_root / f"{name}.json"
        dest = store["data"] / f"{name}.json"
        if src.exists():
            dest.write_text(src.read_text())
    # Copy uploads (medicines)
    src_med = default_uploads / "medicines"
    dest_med = store["uploads"] / "medicines"
    if src_med.exists():
        dest_med.mkdir(parents=True, exist_ok=True)
        for item in src_med.iterdir():
            if item.is_file():
                shutil.copy2(item, dest_med / item.name)
