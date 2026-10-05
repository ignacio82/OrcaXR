#!/usr/bin/env python3
"""Check source and static-library guards with a real engine tree and NDK object."""
import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("geometry_build", HERE / "build-geometry-deps.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class GeometryInputsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="orcaxr-geometry-inputs-")
        cls.directory = Path(cls.scratch.name)
        cls.source, cls.tree = build.prepare_source(cls.directory)
        _, cls.llvm, _ = build.base.toolchain()
        fixture = cls.directory / "fixture.cpp"
        fixture.write_text('extern "C" int geometry_fixture() { return 42; }\n')
        cls.object = cls.directory / "fixture.o"
        subprocess.run([cls.llvm / "clang++", "--target=aarch64-linux-android31", "-c", fixture,
                        "-o", cls.object], check=True)
        cls.archive = cls.directory / "fixture.a"
        subprocess.run([cls.llvm / "llvm-ar", "rcs", cls.archive, cls.object], check=True)

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["git", "-C", cls.source, "worktree", "remove", "--force", cls.source], check=True)
        cls.scratch.cleanup()

    def test_exact_source_and_real_ndk_archive(self):
        self.assertEqual(build.prepare_source(self.directory, create=False)[1], self.tree)
        self.assertEqual(build.archive_objects(self.archive, "arm64-v8a"), 1)

    def test_unstaged_and_staged_source_changes_are_rejected(self):
        path = self.source / "deps/deps-android.cmake"
        original = path.read_bytes()
        try:
            path.write_bytes(original + b"\n# changed recipe\n")
            with self.assertRaises(subprocess.CalledProcessError):
                build.prepare_source(self.directory, create=False)
            subprocess.run(["git", "-C", self.source, "add", path], check=True)
            with self.assertRaisesRegex(RuntimeError, "source drift"):
                build.prepare_source(self.directory, create=False)
        finally:
            path.write_bytes(original)
            subprocess.run(["git", "-C", self.source, "add", path], check=True)

    def test_untracked_source_is_rejected(self):
        path = self.source / "deps/unexpected-source.cpp"
        try:
            path.write_text("unexpected source\n")
            with self.assertRaisesRegex(RuntimeError, "source drift"):
                build.prepare_source(self.directory, create=False)
        finally:
            path.unlink(missing_ok=True)

    def test_wrong_abi_and_mixed_archive_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Non-target object"):
            build.archive_objects(self.archive, "x86_64")
        altered = self.directory / "alien.o"
        data = bytearray(self.object.read_bytes())
        struct.pack_into("<H", data, 18, 62)
        altered.write_bytes(data)
        mixed = self.directory / "mixed.a"
        shutil.copy2(self.archive, mixed)
        subprocess.run([self.llvm / "llvm-ar", "r", mixed, altered], check=True)
        with self.assertRaisesRegex(RuntimeError, "Non-target object"):
            build.archive_objects(mixed, "arm64-v8a")

    def test_truncated_archive_is_rejected(self):
        broken = self.directory / "truncated.a"
        broken.write_bytes(self.archive.read_bytes()[:-8])
        with self.assertRaisesRegex(RuntimeError, "bounds"):
            build.archive_objects(broken, "arm64-v8a")

    def test_install_symlink_cannot_escape_prefix(self):
        prefix = self.directory / "install"
        prefix.mkdir()
        (prefix / "foreign.a").symlink_to(self.archive)
        with self.assertRaisesRegex(RuntimeError, "symlink escapes"):
            build.inspect_install(prefix, "arm64-v8a", self.llvm)


if __name__ == "__main__":
    unittest.main()
