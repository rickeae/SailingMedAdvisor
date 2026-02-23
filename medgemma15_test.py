# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
import os
import argparse
import json
from pathlib import Path

# Force offline mode + make sure only GPU 0 is visible before torch import.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")

import torch

# --- GEMMA3 MASK PATCH (torch<2.6) ---
def _torch_version_ge(major: int, minor: int) -> bool:
    """
     Torch Version Ge helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    try:
        base = torch.__version__.split("+", 1)[0]
        parts = base.split(".")
        return (int(parts[0]), int(parts[1])) >= (major, minor)
    except Exception:
        return False

if not _torch_version_ge(2, 6):
    try:
        import transformers.models.gemma3.modeling_gemma3 as gemma_model
        _orig_create_causal_mask_mapping = gemma_model.create_causal_mask_mapping

        def _create_causal_mask_mapping_no_or(*args, **kwargs):
            # torch<2.6 can't use or_mask_function; ignore token_type_ids for text-only.
            """
             Create Causal Mask Mapping No Or helper.
            Detailed inline notes are included to support safe maintenance and future edits.
            """
            if len(args) >= 7:
                args = list(args)
                args[6] = None
            if "token_type_ids" in kwargs:
                kwargs = dict(kwargs)
                kwargs["token_type_ids"] = None
            return _orig_create_causal_mask_mapping(*args, **kwargs)

        gemma_model.create_causal_mask_mapping = _create_causal_mask_mapping_no_or
    except Exception:
        # If the import fails, let the main error surface later.
        pass
# -------------------------------------------------

from transformers import AutoTokenizer, AutoModelForCausalLM, AutoProcessor

def _safe_pad_token_id(tok):
    """
     Safe Pad Token Id helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    pad = getattr(tok, "pad_token_id", None)
    if pad is not None:
        return pad
    eos = getattr(tok, "eos_token_id", None)
    if isinstance(eos, (list, tuple)):
        return eos[0] if eos else None
    return eos

def _iter_cache_roots() -> list[Path]:
    """
     Iter Cache Roots helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    roots: list[Path] = []
    env_cache = os.environ.get("HUGGINGFACE_HUB_CACHE")
    if env_cache:
        roots.append(Path(env_cache))
    env_home = os.environ.get("HF_HOME")
    if env_home:
        roots.append(Path(env_home) / "hub")
    roots.append(Path("/mnt/modelcache/models_cache/hub"))
    roots.append(Path("/mnt/modelcache/hf_home/hub"))
    # De-dup while keeping order.
    seen = set()
    final: list[Path] = []
    for root in roots:
        if root in seen:
            continue
        seen.add(root)
        if root.is_dir():
            final.append(root)
    return final

def _snapshot_complete(snapshot: Path) -> bool:
    """
     Snapshot Complete helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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
    """
     Pick Latest Complete helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
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

def _resolve_snapshot(model_id: str, snapshot_override: str | None) -> str:
    """
     Resolve Snapshot helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if snapshot_override:
        override = Path(snapshot_override)
        # Accept either a snapshot path or the repo root containing "snapshots/".
        if (override / "snapshots").is_dir():
            return _pick_latest_complete(override / "snapshots", model_id)
        if override.is_dir() and _snapshot_complete(override):
            return str(override)
        return snapshot_override
    safe = model_id.replace("/", "--")
    snapshots: list[Path] = []
    for root in _iter_cache_roots():
        base = root / f"models--{safe}" / "snapshots"
        if not base.is_dir():
            continue
        snapshots.extend([d for d in base.iterdir() if d.is_dir()])
    if not snapshots:
        raise FileNotFoundError(
            f"No snapshots found for {model_id}. Checked: {', '.join(map(str, _iter_cache_roots()))}"
        )
    snapshots.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for snap in snapshots:
        if _snapshot_complete(snap):
            return str(snap)
    raise FileNotFoundError(
        f"Snapshots found for {model_id}, but weights are incomplete (.incomplete). "
        f"Checked: {', '.join(map(str, _iter_cache_roots()))}"
    )

if not torch.cuda.is_available():
    raise RuntimeError("CUDA not available. This script requires the RTX 5000 GPU.")

gpu_name = torch.cuda.get_device_name(0)
if "RTX 5000" not in gpu_name.upper():
    raise RuntimeError(f"Unexpected GPU detected: '{gpu_name}'. Expected RTX 5000.")
if not torch.cuda.is_bf16_supported():
    raise RuntimeError("bfloat16 not supported on this GPU/driver. This model is unstable in float16.")

def _pick_input_device(model) -> str:
    """
     Pick Input Device helper.
    Detailed inline notes are included to support safe maintenance and future edits.
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

def _normalize_device_map(device_map: str | dict) -> str | dict:
    """
     Normalize Device Map helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if isinstance(device_map, str):
        value = device_map.strip()
        if value in {"auto", "balanced", "balanced_low_0", "sequential"}:
            return value
        if value.startswith("cuda") or value.startswith("cpu"):
            return {"": value}
    return device_map

