#!/usr/bin/env python3
"""Drive the Device area on an explicitly selected emulator against the Moonraker simulator.

The simulator runs on this machine (loopback), which the emulator reaches as
10.0.2.2. The app's data is cleared first; the run adds the simulator as a
printer, saves a key, connects and reads its status, survives a restart with
the printer and key remembered, pauses, resumes and — once confirmed —
cancels a job started elsewhere, then removes the printer. What the printer
received is checked at the end.
"""
import argparse
import json
import re
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET
from artifacts import ROOT, sha256

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
if not re.fullmatch(r"emulator-\d+", args.serial):
    raise SystemExit("This unattended smoke test only installs on an explicitly selected emulator")
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"


def adb(*command, timeout=120):
    return subprocess.check_output(["adb", "-s", args.serial, *command], text=True, timeout=timeout).strip()


def nodes():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/orcaxr-device.xml")
    layout = ET.fromstring(adb("shell", "cat", "/data/local/tmp/orcaxr-device.xml"))
    return list(layout.iter("node"))


def center(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    return (left + right) // 2, (top + bottom) // 2


def find(text, timeout=20, exact=True):
    """The node showing [text], scrolling the screen's list both ways to bring it into view."""
    deadline = time.monotonic() + timeout
    sweep = 0
    while time.monotonic() < deadline:
        for node in nodes():
            value = node.get("text") or node.get("content-desc") or ""
            if value == text or (not exact and text in value):
                return node
        # Three swipes down the list, then three back up, and again.
        upward = sweep % 6 < 3
        start, end = ("900", "400") if upward else ("400", "900")
        adb("shell", "input", "swipe", "360", start, "360", end, "300")
        sweep += 1
        time.sleep(0.3)
    (output / "device-smoke-failed.xml").write_text(adb("shell", "cat", "/data/local/tmp/orcaxr-device.xml"))
    raise AssertionError(f"'{text}' never appeared")


def absent(text, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any((node.get("text") or "") == text for node in nodes()):
            return
        time.sleep(0.5)
    raise AssertionError(f"'{text}' never went away")


def tap(text, **kwargs):
    x, y = center(find(text, **kwargs))
    adb("shell", "input", "tap", str(x), str(y))


def type_into(label, value):
    """Focus the text field labelled [label] and type [value]."""
    field = None
    for node in nodes():
        if node.get("class") == "android.widget.EditText" and any(
            (child.get("text") or "") == label for child in node.iter("node")
        ):
            field = node
    if field is None:
        field = find(label)
    x, y = center(field)
    adb("shell", "input", "tap", str(x), str(y))
    adb("shell", "input", "text", value.replace(" ", "%s"))
    hide_keyboard()


def hide_keyboard():
    """Close the soft keyboard, which would cover the next field or button; Back closes it first."""
    for _ in range(10):
        if "mInputShown=true" not in adb("shell", "dumpsys", "input_method"):
            return
        adb("shell", "input", "keyevent", "4")
        time.sleep(0.3)
    raise AssertionError("The soft keyboard would not close")


def start_print(url, filename):
    """Upload [filename] to the simulator and start it, as another client would."""
    boundary = "orcaxr-smoke"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: text/plain\r\n\r\nG28\nG1 X10\n\r\n--{boundary}--\r\n").encode()
    upload = urllib.request.Request(f"{url}/server/files/upload", data=body, method="POST",
                                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                             "X-Api-Key": "emulator-key"})
    urllib.request.urlopen(upload, timeout=10).read()
    start = urllib.request.Request(f"{url}/printer/print/start?filename={filename}", data=b"", method="POST",
                                   headers={"X-Api-Key": "emulator-key"})
    urllib.request.urlopen(start, timeout=10).read()


def launch():
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
    find("Workspace preview — editing is not available yet.")
    tap("Device")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
simulator = subprocess.Popen(["node", "tools/cross-platform/moonraker-simulator-serve.mjs"], cwd=ROOT,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
try:
    url = simulator.stdout.readline().strip()
    port = url.rsplit(":", 1)[1]
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    launch()
    find("No printer saved yet. Add one by its address on your network.")
    tap("Add printer")
    type_into("Name", "Simulator")
    type_into("Address", "10.0.2.2")
    type_into("Port (7125 if empty)", port)
    tap("Save")
    find("Simulator")
    find(f"10.0.2.2 · port {port}")
    type_into("API key (if the printer requires one)", "emulator-key")
    tap("Use this key")
    tap("Connect")
    find("Idle", timeout=30)
    find("Disconnect")
    # A restart remembers the printer and its key, and connects with it again.
    launch()
    find("Simulator")
    tap("Connect")
    find("Idle", timeout=30)
    # A job started elsewhere: paused, resumed, then cancelled once confirmed.
    start_print(url, "smoke.gcode")
    find("Printing", timeout=30, exact=False)
    tap("Pause print")
    find("Paused", timeout=30, exact=False)
    tap("Resume print")
    find("Printing", timeout=30, exact=False)
    tap("Cancel print")
    find("Send to Simulator?")
    tap("Send")
    find("Cancelled", timeout=30)
    tap("Disconnect")
    find("Connect")
    tap("Remove this printer")
    tap("Remove")
    find("No printer saved yet. Add one by its address on your network.")
    simulator.stdin.write("summary\n")
    simulator.stdin.flush()
    received = json.loads(simulator.stdout.readline())
    assert received["apiKeys"] == ["emulator-key"], received["apiKeys"]
    assert received["commands"] == ["start", "pause", "resume", "cancel"], received["commands"]
    assert received["requests"].count("GET /server/info") >= 2, received["requests"]
    report = {
        "evidenceKind": "emulator-only",
        "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
        "appSha256": sha256(app_apk),
        "simulatorRequests": len(received["requests"]),
        "apiKeys": received["apiKeys"],
        "commands": received["commands"],
    }
    (output / "android-device-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Device area passed on API {report['api']} {report['abi']} emulator against the simulator "
          f"({report['simulatorRequests']} requests, key {report['apiKeys'][0]!r})")
finally:
    try:
        simulator.stdin.write("close\n")
        simulator.stdin.flush()
        simulator.wait(timeout=10)
    except Exception:
        simulator.kill()
