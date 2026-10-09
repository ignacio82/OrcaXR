#!/usr/bin/env python3
"""Own a temporary API 34 AVD/process for the JNI and app-startup smoke test."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
from artifacts import ROOT

sdk = Path(os.environ["ANDROID_HOME"])
serial = "emulator-5580"
devices = subprocess.check_output(["adb", "devices"], text=True)
if serial in devices:
    raise SystemExit(f"{serial} is already owned; refusing to reuse it")
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="orcaxr-avd-") as directory:
    env = dict(os.environ, ANDROID_AVD_HOME=directory)
    subprocess.run([sdk / "cmdline-tools/latest/bin/avdmanager", "create", "avd",
                    "--name", "orcaxr_core_ci", "--package", "system-images;android-34;google_apis;x86_64",
                    "--device", "pixel_2"], input="no\n", text=True, env=env, check=True)
    with (output / "emulator.log").open("w") as log:
        process = subprocess.Popen([sdk / "emulator/emulator", "-avd", "orcaxr_core_ci", "-port", "5580",
            "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect",
            "-cores", "2", "-memory", "2560", "-skin", "720x1280", "-dpi-device", "240",
            "-feature", "-Vulkan"], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                assert process.poll() is None, "Owned emulator exited during boot"
                ready = subprocess.run(["adb", "-s", serial, "shell", "getprop", "sys.boot_completed"],
                                       capture_output=True, text=True, timeout=15)
                if ready.returncode == 0 and ready.stdout.strip() == "1":
                    break
                time.sleep(2)
            else:
                raise RuntimeError("Owned emulator did not boot before the deadline")
            subprocess.run(["python3", "tools/cross-platform/android-smoke.py", "--serial", serial], cwd=ROOT, check=True)
            subprocess.run(["python3", "tools/cross-platform/android-device-smoke.py", "--serial", serial], cwd=ROOT, check=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)
