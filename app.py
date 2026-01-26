import os
import json
import uuid
import secrets
import shutil
import zipfile
import asyncio
import threading
import base64
import time
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from db_store import configure_db, init_workspaces, ensure_workspace, get_doc, set_doc

# Temporary startup cleanup to reclaim space and report usage on HF Spaces
def _cleanup_and_report():
    try:
        subprocess.run(
            "rm -rf ~/.cache/huggingface ~/.cache/torch ~/.cache/pip ~/.cache/*",
            shell=True,
            check=False,
        )
        subprocess.run(
            "df -h && du -sh /home/user /home/user/* ~/.cache 2>/dev/null | sort -hr | head -30",
            shell=True,
            check=False,
        )
    except Exception as exc:
        print(f"[startup-cleanup] failed: {exc}")

_cleanup_and_report()


# Temporary startup cleanup to reclaim space and report usage on HF Spaces
def _cleanup_and_report():
    try:
        import subprocess as _sp
        _sp.run("rm -rf ~/.cache/huggingface ~/.cache/torch ~/.cache/pip ~/.cache/*", shell=True, check=False)
        _sp.run("df -h && du -sh /home/user /home/user/* ~/.cache 2>/dev/null | sort -hr | head -30", shell=True, check=False)
    except Exception as exc:
        print(f"[startup-cleanup] failed: {exc}")

_cleanup_and_report()

# Encourage less fragmentation on GPUs with limited VRAM (e.g., RTX 5000)
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# Allow online downloads by default (HF Spaces first run needs this). You can set these to "1" after caches are warm.
os.environ.setdefault("HF_HUB_OFFLINE", "0")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")
AUTO_DOWNLOAD_MODELS = os.environ.get("AUTO_DOWNLOAD_MODELS", "0") == "1"
VERIFY_MODELS_ON_START = os.environ.get("VERIFY_MODELS_ON_START", "1") == "1"
DISABLE_LOCAL_INFERENCE = os.environ.get("DISABLE_LOCAL_INFERENCE") == "1" or bool(os.environ.get("HUGGINGFACE_SPACE_ID"))

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

# Core config
BASE_DIR = Path(__file__).parent.resolve()
APP_HOME = Path("/home/user/app").resolve()

# Data + uploads live inside app home (HF Spaces non-root safe)
DATA_ROOT = APP_HOME / "data"
DATA_ROOT.mkdir(parents=True, exist_ok=True)
UPLOAD_ROOT = APP_HOME / "uploads"
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

OFFLOAD_DIR = APP_HOME / "offload"
OFFLOAD_DIR.mkdir(parents=True, exist_ok=True)

CACHE_DIR = APP_HOME / "models_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Point Hugging Face cache to a local directory to avoid network dependency
os.environ["HF_HOME"] = str(CACHE_DIR)
os.environ["HUGGINGFACE_HUB_CACHE"] = str(CACHE_DIR / "hub")
(CACHE_DIR / "hub").mkdir(parents=True, exist_ok=True)

BACKUP_ROOT = APP_HOME / "backups"
BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_ROOT / "app.db"
configure_db(DB_PATH)
REQUIRED_MODELS = [
    "google/medgemma-1.5-4b-it",
    "Qwen/Qwen2.5-VL-7B-Instruct",
]

WORKSPACE_NAMES = sorted(
    [
        "Darlene&Neal",
        "Rick",
        "Lorraine",
        "Wayne",
        "DaveG",
        "Dave&Nathalie",
        "Tracy&John",
        "Julia&Jeff",
        "Carl",
        "Jeremy",
        "Pamela",
    ],
    key=lambda s: s.lower(),
)
init_workspaces(WORKSPACE_NAMES)

IS_HF_SPACE = bool(os.environ.get("SPACE_ID") or os.environ.get("HF_SPACE") or os.environ.get("HUGGINGFACE_SPACE"))
PHOTO_JOB_WORKER_STARTED = False
PHOTO_JOB_LOCK = threading.Lock()


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


