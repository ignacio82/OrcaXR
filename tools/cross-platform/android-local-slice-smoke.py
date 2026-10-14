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
process, and is current: neither Preview nor Prepare still says the slice
the scaling withdrew was withdrawn.

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
OUT_OF_DATE = "The project changed after this plate was sliced; its G-code was withdrawn. Slice again."

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
    shown = []
    while time.monotonic() < deadline:
        nodes = screen.nodes()
        for node in nodes:
            text = node.get("text") or ""
            if text.startswith("Slicing: ") and text not in ("Slicing: preflighting", "Slicing: serializing"):
                return text
        # What the pinned bar said instead, for the failure's message.
        for node in nodes[:40]:
            text = node.get("text") or ""
            if text and text not in shown:
                shown.append(text)
        time.sleep(0.3)
    raise AssertionError(f"The engine's progress never showed; the screen showed {shown[-25:]}")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
# Revoke notification permission to qualify slicing under notification denial:
# the app asks once before its first local slice; denying it still lets the slice run.
adb("shell", "pm", "revoke", PACKAGE, "android.permission.POST_NOTIFICATIONS")
adb("shell", "pm", "clear-permission-flags", PACKAGE, "android.permission.POST_NOTIFICATIONS", "user-set", "user-fixed")
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

# The slice runs in the engine's own process under notification denial; Preview shows its toolpaths.
tap("Slice")
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    denied_tap = False
    for node in screen.nodes():
        val = node.get("text") or node.get("content-desc") or ""
        if any(opt in val for opt in ("Don’t allow", "Don't allow", "Deny")):
            tap(val)
            denied_tap = True
            break
    if denied_tap:
        break
    time.sleep(0.3)

find("Sliced in Prepare from the project as it stands.", timeout=240)
find("Showing ", exact=False)
if int(adb("shell", "getprop", "ro.build.version.sdk")) >= 33:
    package_dump = adb("shell", "dumpsys", "package", PACKAGE)
    assert "android.permission.POST_NOTIFICATIONS: granted=false" in package_dump, \
        "Notification permission was granted; expected denial qualification"
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

# A long slice: the engine's progress shows, the service is in the foreground, task switching and screen lock are survived, and Cancel Slice stops it.
tap("Project")
menu("Edit", "Scale to build volume")
deadline = time.monotonic() + 60
while (scaled := find("Undo ", exact=False, timeout=30).get("text")) == "Undo Add cube.stl":
    assert time.monotonic() < deadline, "Scale to build volume made no step"
    time.sleep(0.5)
tap("Prepare")
find(OUT_OF_DATE, timeout=30)
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

# Task switching: press Home to put the app in the background. The service remains in the foreground.
adb("shell", "input", "keyevent", "3")
time.sleep(1)
services = adb("shell", "dumpsys", "activity", "services", f"{PACKAGE}/.engine.LocalEngineService")
assert "isForeground=true" in services, "The engine service stopped being foreground after task switch"
assert pid(ENGINE), "The engine died during task switch"

# Screen lock: turn screen off. The slice continues in the foreground service.
adb("shell", "input", "keyevent", "26")
time.sleep(1)
services = adb("shell", "dumpsys", "activity", "services", f"{PACKAGE}/.engine.LocalEngineService")
assert "isForeground=true" in services, "The engine service stopped being foreground during screen lock"
assert pid(ENGINE), "The engine died during screen lock"
adb("shell", "input", "keyevent", "26")
adb("shell", "input", "keyevent", "82")

# Bring editor back to foreground and cancel.
adb("shell", "am", "start", "-n", f"{PACKAGE}/.MainActivity")
find("Cancel Slice", timeout=20)
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
# This slice is current: Preview no longer says the slice the scaling withdrew was withdrawn
# (that notice once outlived the fresh slice), and Prepare offers it.
screen.absent(OUT_OF_DATE, timeout=10)
tap("Prepare")
find("Sliced on this device", timeout=30)
screen.absent(OUT_OF_DATE, timeout=10)

# Mid-slice editor death: the editor process is killed while slicing; :engine receives owner death via Binder,
# cancels native slicing, deletes the staged job directory, and demotes.
# Scale the cube again for a long slice:
tap("Project")
menu("Edit", "Scale to build volume")
find("Undo Transform instance", timeout=30)
tap("Prepare")
slice_ready()
tap("Slice")
running_progress()
assert pid(ENGINE), "No engine process while slicing"
jobs_staged = adb("shell", "run-as", PACKAGE, "ls no_backup/engine-jobs 2>/dev/null || true").split()
assert jobs_staged, "Expected staged job directory in no_backup/engine-jobs"
staged_dir = jobs_staged[0]

# Kill the editor process mid-slice:
victim_editor = pid(PACKAGE)
assert victim_editor, "No editor process to kill"
adb("shell", "run-as", PACKAGE, "kill", "-9", str(victim_editor))
time.sleep(1)
assert not pid(PACKAGE), "Editor process did not terminate"

# Owner death cleanup: LocalEngineService receives binderDied on owner token,
# cancels native slicing, discards the job directory, and demotes/stops.
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    remaining_jobs = adb("shell", "run-as", PACKAGE, "ls no_backup/engine-jobs 2>/dev/null || true").split()
    if staged_dir not in remaining_jobs:
        break
    time.sleep(0.5)
remaining = adb("shell", "run-as", PACKAGE, "ls no_backup/engine-jobs 2>/dev/null || true").split()
assert staged_dir not in remaining, f"Job directory {staged_dir} was not cleaned up after editor died"

# Demoted / stopped:
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    services = adb("shell", "dumpsys", "activity", "services", f"{PACKAGE}/.engine.LocalEngineService || true")
    if "isForeground=true" not in services:
        break
    time.sleep(0.5)
services = adb("shell", "dumpsys", "activity", "services", f"{PACKAGE}/.engine.LocalEngineService || true")
assert "isForeground=true" not in services, "Engine service did not demote after editor died"

# Reopen the app: starts cleanly.
screen.launch(PACKAGE)
editor = pid(PACKAGE)
assert editor and editor != victim_editor, "Editor process did not restart"

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
    "notificationDenialQualified": True,
    "taskSwitchingQualified": True,
    "screenLockQualified": True,
    "editorDeathCleanupQualified": True,
    "engineDeathRecoveryQualified": True,
}
(output / "android-local-slice-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Local slicing passed on API {report['api']} {report['abi']} emulator ({layers} layers, {toolpaths} toolpath pixels)")
