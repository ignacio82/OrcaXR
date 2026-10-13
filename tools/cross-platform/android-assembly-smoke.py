#!/usr/bin/env python3
"""Drive the Workspace's Assembly tool on an explicitly selected emulator.

The app's data is cleared and two cubes added from the Project area's Add menu, each moved toward the back
of the bed with the inspector's Move fields, the second beside the first. The model toolbar's Assembly takes
the Workspace's tool — the Measure tool with the browser's assembly status — and a tap on each cube's top
picks the two faces: the Measure panel's Align section offers the alignments the pair allows (two tops
facing the same way: Centre coincidence, Flip over, Set gap at the measured gap of 0 mm and Turn about
centre, not Parallel). Set gap at 0 moves nothing ("Those faces are already aligned; nothing moved.");
at 25 mm it lifts the second cube, one "Transform instance" step with the browser's status, and the picks
are dropped; undo takes it back. Centre coincidence turns the second cube over onto the first's top, one
more step, undone. Explode the assembly moves the cubes apart on screen — the project untouched, its undo
label unchanged — and Done ends the tool and assembles the view again.

The cubes are found among the pixels that differ from the empty Workspace, as android-brimears-smoke.py
finds its cube; each tap is on the upper third of a cube's pixels, its top face.
"""
import argparse
import re
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
ADDED = "Undo Add cube.stl"
MOVED = "Undo Transform instance"
MOVE = "Move (mm)"
GAP = "Gap (mm)"
EXPLODE = "Explode the assembly"
START = "Assembly: pick a face on each model, then choose an alignment."
CHOOSE = "Choose an alignment; it commits as one undoable move."
FIRST = "Click the first feature to measure from."

screen = Screen(args.serial, output, "assembly")
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


def tool(description, timeout=30):
    """The model toolbar's button described as [description], the toolbar dragged sideways until it shows."""
    deadline = time.monotonic() + timeout
    while True:
        nodes = screen.nodes()
        node = next((n for n in nodes if (n.get("content-desc") or "") == description), None)
        if node is not None and bounds(node)[2] - bounds(node)[0] > 30:
            return node
        assert time.monotonic() < deadline, f"The toolbar's {description} never showed"
        bar = next(n for n in nodes if (n.get("content-desc") or "") == "Model tools")
        left, top, right, bottom = bounds(bar)
        y = str((top + bottom) // 2)
        adb("shell", "input", "swipe", str(right - 140), y, str(left + 140), y, "400")
        time.sleep(0.5)


def checked(description):
    return tool(description).get("checked") == "true"


def settled(box, timeout=20):
    """A screenshot once the Workspace stops changing."""
    deadline = time.monotonic() + timeout
    last = screen.screenshot()
    while True:
        time.sleep(1)
        now = screen.screenshot()
        if len(changed_pixels(last, now, *box)) < 20 or time.monotonic() > deadline:
            return now
        last = now


def described(title, axis, nodes):
    """The inspector field [axis] of tool [title] among [nodes]."""
    fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]

    def text_field(node):
        around = next((f for f in fields if f.get("bounds") == node.get("bounds")), None)
        if around is not None:
            return around
        return next((c for c in node.iter("node") if c.get("class") == "android.widget.EditText"), node)

    found = [text_field(n) for n in nodes if n.get("content-desc") == (f"{title} {axis}" if axis else title)]
    return found[0] if found else None


def field(title, axis, timeout=20):
    """The field described as "[title] [axis]" (or [title]), dragged clear of the bottom bar."""
    deadline = time.monotonic() + timeout
    while True:
        node = described(title, axis, screen.nodes())
        if node is not None:
            left, top, right, bottom = bounds(node)
            if bottom - top > 40 and bottom < height - 200:
                return node
        assert time.monotonic() < deadline, f"The {title} {axis or ''} field never showed"
        adb("shell", "input", "swipe", "360", "900", "360", "600", "300")
        time.sleep(0.5)


