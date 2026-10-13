#!/usr/bin/env python3
"""Drive the File menu's exports and the Download actions on an explicitly selected
emulator, through the system's document picker, and read every file back.

The app's data is cleared; a new project gets a cube on Plate 1 and a cylinder
on Plate 2, Plate 1 active again. From the Project area's Export menu,
"Export as one STL…" offers `cube.stl` in the system's picker and writes the
cube as the browser's binary STL (its header, its 12 facets, every normal a unit
vector, the 20 mm cube standing on the bed); with a second instance of the cube,
"Export all objects as STLs…" writes the browser's ZIP: its two members named
after the object, the second numbered, each the same STL, stored as fflate
stores them (DEFLATE, no UTF-8 flag, 0644, 1980-01-01) — and the browser's own
`writeDeterministicZip`, given those members, writes the same bytes. A
negative part makes the STL export refuse in the browser's words, and no
picker opens. "Export as 3MF…" writes `Untitled project.3mf`, which the
browser, reopening it and saving it again, writes byte for byte the same (its
Save is the export), while the project's own saved state is untouched. Each document is saved in Downloads, chosen from the picker's
roots (it reopens where it was last used).

Then on the external slicer (the real server on the host, its engine a
stand-in writing the reference G-code), once connected and agreed to:
"Download" beside the slice's result writes `orcaxr.gcode` — the published
file byte for byte, the browser's name kept — and "Export G-code…" from the
command palette writes it again. "Download All Plates" without a Slice All
Plates says so in the browser's words; "Export All Plates…" slices every plate
first and writes `Plate_1.gcode` and `Plate_2.gcode` into a folder the
operator picks, each its plate's published file byte for byte. After an edit
the published G-code is no longer the project's and Download is not offered.

Statuses are the browser's (the shell's snackbar): "Exported 1 model as 12 STL
triangles.", "Exported all models as separate STL files.", "STL export
failed: …", "Saved orcaxr.gcode.", "Downloaded 2 plate G-code file(s).".
"""
import argparse
import base64
import json
import math
import struct
import subprocess
import time
import zipfile
from io import BytesIO
from artifacts import ROOT, sha256
from smoke_ui import Screen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--serial", required=True)
args = parser.parse_args()
output = ROOT / "tools/cross-platform/results"
output.mkdir(parents=True, exist_ok=True)
PACKAGE = "dev.orcaxr.nativeapp"
app_apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
TOKEN = "exports-smoke-token-0123456789abcdef"
reference = ROOT / "testdata/parity/fixtures/reference.gcode"
DOWNLOAD = "/sdcard/Download"
# The browser's writeDeterministicZip over members read from stdin ({name: base64}), the archive to stdout.
BROWSER_ZIP = f"""
import {{ writeDeterministicZip }} from {json.dumps(str(ROOT / "web/src/project/serialization/deterministicZip.ts"))};
let input = "";
for await (const chunk of process.stdin) input += chunk;
const files = new Map(Object.entries(JSON.parse(input)).map(([name, data]) => [name, Buffer.from(data, "base64")]));
process.stdout.write(writeDeterministicZip(files));
"""
# The browser reopening a project and saving it again (its Save: the serializer's package), stdin to stdout.
BROWSER_RESAVE = f"""
import {{ Bbs3mfProjectSerializer }} from {json.dumps(str(ROOT / "web/src/project/serialization/Bbs3mfProjectSerializer.ts"))};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const serializer = new Bbs3mfProjectSerializer();
const parsed = await serializer.deserialize(new Uint8Array(Buffer.concat(chunks)));
const saved = await serializer.serialize({{ state: parsed.state, assets: parsed.assets, sourceRevision: 0, sourceHash: "" }});
process.stdout.write(saved.bytes);
"""
FOLDER = "orcaxr-plates"

screen = Screen(args.serial, output, "exports")
adb, find, tap, enabled, absent = screen.adb, screen.find, screen.tap, screen.enabled, screen.absent


def menu(name, action, timeout=20):
    """An action from the Project area's [name] menu, once enabled."""
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
    deadline = time.monotonic() + timeout
    while not enabled(action):
        assert time.monotonic() < deadline, f"'{action}' never became enabled"
        time.sleep(1)
    tap(action)


def pull(path):
    """A file the app wrote through the picker, read back from shared storage."""
    return subprocess.check_output(["adb", "-s", args.serial, "exec-out", "cat", path], timeout=60)


def published(name):
    """A published G-code, read back from the app's cache."""
    return subprocess.check_output(["adb", "-s", args.serial, "exec-out", "run-as", PACKAGE, "cat",
                                    f"cache/prepare/gcode/{name}"], timeout=60)


def save_as(name):
    """The system's picker offers [name]; saved in Downloads, chosen from its roots (it reopens
    where it was last used, which may be the plates' folder)."""
    find(name, timeout=30)
    if any((n.get("content-desc") or "") == "Show roots" for n in screen.nodes()):
        tap("Show roots")
    tap("Downloads", timeout=20)
    find(name, timeout=20)
    tap("SAVE")


