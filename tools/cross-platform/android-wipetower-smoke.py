#!/usr/bin/env python3
"""Drive the browser's wipe-tower auto-placement on an explicitly selected emulator.

The app's data is cleared and a cube added from the Project area's Add menu. The Edit menu's Auto-place
Wipe Tower (the browser's Tools menu entry) places the active plate's tower where it has the most room
around its printed footprint: one "Auto-place wipe tower" step and the browser's "Auto-placed wipe
tower."; undo takes it back. The command palette's entry does the same. In Prepare, the Process section's
"Auto-position wipe tower" switch (the browser's Process card checkbox) places it when switched on —
the browser's "Auto-position wipe tower enabled." beneath it — and says it is disabled when switched off,
leaving the tower where it is.

Lessons kept from the earlier smokes: the Edit menu outgrows a phone's height and is scrolled to its
item; the palette opens with Ctrl+K from a hardware keyboard, its field taking the typing.
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
ADDED = "Undo Add cube.stl"
PLACED = "Undo Auto-place wipe tower"
SWITCH = "Auto-position wipe tower"
CTRL, K, ENTER = "113", "39", 66
SEARCH = "Search every action"
MENU = ("Select All", "Deselect All", "Clone Selected", "Delete Selected", "Delete All", "Printable",
        "Set as an individual object", "Lay flat", "Mirror on X", "Mirror on Y", "Mirror on Z", "Reset Rotation",
        "Reset Scale", "Centre on Plate", "Scale to build volume", "Drop to bed", "Auto-arrange Plate",
        "Split to Objects", "Split to Parts", "Simplify (decimate)", "Measure", "Brim Ears",
        "Auto-place Wipe Tower", "Cut", "Copy", "Paste")

screen = Screen(args.serial, output, "wipetower")
adb, find, absent, tap = screen.adb, screen.find, screen.absent, screen.tap


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
        screen.key(4)
        time.sleep(1)


def edit(action, timeout=30):
    """An action from the Project area's Edit menu once the core enables it, its own list scrolled to it."""
    deadline = time.monotonic() + timeout
    while True:
        tap("Edit")
        found = None
        for attempt in range(12):
            nodes = screen.nodes()
            item = next((n for n in nodes if (n.get("text") or "") == action), None)
            if item is not None:
                left, top, right, bottom = bounds(item)
                if top >= 0 and bottom <= height and bottom - top > 20:
                    found = item
                    break
            lists = [n for n in nodes if n.get("scrollable") == "true"
                     and any((child.get("text") or "") in MENU for child in n.iter("node"))]
            assert lists, "The Edit menu did not open"
            left, top, right, bottom = bounds(min(lists, key=lambda n: (bounds(n)[2] - bounds(n)[0]) * (bounds(n)[3] - bounds(n)[1])))
            inset = (bottom - top) // 5
            x = str((left + right) // 2)
            # The menu may open where it was left: back to its first item, then on down to the action.
            start, end = (top + inset, bottom - inset) if attempt < 3 else (bottom - inset, top + inset)
            adb("shell", "input", "swipe", x, str(start), x, str(end), "300")
            time.sleep(0.5)
        assert found is not None, f"'{action}' never showed in the Edit menu"
        if screen.enabled(action):
            x, y = screen.center(found)
            adb("shell", "input", "tap", str(x), str(y))
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)  # Back closes the menu before it is opened again.
        time.sleep(1)


def undo_placement():
    """The Project area's Undo of the placement, back to the cube alone."""
    find(PLACED, timeout=30)
    tap(PLACED)
    find(ADDED, timeout=30)
    absent(PLACED)


def switch():
    """The Process section's switch row (named by its words)."""
    node = find(SWITCH, timeout=60)
    nodes = screen.lift(node)
    return next(n for n in nodes if (n.get("text") or n.get("content-desc") or "") == SWITCH)


def switched_on():
    """Whether the switch is on: its row (the toggleable node around the words) reports it checked."""
    nodes = screen.nodes()
    parents = {child: parent for parent in nodes for child in parent}
    node = next(n for n in nodes if (n.get("text") or n.get("content-desc") or "") == SWITCH)
    while node is not None and node.get("checkable") != "true":
        node = parents.get(node)
    assert node is not None, "The switch row is not checkable"
    return node.get("checked") == "true"


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]

# A cube on the plate.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find(ADDED, timeout=30)

# The Edit menu's Auto-place Wipe Tower: one step, the browser's status; undo takes it back.
edit("Auto-place Wipe Tower")
find(PLACED, timeout=60)
find("Auto-placed wipe tower.", timeout=30)
tap("Dismiss")
undo_placement()

# The command palette's entry does the same.
adb("shell", "input", "keycombination", CTRL, K)
find(SEARCH, timeout=20)
time.sleep(1)
adb("shell", "input", "text", "wipe%stower")
find("Auto-place Wipe Tower", timeout=20)
find("Automatically position the wipe tower", timeout=20)
screen.key(ENTER)
tap("Project")
find("Auto-placed wipe tower.", timeout=60)
tap("Dismiss")
undo_placement()

# Prepare's switch, off as the browser's starts: on places the tower and says so beneath it; off says so
# and leaves the tower where it is.
tap("Prepare")
switch()
assert not switched_on(), "Auto-position wipe tower was on before it was switched"
adb("shell", "input", "tap", *map(str, screen.center(switch())))
find("Auto-position wipe tower enabled.", timeout=60)
assert switched_on(), "The switch did not show as on"
tap("Project")
find(PLACED, timeout=30)
tap("Prepare")
adb("shell", "input", "tap", *map(str, screen.center(switch())))
find("Auto-position wipe tower disabled.", timeout=60)
assert not switched_on(), "The switch did not show as off"
tap("Project")
find(PLACED, timeout=30)
print("Wipe tower smoke passed")
