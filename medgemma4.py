# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
MedGemma 4B inference runner.

Design intent:
- Keep 4B loading fast and deterministic for triage-first workflows.
- Reuse one model/tokenizer instance per active snapshot to avoid repeated
  GPU allocation churn between requests.
- Apply safety caps from runtime config before generation so user-provided
  token settings cannot exceed model context limits.
"""

from __future__ import annotations

from typing import Any, Dict

import os
import gc

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from medgemma_common import (
    cap_new_tokens,
    pick_input_device,
    resolve_model_max_length,
    resolve_snapshot,
    safe_pad_token_id,
)

MODEL_ID = "google/medgemma-1.5-4b-it"

_MODEL = None
_TOKENIZER = None
_ACTIVE_SNAPSHOT = None


def _default_dtype() -> torch.dtype:
    """Select a stable default dtype based on runtime hardware and flags."""
    if os.environ.get("FORCE_FP16", "").strip() == "1":
        return torch.float16
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    if torch.cuda.is_available():
        return torch.float16
    return torch.float32


def load_model(
    *,
    snapshot: str | None = None,
    device_map: str | dict = "cuda:0",
    dtype: torch.dtype | None = None,
    attn_implementation: str | None = "eager",
    local_files_only: bool = True,
) -> tuple[Any, Any]:
    """
    Load or reuse the 4B model.

    Reuse strategy:
    - If snapshot path matches `_ACTIVE_SNAPSHOT`, return cached objects.
    - Otherwise load tokenizer/model once and pin as active snapshot.
    """
    global _MODEL, _TOKENIZER, _ACTIVE_SNAPSHOT
    if dtype is None:
        dtype = _default_dtype()
    resolved = resolve_snapshot(MODEL_ID, snapshot)
    if _MODEL is not None and _TOKENIZER is not None and _ACTIVE_SNAPSHOT == resolved:
        return _MODEL, _TOKENIZER

    model_kwargs: Dict[str, Any] = {
        "torch_dtype": dtype,
        "device_map": device_map,
        "local_files_only": local_files_only,
        "low_cpu_mem_usage": True,
    }
    if attn_implementation:
        model_kwargs["attn_implementation"] = attn_implementation

    _TOKENIZER = AutoTokenizer.from_pretrained(resolved, use_fast=True, local_files_only=local_files_only)
    _MODEL = AutoModelForCausalLM.from_pretrained(resolved, **model_kwargs)
    _MODEL.eval()
    _ACTIVE_SNAPSHOT = resolved
    return _MODEL, _TOKENIZER


def unload_model() -> None:
    """Release model/tokenizer references and clear CUDA cache when present."""
    global _MODEL, _TOKENIZER, _ACTIVE_SNAPSHOT
    _MODEL = None
    _TOKENIZER = None
    _ACTIVE_SNAPSHOT = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def generate(prompt: str, cfg: Dict[str, Any], *, snapshot: str | None = None, device_map: str | dict = "cuda:0") -> str:
    """
    Generate one assistant response using chat-template formatting.

    `cfg` keys consumed:
    - `tk`: max new tokens target
    - `t`: temperature
    - `p`: top-p
    - `k`: top-k
    - `rep_penalty`: repetition penalty
    """
    model, tokenizer = load_model(snapshot=snapshot, device_map=device_map)

    # Use the tokenizer's chat template to keep prompt framing aligned with
    # the instruction-tuned MedGemma 4B format.
    messages = [{"role": "user", "content": prompt}]
    prompt_text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
    inputs = tokenizer(prompt_text, return_tensors="pt")
    input_ids = inputs.get("input_ids")
    input_device = pick_input_device(model)
    inputs = {k: v.to(input_device) for k, v in inputs.items()}

    # Preserve prompt token length so we only decode newly generated tokens.
    input_len = input_ids.shape[-1] if input_ids is not None else inputs["input_ids"].shape[-1]
    model_max_len = resolve_model_max_length(model, tokenizer)
    max_new_tokens = cap_new_tokens(cfg.get("tk"), input_len, model_max_len)

    with torch.inference_mode():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=cfg.get("t"),
            top_p=cfg.get("p"),
            top_k=cfg.get("k"),
            repetition_penalty=cfg.get("rep_penalty", 1.1),
            do_sample=(cfg.get("t", 0) > 0),
            pad_token_id=safe_pad_token_id(tokenizer),
        )

    response = tokenizer.decode(out[0][input_len:], skip_special_tokens=True)
    return response.strip()
