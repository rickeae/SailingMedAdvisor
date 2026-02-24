#!/usr/bin/env python3
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
scripts/verify_fresh_install.py

Purpose:
Run a deterministic "fresh machine" verification for SailingMedAdvisor.
This checks runtime prerequisites, required files, database schema, default
triage tree content, and a lightweight API startup smoke test.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Tuple


REQUIRED_IMPORTS = [
    "fastapi",
    "uvicorn",
    "jinja2",
    "multipart",  # python-multipart import name
    "aiofiles",
    "PIL",
    "torch",
    "transformers",
    "bitsandbytes",
    "accelerate",
    "safetensors",
    "huggingface_hub",
    "itsdangerous",
    "dotenv",
]

REQUIRED_FILES = [
    "app.py",
    "db_store.py",
    "requirements.txt",
    "run_med_advisor.sh",
    "seed/triage_prompt_tree.default.json",
    "templates/index.html",
    "static/js/chat.js",
]

REQUIRED_TABLES = [
    "settings_meta",
    "crew",
    "triage_options",
    "triage_prompt_modules",
    "triage_prompt_tree",
]


class CheckResults:
    def __init__(self) -> None:
        self.ok: List[str] = []
        self.fail: List[str] = []
        self.warn: List[str] = []

    def pass_(self, msg: str) -> None:
        self.ok.append(msg)
        print(f"[PASS] {msg}")

    def fail_(self, msg: str) -> None:
        self.fail.append(msg)
        print(f"[FAIL] {msg}")

    def warn_(self, msg: str) -> None:
        self.warn.append(msg)
        print(f"[WARN] {msg}")

    def summary(self) -> int:
        print("\n=== Verification Summary ===")
        print(f"Passed: {len(self.ok)}")
        print(f"Warnings: {len(self.warn)}")
        print(f"Failed: {len(self.fail)}")
        return 1 if self.fail else 0


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def check_python_version(results: CheckResults) -> None:
    if sys.version_info >= (3, 10):
        results.pass_(f"Python version is supported: {sys.version.split()[0]}")
    else:
        results.fail_(f"Python >= 3.10 required, found {sys.version.split()[0]}")


def check_required_files(results: CheckResults, repo: Path) -> None:
    missing = [rel for rel in REQUIRED_FILES if not (repo / rel).exists()]
    if missing:
        results.fail_(f"Missing required files: {', '.join(missing)}")
        return
    results.pass_("Required project files are present")


def check_imports(results: CheckResults) -> None:
    missing = []
    for mod in REQUIRED_IMPORTS:
        try:
            importlib.import_module(mod)
        except Exception:
            missing.append(mod)
    if missing:
        results.fail_(f"Missing Python imports: {', '.join(missing)}")
    else:
        results.pass_("All required Python packages import successfully")


