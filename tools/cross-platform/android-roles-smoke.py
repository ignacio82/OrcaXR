#!/usr/bin/env python3
"""Drive the semantic editor's volume roles and Set as Negative Part on an explicitly selected emulator.

The app's data is cleared. A cube is added from the Project area's Add menu;
with its instance selected the inspector's "Volume role" section gives the
browser's hint. A modifier is added (the new part selected): the section
shows the part and its role, "Convert to" lists every role in Orca's order
with the current one marked and not offered ("This is the current role; no
conversion is needed."), and choosing "Negative volume" converts it — one
"Undo Convert volume to negative part", the browser's "Converted … to
Negative volume.", the tree's role indicator following. The cube's own part,
selected from the tree, is the object's last model part: every other role
is refused in the command's words. With the instance selected, "Set as
Negative Part" from the Add menu adds a negative volume ("Undo Add negative
part to object"), and so does the command palette's (found with the
browser's hint, run with Enter); undo takes every step back to the modifier.

Lessons kept from the earlier smokes: an action on the selection waits for
the core to enable it; rows are found by text, never by position; a choice's
enablement is read from its clickable node, not the text inside it.
"""
import argparse
import json
import re
import time
import xml.etree.ElementTree as ET
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
CURRENT = "This is the current role; no conversion is needed."
LAST_MODEL = "The last model part on an object cannot be converted to a non-model role"

screen = Screen(args.serial, output, "roles")
adb, find, tap, enabled = screen.adb, screen.find, screen.tap, screen.enabled


def menu(name, action, timeout=30):
    """An action from the Project area's [name] menu, once the core enables it."""
    deadline = time.monotonic() + timeout
    while True:
        tap(name)
        if enabled(action):
            tap(action)
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)  # Back closes the open menu before it is opened again.
        time.sleep(1)


def bounds(node):
    return tuple(map(int, re.findall(r"\d+", node.get("bounds"))))


def control(text, timeout=60):
    """Taps the enabled control showing [text] (a role choice's row, not the text inside it)."""
    deadline = time.monotonic() + timeout
    while True:
        find(text, timeout=timeout)
        root = ET.fromstring(adb("shell", "cat", screen.dump))
        parents = {child: parent for parent in root.iter("node") for child in parent}
        for node in root.iter("node"):
            if (node.get("text") or node.get("content-desc") or "") != text:
                continue
            clickable = node
            while clickable is not None and clickable.get("clickable") != "true":
                clickable = parents.get(clickable)
            if clickable is not None and clickable.get("enabled") == "true":
                left, top, right, bottom = bounds(clickable)
                adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                return
        assert time.monotonic() < deadline, f"No enabled control shows '{text}'"
        time.sleep(1)


def choices():
    """The "Convert to" choices on screen, lifted into view: each role's label, whether it is
    offered (its row enabled), whether it is the current one, and the words under it."""
    screen.lift(find("Convert to", timeout=60))
    root = ET.fromstring(adb("shell", "cat", screen.dump))
    found = {}
    for node in root.iter("node"):
        # A choice is its radio row (a disabled one reports no click).
        if node.get("checkable") != "true":
            continue
        texts = [n.get("text") for n in node.iter("node") if n.get("text")]
        if texts and texts[0] in ("Part", "Negative volume", "Parameter modifier", "Support blocker", "Support enforcer"):
            found[texts[0]] = {
                "offered": node.get("enabled") == "true",
                "current": node.get("checked") == "true",
                "reason": texts[1] if len(texts) > 1 else None,
            }
    return found


def tap_nth(text, index):
    """Taps the [index]th node showing [text] (rows sharing a name: an object and its part)."""
    deadline = time.monotonic() + 60
    while True:
        nodes = [n for n in screen.nodes() if (n.get("text") or "") == text]
        if len(nodes) > index:
            x, y = screen.center(nodes[index])
            adb("shell", "input", "tap", str(x), str(y))
            return
        assert time.monotonic() < deadline, f"Fewer than {index + 1} rows show '{text}'"
        find(text)
        time.sleep(1)


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
screen.launch(PACKAGE)
find("Import a model in the Project area to see it here.")

# A cube: its instance selected, the section gives the browser's hint.
tap("Project")
find("Untitled project", timeout=30)
menu("Add", "Cube")
find("Undo Add cube.stl", timeout=30)
find("Volume role", timeout=60)
find("Select a part or semantic volume to inspect its role.", timeout=60)

# A modifier, selected as it lands: its role and every role it could become.
menu("Add", "Add Modifier")
find("Undo Add modifier to object", timeout=60)
summary = find(" — Parameter modifier", exact=False, timeout=60).get("text")
name = summary.rsplit(" — ", 1)[0]
listed = choices()
assert list(listed) == ["Part", "Negative volume", "Parameter modifier", "Support blocker", "Support enforcer"], listed
assert listed["Parameter modifier"] == {"offered": False, "current": True, "reason": CURRENT}, listed
assert all(listed[r]["offered"] and not listed[r]["current"] for r in listed if r != "Parameter modifier"), listed
find("Changes are applied only after the canonical adapter accepts a guarded request.")

# "Negative volume": one step, the browser's words, the tree's role indicator.
control("Negative volume")
find("Undo Convert volume to negative part", timeout=60)
find(f"Converted {name} to Negative volume.", timeout=60)
find(f"{name} — Negative volume", timeout=60)
converted = choices()
assert converted["Negative volume"]["current"] and not converted["Negative volume"]["offered"], converted
assert converted["Parameter modifier"]["offered"], converted
# The object's rows opened, the part's row shows its new role.
screen.to_top()
tap("Expand cube.stl")
find("negative-volume", timeout=60)

# The cube's own part is the object's last model part: every other role is refused in the command's words.
screen.to_top()
tap_nth("cube.stl", 1)
find("cube.stl — Part", timeout=60)
body = choices()
assert body["Part"] == {"offered": False, "current": True, "reason": CURRENT}, body
assert all(body[r] == {"offered": False, "current": False, "reason": LAST_MODEL} for r in body if r != "Part"), body

# Set as Negative Part on the selected instance adds a negative volume.
menu("Edit", "Select All")
find("Select a part or semantic volume to inspect its role.", timeout=60)
menu("Add", "Set as Negative Part")
find("Undo Add negative part to object", timeout=60)
find(" — Negative volume", exact=False, timeout=60)

tap("Undo Add negative part to object")
find("Undo Convert volume to negative part", timeout=60)

# The command palette offers it too, with the browser's hint: Enter runs it as the menu does.
find("Select a part or semantic volume to inspect its role.", timeout=60)
adb("shell", "input", "keycombination", "113", "39")
find("Search every action", timeout=20)
time.sleep(1)
adb("shell", "input", "text", "negative%spart")
find("Set as Negative Part", timeout=20)
find("Turn the selected part into a negative (cut) volume", timeout=20)
screen.key(66)
find("Undo Add negative part to object", timeout=60)

# Undo walks back to the modifier.
tap("Undo Add negative part to object")
find("Undo Convert volume to negative part", timeout=60)
tap("Undo Convert volume to negative part")
find("Undo Add modifier to object", timeout=60)

report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "modifier": summary,
    "modifierChoices": listed,
    "bodyChoices": body,
}
(output / "android-roles-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Roles smoke passed on API {report['api']}")
