#!/usr/bin/env python3
"""Mutate real built packages to exercise guards before any native execution."""
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("engine_build", HERE / "build-dependency-probes.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class DependencyPackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, cls.llvm, _ = build.toolchain()
        cls.source_inputs = build.inputs()
        cls.original = build.BUILD / "recipes" / build.fingerprint(cls.source_inputs)
        build.verify_package(cls.original, "x86_64", cls.source_inputs, cls.llvm)

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="orcaxr-package-guard-")
        self.root = Path(self.scratch.name)
        self.package = self.root / "x86_64/package"
        shutil.copytree(self.original / "x86_64/package", self.package)

    def tearDown(self):
        self.scratch.cleanup()

    def verify(self):
        return build.verify_package(self.root, "x86_64", self.source_inputs, self.llvm)

    def manifest(self):
        return json.loads((self.package / "manifest.json").read_text())

    def write_manifest(self, value):
        (self.package / "manifest.json").write_text(json.dumps(value))

    def test_real_package_verifies(self):
        self.assertEqual(len(self.verify()["files"]), 4)

    def test_wrong_machine_is_rejected(self):
        path = self.package / "orcaxr_tbb_probe"
        data = bytearray(path.read_bytes())
        struct.pack_into("<H", data, 18, 183)
        path.write_bytes(data)
        with self.assertRaisesRegex(RuntimeError, "Wrong ELF identity"):
            self.verify()

    def test_small_page_alignment_is_rejected(self):
        path = self.package / "libtbb.so"
        data = bytearray(path.read_bytes())
        header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
        for i in range(header[10]):
            at = header[5] + i * 56
            if struct.unpack_from("<I", data, at)[0] == 1:
                struct.pack_into("<Q", data, at + 48, 4096)
                break
        else:
            self.fail("Fixture has no LOAD segment")
        path.write_bytes(data)
        with self.assertRaisesRegex(RuntimeError, "not 16 KB aligned"):
            self.verify()

    def test_missing_and_extra_libraries_are_rejected(self):
        library = self.package / "libtbbmalloc.so"
        renamed = library.with_name("unexpected.so")
        library.rename(renamed)
        with self.assertRaisesRegex(RuntimeError, "Unexpected or missing"):
            self.verify()
        library.write_bytes(renamed.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "Unexpected or missing"):
            self.verify()

    def test_byte_drift_is_rejected_even_if_elf_still_parses(self):
        path = self.package / "orcaxr_tbb_probe"
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaisesRegex(RuntimeError, "package drift"):
            self.verify()

    def test_dependency_closure_is_checked_beyond_hash_agreement(self):
        path = self.package / "orcaxr_tbb_probe"
        before = path.read_bytes()
        after = before.replace(b"libtbb.so\0", b"libbad.so\0")
        self.assertNotEqual(before, after)
        path.write_bytes(after)
        identity = build.verify_elf(path, "x86_64", self.llvm)
        self.assertIn("libbad.so", identity["needed"])
        manifest = self.manifest()
        manifest["files"][path.name] = identity
        self.write_manifest(manifest)
        with self.assertRaisesRegex(RuntimeError, "dependency is missing"):
            self.verify()

    def test_metadata_and_recipe_drift_are_rejected(self):
        original = self.manifest()
        for field, replacement in [("engineCommit", "0" * 40), ("ndk", "0"),
                ("compiler", "unverified"), ("tbb", {"version": "0"}),
                ("recipe", "0" * 64), ("slicingQualified", True), ("inputs", {})]:
            with self.subTest(field=field):
                self.write_manifest(dict(original, **{field: replacement}))
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    self.verify()


if __name__ == "__main__":
    unittest.main()
