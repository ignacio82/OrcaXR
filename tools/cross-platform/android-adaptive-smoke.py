#!/usr/bin/env python3
"""Drive the app's window-size layouts and keyboard on an explicitly selected emulator.

On the phone the suite boots (720 x 1280 px at 240 dpi: 480 dp wide) the
areas sit on a bottom bar, one at a time. A hardware keyboard then reaches
every control: Tab visits the Device area's buttons and the five areas and
wraps round, Shift+Tab steps back, Space and Enter activate, the focused
button is drawn differently from the unfocused one, a dialog keeps the focus
— wrapping inside it — until Escape closes it and gives the focus back.

The display is then resized with `wm density` and `wm size` — and always
restored, as the run ends or fails: at 160 dpi it is a medium window (720 dp)
with a rail and still one area at a time; at 1280 x 800 px it is an
expanded one (1280 dp) where Prepare and Project show their panel at the
start beside the Workspace, Preview its controls beside the toolpath view,
and Device fills the work area; Tab crosses from the rail into the panel and
round again, stopping in the Workspace only at its theme switch.

File drag and drop cannot be driven through adb: the JVM tests cover how a
drop is classified, planned and refused.
"""
import argparse
import json
import re
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen, changed_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
AREAS = ("Workspace", "Prepare", "Preview", "Device", "Project")
WORKSPACE = "Import a model in the Project area to see it here."
PLATE = "Plate 1 · 0 object(s)"
OPEN_GCODE = "Open G-code file…"
ADD_FIELDS = ("Name", "Address", "Port (7125 if empty)")
TAB, ENTER, SPACE, ESCAPE = 61, 66, 62, 111

screen = Screen(args.serial, output, "adaptive")
adb, nodes, find, tap, absent = screen.adb, screen.nodes, screen.find, screen.tap, screen.absent


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def label(node):
    """What a control shows: its own text or description, else its contents' (a button's
    words, a navigation item's label, a text field's label)."""
    own = node.get("text") or node.get("content-desc") or ""
    if own:
        return own
    return " ".join(filter(None, ((child.get("text") or child.get("content-desc") or "") for child in node.iter("node"))))


def display():
    """The display's width and height in pixels, overridden or not."""
    sizes = dict(re.findall(r"(Physical|Override) size: (\d+x\d+)", adb("shell", "wm", "size")))
    width, height = (sizes.get("Override") or sizes["Physical"]).split("x")
    return int(width), int(height)


def focused():
    """The control the keyboard focus is on, as (label, bounds), or None. The window's own
    view reports the focus too; the innermost focused node smaller than half the display is
    the control."""
    width, height = display()
    marked = [node for node in nodes() if node.get("focused") == "true"]
    inner = [node for node in marked if not any(other is not node and other.get("focused") == "true" for other in node.iter("node"))]
    for node in reversed(inner):
        left, top, right, bottom = bounds(node)
        if (right - left) * (bottom - top) < width * height // 2:
            return label(node), (left, top, right, bottom)
    return None


def tab(back=False):
    if back:
        adb("shell", "input", "keycombination", "59", str(TAB))
    else:
        screen.key(TAB)
    time.sleep(0.4)


def tab_to(text, limit=24):
    """Tabs until the control showing [text] has the focus; the first key out of touch mode
    may only end it."""
    for _ in range(limit):
        tab()
        now = focused()
        if now and now[0] == text:
            return now
    raise AssertionError(f"Tab never reached '{text}'")


def traverse(count):
    """The controls [count] presses of Tab visit, from the one focused now."""
    seen = []
    for _ in range(count):
        tab()
        now = focused()
        assert now, f"Tab left no control focused after {seen}"
        seen.append(now[0])
    return seen


def cycle(seen, required):
    """Checks that the visits cover [required] and repeat with the period of everything visited:
    Tab goes on from the last control to the first, the same way round each time."""
    period = len(set(seen))
    assert set(required) <= set(seen), f"Tab never reached {set(required) - set(seen)}: {seen}"
    assert len(seen) > period, f"Too few presses to see the focus wrap: {seen}"
    assert all(seen[i] == seen[i + period] for i in range(len(seen) - period)), f"Tab does not cycle: {seen}"
    return period


