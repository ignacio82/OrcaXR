"""Common source and tool identities for shared-core artifacts (not slicer artifacts)."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inputs():
    files = [ROOT / "core" / name for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml")]
    for directory, patterns in [
        ("core/crates", ("*.rs", "*.toml")),
        ("contracts", ("*.json",)),
        ("tools/cross-platform", ("*.py",)),
    ]:
        for pattern in patterns:
            files.extend((ROOT / directory).rglob(pattern))
    return {str(path.relative_to(ROOT)): sha256(path) for path in sorted(files)}


def tool_version(*command):
    return subprocess.check_output(command, cwd=ROOT / "core", text=True).strip()


def manifest(kind):
    return {
        "schemaVersion": 1,
        "kind": kind,
        "rustc": tool_version("rustc", "--version"),
        "cargo": tool_version("cargo", "--version"),
        "inputs": inputs(),
        "outputs": {},
    }


def write_manifest(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
