#!/usr/bin/env python3
"""Drive the inspector's settings panels on an explicitly selected emulator.

The app's data is cleared. A cube is added from the Project area's Add menu
(a new project starts from the catalog's default profile, the Snapmaker U1)
and sliced on the device's own engine for a baseline. Its object row opened,
the tree's Settings row opens the object's settings (the browser's scoped
settings panel: "Object settings — cube.stl", Simple detail): the wall count
is overridden to 6 and applied ("Undo Update object settings", the tree's
row "Settings (1)"), then the sparse infill density to 25% ("Settings (2)").
Sliced again, the G-code has more lines than the baseline: the engine read
the object's overrides. The wall count is then reset with "Use inherited"
(found by searching its key) and applied ("Settings (1)"). The object's
"Layer ranges (0)" row opens its height ranges: a 0–5 mm range is added
("Undo Add layer range", the range selected), its own Settings opens its
panel ("Height range settings — 0–5 mm"), a wall count of 4 is applied
("Undo Update height range settings"), and undo takes it back ("Undo Add
layer range").

Lessons kept from the earlier smokes: an action on the selection waits for
the core to enable it; rows are found by text, never by position; a text
field's content description sits on an inner node with the EditText's
bounds; Enter-free typing is checked against what landed.
"""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
SLICED_FILE = "Untitled_project_Plate_1.gcode"
SLICED = "Sliced in Prepare from the project as it stands."

screen = Screen(args.serial, output, "settings")
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


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def control(text, timeout=60):
    """Taps the control showing [text] (a button, not a heading with the same words), once enabled."""
    deadline = time.monotonic() + timeout
    while True:
        find(text, timeout=timeout)
        root = ET.fromstring(adb("shell", "cat", screen.dump))
        parents = {child: parent for parent in root.iter("node") for child in parent}
        for node in root.iter("node"):
            if (node.get("text") or node.get("content-desc") or "") != text:
                continue
            clickable = node
            while clickable is not None and clickable.get("clickable") != "true":
                clickable = parents.get(clickable)
            if clickable is not None and clickable.get("enabled") == "true":
                left, top, right, bottom = bounds(clickable)
                adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                return
        assert time.monotonic() < deadline, f"No enabled control shows '{text}'"
        time.sleep(1)


def edit_text(description):
    """The EditText a setting's field is: Compose reports its content description on an inner node
    with the EditText's bounds, and the setting's name shows the same words beside it."""
    find(description, timeout=60)
    nodes = screen.nodes()
    fields = [node for node in nodes if node.get("class") == "android.widget.EditText"]
    for node in nodes:
        if node.get("content-desc") != description:
            continue
        for field in fields:
            if field is node or bounds(field) == bounds(node):
                return field
    raise AssertionError(f"No text field is described as '{description}'")


def type_setting(description, value):
    """Types [value] into the setting's field, emptied first, and checks what landed."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    for _ in range(3):
        x, y = screen.center(edit_text(description))
        adb("shell", "input", "tap", str(x), str(y))
        deadline = time.monotonic() + 3
        while not shown() and time.monotonic() < deadline:
            time.sleep(0.2)
        time.sleep(0.3)
        # Select everything in the field and delete it, then type.
        adb("shell", "input", "keycombination", "113", "29")
        screen.key(67)
        adb("shell", "input", "text", value)
        time.sleep(1)
        if (edit_text(description).get("text") or "") == value:
            screen.hide_keyboard()
            return
    raise AssertionError(f"Could not type '{value}' into '{description}'")


def apply(label, tree_row=None):
    """Apply, once the draft enables it: one step with the browser's label, and the tree's Settings row counting overrides."""
    control("Apply")
    find(f"Undo {label}", timeout=60)
    if tree_row:
        find(tree_row, timeout=60)


def slice_lines():
    """Slices the plate on the device's engine and reads the published G-code back: its line count."""
    tap("Prepare")
    screen.to_top()
    find("Slicing route: this device's own engine", exact=False, timeout=60)
    screen.absent("Slice preflight issues", timeout=30)
    tap("Slice")
    find(SLICED, timeout=240)
    gcode = subprocess.check_output(["adb", "-s", args.serial, "exec-out", "run-as", PACKAGE, "cat",
                                     f"cache/prepare/gcode/{SLICED_FILE}"], timeout=60)
    tap("Project")
    return gcode.count(b"\n") + 1


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
# Granted up front: the app asks for it once before its first local slice (a system dialog).
adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")

# A cube on a new project, and its baseline slice.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
baseline = slice_lines()

# The object's Settings row opens its settings: the browser's scoped panel at the Simple level.
screen.to_top()
tap("Expand cube.stl")
tap("Settings")
find("Object settings — cube.stl", timeout=60)
find("Object: Plate 1 › cube.stl")
find("Overrides the object's inherited values. Only settings the engine reads at this scope are listed.")
shown = find(" settings shown; ", exact=False, timeout=60).get("text")

# A wall count and an infill density, each applied as one step.
type_setting("Wall loops", "6")
find("Draft changes are not applied yet.", timeout=30)
apply("Update object settings", "Settings (1)")
find("Applied 1 setting change atomically.", timeout=30)
type_setting("Sparse infill density", "25%")
apply("Update object settings", "Settings (2)")

# The engine reads the object's overrides: more walls and denser infill, more G-code.
overridden = slice_lines()
assert overridden > baseline, f"The overrides did not reach the G-code ({baseline} then {overridden} lines)"

# "Use inherited" resets the wall count, found by its key.
find("Object settings — cube.stl", timeout=60)
type_setting("Search settings", "wall_loops")
find("wall_loops", timeout=30)
control("Use inherited")
find("Draft changed", timeout=30)
apply("Update object settings", "Settings (1)")

# The object's height ranges: a 0–5 mm range, then its own wall count, undone.
screen.to_top()
tap("Layer ranges (0)")
find("Height ranges", timeout=60)
find("No height ranges are defined.")
screen.type_into("Minimum Z (mm)", "0")
screen.type_into("Maximum Z (mm)", "5")
control("Add range")
find("Undo Add layer range", timeout=60)
find("Added 0 mm–5 mm.", timeout=30)
find("Selected 0 mm–5 mm", timeout=30)
control("Settings")
find("Height range settings — 0–5 mm", timeout=60)
type_setting("Wall loops", "4")
apply("Update height range settings")
tap("Undo Update height range settings")
find("Undo Add layer range", timeout=60)

report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "objectSimpleView": shown,
    "baselineLines": baseline,
    "overriddenLines": overridden,
}
(output / "android-settings-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Settings smoke passed on API {report['api']} ({baseline} then {overridden} G-code lines)")
