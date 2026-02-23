#!/bin/bash
# =============================================================================
# Author: Rick Escher
# Project: SilingMedAdvisor (SailingMedAdvisor)
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
# run_med_advisor.sh - Secure startup script for MedGemma Advisor

echo "=================================================="
echo "SailingMeAdvisor - Offline emergency medical guidance for offshore sailors,"
echo "powered by MedGemma (HAI-DEF)"
echo ""
echo "=================================================="

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo "❌ Error: Virtual environment not found!"
    echo "Please create it first: python3 -m venv .venv"
    exit 1
fi

# Activate virtual environment
source .venv/bin/activate

# Check if required packages are installed
python3 -c "import fastapi, uvicorn" 2>/dev/null || {
    echo "❌ Error: FastAPI or Uvicorn not installed. Install with: pip install fastapi uvicorn[standard]"
    exit 1
}

# Set environment variables (can be customized)
# export ADMIN_PASSWORD='your_secure_password'
# export SECRET_KEY='your_secret_key'
# Prefer BF16 for stability; set FORCE_FP16=1 (and ALLOW_FP16=1) to override.
# Respect user override; default to 0 to prefer BF16 on supported GPUs.
export FORCE_FP16="${FORCE_FP16:-0}"
# Keep SDP kernels conservative on RTX 5000/Turing; opt in to fast kernels manually.
export USE_FAST_SDP="${USE_FAST_SDP:-0}"
# Tab bar theme toggle:
# 1 = splash purple (#7452B9), 0 = default gray.
export USE_SPLASH_PURPLE_TABBAR="${USE_SPLASH_PURPLE_TABBAR:-0}"
# Legacy env retained for compatibility with any existing checks.
export USE_FLASH_ATTENTION="${USE_FLASH_ATTENTION:-$USE_FAST_SDP}"
export TORCH_USE_CUDA_DSA=0
# Force CUDA placement when available
export FORCE_CUDA="${FORCE_CUDA:-1}"
# Keep GPU-only behavior by default; set to 1 only if you explicitly want CPU fallback on CUDA runtime faults.
export ALLOW_CPU_FALLBACK_ON_CUDA_ERROR="${ALLOW_CPU_FALLBACK_ON_CUDA_ERROR:-0}"
# Keep global cap high for 4B but reserve headroom for 27B KV cache.
export MODEL_MAX_GPU_MEM="${MODEL_MAX_GPU_MEM:-15GiB}"
export MODEL_MAX_GPU_MEM_27B="${MODEL_MAX_GPU_MEM_27B:-8GiB}"
export MODEL_MAX_CPU_MEM=64GiB
# 0 disables hard cap so token count comes from Settings (tr_tok/in_tok).
export MODEL_MAX_NEW_TOKENS_27B="${MODEL_MAX_NEW_TOKENS_27B:-0}"
export MODEL_MAX_INPUT_TOKENS_27B="${MODEL_MAX_INPUT_TOKENS_27B:-2048}"
export MODEL_DEVICE_MAP_27B="${MODEL_DEVICE_MAP_27B:-manual}"
export MODEL_GPU_LAYERS_27B="${MODEL_GPU_LAYERS_27B:-14}"
export MODEL_ATTN_IMPL_27B="${MODEL_ATTN_IMPL_27B:-eager}"
# Reduce allocator fragmentation on long sessions.
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

# CUDA preflight: fail early when FORCE_CUDA=1 so we don't silently run on CPU.
if [ "$FORCE_CUDA" = "1" ]; then
    echo "🔎 CUDA preflight (FORCE_CUDA=1)"
    python3 - <<'PY'
import sys
import torch

if not torch.cuda.is_available():
    print("❌ CUDA preflight failed: torch.cuda.is_available() is False")
    try:
        torch.cuda.current_device()
    except Exception as exc:
        print(f"   CUDA error: {exc}")
    sys.exit(1)

try:
    _ = torch.zeros(1, device="cuda")
except Exception as exc:
    print(f"❌ CUDA preflight failed during tensor allocation: {exc}")
    sys.exit(1)

print(f"✅ CUDA preflight passed on GPU: {torch.cuda.get_device_name(0)}")
PY
    if [ $? -ne 0 ]; then
        echo "Hint: check kernel GPU errors with: journalctl -k | grep -i -E 'NVRM|Xid'"
        echo "If errors persist, reboot or reload NVIDIA driver modules before restarting SailingMedAdvisor."
        exit 1
    fi
fi

# Detect a LAN IP to share in the startup banner (best effort)
LAN_IP=$(hostname -I 2>/dev/null | awk 'NF{print $1; exit}')
if [ -z "$LAN_IP" ] && command -v ip >/dev/null 2>&1; then
    LAN_IP=$(ip route get 8.8.8.8 2>/dev/null | awk 'NR==1 {print $7}')
fi

# Run the application
echo "🚀 Starting server on http://127.0.0.1:5000"
if [ -n "$LAN_IP" ]; then
    echo "🌐 LAN access: http://${LAN_IP}:5000"
else
    echo "🌐 LAN access: http://<this-machine-ip>:5000"
fi
echo "=================================================="
python3 -m uvicorn app:app --host 0.0.0.0 --port 5000
