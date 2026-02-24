# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
File: app.py
Author notes: FastAPI entrypoint for SailingMedAdvisor. I define all routes,
startup wiring, and UI-serving helpers here. Keeps the rest of the codebase
focused on domain logic while this file glues HTTP -> db_store + static assets.
"""

import torch
import transformers
import os

# Keep startup output concise by default.
SHOW_STARTUP_DIAGNOSTICS = os.environ.get("STARTUP_DIAGNOSTICS", "0").strip() == "1"
if SHOW_STARTUP_DIAGNOSTICS:
    print("--- ENVIRONMENT DIAGNOSTICS ---")
    print(f"torch version: {torch.__version__}")
    print(f"torch cuda: {torch.version.cuda}")
    print(f"transformers version: {transformers.__version__}")
    print(f"CUDA Available: {torch.cuda.is_available()}")
    print(f"HUGGINGFACE_SPACE_ID: {os.environ.get('HUGGINGFACE_SPACE_ID')}")
    print("-------------------------------")

# Guard against unstable FP16 on GPUs that support BF16.
if os.environ.get("FORCE_FP16", "").strip() == "1" and torch.cuda.is_available() and torch.cuda.is_bf16_supported():
    if os.environ.get("ALLOW_FP16", "").strip() != "1":
        print("[startup] FORCE_FP16=1 detected, but BF16 is supported. For stability, ignoring FORCE_FP16.")
        os.environ["FORCE_FP16"] = "0"

os.environ.setdefault("TORCH_USE_CUDA_DSA", "0")
os.environ.setdefault("USE_FLASH_ATTENTION", "1")
import json
import uuid
import sqlite3
import secrets
import shutil
import zipfile
import csv
import asyncio
import threading
import base64
import time
import re
import mimetypes
import io
import logging

import medgemma4
import medgemma27b

from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote, unquote_to_bytes
from db_store import (
    configure_db,
    ensure_store,
    get_vessel,
    set_vessel,
    get_patients,
    get_patient_options,
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
    list_prompt_templates,
    upsert_prompt_template,
    get_inventory_items,
    set_inventory_items,
    delete_inventory_item,
    get_tool_items,
    set_tool_items,
    get_history_entries,
    set_history_entries,
    get_history_entry_by_id,
    upsert_history_entry,
    delete_history_entry_by_id,
    get_who_medicines,
    get_chats,
    set_chats,
    get_chat_metrics,
    set_chat_metrics,
    get_triage_options,
    set_triage_options,
    get_triage_prompt_modules,
    upsert_triage_prompt_module,
    set_triage_prompt_modules,
    get_triage_prompt_tree,
    set_triage_prompt_tree,
    get_triage_prompt_tree_default,
    reset_triage_prompt_tree_to_default,
    get_settings_meta,
    set_settings_meta,
    get_history_latency_metrics,
    get_context_payload,
    set_context_payload,
    update_item_verified,
    upsert_inventory_item,
)

logger = logging.getLogger("uvicorn.error")

# --- Optional startup cleanup (disabled by default to speed launch) ---
def _cleanup_and_report():
    """
     Cleanup And Report helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        import subprocess as _sp
        _sp.run("rm -rf ~/.cache/huggingface ~/.cache/torch ~/.cache/pip ~/.cache/*", shell=True, check=False)
        _sp.run("df -h && du -sh /home/user /home/user/* ~/.cache 2>/dev/null | sort -hr | head -30", shell=True, check=False)
    except Exception as exc:
        print(f"[startup-cleanup] failed: {exc}")

if os.environ.get("STARTUP_CLEANUP") == "1":
    _cleanup_and_report()

# --- Environment tuning for model runtime (VRAM, offline flags, cache paths) ---
# Encourage less fragmentation on GPUs with limited VRAM (e.g., RTX 5000).
# Keep both names for compatibility across PyTorch versions.
_alloc_conf_default = "expandable_segments:True"
if not os.environ.get("PYTORCH_CUDA_ALLOC_CONF") and not os.environ.get("PYTORCH_ALLOC_CONF"):
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = _alloc_conf_default
    os.environ["PYTORCH_ALLOC_CONF"] = _alloc_conf_default
elif os.environ.get("PYTORCH_CUDA_ALLOC_CONF") and not os.environ.get("PYTORCH_ALLOC_CONF"):
    os.environ["PYTORCH_ALLOC_CONF"] = os.environ["PYTORCH_CUDA_ALLOC_CONF"]
elif os.environ.get("PYTORCH_ALLOC_CONF") and not os.environ.get("PYTORCH_CUDA_ALLOC_CONF"):
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = os.environ["PYTORCH_ALLOC_CONF"]
# Allow online downloads by default (HF Spaces first run needs this). We can set these to "1" after caches are warm.
os.environ.setdefault("HF_HUB_OFFLINE", "0")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
# Feature flag for tab bar theme:
# 0 = existing gray, 1 = splash-screen purple (#7452B9).
USE_SPLASH_PURPLE_TABBAR = os.environ.get("USE_SPLASH_PURPLE_TABBAR", "0").strip().lower() in {"1", "true", "yes", "on"}
AUTO_DOWNLOAD_MODELS = os.environ.get("AUTO_DOWNLOAD_MODELS", "1" if os.environ.get("HUGGINGFACE_SPACE_ID") else "0") == "1"
# Default off for faster startup; set to "1" when we explicitly want cache verification
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

# Gemma3 masking patch for torch<2.6 (required when token_type_ids are present).
def _torch_version_ge(major: int, minor: int) -> bool:
    """
     Torch Version Ge helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        base = torch.__version__.split("+", 1)[0]
        parts = base.split(".")
        return (int(parts[0]), int(parts[1])) >= (major, minor)
    except Exception:
        return False

def _patch_gemma3_mask_for_torch():
    """
     Patch Gemma3 Mask For Torch helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if _torch_version_ge(2, 6):
        return
    try:
        import transformers.models.gemma3.modeling_gemma3 as gemma_model
        _orig_create_causal_mask_mapping = gemma_model.create_causal_mask_mapping

        def _create_causal_mask_mapping_no_or(*args, **kwargs):
            # torch<2.6 can't use or_mask_function; ignore token_type_ids for text-only.
            """
             Create Causal Mask Mapping No Or helper.
            Detailed inline notes are included to support safe maintenance and future edits.
            """
            if len(args) >= 7:
                args = list(args)
                args[6] = None
            if "token_type_ids" in kwargs:
                kwargs = dict(kwargs)
                kwargs["token_type_ids"] = None
            return _orig_create_causal_mask_mapping(*args, **kwargs)

        gemma_model.create_causal_mask_mapping = _create_causal_mask_mapping_no_or
        print("[startup] patched Gemma3 mask for torch<2.6", flush=True)
    except Exception as exc:
        print(f"[startup] Gemma3 mask patch skipped: {exc}", flush=True)

_patch_gemma3_mask_for_torch()

# Local inference debug logging (disabled by default to avoid noisy console output)
DEBUG_LOCAL_INFERENCE = os.environ.get("DEBUG_LOCAL_INFERENCE", "0") == "1"
_DEBUG_START = time.perf_counter()

def _dbg(msg: str):
    """
     Dbg helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if DEBUG_LOCAL_INFERENCE:
        wall = time.strftime("%Y-%m-%d %H:%M:%S")
        elapsed = time.perf_counter() - _DEBUG_START
        print(f"[debug {wall} +{elapsed:.2f}s] {msg}", flush=True)

# Remote inference (used when local is disabled, e.g., on HF Space)
HF_REMOTE_TOKEN = (
    os.environ.get("HF_REMOTE_TOKEN")
    or os.environ.get("HUGGINGFACE_TOKEN")
    or os.environ.get("MEDGEMMA_TOKEN")
    or ""
)
# Default remote text model; when MedGemma 4B/27B is selected we pass that through instead.
REMOTE_MODEL = os.environ.get("REMOTE_MODEL") or "google/medgemma-1.5-4b-it"

_dbg(
    "env flags: "
    + ", ".join(
        [
            f"IS_HF_SPACE={IS_HF_SPACE}",
            f"DISABLE_LOCAL_INFERENCE={DISABLE_LOCAL_INFERENCE}",
            f"AUTO_DOWNLOAD_MODELS={AUTO_DOWNLOAD_MODELS}",
            f"VERIFY_MODELS_ON_START={VERIFY_MODELS_ON_START}",
            f"AUTO_VERIFY_ONLINE={AUTO_VERIFY_ONLINE}",
            f"HF_HUB_OFFLINE={os.environ.get('HF_HUB_OFFLINE')}",
            f"TRANSFORMERS_OFFLINE={os.environ.get('TRANSFORMERS_OFFLINE')}",
            f"HF_REMOTE_TOKEN_SET={bool(HF_REMOTE_TOKEN)}",
        ]
    )
)

import torch

from fastapi import FastAPI, Request, HTTPException, status, Depends, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
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
    """
     Is Valid Sqlite helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        with open(path, "rb") as f:
            header = f.read(16)
        return header.startswith(b"SQLite format 3")
    except Exception:
        return False


def _db_is_populated(path: Path) -> bool:
    """
     Db Is Populated helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
        if not force and DB_PATH.stat().st_size > 0 and _is_valid_sqlite(DB_PATH):
            # Never overwrite a valid DB unless explicitly forced.
            return
        # drop the stale/invalid DB before seeding
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
]

# Explicit model type mapping to avoid misclassifying text-only models as vision.
TEXT_MODELS = {
    "google/medgemma-1.5-4b-it",
    "google/medgemma-27b-text-it",
}
VISION_MODELS = set()


def _update_chat_metrics(store, model_name: str):
    """Recompute per-model metrics from history_entries to keep averages accurate."""
    metrics = get_history_latency_metrics()
    # Persist snapshot for clients that still read chat_metrics
    db_op("chat_metrics", metrics, store=store)
    return metrics.get(model_name, {"count": 0, "total_ms": 0, "avg_ms": 0})


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
# Precision policy: default to bf16 when supported; allow env override
force_fp16 = os.environ.get("FORCE_FP16", "").strip() == "1"
if device == "cuda" and force_fp16:
    dtype = torch.float16
elif device == "cuda" and torch.cuda.is_bf16_supported():
    dtype = torch.bfloat16
elif device == "cuda":
    dtype = torch.float16
else:
    dtype = torch.float32
models = {"active_name": "", "model": None, "processor": None, "tokenizer": None, "is_text": False}
MODEL_MUTEX = threading.Lock()
MODEL_BUSY_META_LOCK = threading.Lock()
MODEL_BUSY_META = {
    "busy": False,
    "model_choice": "",
    "mode": "",
    "session_id": "",
    "patient": "",
    "started_at": "",
}
try:
    CHAT_QUEUE_MAX = int(os.environ.get("CHAT_QUEUE_MAX", "6"))
except Exception:
    CHAT_QUEUE_MAX = 6
if CHAT_QUEUE_MAX < 1:
    CHAT_QUEUE_MAX = 1
CHAT_QUEUE_LOCK = threading.Lock()
CHAT_QUEUE_COND = threading.Condition(CHAT_QUEUE_LOCK)
CHAT_QUEUE_NEXT_TICKET = 1
CHAT_QUEUE_SERVING_TICKET = 1
CHAT_QUEUE_ENTRIES = {}


def _set_model_busy_meta(model_choice: str, mode: str, session_id: str, patient: str) -> None:
    """
     Set Model Busy Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    started_at = datetime.utcnow().isoformat()
    with MODEL_BUSY_META_LOCK:
        MODEL_BUSY_META.update(
            {
                "busy": True,
                "model_choice": model_choice or "",
                "mode": mode or "",
                "session_id": session_id or "",
                "patient": patient or "",
                "started_at": started_at,
            }
        )


def _clear_model_busy_meta() -> None:
    """
     Clear Model Busy Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with MODEL_BUSY_META_LOCK:
        MODEL_BUSY_META.update(
            {
                "busy": False,
                "model_choice": "",
                "mode": "",
                "session_id": "",
                "patient": "",
                "started_at": "",
            }
        )


def _get_model_busy_meta() -> dict:
    """
     Get Model Busy Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    with MODEL_BUSY_META_LOCK:
        return dict(MODEL_BUSY_META)


