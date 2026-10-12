#!/usr/bin/env python3
"""Drive the Workspace's transform gizmo on an explicitly selected emulator.

The app's data is cleared and a cube added from the Project area's Add menu;
Select All selects it. In the Workspace the gizmo stands over it, drawn as
three.js's TransformControls draws it: the Move tool's arrows, the X arrow
red. A drag on the red arrow moves the cube along the bed's X: one undo entry,
"Transform instance", however many moves the finger made — one undo takes the
whole drag back and the cube is drawn where it was. The keys choose the tool
as the browser's G, R and S do (the toolbar shows which): R the rings,
whose green one turns the cube about the bed's vertical — again one step;
S the scale handles; G the arrows again.

The handles are found by colour among the pixels that differ from the empty
Workspace (the bed's own lines never count), and dragged with paced touch
events, as `smoke_ui.drag` drags a list.
"""
import argparse
import math
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
LABEL = "Undo Transform instance"
ADDED = "Undo Add cube.stl"
KEY_G, KEY_R, KEY_S = 35, 46, 47

screen = Screen(args.serial, output, "gizmo")
adb, find, absent, tap = screen.adb, screen.find, screen.absent, screen.tap


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


def handle(before, after, box, colour):
    """The pixels of the gizmo drawn in [colour] ("red", "green" or "blue": that channel full, the others
    low) that selecting the cube changed, inside [box]."""
    channel = ("red", "green", "blue").index(colour)
    _, _, rows = after
    pixels = []
    for x, y in changed_pixels(before, after, *box):
        rgb = rows[y][x * 4:x * 4 + 3]
        if rgb[channel] >= 200 and all(rgb[c] <= 70 for c in range(3) if c != channel):
            pixels.append((x, y))
    return pixels


def ends(pixels):
    """The two far ends of a handle's pixels: the one farthest from their centre, then the one farthest from that."""
    cx = sum(p[0] for p in pixels) / len(pixels)
    cy = sum(p[1] for p in pixels) / len(pixels)
    first = max(pixels, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
    second = max(pixels, key=lambda p: (p[0] - first[0]) ** 2 + (p[1] - first[1]) ** 2)
    return first, second


def near(pixels, point, radius):
    """The centre of the [pixels] within [radius] of [point]."""
    close = [p for p in pixels if (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2 <= radius ** 2]
    return sum(p[0] for p in close) // len(close), sum(p[1] for p in close) // len(close)


def drag(x0, y0, x1, y1, steps=6):
    """A finger from ([x0], [y0]) to ([x1], [y1]) in paced steps, resting before it lifts."""
    events = [f"input motionevent DOWN {x0} {y0}"]
    events += [f"input motionevent MOVE {x0 + (x1 - x0) * i // steps} {y0 + (y1 - y0) * i // steps}" for i in range(1, steps + 1)]
    events += ["sleep 0.3", f"input motionevent UP {x1} {y1}"]
    adb("shell", "; sleep 0.08; ".join(events))


def checked(description):
    """Whether the toolbar's toggle described as [description] is on."""
    node = find(description, timeout=20)
    return node.get("checked") == "true"


def until_checked(description, timeout=20):
    deadline = time.monotonic() + timeout
    while not checked(description):
        assert time.monotonic() < deadline, f"The toolbar's {description} never showed as the tool"
        time.sleep(0.5)


def settled(box, timeout=20):
    """A screenshot once the Workspace stops changing (the drag's last edit drawn)."""
    deadline = time.monotonic() + timeout
    last = screen.screenshot()
    while True:
        time.sleep(1)
        now = screen.screenshot()
        if len(changed_pixels(last, now, *box)) < 20 or time.monotonic() > deadline:
            return now
        last = now


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]

# The empty Workspace: what the gizmo's colours are told against. Move is the tool.
tap("Workspace")
time.sleep(4)
box = (0, screen.below_toolbar(260), width, height - 220)
empty = settled(box)
until_checked("Move")

# A cube, selected: the gizmo stands over it, Move's arrows, the X arrow red.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find(ADDED, timeout=30)
menu("Edit", "Select All")
tap("Workspace")
time.sleep(3)
selected = settled(box)
red = handle(empty, selected, box, "red")
assert len(red) > 40, f"The gizmo's red X arrow was not drawn ({len(red)} pixels)"
assert len(handle(empty, selected, box, "green")) > 40, "The gizmo's green arrow was not drawn"
(ax, ay), (bx, by) = ends(red)
# Press the arrowhead at one end, then drag on outwards along the arrow.
px, py = near(red, (ax, ay), 25)
length = math.hypot(ax - bx, ay - by)
dx, dy = (ax - bx) / length, (ay - by) / length
drag(px, py, int(px + dx * 120), int(py + dy * 120))
moved = settled(box)
assert len(changed_pixels(selected, moved, *box)) > 200, "Dragging the X arrow moved nothing"

# The drag is one step: one undo takes all of it back, and the cube is drawn where it was.
tap("Project")
find(LABEL, timeout=30)
tap(LABEL)
find(ADDED, timeout=30)
tap("Workspace")
time.sleep(2)
back = settled(box)
assert len(changed_pixels(selected, back, *box)) < 120, "One undo did not take the whole drag back"

# R chooses Rotate: the toolbar says so and the rings stand over the cube; the green one turns it about the bed's vertical.
screen.key(KEY_R)
until_checked("Rotate")
assert not checked("Move"), "Move stayed the tool after R"
rings = settled(box)
green = handle(empty, rings, box, "green")
assert len(green) > 40, f"The rotate gizmo's green ring was not drawn ({len(green)} pixels)"
(gx, gy), _ = ends(green)
rx, ry = near(green, (gx, gy), 20)
drag(rx, ry, rx + 90, ry + 60)
turned = settled(box)
assert len(changed_pixels(rings, turned, *box)) > 150, "Dragging the green ring turned nothing"
tap("Project")
find(LABEL, timeout=30)
tap(LABEL)
find(ADDED, timeout=30)

# S chooses Scale, G Move again.
tap("Workspace")
screen.key(KEY_S)
until_checked("Scale")
screen.key(KEY_G)
until_checked("Move")
print("Gizmo smoke passed")
