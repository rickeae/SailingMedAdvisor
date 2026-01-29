#!/usr/bin/env python3
"""Debug actual inference path"""
import requests
import json

# Check what the API reports
print("1. Checking API status:")
resp = requests.get("http://127.0.0.1:5000/api/offline/check")
data = resp.json()

print(f"   Offline mode: {data.get('offline_mode')}")
print(f"   Cache dir: {data.get('cache_dir')}")
print(f"   Models cached:")
for m in data.get('models', []):
    status = "✓" if m['cached'] else "✗"
    print(f"      {status} {m['model']}")

# Check environment from the app's perspective
print("\n2. Checking app environment flags:")
env_flags = data.get('env', {})
for k, v in sorted(env_flags.items()):
    print(f"   {k}: {v}")

print("\n3. Attempting to decode why GPU not used...")
print("   Possible causes:")
print("   - DISABLE_LOCAL_INFERENCE might be True")
print("   - HF_REMOTE_TOKEN might be set (using remote API)")
print("   - Models loading to CPU instead of GPU")
print("   - device_map not working correctly")

# Try to trigger a simple test query and see response time
print("\n4. Check if you can see logs during query:")
print("   In terminal running server, watch for:")
print("   - 'Loading model...' or similar")
print("   - Any torch/transformers messages")
print("   - Error messages")
