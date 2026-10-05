#!/usr/bin/env python3
"""Build a standalone Android fixture slicer from the current shared engine sources.

This tool produces internal CLI artifacts, not a production JNI/service route.
Successful compilation does not qualify native slicing or distribution.
"""
import argparse
import fcntl
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("geometry_build", HERE / "build-geometry-deps.py")
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
base = geometry.base
SHARED_PATCH = ROOT / "wasm/patches/snapmaker-fork-wasm-port.diff"
STATS_PATCH = ROOT / "server/patches/0003-gcodeprocessor-fullspectrum-oob.patch"
ANDROID_PATCH = HERE / "patches/0004-android-headless-engine.patch"
INITIALIZATION_PATCH = HERE / "patches/0005-headless-print-initialization.patch"
# git apply uses the first matching include/exclude rule. The CMake exclusion
# must precede the broad include; native geometry libraries must stay enabled.
PATCH_STEPS = [(patch, []) for patch in geometry.PATCHES] + [
    (SHARED_PATCH, ["--exclude=src/libslic3r/CMakeLists.txt", "--include=src/libslic3r/*"]),
    (STATS_PATCH, []), (ANDROID_PATCH, []), (INITIALIZATION_PATCH, [])]
PLATFORM_LIBRARIES = base.PLATFORM_LIBRARIES | {"liblog.so", "libandroid.so", "libz.so"}


def inputs():
    files = [Path(__file__), SHARED_PATCH, STATS_PATCH, ANDROID_PATCH, INITIALIZATION_PATCH,
             *sorted((HERE / "engine").glob("*"))]
    return dict(geometry.source_inputs(), **{str(p.relative_to(ROOT)): geometry.sha(p) for p in files if p.is_file()})


def patch_manifest(source_inputs):
    # Keep this Android identity separate from the published WASM/CLI recipes.
    # Order and filters are part of the reproducible selection, not just hashes.
    return [{"path": str(path.relative_to(ROOT)), "sha256": source_inputs[str(path.relative_to(ROOT))],
             "role": "android-dependencies" if path in geometry.PATCHES else
                     "android-build" if path == ANDROID_PATCH else
                     "android-runtime" if path == INITIALIZATION_PATCH else "shared-behavior",
             "filters": filters} for path, filters in PATCH_STEPS]


def source_resources(source):
    paths = sorted((source / "resources/info").glob("*.json"))
    if not paths or any(p.is_symlink() or not p.is_file() for p in paths):
        raise RuntimeError("Native engine resource inputs are missing or indirect")
    return {"info/" + p.name: geometry.sha(p) for p in paths}


