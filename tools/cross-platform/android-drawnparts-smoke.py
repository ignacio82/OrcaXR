#!/usr/bin/env python3
"""Drive the Workspace's Emboss Text and SVG Part tools on an explicitly selected emulator.

The app's data is cleared and the browser's journey font (a synthetic TrueType file the corpus builds,
testdata/cross-platform/drawn-part-vectors.json) and one of its drawings are placed in Downloads. A cube
is added from the Project area's Add menu and selected with Select All.

Emboss Text: the model toolbar's tool takes the Workspace (the toolbar shows it) and the browser's Emboss
panel its foot, saying a font is needed. Load an emboss font opens the system's picker; the font chosen
there names the panel's font, and the hint says the text will be a new part of the cube. "AOi" is added —
the browser's 904 triangles, one "Add embossed text" — and a text the font has no glyph for is refused in
the core's words. With the new text part selected in the Project area's tree, the panel offers Update
text; a 7.5 mm size re-cuts it as one "Edit embossed text", which undo takes back.

SVG Part: the toolbar's tool replaces Emboss Text. Load an SVG drawing reads the picked drawing — its size
and the part of it that cannot be cut, listed — and with the text part still selected (not an SVG part)
Add part adds the drawing to the cube as one "Add SVG part", its status naming what was not cut. Undo
takes the steps back to the cube; Done ends the tool.
"""
import argparse
import base64
import json
import re
import tempfile
import time
from pathlib import Path
from artifacts import ROOT
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
FONT = "sample.ttf"
DRAWING = "badge.svg"

screen = Screen(args.serial, output, "drawnparts")
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


def choose_tool(description):
    """The toolbar's [description] chosen: it becomes the Workspace's tool. A tap on the navigation's
    Workspace, already shown, then hides the button's tooltip."""
    adb("shell", "input", "tap", *map(str, screen.center(tool(description))))
    tap("Workspace")
    deadline = time.monotonic() + 20
    while tool(description).get("checked") != "true":
        assert time.monotonic() < deadline, f"The toolbar never showed {description} as the tool"
        time.sleep(0.5)


def pick_download(name):
    """Chooses [name] from Downloads in the system picker: Recent lists files lately added; through its
    roots when Recent lacks it."""
    try:
        tap(name, timeout=20)
    except AssertionError:
        tap("Show roots")
        time.sleep(1.5)
        tap("Downloads")
        time.sleep(2)
        tap(name, timeout=60)


def press(text, timeout=60):
    """The panel's button [text], once enabled."""
    deadline = time.monotonic() + timeout
    while not screen.enabled(text):
        assert time.monotonic() < deadline, f"'{text}' never became enabled"
        time.sleep(0.5)
    tap(text)


def undo(label):
    """Undo [label] from the Project area, back in the Workspace after."""
    tap("Project")
    find(f"Undo {label}", timeout=30)
    tap(f"Undo {label}")
    tap("Workspace")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
corpus = json.loads((ROOT / "testdata/cross-platform/drawn-part-vectors.json").read_text())
journey = corpus["journey"]
assert journey["font"]["name"] == FONT
files = {FONT: base64.b64decode(journey["font"]["bytes"])}
files[DRAWING] = base64.b64decode(next(d for d in journey["drawings"] if d["name"] == DRAWING)["bytes"])
staging = Path(tempfile.mkdtemp(prefix="orcaxr-drawnparts-smoke-"))
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
for name, data in files.items():
    staged = staging / name
    staged.write_bytes(data)
    adb("shell", "rm", "-f", f"/sdcard/Download/{name}")
    adb("push", str(staged), f"/sdcard/Download/{name}")
    staged.unlink()
    adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file:///sdcard/Download/{name}")
staging.rmdir()
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")

# A cube, selected.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
menu("Edit", "Select All")
tap("Workspace")
time.sleep(2)

# Emboss Text: the tool, its panel and its status; a font picked through the system's picker.
choose_tool("Emboss Text")
find("Emboss text", timeout=30)
find("Emboss: choose a .ttf font file first.", timeout=30)
find("Choose a .ttf font file.")
assert not screen.enabled("Add text"), "Add text was enabled without a font"
tap("Load an emboss font")
pick_download(FONT)
find(f"Loaded {FONT} for embossing.", timeout=60)
find(f"Font — {FONT}", timeout=30)
find("Adds the text as a new part of the selected model.", timeout=30)

# "AOi", added to the cube: the browser's mesh, one step.
screen.type_into("Text", "AOi")
press("Add text")
find("Embossed the text as 904 triangles.", timeout=60)
tap("Project")
find("Undo Add embossed text", timeout=30)
tap("Workspace")

# A text the font has no glyph for is refused in the core's words, and nothing changes.
screen.type_into("Text", "zz")
press("Add text")
find("Emboss failed: The chosen font has no glyph for any character in this text", timeout=60)
screen.type_into("Text", "AOi")

# The text part, selected in the tree, is re-cut at 7.5 mm as one step.
tap("Project")
find("Undo Add embossed text", timeout=30)
# The object's rows, collapsed while it had one part, are opened to reach the new one.
try:
    tap("Expand cube.stl", timeout=30)
except AssertionError:
    find("Collapse cube.stl")
tap("AOi", timeout=60)
tap("Workspace")
find("Editing the selected text re-cuts its mesh; undo restores the previous cut.", timeout=30)
screen.type_into("Size (mm)", "7.5")
press("Update text")
tap("Project")
find("Undo Edit embossed text", timeout=30)
tap("Undo Edit embossed text")
find("Undo Add embossed text", timeout=30)
tap("Workspace")

# SVG Part replaces Emboss Text; the drawing is read with its size and what cannot be cut.
choose_tool("SVG Part")
absent("Emboss text")
find("SVG part", timeout=30)
find("SVG part: choose an .svg file to cut.", timeout=30)
tap("Load an SVG drawing")
pick_download(DRAWING)
find(f"Loaded {DRAWING} at 40.0 x 20.0 mm. 1 part(s) of it cannot be cut.", timeout=60)
find(f"Drawing — {DRAWING}", timeout=30)
find("• <text> needs a font; add it with the text emboss tool instead", timeout=30)
# The selected text part is not an SVG part: the drawing is added to its object.
find("Adds the drawing as a new part of the selected model.", timeout=30)
press("Add part")
find(f"Cut {DRAWING} at 40.0 x 20.0 mm. Not cut: <text> needs a font; add it with the text emboss tool instead", timeout=60)
tap("Project")
find("Undo Add SVG part", timeout=30)
tap("Undo Add SVG part")
find("Undo Add embossed text", timeout=30)
tap("Undo Add embossed text")
find("Undo Add cube.stl", timeout=30)

# Done ends the tool.
tap("Workspace")
tap("Done")
absent("SVG part")
assert tool("SVG Part").get("checked") != "true", "SVG Part stayed the tool after Done"
print("Drawn parts smoke passed")
