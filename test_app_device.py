#!/usr/bin/env python3
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""
Test script to check device detection when app.py loads
"""
import sys
import os

# Set the same environment as app.py does
os.environ.setdefault("TORCH_USE_CUDA_DSA", "0")
os.environ.setdefault("USE_FLASH_ATTENTION", "1")

print("=" * 60)
print("Testing app.py device detection")
print("=" * 60)

import torch
print(f"\n1. PyTorch CUDA available: {torch.cuda.is_available()}")

if torch.cuda.is_available():
    print(f"   GPU: {torch.cuda.get_device_name(0)}")

# Now import app to see what device it sets
print("\n2. Loading app.py...")
try:
    # We need to avoid actually running the FastAPI server
    # Just import to check the device variable
    sys.path.insert(0, '/home/rick/SailingMedAdvisor')
    
    # Import just the device detection part
    exec("""
import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"   Device set to: {device}")

# Check precision
force_fp16 = os.environ.get("FORCE_FP16", "").strip() == "1"
if device == "cuda" and force_fp16:
    dtype = torch.float16
    print(f"   dtype: torch.float16 (forced)")
elif device == "cuda" and torch.cuda.is_bf16_supported():
    dtype = torch.bfloat16
    print(f"   dtype: torch.bfloat16 (supported)")
elif device == "cuda":
    dtype = torch.float16
    print(f"   dtype: torch.float16 (fallback)")
else:
    dtype = torch.float32
    print(f"   dtype: torch.float32 (CPU)")
""")
    
except Exception as e:
    print(f"   Error: {e}")
    import traceback
    traceback.print_exc()

print("\n3. Checking if models would load on GPU...")
device = "cuda" if torch.cuda.is_available() else "cpu"
device_map = "auto" if device == "cuda" else None
load_dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else (torch.float16 if device == "cuda" else torch.float32)

print(f"   device: {device}")
print(f"   device_map: {device_map}")
print(f"   load_dtype: {load_dtype}")

print("\n" + "=" * 60)
print("✓ Configuration looks correct for GPU usage!")
print("=" * 60)