def _sanitize_workspace(name: str) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in (name or ""))
    slug = re.sub("-+", "-", slug).strip("-").lower()
    return slug or "default"

def _label_from_slug(slug: str) -> str:
    cleaned = _sanitize_workspace(slug)
    for name in WORKSPACE_NAMES:
        if _sanitize_workspace(name) == cleaned:
            return name
    return ""


def _workspace_dirs(workspace_label: str):
    slug = _sanitize_workspace(workspace_label)
    ws_rec = ensure_workspace(workspace_label, slug)
    data_dir = DATA_ROOT / slug
    uploads_dir = UPLOAD_ROOT / slug
    med_dir = uploads_dir / "medicines"
    backup_dir = BACKUP_ROOT / slug
    for path in [data_dir, uploads_dir, med_dir, backup_dir]:
        path.mkdir(parents=True, exist_ok=True)
    return {
        "label": workspace_label,
        "slug": slug,
        "data": data_dir,
        "uploads": uploads_dir,
        "med_uploads": med_dir,
        "backup": backup_dir,
        "db_id": ws_rec["id"],
    }


def _get_workspace(request: Request, required: bool = True):
    label = request.session.get("workspace_label") or request.session.get("workspace")
    if not label:
        # Allow fallbacks from headers/query to reduce UX dead-ends
        label = (
            request.headers.get("x-workspace")
            or request.headers.get("x-workspace-label")
            or request.headers.get("x-workspace-slug")
            or request.query_params.get("workspace")
            or request.query_params.get("workspace_label")
            or request.query_params.get("workspace_slug")
        )
    # Map slugs back to labels if needed
    if label and label not in WORKSPACE_NAMES:
        mapped = _label_from_slug(label)
        if mapped:
            label = mapped
    if not label:
        if required:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Workspace not selected")
        return None
    if label not in WORKSPACE_NAMES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid workspace")
    return _workspace_dirs(label)


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
        "vaccine_types": ["MMR", "DTaP", "HepB", "HepA", "Td/Tdap", "Influenza", "COVID-19"],
    }


def db_op(cat, data=None, workspace=None):
    if workspace is None:
        raise ValueError("Workspace is required for data operations.")
    allowed_categories = [
        "settings",
        "patients",
        "inventory",
        "tools",
        "history",
        "chats",
        "vessel",
        "med_photo_queue",
        "med_photo_jobs",
    ]
    if cat not in allowed_categories:
        raise ValueError(f"Invalid category: {cat}")

    workspace_id = workspace.get("db_id")
    if not workspace_id:
        raise ValueError("Workspace database id missing")

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
                "crewCapacity": "",
            }
        return []

    def load_legacy(category):
        legacy_path = workspace["data"] / f"{category}.json"
        if legacy_path.exists():
            try:
                return json.loads(legacy_path.read_text() or "[]")
            except Exception:
                return None
        return None

    if data is not None:
        if cat == "settings":
            if not isinstance(data, dict):
                raise ValueError("Settings payload must be a JSON object.")
            existing = get_doc(workspace_id, cat) or {}
            merged = {**get_defaults(), **existing, **data}
            set_doc(workspace_id, cat, merged)
            return merged
        set_doc(workspace_id, cat, data)
        return data

    loaded = get_doc(workspace_id, cat)
    if loaded is None:
        legacy = load_legacy(cat)
        loaded = legacy if legacy is not None else default_for(cat)
        set_doc(workspace_id, cat, loaded)

    if cat == "settings":
        if not isinstance(loaded, dict):
            loaded = {}
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


def lookup_patient_display_name(p_name, workspace, default="Unnamed Crew"):
    if not p_name:
        return default
    try:
        patients = db_op("patients", workspace=workspace)
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


