#!/usr/bin/env python3
"""Build the application's local slicing adapter (liborcaxr_engine.so) over a verified engine build.

build-engine.py compiles the pinned libslic3r once per ABI and verifies its
fixture package. This layer compiles only the adapter's own sources, with the
exact compile and link lines that recipe gives its probe target, into a JNI
shared library exporting nothing but JNI_OnLoad and the adapter's C entry
points, plus a fixture driver over that same entry point. An adapter change
therefore never rebuilds the engine, and an engine change gives the adapter a
new recipe. Outputs live under build/adapter/<recipe>/<abi>; the engine's own
build tree is only read.

--export DIR verifies both ABIs and writes what the app packages: jniLibs/<abi>/
(the adapter and its runtime libraries) and assets/engine/ (resources and the
identity manifest the app checks the loaded library against).
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("native_engine", HERE / "build-engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
geometry, base = engine.geometry, engine.base
ADAPTER = HERE / "adapter"
PROBE = HERE / "engine"
LIBRARY = "liborcaxr_engine.so"
DRIVER = "orcaxr_engine_driver"
RUNTIME = ("libtbb.so", "libtbbmalloc.so", "libc++_shared.so")
PACKAGED = (LIBRARY, *RUNTIME)
EXPORTS = sorted(["JNI_OnLoad", "orcaxr_engine_slice", "orcaxr_engine_cancel", "orcaxr_engine_progress",
                  "orcaxr_engine_identity", "orcaxr_engine_file_sha256", "orcaxr_engine_check_defaults"])
LIBRARY_SOURCES = [ADAPTER / "engine_adapter.cpp", ADAPTER / "engine_jni.cpp", PROBE / "defaults_probe.cpp"]
DRIVER_SOURCES = [ADAPTER / "engine_driver.cpp"]
PLATFORM = base.PLATFORM_LIBRARIES | {"liblog.so", "libandroid.so", "libz.so"}
PROBE_OBJECT = "src/orcaxr-probe/CMakeFiles/orcaxr_slice_probe.dir/slice_probe.cpp.o"
PROBE_TARGET = "src/orcaxr-probe/orcaxr_slice_probe"


def inputs():
    files = [Path(__file__), *sorted(p for p in ADAPTER.iterdir() if p.is_file()),
             PROBE / "defaults_probe.cpp", PROBE / "defaults_probe.hpp"]
    if any(p.is_symlink() for p in files):
        raise RuntimeError("Adapter inputs must be regular files")
    return {str(p.relative_to(ROOT)): geometry.sha(p) for p in files}


def recipe_id(source_inputs, engine_recipe):
    return hashlib.sha256(json.dumps({"inputs": source_inputs, "engine": base.PIN, "engineRecipe": engine_recipe,
        "ndk": base.NDK_VERSION, "api": 31}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ninja_block(text, header):
    """The indented variables of the build statement that starts with [header]."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(header):
            values = {}
            for entry in lines[index + 1:]:
                if not entry.startswith("  "):
                    break
                key, _, value = entry.strip().partition(" = ")
                values[key] = value
            return values
    raise RuntimeError(f"The engine build has no {header!r} statement")


def engine_lines(cmake, abi, llvm):
    """The engine recipe's own probe compile and link variables, from its build tree, read only."""
    ninja = (cmake / "build.ninja").read_text()
    compile_vars = ninja_block(ninja, f"build {PROBE_OBJECT}: ")
    link_vars = ninja_block(ninja, f"build {PROBE_TARGET}: ")
    rules = (cmake / "CMakeFiles/rules.ninja").read_text()
    triple = base.ABIS[abi][1].replace("-linux-", "-none-linux-") + "31"
    sysroot = llvm.parent / "sysroot"
    prefix = [str(llvm / "clang++"), f"--target={triple}", f"--sysroot={sysroot}"]
    if " ".join(prefix) + " $DEFINES $INCLUDES $FLAGS" not in rules or " ".join(prefix) + " $FLAGS $LINK_FLAGS" not in rules:
        raise RuntimeError("Engine compiler identity differs from the pinned toolchain")
    flags = shlex.split(compile_vars["FLAGS"])
    if flags.count("-fPIE") != 1:
        raise RuntimeError("Unexpected engine probe compile flags")
    compile_flags = shlex.split(compile_vars["DEFINES"]) + shlex.split(compile_vars["INCLUDES"]) + \
        [flag if flag != "-fPIE" else "-fPIC" for flag in flags]
    link_flags = shlex.split(link_vars["LINK_FLAGS"])
    # The dependency file would be written into the engine's build tree.
    position = link_flags.index("--dependency-file=" + link_vars["DEP_FILE"])
    if position == 0 or link_flags[position - 1] != "-Xlinker":
        raise RuntimeError("Unexpected engine probe link flags")
    del link_flags[position - 1:position + 1]
    libraries = []
    for token in shlex.split(link_vars["LINK_LIBRARIES"]):
        if token.startswith("-"):
            libraries.append(token)
        else:
            # Installed archives can be versioned symlinks (libpng.a); they must stay inside the build.
            path = (Path(token) if token.startswith("/") else cmake / token).resolve()
            if not path.is_file() or not path.is_relative_to(base.BUILD.resolve()):
                raise RuntimeError(f"Engine link input is missing: {token}")
            libraries.append(str(path))
    archives = sorted({value for value in libraries if value.endswith(".a")})
    return prefix, compile_flags, shlex.split(link_vars["FLAGS"]), link_flags, libraries, archives