def _is_valid_sqlite(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(16).startswith(b"SQLite format 3")
    except Exception:
        return False


def _ensure_runtime_db(repo: Path, results: CheckResults) -> Path:
    db_path = repo / "app.db"
    if db_path.exists() and _is_valid_sqlite(db_path):
        results.pass_(f"Runtime DB present: {db_path}")
        return db_path

    # If DB is absent/invalid on fresh machine, initialize schema via db_store.
    try:
        import db_store

        db_store.configure_db(db_path)
        if db_path.exists() and _is_valid_sqlite(db_path):
            results.pass_(f"Runtime DB initialized: {db_path}")
            return db_path
        results.fail_("Failed to initialize runtime DB")
    except Exception as exc:
        results.fail_(f"DB initialization error: {exc}")
    return db_path


def check_db_schema(results: CheckResults, db_path: Path) -> None:
    if not db_path.exists() or not _is_valid_sqlite(db_path):
        results.fail_("DB schema check skipped: app.db missing or invalid")
        return

    try:
        with sqlite3.connect(db_path) as conn:
            names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            missing = [t for t in REQUIRED_TABLES if t not in names]
            if missing:
                results.fail_(f"DB missing required tables: {', '.join(missing)}")
            else:
                results.pass_("DB schema includes required tables")

            row = conn.execute("SELECT payload FROM triage_prompt_tree WHERE id=1").fetchone()
            if not row:
                results.fail_("triage_prompt_tree id=1 is missing")
                return
            payload = json.loads(row[0] or "{}")
            if not isinstance(payload.get("tree"), dict) or not payload["tree"]:
                results.fail_("triage_prompt_tree payload has no valid tree")
            else:
                results.pass_("triage_prompt_tree payload exists and is valid JSON")
    except Exception as exc:
        results.fail_(f"DB schema read failed: {exc}")


def check_default_tree_json(results: CheckResults, repo: Path) -> None:
    path = repo / "seed/triage_prompt_tree.default.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        results.fail_(f"Default tree JSON unreadable: {exc}")
        return

    if not isinstance(payload.get("base_doctrine"), str) or not payload["base_doctrine"].strip():
        results.fail_("Default tree is missing base_doctrine text")
        return

    tree = payload.get("tree")
    if not isinstance(tree, dict) or not tree:
        results.fail_("Default tree JSON missing top-level tree map")
        return

    required_domains = {
        "Trauma",
        "Illness",
        "Toxins/Bites/Stings & Environmental Hazards",
        "Dental",
        "Psychological/Behavioral",
    }
    missing_domains = sorted(required_domains - set(tree.keys()))
    if missing_domains:
        results.warn_(f"Default tree missing expected domains: {', '.join(missing_domains)}")
    else:
        results.pass_("Default tree includes expected core domains")


def _poll_db_status(base_url: str, timeout_s: int) -> Tuple[bool, str]:
    start = time.time()
    url = f"{base_url}/api/db/status"
    while time.time() - start < timeout_s:
        try:
            with urllib.request.urlopen(url, timeout=2.0) as resp:
                if resp.status != 200:
                    time.sleep(0.5)
                    continue
                data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, dict) and "exists" in data:
                    return True, f"/api/db/status ok: exists={data.get('exists')} size={data.get('size')}"
        except urllib.error.URLError:
            time.sleep(0.5)
        except Exception:
            time.sleep(0.5)
    return False, "Timed out waiting for /api/db/status"


def smoke_test_api_startup(results: CheckResults, repo: Path, port: int, timeout_s: int) -> None:
    env = os.environ.copy()
    # Keep startup deterministic and fast for verification.
    env["VERIFY_MODELS_ON_START"] = "0"
    env["AUTO_VERIFY_ONLINE"] = "0"
    env["AUTO_DOWNLOAD_MODELS"] = env.get("AUTO_DOWNLOAD_MODELS", "0")

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    proc = subprocess.Popen(
        cmd,
        cwd=str(repo),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        ok, detail = _poll_db_status(f"http://127.0.0.1:{port}", timeout_s=timeout_s)
        if ok:
            results.pass_(f"API startup smoke test passed ({detail})")
        else:
            # Pull a short tail to help debug startup failures.
            tail = ""
            try:
                if proc.stdout:
                    out = proc.stdout.read() or ""
                    tail = out[-1200:]
            except Exception:
                pass
            if tail.strip():
                results.fail_(f"API smoke test failed: {detail}\n--- uvicorn tail ---\n{tail}")
            else:
                results.fail_(f"API smoke test failed: {detail}")
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify fresh SailingMedAdvisor install")
    parser.add_argument("--repo", default=str(_repo_root()), help="Repository root path")
    parser.add_argument("--skip-smoke", action="store_true", help="Skip uvicorn startup smoke test")
    parser.add_argument("--port", type=int, default=5077, help="Port for smoke test server")
    parser.add_argument("--timeout", type=int, default=40, help="Smoke test timeout in seconds")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    results = CheckResults()
    print(f"[info] Verifying repository: {repo}")

    check_python_version(results)
    check_required_files(results, repo)
    check_imports(results)
    db_path = _ensure_runtime_db(repo, results)
    check_db_schema(results, db_path)
    check_default_tree_json(results, repo)
    if not args.skip_smoke:
        smoke_test_api_startup(results, repo, port=args.port, timeout_s=args.timeout)

    return results.summary()


if __name__ == "__main__":
    raise SystemExit(main())

