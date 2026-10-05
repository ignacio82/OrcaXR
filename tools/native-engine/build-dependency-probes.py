#!/usr/bin/env python3
"""Build the pinned engine's TBB dependency and Android feasibility probe.

This is not a libslic3r build or a slicing qualification. Each recipe gets a
fresh worktree; the developer checkout is read only. Build both initial ABIs by
default, at one compiler job. Never import the retired Android engine patches.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.request
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
PIN = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626"
NDK_VERSION = "29.0.14206865"
TBB_ARCHIVE_SHA = "83ea786c964a384dd72534f9854b419716f412f9d43c0be88d41874763e7bb47"
ABIS = {"arm64-v8a": (183, "aarch64-linux-android"), "x86_64": (62, "x86_64-linux-android")}
PATCH = HERE / "patches/0001-android-dependency-bootstrap.patch"
PLATFORM_LIBRARIES = {"libc.so", "libm.so", "libdl.so"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args, cwd=None, capture=False):
    return subprocess.run([str(a) for a in args], cwd=cwd, check=True,
        stdout=subprocess.PIPE if capture else None, text=capture).stdout


def inputs():
    paths = [Path(__file__), PATCH, HERE / "probes/CMakeLists.txt", HERE / "probes/tbb_probe.cpp"]
    return {str(p.relative_to(ROOT)): sha(p) for p in paths}


def fingerprint(source_inputs):
    return hashlib.sha256(json.dumps({"engine": PIN, "ndk": NDK_VERSION, "api": 31,
        "inputs": source_inputs}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def toolchain():
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        raise RuntimeError("This feasibility recipe currently requires Linux x86_64")
    sdk = Path(os.environ["ANDROID_HOME"])
    ndk = sdk / "ndk" / NDK_VERSION
    if not re.search(r"^Pkg.Revision\s*=\s*" + re.escape(NDK_VERSION) + r"\s*$",
                     (ndk / "source.properties").read_text(), re.M):
        raise RuntimeError("NDK version mismatch")
    compiler = ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin/clang++"
    version = run(compiler, "--version", capture=True).splitlines()[0]
    if "clang version 21.0.0" not in version:
        raise RuntimeError("Unexpected compiler in the pinned NDK")
    return ndk, compiler.parent, version


def prepare_source(directory):
    source = directory / "source"
    repository = ROOT / "third_party/SnapmakerOrca"
    if not repository.exists():
        repository = BUILD / "downloads/snapmaker.git"
        if not repository.exists():
            repository.parent.mkdir(parents=True, exist_ok=True)
            run("git", "init", "--bare", repository)
        run("git", "-C", repository, "fetch", "--depth", "1", "https://github.com/Snapmaker/OrcaSlicer.git", PIN)
    if run("git", "-C", repository, "rev-parse", PIN + "^{commit}", capture=True).strip() != PIN:
        raise RuntimeError("Pinned source is unavailable")
    if not source.exists():
        directory.mkdir(parents=True, exist_ok=True)
        run("git", "-C", repository, "worktree", "add", "--quiet", "--detach", source, PIN)
        run("git", "-C", source, "apply", "--check", "--index", PATCH)
        run("git", "-C", source, "apply", "--index", PATCH)
    if run("git", "-C", source, "rev-parse", "HEAD", capture=True).strip() != PIN:
        raise RuntimeError("Prepared source revision drift; refusing to reset it")
    diff = subprocess.check_output(["git", "-C", str(source), "diff", "--binary", "--no-ext-diff", "HEAD"])
    if diff != PATCH.read_bytes():
        raise RuntimeError("Prepared source patch drift; refusing to overwrite it")
    if run("git", "-C", source, "ls-files", "--others", "--exclude-standard", capture=True).strip():
        raise RuntimeError("Unexpected untracked source files")
    return source



def cached_tbb_archive():
    # Shared, content-checked download cache; recipe revisions still extract
    # and compile in clean per-ABI directories.
    archive = BUILD / "downloads/deps/TBB/v2021.5.0.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        if sha(archive) != TBB_ARCHIVE_SHA:
            raise RuntimeError("Cached TBB archive drift; refusing to overwrite it")
        return archive
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as output:
            temporary = Path(output.name)
            url = "https://github.com/oneapi-src/oneTBB/archive/refs/tags/v2021.5.0.zip"
            deadline = time.monotonic() + 180
            size = 0
            with urllib.request.urlopen(url, timeout=30) as response:
                while chunk := response.read1(65536):
                    size += len(chunk)
                    if size > 64 * 1024 * 1024 or time.monotonic() > deadline:
                        raise RuntimeError("TBB archive download exceeded its limit")
                    output.write(chunk)
        if sha(temporary) != TBB_ARCHIVE_SHA:
            raise RuntimeError("Downloaded TBB archive identity mismatch")
        temporary.replace(archive)
        return archive
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verify_elf(path, abi, llvm):
    data = path.read_bytes()
    if len(data) < 64:
        raise RuntimeError("Truncated ELF")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    if header[0][:6] != b"\x7fELF\x02\x01" or header[1] != 3 or header[2] != ABIS[abi][0]:
        raise RuntimeError(f"Wrong ELF identity: {path.name}")
    if header[9] != 56 or header[10] == 0 or header[5] + header[9] * header[10] > len(data):
        raise RuntimeError("Invalid ELF program headers")
    loads = 0
    for i in range(header[10]):
        segment = struct.unpack_from("<IIQQQQQQ", data, header[5] + i * 56)
        if segment[0] == 1:
            loads += 1
            if segment[7] < 16384 or segment[7] & (segment[7] - 1) or segment[2] % 16384 != segment[3] % 16384:
                raise RuntimeError(f"ELF is not 16 KB aligned: {path.name}")
            if segment[2] + segment[5] > len(data) or segment[5] > segment[6]:
                raise RuntimeError("Invalid ELF load segment")
    if not loads:
        raise RuntimeError("ELF has no load segments")
    dynamic = run(llvm / "llvm-readelf", "-d", path, capture=True)
    needed = re.findall(r"\(NEEDED\).*\[([A-Za-z0-9+_.-]+)\]", dynamic)
    if len(needed) != dynamic.count("(NEEDED)") or "(RUNPATH)" in dynamic or "(RPATH)" in dynamic:
        raise RuntimeError("Unrecognized dependency or unexpected runtime search path")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "needed": sorted(needed)}


def verify_package(directory, abi, expected_inputs, llvm):
    package = directory / abi / "package"
    manifest = json.loads((package / "manifest.json").read_text())
    if (manifest["schemaVersion"] != 1 or manifest["engineCommit"] != PIN or manifest["abi"] != abi
        or manifest["api"] != 31 or manifest["ndk"] != NDK_VERSION or manifest["inputs"] != expected_inputs
        or manifest["recipe"] != fingerprint(expected_inputs) or manifest["slicingQualified"] is not False
        or manifest["tbb"] != {"version": "2021.5.0", "archiveSha256": TBB_ARCHIVE_SHA}
        or manifest["compiler"] != run(llvm / "clang++", "--version", capture=True).splitlines()[0]):
        raise RuntimeError("Dependency package identity mismatch")
    required = {"orcaxr_tbb_probe", "libtbb.so", "libtbbmalloc.so", "libc++_shared.so"}
    if set(manifest["files"]) != required or {p.name for p in package.iterdir()} != required | {"manifest.json"}:
        raise RuntimeError("Unexpected or missing package files")
    for name in required:
        if verify_elf(package / name, abi, llvm) != manifest["files"][name]:
            raise RuntimeError(f"Dependency package drift: {name}")
        if not set(manifest["files"][name]["needed"]) <= required - {"orcaxr_tbb_probe"} | PLATFORM_LIBRARIES:
            raise RuntimeError("Packaged native dependency is missing")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", choices=ABIS, action="append")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if args.jobs not in range(1, 5):
        parser.error("--jobs must be between 1 and 4")
    BUILD.mkdir(parents=True, exist_ok=True)
    with (BUILD / ".dependency-build.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH if args.verify_only else fcntl.LOCK_EX)
        ndk, llvm, compiler = toolchain()
        source_inputs = inputs()
        recipe = fingerprint(source_inputs)
        directory = BUILD / "recipes" / recipe
        source = None if args.verify_only else prepare_source(directory)
        archive = None if args.verify_only else cached_tbb_archive()
        for abi in dict.fromkeys(args.abi or ABIS):
            if not args.verify_only:
                root = directory / abi
                deps = root / "deps"
                prefix = deps / "destdir/usr/local"
                common = [f"-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake",
                    f"-DANDROID_ABI={abi}", "-DANDROID_PLATFORM=android-31", "-DANDROID_STL=c++_shared",
                    "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"]
                package = root / "package"
                package.mkdir(parents=True, exist_ok=True)
                (package / "manifest.json").unlink(missing_ok=True)
                run("cmake", "-S", source / "deps", "-B", deps, "-G", "Ninja", *common,
                    f"-DORCAXR_BUILD_JOBS={args.jobs}", f"-DDESTDIR={deps}/destdir",
                    f"-DDEP_DOWNLOAD_DIR={BUILD}/downloads/deps")
                run("nice", "-n", "10", "cmake", "--build", deps, "--target", "dep_TBB", f"-j{args.jobs}")
                if sha(archive) != TBB_ARCHIVE_SHA:
                    raise RuntimeError("TBB source archive identity mismatch")
                run("cmake", "-S", HERE / "probes", "-B", root / "probes", "-G", "Ninja", *common,
                    f"-DCMAKE_PREFIX_PATH={prefix}", f"-DCMAKE_FIND_ROOT_PATH={prefix}")
                run("nice", "-n", "10", "cmake", "--build", root / "probes", f"-j{args.jobs}")
                files = [root / "probes/orcaxr_tbb_probe", prefix / "lib/libtbb.so", prefix / "lib/libtbbmalloc.so",
                    llvm.parent / f"sysroot/usr/lib/{ABIS[abi][1]}/libc++_shared.so"]
                for path in files:
                    shutil.copy2(path, package / path.name)
                manifest = {"schemaVersion": 1, "engineCommit": PIN, "recipe": recipe, "inputs": source_inputs,
                    "abi": abi, "api": 31, "ndk": NDK_VERSION, "compiler": compiler,
                    "tbb": {"version": "2021.5.0", "archiveSha256": TBB_ARCHIVE_SHA}, "slicingQualified": False,
                    "files": {p.name: verify_elf(package / p.name, abi, llvm) for p in files}}
                (package / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            verify_package(directory, abi, source_inputs, llvm)
            print(f"Verified Android dependency package: {abi} {directory / abi / 'package'}", flush=True)


if __name__ == "__main__":
    main()