def stl(data, label):
    """The browser's binary STL: header, count, 50 bytes a facet, unit (or zero) normals. Its vertices."""
    assert data[:27] == b"OrcaXR canonical binary STL" and set(data[27:80]) <= {0}, f"{label}: not the browser's header"
    count = struct.unpack_from("<I", data, 80)[0]
    assert len(data) == 84 + 50 * count, f"{label}: {len(data)} bytes for {count} facets"
    points = []
    for i in range(count):
        values = struct.unpack_from("<12fH", data, 84 + 50 * i)
        normal = values[:3]
        assert abs(math.hypot(*normal) - 1) < 1e-5 or normal == (0, 0, 0), f"{label}: facet {i}'s normal {normal}"
        assert values[12] == 0, f"{label}: facet {i}'s attribute"
        points += [values[3:6], values[6:9], values[9:12]]
    return count, points


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


written = {}
try:
    port = server.stdout.readline().strip().rsplit(":", 1)[1]
    endpoint = f"http://10.0.2.2:{port}"
    adb("install", "-r", str(app_apk))
    adb("shell", "pm", "clear", PACKAGE)
    if screen.api() >= 37:
        adb("shell", "pm", "grant", PACKAGE, "android.permission.ACCESS_LOCAL_NETWORK")
    # Through MediaStore, which the picker's Downloads root lists (a file removed behind its back keeps its row).
    adb("shell", "content delete --uri content://media/external/file --where \"relative_path LIKE 'Download/%' AND "
        "(_display_name LIKE 'cube%' OR _display_name LIKE 'orcaxr%' OR _display_name LIKE 'Untitled_project_stls%' "
        "OR _display_name LIKE 'Untitled project%' "
        "OR _display_name LIKE 'Plate_%')\"")
    adb("shell", f"rm -rf {DOWNLOAD}/cube*.stl {DOWNLOAD}/Untitled_project_stls*.zip '{DOWNLOAD}/orcaxr'* '{DOWNLOAD}/Untitled project'*.3mf")
    adb("shell", f"mkdir -p {DOWNLOAD}/{FOLDER}")
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
    time.sleep(2)

    # Export as one STL…: the active plate's cube, offered under its name, the browser's bytes.
    menu("Export", "Export as one STL…")
    save_as("cube.stl")
    find("Exported 1 model as 12 STL triangles.", timeout=30)
    cube = pull(f"{DOWNLOAD}/cube.stl")
    count, points = stl(cube, "cube.stl")
    extent = [max(p[k] for p in points) - min(p[k] for p in points) for k in range(3)]
    assert count == 12 and all(abs(e - 20) < 1e-3 for e in extent), f"cube.stl: {count} facets, extent {extent}"
    assert abs(min(p[2] for p in points)) < 1e-4, "cube.stl: the cube does not stand on the bed"
    written["cube.stl"] = len(cube)

    # A second cube: Export all objects as STLs… (nothing selected: the whole plate) writes the browser's ZIP.
    menu("Edit", "Select All")
    menu("Edit", "Clone Selected")
    find("Undo Create instance", timeout=30)
    menu("Edit", "Deselect All")
    time.sleep(1)
    menu("Export", "Export all objects as STLs…")
    save_as("Untitled_project_stls.zip")
    find("Exported all models as separate STL files.", timeout=30)
    archive = pull(f"{DOWNLOAD}/Untitled_project_stls.zip")
    with zipfile.ZipFile(BytesIO(archive)) as zipped:
        members = zipped.infolist()
        assert [m.filename for m in members] == ["cube_stl.stl", "cube_stl_2.stl"], [m.filename for m in members]
        for m in members:
            assert m.compress_type == zipfile.ZIP_DEFLATED and m.flag_bits == 0, (m.filename, m.compress_type, m.flag_bits)
            assert m.date_time == (1980, 1, 1, 0, 0, 0) and m.external_attr == 0o644 << 16, (m.filename, m.date_time, m.external_attr)
            assert stl(zipped.read(m), m.filename)[0] == 12
        assert zipped.testzip() is None
        members = {m.filename: base64.b64encode(zipped.read(m)).decode() for m in zipped.infolist()}
    # The browser's own writer (fflate) packs the same members into the same bytes.
    browser = subprocess.check_output(
        ["node", "--import", "./web/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", BROWSER_ZIP],
        input=json.dumps(members).encode(), cwd=ROOT, timeout=120)
    assert browser == archive, f"The archive is not the browser's: {len(archive)} bytes, the browser's {len(browser)}"
    written["Untitled_project_stls.zip"] = len(archive)

    # Export as 3MF…: the browser's Save of the project, byte for byte — the browser, reopening the file
    # and saving it again, writes the very same bytes — and the project's own saved state is untouched.
    menu("Export", "Export as 3MF…")
    save_as("Untitled project.3mf")
    find("Plated geometry exported as 3MF.", timeout=30)
    project = pull(f"{DOWNLOAD}/Untitled project.3mf")
    resaved = subprocess.check_output(
        ["node", "--import", "./web/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", BROWSER_RESAVE],
        input=project, cwd=ROOT, timeout=120)
    assert resaved == project, f"The 3MF is not the browser's Save: {len(project)} bytes, the browser's {len(resaved)}"
    with zipfile.ZipFile(BytesIO(project)) as zipped:
        names = zipped.namelist()
        assert "3D/3dmodel.model" in names and "[Content_Types].xml" in names, names
    find("Unsaved changes", timeout=10)
    written["Untitled project.3mf"] = len(project)

    # A negative part: refused in the browser's words; no picker opens.
    menu("Edit", "Select All")
    menu("Add", "Set as Negative Part")
    find("Undo Add negative part to object", timeout=30)
    menu("Export", "Export as one STL…")
    find("STL export failed: Volume ", exact=False, timeout=30)
    absent("SAVE", timeout=5)
    tap("Undo Add negative part to object")
    find("Undo Create instance", timeout=30)
    menu("Edit", "Deselect All")

    # The external slicer: connected with its token, agreed to, the active plate sliced.
    tap("Prepare")
    find("Plate 1 · 1 object(s)", timeout=30)
    screen.to_top()
    screen.type_into("External slicer URL", endpoint)
    screen.to_top()
    screen.type_into("Access token (only if the server requires one)", TOKEN)
    tap("Connect")
    find("Online — attested (the native Snapmaker Orca CLI at", exact=False, timeout=30)
    when_enabled("Slice")
    find(f"Upload this plate to {endpoint}?", timeout=30)
    tap("Upload and slice")
    find("Sliced in Prepare from the project as it stands.", timeout=120)
    tap("Prepare")
    find(f"Sliced on {endpoint}", timeout=30)
    gcode = published("Untitled_project_Plate_1.gcode")

    # Download beside the result: the published G-code, byte for byte, under the browser's name.
    when_enabled("Download")
    save_as("orcaxr.gcode")
    find("Saved orcaxr.gcode.", timeout=30)
    downloaded = pull(f"{DOWNLOAD}/orcaxr.gcode")
    assert downloaded == gcode, f"Download wrote {len(downloaded)} bytes, not the published {len(gcode)}"
    assert downloaded.endswith(reference.read_bytes()), "The download is not the engine's G-code"
    written["orcaxr.gcode"] = len(downloaded)

    # Export G-code… from the command palette: the same file again (the provider names the copy).
    adb("shell", "input", "keycombination", "113", "39")
    find("Search every action", timeout=20)
    time.sleep(1)
    adb("shell", "input", "text", "Export%sG-code")
    when_enabled("Export G-code…")
    save_as("orcaxr.gcode")
    find("Saved orcaxr (1).gcode.", timeout=30)
    assert pull(f"{DOWNLOAD}/orcaxr (1).gcode") == gcode, "Export G-code… wrote other bytes"

    # Download All Plates before any Slice All Plates: the browser's words, no picker.
    tap("Project")
    find("Untitled project", timeout=30)
    menu("Export", "Download All Plates")
    find("Slice all plates before downloading their G-code.", timeout=30)

    # Export All Plates…: every plate sliced first, then one file per plate in the folder picked.
    menu("Export", "Export All Plates…")
    # Once both plates are sliced, the folder picker: into Download, then the folder.
    deadline = time.monotonic() + 240
    while not any((n.get("text") or "") in (FOLDER, "Download") for n in screen.nodes()):
        assert time.monotonic() < deadline, "The folder picker never opened"
        time.sleep(2)
    if not any((n.get("text") or "") == FOLDER for n in screen.nodes()):
        tap("Download")
    tap(FOLDER, timeout=30)
    tap("USE THIS FOLDER", timeout=30)
    tap("ALLOW", timeout=30)
    find("Downloaded 2 plate G-code file(s).", timeout=60)
    for plate, name in (("Plate_1.gcode", "Untitled_project_Plate_1.gcode"), ("Plate_2.gcode", "Untitled_project_Plate_2.gcode")):
        data = pull(f"{DOWNLOAD}/{FOLDER}/{plate}")
        assert data == published(name), f"{plate} is not {name}'s published bytes"
        written[f"{FOLDER}/{plate}"] = len(data)
    received = json.loads(ask("summary"))
    # The plate sliced alone first, then both plates for Export All Plates.
    assert len(received["jobs"]) == 3 and all(job["outcome"] == "done" for job in received["jobs"]), received["jobs"]

    # An edit: the published G-code is no longer the project's, and Download is not offered.
    tap("Project")
    menu("Edit", "Select All")
    menu("Edit", "Clone Selected")
    find("Undo Create instance", timeout=30)
    tap("Prepare")
    find("its G-code was withdrawn", exact=False, timeout=30)
    tap("Project")
    tap("Export")
    assert not enabled("Export G-code…"), "Export G-code… offered for a withdrawn slice"
    screen.key(4)
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
    "appSha256": sha256(app_apk),
    "written": written,
}
(output / "android-exports-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"Exports passed on API {report['api']} {report['abi']} emulator ({len(written)} files read back)")
