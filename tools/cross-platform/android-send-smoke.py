#!/usr/bin/env python3
"""Drive "Send to Printer" — Prepare's finished slice to the Device area's printer — on an explicitly selected emulator.

Two servers run on this machine, which the emulator reaches as 10.0.2.2: the
real external slicer server (its engine a stand-in that writes the two-layer,
two-tool reference G-code) with a bearer token, and the Moonraker simulator
holding one loaded filament. The app's data is cleared first. The simulator
is added in the Device area with its key and connected; the multicolour
hexagon (which carries its own profiles) is opened and sliced in Prepare.
"Send to Printer" opens the browser's confirmation: the printer and its state,
the plate, the file and its size, the filaments, the blocker for the second
tool's empty slot (so starting is unavailable) and the start options. Uploaded
only, it is stored under a unique name and verified. Sent again with the
simulator holding the upload's reply, "Cancel send" stops it. With both
filaments loaded, the operator chooses levelling and the exact name and starts
the print: the Device area then shows it printing. A model imported afterwards
changes the project: the slice is out of date and nothing can be sent. The
printer receives the three uploads (the cancelled one was already stored),
the levelling and one start, every request with the printer's key.
"""
import argparse
import base64
import json
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
TOKEN = "send-smoke-token-0123456789abcdef"
KEY = "send-smoke-key"
SHOWN_LAYERS = "Layers 1 through 2, Z 0.2 through 0.4 mm"
OUT_OF_DATE = "The project changed after this plate was sliced; its G-code was withdrawn. Slice again."
BLOCKER = "The artifact prints with tool T1, but the printer reports no filament loaded in slot 2."
RED = {"color": "FF0000", "material": "PLA"}
GREEN = {"color": "00FF00", "material": "PLA"}
reference = ROOT / "testdata/parity/fixtures/reference.gcode"
size = f"{reference.stat().st_size} B"
kilobytes = f"{reference.stat().st_size / 1024:.0f}"

screen = Screen(args.serial, output, "send")
adb, find, tap, absent, enabled = screen.adb, screen.find, screen.tap, screen.absent, screen.enabled
hexagon = ROOT / "web/public/models/multicolor_hexagon.3mf"


def pick_download(name):
    """Chooses [name] from Downloads in the system picker, through its roots when Recent lacks it."""
    try:
        tap(name, timeout=5)
    except AssertionError:
        tap("Show roots")
        tap("Downloads")
        tap(name, timeout=20)


def type_into(label, value):
    # The slicer's fields head the Prepare area.
    screen.to_top()
    screen.type_into(label, value)


def checked(text):
    """Whether the checkbox row showing [text] is checked: Compose reports it on the row's clickable node."""
    find(text)
    root = ET.fromstring(adb("shell", "cat", screen.dump))
    parents = {child: parent for parent in root.iter("node") for child in parent}
    node = next(node for node in root.iter("node") if (node.get("text") or "") == text)
    while node is not None and node.get("clickable") != "true":
        node = parents.get(node)
    assert node is not None, f"'{text}' is not inside a control"
    return node.get("checked") == "true"


def confirmation():
    """Opens the send's confirmation and checks what it says about the printer, plate and file; returns the
    unique name it offers and the exact name the operator may choose instead."""
    tap("Send to Printer")
    find("Send to printer", timeout=60)
    find("Toolchanger — ready (standby)")
    find("Plate 1")
    unique = find(f" ({size})", exact=False).get("text").removesuffix(f" ({size})")
    exact = re.fullmatch(r"Use exact name (.+) \(new file\)", find("Use exact name ", exact=False).get("text"))
    assert exact, "The exact name was not offered as a new file"
    stem = exact.group(1).removesuffix(".gcode")
    assert re.fullmatch(re.escape(stem) + r"_[0-9a-f]{32}\.gcode", unique), f"Not a unique name: {unique}"
    return unique, exact.group(1)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
cube = json.loads((ROOT / "testdata/cross-platform/model-import-vectors.json").read_text())
cube_bytes = next(case for case in cube["cases"] if case["name"] == "stl-binary/cube")["bytesBase64"]
staged = Path(tempfile.mkdtemp(prefix="orcaxr-send-smoke-")) / "cube.stl"
staged.write_bytes(base64.b64decode(cube_bytes))
slicer = subprocess.Popen(
    ["node", "tools/cross-platform/external-slicer-serve.mjs",
     json.dumps({"token": TOKEN, "gcodeFile": str(reference.relative_to(ROOT))})],
    cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)
printer = subprocess.Popen(
    ["node", "tools/cross-platform/moonraker-simulator-serve.mjs", json.dumps({"slots": [RED]})],
    cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)


def ask(server, command):
    server.stdin.write(command + "\n")
    server.stdin.flush()
    return server.stdout.readline().strip()


