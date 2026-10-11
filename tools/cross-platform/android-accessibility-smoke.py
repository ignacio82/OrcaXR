#!/usr/bin/env python3
"""Drive the app's theme and accessibility on an explicitly selected emulator.

The app's data is cleared. In the system's light theme every area opens and an
accessibility-node audit of each (a uiautomator dump) finds every clickable,
checkable or long-clickable node named — by its own text or content
description or by its contents' — and the 3D views named "Build plate"; no
control lies under the status or navigation bar. With night mode on
(`cmd uimode night yes`) the Project area's background and the Workspace's
viewport are the dark tokens' colours (bg, and the viewport's wash at the
sampled heights) and the theme switch offers "Switch to light mode", pressed;
pressing it shows the light theme under the system's dark one (an explicit
choice outranks the system, as in the browser), and pressing it again the dark.
At font scale 2.0 every area opens, its key controls are reached (the lists
and the Add printer dialog scroll to them), and the bar's five names are
whole: none shorter than its words need, none overlapping, each on screen. In
landscape a field low in Prepare stays above the keyboard once focused, as a
field of the Add printer dialog does. With every animation scale at 0 the
areas, a menu and a dialog still open and close.

Night mode, font scale, animation scales and rotation are read first and
restored at the end, even on failure; the app's data is cleared last.
"""
import argparse
import json
import re
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
AREAS = ("Workspace", "Prepare", "Preview", "Device", "Project")
WORKSPACE = "Import a model in the Project area to see it here."
VIEW = "Build plate"
TO_DARK, TO_LIGHT = "Switch to dark mode", "Switch to light mode"
ADD_FIELDS = ("Name", "Address", "Port (7125 if empty)")
# The browser's tokens (web/src/ui/tokens.ts, generated into OrcaTokens.kt): the window and the viewport's wash.
LIGHT_BG, DARK_BG = (0xE9, 0xEB, 0xEC), (0x19, 0x1C, 0x1E)
LIGHT_WASH = ((0xF4, 0xF6, 0xF7), (0xC8, 0xCE, 0xD2))
DARK_WASH = ((0x2F, 0x34, 0x37), (0x15, 0x18, 0x1A))
TOLERANCE = 8

screen = Screen(args.serial, output, "accessibility")
adb, nodes, find, tap, absent = screen.adb, screen.nodes, screen.find, screen.tap, screen.absent


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def named(node):
    """Whether a node, or something inside it, has words an accessibility service can read."""
    return any((each.get("text") or each.get("content-desc") or "").strip() for each in node.iter("node"))


def audit(area):
    """Every actionable node of the app's window is named; returns how many were checked."""
    unnamed, count = [], 0
    for node in nodes():
        if node.get("package") != PACKAGE:
            continue
        if "true" in (node.get("clickable"), node.get("checkable"), node.get("long-clickable")):
            count += 1
            if not named(node):
                unnamed.append(f"{node.get('class')} {node.get('bounds')}")
    assert not unnamed, f"{area}: unnamed controls {unnamed}"
    return count


def bars():
    """The system bars' frames on screen, from the window manager's inset sources."""
    text = adb("shell", "dumpsys", "window")
    frames = []
    for kind, left, top, right, bottom in re.findall(
            r"type=(statusBars|navigationBars) frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", text):
        if int(right) > int(left) and int(bottom) > int(top):
            frames.append((kind, int(left), int(top), int(right), int(bottom)))
    return frames


