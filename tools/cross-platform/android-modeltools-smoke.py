#!/usr/bin/env python3
"""Drive the browser's model tools on an explicitly selected emulator: split, simplify and measure.

The app's data is cleared and a binary STL of two separate 10 mm cubes (one mesh, two bodies) is placed in
Downloads. Imported, selected with Select All, it splits to parts — the object then has "2 parts", one
"Split volume to parts" — and undo takes it back; it splits to objects after the browser's confirmation —
"2 objects", one "Split to objects", the flow's status — and undo takes that back. A sphere from the Add
menu (selected as it lands) is previewed in the Simplify panel — the preview's triangle counts, drawn in
the Workspace with Apply and Cancel — and applied there: fewer triangles, one "Replace mesh topology",
undone with the sphere. A 20 mm cube from the Add menu, moved 40 mm along X in the inspector, stands beside
the cubes; the Measure tool (the Edit menu's) then picks the cube's top and a 10 mm cube's top with two
taps in the Workspace, and the readout says they are 10 mm apart.

Lessons kept from the earlier smokes: an import selects nothing; an action acting on the selection waits
until the core enables it; rows are found by their text; the Edit menu outgrows a phone's height and is
scrolled to its item; a field is typed into only once it shows exactly the new text.
"""
import argparse
import re
import struct
import subprocess
import tempfile
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

screen = Screen(args.serial, output, "modeltools")
adb, find, absent, tap = screen.adb, screen.find, screen.absent, screen.tap
MOVE = "Move (mm)"


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def box(origin, size):
    """An axis-aligned box's twelve outward-wound triangles."""
    corners = [[origin[k] + c[k] * size for k in range(3)] for c in
               [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (3, 7, 6), (3, 6, 2), (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5)]
    return [[corners[i] for i in face] for face in faces]


def binary_stl(triangles):
    data = bytearray(80) + struct.pack("<I", len(triangles))
    for triangle in triangles:
        data += struct.pack("<3f", 0, 0, 0)
        for vertex in triangle:
            data += struct.pack("<3f", *vertex)
        data += struct.pack("<H", 0)
    return bytes(data)


MENU = ("Select All", "Deselect All", "Clone Selected", "Delete Selected", "Delete All", "Printable",
        "Set as an individual object", "Lay flat", "Mirror on X", "Mirror on Y", "Mirror on Z", "Reset Rotation",
        "Reset Scale", "Centre on Plate", "Scale to build volume", "Drop to bed", "Auto-arrange Plate",
        "Split to Objects", "Split to Parts", "Simplify (decimate)", "Measure", "Cut", "Copy", "Paste")


def edit(action, timeout=30):
    """An action from the Project area's Edit menu once the core enables it, its own list scrolled to it."""
    deadline = time.monotonic() + timeout
    while True:
        tap("Edit")
        found = None
        for _ in range(8):
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
            adb("shell", "input", "swipe", x, str(bottom - inset), x, str(top + inset), "300")
            time.sleep(0.5)
        assert found is not None, f"'{action}' never showed in the Edit menu"
        if screen.enabled(action):
            x, y = screen.center(found)
            adb("shell", "input", "tap", str(x), str(y))
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)  # Back closes the menu before it is opened again.
        time.sleep(1)


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


def described(title, axis, nodes):
    """The inspector field [axis] of tool [title] among [nodes]: the text field described as "<title> <axis>"."""
    fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]

    def text_field(node):
        around = next((f for f in fields if f.get("bounds") == node.get("bounds")), None)
        if around is not None:
            return around
        return next((c for c in node.iter("node") if c.get("class") == "android.widget.EditText"), node)

    found = [text_field(n) for n in nodes if n.get("content-desc") == f"{title} {axis}"]
    return found[0] if found else None


def field(title, axis, timeout=20):
    """The inspector field [axis] of tool [title], scrolled clear of the bottom bar."""
    deadline = time.monotonic() + timeout
    while True:
        find(title)
        node = described(title, axis, screen.nodes())
        if node is not None:
            left, top, right, bottom = bounds(node)
            if bottom - top > 40 and bottom < height - 260:
                return node
        assert time.monotonic() < deadline, f"The {title} {axis} field never showed"
        adb("shell", "input", "swipe", "360", "900", "360", "600", "300")
        time.sleep(0.5)


def value(title, axis):
    return field(title, axis).get("text") or ""


