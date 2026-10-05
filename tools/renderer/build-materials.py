#!/usr/bin/env python3
"""Compile offline renderer materials with the pinned, verified Filament compiler."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.77.1"
ARCHIVE_SHA = "ec0f5287a3a2fb801a93fd7b0ffd80c894aac980716d6f91ec48e5370d2d0674"
COMPILER_SHA = "3cc22d4ef3d84f561f88c80035658940c3ac2ead56aedf95e54d6c35191a47c6"
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--matc", type=Path, help="Existing verified Linux matc; otherwise download the pinned archive")
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="orcaxr-materials-") as directory:
    temporary = Path(directory)
    compiler = args.matc
    if compiler is None:
        archive = temporary / "filament.tgz"
        urllib.request.urlretrieve(f"https://github.com/google/filament/releases/download/v{VERSION}/filament-v{VERSION}-linux.tgz", archive)
        if sha(archive) != ARCHIVE_SHA:
            raise RuntimeError("Host archive digest mismatch")
        with tarfile.open(archive) as files:
            entries = [entry for entry in files.getmembers() if entry.name.endswith("/bin/matc") and entry.isfile()]
            if len(entries) != 1:
                raise RuntimeError("Expected exactly one material compiler")
            compiler = temporary / "matc"
            compiler.write_bytes(files.extractfile(entries[0]).read())
            compiler.chmod(0o755)
    if sha(compiler) != COMPILER_SHA:
        raise RuntimeError("Material compiler digest mismatch")
    root = ROOT / "android/renderer-filament"
    assets = root / "src/main/assets/materials"
    assets.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": 1, "filamentVersion": VERSION, "compilerSha256": COMPILER_SHA,
                "archiveSha256": ARCHIVE_SHA, "buildScriptSha256": sha(Path(__file__)), "arguments": ["-p", "mobile", "-a", "opengl", "-a", "vulkan"],
                "inputs": {}, "outputs": {}}
    for name in ("opaque", "transparent"):
        source = root / "materials" / f"{name}.mat"
        output = assets / f"{name}.filamat"
        subprocess.run([compiler, *manifest["arguments"], "-o", output, source], check=True)
        manifest["inputs"][source.name] = sha(source)
        manifest["outputs"][output.name] = sha(output)
    (assets / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Compiled two materials with verified Filament {VERSION} matc")