def exported(path, llvm):
    output = base.run(llvm / "llvm-nm", "-D", "--defined-only", "--format=just-symbols", path, capture=True)
    return sorted(output.split())


def verify_files(package, manifest, abi, llvm, names, resources):
    for name in names:
        if (package / name).is_symlink():
            raise RuntimeError("Engine adapter package identity mismatch")
        info = base.verify_elf(package / name, abi, llvm)
        if info != manifest["files"].get(name):
            raise RuntimeError(f"Engine adapter package drift: {name}")
        allowed = set(RUNTIME) | PLATFORM | ({LIBRARY} if name == DRIVER else set())
        if name == "libc++_shared.so" or name == "libtbbmalloc.so":
            allowed = PLATFORM
        if not set(info["needed"]) <= allowed:
            raise RuntimeError("Engine adapter package has an unresolved runtime dependency")
    if exported(package / LIBRARY, llvm) != EXPORTS:
        raise RuntimeError("Engine adapter exports more than its JNI and C entry points")
    actual = {str(p.relative_to(package / "resources")): geometry.sha(p)
              for p in sorted((package / "resources").rglob("*")) if p.is_file()}
    if actual != manifest["resources"] or actual != resources:
        raise RuntimeError("Engine adapter resource drift")


def verify_package(package, identity, abi, llvm, resources):
    manifest = json.loads((package / "manifest.json").read_text())
    names = {*PACKAGED, DRIVER}
    if (set(manifest) != set(identity) | {"files", "resources"} or any(manifest[k] != v for k, v in identity.items())
        or set(manifest["files"]) != names or {p.name for p in package.iterdir()} != names | {"manifest.json", "resources"}
        or any(p.is_symlink() for p in package.rglob("*"))):
        raise RuntimeError("Engine adapter package identity mismatch")
    verify_files(package, manifest, abi, llvm, sorted(names), resources)
    return manifest


def identity_for(abi, engine_recipe, engine_package, source_inputs, recipe, compiler):
    return {"schemaVersion": 1, "kind": "android-engine-adapter", "engineCommit": base.PIN,
        "engineRecipe": engine_recipe, "enginePackageManifestSha256": geometry.sha(engine_package / "manifest.json"),
        "inputs": source_inputs, "recipe": recipe, "abi": abi, "api": 31, "ndk": base.NDK_VERSION,
        "compiler": compiler, "exports": EXPORTS, "symbols": "stripped-unneeded",
        "applicationRoute": True, "slicingQualified": False}


