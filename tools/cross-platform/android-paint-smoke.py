#!/usr/bin/env python3
"""Drive the Workspace's paint tool on an explicitly selected emulator.

The app's data is cleared. A cube is added from the Project area's Add menu
and selected (Select All: the paint tool, as the browser's, wants a selected
instance). In the Workspace the toolbar's Paint opens the paint panel
("Colour painting") once the core enables it; the palette row numbered 2 — a
non-default filament of the default profile — is chosen from a hardware
keyboard's 2, as the browser's shortcut chooses it ("Paint colour: …").

First the cube's own colour: the Project area's selection filament bar (the
project's filaments, as the browser's) assigns the cube to head 2, one
"Assign filament" step, and the Workspace draws the whole cube anew in that
filament's colour, as the browser draws a model in its filament; undo
returns it to how it was drawn.

Then a drag across the cube paints it: the Workspace's pixels over the cube
change, in the colour the assigned cube was drawn in (the same filament, the
same shading). The stroke is one step, "Paint colour facets"; its undo in the
Project area returns the cube to how it was drawn, and offers it again as a
redo. Done closes the panel.

Pixel checks stay modest and relative: the default profile's 270 mm U1 plate
draws a 20 mm cube a few hundred pixels large on a 720x1280 screen, and the
panel covers the Workspace's foot, so only the band above it is compared.
Lessons kept from earlier smokes: an import selects nothing, an action on the
selection waits until the core enables it, rows are found by their text.
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
KEY_2 = 9

screen = Screen(args.serial, output, "paint")
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


def until_enabled(text, timeout=30):
    deadline = time.monotonic() + timeout
    while not screen.enabled(text):
        assert time.monotonic() < deadline, f"'{text}' never became enabled"
        time.sleep(1)


def bounds(node):
    import re
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def colour(image, pixels):
    """The mean colour of [pixels] in [image]."""
    _, _, rows = image
    total = [0, 0, 0]
    for x, y in pixels:
        for channel in range(3):
            total[channel] += rows[y][x * 4 + channel]
    return tuple(round(value / max(1, len(pixels))) for value in total)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
tap("Workspace")
time.sleep(4)
empty = screen.screenshot()

# A cube on the bed, selected.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
menu("Edit", "Select All")
tap("Workspace")
time.sleep(4)
drawn = screen.screenshot()
cube = changed_pixels(empty, drawn, 0, 260, width, height - 220)
assert len(cube) > 300, "The cube was not drawn on the bed"
left, right = min(x for x, _ in cube), max(x for x, _ in cube)
top, bottom = min(y for _, y in cube), max(y for _, y in cube)

# The toolbar's Paint, once the core enables it for the selected instance.
until_enabled("Paint")
tap("Paint")
find("Colour painting", timeout=20)
panel = bounds(find("Colour painting"))
# The panel's card begins above its title; the band above it shows the Workspace.
band = panel[1] - 40
assert (top + bottom) // 2 < band, f"The cube ({top}-{bottom}) is hidden by the paint panel ({band})"
# Row 2 from the keyboard, as the browser's `2` chooses it, once the palette shows it.
find("· key 2", exact=False, timeout=20)
screen.key(KEY_2)
find("Paint colour:", exact=False, timeout=20)
time.sleep(1)
before = screen.screenshot()
shown = [(x, y) for x, y in cube if y < band]

# The cube assigned to head 2 draws in that filament's colour; undo takes it back.
tap("Project")
chip = find("Head 2 · ", exact=False, timeout=30)
tap(chip.get("content-desc") or chip.get("text"))
find("Undo Assign filament", timeout=30)
tap("Workspace")
find("Colour painting", timeout=20)
time.sleep(4)
assigned = screen.screenshot()
recoloured = changed_pixels(before, assigned, 0, 260, width, band)
assert len(recoloured) > len(shown) // 2, f"Assigning a filament recoloured {len(recoloured)} of {len(shown)} pixels"
print(f"Assigned: {len(recoloured)} pixels now {colour(assigned, recoloured)}, were {colour(before, recoloured)}")
tap("Project")
tap("Undo Assign filament")
find("Redo Assign filament", timeout=30)
tap("Workspace")
find("Colour painting", timeout=20)
time.sleep(4)
restored = changed_pixels(before, screen.screenshot(), 0, 260, width, band)
assert len(restored) < max(10, len(recoloured) // 5), f"Undo left {len(restored)} of {len(recoloured)} recoloured pixels"

# A drag across the cube paints it.
y = min((top + bottom) // 2, band - 10)
start, end = left + (right - left) // 4, right - (right - left) // 4
adb("shell", "input", "swipe", str(start), str(y), str(end), str(y), "1200")
find("Painted colour facets.", timeout=30)
time.sleep(3)
after = screen.screenshot()
painted = changed_pixels(before, after, 0, 260, width, band)
assert len(painted) > 40, f"Painting changed only {len(painted)} pixels"
gained = colour(after, painted)
print(f"Painted {len(painted)} pixels; their colour is now {gained}, was {colour(before, painted)}")
# Paint in filament 2 draws as the cube assigned to filament 2 was drawn.
expected = colour(assigned, painted)
assert all(abs(a - b) <= 12 for a, b in zip(gained, expected)), f"Paint draws {gained}, the assigned cube {expected}"

# One step with the browser's label; undo takes the paint back.
tap("Project")
find("Undo Paint colour facets", timeout=30)
tap("Undo Paint colour facets")
find("Redo Paint colour facets", timeout=30)
tap("Workspace")
find("Colour painting", timeout=20)
time.sleep(4)
undone = screen.screenshot()
left_over = changed_pixels(before, undone, 0, 260, width, band)
assert len(left_over) < max(10, len(painted) // 5), f"Undo left {len(left_over)} of {len(painted)} painted pixels"

# Done leaves the paint tool: the toolbar's Paint is back.
tap("Done")
find("Paint", timeout=20)
print("Paint smoke passed")