def verify_package(package, identity, abi, llvm, expected_resources):
    manifest = json.loads((package / "manifest.json").read_text())
    required = {"orcaxr_slice_probe", "libtbb.so", "libtbbmalloc.so", "libc++_shared.so"}
    if (set(manifest) != set(identity) | {"files", "resources"}
        or any(manifest[k] != v for k, v in identity.items()) or set(manifest["files"]) != required
        or {p.name for p in package.iterdir()} != required | {"manifest.json", "resources"}
        or any(p.is_symlink() for p in package.rglob("*"))):
        raise RuntimeError("Native fixture engine package identity mismatch")
    for name in required:
        info = base.verify_elf(package / name, abi, llvm)
        if (info != manifest["files"][name]
            or not set(info["needed"]) <= required - {"orcaxr_slice_probe"} | PLATFORM_LIBRARIES):
            raise RuntimeError("Native engine package drift or missing runtime dependency")
    actual = {str(p.relative_to(package / "resources")): geometry.sha(p)
              for p in sorted((package / "resources").rglob("*")) if p.is_file()}
    if actual != manifest["resources"] or actual != expected_resources:
        raise RuntimeError("Native engine resource drift")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", choices=base.ABIS, action="append")
    parser.add_argument("--jobs", choices=range(1, 5), type=int, default=1)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    selected = list(dict.fromkeys(args.abi or base.ABIS))
    # Dependency construction takes the same exclusive lock itself. Finish it
    # first, then retain ownership through verification, compilation and packaging.
    if not args.verify_only:
        dependency_recipe = geometry.recipe_id(geometry.source_inputs())
        for abi in selected:
            report = base.BUILD / "geometry" / dependency_recipe / abi / "manifest.json"
            command = [sys.executable, str(HERE / "build-geometry-deps.py"), "--abi", abi]
            # A complete installed tree can outlive disposable build objects.
            # Verify its entire source/ABI/file identity before reuse. A corrupt
            # existing report must fail, not silently trigger reconstruction.
            command += ["--verify-only"] if report.exists() else ["--jobs", str(args.jobs)]
            subprocess.run(command, check=True)
    base.BUILD.mkdir(parents=True, exist_ok=True)
    with (base.BUILD / ".dependency-build.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH if args.verify_only else fcntl.LOCK_EX)
        ndk, llvm, compiler = base.toolchain()
        source_inputs = inputs()
        recipe = geometry.recipe_id(source_inputs)
        directory = base.BUILD / "engine" / recipe
        source, tree = geometry.prepare_source(directory, create=not args.verify_only, patch_steps=PATCH_STEPS)
        expected_resources = source_resources(source)
        dependency_inputs = geometry.source_inputs()
        dependency_recipe = geometry.recipe_id(dependency_inputs)
        dependency_root = base.BUILD / "geometry" / dependency_recipe
        _, dependency_tree = geometry.prepare_source(dependency_root, create=False)
        for abi in selected:
            dependency_manifest_path = dependency_root / abi / "manifest.json"
            dependency = json.loads(dependency_manifest_path.read_text())
            prefix = dependency_root / abi / "deps/destdir/usr/local"
            expected = {"schemaVersion": 1, "engineCommit": base.PIN, "sourceTree": dependency_tree,
                "inputs": dependency_inputs, "recipe": dependency_recipe, "abi": abi, "api": 31,
                "ndk": base.NDK_VERSION, "compiler": compiler, "targets": geometry.TARGETS,
                "engineBuilt": False, "slicingQualified": False,
                "install": geometry.inspect_install(prefix, abi, llvm)}
            if dependency != expected:
                raise RuntimeError("Native engine dependency identity mismatch")
            identity = {"schemaVersion": 1, "engineCommit": base.PIN, "sourceTree": tree,
                "inputs": source_inputs, "recipe": recipe, "abi": abi, "api": 31,
                "ndk": base.NDK_VERSION, "compiler": compiler,
                "patches": patch_manifest(source_inputs),
                "executableSymbols": "stripped-unneeded",
                "dependencyManifestSha256": geometry.sha(dependency_manifest_path),
                "engineBuilt": True, "slicingQualified": False, "applicationRoute": False}
            root = directory / abi
            build = root / "cmake"
            package = root / "package"
            if not args.verify_only:
                package.mkdir(parents=True, exist_ok=True)
                (package / "manifest.json").unlink(missing_ok=True)
                geometry.run("cmake", "-S", source, "-B", build, "-G", "Ninja",
                    f"-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake",
                    f"-DANDROID_ABI={abi}", "-DANDROID_PLATFORM=android-31", "-DANDROID_STL=c++_shared",
                    "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
                    f"-DCMAKE_PREFIX_PATH={prefix}", f"-DCMAKE_FIND_ROOT_PATH={prefix}",
                    f"-DOpenCV_DIR={prefix}/sdk/native/jni", f"-DORCAXR_SLICE_PROBE_DIR={HERE}/engine",
                    "-DSLIC3R_GUI=OFF", "-DORCA_TOOLS=OFF", "-DSLIC3R_STATIC=ON",
                    "-DSLIC3R_SENTRY=OFF", "-DSLIC3R_DESKTOP_INTEGRATION=OFF", "-DSLIC3R_ENC_CHECK=OFF")
                geometry.run("nice", "-n", "10", "cmake", "--build", build,
                             "--target", "orcaxr_slice_probe", f"-j{args.jobs}")
                if inputs() != source_inputs:
                    raise RuntimeError("Native engine inputs changed during compilation")
                geometry.prepare_source(directory, create=False, patch_steps=PATCH_STEPS)
                files = [build / "src/orcaxr-probe/orcaxr_slice_probe", prefix / "lib/libtbb.so",
                    prefix / "lib/libtbbmalloc.so",
                    llvm.parent / f"sysroot/usr/lib/{base.ABIS[abi][1]}/libc++_shared.so"]
                for path in files:
                    shutil.copy2(path, package / path.name)
                # NDK release builds retain debug information. Keep it in the
                # build artifact, not the executable transferred to a device.
                geometry.run(llvm / "llvm-strip", "--strip-unneeded", package / "orcaxr_slice_probe")
                resources = package / "resources/info"
                resources.mkdir(parents=True, exist_ok=True)
                for path in sorted((source / "resources/info").glob("*.json")):
                    shutil.copy2(path, resources / path.name)
                manifest = dict(identity,
                    files={p.name: base.verify_elf(package / p.name, abi, llvm) for p in files},
                    resources=expected_resources)
                (package / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            verify_package(package, identity, abi, llvm, expected_resources)
            print(f"Verified native fixture engine package: {abi} {package}", flush=True)


if __name__ == "__main__":
    main()
