# SailingMedAdvisor Fresh Install Guide

This guide is the reproducible install path for setting up a working copy of SailingMedAdvisor on a new computer.

## 1. Prerequisites

- OS: Linux (tested on Ubuntu-class environments)
- Python: `3.10+`
- Git: installed
- GPU runtime (recommended for MedGemma inference):
  - NVIDIA driver + CUDA-compatible PyTorch environment
- Network access for first-time dependency/model downloads

## 2. One-Command Install (Recommended)

From any directory:

```bash
git clone https://github.com/rickeae/SailingMedAdvisor.git
cd SailingMedAdvisor
chmod +x scripts/install_fresh_copy.sh
./scripts/install_fresh_copy.sh --skip-clone
```

What this does:

1. Creates `.venv`
2. Installs dependencies from `requirements.txt`
3. Runs deterministic verification (`scripts/verify_fresh_install.py`)

## 2b. Full Ubuntu 24.04 Bootstrap (System + Clone + Install + Verify)

If the machine is truly fresh and you want one script to do the full flow:

```bash
git clone https://github.com/rickeae/SailingMedAdvisor.git
cd SailingMedAdvisor
chmod +x scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
./scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
```

Optional: also launch the app automatically after verification:

```bash
./scripts/bootstrap_ubuntu24_sailingmedadvisor.sh --start
```

## 3. Verification Command (Standalone)

You can re-run install verification any time:

```bash
./.venv/bin/python scripts/verify_fresh_install.py
```

Verification covers:

- Python version
- Required files present
- Required package imports
- Database initialization/schema checks
- Default triage tree JSON integrity
- API startup smoke test via `GET /api/db/status`

## 4. Start the Application

```bash
FORCE_CUDA=0 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh
```

Open:

- Local: `http://127.0.0.1:5000`
- LAN: `http://<machine-ip>:5000`

GPU-known-good optional start:

```bash
FORCE_CUDA=1 ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=1 ./run_med_advisor.sh
```

## 5. Prepare for Offline Use (Before Departure)

In the app UI:

1. Go to `Settings -> Offline Readiness Check`
2. Click `Check cache status`
3. Click `Download missing models` while internet is available
4. Enable offline flags before operating without internet

Expected required models:

- `google/medgemma-1.5-4b-it`
- `google/medgemma-27b-text-it`

## 6. Demo Reproduction Note

To reproduce the challenge demo scenario, select the 27B model in the consultation UI:

- `google/medgemma-27b-text-it`

## 7. Troubleshooting

- CUDA preflight fails:
  - Check `FORCE_CUDA` and NVIDIA driver health.
  - Use kernel logs (`journalctl -k | grep -i -E 'NVRM|Xid'`) to diagnose driver errors.
- API smoke test fails:
  - Re-run `./.venv/bin/python scripts/verify_fresh_install.py --timeout 90`
  - Check for port conflicts and Python import errors.
- Missing model cache in offline mode:
  - Disable offline flags temporarily, reconnect internet, then use `Download missing models`.
