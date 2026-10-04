# Native Android and shared-core development

This document records Stage A and the initial Phase 3 computation port of the
[migration plan](../android-native-rust-plan.md). The production web project and
current C++ engine remain authoritative. The Android application is a development
shell: it checks the JNI handshake and explicitly reports that editing is not
available. No native project, renderer, slicing service, printer operation, or XR
workflow is implemented yet.

The shared G-code parser, index, bounded windows, and owned binary transport now
run through both host bindings. They are development APIs; production browser
preview still uses TypeScript, and the Android shell does not yet display G-code.
Preview projection, bounded inspection and playback are also exposed through
source-owned session queries. Neither application's renderer consumes these
development bindings yet.

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
| Preview math | `libm` 0.2.16 with default architecture features disabled; same log/exp arithmetic on every target |
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
fail generation. The full project session, command/result/error and cancellation
schemas in Phase 1/4 remain to be implemented. The G-code packet layouts below are
generated; their development leaf request validation is implemented in Rust.
Complete generated host request/result validators and production adapters remain
open.

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

## G-code computation and ownership

The Rust parser preserves modal state, semantic record IDs, source spans in UTF-16
units, one record per G2/G3 command, Float32 assignment order, and explicit
incomplete-prefix diagnostics. Its source-bound index retains checkpoints without
rich columns or interpolation arrays; windows reconstruct columns from immutable
source ownership. Checkpoint metadata retains the existing 64 MiB accounting cap.
Role names, colors, and diagnostic text use UTF-16 unit arrays in the binding
metadata, preserving lone surrogates as well as non-BMP characters. Hosts rebuild
strings explicitly. JSON numeric decoding enables `serde_json/float_roundtrip`;
default decoding rounded a reference checkpoint to the adjacent binary64 value.

`contracts/gcode-buffer.json` generates the Rust writer and TypeScript/Kotlin
layout descriptors. Version 1 packets contain a checked little-endian header,
bounded JSON metadata, and aligned typed columns. Session input arrives in at most
65,536-unit chunks with exact offsets and declared total length. Sealing binds one
immutable source/index. Index pages contain at most 256 entries and never expose
resumable machine state. The session caps rich windows at 240,000 records and
8 million path points; metadata is capped at 8 MiB and complete packets at 160 MiB.
These are hard refusal limits, **not qualified device memory budgets**. Oversized
metadata/packets return a resource error; they are not silently truncated.

Native handles are positive, never reused, and limited to four live owners,
including cancelled work still holding resources. Admission capacity is released
after the last work reference and its buffers have actually been dropped.
Close removes the handle and signals cancellation without waiting on the work
mutex. Active work retains its owner until it settles. Source scans check
cancellation every line/4,096 units and arc interpolation every 256 points;
cancelled parses publish no result. Kotlin serializes work, rejects replies after
close, and releases a pending native packet on allocation/transfer failure. Java
owns each direct output buffer; views remain valid after native close. JNI stores
no Java references and catches Rust unwinds. Browser sessions belong in disposable
task workers; ordinary transferred ArrayBuffers work without cross-origin isolation.

This transport is not zero-copy: JNI/WASM copies each source chunk into Rust, Rust
accumulates it, sealing currently copies into an immutable Arc allocation, packing
copies columns, and the final packet copies into host-owned memory. The session
retains at most one parsed window: a repeated selector reuses it, and switching
selectors releases the old columns before parsing the replacement. An explicit
selector on every view query prevents accidental use of the last loaded window.
Packed outputs are independent allocations. Metadata encoding checks cancellation
on writes; column serialization checks every 4,096 elements and before publishing.
Renderer consumers, search, full generated request/result validators, production
worker selection, offline packaging, and device latency/memory budgets remain open.

The internal Rust projection implements all 12 display modes, composable
role/tool/event/layer/record/value filters, numeric ranges, accessible legends,
and explicit unsupported results for absent filament colors, unspecified role
colors, and missing authoritative layer times. It preserves local column indices
for rendering and validates source-record ranges against the window's offset.
Each output owns its arrays; no mutable view into source columns escapes. Count
and cap validation precede exact-sized output allocations. Cancellation checks
cover validation, path points, prefix-height scanning, missing-metadata scans,
and output passes; cancelled work publishes no projection.