def _chat_queue_snapshot_locked() -> dict:
    """
    Return queue state while holding CHAT_QUEUE_LOCK.
    """
    ordered_tickets = sorted(CHAT_QUEUE_ENTRIES.keys())
    active_ticket = CHAT_QUEUE_SERVING_TICKET if CHAT_QUEUE_SERVING_TICKET in CHAT_QUEUE_ENTRIES else None
    waiting_count = max(len(ordered_tickets) - (1 if active_ticket is not None else 0), 0)
    active_entry = CHAT_QUEUE_ENTRIES.get(active_ticket) if active_ticket is not None else None
    active = None
    if isinstance(active_entry, dict):
        active = {
            "ticket": active_ticket,
            "model_choice": active_entry.get("model_choice") or "",
            "mode": active_entry.get("mode") or "",
            "session_id": active_entry.get("session_id") or "",
            "patient": active_entry.get("patient") or "",
            "started_at": active_entry.get("started_at") or "",
            "queued_at": active_entry.get("queued_at") or "",
        }
    return {
        "max": CHAT_QUEUE_MAX,
        "depth": len(ordered_tickets),
        "waiting": waiting_count,
        "next_ticket": CHAT_QUEUE_NEXT_TICKET,
        "serving_ticket": CHAT_QUEUE_SERVING_TICKET,
        "active": active,
    }


def _chat_queue_snapshot() -> dict:
    """
    Return queue state for API/debug visibility.
    """
    with CHAT_QUEUE_LOCK:
        return _chat_queue_snapshot_locked()


def _chat_queue_enqueue(model_choice: str, mode: str, session_id: str, patient: str):
    """
    Register a chat request in the global inference queue.
    """
    global CHAT_QUEUE_NEXT_TICKET
    with CHAT_QUEUE_COND:
        if len(CHAT_QUEUE_ENTRIES) >= CHAT_QUEUE_MAX:
            return None, _chat_queue_snapshot_locked()
        ticket = CHAT_QUEUE_NEXT_TICKET
        CHAT_QUEUE_NEXT_TICKET += 1
        CHAT_QUEUE_ENTRIES[ticket] = {
            "ticket": ticket,
            "model_choice": (model_choice or "").strip(),
            "mode": (mode or "").strip(),
            "session_id": (session_id or "").strip(),
            "patient": (patient or "").strip(),
            "queued_at": datetime.utcnow().isoformat(),
            "started_at": "",
        }
        ordered_tickets = sorted(CHAT_QUEUE_ENTRIES.keys())
        try:
            position = ordered_tickets.index(ticket) + 1
        except ValueError:
            position = len(ordered_tickets)
        snapshot = _chat_queue_snapshot_locked()
        snapshot["position"] = position
        snapshot["ticket"] = ticket
        return ticket, snapshot


def _chat_queue_wait_turn(ticket: int) -> int:
    """
    Block until a queued request reaches the active inference slot.
    Returns the queue wait duration in seconds.
    """
    with CHAT_QUEUE_COND:
        while True:
            if ticket not in CHAT_QUEUE_ENTRIES:
                raise RuntimeError("CHAT_QUEUE_TICKET_MISSING")
            if ticket == CHAT_QUEUE_SERVING_TICKET:
                now = datetime.utcnow()
                entry = CHAT_QUEUE_ENTRIES.get(ticket) or {}
                entry["started_at"] = now.isoformat()
                CHAT_QUEUE_ENTRIES[ticket] = entry
                queued_at_iso = entry.get("queued_at") or ""
                wait_seconds = 0
                if queued_at_iso:
                    try:
                        wait_seconds = max(int((now - datetime.fromisoformat(queued_at_iso)).total_seconds()), 0)
                    except Exception:
                        wait_seconds = 0
                return wait_seconds
            CHAT_QUEUE_COND.wait(timeout=0.5)


def _chat_queue_release(ticket: int) -> None:
    """
    Advance the queue after a chat completes (success or failure).
    """
    global CHAT_QUEUE_SERVING_TICKET
    with CHAT_QUEUE_COND:
        CHAT_QUEUE_ENTRIES.pop(ticket, None)
        if ticket == CHAT_QUEUE_SERVING_TICKET:
            CHAT_QUEUE_SERVING_TICKET += 1
        while CHAT_QUEUE_SERVING_TICKET < CHAT_QUEUE_NEXT_TICKET and CHAT_QUEUE_SERVING_TICKET not in CHAT_QUEUE_ENTRIES:
            CHAT_QUEUE_SERVING_TICKET += 1
        CHAT_QUEUE_COND.notify_all()
# Configure SDP backends safely.
# Keep math SDP enabled as a guaranteed fallback to avoid:
# "No available kernel. Aborting execution."
if device == "cuda":
    try:
        use_fast_sdp = os.environ.get("USE_FAST_SDP", "0").strip() == "1"
        torch.backends.cuda.enable_flash_sdp(use_fast_sdp)
        torch.backends.cuda.enable_mem_efficient_sdp(use_fast_sdp)
        torch.backends.cuda.enable_math_sdp(True)
    except Exception:
        pass

# BitsAndBytes (4-bit) is optional; enable selectively for large models.
quant_config = None
if device == "cuda" and os.environ.get("DISABLE_BNB", "").strip() != "1":
    try:
        _ = __import__("bitsandbytes")
        bnb_compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=bnb_compute_dtype,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
            # Allow CPU offload when device_map="auto" needs it.
            llm_int8_enable_fp32_cpu_offload=True,
        )
    except Exception as exc:
        print(f"[quant] bitsandbytes unavailable; running without 4-bit quantization ({exc})", flush=True)
    torch.backends.cuda.matmul.allow_tf32 = True


def _sanitize_store(name: str) -> str:
    """
     Sanitize Store helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"

def _label_from_slug(slug: str) -> str:
    """
     Label From Slug helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    cleaned = _sanitize_store(slug)
    return DEFAULT_store_LABEL if _sanitize_store(DEFAULT_store_LABEL) == cleaned else ""

def _migrate_existing_to_default(store):
    """
    Copy legacy single-store files into the new slugged directory layout.
    Idempotent and non-destructive (source files are left in place).
    """
    try:
        slug = store.get("slug") or "default"
        legacy_root = BASE_STORE / slug  # e.g., data/default
        new_data_dir = store.get("data") or (DATA_ROOT / slug)
        new_uploads_dir = store.get("uploads") or (UPLOAD_ROOT / slug)
        legacy_uploads_dir = legacy_root / "uploads"

        # Copy JSON payloads (patients, inventory, etc.) into data/<slug> if missing there
        if legacy_root.exists():
            for path in legacy_root.glob("*.json"):
                dest = new_data_dir / path.name
                if not dest.exists():
                    try:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(path, dest)
                    except Exception:
                        pass

        # Copy legacy uploads into uploads/<slug>/*
        if legacy_uploads_dir.exists():
            for item in legacy_uploads_dir.iterdir():
                dest = new_uploads_dir / item.name
                try:
                    if item.is_dir():
                        shutil.copytree(item, dest, dirs_exist_ok=True)
                    else:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        if not dest.exists():
                            shutil.copy2(item, dest)
                except Exception:
                    pass

    except Exception:
        # Silent failure to avoid blocking startup on migration issues
        pass


