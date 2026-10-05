#!/usr/bin/env python3
"""Own a fresh non-XR emulator for JNI, startup, pixels, and renderer lifetimes.

The output is software-renderer evidence, never physical-device qualification.
Build app/core instrumentation APKs before running. No physical device is used.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SDK = Path(os.environ["ANDROID_HOME"])
OUTPUT = ROOT / "tools/renderer/results"
SERIAL = "emulator-5582"
OUTPUT.mkdir(parents=True, exist_ok=True)
if SERIAL in subprocess.check_output(["adb", "devices"], text=True):
    raise SystemExit(f"{SERIAL} is already owned; refusing to reuse it")


def adb(*arguments, timeout=120):
    return subprocess.check_output(["adb", "-s", SERIAL, *arguments], text=True, timeout=timeout).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with tempfile.TemporaryDirectory(prefix="orcaxr-renderer-avd-") as directory:
    env = dict(os.environ, ANDROID_AVD_HOME=directory)
    subprocess.run([SDK / "cmdline-tools/latest/bin/avdmanager", "create", "avd", "--name", "orcaxr_renderer_ci",
                    "--package", "system-images;android-34;google_apis;x86_64", "--device", "pixel_2"],
                   input="no\n", text=True, env=env, check=True)
    with (OUTPUT / "emulator.log").open("w") as log:
        process = subprocess.Popen([SDK / "emulator/emulator", "-avd", "orcaxr_renderer_ci", "-port", "5582",
            "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect",
            "-cores", "2", "-memory", "2560", "-skin", "720x1280", "-dpi-device", "240",
            "-feature", "-Vulkan"], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Owned emulator exited during boot")
                ready = subprocess.run(["adb", "-s", SERIAL, "shell", "getprop", "sys.boot_completed"],
                                       capture_output=True, text=True, timeout=15)
                if ready.returncode == 0 and ready.stdout.strip() == "1":
                    break
                time.sleep(2)
            else:
                raise RuntimeError("Owned emulator boot timed out")
            print("Owned renderer emulator ready", flush=True)
            subprocess.run(["python3", "tools/cross-platform/android-smoke.py", "--serial", SERIAL], cwd=ROOT, check=True)
            app = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
            tests = ROOT / "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
            adb("install", "-r", str(tests))
            result = adb("shell", "am", "instrument", "-w", "dev.orcaxr.nativeapp.test/androidx.test.runner.AndroidJUnitRunner", timeout=600)
            (OUTPUT / "instrumentation.txt").write_text(result + "\n")
            if not re.search(r"OK \(3 tests\)", result) or "FAILURES" in result or "INSTRUMENTATION_FAILED" in result:
                raise RuntimeError(f"Renderer instrumentation failed; see {OUTPUT / 'instrumentation.txt'}")
            report = json.loads(adb("shell", "run-as", "dev.orcaxr.nativeapp", "cat", "files/viewport-observations.json"))
            report.update({"evidenceKind": "software-emulator-only", "api": adb("shell", "getprop", "ro.build.version.sdk"),
                "abi": adb("shell", "getprop", "ro.product.cpu.abi"), "pageSize": int(adb("shell", "getconf", "PAGESIZE")),
                "appSha256": sha(app), "testApkSha256": sha(tests), "gpu": "swiftshader_indirect", "cores": 2})
            (OUTPUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report, indent=2), flush=True)
        except Exception:
            (OUTPUT / "failure-logcat.txt").write_text(adb("logcat", "-d", "-t", "5000", "-s", "AndroidRuntime", "Filament", "TestRunner", "LifecycleMonitor", "ActivityScenario", "ActivityTaskManager", "ActivityManager"))
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)
