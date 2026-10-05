#!/usr/bin/env python3
"""Own a fresh non-XR emulator for JNI, startup, pixels, and renderer lifetimes.

The output is software-renderer evidence, never physical-device qualification.
Build app/core instrumentation APKs before running. No physical device is used.
"""
import hashlib
import argparse
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
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--scenecore-only", action="store_true", help="Run only the separate candidate's non-XR startup test")
arguments = parser.parse_args()
OUTPUT.mkdir(parents=True, exist_ok=True)
if SERIAL in subprocess.check_output(["adb", "devices"], text=True):
    raise SystemExit(f"{SERIAL} is already owned; refusing to reuse it")
reports = ["scenecore-non-xr-instrumentation.txt", "scenecore-non-xr-report.json", "failure-logcat.txt"]
if not arguments.scenecore_only:
    reports += ["instrumentation.txt", "report.json"]
for name in reports:
    (OUTPUT / name).unlink(missing_ok=True)


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
            spatial_app = ROOT / "android/xr-experiment/build/outputs/apk/debug/xr-experiment-debug.apk"
            spatial_tests = ROOT / "android/xr-experiment/build/outputs/apk/androidTest/debug/xr-experiment-debug-androidTest.apk"
            adb("install", "-r", str(spatial_app))
            adb("install", "-r", str(spatial_tests))
            result = adb("shell", "am", "instrument", "-w", "-e", "class",
                "dev.orcaxr.xrexperiment.NonXrStartupTest",
                "dev.orcaxr.xrexperiment.test/androidx.test.runner.AndroidJUnitRunner", timeout=180)
            (OUTPUT / "scenecore-non-xr-instrumentation.txt").write_text(result + "\n")
            if not re.search(r"OK \(1 test\)", result) or "FAILURES" in result or "INSTRUMENTATION_FAILED" in result:
                raise RuntimeError("SceneCore non-XR startup failed; see scenecore-non-xr-instrumentation.txt")
            report = {"evidenceKind": "non-XR-startup-only", "appSha256": sha(spatial_app),
                "testApkSha256": sha(spatial_tests), "api": adb("shell", "getprop", "ro.build.version.sdk"),
                "abi": adb("shell", "getprop", "ro.product.cpu.abi"), "testsPassed": 1,
                "spatialRenderingQualified": False}
            (OUTPUT / "scenecore-non-xr-report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report, indent=2), flush=True)
            if arguments.scenecore_only:
                raise SystemExit(0)  # finally still tears down our emulator.
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
            # Diagnostics must not mask the original failure or delay cleanup if
            # the emulator/ADB itself is unresponsive.
            try:
                diagnostics = adb("logcat", "-d", "-t", "5000", "-s", "AndroidRuntime", "Filament", "TestRunner",
                    "LifecycleMonitor", "ActivityScenario", "ActivityTaskManager", "ActivityManager", timeout=20)
            except subprocess.SubprocessError as error:
                diagnostics = f"Logcat unavailable: {type(error).__name__}\n"
            (OUTPUT / "failure-logcat.txt").write_text(diagnostics)
            raise
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)
