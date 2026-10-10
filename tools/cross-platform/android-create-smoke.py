#!/usr/bin/env python3
"""Drive creation on an explicitly selected emulator.

The app's data is cleared. From the Project area's Add menu a cube and a
cylinder are added — each one "Add cube.stl" / "Add cylinder.stl", centred
on the bed and drawn in the Workspace. The cylinder (selected as it lands) is
copied and pasted from the Edit menu, then pasted again with Ctrl+V; the
pasted copy gains an instance (Add Instance), which Ctrl+X cuts and Ctrl+V
pastes back as an object of its own; a modifier is added to the selected
object from the Add menu, and undone. Every edit is checked by its undo
label: one step, the browser's history label.

Lessons kept from the edit smoke: an action that acts on the selection waits
until the core has enabled it for the selection the last edit made (its
effect arrives after the step's label), and rows are found by their text,
never by screen position, since the tree reflows as it opens.
"""
import argparse
import time
from artifacts import ROOT
from smoke_ui import Screen, changed_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
CTRL, C, V, X = "113", "31", "50", "52"

screen = Screen(args.serial, output, "create")
adb, find, tap = screen.adb, screen.find, screen.tap


def menu(name, action, timeout=20):
    """An action from the Project area's [name] menu, once the core enables it."""
    deadline = time.monotonic() + timeout
    while True:
        tap(name)
        if screen.enabled(action):
            tap(action)
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)  # Back closes the open menu before it is opened again.
        time.sleep(1)


def chord(key):
    """Ctrl+[key] from a hardware keyboard."""
    adb("shell", "input", "keycombination", CTRL, key)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
box = (0, 260, width, height - 220)
tap("Workspace")
time.sleep(4)
empty = screen.screenshot()

# The Add menu: a cube, then a cylinder, each one step that selects it.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
find("1 object")
tap("Workspace")
time.sleep(4)
drawn = screen.screenshot()
# A 20 mm cube on the project's own bed (the default profile's 270 mm U1 plate): a few hundred pixels.
assert len(changed_pixels(empty, drawn, *box)) > 300, "The cube was not drawn on the bed"
tap("Project")
menu("Add", "Cylinder")
find("Undo Add cylinder.stl", timeout=30)
find("2 objects")

# Copy and paste from the Edit menu: the copy is an object of its own, selected as it lands.
menu("Edit", "Copy")
menu("Edit", "Paste")
find("Undo Paste model", timeout=30)
find("3 objects")
# Ctrl+V pastes again once the core has enabled Paste for the new selection.
time.sleep(1)
chord(V)
find("4 objects", timeout=30)

# Add Instance: another instance of the pasted object, selected; Ctrl+X cuts it and Ctrl+V pastes it back.
menu("Edit", "Add Instance")
find("Undo Create instance", timeout=30)
time.sleep(1)
chord(X)
find("Undo Delete instance", timeout=30)
time.sleep(1)
chord(V)
find("Undo Paste model", timeout=30)
find("5 objects")

# A modifier for the selected object, from the Add menu; undone, the paste is the last step again.
menu("Add", "Add Modifier")
find("Undo Add modifier to object", timeout=30)
tap("Undo Add modifier to object")
find("Undo Paste model", timeout=30)
find("5 objects")
print("Create smoke passed")
