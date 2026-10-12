#!/usr/bin/env python3
"""Drive the Workspace's Brim Ears tool on an explicitly selected emulator.

The app's data is cleared and a cube added from the Project area's Add menu; Select All selects it. The
model toolbar's Brim Ears takes the Workspace's tool (the toolbar shows it), and the browser's Brim ears
panel takes the view's foot with the tool's status and hint. Place on corners puts an ear on each of the
cube's four bottom corners — one "Place brim ears" step — listed in the panel and drawn around the cube's
base as the browser's discs. With an Ear radius of 2.5 mm, a tap on the cube places one more where it met,
at the base, 5 mm across; a radius out of bounds is refused in the browser's words and the field shows
the radius again. Remove takes one ear off and Clear all the rest, each its own step that undo takes
back; Done ends the tool and its discs go.

The cube is moved toward the back of the bed (the inspector's Move Y), so that it stands above the
panel at the view's foot, and deselected once the tool is on (Escape), so that the gizmo leaves it: with
nothing selected the tool's object is the plate's only one, as the browser's. It and the discs are found
among the pixels above the panel that differ from the empty Workspace and from the cube drawn with the
tool on, as android-gizmo-smoke.py finds its handles.
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
RADIUS = "Ear radius (mm)"
MOVE = "Move (mm)"
EAR = re.compile(r"^(\d+)\. .* mm · ⌀(\d+(?:\.\d+)?) mm$")

screen = Screen(args.serial, output, "brimears")
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
    """The model toolbar's button described as [description], the toolbar dragged sideways until it shows
    (a phone's toolbar scrolls)."""
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
        # Clear of the screen's edges, where a swipe is the system's Back gesture.
        adb("shell", "input", "swipe", str(right - 140), y, str(left + 140), y, "400")
        time.sleep(0.5)


def dismiss_tooltip():
    """A tap on the navigation's Workspace, already shown, so a toolbar button's tooltip (a long-held tap
    shows it, and it stays) does not hide the view below the toolbar. (A tap on the view would place an ear.)"""
    tap("Workspace")
    time.sleep(1)


def checked(description):
    """Whether the toolbar's toggle described as [description] is on."""
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


def panel_rows():
    """Every placed ear the panel lists, by its number: its diameter. The panel scrolls, so it is dragged
    to its top and then down to its end a screen at a time (no fling), its rows read on the way."""
    rows = {}

    def collect(nodes):
        for node in nodes:
            match = EAR.match(node.get("text") or "")
            if match:
                rows[int(match.group(1))] = float(match.group(2))

    nodes = screen.nodes()
    for down in (False, True):
        last = None
        for _ in range(10):
            collect(nodes)
            x, top, bottom = screen.scroll_band(nodes, inset=12)
            screen.drag(x, *((bottom, top) if down else (top, bottom)))
            time.sleep(0.2)
            nodes = screen.nodes()
            words = [n.get("text") or n.get("content-desc") or "" for n in nodes]
            if words == last:
                break
            last = words
        collect(nodes)
    return rows


def ears(count, timeout=30):
    """The panel's placed ears once it lists [count] of them, numbered from 1: each one's diameter."""
    deadline = time.monotonic() + timeout
    while True:
        rows = panel_rows()
        if sorted(rows) == list(range(1, count + 1)):
            return [rows[n] for n in sorted(rows)]
        assert time.monotonic() < deadline, f"The panel listed ears {sorted(rows)}, not {count}"
        time.sleep(0.5)


def radius_field():
    """The Ear radius field (described by its label), the panel dragged until it shows whole."""
    nodes = screen.lift(find(RADIUS, timeout=30))
    fields = [n for n in nodes if n.get("class") == "android.widget.EditText"]
    for node in nodes:
        if node.get("content-desc") == RADIUS:
            return next((f for f in fields if f.get("bounds") == node.get("bounds")), None) or \
                next((c for c in node.iter("node") if c.get("class") == "android.widget.EditText"), node)
    raise AssertionError("The Ear radius field is not on screen")


def type_radius(text):
    """Types [text] into the Ear radius field (emptied first) and presses Enter, the browser's change."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    for _ in range(3):
        x, y = screen.center(radius_field())
        adb("shell", "input", "tap", str(x), str(y))
        deadline = time.monotonic() + 3
        while not shown() and time.monotonic() < deadline:
            time.sleep(0.2)
        time.sleep(1)
        count = len(radius_field().get("text") or "") + 1
        adb("shell", "input", "keyevent", *(["112"] * count), *(["67"] * count))
        adb("shell", "input", "text", text)
        time.sleep(0.3)
        if (radius_field().get("text") or "") == text:
            break
        screen.hide_keyboard()
    else:
        raise AssertionError(f"Could not type '{text}' into {RADIUS}")
    screen.key(66)
    screen.hide_keyboard()


def radius_shown(text, timeout=20):
    deadline = time.monotonic() + timeout
    while (radius_field().get("text") or "") != text:
        assert time.monotonic() < deadline, f"The Ear radius field never showed {text}"
        time.sleep(0.5)


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


def move_back(by):
    """The selected cube moved [by] mm toward the back of the bed (the inspector's Move Y, then Enter)."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    held = lambda: (described(MOVE, "Y", screen.nodes()).get("text") or "")
    target = f"{float(field(MOVE, 'Y').get('text')) + by:.2f}"
    for _ in range(3):
        x, y = screen.center(field(MOVE, "Y"))
        adb("shell", "input", "tap", str(x), str(y))
        deadline = time.monotonic() + 3
        while not shown() and time.monotonic() < deadline:
            time.sleep(0.2)
        time.sleep(1)
        count = len(held()) + 1
        adb("shell", "input", "keyevent", *(["112"] * count), *(["67"] * count))
        adb("shell", "input", "text", target)
        time.sleep(0.3)
        if held() == target:
            break
        screen.hide_keyboard()
    else:
        raise AssertionError(f"Could not type '{target}' into {MOVE} Y")
    screen.key(66)
    screen.hide_keyboard()
    find("Undo Transform instance", timeout=30)


def above_panel(timeout=20):
    """The view above the Brim ears panel at its foot: from under the toolbar to above the panel's card,
    which reaches some way above its heading."""
    heading = find("Brim ears", timeout=timeout)
    return (box[0], box[1], box[2], max(box[1] + 50, bounds(heading)[1] - 100))


def quiet(before, after, region, why, most=60):
    """That the view in [region] shows no disc between two screenshots: at most [most] pixels differ."""
    differing = changed_pixels(before, after, *region, delta=20)
    if len(differing) > most:
        xs, ys = [p[0] for p in differing], [p[1] for p in differing]
        raise AssertionError(f"{why}: {len(differing)} pixels differ, within x {min(xs)}–{max(xs)}, y {min(ys)}–{max(ys)}")


def top_of(pixels):
    """A tap point on a box's top face: the middle of the cluster, a third of the way down its height."""
    xs = sorted(p[0] for p in pixels)
    ys = [p[1] for p in pixels]
    return xs[len(xs) // 2], min(ys) + (max(ys) - min(ys)) // 3


def undo(label):
    """Undo [label] from the Project area, back in the Workspace after."""
    tap("Project")
    find(f"Undo {label}", timeout=30)
    tap(f"Undo {label}")
    tap("Workspace")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
width, height = screen.screenshot()[:2]

# The empty Workspace: what the cube and the discs are told against.
tap("Workspace")
time.sleep(4)
box = (0, screen.below_toolbar(260), width, height - 220)
empty = settled(box)

# A cube, selected, moved toward the back of the bed.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find(ADDED, timeout=30)
menu("Edit", "Select All")
move_back(90)
tap("Workspace")
time.sleep(3)

# The toolbar's Brim Ears takes the Workspace's tool, with the browser's panel at its foot.
assert not checked("Brim Ears"), "Brim Ears was the tool before it was chosen"
adb("shell", "input", "tap", *map(str, screen.center(tool("Brim Ears"))))
dismiss_tooltip()
deadline = time.monotonic() + 20
while not checked("Brim Ears"):
    assert time.monotonic() < deadline, "The toolbar never showed Brim Ears as the tool"
    time.sleep(0.5)
find("Brim ears: click the model where an ear should sit.", timeout=30)
find("Click the model to place an ear; each placement undoes on its own.", timeout=30)
radius_shown("5")
# Escape deselects: the gizmo goes, and the plate's only object is still the one ears go on.
screen.key(111)
time.sleep(2)
find("Click the model to place an ear; each placement undoes on its own.", timeout=30)
dismiss_tooltip()
armed = settled(box)
view = above_panel()
# The cube's own shades: darker than the bed, its grid and the ears' discs (the bed may have been framed
# again since the empty Workspace was read, moving its lines).
_, _, rows = armed
cube = [(x, y) for x, y in changed_pixels(empty, armed, *view) if max(rows[y][x * 4:x * 4 + 3]) < 160]
assert len(cube) > 200, f"The cube was not drawn above the panel ({len(cube)} pixels)"

# Place on corners: an ear on each of the cube's four bottom corners, one step, drawn around its base.
tap("Place on corners")
find("Placed 4 brim ears on the corners that would lift; one undo removes them all.", timeout=60)
assert ears(4) == [10, 10, 10, 10], "The corners' ears are not the panel's 5 mm radius"
eared = settled(box)
view = above_panel()
discs = changed_pixels(armed, eared, *view, delta=20)
assert len(discs) > 150, f"The ears' discs were not drawn ({len(discs)} pixels)"
outline = set(cube)
assert any(p not in outline for p in discs), "The discs never reached past the cube's own outline"
tap("Project")
find("Undo Place brim ears", timeout=30)
tap("Workspace")

# A 2.5 mm radius, then a tap on the cube: one more ear, 5 mm across, where the tap met it.
type_radius("2.5")
radius_shown("2.5")
x, y = top_of(cube)
print(f"Tapping the cube at {x}, {y}")
adb("shell", "input", "tap", str(x), str(y))
find("Placed a 2.5 mm brim ear.", timeout=60)
assert sorted(ears(5)) == [5, 10, 10, 10, 10], "The tapped ear is not the panel's 2.5 mm radius"
tap("Project")
find("Undo Place brim ear", timeout=30)
tap("Workspace")

# A radius out of bounds is refused, and the field shows the radius again.
type_radius("50")
find("A brim ear radius must be between 0.1 and 20 mm.", timeout=30)
radius_shown("2.5")

# Remove takes the first ear off as one step; undo puts it back.
remove = find("Remove: ", exact=False, timeout=30)
adb("shell", "input", "tap", *map(str, screen.center(remove)))
find("Removed a brim ear.", timeout=60)
ears(4)
undo("Remove brim ear")
ears(5)

# Clear all takes the rest, and the discs go; undo brings them back.
tap("Clear all")
find("Cleared the brim ears; undo restores them.", timeout=60)
ears(0)
cleared = settled(box)
quiet(armed, cleared, above_panel(), "The discs stayed after Clear all")
undo("Clear brim ears")
ears(5)

# Done ends the tool, and its discs go with it.
view = above_panel()
tap("Done")
absent("Click the model to place an ear; each placement undoes on its own.")
time.sleep(2)
done = settled(box)
quiet(armed, done, view, "The discs stayed after the tool ended")
assert not checked("Brim Ears"), "Brim Ears stayed the tool after Done"
print("Brim ears smoke passed")
