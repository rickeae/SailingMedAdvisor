import os
import json
import uuid
import secrets
from datetime import datetime
from pathlib import Path
from typing import List

# Encourage less fragmentation on GPUs with limited VRAM (e.g., RTX 5000)
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch

from fastapi import FastAPI, Request, HTTPException, status, Depends, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image
from starlette.middleware.sessions import SessionMiddleware
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    AutoTokenizer,
    AutoModelForCausalLM,
    BitsAndBytesConfig,
)

# Core config
DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
UPLOAD_ROOT = Path("uploads")
UPLOAD_ROOT.mkdir(exist_ok=True)
MED_UPLOAD_DIR = UPLOAD_ROOT / "medicines"
MED_UPLOAD_DIR.mkdir(exist_ok=True)
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
OFFLOAD_DIR = Path("offload")
OFFLOAD_DIR.mkdir(exist_ok=True)

# FastAPI app
app = FastAPI(title="SailingMedAdvisor")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
templates = Jinja2Templates(directory="templates")

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


def unload_model():
    """Free GPU/CPU memory for previously loaded model."""
    models["model"] = None
    models["processor"] = None
    models["tokenizer"] = None
    models["active_name"] = ""
    models["is_text"] = False
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def load_model(model_name: str, allow_cpu_large: bool = False):
    """Lazy-load and cache the selected model."""
    if models["active_name"] == model_name:
        return
    # Free previous model to avoid VRAM exhaustion when switching
    unload_model()
    # Warn on CPU usage for large model unless explicitly allowed
    if "28b" in model_name.lower() and device != "cuda" and not allow_cpu_large:
        raise RuntimeError("SLOW_28B_CPU")

    is_text_only = "text" in model_name.lower()
    # Balanced mapping with capped GPU memory; spill the rest to CPU/offload
    device_map = "balanced_low_0" if device == "cuda" else None
    max_memory = {0: "10GiB", "cpu": "64GiB"} if device == "cuda" else None
    if is_text_only:
        models["tokenizer"] = AutoTokenizer.from_pretrained(model_name, use_fast=True)
        models["processor"] = None
        models["model"] = AutoModelForCausalLM.from_pretrained(
            model_name,
            torch_dtype=dtype,
            device_map=device_map,
            max_memory=max_memory,
            low_cpu_mem_usage=True,
            offload_folder=str(OFFLOAD_DIR),
            quantization_config=quant_config,
        )
    else:
        models["processor"] = AutoProcessor.from_pretrained(model_name, use_fast=True)
        models["tokenizer"] = None
        models["model"] = AutoModelForImageTextToText.from_pretrained(
            model_name,
            torch_dtype=dtype,
            device_map=device_map,
            max_memory=max_memory,
            low_cpu_mem_usage=True,
            offload_folder=str(OFFLOAD_DIR),
            quantization_config=quant_config,
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
    }


def db_op(cat, data=None):
    # Input validation to prevent path traversal
    allowed_categories = ["settings", "patients", "inventory", "tools", "history", "chats", "vessel", "med_photo_queue"]
    if cat not in allowed_categories:
        raise ValueError(f"Invalid category: {cat}")

    path = DATA_DIR / f"{cat}.json"
    if not path.exists() or path.stat().st_size == 0:
        if cat == "settings":
            content = get_defaults()
        elif cat == "vessel":
            content = {
                "vesselName": "",
                "registrationNumber": "",
                "flagCountry": "",
                "homePort": "",
                "callSign": "",
                "tonnage": "",
                "crewCapacity": "",
            }
        else:
            content = []
        path.write_text(json.dumps(content, indent=4))

    if data is not None:
        if cat == "settings":
            if not isinstance(data, dict):
                raise ValueError("Settings payload must be a JSON object.")
            try:
                existing = json.loads(path.read_text() or "{}")
                if not isinstance(existing, dict):
                    existing = {}
            except Exception:
                existing = {}
            merged = {**get_defaults(), **existing, **data}
            path.write_text(json.dumps(merged, indent=4))
            return merged
        path.write_text(json.dumps(data, indent=4))
        return data

    return json.loads(path.read_text() or "[]")


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