`contracts/gcode-preview.json` generates the Rust palette and mode catalog. The
production TypeScript implementation remains the independent behavioral oracle.
Its tests and deterministic parser inputs generate `preview-vectors.json`, with
Float32 columns stored as raw bits and source-derived text as UTF-16 units.
The corpus includes extreme finite Float32 layer times: platform libc `exp` changed
an accessible legend label by one binary64 ULP. The pinned pure-Rust `libm`
implementation resolves that observed difference in debug and optimized host
tests. The source-owned binding corpus also includes those 128 extreme cases.
This is corpus evidence, not proof for every float, browser engine or physical
device; production consumer integration has its own remaining gates.

## Development view queries

`Session.view` / WASM `GcodeSession.view` / Kotlin `GcodeSession.view` accept bounded
JSON with required `version: 1`, `operation`, `window` and `request` fields. `window`
is `[]` for the bounded whole-source parse or `[firstEntry, lastEntry]` for an
inclusive index-entry range. It is never implicit, nullable or a substitute source.
Requests over 8 MiB UTF-8, malformed/unknown fields, invalid selectors and unknown
versions are refused. JNI checks Java string length before copying, then Rust
checks UTF-8 bytes. Raw wasm-bindgen glue copies strings before entering Rust;
the future production host validator must enforce the bound before that copy.

| Operation | Request payload | Output kind |
| --- | --- | --- |
| `preview` | Mode, masks, ranges, projection cap and optional authoritative layer times | 1: projection columns and legend/diagnostic metadata |
| `inspection` | Layer/move selection, record visibility, cursor, tool-marker and source-context options | 2: record/layer/tick columns and bounded inspection metadata |
| `playback` | Inspection options plus required `playback` options (direction, wrap, includeCurrent, maxFrames) | 3: ordered original record IDs |

Inspection/playback optionally take envelope `includeSource: true`. Source context
then borrows the sealed session source during computation; requests cannot supply
`gcodeSource`. Default false avoids scanning source text for callers that do not
display it. Context is at most 50 lines before/after the cursor (101 total), with
at most 4,096 UTF-16 units per line and explicit truncation. Inspection permits
at most 100,000 event ticks; playback permits at most 100,000 frames. Neither
truncates a cap violation into a successful partial response. Layer labels use
print Z, avoiding travel-hop heights, and preserve original semantic record IDs.

Preview `layerTimes` uses `secondsByLayerBits: u32[]` and `provenance: u16[]`.
Raw bits preserve Float32 NaN/Infinity so missing authoritative durations remain
explicitly unsupported rather than becoming JSON null or zero. Preview indices
are local to the selected model's columns; inspection/playback IDs include its
original record offset. Callers must keep that distinction when rendering.

`contracts/gcode-view-buffer.json` generates all three platform descriptors for
the `OXGV` version-1 little-endian packet. Its eight-u32 header is magic, version,
kind, metadata byte length, record count, layer count, tick count and total bytes.
JSON metadata precedes four-byte-aligned typed columns, with an 8 MiB metadata
limit and 32 MiB total limit. Tick labels are interned in metadata; kind, original
record/layer IDs, Z and source spans are columns. A host reconstructs tick identity
as `kind:record`. Unsupported preview results have metadata and zero column counts.
These are refusal ceilings, not qualified application memory budgets.