def _store_dirs(store_label: str):
    """
     Store Dirs helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    slug = _sanitize_store(store_label)
    ws_rec = ensure_store(store_label, slug)
    data_dir = DATA_ROOT / slug
    uploads_dir = UPLOAD_ROOT / slug
    backup_dir = BACKUP_ROOT / slug
    for path in [data_dir, uploads_dir, backup_dir]:
        path.mkdir(parents=True, exist_ok=True)
    return {
        "label": store_label,
        "slug": slug,
        "data": data_dir,
        "uploads": uploads_dir,
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
    """
     Startup Model Check helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
        """
         Runner helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
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
    _dbg("model unloaded and CUDA cache cleared")


def _same_med(a, b):
    """
    Determine if two medication records represent the same pharmaceutical item.
    
    This function is critical for duplicate detection during imports (e.g., WHO list,
    CSV uploads) to prevent creating multiple inventory entries for the
    same medication.
    
    Matching Logic:
    ---------------
    1. Generic name MUST match (case-insensitive, normalized)
    2. Placeholder names like "Medication" or empty strings are NOT considered matches
       to avoid incorrectly deduplicating legitimate imports
    3. Strength must match when BOTH records have strength specified
    4. If only one record has strength, they can still match (allows partial imports)
    
    Args:
        a (dict): First medication record with keys: genericName, strength
        b (dict): Second medication record with keys: genericName, strength
    
    Returns:
        bool: True if medications are considered the same item, False otherwise
    
    Examples:
        >>> _same_med(
        ...     {"genericName": "Ibuprofen", "strength": "500mg"},
        ...     {"genericName": "ibuprofen", "strength": "500mg"}
        ... )
        True
        
        >>> _same_med(
        ...     {"genericName": "Ibuprofen", "strength": "500mg"},
        ...     {"genericName": "Ibuprofen", "strength": "200mg"}
        ... )
        False
        
        >>> _same_med(
        ...     {"genericName": "Medication", "strength": ""},  # Placeholder
        ...     {"genericName": "Medication", "strength": ""}
        ... )
        False  # Placeholders don't match to avoid false positives
    
    Notes:
        - Brand names are NOT considered in matching (intentional - same generic
          from different brands should merge)
        - Form (tablet, capsule, etc.) is NOT considered in matching
        - This is used by WHO list imports
    """

    def norm(val):
        """Normalize a medication name/strength for case-insensitive comparison."""
        v = (val or "").strip().lower()
        # Treat empty strings and generic placeholders as non-matches
        return "" if v in {"", "medication", "med"} else v

    # Extract and normalize generic names
    ga, gb = norm(a.get("genericName")), norm(b.get("genericName"))
    
    # Extract and normalize strengths
    sa, sb = norm(a.get("strength")), norm(b.get("strength"))
    
    # Both must have real (non-placeholder) generic names
    if not ga or not gb:
        return False
    
    # Generic names must match exactly (after normalization)
    if ga != gb:
        return False
    
    # If both have strength specified, they must match
    if sa and sb:
        return sa == sb
    
    # If only one has strength (or neither), consider it a match based on generic name alone
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
        _dbg(f"load_model: model already active ({model_name})")
        return
    force_cuda = os.environ.get("FORCE_CUDA", "").strip() == "1"
    runtime_device = "cuda" if torch.cuda.is_available() else "cpu"
    _dbg(
        f"load_model: name={model_name} runtime_device={runtime_device} force_cuda={force_cuda} allow_cpu_large={allow_cpu_large}"
    )
    t0 = time.perf_counter()
    if force_cuda and runtime_device != "cuda":
        raise RuntimeError("CUDA_NOT_AVAILABLE")
    local_dir = _resolve_local_model_dir(model_name)
    _dbg(f"load_model: resolved local snapshot dir: {local_dir}")
    # Free previous model to avoid VRAM exhaustion when switching
    unload_model()
    # Warn on CPU usage for large model unless explicitly allowed
    if "28b" in model_name.lower() and runtime_device != "cuda" and not allow_cpu_large:
        raise RuntimeError("SLOW_28B_CPU")

    # Ensure cache exists (attempt download if allowed and online)
    cached, cache_err = model_cache_status(model_name)
    _dbg(f"load_model: cache status cached={cached} err={cache_err}")
    if not cached and AUTO_DOWNLOAD_MODELS and not is_offline_mode():
        downloaded, err = download_model_cache(model_name)
        _dbg(f"load_model: auto-download attempted downloaded={downloaded} err={err}")
        if downloaded:
            cached, cache_err = model_cache_status(model_name)
        elif err:
            print(f"[offline] auto-download failed for {model_name}: {err}")
    if not cached:
        raise RuntimeError(
            f"Missing model cache for {model_name}. "
            f"{cache_err or 'Open Settings → Offline Readiness to download and back up models.'}"
        )

    model_name = (model_name or "").strip()
    model_name_l = model_name.lower()
    is_text_only = model_name not in VISION_MODELS
    is_medgemma = "medgemma" in model_name_l
    is_large_medgemma = "27b" in model_name_l or "28b" in model_name_l
    # Prefer keeping as much on GPU as possible; allow env override
    if runtime_device == "cuda" and force_cuda and not is_large_medgemma:
        device_map = "cuda"
    else:
        device_map = "auto" if runtime_device == "cuda" else "cpu"
    if runtime_device == "cuda" and is_large_medgemma:
        # Prefer dedicated cap for 27B/28B even when MODEL_MAX_GPU_MEM is set globally.
        max_mem_gpu = os.environ.get("MODEL_MAX_GPU_MEM_27B") or os.environ.get("MODEL_MAX_GPU_MEM") or "8GiB"
    else:
        max_mem_gpu = os.environ.get("MODEL_MAX_GPU_MEM", "15GiB")
    max_mem_cpu = os.environ.get("MODEL_MAX_CPU_MEM", "64GiB")
    max_memory = {0: max_mem_gpu, "cpu": max_mem_cpu} if runtime_device == "cuda" else None
    # Enforce expected GPU for local MedGemma runs.
    if runtime_device == "cuda" and is_medgemma and not IS_HF_SPACE:
        enforce_rtx = os.environ.get("ENFORCE_RTX5000", "1").strip() == "1"
        if enforce_rtx:
            gpu_name = torch.cuda.get_device_name(0)
            if "RTX 5000" not in gpu_name.upper():
                raise RuntimeError(f"Unexpected GPU detected: '{gpu_name}'. Expected RTX 5000.")
        if not torch.cuda.is_bf16_supported():
            raise RuntimeError("MedGemma requires bfloat16 for stable inference on this GPU.")

    # On CPU, use float32; on CUDA pick a safe GPU dtype
    if runtime_device == "cuda":
        load_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    else:
        load_dtype = torch.float32
    _dbg(
        f"load_model: device_map={device_map} dtype={load_dtype} max_memory={max_memory} quantized={quant_config is not None}"
    )
    model_kwargs = {
        "torch_dtype": load_dtype,
        "device_map": device_map,
        "low_cpu_mem_usage": True,
        "local_files_only": True,
    }
    if runtime_device == "cuda" and is_medgemma:
        # Avoid flash/SDPA instability on older RTX cards.
        model_kwargs["attn_implementation"] = "eager"
    if runtime_device == "cuda":
        use_quant = quant_config is not None and ("27b" in model_name.lower() or "28b" in model_name.lower())
        if is_large_medgemma and quant_config is None:
            raise RuntimeError("27B/28B requires bitsandbytes 4-bit quantization for this GPU.")
        model_kwargs.update(
            {
                "max_memory": max_memory,
                "offload_folder": str(OFFLOAD_DIR),
                "quantization_config": quant_config if use_quant else None,
            }
        )
        _dbg(f"load_model: use_quant={use_quant}")
    if force_cuda or os.environ.get("DEBUG_DEVICE", "").strip() == "1":
        print(
            f"[model] runtime_device={runtime_device} device_map={device_map} dtype={load_dtype} force_cuda={force_cuda}",
            flush=True,
        )
    load_path = local_dir or model_name
    if is_text_only:
        _dbg("load_model: loading text model")
        t_tok = time.perf_counter()
        models["tokenizer"] = AutoTokenizer.from_pretrained(load_path, use_fast=True, local_files_only=True)
        _dbg(f"load_model: tokenizer loaded in {time.perf_counter() - t_tok:.2f}s")
        if is_medgemma:
            t_proc = time.perf_counter()
            models["processor"] = AutoProcessor.from_pretrained(load_path, use_fast=True, local_files_only=True)
            _dbg(f"load_model: text processor loaded in {time.perf_counter() - t_proc:.2f}s")
        else:
            models["processor"] = None
        t_model = time.perf_counter()
        models["model"] = AutoModelForCausalLM.from_pretrained(
            load_path,
            **model_kwargs,
        )
        _dbg(f"load_model: text model loaded in {time.perf_counter() - t_model:.2f}s")
    else:
        _dbg("load_model: loading vision model")
        t_proc = time.perf_counter()
        models["processor"] = AutoProcessor.from_pretrained(load_path, use_fast=True, local_files_only=True)
        _dbg(f"load_model: processor loaded in {time.perf_counter() - t_proc:.2f}s")
        models["tokenizer"] = None
        t_model = time.perf_counter()
        models["model"] = AutoModelForImageTextToText.from_pretrained(
            load_path,
            **model_kwargs,
        )
        _dbg(f"load_model: vision model loaded in {time.perf_counter() - t_model:.2f}s")
    # Force GPU placement for smaller models when requested; fail fast on errors.
    if (
        force_cuda
        and runtime_device == "cuda"
        and "27b" not in model_name.lower()
        and "28b" not in model_name.lower()
    ):
        try:
            _dbg("load_model: forcing model.to('cuda')")
            t_move = time.perf_counter()
            models["model"] = models["model"].to("cuda")
            _dbg(f"load_model: model.to('cuda') in {time.perf_counter() - t_move:.2f}s")
        except Exception as exc:
            raise RuntimeError(f"CUDA_MOVE_FAILED: {exc}")
    if force_cuda or os.environ.get("DEBUG_DEVICE", "").strip() == "1":
        model_obj = models.get("model")
        model_dev = getattr(model_obj, "device", "n/a")
        model_map = getattr(model_obj, "hf_device_map", None)
        try:
            mem_alloc = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
        except Exception:
            mem_alloc = "n/a"
        print(f"[model] loaded device={model_dev} hf_device_map={model_map} cuda_mem={mem_alloc}", flush=True)
    models["is_text"] = is_text_only
    models["active_name"] = model_name
    _dbg(f"load_model: load complete in {time.perf_counter() - t0:.2f}s")


def get_defaults():
    """
    Get Defaults helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return {
        "triage_instruction": "Act as Lead Clinician. Priority: Life-saving protocols. Format: ## ASSESSMENT, ## PROTOCOL.",
        "inquiry_instruction": "Act as Medical Librarian. Focus: Academic research and pharmacology.",
        "tr_temp": 0.1,
        "tr_tok": 1024,
        "tr_p": 0.9,
        "tr_k": 50,
        "in_temp": 0.6,
        "in_tok": 2048,
        "in_p": 0.95,
        "in_k": 50,
        "rep_penalty": 1.1,
        "mission_context": "Isolated Medical Station offshore.",
        "user_mode": "user",
        "last_prompt_verbatim": "",
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
        "chat_metrics",
        "vessel",
    ]
    if cat not in allowed_categories:
        raise ValueError(f"Invalid category: {cat}")

    def default_for(category):
        """
        Default For helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
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
                "boatPhoto": "",
                "registrationFrontPhoto": "",
                "registrationBackPhoto": "",
            }
        if category == "chat_metrics":
            return {}
        if category == "chats":
            return []
        return []

    def load_legacy(category):
        """
        Load Legacy helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
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
            existing = get_vessel() or {}
            merged = {**default_for("vessel"), **(existing if isinstance(existing, dict) else {}), **(data or {})}
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
    if cat == "context":
        return get_context_payload()
    if cat == "settings":
        return {**get_defaults(), **loaded}
    return loaded


def safe_float(val, default):
    """
    Safe Float helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def safe_int(val, default):
    """
    Safe Int helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


TRIAGE_SELECTION_FIELDS = [
    ("domain", "triage_domain", "Domain"),
    ("problem", "triage_problem", "Problem / Injury Type"),
    ("anatomy", "triage_anatomy", "Anatomy"),
    ("severity", "triage_severity", "Severity / Complication"),
    ("mechanism", "triage_mechanism", "Mechanism / Cause"),
]

TRIAGE_CONDITION_FIELDS = [
    ("consciousness", "triage_consciousness", "Consciousness"),
    ("breathing", "triage_breathing", "Breathing"),
    ("circulation", "triage_circulation", "Circulation"),
    ("overall_stability", "triage_overall_stability", "Overall Stability"),
]


def extract_triage_selections(form):
    """
    Extract Triage Selections helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    selections = {}
    for category, field_name, _ in TRIAGE_SELECTION_FIELDS:
        selections[category] = (form.get(field_name) or "").strip()
    return selections


def extract_triage_conditions(form):
    """
    Extract Triage Conditions helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    conditions = {}
    for category, field_name, _ in TRIAGE_CONDITION_FIELDS:
        conditions[category] = (form.get(field_name) or "").strip()
    return conditions


def triage_selection_meta(selections: dict):
    """
    Triage Selection Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    data = selections or {}
    meta = {}
    for category, _, label in TRIAGE_SELECTION_FIELDS:
        val = (data.get(category) or "").strip()
        if val:
            meta[label] = val
    return meta


def triage_condition_meta(conditions: dict):
    """
    Triage Condition Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    data = conditions or {}
    meta = {}
    for category, _, label in TRIAGE_CONDITION_FIELDS:
        val = (data.get(category) or "").strip()
        if val:
            meta[label] = val
    return meta


def _normalize_triage_key(value: str) -> str:
    """
     Normalize Triage Key helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())


def _lookup_tree_node(options, selected_value):
    """
     Lookup Tree Node helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(options, dict):
        return "", None
    selected = (selected_value or "").strip()
    if not selected:
        return "", None
    if selected in options:
        return selected, options.get(selected)
    want = _normalize_triage_key(selected)
    if not want:
        return "", None
    for key, value in options.items():
        if _normalize_triage_key(str(key)) == want:
            return str(key), value
    return "", None