def _device_map_all_cuda(device_map: str | dict) -> bool:
    """
     Device Map All Cuda helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if isinstance(device_map, str):
        return device_map.strip().startswith("cuda")
    if isinstance(device_map, dict):
        return all(str(v).startswith("cuda") for v in device_map.values())
    return False

def _load_model(
    snapshot: str,
    quant4: bool,
    device_map: str | dict,
    max_memory: dict | None,
    cpu_offload: bool,
):
    """
     Load Model helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    model_kwargs = {
        "device_map": _normalize_device_map(device_map),
        "dtype": torch.bfloat16,
        "attn_implementation": "eager",
        "local_files_only": True,
        "low_cpu_mem_usage": True,
    }
    if max_memory:
        model_kwargs["max_memory"] = max_memory
    if quant4:
        try:
            from transformers import BitsAndBytesConfig
        except Exception as exc:
            raise RuntimeError(f"bitsandbytes not available for 4-bit load: {exc}")
        bnb_kwargs = dict(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
        )
        if cpu_offload or not _device_map_all_cuda(device_map):
            bnb_kwargs["llm_int8_enable_fp32_cpu_offload"] = True
        model_kwargs["quantization_config"] = BitsAndBytesConfig(**bnb_kwargs)
    model = AutoModelForCausalLM.from_pretrained(snapshot, **model_kwargs)
    tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
    try:
        processor = AutoProcessor.from_pretrained(snapshot, local_files_only=True)
    except Exception:
        processor = None
    model.eval()
    return model, tokenizer, processor

def _ensure_gpu_used(model) -> None:
    """
     Ensure Gpu Used helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    device_map = getattr(model, "hf_device_map", None) or {}
    if any(isinstance(v, str) and v.startswith("cuda") for v in device_map.values()):
        return
    for param in model.parameters():
        if param.device.type == "cuda":
            return
    raise RuntimeError("Model did not place any weights on CUDA. RTX 5000 usage is required.")

def ask(model, tokenizer, processor, text: str, max_new_tokens: int, raw_prompt: bool):
    """
    Ask helper.
    Detailed inline notes are included to support safe maintenance and future edits.
    """
    if raw_prompt:
        prompt = text
    else:
        # Use the model's chat template (<start_of_turn> ... <end_of_turn>)
        messages = [{"role": "user", "content": text}]
        prompt = tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=False,
        )
    if processor is not None:
        inputs = processor(text=prompt, return_tensors="pt")
        input_ids = inputs.get("input_ids")
    else:
        inputs = tokenizer(prompt, return_tensors="pt")
        input_ids = inputs.get("input_ids")
    input_device = _pick_input_device(model)
    inputs = {k: v.to(input_device) for k, v in inputs.items()}

    with torch.inference_mode():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=_safe_pad_token_id(tokenizer),
        )

    response = tokenizer.decode(out[0][input_ids.shape[-1]:], skip_special_tokens=True)
    return response.strip()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MedGemma local test runner")
    parser.add_argument("--model", choices=["4b", "27b"], default="4b", help="Select model size.")
    parser.add_argument("--model-id", default="", help="Override Hugging Face model id.")
    parser.add_argument("--snapshot", default="", help="Override snapshot path directly.")
    parser.add_argument("--max-new-tokens", type=int, default=600, help="Generation length.")
    parser.add_argument("--prompt", default="Explain first aid for a deep fishhook embedded in the cheek while at sea.")
    parser.add_argument("--quant4", action="store_true", help="Load model in 4-bit (recommended for 27B).")
    parser.add_argument("--device-map", default="", help="Override device_map (e.g. 'auto' or 'cuda:0').")
    parser.add_argument("--raw-prompt", action="store_true", help="Use raw prompt (no chat template).")
    parser.add_argument("--max-memory-gpu", default="15GiB", help="Max GPU memory for auto device_map.")
    parser.add_argument("--max-memory-cpu", default="64GiB", help="Max CPU memory for auto device_map.")
    parser.add_argument("--cpu-offload", action="store_true", help="Enable CPU offload for 4-bit quant.")
    args = parser.parse_args()

    model_id = args.model_id.strip() or (
        "google/medgemma-27b-text-it" if args.model == "27b" else "google/medgemma-1.5-4b-it"
    )
    snapshot = _resolve_snapshot(model_id, args.snapshot.strip() or None)
    if not os.path.isdir(snapshot):
        raise FileNotFoundError(f"Model snapshot not found at: {snapshot}")

    device_map = args.device_map.strip() or ("auto" if args.model == "27b" and not args.quant4 else "cuda:0")
    print(f"Loading {model_id} from snapshot: {snapshot}")
    print(f"device_map: {device_map}")
    if args.model == "27b" and not args.quant4 and device_map != "auto":
        print("Warning: 27B model typically needs --device-map auto or --quant4 on RTX 5000.")

    max_memory = None
    if torch.cuda.is_available() and not _device_map_all_cuda(device_map):
        max_memory = {0: args.max_memory_gpu, "cpu": args.max_memory_cpu}
    model, tokenizer, processor = _load_model(
        snapshot,
        args.quant4,
        device_map,
        max_memory,
        args.cpu_offload,
    )
    _ensure_gpu_used(model)
    query = args.prompt
    print(f"\nQUERY: {query}")

    try:
        response = ask(model, tokenizer, processor, query, args.max_new_tokens, args.raw_prompt)
        if not response:
            print("\nRESPONSE: [Still blank. Attempting fallback...]")
        else:
            print(f"\nRESPONSE:\n{'-'*30}\n{response}\n{'-'*30}")
    except Exception as e:
        print(f"\nERROR: {e}")
