#!/usr/bin/env python3
"""Drive the transform inspector and the Edit menu's placement actions on an explicitly selected emulator.

The app's data is cleared and a binary STL is placed in Downloads. A cube is imported — centred on the bed,
nothing selected, so no inspector — and Select All selects it: its Move, Rotate and Scale fields show under
the tree. Lay flat from the Edit menu, then a tap on the cube in the Workspace, lays the tapped face on the
bed (the Workspace says how; Done ends the tool), and undo takes it back. A Move X typed in lands with two
decimals and the browser's undo label, "Transform instance"; Centre on Plate brings it back; a Move Z typed
in, then Drop to bed, brings it down again; Rotate Z 90 and Scale X 200 land and undo restores the scale;
Mirror on X negates it. A second cube lands where the first did, leaving nothing selected; Auto-arrange
Plate lays both out as one "Transform 2 instances", which undo takes back.
"""
import argparse
import base64
import json
import re
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

screen = Screen(args.serial, output, "inspector")
adb, find, absent, tap = screen.adb, screen.find, screen.absent, screen.tap
MOVE, ROTATE, SCALE = "Move (mm)", "Rotate (deg)", "Scale (%)"
AXES = ("X", "Y", "Z")
LABEL = "Undo Transform instance"


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def import_cube(objects):
    tap("Import Model…")
    tap("cube.stl", timeout=30)
    find("Import cube.stl?", timeout=30)
    find(f"The project will then have {objects} object(s). Importing is one step you can undo.")
    tap("Import")


MENU = ("Select All", "Deselect All", "Clone Selected", "Delete Selected", "Delete All", "Printable",
        "Set as an individual object", "Lay flat", "Mirror on X", "Mirror on Y", "Mirror on Z", "Reset Rotation",
        "Reset Scale", "Centre on Plate", "Scale to build volume", "Drop to bed", "Auto-arrange Plate")


def edit(action, timeout=60):
    """An action from the Project area's Edit menu. With the placement actions the menu outgrows a phone's
    height, so its own list (the smallest scrolling container holding its items) scrolls to the action."""
    tap("Edit")
    deadline = time.monotonic() + timeout
    swipes = 0
    while True:
        nodes = screen.nodes()
        item = next((n for n in nodes if (n.get("text") or "") == action), None)
        if item is not None:
            left, top, right, bottom = bounds(item)
            if top >= 0 and bottom <= height and bottom - top > 20:
                x, y = screen.center(item)
                adb("shell", "input", "tap", str(x), str(y))
                return
        assert time.monotonic() < deadline, f"'{action}' never showed in the Edit menu"
        lists = [n for n in nodes if n.get("scrollable") == "true"
                 and any((child.get("text") or "") in MENU for child in n.iter("node"))]
        assert lists, "The Edit menu did not open"
        left, top, right, bottom = bounds(min(lists, key=lambda n: (bounds(n)[2] - bounds(n)[0]) * (bounds(n)[3] - bounds(n)[1])))
        # The menu may open where it was left: back to its first item, then on down to the action.
        inset = (bottom - top) // 5
        x = str((left + right) // 2)
        start, end = (top + inset, bottom - inset) if swipes < 3 else (bottom - inset, top + inset)
        swipes += 1
        adb("shell", "input", "swipe", x, str(start), x, str(end), "300")
        time.sleep(0.5)


def described(title, axis, nodes):
    """The inspector field [axis] of tool [title] among [nodes]: the text field described as
    "<title> <axis>", else the tool's fields in order after its title; None when not shown."""
    # The description sits on a node inside the text field (Compose reports the field around it, with
    # the same bounds), or around it.
    fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]

    def text_field(node):
        around = next((f for f in fields if f.get("bounds") == node.get("bounds")), None)
        if around is not None:
            return around
        return next((c for c in node.iter("node") if c.get("class") == "android.widget.EditText"), node)

    found = [text_field(n) for n in nodes if n.get("content-desc") == f"{title} {axis}"]
    if not found:
        heading = next((i for i, n in enumerate(nodes) if (n.get("text") or "") == title), None)
        after = [n for n in nodes[heading + 1:] if n.get("class") == "android.widget.EditText"] if heading is not None else []
        found = after[AXES.index(axis):AXES.index(axis) + 1]
    return found[0] if found else None