def evaluate_triage_pathway_definition(selections):
    """
    Determine whether the currently selected triage pathway is fully defined.

    A pathway is considered incomplete when:
    - Selected nodes cannot be resolved in the stored tree.
    - Downstream rule maps exist but required selections are missing.
    - Selected downstream nodes exist but their rule text is blank.
    - A selected problem has no usable rule text at all.
    """
    selected = {k: (v or "").strip() for k, v in (selections or {}).items()}
    if not any(selected.values()):
        return {
            "selected": False,
            "fully_defined": False,
            "supplement_with_general": False,
            "reason": "no_selection",
        }

    tree_payload = get_triage_prompt_tree() or {}
    tree = tree_payload.get("tree") if isinstance(tree_payload, dict) else {}
    if not isinstance(tree, dict) or not tree:
        return {
            "selected": True,
            "fully_defined": False,
            "supplement_with_general": True,
            "reason": "tree_missing",
        }

    domain_key, domain_node = _lookup_tree_node(tree, selected.get("domain"))
    if selected.get("domain") and not domain_key:
        return {
            "selected": True,
            "fully_defined": False,
            "supplement_with_general": True,
            "reason": "domain_not_found",
        }
    if not isinstance(domain_node, dict):
        return {
            "selected": True,
            "fully_defined": False,
            "supplement_with_general": True,
            "reason": "domain_invalid",
        }

    if not selected.get("problem"):
        return {
            "selected": True,
            "fully_defined": False,
            "supplement_with_general": True,
            "reason": "problem_missing",
        }

    problem_key, problem_node = _lookup_tree_node(domain_node.get("problems") or {}, selected.get("problem"))
    if not problem_key or not isinstance(problem_node, dict):
        return {
            "selected": True,
            "fully_defined": False,
            "supplement_with_general": True,
            "reason": "problem_not_found",
        }

    anatomy_map = problem_node.get("anatomy_guardrails") if isinstance(problem_node.get("anatomy_guardrails"), dict) else {}
    severity_map = problem_node.get("severity_modifiers") if isinstance(problem_node.get("severity_modifiers"), dict) else {}
    mechanism_map = problem_node.get("mechanism_modifiers") if isinstance(problem_node.get("mechanism_modifiers"), dict) else {}

    def _resolved_text(option_map, option_value):
        """
         Resolved Text helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        key, text = _lookup_tree_node(option_map or {}, option_value)
        if key and isinstance(text, str) and text.strip():
            return key, text.strip()
        return "", ""

    missing_reasons = []

    if anatomy_map:
        if not selected.get("anatomy"):
            missing_reasons.append("anatomy_missing")
        else:
            resolved_key, resolved_text = _resolved_text(anatomy_map, selected.get("anatomy"))
            if not resolved_key or not resolved_text:
                missing_reasons.append("anatomy_rule_missing")
    elif selected.get("anatomy"):
        missing_reasons.append("anatomy_not_supported")

    if severity_map:
        if not selected.get("severity"):
            missing_reasons.append("severity_missing")
        else:
            resolved_key, resolved_text = _resolved_text(severity_map, selected.get("severity"))
            if not resolved_key or not resolved_text:
                missing_reasons.append("severity_rule_missing")
    elif selected.get("severity"):
        missing_reasons.append("severity_not_supported")

    if mechanism_map:
        if not selected.get("mechanism"):
            missing_reasons.append("mechanism_missing")
        else:
            resolved_key, resolved_text = _resolved_text(mechanism_map, selected.get("mechanism"))
            if not resolved_key or not resolved_text:
                missing_reasons.append("mechanism_rule_missing")
    elif selected.get("mechanism"):
        missing_reasons.append("mechanism_not_supported")

    procedure = (problem_node.get("procedure") or "").strip()
    extra_problem_text = any(
        isinstance(v, str) and v.strip()
        for k, v in problem_node.items()
        if k not in {"procedure", "anatomy_guardrails", "severity_modifiers", "mechanism_modifiers"}
    )
    map_text_exists = any(
        isinstance(v, str) and v.strip()
        for m in (anatomy_map, severity_map, mechanism_map)
        for v in (m or {}).values()
    )
    if not (procedure or extra_problem_text or map_text_exists):
        missing_reasons.append("problem_rules_empty")

    fully_defined = len(missing_reasons) == 0
    return {
        "selected": True,
        "fully_defined": fully_defined,
        "supplement_with_general": not fully_defined,
        "reason": missing_reasons[0] if missing_reasons else "ok",
    }


def assemble_system_prompt(selections, user_metadata_block=""):
    """
    Build hierarchical triage system instruction from the selected tree path.

    Returns an empty string when no dropdowns are selected so callers can
    fall back to the generic triage prompt.
    """
    selected = {k: (v or "").strip() for k, v in (selections or {}).items()}
    if not any(selected.values()):
        return ""

    tree_payload = get_triage_prompt_tree() or {}
    tree = tree_payload.get("tree") if isinstance(tree_payload, dict) else {}
    if not isinstance(tree, dict) or not tree:
        return ""
    base_doctrine = (tree_payload.get("base_doctrine") or "").strip()

    sections = []
    if base_doctrine:
        sections.append(f"BASE_DOCTRINE:\n{base_doctrine}")

    domain_key, domain_node = _lookup_tree_node(tree, selected.get("domain"))
    if domain_key and isinstance(domain_node, dict):
        mindset = (domain_node.get("mindset") or "").strip()
        if mindset:
            sections.append(f"DOMAIN [{domain_key}]:\nMINDSET: {mindset}")

    problem_key = ""
    problem_node = None
    if isinstance(domain_node, dict):
        problem_key, problem_node = _lookup_tree_node(domain_node.get("problems") or {}, selected.get("problem"))
    if problem_key and isinstance(problem_node, dict):
        problem_lines = []
        procedure = (problem_node.get("procedure") or "").strip()
        if procedure:
            problem_lines.append(f"PROCEDURE: {procedure}")
        for key, value in problem_node.items():
            if key in {"procedure", "anatomy_guardrails", "severity_modifiers", "mechanism_modifiers"}:
                continue
            if isinstance(value, str) and value.strip():
                label = key.replace("_", " ").upper()
                problem_lines.append(f"{label}: {value.strip()}")
        if problem_lines:
            sections.append(f"PROBLEM [{problem_key}]:\n" + "\n".join(problem_lines))

        anatomy_key, anatomy_text = _lookup_tree_node(problem_node.get("anatomy_guardrails") or {}, selected.get("anatomy"))
        if anatomy_key and isinstance(anatomy_text, str) and anatomy_text.strip():
            sections.append(f"ANATOMY [{anatomy_key}]:\n{anatomy_text.strip()}")

        severity_key, severity_text = _lookup_tree_node(problem_node.get("severity_modifiers") or {}, selected.get("severity"))
        if severity_key and isinstance(severity_text, str) and severity_text.strip():
            sections.append(f"SEVERITY [{severity_key}]:\n{severity_text.strip()}")

        mechanism_key, mechanism_text = _lookup_tree_node(problem_node.get("mechanism_modifiers") or {}, selected.get("mechanism"))
        if mechanism_key and isinstance(mechanism_text, str) and mechanism_text.strip():
            sections.append(f"MECHANISM [{mechanism_key}]:\n{mechanism_text.strip()}")

    if not sections:
        return ""

    metadata = (user_metadata_block or "").strip()
    if metadata:
        sections.append(metadata)
    return "\n\n".join(section for section in sections if section.strip()).strip()


def _is_resource_excluded(item):
    """
     Is Resource Excluded helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    val = item.get("excludeFromResources")
    if isinstance(val, str):
        return val.strip().lower() in {"true", "1", "yes"}
    return bool(val)


def _categorize_supply_name(name: str) -> str:
    """
     Categorize Supply Name helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not name:
        return "Other"
    n = name.strip().lower()
    if any(k in n for k in ["burn", "water-jel", "water jel", "sunburn", "aloe"]):
        return "Burn care"
    if any(k in n for k in ["bandage", "gauze", "pad", "dressing", "tegaderm", "steri", "strip", "sponge", "wound"]):
        return "Wound care & dressings"
    if any(k in n for k in ["splint", "elastic bandage", "moleskin", "padding", "support"]):
        return "Splints & supports"
    if any(k in n for k in ["betadine", "antiseptic", "alcohol", "sanitizer", "wipe", "brush"]):
        return "Antiseptics & hygiene"
    if any(k in n for k in ["cpr", "respir", "airway", "nasopharyngeal", "rescue mask"]):
        return "Airway & breathing"
    if any(k in n for k in ["stethoscope", "thermometer", "blood pressure", "bp"]):
        return "Diagnostics & monitoring"
    if any(k in n for k in ["forceps", "hemostat", "scissors", "tweezers", "needle holder", "scalpel", "spatula", "snips", "pliers"]):
        return "Instruments & tools"
    if any(k in n for k in ["eye", "eyewash", "eye wash"]):
        return "Eye care"
    if any(k in n for k in ["dent", "dental"]):
        return "Dental"
    if any(k in n for k in ["glove", "ppe"]):
        return "PPE"
    if any(k in n for k in ["lubricat", "surgilube", "jelly", "gel"]):
        return "Lubricants & gels"
    if any(k in n for k in ["blanket", "bivvy", "matches", "duct tape", "safety pin", "toe protector"]):
        return "Survival & utility"
    if "enema" in n or "syringe" in n:
        return "Irrigation & syringes"
    return "Other"


def _normalize_category_label(label: str) -> str:
    """
     Normalize Category Label helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    return (label or "").strip().lower()


def _summarize_supply_categories(items: list[dict], allowed_categories: list[str] | None) -> tuple[str, dict]:
    """
     Summarize Supply Categories helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    allowed_categories = allowed_categories or []
    allowed_map = {_normalize_category_label(c): c for c in allowed_categories if c}
    counts = {c: 0 for c in allowed_categories if c}
    fallback_label = None
    for c in allowed_categories:
        if _normalize_category_label(c) in {"other", "misc", "uncategorized"}:
            fallback_label = c
            break
    if not fallback_label:
        fallback_label = "Other"

    for item in items or []:
        if _is_resource_excluded(item):
            continue
        name = item.get("name") or item.get("genericName") or item.get("brandName") or ""
        raw_cat = item.get("category") or ""
        cat = raw_cat if raw_cat.strip() else _categorize_supply_name(name)
        key = _normalize_category_label(cat)
        if key in allowed_map:
            counts[allowed_map[key]] = counts.get(allowed_map[key], 0) + 1
        else:
            counts[fallback_label] = counts.get(fallback_label, 0) + 1

    if not counts:
        return "", {}
    ordered = [(k, v) for k, v in counts.items() if v]
    if not ordered:
        return "", {}
    ordered.sort(key=lambda kv: (-kv[1], kv[0].lower()))
    summary = ", ".join(f"{cat} ({cnt})" for cat, cnt in ordered)
    return summary, counts


def _patient_display_name(record, fallback):
    """
     Patient Display Name helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
    Lookup Patient Display Name helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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