Java owns direct output buffers and exposes read-only views. Kotlin serializes
prepare/copy, preserves the session after a computation rejection, and closes it
on allocation/transfer failure. Every native prepare clears any pending packet,
including when the new request fails. Close can independently cancel work; the
Kotlin owner rejects any reply that races with close. WASM outputs are copied into
host-owned Uint8Arrays and can be transferred after disposing the Rust session.
The packet checks cover headers, column bounds, UTF-8, and Android tick references;
complete generated metadata/result validation remains required for production.

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
node tools/cross-platform/generate-gcode-layout.mjs
node tools/cross-platform/generate-preview-catalog.mjs
node tools/cross-platform/generate-view-layout.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bindings-test.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/canonical-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/gcode-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/preview-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/inspection-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/view-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/inventory.mjs
```

Run these in `core/` so the pinned Rust toolchain is selected:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked --jobs 2 -- -D warnings
cargo test --workspace --locked --jobs 2
cargo test -p orcaxr-gcode --test preview --test inspection --test views --test session --release --locked --jobs 2
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

Initial G-code verification on 2026-10-04 established:

- An independently generated corpus captures the unchanged production TypeScript
  regressions plus deterministic modal, arc, UTF-16, malformed-input, and checkpoint
  cases. All 98 parse/index traces and 358 windows agree on host Rust, actual
  browser WASM, and Android x86_64 JNI. Every Float32 column is compared by bits;
  host Rust also compares the full private checkpoint state.
- Resource tests traverse all 300,002 records of one large layer with no retained
  column capacity above 240,000, check whole-arc cap failures, exercise 1,024
  deterministic malformed UTF-16/numeric inputs, and settle cooperative cancellation.
  Source upload, sealing, cancellation, range, and resource rejections are tested.
- Twelve browser reopen/index/window/close cycles over that large layer retain
  a stable 57,540,608-byte WASM linear-memory allocation. They transfer a total
  360,018,192 packet bytes within the worker. A separate packet transfer to the
  host survives session disposal. These numbers exclude JS/browser RSS and do not
  qualify physical-device performance or a total application memory ceiling.
- Eight Android instrumentation tests pass, including all parser vectors, stale
  handles, owner-capacity refusal, close during indexing, writable direct-buffer
  checks, malformed UTF-8 packet metadata, and buffer survival after native close.
  The native shell still passes three cold starts on the API 34 emulator.

The parser port does not yet replace the production web preview. Stage B and the
Phase 3 exit gate remain open until production packaging, full host validators,
search, rollback selection, renderer integration, and device measurements are
verified.

Host projection verification on 2026-10-04 establishes 1,567 reference
projections/rejections over 202 models, including all display modes, filter
combinations, exact Float32 output bits, legends and labels, malformed models,
missing-metadata diagnostics, UTF-16 provenance, nonzero window offsets, and
128 logarithmic-duration cases spanning finite Float32 exponents. Additional
tests verify cancellation settlement, cap refusals and output independence.
The 300,002-record resource test now also projects each bounded window and checks
that output capacities exactly match the selected counts. Malformed model injection
is confined to these host tests; the binding corpus below uses actual session
sources and selectors.

Host inspection verification covers 1,169 reference cases over 453 models,
including source windows, lone surrogates, layer/move ranges, original record IDs,
event ticks, cursor/marker/focus bounds, stepping, playback and explicit errors.
Resource cases verify the 100,000-tick cap before allocating tick strings, the
101-line/4,096-unit source limits, cancellation during a 16 Mi-unit source scan,
and refusal of corrupted playback ordinals. Packing 100,000 pause events stays
under 4 MiB with one interned label; the associated 100,000-frame playback remains
bounded. Column packing also settles cancellation with a five-second watchdog;
that watchdog is not a UI latency target.

An additional independent corpus constructs 4,479 view queries over 100 immutable
sources, including whole/window switches, ten rejections, all 12 preview modes,
128 extreme logarithmic-duration cases, inspection/source context and playback.
All cases agree on host Rust, actual browser WASM and Android x86_64 JNI. Successful
browser results total 4,617,792 packet bytes. A transferred view packet remains
valid after Rust session disposal and worker termination. Android checks rejected
requests followed by valid work, buffer survival, malformed headers/UTF-8, and
clearing a pending packet when a subsequent prepare fails. No test injects model
columns into the production binding API.

The current browser repeat test remains stable at 57,540,608 bytes of WASM linear
memory for parser reopen cycles; canonicalization alone settles at 12,058,624
bytes. These measurements exclude JavaScript/browser RSS, GPU storage and native
Android residency. View-specific sustained memory/latency and physical-device
qualification remain open. Debug/optimized host tests, strict Clippy, generated
artifact checks, both Android ABIs, debug/release builds and lint pass. Ten JNI
instrumentation tests and three shell cold starts pass on the API 34 x86_64
emulator; this is not ARM64 or 16 KB-page runtime evidence.

The projection compiles for WASM, Android ARM64 and Android x86_64. Debug and
optimized host reference tests, strict Clippy, regeneration checks and Cargo audit
pass. Full web quality also passes after the incomplete-prefix notice correction,
including 255 unit-test files, production browser/recovery/offline checks,
accessibility, pseudo-localization, slicing and bundle budgets. The existing
TypeScript preview benchmark records a 1.615 indexed/whole median ratio against
its 2.5 ceiling; this does not measure the Rust projection. All three npm audits
report zero vulnerabilities. The configured redacted secret scan covers 1,532
UTF-8 source files, including six with embedded NULs, with no findings.
The wave-settings gate now reconstructs the pinned source plus the tracked build
patch in a temporary directory; an older local engine checkout no longer changes
the test authority, and absent source never silently skips that check.

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
