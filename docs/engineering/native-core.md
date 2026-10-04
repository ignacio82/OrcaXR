# Native Android and shared-core development

This document records the implementation and evidence for Stage A of the
[migration plan](../android-native-rust-plan.md). The production web project and
current C++ engine remain authoritative. The Android application is a development
shell: it checks the JNI handshake and explicitly reports that editing is not
available. No native project, renderer, slicing service, printer operation, or XR
workflow is implemented yet.

## Build decisions

| Component | Current pin / decision |
| --- | --- |
| Application ID | `dev.orcaxr.nativeapp`, a separate installation |
| Historical application | `dev.orcaxr.app`; no automatic data or signing migration |
| Android SDK | Minimum 31, compile/target 37; optional touchscreen, no required XR feature |
| Build | AGP 9.2.1, Gradle 9.5.0 with distribution SHA-256 |
| Java | JDK 21; Java bytecode target 17 |
| Kotlin | AGP built-in Kotlin, Compose compiler plugin 2.3.21 |
| Compose | BOM 2026.03.01; Activity 1.13.0, Lifecycle 2.10.0 |
| NDK | 29.0.14206865; API 31 linkers; ARM64 and x86_64 |
| Rust | 1.94.1, locked dependencies; Android targets and `wasm32-unknown-unknown` |
| Browser bindings | `wasm-bindgen` / CLI 0.2.129 as one matched set |
| JNI | Direct `jni` crate 0.21.1 boundary; exact-class consumer keep rule |
| Dependency checks | Gradle SHA-256 verification metadata; Cargo lockfile and cargo-audit 0.22.2 |

Minimum SDK 31 retains the retired app's floor while keeping the new target open
to ordinary phones and large screens. Target 37 requires the planned local-network
permission work before networking is implemented. The shell declares no network,
camera, or XR permission and never initializes those services. No XR artifact
version is selected by this foundation build. Release APKs are unsigned; publishing
and key selection remain separate release work. Cloud backup and device transfer
exclude app-private storage. Intentional document export/recovery will have its
own guarded implementation.

The old application ID was verified against historical commit `7f16e6b`.
A separate ID prevents a development install from replacing a retired APK or
assuming compatibility with its stored projects. Native projects will use the
current canonical archive contract when that port is complete.

AGP 9.2.1's typed `android.sourceSets` access produced a runtime cast failure in
this build. Generated JNI directories are registered through
`androidComponents.onVariants` and `addGeneratedSourceDirectory`, which also
establish the Rust task dependency. The native engine is deliberately absent from
this build; do not substitute the historical engine script.

## Contracts and scope

`contracts/core-protocol.json` owns the initial **stateless canonicalization
request**. The generator emits Rust request deserialization/validation, TypeScript
types/validation, and Kotlin request types/validation. Regeneration must be clean.
It is a deliberately limited schema subset; unsupported schema constructs must
fail generation. The full session, command/result/error, cancellation, projection,
and direct-buffer schemas in Phase 1/4 remain to be implemented.

The core parses bounded JSON into UTF-16 strings and sorts keys by code units.
It preserves escaped lone surrogates, resolves duplicate keys like `JSON.parse`,
formats finite binary64 numbers like JavaScript, and normalizes negative zero.
Canonical bytes feed independent FNV-1a64 semantic and SHA-256 artifact digests.
Limits are 8 MiB for the request, 1 MiB for inner input, 6 MiB for canonical output,
64 levels of nesting, and 100,000 value nodes. Diagnostics do not echo model data.
The JNI bridge checks Java string length before copying and Rust then checks UTF-8
bytes. No borrowed JNI reference escapes the call. Startup computation runs off
the Android UI thread; mismatched or malformed handshakes fail closed.

The browser harness exercises the actual WASM binary in a module worker under a
CSP with `wasm-unsafe-eval` and without cross-origin isolation. The test owner
terminates a worker to cancel synchronous leaf computation and rejects pending
replies. This verifies that ownership pattern, not a production session transport
or a cooperative cancellation API. The browser application does not load the new
core yet, so production service-worker packaging is also still open.

`contracts/generated/migration-inventory.json` captures all 226 registry actions
at web commit `fc9da4e`, including handler presence, surfaces, exclusions, shortcuts,
automation identity, capability reasons, and existing evidence references.
The web registry reports 219 partial and 7 unavailable actions; those limitations
are preserved. Every native workflow remains unavailable. Source hashes include
the parity report and the existing settings/profile/localization authorities.
These assets are not yet consumed or bundled by the native shell. On web scope
changes, commit the web authority first and explicitly regenerate the inventory;
CI rejects silent inventory drift.

## Repeatable checks

Install the SDK/NDK above, set `ANDROID_HOME` (or `android/local.properties`), and
install Rust through rustup. Gradle requires JDK 21 on the host. No private keys,
profiles, models, or printer endpoints are needed.

