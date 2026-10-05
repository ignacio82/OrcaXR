#!/usr/bin/env python3
"""Exercise fixture-engine publication guards using an actual verified package."""
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
spec = importlib.util.spec_from_file_location("fixture_engine", HERE / "build-engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--abi", choices=engine.base.ABIS, default="x86_64")
arguments = parser.parse_args()


class EnginePackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lock = (engine.base.BUILD / ".dependency-build.lock").open("a+b")
        cls.addClassCleanup(cls.lock.close)
        fcntl.flock(cls.lock, fcntl.LOCK_SH)
        subprocess.run([sys.executable, HERE / "build-engine.py", "--abi", arguments.abi,
                        "--verify-only"], check=True)
        _, cls.llvm, _ = engine.base.toolchain()
        cls.inputs = engine.inputs()
        cls.recipe = engine.geometry.recipe_id(cls.inputs)
        root = engine.base.BUILD / "engine" / cls.recipe
        source, _ = engine.geometry.prepare_source(root, create=False, patch_steps=engine.PATCH_STEPS)
        cls.resources = engine.source_resources(source)
        cls.original = root / arguments.abi / "package"
        manifest = json.loads((cls.original / "manifest.json").read_text())
        cls.identity = {key: value for key, value in manifest.items() if key not in {"files", "resources"}}

    @classmethod
    def tearDownClass(cls):
        if engine.inputs() != cls.inputs:
            raise RuntimeError("Engine inputs changed during package checks")

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="orcaxr-engine-package-test-")
        self.addCleanup(self.scratch.cleanup)
        self.package = Path(self.scratch.name) / "package"
        shutil.copytree(self.original, self.package)

    def verify(self):
        return engine.verify_package(self.package, self.identity, arguments.abi, self.llvm, self.resources)

    def manifest(self):
        return json.loads((self.package / "manifest.json").read_text())

    def write_manifest(self, value):
        (self.package / "manifest.json").write_text(json.dumps(value))

    def test_real_package_verifies_without_claiming_slicing(self):
        result = self.verify()
        self.assertTrue(result["engineBuilt"])
        self.assertFalse(result["slicingQualified"])
        self.assertFalse(result["applicationRoute"])

    def test_resource_drift_is_rejected_even_with_matching_manifest_hash(self):
        relative = next(iter(self.resources))
        path = self.package / "resources" / relative
        path.write_bytes(path.read_bytes() + b"\n")
        manifest = self.manifest()
        manifest["resources"][relative] = engine.geometry.sha(path)
        self.write_manifest(manifest)
        with self.assertRaisesRegex(RuntimeError, "resource drift"):
            self.verify()

    def test_identical_resource_symlink_is_rejected(self):
        relative = next(iter(self.resources))
        path = self.package / "resources" / relative
        path.unlink()
        path.symlink_to(self.original / "resources" / relative)
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()

    def test_missing_runtime_and_extra_file_are_rejected(self):
        library = self.package / "libtbbmalloc.so"
        renamed = library.with_name("unexpected.so")
        library.rename(renamed)
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()
        shutil.copy2(renamed, library)
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            self.verify()

    def test_executable_byte_drift_is_rejected(self):
        path = self.package / "orcaxr_slice_probe"
        with path.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(RuntimeError, "package drift"):
            self.verify()

    def test_unresolved_runtime_is_rejected_even_with_matching_elf_hash(self):
        path = self.package / "orcaxr_slice_probe"
        before = path.read_bytes()
        after = before.replace(b"libtbb.so\0", b"libbad.so\0")
        self.assertNotEqual(before, after)
        path.write_bytes(after)
        manifest = self.manifest()
        manifest["files"][path.name] = engine.base.verify_elf(path, arguments.abi, self.llvm)
        self.assertIn("libbad.so", manifest["files"][path.name]["needed"])
        self.write_manifest(manifest)
        with self.assertRaisesRegex(RuntimeError, "missing runtime dependency"):
            self.verify()

    def test_provenance_and_qualification_changes_are_rejected(self):
        original = self.manifest()
        changes = [("sourceTree", "0" * 40), ("recipe", "0" * 64),
            ("dependencyManifestSha256", "0" * 64), ("compiler", "unverified"),
            ("inputs", {}), ("patches", list(reversed(original["patches"]))),
            ("slicingQualified", True), ("applicationRoute", True),
            ("executableSymbols", "unverified")]
        for key, value in changes:
            with self.subTest(field=key):
                self.write_manifest(dict(original, **{key: value}))
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    self.verify()


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
