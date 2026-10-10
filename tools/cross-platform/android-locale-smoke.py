#!/usr/bin/env python3
"""Drive the app in other languages on an explicitly selected emulator (API 33 and later).

The app's language is set as the system's per-app language setting sets it
(`cmd locale set-app-locales`). In German, the areas show the browser's German
catalogue's words — read from web/public/l10n/de.json through the mapping in
contracts/android-strings.json, so the run checks what the generator carried —
and a resource no browser message carries stays English, as the browser shows
a message its catalogue lacks. Under the debug build's ar-XB pseudo-locale the
layout mirrors right-to-left (the bottom bar's first area on the right) and
every area opens without a crash; under en-XA the bar's words are expanded and
accented. The app's language is reset at the end, whatever happened.
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
contract = json.loads((ROOT / "contracts/android-strings.json").read_text())
german = json.loads((ROOT / "web/public/l10n/de.json").read_text())
english = json.loads((ROOT / "web/public/l10n/en.json").read_text())
# Bidirectional controls the ar-XB pseudo-locale wraps around each word.
BIDI = re.compile("[‎‏‪-‮⁦-⁩]")

screen = Screen(args.serial, output, "locale")
adb, find, tap, nodes = screen.adb, screen.find, screen.tap, screen.nodes


def words(name, catalogue):
    """What resource [name] says in [catalogue]: its mapped browser message there."""
    key = contract["resources"][name]["key"]
    return catalogue[key]


def set_language(tags):
    """The app's own language, as the system's per-app setting sets it."""
    adb("shell", "cmd", "locale", "set-app-locales", PACKAGE, "--locales", tags)
    reported = adb("shell", "cmd", "locale", "get-app-locales", PACKAGE)
    assert f"[{tags}]" in reported, f"The app's language was not set to {tags}: {reported}"


def reset_language():
    """The system's language again: an empty list, which is what no --locales sets."""
    adb("shell", "cmd", "locale", "set-app-locales", PACKAGE)


def shown():
    """Every text on screen without bidirectional controls, with its node's centre."""
    return [(BIDI.sub("", node.get("text") or ""), screen.center(node)) for node in nodes() if node.get("text")]


def bar():
    """Each text's lowest centre on screen: the bottom bar's labels, wherever else a word recurs."""
    lowest = {}
    for text, (x, y) in shown():
        if text not in lowest or y > lowest[text][1]:
            lowest[text] = (x, y)
    return lowest


def alive():
    pid = adb("shell", "pidof", PACKAGE)
    assert pid, "The app is not running"
    assert PACKAGE in screen.focused(), "The app lost the screen"


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
api = screen.api()
assert api >= 33, f"Per-app languages need API 33; this emulator runs {api}"
adb("install", "-r", str(app_apk))
adb("shell", "pm", "clear", PACKAGE)
checked = []
try:
    # German: the browser's German words where it has them, English where it has none.
    set_language("de")
    screen.launch(PACKAGE)
    find("Import a model in the Project area to see it here.")
    for name in ("nav_prepare", "nav_preview", "nav_device", "nav_project"):
        assert words(name, german) != words(name, english), f"{name} is not translated in the German catalogue"
        find(words(name, german))
        checked.append(name)
    # The workspace's own name has no German message, so it stays English.
    assert contract["resources"]["nav_workspace"]["key"] not in german
    find(words("nav_workspace", english))
    tap(words("nav_project", german))
    for name in ("project_new", "project_open", "project_save", "project_undo"):
        find(words(name, german), timeout=30)
        checked.append(name)
    # A resource the browser has no message for, in English beside them.
    find("Plates and objects")
    tap(words("nav_prepare", german))
    find(words("prepare_remove", german), timeout=30)
    checked.append("prepare_remove")
    find("External slicer")
    alive()

    # ar-XB mirrors the layout: the bar's first area, the Workspace, is on the right.
    set_language("ar-XB")
    screen.launch(PACKAGE)
    deadline = time.monotonic() + 20
    while True:
        labels = bar()
        if "Workspace" in labels and "Project" in labels:
            break
        assert time.monotonic() < deadline, f"The bottom bar never showed under ar-XB: {sorted(labels)}"
        time.sleep(0.5)
    assert labels["Workspace"][0] > labels["Project"][0], "ar-XB did not lay the bar out right-to-left"
    raw = [node.get("text") or "" for node in nodes()]
    assert any(BIDI.search(text) for text in raw), "ar-XB did not pseudo-localize the app's words"
    for area in ("Prepare", "Preview", "Device", "Project", "Workspace"):
        x, y = bar()[area]
        adb("shell", "input", "tap", str(x), str(y))
        time.sleep(2)
        alive()

    # en-XA expands and accents every resource: no bar label reads as written.
    set_language("en-XA")
    screen.launch(PACKAGE)
    time.sleep(3)
    texts = list(bar())
    assert "Prepare" not in texts and "Project" not in texts, f"en-XA left the bar's words as they are: {texts}"
    assert any(text.startswith("[") for text in texts), f"en-XA did not pseudo-localize the bar: {texts}"
    alive()
finally:
    # Reset whatever failed, without hiding why it failed.
    reset_language()
reported = adb("shell", "cmd", "locale", "get-app-locales", PACKAGE)
assert reported.rstrip().endswith("[]"), f"The app's language was not reset: {reported}"
report = {
    "evidenceKind": "emulator-only",
    "api": str(api),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "appSha256": sha256(app_apk),
    "germanResources": checked,
}
(output / "android-locale-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Languages passed on API {report['api']} {report['abi']} emulator: German ({len(checked)} resources), ar-XB, en-XA")