def navigation():
    """'bar' or 'rail', from where the five areas' labels sit."""
    width, height = display()
    shown = {}
    for node in nodes():
        text = node.get("text") or ""
        if text in AREAS:
            assert text not in shown, f"'{text}' is shown twice"
            left, top, right, bottom = bounds(node)
            shown[text] = ((left + right) // 2, (top + bottom) // 2)
    assert set(shown) == set(AREAS), f"Areas missing from the navigation: {set(AREAS) - set(shown)}"
    xs = [x for x, _ in shown.values()]
    ys = [y for _, y in shown.values()]
    if max(ys) - min(ys) < 20 and min(ys) > height * 3 // 4 and xs == sorted(xs):
        return "bar"
    if max(xs) - min(xs) < 20 and max(xs) < width // 5 and ys == sorted(ys):
        return "rail"
    raise AssertionError(f"The areas are neither on a bar nor on a rail: {shown}")


def resize(size, density):
    """Overrides (or, with "reset", restores) the display; the app's window is recreated for it."""
    adb("shell", "wm", "size", size)
    adb("shell", "wm", "density", density)
    time.sleep(4)


def restore():
    adb("shell", "wm", "size", "reset")
    adb("shell", "wm", "density", "reset")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
report = {"evidenceKind": "emulator-only"}
restore()
try:
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    screen.launch(PACKAGE)
    find(WORKSPACE)

    # A phone: the bottom bar, one area at a time.
    phone = display()
    assert navigation() == "bar", "A phone lost its bottom bar"
    tap("Prepare")
    find(PLATE, timeout=30)
    absent(WORKSPACE, timeout=10)
    tap("Preview")
    gcode = bounds(find(OPEN_GCODE))
    assert gcode[1] > phone[1] * 2 // 5, f"On a phone Preview's controls should sit below the toolpath view: {gcode}"

    # The keyboard: Tab reaches every control of the Device area and the five areas, and wraps.
    tap("Device")
    find("Add printer")
    tab_to("Add printer")
    seen = traverse(16)
    period = cycle(seen, ("Add printer", "Find printers", *AREAS))
    report["phoneDeviceTabOrder"] = seen[:period]
    # Shift+Tab steps back, Tab forward again.
    tab(back=True)
    assert focused()[0] == seen[-2], f"Shift+Tab did not return to '{seen[-2]}'"
    tab()
    assert focused()[0] == seen[-1], f"Tab did not go on to '{seen[-1]}'"
    # Space and Enter activate: a navigation item, then back by Enter.
    tab_to("Project")
    screen.key(SPACE)
    find("New Project", timeout=20)
    tab_to("Device")
    screen.key(ENTER)
    find("Add printer", timeout=20)
    # The focused control is drawn differently: its state layer is raised for the keyboard.
    _, button = tab_to("Add printer")
    time.sleep(0.6)
    lit = screen.screenshot()
    tab()
    assert focused()[0] == "Find printers", "Tab did not move on from 'Add printer'"
    time.sleep(0.6)
    unlit = screen.screenshot()
    shown = len(changed_pixels(lit, unlit, *button, delta=20))
    report["focusChangedPixels"] = shown
    assert shown > 300, f"The focused button looks like an unfocused one ({shown} pixels differ)"
    # A dialog keeps the focus, wrapping inside it, until Escape closes it and gives the focus back.
    tab(back=True)
    assert focused()[0] == "Add printer", "Shift+Tab did not return to 'Add printer'"
    screen.key(ENTER)
    find(ADD_FIELDS[2], timeout=20)
    seen = traverse(12)
    inside = ("Save", "Cancel", *ADD_FIELDS)
    strays = [each for each in seen if not any(name in each for name in inside)]
    assert not strays, f"The focus left the dialog for {strays}: {seen}"
    cycle(seen, ())
    assert all(any(name in each for each in seen) for name in inside), f"Tab missed a control of the dialog: {seen}"
    report["dialogTabOrder"] = seen[:len(set(seen))]
    tab_to("Cancel")
    screen.key(ESCAPE)
    absent(ADD_FIELDS[2], timeout=20)
    time.sleep(0.6)
    back = focused()
    assert back and back[0] == "Add printer", f"Closing the dialog did not give the focus back to 'Add printer': {back}"

    # A medium window (720 dp): the rail, still one area at a time.
    resize("reset", "160")
    find("Add printer", timeout=30)
    assert navigation() == "rail", "A medium window has no rail"
    tap("Prepare")
    find(PLATE, timeout=30)
    absent(WORKSPACE, timeout=10)
    tap("Preview")
    medium = display()
    gcode = bounds(find(OPEN_GCODE))
    assert gcode[1] > medium[1] * 2 // 5, f"In a medium window Preview's controls should sit below the toolpath view: {gcode}"

    # An expanded window (1280 dp): the area's panel at the start beside the viewport.
    resize("1280x800", "160")
    find(OPEN_GCODE, timeout=30)
    assert navigation() == "rail", "An expanded window has no rail"
    width, height = display()
    # The browser's sidebar is 356 px beside the viewport in a window wider than 1180 px; at 160 dpi a
    # dp is a pixel, and Material's rail is at least 80 dp before it.
    panel_end = 80 + 356
    gcode = bounds(find(OPEN_GCODE))
    assert gcode[2] <= panel_end and gcode[1] < height // 3, f"Preview's controls are not the panel at the start: {gcode}"
    surfaces = [bounds(node) for node in nodes() if node.get("class") == "android.view.SurfaceView"]
    if surfaces:
        assert surfaces[0][0] >= panel_end - 2, f"The toolpath view is not beside the panel: {surfaces}"
    for area, first in (("Prepare", PLATE), ("Project", "Untitled project")):
        tap(area)
        heading = bounds(find(first, timeout=30))
        # The Workspace's own words sit 16 dp in from its start edge.
        viewport = bounds(find(WORKSPACE, timeout=20))[0] - 16
        assert viewport >= panel_end - 2, f"The Workspace does not leave {area}'s panel its 356 dp: it starts at {viewport}"
        assert heading[2] <= viewport, f"{area}'s panel is not at the start beside the Workspace: {heading}, {viewport}"
        report[f"expanded{area}ViewportStart"] = viewport
    # Tab crosses from the rail into the panel and round again; in the Workspace only its theme switch takes the focus.
    tab_to("Project")
    seen = traverse(26)
    cycle(seen, ("New Project", "Open Project…", "Import Model…", *AREAS))
    report["expandedProjectTabOrder"] = seen[:len(set(seen))]
    tap("Device")
    find("Add printer", timeout=20)
    absent(WORKSPACE, timeout=10)
    tap("Workspace")
    workspace = bounds(find(WORKSPACE, timeout=20))
    assert workspace[0] < panel_end, f"The Workspace area does not fill the work area: {workspace}"
finally:
    restore()
    adb("shell", "am", "force-stop", PACKAGE)
report.update({
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
})
(output / "android-adaptive-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Adaptive shell and keyboard passed on API {report['api']} {report['abi']} emulator "
      f"(bar, rail, two panes; {len(report['phoneDeviceTabOrder'])} controls in the Device area's Tab order)")
