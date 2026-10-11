#!/usr/bin/env python3
"""Drive slicing on the device's own engine on an explicitly selected emulator.

The app's data is cleared. A cube is added from the Project area's Add menu
(a new project starts from the catalog's default profile, the Snapmaker U1).
Prepare shows the local route and why — this device's engine, as external
slicing is off — and Slice slices the plate in the engine's own process
(`dev.orcaxr.nativeapp:engine`, separate from the editor's): Preview opens
with the toolpaths drawn, and the G-code summary in Prepare (size, lines,
layers — the engine's stated total, as the browser prefers it) matches the
file the app published, read back from the device. The
cube is then scaled to the build volume — a slice long enough to watch (a
bed of small cubes slices in about two seconds on the emulator): it shows
the engine's progress with the service in the foreground, and Cancel Slice
stops it. Sliced again, the engine's process is killed mid-slice: the
editor stays up with its project and says the engine stopped unexpectedly;
undone back to the small cube, the next slice runs on a fresh engine
process.

Lessons kept from the earlier smokes: an action on the selection waits for
the core to enable it, and rows are found by text, never by position.
"""
import argparse
import json
import math
import re
import subprocess
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen, saturated_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
ENGINE = PACKAGE + ":engine"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
SLICED_FILE = "Untitled_project_Plate_1.gcode"
CANCELLED = "slice failed: Cancelled by user"
INTERRUPTED = "slice failed: the slicing engine stopped unexpectedly; the project is unchanged. Slice again."

screen = Screen(args.serial, output, "local-slice")
adb, find, tap, enabled = screen.adb, screen.find, screen.tap, screen.enabled


def menu(name, action, timeout=20):
    """An action from the Project area's [name] menu, once the core enables it."""
    deadline = time.monotonic() + timeout
    while True:
        tap(name)
        if enabled(action):
            tap(action)
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)
        time.sleep(1)


def pid(process):
    value = adb("shell", f"pidof {process} || true")
    return int(value.split()[0]) if value else None


def slice_ready():
    screen.to_top()
    find("Slicing route: this device's own engine", exact=False, timeout=30)
    screen.absent("Slice preflight issues", timeout=30)
    assert enabled("Slice"), "Slice was not offered on this device's engine"


def running_progress(timeout=120):
    """The engine's own progress: a step it named while slicing, with a percent bar."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for node in screen.nodes():
            text = node.get("text") or ""
            if text.startswith("Slicing: ") and text not in ("Slicing: preflighting", "Slicing: serializing"):
                return text
        time.sleep(0.3)
    raise AssertionError("The engine's progress never showed")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
# Granted up front: the app asks for it once before its first local slice (a system dialog).
adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
editor = pid(PACKAGE)
assert editor, "The app's process is not running"

# A cube on a new project, which starts from the catalog's default profile.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)

# Prepare: the local route and why, the browser's "off" in this device's words, and Slice offered.
tap("Prepare")
find("Off — slicing on this device.", timeout=30)
slice_ready()
route = find("Slicing route: this device's own engine", exact=False).get("text")
assert "as external slicing is off" in route and "fit the memory this device has now" in route, route

# The slice runs in the engine's own process; Preview shows its toolpaths.
tap("Slice")
find("Sliced in Prepare from the project as it stands.", timeout=240)
find("Showing ", exact=False)
engine = pid(ENGINE)
assert engine and engine != pid(PACKAGE), "The engine did not run in its own process"
time.sleep(4)
width = screen.screenshot()[0]
toolpaths = saturated_pixels(screen.screenshot(), 0, 80, width, 520)
assert toolpaths > 150, f"The sliced toolpaths were not drawn ({toolpaths} coloured pixels)"

# The summary Prepare shows is the published file's, read back from the device.
tap("Prepare")
find("Sliced on this device", timeout=30)
status = find("SLICED in", exact=False, timeout=30).get("text")
summary = re.search(r"SLICED in (\d+) ms\s+(\d+) KB, (\d+) lines, (\d+) layers", status)
assert summary, status
gcode = subprocess.check_output(["adb", "-s", args.serial, "exec-out", "run-as", PACKAGE, "cat",
                                 f"cache/prepare/gcode/{SLICED_FILE}"], timeout=60)
# The browser's rule (SliceStatus.ts), independently: lines split on LF; layers the engine's own
# stated total in the trailer (the text's last 64 Ki units; the engine writes ASCII), else markers.
text = gcode.decode("utf-8-sig")
lines = gcode.count(b"\n") + 1
markers = len(re.findall(r"; CHANGE_LAYER|;LAYER_CHANGE", text))
stated = re.search(r"^; total layers count = (.+)$", text[-65536:], re.M)
try:
    total = float(stated.group(1)) if stated else None
except ValueError:
    total = None
layers = int(total) if total is not None and total >= 0 and total == int(total) else markers
assert int(summary.group(2)) == math.floor(len(gcode) / 1024 + 0.5), (summary.group(2), len(gcode))
assert int(summary.group(3)) == lines, (summary.group(3), lines)
assert int(summary.group(4)) == layers and layers >= 50, (summary.group(4), layers, markers)

# A long slice: the engine's progress shows, the service is in the foreground, and Cancel Slice stops it.
tap("Project")
menu("Edit", "Scale to build volume")
deadline = time.monotonic() + 60
while (scaled := find("Undo ", exact=False, timeout=30).get("text")) == "Undo Add cube.stl":
    assert time.monotonic() < deadline, "Scale to build volume made no step"
    time.sleep(0.5)
tap("Prepare")
find("The project changed after this plate was sliced; its G-code was withdrawn. Slice again.", timeout=30)
slice_ready()
tap("Slice")
progress = running_progress()
# The service promotes itself as the job starts, a moment after the engine's first step may show.
deadline = time.monotonic() + 10
while "isForeground=true" not in (services := adb("shell", "dumpsys", "activity", "services", f"{PACKAGE}/.engine.LocalEngineService")):
    if time.monotonic() > deadline:
        (output / "local-slice-services.txt").write_text(services)
        raise AssertionError("The engine's service was not in the foreground while slicing")
    time.sleep(0.5)
tap("Cancel Slice")
cancelled = find(CANCELLED, exact=False, timeout=60).get("text")

# Killed mid-slice, the engine takes only its own process down: the editor says so and keeps its project.
slice_ready()
tap("Slice")
running_progress()
victim = pid(ENGINE)
assert victim, "No engine process while slicing"
adb("shell", "run-as", PACKAGE, "kill", "-9", str(victim))
find(INTERRUPTED, timeout=60)
assert pid(PACKAGE) == editor, "The editor's process did not survive the engine's"
tap("Project")
find(scaled, timeout=30)

# Back to the small cube: the next slice runs on a fresh engine process.
tap(scaled)
find("Undo Add cube.stl", timeout=30)
tap("Prepare")
slice_ready()
tap("Slice")
find("Sliced in Prepare from the project as it stands.", timeout=240)
restarted = pid(ENGINE)
assert restarted and restarted != victim, "The engine's process was not replaced"

report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "pageSize": int(adb("shell", "getconf", "PAGESIZE")),
    "appSha256": sha256(app_apk),
    "gcodeBytes": len(gcode),
    "gcodeLines": lines,
    "gcodeLayers": layers,
    "gcodeLayerMarkers": markers,
    "toolpathPixels": toolpaths,
    "scaled": scaled,
    "progress": progress,
    "cancelled": cancelled,
}
(output / "android-local-slice-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Local slicing passed on API {report['api']} {report['abi']} emulator ({layers} layers, {toolpaths} toolpath pixels)")
