#!/usr/bin/env python3
# =============================================================================
# Author: Rick Escher
# Project: SailingMedAdvisor
# Context: Google HAI-DEF Framework
# Models: Google MedGemmas
# Program: Kaggle Impact Challenge
# =============================================================================
"""Test if models load from external cache"""
import os
from pathlib import Path

# Simulate app startup
EXTERNAL_CACHE = Path("/mnt/modelcache/models_cache")
if EXTERNAL_CACHE.exists():
    os.environ["HF_HOME"] = str(EXTERNAL_CACHE)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(EXTERNAL_CACHE / "hub")
    print(f"✓ Set HF_HOME to: {EXTERNAL_CACHE}")
else:
    print(f"✗ External cache not found!")
    exit(1)

import torch
from transformers import AutoConfig

print(f"\n1. Checking GPU:")
print(f"   CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"   GPU: {torch.cuda.get_device_name(0)}")

print(f"\n2. Testing model cache detection:")
model_name = "google/medgemma-1.5-4b-it"
safe = model_name.replace("/", "--")
cache_path = EXTERNAL_CACHE / "hub" / f"models--{safe}"

if cache_path.exists():
    print(f"   ✓ Model cache exists: {cache_path}")
    
    # Check snapshots
    snap_dir = cache_path / "snapshots"
    if snap_dir.exists():
        snapshots = list(snap_dir.iterdir())
        print(f"   ✓ Found {len(snapshots)} snapshot(s)")
        
        # Check latest snapshot
        latest = max(snapshots, key=lambda p: p.stat().st_mtime)
        print(f"   Latest: {latest.name}")
        
        # Check for required files
        required = ["config.json", "model.safetensors.index.json"]
        for req in required:
            if (latest / req).exists():
                print(f"   ✓ {req} present")
            else:
                print(f"   ✗ {req} MISSING")
        
        # Try to load config
        print(f"\n3. Attempting config load:")
        try:
            config = AutoConfig.from_pretrained(
                model_name,
                cache_dir=str(EXTERNAL_CACHE / "hub"),
                local_files_only=True
            )
            print(f"   ✓ Config loaded successfully!")
            print(f"   Model type: {config.model_type}")
        except Exception as e:
            print(f"   ✗ Config load failed: {e}")
    else:
        print(f"   ✗ Snapshots directory missing!")
else:
    print(f"   ✗ Model cache NOT found at {cache_path}")

print("\n" + "="*60)
