#!/usr/bin/env python3
"""Build the pinned shared core for both Android ABIs; never uses old slicer scripts."""
from pathlib import Path
import os
import platform
import shutil
import subprocess
from artifacts import ROOT, manifest, sha256, write_manifest

NDK_VERSION = "29.0.14206865"
sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
properties = ROOT / "android/local.properties"
if properties.exists():
    for line in properties.read_text().splitlines():
        if line.startswith("sdk.dir="):
            sdk = line.removeprefix("sdk.dir=")
if not sdk:
    raise SystemExit("Set ANDROID_HOME or android/local.properties sdk.dir")
host = {"Linux": "linux-x86_64", "Darwin": "darwin-x86_64"}.get(platform.system())
if not host:
    raise SystemExit("This build entry point currently supports Linux/macOS hosts")
toolchain = Path(sdk) / "ndk" / NDK_VERSION / "toolchains/llvm/prebuilt" / host / "bin"
output = ROOT / "android/core-bridge/build/generated/jniLibs"
result = manifest("android-jni")
result.update(ndkVersion=NDK_VERSION, apiLevel=31, rustflags=["-C", "link-arg=-Wl,-z,max-page-size=16384"])
for abi, target, clang in [
    ("arm64-v8a", "aarch64-linux-android", "aarch64-linux-android31-clang"),
    ("x86_64", "x86_64-linux-android", "x86_64-linux-android31-clang"),
]:
    linker = toolchain / clang
    if not linker.is_file():
        raise SystemExit(f"Missing pinned NDK linker: {linker}")
    env = dict(os.environ)
    env[f"CARGO_TARGET_{target.replace('-', '_').upper()}_LINKER"] = str(linker)
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(["-C", "link-arg=-Wl,-z,max-page-size=16384"])
    subprocess.run(["cargo", "build", "--locked", "--release", "--jobs", "2", "--target-dir", "target", "--target", target,
                    "-p", "orcaxr-android"], cwd=ROOT / "core", env=env, check=True)
    source = ROOT / "core/target" / target / "release/liborcaxr_android.so"
    destination = output / abi / source.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    result["outputs"][f"{abi}/{source.name}"] = sha256(destination)
write_manifest(output.parent / "core-native-manifest.json", result)
print("Built shared core for arm64-v8a and x86_64")
