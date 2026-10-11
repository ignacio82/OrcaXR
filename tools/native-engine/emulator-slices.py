#!/usr/bin/env python3
"""Compare canonical native fixture slices on a fresh owned x86_64 emulator.

Requires a verified build-engine.py package and a complete published-WASM
reference set. This internal CLI run does not qualify an APK or an app route.
With --adapter the same fixtures run through the application adapter's own
slicing entry point (liborcaxr_engine.so, the C function its JNI layer calls,
driven by its fixture driver) from a verified build-engine-adapter.py package.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("native_engine", HERE / "build-engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
adapter_spec = importlib.util.spec_from_file_location("engine_adapter", HERE / "build-engine-adapter.py")
adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(adapter)
base = engine.base
sha = engine.geometry.sha
SERIAL = "emulator-5588"
SDK = Path(os.environ["ANDROID_HOME"])
DIAGNOSTIC_BYTES = 64 * 1024


def metadata(path):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 4 * 1024 * 1024:
        raise RuntimeError("Expected bounded regular metadata")
    return json.loads(path.read_text())


def adb(*args, timeout=60):
    return subprocess.check_output([SDK / "platform-tools/adb", "-s", SERIAL, *map(str, args)],
                                   text=True, timeout=timeout, stderr=subprocess.DEVNULL).strip()


def capture_process(command, stdout_path, stderr_path, timeout):
    # Limit writes in the child as well as reads in the parent. In particular,
    # an unexpected engine log must not fill host storage or memory via adb.
    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE, (DIAGNOSTIC_BYTES, DIAGNOSTIC_BYTES))

    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        os.chmod(stdout_path, 0o600)
        os.chmod(stderr_path, 0o600)
        return subprocess.run(command, stdout=stdout, stderr=stderr, timeout=timeout,
                              preexec_fn=limit_output, check=False)


def engine_protocol(command, remote_log, remote_result, output, label, timeout=60):
    stdout_path = output / (label + ".stdout.txt")
    transport_path = output / (label + ".transport.txt")
    captured = capture_process([SDK / "platform-tools/adb", "-s", SERIAL, "shell",
        command + " 2> " + shlex.quote(remote_log)], stdout_path, transport_path, timeout)
    # Retain bounded engine diagnostics before parsing or raising. The VM is
    # always destroyed by the owner, so a traceback alone would lose the cause.
    capture_process([SDK / "platform-tools/adb", "-s", SERIAL, "shell",
        "head -c " + str(DIAGNOSTIC_BYTES) + " " + shlex.quote(remote_log)],
        output / (label + ".engine.txt"), output / (label + ".log-transport.txt"), 15)
    if captured.returncode != 0:
        raise RuntimeError(f"Native command failed for {label}; see private diagnostic files")
    description = adb("shell", "stat -c '%F:%s' " + shlex.quote(remote_result))
    if not re.fullmatch(r"regular file:[1-9][0-9]*", description):
        raise RuntimeError(f"Native protocol file type is invalid for {label}")
    size = int(description.rsplit(":", 1)[1])
    if size > 4096:
        raise RuntimeError(f"Native protocol file is too large for {label}")
    result_path = output / (label + ".result.json")
    transferred = capture_process([SDK / "platform-tools/adb", "-s", SERIAL, "shell",
        "head -c 4097 " + shlex.quote(remote_result)], result_path,
        output / (label + ".result-transport.txt"), 15)
    if transferred.returncode != 0 or result_path.stat().st_size != size:
        raise RuntimeError(f"Native protocol handoff failed for {label}")
    try:
        result = json.loads(result_path.read_bytes())
    except (ValueError, UnicodeError):
        raise RuntimeError(f"Native protocol is invalid for {label}; see private diagnostic files") from None
    if not isinstance(result, dict):
        raise RuntimeError(f"Native protocol is not an object for {label}")
    return result


def checked_references(fixtures_path, reference_path):
    subprocess.run(["node", HERE / "slice-reference.mjs", fixtures_path, "--check-inputs"], check=True)
    fixtures = metadata(fixtures_path)
    reference = metadata(reference_path)
    canonical = metadata(ROOT / "wasm/artifact-provenance.json")
    if (reference.get("schemaVersion") != 1
        or reference.get("evidenceKind") != "published-wasm-fixture-reference-only"
        or reference.get("nativeSlicingQualified") is not False
        or reference.get("fixtureManifestSha256") != sha(fixtures_path)
        or reference.get("runnerSha256") != sha(HERE / "slice-reference.mjs")
        or reference.get("oracleSha256") != sha(ROOT / "tools/parity-oracles/gcode.mjs")
        or reference.get("engineArtifacts") != canonical["outputs"]
        or [item["id"] for item in reference["fixtures"]] != [item["id"] for item in fixtures["fixtures"]]):
        raise RuntimeError("Reference set identity mismatch")
    for item in reference["fixtures"]:
        if not re.fullmatch(r"[a-z][a-z-]+", item["id"]) or item["path"] != item["id"] + ".gcode":
            raise RuntimeError("Unexpected reference path")
        path = reference_path.parent / item["path"]
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != item["bytes"]
            or not 0 < item["bytes"] <= 128 * 1024 * 1024 or sha(path) != item["sha256"]):
            raise RuntimeError("Reference output drift")
    return fixtures, reference


def stop_owned_emulator(process, graceful_timeout=30, kill_timeout=15):
    # The emulator has its own process group. Also address descendants if its
    # launcher exited first; never use a device-wide kill or a shared AVD.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=graceful_timeout)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=kill_timeout)
    deadline = time.monotonic() + kill_timeout
    while time.monotonic() < deadline:
        live = False
        for directory in Path("/proc").iterdir():
            if not directory.name.isdecimal():
                continue
            try:
                fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
                live |= int(fields[2]) == process.pid and fields[0] != "Z"
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        if not live:
            return
        time.sleep(0.1)
    raise RuntimeError("Owned emulator descendants did not stop")


def checked_result(result, through_adapter):
    """The completion document: the probe's, or the adapter's own result with its digest."""
    if through_adapter:
        if (set(result) != {"schemaVersion", "outcome", "stage", "objects", "gcodeBytes", "gcodeSha256", "rejectedOverrides"}
            or result["schemaVersion"] != 1 or result["outcome"] != "completed" or result["stage"] != "output"
            or type(result["objects"]) is not int or result["objects"] != 1 or result["rejectedOverrides"] != 0
            or type(result["gcodeBytes"]) is not int or not 0 < result["gcodeBytes"] <= 128 * 1024 * 1024
            or not re.fullmatch(r"[0-9a-f]{64}", result["gcodeSha256"])):
            raise RuntimeError("Native adapter completion protocol mismatch")
        return
    if (set(result) != {"schemaVersion", "completed", "objects", "gcodeBytes"}
        or type(result["schemaVersion"]) is not int or result["schemaVersion"] != 1
        or result["completed"] is not True or type(result["objects"]) is not int or result["objects"] != 1
        or type(result["gcodeBytes"]) is not int or not 0 < result["gcodeBytes"] <= 128 * 1024 * 1024):
        raise RuntimeError("Native fixture completion protocol mismatch")


def run_slices(package, package_manifest, fixtures_path, fixtures, reference_path, output, executable):
    remote = "/data/local/tmp/orcaxr-slices-" + uuid.uuid4().hex
    adb("shell", "mkdir", "-p", remote + "/resources/info", remote + "/jobs")
    for name, identity in package_manifest["files"].items():
        adb("push", package / name, remote + "/" + name)
        if adb("shell", "sha256sum", remote + "/" + name).split()[0] != identity["sha256"]:
            raise RuntimeError("Device engine copy identity mismatch")
    for name, digest in package_manifest["resources"].items():
        adb("push", package / "resources" / name, remote + "/resources/" + name)
        if adb("shell", "sha256sum", remote + "/resources/" + name).split()[0] != digest:
            raise RuntimeError("Device resource copy identity mismatch")
    adb("shell", "chmod", "700", remote + "/" + executable)
    default_result = remote + "/defaults.json"
    default_command = " ".join(shlex.quote(value) for value in ["env", "LD_LIBRARY_PATH=" + remote,
        remote + "/" + executable, "--check-defaults", default_result])
    defaults = engine_protocol(default_command, remote + "/defaults.log", default_result, output, "defaults")
    if (set(defaults) != {"schemaVersion", "defaultsChecked", "patterns"}
        or type(defaults["schemaVersion"]) is not int or defaults["schemaVersion"] != 1
        or defaults["defaultsChecked"] is not True
        or defaults["patterns"] != [0, 90, 165, 255]
        or any(type(value) is not int for value in defaults["patterns"])):
        raise RuntimeError("Native engine initialization check failed")
    observations = []
    for fixture in fixtures["fixtures"]:
        identifier = fixture["id"]
        job = remote + "/jobs/" + identifier
        adb("shell", "mkdir", job)
        for kind, destination in [("archive", "input.3mf"), ("overrides", "overrides.json")]:
            entry = fixture[kind]
            adb("push", fixtures_path.parent / entry["path"], job + "/" + destination)
            if adb("shell", "sha256sum", job + "/" + destination).split()[0] != entry["sha256"]:
                raise RuntimeError("Device fixture copy identity mismatch")
        command = " ".join(shlex.quote(value) for value in ["env", "LD_LIBRARY_PATH=" + remote,
            remote + "/" + executable, job + "/input.3mf", job + "/overrides.json",
            remote + "/resources", job + "/output.gcode", job + "/result.json"])
        started = time.monotonic()
        # Any timeout/failure tears down this entire owned VM before returning.
        # Remote engine output never becomes a public result merely on creation.
        result = engine_protocol(command, job + "/progress.jsonl", job + "/result.json", output, identifier, timeout=240)
        checked_result(result, executable == adapter.DRIVER)
        elapsed = (time.monotonic() - started) * 1000
        remote_path = job + "/output.gcode"
        mode = adb("shell", "stat", "-c", "%F", remote_path)
        size = int(adb("shell", "stat", "-c", "%s", remote_path))
        if mode != "regular file" or size != result["gcodeBytes"]:
            raise RuntimeError("Native output type or length mismatch")
        digest = adb("shell", "sha256sum", remote_path).split()[0]
        if executable == adapter.DRIVER and digest != result["gcodeSha256"]:
            raise RuntimeError("Native adapter reported a different G-code digest")
        local = output / (identifier + ".gcode")
        adb("pull", remote_path, local)
        if local.is_symlink() or not local.is_file() or local.stat().st_size != size or sha(local) != digest:
            raise RuntimeError("Native output handoff mismatch")
        comparison = output / (identifier + ".comparison.txt")
        with comparison.open("w") as log:
            compared = subprocess.run(["node", ROOT / "tools/parity-oracles/compare-gcode.mjs",
                reference_path.parent / (identifier + ".gcode"), local], stdout=log, stderr=subprocess.STDOUT,
                timeout=60)
        if compared.returncode != 0:
            raise RuntimeError(f"Native/reference semantics differ for fixture {identifier}; see private comparison evidence")
        observations.append({"id": identifier, "path": local.name, "sha256": digest, "bytes": size,
            "elapsedMs": elapsed, "result": result, "semanticParity": True,
            "comparisonSha256": sha(comparison)})
        print(f"Native fixture parity passed: {identifier}", flush=True)
    return defaults, observations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--adapter", action="store_true", help="slice through the application adapter's entry point")
    args = parser.parse_args()
    fixtures_path, reference_path = args.fixtures.resolve(), args.reference.resolve()
    if SERIAL in subprocess.check_output([SDK / "platform-tools/adb", "devices"], text=True):
        raise RuntimeError("Owned emulator port already in use; refusing to reuse it")
    fixtures, reference = checked_references(fixtures_path, reference_path)
    recorded_paths = [fixtures_path, reference_path, Path(__file__),
        ROOT / "tools/parity-oracles/gcode.mjs", ROOT / "tools/parity-oracles/compare-gcode.mjs"]
    recorded_hashes = {path: sha(path) for path in recorded_paths}
    with (base.BUILD / ".dependency-build.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        subprocess.run([sys.executable, HERE / "build-engine.py", "--abi", "x86_64", "--verify-only"], check=True)
        recipe = engine.geometry.recipe_id(engine.inputs())
        package = base.BUILD / "engine" / recipe / "x86_64/package"
        executable = "orcaxr_slice_probe"
        if args.adapter:
            subprocess.run([sys.executable, HERE / "build-engine-adapter.py", "--abi", "x86_64", "--verify-only"], check=True)
            package = base.BUILD / "adapter" / adapter.recipe_id(adapter.inputs(), recipe) / "x86_64/package"
            executable = adapter.DRIVER
        package_manifest = metadata(package / "manifest.json")
        run_id = uuid.uuid4().hex
        output = HERE / "results" / ("slices-" + run_id)
        output.mkdir(parents=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="orcaxr-slice-avd-") as avd:
            env = dict(os.environ, ANDROID_AVD_HOME=avd)
            subprocess.run([SDK / "cmdline-tools/latest/bin/avdmanager", "create", "avd", "--name", "orcaxr_slice_probe",
                "--package", "system-images;android-34;google_apis;x86_64", "--device", "pixel_2"],
                input="no\n", text=True, env=env, check=True)
            with (output / "emulator.log").open("w") as log:
                process = subprocess.Popen([SDK / "emulator/emulator", "-avd", "orcaxr_slice_probe", "-port", "5588",
                    "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect",
                    "-cores", "2", "-memory", "2560", "-feature", "-Vulkan"], env=env,
                    start_new_session=True, stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 300
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise RuntimeError("Owned emulator exited before boot")
                        try:
                            if adb("shell", "getprop", "sys.boot_completed", timeout=15) == "1":
                                break
                        except subprocess.SubprocessError:
                            pass
                        time.sleep(2)
                    else:
                        raise RuntimeError("Owned emulator did not boot within the diagnostic limit")
                    if adb("shell", "getprop", "ro.product.cpu.abi") != "x86_64":
                        raise RuntimeError("Wrong emulator ABI")
                    defaults, observations = run_slices(package, package_manifest, fixtures_path, fixtures, reference_path,
                                                        output, executable)
                    report = {"schemaVersion": 1, "evidenceKind": "x86_64-emulator-native-fixture-parity-only",
                        "engineCommit": base.PIN, "packageManifestSha256": sha(package / "manifest.json"),
                        "fixtureManifestSha256": sha(fixtures_path), "referenceManifestSha256": sha(reference_path),
                        "referenceEngineIdentity": reference["engineIdentity"], "runnerSha256": sha(Path(__file__)),
                        "oracleSha256": sha(ROOT / "tools/parity-oracles/gcode.mjs"),
                        "comparisonRunnerSha256": sha(ROOT / "tools/parity-oracles/compare-gcode.mjs"),
                        "api": adb("shell", "getprop", "ro.build.version.sdk"), "abi": "x86_64",
                        "pageSize": int(adb("shell", "getconf", "PAGESIZE")),
                        "initializationCheck": defaults, "observations": observations,
                        "emulatorFixtureParity": True, "nativeSlicingQualified": False,
                        "applicationRoute": False, "adapterEntryPoint": args.adapter,
                        "arm64RuntimeQualified": False}
                finally:
                    stop_owned_emulator(process)
        # Publish evidence only after the owned VM and all its jobs are stopped.
        if any(sha(path) != digest for path, digest in recorded_hashes.items()):
            raise RuntimeError("Fixture comparison inputs changed during execution")
        checked_references(fixtures_path, reference_path)
        if (adapter.inputs() if args.adapter else engine.inputs()) != package_manifest["inputs"]:
            raise RuntimeError("Native engine recipe changed during fixture comparison")
        (output / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"Verified native fixture comparison: {output}", flush=True)


if __name__ == "__main__":
    main()
