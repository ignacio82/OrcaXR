#!/usr/bin/env python3
"""Drive the Project area on an explicitly selected emulator through the system's document picker.

The app's data is cleared and a binary STL is placed in Downloads. The run
imports it (previewed, then committed as one undoable step), undoes and redoes
it, saves the project as a 3MF with "Save as", starts a new project, reopens
the saved one from the recent documents, keeps unsaved changes on Cancel,
saves them first on Save and drops them only on Discard, refuses a document handed over outside the system's
document sharing, and after a restart reopens the recent document through its
persisted grant. The saved file is checked to be a ZIP package.
"""
import argparse
import base64
import json
import tempfile
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from artifacts import ROOT, sha256

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
if not re.fullmatch(r"emulator-\d+", args.serial):
    raise SystemExit("This unattended smoke test only installs on an explicitly selected emulator")
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
SAVED = "Untitled project.3mf"


def adb(*command, timeout=120):
    return subprocess.check_output(["adb", "-s", args.serial, *command], text=True, timeout=timeout).strip()


def nodes():
    adb("shell", "uiautomator", "dump", "/data/local/tmp/orcaxr-project.xml")
    return list(ET.fromstring(adb("shell", "cat", "/data/local/tmp/orcaxr-project.xml")).iter("node"))


def center(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    return (left + right) // 2, (top + bottom) // 2


def find(text, timeout=20):
    """The node showing [text], scrolling the list on to its end and back until it shows."""
    deadline = time.monotonic() + timeout
    onward, placed, seen = True, None, []
    while time.monotonic() < deadline:
        current = nodes()
        for node in current:
            value = node.get("text") or node.get("content-desc") or ""
            if value == text:
                return node
            if value and value not in seen:
                seen.append(value)
        layout = [node.get("bounds") for node in current]
        if layout == placed:
            onward = not onward
        placed = layout
        start, end = ("900", "500") if onward else ("500", "900")
        adb("shell", "input", "swipe", "360", start, "360", end, "300")
        time.sleep(0.3)
    (output / "project-smoke-seen.txt").write_text("\n".join(seen) + "\n")
    raise AssertionError(f"'{text}' never appeared")


def tap(text, **kwargs):
    x, y = center(find(text, **kwargs))
    adb("shell", "input", "tap", str(x), str(y))


def launch():
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
    find("Workspace preview — editing is not available yet.")
    tap("Project")
    find("Untitled project", timeout=30)


def import_cube(objects):
    tap("Import model")
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
# Import: previewed, committed as one undoable step, undone and redone.
import_cube(1)
find("Undo Import cube.stl", timeout=30)
find("Unsaved changes")
find("1 object")
tap("Undo Import cube.stl")
find("0 objects", timeout=30)
tap("Redo Import cube.stl")
find("1 object", timeout=30)
# Save as: the system's picker creates the document; the project is then clean.
tap("Save as")
find(SAVED, timeout=30)
tap("SAVE")
find(f"Saved {SAVED}.", timeout=30)
find(f"{SAVED} · No unsaved changes")
assert adb("shell", f"head -c 2 '/sdcard/Download/{SAVED}'") == "PK", "The saved project is not a ZIP package"
# New project, then the saved one again from the recent documents.
tap("New project")
find("0 objects", timeout=30)
tap(SAVED)
find("1 object", timeout=30)
find(f"{SAVED} · No unsaved changes")
# Unsaved changes: kept on Cancel; on Save, written to the document "Save as"
# created before the new project replaces them; dropped only on Discard.
import_cube(2)
find("2 objects", timeout=30)
tap("New project")
find("Save changes to Untitled project?")
tap("Cancel")
find("2 objects")
tap("New project")
find("Save changes to Untitled project?")
tap("Save")
find("0 objects", timeout=30)
find(f"Saved {SAVED}.")
tap(SAVED)
find("2 objects", timeout=30)
import_cube(3)
find("3 objects", timeout=30)
tap("New project")
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
report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "savedBytes": int(adb("shell", f"stat -c %s '/sdcard/Download/{SAVED}'")),
}
(output / "android-project-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Project area passed on API {report['api']} {report['abi']} emulator ({report['savedBytes']}-byte 3MF saved and reopened)")