def build_prompt(settings, mode, msg, p_name, store, triage_selections=None, triage_conditions=None):
    """
    Build Prompt helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    rep_penalty = safe_float(settings.get("rep_penalty", 1.1) or 1.1, 1.1)
    mission_context = settings.get("mission_context", "")

    prompt_meta = {
        "triage_pathway_supplemented": False,
        "triage_pathway_status": "n/a",
        "triage_pathway_reason": "",
    }

    def _section_block(title, content):
        """
         Section Block helper.
        Detailed inline notes are included to support safe maintenance and future edits.
        """
        body = (content or "").strip()
        if not body:
            return ""
        return f"{title}:\n{body}"

    if mode == "inquiry":
        instruction = settings.get("inquiry_instruction") or ""
        prompt_sections = [
            _section_block("MISSION CONTEXT", mission_context),
            _section_block("INQUIRY MODE", instruction),
            _section_block("QUERY", msg),
        ]
        _dbg(
            "prompt_breakdown[inquiry]: "
            + f"mission_chars={len(mission_context or '')} "
            + f"instruction_chars={len(instruction or '')} "
            + f"query_chars={len(msg or '')}"
        )
        prompt = "\n\n".join(section for section in prompt_sections if section.strip())
        cfg = {
            "t": safe_float(settings.get("in_temp", 0.6), 0.6),
            "tk": safe_int(settings.get("in_tok", 2048), 2048),
            "p": safe_float(settings.get("in_p", 0.95), 0.95),
            "k": safe_int(settings.get("in_k", 50), 50),
            "rep_penalty": rep_penalty,
        }
    else:
        pharma_items = {}
        equip_items = {}
        consumable_items = {}
        for m in db_op("inventory", store=store):
            # Prefer generic names in prompts to keep medication references concise.
            item_name = m.get("genericName") or m.get("name") or m.get("brandName")
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

        tool_items = list(db_op("tools", store=store))
        equipment_items = []
        consumable_tools = []
        for t in tool_items:
            t_type = (t.get("type") or "").strip().lower()
            if t_type == "consumable":
                consumable_tools.append(t)
            else:
                equipment_items.append(t)
        equipment_items.sort(key=lambda t: (t.get("name") or "").lower())
        consumable_tools.sort(key=lambda t: (t.get("name") or "").lower())

        equipment_total = len(equipment_items)
        consumable_total = len(consumable_tools)
        tier_entries = []

        def _tier_entry(name, item_type, tier, cat):
            """
             Tier Entry helper.
            Detailed inline notes are included to support safe maintenance and future edits.
            """
            if not name:
                return ""
            tier_val = (tier or "").strip()
            cat_val = (cat or "").strip()
            if not tier_val and not cat_val:
                return ""
            label = "MED" if item_type == "pharma" else "ITEM"
            parts = [f"[{label}: {name}]"]
            if item_type != "pharma":
                parts.append(f"[TYPE: {item_type}]")
            if tier_val:
                parts.append(f"[TIER: {tier_val}]")
            if cat_val:
                parts.append(f"[CAT: {cat_val}]")
            return " ".join(parts)

        for med in db_op("inventory", store=store):
            if _is_resource_excluded(med):
                continue
            med_name = med.get("genericName") or med.get("name") or med.get("brandName")
            entry = _tier_entry(med_name, "pharma", med.get("priorityTier"), med.get("tierCategory"))
            if entry:
                tier_entries.append(entry)
        for tool in tool_items:
            if _is_resource_excluded(tool):
                continue
            tool_name = tool.get("name")
            tool_type = (tool.get("type") or "").strip().lower()
            item_type = "consumable" if tool_type == "consumable" else "equipment"
            entry = _tier_entry(tool_name, item_type, tool.get("priorityTier"), tool.get("tierCategory"))
            if entry:
                tier_entries.append(entry)
        tier_payload = " ".join(tier_entries)

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
            """
             Format Vaccines helper.
            Detailed inline notes are included to support safe maintenance and future edits.
            """
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

        equipment_names = [t.get("name") for t in equipment_items if t.get("name")]
        consumable_names = [t.get("name") for t in consumable_tools if t.get("name")]

        def _compact_inventory(values, limit):
            """
             Compact Inventory helper.
            Detailed inline notes are included to support safe maintenance and future edits.
            """
            clean = [v for v in (values or []) if v]
            if not clean:
                return "None listed"
            return ", ".join(clean)

        full_onboard_inventory = (
            "PHARMACEUTICALS:\n"
            f"- INVENTORY: {pharma_str or 'None listed'}\n"
            f"- TIERED TAGS: {tier_payload or 'No tier assignments recorded'}\n\n"
            "MEDICAL EQUIPMENT:\n"
            f"- INVENTORY: {', '.join(equipment_names) or 'None listed'}\n\n"
            "CONSUMABLES:\n"
            f"- INVENTORY: {', '.join(consumable_names) or 'None listed'}"
        )
        compact_onboard_inventory = (
            "PHARMACEUTICALS:\n"
            f"- INVENTORY: {_compact_inventory(pharma_list, 20)}\n"
            f"- TIERED TAGS: {tier_payload or 'No tier assignments recorded'}\n\n"
            "MEDICAL EQUIPMENT:\n"
            f"- INVENTORY: {_compact_inventory(equipment_names, 12)}\n\n"
            "CONSUMABLES:\n"
            f"- INVENTORY: {_compact_inventory(consumable_names, 16)}"
        )
        patient_metadata = (
            f"- Name: {display_name}\n"
            f"- Sex: {p_sex}\n"
            f"- Date of Birth: {p_birth}\n"
            f"- Medical History (profile): {p_hist or 'No records.'}\n"
            f"- Vaccines: {_format_vaccines(vaccines)}"
        )
        modular_metadata = "\n\n".join(
            section for section in [
                _section_block("ONBOARD MEDICAL INVENTORY", compact_onboard_inventory),
                _section_block("PATIENT HISTORY", patient_metadata),
            ] if section
        )
        condition_meta = triage_condition_meta(triage_conditions or {})
        condition_lines = [f"- {k}: {v}" for k, v in condition_meta.items() if (v or "").strip()]
        condition_section = _section_block("PATIENT CONDITION", "\n".join(condition_lines))
        mission_section = _section_block("MISSION CONTEXT", mission_context)
        general_section = _section_block("TRIAGE MODE GENERAL", settings.get("triage_instruction") or "")
        inventory_section = _section_block("ONBOARD MEDICAL INVENTORY", full_onboard_inventory)
        patient_history_section = _section_block("PATIENT HISTORY", patient_metadata)
        pathway_eval = evaluate_triage_pathway_definition(triage_selections or {})
        modular_system_prompt = assemble_system_prompt(triage_selections or {}, user_metadata_block=modular_metadata)
        using_modular_prompt = bool(modular_system_prompt.strip())
        supplement_with_general = bool(pathway_eval.get("supplement_with_general"))
        pathway_section = _section_block("TRIAGE MODE CLINICAL TRIAGE PATHWAY", modular_system_prompt)
        situation_section = _section_block("SITUATION", msg)
        general_triage_instruction = (settings.get("triage_instruction") or "").strip()

        if supplement_with_general:
            prompt_meta["triage_pathway_supplemented"] = True
            prompt_meta["triage_pathway_status"] = "supplemented"
            prompt_meta["triage_pathway_reason"] = pathway_eval.get("reason") or ""
            if using_modular_prompt:
                triage_instruction = "\n\n".join(
                    section for section in [
                        general_section,
                        pathway_section,
                    ] if section and section.strip()
                ).strip()
                prompt_sections = [
                    mission_section,
                    general_section,
                    pathway_section,
                    condition_section,
                    situation_section,
                ]
            else:
                triage_instruction = general_triage_instruction
                prompt_sections = [
                    mission_section,
                    general_section,
                    inventory_section,
                    patient_history_section,
                    condition_section,
                    situation_section,
                ]
        elif using_modular_prompt:
            prompt_meta["triage_pathway_status"] = "modular"
            triage_instruction = modular_system_prompt
            prompt_sections = [
                mission_section,
                pathway_section,
                condition_section,
                situation_section,
            ]
        else:
            prompt_meta["triage_pathway_status"] = "general"
            triage_instruction = general_triage_instruction
            prompt_sections = [
                mission_section,
                general_section,
                inventory_section,
                patient_history_section,
                condition_section,
                situation_section,
            ]
        _dbg(
            "prompt_breakdown[triage]: "
            + f"mission_chars={len(mission_context or '')} "
            + f"instruction_chars={len(triage_instruction or '')} "
            + f"pharma_count={len(pharma_list)} pharma_chars={len(pharma_str)} "
            + f"equip_count={len(equip_list)} equip_chars={len(equip_str)} "
            + f"consumable_count={len(consumable_list)} consumable_chars={len(consumable_str)} "
            + f"equipment_total={equipment_total} "
            + f"consumable_total={consumable_total} "
            + f"tier_entries={len(tier_entries)} tier_chars={len(tier_payload)} "
            + f"patient_hist_chars={len(p_hist or '')} "
            + f"vaccines_count={len(vaccines) if isinstance(vaccines, list) else 0} "
            + f"modular={using_modular_prompt} "
            + f"supplemented={supplement_with_general} "
            + f"pathway_reason={prompt_meta.get('triage_pathway_reason') or ''} "
            + f"triage_selections={json.dumps(triage_selections or {})} "
            + f"triage_conditions={json.dumps(triage_conditions or {})} "
            + f"situation_chars={len(msg or '')}"
        )
        prompt = "\n\n".join(section for section in prompt_sections if section.strip())
        cfg = {
            "t": safe_float(settings.get("tr_temp", 0.1), 0.1),
            "tk": safe_int(settings.get("tr_tok", 1024), 1024),
            "p": safe_float(settings.get("tr_p", 0.9), 0.9),
            "k": safe_int(settings.get("tr_k", 50), 50),
            "rep_penalty": rep_penalty,
        }

    return prompt, cfg, prompt_meta


def _safe_json_load(value):
    """
     Safe Json Load helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return None
    return None


def _normalize_transcript_payload(raw_payload):
    """
     Normalize Transcript Payload helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    payload = _safe_json_load(raw_payload)
    if isinstance(payload, dict):
        messages = payload.get("messages") or []
        meta = payload.get("meta") or {}
    elif isinstance(payload, list):
        messages = payload
        meta = {}
    else:
        messages = []
        meta = {}
    if not isinstance(messages, list):
        messages = []
    if not isinstance(meta, dict):
        meta = {}
    return messages, meta


def _format_transcript_for_prompt(messages, next_user_message):
    """
     Format Transcript For Prompt helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    lines = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = (msg.get("role") or msg.get("type") or "").strip().lower()
        content = msg.get("message") or msg.get("content") or ""
        if not content:
            continue
        label = "USER" if role == "user" else "ASSISTANT"
        if role == "user":
            triage_meta = msg.get("triage_meta") or {}
            if isinstance(triage_meta, dict) and triage_meta:
                meta_lines = [f"- {k}: {v}" for k, v in triage_meta.items() if v]
                if meta_lines:
                    lines.append("TRIAGE INTAKE:\n" + "\n".join(meta_lines))
        lines.append(f"{label}: {content}")
    if next_user_message:
        lines.append(f"USER: {next_user_message}")
    return "\n".join(lines).strip()


def get_credentials(store):
    """Return list of crew entries that have username/password set."""
    return get_credentials_rows()


def load_context(store):
    """Return static/inline sidebar context; external context.json no longer used."""
    return {}


def _has_creds(store):
    """
     Has Creds helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
    Export Default Dataset helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        store = request.state.store
        if not store:
            return JSONResponse({"error": "store not set"}, status_code=status.HTTP_400_BAD_REQUEST)
        default_root = DATA_ROOT / "default"
        default_root.mkdir(parents=True, exist_ok=True)
        default_uploads = default_root / "uploads" / "medicines"
        default_uploads.mkdir(parents=True, exist_ok=True)
        categories = ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "context"]
        written = []
        for cat in categories:
            data = db_op(cat, store=store)
            dest = default_root / f"{cat}.json"
            dest.write_text(json.dumps(data, indent=4))
            written.append(dest.name)
        triage_tree_dest = default_root / "triage_prompt_tree.json"
        triage_tree_dest.write_text(json.dumps(get_triage_prompt_tree(), indent=2, ensure_ascii=False), encoding="utf-8")
        written.append(triage_tree_dest.name)
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
    """
    Login Page helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    store = DEFAULT_store
    request.state.store = store
    return templates.TemplateResponse("login.html", {"request": request, "store": store})


@app.post("/login")
async def login(request: Request):
    # Auth model: if no crew credentials configured, auto-admit; otherwise require username/password
    """
    Login helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
    Logout helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    request.session.clear()
    fresh = (request.query_params.get("fresh") or "").strip()
    target = "/login"
    if fresh:
        target = f"/login?fresh={quote(fresh)}"
    return RedirectResponse(url=target, status_code=status.HTTP_302_FOUND)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """
    Index helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
        {
            "request": request,
            "store": store,
            "vessel_prefill": vessel_prefill,
            "use_splash_purple_tabbar": USE_SPLASH_PURPLE_TABBAR,
        },
    )


@app.get("/api/auth/meta")
async def auth_meta(request: Request):
    """
    Auth Meta helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    store = DEFAULT_store
    creds = get_credentials(store)
    return {"has_credentials": bool(creds), "count": len(creds), "store": store["label"]}


@app.get("/api/chat/metrics")
async def chat_metrics(request: Request, _=Depends(require_auth)):
    """Quick peek at per-model latency/count stats collected during chats."""
    try:
        store = DEFAULT_store
        metrics = get_history_latency_metrics()
        return {"metrics": metrics if isinstance(metrics, dict) else {}}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _local_model_availability_payload() -> dict:
    """
    Report local cache availability for required MedGemma models.
    """
    models = []
    available_models = []
    missing_models = []
    for model_name in REQUIRED_MODELS:
        cached, err = model_cache_status(model_name)
        row = {
            "model": model_name,
            "installed": bool(cached),
            "error": "" if cached else (err or "model cache missing"),
        }
        models.append(row)
        if row["installed"]:
            available_models.append(model_name)
        else:
            missing_models.append(model_name)
    has_any = bool(available_models)
    message = (
        "No local MedGemma models are installed. Open Settings -> Offline Readiness Check to download at least one model."
        if not has_any
        else ""
    )
    return {
        "models": models,
        "required_models": list(REQUIRED_MODELS),
        "available_models": available_models,
        "missing_models": missing_models,
        "has_any_local_model": has_any,
        "disable_submit": not has_any,
        "message": message,
    }


@app.get("/api/models/availability")
async def models_availability(_=Depends(require_auth)):
    """Expose local model availability so UI can disable submit when no models are installed."""
    try:
        return _local_model_availability_payload()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/chat/queue")
async def chat_queue_status(request: Request, _=Depends(require_auth)):
    """Return the current in-memory inference queue state."""
    try:
        return {"queue": _chat_queue_snapshot()}
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
    """
    Triage Options Save helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Payload must be an object"}, status_code=status.HTTP_400_BAD_REQUEST)
        set_triage_options(payload)
        return {"status": "ok", "fields": list(payload.keys())}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/triage/tree")
async def triage_tree(_=Depends(require_auth)):
    """Expose hierarchical triage decision tree for gated dropdowns."""
    try:
        return get_triage_prompt_tree()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/patients/options")
async def patient_options(_=Depends(require_auth)):
    """Return a lightweight patient list for fast triage dropdown hydration."""
    try:
        return get_patient_options()
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


