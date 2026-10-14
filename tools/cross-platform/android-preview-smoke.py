#!/usr/bin/env python3
"""Drive the Preview area — the browser's "Open G-code Viewer…" — on an explicitly selected emulator.

A two-layer, two-tool reference G-code is placed in Downloads and opened
through the system's document picker; the shared core's preview draws its
toolpaths (screenshot against the empty view) with the totals the file states,
as the browser's panel words them, recolours them by tool, shows
a single layer, keeps them when the operator leaves the area and returns, and
refuses an empty file in the browser's words.
"""
import argparse
import json
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen, changed_pixels, saturated_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
fixture = ROOT / "testdata/parity/fixtures/reference.gcode"
SHOWING = "Showing reference.gcode — Layers 1 through 2, Z 0.2 through 0.4 mm"

screen = Screen(args.serial, output, "preview")
adb, find, tap = screen.adb, screen.find, screen.tap


def pick_download(name):
    """Chooses [name] from Downloads in the system picker: Recent lists files lately added, a scroll
    or two down; through its roots when Recent lacks it."""
    try:
        tap(name, timeout=20)
    except AssertionError:
        tap("Show roots")
        time.sleep(1.5)
        tap("Downloads")
        time.sleep(2)
        tap(name, timeout=60)


def drawn():
    time.sleep(4)
    return screen.screenshot()


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
adb("shell", "rm -f /sdcard/Download/reference.gcode /sdcard/Download/empty.gcode")
adb("push", str(fixture), "/sdcard/Download/reference.gcode")
adb("shell", "touch /sdcard/Download/empty.gcode")
for name in ("reference.gcode", "empty.gcode"):
    adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file:///sdcard/Download/{name}")
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")
tap("Preview")
find("Slice the plate or open a G-code file to inspect toolpaths.")
width = screen.screenshot()[0]
# The toolpath view fills the upper half above the controls.
view = (0, 80, width, 520)
empty = drawn()
tap("Open G-code file…")
pick_download("reference.gcode")
find(SHOWING, timeout=30)
# The file's own totals, from the shared core's summary.
find("≈42s · 0.02 g")
lines = drawn()
# Toolpaths are drawn in the core's saturated colours; the bed origin indicator is ~20 pixels, toolpaths >150.
assert saturated_pixels(empty, *view) < 50, "The empty view already shows coloured lines"
toolpaths = saturated_pixels(lines, *view)
assert toolpaths > 150, f"The toolpaths were not drawn ({toolpaths} coloured pixels)"
# Coloured by tool rather than by line type.
tap("Line Type")
tap("Tool")
by_tool = drawn()
assert len(changed_pixels(lines, by_tool, *view)) > 30, "The tool colours did not replace the line types"
# Only the top layer.
tap("Single layer")
single = drawn()
assert len(changed_pixels(by_tool, single, *view)) > 30, "Single layer did not change the view"
# Leaving the area and returning keeps the preview.
tap("Project")
tap("Preview")
find("Showing reference.gcode", exact=False, timeout=30)
# An empty file is refused in the browser's words.
tap("Open G-code file…")
pick_download("empty.gcode")
find("empty.gcode is empty.", exact=False, timeout=30)
report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "toolpathPixels": toolpaths,
}
(output / "android-preview-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Preview area passed on API {report['api']} {report['abi']} emulator ({toolpaths} toolpath pixels)")
