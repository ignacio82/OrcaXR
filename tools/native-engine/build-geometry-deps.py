#!/usr/bin/env python3
"""Cross-build the current engine's geometry dependencies from tracked recipes.

This development entry point does not build libslic3r or package an application.
Use --target for an explicit subset while porting; the report records that subset.
The default attempts the complete geometry dependency list for both initial ABIs.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("dependency_build", HERE / "build-dependency-probes.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
PATCHES = [HERE / "patches" / name for name in [
    "0001-android-dependency-bootstrap.patch", "0002-android-geometry-dependencies.patch",
    "0003-android-crypto-dependency.patch"]]
TARGETS = ["GMP", "MPFR", "ZLIB", "Boost", "CGAL", "Cereal", "Qhull", "NLopt", "libnoise",
           "EXPAT", "PNG", "JPEG", "FREETYPE", "TBB", "Blosc", "OpenEXR", "OpenVDB", "OpenCV", "OCCT", "OpenSSL"]


def run(*args, cwd=None, env=None, capture=False):
    return subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True,
                          stdout=subprocess.PIPE if capture else None, text=capture).stdout


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_inputs():
    return {str(p.relative_to(ROOT)): sha(p) for p in [Path(__file__), HERE / "build-dependency-probes.py", *PATCHES]}


def recipe_id(inputs):
    return hashlib.sha256(json.dumps({"inputs": inputs, "engine": base.PIN,
        "ndk": base.NDK_VERSION, "api": 31}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare_source(directory, create=True, patch_steps=None):
    steps = patch_steps if patch_steps is not None else [(patch, []) for patch in PATCHES]
    source = directory / "source"
    if not create and not source.exists():
        raise RuntimeError("Geometry source has not been built for this recipe")
    repository = ROOT / "third_party/SnapmakerOrca"
    if not repository.exists():
        repository = base.BUILD / "downloads/snapmaker.git"
        if not repository.exists():
            repository.parent.mkdir(exist_ok=True, parents=True)
            run("git", "init", "--bare", repository)
        run("git", "-C", repository, "fetch", "--depth", "1", "https://github.com/Snapmaker/OrcaSlicer.git", base.PIN)
    directory.mkdir(exist_ok=True, parents=True)
    # Compute the expected patched tree in a separate Git index. A modified
    # worktree or its mutable index cannot attest its own source identity.
    with tempfile.TemporaryDirectory(prefix="orcaxr-engine-index-", dir=directory) as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / "index"))
        run("git", "-C", repository, "read-tree", base.PIN, env=env)
        for patch, filters in steps:
            run("git", "-C", repository, "apply", "--cached", *filters, patch, env=env)
        expected = run("git", "-C", repository, "write-tree", env=env, capture=True).strip()
    if not source.exists():
        run("git", "-C", repository, "worktree", "add", "--quiet", "--detach", source, base.PIN)
        for patch, filters in steps:
            run("git", "-C", source, "apply", "--index", *filters, patch)
    if run("git", "-C", source, "rev-parse", "HEAD", capture=True).strip() != base.PIN:
        raise RuntimeError("Engine revision drift; refusing to reset the worktree")
    run("git", "-C", source, "diff", "--exit-code", "--quiet")
    if (run("git", "-C", source, "write-tree", capture=True).strip() != expected
        or run("git", "-C", source, "ls-files", "--others", "--exclude-standard", capture=True).strip()):
        raise RuntimeError("Engine source drift; refusing to overwrite the worktree")
    return source, expected


def archive_objects(path, abi):
    """Reject host or mixed-ABI objects, including objects in GNU long-name archives."""
    count = 0
    total = path.stat().st_size
    with path.open("rb") as stream:
        if stream.read(8) != b"!<arch>\n":
            raise RuntimeError(f"Expected a regular object archive: {path.name}")
        while stream.tell() < total:
            header = stream.read(60)
            if len(header) != 60 or header[58:] != b"`\n":
                raise RuntimeError("Malformed archive member")
            size = int(header[48:58])
            start = stream.tell()
            if size < 0 or start + size > total:
                raise RuntimeError("Invalid archive member bounds")
            name = header[:16].rstrip()
            if name not in (b"/", b"//", b"/SYM64/"):
                ident = stream.read(min(size, 20))
                if (len(ident) != 20 or ident[:6] != b"\x7fELF\x02\x01"
                    or struct.unpack_from("<HH", ident, 16) != (1, base.ABIS[abi][0])):
                    raise RuntimeError(f"Non-target object in {path.name}")
                count += 1
            stream.seek(start + size + size % 2)
        if stream.tell() != total or count == 0:
            raise RuntimeError("Empty or malformed object archive")
    return count


def inspect_install(prefix, abi, llvm):
    entries = {}
    libraries = {}
    for path in sorted(prefix.rglob("*")):
        relative = str(path.relative_to(prefix))
        if path.is_symlink():
            if not path.resolve().is_relative_to(prefix.resolve()):
                raise RuntimeError("Install symlink escapes the target prefix")
            entries[relative] = {"symlink": os.readlink(path)}
        elif path.is_file():
            identity = {"sha256": sha(path), "bytes": path.stat().st_size}
            entries[relative] = identity
            if path.suffix == ".a":
                libraries[relative] = dict(identity, objects=archive_objects(path, abi))
            elif ".so" in path.name:
                libraries[relative] = base.verify_elf(path, abi, llvm)
    if not libraries:
        raise RuntimeError("No target libraries were installed")
    tree = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"treeSha256": tree, "entries": len(entries), "libraries": libraries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", action="append", choices=base.ABIS)
    parser.add_argument("--target", action="append", choices=TARGETS)
    parser.add_argument("--jobs", type=int, default=1, choices=range(1, 5))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    base.BUILD.mkdir(parents=True, exist_ok=True)
    # The dependency probes share the download cache with this builder.
    with (base.BUILD / ".dependency-build.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH if args.verify_only else fcntl.LOCK_EX)
        ndk, llvm, compiler = base.toolchain()
        inputs = source_inputs()
        recipe = recipe_id(inputs)
        directory = base.BUILD / "geometry" / recipe
        source, tree = prepare_source(directory, create=not args.verify_only)
        targets = [t for t in TARGETS if t in (args.target or TARGETS)]
        for abi in dict.fromkeys(args.abi or base.ABIS):
            build = directory / abi / "deps"
            prefix = build / "destdir/usr/local"
            report_path = directory / abi / "manifest.json"
            identity = {"schemaVersion": 1, "engineCommit": base.PIN, "sourceTree": tree,
                "inputs": inputs, "recipe": recipe, "abi": abi, "api": 31, "ndk": base.NDK_VERSION,
                "compiler": compiler, "targets": targets, "engineBuilt": False, "slicingQualified": False}
            if not args.verify_only:
                report_path.unlink(missing_ok=True)
                run("cmake", "-S", source / "deps", "-B", build, "-G", "Ninja",
                    f"-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake",
                    f"-DANDROID_ABI={abi}", "-DANDROID_PLATFORM=android-31", "-DANDROID_STL=c++_shared",
                    "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
                    f"-DORCAXR_BUILD_JOBS={args.jobs}", f"-DDESTDIR={build}/destdir",
                    f"-DDEP_DOWNLOAD_DIR={base.BUILD}/downloads/deps")
                for target in targets:
                    print(f"Building {abi} dep_{target}", flush=True)
                    run("nice", "-n", "10", "cmake", "--build", build, "--target", "dep_" + target, "-j1")
                if source_inputs() != inputs:
                    raise RuntimeError("Build inputs changed during compilation; refusing to attest them")
                prepare_source(directory, create=False)
                installed = inspect_install(prefix, abi, llvm)
                report_path.write_text(json.dumps(dict(identity, install=installed), indent=2, sort_keys=True) + "\n")
            report = json.loads(report_path.read_text())
            if report != dict(identity, install=inspect_install(prefix, abi, llvm)):
                raise RuntimeError("Geometry dependency build identity mismatch")
            print(f"Verified geometry dependency subset: {abi} {','.join(targets)} {report_path}", flush=True)


if __name__ == "__main__":
    main()
