#!/usr/bin/env python3
# =============================================================================
# Author: Rick Escher
# Project: SilingMedAdvisor (SailingMedAdvisor)
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
Test actual model loading to GPU
"""
import os
os.environ.setdefault("TORCH_USE_CUDA_DSA", "0")
os.environ.setdefault("USE_FLASH_ATTENTION", "1")

import torch
print("=" * 70)
print("Testing Actual Model Loading")
print("=" * 70)

print(f"\n1. Device Detection:")
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"   device = {device}")
print(f"   torch.cuda.is_available() = {torch.cuda.is_available()}")

if torch.cuda.is_available():
    print(f"   GPU: {torch.cuda.get_device_name(0)}")
    print(f"   Initial GPU Memory: {torch.cuda.memory_allocated(0) / 1024**2:.2f} MB")

print(f"\n2. Testing Transformers Import:")
try:
    from transformers import AutoTokenizer, AutoModelForCausalLM
    print("   ✓ Transformers imported successfully")
except Exception as e:
    print(f"   ✗ Failed to import transformers: {e}")
    exit(1)

print(f"\n3. Testing Small Model Load (on {device}):")
try:
    # Use a tiny model for testing
    model_name = "gpt2"  # Very small model for quick test
    print(f"   Loading {model_name}...")
    
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    
    # Try to load with same settings as app.py
    dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else (torch.float16 if device == "cuda" else torch.float32)
    device_map = "auto" if device == "cuda" else None
    
    print(f"   dtype: {dtype}")
    print(f"   device_map: {device_map}")
    
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        device_map=device_map,
        low_cpu_mem_usage=True,
    )
    
    print(f"   ✓ Model loaded successfully")
    print(f"   Model device: {model.device}")
    
    if torch.cuda.is_available():
        print(f"   GPU Memory after load: {torch.cuda.memory_allocated(0) / 1024**2:.2f} MB")
    
    # Try a simple inference
    print(f"\n4. Testing Inference:")
    inputs = tokenizer("Hello, my name is", return_tensors="pt")
    
    # Move inputs to same device as model
    if device == "cuda":
        inputs = {k: v.cuda() for k, v in inputs.items()}
    
    print(f"   Input device: {inputs['input_ids'].device}")
    
    with torch.no_grad():
        outputs = model.generate(**inputs, max_new_tokens=5)
    
    result = tokenizer.decode(outputs[0])
    print(f"   ✓ Inference successful: '{result}'")
    
    if torch.cuda.is_available():
        print(f"   GPU Memory after inference: {torch.cuda.memory_allocated(0) / 1024**2:.2f} MB")
        print(f"\n   💡 Check nvidia-smi NOW - you should see GPU memory used!")
        input("   Press Enter to continue (this keeps GPU memory allocated)...")
    
except Exception as e:
    print(f"   ✗ Error: {e}")
    import traceback
    traceback.print_exc()

print("\n" + "=" * 70)
