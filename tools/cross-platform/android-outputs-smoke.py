#!/usr/bin/env python3
"""Drive a slice's outputs — each plate's pictures, Slice All Plates, and the external
slicer's repeatable download — on an explicitly selected emulator.

On the device's own engine: the app's data is cleared, a new project (the
catalog's default profile, the Snapmaker U1, whose `thumbnails` asks for a
48 × 48 and a 300 × 300 PNG) gets a cube on Plate 1 and a cylinder on Plate 2
(added from the plate bar, active once added), and Plate 1 is made active
again. "Slice All Plates" — the browser's menu action, enabled once the core
enables it — slices both plates in the engine's own process: Preview opens on
Plate 1's toolpaths (the active plate's result, as the browser publishes it),
and Prepare says SLICED 2 plate(s) with their total, lists each plate's result
and names the one Preview and Send take. Both published files, read back from
the device, carry the plate's two pictures right after the engine's header and
its blank line (where the engine writes them for a non-BBL printer): PNGs of
the asked sizes, a model drawn on transparency, each plate its own.

Then on the external slicer — the real server on the host, its engine a
stand-in writing the two-layer reference G-code, which has no header: once
connected with its token and agreed to, the next artifact download is cut off
halfway. The app fetches the result the server kept again, checks it, releases
the job and publishes it with the plate's pictures at its top (the server
records the two downloads and the release); Slice All Plates on it submits
both plates.

Lessons kept from the earlier smokes: an action waits until the core enables
it, rows are found by text, and Prepare's Slice buttons stay in the bar above
its list.
"""
import argparse
import base64
import json
import math
import re
import subprocess
import time
from artifacts import ROOT, sha256
from smoke_ui import Screen, decode_png, saturated_pixels

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
ENGINE = PACKAGE + ":engine"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
TOKEN = "outputs-smoke-token-0123456789abcdef"
FIRST = "Untitled_project_Plate_1.gcode"
SECOND = "Untitled_project_Plate_2.gcode"
reference = ROOT / "testdata/parity/fixtures/reference.gcode"
BLOCK = re.compile(r"; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin (\d+)x(\d+) (\d+)\n((?:; [A-Za-z0-9+/=]+\n)*); thumbnail end\n; THUMBNAIL_BLOCK_END\n\n")

screen = Screen(args.serial, output, "outputs")
adb, find, tap, enabled = screen.adb, screen.find, screen.tap, screen.enabled


def menu(name, action, timeout=20):
    """An action from the Project area's [name] menu, once the core enables it."""
    deadline = time.monotonic() + timeout
    while True:
        tap(name)
        if enabled(action):
            tap(action)
            return
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        screen.key(4)
        time.sleep(1)


def when_enabled(action, timeout=60):
    """Taps [action] once the core enables it."""
    deadline = time.monotonic() + timeout
    while not enabled(action):
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        time.sleep(1)
    tap(action)


def pid(process):
    value = adb("shell", f"pidof {process} || true")
    return int(value.split()[0]) if value else None


def published(name):
    """A published G-code, read back from the app's cache."""
    return subprocess.check_output(["adb", "-s", args.serial, "exec-out", "run-as", PACKAGE, "cat",
                                    f"cache/prepare/gcode/{name}"], timeout=60)


def pictures(gcode, where):
    """The thumbnail blocks of [gcode], which start at byte [where]: (width, height, PNG) each,
    every block's length checked and every picture a model on transparency."""
    text = gcode.decode("utf-8")
    found = []
    at = where
    for match in BLOCK.finditer(text, where):
        assert match.start() == at, f"The pictures are not together at {where}: one starts at {match.start()}"
        at = match.end()
        width, height, length = (int(match.group(i)) for i in (1, 2, 3))
        encoded = "".join(line[2:] for line in match.group(4).splitlines())
        assert len(encoded) == length, (len(encoded), length)
        png = base64.b64decode(encoded)
        w, h, rows = decode_png(png)
        assert (w, h) == (width, height), ((w, h), (width, height))
        opaque = sum(1 for row in rows for x in range(w) if row[x * 4 + 3] == 255)
        corners = [rows[y][x * 4 + 3] for x in (0, w - 1) for y in (0, h - 1)]
        assert corners == [0, 0, 0, 0], f"The picture's corners are not transparent: {corners}"
        assert width * height // 100 < opaque < width * height * 6 // 10, f"No model framed in the {width}x{height} picture ({opaque} pixels)"
        found.append((width, height, png, opaque))
    return found


