#!/usr/bin/env python3
"""Compile the real Kotlin/Java bridge for host JNI replay using cached build tools.
This is a JVM check, not Android assembly or instrumentation qualification.
Run the normal verified Android dependency resolution first to populate caches.
"""
from pathlib import Path
import os
import subprocess
import shutil
import hashlib
import xml.etree.ElementTree as ET
from artifacts import ROOT

cache = Path(os.environ.get("GRADLE_USER_HOME", Path.home() / ".gradle")) / "caches/modules-2/files-2.1"
verification = ET.parse(ROOT / "android/gradle/verification-metadata.xml").getroot()
ns = {"v": "https://schema.gradle.org/dependency-verification"}
def jar(group, name, version):
    values = list((cache / group / name / version).glob("*/*.jar"))
    if len(values) != 1:
        raise SystemExit(f"Resolve the Android build dependencies first: missing {name}:{version}")
    component = verification.find(f"v:components/v:component[@group='{group}'][@name='{name}'][@version='{version}']", ns)
    artifact = None if component is None else component.find(f"v:artifact[@name='{values[0].name}']", ns)
    allowed = [] if artifact is None else [v.get("value") for v in artifact.findall("v:sha256", ns)]
    if hashlib.sha256(values[0].read_bytes()).hexdigest() not in allowed:
        raise SystemExit(f"Cached tool does not match Android SHA-256 verification metadata: {name}:{version}")
    return str(values[0])

stdlib = jar("org.jetbrains.kotlin", "kotlin-stdlib", "2.4.0")
annotations = jar("org.jetbrains", "annotations", "23.0.0")
compiler = os.pathsep.join([
    jar("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.3.21"),
    jar("org.jetbrains.kotlin", "kotlin-stdlib", "2.3.21"),
    jar("org.jetbrains.kotlin", "kotlin-script-runtime", "2.3.21"),
    jar("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    jar("org.jetbrains.kotlin", "kotlin-daemon-embeddable", "2.3.21"),
    jar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    annotations,
])
sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
properties = ROOT / "android/local.properties"
if properties.exists():
    for line in properties.read_text().splitlines():
        if line.startswith("sdk.dir="):
            sdk = line.removeprefix("sdk.dir=")
if not sdk:
    raise SystemExit("Set ANDROID_HOME or android/local.properties sdk.dir")
platforms = []
for properties in (Path(sdk) / "platforms").glob("*/source.properties"):
    values = dict(line.split("=", 1) for line in properties.read_text().splitlines() if "=" in line)
    if values.get("AndroidVersion.ApiLevel") in ("37", "37.0") and values.get("AndroidVersion.ApiMinor", "0") == "0":
        platforms.append(properties.parent / "android.jar")
if len(platforms) != 1 or not platforms[0].is_file():
    raise SystemExit("Install the pinned Android 37 platform")
android = platforms[0]
output = ROOT / "tools/cross-platform/results/project-jvm"
# This directory is wholly generated. Removed/renamed Kotlin classes must not
# survive on the replay classpath and make a source-only build falsely succeed.
if output.exists():
    shutil.rmtree(output)
output.mkdir(parents=True, exist_ok=True)
main = ROOT / "android/core-bridge/src/main/java"
java = sorted(main.rglob("*.java"))
subprocess.run(["javac", "--release", "17", "-d", str(output), *map(str, java)], check=True)
subprocess.run(["java", "-cp", compiler, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
                os.pathsep.join([str(output), stdlib, annotations, str(android)]), "-d", str(output),
                *map(str, sorted(main.rglob("*.kt"))),
                *map(str, sorted((ROOT / "android/core-bridge/src/androidTest/java/dev/orcaxr/core").glob("*Checks.kt")))], check=True)
subprocess.run(["javac", "--release", "17", "-cp", os.pathsep.join([str(output), stdlib]),
                "-d", str(output), str(ROOT / "tools/cross-platform/jvm/ProjectJniHarness.java")], check=True)
(output / "classpath.txt").write_text(os.pathsep.join([str(output), stdlib]))
print("Compiled Java/Kotlin project bridge and host JNI test harness")
