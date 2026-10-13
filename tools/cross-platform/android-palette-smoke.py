#!/usr/bin/env python3
"""Drive the command palette, the Workspace's toolbar, the scene's context menus and hover on an explicitly selected emulator.

The app's data is cleared. Ctrl+K from a hardware keyboard opens the browser's
command palette over the Workspace; "zzzz" finds nothing ("No matching
actions") and Escape closes it; "cube" finds the Add menu's Cube with its hint
("Add a 20 mm cube"), which Enter runs: the palette closes and the cube lands
on the bed as one "Add cube.stl" step. A long press on the cube opens the
scene's context menu in the browser's sections (EDIT, then SCENE); its Clone
Selected is one "Create instance" step. The model toolbar ("Model tools")
deletes the selected copy with its Delete: "Delete instance". A long press on
the bare plate opens the plate's menu (FILE, …, Select All), which Back closes.
"top view" and Enter turn the Workspace's camera to the View menu's Top View.
Escape deselects all, which the core answers by disabling the toolbar's
Delete; a mouse over it (adb's `input mouse`: Compose takes a mouse's first
event as the pointer entering) shows its tooltip, the browser's reason:
"Select a model instance for this action." The palette's Slice (found by its
hint, which a row shows only while it is enabled: Prepare's rule, not the
core's) runs a local slice as Prepare's Slice does — Prepare shows, the plate
slices on this device's engine and Preview opens it — and its Send to Printer
then says why it waits: no printer is connected (the app's own words, where
the core would have said "Slice successfully first."); Enter leaves it open
with "Send to Printer: …", and Escape closes it.

A tooltip is a popup window of its own, outside the active window a plain
uiautomator dump reads: the smoke dumps every window (`--windows`) and, where
uiautomator cannot, looks for the tooltip's fresh pixels under the button.
adb cannot press a mouse's right button, so the secondary click that opens the
same menus is not driven; a long press runs the same code from there. Lessons
kept from the earlier smokes: an undo label is read in the Project area; an
action on the selection waits until the core enables it; the bed is the
default profile's 270 mm plate, so pixel counts stay modest.
"""
import argparse
import re
import subprocess
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
CTRL, K, ENTER, ESCAPE, BACK = "113", "39", 66, 111, 4
SEARCH = "Search every action"
NEEDS_INSTANCE = "Select a model instance for this action."
SLICE_HINT = "Slice the plated models to G-code"
CONNECT_FIRST = "Connect to a printer in the Device area to send this plate."

screen = Screen(args.serial, output, "palette")
adb, find, tap, absent = screen.adb, screen.find, screen.tap, screen.absent


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def shown(text):
    """Whether a node shows [text] or is named by it."""
    return any(text in ((n.get("text") or ""), (n.get("content-desc") or "")) for n in screen.nodes())


def palette(query):
    """Ctrl+K, then [query] typed into the palette's field (which has the focus as the palette opens)."""
    adb("shell", "input", "keycombination", CTRL, K)
    find(SEARCH, timeout=20)
    time.sleep(1)
    adb("shell", "input", "text", query.replace(" ", "%s"))
    time.sleep(1)


def closed(timeout=20):
    deadline = time.monotonic() + timeout
    while shown(SEARCH):
        assert time.monotonic() < deadline, "The palette did not close"
        time.sleep(0.5)


