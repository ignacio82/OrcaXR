#!/usr/bin/env python3
"""Drive the Project area on an explicitly selected emulator through the system's document picker.

The app's data is cleared and a binary STL is placed in Downloads. The run
sees the Workspace draw an imported model on the bed, highlight it when
tapped and drop it on undo (screenshot against screenshot); it then imports
it (previewed, then committed as one undoable step), undoes and redoes
it with the buttons and with the browser's keyboard shortcuts, saves the project as a 3MF with "Save as", starts a new project, reopens
the saved one from the recent documents, keeps unsaved changes on Cancel,
saves them first on Save and drops them only on Discard, brings the window
holding a document forward rather than opening it twice, asks before saving
over a change made outside OrcaXR, refuses a document handed over outside the system's
document sharing, and after a restart reopens the recent document through its
persisted grant; a shared copy reaches the share sheet without saving; Back
with unsaved changes asks first, from any area; unsaved work survives the
process being killed in the background and the app's task being removed (as
a closed window or a swipe from Recents) or replaced by an update, and is
restored in the next session. The
saved file is checked to be a ZIP package.
"""
import argparse
import base64
import json
import re
import tempfile
from pathlib import Path
import subprocess
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
SAVED = "Untitled project.3mf"


screen = Screen(args.serial, output, "project")
adb, nodes, find, absent, tap = screen.adb, screen.nodes, screen.find, screen.absent, screen.tap
to_top, hide_keyboard, type_into, focused = screen.to_top, screen.hide_keyboard, screen.type_into, screen.focused


def launch():
    screen.launch(PACKAGE)
    find("Import a model in the Project area to see it here.")
    tap("Project")
    find("Untitled project", timeout=30)


def import_cube(objects):
    tap("Import Model…")
    tap("cube.stl", timeout=30)
    find("Import cube.stl?", timeout=30)
    find(f"The project will then have {objects} object(s). Importing is one step you can undo.")
    tap("Import")


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
cube = json.loads((ROOT / "testdata/cross-platform/model-import-vectors.json").read_text())
cube_bytes = next(case for case in cube["cases"] if case["name"] == "stl-binary/cube")["bytesBase64"]
staged = Path(tempfile.mkdtemp(prefix="orcaxr-project-smoke-")) / "cube.stl"
staged.write_bytes(base64.b64decode(cube_bytes))
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
# The device shell splits words itself: a path with a space is quoted for it.
adb("shell", f"rm -f /sdcard/Download/cube.stl '/sdcard/Download/{SAVED}'")
adb("push", str(staged), "/sdcard/Download/cube.stl")
staged.unlink()
staged.parent.rmdir()
adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:///sdcard/Download/cube.stl")
launch()
find("No unsaved changes")
find("0 objects")
# The Workspace draws the project: an imported model appears on the bed, a tap
# highlights it, and undo takes it away again (compared screenshot to screenshot
# below the overlay text, so the bed grid and labels never count).
width, height = screen.screenshot()[:2]
box = (0, 260, width, height - 220)


def workspace():
    tap("Workspace")
    time.sleep(4)
    return screen.screenshot()