@app.delete("/api/data/inventory/{item_id}")
async def delete_inventory_record(item_id: str, _=Depends(require_auth)):
    """Delete a single pharmaceutical without revalidating the entire inventory payload."""
    try:
        removed = delete_inventory_item(item_id)
        if not removed:
            return JSONResponse({"error": "Item not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return {"status": "deleted", "id": item_id}
    except Exception:
        logger.exception("inventory delete failed", extra={"item_id": item_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/data/inventory/{item_id}/verify")
async def verify_inventory_record(item_id: str, request: Request, _=Depends(require_auth)):
    """Toggle a single pharma item's verified flag without touching other records."""
    try:
        payload = await request.json()
        flag = bool(payload.get("verified"))
        ok = update_item_verified(item_id, flag)
        if not ok:
            return JSONResponse({"error": "Item not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return {"id": item_id, "verified": flag}
    except Exception:
        logger.exception("inventory verify toggle failed", extra={"item_id": item_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.put("/api/data/inventory/{item_id}")
async def upsert_single_inventory(item_id: str, request: Request, _=Depends(require_auth)):
    """Upsert a single pharma item and its expiries; avoids wiping the whole inventory."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Payload must be an object"}, status_code=status.HTTP_400_BAD_REQUEST)
        payload["id"] = item_id  # ensure path id wins
        normalized = upsert_inventory_item(payload)
        return normalized
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("inventory upsert failed", extra={"item_id": item_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/history/{entry_id}")
async def get_history_entry(entry_id: str, _=Depends(require_auth)):
    """Fetch one consultation log entry by ID."""
    try:
        entry = get_history_entry_by_id(entry_id)
        if not entry:
            return JSONResponse({"error": "History entry not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return JSONResponse(entry)
    except Exception:
        logger.exception("history get failed", extra={"entry_id": entry_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.put("/api/history/{entry_id}")
async def upsert_history_entry_api(entry_id: str, request: Request, _=Depends(require_auth)):
    """Update one consultation log entry without rewriting the full history list."""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Payload must be a JSON object."}, status_code=status.HTTP_400_BAD_REQUEST)

        existing = get_history_entry_by_id(entry_id)
        if not existing:
            return JSONResponse({"error": "History entry not found"}, status_code=status.HTTP_404_NOT_FOUND)

        merged = {**existing, **payload}
        merged["id"] = entry_id
        if payload.get("query") and not payload.get("user_query"):
            merged["user_query"] = payload.get("query")
        merged["updated_at"] = datetime.utcnow().isoformat()

        upsert_history_entry(merged)
        saved = get_history_entry_by_id(entry_id) or merged
        return JSONResponse(saved)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("history upsert failed", extra={"entry_id": entry_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.delete("/api/history/{entry_id}")
async def delete_history_entry_api(entry_id: str, _=Depends(require_auth)):
    """Delete one consultation log entry by ID."""
    try:
        removed = delete_history_entry_by_id(entry_id)
        if not removed:
            return JSONResponse({"error": "History entry not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return {"status": "deleted", "id": entry_id}
    except Exception:
        logger.exception("history delete failed", extra={"entry_id": entry_id, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


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
            return JSONResponse(db_op(cat, payload))
        result = db_op(cat)
        return JSONResponse(result)
    except ValueError as e:
        try:
            logger.warning("api/data validation error", extra={"cat": cat, "error": str(e), "db_path": str(DB_PATH)})
        except Exception:
            logger.warning(f"api/data validation error cat={cat}: {e}")
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("api/data failed", extra={"cat": cat, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/settings/prompt-library")
async def get_prompt_library(prompt_key: Optional[str] = None, _=Depends(require_auth)):
    """
    Get Prompt Library helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        return {"items": list_prompt_templates(prompt_key)}
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("prompt library list failed", extra={"prompt_key": prompt_key, "db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/settings/prompt-library")
async def save_prompt_library(request: Request, _=Depends(require_auth)):
    """
    Save Prompt Library helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return JSONResponse({"error": "Payload must be a JSON object."}, status_code=status.HTTP_400_BAD_REQUEST)
    try:
        saved = upsert_prompt_template(
            payload.get("prompt_key"),
            payload.get("name"),
            payload.get("prompt_text"),
        )
        return saved
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("prompt library save failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/settings/triage-modules")
async def get_triage_modules(_=Depends(require_auth)):
    """
    Get Triage Modules helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        return {"modules": get_triage_prompt_modules()}
    except Exception:
        logger.exception("triage modules list failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/settings/triage-tree")
async def get_triage_tree_settings(_=Depends(require_auth)):
    """
    Get Triage Tree Settings helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        return {"payload": get_triage_prompt_tree()}
    except Exception:
        logger.exception("triage tree load failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/settings/triage-tree")
async def save_triage_tree_settings(request: Request, _=Depends(require_auth)):
    """
    Save Triage Tree Settings helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return JSONResponse({"error": "Payload must be a JSON object."}, status_code=status.HTTP_400_BAD_REQUEST)
    tree_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    try:
        saved = set_triage_prompt_tree(tree_payload)
        return {"payload": saved}
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("triage tree save failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/settings/triage-tree/default")
async def get_triage_tree_default_settings(_=Depends(require_auth)):
    """
    Get Triage Tree Default Settings helper.
    Return canonical default triage tree loaded from the maintained JSON file.
    """
    try:
        return {"payload": get_triage_prompt_tree_default()}
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_404_NOT_FOUND)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("triage tree default load failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/settings/triage-tree/reset")
async def reset_triage_tree_settings(_=Depends(require_auth)):
    """
    Reset Triage Tree Settings helper.
    Reset triage decision tree in DB from canonical default JSON file.
    """
    try:
        saved = reset_triage_prompt_tree_to_default()
        return {"payload": saved}
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_404_NOT_FOUND)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("triage tree reset failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/settings/triage-modules")
async def save_triage_modules(request: Request, _=Depends(require_auth)):
    """
    Save Triage Modules helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return JSONResponse({"error": "Payload must be a JSON object."}, status_code=status.HTTP_400_BAD_REQUEST)
    try:
        if isinstance(payload.get("modules"), dict):
            set_triage_prompt_modules(
                payload.get("modules") or {},
                replace=bool(payload.get("replace")),
            )
            return {"modules": get_triage_prompt_modules()}
        saved = upsert_triage_prompt_module(
            payload.get("category"),
            payload.get("module_key"),
            payload.get("module_text"),
            payload.get("position"),
        )
        return {"module": saved}
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        logger.exception("triage modules save failed", extra={"db_path": str(DB_PATH)})
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/context")
async def get_context(request: Request, _=Depends(require_auth)):
    """Context endpoint retained for compatibility; now returns empty payload since sidebar content is static."""
    return {}


def _safe_filename_part(raw: str, fallback: str) -> str:
    """
     Safe Filename Part helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", (raw or "").strip())
    safe = safe.strip("._-")
    return safe or fallback


def _ext_for_mime(mime: str, default_ext: str = ".bin") -> str:
    """
     Ext For Mime helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    base = (mime or "").split(";")[0].strip().lower()
    ext = mimetypes.guess_extension(base) or default_ext
    if ext == ".jpe":
        ext = ".jpg"
    return ext


def _decode_data_url_bytes(value: str):
    """
     Decode Data Url Bytes helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(value, str):
        return None, None
    raw = value.strip()
    if not raw or not raw.startswith("data:"):
        return None, None
    try:
        header, payload = raw.split(",", 1)
    except ValueError:
        return None, None
    meta = header[5:]
    mime = "application/octet-stream"
    if ";" in meta:
        mime = (meta.split(";", 1)[0] or mime).strip()
    elif meta:
        mime = meta.strip()
    try:
        if ";base64" in header.lower():
            blob = base64.b64decode(payload)
        else:
            blob = unquote_to_bytes(payload)
    except Exception:
        return None, None
    return mime, blob


def _crew_display_name(member: dict, fallback: str = "Unnamed Crew") -> str:
    """
     Crew Display Name helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    first = str(member.get("firstName") or "").strip()
    last = str(member.get("lastName") or "").strip()
    if first and last:
        return f"{first} {last}"
    if first or last:
        return first or last
    name = str(member.get("name") or "").strip()
    return name or fallback


def _build_crew_list_csv_text(patients: list, vessel: dict, export_date: str) -> str:
    """
     Build Crew List Csv Text helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    vessel_name = vessel.get("vesselName") or "[Vessel Name]"
    captain = next((c for c in patients if str(c.get("position") or "").strip() == "Captain"), None)
    captain_name = _crew_display_name(captain, fallback="[Captain Name]") if captain else "[Captain Name]"
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["CREW LIST"])
    writer.writerow([f"Vessel: {vessel_name}"])
    writer.writerow([f"Date: {export_date}"])
    writer.writerow([])
    writer.writerow(["No.", "Name", "Birth Date", "Position", "Citizenship", "Birthplace", "Passport No.", "Issue Date", "Expiry Date"])
    for idx, crew in enumerate(patients, start=1):
        writer.writerow([
            idx,
            _crew_display_name(crew),
            crew.get("birthdate") or "",
            crew.get("position") or "",
            crew.get("citizenship") or "",
            crew.get("birthplace") or "",
            crew.get("passportNumber") or "",
            crew.get("passportIssue") or "",
            crew.get("passportExpiry") or "",
        ])
    writer.writerow([])
    writer.writerow([])
    writer.writerow([f"Captain: {captain_name}"])
    writer.writerow(["Signature: _________________________"])
    return out.getvalue()


def _build_vessel_info_text(vessel: dict) -> str:
    """
     Build Vessel Info Text helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    fields = [
        ("Vessel Name", "vesselName"),
        ("Registration Number", "registrationNumber"),
        ("Flag Country", "flagCountry"),
        ("Home Port", "homePort"),
        ("Call Sign", "callSign"),
        ("MMSI Number", "mmsi"),
        ("Gross Tonnage", "tonnage"),
        ("Net/Register Tonnage", "netTonnage"),
        ("Hull Number", "hullNumber"),
        ("Starboard Engine", "starboardEngine"),
        ("Starboard Engine S/N", "starboardEngineSn"),
        ("Port Engine", "portEngine"),
        ("Port Engine S/N", "portEngineSn"),
        ("RIB S/N", "ribSn"),
    ]
    lines = [
        "VESSEL INFORMATION",
        f"Exported (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]
    for label, key in fields:
        lines.append(f"{label}: {vessel.get(key) or ''}")
    lines.append("")
    return "\n".join(lines)


@app.post("/api/vessel/photo")
async def update_vessel_photo(request: Request, _=Depends(require_auth)):
    """
    Update Vessel Photo helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        payload = await request.json()
        field = payload.get("field")
        data = payload.get("data") or ""
        if field not in {"boatPhoto", "registrationFrontPhoto", "registrationBackPhoto"}:
            return JSONResponse({"error": "Invalid field"}, status_code=status.HTTP_400_BAD_REQUEST)
        if data and not isinstance(data, str):
            return JSONResponse({"error": "Invalid data payload"}, status_code=status.HTTP_400_BAD_REQUEST)
        saved = db_op("vessel", {field: data}, store=request.state.store)
        return {"status": "ok", "field": field, "hasData": bool(saved.get(field))}
    except Exception:
        logger.exception("vessel photo update failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/export/immigration-zip")
async def export_immigration_zip(request: Request, _=Depends(require_auth)):
    """
    Export Immigration Zip helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        patients = db_op("patients", store=request.state.store) or []
        vessel = db_op("vessel", store=request.state.store) or {}
        export_date = datetime.utcnow().strftime("%Y-%m-%d")
        vessel_slug = _safe_filename_part(str(vessel.get("vesselName") or ""), "vessel")
        zip_name = f"immigration_export_{vessel_slug}_{export_date}.zip"
        zip_buffer = io.BytesIO()
        passport_files = 0
        vessel_image_files = 0
        with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                f"crew_list_{export_date}.csv",
                _build_crew_list_csv_text(patients, vessel, export_date),
            )
            zf.writestr("vessel_info.txt", _build_vessel_info_text(vessel))

            vessel_images = {
                "boatPhoto": "boat_photo",
                "registrationFrontPhoto": "registration_front",
                "registrationBackPhoto": "registration_back",
            }
            for field, basename in vessel_images.items():
                mime, blob = _decode_data_url_bytes(vessel.get(field) or "")
                if not blob:
                    continue
                ext = _ext_for_mime(mime, ".bin")
                zf.writestr(f"vessel_images/{basename}{ext}", blob)
                vessel_image_files += 1

            for idx, crew in enumerate(patients, start=1):
                mime, blob = _decode_data_url_bytes(crew.get("passportPage") or "")
                if not blob:
                    continue
                name = _safe_filename_part(_crew_display_name(crew), f"crew_{idx:02d}")
                ext = _ext_for_mime(mime, ".bin")
                zf.writestr(f"passport_pages/{idx:02d}_{name}_passport_page{ext}", blob)
                passport_files += 1

            manifest_lines = [
                "IMMIGRATION EXPORT PACKAGE",
                f"Generated (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
                f"Crew records: {len(patients)}",
                f"Passport page files: {passport_files}",
                f"Vessel image files: {vessel_image_files}",
                "",
                "Included files:",
                f"- crew_list_{export_date}.csv",
                "- vessel_info.txt",
                "- passport_pages/*",
                "- vessel_images/*",
            ]
            zf.writestr("manifest.txt", "\n".join(manifest_lines) + "\n")

        zip_buffer.seek(0)
        headers = {
            "Content-Disposition": f"attachment; filename=\"{zip_name}\"; filename*=UTF-8''{quote(zip_name)}"
        }
        return Response(content=zip_buffer.getvalue(), media_type="application/zip", headers=headers)
    except Exception:
        logger.exception("immigration zip export failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/crew/photo")
async def update_crew_photo(request: Request, _=Depends(require_auth)):
    """
    Update Crew Photo helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
    Upsert Crew Vaccine helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
    Delete Crew Vaccine helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        ok = delete_vaccine(crew_id, vaccine_id)
        if not ok:
            return JSONResponse({"error": "Not found"}, status_code=status.HTTP_404_NOT_FOUND)
        return {"status": "ok"}
    except Exception:
        logger.exception("crew vaccine delete failed")
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _safe_pad_token_id(tok):
    """
     Safe Pad Token Id helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    pad = getattr(tok, "pad_token_id", None)
    if pad is not None:
        return pad
    eos = getattr(tok, "eos_token_id", None)
    if isinstance(eos, (list, tuple)):
        return eos[0] if eos else None
    return eos


def _resolve_model_max_length(model, tok=None):
    """
     Resolve Model Max Length helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    cfg = getattr(model, "config", None)
    candidates = []
    if cfg is not None:
        for attr in ("max_position_embeddings", "max_seq_len", "max_sequence_length", "n_positions"):
            val = getattr(cfg, attr, None)
            if isinstance(val, int) and val > 0:
                candidates.append(val)
        text_cfg = getattr(cfg, "text_config", None)
        if text_cfg is not None:
            for attr in ("max_position_embeddings", "max_seq_len", "max_sequence_length", "n_positions"):
                val = getattr(text_cfg, attr, None)
                if isinstance(val, int) and val > 0:
                    candidates.append(val)
    if tok is not None:
        tok_max = getattr(tok, "model_max_length", None)
        # Ignore sentinel "very large" values used by tokenizers
        if isinstance(tok_max, int) and 0 < tok_max < 1_000_000_000:
            candidates.append(tok_max)
    return min(candidates) if candidates else None


def _cap_new_tokens(max_new_tokens, input_len, model_max_len):
    """
     Cap New Tokens helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if not isinstance(max_new_tokens, int):
        return max_new_tokens
    if model_max_len is None:
        return max_new_tokens
    if input_len >= model_max_len:
        _dbg(f"generate_response: input_len {input_len} >= model_max_len {model_max_len}; forcing 1 new token")
        return 1
    max_allowed = max(model_max_len - input_len - 1, 1)
    if max_new_tokens > max_allowed:
        _dbg(
            f"generate_response: clamping max_new_tokens {max_new_tokens} -> {max_allowed} "
            f"(input_len={input_len}, model_max_len={model_max_len})"
        )
        return max_allowed
    return max_new_tokens


def _generate_response_local(model_choice: str, force_cpu_slow: bool, prompt: str, cfg: dict):
    """
     Generate Response Local helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    _dbg("generate_response: local inference path")
    model_name = (model_choice or "google/medgemma-1.5-4b-it").strip()
    model_name_l = model_name.lower()
    is_large_model = "27b" in model_name_l or "28b" in model_name_l
    force_cuda = os.environ.get("FORCE_CUDA", "").strip() == "1"
    allow_cpu_fallback_on_cuda_error = os.environ.get("ALLOW_CPU_FALLBACK_ON_CUDA_ERROR", "").strip() == "1"
    runtime_device = "cuda" if torch.cuda.is_available() else "cpu"
    if force_cuda and runtime_device != "cuda":
        cuda_err = ""
        try:
            torch.cuda.current_device()
        except Exception as exc:
            cuda_err = str(exc)
        detail = f": {cuda_err}" if cuda_err else ""
        raise RuntimeError(f"CUDA_NOT_AVAILABLE{detail}")
    if is_large_model and runtime_device != "cuda" and not force_cpu_slow:
        raise RuntimeError("SLOW_28B_CPU")
    try:
        if is_large_model:
            # Ensure only one model family occupies VRAM at a time.
            try:
                medgemma4.unload_model()
            except Exception:
                pass
            max_mem_gpu = os.environ.get("MODEL_MAX_GPU_MEM_27B") or os.environ.get("MODEL_MAX_GPU_MEM") or "8GiB"
            max_mem_cpu = os.environ.get("MODEL_MAX_CPU_MEM", "64GiB")
            max_memory = {0: max_mem_gpu, "cpu": max_mem_cpu} if runtime_device == "cuda" else None
            device_map_27b = os.environ.get("MODEL_DEVICE_MAP_27B", "manual").strip() or "manual"
            res = medgemma27b.generate(
                prompt,
                cfg,
                device_map=device_map_27b if runtime_device == "cuda" else "cpu",
                max_memory=max_memory,
            )
        else:
            try:
                medgemma27b.unload_model()
            except Exception:
                pass
            res = medgemma4.generate(
                prompt,
                cfg,
                device_map="cuda:0" if runtime_device == "cuda" else "cpu",
            )
    except Exception as exc:
        err_txt = str(exc)
        err_l = err_txt.lower()
        cuda_runtime_failure = (
            runtime_device == "cuda"
            and (
                "cuda driver error" in err_l
                or "cuda error" in err_l
                or "cublas" in err_l
                or "cudnn" in err_l
                or "device-side assert" in err_l
                or "no cuda gpus are available" in err_l
            )
        )
        if not cuda_runtime_failure:
            raise

        _dbg(f"generate_response: cuda runtime failure detected: {err_txt}")
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass

        if force_cuda:
            raise RuntimeError(f"CUDA_NOT_AVAILABLE: {err_txt}")
        if not allow_cpu_fallback_on_cuda_error:
            raise RuntimeError(f"CUDA_NOT_AVAILABLE: {err_txt}")

        if is_large_model:
            if not force_cpu_slow:
                # Preserve existing UX: ask user to confirm slow CPU run for 27B.
                raise RuntimeError("SLOW_28B_CPU")
            _dbg("generate_response: retrying 27B on CPU after CUDA failure")
            try:
                medgemma27b.unload_model()
            except Exception:
                pass
            res = medgemma27b.generate(
                prompt,
                cfg,
                device_map="cpu",
                max_memory=None,
            )
        else:
            _dbg("generate_response: retrying 4B on CPU after CUDA failure")
            try:
                medgemma4.unload_model()
            except Exception:
                pass
            res = medgemma4.generate(
                prompt,
                cfg,
                device_map="cpu",
            )
    models["active_name"] = model_name
    models["is_text"] = True
    _dbg(f"generate_response: local response_len={len(res)}")
    return res


def _generate_response(model_choice: str, force_cpu_slow: bool, prompt: str, cfg: dict, prelocked: bool = False):
    """
     Generate Response helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    _dbg(
        "generate_response: "
        + f"model_choice={model_choice} force_cpu_slow={force_cpu_slow} "
        + f"prompt_len={len(prompt) if prompt else 0} "
        + f"cfg=tk:{cfg.get('tk')} t:{cfg.get('t')} p:{cfg.get('p')} k:{cfg.get('k')} rep:{cfg.get('rep_penalty')}"
    )
    # If local inference is disabled (HF Space), fall back to HF Inference API
    if DISABLE_LOCAL_INFERENCE:
        if not HF_REMOTE_TOKEN:
            _dbg("generate_response: remote path selected but HF_REMOTE_TOKEN missing")
            raise RuntimeError("REMOTE_TOKEN_MISSING")
        client = InferenceClient(token=HF_REMOTE_TOKEN)
        # Use requested model when provided (e.g., MedGemma) else default
        model_name = model_choice or REMOTE_MODEL
        _dbg(f"generate_response: remote inference model={model_name}")
        resp = client.text_generation(
            prompt,
            model=model_name,
            max_new_tokens=cfg["tk"],
            temperature=cfg["t"],
            top_p=cfg["p"],
            top_k=cfg.get("k"),
        )
        out = resp.strip()
        _dbg(f"generate_response: remote response_len={len(out)}")
        return out

    if prelocked:
        return _generate_response_local(model_choice, force_cpu_slow, prompt, cfg)
    with MODEL_MUTEX:
        return _generate_response_local(model_choice, force_cpu_slow, prompt, cfg)


@app.post("/api/chat")
async def chat(request: Request, _=Depends(require_auth)):
    """Session-based chat endpoint (triage + inquiry)."""
    try:
        store = request.state.store
        start_time = datetime.now()
        form = await request.form()
        msg = (form.get("message") or "").strip()
        if not msg:
            return JSONResponse({"error": "Message is required."}, status_code=status.HTTP_400_BAD_REQUEST)
        user_msg_raw = msg
        p_name = form.get("patient") or ""
        mode = (form.get("mode") or "triage").strip()
        is_priv = form.get("private") == "true"
        model_choice = form.get("model_choice")
        force_cpu_slow = form.get("force_28b") == "true"
        queue_wait_requested = form.get("queue_wait") == "true"
        override_prompt = form.get("override_prompt") or ""
        session_action = (form.get("session_action") or "").strip()
        session_id = (form.get("session_id") or "").strip()
        transcript_raw = form.get("transcript") or ""
        session_meta_raw = form.get("session_meta") or ""
        session_meta = _safe_json_load(session_meta_raw) or {}
        if not isinstance(session_meta, dict):
            session_meta = {}
        session_meta_payload = dict(session_meta)
        is_start = session_action == "start" or not session_id
        if not session_id:
            session_id = f"session-{uuid.uuid4().hex}"

        if not DISABLE_LOCAL_INFERENCE:
            model_availability = _local_model_availability_payload()
            if not model_availability.get("has_any_local_model"):
                return JSONResponse(
                    {
                        "error": (
                            model_availability.get("message")
                            or "No local MedGemma models are installed."
                        ),
                        "models_unavailable": True,
                        "model_availability": model_availability,
                    },
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            available_models = model_availability.get("available_models") or []
            if available_models:
                chosen_model = (model_choice or "").strip()
                if not chosen_model:
                    model_choice = available_models[0]
                elif chosen_model not in available_models:
                    return JSONResponse(
                        {
                            "error": (
                                f"Selected model is not installed locally: {chosen_model}. "
                                "Choose an installed model or download missing models in Settings."
                            ),
                            "models_unavailable": True,
                            "model_availability": model_availability,
                        },
                        status_code=status.HTTP_400_BAD_REQUEST,
                    )
        _dbg(
            "chat request: "
            + f"mode={mode} model_choice={model_choice} force_28b={force_cpu_slow} "
            + f"private={is_priv} msg_len={len(msg) if msg else 0} "
            + f"session_action={session_action} session_id={session_id}"
        )
        triage_selections = extract_triage_selections(form) if mode == "triage" else {}
        triage_conditions = extract_triage_conditions(form) if mode == "triage" else {}
        s = db_op("settings", store=store)
        triage_meta = {}
        if mode == "triage":
            triage_meta.update(triage_condition_meta(triage_conditions))
            triage_meta.update(triage_selection_meta(triage_selections))
        if mode == "triage" and is_start:
            triage_path = {k: v for k, v in (triage_selections or {}).items() if (v or "").strip()}
            if triage_path:
                session_meta_payload["triage_path"] = triage_path
            triage_condition_snapshot = {
                k: v for k, v in (triage_conditions or {}).items() if (v or "").strip()
            }
            if triage_condition_snapshot:
                session_meta_payload["triage_condition"] = triage_condition_snapshot

        transcript_messages, _ = _normalize_transcript_payload(transcript_raw)
        if not is_start:
            msg_for_prompt = _format_transcript_for_prompt(transcript_messages, user_msg_raw)
            if not msg_for_prompt:
                msg_for_prompt = msg
        else:
            msg_for_prompt = msg

        prompt, cfg, prompt_meta = build_prompt(
            s,
            mode,
            msg_for_prompt,
            p_name,
            store,
            triage_selections=triage_selections,
            triage_conditions=triage_conditions,
        )
        if override_prompt.strip():
            prompt = override_prompt.strip()

        # Persist the exact prompt submitted for debug visibility in Settings.
        try:
            set_settings_meta(last_prompt_verbatim=prompt)
        except Exception:
            logger.exception("Unable to persist last_prompt_verbatim")

        model_lock_acquired = False
        busy_meta_set = False
        queue_ticket = None
        queue_wait_seconds = 0
        queue_snapshot = {}
        queue_ticket, queue_snapshot = _chat_queue_enqueue(model_choice or "", mode, session_id, p_name)
        if queue_ticket is None:
            return JSONResponse(
                {
                    "error": (
                        "Inference queue is full. "
                        "Please wait for active consultations to finish and submit again."
                    ),
                    "queue_full": True,
                    "queue": queue_snapshot,
                },
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        queue_position = safe_int(queue_snapshot.get("position"), 1)
        if queue_position > 1 and not queue_wait_requested:
            _chat_queue_release(queue_ticket)
            active = queue_snapshot.get("active") or {}
            active_model = (active.get("model_choice") or "").strip() or "another consultation"
            return JSONResponse(
                {
                    "error": (
                        f"Another user is currently running {active_model}. "
                        f"Your request would be queued at position {queue_position}. "
                        "Choose Wait to join the queue, or Cancel to try later."
                    ),
                    "gpu_busy": True,
                    "queue_prompt": True,
                    "queue_position": queue_position,
                    "active_model": active_model,
                    "queue": queue_snapshot,
                },
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        queue_wait_seconds = await asyncio.to_thread(_chat_queue_wait_turn, queue_ticket)
        _set_model_busy_meta(model_choice or "", mode, session_id, p_name)
        busy_meta_set = True

        try:
            if not DISABLE_LOCAL_INFERENCE:
                MODEL_MUTEX.acquire()
                model_lock_acquired = True
                res = await asyncio.to_thread(
                    _generate_response,
                    model_choice,
                    force_cpu_slow,
                    prompt,
                    cfg,
                    True,
                )
            else:
                res = await asyncio.to_thread(_generate_response, model_choice, force_cpu_slow, prompt, cfg)
        except RuntimeError as e:
            _dbg(f"chat runtime error: {e}")
            if str(e) == "CHAT_QUEUE_TICKET_MISSING":
                return JSONResponse(
                    {"error": "Queue ticket was lost. Please submit again."},
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if str(e) == "SLOW_28B_CPU":
                return JSONResponse(
                    {
                        "error": "The 28B MedGemma model on CPU can take an hour or more. Continue?",
                        "confirm_28b": True,
                    },
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            if str(e).startswith("CUDA_NOT_AVAILABLE"):
                return JSONResponse(
                    {
                        "error": (
                            "CUDA is required but not currently available. "
                            "Check NVIDIA driver/kernel health (e.g., journalctl -k for NVRM/Xid) "
                            "and restart GPU services or reboot."
                        ),
                        "cuda_unavailable": True,
                        "details": str(e),
                    },
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            if "Missing model cache" in str(e) or str(e) in {"REMOTE_TOKEN_MISSING", "LOCAL_INFERENCE_DISABLED"}:
                return JSONResponse(
                    {"error": str(e), "offline_missing": True},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
        finally:
            if model_lock_acquired:
                try:
                    MODEL_MUTEX.release()
                except RuntimeError:
                    pass
            if busy_meta_set:
                _clear_model_busy_meta()
            if queue_ticket is not None:
                try:
                    _chat_queue_release(queue_ticket)
                except Exception:
                    pass
        elapsed_ms = max(int((datetime.now() - start_time).total_seconds() * 1000), 0)

        now_iso = datetime.now().isoformat()
        patient_display = (
            lookup_patient_display_name(p_name, store, default="Unnamed Crew")
            if mode == "triage"
            else "Inquiry"
        )
        session_date = session_meta.get("date") or session_meta.get("started_at")
        if not session_date:
            session_date = datetime.now().strftime("%Y-%m-%d %H:%M")
        if is_start:
            transcript_messages = []
        user_entry = {
            "role": "user",
            "message": user_msg_raw,
            "model": model_choice,
            "ts": now_iso,
        }
        if triage_meta and is_start:
            user_entry["triage_meta"] = triage_meta
        transcript_messages.append(user_entry)
        transcript_messages.append(
            {
                "role": "assistant",
                "message": res,
                "model": models["active_name"],
                "ts": now_iso,
                "duration_ms": elapsed_ms,
            }
        )

        if not is_priv:
            existing_entry = get_history_entry_by_id(session_id) if not is_start else None
            if not session_date:
                session_date = (existing_entry or {}).get("date") or datetime.now().strftime("%Y-%m-%d %H:%M")
            query_text = session_meta.get("initial_query") or (existing_entry or {}).get("query") or user_msg_raw
            patient_id = session_meta.get("patient_id") or p_name or (existing_entry or {}).get("patient_id") or ""
            meta_payload = dict(session_meta_payload)
            meta_payload.update(
                {
                    "session_id": session_id,
                    "mode": mode,
                    "patient_id": patient_id,
                    "patient": patient_display,
                    "started_at": session_date,
                }
            )
            transcript_payload = {
                "messages": transcript_messages,
                "meta": meta_payload,
            }
            entry = {
                "id": session_id,
                "date": session_date,
                "patient": patient_display,
                "patient_id": patient_id,
                "mode": mode,
                "query": query_text,
                "user_query": query_text,
                "response": json.dumps(transcript_payload),
                "model": models["active_name"],
                "duration_ms": elapsed_ms,
                "prompt": prompt,
                "injected_prompt": override_prompt.strip() or prompt,
            }
            upsert_history_entry(entry)

        metrics = _update_chat_metrics(store, models["active_name"])

        return JSONResponse(
            {
                "response": res,
                "model": models["active_name"],
                "duration_ms": elapsed_ms,
                "queue_wait_seconds": queue_wait_seconds,
                "queue_ticket": queue_ticket,
                "queue_position_on_submit": queue_snapshot.get("position"),
                "model_metrics": metrics,
                "triage_pathway_supplemented": bool(prompt_meta.get("triage_pathway_supplemented")),
                "triage_pathway_status": prompt_meta.get("triage_pathway_status"),
                "triage_pathway_reason": prompt_meta.get("triage_pathway_reason"),
                "session_id": session_id,
                "transcript": transcript_messages,
                "session_meta": {
                    **session_meta_payload,
                    "session_id": session_id,
                    "mode": mode,
                    "patient_id": session_meta.get("patient_id") or p_name,
                    "patient": session_meta.get("patient") or patient_display,
                    "date": session_meta.get("date") or session_meta.get("started_at") or session_date,
                },
            }
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/chat/preview")
async def chat_preview(request: Request, _=Depends(require_auth)):
    """
    Chat Preview helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    form = await request.form()
    msg = form.get("message")
    p_name = form.get("patient")
    mode = form.get("mode")
    store = request.state.store
    triage_selections = extract_triage_selections(form) if mode == "triage" else {}
    triage_conditions = extract_triage_conditions(form) if mode == "triage" else {}
    s = db_op("settings", store=store)
    prompt, cfg, prompt_meta = build_prompt(
        s,
        mode,
        msg,
        p_name,
        store,
        triage_selections=triage_selections,
        triage_conditions=triage_conditions,
    )
    return {
        "prompt": prompt,
        "mode": mode,
        "patient": p_name,
        "cfg": cfg,
        "triage_pathway_supplemented": bool(prompt_meta.get("triage_pathway_supplemented")),
        "triage_pathway_status": prompt_meta.get("triage_pathway_status"),
        "triage_pathway_reason": prompt_meta.get("triage_pathway_reason"),
    }


def has_model_cache(model_name: str):
    """
    Has Model Cache helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    ok, _ = model_cache_status(model_name)
    return ok


def model_cache_status(model_name: str):
    """Lightweight check: is the huggingface snapshot for this model present locally?"""
    safe = model_name.replace("/", "--")
    base = CACHE_DIR / "hub" / f"models--{safe}"
    _dbg(f"cache_status: model={model_name} base={base}")
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
            _dbg(f"cache_status: valid snapshot {child}")
            return True, ""
        if not cfg.exists():
            last_err = "config.json missing"
        elif not weights_present:
            last_err = "weights missing"
    return False, last_err


def is_offline_mode() -> bool:
    """
    Is Offline Mode helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    resolved = str(candidates[0]) if candidates else None
    _dbg(f"resolve_local_model_dir: model={model_name} resolved={resolved}")
    return resolved


def verify_required_models(download_missing: bool = False, force_download: bool = False):
    """Check required model cache; optionally download missing models when online.

    Notes:
    - ``download_missing`` enables fetch attempts for missing models.
    - ``force_download`` lets an explicit UI action (Readiness -> Download missing)
      override AUTO_DOWNLOAD_MODELS so local deployments can fetch on demand.
    """
    results = []
    offline = is_offline_mode()
    download_allowed = (AUTO_DOWNLOAD_MODELS or force_download) and not offline
    for m in REQUIRED_MODELS:
        cached, cache_err = model_cache_status(m)
        downloaded = False
        error = ""
        # Allow download attempt unless offline flags are set
        if not cached and download_missing and download_allowed:
            downloaded, error = download_model_cache(m)
            cached, cache_err = model_cache_status(m)
        if not cached and not error:
            error = cache_err or "config/weights missing in cache"
        results.append({"model": m, "cached": cached, "downloaded": downloaded, "error": error})
    return results


def _offline_status_payload(model_status, *, download_requested: bool = False, force_download: bool = False):
    """Return a consistent payload for all Offline Readiness endpoints."""
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
    missing = [m for m in model_status if not m.get("cached")]
    cached_count = len([m for m in model_status if m.get("cached")])
    offline_mode = is_offline_mode()
    download_allowed = bool((AUTO_DOWNLOAD_MODELS or force_download) and not offline_mode)
    return {
        "models": model_status,
        "missing": missing,
        "cached_models": cached_count,
        "total_models": len(model_status),
        "env": env_flags,
        "cache_dir": str(CACHE_DIR.resolve()),
        "offline_mode": offline_mode,
        "disk": disk,
        "download_requested": bool(download_requested),
        "download_allowed": download_allowed,
        "auto_download": AUTO_DOWNLOAD_MODELS,
    }


@app.get("/api/offline/check")
async def offline_check(_=Depends(require_auth)):
    """Report cache status/disk usage without downloading models."""
    try:
        model_status = verify_required_models(download_missing=False)
        return _offline_status_payload(model_status, download_requested=False, force_download=False)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _parse_bool(val):
    """
     Parse Bool helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
        roots = [
            (store["data"], "data"),
            (store["uploads"], "uploads"),
            (CACHE_DIR, "models_cache"),
        ]
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for root, root_label in roots:
                for path in root.rglob("*"):
                    if path.is_file():
                        try:
                            arcname = path.resolve().relative_to(base)
                        except Exception:
                            # Preserve folder structure even when storage lives outside APP_HOME.
                            try:
                                rel = path.resolve().relative_to(root.resolve())
                                arcname = Path(root_label) / rel
                            except Exception:
                                arcname = Path(root_label) / path.name
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
        model_status = verify_required_models(download_missing=False)
        return _offline_status_payload(model_status, download_requested=False, force_download=False)
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
        # Safety: ensure extraction stays inside APP_HOME and never writes
        # outside the application directory tree.
        app_root = APP_HOME.resolve()
        with zipfile.ZipFile(target, "r") as zf:
            for member in zf.infolist():
                member_name = (member.filename or "").strip()
                if not member_name:
                    continue
                destination = (app_root / member_name).resolve()
                if not str(destination).startswith(str(app_root)):
                    return JSONResponse(
                        {"error": f"Unsafe path in backup archive: {member_name}"},
                        status_code=status.HTTP_400_BAD_REQUEST,
                    )
            zf.extractall(app_root)
        return {"restored": str(target.resolve())}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/offline/ensure")
async def offline_ensure(_=Depends(require_auth)):
    """Check cache and download missing models when explicitly requested by UI."""
    try:
        # force_download=True intentionally overrides AUTO_DOWNLOAD_MODELS for
        # explicit operator-initiated readiness actions in Settings.
        results = verify_required_models(download_missing=True, force_download=True)
        return _offline_status_payload(results, download_requested=True, force_download=True)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


hb_models = _heartbeat("Housekeeping", interval=2.0)
_startup_model_check()
_background_verify_models()
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
    # Clear uploads
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
    for name in ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "context"]:
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


#

# MAINTENANCE NOTE
# Historical auto-generated note blocks were removed because they were repetitive and
# obscured real logic changes during review. Keep focused comments close to behavior-
# critical code paths (auth/session flow, startup/bootstrap, prompt assembly, and
# persistence contracts) so maintenance remains actionable.
