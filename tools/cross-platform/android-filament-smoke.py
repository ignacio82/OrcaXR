#!/usr/bin/env python3
"""Drive the project's filaments on an explicitly selected emulator.

The app's data is cleared, so a new project starts from the catalog's default
profile (the Snapmaker U1: four heads, H-1 to H-4). A cube is added from the
Project area's Add menu. In the Prepare area's Filaments list, "+" adds a
fifth filament slot — an extra palette colour, A-5, in the profile's own
filament, with its own filament picker beside the heads' — as one "Update
slicing configuration". Back in the Project area, Select All selects the cube
and the selection filament bar shows; its chip for the new filament (head 5)
assigns the cube to it as one "Assign filament", and the cube's tree row shows
the filament under its name. Undo takes the assignment back (the row shows no
filament; the slot edit is the last step again). Finally the new slot's colour
is changed from its swatch in the Filaments list, one more "Update slicing
configuration", and the colour editor shows the new colour when it opens again.

Lessons kept from the earlier smokes: an import selects nothing, as in the
browser, so the cube is selected with Select All; an action acting on the
selection waits until the core enables it; rows are found by their text,
never by screen position; Compose reports a text field's content-desc on an
inner node with the same bounds as the EditText.
"""
import argparse
import re
import time
from artifacts import ROOT
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
ADD_SLOT = "Add an auxiliary palette color (not a virtual recipe)"
SLOT_LABEL = "Update slicing configuration"

screen = Screen(args.serial, output, "filament")
adb, find, absent, tap, nodes = screen.adb, screen.find, screen.absent, screen.tap, screen.nodes


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


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


def until_enabled(text, timeout=30):
    """Waits until the control showing (or described as) [text] is enabled: the profile has loaded."""
    deadline = time.monotonic() + timeout
    while not screen.enabled(text):
        assert time.monotonic() < deadline, f"'{text}' never became enabled"
        time.sleep(1)


def badge_under(label, badge, timeout=20):
    """Whether the tree row showing [label] shows [badge] among its indicators, just under its name.
    The filament bar names the selected object too; the tree's row is the one above it."""
    find(label, timeout=timeout)
    deadline = time.monotonic() + timeout
    while True:
        current = nodes()
        rows = [n for n in current if (n.get("text") or "") == label]
        if rows:
            left, top, right, bottom = bounds(min(rows, key=lambda n: bounds(n)[1]))
            shown = [n for n in current if (n.get("text") or "") == badge]
            if any(0 <= bounds(n)[1] - bottom < 120 and bounds(n)[0] >= left - 10 for n in shown):
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.5)


def colour_field():
    """The colour editor's text: the `#rrggbb` its field holds."""
    return screen.field("Colour (#rrggbb)").get("text") or ""


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")

# A cube, from the Add menu.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
find("1 object")

# The Filaments list: the U1's four heads, then a fifth slot from "+", one undoable step.
tap("Prepare")
find("Filaments", timeout=30)
for head in ("H-1:", "H-2:", "H-3:", "H-4:"):
    find(head)
until_enabled(ADD_SLOT)
tap(ADD_SLOT)
find("A-5:", timeout=30)
# The new slot has its own filament picker beside the heads', as the browser's heads panel.
find("Palette filament 5")
tap("Project")
find(f"Undo {SLOT_LABEL}", timeout=30)

# Select All selects the cube; the bar's chip for the new filament assigns it, one undoable step.
menu("Edit", "Select All")
chip = find("Head 5 · ", exact=False, timeout=30)
chip_text = chip.get("content-desc") or chip.get("text")
assert chip_text.startswith("Head 5 · "), chip_text
name = chip_text.removeprefix("Head 5 · ").split(" · ")[0]
assert not badge_under("cube.stl", name, timeout=2), "The cube showed a filament before it had one"
tap(chip_text)
find("Undo Assign filament", timeout=30)
find(f"{name} assigned")
assert badge_under("cube.stl", name), "The cube's tree row does not show its new filament"

# Undo takes the assignment back: the slot edit is the last step again and the row shows no filament.
tap("Undo Assign filament")
find(f"Undo {SLOT_LABEL}", timeout=30)
find("Redo Assign filament")
assert not badge_under("cube.stl", name, timeout=3), "The undone assignment still shows on the cube's row"

# The new slot's colour, from its swatch: one more slicing configuration step (it ends the redo).
tap("Prepare")
tap("Palette colour 5", timeout=30)
find("Colour (#rrggbb)", timeout=20)
assert colour_field() == "#cccccc", colour_field()
tap("#2196f3")
assert colour_field() == "#2196f3", colour_field()
tap("Apply")
absent("Apply")
tap("Project")
find(f"Undo {SLOT_LABEL}", timeout=30)
absent("Redo Assign filament", timeout=30)
tap("Prepare")
tap("Palette colour 5", timeout=30)
# The editor opens on the slot's colour as the project holds it now.
find("Colour (#rrggbb)", timeout=20)
assert colour_field() == "#2196f3", colour_field()
screen.key(4)
print("Filament smoke passed")
