#!/usr/bin/env python3
"""Mutate real reference captures and exercise owned-process cleanup on Linux."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("slice_runner", HERE / "emulator-slices.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("fixtures", type=Path)
parser.add_argument("reference", type=Path)
arguments = parser.parse_args()


class SliceRunnerTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="orcaxr-slice-runner-test-")
        self.directory = Path(self.scratch.name)
        self.fixtures = arguments.fixtures.resolve()
        self.reference = self.directory / "manifest.json"
        shutil.copy2(arguments.reference, self.reference)
        self.manifest = json.loads(self.reference.read_text())
        for item in self.manifest["fixtures"]:
            shutil.copy2(arguments.reference.parent / item["path"], self.directory / item["path"])

    def tearDown(self):
        self.scratch.cleanup()

    def local_shell_sdk(self):
        sdk = self.directory / "sdk"
        executable = sdk / "platform-tools/adb"
        executable.parent.mkdir(parents=True)
        executable.write_text("#!/usr/bin/env python3\nimport os,sys\nos.execvp('sh',['sh','-c',sys.argv[4]])\n")
        executable.chmod(0o700)
        return sdk

    def test_real_reference_acceptance(self):
        fixtures, reference = runner.checked_references(self.fixtures, self.reference)
        self.assertEqual(len(fixtures["fixtures"]), 11)
        self.assertEqual(len(reference["fixtures"]), 11)

    def test_reference_identity_drift_is_rejected(self):
        for key in ["fixtureManifestSha256", "runnerSha256", "oracleSha256"]:
            with self.subTest(key=key):
                changed = dict(self.manifest, **{key: "0" * 64})
                self.reference.write_text(json.dumps(changed))
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    runner.checked_references(self.fixtures, self.reference)

    def test_reference_engine_drift_is_rejected(self):
        self.manifest["engineArtifacts"]["slic3r.wasm"] = "0" * 64
        self.reference.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            runner.checked_references(self.fixtures, self.reference)

    def test_reference_bytes_and_symlinks_are_rejected(self):
        entry = self.manifest["fixtures"][0]
        path = self.directory / entry["path"]
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(RuntimeError, "output drift"):
            runner.checked_references(self.fixtures, self.reference)
        path.unlink()
        path.symlink_to((arguments.reference.parent / entry["path"]).resolve())
        with self.assertRaisesRegex(RuntimeError, "output drift"):
            runner.checked_references(self.fixtures, self.reference)

    def test_capture_bounds_noisy_process_output(self):
        stdout = self.directory / "stdout.txt"
        stderr = self.directory / "stderr.txt"
        result = runner.capture_process([sys.executable, "-c",
            "import os; os.write(1,b'x'*1000000); os.write(1,b'y'*1000000)"], stdout, stderr, 5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(stdout.stat().st_size, runner.DIAGNOSTIC_BYTES)
        self.assertLessEqual(stderr.stat().st_size, runner.DIAGNOSTIC_BYTES)
        self.assertEqual(stdout.stat().st_mode & 0o777, 0o600)

    def test_protocol_keeps_diagnostics_on_parse_and_exit_failures(self):
        sdk = self.local_shell_sdk()
        for label, payload, code in [("valid", '{"ok":true}', 0),
                                     ("logs", '[2026-10-05] log\\n{"ok":true}', 0),
                                     ("failure", '{"ok":true}', 1),
                                     ("array", '[]', 0)]:
            with self.subTest(label=label), patch.object(runner, "SDK", sdk):
                remote_result = str(self.directory / (label + ".remote.json"))
                program = (f"import sys,pathlib; pathlib.Path({remote_result!r}).write_text({payload!r}); "
                    f"print('startup log before main'); print('engine diagnostic',file=sys.stderr); sys.exit({code})")
                command = shlex.join([sys.executable, "-c", program])
                if label == "valid":
                    self.assertEqual(runner.engine_protocol(command, str(self.directory / "remote.log"), remote_result,
                        self.directory, label), {"ok": True})
                else:
                    with self.assertRaises(RuntimeError):
                        runner.engine_protocol(command, str(self.directory / "remote.log"), remote_result, self.directory, label)
                self.assertEqual((self.directory / (label + ".stdout.txt")).read_text(), "startup log before main\n")
                self.assertEqual((self.directory / (label + ".engine.txt")).read_text(), "engine diagnostic\n")

    def test_protocol_refuses_indirect_and_oversized_files(self):
        sdk = self.local_shell_sdk()
        target = self.directory / "target.json"
        target.write_text('{"ok":true}')
        link = self.directory / "link.json"
        link.symlink_to(target)
        oversized = self.directory / "large.json"
        oversized.write_text('{"text":"' + 'x' * 4096 + '"}')
        for label, path, error in [("symlink", link, "file type"), ("oversized", oversized, "too large")]:
            with self.subTest(label=label), patch.object(runner, "SDK", sdk):
                with self.assertRaisesRegex(RuntimeError, error):
                    runner.engine_protocol("true", str(self.directory / "remote.log"), str(path), self.directory, label)
                self.assertFalse((self.directory / (label + ".result.json")).exists())

    def test_termination_escalates_only_for_owned_group(self):
        control = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"], start_new_session=True)
        target = subprocess.Popen([sys.executable, "-c",
            "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(300)"],
            stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertEqual(target.stdout.readline().strip(), "ready")
            runner.stop_owned_emulator(target, graceful_timeout=0.2, kill_timeout=5)
            self.assertEqual(target.returncode, -signal.SIGKILL)
            self.assertIsNone(control.poll())
        finally:
            target.stdout.close()
            runner.stop_owned_emulator(target, graceful_timeout=0.2, kill_timeout=5)
            control.terminate()
            control.wait(timeout=5)

    def test_descendant_is_stopped_after_leader_exit(self):
        target = subprocess.Popen([sys.executable, "-c", """
import os,signal,time
child=os.fork()
if child:
    os._exit(0)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print(os.getpid(),flush=True)
time.sleep(300)
"""], stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            child = int(target.stdout.readline())
            target.wait(timeout=5)
            runner.stop_owned_emulator(target, graceful_timeout=0.2, kill_timeout=5)
            path = Path(f"/proc/{child}/stat")
            if path.exists():
                self.assertEqual(path.read_text().rsplit(")", 1)[1].split()[0], "Z")
        finally:
            target.stdout.close()
            runner.stop_owned_emulator(target, graceful_timeout=0.2, kill_timeout=5)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
