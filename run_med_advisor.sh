#!/bin/bash
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
# Prefer FP16 on RTX-class GPUs and enable flash attention kernels
export FORCE_FP16=1
export USE_FLASH_ATTENTION=1
export TORCH_USE_CUDA_DSA=0
# Force CUDA placement when available
export FORCE_CUDA=1
# Allow model to use more VRAM before offloading
export MODEL_MAX_GPU_MEM=15GiB
export MODEL_MAX_CPU_MEM=64GiB

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
