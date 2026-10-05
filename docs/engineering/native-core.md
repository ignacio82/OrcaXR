# Native Android and shared-core development

This document records Stage A and the initial Phase 3 computation port of the
[migration plan](../android-native-rust-plan.md). The production web project and
current C++ engine remain authoritative. The Android application is a development
shell: it checks the JNI handshake and explicitly reports that editing is not
available. Debug builds additionally expose a flat viewport experiment with
synthetic fixtures. No native project, slicing service, printer operation, or XR
workflow is implemented yet.

The shared G-code parser, index, bounded windows, and owned binary transport now
run through both host bindings. Production browser preview now uses the Rust
adapter. The debug viewport consumes a synthetic G-code projection through JNI;
native document import and production preview remain unimplemented.
Preview projection, bounded inspection and playback are also exposed through
source-owned session queries. The browser renderer consumes the checked model,
projection and inspection packets through its existing worker session interface.
Playback remains a binding API without a new production playback workflow.
Native renderer integration and device qualification remain open.

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
this application build; do not substitute the historical engine script. The
separate [current-engine dependency probes](slicing.md#native-android-dependency-feasibility)
now provide a clean TBB build and x86_64 runtime checks. The separate full-engine
port passes clean builds for both ABIs, ELF/dependency verification and seven
package mutation tests per ABI. Its final x86_64 package passes actual constructor
checks and eleven comparisons against published-WASM archive outputs. These
fixture artifacts do not provide an application slicing route or ARM64 runtime
qualification.
The [canonical reference corpus](native-slice-fixtures.md) provides eleven
published-WASM archive outputs and input guard checks for that comparison.
Application capture/preflight and production native slicing remain unimplemented.

## Flat renderer experiment

The debug launcher opens a separate Compose/SurfaceView workbench. Release builds
exclude its Activity, renderer dependencies and compiled materials. Opening the
normal shell never initializes Filament. The workbench uses generated fixtures
only; selecting/painting modifies display projections, with no canonical project,
file import, network, slicer or XR session.

`renderer-api` owns immutable indexed geometry, packing, transform conversion,
picking and toolpath projection. `renderer-filament` is the first flat candidate,
not a final flat/spatial renderer selection. Filament **1.77.1** is the published
Maven runtime used here, with its exact Linux `matc` from the
[matching release](https://github.com/google/filament/releases/tag/v1.77.1).
The Maven AAR agrees with that release's SHA-256
`575134fe58edd4a01b03d9f48cce07f6ddb54322d8db1ceba7184b4e36cbd932`.
GitHub 1.77.2 existed when selected, but its Maven POM returned 404; do not mix a
newer compiler with this runtime. The dependency adds annotation 1.10.0 and Kotlin
stdlib 2.4.0; Gradle verifies their exact metadata/artifacts too.

Two offline unlit materials provide facet colors, world-height clipping and
transparency. The build checks runtime version, compiler/archive/script identity,
compiler arguments, sources and generated output hashes. Regenerate with
`python3 tools/renderer/build-materials.py`, optionally passing `--matc` for an
already downloaded compiler with the required hash. Normal builds verify tracked
outputs without downloading the compiler. These materials do not yet establish
production lighting, normals, color-management or transparent-sort fidelity.
Clipping must use `getUserWorldPosition()`: Filament's `getWorldPosition()` is
an internal world frame, not the API-level coordinates used by CPU picking.
Using it initially left pixels visible after the CPU correctly rejected hits.
The [pinned material API](https://github.com/google/filament/blob/v1.77.1/docs/Materials.md.html)
documents this distinction.

The one basis conversion is millimetres `(x,y,z)` to metres `(x,z,-y)/1000`, with
positive determinant. Affine transforms use the conjugated basis; inverse rays
preserve their world-distance parameter through nonuniform and mirrored scale.
Normal conversion uses the inverse transpose. Picking uses a cancellable median
BVH with original facet ordinals; its sorted index never changes geometry.
Ray-aligned edge tests follow the shared-edge approach described in
[PBRT's intersection discussion](https://pbr-book.org/4ed/Shapes/Triangle_Meshes#IntersectionTests),
with conservative Double slab exits. A plain barycentric test missed the exact
shared center vertex on the emulator despite passing the initial JVM fixture.
Clipping filters intersections in world coordinates, including transformed copies.

The grid has 128 or 1,000 cells per side (32,768 or 2,000,000 facets). Indexed
positions, indices and facet colors remain immutable. The renderer expands at
most **16,384 facets per chunk**, yielding separate position/color/index buffers
and stable original-facet ranges. Mesh upload costs 60 bytes per facet, including
indices. A two-million-facet mesh therefore requests **120,000,000 GPU buffer
bytes** before driver overhead. This experiment intentionally measures that cost;
it does not claim native rendering inherently saves memory.

A single worker builds source/BVH and packs chunks. Admission waits for all native
copy-completion callbacks before packing another chunk, keeping mesh staging at
most **983,040 bytes**. Replacing a load cancels its generation and admits the
replacement only after the old worker and upload settle. Java buffers remain
owned until Filament's callbacks run. The CPU counter covers retained source,
BVH arrays and toolpath record IDs; it excludes object headers, temporary build
allocations, ART, driver memory and process RSS. The GPU counter estimates buffer
payloads, not measured GPU allocation. Callback completion is copy-consumption
evidence, not a displayed-frame timestamp.

Two draw instances share each chunk's vertex/index buffers. Transforms, selection,
clipping and opacity update transforms/materials without resending geometry.
Painting updates only the color bytes for at most 4,096 original facets per call;
a range can cross chunk boundaries. It affects the shared display geometry of
both instances and does not implement authored per-instance paint state.

Toolpaths consume JNI model/projection packets, copy Rust's Float32 RGBA colors
exactly and retain original semantic record IDs. Arc path kinds are **0 (direct),
2 (G2), 3 (G3)**. Every sidecar edge and final arc edge retains its one source ID,
including a zero-length final edge. An omitted whole-source `recordOffset` means
zero; explicit window offsets remain authoritative. Path bounds, dense offsets,
finite positions/colors and increasing selection indices are checked before
packing. Kotlin also validates generated metadata, model/index relations and
view references to the captured model. Renderer packing requires the same capture
identity, even when another capture has identical geometry. The workbench uses
generated typed requests; production integration remains required. It never accepts
untrusted documents.

Only visible, dirty viewports request frames. The Activity closes the renderer
and cancels its JNI fixture owner on pause, and constructs a fresh owner on
resume/recreation. Surface detachment flushes swap-chain destruction before
Android releases the Surface. Close destroys owned entities, buffers, materials,
views and the engine; generation checks reject late worker/copy callbacks. The
current experiment deliberately rebuilds fixtures on resume. It has no dirty
project state to recover. True device/driver context loss and production project
restoration still need dedicated qualification.

The separate [SceneCore candidate](#scenecore-candidate) uses this same packed
mesh fixture. The flat app still has no XR dependency or session initialization.
Spatial runtime measurements, real-device traces, continuous paint/input,
Home/Full Space transitions and the application slicing route remain open.

Run the experiment checks after the foundation builds:

```sh
./android/gradlew -p android :app:assembleDebug :app:assembleDebugAndroidTest \
  :app:assembleRelease :core-bridge:assembleDebugAndroidTest \
  :renderer-api:testDebugUnitTest :app:lintDebug \
  :xr-experiment:assembleDebug :xr-experiment:assembleDebugAndroidTest \
  :renderer-scenecore:testDebugUnitTest :renderer-scenecore:lintDebug :xr-experiment:lintDebug \
  --dependency-verification strict --no-daemon --console=plain
python3 tools/cross-platform/verify-artifacts.py --apk android/app/build/outputs/apk/debug/app-debug.apk
python3 tools/cross-platform/verify-artifacts.py --apk android/app/build/outputs/apk/release/app-release-unsigned.apk
python3 tools/cross-platform/verify-artifacts.py --apk android/xr-experiment/build/outputs/apk/debug/xr-experiment-debug.apk
python3 tools/renderer/emulator-smoke.py
```

The final command owns a fresh API 34 x86_64 emulator on port 5582 and refuses an
occupied port. It first verifies non-XR startup/recreation of the separate
SceneCore experiment, then runs the existing real JNI corpus and three cold starts,
then actual PixelCopy assertions, a Rust toolpath fixture, bounded paint uploads,
picking/clipping, hidden-frame suspension, cancellation, recreation and repeated
large-mesh teardown. Machine-specific reports stay ignored under
`tools/renderer/results/`. Frame CPU submission time, buffer counters and observed
load durations are diagnostic observations, not frame-pacing or device budgets.

### Emulator evidence on 2026-10-05

Six JVM geometry tests pass, including 854 oblique shared-vertex rays, independent
grid-cell facet expectations, basis/winding/normal checks and mirrored/nonuniform
transforms. All ten existing real JNI tests and three normal-shell cold starts
pass on the owned API 34 x86_64, two-core SwiftShader emulator (4 KB pages).
Three additional app instrumentation tests pass in 70.907 seconds. They check
real SurfaceView pixels, the cross-chunk 4,096-facet paint update (49,152 bytes,
two buffer uploads), original facet picking, complete clipping to background,
shared-instance/transparency changes without geometry uploads, hidden-frame
suspension, cancellation, Activity recreation, pause/resume and repeated teardown.
The JNI toolpath test preserves Float32 colors, arc source IDs and buffer validity
after native close, and refuses a segment-budget overflow.

The final two large-fixture observations were:

| Observation | First open | Second open |
| --- | ---: | ---: |
| Facets | 2,000,000 | 2,000,000 |
| Load through readiness and pixel capture | 28,941.41 ms | 27,835.74 ms |
| Retained mesh/BVH/toolpath-ID array bytes | 57,267,352 | 57,267,352 |
| GPU buffer payload estimate, including 125 line segments | 120,008,000 bytes | 120,008,000 bytes |
| Peak pending upload bytes | 983,040 | 983,040 |
| Submitted frames over this viewport lifetime | 297 | 290 |
| Maximum observed frame CPU submission | 34.14 ms | 19.24 ms |

These are two observations on a busy shared host with a software GPU, including
source generation, BVH construction and progressive uploads. They are not a
statistical benchmark, total-memory accounting, GPU frame times or target-device
acceptance. The successful app APK SHA-256 is
`1a9a6eb2cafa3b5bcc2e02809a0448cf3cbbebfc92d1340280693af65399c8ab`;
test APK SHA-256 is
`9835c55cc3a73e093efef5dc37224d683e84bf2e758a559268859129b7704f09`.
The ignored report binds these APKs and emulator settings to the observations.

Strict Gradle verification, debug/release builds, lint and all six JVM tests pass.
Only the pre-existing newer-version lint warnings remain. The debug APK's six
native libraries and release APK's four pass both-ABI ELF/ZIP 16 KB alignment;
this remains packaging evidence, not 16 KB-device loading. Release contains no
Filament library or material asset. Cargo audit, all three npm development audits
and the configured redacted 1,582-file UTF-8 source scan pass. CI now runs the renderer suite
with the foundation checks; a clean hosted-runner result is still unverified.

The first emulator attempts exposed two corrected consumer mistakes: arc path
kinds were treated as a contiguous 0–2 range, and clipping used Filament's internal
world frame. Shared-vertex picking also needed the ray-aligned edge test described
above. The large fixture test now selects through the Activity's own intent so a
pause/resume preserves its requested size. No assertion, resource ceiling or test
timeout was relaxed to obtain the passing run.
The combined candidate/flat rerun first timed out during instrumentation while
the host showed severe CPU, memory and I/O pressure; ADB diagnostics also timed
out. After the owned emulator exited and builds finished, the fresh retry passed
all suites with unchanged limits. The runner now clears stale reports before a
run and preserves the original failure if log capture fails.

## SceneCore candidate

`android/renderer-scenecore` and the separate `dev.orcaxr.xrexperiment`
application pin **SceneCore/runtime 1.0.0-rc01**. They are development experiments,
not a release feature or a renderer selection. The regular Android app has no
SceneCore dependency. The experiment initially opens a Compose control panel in
Home Space and requests Full Space only through its explicit control. It checks
`android.software.xr.api.spatial` before calling `Session.create`; ordinary
Android must never fall through to the SDK's ARCore session path. Session
creation uses the public named `context` overload on an I/O dispatcher. Passing
an Activity positionally selects a library-restricted overload in rc01; lint
must remain enabled rather than suppressing that diagnostic.

The following constraints come from the exact Google Maven rc01 source jars
and actual SDK validators, not examples for a different SDK version:

| Requirement | rc01 public API and candidate behavior |
| --- | --- |
| Mesh and colors | Two vertex buffers: FLOAT3 positions and normalized UBYTE4 RGBA, plus UINT32 indices; directly consumes `MeshPacking` without GLB serialization |
| Update paint | `MeshBuffer.create` copies input and exposes no update method; `CustomMesh` and the mesh attached to a `MeshEntity` are immutable. The candidate replaces affected chunks and their entities |
| Paint sample cost | The fixed 4,096-facet projection spans two 16,384-facet chunks: 1,966,080 payload bytes replaced. The flat candidate's color-only update is 49,152 bytes. This 40× ratio is a payload calculation, not measured transfer traffic or latency |
| Instancing | Two entities share each chunk's mesh/buffer. The second is translated and uniformly scaled; disabled second entities still occupy runtime resources |
| Transforms | Public entity scale is nonnegative and uniform. The Vector3 nonuniform overload is restricted. Mirrors/nonuniform transforms are not implemented; skinning or geometry alternatives need separate investigation |
| Selection and transparency | Material tint and OPAQUE/BLEND switching are implemented for the fixture; spatial visual correctness remains unverified |
| Clipping and toolpaths | Not implemented. Public custom-mesh topologies are TRIANGLES/TRIANGLE_STRIP, and COLOR rejects FLOAT3/FLOAT4. The adapter must preserve projected toolpath float colors and semantic IDs; silent quantization or independent role classification is not an acceptable workaround |
| Disposal | Public resource `close()` exists, but `Entity.dispose()` is restricted/deprecated. Detach entities and release references; zero application counters do not prove immediate runtime/GPU reclamation |

The source fixture is the same 32,768- or 2,000,000-facet synthetic grid used by
the flat workbench, with the same positive-determinant millimetre/basis conversion.
Uploads use at most 16,384 facets/983,040 payload bytes per call. Packing runs off
the UI thread; synchronous SceneCore creation runs on the main thread, with a
yield between chunks. Generation jobs cancel on replacement, pause, capability
loss and destruction; the Activity constructs a new viewport on resume or regain
of 3D capability. The fixed sample paint changes only packed colors. It does not
edit a canonical model, alter source topology, implement an input stroke, or
provide picking. Close detaches entities and explicitly closes owned meshes,
buffers and materials; Session lifetime remains owned by the Activity/SDK.

Metrics distinguish source-array bytes, live requested buffer payload, largest
individual upload chunk, cumulative bytes/calls, paint replacement bytes and
maximum synchronous submission duration. They omit allocation headers, packing
and cancellation overlap, GC retention, SDK copies, hidden entity/subspace cost,
driver memory and process RSS. In the inspected SDK, each MeshEntity creates a
split-engine subspace: 123 mesh chunks can allocate 246 entity/subspace pairs even
with the second instance disabled. These counters are not GPU draw calls. Spatial
performance, memory reclamation, shared-buffer close semantics and panel/space
lifecycles still require runtime evidence.

Local evidence on 2026-10-05:

- Strict dependency verification builds the candidate app and instrumentation.
  Four JVM tests execute actual SDK layout/region validation, confirm rejection of
  float vertex colors, and verify the two-chunk paint range without mutating
  positions, indices or source colors. Both candidate lint tasks pass.
- The non-XR API 34 x86_64 emulator test launches and recreates the Activity three
  times. It checks zero session attempts, no viewport/uploads, and no loaded XR,
  Impress or ARCore native libraries in the process mappings. This is startup
  isolation evidence only; it does not execute a SceneCore renderer. The test
  passed in 6.719 seconds.
  Verified candidate APK SHA-256: `4409761d35e7eb0843026dc9eb2d56ce71202ed40338bf06d86b7f996ee265e1`;
  instrumentation APK: `16d316b8c6eb8a79a6f420a46352a459abf9fcbc971f64fab2392aa6858ea0d4`.
- All 14 packaged native libraries across arm64-v8a and x86_64 pass ELF/ZIP
  16 KB alignment and core identity verification. All 71 added dependency
  artifact hashes were re-fetched from official Google Maven/Maven Central and
  matched; existing verification hashes were unchanged. The transitive graph
  includes Impress 1.0.0-beta03, ARCore 1.56.0 and Media3 1.10.0.
- XR Preview API v4 image revision 3, API 34 x86_64, was installed for a diagnostic
  on this Linux host (emulator 37.1.11, two cores, 4 GiB, SwiftShader). The emulator
  reported unsupported Vulkan shader stages and hanging QEMU threads; ADB probes
  timed out and the owned emulator process exited before a verified boot. No APK
  was installed or spatial measurement taken. Official XR emulator requirements
  list macOS/Windows; this diagnostic is not a supported-host qualification.

Run only the non-XR candidate check after building its two APKs with
`python3 tools/renderer/emulator-smoke.py --scenecore-only`. The default smoke
command additionally runs the existing JNI, shell and flat-renderer suites.
Reports remain ignored under `tools/renderer/results/`; CI publishes those reports
and both candidate build/lint/test reports. Hosted CI has not been claimed run by
these local checks. No app was installed on the physical XR device, and no
physical XR journey was exercised.

The spatial comparison and Phase 2 exit remain open. Next evidence must include
actual same-fixture pixels, input/picking, clipping, toolpath fidelity, transform
alternatives, repeated Home/Full Space and Activity lifetimes, frame pacing and
memory. Compare a separate custom OpenXR/panel integration prototype if public
SceneCore paths cannot satisfy these requirements; do not prematurely make this
candidate the production spatial renderer.

References: [SceneCore release notes](https://developer.android.com/jetpack/androidx/releases/xr-scenecore),
[custom meshes](https://developer.android.com/reference/androidx/xr/scenecore/MeshBuffer),
[XR manifest configuration](https://developer.android.com/develop/xr/jetpack-xr-sdk/build-immersive),
[XR emulator requirements](https://developer.android.com/develop/xr/jetpack-xr-sdk/run/create-avds/xr-headsets-glasses).

## Contracts and scope

The browser now has a transitional `AsyncEditorSession` over its TypeScript
authority. Undo/Redo actions await acknowledgements; guarded queued execution,
bounded callback-free batches and ordered summary queries are available for
incremental migration. Project, asset and history guards prevent stale work from
silently applying to a newer edit. This is an in-process facade using trusted
command objects and an opaque owner token, not a generated project protocol or
a Rust project implementation. The remaining action/import/save/slice migration
and full command bindings remain Phase 1/4 work. The maintained details live in
[project contracts](project-contracts.md).

The migration inventory binds action source files to an existing Git commit.
Commit an action-source change before regenerating it with `inventory.mjs --write`.
The inventory JSON is also an input to shared-core provenance, so refresh the
WASM/JNI build manifests and packaged browser asset set through their normal
build tools afterward. Byte-identical executables still need manifests that bind
the updated input. The asynchronous history update preserves all 226 action
records and native capability states; rebuilt WASM/glue and both JNI binaries
are byte-identical, and the existing debug/release APKs verify against them.

`contracts/core-protocol.json` owns the initial **stateless canonicalization
request**. The generator emits Rust request deserialization/validation, TypeScript
types/validation, and Kotlin request types/validation. Regeneration must be clean.
Its Rust decoder explicitly requires a map: deriving Serde struct deserialization
also accepted positional arrays even though the schema and host validators require
objects. All four named fields must occur exactly once; unknown fields are rejected.
Protocol versions retain numeric value semantics, including `1.0` and `1e0`.
This envelope rule is separate from the inner JSON input's last-key-wins semantics.
It is a deliberately limited schema subset; unsupported schema constructs must
fail generation. The full project session, command/result/error and cancellation
schemas in Phase 1/4 remain to be implemented. The G-code packet layouts below are
generated. `contracts/gcode-requests.json` now owns six source/view request types
and all three operation envelopes. It generates Rust types/object decoders,
TypeScript types/guards/field catalogs, and Kotlin types/encoders/shape tables.
`contracts/gcode-metadata.json` generates 26 bounded metadata validators for
TypeScript and Kotlin, plus TypeScript types. Browser request encoders also
validate shapes and enforce bounds before entering WASM. Kotlin binds decoded
views to the explicit source/window capture and validates their model relations.
The host adapters retain their platform-specific input conversion and bounded
serialization; Rust computation owns semantic mode/mask/range checks and their
existing error codes. This leaf contract is not the full project command protocol.

Optional nullable transport fields match Rust `Option`; omitted boolean, list
and source-limit defaults come from the schema. Unsigned integer fields use
integer JSON tokens, and both host encoders emit their exact nonnegative values.
Raw unsigned duration bits and UTF-16 text arrays preserve NaN/Infinity
and lone surrogates. Kotlin uses `Long` for UInt32 fields. Generated Rust object
visitors reject positional arrays, unknown fields and duplicate keys, including
duplicates whose first value is null. Source options now decode directly into
those types instead of first passing through a duplicate-collapsing JSON value.
Duplicate keys within the canonicalization request's inner input retain their
existing last-key-wins semantics; its outer envelope rejects duplicates.

Kotlin's typed source/view overloads encode bounded ASCII JSON before JNI. Raw
JSON overloads use the same generated structural guards before source/window
binding. Options retain the 64 KiB ceiling; views retain 8 MiB. Kotlin and browser
shape traversal have a 4,194,304-node budget; Kotlin also polls cancellation.
The writer charges bytes before appending, including escaping and numeric digits,
and checks array counts before traversing their elements.

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
or a cooperative cancellation API. The production worker now uses the same source
owner; its loading and offline packaging are described below.

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
Production native renderer consumers, search, and
device latency/memory budgets remain open.

The internal Rust projection implements all 12 display modes, composable
role/tool/event/layer/record/value filters, numeric ranges, accessible legends,
and explicit unsupported results for absent filament colors, unspecified role
colors, and missing authoritative layer times. It preserves local column indices
for rendering and validates source-record ranges against the window's offset.
Each output owns its arrays; no mutable view into source columns escapes. Count
and cap validation precede exact-sized output allocations. Cancellation checks
cover validation, path points, prefix-height scanning, missing-metadata scans,
and output passes; cancelled work publishes no projection.

`contracts/gcode-preview.json` generates the Rust palette and mode catalog and
the Kotlin mode definitions used to check projection metadata. The
production TypeScript implementation remains the independent behavioral oracle.
Its tests and deterministic parser inputs generate `preview-vectors.json`, with
Float32 columns stored as raw bits and source-derived text as UTF-16 units.
The corpus includes extreme finite Float32 layer times: platform libc `exp` changed
an accessible legend label by one binary64 ULP. The pinned pure-Rust `libm`
implementation resolves that observed difference in debug and optimized host
tests. The source-owned binding corpus also includes those 128 extreme cases.
This is corpus evidence, not proof for every float, browser engine or physical
device; physical consumer qualification has its own remaining gates.

## Source-owned view queries

`Session.view` / WASM `GcodeSession.view` / Kotlin `GcodeSession.view` accept bounded
JSON with required `version: 1`, `operation`, `window` and `request` fields. `window`
is `[]` for the bounded whole-source parse or `[firstEntry, lastEntry]` for an
inclusive index-entry range. It is never implicit, nullable or a substitute source.
Requests over 8 MiB UTF-8, malformed/unknown fields, invalid selectors and unknown
versions are refused. JNI checks Java string length before copying, then Rust
checks UTF-8 bytes. Raw wasm-bindgen glue copies strings before entering Rust;
the browser source owner's encoder enforces the byte bound before that copy.

Kotlin uses `session.view(model, request)`: the model must come from that session
and the exact whole/window selector in the request. The host validates this
association and the expected operation kind before accepting the native result.
Different entries can share a record offset, so offsets/counts cannot replace
the selector identity.
It does not capture a second model implicitly. A view retains only an opaque
capture token, not the model buffers or session; `belongsTo(model)` remains valid
after close. The renderer requires this token before packing any geometry.
Foreign captures, selector mismatches and rejected computation requests leave
the session usable; malformed output closes it.

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
Both hosts check headers, complete buffers, zero alignment padding, column bounds,
strict UTF-8 and generated metadata. Kotlin additionally validates model kinds,
tool/filament/role references, source spans, coordinates, dense arc ranges and
arc extrusion semantics. Index metadata binds the source length; pages bind the
declared counts and neighboring entry ranges. Public metadata access returns a
snapshot, so caller mutation cannot change the validated packet or index bounds.
Kotlin view checks bind preview local indices, inspection/playback original IDs,
layer endpoints, cursor ordinals/positions/source spans, selected ranges, tool
markers, event ticks and bounded source context to the captured model. Preview
mode definitions, ranges, unique legend IDs, missing-metadata indices and finite
color/value columns are checked too. Playback permits repeated/reversed IDs for
wrap/direction behavior while requiring every frame to be inspectable and within
the captured window. These checks match the browser boundary's relational rules;
they do not recompute the projection or inspection algorithms.

Android metadata uses strict `JsonReader` parsing before calling any typed
`JSONObject` getter, which otherwise permits numeric/string coercion. Parsing
rejects duplicate keys, trailing input, non-finite numbers, raw control characters
and nesting beyond 16 levels. Parsing and generated shape validation each have
the schema's 4,194,304-node ceiling; fields retain their own smaller bounds.
UTF-16 source-text arrays preserve lone surrogates and reject coerced values.
Long JSON, generated-validator, model/arc and view loops check session cancellation
every 4,096 characters, nodes or records/points. Constructor checks use the
current handle and retain no callback in the completed packet; closing an owner
can stop host validation as well as Rust work.
See the platform [JsonReader](https://developer.android.com/reference/android/util/JsonReader)
and [JSONObject](https://developer.android.com/reference/org/json/JSONObject)
contracts. These checks do not change the separate canonical JSON operation's
intentional duplicate-key semantics.

Local Android boundary evidence on 2026-10-05: **21 JNI instrumentation tests**
pass on the owned API 34 x86_64 emulator, including the existing parser/window
corpus and 4,554 view requests with captured-model validation. Seven boundary tests
mutate actual native packets and exercise coercion/null/missing/unknown fields,
malformed JSON, dense paths,
padding, immutable metadata snapshots, index continuity, traversal limits and
cooperative cancellation. They also reject foreign/mismatched captures and
malformed view relations, exercise nonzero-offset windows for all three view kinds,
and verify valid work after refusals and buffer survival after close.
Three shell cold starts, three renderer pixel/lifecycle tests and the separate
non-XR startup test also pass. Renderer checks reject a projection paired with a
different capture of identical geometry. Debug/release builds,
strict dependency verification, JVM tests and lint pass; the actual APKs retain
both-ABI 16 KB ELF/ZIP alignment. The unchanged TypeScript decoder still passes
its 456-model/window boundary corpus and the published browser-core set verifies.
All three full npm audits and Cargo audit pass; the configured redacted scan
covers 1,627 UTF-8 source files, including six normalized for embedded NULs, with
no findings. These runs do not establish ARM64 execution, 16 KB runtime loading,
production native workflows or physical-device performance.

The request contract adds 30 independently authored shape/result cases, checked
by generated host guards, debug/release Rust sessions, real browser WASM and
Android JNI. They cover defaults/nullability, malformed object/array shapes,
unknown fields, source substitution, UInt32 overflow, UTF-16 units and preserved
semantic error codes. Additional tests reject duplicate keys, detached/shared
typed inputs and property getters; Kotlin exercises typed requests for all three
view kinds, UInt32/UTF-16 round trips, byte/node bounds and cancellation. The
browser replay also verifies valid work after refusals. The generated definitions
regenerate cleanly; eight mutation checks reject unsupported schema definitions
before generation. Rust clippy passes, and the refreshed browser asset set is
`84e14d0306ba` (560,666 WASM bytes). These are transport/correctness results, not
physical-device performance qualification.
The complete `scripts/quality.sh` gate passes for this change, including web
quality/browser/offline checks, server integration/deployment checks, published
slicer regressions and the three development-dependency audits. Regenerated
parity reports remain unchanged and preserve the outstanding human gates.

## Browser host boundary

`GcodePackets` accepts complete, fixed ordinary ArrayBuffers with exact packet
lengths, zero alignment padding, bounded counts and strict UTF-8 metadata. It
rejects shared, resizable, detached and oversized backing buffers. Its generated
metadata guards reject unknown fields and enforce finite numbers, integer/text
bounds, and a validation-node budget. Additional checks bind indices, source
spans, layer selections, cursor/tool-marker positions, ticks and visible records
to the decoded model. Projection indices remain local; inspection/playback IDs
remain original source IDs. Typed columns share the single owned packet buffer.
String reconstruction preserves individual UTF-16 code units.

Source-window `endOffset` includes a trailing CR in CRLF input, while its displayed
`text` omits that CR. At the 4,096-unit limit this distinction also affects the
truncation flag. Do not validate display length as exact raw-span length.
Context scanning also stops before the delimiter immediately preceding the
cursor's line. When that delimiter is at offset zero, clamping a backward search
to zero rediscovers it and can produce negative line numbers. Both TypeScript and
Rust now move to the first blank line in that case; the shared corpus includes
leading LF, repeated LF and CRLF inputs.

`CoreGcodeSource` takes an already initialized binding and is intended for a
disposable task worker. It sends chunks of at most 65,536 UTF-16 units, validates
and freezes index metadata, and checks consecutive pages, declared page lengths,
and complete-source coverage. The host refuses index counts above the parser's
64 MiB accounting budget divided by its minimum 256-byte checkpoint charge, plus
the initial entry. This is a corruption bound, not a measured JS heap budget.
It retains no JS source string or model columns. Each opened frame binds view
queries to an immutable selector and source; callers own its decoded buffers.
Transferring a frame invalidates further queries against that frame. Reopening
gets fresh host bytes while Rust may reuse its one cached parsed model.

Initialization failure releases the native owner. Host disposal is idempotent,
and subsequent work, including an in-progress page iterator, refuses a closed
owner. Raw wasm-bindgen `.free()` is **not** idempotent; the host clears its handle
before calling it. Synchronous work is cancelled by the containing worker's
termination, not a main-thread callback into a busy WASM call. The production
worker connects this owner to its existing 120-second deadline, replacement,
coalescing, cancellation and disposal lifecycle.

Host encoders accept the existing typed preview/inspection API, reject unknown
fields and substitute source/checkpoint options, and preserve Float32 duration
bits and UTF-16 provenance/colors. They write bounded ASCII JSON directly, charging
each byte before appending it, rather than materializing an unbounded typed-array
copy and then checking its size. Parser options have a 64 KiB bound; view requests
have an 8 MiB bound. Shared/resizable/detached typed inputs are refused. The
adapter consumes generated field catalogs and validates the converted request
against the shared schema before serialization. Rust owns semantic computation
checks. Kotlin encoders and types are generated from the same definitions; full
project command contracts remain a separate Phase 1/4 requirement.

## Production browser adapter and packaging

The default preview adapter is Rust. `?previewCore=typescript` selects the
independent reference when the worker host module first loads. The choice remains
fixed for that module lifetime; changing it requires a guarded reload. A failed
Rust request never silently changes adapters. Protocol version 2 binds replies to
the chosen adapter. Canonical project state, artifact summary authority, UI and
renderer behavior remain in their existing TypeScript owners. The legacy explicit
`project(overrides)` synchronous API still uses the reference function; production
surfaces consume the worker's cached default projection.

Both adapters use the same window/view controller. Rust retains source/index and
one parsed window, copies an owned packet to JS, computes its views, and transfers
the packet and view buffers. It then drops the host frame; re-opening the same
selector copies fresh host bytes while reusing Rust's cached model. The main
receiver checks each column's exact range in the one bounded packet before using
the existing semantic snapshot checks. It does not relax per-column backing
limits for reference output. This is bounded ownership, not zero-copy transport.

`node tools/cross-platform/package-browser-core.mjs --write` packages the output
of `build-wasm.py`. Normal `web` dev/build commands verify current source hashes,
exact glue/declaration hashes, manifest and WASM without requiring Rust. The
tracked `core/browser` glue and `web/public/core/<manifest-sha256>` asset pair
are one set. The loader bounds decoded response bytes, verifies both SHA-256
identities, initializes only verified bytes, then checks the core handshake.
Compressed Content-Length describes transfer bytes, so stream length and digest
remain authoritative. It works without WebCrypto subtle or cross-origin isolation.
Missing/corrupt assets fail visibly; reopening explicitly retries. Worker
termination cancels loading as well as synchronous computation.

The preview worker is an additional entry in the main Rollup graph. Sharing pure
parser/projection modules avoids duplicating the reference implementation beyond
the JS budget. Worker imports are static: Vite's application dynamic-import
preload helper accesses `document` and cannot run there. Strict entry signatures
keep application startup out of the worker. The generated preview inventory
contains its host, worker and complete dependency graph plus the exact asset pair.
Both service workers cache these bytes without instantiation. Workbox excludes
`core/**` from its glob because explicit SHA-256 entries already own those URLs.
Static-host updates wait for the existing unsaved-work guard's `SKIP_WAITING`.

Vite warns about wasm-bindgen's unused default sibling WASM URL. The loader always
passes verified bytes; the exact generated glue stays unchanged for provenance.
No separate default-path binary is served or fetched. Docker's web-builder copies
the same core/contracts/tooling inputs and verifies this packaged set.

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
node tools/cross-platform/canonical-requests.mjs
node tools/cross-platform/generate-gcode-layout.mjs
node tools/cross-platform/generate-preview-catalog.mjs
node tools/cross-platform/generate-view-layout.mjs
node tools/cross-platform/generate-gcode-metadata.mjs
node tools/cross-platform/generate-gcode-requests.mjs
node tools/cross-platform/test-request-generator.mjs
node tools/cross-platform/package-browser-core.mjs
node web/scripts/run-tests.mjs gcode-packets.test.ts core-gcode-source.test.ts gcode-requests.test.ts rust-gcode-loading.test.ts
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
cargo test -p orcaxr-gcode --test preview --test inspection --test views --test session --test requests --release --locked --jobs 2
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

The canonical request correction on 2026-10-05 adds **48 raw envelope cases**.
The positional-array case failed against the old generated decoder before the
fix. Host Rust debug/release, actual browser WASM, and Android x86_64 JNI now agree
on named-field decoding, missing/null/duplicate/unknown fields, escaped names,
numeric version values, malformed roots and sanitized failures. An accepted
request after all refusals verifies continued operation. Arrays and duplicate
keys inside the inner input still canonicalize with the existing semantics.
The browser rerun also passes all 269 canonical/hash vectors, 10 invalid inputs,
98 G-code traces, 358 windows, 4,554 view queries and 30 G-code request cases.
The refreshed browser set is `4d8246c8187f` with 558,264 WASM bytes. Both JNI ABIs
were rebuilt; debug/release APKs pass source identity and 16 KB ELF/ZIP alignment.
The owned API 34 x86_64 run passes all 21 JNI tests, three shell cold starts,
three renderer pixel/lifecycle tests and the separate non-XR startup test.
Two two-million-facet loads retain the 983,040-byte staging peak and the existing
120,008,000-byte GPU-buffer estimate. These software-emulator observations do not
qualify physical-device performance or ARM64 execution.
The complete `scripts/quality.sh` gate passes with this packaged browser set,
including production browser/offline/recovery checks, server integration and
HTTP/HTTPS deployment, published-engine slicing regressions and all three full
npm audits. Rust format, strict Clippy, debug/release tests and Cargo audit pass;
the core workflow passes actionlint. The configured redacted source
scan covers 1,637 UTF-8 files, including six normalized for embedded NULs, with
no findings. Optional container image builds were not run for this boundary change.

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

The parser now backs the production browser preview with verified packaging and
a startup reference rollback. Stage B and the Phase 3 exit gate remain open for
search, production native renderer integration and device
measurements.

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

Host inspection verification covers 1,181 reference cases over 456 models,
including source windows, lone surrogates, layer/move ranges, original record IDs,
event ticks, cursor/marker/focus bounds, stepping, playback and explicit errors.
Resource cases verify the 100,000-tick cap before allocating tick strings, the
101-line/4,096-unit source limits, cancellation during a 16 Mi-unit source scan,
and refusal of corrupted playback ordinals. Packing 100,000 pause events stays
under 4 MiB with one interned label; the associated 100,000-frame playback remains
bounded. Column packing also settles cancellation with a five-second watchdog;
that watchdog is not a UI latency target.

An additional independent corpus constructs 4,554 view queries over 103 immutable
sources, including whole/window switches, ten rejections, all 12 preview modes,
128 extreme logarithmic-duration cases, inspection/source context and playback.
All cases agree on host Rust, actual browser WASM and Android x86_64 JNI. Successful
browser results total 4,654,356 packet bytes. A transferred view packet remains
valid after Rust session disposal and worker termination. Android checks rejected
requests followed by valid work, buffer survival, malformed headers/UTF-8, and
clearing a pending packet when a subsequent prepare fails. No test injects model
columns into the production binding API.

The new browser packet decoder additionally agrees with all 456 whole/window
models and all 4,554 real-WASM view cases. The source owner replays those same
4,554 requests over 103 sources, including ten refusals. Actual-WASM mutation
tests reject 26 corrupted view packets, in addition to unit-tested malformed
model/header/text/column cases. Source-owner tests cover pre-copy request bounds,
split/isolated surrogates, Float32 NaN/Infinity bits, failed initialization,
short pages and repeated disposal. Every source replay transfers a model, refuses
queries against its detached frame, reopens a fresh frame, and rejects work after
disposal. Those corpus checks exercise the host boundary. The production worker
also has separate two-adapter browser tests; native rendering remains untested.

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
pass. Full web quality passes after the production browser integration, including 258
unit-test files, production browser/recovery/offline checks,
accessibility, pseudo-localization, slicing and bundle budgets. The existing
TypeScript preview benchmark records a 1.594 indexed/whole median ratio against
its 2.5 ceiling; this does not measure the Rust projection. All three npm audits
report zero vulnerabilities. The configured redacted secret scan covers 1,556
UTF-8 source files, including six with embedded NULs, with no findings.

Production Chromium replays the same 300,002-record source through both adapters
and checks identical initial view state, bounded DOM/XR paging, empty-filter
recovery, replacement, pending-navigation cancellation and disposal. The final
gate observed 550.69 ms for Rust and 979.70 ms for TypeScript, including initial
source conversion, indexing, parsing, host transfer and presentation. Those are
single synthetic-host observations, not device acceptance measurements. The
final JS entry is 2,264,048 bytes and all JS totals 10,574,850 bytes under unchanged
limits. The current shared Rust WASM adds 560,666 bytes outside that JS budget.

Loader tests cover bounded/compressed responses, strict handshake, missing and
corrupt pairs, no silent fallback, fetch cancellation, explicit retry, and idle
startup. First-preview offline tests pass for the PWA and static `/slicer/` host;
static updates exercise Cancel and Discard through the real unsaved-work guard.
Vite development preview, the Docker web-builder, all 56 server tests and actual
Express HTTP/HTTPS browser qualification also pass, including Rust preview of
external slice output on insecure LAN. Canonical and both present local server
engine copies now verify against the pinned manifest; old ignored local copies
were retained when refreshed. This does not qualify a new native engine build.

One initial full run timed out waiting for persistence-test startup readiness;
the focused retry and complete repeated gate passed without extending timeouts.
Failure diagnostics now include the boot feature state for a recurrence.
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
