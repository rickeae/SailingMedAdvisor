import os
import json
import torch
import secrets
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException, status, Depends
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from transformers import AutoProcessor, AutoModelForImageTextToText

# Core config
DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

# FastAPI app
app = FastAPI(title="SailingMedAdvisor")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Model state
device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
models = {"active_name": "", "model": None, "processor": None}


def load_model(model_name: str):
    """Lazy-load and cache the selected model."""
    if models["active_name"] == model_name:
        return
    models["processor"] = AutoProcessor.from_pretrained(model_name, use_fast=True)
    models["model"] = AutoModelForImageTextToText.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map="auto" if device == "cuda" else None,
    )
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
    }


def db_op(cat, data=None):
    # Input validation to prevent path traversal
    allowed_categories = ["settings", "patients", "inventory", "tools", "history", "chats", "vessel"]
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
        path.write_text(json.dumps(data, indent=4))
        return data

    return json.loads(path.read_text() or "[]")


def get_credentials():
    """Return list of crew entries that have username/password set."""
    return [p for p in db_op("patients") if p.get("username") and p.get("password")]


def load_context():
    """Load context/sidebar content from data/context.json, ensure file exists."""
    path = DATA_DIR / "context.json"
    if not path.exists():
        path.write_text(json.dumps({}, indent=4))
    return json.loads(path.read_text() or "{}")


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
            payload = await request.json()
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


@app.post("/api/chat")
async def chat(request: Request, _=Depends(require_auth)):
    try:
        form = await request.form()
        msg = form.get("message")
        p_name = form.get("patient")
        mode = form.get("mode")
        is_priv = form.get("private") == "true"
        model_choice = form.get("model_choice")

        load_model(model_choice)
        s = db_op("settings")

        rep_penalty = float(s.get("rep_penalty", 1.1) or 1.1)
        mission_context = s.get("mission_context", "")

        if mode == "inquiry":
            prompt = f"INSTRUCTION: {s.get('inquiry_instruction')}\n\nQUERY: {msg}"
            cfg = {
                "t": float(s.get("in_temp", 0.6)),
                "tk": int(s.get("in_tok", 2048)),
                "p": float(s.get("in_p", 0.95)),
            }
        else:
            inv = ", ".join([m["name"] for m in db_op("inventory")])
            tools = ", ".join([t["name"] for t in db_op("tools")])
            p_hist = next(
                (p.get("history", "No records.") for p in db_op("patients") if p.get("name") == p_name),
                "No records.",
            )
            prompt = (
                f"RULES: {s.get('triage_instruction')}\n"
                f"RESOURCES: {inv} | {tools}\n"
                f"PATIENT: {p_name}\n"
                f"HISTORY: {p_hist}\n"
                f"SITUATION: {msg}"
            )
            cfg = {
                "t": float(s.get("tr_temp", 0.1)),
                "tk": int(s.get("tr_tok", 1024)),
                "p": float(s.get("tr_p", 0.9)),
            }

        # Apply mission context to both modes when present
        if mission_context:
            prompt = f"MISSION CONTEXT: {mission_context}\n\n{prompt}"

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
            repetition_penalty=rep_penalty,
            do_sample=(cfg["t"] > 0),
        )

        res = models["processor"].decode(out[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True).strip()

        if not is_priv:
            h = db_op("history")
            h.append(
                {
                    "id": datetime.now().isoformat(),
                    "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "patient": p_name if mode == "triage" else "Inquiry",
                    "query": msg,
                    "response": res,
                }
            )
            db_op("history", h)

        return JSONResponse({"response": res, "model": models["active_name"]})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


if __name__ == "__main__":
    import uvicorn

    print("=" * 50)
    print("🏥 SailingMedAdvisor Starting (FastAPI)...")
    print("=" * 50)
    print("Access via: http://0.0.0.0:5000 (all network interfaces)")
    print("=" * 50)

    uvicorn.run("app:app", host="0.0.0.0", port=5000, reload=False)
