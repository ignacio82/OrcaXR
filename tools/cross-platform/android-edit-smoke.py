#!/usr/bin/env python3
"""Drive selection and object edits on an explicitly selected emulator.

The app's data is cleared and a binary STL is placed in Downloads. Two cubes
are imported; a tap on a model in the Workspace selects it in the project —
the scene highlights it and, in the Project area, the tree opens to its
instance row, checked as selected. The selection is deleted from the Edit
menu and the deletion undone; an instance is selected from its tree row,
cloned (one "Create instance" that selects the copy), made unprintable,
deleted with the keyboard's Delete key and Escape deselects all; an object is
renamed from its row's long-press menu; a plate is added, renamed and deleted
from the plate bar. Every edit is checked by its undo label: one step, the
browser's history label.
"""
import argparse
import base64
import json
import tempfile
import re
import time
from pathlib import Path
from artifacts import ROOT
from smoke_ui import Screen, changed_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"

screen = Screen(args.serial, output, "edit")
adb, nodes, find, absent, tap = screen.adb, screen.nodes, screen.find, screen.absent, screen.tap
type_into, center = screen.type_into, screen.center


def import_cube(objects):
    tap("Import Model…")
    screen.pick_download("cube.stl", timeout=30)
    find("Import cube.stl?", timeout=30)
    find(f"The project will then have {objects} object(s). Importing is one step you can undo.")
    tap("Import")


def checked(description, timeout=20):
    """Whether the check box described as [description] is checked, once it shows."""
    node = find(description, timeout=timeout)
    return node.get("checked") == "true"


def until_checked(description, expected, timeout=20):
    deadline = time.monotonic() + timeout
    while checked(description) != expected:
        assert time.monotonic() < deadline, f"'{description}' never became {'checked' if expected else 'unchecked'}"
        time.sleep(0.5)


def instance_boxes():
    """The expanded object's instance rows' check boxes, in tree order: those between its "Instances (n)"
    group row and the next row of another kind. An imported instance is named after its file, as its
    object is, so rows are told apart by place rather than by name. The group row is brought near the
    top of the list first: found on the list's last line, its rows would be off screen."""
    nodes = screen.lift(find("Instances (", exact=False))
    def top(node):
        return int(re.findall(r"\d+", node.get("bounds"))[1])
    group = next(n for n in nodes if re.fullmatch(r"Instances \(\d+\)", n.get("text") or ""))
    after = [n for n in nodes if top(n) > top(group) and n.get("class") == "android.widget.TextView"
             and re.fullmatch(r"Settings|Instances \(\d+\)|Layer ranges \(\d+\)", n.get("text") or "")]
    end = min((top(n) for n in after), default=10 ** 6)
    return [n for n in nodes if n.get("class") == "android.widget.CheckBox"
            and (n.get("content-desc") or "").startswith("Select ") and top(group) < top(n) < end]


def until_instance(index, expected, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        boxes = instance_boxes()
        if len(boxes) > index and (boxes[index].get("checked") == "true") == expected:
            return
        assert time.monotonic() < deadline, f"Instance row {index + 1} never became {'checked' if expected else 'unchecked'}"
        time.sleep(0.5)


def tap_instance(index):
    """Activates instance row [index] by its label, beside its check box."""
    left, top, right, bottom = map(int, re.findall(r"\d+", instance_boxes()[index].get("bounds")))
    adb("shell", "input", "tap", str(right + 60), str((top + bottom) // 2))


def long_press(text):
    x, y = center(find(text))
    adb("shell", "input", "swipe", str(x), str(y), str(x), str(y), "1000")


def edit(action):
    """An action from the Project area's Edit menu."""
    tap("Edit")
    tap(action)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
cube = json.loads((ROOT / "testdata/cross-platform/model-import-vectors.json").read_text())
cube_bytes = next(case for case in cube["cases"] if case["name"] == "stl-binary/cube")["bytesBase64"]
staged = Path(tempfile.mkdtemp(prefix="orcaxr-edit-smoke-")) / "cube.stl"
staged.write_bytes(base64.b64decode(cube_bytes))
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
adb("shell", "rm", "-f", "/sdcard/Download/cube.stl")
adb("push", str(staged), "/sdcard/Download/cube.stl")
staged.unlink()
staged.parent.rmdir()
adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:///sdcard/Download/cube.stl")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
box = (0, 260, width, height - 220)
tap("Workspace")
time.sleep(4)
empty = screen.screenshot()

# A cube, then a tap on it in the Workspace selects it in the project. (A second import lands on the
# same spot — the browser centres every import on the bed — where its twin could hide the highlight.)
tap("Project")
find("Untitled project", timeout=30)
import_cube(1)
find("1 object", timeout=30)
tap("Workspace")
time.sleep(4)
drawn = screen.screenshot()
model = changed_pixels(empty, drawn, *box)
# A 20 mm cube on the project's own bed (the default profile's 270 mm U1 plate): a few hundred pixels.
assert len(model) > 300, f"The imported model was not drawn ({len(model)} pixels changed)"
x = sum(p[0] for p in model) // len(model)
y = sum(p[1] for p in model) // len(model)
adb("shell", "input", "tap", str(x), str(y))
time.sleep(2)
assert len(changed_pixels(drawn, screen.screenshot(), *box)) > len(model) // 2, "The selected model was not highlighted"
tap("Project")
# The tree opened to the tapped instance's row, which reports the selection.
until_instance(0, True, timeout=30)
import_cube(2)
find("2 objects", timeout=30)
# The import leaves nothing selected; a tap on the two cubes' spot selects one of them again.
tap("Workspace")
time.sleep(3)
adb("shell", "input", "tap", str(x), str(y))
time.sleep(2)
tap("Project")

# Delete Selected from the Edit menu, then undo it.
edit("Delete Selected")
find("Undo Delete object", timeout=30)
find("1 object")
tap("Undo Delete object")
find("2 objects", timeout=30)

# An instance selected from its tree row, cloned: the copy is selected.
tap_instance(0)
until_instance(0, True)
edit("Clone Selected")
find("Undo Create instance", timeout=30)
find("1 part, 2 instances")
until_instance(1, True)
# Printable: the selected copy leaves the print, one undoable step.
edit("Printable")
find("Undo Mark instance unprintable", timeout=30)
# The keyboard: Delete deletes the selected instance; Escape deselects all.
tap_instance(0)
until_instance(0, True)
# The core enables Delete Selected for the new selection as its effect arrives.
time.sleep(1)
screen.key(112)
find("Undo Delete instance", timeout=30)
find("1 part, 1 instance")
until_instance(0, True)
screen.key(111)
until_instance(0, False)

# Rename an object from its row's long-press menu.
# The second cube's object is "cube (2)": the core keeps object names unique.
long_press("cube (2)")
tap("Rename")
find("Rename cube (2)", timeout=20)
type_into("Name", "Bolt")
tap("Save")
find("Undo Rename object to Bolt", timeout=30)
find("Bolt")

# The plate bar: add a plate (active), rename it, delete it.
tap("Add build plate")
find("Undo Add Plate 2", timeout=30)
tap("Actions for Plate 2")
tap("Rename build plate")
find("Rename Plate 2", timeout=20)
type_into("Name", "Second")
tap("Save")
find("Undo Rename plate to Second", timeout=30)
tap("Actions for Second")
tap("Delete build plate")
find("Undo Delete plate", timeout=30)
absent("Second")
find("2 objects")
print("Edit smoke passed")