def clear_of_bars(where):
    """No actionable node of the app lies under a system bar. A list clips what it scrolls past its
    edge, but the dump reports such a node's whole bounds, so each node is clipped to the lists
    holding it first: only what shows counts."""
    frames = bars()
    current = nodes()
    parents = {child: parent for parent in current for child in parent}
    for node in current:
        if node.get("package") != PACKAGE or node.get("clickable") != "true":
            continue
        left, top, right, bottom = bounds(node)
        ancestor = parents.get(node)
        while ancestor is not None:
            if ancestor.get("scrollable") == "true":
                l, t, r, b = bounds(ancestor)
                left, top, right, bottom = max(left, l), max(top, t), min(right, r), min(bottom, b)
            ancestor = parents.get(ancestor)
        if right <= left or bottom <= top:
            continue
        for kind, l, t, r, b in frames:
            overlap = min(right, r) - max(left, l) > 0 and min(bottom, b) - max(top, t) > 0
            assert not overlap, f"{where}: {node.get('class')} {node.get('bounds')} lies under {kind} {(l, t, r, b)}"
    return len(frames)


def ime_top():
    """The top of the soft keyboard on screen, once it is shown."""
    shown = lambda: "mInputShown=true" in adb("shell", "dumpsys", "input_method")
    deadline = time.monotonic() + 10
    while not shown():
        assert time.monotonic() < deadline, "The soft keyboard never showed"
        time.sleep(0.3)
    time.sleep(1)
    text = adb("shell", "dumpsys", "window")
    tops = [int(top) for top in re.findall(r"type=ime frame=\[-?\d+,(\d+)\]\[-?\d+,\d+\][^\n]*visible=true", text)]
    if not tops:
        windows = adb("shell", "dumpsys", "window", "InputMethod")
        tops = [int(top) for top in re.findall(r"(?:mFrame|frame)=\[-?\d+,(\d+)\]\[-?\d+,\d+\]", windows) if int(top) > 0]
    assert tops, "The keyboard's frame was not reported"
    top = min(tops)
    # The display as it is now (rotated or not): the window manager's current size.
    height = int(re.search(r"cur=(\d+)x(\d+)", adb("shell", "dumpsys", "window", "displays")).group(2))
    # A keyboard over the whole window (an extract view) would leave nothing to keep above it.
    assert top > height // 5, f"The keyboard covers the window (top {top} of {height}): a field cannot stay above it"
    return top


def above_keyboard(label, where):
    """Focuses the field labelled [label] and checks it stays above the keyboard."""
    x, y = screen.center(screen.field(label))
    adb("shell", "input", "tap", str(x), str(y))
    keyboard = ime_top()
    field = bounds(screen.field(label))
    assert field[3] <= keyboard + 2, f"{where}: '{label}' {field} is under the keyboard at {keyboard}"
    screen.hide_keyboard()
    return {"field": field, "keyboardTop": keyboard}


def pixel(image, x, y):
    _, _, rows = image
    row = rows[y]
    return row[x * 4], row[x * 4 + 1], row[x * 4 + 2]


def close(colour, expected, tolerance=TOLERANCE):
    return all(abs(a - b) <= tolerance for a, b in zip(colour, expected))


def page_background(expected, where):
    """A pixel of the Project area's own background is [expected]: at the end edge, in the list's 16 dp
    margin, level with its first buttons (nothing the list draws reaches that margin)."""
    tap("Project")
    y = screen.center(find("New Project", timeout=30))[1]
    time.sleep(1)
    image = screen.screenshot()
    sample = pixel(image, image[0] - 8, y)
    assert close(sample, expected), f"{where}: the Project area's background is {sample}, not {expected}"
    return sample


def workspace_wash(wash, where):
    """The Workspace viewport's wash at points away from the bed: its top and bottom colours where sampled."""
    tap("Workspace")
    find(WORKSPACE, timeout=30)
    time.sleep(3)
    # The 3D view by its name (a SurfaceView reports itself as a plain View).
    surfaces = [bounds(node) for node in nodes() if (node.get("content-desc") or "") == VIEW]
    assert surfaces, "The Workspace has no 3D view"
    left, top, right, bottom = surfaces[0]
    image = screen.screenshot()
    samples, matched = [], 0
    for fraction in (0.08, 0.92):
        y = top + int((bottom - top) * fraction)
        expected = tuple(round(a + (b - a) * fraction) for a, b in zip(*wash))
        for x in (left + 6, right - 6):
            colour = pixel(image, x, y)
            samples.append({"x": x, "y": y, "colour": colour, "expected": expected})
            matched += close(colour, expected, TOLERANCE + 4)
    assert matched >= 2, f"{where}: the viewport is not the theme's wash: {samples}"
    return samples