def gap_field():
    """The Align section's Gap (mm) field, the panel dragged until its row (with Set gap) shows whole."""
    nodes = screen.lift(find("Set gap", timeout=30))
    fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]
    described_as = [n for n in nodes if n.get("content-desc") == GAP and bounds(n)[3] > bounds(n)[1]]
    for node in described_as:
        left, top, right, bottom = bounds(node)
        # The field's own node, around the one its description is read from.
        match = next((f for f in fields if bounds(f)[0] == left and bounds(f)[2] == right
                      and bounds(f)[1] <= top and bounds(f)[3] >= bottom), None)
        if match is not None:
            return match
    raise AssertionError("The Gap (mm) field is not on screen")


def type_gap(text):
    """Types [text] into the Gap (mm) field, emptied first; the button reads it as it is pressed."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    for _ in range(3):
        x, y = screen.center(gap_field())
        adb("shell", "input", "tap", str(x), str(y))
        deadline = time.monotonic() + 3
        while not shown() and time.monotonic() < deadline:
            time.sleep(0.2)
        time.sleep(1)
        count = len(gap_field().get("text") or "") + 1
        adb("shell", "input", "keyevent", *(["112"] * count), *(["67"] * count))
        adb("shell", "input", "text", text)
        time.sleep(0.3)
        if (gap_field().get("text") or "") == text:
            break
        screen.hide_keyboard()
    else:
        raise AssertionError(f"Could not type '{text}' into {GAP}")
    screen.hide_keyboard()


def type_into(title, axis, text, enter=True):
    """Types [text] into a field (emptied first), Enter the browser's change when [enter]."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    held = lambda: (described(title, axis, screen.nodes()).get("text") or "")
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
        raise AssertionError(f"Could not type '{text}' into {title} {axis or ''}")
    if enter:
        screen.key(66)
    screen.hide_keyboard()


def move_by(axis, by):
    """The selected cube moved [by] mm along [axis] (the inspector's Move field, then Enter): one step."""
    target = f"{float(field(MOVE, axis).get('text')) + by:.2f}"
    type_into(MOVE, axis, target)
    find(MOVED, timeout=30)


def top_of(pixels):
    """A tap point on a box's top face: the middle of the cluster, a third of the way down its height."""
    xs = sorted(p[0] for p in pixels)
    ys = [p[1] for p in pixels]
    return xs[len(xs) // 2], min(ys) + (max(ys) - min(ys)) // 3


def pick_tops():
    """The two cubes' tops picked with two taps, each once the panel asks for it: the Align section then
    offers the alignments."""
    find(FIRST, timeout=30)
    adb("shell", "input", "tap", *map(str, top_of(first)))
    find("Click the second feature to measure to.", timeout=30)
    adb("shell", "input", "tap", *map(str, top_of(second)))
    find(CHOOSE, timeout=30)


def press(words):
    """The panel's button showing [words], dragged into view, once it is enabled."""
    node = screen.lift(find(words, timeout=30))
    button = next(n for n in node if (n.get("text") or "") == words)
    adb("shell", "input", "tap", *map(str, screen.center(button)))


def enabled(words):
    nodes = screen.lift(find(words, timeout=30))
    parents = {child: parent for parent in nodes for child in parent}
    node = next(n for n in nodes if (n.get("text") or "") == words)
    while node is not None and node.get("clickable") != "true":
        node = parents.get(node)
    return node is not None and node.get("enabled") == "true"


def above_panel():
    """The view above the Measure panel at its foot: from under the toolbar to above its card, which reaches
    some way above its heading's Clear."""
    heading = find("Clear", timeout=30)  # the panel's own; the toolbar's Measure is described alike
    return (box[0], box[1], box[2], max(box[1] + 50, bounds(heading)[1] - 100))


def undo(label):
    """Undo [label] from the Project area, then back in the Workspace once it shows."""
    tap("Project")
    find(f"Undo {label}", timeout=30)
    tap(f"Undo {label}")
    tap("Workspace")
    time.sleep(2)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]
tap("Workspace")
time.sleep(4)
box = (0, screen.below_toolbar(260), width, height - 220)
empty = settled(box)

# Two cubes toward the back of the bed, side by side; each one's pixels told apart.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find(ADDED, timeout=30)
move_by("Y", 90)
tap("Workspace")
time.sleep(3)
# Escape deselects: the gizmo leaves the cube, so its pixels are the cube's alone.
screen.key(111)
one = settled(box)
tap("Project")
menu("Add", "Cube")
find(ADDED, timeout=30)
move_by("Y", 90)
move_by("X", 40)
tap("Workspace")
time.sleep(3)
screen.key(111)
both = settled(box)
first = set(changed_pixels(empty, one, *box))
second = [p for p in changed_pixels(empty, both, *box) if p not in first]
first = list(first)
assert len(first) > 150 and len(second) > 150, f"The cubes were not drawn apart ({len(first)} and {len(second)} pixels)"

