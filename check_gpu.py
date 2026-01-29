#!/usr/bin/env python3
"""
GPU Detection Diagnostic Script
Run this to check if PyTorch can see your NVIDIA GPU
"""

import sys

print("=" * 60)
print("GPU Detection Diagnostic")
print("=" * 60)

# Check if torch is installed
try:
    import torch
    print(f"✓ PyTorch installed: {torch.__version__}")
except ImportError as e:
    print(f"✗ PyTorch not found: {e}")
    print("  Install with: pip install torch")
    sys.exit(1)

print()

# Check CUDA availability
print(f"CUDA available: {torch.cuda.is_available()}")
print(f"CUDA version (compiled): {torch.version.cuda}")

if torch.cuda.is_available():
    print(f"✓ GPU DETECTED!")
    print(f"  Number of GPUs: {torch.cuda.device_count()}")
    
    for i in range(torch.cuda.device_count()):
        print(f"\n  GPU {i}:")
        print(f"    Name: {torch.cuda.get_device_name(i)}")
        props = torch.cuda.get_device_properties(i)
        print(f"    Total memory: {props.total_memory / 1024**3:.2f} GB")
        print(f"    Compute capability: {props.major}.{props.minor}")
    
    # Test tensor creation
    try:
        test_tensor = torch.zeros(10, 10).cuda()
        print(f"\n✓ Successfully created tensor on GPU: {test_tensor.device}")
        del test_tensor
    except Exception as e:
        print(f"\n✗ Failed to create tensor on GPU: {e}")
else:
    print("✗ NO GPU DETECTED")
    print("\nPossible reasons:")
    print("  1. No NVIDIA GPU installed")
    print("  2. NVIDIA drivers not installed")
    print("  3. PyTorch installed without CUDA support")
    print("  4. CUDA toolkit version mismatch")
    
    print("\nTo install PyTorch with CUDA support:")
    print("  pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118")
    
    # Check for NVIDIA driver
    try:
        import subprocess
        result = subprocess.run(['nvidia-smi'], capture_output=True, text=True)
        if result.returncode == 0:
            print("\n✓ nvidia-smi found - NVIDIA driver is installed")
            print("\nNVIDIA Driver Info:")
            print(result.stdout)
        else:
            print("\n✗ nvidia-smi not found - NVIDIA driver may not be installed")
    except FileNotFoundError:
        print("\n✗ nvidia-smi not found - NVIDIA driver may not be installed")

print("\n" + "=" * 60)
