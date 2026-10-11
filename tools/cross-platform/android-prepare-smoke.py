#!/usr/bin/env python3
"""Drive the Prepare area — slicing the active plate on the external slicer — on an explicitly selected emulator.

The real external slicer server runs on this machine (headless, its engine a
stand-in that writes the two-layer reference G-code; the emulator reaches the
host at 10.0.2.2) with a bearer token. A cube is imported through the system's
document picker into a fresh project, which starts — as the browser's new
document does — from the catalog's default profile (Snapmaker U1, 0.4 mm,
four heads). Prepare shows the slicer offline and the device's own engine as
the route (android-local-slice-smoke.py slices on it); a
connection without the token shows the policy's refusal, with the token the
attested engine. The cube passes the shared preflight; another printer chosen
from the picker becomes the project's configuration as one undoable step and
passes too. The first slice asks before uploading the plate, then the G-code
opens in Preview (toolpaths drawn); the next slice to the same slicer does not
ask again — held by the server, it is cancelled and the cancellation
confirmed. Sliced again, then a second cube imported: the G-code is withdrawn
from Preview and Prepare's result is out of date. A project carrying its own
printer and filaments (the multicolour hexagon) slices with them, the pickers
saying so. Deleting the slicer turns slicing off. The server sees each upload
as a 3MF package, with the token and nothing else.
"""
import argparse
import base64
import json
import subprocess
import tempfile
import time
from pathlib import Path
from artifacts import ROOT, sha256
from smoke_ui import Screen, saturated_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
TOKEN = "prepare-smoke-token-0123456789abcdef"
SHOWN_LAYERS = "Layers 1 through 2, Z 0.2 through 0.4 mm"
OUT_OF_DATE = "The project changed after this plate was sliced; its G-code was withdrawn. Slice again."

screen = Screen(args.serial, output, "prepare")
adb, find, tap, enabled = screen.adb, screen.find, screen.tap, screen.enabled
hexagon = ROOT / "web/public/models/multicolor_hexagon.3mf"


def pick_download(name):
    """Chooses [name] from Downloads in the system picker, through its roots when Recent lacks it."""
    try:
        tap(name, timeout=5)
    except AssertionError:
        tap("Show roots")
        tap("Downloads")
        tap(name, timeout=20)


def type_into(label, value):
    # The slicer's fields head the area; the preflight's cards can make it long.
    screen.to_top()
    screen.type_into(label, value)


def import_cube():
    tap("Import Model…")
    pick_download("cube.stl")
    find("Import cube.stl?", timeout=30)
    tap("Import")
    find("Undo Import cube.stl", timeout=30)


def drawn():
    time.sleep(4)
    return screen.screenshot()


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
cube = json.loads((ROOT / "testdata/cross-platform/model-import-vectors.json").read_text())
cube_bytes = next(case for case in cube["cases"] if case["name"] == "stl-binary/cube")["bytesBase64"]
staged = Path(tempfile.mkdtemp(prefix="orcaxr-prepare-smoke-")) / "cube.stl"
staged.write_bytes(base64.b64decode(cube_bytes))
server = subprocess.Popen(
    ["node", "tools/cross-platform/external-slicer-serve.mjs",
     json.dumps({"token": TOKEN, "gcodeFile": "testdata/parity/fixtures/reference.gcode"})],
    cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)


def ask(command):
    server.stdin.write(command + "\n")
    server.stdin.flush()
    return server.stdout.readline().strip()