def build_prompt(settings, mode, msg, p_name):
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
        inv_items = []
        for m in db_op("inventory"):
            item_name = m.get("name") or m.get("genericName") or m.get("brandName")
            if item_name:
                inv_items.append(item_name)
        inv = ", ".join(inv_items)

        tool_items = []
        for t in db_op("tools"):
            tool_name = t.get("name")
            if tool_name:
                tool_items.append(tool_name)
        tools = ", ".join(tool_items)

        patient_record = next((p for p in db_op("patients") if p.get("name") == p_name), {})
        p_hist = patient_record.get("history", "No records.")
        p_sex = patient_record.get("sex") or patient_record.get("gender") or "Unknown"
        p_birth = patient_record.get("birthdate") or "Unknown"

        prompt_sections = [
            f"MISSION CONTEXT: {mission_context}" if mission_context else "",
            f"TRIAGE INSTRUCTION:\n{settings.get('triage_instruction')}",
            "RESOURCES:\n- Inventory: " + (inv or "None listed") + "\n- Tools: " + (tools or "None listed"),
            "PATIENT:\n"
            f"- Name: {p_name or 'Unnamed Crew'}\n"
            f"- Sex: {p_sex}\n"
            f"- Date of Birth: {p_birth}\n"
            f"- Medical History (profile): {p_hist or 'No records.'}",
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


def get_credentials():
    """Return list of crew entries that have username/password set."""
    return [p for p in db_op("patients") if p.get("username") and p.get("password")]


def load_context():
    """Load context/sidebar content from data/context.json, ensure file exists."""
    path = DATA_DIR / "context.json"
    if not path.exists():
        path.write_text(json.dumps({}, indent=4))
    return json.loads(path.read_text() or "{}")


def get_med_photo_queue():
    queue = db_op("med_photo_queue")
    return queue if isinstance(queue, list) else []


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


def build_inventory_record(extracted: dict, photo_url: str):
    now_id = f"med-{int(datetime.now().timestamp() * 1000)}"
    note = extracted.get("notes") or "Imported from medication photo."
    purchase_row = {
        "id": f"ph-{uuid.uuid4().hex}",
        "date": datetime.now().strftime("%Y-%m-%d"),
        "quantity": "",
        "price": "",
        "notes": note,
        "photos": [photo_url] if photo_url else [],
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
        "photos": [photo_url] if photo_url else [],
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


def run_medicine_photo_inference(image_path: Path):
    if not image_path.exists():
        raise FileNotFoundError("Image not found on disk")
    model_name = "Qwen/Qwen2.5-VL-7B-Instruct"
    load_model(model_name, allow_cpu_large=True)
    image = Image.open(image_path).convert("RGB")
    # Limit resolution to reduce VRAM/KV cache size
    image.thumbnail((1024, 1024))
    prompt = (
        "You are a pharmacy intake assistant on a sailing vessel. "
        "Look at the medication photo and return JSON only with keys: "
        "generic_name, brand_name, form, strength, expiry_date, batch_lot, "
        "storage_location, manufacturer, indication, allergy_warnings, dosage, notes."
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    processor = models["processor"]
    if processor is None:
        raise RuntimeError("Vision processor not initialized")
    chat = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=[chat], images=[image], return_tensors="pt").to(models["model"].device)
    with torch.no_grad():
        out = models["model"].generate(
            **inputs,
            max_new_tokens=160,
            temperature=0.1,
            top_p=0.9,
            do_sample=False,
            use_cache=True,
        )
    decoded = decode_generated_text(out, inputs, processor)
    payload = extract_json_payload(decoded)
    if not payload:
        payload = {"notes": decoded}
    normalized = normalize_medicine_fields(payload, decoded)
    normalized["raw"] = decoded
    return normalized


def require_auth(request: Request):
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return True


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@app.post("/login")
async def login(request: Request):
    payload = {}
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
    else:
        form = await request.form()
        payload = dict(form)

    crew_creds = get_credentials()
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
        (p for p in crew_creds if p.get("username") == username and p.get("password") == password),
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
    if not request.session.get("authenticated"):
        return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/auth/meta")
async def auth_meta():
    creds = get_credentials()
    return {"has_credentials": bool(creds), "count": len(creds)}


@app.api_route("/api/data/{cat}", methods=["GET", "POST"])
async def manage(cat: str, request: Request, _=Depends(require_auth)):
    try:
        if request.method == "POST":
            try:
                payload = await request.json()
            except Exception:
                form = await request.form()
                payload = dict(form)
            return JSONResponse(db_op(cat, payload))
        return JSONResponse(db_op(cat))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
    except Exception:
        return JSONResponse({"error": "Server error"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/context")
async def get_context(_=Depends(require_auth)):
    try:
        return JSONResponse(load_context())
    except Exception:
        return JSONResponse({"error": "Unable to load context"}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.get("/api/medicines/queue")
async def get_medicine_queue(_=Depends(require_auth)):
    try:
        return {"queue": get_med_photo_queue()}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/medicines/photos")
async def enqueue_medicine_photos(files: List[UploadFile] = File(...), _=Depends(require_auth)):
    if not files:
        return JSONResponse({"error": "No files uploaded"}, status_code=status.HTTP_400_BAD_REQUEST)
    queue = get_med_photo_queue()
    added = []
    for file in files:
        content_type = (file.content_type or "").lower()
        if not content_type.startswith("image/"):
            continue
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
            suffix = ".png"
        new_id = f"medimg-{uuid.uuid4().hex}"
        filename = f"{new_id}{suffix}"
        raw = await file.read()
        if not raw:
            continue
        save_path = MED_UPLOAD_DIR / filename
        save_path.write_bytes(raw)
        entry = {
            "id": new_id,
            "filename": filename,
            "path": str(save_path),
            "url": f"/uploads/medicines/{filename}",
            "status": "queued",
            "created_at": datetime.now().isoformat(),
            "error": "",
        }
        queue.append(entry)
        added.append(entry)
    db_op("med_photo_queue", queue)
    if not added:
        return JSONResponse({"error": "No valid image files were queued"}, status_code=status.HTTP_400_BAD_REQUEST)
    return {"queued": added, "queue": queue}


@app.post("/api/medicines/photos/{item_id}/process")
async def process_medicine_photo(item_id: str, _=Depends(require_auth)):
    queue = get_med_photo_queue()
    entry = next((i for i in queue if i.get("id") == item_id), None)
    if not entry:
        return JSONResponse({"error": "Queue item not found"}, status_code=status.HTTP_404_NOT_FOUND)
    entry["status"] = "processing"
    entry["error"] = ""
    db_op("med_photo_queue", queue)
    try:
        image_path = Path(entry.get("path") or "")
        result = run_medicine_photo_inference(image_path)
        med_record = build_inventory_record(result, entry.get("url", ""))
        inventory = db_op("inventory")
        inventory.append(med_record)
        db_op("inventory", inventory)
        entry["status"] = "completed"
        entry["completed_at"] = datetime.now().isoformat()
        entry["result"] = result
        entry["inventory_id"] = med_record["id"]
    except Exception as e:
        entry["status"] = "failed"
        entry["error"] = str(e)
    # Remove completed items from the queue so they no longer appear in the UI
    if entry.get("status") == "completed":
        queue = [i for i in queue if i.get("status") != "completed"]
    db_op("med_photo_queue", queue)
    status_code = status.HTTP_200_OK if entry.get("status") == "completed" else status.HTTP_500_INTERNAL_SERVER_ERROR
    return JSONResponse(entry, status_code=status_code)


@app.post("/api/chat")
async def chat(request: Request, _=Depends(require_auth)):
    try:
        start_time = datetime.now()
        form = await request.form()
        msg = form.get("message")
        p_name = form.get("patient")
        mode = form.get("mode")
        is_priv = form.get("private") == "true"
        model_choice = form.get("model_choice")
        force_cpu_slow = form.get("force_28b") == "true"
        override_prompt = form.get("override_prompt") or ""

        try:
            load_model(model_choice, allow_cpu_large=force_cpu_slow)
        except RuntimeError as e:
            if str(e) == "SLOW_28B_CPU":
                return JSONResponse(
                    {
                        "error": "The 28B MedGemma model on CPU can take an hour or more. Continue?",
                        "confirm_28b": True,
                    },
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            return JSONResponse({"error": str(e)}, status_code=status.HTTP_400_BAD_REQUEST)
        s = db_op("settings")

        prompt, cfg = build_prompt(s, mode, msg, p_name)
        if override_prompt.strip():
            prompt = override_prompt.strip()

        if models["is_text"]:
            tok = models["tokenizer"]
            messages = [{"role": "user", "content": prompt}]
            inputs = tok.apply_chat_template(
                messages,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            ).to(models["model"].device)
        else:
            inputs = models["processor"].apply_chat_template(
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

        if models["is_text"]:
            res = models["tokenizer"].decode(out[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True).strip()
        else:
            res = models["processor"].decode(out[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True).strip()

        elapsed_ms = max(int((datetime.now() - start_time).total_seconds() * 1000), 0)

        if not is_priv:
            h = db_op("history")
            h.append(
                {
                    "id": datetime.now().isoformat(),
                    "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "patient": p_name if mode == "triage" else "Inquiry",
                    "query": msg,
                    "response": res,
                    "model": models["active_name"],
                    "duration_ms": elapsed_ms,
                }
            )
            db_op("history", h)

        return JSONResponse({"response": res, "model": models["active_name"], "duration_ms": elapsed_ms})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/api/chat/preview")
async def chat_preview(request: Request, _=Depends(require_auth)):
    form = await request.form()
    msg = form.get("message")
    p_name = form.get("patient")
    mode = form.get("mode")
    s = db_op("settings")
    prompt, cfg = build_prompt(s, mode, msg, p_name)
    return {"prompt": prompt, "mode": mode, "patient": p_name, "cfg": cfg}


if __name__ == "__main__":
    import uvicorn

    print("=" * 50)
    print("🏥 SailingMedAdvisor Starting (FastAPI)...")
    print("=" * 50)
    print("Access via: http://0.0.0.0:5000 (all network interfaces)")
    print("=" * 50)

    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=False)