def field(title, axis, timeout=20):
    """The inspector field [axis] of tool [title], scrolled wholly into the screen's scrolling
    part. That part ends where the area bar begins, and the bar's height depends on the window
    and the text size (it wraps the areas' names onto more rows), so the field is placed by the
    container's own bounds, and the swipe stays inside it."""
    deadline = time.monotonic() + timeout
    while True:
        find(title)
        nodes = screen.nodes()
        node = described(title, axis, nodes)
        containers = [bounds(n) for n in nodes if n.get("scrollable") == "true"]
        left, top, right, bottom = max(containers, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])) if containers else (0, 0, width, height)
        shift = (bottom - top) // 3
        if node is not None:
            _, field_top, _, field_bottom = bounds(node)
            if field_bottom - field_top > 40 and field_top >= top and field_bottom <= bottom:
                return node
            # Above the scrolling part: bring the content down instead.
            if field_top < top:
                shift = -shift
        assert time.monotonic() < deadline, f"The {title} {axis} field never showed"
        x = str((left + right) // 2)
        start_y = bottom - (bottom - top) // 6 if shift > 0 else top + (bottom - top) // 6
        adb("shell", "input", "swipe", x, str(start_y), x, str(start_y - shift), "300")
        time.sleep(0.5)


def value(title, axis):
    return field(title, axis).get("text") or ""


def until_value(title, axis, expected, timeout=30):
    deadline = time.monotonic() + timeout
    while (shown := value(title, axis)) != expected:
        assert time.monotonic() < deadline, f"{title} {axis} shows '{shown}', never '{expected}'"
        time.sleep(0.5)


def type_field(title, axis, text, expected):
    """Types [text] into a field and presses Enter — the browser's change — then leaves the field
    and waits for the selection's value, [expected], with the browser's two decimals. Enter commits whatever the
    field holds, so the field must show exactly [text] first. On a loaded emulator Ctrl+A can
    arrive without its Ctrl, and the tap's caret can land after a Move End sent to follow it,
    so the old digits survive around the caret: the field is emptied on both sides of the caret
    instead — a Forward Delete and a Backspace per character it shows (the field consumes the
    spare ones: a Forward Delete it does not use would delete the model) — and typed again until
    it reads right. Once the keyboard is up nothing scrolls: a swipe could land on the keyboard."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    def held():
        node = described(title, axis, screen.nodes())
        return "" if node is None else node.get("text") or ""

    seen = []
    for attempt in range(3):
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
        seen.append(held())
        if seen[-1] == text:
            break
        screen.hide_keyboard()
    else:
        png = subprocess.check_output(["adb", "-s", args.serial, "exec-out", "screencap", "-p"], timeout=60)
        (output / f"inspector-{title.split()[0].lower()}-{axis}-typing.png").write_bytes(png)
        raise AssertionError(f"Could not type '{text}' into {title} {axis}; it showed {seen}")
    screen.key(66)
    # Enter changes the field, which keeps the focus and its typing (the browser's input does); Tab
    # leaves it, so it shows the selection's value.
    screen.key(61)
    screen.hide_keyboard()
    until_value(title, axis, expected)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
cube = json.loads((ROOT / "testdata/cross-platform/model-import-vectors.json").read_text())
cube_bytes = next(case for case in cube["cases"] if case["name"] == "stl-binary/cube")["bytesBase64"]
staged = Path(tempfile.mkdtemp(prefix="orcaxr-inspector-smoke-")) / "cube.stl"
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

# A cube: the import selects nothing, so no inspector; Select All shows its fields.
tap("Project")
find("Untitled project", timeout=30)
import_cube(1)
find("1 object", timeout=30)
absent(MOVE)
edit("Select All")
x0, y0, z0 = (value(MOVE, axis) for axis in AXES)
assert all(re.fullmatch(r"-?\d+\.\d\d", v) for v in (x0, y0, z0)), f"Move shows {x0}, {y0}, {z0}"
assert [value(ROTATE, axis) for axis in AXES] == ["0.00"] * 3, "An imported cube is not rotated"
assert [value(SCALE, axis) for axis in AXES] == ["100.00"] * 3, "An imported cube is at 100 %"

# Lay flat: the Edit menu's tool, then a tap on the cube in the Workspace lays the tapped face on the bed.
tap("Workspace")
time.sleep(4)
model = changed_pixels(empty, screen.screenshot(), *box)
# A 20 mm cube on the default profile's 270 mm bed: a few hundred pixels.
assert len(model) > 300, f"The selected model was not drawn ({len(model)} pixels changed)"
x = sum(p[0] for p in model) // len(model)
y = sum(p[1] for p in model) // len(model)
tap("Project")
edit("Lay flat")
tap("Workspace")
find("Lay flat: click the facet that should rest on the bed.", timeout=20)
adb("shell", "input", "tap", str(x), str(y))
time.sleep(2)
tap("Done")
absent("Lay flat: click the facet that should rest on the bed.")
tap("Project")
find(LABEL, timeout=30)
turned = [value(ROTATE, axis) for axis in AXES]
assert turned != ["0.00"] * 3, "Laying a face flat did not turn the cube"
tap(LABEL)
for axis in AXES:
    until_value(ROTATE, axis, "0.00")

# Move X lands, as the browser shows it; Centre on Plate brings the cube back.
type_field(MOVE, "X", "50", "50.00")
find(LABEL, timeout=30)
edit("Centre on Plate")
until_value(MOVE, "X", x0)
# Raised, then dropped to the bed.
type_field(MOVE, "Z", "20", "20.00")
edit("Drop to bed")
until_value(MOVE, "Z", z0)
# Rotate 90° about Z, scale X to 200 %, and undo the scale.
type_field(ROTATE, "Z", "90", "90.00")
type_field(SCALE, "X", "200", "200.00")
tap(LABEL)
until_value(SCALE, "X", "100.00")
assert value(ROTATE, "Z") == "90.00", "Undo took back more than the scale"
# Mirror on X: a negative scale, one more step.
edit("Mirror on X")
until_value(SCALE, "X", "-100.00")
find(LABEL)

# A second cube lands on the first and leaves nothing selected; Auto-arrange lays both out as one step.
import_cube(2)
find("2 objects", timeout=30)
absent(MOVE)
edit("Auto-arrange Plate")
find("Undo Transform 2 instances", timeout=30)
tap("Undo Transform 2 instances")
absent("Undo Transform 2 instances")
find("2 objects")
print("Inspector smoke passed")