def tool(description, timeout=30):
    """The model toolbar's button described as [description], the toolbar dragged sideways until it shows."""
    deadline = time.monotonic() + timeout
    while True:
        nodes = screen.nodes()
        node = next((n for n in nodes if (n.get("content-desc") or "") == description), None)
        if node is not None and bounds(node)[2] - bounds(node)[0] > 30 and bounds(node)[2] <= width:
            return node
        assert time.monotonic() < deadline, f"The toolbar's {description} never showed"
        bar = next(n for n in nodes if (n.get("content-desc") or "") == "Model tools")
        left, top, right, bottom = bounds(bar)
        y = str((top + bottom) // 2)
        adb("shell", "input", "swipe", str(right - 140), y, str(left + 140), y, "400")
        time.sleep(0.5)


def until_enabled(text, enabled=True, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        if text == "Delete":
            tool(text, timeout=10)
        try:
            if screen.enabled(text, timeout=2) == enabled:
                return
        except AssertionError:
            pass
        assert time.monotonic() < deadline, f"'{text}' never became {'enabled' if enabled else 'disabled'}"
        time.sleep(1)


def long_press(x, y):
    """A finger held still for 1.5 s."""
    adb("shell", "input", "swipe", str(x), str(y), str(x), str(y), "1500")


def windows():
    """Every window's nodes as uiautomator dumps them, or None where it cannot dump them all."""
    dump = "/data/local/tmp/orcaxr-palette-windows.xml"
    adb("shell", "rm", "-f", dump)
    listed = subprocess.run(["adb", "-s", args.serial, "shell", "uiautomator", "dump", "--windows", dump],
                            capture_output=True, text=True, timeout=120)
    read = subprocess.run(["adb", "-s", args.serial, "shell", "cat", dump], capture_output=True, text=True, timeout=60)
    return read.stdout if listed.returncode == 0 and read.returncode == 0 and "<hierarchy" in read.stdout else None


def tooltip(text, anchor, before, timeout=10):
    """Whether [text] shows as [anchor]'s tooltip: in a dump of every window, or as fresh pixels under it."""
    left, top, right, bottom = bounds(anchor)
    region = (max(0, left - 200), bottom, min(width, right + 200), min(height, bottom + 200))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(1)
        xml = windows()
        if xml is not None:
            if text in xml:
                return True
        elif len(changed_pixels(before, screen.screenshot(), *region)) > 200:
            return True
    return False


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
# Granted up front: the app asks for it once before its first local slice (a system dialog).
adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
tap("Workspace")
find("Model tools", timeout=30)
time.sleep(4)
empty = screen.screenshot()
# The 3D view's pixels below the model toolbar, whose buttons change with the selection.
box = (0, screen.below_toolbar(260), width, height - 220)

# The palette from the keyboard: a search that finds nothing says so, and Escape closes it.
palette("zzzz")
find("No matching actions", timeout=20)
screen.key(ESCAPE)
closed()

# A search for the cube: the Add menu's Cube, with its hint; Enter runs it as one step with the browser's label.
palette("cube")
find("Cube", timeout=20)
find("Add a 20 mm cube", timeout=20)
screen.key(ENTER)
closed()
tap("Project")
find("Undo Add cube.stl", timeout=30)
tap("Workspace")
time.sleep(4)
# Escape deselects the added cube: the transform gizmo leaves it, so the changed pixels are the cube's
# alone, and the long press below meets the cube rather than a handle (a handle takes a press).
screen.key(ESCAPE)
time.sleep(2)
drawn = screen.screenshot()
cube = changed_pixels(empty, drawn, *box)
# A 20 mm cube on the 270 mm plate: a few hundred pixels.
assert len(cube) > 300, f"The cube was not drawn on the bed ({len(cube)} pixels changed)"
x = sum(p[0] for p in cube) // len(cube)
y = sum(p[1] for p in cube) // len(cube)

# A long press on the cube: the scene's menu in the browser's sections; Clone Selected is one step.
long_press(x, y)
find("EDIT", timeout=20)
find("SCENE")
until_enabled("Clone Selected")
tap("Clone Selected")
tap("Project")
find("Undo Create instance", timeout=30)
tap("Workspace")

# The toolbar's Delete deletes the selected copy, once the core enables it for the selection.
until_enabled("Delete")
tap("Delete")
tap("Project")
find("Undo Delete instance", timeout=30)
tap("Workspace")
time.sleep(2)

# A long press on the bare plate: the plate's menu in its sections; Back closes it.
long_press(width // 8, box[3] - 40)
find("FILE", timeout=20)
find("Select All")
screen.key(BACK)
absent("FILE")

# The View menu's Top View from the palette turns the Workspace's camera.
time.sleep(2)
framed = screen.screenshot()
palette("top view")
find("Top View", timeout=20)
screen.key(ENTER)
closed()
time.sleep(3)
assert len(changed_pixels(framed, screen.screenshot(), *box)) > 2000, "Top View did not move the camera"

# Nothing selected: the toolbar's Delete is disabled, and a mouse over it shows why, in the browser's words.
screen.key(ESCAPE)
until_enabled("Delete", enabled=False)
delete = tool("Delete")
before = screen.screenshot()
dx, dy = screen.center(delete)
# adb's mouse cannot hover, only tap, and Compose takes the tap as the pointer entering; the first
# tap after the keyboard's Escape was seen not to show the tooltip on a loaded emulator (a real mouse
# goes on sending hover moves), so the mouse leaves and taps again.
for attempt in range(3):
    if attempt:
        adb("shell", "input", "mouse", "motionevent", "MOVE", str(width // 2), str(height * 3 // 4))
        time.sleep(1)
    adb("shell", "input", "mouse", "tap", str(dx), str(dy))
    if tooltip(NEEDS_INSTANCE, delete, before, timeout=8):
        break
else:
    raise AssertionError("Hovering the toolbar's Delete showed no tooltip")

# The palette's Slice, enabled as Prepare's Slice is: Enter slices the plate on this device's engine, as that button does.
palette("slice the plated")
find(SLICE_HINT, timeout=60)
screen.key(ENTER)
closed()
find("Sliced in Prepare from the project as it stands.", timeout=240)
tap("Prepare")
find("Sliced on this device", timeout=30)
find("SLICED in", exact=False, timeout=30)

# Send to Printer is listed now there is a slice to send, held back by the Device area: no printer is connected.
palette("send to printer")
find(CONNECT_FIRST, timeout=30)
screen.key(ENTER)
find("Send to Printer: " + CONNECT_FIRST, timeout=20)
screen.key(ESCAPE)
closed()
print("Palette smoke passed")
