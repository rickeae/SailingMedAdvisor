#!/usr/bin/env bash
# =============================================================================
# Author: Rick Escher
# Project: SilingMedAdvisor (SailingMedAdvisor)
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
set -euo pipefail

# Copy only pharmaceuticals (type == "medication") from one workspace to another.
# Equipment and consumables in the destination are preserved.

SRC_WORKSPACE="${SRC_WORKSPACE:-Lorraine}"
DEST_WORKSPACE="${DEST_WORKSPACE:-Rick}"
APP_HOME="${APP_HOME:-/home/user/app}"

slug() {
  echo "${1:-}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

SRC_SLUG=$(slug "$SRC_WORKSPACE")
DEST_SLUG=$(slug "$DEST_WORKSPACE")

DATA_BASE="$APP_HOME/data"
UPLOAD_BASE="$APP_HOME/uploads"

SRC_INV="$DATA_BASE/$SRC_SLUG/inventory.json"
DEST_INV="$DATA_BASE/$DEST_SLUG/inventory.json"

if [[ ! -f "$SRC_INV" ]]; then
  echo "Source inventory not found: $SRC_INV" >&2
  exit 1
fi
if [[ ! -f "$DEST_INV" ]]; then
  echo "Destination inventory not found: $DEST_INV" >&2
  exit 1
fi

backup="$DEST_INV.bak.$(date +%s)"
if ! cp "$DEST_INV" "$backup" 2>/dev/null; then
  echo "Unable to create backup at $backup. Check permissions (maybe the data dir is read-only)." >&2
  exit 1
fi

jq -s '
  def norm: ( .type // "" ) | ascii_downcase;
  (.[0] // []) as $dest
  | (.[1] // []) as $src
  | ($dest | map(select(norm != "medication"))) as $dest_keep
  | ($src  | map(select(norm == "medication"))) as $src_meds
  | $dest_keep + $src_meds
' "$DEST_INV" "$SRC_INV" > "${DEST_INV}.tmp"
mv "${DEST_INV}.tmp" "$DEST_INV"

SRC_PHOTOS="$UPLOAD_BASE/$SRC_SLUG/medicines"
DEST_PHOTOS="$UPLOAD_BASE/$DEST_SLUG/medicines"
if [[ -d "$SRC_PHOTOS" ]]; then
  mkdir -p "$DEST_PHOTOS"
  rsync -av "$SRC_PHOTOS/" "$DEST_PHOTOS/"
else
  echo "No medicine photos found at $SRC_PHOTOS (skipping photos copy)"
fi

echo "Done. Backed up: $backup"
