#!/usr/bin/env python3
"""Verify shared-core source/output identity and actual APK ELF/ZIP page alignment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zipfile
from artifacts import ROOT, inputs, sha256


def verify_manifest(path, directory, kind):
    value = json.loads(path.read_text())
    assert value["schemaVersion"] == 1 and value["kind"] == kind, "Wrong artifact manifest"
    assert value["inputs"] == inputs(), "Shared-core inputs changed; rebuild before packaging"
    for name, digest in value["outputs"].items():
        target = (directory / name).resolve()
        assert target.is_relative_to(directory.resolve()), "Invalid artifact path"
        assert sha256(target) == digest, f"Artifact digest mismatch: {name}"
    return value


def elf_alignment(data, abi):
    assert data[:6] == b"\x7fELF\x02\x01", "Expected little-endian ELF64"
    assert struct.unpack_from("<H", data, 18)[0] == {"arm64-v8a": 183, "x86_64": 62}[abi], "Wrong ABI"
    start = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    assert size >= 56 and 0 < count <= 1024 and start + size * count <= len(data), "Invalid ELF program headers"
    loads = []
    for index in range(count):
        kind, _, offset, address, _, _, _, alignment = struct.unpack_from("<IIQQQQQQ", data, start + size * index)
        if kind == 1:
            assert alignment >= 16384 and alignment & (alignment - 1) == 0, "ELF needs 16 KB LOAD alignment"
            assert (address - offset) % 16384 == 0, "ELF LOAD offset is not page congruent"
            loads.append(alignment)
    assert loads, "ELF has no loadable segments"
    return loads


ENGINE_LIBRARIES = {"liborcaxr_engine.so", "libtbb.so", "libtbbmalloc.so", "libc++_shared.so"}


def verify_engine(archive, libraries):
    """The local slicing engine, when the APK carries it: exactly the verified adapter export's
    libraries for both ABIs and its resources, as the identity manifest the app checks names them."""
    packaged = {name for name in libraries if name.split("/")[2] in ENGINE_LIBRARIES}
    if "assets/engine/manifest.json" not in archive.namelist():
        assert not packaged, "Engine libraries are packaged without the engine identity manifest"
        return None
    manifest = json.loads(archive.read("assets/engine/manifest.json"))
    assert set(manifest["abis"]) == {"arm64-v8a", "x86_64"} and manifest["slicingQualified"] is False
    expected = {f"lib/{abi}/{name}" for abi, entry in manifest["abis"].items() for name in entry["files"]}
    assert packaged == expected and all(len(entry["files"]) == len(ENGINE_LIBRARIES) for entry in manifest["abis"].values()), \
        "Packaged engine libraries differ from the engine manifest"
    for abi, entry in manifest["abis"].items():
        for name, digest in entry["files"].items():
            assert libraries[f"lib/{abi}/{name}"]["sha256"] == digest, f"Engine library differs from the verified adapter: {abi}/{name}"
    for name, digest in manifest["resources"].items():
        assert hashlib.sha256(archive.read(f"assets/engine/resources/{name}")).hexdigest() == digest, f"Engine resource drift: {name}"
    exported = ROOT / "android/app/build/generated/engine/assets/engine/manifest.json"
    if exported.exists():
        assert json.loads(exported.read_text()) == manifest, "The APK's engine manifest is not the verified export"
    return {"adapterRecipe": manifest["adapterRecipe"], "engineRecipe": manifest["engineRecipe"],
            "engineCommit": manifest["engineCommit"],
            "bytesPerAbi": {abi: sum(len(archive.read(f"lib/{abi}/{name}")) for name in entry["files"])
                            for abi, entry in manifest["abis"].items()}}


def verify_apk(path, ndk):
    native = ROOT / "android/core-bridge/build/generated"
    value = verify_manifest(native / "core-native-manifest.json", native / "jniLibs", "android-jni")
    assert set(value["outputs"]) == {f"{abi}/liborcaxr_android.so" for abi in ("arm64-v8a", "x86_64")}
    strip = next(ndk.glob("toolchains/llvm/prebuilt/*/bin/llvm-strip"))
    report = {"apkSha256": sha256(path), "libraries": {}}
    with zipfile.ZipFile(path) as archive, path.open("rb") as apk:
        names = [name for name in archive.namelist() if name.startswith("lib/") and name.endswith(".so")]
        assert len(names) == len(set(names)), "Duplicate native library entries"
        for name in names:
            _, abi, library = name.split("/")
            entry = archive.getinfo(name)
            assert entry.compress_type == zipfile.ZIP_STORED, f"Native library must be mmap-ready: {name}"
            apk.seek(entry.header_offset)
            header = apk.read(30)
            assert header[:4] == b"PK\x03\x04"
            filename_size, extra_size = struct.unpack_from("<HH", header, 26)
            offset = entry.header_offset + 30 + filename_size + extra_size
            assert offset % 16384 == 0, f"APK library is not 16 KB ZIP-aligned: {name}"
            data = archive.read(name)
            alignments = elf_alignment(data, abi)
            if library == "liborcaxr_android.so":
                with tempfile.TemporaryDirectory(prefix="orcaxr-strip-") as directory:
                    stripped = Path(directory) / library
                    subprocess.run([strip, "--strip-unneeded", "-o", stripped, native / "jniLibs" / abi / library], check=True)
                    assert stripped.read_bytes() == data, f"Packaged library differs from attested build: {name}"
            report["libraries"][name] = {"sha256": hashlib.sha256(data).hexdigest(), "zipOffset": offset, "loadAlignments": alignments}
        for name in value["outputs"]:
            assert f"lib/{name}" in report["libraries"], f"Missing required JNI library: {name}"
        report["localEngine"] = verify_engine(archive, report["libraries"])
    report["apkBytes"] = path.stat().st_size
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", action="store_true")
    parser.add_argument("--project-wasm", action="store_true")
    parser.add_argument("--printer-wasm", action="store_true")
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--ndk", type=Path)
    args = parser.parse_args()
    assert args.wasm or args.project_wasm or args.printer_wasm or args.apk, (
        "Choose --wasm, --project-wasm, --printer-wasm and/or --apk")
    for selected, kind in [(args.wasm, None), (args.project_wasm, "project"), (args.printer_wasm, "printer")]:
        if not selected:
            continue
        directory = ROOT / (f"core/dist/{kind}-wasm" if kind else "core/dist/wasm")
        value = verify_manifest(directory / "core-wasm-manifest.json", directory,
                                f"browser-{kind}-wasm" if kind else "browser-wasm")
        assert value["features"] == ([kind] if kind else ["gcode"])
        assert value["defaultFeatures"] == (kind is None)
        assert set(value["outputs"]) == {"orcaxr_core.js", "orcaxr_core.d.ts", "orcaxr_core_bg.wasm", "orcaxr_core_bg.wasm.d.ts"}
        print(f"Verified {kind or 'computation'} WASM/glue/source identity")
    if args.apk:
        sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        ndk = args.ndk or (Path(sdk) / "ndk/29.0.14206865" if sdk else None)
        assert ndk, "Specify --ndk or ANDROID_HOME"
        report = verify_apk(args.apk, ndk)
        output = ROOT / "tools/cross-platform/results"
        output.mkdir(parents=True, exist_ok=True)
        (output / f"{args.apk.stem}-artifacts.json").write_text(json.dumps(report, indent=2) + "\n")
        engine = "with the verified local engine" if report["localEngine"] else "without a local engine"
        print(f"Verified {len(report['libraries'])} packaged native libraries, both ABIs, source identity and 16 KB alignment, "
              f"{engine}; APK {report['apkBytes']} bytes")


if __name__ == "__main__":
    main()
