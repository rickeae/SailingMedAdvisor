import json
from pathlib import Path
from datetime import datetime
from db_store import configure_db, ensure_workspace, set_doc

BASE = Path(__file__).parent.resolve()
DATA_ROOT = BASE / "data"
DB_PATH = DATA_ROOT / "app.db"

CATEGORIES = [
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

DEFAULTS_DIR = DATA_ROOT / "default"


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text() or json.dumps(default))
    except Exception:
        return default


def default_for(cat: str):
    if cat == "settings":
        return {}
    if cat == "vessel":
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


def import_workspace(label: str, slug: str):
    ws_dir = DATA_ROOT / slug
    # Fallback to root data/ if slug dir missing
    if not ws_dir.exists():
        ws_dir = DATA_ROOT
        print(f"[info] using root data dir for {label} ({slug})")
    ws_rec = ensure_workspace(label, slug)
    ws_id = ws_rec["id"]
    print(f"[ws] {label} ({slug}) -> id {ws_id}")
    for cat in CATEGORIES:
        path = ws_dir / f"{cat}.json"
        default_data = load_json(DEFAULTS_DIR / f"{cat}.json", default_for(cat))
        payload = load_json(path, default_data)
        set_doc(ws_id, cat, payload)
        if isinstance(payload, list):
            count = len(payload)
        elif isinstance(payload, dict):
            count = len(payload)
        else:
            count = 1
        print(f"  - {cat}: imported ({count} items)")


def main():
    configure_db(DB_PATH)
    # Map known workspaces; adjust as needed
    workspaces = {
        "Rick": "rick",
        "Lorraine": "lorraine",
        "Demo Workspace Pre-Loaded with Sample Data": "demo-workspace-pre-loaded-with-sample-data",
    }
    for label, slug in workspaces.items():
        import_workspace(label, slug)
    print("[done] migration complete at", datetime.utcnow().isoformat())


if __name__ == "__main__":
    main()