# The toolbar's Assembly: the Measure tool with the assembly status.
assert not checked("Assembly"), "Assembly was the tool before it was chosen"
adb("shell", "input", "tap", *map(str, screen.center(tool("Assembly"))))
deadline = time.monotonic() + 20
while not checked("Assembly"):
    assert time.monotonic() < deadline, "The toolbar never showed Assembly as the tool"
    time.sleep(0.5)
find(START, timeout=30)
find(FIRST, timeout=30)
# The view with the tool on and nothing picked: what the moves are told against, above the panel.
time.sleep(2)
armed = settled(box)

# Two tops facing the same way: everything but Parallel; the gap the measured 0 mm.
pick_tops()
# The panel at its tallest (the Align section shown): the view above it is compared.
view = above_panel()
print(f"compared above the panel: {view}")
assert not enabled("Parallel"), "Parallel was offered for two parallel faces"
for words in ("Centre coincidence", "Flip over", "Set gap", "Turn about centre"):
    assert enabled(words), f"{words} was not offered"
assert (gap_field().get("text") or "") == "0", "The gap field does not start at the measured gap"
press("Set gap")
find("Those faces are already aligned; nothing moved.", timeout=30)

# A 25 mm gap lifts the second cube: one step, the browser's status, the picks dropped.
type_gap("25")
press("Set gap")
find("Applied parallel distance. Undo restores the previous placement.", timeout=60)
find(FIRST, timeout=30)
lifted = settled(box)
moved = changed_pixels(armed, lifted, *view)
print(f"lifted: {len(moved)} pixels changed above the panel")
assert len(moved) > 150, "The second cube was not drawn lifted"
tap("Project")
find(MOVED, timeout=30)
tap("Workspace")
undo("Transform instance")

# Centre coincidence turns the second cube over onto the first's top: one step, undone.
pick_tops()
press("Centre coincidence")
find("Applied center coincidence. Undo restores the previous placement.", timeout=60)
stacked = settled(box)
assert len(changed_pixels(armed, stacked, *view)) > 150, "The second cube was not drawn on the first"
undo("Transform instance")
back = settled(box)
assert len(changed_pixels(armed, back, *view, delta=40)) < 60, "Undo did not put the second cube back"

# Explode the assembly: the cubes drawn apart, the project untouched; Done assembles the view again.
tap("Project")
label = find("Undo ", exact=False, timeout=30).get("text")
tap("Workspace")
def factor_shown():
    """The factor the panel shows beside Explode the assembly."""
    nodes = screen.lift(find(EXPLODE, timeout=30))
    texts = [n for n in nodes if n.get("class") == "android.widget.TextView"]
    at = next(i for i, n in enumerate(texts) if (n.get("text") or "") == EXPLODE)
    return float(texts[at + 1].get("text"))


assert factor_shown() == 1, "The view was exploded before the slider moved"
nodes = screen.lift(find(EXPLODE, timeout=30))
bar = next(n for n in nodes if n.get("class") == "android.widget.SeekBar")
left, top, right, bottom = bounds(bar)
# A press near the track's far end moves the factor there (the slider's press to seek).
adb("shell", "input", "tap", str(right - 24), str((top + bottom) // 2))
deadline = time.monotonic() + 30
while factor_shown() < 2.5:
    assert time.monotonic() < deadline, "The slider never exploded the view"
    time.sleep(0.5)
print(f"exploded to {factor_shown()}")
apart = settled(box)
assert len(changed_pixels(back, apart, *view)) > 150, "Explode the assembly moved nothing on screen"
tap("Project")
find(label, timeout=30)
tap("Workspace")
tap("Done")
absent(FIRST)
time.sleep(2)
assembled = settled(box)
assert len(changed_pixels(both, assembled, *box, delta=40)) < 60, "Ending the tool did not assemble the view"
assert not checked("Assembly"), "Assembly stayed the tool after Done"
print("Assembly smoke passed")