try:
    port = server.stdout.readline().strip().rsplit(":", 1)[1]
    endpoint = f"http://10.0.2.2:{port}"
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    if screen.api() >= 37:
        # Granted up front: android-local-network-smoke.py drives the prompt itself.
        adb("shell", "pm", "grant", PACKAGE, "android.permission.ACCESS_LOCAL_NETWORK")
    adb("shell", "rm -f /sdcard/Download/cube.stl /sdcard/Download/hexagon.3mf")
    adb("push", str(staged), "/sdcard/Download/cube.stl")
    adb("push", str(hexagon), "/sdcard/Download/hexagon.3mf")
    for name in ("cube.stl", "hexagon.3mf"):
        adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file:///sdcard/Download/{name}")
    screen.launch(PACKAGE)
    find("Import a model in the Project area to see it here.")
    tap("Project")
    find("Untitled project", timeout=30)
    import_cube()

    # Prepare: the active plate, no slicer yet: the route is this device's own engine.
    tap("Prepare")
    find("· 1 object(s)", exact=False, timeout=30)
    find("Offline")
    find("Slicing route: this device's own engine", exact=False)
    find("Off — slicing on this device.")

    # The policy's refusal: the server wants its token before it reports its engine.
    type_into("External slicer URL", endpoint)
    tap("Connect")
    find("The external slicer requires a token before it will report its engine.", timeout=30)
    # An unattested slicer is never the route: the device's engine still is.
    find("Slicing route: this device's own engine", exact=False)
    type_into("Access token (only if the server requires one)", TOKEN)
    tap("Connect")
    find("Online — attested (the native Snapmaker Orca CLI at", exact=False, timeout=30)
    find("On — models will be sliced on the external server.")
    find(f"Slicing route: the external slicer at {endpoint}, whose engine attested as", exact=False)

    # A new project starts from the catalog's default profile: the bare cube passes the preflight.
    find("Snapmaker U1 (0.4 nozzle)")
    find("Head 4 filament")
    screen.absent("Slice preflight issues", timeout=30)
    assert enabled("Slice"), "Slice was not offered for a cube on the default profile"

    # Another printer, chosen from the picker: one undoable step, and its preflight passes too.
    screen.to_top()
    tap("Snapmaker U1 (0.4 nozzle)")
    tap("Elegoo Centauri Carbon 0.4 nozzle")
    find("Elegoo Centauri Carbon 0.4 nozzle", timeout=30)
    screen.absent("Head 2 filament", timeout=30)
    tap("Project")
    find("Undo Update slicing configuration", timeout=30)
    tap("Prepare")
    screen.absent("Slice preflight issues", timeout=30)
    assert enabled("Slice"), "Slice was not offered for the chosen printer"

    # The first slice asks before anything leaves the device; then Preview shows the G-code.
    tap("Slice")
    find(f"Upload this plate to {endpoint}?", timeout=30)
    tap("Upload and slice")
    find(SHOWN_LAYERS, exact=False, timeout=90)
    find("Showing ", exact=False)
    find("Sliced in Prepare from the project as it stands.")
    width = screen.screenshot()[0]
    view = (0, 80, width, 520)
    toolpaths = saturated_pixels(drawn(), *view)
    assert toolpaths > 150, f"The sliced toolpaths were not drawn ({toolpaths} coloured pixels)"
    tap("Prepare")
    find("SLICED in", exact=False, timeout=30)
    find(f"Sliced on {endpoint}")

    # The same slicer is not asked about again. Held by the server, the job is cancelled and the server confirms it.
    assert ask("hold") == "holding"
    tap("Slice")
    find("Slicing: Holding for cancellation", timeout=60)
    tap("Cancel Slice")
    find("slice failed: The external slice was cancelled.", timeout=60)
    assert ask("release") == "released"
    tap("Slice")
    find(SHOWN_LAYERS, exact=False, timeout=90)
    tap("Prepare")
    find("SLICED in", exact=False, timeout=30)

    # The project changes: the slice is withdrawn from Preview and out of date in Prepare.
    tap("Project")
    import_cube()
    tap("Preview")
    find(OUT_OF_DATE, timeout=30)
    find("Slice the plate or open a G-code file to inspect toolpaths.")
    tap("Prepare")
    find(OUT_OF_DATE, timeout=30)

    # A project carrying its own printer and filaments slices with them until a profile is chosen.
    tap("Project")
    tap("Open Project…")
    pick_download("hexagon.3mf")
    find("Save changes to Untitled project?", timeout=30)
    tap("Discard")
    find("hexagon.3mf · No unsaved changes", timeout=60)
    tap("Prepare")
    find("Using the project’s own settings", timeout=30)
    screen.absent("Slice preflight issues", timeout=30)
    assert enabled("Slice"), "Slice was not offered for a project with its own settings"

    # Deleting the slicer turns slicing off and forgets the consent.
    tap("Delete")
    find("External slicer removed — slicing locally.", timeout=30)
    find("Offline")

    received = json.loads(ask("summary"))
    outcomes = [job["outcome"] for job in received["jobs"]]
    assert outcomes == ["done", "cancelled", "done"], outcomes
    assert all(job["zip"] for job in received["jobs"]), "An upload was not a 3MF package"
    # The tokenless check, then the token on everything else.
    assert sorted(received["authorizations"]) == ["", f"Bearer {TOKEN}"], received["authorizations"]
    assert "DELETE /jobs/:id" in received["requests"], "The cancellation never reached the server"
    report = {
        "evidenceKind": "emulator-only",
        "api": adb("shell", "getprop", "ro.build.version.sdk"),
        "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
        "appSha256": sha256(app_apk),
        "jobs": outcomes,
        "requests": len(received["requests"]),
        "toolpathPixels": toolpaths,
    }
    (output / "android-prepare-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Prepare area passed on API {report['api']} {report['abi']} emulator ({toolpaths} toolpath pixels)")
finally:
    staged.unlink(missing_ok=True)
    staged.parent.rmdir()
    try:
        server.stdin.write("close\n")
        server.stdin.flush()
        server.wait(timeout=10)
    except Exception:
        server.kill()
