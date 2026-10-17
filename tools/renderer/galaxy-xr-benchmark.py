#!/usr/bin/env python3
"""Run and measure SceneCore spatial renderer benchmarks on the physical Galaxy XR headset.

Captures real-hardware measurements:
- 32,768 and 2,000,000 facet fixture load times, synchronous submission latencies, and payload sizes
- Subspace and MeshEntity allocations
- Sample paint chunk replacement latencies and bytes
- Split engine and CPM status
- Device memory (PSS, Native Heap, Graphics)
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "tools/renderer/results"
DEFAULT_SERIAL = "adb-R3GYB0AQXWE-nYV2BD._adb-tls-connect._tcp"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", default=DEFAULT_SERIAL, help="ADB target serial")
parser.add_argument("--timeout", type=int, default=180, help="Overall benchmark timeout in seconds")
args = parser.parse_args()

OUTPUT.mkdir(parents=True, exist_ok=True)
serial = args.serial

def adb(*cmd, timeout=30):
    return subprocess.check_output(["adb", "-s", serial, *cmd], text=True, timeout=timeout).strip()

def check_device():
    devices = subprocess.check_output(["adb", "devices"], text=True)
    if serial not in devices:
        sys.exit(f"Device {serial} not found in adb devices:\n{devices}")
    model = adb("shell", "getprop", "ro.product.model")
    name = adb("shell", "getprop", "ro.product.name")
    print(f"Target device: {model} ({name}) serial={serial}")

def is_awake():
    power = adb("shell", "dumpsys", "power")
    for line in power.splitlines():
        if "mWakefulness=" in line:
            return "Awake" in line
    return False

def is_unlocked():
    trust = adb("shell", "dumpsys", "trust")
    return "deviceLocked=0" in trust

def wait_for_awake(timeout=60):
    print("Checking headset wakefulness...")
    if is_awake():
        print("Headset is awake.")
        return True
    print("Headset is asleep (proximity sensor detected doff).")
    print("Please put on the headset or cover the proximity sensor between the lenses...")
    start = time.time()
    while time.time() - start < timeout:
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        time.sleep(1)
        if is_awake():
            print("Headset is now awake!")
            return True
    return False

def wait_for_unlocked(timeout=120):
    print("Checking device lock state...")
    if is_unlocked():
        print("Device is unlocked.")
        return True
    print("Device is locked (deviceLocked=1).")
    print("Please unlock the headset with your PIN, pattern, or iris unlock...")
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(1)
        if is_unlocked():
            print("Device unlocked successfully!")
            return True
    return False

def run_benchmark():
    check_device()
    if not wait_for_awake(args.timeout):
        print("Timed out waiting for headset to wake up.", file=sys.stderr)
        sys.exit(1)
    if not wait_for_unlocked(args.timeout):
        print("Timed out waiting for headset to be unlocked.", file=sys.stderr)
        sys.exit(1)

    print("Clearing logcat...")
    adb("logcat", "-c")

    print("Launching SceneCoreExperimentActivity with auto_benchmark=true...")
    adb("shell", "am", "start", "-n", "dev.orcaxr.xrexperiment/.SceneCoreExperimentActivity",
        "--ez", "auto_benchmark", "true")

    # Give activity a moment to start and trigger broadcast as backup
    time.sleep(2)
    adb("shell", "am", "broadcast", "-a", "dev.orcaxr.xrexperiment.ACTION_RUN_BENCHMARK")

    print("Monitoring logcat for benchmark metrics...")
    proc = subprocess.Popen(
        ["adb", "-s", serial, "logcat", "-v", "time", "-s", "SceneCoreBenchmark:I", "SceneCoreViewport:I"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )

    metrics = {}
    lines_captured = []
    start_time = time.time()
    deadline = start_time + args.timeout

    try:
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                time.sleep(0.1)
                continue
            line = line.strip()
            lines_captured.append(line)
            print(f"  {line}")

            if "[METRIC 32K_LOAD]" in line:
                metrics["32k_load"] = line.split("[METRIC 32K_LOAD]")[1].strip()
            elif "[METRIC INSTANCES]" in line:
                metrics["instances"] = line.split("[METRIC INSTANCES]")[1].strip()
            elif "[METRIC 32K_PAINT]" in line:
                metrics["32k_paint"] = line.split("[METRIC 32K_PAINT]")[1].strip()
            elif "[METRIC 2M_LOAD]" in line:
                metrics["2m_load"] = line.split("[METRIC 2M_LOAD]")[1].strip()
            elif "[METRIC 2M_PAINT]" in line:
                metrics["2m_paint"] = line.split("[METRIC 2M_PAINT]")[1].strip()
            elif "=== SCENECORE BENCHMARK SUITE COMPLETE ===" in line:
                print("Benchmark completed successfully!")
                break
            elif "FAILED:" in line:
                print(f"Benchmark reported failure: {line}", file=sys.stderr)
                break
    finally:
        proc.terminate()

    # Capture system dumps
    print("Collecting memory and split engine dumps...")
    meminfo = adb("shell", "dumpsys", "meminfo", "dev.orcaxr.xrexperiment")
    spf = adb("shell", "dumpsys", "spf_renderbridge")

    report = {
        "device": {
            "serial": serial,
            "model": adb("shell", "getprop", "ro.product.model"),
            "fingerprint": adb("shell", "getprop", "ro.build.fingerprint")
        },
        "metrics": metrics,
        "log": lines_captured,
        "split_engine": spf,
        "meminfo_summary": [l.strip() for l in meminfo.splitlines() if "TOTAL" in l or "Native Heap" in l or "Graphics" in l]
    }

    report_path = OUTPUT / "galaxy-xr-scenecore-report.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"\nReport written to {report_path}")
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    run_benchmark()