def switch_state():
    """The theme switch's label and whether it is pressed."""
    tap("Workspace")
    find(WORKSPACE, timeout=30)
    for node in nodes():
        desc = node.get("content-desc") or ""
        if desc in (TO_DARK, TO_LIGHT):
            return desc, node.get("checked") == "true"
    raise AssertionError("The Workspace shows no theme switch")


def open_areas(where, keys):
    """Every area opens and its key control is reached (scrolling for it: at font scale 2.0 the
    Prepare list runs to many screens, so the search may take a while on a loaded emulator)."""
    for area in AREAS:
        tap(area)
        find(keys[area], timeout=120)
    return where


def settings(namespace, key):
    value = adb("shell", "settings", "get", namespace, key)
    return None if value in ("null", "") else value


def put(namespace, key, value):
    if value is None:
        adb("shell", "settings", "delete", namespace, key)
    else:
        adb("shell", "settings", "put", namespace, key, value)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
night = re.search(r"Night mode: (\w+)", adb("shell", "cmd", "uimode", "night")).group(1)
saved = {
    ("system", "font_scale"): settings("system", "font_scale"),
    ("global", "window_animation_scale"): settings("global", "window_animation_scale"),
    ("global", "transition_animation_scale"): settings("global", "transition_animation_scale"),
    ("global", "animator_duration_scale"): settings("global", "animator_duration_scale"),
    ("system", "accelerometer_rotation"): settings("system", "accelerometer_rotation"),
    ("system", "user_rotation"): settings("system", "user_rotation"),
}
report = {"evidenceKind": "emulator-only"}
KEYS = {"Workspace": WORKSPACE, "Prepare": "Slice", "Preview": "Open G-code file…", "Device": "Add printer", "Project": "New Project"}
try:
    adb("shell", "cmd", "uimode", "night", "no")
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    screen.launch(PACKAGE)
    find(WORKSPACE, timeout=30)

    # Light, as the system is: every area's controls named, the 3D views too, nothing under the bars.
    find(VIEW)
    state = switch_state()
    assert state == (TO_DARK, False), f"In the light theme the switch reads {state}"
    audited = {}
    for area in AREAS:
        tap(area)
        find(KEYS[area], timeout=30)
        audited[area] = audit(area)
        report.setdefault("barsChecked", clear_of_bars(f"portrait {area}"))
    tap("Preview")
    find(VIEW)
    report["auditedControls"] = audited
    report["lightBackground"] = page_background(LIGHT_BG, "light")
    report["lightWash"] = workspace_wash(LIGHT_WASH, "light")

    # Night mode: the dark tokens' colours, and the switch offering light.
    adb("shell", "cmd", "uimode", "night", "yes")
    # The window is recreated in the area it showed.
    time.sleep(4)
    report["darkBackground"] = page_background(DARK_BG, "night mode")
    report["darkWash"] = workspace_wash(DARK_WASH, "night mode")
    state = switch_state()
    assert state == (TO_LIGHT, True), f"In the dark theme the switch reads {state}"
    for area in AREAS:
        tap(area)
        find(KEYS[area], timeout=30)
        audit(f"dark {area}")
    # An explicit choice outranks the system's dark theme, and the switch goes back.
    tap("Workspace")
    tap(TO_LIGHT)
    time.sleep(2)
    report["chosenLight"] = page_background(LIGHT_BG, "light chosen under night mode")
    tap("Workspace")
    tap(TO_DARK)
    time.sleep(2)
    page_background(DARK_BG, "dark chosen again")
    adb("shell", "cmd", "uimode", "night", "no")
    adb("shell", "pm", "clear", PACKAGE)

    # Font scale 2.0: every area opens, key controls are reached, the bar's names are whole.
    put("system", "font_scale", "2.0")
    screen.launch(PACKAGE)
    find(WORKSPACE, timeout=30)
    width = int(re.search(r"(\d+)x(\d+)", adb("shell", "wm", "size")).group(1))
    labels = {}
    for node in nodes():
        if node.get("package") == PACKAGE and (node.get("text") or "") in AREAS:
            labels[node.get("text")] = bounds(node)
    assert set(labels) == set(AREAS), f"At font scale 2.0 the bar shows {sorted(labels)}"
    for name, (left, top, right, bottom) in labels.items():
        assert 0 <= left and right <= width, f"'{name}' runs off the screen: {(left, top, right, bottom)}"
        # A clipped name is as wide as its share of the bar; a whole one as wide as its words.
        assert (right - left) >= 0.3 * len(name) * (bottom - top), f"'{name}' is cut short: {(left, top, right, bottom)}"
    boxes = list(labels.values())
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            assert min(a[2], b[2]) <= max(a[0], b[0]) or min(a[3], b[3]) <= max(a[1], b[1]), f"Bar names overlap: {labels}"
    report["fontScaleBar"] = labels
    open_areas("font scale 2.0", KEYS)
    tap("Project")
    for name in ("Edit", "Add", "Import Model…"):
        find(name, timeout=20)
    tap("Device")
    tap("Add printer")
    for name in ADD_FIELDS:
        find(name, timeout=20)
    find("Save")
    find("Cancel")
    tap("Cancel")
    absent(ADD_FIELDS[2], timeout=20)
    put("system", "font_scale", saved[("system", "font_scale")])

    # Landscape: content clear of the bars, and fields above the keyboard.
    put("system", "accelerometer_rotation", "0")
    put("system", "user_rotation", "1")
    time.sleep(4)
    for area in AREAS:
        tap(area)
        find(KEYS[area], timeout=30)
        clear_of_bars(f"landscape {area}")
    tap("Prepare")
    report["landscapePrepareField"] = above_keyboard("Access token (only if the server requires one)", "landscape Prepare")
    tap("Device")
    tap("Add printer")
    report["landscapeDialogField"] = above_keyboard(ADD_FIELDS[2], "landscape Add printer")
    tap("Cancel")
    absent(ADD_FIELDS[2], timeout=20)
    put("system", "user_rotation", saved[("system", "user_rotation")] or "0")
    put("system", "accelerometer_rotation", saved[("system", "accelerometer_rotation")])
    time.sleep(3)
    tap("Device")
    tap("Add printer")
    report["portraitDialogField"] = above_keyboard(ADD_FIELDS[2], "portrait Add printer")
    tap("Cancel")
    absent(ADD_FIELDS[2], timeout=20)

    # Every animation off: the areas, a menu and a dialog still open and close.
    for key in ("window_animation_scale", "transition_animation_scale", "animator_duration_scale"):
        put("global", key, "0")
    screen.launch(PACKAGE)
    find(WORKSPACE, timeout=30)
    open_areas("animations off", KEYS)
    tap("Edit")
    find("Select All", timeout=20)
    screen.key(4)
    absent("Select All", timeout=20)
    tap("Device")
    tap("Add printer")
    find(ADD_FIELDS[0], timeout=20)
    tap("Cancel")
    absent(ADD_FIELDS[0], timeout=20)
    assert adb("shell", "pidof", PACKAGE), "The app is not running with animations off"
finally:
    adb("shell", "cmd", "uimode", "night", night if night in ("yes", "no", "auto") else "no")
    for (namespace, key), value in saved.items():
        put(namespace, key, value)
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "pm", "clear", PACKAGE)
report.update({
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
})
(output / "android-accessibility-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Theme and accessibility passed on API {report['api']} {report['abi']} emulator "
      f"({sum(report['auditedControls'].values())} controls named in five areas; dark tokens; font scale 2.0; "
      f"keyboard; animations off)")
