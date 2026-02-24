#!/usr/bin/env bash
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
# scripts/install_fresh_copy.sh
#
# Purpose:
#   Streamline first-time setup on a new machine:
#   1) clone repository (optional)
#   2) create virtual environment
#   3) install Python dependencies
#   4) run deterministic install verification
#
# Usage examples:
#   ./scripts/install_fresh_copy.sh
#   ./scripts/install_fresh_copy.sh --target ~/SailingMedAdvisor --repo-url https://github.com/rickeae/SailingMedAdvisor.git
#   ./scripts/install_fresh_copy.sh --skip-clone --skip-verify

set -euo pipefail

REPO_URL="https://github.com/rickeae/SailingMedAdvisor.git"
BRANCH="main"
TARGET_DIR=""
SKIP_CLONE="0"
SKIP_VERIFY="0"
PYTHON_BIN="python3"

usage() {
  cat <<'EOF'
install_fresh_copy.sh

Options:
  --repo-url <url>      Git repository URL (default: official GitHub repo)
  --branch <name>       Branch to checkout (default: main)
  --target <path>       Target directory (default: current directory if --skip-clone, else ./SailingMedAdvisor)
  --python <bin>        Python executable (default: python3)
  --skip-clone          Use existing repository in target/current directory
  --skip-verify         Skip post-install verification script
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="$2"; shift 2 ;;
    --branch)
      BRANCH="$2"; shift 2 ;;
    --target)
      TARGET_DIR="$2"; shift 2 ;;
    --python)
      PYTHON_BIN="$2"; shift 2 ;;
    --skip-clone)
      SKIP_CLONE="1"; shift ;;
    --skip-verify)
      SKIP_VERIFY="1"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1 ;;
  esac
done

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "ERROR: Python executable not found: $PYTHON_BIN"
  exit 1
fi

if [[ "$SKIP_CLONE" == "1" ]]; then
  if [[ -n "$TARGET_DIR" ]]; then
    WORKDIR="$TARGET_DIR"
  else
    WORKDIR="$(pwd)"
  fi
else
  if [[ -z "$TARGET_DIR" ]]; then
    TARGET_DIR="$(pwd)/SailingMedAdvisor"
  fi
  WORKDIR="$TARGET_DIR"
  if [[ -d "$WORKDIR/.git" ]]; then
    echo "[info] Existing git repo detected at $WORKDIR; fetching latest branch $BRANCH"
    git -C "$WORKDIR" fetch --all --tags
    git -C "$WORKDIR" checkout "$BRANCH"
    git -C "$WORKDIR" pull --ff-only
  else
    echo "[info] Cloning $REPO_URL into $WORKDIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$WORKDIR"
  fi
fi

if [[ ! -f "$WORKDIR/app.py" || ! -f "$WORKDIR/requirements.txt" ]]; then
  echo "ERROR: $WORKDIR does not look like SailingMedAdvisor repository root."
  exit 1
fi

echo "[info] Working directory: $WORKDIR"
cd "$WORKDIR"

if [[ ! -d ".venv" ]]; then
  echo "[info] Creating virtual environment"
  "$PYTHON_BIN" -m venv .venv
fi

echo "[info] Upgrading pip/setuptools/wheel"
./.venv/bin/python -m pip install --upgrade pip setuptools wheel

echo "[info] Installing dependencies"
./.venv/bin/pip install -r requirements.txt

chmod +x run_med_advisor.sh
chmod +x scripts/verify_fresh_install.py || true

if [[ "$SKIP_VERIFY" == "0" ]]; then
  echo "[info] Running installation verification"
  ./.venv/bin/python scripts/verify_fresh_install.py
else
  echo "[warn] Verification skipped (--skip-verify)"
fi

cat <<'EOF'

Installation complete.

Next steps:
1) Start app:
   FORCE_CUDA=0 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh
2) Open:
   http://127.0.0.1:5000
3) In Settings > Offline Readiness Check:
   - Check cache status
   - Download missing models (while online)
   - Enable offline mode before offshore use
EOF