empty = workspace()
tap("Project")
import_cube(1)
find("1 object", timeout=30)
drawn = workspace()
model = changed_pixels(empty, drawn, *box)
# The 20 mm test cube covers about 1,500 pixels of the framed 200 mm bed at this resolution.
assert len(model) > 800, f"The imported model was not drawn ({len(model)} pixels changed)"
x = sum(p[0] for p in model) // len(model)
y = sum(p[1] for p in model) // len(model)
adb("shell", "input", "tap", str(x), str(y))
time.sleep(2)
highlighted = screen.screenshot()
assert len(changed_pixels(drawn, highlighted, *box)) > 600, "A tap on the model did not highlight it"
adb("shell", "input", "keycombination", "113", "54")
time.sleep(4)
undone = screen.screenshot()
assert len(changed_pixels(empty, undone, *box)) < 200, "Undo left the model drawn"
tap("Project")
find("0 objects", timeout=30)
# Import: previewed, committed as one undoable step, undone and redone.
import_cube(1)
find("Undo Import cube.stl", timeout=30)
find("Unsaved changes")
find("1 object")
tap("Undo Import cube.stl")
find("0 objects", timeout=30)
tap("Redo Import cube.stl")
find("1 object", timeout=30)
# The browser's shortcuts from a hardware keyboard: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo.
adb("shell", "input", "keycombination", "113", "54")
find("0 objects", timeout=30)
adb("shell", "input", "keycombination", "113", "59", "54")
find("1 object", timeout=30)
adb("shell", "input", "keycombination", "113", "54")
find("0 objects", timeout=30)
adb("shell", "input", "keycombination", "113", "53")
find("1 object", timeout=30)
# Save as: the system's picker creates the document; the project is then clean.
tap("Save Project As…")
find(SAVED, timeout=30)
tap("SAVE")
find(f"Saved {SAVED}.", timeout=30)
find(f"{SAVED} · No unsaved changes")
assert adb("shell", f"head -c 2 '/sdcard/Download/{SAVED}'") == "PK", "The saved project is not a ZIP package"
# New project, then the saved one again from the recent documents.
tap("New Project")
find("0 objects", timeout=30)
tap(SAVED)
find("1 object", timeout=30)
find(f"{SAVED} · No unsaved changes")
# Unsaved changes: kept on Cancel; on Save, written to the document "Save as"
# created before the new project replaces them; dropped only on Discard.
import_cube(2)
find("2 objects", timeout=30)
tap("New Project")
find("Save changes to Untitled project?")
tap("Cancel")
find("2 objects")
tap("New Project")
find("Save changes to Untitled project?")
tap("Save")
find("0 objects", timeout=30)
find(f"Saved {SAVED}.")
tap(SAVED)
find("2 objects", timeout=30)
# One writer per document: the document this window holds, handed over again in
# a window of its own, brings this window forward and closes the new one.
recent = adb("shell", f"run-as {PACKAGE} cat shared_prefs/orcaxr.projects.xml")
held = re.search(r"content://[^\s<&\x00]+", recent).group(0)
adb("shell", f"am start -W -a android.intent.action.VIEW -t model/3mf -f 0x18080000 -d '{held}' -n {PACKAGE}/.MainActivity")


def windows():
    """The tasks the app's windows live in."""
    return set(re.findall(re.escape(PACKAGE) + r"/\.MainActivity t(\d+)", adb("shell", "dumpsys", "activity", "activities")))


time.sleep(2)
deadline = time.monotonic() + 20
while len(windows()) > 1:
    assert time.monotonic() < deadline, "A second window kept the held document"
    time.sleep(0.5)
assert PACKAGE in focused(), "The holding window was not brought forward"
find(f"{SAVED} · No unsaved changes")
# A change made outside OrcaXR is not overwritten unnoticed: Save asks first.
before = int(adb("shell", f"stat -c %s '/sdcard/Download/{SAVED}'"))
adb("shell", f"printf x >> '/sdcard/Download/{SAVED}'")
tap("Save Project")
find(f"{SAVED} changed outside OrcaXR", timeout=20)
tap("Cancel")
time.sleep(1)
assert int(adb("shell", f"stat -c %s '/sdcard/Download/{SAVED}'")) == before + 1, "Cancel wrote the document"
tap("Save Project")
tap("Overwrite", timeout=20)
find(f"Saved {SAVED}.", timeout=30)
assert adb("shell", f"head -c 2 '/sdcard/Download/{SAVED}'") == "PK", "Overwrite did not write a package"
import_cube(3)
find("3 objects", timeout=30)
tap("New Project")
tap("Discard")
find("0 objects", timeout=30)
# A document handed over outside the system's sharing is refused.
adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-t", "model/3mf",
    "-d", f"file:///sdcard/Download/{SAVED.replace(' ', '%20')}", "-n", f"{PACKAGE}/.MainActivity")
find("OrcaXR opens only documents shared through the system.", timeout=30)
# After a restart the recent document opens through its persisted grant.
launch()
tap(SAVED)
find("2 objects", timeout=30)
# Back with unsaved changes asks first; Cancel stays, Discard leaves. First,
# a copy shared through the system's share sheet leaves the project unsaved.
import_cube(3)
find("3 objects", timeout=30)
tap("Share")
deadline = time.monotonic() + 20
while "Chooser" not in focused():
    assert time.monotonic() < deadline, f"No share sheet: {focused()}"
    time.sleep(0.5)