def build(abi, engine_recipe, engine_root, recipe, source_inputs, llvm, compiler):
    cmake = engine_root / abi / "cmake"
    engine_package = engine_root / abi / "package"
    prefix, compile_flags, link_base, link_flags, libraries, archives = engine_lines(cmake, abi, llvm)
    root = base.BUILD / "adapter" / recipe / abi
    objects = root / "objects"
    package = root / "package"
    if root.exists():
        shutil.rmtree(root)
    objects.mkdir(parents=True)
    package.mkdir()
    defines = [f'-DORCAXR_ENGINE_COMMIT="{base.PIN}"', f'-DORCAXR_ENGINE_RECIPE="{engine_recipe}"',
               f'-DORCAXR_ADAPTER_RECIPE="{recipe}"', f"-I{ADAPTER}", f"-I{PROBE}"]
    compiled = []
    for source in [*LIBRARY_SOURCES, *DRIVER_SOURCES]:
        target = objects / (source.stem + ".o")
        flags = [flag if flag != "-fPIC" else "-fPIE" for flag in compile_flags] if source in DRIVER_SOURCES else compile_flags
        geometry.run("nice", "-n", "10", *prefix, *defines, *flags, "-c", source, "-o", target)
        compiled.append(target)
    library = root / LIBRARY
    geometry.run("nice", "-n", "10", *prefix, *link_base, "-fPIC", "-shared", f"-Wl,-soname,{LIBRARY}", *link_flags,
                 f"-Wl,--version-script={ADAPTER / 'exports.map'}", "-Wl,-z,max-page-size=16384",
                 *compiled[:len(LIBRARY_SOURCES)], "-o", library, *libraries)
    driver = root / DRIVER
    geometry.run("nice", "-n", "10", *prefix, *link_base, "-fPIE", "-pie", *link_flags, "-Wl,-z,max-page-size=16384",
                 compiled[-1], library, "-o", driver)
    if inputs() != source_inputs:
        raise RuntimeError("Engine adapter inputs changed during compilation")
    # Keep the unstripped originals beside the package; devices get stripped copies.
    for path in [library, driver, *(engine_package / name for name in RUNTIME)]:
        shutil.copy2(path, package / path.name)
        geometry.run(llvm / "llvm-strip", "--strip-unneeded", package / path.name)
    resources = package / "resources"
    shutil.copytree(engine_package / "resources", resources)
    identity = identity_for(abi, engine_recipe, engine_package, source_inputs, recipe, compiler)
    manifest = dict(identity,
        files={name: base.verify_elf(package / name, abi, llvm) for name in sorted({*PACKAGED, DRIVER})},
        resources={str(p.relative_to(resources)): geometry.sha(p) for p in sorted(resources.rglob("*")) if p.is_file()})
    (package / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    # What the link consumed, for the record: the engine's own archives at this build.
    (root / "link-inputs.json").write_text(json.dumps({str(Path(p).relative_to(base.BUILD.resolve()))
        if Path(p).is_relative_to(base.BUILD.resolve()) else p: geometry.sha(Path(p)) for p in archives},
        indent=2, sort_keys=True) + "\n")


def export(target, packages, recipe, engine_recipe):
    """What the app packages, from verified packages only: libraries per ABI, resources and identity."""
    if target.exists():
        shutil.rmtree(target)
    assets = target / "assets/engine"
    resources = None
    abis = {}
    for abi, (package, manifest) in packages.items():
        libraries = target / "jniLibs" / abi
        libraries.mkdir(parents=True)
        for name in PACKAGED:
            shutil.copy2(package / name, libraries / name)
        if resources is None:
            resources = manifest["resources"]
            shutil.copytree(package / "resources", assets / "resources")
        elif resources != manifest["resources"]:
            raise RuntimeError("Engine resources differ between ABIs")
        abis[abi] = {"manifestSha256": geometry.sha(package / "manifest.json"),
                     "files": {name: manifest["files"][name]["sha256"] for name in PACKAGED}}
    identity = {"schemaVersion": 1, "engineCommit": base.PIN, "engineRecipe": engine_recipe, "adapterRecipe": recipe,
                "abis": abis, "resources": resources, "slicingQualified": False}
    (assets / "manifest.json").write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", choices=base.ABIS, action="append")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--export", type=Path, help="write the app's verified engine libraries and assets here")
    args = parser.parse_args()
    selected = list(dict.fromkeys(args.abi or base.ABIS))
    if args.export and set(selected) != set(base.ABIS):
        parser.error("--export packages both ABIs")
    for abi in selected:
        # The engine recipe verifies its sources, dependency installation and package first.
        subprocess.run([sys.executable, HERE / "build-engine.py", "--abi", abi, "--verify-only"], check=True,
                       stdout=subprocess.DEVNULL if args.export else None)
    base.BUILD.mkdir(parents=True, exist_ok=True)
    with (base.BUILD / ".dependency-build.lock").open("a+b") as engine_lock, \
            (base.BUILD / ".adapter-build.lock").open("a+b") as lock:
        # Readers of the engine build share its lock; this layer's own outputs have theirs.
        fcntl.flock(engine_lock, fcntl.LOCK_SH)
        fcntl.flock(lock, fcntl.LOCK_SH if args.verify_only or args.export else fcntl.LOCK_EX)
        _, llvm, compiler = base.toolchain()
        engine_inputs = engine.inputs()
        engine_recipe = geometry.recipe_id(engine_inputs)
        engine_root = base.BUILD / "engine" / engine_recipe
        source, _ = geometry.prepare_source(engine_root, create=False, patch_steps=engine.PATCH_STEPS)
        resources = engine.source_resources(source)
        source_inputs = inputs()
        recipe = recipe_id(source_inputs, engine_recipe)
        packages = {}
        for abi in selected:
            if not (args.verify_only or args.export):
                build(abi, engine_recipe, engine_root, recipe, source_inputs, llvm, compiler)
            engine_package = engine_root / abi / "package"
            identity = identity_for(abi, engine_recipe, engine_package, source_inputs, recipe, compiler)
            package = base.BUILD / "adapter" / recipe / abi / "package"
            if not (package / "manifest.json").is_file():
                raise RuntimeError(f"No engine adapter package for {abi}; run build-engine-adapter.py --abi {abi}")
            packages[abi] = (package, verify_package(package, identity, abi, llvm, resources))
            if not args.export:
                print(f"Verified engine adapter package: {abi} {package}", flush=True)
        if engine.inputs() != engine_inputs or inputs() != source_inputs:
            raise RuntimeError("Engine or adapter inputs changed during verification")
        if args.export:
            export(args.export, packages, recipe, engine_recipe)
            print(f"Exported verified engine adapter {recipe[:12]} for {', '.join(selected)}", flush=True)


if __name__ == "__main__":
    main()