assert adb("shell", "getprop", "sys.boot_completed") == "1", "Emulator is not ready"
server = subprocess.Popen(
    ["node", "tools/cross-platform/external-slicer-serve.mjs",
     json.dumps({"token": TOKEN, "gcodeFile": str(reference.relative_to(ROOT))})],
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
    # Granted up front: the app asks for it once before its first local slice (a system dialog).
    adb("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
    if screen.api() >= 37:
        # Granted up front: android-local-network-smoke.py drives the prompt itself.
        adb("shell", "pm", "grant", PACKAGE, "android.permission.ACCESS_LOCAL_NETWORK")
    screen.launch(PACKAGE)
    find("Import a model in the Project area to see it here.")

    # Two plates with a model each; Plate 1 active again.
    tap("Project")
    find("Untitled project", timeout=30)
    menu("Add", "Cube")
    find("Undo Add cube.stl", timeout=30)
    tap("Add build plate")
    find("Undo Add Plate 2", timeout=30)
    menu("Add", "Cylinder")
    find("Undo Add cylinder.stl", timeout=30)
    tap("Activate build plate: Plate 1")
    tap("Prepare")
    find("Plate 1 · 1 object(s)", timeout=30)

    # Slice All Plates on this device's engine: Preview opens on the active plate's result.
    find("Off — slicing on this device.", timeout=30)
    screen.absent("Slice preflight issues", timeout=30)
    when_enabled("Slice All Plates")
    find("Sliced in Prepare from the project as it stands.", timeout=480)
    find(f"Showing {FIRST}", exact=False, timeout=30)
    engine = pid(ENGINE)
    assert engine and engine != pid(PACKAGE), "The engine did not run in its own process"
    time.sleep(4)
    width = screen.screenshot()[0]
    toolpaths = saturated_pixels(screen.screenshot(), 0, 80, width, 520)
    assert toolpaths > 150, f"Plate 1's toolpaths were not drawn ({toolpaths} coloured pixels)"

    # Prepare: the set's status, each plate's result, and the one Preview and Send take.
    tap("Prepare")
    status = find("SLICED 2 plate(s) in", exact=False, timeout=30).get("text")
    first, second = published(FIRST), published(SECOND)
    total = re.search(r"SLICED 2 plate\(s\) in \d+ ms\s+(\d+) KB total", status)
    assert total and int(total.group(1)) == math.floor((len(first) + len(second)) / 1024 + 0.5), (status, len(first), len(second))
    find("Plate 1: ", exact=False)
    find("Plate 2: ", exact=False)
    find("Preview and Send to Printer use Plate 1.")

    # Each file carries its plate's pictures right after the engine's header and its blank line.
    drawn = {}
    for name, gcode in ((FIRST, first), (SECOND, second)):
        header = gcode.index(b"; HEADER_BLOCK_END\n") + len(b"; HEADER_BLOCK_END\n")
        if gcode[header:header + 1] == b"\n":
            header += 1
        found = pictures(gcode, header)
        assert [(w, h) for w, h, _, _ in found] == [(48, 48), (300, 300)], f"{name}: {[(w, h) for w, h, _, _ in found]}"
        assert gcode.count(b"; THUMBNAIL_BLOCK_START") == 2, f"{name}: a second set of pictures"
        drawn[name] = found
    assert drawn[FIRST][1][2] != drawn[SECOND][1][2], "Both plates' files show the same picture"

    # The external slicer: connected with its token, agreed to, its next download cut off halfway.
    screen.to_top()
    screen.type_into("External slicer URL", endpoint)
    screen.to_top()
    screen.type_into("Access token (only if the server requires one)", TOKEN)
    tap("Connect")
    find("Online — attested (the native Snapmaker Orca CLI at", exact=False, timeout=30)
    assert ask("drop") == "damaging"
    when_enabled("Slice")
    find(f"Upload this plate to {endpoint}?", timeout=30)
    tap("Upload and slice")
    find("Sliced in Prepare from the project as it stands.", timeout=120)
    tap("Prepare")
    find(f"Sliced on {endpoint}", timeout=30)
    find("SLICED in", exact=False, timeout=30)
    fetched = published(FIRST)
    expected = reference.read_bytes()
    assert fetched.endswith(expected), "The external slicer's G-code was not published whole"
    external = pictures(fetched, 0)
    assert [(w, h) for w, h, _, _ in external] == [(48, 48), (300, 300)], "No pictures at the top of a file without a header"
    assert len(fetched) == len(expected) + sum(len(m.group(0).encode()) for m in BLOCK.finditer(fetched.decode()))
    received = json.loads(ask("summary"))
    requests = received["requests"]
    job = requests[requests.index("POST /slice?async=1"):]
    assert job.count("GET /jobs/:id/gcode") == 2, f"The cut-off download was not fetched again: {job}"
    assert job[-1] == "DELETE /jobs/:id", f"The result was not released after the good transfer: {job}"

    # Slice All Plates on the external slicer: both plates submitted, both results kept.
    when_enabled("Slice All Plates")
    find("Sliced in Prepare from the project as it stands.", timeout=120)
    tap("Prepare")
    find("SLICED 2 plate(s) in", exact=False, timeout=30)
    find("Plate 2: ", exact=False)
    received = json.loads(ask("summary"))
    assert len(received["jobs"]) == 3 and all(job["outcome"] == "done" for job in received["jobs"]), received["jobs"]
    assert received["authorizations"] == [f"Bearer {TOKEN}"], received["authorizations"]
finally:
    try:
        ask("close")
    except (BrokenPipeError, OSError):
        pass
    server.wait(timeout=30)

report = {
    "evidenceKind": "emulator-only",
    "api": adb("shell", "getprop", "ro.build.version.sdk"),
    "abi": adb("shell", "getprop", "ro.product.cpu.abi"),
    "pageSize": int(adb("shell", "getconf", "PAGESIZE")),
    "appSha256": sha256(app_apk),
    "localBytes": [len(first), len(second)],
    "pictures": {name: [[w, h, opaque] for w, h, _, opaque in found] for name, found in drawn.items()},
    "toolpathPixels": toolpaths,
    "externalBytes": len(fetched),
    "externalRequests": len(requests),
}
(output / "android-outputs-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Outputs passed on API {report['api']} {report['abi']} emulator (two plates, {len(first)} and {len(second)} bytes)")