try:
    slicer_port = slicer.stdout.readline().strip().rsplit(":", 1)[1]
    endpoint = f"http://10.0.2.2:{slicer_port}"
    printer_port = printer.stdout.readline().strip().rsplit(":", 1)[1]
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    if screen.api() >= 37:
        # Granted up front: android-local-network-smoke.py drives the prompt itself.
        adb("shell", "pm", "grant", PACKAGE, "android.permission.ACCESS_LOCAL_NETWORK")
    adb("shell", "rm -f /sdcard/Download/cube.stl /sdcard/Download/hexagon.3mf")
    adb("push", str(staged), "/sdcard/Download/cube.stl")
    adb("push", str(hexagon), "/sdcard/Download/hexagon.3mf")
    for name in ("cube.stl", "hexagon.3mf"):
        adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file:///sdcard/Download/{name}")
    screen.launch(PACKAGE)
    find("Import a model in the Project area to see it here.")

    # The printer: the simulator, its key, connected.
    tap("Device")
    tap("Add printer")
    screen.type_into("Name", "Toolchanger")
    screen.type_into("Address", "10.0.2.2")
    screen.type_into("Port (7125 if empty)", printer_port)
    tap("Save")
    find(f"10.0.2.2 · port {printer_port}")
    screen.type_into("API key (if the printer requires one)", KEY)
    tap("Use this key")
    tap("Connect")
    find("Idle", timeout=30)

    # The plate: the hexagon, sliced on the external slicer after consent.
    tap("Project")
    tap("Open Project…")
    pick_download("hexagon.3mf")
    find("hexagon.3mf · No unsaved changes", timeout=60)
    tap("Prepare")
    find("Plate 1 · 1 object(s)", timeout=30)
    type_into("External slicer URL", endpoint)
    type_into("Access token (only if the server requires one)", TOKEN)
    tap("Connect")
    find("Online — attested (the native Snapmaker Orca CLI at", exact=False, timeout=30)
    assert enabled("Slice"), "Slice was not offered for a plate the preflight passes"
    tap("Slice")
    find(f"Upload this plate to {endpoint}?", timeout=30)
    tap("Upload and slice")
    find(SHOWN_LAYERS, exact=False, timeout=90)
    tap("Prepare")
    find("SLICED in", exact=False, timeout=30)
    assert enabled("Send to Printer"), "Send to Printer was not offered for a current slice and a connected printer"

    # One filament loaded: the confirmation names the blocker, starting is unavailable, uploading is not.
    unique, exact = confirmation()
    find("2 tools (T0, T1) · H1: PLA #FF0000")
    find(BLOCKER)
    find("Resolve the filament mapping problems above before starting this print")
    find("Calibrate the build plate first")
    find("Record a timelapse")
    assert not checked("Calibrate the build plate first"), "A start option was chosen for the operator"
    assert not enabled("Upload and start print"), "Starting was offered with a tool's slot empty"
    tap("Upload only")
    find(f"— {kilobytes} KB verified; start it from the printer when ready.", exact=False, timeout=60)
    uploaded = find(" KB verified; start it from the printer when ready.", exact=False).get("text")
    assert re.fullmatch(re.escape(f"Uploaded {exact.removesuffix('.gcode')}_") + r"[0-9a-f]{32}\.gcode — .*", uploaded), uploaded

    # Held by the printer mid-upload, the send is cancelled.
    assert ask(printer, "hold 30000") == "holding"
    confirmation()
    tap("Upload only")
    find("Uploading ", exact=False, timeout=60)
    tap("Cancel send")
    find("Send failed: Upload cancelled.", exact=False, timeout=60)

    # Both filaments loaded: levelling and the exact name chosen, the print started.
    assert ask(printer, f"slots {json.dumps([RED, GREEN])}") == "slots"
    unique, exact = confirmation()
    find("2 tools (T0, T1) · H1: PLA #FF0000; H2: PLA #00FF00")
    screen.absent(BLOCKER, timeout=5)
    tap("Calibrate the build plate first")
    assert checked("Calibrate the build plate first"), "Levelling was not chosen"
    tap(f"Use exact name {exact} (new file)")
    find(f"{exact} ({size})")
    assert enabled("Upload and start print"), "Starting was not offered with every tool loaded"
    tap("Upload and start print")
    find(f"Printing {exact} — {kilobytes} KB verified on the printer.", timeout=90)
    tap("Device")
    find("Printing", exact=False, timeout=30)

    # The project changes: the slice is out of date, and nothing can be sent.
    tap("Project")
    tap("Import Model…")
    pick_download("cube.stl")
    find("Import cube.stl?", timeout=30)
    tap("Import")
    find("Undo Import cube.stl", timeout=30)
    tap("Prepare")
    find(OUT_OF_DATE, timeout=30)
    absent("Send to Printer")

    received = json.loads(ask(printer, "summary"))
    stem = exact.removesuffix(".gcode")
    uniques = [path for path in received["stored"] if re.fullmatch(re.escape(stem) + r"_[0-9a-f]{32}\.gcode", path)]
    # The upload-only send and the cancelled one (stored before its reply was held), then the print.
    assert len(uniques) == 2 and exact in received["stored"] and len(received["stored"]) == 3, received["stored"]
    assert received["started"] == exact, received["started"]
    assert received["commands"] == ["gcode:BED_MESH_CALIBRATE", "start"], received["commands"]
    assert [key for key in received["apiKeys"] if key] == [KEY], received["apiKeys"]
    sliced = json.loads(ask(slicer, "summary"))
    assert [job["outcome"] for job in sliced["jobs"]] == ["done"], sliced["jobs"]
    report = {
        "evidenceKind": "emulator-only",
        "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
        "appSha256": sha256(app_apk),
        "stored": received["stored"],
        "started": received["started"],
        "commands": received["commands"],
        "printerRequests": len(received["requests"]),
    }
    (output / "android-send-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Send to Printer passed on API {report['api']} {report['abi']} emulator "
          f"({report['printerRequests']} printer requests, started {exact})")
finally:
    staged.unlink(missing_ok=True)
    staged.parent.rmdir()
    for server in (slicer, printer):
        try:
            server.stdin.write("close\n")
            server.stdin.flush()
            server.wait(timeout=10)
        except Exception:
            server.kill()