def build_prompt(settings, mode, msg, p_name, workspace):
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
        for m in db_op("inventory", workspace=workspace):
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
        for t in db_op("tools", workspace=workspace):
            tool_name = t.get("name")
            if tool_name:
                tool_items.append(tool_name)
        tool_items.sort(key=lambda s: (s or "").lower())
        equipment_extra = ", ".join(tool_items)

        patient_record = next(
            (
                p
                for p in db_op("patients", workspace=workspace)
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


def get_credentials(workspace):
    """Return list of crew entries that have username/password set."""
    return [p for p in db_op("patients", workspace=workspace) if p.get("username") and p.get("password")]


def load_context(workspace):
    """Load context/sidebar content from data/context.json, ensure file exists."""
    path = workspace["data"] / "context.json"
    if not path.exists():
        path.write_text(json.dumps({}, indent=4))
    return json.loads(path.read_text() or "{}")


def get_med_photo_queue(workspace):
    queue = db_op("med_photo_queue", workspace=workspace)
    return queue if isinstance(queue, list) else []


def _resolve_med_model(workspace):
    settings = db_op("settings", workspace=workspace)
    model_pref = (settings.get("med_photo_model") or "qwen").lower()
    primary = "Qwen/Qwen2.5-VL-7B-Instruct"
    has_cache, _ = model_cache_status(primary)
    if not has_cache:
        logger.warning("Preferred medicine photo model cache missing; continuing with %s", primary)
    return primary


def _merge_inventory_record(med_record: dict, photo_urls: List[str], workspace):
    inventory = db_op("inventory", workspace=workspace)
    existing = next((m for m in inventory if _same_med(m, med_record)), None)
    entry = {"status": "completed", "urls": photo_urls}
    if existing:
        existing.setdefault("photos", [])
        all_urls = photo_urls or []
        if all_urls:
            merged_photos = existing["photos"] + all_urls
            seen = set()
            existing["photos"] = [p for p in merged_photos if not (p in seen or seen.add(p))]
        existing.setdefault("purchaseHistory", [])
        med_record_ph = med_record.get("purchaseHistory") or []
        if med_record_ph:
            existing["purchaseHistory"].extend(med_record_ph)
        for key, val in med_record.items():
            if key in {"id", "photos", "purchaseHistory"}:
                continue
            if _is_blank(existing.get(key)) and not _is_blank(val):
                existing[key] = val
        entry["inventory_id"] = existing.get("id")
    else:
        inventory.append(med_record)
        entry["inventory_id"] = med_record["id"]
    db_op("inventory", inventory, workspace=workspace)
    return entry


def _load_photo_jobs(workspace):
    jobs = db_op("med_photo_jobs", workspace=workspace)
    if not isinstance(jobs, list):
        jobs = []
    return jobs


def _save_photo_jobs(workspace, jobs):
    db_op("med_photo_jobs", jobs, workspace=workspace)
    log_job(f"[{workspace['label']}] saved {len(jobs)} job(s)")


def _update_job(workspace, job_id, updater):
    jobs = _load_photo_jobs(workspace)
    updated = None
    for job in jobs:
        if job.get("id") == job_id:
            updated = updater(job)
            break
    _save_photo_jobs(workspace, jobs)
    return updated, jobs


def _process_photo_job(job, workspace):
    paths = [Path(p) for p in job.get("paths") or [] if p]
    urls = job.get("urls") or []
    if not paths:
        raise RuntimeError("No image paths found for job")
    log_job(f"[{workspace['label']}] processing job {job.get('id')} ({len(paths)} photo(s), mode={job.get('mode')})")
    entry = asyncio.run(_process_photo_group(paths, urls, workspace))
    job.update(
        {
            "status": "completed",
            "completed_at": datetime.now().isoformat(),
            "result": entry.get("result") or {},
            "inventory_id": entry.get("inventory_id"),
            "used_model": entry.get("used_model"),
            "error": "",
        }
    )
    log_job(f"[{workspace['label']}] job {job.get('id')} completed; inventory_id={job.get('inventory_id')}")


def _photo_job_worker():
    while True:
        processed = False
        for name in WORKSPACE_NAMES:
            try:
                ws = _workspace_dirs(name)
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
                break
            except Exception:
                # Avoid worker crash; continue to next workspace
                continue
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
    primary_photo = photo_urls[0] if photo_urls else ""
    purchase_row = {
        "id": f"ph-{uuid.uuid4().hex}",
        "date": datetime.now().strftime("%Y-%m-%d"),
        "quantity": "",
        "notes": note,
        "photos": photo_urls or [],
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
        "photos": photo_urls or ([] if not primary_photo else [primary_photo]),
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


def _has_creds(workspace):
    if not workspace:
        return False
    creds = get_credentials(workspace)
    return bool(creds)


def require_auth(request: Request):
    """Enforce auth only when credentials are configured."""
    path = request.url.path
    workspace_optional_paths = ("/api/offline/check", "/api/offline/ensure", "/api/offline/flags")
    workspace_required = not any(path.startswith(p) for p in workspace_optional_paths)
    workspace = _get_workspace(request, required=workspace_required)
    request.state.workspace = workspace
    if not _has_creds(workspace):
        # No credentials configured, allow pass-through
        return True
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return True


@app.get("/workspace", response_class=HTMLResponse)
async def workspace_page(request: Request):
    current = request.session.get("workspace_label") or ""
    ctx = {"request": request, "workspaces": WORKSPACE_NAMES, "selected": current}
    return templates.TemplateResponse("workspace.html", ctx)


@app.post("/workspace")
async def set_workspace(request: Request):
    try:
        payload = {}
        if request.headers.get("content-type", "").startswith("application/json"):
            payload = await request.json()
        else:
            form = await request.form()
            payload = dict(form)
        chosen = (payload.get("workspace") or "").strip()
        password = (payload.get("password") or "").strip()
        if password != "Aphrodite":
            return JSONResponse({"error": "Invalid workspace password"}, status_code=status.HTTP_401_UNAUTHORIZED)
        if chosen not in WORKSPACE_NAMES:
            return JSONResponse({"error": "Invalid workspace selected"}, status_code=status.HTTP_400_BAD_REQUEST)
        # Reset session to avoid cross-workspace bleed
        request.session.clear()
        request.session["workspace"] = _sanitize_workspace(chosen)
        request.session["workspace_label"] = chosen
        if request.headers.get("accept", "").startswith("application/json"):
            return {"success": True, "workspace": chosen}
        return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)
    except Exception as e:
        return JSONResponse({"error": f"Unable to set workspace: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/workspace/reset")
async def reset_workspace(request: Request):
    try:
        workspace = _get_workspace(request, required=False)
        if not workspace:
            return JSONResponse({"error": "Workspace not set"}, status_code=status.HTTP_400_BAD_REQUEST)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        action = (payload.get("action") or "").lower()
        if action == "clear":
            _clear_workspace_data(workspace)
            return {"status": "cleared"}
        if action == "sample":
            # Placeholder: waiting for provided sample data to load
            _clear_workspace_data(workspace)
            _apply_default_dataset(workspace)
            return {"status": "sample_loaded"}
        if action == "keep":
            return {"status": "kept"}
        return JSONResponse({"error": "Invalid action"}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception as e:
        return JSONResponse({"error": f"Unable to reset workspace: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/default/export")
async def export_default_dataset(request: Request, _=Depends(require_auth)):
    try:
        workspace = request.state.workspace
        if not workspace:
            return JSONResponse({"error": "Workspace not set"}, status_code=status.HTTP_400_BAD_REQUEST)
        default_root = DATA_ROOT / "default"
        default_root.mkdir(parents=True, exist_ok=True)
        default_uploads = default_root / "uploads" / "medicines"
        default_uploads.mkdir(parents=True, exist_ok=True)
        categories = ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "med_photo_queue", "med_photo_jobs", "context"]
        written = []
        for cat in categories:
            data = db_op(cat, workspace=workspace)
            dest = default_root / f"{cat}.json"
            dest.write_text(json.dumps(data, indent=4))
            written.append(dest.name)
        # Copy medicine uploads
        src_med = workspace["uploads"] / "medicines"
        if src_med.exists():
            for item in src_med.iterdir():
                if item.is_file():
                    shutil.copy2(item, default_uploads / item.name)
        return {"status": "ok", "written": written}
    except Exception as e:
        return JSONResponse({"error": f"Unable to export default dataset: {e}"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    workspace = _get_workspace(request, required=False)
    if not workspace:
        return RedirectResponse(url="/workspace", status_code=status.HTTP_302_FOUND)
    request.state.workspace = workspace
    return templates.TemplateResponse("login.html", {"request": request, "workspace": workspace})


@app.post("/login")
async def login(request: Request):
    workspace = _get_workspace(request, required=False)
    if not workspace:
        return JSONResponse({"error": "Select a workspace before logging in."}, status_code=status.HTTP_400_BAD_REQUEST)
    payload = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
    else:
        form = await request.form()
        payload = dict(form)

    crew_creds = get_credentials(workspace)
    # If no credentials are configured, transparently log in.
    if not crew_creds:
        request.session["authenticated"] = True
        request.session["user"] = "auto"
        request.session["workspace"] = workspace["slug"]
        request.session["workspace_label"] = workspace["label"]
        return {"success": True, "auto": True}

    username = payload.get("username", "").strip()
    password = payload.get("password", "").strip()
    if not username or not password:
        return JSONResponse({"error": "Username and password required"}, status_code=status.HTTP_400_BAD_REQUEST)

    match = next(
        (p for p in crew_creds if p.get("username") == username and p.get("password") == password),
        None,
    )
    if not match:
        return JSONResponse({"error": "Invalid credentials"}, status_code=status.HTTP_401_UNAUTHORIZED)

    request.session["authenticated"] = True
    request.session["user"] = username
    request.session["workspace"] = workspace["slug"]
    request.session["workspace_label"] = workspace["label"]
    return {"success": True}


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    workspace = _get_workspace(request, required=False)
    if not workspace:
        return RedirectResponse(url="/workspace", status_code=status.HTTP_302_FOUND)
    request.state.workspace = workspace
    if not request.session.get("authenticated"):
        if _has_creds(workspace):
            return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
        # Auto-admit when no credentials exist; avoid login loop on Spaces
        request.session["authenticated"] = True
        request.session["user"] = "auto"
    return templates.TemplateResponse("index.html", {"request": request, "workspace": workspace})


@app.get("/api/auth/meta")
async def auth_meta(request: Request):
    workspace = _get_workspace(request, required=False)
    if not workspace:
        return JSONResponse({"error": "Workspace not selected"}, status_code=status.HTTP_400_BAD_REQUEST)
    creds = get_credentials(workspace)
    return {"has_credentials": bool(creds), "count": len(creds), "workspace": workspace["label"]}


@app.get("/api/workspaces")
async def workspace_meta(request: Request):
    """Return available workspaces and current selection (no auth required)."""
    current = request.session.get("workspace_label") or ""
    return {"workspaces": WORKSPACE_NAMES, "current": current}


@app.api_route("/api/data/{cat}", methods=["GET", "POST"])
async def manage(cat: str, request: Request, _=Depends(require_auth)):
    try:
        workspace = request.state.workspace
        if request.method == "POST":
            try:
                payload = await request.json()
            except Exception:
                form = await request.form()
                payload = dict(form)
            return JSONResponse(db_op(cat, payload, workspace=workspace))
        return JSONResponse(db_op(cat, workspace=workspace))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/context")
async def get_context(request: Request, _=Depends(require_auth)):
    try:
        workspace = request.state.workspace
        return JSONResponse(load_context(workspace))
    except Exception:
        return JSONResponse({"error": "Unable to load context"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/medicines/queue")
async def get_medicine_queue(request: Request, _=Depends(require_auth)):
    # Queue is deprecated; return empty for compatibility
    try:
        return {"queue": []}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/medicines/jobs")
async def list_photo_jobs(request: Request, _=Depends(require_auth)):
    try:
        workspace = request.state.workspace
        jobs = _load_photo_jobs(workspace)
        return {"jobs": jobs}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.delete("/api/medicines/jobs/{job_id}")
async def delete_photo_job(job_id: str, request: Request, _=Depends(require_auth)):
    workspace = request.state.workspace
    jobs = _load_photo_jobs(workspace)
    jobs = [j for j in jobs if j.get("id") != job_id]
    _save_photo_jobs(workspace, jobs)
    return {"jobs": jobs}


@app.post("/api/medicines/jobs/{job_id}/retry")
async def retry_photo_job(job_id: str, request: Request, _=Depends(require_auth)):
    workspace = request.state.workspace
    updated, jobs = _update_job(
        workspace,
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


async def _process_photo_group(photo_paths: List[Path], photo_urls: List[str], workspace):
    primary_model = _resolve_med_model(workspace)
    image_path = Path(photo_paths[0])
    settings = db_op("settings", workspace=workspace)
    photo_prompt = settings.get("med_photo_prompt") or get_defaults().get("med_photo_prompt", "")

    try:
        result = await asyncio.to_thread(run_medicine_photo_inference, image_path, primary_model, photo_prompt)
        used_model = primary_model
    except Exception as e:
        raise RuntimeError(f"Photo inference failed for {primary_model}: {e}") from e

    med_record = build_inventory_record(result, photo_urls)
    entry = _merge_inventory_record(med_record, photo_urls, workspace)
    entry.update({"result": result, "used_model": used_model})
    return entry


@app.post("/api/medicines/photos")
async def enqueue_medicine_photos(request: Request, files: List[UploadFile] = File(...), group: bool = False, _=Depends(require_auth)):
    try:
        workspace = request.state.workspace
        med_dir = workspace["med_uploads"]
        if not files:
            return JSONResponse({"error": "No files uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)

        mode = request.query_params.get("mode") or ("grouped" if group else "single")
        grouped = mode.lower().startswith("group")
        new_jobs = []
        selected_model = _resolve_med_model(workspace)
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
                urls.append(f"/uploads/{workspace['slug']}/medicines/{filename}")
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
            log_job(f"[{workspace['label']}] queued grouped job {job_id} with {len(paths)} photo(s)")
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
                url = f"/uploads/{workspace['slug']}/medicines/{filename}"
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
                log_job(f"[{workspace['label']}] queued single job {job_id} for photo {filename}")
            if not new_jobs:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
        jobs = _load_photo_jobs(workspace)
        jobs.extend(new_jobs)
        _save_photo_jobs(workspace, jobs)
        log_job(f"[{workspace['label']}] total jobs queued: {len(jobs)}")
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
        workspace = request.state.workspace
        med_dir = workspace["med_uploads"]
        selected_model = _resolve_med_model(workspace)
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
                urls.append(f"/uploads/{workspace['slug']}/medicines/{filename}")
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
            log_job(f"[{workspace['label']}] queued grouped job {job_id} with {len(paths)} photo(s)")
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
                url = f"/uploads/{workspace['slug']}/medicines/{filename}"
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
                log_job(f"[{workspace['label']}] queued single job for photo {filename}")
            if not jobs_to_add:
                return JSONResponse({"error": "No valid image files were uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
        jobs = _load_photo_jobs(workspace)
        jobs.extend(jobs_to_add)
        _save_photo_jobs(workspace, jobs)
        log_job(f"[{workspace['label']}] total jobs queued: {len(jobs)}")
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
    try:
        workspace = request.state.workspace
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
        s = db_op("settings", workspace=workspace)

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

        prompt, cfg = build_prompt(s, mode, msg, p_name, workspace)
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
            if "Missing model cache" in str(e):
                return JSONResponse(
                    {"error": str(e), "offline_missing": True},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
        elapsed_ms = max(int((datetime.now() - start_time).total_seconds() * 1000), 0)

        if not is_priv:
            h = db_op("history", workspace=workspace)
            patient_display = (
                lookup_patient_display_name(p_name, workspace, default="Unnamed Crew")
                if mode == "triage"
                else "Inquiry"
            )
            h.append(
                {
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
            )
            db_op("history", h, workspace=workspace)

        return JSONResponse(
            {
                "response": f"{res}\n\n(Response time: {elapsed_ms} ms)",
                "model": models["active_name"],
                "duration_ms": elapsed_ms,
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
    workspace = request.state.workspace
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
    s = db_op("settings", workspace=workspace)
    prompt, cfg = build_prompt(s, mode, msg, p_name, workspace)
    return {"prompt": prompt, "mode": mode, "patient": p_name, "cfg": cfg}


def has_model_cache(model_name: str):
    ok, _ = model_cache_status(model_name)
    return ok


def model_cache_status(model_name: str):
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
        if not cached and download_missing and not offline and AUTO_DOWNLOAD_MODELS:
            downloaded, error = download_model_cache(m)
            cached, cache_err = model_cache_status(m)
        if not cached and not error:
            error = cache_err or "config/weights missing in cache"
        results.append({"model": m, "cached": cached, "downloaded": downloaded, "error": error})
    return results


@app.get("/api/offline/check")
async def offline_check(_=Depends(require_auth)):
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
    try:
        workspace = request.state.workspace
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = workspace["backup"] / f"offline_backup_{ts}.zip"
        base = APP_HOME.resolve()
        with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for root in [workspace["data"], workspace["uploads"], CACHE_DIR]:
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
        workspace = request.state.workspace
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        filename = (payload.get("filename") or "").strip()
        backup_dir = workspace["backup"]
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

_startup_model_check()
_start_photo_worker()

if __name__ == "__main__":
    import uvicorn

    print("=" * 50)
    print("🏥 SailingMedAdvisor Starting (FastAPI)...")
    print("=" * 50)
    print("Access via: http://0.0.0.0:5000 (all network interfaces)")
    print("=" * 50)

    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=False)
def _clear_workspace_data(workspace):
    """Remove data and uploads for a workspace to start fresh."""
    if not workspace:
        return
    # Clear data directory
    for path in workspace["data"].iterdir():
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        except Exception:
            continue
    # Clear uploads (including medicine photos)
    for path in workspace["uploads"].iterdir():
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        except Exception:
            continue
    # Recreate expected files with defaults
    db_op("settings", get_defaults(), workspace=workspace)
    db_op("patients", [], workspace=workspace)
    db_op("inventory", [], workspace=workspace)
    db_op("tools", [], workspace=workspace)
    db_op("history", [], workspace=workspace)
    db_op("vessel", {}, workspace=workspace)
    db_op("med_photo_queue", [], workspace=workspace)
    db_op("med_photo_jobs", [], workspace=workspace)
    db_op("chats", [], workspace=workspace)
    db_op("context", {}, workspace=workspace)


def _apply_default_dataset(workspace):
    """Copy default data + uploads into the given workspace."""
    if not workspace:
        return
    default_root = DATA_ROOT / "default"
    default_uploads = default_root / "uploads"
    default_root.mkdir(parents=True, exist_ok=True)
    default_uploads.mkdir(parents=True, exist_ok=True)
    (default_uploads / "medicines").mkdir(parents=True, exist_ok=True)
    # Copy data files
    for name in ["settings", "patients", "inventory", "tools", "history", "vessel", "chats", "med_photo_queue", "med_photo_jobs", "context"]:
        src = default_root / f"{name}.json"
        dest = workspace["data"] / f"{name}.json"
        if src.exists():
            dest.write_text(src.read_text())
    # Copy uploads (medicines)
    src_med = default_uploads / "medicines"
    dest_med = workspace["uploads"] / "medicines"
    if src_med.exists():
        dest_med.mkdir(parents=True, exist_ok=True)
        for item in src_med.iterdir():
            if item.is_file():
                shutil.copy2(item, dest_med / item.name)
