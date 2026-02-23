#!/usr/bin/env bash
# =============================================================================
# Author: Rick Escher
# Project: SilingMedAdvisor (SailingMedAdvisor)
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
set -euo pipefail

# Copy only pharmaceuticals from Lorraine to Rick without jq.
# Heuristic: anything not explicitly consumable/equipment/durable is treated as medication.
# Requires python3 (available) for JSON manipulation; avoids sudo.

SRC_WORKSPACE="${SRC_WORKSPACE:-Lorraine}"
DEST_WORKSPACE="${DEST_WORKSPACE:-Rick}"
APP_HOME="${APP_HOME:-/home/user/app}"

slug() {
  echo "${1:-}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

SRC_SLUG=$(slug "$SRC_WORKSPACE")
DEST_SLUG=$(slug "$DEST_WORKSPACE")

SRC_INV="$APP_HOME/data/$SRC_SLUG/inventory.json"
DEST_INV="$APP_HOME/data/$DEST_SLUG/inventory.json"

if [[ ! -f "$SRC_INV" ]]; then
  echo "Source inventory not found: $SRC_INV" >&2
  exit 1
fi
if [[ ! -f "$DEST_INV" ]]; then
  echo "Destination inventory not found: $DEST_INV" >&2
  exit 1
fi

backup="$DEST_INV.bak.$(date +%s)"
cp "$DEST_INV" "$backup"

python3 - <<PY
import json
from pathlib import Path

src = Path("$SRC_INV").read_text()
dest = Path("$DEST_INV").read_text()
try:
    src_data = json.loads(src)
    dest_data = json.loads(dest)
except Exception as e:
    raise SystemExit(f"JSON parse error: {e}")

def norm_type(item):
    return (item.get("type") or "").strip().lower()

keep_types = {"consumable", "equipment", "durable"}
dest_keep = [x for x in dest_data if norm_type(x) in keep_types]
src_meds = [x for x in src_data if norm_type(x) not in keep_types]

merged = dest_keep + src_meds
Path("$DEST_INV").write_text(json.dumps(merged, indent=2))
PY

SRC_PH="$APP_HOME/uploads/$SRC_SLUG/medicines"
DEST_PH="$APP_HOME/uploads/$DEST_SLUG/medicines"
if [[ -d "$SRC_PH" ]]; then
  mkdir -p "$DEST_PH"
  cp -a "$SRC_PH/." "$DEST_PH/"
else
  echo "No medicine photos found at $SRC_PH (skipping photos copy)"
fi

echo "Done. Backup created at $backup"
