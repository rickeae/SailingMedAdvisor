#!/usr/bin/env bash
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
# scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
#
# Purpose:
#   End-to-end bootstrap for a clean Ubuntu 24.04 machine:
#   1) install required system packages
#   2) clone SailingMedAdvisor anonymously from GitHub
#   3) run project install script
#   4) run fresh-install verification
#   5) optionally start the app
#
# Usage:
#   chmod +x scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
#   ./scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
#
# Optional flags:
#   --target <dir>         Install directory (default: $HOME/SailingMedAdvisor)
#   --branch <name>        Git branch (default: main)
#   --repo-url <url>       Repo URL (default: public GitHub URL)
#   --skip-system-packages Skip apt install step
#   --start                Start app after verification
#   --prefer-gpu-start     Prefer GPU settings when starting app (default is CPU-safe start)
#   --force-cuda <0|1>     Set FORCE_CUDA explicitly when starting app
#   --help                 Show usage

set -euo pipefail

REPO_URL="https://github.com/rickeae/SailingMedAdvisor.git"
BRANCH="main"
TARGET_DIR="${HOME}/SailingMedAdvisor"
SKIP_SYSTEM_PACKAGES="0"
START_APP="0"
PREFER_GPU_START="0"
FORCE_CUDA_OVERRIDE=""

usage() {
  cat <<'EOF'
bootstrap_ubuntu24_sailingmedadvisor.sh

Flags:
  --target <dir>          Install directory (default: $HOME/SailingMedAdvisor)
  --branch <name>         Git branch (default: main)
  --repo-url <url>        Repo URL (default: https://github.com/rickeae/SailingMedAdvisor.git)
  --skip-system-packages  Skip apt package installation
  --start                 Start app after successful verification
  --prefer-gpu-start      Prefer GPU startup flags (default start is CPU-safe)
  --force-cuda <0|1>      Force FORCE_CUDA value when starting app
  --help                  Show this help text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_DIR="$2"; shift 2 ;;
    --branch)
      BRANCH="$2"; shift 2 ;;
    --repo-url)
      REPO_URL="$2"; shift 2 ;;
    --skip-system-packages)
      SKIP_SYSTEM_PACKAGES="1"; shift ;;
    --start)
      START_APP="1"; shift ;;
    --prefer-gpu-start)
      PREFER_GPU_START="1"; shift ;;
    --force-cuda)
      FORCE_CUDA_OVERRIDE="$2"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1 ;;
  esac
done

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  echo "ERROR: Need root or sudo to run: $*"
  exit 1
}

install_system_packages() {
  if [[ "$SKIP_SYSTEM_PACKAGES" == "1" ]]; then
    echo "[info] Skipping apt package installation (--skip-system-packages)"
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "[warn] apt-get not found; skipping package install step."
    return
  fi
  echo "[step] Installing system packages (git, python3, venv, pip, certs)"
  run_as_root apt-get update
  run_as_root apt-get install -y git python3 python3-venv python3-pip ca-certificates
}

clone_or_update_repo() {
  echo "[step] Cloning/updating repository"
  if [[ -d "$TARGET_DIR/.git" ]]; then
    echo "[info] Existing repo found at $TARGET_DIR"
    git -C "$TARGET_DIR" fetch --all --tags
    git -C "$TARGET_DIR" checkout "$BRANCH"
    git -C "$TARGET_DIR" pull --ff-only
    return
  fi
  if [[ -e "$TARGET_DIR" && ! -d "$TARGET_DIR/.git" ]]; then
    echo "ERROR: Target exists but is not a git repo: $TARGET_DIR"
    exit 1
  fi
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
}

install_project() {
  echo "[step] Running project installer"
  cd "$TARGET_DIR"
  chmod +x scripts/install_fresh_copy.sh
  ./scripts/install_fresh_copy.sh --skip-clone
}

verify_project() {
  echo "[step] Running verification"
  cd "$TARGET_DIR"
  ./.venv/bin/python scripts/verify_fresh_install.py
}

resolve_force_cuda() {
  if [[ -n "$FORCE_CUDA_OVERRIDE" ]]; then
    echo "$FORCE_CUDA_OVERRIDE"
    return
  fi
  # Default to CPU-safe startup for reproducibility across unknown machines.
  # This avoids failing on hosts with partial/broken GPU drivers.
  if [[ "$PREFER_GPU_START" != "1" ]]; then
    echo "0"
    return
  fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "1"
  else
    echo "0"
  fi
}

start_project_if_requested() {
  if [[ "$START_APP" != "1" ]]; then
    return
  fi
  cd "$TARGET_DIR"
  chmod +x run_med_advisor.sh
  FORCE_CUDA_VALUE="$(resolve_force_cuda)"
  if [[ "$FORCE_CUDA_VALUE" == "1" ]]; then
    echo "[step] Starting SailingMedAdvisor in GPU-preferred mode (FORCE_CUDA=1)"
    FORCE_CUDA=1 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh
  else
    echo "[step] Starting SailingMedAdvisor in CPU-safe mode (FORCE_CUDA=0)"
    FORCE_CUDA=0 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh
  fi
}

main() {
  echo "=================================================="
  echo "SailingMedAdvisor Ubuntu 24.04 Bootstrap"
  echo "Target: $TARGET_DIR"
  echo "Repo:   $REPO_URL ($BRANCH)"
  echo "=================================================="

  install_system_packages
  clone_or_update_repo
  install_project
  verify_project

  cat <<EOF

[done] Fresh install test completed successfully.
Installed at: $TARGET_DIR

To run manually:
  cd "$TARGET_DIR"
  FORCE_CUDA=0 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh

EOF
  start_project_if_requested
}

main "$@"
