#!/usr/bin/env python3
"""Drive the Device area on an explicitly selected emulator against the Moonraker simulator.

The simulator runs on this machine (loopback), which the emulator reaches as
10.0.2.2. The app's data is cleared first; the run adds the simulator as a
printer, saves a key, connects and reads its status, survives a restart with
the printer and key remembered, pauses, resumes and — once confirmed —
cancels a job started elsewhere, deletes its file, reads the history, sends
console commands (a move confirmed first) and a macro, shows a camera frame
fetched through Moonraker after its own URL fails, then finds the printer
again by discovery — a helper in the core's test APK advertises
`_moonraker._tcp` on the emulator, as Moonraker's zeroconf component does, on
a port forwarded to the simulator — adds and connects to it, and removes both
printers. What the printer received is checked at the end.
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
core_tests_apk = ROOT / "android/core-bridge/build/outputs/apk/androidTest/debug/core-bridge-debug-androidTest.apk"
CORE_TESTS = "dev.orcaxr.core.test"


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
    """The node showing [text], scrolling the screen's list to bring it into view: on down the
    list until it stops moving (its end), then back up to its start, and so on."""
    deadline = time.monotonic() + timeout
    onward = True
    placed = None
    seen = []
    while time.monotonic() < deadline:
        current = nodes()
        for node in current:
            value = node.get("text") or node.get("content-desc") or ""
            if value == text or (not exact and text in value):
                return node
            if value and value not in seen:
                seen.append(value)
        # Nothing moved since the last swipe: this end of the list is reached.
        layout = [node.get("bounds") for node in current]
        if layout == placed:
            onward = not onward
        placed = layout
        start, end = ("900", "400") if onward else ("400", "900")
        adb("shell", "input", "swipe", "360", start, "360", end, "300")
        time.sleep(0.3)
    (output / "device-smoke-failed.xml").write_text(adb("shell", "cat", "/data/local/tmp/orcaxr-device.xml"))
    (output / "device-smoke-seen.txt").write_text("\n".join(seen) + "\n")
    raise AssertionError(f"'{text}' never appeared")


def to_top():
    """Flings the screen's list back to its first item."""
    for _ in range(6):
        adb("shell", "input", "swipe", "360", "300", "360", "1100", "100")
    time.sleep(0.5)


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
# A printer with a past, a macro, a canned temperature reply and a camera whose
# snapshot path (relative, so first looked for on the web origin's port 80,
# where nothing answers) makes the app fall back to Moonraker.
options = {
    "history": [{"job_id": f"00000{n}", "filename": f"job-{n}.gcode", "status": "completed",
                 "start_time": 1_800_000_000 + n * 4000, "end_time": 1_800_003_600 + n * 4000,
                 "print_duration": 3500, "total_duration": 3600, "filament_used": 1234.5, "exists": True,
                 "metadata": {"estimated_time": 3400}} for n in (1, 2, 3)],
    "historyTotals": {"total_jobs": 3, "total_time": 10800, "total_print_time": 10500},
    "configSettings": {"gcode_macro load_filament": {"gcode": "M109 S{params.TEMP}\nG1 E50"}},
    "gcodeResponses": {"M105": "ok T:210.0 /210.0 B:60.0 /60.0"},
    "webcams": [{"name": "Nozzle", "service": "mjpegstreamer-adaptive", "snapshot_url": "/webcam/snapshot",
                 "stream_url": "/webcam/?action=stream", "target_fps": 4}],
}
simulator = subprocess.Popen(["node", "tools/cross-platform/moonraker-simulator-serve.mjs", json.dumps(options)], cwd=ROOT,
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
    # Files: the job's file, read and deleted once confirmed.
    tap("Files")
    tap("smoke.gcode")
    find("Print this file")
    tap("Delete file")
    find("Delete smoke.gcode?")
    tap("Delete")
    absent("smoke.gcode")
    # History: the printer's own records, described as the browser does.
    tap("History")
    find("job-1.gcode")
    find("Page 1 of 1 — 3 jobs")
    # Console: a report-only command goes straight out and its answer comes
    # back over the socket; a move is confirmed first; a macro with a value.
    tap("Console")
    type_into("G-code", "M105")
    tap("Send")
    find("› M105")
    find("ok T:210.0 /210.0 B:60.0 /60.0")
    type_into("G-code", "G28")
    tap("Send")
    find("Run G28?")
    tap("Run G28")
    find("› G28")
    tap("Show macros")
    type_into("TEMP", "220")
    tap("Run LOAD_FILAMENT")
    find("Run LOAD_FILAMENT?")
    tap("Run LOAD_FILAMENT")
    find("› LOAD_FILAMENT TEMP=220")
    # Camera: nothing answers on the web origin, so the frame comes through Moonraker.
    tap("Camera")
    find("Latest frame from Nozzle", timeout=30)
    tap("Status")
    tap("Disconnect")
    find("Connect")
    # Discovery: the printer announces itself, is verified with no key sent and
    # proposed under the name it gives itself; nothing is saved until it is added.
    adb("install", "-r", str(core_tests_apk))
    advertiser = subprocess.Popen(
        ["adb", "-s", args.serial, "shell", "am", "instrument", "-w", "-e", "class", "dev.orcaxr.core.MoonrakerAdvertiser",
         "-e", "advertiseMoonraker", f"10.0.2.2:{port}", "-e", "advertiseSeconds", "300",
         f"{CORE_TESTS}/androidx.test.runner.AndroidJUnitRunner"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        time.sleep(3)
        tap("Find printers")
        find("Moonraker answered", timeout=45)
        tap("Add orcaxr-simulator")
        find("Saved orcaxr-simulator.")
        tap("Connect")
        # The same machine, through the advertised port: the job cancelled above.
        find("Connected", timeout=30)
        find("Cancelled", timeout=30)
        tap("Disconnect")
        find("Connect")
        tap("Remove this printer")
        find("Remove orcaxr-simulator?")
        tap("Remove")
        absent("orcaxr-simulator")
    finally:
        adb("shell", "am", "force-stop", CORE_TESTS)
        advertiser.wait(timeout=30)
    # The printer typed in first is the active one again.
    to_top()
    find("Simulator")
    tap("Remove this printer")
    find("Remove Simulator?")
    tap("Remove")
    find("No printer saved yet. Add one by its address on your network.")
    simulator.stdin.write("summary\n")
    simulator.stdin.flush()
    received = json.loads(simulator.stdout.readline())
    # The typed-in printer's key, and none from the probe or the discovered printer (saved without one).
    assert sorted(received["apiKeys"], key=str) == sorted(["emulator-key", None], key=str), received["apiKeys"]
    assert received["commands"] == ["start", "pause", "resume", "cancel", "delete:smoke.gcode", "gcode:M105",
                                    "gcode:G28", "gcode:LOAD_FILAMENT TEMP=220"], received["commands"]
    assert received["snapshotRequests"] >= 1, received
    # Connections from the typed-in printer (twice), the probe and the discovered printer.
    assert received["requests"].count("GET /server/info") >= 4, received["requests"]
    report = {
        "evidenceKind": "emulator-only",
        "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
        "appSha256": sha256(app_apk),
        "simulatorRequests": len(received["requests"]),
        "apiKeys": [key for key in received["apiKeys"] if key],
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
