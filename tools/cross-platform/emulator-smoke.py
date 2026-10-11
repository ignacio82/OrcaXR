#!/usr/bin/env python3
"""Own a temporary AVD/process for the JNI, app-startup, Device, Project, edit, inspector, creation, filament, Preview, Prepare, Send, language and adaptive-shell smoke tests.

API 34 by default; `--api 37` runs them on Android 17, where every printer
exchange needs the local-network permission, and adds that permission's own
smoke (asking, denial, denial for good, grant in settings, revocation).
`--pages 16` uses the 16 KB page-size image of that release, so the packaged
native libraries load on a 16 KB kernel.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import time
from artifacts import ROOT

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--api", type=int, choices=(34, 37), default=34)
parser.add_argument("--pages", type=int, choices=(4, 16), default=4)
# Every smoke installs the app it drives, so a run may start part-way through the order.
SMOKES = ["android-smoke", "android-local-network-smoke", "android-device-smoke", "android-project-smoke",
          "android-preview-smoke", "android-prepare-smoke", "android-send-smoke", "android-locale-smoke",
          "android-edit-smoke", "android-inspector-smoke", "android-create-smoke", "android-filament-smoke",
          # Last: it resizes the display (restoring it as it ends) for the window-size layouts.
          "android-adaptive-smoke"]
parser.add_argument("--from", dest="start", choices=SMOKES, default=SMOKES[0],
                    help="run the smokes from this one on, in order")
arguments = parser.parse_args()
api = arguments.api
images = {
    (34, 4): "system-images;android-34;google_apis;x86_64",
    (37, 4): "system-images;android-37.0;google_apis;x86_64",
    (37, 16): "system-images;android-37.0;google_apis_ps16k;x86_64",
}
if (api, arguments.pages) not in images:
    raise SystemExit(f"No {arguments.pages} KB page image is configured for API {api}")
sdk = Path(os.environ["ANDROID_HOME"])
serial = "emulator-5580" if api == 34 else "emulator-5582"
devices = subprocess.check_output(["adb", "devices"], text=True)
if serial in devices:
    raise SystemExit(f"{serial} is already owned; refusing to reuse it")
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="orcaxr-avd-") as directory:
    env = dict(os.environ, ANDROID_AVD_HOME=directory)
    subprocess.run([sdk / "cmdline-tools/latest/bin/avdmanager", "create", "avd",
                    "--name", "orcaxr_core_ci", "--package", images[(api, arguments.pages)],
                    "--device", "pixel_2"], input="no\n", text=True, env=env, check=True)
    with (output / "emulator.log").open("w") as log:
        process = subprocess.Popen([sdk / "emulator/emulator", "-avd", "orcaxr_core_ci", "-port", serial.rsplit("-", 1)[1],
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
            page = subprocess.check_output(["adb", "-s", serial, "shell", "getconf", "PAGESIZE"], text=True).strip()
            assert page == str(arguments.pages * 1024), f"Expected {arguments.pages} KB pages, the kernel uses {page} bytes"
            for smoke in SMOKES[SMOKES.index(arguments.start):]:
                # The local-network permission exists from Android 17.
                if smoke == "android-local-network-smoke" and api < 37:
                    continue
                subprocess.run(["python3", f"tools/cross-platform/{smoke}.py", "--serial", serial], cwd=ROOT, check=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)
