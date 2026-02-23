# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
Shared helpers for MedGemma inference runners.

This module centralizes shared safeguards used by both 4B and 27B runners:
- Resolving a complete local snapshot from HF cache roots
- Guarding token lengths against model context limits
- Selecting stable padding and input device behavior across device maps
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, List

import torch


def safe_pad_token_id(tok):
    """Return a usable pad token ID fallback for generation APIs."""
    pad = getattr(tok, "pad_token_id", None)
    if pad is not None:
        return pad
    eos = getattr(tok, "eos_token_id", None)
    if isinstance(eos, (list, tuple)):
        return eos[0] if eos else None
    return eos


def iter_cache_roots() -> List[Path]:
    """Yield known HuggingFace cache roots, deduplicated and existing only."""
    roots: List[Path] = []
    env_cache = os.environ.get("HUGGINGFACE_HUB_CACHE")
    if env_cache:
        roots.append(Path(env_cache))
    env_home = os.environ.get("HF_HOME")
    if env_home:
        roots.append(Path(env_home) / "hub")
    roots.append(Path("/mnt/modelcache/models_cache/hub"))
    roots.append(Path("/mnt/modelcache/hf_home/hub"))
    seen = set()
    final: List[Path] = []
    for root in roots:
        if root in seen:
            continue
        seen.add(root)
        if root.is_dir():
            final.append(root)
    return final


def _snapshot_complete(snapshot: Path) -> bool:
    """Validate that a snapshot directory has complete safetensor files."""
    index = snapshot / "model.safetensors.index.json"
    if index.exists():
        try:
            data = json.loads(index.read_text())
        except Exception:
            return False
        weight_map = data.get("weight_map") or {}
        files = set(weight_map.values())
        if not files:
            return False
        for name in files:
            f = snapshot / name
            if not f.exists():
                return False
            target = f.resolve()
            if str(target).endswith(".incomplete"):
                return False
        return True
    single = snapshot / "model.safetensors"
    if single.exists():
        target = single.resolve()
        return not str(target).endswith(".incomplete")
    return False


def _pick_latest_complete(snapshot_dir: Path, model_id: str) -> str:
    """Pick newest snapshot that passes completeness checks."""
    if not snapshot_dir.is_dir():
        raise FileNotFoundError(f"Snapshot dir not found for {model_id}: {snapshot_dir}")
    snapshots = [d for d in snapshot_dir.iterdir() if d.is_dir()]
    if not snapshots:
        raise FileNotFoundError(f"No snapshots found for {model_id} in: {snapshot_dir}")
    snapshots.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for snap in snapshots:
        if _snapshot_complete(snap):
            return str(snap)
    raise FileNotFoundError(
        f"Snapshots found for {model_id}, but weights are incomplete (.incomplete). "
        f"Checked: {snapshot_dir}"
    )


def resolve_snapshot(model_id: str, snapshot_override: str | None = None) -> str:
    """
    Resolve a concrete snapshot path for local model loading.

    Preference order:
    1) Caller override path (direct snapshot or `.../snapshots`)
    2) Latest complete snapshot from known cache roots
    """
    if snapshot_override:
        override = Path(snapshot_override)
        if (override / "snapshots").is_dir():
            return _pick_latest_complete(override / "snapshots", model_id)
        if override.is_dir() and _snapshot_complete(override):
            return str(override)
        return snapshot_override
    safe = model_id.replace("/", "--")
    snapshots: List[Path] = []
    for root in iter_cache_roots():
        base = root / f"models--{safe}" / "snapshots"
        if not base.is_dir():
            continue
        snapshots.extend([d for d in base.iterdir() if d.is_dir()])
    if not snapshots:
        raise FileNotFoundError(
            f"No snapshots found for {model_id}. Checked: {', '.join(map(str, iter_cache_roots()))}"
        )
    snapshots.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for snap in snapshots:
        if _snapshot_complete(snap):
            return str(snap)
    raise FileNotFoundError(
        f"Snapshots found for {model_id}, but weights are incomplete (.incomplete). "
        f"Checked: {', '.join(map(str, iter_cache_roots()))}"
    )


def resolve_model_max_length(model, tok=None):
    """Infer effective model context length from config/tokenizer metadata."""
    cfg = getattr(model, "config", None)
    candidates: List[int] = []
    if cfg is not None:
        for attr in ("max_position_embeddings", "max_seq_len", "max_sequence_length", "n_positions"):
            val = getattr(cfg, attr, None)
            if isinstance(val, int) and val > 0:
                candidates.append(val)
        text_cfg = getattr(cfg, "text_config", None)
        if text_cfg is not None:
            for attr in ("max_position_embeddings", "max_seq_len", "max_sequence_length", "n_positions"):
                val = getattr(text_cfg, attr, None)
                if isinstance(val, int) and val > 0:
                    candidates.append(val)
    if tok is not None:
        tok_max = getattr(tok, "model_max_length", None)
        if isinstance(tok_max, int) and 0 < tok_max < 1_000_000_000:
            candidates.append(tok_max)
    return min(candidates) if candidates else None


def cap_new_tokens(max_new_tokens, input_len: int, model_max_len: int | None):
    """Clamp requested output tokens so prompt+response stay within context."""
    if not isinstance(max_new_tokens, int):
        return max_new_tokens
    if model_max_len is None:
        return max_new_tokens
    if input_len >= model_max_len:
        return 1
    max_allowed = max(model_max_len - input_len - 1, 1)
    return min(max_new_tokens, max_allowed)


def pick_input_device(model) -> str:
    """
    Choose where prompt tensors should be placed before generation.

    For partitioned/offloaded models, this prefers embedding-layer device.
    """
    if hasattr(model, "hf_device_map"):
        device_map = getattr(model, "hf_device_map") or {}
        preferred = None
        for name, dev in device_map.items():
            if isinstance(dev, str) and dev.startswith("cuda"):
                if "embed" in name:
                    return dev
                preferred = dev
        if preferred:
            return preferred
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def normalize_device_map(device_map: str | Dict[str, str]):
    """Normalize common string forms into transformers-compatible device maps."""
    if isinstance(device_map, str):
        value = device_map.strip()
        if value in {"auto", "balanced", "balanced_low_0", "sequential"}:
            return value
        if value.startswith("cuda") or value.startswith("cpu"):
            return {"": value}
    return device_map


def device_map_all_cuda(device_map: str | Dict[str, str]) -> bool:
    """Return True when all mapped targets point to CUDA devices."""
    if isinstance(device_map, str):
        return device_map.strip().startswith("cuda")
    if isinstance(device_map, dict):
        return all(str(v).startswith("cuda") for v in device_map.values())
    return False
