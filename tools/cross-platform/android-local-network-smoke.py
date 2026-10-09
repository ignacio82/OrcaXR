#!/usr/bin/env python3
"""Drive Android 17's local-network permission through the Device area on an explicitly selected API 37+ emulator.

The simulator runs on this machine and is reached as 10.0.2.2, a private
address, so every exchange needs ACCESS_LOCAL_NETWORK. With the permission
never asked, the run adds the simulator and connects: refused at once, in
words, with nothing sent. It then asks and is denied, asks and is denied
again — after which the system no longer asks and the card offers the app's
settings — is granted there (as the operator would), reads it again on
resume and connects; the grant is revoked (the system ends the app), the
connection is refused again, and "Find printers" asks before it looks and
searches once allowed. The simulator must receive nothing while denied.
"""
import argparse
import json
import subprocess
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
PROMPT = "Allow OrcaXR to find, connect to, and determine the relative position of nearby devices?"
CARD = "OrcaXR needs permission to reach devices on your local network before it can connect to this printer."
REFUSED = "OrcaXR may not use the local network, so it cannot reach 10.0.2.2. Allow nearby devices for OrcaXR in the system settings."


screen = Screen(args.serial, output, "local-network")
adb, nodes, find, absent, tap = screen.adb, screen.nodes, screen.find, screen.absent, screen.tap
to_top, hide_keyboard, type_into, focused = screen.to_top, screen.hide_keyboard, screen.type_into, screen.focused


def granted():
    return f"{PERMISSION}: granted=true" in adb("shell", "dumpsys", "package", PACKAGE)


def front():
    """Brings the app back to the front, so it reads the permission again on resume."""
    adb("shell", "input", "keyevent", "3")
    time.sleep(1)
    adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")


assert int(adb("shell", "getprop", "ro.build.version.sdk")) >= 37, "Android 17's permission needs an API 37 emulator"
simulator = subprocess.Popen(["node", "tools/cross-platform/moonraker-simulator-serve.mjs", "{}"], cwd=ROOT,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)


def received():
    simulator.stdin.write("summary\n")
    simulator.stdin.flush()
    return json.loads(simulator.stdout.readline())["requests"]


try:
    port = simulator.stdout.readline().strip().rsplit(":", 1)[1]
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    adb("shell", "pm", "revoke", PACKAGE, PERMISSION)
    adb("shell", "pm", "clear-permission-flags", PACKAGE, PERMISSION, "user-set", "user-fixed")
    screen.launch(PACKAGE)
    find("Workspace preview — editing is not available yet.")
    tap("Device")
    tap("Add printer")
    type_into("Name", "Simulator")
    type_into("Address", "10.0.2.2")
    type_into("Port (7125 if empty)", port)
    tap("Save")
    find(f"10.0.2.2 · port {port}")
    # Never asked: the card explains, and a connection is refused at once, in words.
    find(CARD)
    tap("Connect")
    find(REFUSED, timeout=10)
    tap("Dismiss")
    # Asked and denied: the system may ask again.
    tap("Allow local network access")
    find(PROMPT)
    tap("Don’t allow")
    find(CARD)
    find("Allow local network access")
    # Denied again: the system no longer asks, so the card offers the app's settings.
    tap("Allow local network access")
    find(PROMPT)
    tap("Don’t allow")
    find("Open app settings")
    assert received() == [], "A request reached the printer while the permission was denied"
    # Granted in the settings, as the operator would: read again on resume.
    adb("shell", "pm", "grant", PACKAGE, PERMISSION)
    front()
    absent(CARD)
    tap("Connect")
    find("Idle", timeout=30)
    assert "GET /server/info" in received(), "The granted connection never reached the printer"
    # Revoked: the system ends the app; reopened, the printer is refused again.
    before = len(received())
    adb("shell", "pm", "revoke", PACKAGE, PERMISSION)
    adb("shell", "pm", "clear-permission-flags", PACKAGE, PERMISSION, "user-set", "user-fixed")
    screen.launch(PACKAGE)
    tap("Device")
    find(CARD, timeout=30)
    tap("Connect")
    find(REFUSED, timeout=10)
    tap("Dismiss")
    assert len(received()) == before, "A request reached the printer after the grant was revoked"
    # Discovery asks before it looks, and searches once allowed.
    tap("Find printers")
    find(PROMPT)
    tap("Allow")
    find("No printer answered. Moonraker announces itself only when its zeroconf component is enabled; add the printer by its address instead.", timeout=40)
    assert granted(), "The permission was not granted from the prompt"
    absent(CARD)
    report = {
        "evidenceKind": "emulator-only",
        "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "release": adb("shell", "getprop", "ro.build.version.release"),
        "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
        "appSha256": sha256(app_apk),
        "requestsWhileDenied": 0,
    }
    (output / "android-local-network-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Local-network permission passed on API {report['api']} (Android {report['release']}) {report['abi']} emulator")
finally:
    try:
        simulator.stdin.write("close\n")
        simulator.stdin.flush()
        simulator.wait(timeout=10)
    except Exception:
        simulator.kill()
