#!/usr/bin/env python3
"""Exercise the engine adapter package's publication guards on an actual verified package."""
import argparse
import fcntl
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("engine_adapter", HERE / "build-engine-adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
engine, base, geometry = adapter.engine, adapter.base, adapter.geometry
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--abi", choices=base.ABIS, default="x86_64")
arguments = parser.parse_args()


class EngineAdapterPackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, HERE / "build-engine-adapter.py", "--abi", arguments.abi, "--verify-only"], check=True)
        cls.lock = (base.BUILD / ".adapter-build.lock").open("a+b")
        cls.addClassCleanup(cls.lock.close)
        fcntl.flock(cls.lock, fcntl.LOCK_SH)
        _, cls.llvm, compiler = base.toolchain()
        engine_recipe = geometry.recipe_id(engine.inputs())
        engine_root = base.BUILD / "engine" / engine_recipe
        source, _ = geometry.prepare_source(engine_root, create=False, patch_steps=engine.PATCH_STEPS)
        cls.resources = engine.source_resources(source)
        cls.inputs = adapter.inputs()
        recipe = adapter.recipe_id(cls.inputs, engine_recipe)
        cls.identity = adapter.identity_for(arguments.abi, engine_recipe, engine_root / arguments.abi / "package",
                                            cls.inputs, recipe, compiler)
        cls.original = base.BUILD / "adapter" / recipe / arguments.abi / "package"

    @classmethod
    def tearDownClass(cls):
        if adapter.inputs() != cls.inputs:
            raise RuntimeError("Adapter inputs changed during package checks")

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="orcaxr-adapter-package-test-")
        self.addCleanup(self.scratch.cleanup)
        self.package = Path(self.scratch.name) / "package"
        shutil.copytree(self.original, self.package)

    def verify(self):
        return adapter.verify_package(self.package, self.identity, arguments.abi, self.llvm, self.resources)

    def manifest(self):
        return json.loads((self.package / "manifest.json").read_text())

    def write_manifest(self, value):
        (self.package / "manifest.json").write_text(json.dumps(value))

    def test_real_package_verifies_as_an_unqualified_application_route(self):
        result = self.verify()
        self.assertTrue(result["applicationRoute"])
        self.assertFalse(result["slicingQualified"])
        self.assertEqual(adapter.EXPORTS, adapter.exported(self.package / adapter.LIBRARY, self.llvm))

    def test_library_byte_drift_is_rejected(self):
        with (self.package / adapter.LIBRARY).open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(RuntimeError, "package drift"):
            self.verify()

    def test_missing_runtime_and_extra_file_are_rejected(self):
        library = self.package / "libtbb.so"
        renamed = library.with_name("unexpected.so")
        library.rename(renamed)
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()
        shutil.copy2(renamed, library)
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()

    def test_unresolved_runtime_is_rejected_even_with_matching_hash(self):
        path = self.package / adapter.LIBRARY
        before = path.read_bytes()
        after = before.replace(b"libtbb.so\0", b"libbad.so\0")
        self.assertNotEqual(before, after)
        path.write_bytes(after)
        manifest = self.manifest()
        manifest["files"][path.name] = base.verify_elf(path, arguments.abi, self.llvm)
        self.write_manifest(manifest)
        with self.assertRaisesRegex(RuntimeError, "unresolved runtime dependency"):
            self.verify()

    def test_symlinked_library_is_rejected(self):
        path = self.package / "libtbbmalloc.so"
        path.unlink()
        path.symlink_to(self.original / "libtbbmalloc.so")
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()

    def test_resource_drift_is_rejected_even_with_matching_manifest_hash(self):
        relative = next(iter(self.resources))
        path = self.package / "resources" / relative
        path.write_bytes(path.read_bytes() + b"\n")
        manifest = self.manifest()
        manifest["resources"][relative] = geometry.sha(path)
        self.write_manifest(manifest)
        with self.assertRaisesRegex(RuntimeError, "resource drift"):
            self.verify()

    def test_provenance_and_qualification_changes_are_rejected(self):
        original = self.manifest()
        changes = [("engineRecipe", "0" * 64), ("recipe", "0" * 64), ("enginePackageManifestSha256", "0" * 64),
                   ("engineCommit", "0" * 40), ("compiler", "unverified"), ("inputs", {}),
                   ("exports", adapter.EXPORTS + ["extra"]), ("slicingQualified", True),
                   ("applicationRoute", False), ("symbols", "unverified"), ("abi", "riscv64")]
        for key, value in changes:
            with self.subTest(field=key):
                self.write_manifest(dict(original, **{key: value}))
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    self.verify()

    def test_export_writes_only_verified_libraries_and_the_identity_manifest(self):
        if any(not (self.original.parent.parent / abi / "package/manifest.json").is_file() for abi in base.ABIS):
            self.skipTest("an export packages both ABIs; this host built one")
        target = Path(self.scratch.name) / "export"
        subprocess.run([sys.executable, HERE / "build-engine-adapter.py", "--export", target], check=True,
                       stdout=subprocess.DEVNULL)
        identity = json.loads((target / "assets/engine/manifest.json").read_text())
        self.assertEqual(set(identity["abis"]), set(base.ABIS))
        self.assertEqual(identity["adapterRecipe"], self.identity["recipe"])
        self.assertFalse(identity["slicingQualified"])
        for abi, entry in identity["abis"].items():
            libraries = target / "jniLibs" / abi
            self.assertEqual({p.name for p in libraries.iterdir()}, set(adapter.PACKAGED))
            for name, digest in entry["files"].items():
                self.assertEqual(geometry.sha(libraries / name), digest)
        self.assertNotIn(adapter.DRIVER, {p.name for p in (target / "jniLibs" / arguments.abi).iterdir()})


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