def type_field(title, axis, text, timeout=30):
    """Types [text] into a field (emptied on both sides of the caret first) and presses Enter, the
    browser's change; then waits for the field to show the moved instance's two-decimal value."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")

    def held():
        node = described(title, axis, screen.nodes())
        return "" if node is None else node.get("text") or ""

    for _ in range(3):
        x, y = screen.center(field(title, axis))
        adb("shell", "input", "tap", str(x), str(y))
        deadline = time.monotonic() + 3
        while not shown() and time.monotonic() < deadline:
            time.sleep(0.2)
        time.sleep(1)
        count = len(held()) + 1
        adb("shell", "input", "keyevent", *(["112"] * count), *(["67"] * count))
        adb("shell", "input", "text", text)
        time.sleep(0.3)
        if held() == text:
            break
        screen.hide_keyboard()
    else:
        raise AssertionError(f"Could not type '{text}' into {title} {axis}")
    screen.key(66)
    screen.hide_keyboard()
    expected = f"{float(text):.2f}"
    deadline = time.monotonic() + timeout
    while value(title, axis) != expected:
        assert time.monotonic() < deadline, f"{title} {axis} never showed {expected}"
        time.sleep(0.5)


def panel_button(text, timeout=30):
    """The Simplify panel's button showing [text]: not the navigation's item of the same name (the bar
    along the bottom of a phone's screen), the list scrolled until the button shows above it."""
    deadline = time.monotonic() + timeout
    while True:
        nodes = screen.nodes()
        found = [n for n in nodes if (n.get("text") or "") == text and bounds(n)[3] < height - 230]
        if found:
            node = found[0]
            parents = {child: parent for parent in nodes for child in parent}
            while node is not None and node.get("clickable") != "true":
                node = parents.get(node)
            if node is not None:
                return node
        assert time.monotonic() < deadline, f"The panel's '{text}' never showed"
        adb("shell", "input", "swipe", "360", "900", "360", "600", "300")
        time.sleep(0.5)


def top_of(pixels):
    """A tap point on a box's top face: the middle of the cluster, a third of the way down its height
    (the camera looks down on the plate, so a box's top is the upper part of what it draws)."""
    xs = sorted(p[0] for p in pixels)
    ys = [p[1] for p in pixels]
    return xs[len(xs) // 2], min(ys) + (max(ys) - min(ys)) // 3


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
staged = Path(tempfile.mkdtemp(prefix="orcaxr-modeltools-smoke-")) / "pair.stl"
staged.write_bytes(binary_stl(box((0, 0, 0), 10) + box((15, 0, 0), 10)))
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
adb("shell", "rm", "-f", "/sdcard/Download/pair.stl")
adb("push", str(staged), "/sdcard/Download/pair.stl")
staged.unlink()
staged.parent.rmdir()
adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:///sdcard/Download/pair.stl")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
area = (0, 260, width, height - 220)
tap("Workspace")
time.sleep(4)
empty = screen.screenshot()

# Two bodies in one mesh: the import selects nothing, Select All selects it.
tap("Project")
find("Untitled project", timeout=30)
tap("Import Model…")
tap("pair.stl", timeout=30)
find("Import pair.stl?", timeout=30)
tap("Import")
find("1 object", timeout=30)
find("1 part, 1 instance")
edit("Select All")

# Split to Parts: one step, the object now has two parts; undo takes it back.
edit("Split to Parts")
find("Undo Split volume to parts", timeout=30)
find("Split object into parts in one undoable edit.")
find("2 parts, 1 instance")
tap("Undo Split volume to parts")
find("1 part, 1 instance", timeout=30)
absent("Undo Split volume to parts")

# Split to Objects: the browser's confirmation first, then one step; undo takes it back.
edit("Select All")
edit("Split to Objects")
find("into separate objects?", timeout=30, exact=False)
find("triangles will be separated by connected body across all 1 instance.", exact=False)
tap("OK")
find("Undo Split to objects", timeout=30)
find("into 2 objects across all 1 instance in one undoable edit.", exact=False)
find("2 objects")
tap("Undo Split to objects")
find("1 object", timeout=30)
absent("Undo Split to objects")

# Simplify a sphere: previewed in the panel and drawn in the Workspace, then applied there.
menu("Add", "Sphere")
find("Undo Add sphere.stl", timeout=30)
tap("Simplify")
find("Preview shows the result on the model; nothing is changed until you apply.", timeout=30)
deadline = time.monotonic() + 30
while panel_button("Preview").get("enabled") != "true":
    assert time.monotonic() < deadline, "Preview never became enabled for the selected sphere"
    time.sleep(1)
adb("shell", "input", "tap", *map(str, screen.center(panel_button("Preview"))))
status = find("Previewing 1 part(s): ", timeout=60, exact=False).get("text")
counts = re.search(r"Previewing 1 part\(s\): (\d+) → (\d+) triangles \(50% removed\)\.", status)
assert counts, f"The preview said {status!r}"
before, after = map(int, counts.groups())
assert 0 < after < before, f"The preview kept {after} of {before} triangles"
tap("Workspace")
find(f"Previewing 1 part(s): {before} → {after} triangles (50% removed).", timeout=30)
tap("Apply")
tap("Project")
find(f"Simplified 1 part(s): {before} → {after} triangles. Painting was reset; undo restores both.", timeout=60)
find("Undo Replace mesh topology")
tap("Undo Replace mesh topology")
find("Undo Add sphere.stl", timeout=30)
tap("Undo Add sphere.stl")
find("1 object", timeout=30)

# Measure: a 20 mm cube moved beside the 10 mm cubes, then the two tops picked in the Workspace.
tap("Workspace")
time.sleep(4)
cubes = screen.screenshot()
tap("Project")
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
x0 = float(value(MOVE, "X"))
type_field(MOVE, "X", f"{x0 + 40:.2f}")
tap("Workspace")
time.sleep(4)
both = screen.screenshot()
pair = set(changed_pixels(empty, cubes, *area))
cube = [p for p in changed_pixels(empty, both, *area) if p not in pair]
assert len(pair) > 100 and len(cube) > 100, f"The models were not drawn apart ({len(pair)} and {len(cube)} pixels)"
middle = (min(p[0] for p in pair) + max(p[0] for p in pair)) // 2
left = [p for p in pair if p[0] < middle]
tap("Project")
edit("Measure")
tap("Workspace")
find("Measure: click two features (a face, edge, corner, or hole).", timeout=30)
find("Click the first feature to measure from.")
for point in (top_of(cube), top_of(left)):
    adb("shell", "input", "tap", *map(str, point))
    time.sleep(2)
find("Click another feature to start a new measurement.", timeout=30)
find("Distance (to line/plane)", timeout=30)
find("10 mm")
png = subprocess.check_output(["adb", "-s", args.serial, "exec-out", "screencap", "-p"], timeout=60)
(output / "modeltools-measure.png").write_bytes(png)
tap("Clear")
find("Measurement cleared.", timeout=30)
absent("10 mm")
tap("Done")
absent("Click the first feature to measure from.")
print("Model tools smoke passed")
