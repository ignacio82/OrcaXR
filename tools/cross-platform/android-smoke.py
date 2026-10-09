#!/usr/bin/env python3
"""Run JNI vectors and verify shell startup on an explicitly selected emulator."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from artifacts import ROOT, sha256

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
if not re.fullmatch(r"emulator-\d+", args.serial):
    raise SystemExit("This unattended smoke test only installs on an explicitly selected emulator")
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)


def adb(*command, timeout=120):
    return subprocess.check_output(["adb", "-s", args.serial, *command], text=True, timeout=timeout).strip()


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
test_apk = ROOT / "android/core-bridge/build/outputs/apk/androidTest/debug/core-bridge-debug-androidTest.apk"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
adb("install", "-r", str(test_apk))
instrumentation = adb("shell", "am", "instrument", "-w", "dev.orcaxr.core.test/androidx.test.runner.AndroidJUnitRunner")
assert re.search(r"OK \(\d+ tests?\)", instrumentation), instrumentation
assert "FAILURES" not in instrumentation and "INSTRUMENTATION_FAILED" not in instrumentation, instrumentation
(output / "jni-instrumentation.txt").write_text(instrumentation + "\n")
print("Real JNI instrumentation passed", flush=True)
adb("install", "-r", str(app_apk))
for cycle in range(3):
    adb("shell", "am", "force-stop", "dev.orcaxr.nativeapp")
    launch = adb("shell", "am", "start", "-W", "-n", "dev.orcaxr.nativeapp/.MainActivity")
    for attempt in range(10):
        adb("shell", "uiautomator", "dump", "/data/local/tmp/orcaxr-core-smoke.xml")
        encoded_layout = adb("shell", "cat", "/data/local/tmp/orcaxr-core-smoke.xml")
        layout = ET.fromstring(encoded_layout)
        texts = {node.get("text") for node in layout.iter("node")}
        if "Import a model in the Project area to see it here." in texts:
            break
        time.sleep(0.5)
    else:
        (output / "failed-startup.xml").write_text(encoded_layout)
        (output / "failed-startup.txt").write_text(launch + "\n" + adb("logcat", "-d", "-t", "200", "-s", "AndroidRuntime", "ActivityTaskManager"))
        raise AssertionError("Native shell did not finish the real JNI handshake")
report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "pageSize": int(adb("shell", "getconf", "PAGESIZE")),
    "appSha256": sha256(app_apk),
    "testApkSha256": sha256(test_apk),
    "instrumentation": instrumentation,
    "coldStarts": 3,
}
(output / "android-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"JNI instrumentation passed; {report['coldStarts']} shell cold starts passed on API {report['api']} {report['abi']} emulator ({report['pageSize']}-byte pages)")
