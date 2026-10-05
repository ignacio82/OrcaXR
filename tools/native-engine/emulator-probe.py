#!/usr/bin/env python3
"""Execute verified x86_64 dependency probes on a fresh owned emulator only."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("engine_build", HERE / "build-dependency-probes.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
SDK = Path(os.environ["ANDROID_HOME"])
SERIAL = "emulator-5586"
OUTPUT = HERE / "results"


def adb(*args, timeout=60):
    return subprocess.check_output(["adb", "-s", SERIAL, *map(str, args)], text=True, timeout=timeout).strip()


def main():
    if SERIAL in subprocess.check_output(["adb", "devices"], text=True):
        raise RuntimeError("Owned emulator port already in use; refusing to reuse it")
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "dependency-probe.json").unlink(missing_ok=True)
    with (build.BUILD / ".dependency-build.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        _, llvm, _ = build.toolchain()
        source_inputs = build.inputs()
        directory = build.BUILD / "recipes" / build.fingerprint(source_inputs)
        manifest = build.verify_package(directory, "x86_64", source_inputs, llvm)
        package = directory / "x86_64/package"
        with tempfile.TemporaryDirectory(prefix="orcaxr-engine-avd-") as avd:
            env = dict(os.environ, ANDROID_AVD_HOME=avd)
            subprocess.run([SDK / "cmdline-tools/latest/bin/avdmanager", "create", "avd", "--name", "orcaxr_engine_probe",
                "--package", "system-images;android-34;google_apis;x86_64", "--device", "pixel_2"],
                input="no\n", text=True, env=env, check=True)
            with (OUTPUT / "emulator.log").open("w") as log:
                process = subprocess.Popen([SDK / "emulator/emulator", "-avd", "orcaxr_engine_probe", "-port", "5586",
                    "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect",
                    "-cores", "2", "-memory", "1536", "-feature", "-Vulkan"], env=env, stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 300
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise RuntimeError("Owned emulator exited before boot")
                        try:
                            ready = subprocess.run(["adb", "-s", SERIAL, "shell", "getprop", "sys.boot_completed"],
                                capture_output=True, text=True, timeout=15)
                            if ready.returncode == 0 and ready.stdout.strip() == "1":
                                break
                        except subprocess.TimeoutExpired:
                            pass  # Reobserve this process; a probe timeout is not process exit.
                        time.sleep(2)
                    else:
                        raise RuntimeError("Owned emulator did not boot within the diagnostic limit")
                    if adb("shell", "getprop", "ro.product.cpu.abi") != "x86_64":
                        raise RuntimeError("Wrong emulator ABI")
                    remote = "/data/local/tmp/orcaxr-engine-probe-" + uuid.uuid4().hex
                    adb("shell", "mkdir", remote)
                    for name, identity in manifest["files"].items():
                        adb("push", package / name, remote + "/" + name)
                        digest = adb("shell", "sha256sum", remote + "/" + name).split()[0]
                        if digest != identity["sha256"]:
                            raise RuntimeError("Device copy identity mismatch")
                    adb("shell", "chmod", "700", remote + "/orcaxr_tbb_probe")
                    observations = []
                    for _ in range(3):
                        started = time.monotonic()
                        output = adb("shell", "env", "LD_LIBRARY_PATH=" + remote, remote + "/orcaxr_tbb_probe", timeout=180)
                        result = json.loads(output)
                        expected = {"schemaVersion": 1, "passed": True, "tbbInterface": 12050,
                            "pageSize": int(adb("shell", "getconf", "PAGESIZE")), "allocationRounds": 16,
                            "allocationsPerRound": 512, "alignedCases": 20, "parallelItems": 1000003, "slicingQualified": False}
                        if result != expected:
                            raise RuntimeError("Native dependency probe result mismatch")
                        observations.append({"result": result, "elapsedMs": (time.monotonic() - started) * 1000})
                    report = {"evidenceKind": "x86_64-emulator-dependency-probe-only",
                        "engineCommit": build.PIN, "recipe": manifest["recipe"],
                        "packageManifestSha256": build.sha(package / "manifest.json"),
                        "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                        "api": adb("shell", "getprop", "ro.build.version.sdk"), "abi": "x86_64",
                        "observations": observations, "slicingQualified": False, "arm64RuntimeQualified": False}
                    (OUTPUT / "dependency-probe.json").write_text(json.dumps(report, indent=2) + "\n")
                    print(json.dumps(report, indent=2), flush=True)
                except Exception:
                    try:
                        diagnostics = adb("logcat", "-d", "-t", "1000", timeout=15)
                    except subprocess.SubprocessError as error:
                        diagnostics = f"Logcat unavailable: {type(error).__name__}\n"
                    (OUTPUT / "failure-logcat.txt").write_text(diagnostics)
                    raise
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            process.kill(); process.wait(timeout=15)


if __name__ == "__main__":
    main()
