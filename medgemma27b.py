# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
MedGemma 27B inference runner.

Design intent:
- Use 4-bit quantization to fit 27B inference on constrained edge hardware.
- Support automatic and manual layer placement across GPU/CPU.
- Reuse loaded model when snapshot/load signature is unchanged to reduce
  repeated load latency and VRAM fragmentation.
"""

from __future__ import annotations

from typing import Any, Dict

import os
import gc

import torch
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

from medgemma_common import (
    cap_new_tokens,
    normalize_device_map,
    pick_input_device,
    resolve_model_max_length,
    resolve_snapshot,
    safe_pad_token_id,
)

MODEL_ID = "google/medgemma-27b-text-it"

_MODEL = None
_TOKENIZER = None
_ACTIVE_SNAPSHOT = None
_ACTIVE_LOAD_SIGNATURE = None


def _default_dtype() -> torch.dtype:
    """Select default compute dtype with BF16 preference when available."""
    if os.environ.get("FORCE_FP16", "").strip() == "1":
        return torch.float16
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    if torch.cuda.is_available():
        return torch.float16
    return torch.float32


def _load_quant_config() -> Any:
    """Build BitsAndBytes 4-bit configuration for 27B local inference."""
    try:
        from transformers import BitsAndBytesConfig
    except Exception as exc:
        raise RuntimeError(f"bitsandbytes not available for 4-bit load: {exc}")
    bnb_compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=bnb_compute_dtype,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
        llm_int8_enable_fp32_cpu_offload=True,
    )


def _resolve_num_layers(config_obj: Any) -> int:
    """Extract layer count from model config with safe fallback."""
    if config_obj is None:
        return 62
    val = getattr(config_obj, "num_hidden_layers", None)
    if isinstance(val, int) and val > 0:
        return val
    text_cfg = getattr(config_obj, "text_config", None)
    val = getattr(text_cfg, "num_hidden_layers", None)
    if isinstance(val, int) and val > 0:
        return val
    return 62


def _manual_device_map(num_layers: int, gpu_layers: int) -> Dict[str, str]:
    """
    Create deterministic layer placement for mixed GPU/CPU execution.

    The first `gpu_layers` transformer blocks stay on GPU; remaining layers
    plus final norm/head are offloaded to CPU.
    """
    gpu_layers = max(0, min(int(gpu_layers), int(num_layers)))
    dm: Dict[str, str] = {
        "model.embed_tokens": "cuda:0",
        "model.rotary_emb": "cuda:0",
        "model.norm": "cpu",
        "lm_head": "cpu",
    }
    for i in range(int(num_layers)):
        dm[f"model.layers.{i}"] = "cuda:0" if i < gpu_layers else "cpu"
    return dm


def _resolve_device_map_for_27b(
    device_map: str | dict,
    *,
    resolved_snapshot: str,
    local_files_only: bool,
) -> str | Dict[str, str]:
    """Normalize configured device map into a concrete mapping."""
    if isinstance(device_map, dict):
        return normalize_device_map(device_map)
    if not isinstance(device_map, str):
        return normalize_device_map(device_map)
    value = device_map.strip()
    mode = value.lower()
    if mode.startswith("manual"):
        config_obj = AutoConfig.from_pretrained(resolved_snapshot, local_files_only=local_files_only)
        num_layers = _resolve_num_layers(config_obj)
        gpu_layers = int(os.environ.get("MODEL_GPU_LAYERS_27B", "14"))
        if ":" in mode:
            try:
                gpu_layers = int(mode.split(":", 1)[1].strip())
            except Exception:
                pass
        return _manual_device_map(num_layers, gpu_layers)
    return normalize_device_map(value)


def load_model(
    *,
    snapshot: str | None = None,
    device_map: str | dict = "auto",
    dtype: torch.dtype | None = None,
    max_memory: Dict[str, str] | None = None,
    local_files_only: bool = True,
) -> tuple[Any, Any]:
    """
    Load/reuse 27B model and tokenizer.

    Reload triggers:
    - Snapshot changed
    - Device map changed
    - Dtype changed
    - Max-memory map changed
    """
    global _MODEL, _TOKENIZER, _ACTIVE_SNAPSHOT, _ACTIVE_LOAD_SIGNATURE
    if dtype is None:
        dtype = _default_dtype()
    resolved = resolve_snapshot(MODEL_ID, snapshot)
    normalized_device_map = _resolve_device_map_for_27b(
        device_map,
        resolved_snapshot=resolved,
        local_files_only=local_files_only,
    )
    memory_sig = tuple(sorted((max_memory or {}).items(), key=lambda kv: str(kv[0])))
    load_sig = (str(dtype), str(normalized_device_map), memory_sig)
    if (
        _MODEL is not None
        and _TOKENIZER is not None
        and _ACTIVE_SNAPSHOT == resolved
        and _ACTIVE_LOAD_SIGNATURE == load_sig
    ):
        return _MODEL, _TOKENIZER
    if _MODEL is not None or _TOKENIZER is not None:
        unload_model()

    quant_config = _load_quant_config()
    attn_impl = (os.environ.get("MODEL_ATTN_IMPL_27B", "eager") or "").strip() or "eager"
    model_kwargs: Dict[str, Any] = {
        "torch_dtype": dtype,
        "device_map": normalized_device_map,
        "local_files_only": local_files_only,
        "low_cpu_mem_usage": True,
        "quantization_config": quant_config,
        "offload_folder": os.environ.get("MODEL_OFFLOAD_DIR", "offload"),
        # Avoid flash/SDPA kernel selection issues on older GPUs/offload mixes.
        "attn_implementation": attn_impl,
    }
    if max_memory:
        model_kwargs["max_memory"] = max_memory

    _TOKENIZER = AutoTokenizer.from_pretrained(resolved, use_fast=True, local_files_only=local_files_only)
    _MODEL = AutoModelForCausalLM.from_pretrained(resolved, **model_kwargs)
    _MODEL.eval()
    _ACTIVE_SNAPSHOT = resolved
    _ACTIVE_LOAD_SIGNATURE = load_sig
    return _MODEL, _TOKENIZER


def unload_model() -> None:
    """Release 27B references and request CUDA cache cleanup."""
    global _MODEL, _TOKENIZER, _ACTIVE_SNAPSHOT, _ACTIVE_LOAD_SIGNATURE
    _MODEL = None
    _TOKENIZER = None
    _ACTIVE_SNAPSHOT = None
    _ACTIVE_LOAD_SIGNATURE = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def generate(
    prompt: str,
    cfg: Dict[str, Any],
    *,
    snapshot: str | None = None,
    device_map: str | dict = "auto",
    max_memory: Dict[str, str] | None = None,
) -> str:
    """
    Generate one assistant response with context-length and token safeguards.

    This path caps input tokens for VRAM stability, then caps output tokens
    against remaining model context budget.
    """
    model, tokenizer = load_model(snapshot=snapshot, device_map=device_map, max_memory=max_memory)

    # Keep prompt construction aligned with instruction chat fine-tuning.
    messages = [{"role": "user", "content": prompt}]
    prompt_text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
    inputs = tokenizer(prompt_text, return_tensors="pt")
    # Keep context bounded for 27B to control KV-cache VRAM on 16GB GPUs.
    try:
        max_input_tokens = int(os.environ.get("MODEL_MAX_INPUT_TOKENS_27B", "2048"))
    except Exception:
        max_input_tokens = 2048
    input_ids = inputs.get("input_ids")
    if (
        max_input_tokens > 0
        and input_ids is not None
        and input_ids.shape[-1] > max_input_tokens
    ):
        start = input_ids.shape[-1] - max_input_tokens
        for key in ("input_ids", "attention_mask"):
            if key in inputs and inputs[key] is not None and inputs[key].shape[-1] > max_input_tokens:
                inputs[key] = inputs[key][:, start:]
        input_ids = inputs.get("input_ids")
    input_device = pick_input_device(model)
    inputs = {k: v.to(input_device) for k, v in inputs.items()}

    # Preserve prompt token count so decode excludes the original prompt.
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