```sh
npm --prefix web ci
rustup toolchain install 1.94.1 --profile minimal --component rustfmt --component clippy \
  --target wasm32-unknown-unknown,aarch64-linux-android,x86_64-linux-android
cargo +1.94.1 install wasm-bindgen-cli --version 0.2.129 --locked --jobs 2
cargo +1.94.1 install cargo-audit --version 0.22.2 --locked --jobs 2
node tools/cross-platform/generate-contracts.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bindings-test.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/canonical-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/inventory.mjs
```

Run these in `core/` so the pinned Rust toolchain is selected:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked --jobs 2 -- -D warnings
cargo test --workspace --locked --jobs 2
cargo audit
```

Run the platform checks from the repository root:

```sh
python3 tools/cross-platform/build-wasm.py
python3 tools/cross-platform/verify-artifacts.py --wasm
node tools/cross-platform/wasm-smoke.mjs
./android/gradlew -p android :app:assembleDebug :app:assembleRelease \
  :core-bridge:assembleDebugAndroidTest :core-bridge:testDebugUnitTest :app:lintDebug \
  --dependency-verification strict --no-daemon --console=plain
python3 tools/cross-platform/verify-artifacts.py --apk android/app/build/outputs/apk/debug/app-debug.apk
python3 tools/cross-platform/verify-artifacts.py --apk android/app/build/outputs/apk/release/app-release-unsigned.apk
python3 tools/cross-platform/emulator-smoke.py
```

The last command requires KVM and the SDK's API 34 Google APIs x86_64 image. It owns
a temporary 720×1280 AVD/process, uses two CPU cores and software GLES with Vulkan
disabled, and refuses to reuse an occupied emulator port. A larger fresh emulator
on the busy shared host encountered a System UI ANR after JNI tests passed; the
startup assertion correctly failed. This small CI display is for protocol/startup
checks, not renderer performance measurements. To test an
already-owned emulator explicitly, use `android-smoke.py --serial emulator-NNNN`.
It refuses physical-device serials. Tests install the development app and test APK,
run real JNI vectors, and check three cold starts through the UI hierarchy.

Build products and machine-specific evidence stay ignored under `core/target`,
`core/dist`, Android `build` directories, and `tools/cross-platform/results`.
Artifacts bind source hashes, compiler identity, and output hashes. The APK verifier
checks **all packaged** native libraries for ELF and ZIP 16 KB alignment, both core
ABIs, and exact equality between packaged JNI bytes and the attested build after
the NDK strip step. This is a packaging check; it is not 16 KB-device loading proof.
Source hashes attest inputs used by the tooling, not an independent clean rebuild.

Gradle verification metadata was bootstrapped from the declared Google/Maven
repositories. Normal checks run in strict mode. Metadata updates require review;
regenerating checksums is not an authenticity audit. Current lint warnings for
newer available dependency versions remain visible; there is no lint suppression
or relaxed error threshold.

## Evidence and remaining gates

Initial local verification on 2026-10-04 established:

- Rust unit/integration tests and strict Clippy pass. The independent TypeScript
  authority supplies 269 canonical/hash vectors and 10 malformed-input cases.
  Shared request-ID cases reject trailing newlines consistently in Rust,
  TypeScript, and Kotlin. Cargo audit reports no known vulnerabilities.
- Real browser WASM passes those vectors without cross-origin isolation. Forty
  repeated near-1 MiB inputs settle at 11,993,088 bytes of WASM linear memory;
  the final 20 operations show no further growth. This excludes JS/browser RSS
  and is not a device memory ceiling. Ten terminate/reopen cycles, missing assets,
  and incompatible-version handshakes pass.
- Debug and R8-shrunk unsigned release builds, Android lint, and a JVM test of
  handshake versions/resource bounds pass. Runtime JNI tests pass on an API 34
  x86_64 emulator, including malformed handshakes, oversized requests, and Unicode.
  Three non-XR cold starts succeed. This emulator has 4,096-byte pages.
- Both APK ABIs and four packaged native libraries pass ELF/ZIP 16 KB alignment
  and core-source/output identity checks.

Full development-dependency audits for web, server, and engine tooling also report
zero vulnerabilities. These foundation changes do not modify the web runtime or
replace its existing quality and release gates.

The workflow `.github/workflows/native-core.yml` repeats these checks independently
of the existing web/server/engine gates. Its first GitHub-hosted run is not yet
evidence. Physical ARM64, 16 KB runtime loading, API 37 runtime behavior, XR,
Googlebook, sustained memory/thermal measurements, all project workflows, and
supervised printer qualification remain open. No phase exit or release claim is
closed by these foundation results.

Read-only inventory of a connected Samsung SM-I610 on 2026-10-04 reports Android
14/API 34, ARM64, Adreno 740, 16,066,684 KiB reported RAM, and 4,096-byte pages.
No native app was installed or exercised on that headset for this foundation
evidence. Refresh rate, supported input methods, and native performance still
need a recorded qualification run; available RAM is not an editor memory budget.
