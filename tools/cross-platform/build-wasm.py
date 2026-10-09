#!/usr/bin/env python3
"""Build a matched WASM/glue set using the Cargo-pinned wasm-bindgen tool."""
import subprocess
import tomllib
import argparse
from artifacts import ROOT, manifest, sha256, tool_version, write_manifest

parser = argparse.ArgumentParser()
sets = parser.add_mutually_exclusive_group()
sets.add_argument("--project", action="store_true", help="Build the separate project host module")
sets.add_argument("--printer", action="store_true", help="Build the separate printer host module")
args = parser.parse_args()
# The computation (G-code preview) module is the default feature set; the
# project and printer modules each select only their own feature.
kind = "project" if args.project else "printer" if args.printer else None
cargo = tomllib.loads((ROOT / "core/Cargo.toml").read_text())
dependency = cargo["workspace"]["dependencies"]["wasm-bindgen"]
version = (dependency["version"] if isinstance(dependency, dict) else dependency).removeprefix("=")
if tool_version("wasm-bindgen", "--version") != f"wasm-bindgen {version}":
    raise SystemExit(f"Install wasm-bindgen-cli {version} with cargo install --locked")
subprocess.run(["cargo", "build", "--locked", "--release", "--jobs", "2",
                "--target-dir", "target", "--target", "wasm32-unknown-unknown",
                "-p", "orcaxr-wasm", *(["--no-default-features", "--features", kind] if kind else [])], cwd=ROOT / "core", check=True)
output = ROOT / (f"core/dist/{kind}-wasm" if kind else "core/dist/wasm")
output.mkdir(parents=True, exist_ok=True)
subprocess.run(["wasm-bindgen", "target/wasm32-unknown-unknown/release/orcaxr_wasm.wasm",
                "--target", "web", "--out-dir", str(output), "--out-name", "orcaxr_core"],
               cwd=ROOT / "core", check=True)
result = manifest(f"browser-{kind}-wasm" if kind else "browser-wasm")
result.update(features=[kind] if kind else ["gcode"], defaultFeatures=kind is None)
result["wasmBindgenVersion"] = version
for name in ("orcaxr_core.js", "orcaxr_core.d.ts", "orcaxr_core_bg.wasm", "orcaxr_core_bg.wasm.d.ts"):
    result["outputs"][name] = sha256(output / name)
write_manifest(output / "core-wasm-manifest.json", result)
print("Built matched shared-core WASM and browser bindings")