adb("shell", "input", "keyevent", "4")
find(f"{SAVED} · Unsaved changes")
assert adb("shell", f"run-as {PACKAGE} ls cache/shared") == SAVED, "The shared copy is missing"
assert adb("shell", f"run-as {PACKAGE} head -c 2 'cache/shared/{SAVED}'") == "PK", "The shared copy is not a ZIP package"
tap("Device")
adb("shell", "input", "keyevent", "4")
find("Save changes to Untitled project?")
tap("Cancel")
find("3 objects")
adb("shell", "input", "keyevent", "4")
tap("Discard")


deadline = time.monotonic() + 20
while PACKAGE in focused():
    assert time.monotonic() < deadline, "The app stayed in front after Discard"
    time.sleep(0.5)
# Process death: unsaved work is kept as the app leaves the screen, and the
# next session offers it back; the restored copy stays until discarded.
launch()
find("0 objects")
import_cube(1)
find("1 object", timeout=30)
adb("shell", "input", "keyevent", "3")
time.sleep(4)
adb("shell", "am", "kill", PACKAGE)
deadline = time.monotonic() + 20
while subprocess.run(["adb", "-s", args.serial, "shell", "pidof", PACKAGE], capture_output=True, text=True).stdout.strip():
    assert time.monotonic() < deadline, "The app's process outlived its kill"
    time.sleep(0.5)
adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
# The system restores the activity it ended, on the Project area it showed.
find("Unsaved work: Untitled project", timeout=30)
tap("Restore")
find("Restored Untitled project. Save it to keep it.", timeout=30)
find("1 object")
tap("Discard")
absent_deadline = time.monotonic() + 20
while any((node.get("text") or "") == "Unsaved work: Untitled project" for node in nodes()):
    assert time.monotonic() < absent_deadline, "The discarded copy is still offered"
    time.sleep(0.5)
# Its task removed right after an edit — as a window closed or the app swiped
# away from Recents, it finishes without asking, before the timed capture: the
# unsaved work is kept as it leaves and offered by the next session.
task = re.search(r"taskId=(\d+): " + re.escape(PACKAGE), adb("shell", "am", "stack", "list")).group(1)
screen.to_top()
tap("Import Model…")
tap("cube.stl", timeout=30)
find("Import cube.stl?", timeout=30)
tap("Import")
edited = time.monotonic()
find("Unsaved changes", timeout=10)
adb("shell", "am", "stack", "remove", task)
# Well before the 5 s timed capture: only the capture as the app leaves can keep it.
assert time.monotonic() - edited < 4, "The task was removed too late to tell the captures apart"
deadline = time.monotonic() + 20
while f"{PACKAGE}/.MainActivity" in adb("shell", "dumpsys", "activity", "activities"):
    assert time.monotonic() < deadline, "The app's activity outlived its task"
    time.sleep(0.5)
time.sleep(4)
launch()
find("Unsaved work: Untitled project", timeout=30)
tap("Discard")
deadline = time.monotonic() + 20
while any((node.get("text") or "") == "Unsaved work: Untitled project" for node in nodes()):
    assert time.monotonic() < deadline, "The discarded copy is still offered"
    time.sleep(0.5)
# An update replaces the app while it runs: the system ends it without asking.
# Work older than the timed capture's 5 s is offered by the updated app.
screen.to_top()
tap("Import Model…")
tap("cube.stl", timeout=30)
find("Import cube.stl?", timeout=30)
tap("Import")
find("Unsaved changes", timeout=10)
time.sleep(7)
adb("install", "-r", str(app_apk))
launch()
find("Unsaved work: Untitled project", timeout=30)
tap("Discard")
deadline = time.monotonic() + 20
while any((node.get("text") or "") == "Unsaved work: Untitled project" for node in nodes()):
    assert time.monotonic() < deadline, "The discarded copy is still offered"
    time.sleep(0.5)
report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "savedBytes": int(adb("shell", f"stat -c %s '/sdcard/Download/{SAVED}'")),
}
(output / "android-project-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Project area passed on API {report['api']} {report['abi']} emulator ({report['savedBytes']}-byte 3MF saved and reopened)")
