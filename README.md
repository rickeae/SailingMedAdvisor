---
title: SailingMedAdvisor
emoji: ⛵
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# SailingMedAdvisor

Offline-first emergency decision support for offshore crews, using Google MedGemma models with a structured triage workflow.

## What This Repository Contains

This repository contains the active application code and core runtime assets for:

- FastAPI backend (`app.py`)
- SQLite persistence layer (`app.db`, `db_store.py`)
- MedGemma inference adapters (`medgemma4.py`, `medgemma27b.py`, `medgemma_common.py`)
- Frontend UI (`templates/`, `static/`)
- Default seed data (`data/default/`)
- Startup script (`run_med_advisor.sh`)

Non-project scratch/export artifacts have been removed from version control.

## Core Capabilities

- Triage and inquiry consultation modes
- Clinical triage pathway dropdowns (Domain, Problem, Anatomy, Mechanism/Cause, Severity/Complication)
- Patient condition capture (Consciousness, Breathing, Circulation, Overall Stability)
- Prompt assembly with pathway fallback to general triage instructions when path coverage is incomplete
- Consultation logging with restore/demo-restore workflows
- Crew, vessel, inventory, and settings management from UI
- Model parameters in Settings (temperature, top-p, top-k, token limits, etc.)

## Models

- `google/medgemma-1.5-4b-it`
- `google/medgemma-27b-text-it` (runtime adapter file: `medgemma27b.py`)

Both model paths are wired to use settings-defined sampling/token parameters.

## Quick Start

1. Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start the app:

```bash
chmod +x run_med_advisor.sh
./run_med_advisor.sh
```

4. Open:

- Local: `http://127.0.0.1:5000`
- LAN: `http://<your-machine-ip>:5000`

## Fresh Install On A New Computer (Contest Repro Path)

Use the installer script to set up and verify a new machine:

```bash
git clone https://github.com/rickeae/SailingMedAdvisor.git
cd SailingMedAdvisor
chmod +x scripts/install_fresh_copy.sh
./scripts/install_fresh_copy.sh --skip-clone
```

For full instructions and troubleshooting, see `docs/FRESH_INSTALL.md`.

You can re-run the deterministic installation verification at any time:

```bash
./.venv/bin/python scripts/verify_fresh_install.py
```

For a clean Ubuntu 24.04 environment, you can run the all-in-one bootstrap script:

```bash
chmod +x scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
./scripts/bootstrap_ubuntu24_sailingmedadvisor.sh
```

## Demo Reproduction (27B scenario)

For the Kaggle demo scenario, use the 27B model path in the UI:

1. Open `http://127.0.0.1:5000`.
2. In MedGemma Consultation, choose `Triage Consultation`.
3. Set model to `google/medgemma-27b-text-it`.
4. Enter the fish-hook cheek scenario used in the demo.
5. Select the matching clinical triage pathway values.
6. Submit and compare output structure against the demo video.

## Authentication Behavior

- If crew credentials are configured, login is required.
- If no credentials are configured yet, login is auto-admitted.

Credentials are managed from the app UI (Vessel & Crew / Settings flows).

## Data Storage

- Primary runtime data is stored in `app.db`.
- Default dataset JSONs live in `data/default/` and are used for baseline content and seeding support.

## Repository Layout (Primary)

```text
SailingMedAdvisor/
├── app.py
├── app.db
├── db_store.py
├── medgemma4.py
├── medgemma27b.py
├── medgemma_common.py
├── run_med_advisor.sh
├── requirements.txt
├── templates/
├── static/
├── scripts/
└── data/default/
```

## Operational Notes

- The startup script performs CUDA preflight when `FORCE_CUDA=1` (default).
- CPU fallback on CUDA runtime errors is disabled by default (`ALLOW_CPU_FALLBACK_ON_CUDA_ERROR=0`).
- If GPU is already occupied, the app surfaces a GPU-busy style failure message instead of silently switching devices.

## Medical Safety Note

This software is a decision-support aid for constrained/offshore scenarios.  
It is not a replacement for licensed medical professionals or emergency services.
