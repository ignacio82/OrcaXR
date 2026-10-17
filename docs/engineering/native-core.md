# Native Android and shared-core development

This document records Stage A and the shared computation/project foundations of the
[migration plan](../android-native-rust-plan.md). The production web project and
current C++ engine remain authoritative. The Android application is a development
shell: it checks the JNI handshake and explicitly reports that editing is not
available. Debug builds additionally expose a flat viewport experiment with
synthetic fixtures, reached from the launcher icon's shortcut (a long press) so that
nothing over the Workspace covers its controls. The shared Rust library now executes prepared plate, entity-name, instance-printability and
transform commands with history through a guarded string endpoint. An optional WASM binding replays
it in a Node worker, but the Android app has no native project
editing, slicing service, printer
operation or XR workflow yet.

The shared G-code parser, index, bounded windows, and owned binary transport now
run through both host bindings. Production browser preview now uses the Rust
adapter. The debug viewport consumes a synthetic G-code projection through JNI;
Android application document import and production preview remain unimplemented.
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
exclude its Activity. (When it was built, release builds left out Filament, its
dependencies and compiled materials altogether, and the shell never started it;
the Workspace and Preview have since drawn with Filament in every build — see
[Flat renderer selection](#flat-renderer-selection).) The workbench uses generated fixtures
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
transparency: a vertex colour times the draw's tint where its alpha is 1, the
vertex colour alone where it is 0 (a painted facet), moved toward a
`highlight` colour by its alpha, the transparent material premultiplying by
its opacity. The build checks runtime version, compiler/archive/script identity,
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
this remains packaging evidence, not 16 KB-device loading. Release then contained
no Filament library or material asset (it does now). Cargo audit, all three npm development audits
and the configured redacted 1,582-file UTF-8 source scan pass. CI now runs the renderer suite
with the foundation checks; a clean hosted-runner result is still unverified.

### Emulator evidence on 2026-10-08

All 41 `core-bridge` real-JNI instrumentation tests (61.3 s) and three shell
cold starts pass on a freshly owned API 34 x86_64 emulator (4 KB pages)
through `tools/cross-platform/android-smoke.py`. They include the browser's
G-code document corpus (1,562 readable-text windows, 19,035 searches), the
view corpus (4,604 views) and the project actor checks. The first run found
the Kotlin text-window check refusing a line that keeps one carriage return
(the browser drops only one before `\n`, so `\r\r\n` leaves one), and two
instrumented pins left behind when their host replays grew; all three are
fixed. Instrumented tests run only on an emulator or device, so a corpus
change needs this run too. The emulator's 7.4 GB userdata partition does not
fit a tmpfs `/tmp`; give `ANDROID_AVD_HOME` a disk-backed directory.

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

### Emulator evidence on 2026-10-09

All 48 `core-bridge` real-JNI instrumentation tests — now including
`CredentialVaultTest` over the real Android Keystore, the two
`AndroidPrinterDiscoveryTest` cases and the `MoonrakerAdvertiser` helper
(skipped without its arguments) — three shell cold starts and the Device
area smoke (`android-device-smoke.py`, against the Moonraker simulator on
the host, ending with a DNS-SD search that finds, adds and connects to it)
and the Project area smoke (`android-project-smoke.py`, through the system
document picker) pass on a freshly owned API 34 x86_64 emulator through
`emulator-smoke.py`. The host's `/tmp` is a tmpfs and its
disk was nearly full: give `TMPDIR` a disk-backed directory with at least
8 GB free before running it.

### Emulator evidence on 16 KB pages

`emulator-smoke.py --api 37 --pages 16` owns an AVD from the 16 KB
page-size Android 17 image and checks the kernel's page size before
running: all 48 instrumented tests (the shared core's JNI libraries loading
and running), three cold starts, the local-network, Device and Project
smokes pass with 16384-byte pages, so the packaged native libraries load as
well as align (`verify-artifacts.py`). The slower emulator dropped the first
keys of an API key typed before the keyboard connected; `smoke_ui.type_into`
now waits for the keyboard, types in bursts and checks what landed.

### Emulator evidence on Android 17

`emulator-smoke.py --api 37` owns a fresh API 37 (Android 17) x86_64 AVD
and runs the same suite — the 48 instrumented tests, three cold starts, the
Device and Project smokes — plus `android-local-network-smoke.py`, which
drives `ACCESS_LOCAL_NETWORK` (a runtime permission in the Nearby devices
group, denied by default) against the simulator at 10.0.2.2: the card and an
immediate refusal before it is asked, the system prompt ("Allow OrcaXR to
find, connect to, and determine the relative position of nearby devices?")
denied once and again, the card then offering the app's settings, a grant
made there read on resume and connecting, revocation refusing again, and
"Find printers" asking before it searches. Nothing reaches the simulator
while access is denied. The run found four things the API 34 runs could not:
after a second denial the card kept offering a request the system no longer
shows (the rationale flag is not Compose state, so nothing recomposed — the
card now reads "denied for good" from the answer itself); a denied
connection was reported only as `Network: handshake_server` (the workspace
now refuses up front with the reason); service discovery and registration
throw `SecurityException` without the permission, so the instrumented test
APK declares and grants it; and a UiAutomation connection opened by a test
process takes the one `uiautomator dump` needs, so the smoke grants the
advertiser's permission with `pm grant` instead. The smokes now share
`smoke_ui.py`, whose launch retries while `pm clear` still tears down the
app's task and collapses a notification shade a home-screen swipe opened.
Its search for what is off screen drags a list down to its end and back up
to its start a screen at a time, without a fling (each touch event its own
`input` command, the finger at rest before it lifts): a swipe's fling carried
rows past the screen's edge and out of every dump, and flinging back to the
start left what lay just above the screen, such as a panel's status line, to
a search down the whole list. It sweeps the list once, down and back, before
it gives up, so a step's short timeout bounds how long the app takes to show
something, not how long a slow emulator takes to search a long list. A smoke
that reads what follows a row it found (a group's rows, a row's indicators)
first lifts that row near the list's top, since the search stops at the first
screen showing it, perhaps on its last line.

## Flat renderer selection

Recorded 2026-10-12. The flat Android app (phones, tablets, Chromebooks, Android
XR's Home Space panels) draws with **Filament 1.77.1 on OpenGL ES**, through
`FilamentScene` (`android/renderer-filament`), in the Workspace and the Preview.
It is the only flat candidate: it draws production meshes, facet paint with
colour-only partial uploads and toolpaths, picks on the CPU, survives the
areas' lifecycle, and loads on 4 KB and 16 KB pages, all on the emulators'
suites; the earlier workbench measured a 2,000,000-facet fixture
([above](#emulator-evidence-on-2026-10-05)). The spatial selection is still
open (see the end of this section).

What it does, and how that compares with the browser's three.js workspace:

- **Lighting.** No lights, no indirect light, no shadows: both materials are
  unlit (`materials/opaque.mat`, `transparent.mat`, compiled by
  `tools/renderer/build-materials.py` with Filament's own `matc`). Shading is
  baked on the CPU per facet (`PacketMesh.kt`): grey = 0.35 + 0.65·max(0,
  n·L) with L = normalize(0.4, −0.55, 0.75) in printer millimetres (from the
  front right, matching the browser's DirectionalLight), multiplied with the tint and paint in sRGB bytes. The browser
  lights its surfaces per pixel (`MeshStandardMaterial`, roughness .72,
  metalness .04) with a hemisphere light (`0xbbbbbb`/`0x888888`, 3) and a
  directional light (white, 2) from the front right. Chosen for the flat app:
  baked shading — it costs nothing per frame, keeps paint uploads to colours,
  and needs no lighting material.
- **Colour management.** Colours are drawn as authored: post-processing is off
  (no tone mapper, colour grading, dithering or FXAA), the swap chain is not
  sRGB, and every colour — tints, the theme's viewport wash and plate tokens,
  paint, the projection's toolpath colours — is its sRGB value over 255,
  written as given. The browser keeps three's colour management on (sRGB
  output, no tone mapping), so authored colours reach its screen unchanged
  too; its 3D G-code preview did not until 2026-10-12, when it began converting
  the projection's colours to three's working space (it had drawn every
  toolpath lighter). Chosen: authored sRGB, untoned, as the browser's output.
- **Transparency.** One transparent material (`transparent.mat`: blended,
  premultiplied, no depth write, double-sided), used for non-printable
  instances at 0.4; Filament sorts per renderable, not per triangle. The
  simplify preview, helper volumes and the bed draw opaque, and the paint
  stroke preview is blended into vertex colours on the CPU (55 %). The browser
  draws the wipe-tower ghost (.35), its paint preview (.55) and an optional
  selection outline transparent.
- **Drawing.** Selection mixes the tint 45 % toward the accent (1, .62, .18).
  The bed draws a 3D solid plate (a 6 mm box below z = 0 filled in the theme's
  `plate.fill` token, side faces shaded at 0.85× and bottom at 0.7×, offset by
  `setPolygonOffset(1f, 1f)` to avoid z-fighting with the grid lines and models
  at z = 0), a 10 mm grid (coarsened to keep under 1,000 lines), the outline in
  the plate's major colour, and an origin indicator at (0, 0) in the plate's
  origin token colour. Toolpaths are one-pixel lines (Filament has no line
  width), at most 240,000 segments, as the browser's. Culling is off and
  materials are double-sided; each draw chunk is its own renderable (no GPU
  instancing). Anti-aliasing remains disabled on OpenGL ES: Filament 1.77.1's
  built-in blit shader (`blitLow`) for resolving multisample framebuffers on
  GLES 3.0 fails GLSL compilation in `FEngine::loop` with `PostconditionPanic:
  OpenGL program blitLow failed to link or compile` (GLSL syntax error in
  structure constructor arguments and float to mediump vec4 assignment), aborting
  with SIGABRT if MSAA is enabled.
- **Lifecycle.** A scene exists only while its area is resumed and renders
  only while dirty; surface loss destroys the swap chain. Context loss is not
  handled (`DONT_CHECK`), and the Vulkan materials are packaged but never used.
- **Devices.** Only x86_64 emulators (API 34; API 37 with 16 KB pages) have run
  it: no ARM64 device, no physical GPU.

Open before the flat exit gate, none of them blocking: frame time, draw calls,
memory and paint and pick latency of `FilamentScene` itself on the large fixture
(the workbench's numbers are not the production renderer's); the transparent
sort with overlapping non-printable instances; context loss; a device run.
(The plate fill is done; anti-aliasing is blocked by Filament's GLES `blitLow`
shader bug until an upgraded Filament or Vulkan backend is adopted).

The spatial selection (Android XR's Full Space) waits on hardware: the
SceneCore candidate ([below](#scenecore-candidate)) has rendered nothing
spatially (the SwiftShader XR image does not boot) and lacks picking,
clipping and toolpaths. It is chosen if, on a Galaxy XR, it draws the packed
mesh fixture with per-facet paint updates, selection and toolpaths within
the frame budget; otherwise the plan's fallback (OpenXR) is prototyped.

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

Physical hardware evidence on Samsung Galaxy XR (`SM-I610`, Android 14 / API 34, Adreno 740, Snapdragon SXR2230P):

- The candidate harness (`android/xr-experiment`) and benchmark suite (`tools/renderer/galaxy-xr-benchmark.py`) executed on the physical headset, recording `tools/renderer/results/galaxy-xr-scenecore-report.json`.
- Full Space transition: ~500 ms (`SpatialCapability.SPATIAL_3D_CONTENT` granted).
- 32,768 facet fixture (128 cells): 912.05 ms total load (2 uploads, largest chunk 983,040 B, 1,966,080 B payload, max synchronous submission 31.77 ms). Toggle instances created 4 entities.
- 32k sample paint replacement (4,096 facets across 2 chunks): 225.28 ms across 4 upload calls, 1,966,080 B buffer payload replaced.
- 2,000,000 facet fixture (1,000 cells): 7,045.12 ms total load across 123 chunks (120,000,000 B buffer payload, 246 entities, max synchronous submission 59.59 ms).
- 2M sample paint replacement: 100.81 ms across 125 upload calls, 1,966,080 B buffer payload replaced.
- SpaceFlinger / CPM (`cpm`): running at 72.0 FPS compositor rate, 2.47 ms GPU, Eye Tracking at 187.0 FPS, Hand Tracking active. Split engine buffers: Total 187, Current 22, Max 119. Process PSS 186.2 MB (Native Heap 16.6 MB, Graphics 25.4 MB).
- SceneCore 1.0.0-rc01 fatal defects and architectural limitations identified:
  - **Fatal native abort on mesh destruction (`owned_ptr.h:657`):** `imp::Mesh` in `libimpress_api_jni.so` crashes with `SIGABRT` if `CustomMesh.close()` or its Java `Cleaner` runs while any `MeshEntity` (even detached) still references it.
  - **Inaccessible entity disposal:** `Entity.dispose()` is restricted/inaccessible in rc01; replaced chunks cannot be garbage-collected or destroyed without crashing, forcing a tombstone leak (`tombstonedChunks`) for the session lifetime.
  - **CPM subspace saturation:** SceneCore creates an independent CPM split-engine subspace per `MeshEntity` (`mesh_entity_subspace_XX`). For 2M facets, 246 entities choke CPM asynchronous buffer registration unless throttled with inter-chunk pacing delays (`delay(16)`).
  - **Missing interactive capabilities:** SceneCore rc01 provides no ray picking against CustomMesh, no clipping planes, and color attributes reject float toolpath data.
  - **Paint bandwidth penalty:** Updating a 4k-facet paint stroke forces re-uploading entire chunks (1.96 MB) versus a 49 KB partial attribute subrange in Filament (40x penalty).
- Physical Filament qualification on Galaxy XR (`android/app` on Adreno 740):
  - Resolved OpenGL ES 3.2 backend (Feature level 2).
  - 50th percentile GPU latency: 1ms; 90th percentile: 2ms; 95th percentile: 3ms. Total GPU memory: 2.15 MB.
  - 2,000,000 facets rendered, center ray picking against fixture, 49 KB partial paint buffer updates, clipping planes, transparency, and toolpath geometry verified.
- Physical ARM64 local engine slicing qualification on Galaxy XR (`dev.orcaxr.nativeapp.engine.LocalEngineServiceTest`):
  - `liborcaxr_engine.so` executed natively on Snapdragon SXR2230P in the `:engine` service process.
  - Staged upload, sliced 20mm cube on Snapmaker U1 profile, reported progress steps, published verified G-code output, and cancelled a second full-bed job cleanly in 6.3 seconds.
- **Phase 2 Spatial Renderer Decision:** SceneCore rc01 is **rejected** for the interactive 3D model viewport. The production architecture uses a hybrid model: SceneCore hosts spatial UI panels, windows, and spatial activity lifecycle; interactive 3D model workspace editing, facet painting, clipping, and toolpaths are hosted on an embedded spatial surface / OpenXR pipeline.

References: [SceneCore release notes](https://developer.android.com/jetpack/androidx/releases/xr-scenecore),
[custom meshes](https://developer.android.com/reference/androidx/xr/scenecore/MeshBuffer),
[XR manifest configuration](https://developer.android.com/develop/xr/jetpack-xr-sdk/build-immersive),
[XR emulator requirements](https://developer.android.com/develop/xr/jetpack-xr-sdk/run/create-avds/xr-headsets-glasses).

## Contracts and scope

`orcaxr-project` now implements the stable-identifier foundation of Phase 4.
Domain IDs retain immutable UTF-16 units and their entity-family type; protocol
request IDs and session generations remain separate contracts. The unchanged
TypeScript authority generates 150 explicit identifier cases, exhaustive tests
of 2,555,904 UTF-16 grammar positions, a 65,536-unit imported payload, 20 PRNG
streams (1,280 exact floating-point words and 320 UUIDs), and four injected UUID
streams. Cases include surrogate halves, NULs, Unicode whitespace differences,
case preservation, negative/non-finite random inputs and seed wrapping. Five
integration tests plus a compile-fail brand check pass in debug/release; strict
workspace Clippy/tests and Cargo audit pass. The library checks for wasm32 and
both Android targets without platform dependencies. These are host execution
and target compilation evidence, not native editing qualification. The newer
WASM and JNI session bindings are described below. Graph admission, model and asset libraries are
described below, together with the newer command/history owner; guarded native
worker/JNI project integration remains open. The
native-core workflow now checks fixture drift and these targets.
The identifier-only update added the project crate to shared-core provenance.
Its browser set `255e6ce1f2dc` and JNI manifests retained byte-identical executables;
both APKs verified against those inputs with all libraries 16 KB aligned.
The complete repository quality gate passed with that asset set, including all
265 web unit-test files, 95 project test files, browser/offline/recovery and
accessibility checks, server HTTP/HTTPS deployment, real slicing and all three
npm audits. The redacted source scan covers 1,646 UTF-8 files with no findings;
workflow actionlint passes. Hosted CI and device execution of the new identifier
crate were not run.

The Rust asset repository now preserves the browser's immutable ownership model.
Canonical descriptors retain complete JSON metadata, UTF-16 keys/text, unknown
fields and binary64 number semantics. The repository checks stable IDs, finite
canonical metadata, byte lengths and lowercase FNV content claims before storing
owned copies. Other declared digest schemes remain opaque, while actual bytes
always determine the canonical bundle fingerprint. Declared graph-level layouts
and references are checked by the separate graph validator described below; this
repository is not an asset transport or an unchecked JavaScript-object emulator.

Internal history captures share immutable versions and records. Opaque handles
reject foreign repositories and restore cached fingerprints with the original
record identity. Read-only leases preserve renderer identity and keep bytes alive
until their last owner releases them; the repository holds no snapshot cycle.
Public mutable reads and borrowed imports copy. Owned native transfers validate
before moving their buffers. Restores validate all entries before publishing,
and equal public restores create fresh versions/records. No-op puts and absent
removals preserve identity. Digest lookup follows insertion order, while list and
fingerprint ordering follow UTF-16 IDs; the trace suite distinguishes those orders.
Fingerprinting streams canonical metadata and cached byte digests directly into
FNV without materializing a complete JSON string or copying payloads.

The TypeScript-derived corpus contains **13 payloads and 222 operations**, comparing
every result/error, sorted descriptor/byte payload, record/version identity and
fingerprint. It covers multiple history branches, duplicate digest order, failed
and duplicate-ID restores, immutable conflicts, public-copy isolation, empty
payloads, byte extremes, NULs, surrogate halves, supplementary characters,
unknown nested metadata and extreme finite numbers. During this port a failing
regression proved that browser `cloneJson` dropped own `__proto__` fields and
changed the copy's prototype. It now defines that key as an ordinary own property,
including nested copies; the trace corpus binds the corrected reference hashes.
Canonical encoding and ordinary project bytes are unchanged.

Four asset integration tests and a cache/lifetime unit test pass in debug/release,
along with read-only lease and existing ID brand compile-fail checks. The synthetic
allocation probe uses an 8 MiB asset: 200 capture/remove/restore cycles and first
fingerprint computation allocate no mesh-sized buffer; its positive control public
read allocates exactly one 8 MiB copy. Pointer/lease tests and source review verify
shared payload ownership. The allocation result is host evidence, not an Android
latency/memory ceiling. The existing browser asset benchmark also retains zero
copied bytes across 20 transform/undo pairs on its 8 MiB fixture. Full workspace tests, strict Clippy, Cargo audit and checks
for wasm32 and both Android targets pass with Rust 1.94.1. CI now regenerates the
asset corpus and runs the allocation probe. The optional project WASM and JNI
bindings are described below; production integration remains open. These library tests close no
Phase 4 exit.

The Rust project crate also implements the five-channel facet computation model.
Validated sparse assignments and version-2 refinement trees preserve color,
support, seam, fuzzy-skin and brim semantics. Tree normalization, combined
assignment/refinement remapping, split lookup, visitation, assigned-leaf counts
and whole-stroke split removal share the reference's outcomes. Homogeneous
branches collapse recursively; their paint moves into whole-facet assignments.
Canonical grouping sorts serialized keys by UTF-16 units, including surrogate
halves and supplementary/BMP order, while serializing each distinct value once.

Private tree construction enforces split topology and 64 levels; immutable owned
trees cannot contain the JavaScript validator's shared/cyclic object identities.
The existing expansion budget is retained. Canonical-value validation is independent
of the stateless JSON parser's limits; tests construct 63/64/65/80-level inputs
without routing them through that unrelated parser. Triangle numbers preserve
binary64 integer semantics, including large imported counts. Dense materialization
requires an explicit host maximum, rejects unaddressable sizes and uses checked
root allocation. The library is a computation view, not a full annotation/project
codec; the typed candidate below retains surrounding graph data. Graph admission
checks topology consistency; paint gesture/source-revision guards remain the host's
responsibility. These computation helpers do not introduce paint command endpoints.

Independent TypeScript fixtures now contain **273 refinement cases, 80 whole-facet
assignment cases, four depth cases and 160 editing traces**. They bind reference
source hashes and compare complete ordered diagnostics, canonical sparse outputs,
dense expansion, remapping, lookup, visitation and split removal. Cases cover all
five channels and seven legal split orientations, bad/extra fields, source-index
conflicts, unknown filament references, Unicode IDs and paint-preserving collapse.
Seven Rust tests pass in debug/release, including atomic failure, explicit dense
budgets and rejection of a 1,398,101-node expansion before normalization. The
synthetic 1,897,256-triangle sparse probe decodes 10,000 whole assignments and one
split, then remaps five times: **4,038,946 total allocated bytes**, largest
allocation **131,072 bytes**. The explicit dense positive control allocates
**75,890,240 bytes**. This verifies sparse allocation behavior, not device speed.
The CI workflow regenerates the corpus and runs the allocation probe. The newer
graph admission, command/history owner and session endpoint are described below;
worker/JNI project integration, editing UI and device qualification remain open.

For this facet-library update, strict workspace Clippy/tests, release project tests,
Cargo audit and compilation for wasm32/aarch64 Android/x86_64 Android pass. The
rebuilt browser set `86d271e88698` binds 71 source inputs and retains the same
556,646-byte WASM executable. Debug/release Android assembly, JVM tests, lint and
both APK source/alignment checks pass. The owned API 34 x86_64 SwiftShader emulator
passes 24 core instrumentation tests, three cold starts, three renderer tests and
one non-XR SceneCore startup check. Actual browser WASM smoke tests also pass.
The full repository run exposed a preview test's 20 ms worker-creation assumption;
its replacement check now observes real `open` submission and verifies that
specific worker's termination, keeping both adapter cancellation assertions.
These existing bindings do not execute the new facet library; its execution
evidence is the host differential tests and allocation probe. No physical device
was installed or qualified. The complete repository gate subsequently passed,
including 267 web unit-test files, 97 project test files, both preview adapters,
startup/offline/recovery/accessibility checks, HTTP/HTTPS deployment, real slicing
and all three full npm audits with no vulnerabilities. The final source scan
covers 1,678 UTF-8 files (six NUL-normalized) with no findings; actionlint passes.

The Rust project crate now has a lossless typed schema-1 model and immutable
candidate owner. Records cover plates, objects, volumes, instances, layer ranges,
mesh/asset descriptors, all five paint channels, physical/mixed filaments and
FullSpectrum recipes, emboss metadata, custom G-code, thumbnails and extensions.
Every record retains unknown fields, including own `__proto__` data. Text and IDs
preserve complete UTF-16; number fields retain finite binary64 values without
imposing pointer-width or safe-integer limits. Missing optional fields remain
omitted, while explicit null is rejected where the declared type does not permit
it. Typed decoding checks required fields, literal domains and tuple lengths.

`ProjectData` owns an immutable candidate and its cached full-state FNV fingerprint.
It does **not** prove semantic validity: tests deliberately construct candidates
with invalid timestamps and dangling references. The separate graph validator
described below now admits valid candidates. Native stores, command/history
execution for plate intents and the session endpoint are described below.
Option/profile validation and the remaining command families are still required. The
TypeScript validator's `Date.parse` acceptance and layer-event `toFixed(4)`
collision keys now have separate compatibility helpers used by graph admission.
No JNI/WASM
model endpoint or Android editing route is introduced by this library.

Child collections/records and configuration/annotation/extension payloads use
shared immutable ownership. Copy-on-write edits detach only their changed path;
retained candidates keep their original state and hash. Generic sparse assignment
arrays preserve original grouping, order and extras without allocating a second
typed object for every triangle. Refinement metadata stays intact for the separate
facet validator. Streaming canonical writing reuses the shared string encoder,
sorts keys by UTF-16 units and borrows imported keys. It includes all metadata,
timestamps and array order. Public exports intentionally copy; moving extras to
another record cannot shadow a known field, even when that optional field is absent.
Metadata validation uses a depth-proportional iterator stack, without applying
the unrelated stateless parser's request caps to persisted candidates.

The TypeScript generator validates every source fixture with the existing graph
validator and records source hashes, complete canonical states, fingerprints and
selector results. It covers **11 full states, four deterministic factories and
five direct candidate edits**, plus AST-derived **33 record layouts and 11 literal
domains**. Cases include all modeled fields and distribution variants, unknown
metadata at record boundaries, own prototype keys, large finite integers and
UTF-16 identities/references throughout a complete graph. Ten Rust integration
tests pass in debug/release: round trips, hashes, factory ID consumption, graph
lookups, topology comparisons, filament inheritance, schema drift, private error
diagnostics, failed decoding, copy isolation, sharing and metadata beyond the
stateless parser's node/depth budgets. These direct edits are not command/history
replay qualification.

The synthetic model allocation probe independently reconstructs a TypeScript-valid
300,000-painted-triangle metadata fixture and verifies its reference fingerprint.
Initial fingerprinting plus 20 retained transform edits with fresh fingerprints
make **zero 9,600,000-byte payload allocations**; the largest internal allocation
is **552 bytes**. A public-export positive control makes exactly one payload-sized
copy. This is host graph-metadata evidence, not native mesh loading, undo policy,
device performance or incremental hashing. CI now regenerates the model corpus
and runs the model tests and allocation probe.

For this model-library update, strict workspace Clippy/tests, release project
tests, Cargo audit and compilation for wasm32 and both Android targets pass.
The rebuilt browser set `80d66d932254` binds 76 source inputs and a 556,646-byte
WASM executable. Android debug/release assembly, core JVM tests, app lint and
both APK provenance/alignment checks pass. Browser WASM smoke passes against the
rebuilt pair. The owned API 34 x86_64 emulator passes 24 core tests, three cold
starts, three renderer tests and the non-XR SceneCore startup test. These bindings
exercise the existing canonicalization/G-code/intent APIs, not the new model:
model execution evidence comes from the host differential tests and allocation
probe. No native model endpoint, physical-device or hosted-CI qualification is
claimed. The redacted source scan covers 1,685 UTF-8 files (six NUL-normalized)
with no findings; workflow actionlint passes.
The complete repository gate passes with this asset set: 267 web unit-test files,
97 project test files, both preview adapters, startup/offline/recovery,
accessibility and localization, HTTP/HTTPS server deployment and real slicing
fixtures. All three full npm audits report zero vulnerabilities. Main-entry size
remains 2,101,384 bytes and total JavaScript 10,436,886 bytes, within unchanged
budgets. These checks preserve the current web release; Phase 4 remains open.

Rust settings policy now reuses the browser's pinned scope extractor, including
its four exact engine blobs and table digest. The generated table has 527 project,
eight plate, 242 object, 123 part and 124 height-range keys (532 unique keys).
Generation first checks the browser table against that same extraction. Native
lookup compares lossless UTF-16 keys with the sorted ASCII engine keys; it neither
normalizes imported names nor invents settings defaults.

The library implements scope eligibility, narrowest scope, strict layer validation,
stable precedence resolution, winner/shadowed explanations, canonical output and
explicit import sanitization. Unknown textual scopes and duplicate node layers
retain ordered diagnostics; non-text/invalid JSON belongs to host shape decoding.
Sanitization takes a typed recognized scope and preserves the original map while
returning a filtered view plus every removal. The separate project selector checks
plate/object/volume/range parent relationships and returns effective, inherited,
local, source-by-key and ignored projections. Read-only results borrow immutable
values; explicit public exports copy. Errors keep source text in typed UI messages
without exposing it in routine Debug/Display output.

During this port a failing browser regression showed that an ignored plate value
could hide an inherited value in the project configuration projection: project `wall_loops=2`
plus stored plate `wall_loops=99` correctly resolved to 2, but incorrectly exposed
99 as local and omitted inherited 2. Both implementations now exclude that ignored
local entry and retain the inherited value. The stored foreign field remains 99
for lossless export. Ignored diagnostics also use canonical UTF-16 key order;
numeric-looking keys and insertion order no longer change the result after a
canonical save/reopen. Existing effective engine values and scope eligibility are
unchanged by these corrections.
The current production caller consumes the effective plate configuration for
slice preflight; this fix does not establish a new inspector or native UI flow.

The independently executed TypeScript corpus covers **544 known/foreign keys,
3,439 layer cases, 15 sanitizers and 100 graph queries**. It binds reference source
hashes and the engine table provenance. Five Rust integration tests compare exact
canonical results, ordered issues, aggregate error messages, winner/shadowed
sources and invalid parent requests. Cases cover every engine key at all five
scopes, reversed precedence, stable ties, duplicate omitted/empty/NUL IDs, unknown
scope names, Unicode keys/IDs, explicit null values and own prototype properties.
Both browser projection regressions pass with the existing scoped-setting tests.
The allocation probe performs 200 combined resolution/explanation/sanitization/
graph-query cycles over an **8,388,608-byte** configuration string with **zero
payload-sized allocations**, largest internal allocation **368 bytes**. An explicit
public export makes one measured payload copy; pointer checks confirm sharing.
These are scope-policy and host ownership results, not option-value validation,
profile compatibility, settings commands, slice preflight, native UI execution or
physical-device qualification. CI regenerates the table and corpus and runs the
tests and probe; Phase 4 stays open.

For this settings-library update, strict workspace Clippy/tests, release project
tests, Cargo audit and compilation for wasm32 and both Android targets pass.
The browser set `46e2fdbafc9e` binds 81 source inputs and retains the byte-identical
556,646-byte WASM executable. Android debug/release assembly, core JVM tests,
lint, both APK provenance/alignment checks and browser WASM smoke pass. The owned
API 34 x86_64 emulator passes 24 core tests, three cold starts, three renderer
tests and non-XR SceneCore startup. Those platform tests execute existing bindings;
the new settings module is executed by the host differential tests and allocation
probe; native settings command endpoints remain unimplemented. The redacted source scan covers
1,693 UTF-8 files (six NUL-normalized) with no findings; actionlint passes.
The complete repository gate passes with 267 web unit-test files, 97 project
test files, both preview adapters, startup/offline/recovery, accessibility and
localization, HTTP/HTTPS server deployment and real slicing fixtures. All three
full npm audits report zero vulnerabilities. Main-entry size is 2,101,441 bytes
and total JavaScript 10,436,944 bytes, within unchanged budgets. No physical
device or hosted-CI qualification was performed for this update.

The Rust validation-value library now preserves the two JavaScript behaviors
that a strict ISO parser or normal Rust formatting would change. Timestamp syntax
adapts the V8 parser in Node v22.21.0, with its BSD license and source attribution
retained. It scans borrowed UTF-16 without allocation and preserves NUL behavior,
legacy dates/month prefixes/comments, two-digit years, day overflow, fractional
seconds and numeric timezone offsets. `Date.parse` allows implementation-specific
legacy syntax: this is a pinned V8 compatibility profile, not a claim about every
browser engine. V8 itself has a build-dependent legacy offset overflow check;
callers explicitly choose Smi31 (the tested Chromium build) or Smi32 (the tested
Node build). Rust pointer width never selects that policy.

Timestamp parsing distinguishes explicit UTC offsets from local civil times.
Local values require an injected host conversion with matching DST ambiguity,
gap and historical timezone rules. The library checks the permitted range before
conversion and applies TimeClip afterward. Host-service errors propagate
separately from invalid input; there is no default UTC fallback. Native timezone
conversion now has the explicit JNI/Java adapter described below; its Android
runtime qualification remains open. Layer-event keys
compute the exact binary64 rational rounded to four decimals, with ECMAScript
ties and signed-zero behavior, then use the shared JavaScript number formatter
at magnitudes of at least 10^21. Invalid but finite authored heights still get
the same collision key. Non-finite values are already excluded by typed candidates.

`validation-value-vectors.mjs` independently executes Node Date.parse/toFixed,
the actual TypeScript graph validator and installed Chromium. Its source-bound
corpus covers **6,137** timestamp strings in UTC, UTC-12 and UTC+14, **48** local
conversions across New York, Lord Howe, Apia and Kathmandu, **10,942** exact
binary64 rounding inputs and **247** project layer-event collision checks.
The measured oracles are Node 22.21.0 and Chromium 150.0.7871.24. Six Rust tests
pass in debug and release for both integer profiles. Fixed-zone comparisons
resolve the actual parsed civil value; DST/history tests check that value and
preserve an oracle-backed host result. They do not implement or qualify a Rust
timezone database. Other tests cover resolver failure, TimeClip boundaries and
inputs/comments beyond transport budgets. A **6,291,484-byte** synthetic input
with over a million nested comment pairs takes **zero heap allocations**
over twenty parses; an explicit copy positive control makes one full allocation.
CI regenerates both engine oracles and runs the tests and allocation probe.
These compatibility primitives are now used by the graph validator below. They
do not by themselves qualify a host timezone service. The newer WASM and
JNI/Java bindings are described below; no Phase 4 exit is closed.

For this compatibility update, strict workspace Clippy/tests, release project
tests, Cargo audit and compilation for wasm32 and both Android targets pass.
Browser set `336e838e5106` binds 85 source inputs; its 556,646-byte WASM executable
is byte-identical. Android debug/release assembly, JVM tests, lint, both APK
provenance/alignment checks and browser WASM smoke pass. An owned API 34 x86_64
emulator passes 24 core tests, three cold starts, three renderer tests and one
non-XR SceneCore startup test. These platform checks exercise the existing
bindings, not the new validation-value library. The redacted source scan covers
1,700 UTF-8 files (six NUL-normalized) with no findings; actionlint passes.
The complete repository gate also passes: 267 web unit-test files, 97 project
test files, both preview adapters, browser/offline/recovery/accessibility checks,
HTTP/HTTPS deployment and real slicing fixtures. All three full npm audits report
zero vulnerabilities. Main-entry JavaScript is 2,101,441 bytes and total JavaScript
10,436,944 bytes, within the existing budgets. Physical-device and hosted-CI
qualification remain outside this local evidence.

Rust semantic graph validation now covers canonical typed candidates. It reports
duplicate IDs, declared layout/count/bounds failures, missing references,
inherited-settings inconsistencies, physical/mixed filament rules and cycles,
FullSpectrum recipe constraints, transforms, height ranges, topology and all five
paint channels, layer-event rules/collisions, thumbnails and extension references/
paths. It preserves traversal order, complete UTF-16 diagnostic text and ordinary
binary64 integer rules. Only fields that require safe integers use that narrower
check. Unknown imported settings stay intact; this is not option/profile
eligibility or actual mesh-byte/slicing attestation.

`validate_project` borrows `ProjectData`, whose typed model and canonical encoding
have already excluded malformed shapes, IDs and non-finite JSON. It accepts an
explicit timestamp policy: a host can provide its actual Date.parse behavior or
use `V8Timestamps` with the pinned grammar and local-time resolver. Service failure
returns separately from an invalid-data report. `ValidatedProject` admits only a
report without errors, retains the immutable candidate and cached fingerprint,
and shares that proof across clones. Editing a candidate does not change the
admitted original; the edited candidate needs new admission. Public UI messages
retain the browser text, while Debug/Display omit private imported data. This
type owns no revision, asset repository, command bus, subscriber list or history.

Two browser diagnostic corrections accompany the port. Unknown refinement-channel
issues now use canonical UTF-16 key order, including numeric-looking keys and lone
surrogates, so save/reopen cannot reorder them. Sorted layer-range validation now
carries original array positions; it no longer repeatedly searches by object
identity or misattributes a repeated shared record to its first occurrence.
Both have browser regression tests and native differential cases. Mixed-cycle
validation uses iterative DFS with the same last-duplicate-ID lookup and ordered
cycle paths; a 10,000-entry native graph does not exhaust the call stack.

The independent `project-validation-vectors.mjs` corpus contains **622 states**
and **81 diagnostic codes**, comparing complete ordered issues, error text and
full-state fingerprints. It checks each state again after canonical save/reopen,
covers compound failures, existing full-schema/UTF-16 fixtures, mixed cycles,
numeric boundaries, all five sparse-paint channels and malformed refinement
encodings. A source-code inventory requires coverage of every graph diagnostic;
**12** source codes are separately documented as already excluded by typed
decoding. Seven Rust integration tests pass in debug/release, including immutable
proof reuse, timestamp-policy selection, timezone failures, TimeClip after host
conversion, private diagnostics and deep mixed graphs. CI regenerates the corpus.

The graph allocation probe declares **1,897,256** source triangles with **100,000**
assigned facets and compares separately owned equal **8,388,608-byte** settings
strings plus wide metadata arrays. Admission allocates **1,971,034 bytes** in
total, with a largest allocation of **640 bytes** and no payload copy or dense
mesh roots. Two hundred proof clones/reads allocate nothing and do not validate
again; the public-export positive control copies the 8 MiB string once. Equality
uses depth-sized iterator frames and paint paths are formatted only on failures.
This is host metadata ownership evidence, not a device performance budget.
Native history/session execution, optional WASM binding and Android JNI/timezone
services are described below; the Phase 4 exit is not closed.

For this graph-validation update, Rust workspace tests, optimized project tests,
strict Clippy, format, Cargo audit and compilation for wasm32 and both Android
targets pass. Browser set `23fa38479ab7` binds 91 source inputs and retains the
byte-identical 556,646-byte WASM executable. Browser WASM smoke, Android
debug/release assembly, JVM tests, lint and both APK provenance/16 KB alignment
checks pass. The owned API 34 x86_64 emulator passes 24 core tests, three shell
cold starts, three renderer tests and one non-XR SceneCore startup test. These
platform tests exercise the existing bindings; they do not execute the new
graph-validation library through JNI or WASM. Physical-device and hosted-CI
qualification remain outside this local evidence.
The complete repository gate passes with 267 web unit-test files, 97 project
test files, production browser/offline/recovery/accessibility checks, both
preview adapters, HTTP/HTTPS deployment and the published-engine slicing
regressions. All three full npm audits report zero vulnerabilities. Main-entry
JavaScript remains 2,101,441 bytes; total JavaScript is 10,437,001 bytes, within
unchanged budgets. Actionlint passes, and the configured redacted source scan
covers 1,708 UTF-8 files (six NUL-normalized) with no findings.

Rust now has single-owner project and selection stores. The project store accepts
admitted immutable graphs, shares snapshots and returns a `ProjectChange` after
publication. Equal replacements still advance revision; restoration reuses the
original allocation/proof/hash with a new revision and empty dirty categories.
Fresh candidate validation and timezone-service failure happen before publication.
`has_same_content` compares the complete graph, including unknown metadata,
without serializing or trusting an FNV match. Shared JSON is skipped by identity;
separately owned JSON uses the same depth-sized equality iterator as graph checks.

Selection preserves ordered kind/ID deduplication, explicit primary membership,
the default last-item primary, add/toggle behavior, and pruning through canonical
selectors. Disabled physical/mixed filaments still exist. Restoring a selection
without a primary uses set semantics and chooses its last item; exact no-ops
return no change. Snapshots and receipts share immutable data and survive owner
disposal. Debug output omits private source text, IDs and reasons.

The independent store corpus executes the production TypeScript stores for
**311 steps** over **12 candidates**, checking full canonical content, allocation
identity, revisions, guards, ordered project/selection receipts, diagnostics,
failed operations, rollback, signed zero, foreign metadata and retained snapshots.
Throwing reference observers do not prevent later receipt delivery. Native stores
return those receipts directly; host subscription dispatch remains separate.
The JNI owner below refuses reentry and query captures expose bounded reads;
these store tests do not qualify those bindings. The low-level revision/hash guard deliberately has value
semantics; the native session below adds generation/asset/history checks and
owner-bound local guards.

Native revisions are capped at the existing protocol safe-integer maximum.
Capacity refusal publishes nothing, instead of allowing unchecked JavaScript
counter rounding or integer overflow. A schema-bound boundary test exercises
the final revision and refusal; future transactions must check enough capacity
for all their publications and rollback before their first mutation. The command
owner below implements that reservation. This is not a persisted project limit;
worker/JNI project transport and editing UI remain Phase 4 work.

Four store/selection integration tests and the counter-boundary unit test pass
in debug and release, alongside the full Rust workspace tests, strict Clippy,
format and cross-compilation for wasm32/Android ARM64/Android x86_64. The resource
probe performs **200 publication/rollback cycles**, retaining **400 receipts**
over the same 1,897,256-triangle/100,000-assignment synthetic graph and 8 MiB
configuration payload. Full comparisons against an independently owned equal
graph, guard checks and selection restoration allocate **2,448,000 bytes** total;
the largest allocation is **640 bytes**, with no payload copy. The explicit
public-export positive control copies the 8 MiB string once. This is store
ownership evidence, not command/history execution or device performance.

The Rust command owner executes nineteen shared intents: plate add, duplicate,
delete, activate, rename, reorder and printability; object/volume/instance rename;
instance printability; single/batch instance transforms; object/instance deletion;
plate clearing; independent object duplication; cross-plate movement; and
instance-to-object conversion. Shared bounded
wire decoding precedes stable-ID and constructor validation; a whole batch is
prepared before mutation. The owner holds project, selection, assets and the
explicit timestamp policy. Returned outcomes contain all ordered project,
selection and history effects, even on failure. Stores and the bus retain no
host callback queue. The native session below checks guarded work and returns
ordered effects with its reply; the host must settle dispatch before delivering
that acknowledgement.

The bus implements entry/estimated-byte retention, single-entry coalescing,
checkpoint/dirty tokens, undo/redo and atomic batches. Equal visible history can
still advance the history guard revision. Each command declares a publication
bound, enforced by its context; preflight reserves that capacity plus all rollback
publications before mutation. Dirty clocks are monotonic across failures. Failed
execution restores project/assets/selection and dirty tokens; a batch member
failure also restores the outer snapshot. No-op commands do not enter history.
Commands report anticipated failures with Result; this does not add panic
recovery or transport arbitrary callbacks/nested synchronous transactions.

Plate duplication remaps every editable entity ID, interleaves scoped G-code/thumbnails,
retains unknown fields and shares immutable mesh references and paint/config
payloads. Its cached source comparison uses the complete canonical scope, never
an FNV-only match. Its history charge streams the browser's canonical UTF-16
length, including escaping the embedded source-scope string, without retaining
that serialization. Plate duplicate/delete revert reuses admitted previous graphs.
Reorder undo preserves browser logical-order behavior, including renumbering;
duplication retains the existing sparse-order source-change refusal.

An independent production-TypeScript corpus provides **1,108 steps in 51 traces**
over **265 complete canonical contents**. It compares state, fingerprint,
revision, selection, ordered effects, errors, visible history/history revision,
asset fingerprints, and retained immutable snapshots after every step. Cases
include plate limits, all nineteen commands, no-ops, undo/redo, failed preparation
versus failed execution, Unicode/unknown metadata, duplicate ID-plan errors,
sparse orders, checkpoints and exact UTF-16 history-retention thresholds. New
traces cover trimmed names, absent versus empty instance names, transform
validation failures, sorted batch targets, gesture coalescing, redo branches and
atomic failures. Imported transform extras and legacy single-key collisions
retain the TypeScript semantics described in project contracts. Lifecycle traces
also exercise subtree deletion and neighboring selection, empty-plate history,
ID collisions, cross-plate undo, optional names and conversion's instance-field
rules. All six added commands preserve asset records. Native
checks additionally preserve asset record identity and inject failure during
no-op detection, apply, revert, redo, estimate and coalescing. Reservation tests
cover publication overrun and safe history/dirty counter exhaustion. These are
library execution tests; production worker/JNI integration, other command families,
revisioned projections, archive compatibility and editing UI remain open.

Local `PreparedCommand::create_instance` and `paste_object` now retain complete
immutable records, including unknown metadata and shared paint/configuration
allocations. `InstanceInput`/`ObjectInput` stage UTF-8 chunks under caller-supplied
JSON budgets, preserve UTF-16 escapes and persisted last-key-wins JSON, and prove
typed structure before returning an immutable record. Destination graph admission
still belongs to command application. Staging cancellation drops its data; it
does not publish state, register a session handle or import referenced assets.

A separate independent TypeScript corpus supplies **197 steps in 11 traces**
over **95 canonical contents** for these local commands. It compares the same
full states, ordered effects, history, errors and immutable assets as the wire
corpus, including caller mutation after construction, insertion positions,
Unicode/unknown metadata, paste after source deletion, destination resolution,
collision/validation failures and exact retention thresholds. A 70-instance
transaction qualifies one-step undo/redo and rollback after its final duplicate;
local labels retain empty, whitespace and long UTF-16 values. This exposed and
removed wire-only batch/label restrictions from the native history owner. The
generated decoder still refuses a 65-command wire batch and oversized labels;
hosts must admit larger staged work under explicit operation budgets.
Five native input/ownership tests additionally check every byte split, malformed
structure, incomplete/terminal failure, overwritten source buffers, copy-on-write
isolation and a record exceeding both the small request byte and node ceilings.
Finished captured commands now enter a session-owned staging pool in Rust and the
local TypeScript endpoint. The pool is disabled until the host supplies explicit
resource, command-count and encoded-UTF-16 limits. The immutable input charge
includes every retained argument and transaction label. A one-use, monotonically
allocated ID carries the original owner/project/asset/history guard through
admission and queue execution. A queued input retains its budget lease until
execution, cancellation or disposal. Cancel/close release the full payload before
reply settlement. Ready-input release bypasses a full request queue, and separate
host cleanup safely frees unaccepted resources after transport failure. None of
these paths retries or undoes a committed edit. Preparation/decoding is separately
budgeted by the host; this pool neither counts unfinished tasks nor measures
resident memory. The version-1 envelope adds executeStaged/releaseStaged and a
released result; existing small command/batch limits stay unchanged. Older
decoders reject these operations, and the matching upload host must be present.

An independent staged endpoint corpus compares **32 traces / 398 groups / 331
requests / 107 full contents**, including all local instance/paste command traces,
70-command atomic batches, source/history guards, cancellation, disposal, limits,
ID nonreuse and release at queue capacity. Eight direct native tests and sixteen
TypeScript transport tests cover large records, immediate payload destruction,
one-use captures, lost replies and completed-but-unavailable summaries. This
qualifies local/Rust ownership and generated reference submission. The separate
`contracts/project-staging.json` schema now also generates input/pool options and
bulk work/command tags for Rust, TypeScript and Kotlin. Its UTF-8 JSON envelope is
`[version, work]`: work is `[singleTag, command]` or `[transactionTag, label, commands]`.
Each command starts with its generated numeric tag and the ordered fields declared
by the schema; optional arguments use null. Records preserve persisted JSON semantics,
while embedded small intents remain strict ASCII JSON strings. Invalid arities,
versions and typed records are refused without publication.

WASM/JNI upload owners accept ordered chunks up to 64 KiB, under explicit byte,
node, text, token, depth, command-count and encoded-input budgets. A separate
four-preparation limit per core instance covers both reading and sealed uploads
across sessions. The permit stays held until failed admission or transfer to the
finished-input pool; cancellation, malformed data and failed sealing release it.
Only offset/chunk refusals preserve progress. Sealing does synchronous typed decoding
and measurement; the host must own and schedule that preparation task. JNI owners
can use separate task threads, but WASM handles remain in one module/linear memory.
Separating seal from transfer does not isolate it on another worker or make it
interruptible. Production WASM finalization scheduling remains open. Transfer has no parser work and checks
the original captured guard. Captures can outlive their source session, but cannot
attach to a new owner; application tasks must cancel abandoned preparations.
Kotlin exposes consumed uploads and closeable ready references, including late
result cleanup. Closing a ready reference releases only unaccepted work. A failed
release retains the ID for retry; preparation waiting does not hold the session gate.

Actual Node-worker WASM and debug/release JNI now replay **109 command uploads and
331 staged requests** against all **32 independent traces**, with **103 shared
boundary refusals**. This includes full instance/paste metadata and 70-command
atomic transactions. **Seven Kotlin ownership scenarios** exercise the actual
high-level classes. **Two native upload tests** cover concurrent permits, byte
splits/source ownership, a record above the small byte/node ceilings, option bounds
and failures releasing capacity. **148 TypeScript option checks** cover exact
shapes, accessors and numeric budgets. The browser controller now sends clone,
add-instance and fill-bed through local staged references with the original guard.
It enables four ready/queued resources, 4,096 commands and 16 Mi encoded input units;
record capture separately limits nodes/depth. The default fill limit remains 64.
**23 controller cases** cover 70-copy atomic fill, rollback after a member failure,
exact undo/redo, pre-preparation guards, stale/closed owners, resource exhaustion,
captured results and lost receipts. Existing registry/presentation tests also await
these actions. Clipboard paste also uses the local staged adapter: **13 controller
checks** cover reset/source deletion, stale/closed ownership, uncertain receipts,
newer clipboard copies and 3MF save/reopen. Opaque asset subsets retain only
selected records, including SVG drawings, under 4,096-asset / 512 MiB limits.
Paste restores missing declarations and bytes inside its rollback boundary and
history accounts for retained bytes. **Eleven asset ownership tests** cover
conflicts, failed publication, retryable undo/redo and twenty cycles over an 8 MiB
asset without copying its payload; public reads still copy. Rust now has the
matching library capture/paste operation. It retains the selected object and
asset records under caller-supplied count/byte limits, with weak repository
ownership and shared typed metadata; no whole source project/version survives.
Missing declarations/records are merged inside command rollback, and history
charges captured bytes plus metadata. Dependency lookup and undo reference scans
avoid a full graph traversal per selected asset. Seventeen browser-authored traces
compare **130 steps / 15 complete contents**, including SVG drawings, partial
restoration, unchanged and deleted sources, UTF-16 extras, foreign captures,
descriptor/byte conflicts, dangling materials, invalid IDs/destinations, batch
rollback, exact input units and history retention thresholds. Seven native tests
cover capture bounds/source consistency, selected record identity, all-conflicts-
before-publication, staged measurement limits, apply/undo/redo fault retries and
detached preparation after source closure with shared permit accounting.
WASM/JNI now expose four independently budgeted clipboard owners per core
instance. Capture takes a current object query node and session guard, preserving
sorted display selection while rejecting stale graphs and wrong node kinds.
The completed capture retains no source snapshot. Fresh paste guards attach selected data
to the existing command upload owner; its additive tag carries only IDs and the
destination, while finished-input/history charges include retained metadata/bytes.
Ten captures in the independent endpoint corpus and **53 shared host refusals**
exercise quota exhaustion, foreign/stale sources, malformed input, exact charges,
source closure, early clipboard disposal and command/history retention. **Six
Kotlin ownership scenarios** exercise the actual high-level wrappers, including
close during reading, stale transfer and late-result cleanup with permit reuse.
Android also exposes a detached preparation owner: guarded project/asset snapshots
are captured without scanning the object, then query selection and asset validation
run on a preparation worker. Preparation and completed captures share the same four
permits. JNI conversion reuses the input handle without allocating another slot.
The input temporarily retains frozen source versions; success keeps only selected
data. No live session or repository lock is needed during that traversal.
Browser preparation remains synchronous. Production archive import, browser task
isolation and Android editing remain open; the small command union still
has nineteen variants. These host tests do not establish device memory or latency.

The command allocation probe completes **20 plate cycles**, **40 transform/undo pairs**,
**120 object lifecycle/undo pairs**, **40 captured instance-creation/paste/undo pairs**,
**580 project revisions** and **1,520 retained events** over 1,897,256 declared source triangles, 100,000 paint
assignments, an 8 MiB asset and equal 8 MiB configuration strings. Duplication,
deletion, movement, independent conversion, instance creation, paste, single/batch
transforms, undo/redo and failed batches allocate **1,124,223,036 bytes** total, with
largest allocation **217,600 bytes** and **zero payload-sized copies**. Mesh,
paint and configuration identity assertions pass; the explicit public asset read
copies one 8 MiB payload. The additional clipboard probe captures one 8 MiB record
and runs twenty measured preparation/paste/undo/redo cycles: **81,669,734 allocated
bytes**, largest allocation **768 bytes**, **zero payload-sized allocations** and
an explicit public-read control detecting one 8 MiB allocation. Its full record
contains 100,000 paint assignments and charges 590,719 encoded input units.
The separate session probe now measures twenty guarded query capture/upload/seal/
stage/release cycles: **139 wire bytes**, **8,979,001 input units**, **298,300 allocated
bytes** total and largest allocation **640 bytes**, with **zero payload-sized
allocations**. Release destroys the immutable capture immediately; public-copy
controls detect the mesh and both large metadata strings. This covers host
preparation ownership separately from the command apply/undo/redo probe.
These are synthetic ownership measurements, not native
device latency/residency or real-model import qualification. Full workspace debug
tests, release project tests, all three command corpora, six clipboard boundary/fault tests,
five record-input tests, seven history fault tests,
safe-counter boundary test, strict workspace/all-target Clippy, formatting,
reference regeneration and actionlint pass. The project library also compiles
for wasm32, Android ARM64 and Android x86_64.

The native project crate now owns a guarded session endpoint for the existing
string protocol. Construction takes a separately admitted graph and explicit
host timestamp policy, checks exact asset membership/full metadata and creates
the browser's initial clean checkpoint. Typed-to-JSON equality compares borrowed
known fields and unknown values without public copies or hash-only admission.
A host-supplied 128-bit nonce is distinct from canonical ID generation. Decoder
bounds precede work capture; a 32-request queue retains only prepared commands
and bounded guard values. Queries run in order with mutations. Read-only local
views are for future bounded projections; wire replies never serialize a graph.

Handshake, wrong-generation/version/disposal precedence, monotonic request IDs,
readiness, guard checks, cancellation and close follow the browser endpoint.
Control messages remain available at queue capacity. Preparation failures keep
small settlement slots and remain their original errors even if subsequently
cancelled/closed. Other cancelled/closed work immediately drops captured payloads
but retains a slot until the host drains its reply. Close invalidates the
connection; immutable assets/receipts can outlive it. The host schedules one
synchronous commit at a time away from the UI and consumes ordered effects before
delivering the already-settled reply. There is no callback into the host during
commit, and later cancellation cannot retract an acknowledged mutation.

Queued mutation guards bind project ID, revision, semantic hash, asset fingerprint
and history revision. Host-local guards also bind an opaque authority owner;
equal-looking foreign snapshots cannot authorize local selection or saves.
Successful save handoff checks the captured project/revision/content/assets,
without rejecting a history-only change to the same serialized document. The
resulting checkpoint still invalidates queued edit guards. A summary that exceeds
frame/node limits after commit reports receiptUnavailable with the real changed
flag; the edit is never relabelled as rolled back or automatically retried.

The independent TypeScript endpoint corpus now covers **1,380 requests in 1,306
submission groups across 60 traces**, with **269 complete canonical contents**
and **eight bundle-admission cases**. It replays the prepared command corpus through
an actual EditorSession/AsyncEditorSession/ProjectSessionEndpoint, comparing
replies, full graph/hash/revision, selection, history, ordered effects, asset
identity and retained snapshots. Groups exercise queue saturation/recovery,
staleness, malformed frames, replay, cancellation, close and preparation-error
precedence. A generated node-boundary case proves that a valid request can commit
while its larger history summary cannot fit. Native ownership tests and a save
trace distinguish export checks from stricter edit guards. Full-model borrowed
comparison also agrees with the independent canonical corpus and missing fields.

The session allocation probe uses an 8 MiB mesh and two separate 8 MiB metadata
strings, including a known filename and unknown wide metadata. Admission plus
local guard checks allocate **3,778 bytes**, largest **640 bytes**, with no
payload copy. Thirty-two prepared requests with 120,000-unit IDs retain
**7,705,984 bytes**; cancellation leaves **8,064 bytes** before draining, and
close releases all prepared data before draining. A public repository read makes
three measured 8 MiB copies as a positive control. These are synthetic ownership
measurements, not Android memory/latency qualification. The host owns response
lifetimes; the core retains neither an unbounded result queue nor callbacks.
The same probe now stages an 8 MiB full instance record, releases it while ready
and cancels it while queued. Capture/admission/release allocate **19,306 bytes**
total, largest **2,216 bytes**, with no payload-sized copy. The retained delta
peaks at **8,391,984 bytes**; at most **2,376 bytes** remain before settlement and
a weak reference proves the record has already been destroyed. Input construction
and parsing happen before that measurement and require separate host budgets.

Native bulk input now stages a canonical document from ordered UTF-8 chunks of
at most 64 KiB, without retaining its source text. The host explicitly supplies
byte/node/text/token/depth and asset budgets. The iterative JSON reader preserves
lossless UTF-16 escapes, strict UTF-8, duplicate-property last-wins behavior and
finite binary64 values. Counts include discarded duplicate properties. Syntax or
resource failure releases staged values; bad chunk boundaries leave progress
unchanged. Nesting is capped at 128 edges to keep later value encoding/drop safe.
This is an input resource boundary, separate from both project schema validity
and the stateless canonicalizer's small envelope limits.

Document shape, semantic graph admission, explicit timestamp services and declared
asset budgets precede byte transfers. Only declared assets are accepted, one
active transfer at a time. Exact lengths and digests are checked before an owned
buffer moves into an immutable repository record. Cancel releases the active
buffer; failed digest checks discard it and allow retry without disturbing earlier
staged assets. Finishing consumes a complete graph/repository bundle; it cannot
publish a partially loaded session. Final graph admission/hash and asset digest
work are still synchronous and belong in an owned import task. Chunked parsing
does not qualify cancellation of that finalization work on the authority worker.

Complete immutable bundles now support guarded document replacement through
Rust, WASM/JNI and Kotlin. Preparation checks exact graph/asset metadata and warms
the bundle fingerprint before entering the authority. Open tickets bind source
export identity and a unique operation: a newer failed/cancelled Open never
revives an older one. History-only changes preserve the source export guard;
project/asset changes refuse. Reset checks its captured export identity and clears
pending Open only after successful commit. Project/selection/history effects
match browser order, revisions advance even for equal contents, and history
becomes clean. Repository ownership, connection/request/staged-ID counters and
immutable old captures survive. Ready/queued work keeps its charge and settles
stale against the new graph. Prepared records move without payload copies.

The independent browser authority provides **16 traces / 59 steps / 4 complete
contents** for clean/dirty/equal/empty replacement, source edits and undo,
selection/history-only changes, superseding/failing/cancelling Opens, disposal
and invalid bundles. Three native tests additionally check foreign tokens,
immediate rejected-input destruction, prepared graph/record identities,
clipboard owner continuity and stale staged settlement. Counter exhaustion
refuses before publication. Actual WASM and debug/release JNI replay add **seven host refusals**;
the consumed-document retry keeps the session usable. WASM retains an empty
wrapper after consumption and requires explicit free. **Seven Kotlin ownership scenarios** exercise the actual high-level owners, and
the Android instrumentation source compiles. Kotlin consumes prepared owners;
JNI reserves native effect capacity before publishing. These are document
adoption APIs; foreign archive decoding, application task integration, dirty confirmation
and Android document UI remain open.

The release adoption probe runs **20 preparation/commit cycles** over an 8 MiB
mesh and two 8 MiB metadata strings. Bundle proof/fingerprinting plus commit
allocate **85,328 bytes** total, largest allocation **640 bytes**, with **zero
payload-sized allocations**. Prepared graph and asset record identities survive
commit. Public-read controls detect all three payload copies. Graph/payload admission and input fixture
allocation precede measurement; this does not qualify parsing, file I/O,
device residency or interactive latency.

The independent input corpus uses JavaScript JSON.parse and the production
canonical writer for **2,433 cases**, of which **694** are accepted. Native tests
try every byte split and one-byte chunks, exhaust all 65,536 escaped UTF-16 units,
refuse malformed UTF-8 and exercise exact resource boundaries. Documents beyond
the stateless byte/node limits succeed under the explicit bulk budgets. All 18
session reference documents and their actual asset bytes load into guarded native
sessions; full canonical content, metadata, byte content, identities and initial
handshakes agree. Fault tests cover admission/timezone errors, aggregate asset
budgets, cancellation, corrupt payload retry and immutable record identity.

The synthetic input probe reads a **1,640,745-byte** document containing a million
text units and 100,001 foreign array values. Parsing, admission and comparison
allocate **13,586,976 bytes**, largest **4,194,304 bytes**. An 8 MiB mesh transfer
has **one payload-sized allocation**, with no second mesh allocation on repository
admission. Cancelling the active transfer releases **8,388,608 bytes** immediately;
the public asset-read positive control adds one mesh copy. These are host
ownership measurements, not Android memory or loading-time qualification.

The project session now has an actual WASM binding, built separately from the
production preview module. `contracts/project-host.json` generates Rust, TypeScript
and Kotlin definitions for versioned input/history budgets, bounded transfer/text
chunks and effect/selection kinds. Producers preserve unsigned 32-bit values;
the TypeScript encoder captures own data properties without invoking getters.
Rust rejects nonfinite/fractional/out-of-range values before allocating an upload.
Raw wasm-bindgen still copies input before Rust validation, so a production host
must enforce the generated limits before entering these trusted adapter APIs.

`ProjectUpload` owns staged document/asset transfers; opening consumes it even on
failure and publishes only a complete bundle under a fresh host nonce. Browser
timestamp validation invokes actual host Date.parse, reconstructing lossless
UTF-16 in bounded chunks. Exceptions are redacted service failures, not invalid
project timestamps. Session replies expose ordered project/selection/history
effects, including rollback effects on failures. The host must dispatch them
before acknowledging the operation. Selection and save use opaque owner-bound
guards; merely exporting never clears dirty state.

Project, selection, history and asset captures retain immutable native ownership
after session release. Hosts explicitly free all handles and receive owned arrays
from bounded reads. Project JSON and asset metadata export are explicit bulk
operations: each allocates a complete serialized UTF-8 buffer under the caller's
output limit. Reading that buffer in chunks does not make its creation incremental
or interruptible. The query API below provides bounded reads from immutable
captures; live subscriptions, complete tree/renderer projections and production
browser authority-worker export isolation remain open. Android now provides a
separate streaming writer and frozen export task, described below.

`project-wasm-test.mjs` executes the real project binary in a Node worker. Its
unchanged browser-compatible replay loads all 60 canonical documents and actual
assets, executes **1,380 requests in 1,306 groups**, and compares complete canonical
state, revisions, selection, history, asset metadata/bytes and ordered effects
against the independent TypeScript corpus. Retained captures and leases survive
session release; a transferred buffer remains valid after worker termination.
Additional checks exercise **91 refusals**, **6,137 timestamp cases** against
host Date.parse, a long timestamp assembled across chunks, foreign/disposed guards,
output-copy isolation and redacted host-service failure. These are Node/V8 binding
results, not browser/device performance or production-client qualification.

The computation package remains **556,646 WASM bytes** in set `33a2d46728dc`,
with a byte-identical executable. The rebuilt project-only executable retains its size and unchanged glue. Its package includes
captured queries and nineteen wire commands; it is **1,446,376 bytes**, set `98ea88963183`, SHA-256
`098026fad2910da3677acfeb3e6ffa8d42bba00496be1284a548b494ae5b9d49`.
The project-only package also exposes guarded Open/reset, clipboard/full-record
command upload and one-use staged submission. Production worker scheduling and editing UI are separate.
Both manifests bind **222 source inputs**, exact output hashes and explicit feature
selection. `build-wasm.py --project`, `package-browser-core.mjs --project` and
`verify-artifacts.py --project-wasm` operate on the separate package. Workbox
excludes `core-project/**`; neither preview nor static-shell inventory adds it.
The production web build, offline inventory checks and unchanged bundle budgets
pass: main JavaScript is **2,127,027 bytes**, total JavaScript **10,477,565 bytes**.
The generated Kotlin options pass two directly compiled JVM/JUnit tests.
The real JNI/Java/Kotlin replay described below provides separate host execution
evidence; neither check establishes fresh Gradle assembly or Android runtime behavior.

Workspace tests with all features, optimized project tests, strict all-target /
all-feature Clippy and formatting pass. The project crate checks for wasm32,
Android ARM64 and Android x86_64. Both direct JNI builds pass with all 92 project
exports and 16 KB ELF LOAD alignment. Existing APKs predate the project JNI
implementation and do not qualify these binaries; fresh packaging/alignment
verification remains required.
Generation/package verification and workflow actionlint pass. The redacted source
scan finds no secrets across **1,957 UTF-8 sources** (six NUL-normalized).
The generic-key rule flagged four copies of the generated filament-policy source
checksum. Each was verified against that file; the exception requires that exact
SHA-256 and an artifact-manifest path. Positive controls still detect a different
synthetic value in the same manifest and the known digest outside those paths.
The separate archive crate adds five locked
compression/checksum dependencies; the session bindings add none. A cached Cargo
audit using the 2026-10-03 advisory snapshot finds no vulnerabilities across 66
dependencies and 1,290 advisories. Fetching a fresh database still fails; the
cached run skips registry yanked-version checks and is not a full online audit.

The store/command/session/input/binding update is not fully qualified. The browser
HTTP smoke cannot bind localhost (`EPERM`). The new no-listener browser runner
also fails before startup because Chrome Crashpad cannot create its socket; no
browser replay result is claimed. Gradle cannot obtain a usable wildcard IP, npm
audits fail DNS (`EAI_AGAIN`), and the inventory's Node/Git subprocess is unavailable.
The latest web quality attempt passes static checks and reaches unit/slicing tests,
but network simulator tests fail on localhost binds and the run is stopped at its
300-second bound (exit 124). It is not a passing full gate. Fresh Gradle/lint/emulator,
browser/deployment, inventory and online-audit checks remain required. These changes
remain uncommitted. Earlier passing full gates
do not qualify this update.

Production browser worker transport/subscriptions, Android app integration and
runtime qualification, bounded renderer/tree projections, browser export task isolation,
production open/reset/import integration, crash recovery and other command families remain unimplemented.
No production browser session switches authority, no Android editing UI is enabled,
and no migration phase exit gate is closed.

Android now exposes the same Rust project session through **92 JNI exports**
and Kotlin AutoCloseable owners. Java declarations generate only the JNI export
signatures; handwritten Rust handlers retain the domain behavior and its shared
request/host contracts. No third-party dependency was added. The JNI registry
admits at most **four upload/prepared-document/session owners** and **4,096 total handles**, with
positive IDs that never wrap or get reused. Upload-to-session transfer changes the
existing owner slot in place; it needs no fifth document permit. Kotlin consumes
an upload on every open failure as well as success.

Result capacity is reserved before a command can commit or leave the queue.
Saturating the registry refuses execution without losing its queued request;
freeing capacity allows exactly one commit with the original ordered effects.
Reply-to-effects conversion now changes the already reserved slot in place; it
requires no second handle permit. The reply wrapper is consumed and the effects
wrapper becomes the sole owner of that ID. The former type and repeated conversion
refuse without consuming the effects. A real-JNI saturation regression reproduced
the prior post-commit allocation failure before this fix and now preserves both
the confirmed receipt and effects with all 4,096 permits charged.
Registry locks cover lookup/publication only. Per-owner try-locks refuse raw JNI
concurrency or callback reentry. Close immediately invalidates lookup without
waiting for native work, whose retained reference keeps memory/admission alive.
Kotlin rejects late results and releases late captures. A mutation racing close
may already have committed; the host must treat a missing acknowledgement as an
uncertain outcome and must not retry it automatically. Captures and copied arrays
remain usable after their original session closes.

Raw JNI checks input lengths before copying: at most 64 KiB per byte chunk,
131,072 UTF-16 units per selection input, exact options/nonce array lengths and
the shared request string budget. Output reads own Java arrays, bounded to
64 KiB or 16,384 UTF-16 units. No native pointer escapes. The explicit buffered
JSON/metadata export methods still allocate complete bounded buffers. The separate
JSON writer streams canonical bytes through a synchronous Java sink, with a 64 KiB
native output buffer and an explicit total-byte limit. This bounds output staging,
not serializer metadata traversal or destination memory. Local JNI references are
released per chunk; callback exceptions are cleared and reported without private
exception text. Closing the snapshot stops subsequent chunks, and reentry on that
snapshot refuses. Effects must be dispatched before the
wire acknowledgement, including failure/rollback effects. The binding does not
install subscriptions or a second project authority.

The Kotlin `ProjectActor` now provides an exclusive asynchronous command/query,
guarded Open/reset, clipboard, save/export and staged-command owner. One authority executor performs commits,
two preparation workers admit documents, capture clipboard data, stream exports or
seal command uploads, and one ordered delivery executor consumes effects before
completing requests. The total admission ceiling is 32, including preparations and
undelivered results; a slow projection consumer therefore applies backpressure.
It copies bounded typed request data before enqueueing and allocates wire IDs in
execution order, with a checked nonce/version/budget handshake. It adds no dependency.

Queued/preparing cancellation prevents publication and releases native resources.
Once an edit is executing, cancellation refuses; close reports a lost active result
as uncertain and never retries. Already confirmed edits remain completed even when
projection delivery fails or the actor closes. Callback code must return promptly,
observe its application lifetime and never wait synchronously on another request
from the actor. Close releases native owners without waiting for JNI; completion
notification drains after any active callback returns. Finished request tickets
release their cancellation closure, and close releases the projection listener.
Prepared Open results retain their source/operation guard until final commit.
Reset checks export identity, allowing history-only changes and preserving pending
Open on failure. Completed Open/reset without bounded summaries remain explicit
completed outcomes. Ordinary typed message capture keeps the existing wire limits;
bulk commands and reset instead use an opaque actor-bound guard containing monotonic
project/history revisions and the asset fingerprint. It retains no full ID, native
handle, source graph or actor closure. All project/asset writes belong to the actor
and publish a project revision; adding another writer would invalidate this proof.

Bulk preparation checks that proof before creating the original native local guard
and an immutable source snapshot. Producers borrow the snapshot and an ordered
chunk writer, with explicit per-input budgets. Sealing runs on a preparation worker;
final admission/execution rechecks the native guard and consumes the input exactly
once. Ready references never escape and release on every settlement. Finished-pool
limits are explicit and default to zero; native limits independently bound four
active/queued uploads across all sessions. Scope cancellation drops input handles
and source captures even when a producer ignores cancellation. Writer calls after
the callback returns refuse. Source captures are for preparation, not a live UI model.
The startup worker warms immutable asset metadata before transferring authority.

A returned guard is optional if a completed summary is unavailable and its separate
host capture also runs out of handles. This cannot turn a known native completion
into failure or uncertainty. Free resources and query for another guard; never
repeat the mutation to obtain one. Rich acknowledgements provide their guard
without allocating another native capture. Open/reset likewise preserve confirmed
adoption and ordered effects when no handle remains for the optional summary query.
They return their explicit completed-without-summary outcome, keeping the session
usable for a later query once resources have been released.

**Twelve shared JVM/device actor scenarios** run against real debug/release JNI:
ordered effects and undo, immutable submission and queued cancellation while a real
native timestamp callback blocks, bounded pending delivery, mutable future isolation,
stale/superseded/failed Opens, cancelled and late preparation cleanup, projection
failure, rollback before failure acknowledgement, close during delivery versus native
execution, invalid-generation startup, oversized summaries, and twenty repeated
open/edit/close cycles with no remaining actor threads. One concurrent optimized
full replay hit its 300-second deadline before actor checks; an isolated actor run
and the subsequent complete optimized replay passed without changing the deadline.
The Android instrumentation
source compiles against verified cached dependencies; it has not executed on Android.
These tests do not establish physical-device responsiveness or process-crash recovery.
**Sixteen additional real-JNI preparation scenarios** cover source capture and
thread ownership, twenty staged-edit/undo cycles with zero remaining pool charges,
queued/stale work, all four upload permits, cancellation, malformed/oversized input,
finished-pool refusal, rollback effects, close before/during commit, reset/Open and
history-only transitions, oversized IDs and post-commit handle exhaustion for
commands and both document-adoption paths.
A separate browser-authored **70-instance transaction** agrees with the actor's
complete acknowledgement and ordered effect kinds, then undoes/redoes as one entry.
These checks and the original twelve scenarios run in both native build profiles;
the latest complete debug/release replays pass after compiling into an empty class
directory. The build helper removes its generated output before compilation so
deleted or renamed classes cannot mask source errors. The shared Android
instrumentation source compiles but has no new device result.
Clipboard copy now checks a host guard before taking a native preparation and
immutable query source. Its selector and object/asset capture run off authority;
final publication checks the original native guard and latest copy/clear identity.
Failed or cancelled replacement preserves the previous completed clipboard, while
a failed newer request cannot revive an older pending copy. The actor owns one
current native clipboard. Results retain only its opaque identity and bounded
metadata. Paste attaches that data and a fresh destination guard before invoking
its producer; clear/replacement invalidates new uses of an old identity while
already prepared pastes keep their data. Clearing is ordered with authority work
and immediately supersedes pending copies. Closing releases clipboard/preparation
owners without waiting for a selector that ignores interruption.

**Thirteen additional shared JVM/device clipboard checks** cover twenty
copy/paste/undo cycles, failed/newer/cancelled/stale copies, the shared four-owner
quota, clear/replacement during paste, upload cancellation, foreign identities,
close/late-result cleanup, invalid inputs and disabled staging. Raw JNI conversion
also succeeds after source closure at full handle capacity; repeated conversion
refuses without damaging the completed clipboard. Both complete debug/release JNI
replays pass these checks. Two independent TypeScript
fixtures compare complete acknowledgements and ordered effects, including sorted
plate selection and clipboard clear after upload capture, followed by undo/redo.
Subscriptions and composition into the application's complete editing workflows
remain open. These checks do not qualify Android device responsiveness.

Save/export now freezes an admitted project and its exact immutable asset version
together under the original export guard. The capture shares existing records,
follows canonical declaration order and survives reset or source-session disposal.
History-only changes preserve export identity. A preparation worker validates budget
options and checks asset-count and asset-byte limits, then lends a thread-confined
source to the host callback. JSON streams through JNI under its byte limit; assets
use bounded lease reads. Every
declared asset and the JSON document must finish before handoff can be confirmed.
The borrowed source refuses use after the callback returns or its scope closes.

Ordinary export preserves dirty state. Manual save acknowledges a checkpoint only
after the host callback confirms complete handoff and authority rechecks the captured
identity. Concurrent edits/reset produce a confirmed stale export without clearing
newer dirty state. Handle exhaustion preserves confirmed handoff as an unavailable
checkpoint; projection failure cannot undo an already confirmed checkpoint.
Queued/preparing work is cancellable. Once the destination callback begins,
cancellation refuses and callback failure or an unconfirmed close is uncertain.
Close releases native resources without joining the destination; host I/O must have
its own deadlines. A callback still in progress cannot be forcibly interrupted.
Archive encoding, storage-provider flush/close and durable publication belong to the
host and remain unimplemented; a callback's success alone is not proof of disk durability.

**Thirteen shared JVM/device export scenarios** pass complete debug/release JNI
replays. They compare streamed JSON against an independently generated TypeScript
fixture spanning multiple chunks, all UTF-16 units, lone surrogates, numeric edge
cases and unknown fields. Checks cover exact/insufficient budgets, redacted callback
failure, reentry/close, frozen assets after reset, retained-source refusal, twenty
edit/save cycles, concurrent edits during an actual output callback, history-only
changes, queued cancellation, incomplete output, handle exhaustion, close after
confirmed handoff and checkpoint projection failure. Rust also tests record sharing,
declaration order and retained bundle ownership after source disposal. The shared
instrumentation source compiles; these are host execution results, not Android
runtime, archive round-trip or storage-provider qualification.

`ProjectTimeZone` captures an explicit ZoneId. Rust parses timestamps using the
selected Chromium/Smi31 or Node/Smi32 profile, invoking the Java resolver only
for local civil time. Java LocalDateTime.atZone selects the earlier overlap offset
and shifts gaps forward by their length, matching the tested browser references
([Java API contract](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/LocalDateTime.html#atZone(java.time.ZoneId))).
A retained GlobalRef owns the service across calls. Callback exceptions are
cleared and returned as redacted timestamp_service errors, never invalid-data
results or a UTC fallback. Android timezone database versions still need actual
device qualification; desktop Java agreement cannot establish that.

The test-only JVM harness compiles the actual Java/Kotlin bridge with cached
tool JARs verified against Android's SHA-256 dependency metadata. The unchanged
project replay executes **1,380 requests / 1,306 groups / 60 traces** against actual
JNI in both debug and optimized builds, comparing full canonical contents,
ordered effects, history, selection, IDs, asset bytes/metadata and retained
captures. Additional checks pass **75 refusal cases**, **36,822 fixed-zone
validity cases** (6,137 strings × two integer profiles × three zones), **48
historical/DST cells**, and **nine Kotlin ownership scenarios** including reentry,
service failure, close during blocked work, late-result cleanup and retained query
captures. Owned bytes
survive JVM termination. These checks use a test-only stdin/stdout transport;
no such transport ships in the Android app. CI runs both build profiles.

The shared Kotlin owner scenarios and timestamp corpus also have Android
instrumentation tests. Their source is checked against the verified Android/JUnit
compile dependencies, but these new tests have not executed on Android for this update.
Existing instrumentation reports and APKs cannot qualify newly added entry points.
Application integration, projection subscriptions, archive adoption/encoding,
storage-provider handoff, crash recovery, remaining command families and Android editing remain
open. The development shell still does not expose project editing.

The captured query API uses a separate version-1 schema, generating Rust enum
codes and TypeScript/Kotlin numeric packet validators. Its **nine node kinds**
cover project, plate, object, volume, instance, layer range, physical/mixed
filament and source asset. **Eight child relations** expose bounded hierarchy
pages, numeric inspector/transform data, local/effective filament IDs and authored
mesh declarations. Each capture owns one immutable admitted revision/hash;
private positional addresses never authorize commands or refer to a newer graph.
Captures can be read after session disposal and without retaining their original
parent handles. They share graph ownership instead of serializing it.

Pages contain at most **64 rows**, below **64 KiB** of finite numeric data. Text
is read separately in at most **16,384 UTF-16 units**, preserving lone surrogates,
NULs and optional absence versus empty text. Canonical IDs are never truncated
to fit a row. Plate lists sort by order/UTF-16 ID and layer ranges by minimum Z/ID,
matching the browser Objects projection; other children retain canonical order.
Sorted lists check a caller-supplied entry limit before allocating an index.
Unsorted lists allocate no index, and field/page reads do not walk configuration
values, paint payloads or geometry. Sorting is synchronous work for an owned
projection executor, not UI/authority-thread work. Source offsets and strides
retain the admitted document's authored values, including accepted fractional
metadata; GPU buffer validation remains a separate requirement.

The independent query corpus reads the TypeScript model/selectors and checks
ordering against the Objects projection. It compares **5,987 nodes across 365
admitted captures**, including every retained session-corpus state, optional
fields, numeric extremes, inherited filaments, wide lists and lossless text.
Rust debug/release tests also exercise exact page/text/sort limits, invalid
fields/relations, retained revisions and disposal. The actual binding replay
loads **356 complete bundles / 5,736 nodes / 3,295 pages** and exercises **57,436
query refusals**; the other nine captures have no attested payload fixture and
remain library-only evidence. Copied numeric arrays survive caller mutation and
text survives native-handle release and host termination. TypeScript and the
actual Kotlin decoder each accept all **5,987** reference packets and reject
**7,576** malformed packets. Tests cover missing, duplicate, unknown and unordered
fields, invalid codes/numbers, page counts/lengths and mixed node kinds. Atomic
mesh-field groups, index/stride dependencies, mesh-kind discrimination and exact
component-count bounds reject partial or contradictory declarations.

The synthetic query allocation probe retains **1,897,256** declared triangles,
**100,000** painted facets, an **8 MiB name** and an **8 MiB settings string**.
Two hundred metadata/page/text cycles allocate **6,817,600 bytes** total, largest
**32,768 bytes**, with **zero payload-sized allocations**. An explicit settings
export makes one 8 MiB copy as a positive control. These are library ownership
measurements, not Android latency/residency budgets. Full tree presentation,
paint summaries, resolved settings, capability queries, renderer packets,
revisioned subscriptions and production worker/JNI integration remain open.

The browser now has a transitional `AsyncEditorSession` over its TypeScript
authority. Undo/Redo, plate lifecycle, object/part rename, instance printability,
single/batch transforms and six object lifecycle controller routes await
acknowledgements; guarded queued execution,
bounded callback-free batches and ordered summary queries are available for
incremental migration. Project, asset and history guards prevent stale work from
silently applying to a newer edit. These payloads use the generated intent
contract below; the TypeScript command bus remains authoritative. Generated
session messages now serve these operations through an in-process string adapter.
Derived placement actions await their transformations. DOM/XR gestures retain
one dispatched edit and one latest pose, chaining only actual receipts; selection
lifetimes catch even same-task away-and-back selection changes. Cancellation is
cooperative and never retracts a committed edit. Multi-instance printability
keeps separate undo entries and reports partial completion. Selected deletion,
plate clearing, cut and instance conversion await their registry actions;
independent duplication and plate movement also have async controller APIs.
Duplication returns an immutable captured result even if the object is renamed,
moved or disposed before acknowledgement arrives. Cut completes its clipboard
copy synchronously and retains it on failed/uncertain deletion; later replies
never replace clipboard UI state. Even a throwing clipboard subscriber cannot
abandon the pending deletion receipt. Regression coverage includes 57 canonical
edit/gesture cases, 60 lifecycle controller cases, 222 registry/surface
acknowledgement cases and 56 real-workspace presentation cases, including delayed
delivery and disposal. All 33 workspace/action test files pass; the final action
and presentation cases, XR-event/menu regressions,
TypeScript check and production rebuild also pass. Offline and bundle
budgets remain satisfied, with a 2,117,624-byte entry and 10,453,184 total JavaScript
bytes. These host tests do not qualify browser controls or XR hardware.
Numeric transforms, DOM/XR drags and DOM lay-on-face now use explicit registry
surfaces. The result-bearing API retains actual command receipts and availability
reasons; ordinary actions delegate to the same boundary. Twenty-one registry
routing cases check declared/undeclared surfaces, denial, receipt identity and
failure propagation. A production XR drag regression also fixed a record-identity
check that suppressed movement: projected model records are rebuilt on each read,
so membership now checks the stable instance ID and mounted scene node. Remaining
editing/import/save/slice migration, remote projection contracts,
production worker/JNI project integration, crash recovery and remaining Rust command
implementation remain
Phase 1/4 work. The maintained details live in
[project contracts](project-contracts.md).

`contracts/project-intents.json` defines nineteen prepared commands and
batches of up to 64 operations, plus versioned session requests and replies.
`generate-project-intents.mjs` emits TypeScript
readonly types with immutable capture, Rust owned types/converters and Kotlin
sealed types/encoders/decoders. The restricted schema rejects unsupported features
rather than ignoring them. Formatting uses a temporary Rust file, and schema
mutation tests capture diagnostics in files; this avoids restricted-host child
pipe operations without relaxing rustfmt or mutation assertions. ASCII JSON
carries all user text as UTF-16 integer
arrays; existing project encoding and semantic hashes do not change. Structural
validation is distinct from stable-ID and project validation in the executor.
The browser production plate path now submits these intents through the existing
asynchronous facade through serialized request/reply envelopes. A captured batch
maps to the original atomic transaction. The connection negotiates protocol,
project schema and intent versions, binds a separate 128-bit generation nonce,
rejects duplicate/out-of-order request IDs, and carries exact project/asset/history
guards. Ordered queries, acknowledgements, bounded error enums, cancellation and
close are shared message types. Both ends bound pending operations; close/cancel
have a control lane. Local owner tokens are checked before conversion and never
cross the string boundary. No transport nonce consumes project ID entropy.

History display labels include explicit truncation flags; the canonical bus keeps
full labels. An undo that restores a project ID beyond the message budget reports
an explicit completed-but-summary-unavailable outcome, never a rejection implying
rollback. Lost/malformed/foreign replies fail the client closed without retrying
an uncertain edit. After-commit cancellation or close cannot retract a valid
acknowledgement. The host still owns reconciliation and transport liveness.
Selection, capabilities and rendering remain canonical local subscriptions;
this adapter is not a production worker or JNI project executor.

All three decoders bound input bytes, value nodes and nesting, reject duplicate,
unknown and missing fields, and require objects rather than positional arrays.
Numeric fields use binary64 value semantics, preserving accepted decimal/exponent
spellings and normalizing negative zero. Added and renamed plate names retain their
existing 160/120-unit limits. New entity names and gestures use the aggregate
request budget, with constructor-level whitespace/empty checks. Transform arrays
require exactly 3/4/3 finite binary64 values; domain admission checks validity.
Plate order retains large finite integral values
above the safe-integer range. Local TypeScript capture rejects accessors,
custom prototypes, symbols and non-dense/extended arrays without invoking getters.
It freezes its owned copy before constructing commands; a preparation encoder
bounds aggregate UTF-16 allocation before the completed request is captured. Neither a caller changing
an intent nor a failed batch can redirect an accepted edit or change immutable
asset ownership. The schema's resource limits are transport limits; larger
persisted identifiers have not been redefined as invalid domain IDs. Android
`JsonReader` strict mode was observed accepting `1.` on API 34. Project protocol
JSON now uses a portable Kotlin structural parser and the shared lexical check;
G-code metadata retains its Android reader plus that lexical check. The portable
parser preserves escaped UTF-16 keys, rejects decoded duplicate keys and requires
exact JSON structure under the existing byte/node/depth limits. It is not a persisted
document parser. Metadata strings and cancellation retain their existing behavior.

A root the contract lists under `bulkRoots` decodes and encodes under its
`bulk` tier instead (16 MiB, 4,194,304 nodes, 12 levels): a printer's own
replies decoded, such as a storage listing of a folder of thousands of files,
which no edit intent ever approaches. The tier is a parameter of the same
three parsers and writers (`parse_bounded`/`encode_bounded`,
`ProjectIntentJson.parse(text, BULK)`/`ProjectIntentWriter(BULK)`,
`bulkLimits`), so a bulk root is no less strict, only larger. An array may
exceed the default node bound only where bulk roots alone reach it; the
generator checks every other root's reach and its mutation test covers both
rules.

The command/session corpus contains **969 independently authored raw cases**,
replayed by TypeScript and host Rust. The earlier 673-case corpus ran through
compiled Kotlin on API 34; the expanded decoder corpus has not run on Android.
The actual portable Kotlin codec now replays all 969 raw cases on the host JVM,
plus independent TypeScript comparisons of structural/escape/budget mutations and
all 65,536 UTF-16 units: **241 accepted round trips / 1,224 refusals** in total.
Actual generated Kotlin writers pass **220 numeric cases** and **74 nonfinite/
shape refusals** on the host JVM, including subnormal/extreme values, signed zero
and UTF-16 identifiers. Twelve lifecycle writer cases additionally preserve
absent/value options and UTF-16 names/IDs. Four staged-reference boundary cases
and six invalid-ID refusals cover the new Kotlin session writers. These are host
codec checks; Android instrumentation/runtime qualification remains separate.
Separate checks round-trip all 65,536 UTF-16 units, reject node/byte/depth
exhaustion and malformed typed output, and reject **33** unsupported schema mutations.
Nineteen transport regressions cover negotiation, request replay, immutable
payloads, stale guards, cancellation/close races, lost/corrupt replies, backpressure,
bounded history, completed outcomes without summaries and owner isolation.
The 40 production-controller plate regressions retain distinct add/rename limits;
a session regression preserves plate order above the safe-integer range. A failed
prepared batch restores project/selection/history/assets, while later valid work
and empty batches retain the original behavior. The earlier codec-only revision
passed workspace Rust tests, format, strict Clippy and Cargo audit. At that
revision, both Android ABIs, debug/release APKs, strict dependency verification,
unit tests and lint passed. The owned emulator passed 24 core instrumentation
tests (including three Kotlin intent tests), three
cold starts, three renderer pixel/lifecycle tests and the separate non-XR startup.
This is 4,096-byte-page software-emulator evidence, not ARM64 or physical XR
execution. Those earlier codec checks do not execute the newer project WASM/JNI
session bindings described above.

That earlier browser set `9fdb6e51878b` contained 556,646 WASM bytes and bound
67 core source inputs. Its actual browser WASM run covered all 269 canonical vectors,
10 malformed inputs, 48 canonical envelopes, 98 G-code sources/358 windows,
4,554 view queries and 30 G-code request cases. Both APKs verify matching source
and output identity with every native library 16 KB ELF/ZIP aligned. The command/session
corpus exercises host TypeScript/Rust and Android Kotlin; it does not
claim Rust project execution through those existing WASM/JNI computation APIs.
The archive worker now shares its pure codec modules with the app build, with a
strict entry signature preserving context startup and independently owned worker
instances. The offline graph includes archive dependencies and the static cache
moves to shell-v4. This removes duplicate codec code without relaxing bundle
budgets. The final redacted source scan covers 1,672 UTF-8 files (six normalized
for embedded NULs), with no findings. Workflow actionlint, generated binding and
fixture checks pass; hosted CI remains unqualified. The complete repository gate
passes against the final source/artifact set: 267 web unit-test files, 97 project
test files, browser/offline/recovery/accessibility and pseudo-localization checks,
HTTP/HTTPS server deployment fixtures, real slicing, artifact verification and all
three full npm audits. Main-entry size is 2,101,384 bytes; total JavaScript is
10,436,886 bytes under the unchanged 10,600,000-byte ceiling. These checks qualify
the local TypeScript transport and codecs, not native project execution or XR
hardware behavior.

The migration inventory binds action source files to an existing Git commit.
Commit an action-source change before regenerating it with `inventory.mjs --write`.
The inventory JSON is also an input to shared-core provenance, so refresh the
WASM/JNI build manifests and packaged browser asset set through their normal
build tools afterward. Byte-identical executables still need manifests that bind
the updated input. The asynchronous history and plate updates preserve all 226
action records and native capability states. The plate update bound source commit
`ae4c6ab`; browser set `e8e625f7c1b2` contained the same 558,264-byte WASM.
Rebuilt WASM/glue and both JNI binaries were byte-identical, and the
debug/release APKs verified against that input manifest with both ABIs and every
packaged native library retaining 16 KB ELF/ZIP alignment. That asset set
passed the production browser, startup, recovery, worker, offline and static-host
preview suite; bundle budgets passed at 2,269,279 main bytes and 10,586,871 total JS
bytes. The source change passed the complete repository gate before this metadata
refresh. No Android runtime behavior or physical-device qualification is inferred
from the metadata checks.

`contracts/core-protocol.json` owns the initial **stateless canonicalization
request**. The generator emits Rust request deserialization/validation, TypeScript
types/validation, and Kotlin request types/validation. Regeneration must be clean.
Its Rust decoder explicitly requires a map: deriving Serde struct deserialization
also accepted positional arrays even though the schema and host validators require
objects. All four named fields must occur exactly once; unknown fields are rejected.
Protocol versions retain numeric value semantics, including `1.0` and `1e0`.
This envelope rule is separate from the inner JSON input's last-key-wins semantics.
It is a deliberately limited schema subset; unsupported schema constructs must
fail generation. The prepared project/session schemas above cover the initial
plate/history boundary; remaining commands, projection deltas and actual
production worker/JNI project integration in Phase 1/4 remain open. The G-code packet layouts below are
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
at web commit `ae4c6ab`, including handler presence, surfaces, exclusions, shortcuts,
automation identity, capability reasons, and existing evidence references.
The web registry reports 219 partial and 7 unavailable actions; those limitations
are preserved. Every native workflow remains unavailable. Source hashes include
the parity report and the existing settings/profile/localization authorities.
These assets are not yet consumed or bundled by the native shell. On web scope
changes, commit the web authority first and explicitly regenerate the inventory;
CI rejects silent inventory drift. The current uncommitted transform routing
adds inspector/scene surfaces to that authority. Regeneration still requires a
committed source tree and is pending while Git metadata is read-only here; the
historical inventory is not evidence of current surface coverage.

## Packed mesh codec and canonical bounds

The project crate now admits a mesh view over an immutable asset lease. Repository
admission already checks byte length and declared FNV digest. The mesh step validates
buffer extents, finite float32 coordinates, uint16/uint32 indices, triangle counts
and vertex references under explicit byte/count caps. It supports little-endian
unaligned/interleaved views, extra position components and non-indexed meshes.
Layout arithmetic remains in the safe-integer domain before narrowing actual
addresses; an unused large stride stays valid on wasm32. The view owns no decoded
vertex/index arrays. Cloning it retains the immutable record and validation proof,
including after repository release. Random access and iterators borrow those bytes.

Packed authoring accepts float32 or float64 coordinates and optional uint32 indices.
It bounds supplied metadata before copying, allocates one output buffer and computes
the canonical FNV digest while writing little-endian fields. It preserves UTF-16
IDs/filenames/provenance, optional-field behavior, float32 rounding and signed zero.
Explicit expanded positions are a separate operation with their own byte cap.
Cancellation discards private output; errors expose typed reasons without source data.

Canonical instance bounds read a captured typed graph and asset snapshot. They check
full descriptor agreement, known unique instance IDs and optional volume roles,
cache validated views per asset and visit every source vertex, including unused
vertices. Volume TRS precedes instance TRS with the browser's quaternion normalization
and arithmetic order. The result uses exact transformed vertices, without a
box-corner approximation or transformed vertex buffer. Selected-instance, unique-asset
and total transformed-vertex limits are explicit. Mesh loops poll cancellation;
graph scans/full metadata equality still belong off live authority. These APIs
publish no state and infer no current revision or renderer ownership.

Independent production helpers provide **196 encoding**, **768 decoding** and
**146 bounds** cases. They compare exact descriptor/asset bytes, float32 bits,
triangle order, expanded positions, binary64 bounds bits and refusals. Cases include
strides, unaligned access, ignored non-finite extra components, large unused strides,
384 individual payload-bit mutations, extended UTF-16 metadata, randomized mirrored
transforms, tiny/huge quaternions, unused vertices and shared assets/role filters.
All six native debug/release tests pass, covering the corpus/source identity, explicit
caps, cancellation, output-copy isolation and lease/proof lifetime. The focused
browser codec/bounds/placement/export suites pass 96 tests across nine files. Reference generation and the
optimized allocation probe are included in CI.

The regressions also exposed two browser defects. A finite double could overflow
when stored as float32, creating an asset the decoder would later refuse. Bounds
could ignore an overflowed transformed vertex and return a finite undersized box.
Both now reject those cases; each new browser regression failed before the fix.
Ordinary finite mesh bytes and bounds are unchanged in the differential corpus.

The host probe uses **2,000,000 vertices**, **2,000,000 triangles**, a **48,000,000-byte
asset** and an existing **8 MiB metadata value**. Twenty validation/clone/bounds
cycles allocate zero bytes. Twenty canonical instance-bound queries allocate
**86,520 bytes total**, largest **1,160 bytes**, and no payload-sized allocation.
Authoring makes exactly one 48 MB output allocation per cycle; explicit expansion
registers one 72 MB allocation per cycle as a copy control. Every phase releases
all measured allocations. Source construction is excluded. These are host library
results, not Android residency/latency, native mesh-file import or GPU-buffer evidence.
WASM/JNI mesh bindings, production renderer integration, picking/region selection
and guarded editing workflows remain open; no Phase 5 gate is closed by this port.

## Shared archive container and canonical staging

`orcaxr-archive` owns ZIP/ZIP64 inspection, stored/DEFLATE reads and streaming output.
It uses pinned `flate2` with the pure Rust backend and `crc32fast`; the five added
packages and their license metadata are listed in [NOTICE](../../NOTICE.md).
It is a shared host library with checks for wasm32 and both Android targets;
no archive binding or production application integration is enabled yet.

An owner indexes a host-staged immutable seekable source. It checks archive length,
member count, local/central names and metadata, overlap, safe UTF-8 paths, entry and
aggregate expansion budgets and compression ratio before expanding payloads.
ZIP64 widens fields under the same limits. Paths preserve case, Unicode and percent
escapes without filesystem extraction. Member reads use 64 KiB input/output chunks,
check exact consumed/expanded lengths and CRC, and return redacted typed errors.
The end-directory scan allocates at most 65,557 bytes; index and decoder history
have separate bounded costs. Cancellation is checked around bounded I/O/decode
steps. Host providers need not seek: adapters must first stage them privately.
They also own I/O deadlines and must discard provisional output if a member fails.
Opening establishes only the directory proof; import must consume or verify every
member before publishing a project, including preserved unknown members.

The browser reference generator now covers **75 container cases** (17 accepted,
58 refused), **15 path cases**, and four shipped ZIP64 calibration archives whose
**16 members / 4,543,011 expanded bytes** match exactly by length and SHA-256.
The corpus exposed five malformed ZIP64 forms accepted by the old browser reader.
Both implementations now reject invalid record extents, nonzero record disk fields
and contradictory non-sentinel classic metadata, following the
[PKWARE format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
Valid archive output bytes are unchanged. The native reader also rejects an early
DEFLATE end with unconsumed claimed compressed data; this stricter malformed-input
check is tested separately from the browser acceptance corpus.
The corpus also exposed silent data loss in the existing browser writer: an exact
`__proto__` member became `0`. Authoring now passes a collision-free, same-length
ASCII alias through fflate's dictionaries and restores the local/central name bytes.
Data, compression, CRCs and offsets are unchanged; ordinary archives remain exactly
byte-identical. Independent header bytes, colliding alias names and a canonical
Open/Save round trip cover the fix.

Six debug/release native tests cover independent references, actual files, short
reads, cancellation, private I/O errors, dishonest expansion lengths and exhaustive
single-bit/truncation mutations of a small ZIP64 archive. Twenty complete read
cycles for synthetic 1 MiB and 16 MiB members retain no allocations and make no
allocation of 1 MiB or larger. The largest allocations are 65,536 and 65,557 bytes;
total allocations are 3,614,580 and 4,807,140 bytes. Fixture construction and the
preexisting compressed source are excluded. These results qualify host ownership,
not Android residency/latency, file-provider behavior or forced I/O interruption.

The **229-test** all-feature workspace run, final seven-test core-model suite,
strict Clippy and all **81 archive release tests** pass. The archive tests/probes and
three target checks are included in CI. The focused browser BBS/facet/ZIP64 suites pass
41 tests across four files, including the pinned casing corpus.
Both WASM executables and all six glue/declaration files remain byte-identical
to the qualified mesh build, retaining its complete Node-worker replay evidence.
Package manifests bind the new sources. Rebuilt host debug/release JNI and both
Android ABI libraries are also byte-identical to that qualified build. With all
285 JVM classes and 59 Java/Kotlin sources unchanged, its replay evidence remains
applicable: 1,380 session requests, 331 staged requests, 109 command uploads,
59 document steps and 57,436 query refusals, plus ownership/cancellation and Kotlin
actor checks. Both Android ABI outputs retain 92 project JNI exports and 16 KiB
LOAD alignment. Refreshed manifests bind all 222 workspace inputs. Numeric/XML
primitives and complete core-model authoring are host-tested and target-compiled;
no new archive binding is exposed.
Canonical-envelope staging now consumes that immutable archive and incrementally
feeds UTF-8 JSON into the shared bulk parser without retaining a complete text or
uncompressed member buffer. It strips exactly one initial BOM across arbitrary
chunk boundaries. Explicit byte/node/text/token/depth budgets apply; the current
native parser supports depth 128 and finite numbers. The archive layer rejects
unsafe JSON keys even in ignored envelope fields, then checks format/version,
legacy migrations, typed shape and semantic admission with the host timestamp
policy. Dense roots remain authoritative, including uniform-tree collapse before
final validation. Legacy false fuzzy assignments undergo a coerced validation pass
before removal, preventing malformed triangles/references from disappearing.
Only affected fuzzy assignment arrays are rebuilt; other typed graph data stays
shared. Timestamp service failures remain distinct from invalid documents.

Exact asset mapping membership and nonstructural safe paths precede payload
allocation. CRC/length and supported FNV digests are checked before moving owned
buffers into immutable records. Unsupported digest schemes produce declaration
ordinals for host warnings, rather than false verification. Declared blob members
must match their referenced bytes through bounded comparison writes. All remaining
members, including unknown ones, are integrity-checked to a sink. Cancellation or
failure drops private staging. Successful staging retains the entire archive for
later OPC/BBS reconciliation and unknown-member adoption; it exposes read-only
state/assets and verified member reads. The raw intermediate cannot be adopted;
the consuming completion step below must succeed first.
Hosts must schedule synchronous admission/hash/digest work off live authority.

Production browser envelope, asset and blob helpers provide an independent
**109-case reference (46 admitted / 63 refused)**. Complete state, UTF-16 IDs,
asset descriptors/bytes, migrations, unsupported-digest ordinals, mappings and
retained member SHA-256 values agree. Full-browser-import acceptance is recorded
separately: one admitted UTF-16 envelope fails later XML projection. The reference
does not equate partial admission with a completed import. Five native integration
scenarios cover these references/source identity, budgets/service failures,
cancellation/source ownership and corrupt unknown members. A separate unit test
splits BOM/UTF-8/escapes at every byte boundary. The optimized allocation probe
performs twenty successful and twenty late-integrity-failure loads of an 8 MiB
asset plus matching blob and unknown members. Each run allocates that payload once,
with zero retained allocations after release; each twenty-cycle phase allocates
186,853,760 bytes total. Input construction is excluded. Reference regeneration,
all archive tests, the probe and target checks are in CI.

OPC reconciliation now reads root/model relationships and content-type metadata
through a bounded streaming compatibility scanner. Explicit part/tag/record/text
budgets include ignored and overwritten input. Strict incremental UTF-8, duplicate
attribute/relationship checks and numeric entity validation precede metadata
merging. The scanner intentionally matches the existing browser tag extraction
(including legacy comment/prefix handling); it is not a general XML or BBS parser
and never loads external entities. Missing internal targets produce preserved
warnings. A consuming canonical step applies the merge and re-admits the graph;
failures discard the intermediate, while all original archive members and asset
records remain owned for the later import stages.

### Bounded foreign model staging

The first foreign-model seam is a separate bounded streaming XML admission scanner
in `bbs::read_xml`. It validates UTF-8 across writes, XML characters/entities,
well-formed tags, namespace bindings and expanded attribute uniqueness under
caller-supplied byte/text/token/element/attribute/depth limits. It streams borrowed
tag/text events and bounded ignored-span events rather than building a document
tree. Events are provisional: callers must discard them if `finish()` reports any
input, cancellation or visitor failure. The production-browser-derived corpus
contains **466 cases (319 admitted / 147 refused)** and binds the browser source
hash; Rust also checks arbitrary split boundaries for representative multibyte,
entity, comment, CDATA, PI, namespace and BOM input, plus independent resource and
cancellation failures. The reference generator and scanner test run in native-core
CI. Its events also expose expanded element/attribute namespace URIs and local
names while retaining original qualified names. An additional browser-authored
xml validator and ZIP-writer hashes and runs in native-core CI. A native integration
foreign archive corpus stores **fourteen exact ZIP inputs**, complete expected state,
asset descriptors/bytes, warnings and preserved entries for seven accepted projects,
plus seven refused inputs. Its generator binds the production serializer, parser,
xml validator and ZIP-writer hashes and runs in native-core CI. A native integration
XML validator and ZIP-writer hashes and runs in native-core CI. A native integration
test reopens the exact ZIP bytes, verifies every member, and streams every model
part through the XML scanner; it keeps XML syntax refusals distinct from the
semantic model refusals recorded by the browser. `read_xml::part::Builder` now
projects the structural vocabulary of one model part under explicit object,
vertex, triangle, component, build-item, material, title and facet limits. It
handles unit-to-mm conversion, browser-order Float32 geometry, local numeric
object IDs, 12-value transforms and Production Extension path attributes by
namespace URI. It decodes BBS color, support, seam and fuzzy-skin roots into sparse
canonical channels, including the legacy `paint_fuzzy` alias. Color slots use
explicit `import:3mf:paint-slot-N` placeholders until BBS metadata can resolve
actual printer filament IDs. Unknown extension attributes on objects, components,
build items and facets are retained under package-wide count/text budgets;
namespace declarations, standard fields and interpreted Production paths are
excluded. Resolved leaves carry source component-edge identities so expansion
does not copy these attributes per occurrence. The fixture checks browser-expected
extensionData, basic geometry/unit/component/build results, painted/refined facets,
invalid paint states, unsupported units and duplicate local IDs. `read_xml::graph::resolve`
validates all part-local object/build references and production package paths,
reports missing members/objects and cycles, and expands unique build roots under
part/object/reference/depth/expansion budgets while composing component matrices.
The foreign corpus exercises internal and external references plus missing-part,
missing-object and cycle refusals. These are structural parsing/resolution seams;
they do not yet parse BBS metadata/settings, map retained extension attributes
into canonical extensionData or construct an admitted canonical project.
`read_xml::package::read_model_structure` now connects them to ZIP staging.
It streams the root and referenced model members only, checks each member's
decompression/CRC receipt, shares geometry, title, encoded-facet, refinement-node
and annotation-materialization budgets across parts, and returns only after graph
admission. The foreign archive integration test runs all fourteen exact ZIP
fixtures through this path and checks aggregate split-part geometry/title,
facet byte/node/materialization and extension-attribute budgets, plus cancellation.
Canonical archive import still does not consume this structural result.

Reproduce the focused checks with:

```sh
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/foreign-bbs-vectors.mjs
CARGO_TARGET_DIR=/tmp/orcaxr-archive-target cargo +1.94.1 test --manifest-path core/Cargo.toml -p orcaxr-archive --lib --test xml_reader --test foreign_bbs_vectors --locked --offline --jobs 1
CARGO_TARGET_DIR=/tmp/orcaxr-archive-target cargo +1.94.1 clippy --manifest-path core/Cargo.toml -p orcaxr-archive --all-targets --locked --offline --jobs 1 -- -D warnings
cargo +1.94.1 fmt --manifest-path core/Cargo.toml --all -- --check
```

The same archive crate also checks for `wasm32-unknown-unknown`,
`aarch64-linux-android` and `x86_64-linux-android`.

`CanonicalArchiveSource::complete` now performs the full canonical-envelope path:
OPC merge, BBS regeneration/reconciliation, unowned-member adoption and final graph
admission. It returns a separate completed owner that can produce the existing
guarded prepared document. Full foreign BBS XML/3MF metadata and canonical
assembly, STL/OBJ/AMF import, application archive bindings and document-provider
flows remain unimplemented; bounded model-structure parsing and graph resolution
are library seams only.

The shared ZIP decoder provides bounded pull reads and an exact generated-output
comparison sink. Reading the declared byte count or finding an early mismatch
does not validate the remaining compressed input. Successful finish drains the
tail and checks CRC, expanded size and the DEFLATE terminal boundary. Errors poison
that stream attempt; the immutable archive can be reopened explicitly. Five
native tests cover browser ZIP references, varied chunk sizes, short/interrupted
I/O, malformed unread tails, cancellation and private-error redaction. Compressed
input FNV hashing matches all indexed browser references and four shipped ZIP64
files; it supplies deterministic import IDs, not authenticity verification.

Canonical completion validates every regenerated BBS output, even though only four
metadata members are candidates for preserved-original adoption. Comparisons use
bounded buffers without a full XML/JSON copy. Missing printable area permits the
browser's preservation fallback; shared SVG path/collision checks still run first.
The differential corpus exposed incomplete persisted SVG recipes accepted by the
browser when regeneration was postponed. A regression failed before correction;
browser envelope admission now checks the existing required field shapes, matching
native schema decoding while preserving valid recipes and unknown fields. That
check generalized: `assertProjectShape` walks every schema-1 record from a table
`generate-project-shape.mjs` reads out of the core's `record!`, `text_enum!`,
`number_enum!`, `bool_literal!` and `entity_kinds!` declarations, with the
special decoders (sparse assignments, mixed distributions, finite JSON) mirrored
by hand. It runs where native decodes: after the dense-refinement migration, on
the state with legacy false fuzzy-skin values read as painted.
`canonical-shape-vectors` holds every schema position deleted, nulled or
retyped, and `canonical::admit_state` meets the browser on all of them.

Unowned members follow exact UTF-16 path ordering, compressed-archive/path FNV IDs,
global collision suffixes, shared media inference, byte digests and provenance.
Standard plate PNG metadata uses the bounded header and declared plate order.
Original declared asset records retain their allocation identity; newly adopted
bytes move into immutable storage once. Explicit record/text/asset/warning and
regeneration budgets bound the operation. Final graph admission and prepared
bundle conversion remain on the preparation task; only the original Open/reset
guard authorizes publication to an existing session.

The independent production-browser corpus covers **385 archives**, with
**276 accepted** and **109 refused**. Complete canonical state, asset descriptors,
payload bytes, imported IDs and the full warning set agree without normalizing
the archive-derived IDs. Four native integration tests also cover original lease
identity, eleven budget families, cancellation, timestamp service failure and
real session adoption: a superseded Open preserves the old document, while a
current Open moves the admitted records and clears history. Edited archive
interchange has separate evidence below; application Open/Save remains unqualified.
The optimized completion probe performs five successful loads and five late final-
admission failures over one declared and one newly adopted **8 MiB payload**.
Each load allocates each payload exactly once; all original declared records
retain their identity. Success allocates **91,804,945 bytes** across five cycles,
late failure **91,747,240 bytes**, with **zero retained allocations** afterward.
Five equal and five early-mismatch comparisons of the 8 MiB member allocate
**675,005** and **1,002,685 bytes**, respectively, with a **65,557-byte** maximum,
no payload-sized allocation and zero retained bytes. Both comparison paths verify
the tail; a deliberate 8 MiB copy is detected. Source construction is excluded.
These host measurements do not qualify Android/provider residency or latency.
All **229 workspace tests**, **81 optimized archive tests**, strict Clippy,
formatting and wasm32/both Android target checks pass. Refreshed manifests bind
222 inputs; both WASM packages and debug/release host JNI plus both Android ABI
executables remain byte-identical to the previously replayed bindings. All 285
JVM classes and 59 Java/Kotlin inputs are also unchanged, retaining that evidence.
The focused browser BBS/emboss/ZIP files pass, including the new SVG admission test.
Edited canonical interchange has separate host evidence below; foreign import
and application Open/Save remain open.

Three deterministic OPC writers use an exact final member inventory, bounded
64 KiB provisional output, explicit byte limits and cooperative cancellation.
They validate XML characters, fixed root targets, duplicate emitted IDs and
required content types. Root and model writers share the validated import target
resolver, fixing lost query/fragment relationships on canonical Open/Save.
Nonstandard or absent filename suffixes receive per-part content types instead
of invalid default extensions. Import recognizes these inferred declarations
without adding user metadata, so repeated Open/Save preserves the canonical
fingerprint and unknown bytes. Explicit preserved declarations keep precedence. Each
writer validates only its own preserved metadata; a malformed content-type row
does not prevent an independent relationship projection, or vice versa.

`contracts/opc-lowercase.json` pins Unicode 16 default lowercase, including
expansions and Final_Sigma context. Generated browser/Rust tables prevent runtime
Unicode upgrades from changing persisted OPC declarations; member names are
unchanged. An exhaustive comparison found 28 scalar differences between Rust
1.94.1 and the established Node 22.21.0 reference. The shared implementation
(`orcaxr_project::js_math::case`, also the ports' `toLowerCase`)
matches all 1,112,064 scalars, 2,048 isolated surrogate units and 9,986 captured
contexts. Both contextual algorithms use linear scans and retain no full context
buffer. Generation independently verifies the pinned runtime's mappings and
Cased/Case_Ignorable properties. The algorithm follows the
[Unicode default casing context rules](https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/);
its data attribution/license is in NOTICE.

Independent production helpers supply **92 OPC cases (71 successful merges)**
and **30 target resolutions**, comparing complete state, ordered UTF-16 warnings
and exact XML bytes or per-writer refusal. Six native integration tests cover
references/source hashes, limits, cancellation, private I/O failures, consuming
canonical reconciliation and snapshot isolation. A scanner unit test exercises
all chunk boundaries, truncated/invalid UTF-8, long attribute-name failures and
single-byte hostile mutations. Browser regressions cover query/fragment targets
and three Open/Save cycles over unusual member names with unchanged project
fingerprints and payload bytes. Generated tables and references, native tests,
three target checks and the allocation probe run in CI; the runtime casing oracle
uses the pinned Node 22.21.0 contracts job.

The OPC allocation probe measures twenty consuming merge/revalidation/write
cycles with an existing 8 MiB UTF-16 metadata value and shared 8 MiB asset.
With exclusive metadata ownership it allocates 8,922,400 bytes total, no allocation
above 65,536 bytes and no payload-sized copy. Retaining an original project
snapshot deliberately requires one 8,388,608-byte metadata copy per cycle:
176,707,400 total allocated bytes, twenty payload-sized allocations. Both runs
release all measured allocations. Input construction is excluded; these host
results do not qualify provider staging, Android residency or task latency.

The BBS facet hex codec now shares the canonical facet computation trees.
Decoding requires nonempty uppercase ASCII hex, an explicit byte limit, a shared
aggregate node budget, at most one million nodes per root and 64 split levels.
Budget charges and callback order match the browser even after malformed input;
failed operations retain their spent budget. State zero is unpainted. The generic
wire codec covers states 1–255, with caller-owned channel/filament mapping enforcing
the color consumer's 64-slot limit, support/seam values and fuzzy-skin state.
Brim has no BBS wire attribute. Indexed sparse assembly validates only supplied
roots and collapses homogeneous splits into assignments; missing facets require
neither iteration nor allocated roots.
Sparse validation/collapse is synchronous; import owners must schedule it off live
authority rather than treating codec cancellation as interruption of that step.

Encoding borrows either a computation tree or persisted canonical JSON. It does
not clone/convert a second paint tree or large UTF-16 paint values. A depth-bounded
traversal stack and fixed 4 KiB buffer emit exact uppercase hex under an output
limit. Cancellation is checked during decoding, traversal and short/interrupted
writes. I/O failures expose only their kind; no host flush is invoked. All output
is provisional and must be discarded after error or cancellation.

The unchanged production TypeScript codec supplies **1,594 reference cases**,
**five shared-budget sequences**, **eight sparse imports** and a digest over all
**69,904 uppercase hex streams of lengths one through four**. Complete tree values,
remaining budgets, callback order, writer bytes and refusals agree. Sparse results
also match the browser's dense collapse for two million declared facets. Eight
native integration tests cover those references/source hashes, maximum node/depth
limits, malformed persisted trees, explicit byte budgets, cancellation, sparse
index/value validation, short writes and private I/O failures. Reference generation
and the optimized allocation probe run in CI with the archive tests/target checks.

Twenty sparse decode/normalize/write cycles with three explicit roots allocate
**27,360 bytes total**, largest **632 bytes**, for both two million and two billion
declared facets. Twenty borrowed writes with an existing **8 MiB** UTF-16 paint
value allocate **480 bytes total**, largest **24 bytes**, for each representation.
All phases retain zero allocations. A deliberate persisted-value clone registers
one 8 MiB allocation as a positive control. Input construction is excluded; this
is host evidence for these primitives, not full mesh import or device residency.

The BBS numeric/XML primitives now share the production browser's formatting
policy. Eight browser helpers were extracted without changing their syntax into
`bbsNumbers.ts` and `bbsXml.ts`; archive writers still call those same functions.
Rust formats mesh float32 coordinates into fixed stack text, retaining the first
rounded decimal precision that converts back to the original value. Generic
shortest-float32 output differs at some binary-power boundaries. The port uses
shortest length only as a precision lower bound, then applies the browser's
rounding rule, including decimal ties away from zero. Canonical doubles retain
ECMAScript formatting and normalize negative zero. Matrix projection preserves
V8's scaled compensated quaternion norm and operation order, with both 3MF's
column-wise 3x4 and BBS metadata's row-major 4x4 order. Zero/non-finite norms are
refused; the latter already fails canonical graph admission even though the raw
browser helper can silently collapse that invalid input to an identity rotation.

XML writes use a fixed 4 KiB buffer, explicit aggregate UTF-16 input/output byte
limits and borrowed text/mesh vertices. All single code points follow the
browser's XML 1.0 policy: malformed surrogate sequences, forbidden low controls
and U+FFFE/U+FFFF refuse output; valid astral values remain intact. Attribute/text
escaping is distinct. Cancellation covers traversal, every short/Interrupted
write and finalization. A failed writer stays failed even if the caller ignores
an earlier error. Drop never writes and finish never flushes the host. Output
remains provisional; the package owner must discard any emitted prefix on error.
No complete model/metadata writer or package publication is provided by this API.

Independent references cover **4,419 explicit float32 cases**, **9,351,846 sampled
float32 values** across all finite exponents and random bits, **2,884 double
numbers**, **2,070 transforms**, **322 XML strings**, and every code point from
zero through U+10FFFF (**1,112,033 accepted**, **2,079 refused**). They compare
exact text, matrix bits, stream hashes and refusals. Native tests also cover
aggregate budgets, poisoned finalization, cancellation after the last host write,
private I/O errors, short writes and explicit vertex rows. The numeric/XML
reference generators and optimized allocation probe run in CI. All eleven new
numeric/XML tests pass in debug/release. The focused browser BBS suites pass
37 tests across two files; the latest full web quality run encounters Git/localhost
permission errors and reaches the calibration-resource unit suite before its
300-second timeout (exit 124). Production build, offline inventory and bundle
limits pass.

Five writes of a borrowed **two-million-vertex mesh** each emit **116,727,266
bytes**, matching the independently generated browser SHA-256. They allocate
**zero heap bytes** and retain none. Twenty escaped writes of an existing **8 MiB
UTF-16 value** likewise allocate zero bytes. An intentional clone records exactly
8 MiB as a positive counter control. Source construction is excluded. This
qualifies primitive host allocation behavior, not complete model assembly,
Android residency or file-provider publication.

The standard core-model author now prepares an admitted immutable project and
captured asset leases, then streams the complete `3D/3dmodel.model` member. It
checks supplied asset membership and full descriptor equality, caches borrowed
mesh proofs, assigns numeric resource IDs in sorted-plate/object/volume order,
and projects physical plus enabled mixed material slots. Plate origins retain
the browser's printable-area syntax, stable plate ordering and arithmetic.
Volume component transforms and per-instance build transforms remain distinct.
Missing or malformed mesh bytes yield typed omission warnings; resource limits,
cancellation, unknown/duplicate supplied assets and descriptor drift refuse the
operation instead of silently omitting oversized data. This API publishes no state.

Paint preparation builds an explicitly bounded sparse index over assigned source
facets and borrowed refined roots. Whole-assignment arrays need not be ordered;
refined roots and whole assignments remain disjoint under graph admission. The
writer never allocates objects for unpainted triangles or clones refined trees.
Color uses the 64-state consumer limit, and an unsupported leaf omits its entire
refined standard root with a warning. Brim remains canonical-only. Extension
attributes borrow their original values; namespace allocation and rendered-name
ordering use UTF-16. Reserved attributes cannot override authoritative fields.
Regular duplicate names refuse output; repeated facet attributes retain the last
value, while illegal earlier values still refuse. Output reuses one attribute
scratch buffer across all triangles and streams mesh vertices directly.

Preparation bounds visited records, relevant UTF-16 text, explicit paint entries
and nodes, source mesh sizes and total output geometry visits. Full descriptor
equality and bounded sorting are synchronous and must run off session authority;
source ingress/capture limits remain necessary. Streaming has its own byte budget,
cancellable short/interrupted writes and provisional ownership. Typed warnings
cover core-model omissions; they are not the complete package metadata warnings.
The independent production browser supplies 212 complete-model cases: 172 exact
XML outputs and 40 refusals. They cover compact geometry, mirrored transforms,
multiple plates/instances, shared meshes, disabled/material-limit behavior, all
paint channels, refined and unsorted whole-facet paint, namespace sorting,
reserved/duplicate attributes, invalid XML and omitted geometry. Native tests
also cover full descriptor agreement, retained leases, explicit budgets,
cancellation, private host errors and the shared leaf/tree codec helpers.

The complete-model probe uses **two million vertices and two million triangles**
in a borrowed **48 MB** mesh, sparse paint and an existing **8 MiB UTF-16 extension
value**. Five preparations allocate **34,950 bytes total**, largest **1,160 bytes**;
five complete writes allocate **1,560 bytes total**, largest **192 bytes**. Each
write emits **239,309,686 bytes** with the same native SHA-256. Both phases retain
zero allocations and make no payload-sized copy; a deliberate mesh clone registers
exactly 48 MB. Fixture construction and graph admission precede measurement.
This large-output check compares repeated native writes; independent browser byte
agreement comes from the 212 reference cases above. Dense paint still needs its
explicitly bounded derived index, and unusually large facet attribute lists can
require bounded sorting scratch. These results qualify this host workload, not
Android residency, device latency or provider publication. The generator and
optimized probe run in CI; seven native core-model tests pass in debug/release.

The prepared model now also anchors five native BBS metadata writers: model
settings, layer ranges, layer events, brim ears and layer-height profiles. Model
settings share its resource IDs and sorted plate/instance membership; the other
object sidecars retain one-based object ordinals, including omitted geometry.
Configuration traversal borrows keys/values in UTF-16 order, flattens arrays with
the browser's semicolon rules and streams canonical JSON objects through a stack
escape adapter. Range filament assignments override the configured extruder;
object/part rows retain the separate declared-slot and configuration entries.
Layer events preserve actual operator G-code/messages and stable height order.

Emboss text/projection attributes preserve field presence, newline escaping and
the pinned vertical alignment names. Numeric text uses exact ECMAScript
`toFixed(6)`; emboss then converts that result back through Number/String, while
brim/profile files retain six decimals below the ECMAScript exponent threshold.
The browser regression exposed illegal XML controls/surrogates in emboss text
and drawing paths; both browser and native authoring now refuse them. Valid
emboss output remains unchanged. SVG gathering retains immutable drawing leases
in original plate traversal order. Shared paths require equal bytes, and all
structural paths are reserved even when a particular sidecar is absent. A missing
asset omits only its own part's reference; another part sharing that path cannot
supply it implicitly. Different available IDs with equal bytes may share a path.
Browser/native regressions reproduced the missing-source bug before correction.
The package owner separately reconciles the complete generated/preserved inventory.

Preparation separately bounds visited records, configuration nodes/depth,
UTF-16 input and drawing bytes. Each provisional member has an explicit output
budget and cancellable short/interrupted writes. Recursive configuration depth
is also capped at 128. Optional absent members write nothing. No settings payload,
text recipe or SVG bytes are cloned. Seven native tests compare **259 browser
cases** (**225 exact accepted member sets**, **34 refusals**) and **4,109 numeric
cases**, plus resource limits, captured drawing lifetime, cancellation and private
host failures. The reference generator and optimized ownership probe run in CI.

The metadata ownership probe uses a captured **8 MiB SVG drawing**, an **8 MiB
UTF-16 configuration value** inside a JSON-valued option, and an **8 MiB UTF-16
emboss recipe**. Five preparations allocate **25,040 bytes total**, largest
**456 bytes**. Five complete member writes allocate **zero heap bytes**; each
produces **41,944,424 bytes** with the same native hash. Both phases retain zero
allocations and make no payload-sized copies. An intentional drawing copy detects
exactly 8 MiB. Input construction/admission and core-model preparation precede
measurement; large-output identity compares repeated native writes. Independent
browser agreement comes from the 259 reference cases, and no device residency,
latency or file-provider qualification is inferred. This optimized measurement
includes the shared-path collision and drawing-source ownership indexes.

Native project-settings authoring now borrows the same frozen model and material
mapping. Its 98 per-filament vector keys are generated from the production browser
policy. Correct-length imported vectors win; other fields preserve local-value,
base-vector and first-defined fallback behavior, including the distinction between
undefined and null. Optional empty preset/vendor values remain distinct from
absence. Wipe towers use sorted plate order, include disabled tower coordinates,
and retain the first enabled rotation/filament with typed projection warnings.

The relative-extruder reset follows the production ECMAScript multiline grammar,
including CR, LF and Unicode line separators. It scans borrowed scripts with
cancellation in both line discovery and grammar matching, then streams any appended
reset without creating another script. Nested JSON-valued options are escaped
through a stack adapter; lone UTF-16 surrogates and controls remain JSON escapes,
independent of XML rejection. Preparation budgets records, configuration nodes,
depth, input text and derived values. Output is separately bounded, cancellable,
private and deterministic across short/interrupted writes and failed attempts.

Ordinary mixed rows retain largest-remainder percentages, stable UTF-8 FNV IDs,
legacy cycle patterns and approximate gradient/match warnings. Independent browser
tests exposed overflow for valid finite weights: `100 * weight` or a weight sum
could become infinite and generate NaN percentages or a zero gradient endpoint.
Both implementations now scale by the largest weight only when the original
calculation overflows, preserving ordinary rounding and canonical source values.
Exact FullSpectrum rows retain stored unsigned 64-bit IDs, offsets, flags and
gradient weights. Manual groups choose their engine pair from physical slot order
independently of UI mode, preserve bracketed slots above nine and derive the B
percentage from equal group averages, not a flattened token count. Four-decimal
rounding follows ECMAScript's exact double value, including ties and signed zero.

The production-browser reference generator covers **508 cases**: **507 exact
settings members** and the expected exact-recipe refusal above 64 physical tools.
It also captures the settings-specific warning subset and **4,108 double-bit
formatting cases**. Full package warning parity is not inferred from this subset.
The corpus includes all vector keys, disabled entries, null/absence fallback,
UTF-16 text and stable IDs, reset syntax, reordered plates/physical slots, huge
finite weights and randomized multi-group exact patterns. Both the generated key
policy and independent reference freshness are checked in CI.

Four native integration tests and one reset-scan unit test pass in debug/release.
The host ownership probe uses separate **8 MiB UTF-16 payloads** for nested JSON,
the reset script and a physical value reused by fallback, plus **8 MiB of exact
pattern IDs** (**524,288 tokens**). Five preparations allocate **20,420 bytes**,
largest **728 bytes**; five writes allocate **zero heap bytes**. Each write emits
**38,273,506 bytes** with the same native hash. Neither phase retains allocations
or makes a payload-sized copy; the deliberate copy control detects exactly 8 MiB.
Input construction, graph admission and model preparation are excluded. Large
hash equality covers repeated native output; independent browser agreement comes
from the 508 reference cases. This does not qualify Android residency, latency,
file providers or application Save. The full Rust workspace passes **229 tests**,
and all **81 optimized archive tests** pass. The archive compiles for wasm32 and
both Android ABIs; these settings APIs still have no WASM/JNI application binding.

Complete package authoring is described below. XML import/reconciliation,
foreign member adoption, native bindings, transactional application import,
file-provider publication and bidirectional edited-project round trips remain
open. Component authoring does not close a Phase 5 task or qualify native Open/Save.

Native ZIP/ZIP64 authoring now writes an empty private seekable destination from
borrowed member paths and a streaming producer. It validates every name before
output, sorts by UTF-16 units, applies the browser's already-compressed suffix
policy, and fixes UTF-8 flags, Unix permissions and the 1980 timestamp. Per-entry,
aggregate, output-extent and index budgets remain explicit. Each completed member
patches its own provisional header; footer success is distinct from the host's
provider transfer, flush/durability and guarded save acknowledgement. Cancellation,
short/interrupted I/O, producer failure and swallowed sink errors cannot produce
a successful receipt. Errors redact private names and host/producer messages.

The compressor collects fixed 64 KiB chunks, so producer chunking and flush calls
do not change bytes. It sync-aligns DEFLATE output and inserts empty nonfinal
stored blocks when necessary to satisfy the same reader ratio limit, following
[RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html) and the pinned flate2 Sync
contract. ZIP64 local fields are reserved under wide budgets; directory records
use the actual sentinel thresholds. No whole compressed/uncompressed member or
complete archive is retained. The host must schedule sorting/compression off the
UI thread and supply deadlines for blocking I/O.

Six native scenarios cover deterministic bytes, UTF-16 ordering, classic/wide
members, all output budgets, cancellation/error redaction and ratio caps including
1:1. Actual counts 65,534/65,535/65,536 cover directory sentinels. A virtual sparse
host streams a 4 GiB stored member, indexes its 64-bit lengths and reads a second
member beyond 32-bit offsets while retaining less than 1 KiB of header data.
The writer still checksums every input byte; this test does not claim 4 GiB
provider storage or Android memory qualification.

Independent production-browser and Python readers verify 74 emitted archives,
including Unicode/BOM/prototype names, payloads around the 64 KiB boundary,
compression suffixes, both header widths, highly compressible input and actual
65,535/65,536-member directories. They compare expanded lengths/SHA-256, CRCs,
metadata and ordering; compressed bytes need not match the browser compressor.
The regressions exposed stripped leading U+FEFF filename bytes and fflate's silent
truncation into a declared-size output buffer. Both readers now preserve literal
BOM names; the browser decodes verified members directly and uses one sentinel
byte to reject dishonest expansion with a matching prefix CRC. Discarded directory
payloads are still decoded and integrity-checked; a corrupted block regression
fails before this correction. Local-region
overlap checking sorts extents before expansion, avoiding quadratic work.
The 75-case browser reference includes these regressions.

The host allocation probe reuses an existing 8 MiB random payload for DEFLATE and
stored members and generates another 8 MiB zero member through a fixed buffer.
Five writes to an exclusive private file allocate **4,504,940 bytes** in total,
largest **85,196 bytes**, with **zero retained allocations or payload-sized
copies**. Each archive is **16,787,249 bytes** and has identical SHA-256 across
cycles; an explicit 8 MiB copy is detected by the positive control. Source
construction and post-write hash/integrity verification are excluded. These
are host allocator observations, not peak RSS or Android/provider measurements.
Independent reader comparisons use the separate 74-case corpus. The writer,
probe and independent decoders run in CI. Workspace **229-test**, optimized
**81-test** archive, strict Clippy, formatting and three-target checks pass.
This output library has no application binding. The first release run detected an older fixture embedded before the final
browser-reader correction; the affected debug tests and complete archive release
suite were rebuilt against the refreshed source hashes and passed.

Complete package authoring now combines those writers from one admitted project
and its exact immutable asset bundle. The ExportCapture adapter survives document
replacement and owner disposal without consulting live state or acknowledging a
saved checkpoint. Asset membership and full descriptor equality precede output;
supported digest/length attestation belongs to immutable repository admission.
Path selection matches UTF-16 asset order, preserved-member candidates, thumbnail
precedence and the browser's UTF-8 FNV fallback. A generated/preserved collision
streams comparison against the captured bytes instead of buffering generated XML.
Only four preservable metadata paths with the explicit preserve-original marker
can override differing generated bytes. Duplicate or structural aliases refuse.

The canonical envelope streams state directly through a fixed 64 KiB buffer,
retaining UTF-16 escapes and canonical ordering. It validates complete unique
asset mappings, safe paths, state nodes/depth, output size and forbidden object
keys. These are explicit host budgets, not device RAM qualification. Typed
warnings cover model/metadata/settings, unavailable filaments across every scope,
unsupported digests, opaque extensions, custom hooks, preserved originals and
dropped OPC targets. Full-package warnings replace the model's local unavailable
assignment notices; rendering/deduplication remains a host concern. Private
diagnostics stay redacted. OPC inventory stages intentionally match browser order.

Independent production-browser references cover **1,032 package cases**:
**937 accepted** complete expanded-member inventories and **95 refusals**. Native
tests compare every length/SHA-256, canonical mapping/envelope and warning set.
Warning comparison preserves UTF-16 units; parser-specific malformed-mesh prose
is normalized to omitted-volume identity and invalid-mesh category. Four package
boundary tests cover membership/full descriptors, sixteen budget failures,
nonempty destinations, cancellation across preparation/writing, short/interrupted
or failed I/O, input immutability, repeatability and captured-owner lifetime.
Three envelope tests independently cover byte identity, mappings, unsafe keys,
depth boundaries and output failures. Reference source hashes are verified.

The actual native-output example emits **947 packages**, including ten after
native command-bus rename edits. The production browser opens all of them, compares
complete state/assets/warnings with browser-generated equivalents and saves/opens
them again. Expanded member bytes agree exactly. Only newly imported opaque IDs
are normalized for this comparison: their specified seed is the compressed ZIP
hash, which differs between encoders. Existing canonical IDs are never normalized.
This proves native authoring and browser consumption, not native archive import
or Android application Save. The file-backed package allocation probe and these
independent checks run in CI; application bindings, provider publication and
application adoption remain open. Foreign import is described below.

The optimized complete-package probe reuses an **8 MiB SVG asset** in drawing and
canonical asset members, with separate **8 MiB UTF-16 configuration and emboss
values**. Five file-backed writes allocate **26,379,550 bytes total**, largest
**85,196 bytes**, with **zero payload-sized copies and zero retained allocations**.
Each ZIP is **16,859,744 bytes**, expanding to **71,311,249 bytes**, with repeated
SHA-256 `32d86656a4b46b9ceeaff4cb19162c2806bbe7530e469ef1d83a0165791469a9`.
The deliberate 8 MiB copy is detected. Source construction/admission and
post-write hashing/integrity checks are excluded. Independent browser agreement
comes from the separate reference corpus; this measures host allocator behavior,
not peak RSS, Android residency or provider/device performance.

### Complete foreign BBS/3MF import

`orcaxr_archive::bbs::foreign::import` completes a standard BBS/3MF package that
has no OrcaXR envelope, porting the production browser's `deserializeForeign` and
`importBbsCore`. It streams the root and referenced model parts through
`read_model_structure`, reads `project_settings.config` (JSON or legacy XML),
`model_settings.config`, layer ranges/events, brim ears and layer-height profiles
under one per-member byte limit, then resolves physical and FullSpectrum filament
identities, color paint slots, plate membership and plate-local origins, and
assembles the canonical state, mesh assets and SVG drawings. OPC metadata merges
before graph admission; the native BBS writer then decides which consumed members
the next save regenerates, every other member is adopted exactly like canonical
import (shared `adopt_unowned`, identical budget order), and the final bundle is
admitted again. The result is a `CompletedCanonicalArchive`; guarded adoption still
belongs to the host's Open/reset. Warnings are typed and carry the browser's exact
UTF-16 text, because several quote file content.

Metadata members are small and buffered, and the browser reads them with
case-insensitive regular expressions, `Number`, `parseInt`, `parseFloat`,
`String`, `trim` and a twice-applied `decodeXml`. `foreign::scan` and
`foreign::js` reproduce those exact match positions and conversions (Unicode
`\s`, ASCII-only case folding and `\w`, lone surrogates from numeric entities,
`String.fromCodePoint` range failures), so unusual but accepted files import
identically. The model XML itself stays on the validating streaming reader; the
browser's model regexes agree with it for well-formed parts. One documented
difference remains: native project-settings JSON is limited to 128 levels of
nesting (the shared JSON reader's maximum), where the browser allows 256.

Building the corpus exposed three browser defects, fixed in the same change:
an empty build (a new or cleared project) was rejected as contradictory plate
membership; an imported SVG drawing was returned without a `sourceAssets` entry,
so the next save dropped the part's drawing; and one layer event the canonical
model cannot hold (a color change without a tool, an empty custom event, an
out-of-range or repeated height) failed validation and made the whole archive
unopenable. Plate membership is now checked against the build list the import
actually parsed, drawings are declared, and unrepresentable layer events are
dropped with a warning while IDs keep their source positions.

`tools/cross-platform/foreign-import-vectors.mjs` records **956 archives**: every
browser-written package from the BBS model/metadata/settings and package-input
corpora with the `Metadata/orcaxr/` tree removed, eleven real Orca/BBS archives
shipped in this repository (FullSpectrum, Production Extension parts, calibration
models and parity fixtures) and eight authored metadata cases. Native import
matches **949 accepted** opens (complete state digests, or full canonical JSON for
real and authored cases, every asset descriptor and byte digest, and the sorted
warning set) and all **7 refusals**. The fifteen authored foreign references also
match complete state, and a cancellation test publishes nothing. Mutating one
warning string or one state field makes every affected comparison fail. Host
bindings are described next; application adoption, provider Open and STL/OBJ/AMF
import remain open.

### Archive Open and Save host tasks

A host chooses thirteen budgets in `contracts/project-archive.json` (archive,
entry and total bytes, entries, vertices, triangles, records, text units, paint
nodes, asset counts/bytes, warnings). `generate-project-archive.mjs` emits the
Rust decoder (`archive_layout`), TypeScript and Kotlin encoders; the decoder
refuses wrong versions, non-integral or out-of-range values and per-item caps
above their totals. `orcaxr_archive::policy::Policy` derives every detailed ZIP,
XML, model, metadata, settings, OPC, envelope and package limit from those
budgets, so WASM and JNI enforce one policy and a new internal limit cannot drift
between bindings. The same module maps failures to bounded, redacted codes
(`resource_limit`, `invalid_archive`, `invalid_document`, `timestamp_service`,
`unsavable_project`, `cancelled`); budget refusals nested in any decoder report
`resource_limit`, so a host can tell "too large" from "invalid". `archive::text`
renders warnings as the browser's sorted, unique UTF-16 texts.

Open stages exact bytes in offset-checked 64 KiB chunks and then prepares
privately: canonical completion or foreign import, warnings and format, ending in
a prepared document that only the session's guarded `finish_open` or
`reset_document` adopts. Save packages a frozen capture with its checkpoint guard
and never changes dirty state; only a confirmed handoff acknowledges the guard.
WASM exposes `ProjectArchiveUpload`/`ProjectArchiveImport` and
`ProjectSession.write_archive`. JNI keeps each step in one registry slot (upload,
then import, then document) under the bounded concurrent-document budget, and
packages an immutable `ExportCapture` so no session gate is held while writing.
Closing a JNI handle cancels its import or write cooperatively. Kotlin adds
`ProjectArchiveUpload.prepare(scope, stream, …)` for an actor `openDocument` or
`resetDocument` producer, and `ProjectExportSource.writeArchive` for
`saveDocument`, whose existing handoff rule acknowledges the checkpoint.

`archive-wasm-replay.mjs` drives the same 1,341 browser archives (canonical
completion and foreign-import corpora) through each binding: matching format,
warnings and complete state for **1,225 accepted** and refusal for **116**; then
Save, checkpoint acknowledgement and reopening the saved bytes as canonical with
plates and every asset intact (**1,223 saves**, 1,213 byte-identical states; the
two unresolved-origin envelopes are the browser's Save refusals too). It passes
in Node WASM, a Chrome 150 module worker and the host JVM over real JNI (debug
and release). `ProjectActorArchiveChecks` adds seven actor journeys: guarded Open
of a foreign archive, Save with checkpoint, reopen to the same semantic hash,
mutually exclusive bundle/package streams, budget and malformed-input refusals
that leave the session untouched, chunk-order refusals, and closed-handle
behavior. `tests/policy.rs` proves browser-equivalent budgets accept every
browser Open and Save and that five tight budgets refuse with `resource_limit`.
The Android instrumented test `actorArchiveOpenAndSaveCrossRealJni` runs with
the rest of the core bridge's instrumented tests in both emulator suites (API 34,
and API 37 with 16 KB pages).

Staging rules live in `orcaxr_archive::staged::ArchiveInput`, shared by both
bindings: a declared length is reserved before any chunk and must be met exactly;
open-ended input (WASM `undefined`, JNI `-1`, Kotlin `null`) grows fallibly up to
the archive budget, for unsized or nonseekable provider streams. The replays open
every other archive open-ended (670 of 1,341) with identical results.

`ProjectDocuments` adapts provider documents to these tasks without assuming a
path, seek, fsync or atomic replacement. `prepare` stages a plausible reported
size exactly and re-reads a stale or missing size open-ended; provider failures
become redacted `ProjectDocumentException` codes (`document_permission`,
`document_unavailable`, `document_not_writable`, `document_storage_full`,
`document_read_failed`, `document_write_failed`) while archive refusals keep
their codes. `save` builds the complete package before opening the destination,
so a refused Save never truncates the user's file, and returns only after the
provider accepted close; a failure after opening is reported uncertain and the
project stays dirty. `ContentProjectDocument` wraps a `ContentResolver` URI:
`OpenableColumns.SIZE` as the size hint, truncating `"wt"` writes only (a stale
tail would corrupt the ZIP directory) and `ENOSPC` as `document_storage_full`.
`ProjectDocumentChecks` passes six journeys over real JNI and the actor: six size
variants (exact, unknown, zero, stale high/low, over budget), budget and
malformed refusals, permission/unavailable/read failures, an untouched
destination after a refused Save, write/close/grant failures that keep the
project dirty, and a successful Save that acknowledges the checkpoint and
reopens to the same semantic hash. The instrumented tests (including a real
`ContentResolver` truncation round trip) compile under Gradle but have not run on
a device. Pickers, persisted grants, recent files and share intents belong to
the application (Phase 7).

The Chrome harness now loads an intercepted secure origin: Chrome 150 refuses
blob module workers from an opaque `about:blank` page, which had silently broken
the real-browser project replay. Its query replay treats `Date.parse` as the
engine oracle, because Chromium's 31-bit Smi parser refuses one legacy offset
(`Jan 1 1970 GMT+500000:00`) that Node accepts.

### Signature-first model decoding

`orcaxr_archive::models::decode` ports the production browser's
`decodeModelImport`: binary/ASCII STL, Wavefront OBJ (with `mtllib` colours from
archive siblings), AMF (units, materials, `slic3r.modifier` roles, constellation
instances), gzip or single-member ZIP compressed AMF, and ZIP archives that
decode every supported member as one atomic import. Content signatures choose
the decoder; an extension only breaks ties and a contradiction is refused.
STEP, SVG, G-code and 3MF packages are recognised and refused with the browser's
machine-readable reason. Vertices weld on exact Float32 bits in first-seen
order, so one source always yields identical meshes. Every decoder observation
is a notice with the browser's exact UTF-16 text; errors carry its reason and
format codes. Decoding is synchronous and cooperatively cancellable.

The port reproduces the browser's JavaScript semantics where they decide
outcomes: `TextDecoder` replacement and BOM handling, `split(/\r?\n/)` and
`\s`, `Number`/`parseInt`, `toLowerCase` (a Kelvin-sign `Kd` in a material
library and a Kelvin-sign closing tag both match), UTF-16 name slicing that can
leave a lone surrogate, the XML scanner's entity grammar and attribute quirks,
V8's fdlibm `sin`/`cos` for AMF instance rotations (`libm`), and fflate's gzip
behaviour (no CRC check, output sized by the trailer length, an empty body as
that many zero bytes). The trailer never sizes an allocation natively; one
refusal differs only in its format code (a stored block that overflows the
trailer length). Building the corpus exposed a browser defect, fixed in the same
change: prototype keys were treated as declared extensions, AMF units and XML
attributes, so `cube.constructor` was refused and `unit="constructor"` produced
a non-numeric scale.

`tools/cross-platform/model-import-vectors.mjs` records **260 cases**: authored
detection, STL, OBJ, AMF, compressed-AMF, ZIP and limit cases plus the six model
files shipped in this repository (including the 11 MB Benchy). Native decoding
matches all **116 accepted** results (format, units, names, roles, colours,
materials, transform bits, mesh digests and the exact notice list) and all
**144 refusals** (class, reason and format). Mutating one expected notice or
mesh digest fails the comparison, and a cancellation test publishes nothing.
`models::stage::stage` then ports `ModelImportParser`'s merge staging: positions
scaled to millimetres, packed mesh assets (`mesh::encode`) deduplicated against
the project's existing meshes by digest and mesh layout, unique object names
(`name (2)` …), group placement centred on the printable area (`bedAreaMm`, the
midpoint of its corners; JNI and WASM take it as `[xMin, yMin, xMax, yMax]`)
and/or dropped to the bed from the bounds of every instance, `orcaxr:importSource`/`orcaxr:sourceMaterial`
extension data, and every decoder notice as an import repair, dropped field or
diagnostic with the browser's identifiers. The host supplies the stable-ID source
and timestamp; staging is private and returns the candidate state, the new asset
payloads and the notices. `model-stage-vectors.mjs` stages every decoded corpus
case into an empty project (with and without bed placement), plus chained imports
into projects that already hold the same mesh and names and into a non-first
active plate, on areas from the bed corner, the U1's and one far from it:
**241 cases** (239 staged, 2 Float32-overflow refusals) agree on
ID requests, complete state, asset descriptors and bytes, imported IDs and
notices.

`orcaxr_project::import` ports `ProjectImportCoordinator`: `prepare` checks
declarations against payloads (duplicates, undeclared or missing payloads,
metadata/length/digest mismatches, unknown imported IDs), completes imported
provenance, consolidates byte-identical assets with alias rewriting (keeping a
base asset's ID when its content matches), validates the final graph under the
host's timestamp policy, replays the browser repository's restore checks, and
builds the browser's preview (counts, blocked state, sorted required
acknowledgements, every notice with its `coordinator:` identifier, stale-base
diagnostic). `ProjectSession::commit_import` applies the browser's confirmation
order (blocked, missing acknowledgements, stale base) and executes one undoable
`Import <filename>` command that replaces the project and asset repository; redo
restores the exact repository version it produced, undo the previous one.
`model-transaction-vectors.mjs` runs the real coordinator and parser over a real
`CommandBus`: **23 transactions** agree on preview, staged bundle, confirmation
refusals, committed state, ID-ordered assets and history, and undo/redo through
the session wire protocol restore the exact base and committed states, including
a deliberately colliding ID namespace that blocks the commit and a stale base.
Model import is bound to hosts through one shared task
(`orcaxr_archive::models::host`): the base (guard, snapshot, asset copies) is
captured on the authority, decoding, staging and preview run privately, and
`commit_import` runs on the authority. Limits come from the generated
`contracts/project-model-import.json` (defaults asserted equal to the browser's);
source bytes stage exactly or open-ended like archives; production IDs are
UUIDv4 from host-seeded entropy, replay IDs a deterministic counter namespace;
failures are bounded `unsupported-format:*`/`malformed-model:*` codes. WASM
exposes `ProjectModelUpload`, `capture_import_base`, `prepare_model` and
`commit_import`; JNI keeps each step in one registry slot (upload, then preview)
and cancels cooperatively on close; Kotlin adds `ProjectModelUpload`,
`ProjectImportBase.prepareModel`, `ProjectDocuments.stageModel` and the actor's
two-phase `prepareImport`/`commitImport` (`ImportPrepared` and `Imported`
outcomes, `UNCONFIRMED` for a blocked or unacknowledged preview; a refused
confirmation keeps the candidate). `model-import-replay.mjs` replays all 21
browser transactions identically in Node WASM, a Chrome 150 worker and host
JNI (debug and release), and `ProjectActorImportChecks` passes seven actor
journeys (preview, acknowledgement gating, undo, stale and closed candidates,
unsupported sources, foreign candidates, direct session refusal codes).

### Layer-range commands

The five layer-range commands (`objects/layerRangeCommands.ts`) are native:
add (an empty-config range over the wire), bounds edits with absent/present
fields, split (the upper half inherits settings and filament), merge (only
consecutive touching ranges with equal settings and filament) and delete. Ranges
stay sorted by height then UTF-16 ID; refusal messages format heights as
ECMAScript numbers; add/split select the new range, merge/delete repair the
selection exactly like the browser (fallback to the merged range, the neighbouring
range or the object). A layer-range scenario in `project-command-vectors.mjs`
(54 steps, including transactions and rollbacks) is replayed by the Rust command
tests, and the regenerated session traces by the WASM and JNI replays.

### Layer-event commands

Authored layer events (`layerEventCommands.ts`) are native: `addLayerEvent`,
`editLayerEvent` and `deleteLayerEvent` rewrite the plate-scoped `customGcode`
entries that carry a `layerEvent`. Event types travel as camelCase wire values
(`colorChange`, `toolChange`, …) and map onto the canonical kebab-case literals.
An edit patches each optional event field as keep, clear or value (the
browser's `key in patch`); `type`, `topZMm` and `code` are absent-or-value. An
edit rebuilds the entry canonically, so foreign fields on it are dropped and a
non-custom event never keeps a body. Validity of the edited list (height above
the plate and at most 10,000 mm, one event per `toFixed(4)` height on a plate,
1-based tools for colour/tool changes, non-blank custom code, an existing plate,
globally unique IDs) is left to graph validation inside the validating
replacement, so refusals carry the same `Invalid project state (…)` message as the
browser's `assertValidProjectState`. The 64-step `layer-events` scenario covers
every type, those refusals, transport refusals for non-stable IDs, no-op edits,
plate deletion with events, and transactions.

### Brim-ear commands

The four brim-ear commands (`objects/brimEarCommands.ts`) are native:
`addBrimEar`, `addBrimEars` (one entry for a detected set; an empty set is
refused), `removeBrimEar` (a non-negative integer index) and `clearBrimEars`.
Preparation refuses a head radius outside the pinned 0.1–20 mm gizmo bounds with
the browser's message. The browser's undo behaviour is reproduced rather than
normalised: undoing a single placement pops the last ear (an emptied list removes
the `brimEars` key, even when the object started with an empty list); undo
publishes under the command's own reason with no `revert:` prefix; and undoing a
clear that removed nothing records history without a project publication. None of
these commands has a no-op check, so clearing an object without ears is still an
undoable entry.

### Brim-ear detection and the tool's view

`brim_ears` ports the browser's `brimEarExchange.ts` over
`brimEarDetection.ts` and `brimEarPreview.ts`. Ears are object-local: the
first layer an ear holds is the object's model volumes, each moved by its own
transform into object space (composed as three.js composes them). Detection
(`BrimEarDetectRequest`) cuts that layer just above its base, chains the cut
into loops — a segment that only ends where the chain stands walked backwards,
since a triangulation does not keep the cut's direction from one triangle to
the next — and keeps the outward corners sharp enough to peel, thinned to the
sharpest of each cluster. The stranded check (`BrimEarStrandedRequest`) names
the placed ears whose discs reach neither the layer nor, through overlapping
discs, an anchored ear. An object's view (`BrimEarViewRequest`, the browser's
`objectBrimEarView`, which the workspace's brim-ear tool reads through
`CanonicalWorkspaceController.getBrimEarView`) is what the tool shows and
places with: the placed ears, the stranded ones and the base a placed ear sits
on (`objectModelBaseZ`, the object's lowest model point; the pinned engine
drops an ear above the bed). An object whose model parts cannot be read still
lists its ears, with none stranded and no base, as the workspace shows them;
only an unknown object is refused. Bindings: WASM `detect_brim_ears`,
`stranded_brim_ears` and `brim_ear_view`, the JNI exports
`sessionBrimEarDetect`, `sessionBrimEarStranded` and `sessionBrimEarView`, and
Kotlin `ProjectSession.detectBrimEars`, `strandedBrimEars` and `brimEarView`.

`brim-ear-vectors.mjs` detects ears on recentred split parts, a pyramid whose
sides are single triangles, a plus with inward corners, a smooth prism, a part
turned, scaled and mirrored by its own transform, a part beside a modifier, a
flat sheet, a notch whose corners collide and three's box (the Add menu's
cube, whose walls' triangles cut opposite ways), under default and explicit
angles, thinning radii, ear radii and cut heights; checks placed ears for the
stranded ones (touching, chained through other ears, and islands); and reads
every object's view: 41 detections, 10 stranded checks and 10 views (3
refusals). Rust, WASM in Node and Chrome and JNI answer all 61 byte for byte;
133 Kotlin checks cover the wrapper. It also records a journey through the
production `CanonicalWorkspaceController` on a canonical 3MF, as the
workspace's tool runs it: the one object the selection's model parts belong
to, taps on its parts read in the object's frame through three.js and placed
at its base (one onto a part lifted off the bed, whose ear reaches nothing),
the detector's corners, a removal, clears, and the cases that place nothing
(a smooth outline, a flat sheet, no single object), with the semantic hash,
undo label and the target's view after each of its 20 steps and the 8 undo
entries, which [the Android Brim Ears tool](#android-brim-ears) replays.

### Layer-height profile commands

The four layer-height commands (`objects/layerHeightCommands.ts`) are native,
with `orcaxr_project::layer_heights` porting the browser's pinned `Slicing.cpp` /
`SlicingAdaptive.cpp` algorithms (`layerHeightProfile.ts`) expression by
expression: manual adjust (increase/decrease/reduce/smooth over a raised-cosine
band with 0.1 mm resampling), the six-round biased Gaussian smoother, adaptive
generation and reset. Each command replaces the whole profile; undo restores the
previous profile or removes it again (reason `<type>:undo`), and none has a no-op
check. Adjust and smooth carry explicit slicing parameters on the wire. Adaptive
carries only the printer limits and a quality factor: the command reads the first
volume's mesh from the session through `mesh::decode_indexed` (the browser's
`decodeIndexedMeshAsset`, its checks and messages) and takes the object height
from the mesh's Z span, 20 mm for a flat mesh. The browser command and the
workspace's adaptive action now read the session the same way.

The pinned algorithms terminate only for printer-sane input, so both engines now
refuse, with the same messages: non-positive layer or first-layer heights, an
object over 10,000 mm, more than 1,000,000 layers at the thinner of the minimum
and first-layer heights, and a smoothing radius over 100. A profile edit that
produces a non-finite number (from extreme imported profiles) is refused exactly
as the browser's validation refuses it: `Invalid project state (1 errors):
Canonical JSON cannot contain non-finite numbers at $`.

### Filament commands

The physical-filament commands (`filaments/commands.ts`) are native as validated
whole-state snapshot commands: each builds its next state and graph-validates it
(the browser's `assertValidProjectState`) for the no-op check and again on apply,
undo restores the exact previous state, and the history estimate counts both
canonical states. The bus's no-op check therefore takes the mutable context
(`CommandContext::admit` validates without publishing) and may record state the
command reuses on apply and redo.

Assignments set or clear an object, volume or layer-range filament (duplicate
targets are refused by the browser's exact string keys). Remap rewrites every
reference to one enabled destination: wipe towers, scoped assignments, layer
ranges, colour paint through `FacetChannel::remap` (a split whose leaves become
uniform moves into the whole-facet assignments) and mixed recipes, whose
colliding components merge in first-seen order with summed weights. Enablement
is a reversible tombstone in `extensionData.orcaxrFilamentLifecycle`. Printer
sync reproduces the browser's JavaScript object semantics (`trim`, truthiness and
`{...value}` spread of arbitrary JSON) when it preserves pre-sync colours, and
adopts unmatched slots with caller-supplied IDs (`newFilamentIds`) drawn once per
tool; running out is refused. The browser now also draws adopted IDs once per
tool, so redo recreates the same filament, and re-enabling removes an emptied
`extensionData` instead of storing `undefined`.

### Mixed-filament commands

Mixed-filament recipes (`filaments/mixedCommands.ts`) use the same snapshot
machinery: add, edit (one command for rename, components, distribution, full
spectrum and config), duplicate, enable/disable and tombstone. A duplicate
inserts after its source, and a full-spectrum duplicate gets the upstream
stable ID `fullSpectrumStableNumericId` derives (FNV-1a 64 of the ID's UTF-8,
never zero). Removal is separate: it refuses while any canonical reference
remains, listing every path (wipe towers, scoped assignments, colour paint and
refinement leaves, layer ranges, recipe components) sorted by UTF-16, then
prunes the selection.

Recipes travel as typed intents. Full-spectrum modes use upstream's codes
(`legacy`/`ui0`…`ui3`, `m0`/`m2`). The free-form `config` and `extensionData`
maps travel as canonical JSON text. Both engines refuse the same inputs as
invalid intents: ill-formed UTF-16, invalid or non-finite JSON, a non-object
root, and nesting deeper than 16. A map lands up to seven levels deep in the
project state, and the whole state must stay inside the canonical parser's own
depth limit of 64. Accepting deeper text produced projects the native parser
could not read back, which the query corpus caught. Every invalid-intent refusal precedes the commands' own blank-name checks,
as in the browser mapping.

### Setting-override commands

`setProjectSettingsOverrides` and `setScopedOverrides` (`settingsOverrides.ts`,
`scopedOverrides.ts`) are native. Each is prepared against the revision and
semantic hash of the snapshot its caller read. The no-op check and the first
apply refuse a stale guard; a redo instead requires the stored settings to be
exactly what the command left. The project command stores the complete
inherited/override pair and their spread as `config`. The scoped command checks
every key against the generated scope table: one out-of-scope key is named
(`brim_width cannot be set on a part`), several are counted. It replaces the
node's in-scope overrides while preserving stored keys the scope does not own.
Because a failed command publishes a rollback revision, callers read a fresh
guard for every intent.

### Volume-role conversion

`convertVolumeRole` (`objects/semanticVolumeCommands.ts`) is native. A volume
becomes a part, negative part, modifier, support blocker or support enforcer.
The browser's reasons are kept: an unknown volume, the last model part of an
object, facet paint on a part becoming a non-model role, and a local filament
on a role that cannot carry one. The object's volumes are re-sorted into
upstream Orca's role order with a stable sort, and undo restores the previous
list exactly.

The decision is public, so a host explains a blocked choice before anything
is submitted, in the words the command refuses with:
`commands::inspect_volume_role_conversion` is `inspectVolumeRoleConversion`
for any role text (a role Orca lacks is refused before the volume is looked
up, quoted as `JSON.stringify` quotes it, lone surrogates escaped), returning
the browser's code (`unknown-volume`, `unsupported-role`,
`last-model-volume`, `facet-annotations`, `filament-assignment`) and words;
the command's own check calls the same function. The semantic object
editor's "Volume role" section kept its words inside its DOM class; they are
production code of their own now (`volumeRoleEditor.ts`), which
`SemanticObjectEditor` draws and the controller's snapshot reads, ported as
`orcaxr_project::volume_role_editor`: a part's role with one choice per role
in Orca's order, each with its label ("Part", "Negative volume", "Parameter
modifier", "Support blocker", "Support enforcer" — English in every language,
as in the browser), whether it is current, the command's decision and, when
the choice is not offered, why ("This is the current role; no conversion is
needed." or the refusal); the summary "name — Role"; and a conversion's words
("Converting name to Role…", "Converted name to Role."). Hosts reach them
through `volumeRoleEditorExchange.ts`: on a captured project
`volume_role_editor` (`{"volumeId"}` → `{"projection"}`, null for a part the
project lacks) and `volume_role_decision` (`{"role","volumeId"}`), and
`volume_role_messages` (`{"role","volumeName"}`). WASM exports them; JNI adds
three exports (`projectVolumeRoleEditor`, `projectVolumeRoleDecision`,
`volumeRoleMessages`), read by Kotlin `VolumeRoleEditors` and
`ProjectSnapshot.volumeRoleEditor`/`volumeRoleDecision`.

`volume-role-vectors.mjs` records, from the production modules over three
states derived from the browser fixture — an object holding every role
(model parts painted on each channel and on refinement roots alone, with and
without local filaments, a negative volume, modifiers with and without
filaments, a blocker and an enforcer; empty, non-ASCII, emoji and
lone-surrogate names), an object whose only model part carries a filament, a
second plate, and the state after the browser's command converted three
parts (re-sorted) — 38 projections, 330 decisions (243 refused: 140
unsupported role texts, 56 facet paint, 20 last model part, 15 unknown
volumes, 12 local filaments; 35 no-ops and 52 conversions allowed), 25
conversion messages and 12 malformed requests. Rust replays them on real store
snapshots; WASM in Node and in Chrome's module worker and JNI (debug and
release) open each state as a session and match every reply
(`volume-role-replay.mjs`).

The Android session runs them through [`ProjectSettings`](#android-settings-panels):
`volumeRoles(volumeId)` reads a part's choices with the guard of the state
they were read on, and `convertVolumeRole(panel, role)` submits the browser's
`convertVolumeRole` intent under it — one undoable step the core labels
("Convert volume to negative part", "Convert volume to modifier", …), a stale
panel refused as "Semantic object edit was prepared for a stale canonical
project revision", a choice the editor does not offer refused before anything
is submitted in the command's words (the session's own refusal carries no
words), the part's current role changing nothing. `ProjectWorkspace.setNegativePart`
is the browser's `setNegativePart`: a selected part that is not a negative
volume is converted (its decision checked first, so a refusal is the
command's words), otherwise a negative volume is added to the object the
selection names ("Add negative part to object", the new part selected);
nothing selected is "Set as Negative Part requires a selected object,
instance, or volume". `ProjectVolumeRoleChecks` (846 checks over JNI) read
every corpus reply through the Kotlin readers, then on an imported cube
refuse Set as Negative Part with nothing selected and the only part's other
roles (the last model part), add negative volumes from an instance and from a
negative part, convert one to a modifier and to a part with the core's
labels and the browser's words, refuse a stale panel, convert the original
part with Set as Negative Part once a second model part exists, refuse the
object's last model part, and undo every step back to the import.

The catalogue gates `set_negative_part` on an instance selection
(`has-instance-selection`, `canonicalUiFacts`), so the browser's registry —
and the core's capabilities on Android — never invoke it with a part
selected; its conversion branch is reachable only by calling the workspace
directly. The semantic editor converts a selected part in both.

### Facet paint strokes

Whole-facet strokes are native as `facetStroke` intents. The browser's commit
path is now split: `prepareFacetAnnotationStroke` derives the before/after
annotations from the session state, and `FacetStrokeRequestCommand` prepares on
its first apply and then behaves exactly like `FacetAnnotationStrokeCommand`.
The workspace's commit function and native intents run the same preparation.
That preparation refuses a stale revision/hash or topology guard
(`Facet annotation result is stale (…)`), a non-model volume, and invalid
stored or resulting annotations (`Invalid facet annotations (N issues)`, the
sparse validator's count). Ranges are normalized (sorted, merged, refused when
outside the mesh), and painting regroups the channel by canonical value in
canonical-text order. A stroke over a refined channel drops the subdivision of
every covered facet; remaining splits that collapse to one leaf are dropped, as
`normalizeFacetRefinementEncoding` does. Strokes that change nothing are no-ops.
Dense refined-root commits (`commitFacetRefinement`) can exceed intent limits on
real meshes and will move to the staged path with the asset-bearing commands.

### Project rename, wipe towers and auto-pair reconciliation

`renameProject`, `setPlateWipeTower` and `reconcileAutoPairs` are native.
Renaming refuses a blank name and, like the browser, has no no-op check.
Wipe-tower placement replaces or removes one plate's tower, is a no-op when
nothing changes, and keeps its default labels (`Auto-place wipe tower` for an
enabled tower, `Update wipe tower` otherwise) and fixed 128-byte estimate.
Auto-pair reconciliation replaces the whole mixed-filament list with typed
recipes under a revision/hash guard; redo refuses if the list moved. The list
is validated as a whole, so dropping a referenced recipe is refused.

### Model-colour recreation

`recreateModelColors` is native as a filament snapshot command. It applies a
recreation plan the host already chose: it adopts reported printer slots (a
candidate tool's ID first, otherwise caller-supplied IDs drawn once per tool,
refusing when they run out), adds the plan's new recipes, then points every
reference at its destination. Matches are by source filament, or by colour
normalized like `normalizeHexColor` (trimmed, optional `#`, six hex digits,
upper case). That covers wipe towers, scoped assignments, a volume's
`orcaxr:sourceMaterial` colour and colour paint. Paint falls back from a
volume's `orcaxr:originalFilamentColors` to the project's when the volume has
none. A non-string colour where the browser calls `trim` is refused with the
browser's own error. The browser command now also draws adopted IDs once per
tool, as printer sync does.

### Split to objects

`separateObjectVolumes` promotes each model volume of a multi-volume object
into an object of its own, with no mesh bytes involved. The intent carries a
revision/hash guard, the object, and caller-chosen object and instance IDs per
volume. The browser's `SeparateObjectVolumesRequestCommand` checks the guard,
then fingerprints the object as the workspace does. Both sides then follow
`SeparateObjectVolumesCommand`:

- the browser's refusals, in order: fewer than two volumes; modifier or
  negative volumes; volumes under three facets; layer ranges; object
  extension data;
- IDs fresh against `collectStableIds`, which excludes asset and blob IDs;
- the object configuration overlaid by the volume's, and the volume's filament
  or else the object's;
- each volume offset carried through every instance's scale and normalized
  quaternion (V8 `hypot`);
- the selection remapped from the source object and instances to every copy.

Redo and undo swap whole states and refuse a project that changed underneath.
Brim ears, the layer-height profile and unknown object fields are dropped, as
in Orca's `ModelObject::split`.

The history estimate counts the source object's canonical JSON escaped as a
string, plus the identities and both states. Retention traces pin it to the
unit. Splitting a single volume into components needs staged mesh payloads; it
moves with the asset-bearing commands.

### Payload-carrying record commands

`AddObjectCommand`, `AddObjectWithAssetCommand` and `AddVolumeCommand` are
native as `PreparedCommand::add_object`, `add_object_with_asset` and
`add_volume`. Records decode through the bulk record inputs (`ObjectInput`,
`VolumeInput`). A payload becomes a `StagedAsset`: its descriptor shape,
length and digest are validated once into an `AssetLease`.
`AssetRepository::put_lease` adopts that record by reference, so applying and
redoing never copy mesh bytes; a test checks the record identity across redo.

The refusals keep the browser's order and text:

- unknown plate or object; duplicate object or volume;
- an object that does not reference its payload (refused at preparation);
- a payload declared in state but missing from the repository, or the reverse;
- descriptor metadata that differs from the declaration;
- a digest already declared, or held outside the declared bundle (found by
  insertion order without copying);
- a different stored record under the same ID.

Volumes are inserted in upstream role order. Undo removes only payloads the
command inserted and no remaining reference keeps. History charges the
canonical record plus the payload bytes; a payload-free add charges one.
`project-asset-command-vectors.mjs` builds these traces from the production
constructors. They carry repository-only payloads too (`extraAssets`), and the
Rust replay compares the asset bundle fingerprint at every step.

### Mesh topology replacement and booleans

`ReplaceVolumeMeshCommand` and `MeshBooleanCommand` are native as
`PreparedCommand::replace_volume_mesh` and `mesh_boolean`. Their guards arrive
as raw text and numbers (`TopologyGuard`, `BooleanGuard`) and are checked like
`assertGuardShape` / `assertBooleanGuard`, so malformed IDs, digests and counts
fail with the browser's messages. Both commands, in the browser's order:

- check the guarded topology against the live volume and its declared,
  stored, decodable mesh;
- require a fresh replacement ID and digest;
- reset every annotation channel at the next topology revision;
- drop payloads that nothing references any more.

The boolean also resets both transforms, since its result is in bed
coordinates, and removes the other instance, or its whole object (with that
object's unreferenced meshes) when it was the last instance.

Stored meshes are re-validated with `mesh::validate_indexed`. It is the same
walker as `decode_indexed` (same checks, order and messages), but it keeps
nothing. Removed payloads are retained as `AssetLease`s, so undo restores the
exact records; the replay checks the original mesh's identity whenever it is
present. Three browser defects were fixed before porting:

- undo now reverses apply's descriptor edits exactly, where it used to permute
  the declared asset order when the removed object held several meshes;
- a boolean of an instance with itself is refused;
- history no longer stringifies payload bytes, which a typed array turns into
  an index-keyed object; it charges their byte length instead.

`meshBooleanCommands.test.ts` covers each fix.

### Split to parts and single-volume split to objects

`SplitVolumeToPartsCommand` is native as `PreparedCommand::split_volume_to_parts`.
Guard and parts arrive as received (`VolumeSplitGuard` with the source volume's
canonical text; `SplitPart` with a staged payload), and construction normalizes
them like `normalizePreparedParts`:

- guard shape, then at least two parts with fresh, unique, stable volume IDs;
- transforms with non-zero scale and rotation;
- part payloads that differ from the source and decode to non-empty meshes;
- source-triangle maps that are a lossless, non-overlapping partition;
- one payload per asset ID and one asset ID per digest.

Apply follows the browser. It checks staleness, comparing the volume's
canonical text with the fingerprint by streaming it, never by building the
string. It refuses opaque core-facet 3MF metadata. It then classifies payloads
as already declared, colliding or owned, and generates role-preserving parts
named `<name>_<n>`. Owned descriptors take the source's place in the declared
asset list. A selected source volume becomes every part, and undo is the exact
inverse.

`prepare_split_to_objects` is `commitPreparedVolumeSplitToObjects`. Its checks
(source found, exactly one volume, no component under three facets) run against
live state and refuse without publishing. Constructing the split also refuses
before any transaction. The browser now does the same: it used to build the
split inside its transaction and publish a rollback for bad input. The result
is a "Split to objects" batch: the split, then a `SeparateObjectVolumes` whose
source is the object holding the first part, fingerprinted after the split
commits. That matches the browser's in-transaction guard capture, including
the three publications of a promotion that fails inside the transaction.

### Split sources

`split::source` is what a split of the selected instance would split
(`SplitSource.ts`, which the browser's controller now reads for its
confirmation, its commit and Split to Parts). It answers the object holding
the instance — plate, ID, name, strategy (its volumes promoted, or its one
volume separated by connected body), volumes, their triangles and every
instance the split replaces — or the workspace's refusal in its words and
order: an instance the project no longer has (worded per split), an object
with no volume, a non-model volume or a volume below three facets; splitting
to objects, height ranges or object extension data no promotion distributes;
for a single volume, more triangles than the synchronous limit (written as
`toLocaleString('en-US')` writes them), paint or opaque triangle-indexed 3MF
metadata; and, splitting to parts, an object that already has parts. The
exchange is canonical JSON over a captured project (`SplitSourceExchange.ts`,
`source_json`; WASM `split_source`, JNI `projectSplitSource`, Kotlin
`ProjectSnapshot.splitSource`). `model-tool-vectors.mjs` asks it of every
instance of a project covering each refusal and an import's provenance,
under both splits and several limits: 118 replies (64 refused) and 12
malformed requests agree in Rust, WASM in Node and over JNI, and 176 Kotlin
checks read them through the wrapper.

Split to Parts keeps the object, so the object's own data — height ranges,
extension data — stays with it and never refuses the split. Split to Objects
replaces the object, and its promotion (`separateObjectVolumes`,
`splitToObjectsCommands.ts` and `commands::split_objects`, reached by both
strategies) distributes what it knows how to distribute:
`DISTRIBUTED_OBJECT_EXTENSION_KEYS` is `orcaxr:importSource`, the provenance
every model import (`ModelImportParser`, the core's model staging) and
geometry merge (`GeometryMergeParser`) gives an object. Each resulting object
gets a copy, as a duplicated object keeps its own. Any other key still
refuses the promotion. Until this change no imported model could be split,
because every import carries that key; `split-imported-model.test.ts` holds
the regression.
Corpus cases cover a model import's and a geometry merge's provenance, alone
and beside an unknown key: in the split sources, the model-tool journey (39
steps, 191 JNI checks), the session's volume splits and the
`split-to-objects-provenance` command trace.

### SVG and embossed-text parts

The four recipe-carrying commands are two native kinds:
`PreparedCommand::add_drawn_part` and `recut_part`, each with a `Recipe` that is
either an SVG part (its drawing payload and `EmbossSvgPart`) or an
`EmbossTextConfiguration`. Adding places a model volume carrying its recipe.
SVG parts declare and store the mesh and the drawing. Text refuses an
already-declared asset and is named from its first line (JavaScript `trim`,
at most 60 UTF-16 units, else "Text"). A re-cut replaces the mesh at the next
topology revision with annotations reset. It drops the old mesh only when no
volume references it; these commands check volume meshes only, unlike the
topology commands.

Reverts publish the browser's `<type>:undo` reasons rather than
`revert:<type>`. An undo that finds the recipe missing fails with the
browser's own "Canonical JSON cannot contain undefined". None of the four has
a history estimate, so each charges one.

### Emboss fonts, drawings and drawn parts

What the browser's Emboss and SVG part tools compute before they submit a
cut is shared too, so a host needs no font stack or SVG reader of its own:

- **Fonts.** `emboss::font` ports the browser's TrueType reader
  (`truetypeOutlines.ts`, over `embossFontExchange.ts`) outline for outline:
  `glyf` outlines alone or in a collection (`ttcf`, at the request's index),
  simple and composite glyphs (byte, word and point-matched arguments, every
  scale form, five levels of nesting), quadratics flattened to eight segments
  in the browser's operation order, `hmtx` advances (the last repeated, half
  an em without metrics), and cmap formats 4 and 12 under the browser's
  scoring of encoding records; CFF fonts, other cmap formats and missing
  tables are refused in its words. A font is read when it loads
  (`EmbossFontRequest` → `EmbossFontReply`: its units per em and glyph
  count); a glyph when a text needs it, so one that cannot be read refuses
  the cut. `EmbossGlyphsRequest` answers a text's outlines — each character
  the cut looks up, once, in the order it first does, those the font lacks
  left out — which are exactly the `GlyphFont` an `EmbossRequest` carries.
  `emboss::prepare_text` (`EmbossTextRequest`, the browser's
  `prepareEmbossTextWire`) cuts a recipe with a font directly: the recipe is
  checked first, then each glyph read in the cut's order, then the browser's
  layout, extrusion and refusals, its reply and mesh the ones the same
  outlines sent through `prepare` give. Fonts are at most 64 MiB.
- **Reading defects fixed in the browser**, each with a regression in
  `truetypeOutlines.test.ts`, so both readers refuse instead of failing
  differently. A file cut short threw V8's "Offset is outside the bounds of
  the DataView" (now "This font file is cut short: its tables point past its
  end"); a character map of overlapping ranges was expanded entry by entry
  (a 3.3-billion-entry map from a 600 KB file) and is now searched where it
  is stored, the last segment or group mapping a code point winning, as the
  expansion's last write did; contour end points out of order read points
  the glyph lacks into NaN coordinates (now refused); and a composite
  referring to composites could multiply without bound (now at most
  2¹⁸ flattened points and component references per character, "This font
  has a glyph too complex to emboss"). No well-formed outline changed.
- **Drawings.** `svg::read_drawing` (`SvgDrawingReply`, the browser's
  `readSvgDrawingWire` over `readSvgDrawing`) reads a picked drawing as the
  SVG part tool does at load: its own size and the first 64 features it
  cannot cut with their total, or its refusal. A size past float64 range is
  refused at load with the cut's words; the browser listed it as
  "Infinity" and refused only the cut, and now refuses at load too
  (`OrcaWorkspace.loadSvgDrawing` reads through `readSvgDrawing`).
- **Drawn parts.** `ProjectSession::drawn_part` (`DrawnPartRequest` →
  `DrawnPartReply`, the browser's `drawnPartWire`) answers whether a part is
  embossed text, an SVG part, either or neither — what decides a re-cut; an
  unknown part is refused in the commands' words. The workspace's
  `embossTargetVolume` and `svgTargetVolume` read it through
  `CanonicalWorkspaceController.getDrawnPart`. The tools' starting recipe
  and depth are the browser's `DEFAULT_EMBOSS_TEXT_CONFIGURATION` and
  `DEFAULT_SVG_PART_DEPTH_MM`.

Bindings: WASM `read_emboss_font` (a `ProjectEmbossFont` with `reply`,
`glyphs` and `prepare`), `read_svg_drawing` and `ProjectSession.drawn_part`;
the JNI exports `readEmbossFont`, `embossFontReply`, `embossFontGlyphs`,
`prepareEmbossText`, `readSvgDrawing` and `sessionDrawnPart`; Kotlin
`ProjectEmbossFont`, `ProjectSvgPart.readDrawing` and
`ProjectSession.drawnPart`. The browser's project set grows by about 50 KB
(10,982,108 bytes).

Evidence. Fonts are built from glyph descriptions
(`web/src/project/objects/__tests__/syntheticFonts.ts`), so no third-party
font is copied into the repository. `emboss-font-vectors.mjs` records 39
synthetic fonts covering every path above and every refusal (cut short
anywhere, not TrueType, CFF, each required table, units per em, cmap
formats, collection indices from −0 to 10²¹, nesting, contours out of order,
the expansion budget): 46 reads (25 refused), 29 outline requests (5
refused; 90 outlines, 6,446 points) and 20 cuts (9 meshes); each cut is also
checked there to equal the same recipe cut from its recorded outlines.
`svg-part-vectors.mjs` reads each of its 22 drawings on its own.
`drawn-part-vectors.mjs` asks every part of the project the browser's tools
made for its kind (11 replies, 2 refused) and records the tools' journey for
[the Android tools](#android-emboss-text-and-svg-parts). Rust, WASM in Node
and Chrome and JNI answer every reply byte for byte, and the Kotlin wrapper
(`ProjectDrawnPartChecks`) matches every value. On real fonts,
`emboss-font-differential.mjs` reads every TrueType font installed on a host
(never copied) with both readers — the project WASM build against the
browser's TypeScript — and compares every Basic Multilingual Plane code
point's outlines and sample cuts: on this host 34 fonts (DejaVu, FreeFont,
LyX), 136,158 outlines (18,884,581 points) and 136 cuts identical.

### Whole-project replacement

`ReplaceProjectCommand` is `PreparedCommand::replace_project(next, label)`,
labelled "Replace project" by default. The next state is admitted on every
apply, so an invalid one fails with the browser's validation message. The
selection is pruned against the new state, and undo restores the exact prior
validated project, pruning again. History charges the canonical length of both
states. The browser's bus also restores each entry's recorded selection on
undo and redo, and the native bus matches it.

### Staged imports

`ImportProjectCommand` also arrives as staged work: an `importProject` record
carries the whole next state, every asset descriptor it travels with, and its
`Import <filename>` label (`CapturedCommand::import_project`). The payloads are
the upload's staged leases, adopted into the repository by reference
(`restore_leases`), and the state is admitted on the first apply against the
assets it installs; redo restores that exact project and repository version.
Before anything changes, both bindings check the bundle as the browser's
`assertProjectBundle` does — a declared asset missing or with different
metadata, then an undeclared one, then an ID supplied twice — refusing with
the browser's message. The browser commits model, geometry and project
imports this way (`confirmImport`), guarded by the state the preview was
checked against. The asset-command corpus gains an import trace (25 traces,
360 steps) and the staged corpus replays it through Rust, WASM and JNI (57
traces, 952 groups).

### Staged payload uploads

The staging contract gains record kinds for every payload-carrying command. They
are `addObject`, `addObjectWithAsset`, `addVolume`, `replaceVolumeMesh`,
`meshBoolean`, `splitVolumeToParts`, `addSvgPart`, `editSvgPart`,
`addEmbossText`, `editEmbossText`, `replaceProject` and `importProject`, plus a `splitToObjects`
work. Records carry each payload's descriptor in place of its bytes. Guards are
objects with exactly their fields.

After `seal`, `CommandUpload` holds decoded builders and the declared payloads,
deduplicated by ID; one ID with two descriptors refuses the upload. Payloads
stream like bundle assets:

- `asset_count` lists them in first-declaration order;
- `begin_asset(i)` reserves the exact length;
- `append_asset` takes exact offsets and chunks of at most 64 KiB;
- `finish_asset` validates the payload (`StagedAsset`, a shareable lease); a
  mismatch discards only that payload.

The last payload builds the commands on the preparation task, and a refusal
there cancels the upload. Upload options add `assets` and `assetBytes`, checked
at sealing before any byte arrives. Pool options and usage add `assetBytes`,
charging each distinct payload once per work. `asset_bytes` reports the charge.
WASM, JNI (`commandUpload*Asset*`) and Kotlin (`ProjectCommandUpload`,
`ProjectAssetWriter`, `ProjectActor.prepareCommands(..., assets)`) expose the
same steps, and the actor refuses preparation if a declared payload never
arrived.

The browser's capture functions measure the same records and validate and copy
payloads. Its endpoint pool tracks `assetBytes`, and split-to-objects work runs
`commitPreparedVolumeSplitToObjects` as a staged program. The staged corpus
replays every asset trace through staging (bundles made consistent), and the
replay harness streams each work's payloads into real uploads.

### Refined facet commits

`commitFacetRefinement` is `prepare_facet_refinement(snapshot, request)` with a
`FacetRefinement` request: guard, channel, dense roots and an optional label.
Roots decode with exactly their fields (`facets::Node::from_value`), and
browser captures enforce the same shapes, so unit charges match. In the
browser's order, it refuses without publishing on:

- a stale guard, missing volume or moved topology;
- a non-model volume;
- prior annotations with validation issues;
- a root count that differs from the triangle count.

Then `facets::collapse_roots` normalizes the roots and groups whole-facet
values in canonical order. The encoding is validated without requiring
splits, and so is the resulting annotation set. A result identical to the
current annotations returns `None` and executes nothing. Otherwise it returns
the stroke command with the prepared before/after, which applies, reverts and
estimates exactly like `FacetAnnotationStrokeCommand` (default label "Paint
refined <channel> facets"). Staged hosts send a `facetRefinement` work; the
session runs the preparation against live state when the work executes.

### JavaScript `Math` parity

Ported arithmetic that the browser performs with `Math` goes through
`orcaxr_project::js_math`. Node 22's V8 (12.4) computes `sin`, `cos` and `exp`
with its own fdlibm 5.3 port (`src/base/ieee754.cc`, including `exp(1) = E`);
its optional glibc trig is not enabled in Node's build. The `libm` crate follows
later FreeBSD revisions (`__kernel_cos`, `init_jk`, reduction thresholds) and
differs from V8 in the last bit for about 1% of trig arguments, which surfaced
as one differing layer-height sample. `js_math` ports V8's functions line for
line, plus V8's scaled, compensated `hypot` and JavaScript's NaN/signed-zero
`min`/`max`. `js-math-vectors.mjs` pins 10,099 sin/cos arguments (every
range-reduction branch, thresholds, huge and subnormal inputs), 2,512 exp and
1,509 hypot cases as bit patterns. The AMF rotation decoder, previously on
`libm` trig, now uses it too. `asin`, `atan` and `atan2` (V8's fdlibm,
including FreeBSD's `m &= 1` for |y/x| beyond 2^60) serve three.js's Euler
angles: 3,860 asin arguments (every threshold, the tails near ±1) and 3,680
atan2 pairs (signed zeros, infinities, NaN, x = 1, every reduction band of
atan) agree bit for bit.

`pow` (and `**`) and `cbrt` serve the Match search's CIEDE2000 and sRGB gamma.
V8 computes `pow` with fdlibm 5.3's `e_pow.c`, not the platform's: Node's
answers differ from glibc's correctly rounded `pow` for about one argument
in ten, and Rust's `powf` follows the platform (glibc, bionic's msun or, in
WASM, the `libm` crate), so `js_math::pow` ports V8's line for line and
`cbrt` ports FreeBSD's `s_cbrt.c` as V8 has it. 7,699 pow pairs (the
exponents 7, 2, 2.4 and 0.5 over their ranges, ±1, ±0, ±∞ and NaN in either
place, negative bases with odd, even and fractional exponents, |y| beyond
2³¹ near one, overflow, underflow and subnormal results) and 3,813 cbrt
arguments agree bit for bit. `js_math::sort` is V8's `Array.prototype.sort`
(its TimSort from `array-sort.tq`: natural runs, binary insertion up to the
minimum run, the run stack's merge rules, galloping): the Match ranking's
comparator has a 1e-6 tolerance, which makes ties intransitive, so only the
same algorithm leaves the same order — and Rust's own sort refuses such a
comparator outright. 260 arrays of up to 700 entries crowded within the
tolerance, in ascending and descending runs, leave V8's order.

### Engine-option value codec

`settings::options` holds the engine-option table generated by
`generate-engine-options.mjs`. The generator first admits the browser's
pinned schema with the browser's own `validateEngineOptionSchema`. The table
records all 816 `ConfigOptionDef` storage contracts: option and value type,
shape, nullability, percent semantics, delimiters, nil token, bounds and the
enum domain with labels. The schema's SHA-256 is bound into the table. A
second table, for the settings editor below, carries presentation, defaults
and literal GUI placements; source provenance stays in the browser schema.

The codec ports `codec.ts` in the browser's order and with its messages:

- `contract_issue`: storage contracts the codec cannot honour;
- `parse_setting_draft`: ASCII integer and decimal grammars, `nil`,
  `1/0/true/false` without case, required percent suffixes, enum tokens and
  points;
- `validate_setting_value`: types, nullability and bounds per vector entry
  and point component;
- `serialize_setting_value`: -0 prints as 0; a vector item cannot contain
  its delimiter.

`decode_settings_config` ports `decodeSettingsConfig`: the editable subset
of a configuration, with read-only diagnostics for values no definition
accepts or that duplicate-key definitions decode differently, plus foreign
keys. `apply_settings_commit` ports `applySettingsCommitToConfig`.

The browser sorted configuration keys with `localeCompare(…, 'en')`. That
collation places `_` before digits and folds case, so foreign-key order
differed from the canonical UTF-16 order everywhere else. It now uses
`compareCanonicalText`, with a regression test.

`settings-codec-vectors.mjs` runs the production codec over one
representative of each of the 161 distinct storage contracts: 13,191 drafts
and typed values. It also pins every definition's contract, three
configuration decodes (every key, mixed JSON, invalid values) and the commit
refusals. Rust replays all of them as canonical JSON.

### Settings editor

`settings::editor` ports the browser's settings editor. The generator emits
each definition's label, full label, category, tooltip, unit, mode,
technology, read-only flag, GUI widget type, aliases, conditional enum
domains and canonical default, plus the 21 tabs, 93 groups and 424 literal
placements, the custom-widget keys and the exact project-config writes.

- `assess_support` (`assessFieldSupport`) gives the generic editor's
  refusals in the browser's order: ambiguous owners, custom widgets, unknown
  technology, read-only, special widgets, conditional enums, missing or
  wrong-surface placements (the reviewed project overrides excepted), codec
  contracts and invalid defaults.
- `project_field` and `query_fields` (`projectSettingsField(s)`) apply scope,
  mode, technology, support and search filters, record search matches and
  sort by GUI order, then category, label, key, owner and ID.
- `DraftEditor` (`SettingsDraftEditor`) keeps drafts over inherited values,
  defaults and overrides: field states, comparisons, resets and atomic
  commits with the browser's errors and messages.
- `step_value` and `step_for` (`stepper.ts`) toggle booleans, cycle enums
  and step bounded scalars by a snapped hundredth of the span, rounding as
  V8 does. `stepper_rows` builds the keyboard-free rows of
  `ScopedSettingsStepper`.
- `full_spectrum` holds the reviewed Local-Z, height-bound and recipe-editor
  rules.

Sorting uses the host `Collation`. Search folds text with
`normalize('NFKD')` and `toLocaleLowerCase('en-US')`, which is a host
`SearchFolding` policy; the built-in `AsciiFolding` is exact for ASCII and
refuses other text. Labels, categories, keys and IDs are ASCII, so the
built-in collation orders every field.

`settings-editor-vectors.mjs` drives the production modules: 816 field
projections under six surfaces and three technologies, 61 queries (40 with
searches, including NFKD-only matches such as `mm3` for `mm³`), five draft
editors (61 steps), 5,856 stepping origins in both directions and the rows of
every scope in two modes through the production controller. Full Spectrum
expansions, dependencies, cross-field issues and the structured editor are
pinned too. Rust matches all of them.

### Settings editor host exchange

`settings::editor::exchange` serves the editor to hosts through generated
contract values. A `HostEditor` is created from an `EditorCreate` (mode,
technology, surface, scope, and inherited and override values as JSON); the
browser's constructor refusals become `invalid_editor`. It answers:

- `query`, then `field(i)`: the field list with locations, enum choices,
  support and search matches;
- `state` and `compare` for one field;
- `edit` (set, clear, inherit or reset a draft) and `commit`, whose browser
  errors are refusals carrying the message and issues;
- `rows`, then `row(i)`, and the count of unsupported fields;
- the free `step` and Full Spectrum `rules` (expansion, dependency,
  cross-field issue and structured editor for one key).

Bindings keep the host's collator and search folder. WASM takes any object
with `fold(Uint16Array)`, which the browser builds from `normalize('NFKD')`
and `toLocaleLowerCase('en-US')`. JNI takes a `SearchFolding`, called
through its own thread attachment; `SearchFolding.PLATFORM` uses the
platform `Normalizer` and US lowercasing. A throwing callback becomes
`folding_failed` or `collation_failed` without exposing its text. Without a
folder the exact ASCII folding applies, which can list but not search this
schema, because some tooltips are not ASCII. The Kotlin wrapper is
`SettingsEditor`.

The settings editor corpus now carries contract encodings: every query's
field IDs with sampled fields, all five editors step by step, every
seventh definition's steps, all Full Spectrum rule combinations and every
row view. Rust, WASM in Node and Chrome and JNI match 14,938 replies, with
78 refusals each. The Kotlin wrapper passes 24 checks.

### Settings projection

`settings::scoped` ports the read side of `scopedOverrides.ts` and
`settingsOverrides.ts` over a project snapshot:

- `targets`: every node a scoped edit can address, in the order a person
  scans the scene (project, then plates by order with their objects, parts
  and height ranges), with the browser's labels, `›` paths, fallback names,
  height-range labels (`0.1–0.3 mm`, numbers as JavaScript prints them) and
  in-scope override counts;
- `snapshot`: one node's in-scope overrides, the keys it stores but does not
  own with their `setting-not-in-scope` issues, the chain above it, and the
  configuration resolved without and with it; an unknown node is the
  browser's `No … node matches …`;
- `explain`: one key's value, winning scope (or the base configuration) and
  what it shadowed;
- `project_overrides`: the project scope's inherited, override and
  effective configurations.

A settings surface decodes `inheritedConfig` and `overrides` into the
settings editor exactly as the browser panels do.
`settings-projection-vectors.mjs` builds three states from the browser's own
project fixture (foreign keys, unnamed nodes, reordered plates, Unicode
names, fractional heights, an empty plate) and pins 17 targets, their
snapshots, 119 explanations and the unknown-node refusals. Rust matches all
of them.

### Settings sessions and their host exchange

`settings::session` opens the editor a browser settings panel opens for one
node (`mountSettingsEditors.ts`). The project node edits its raw explicit
overrides over the inherited preset configuration with an unscoped editor;
any other node edits its in-scope overrides over the chain above it, scoped,
on its scope's GUI surface. Values are decoded with
`decode_settings_config`, and a commit is applied with
`apply_settings_commit`, so foreign, unknown and read-only values survive.
The commit becomes the browser's `setProjectSettingsOverrides` or
`setScopedOverrides` intent, guarded by the snapshot the editor was opened
from.

`settings::projection_exchange` serves the projection on captured projects:
target pages of at most 64, node snapshots and explanations, with the
browser's unknown-node message as a result rather than a refusal. A captured
project also opens settings editors (`HostEditor::open`), whose `intent`
returns the guarded intent of the latest commit for the host to execute.

Bindings: WASM `CapturedProject.settings_targets`, `settings_snapshot`,
`settings_explain` and `settings_editor`, plus `SettingsEditor.intent`; five
JNI exports; Kotlin `ProjectSnapshot.settingsTargets`, `settingsSnapshot`,
`settingsExplain`, `settingsEditor` and `SettingsEditor.intent`.

The projection corpus adds 30 sessions (every node of two states in two
modes, with in-scope and refused edits) and the exchange's encodings. Rust,
WASM in Node and Chrome and JNI open each state as a real project session
and match 281 replies (paint palettes included), including every commit and
intent, with 36 refusals.
A Rust test closes the loop: each node's intent executes in a native
session, and the node then stores exactly the committed overrides with its
foreign keys intact.

The browser commits the same way. Its settings panels submit these intents
through the guarded asynchronous session route
(`CanonicalWorkspaceController.applyProjectSettingsOverrides` and
`applyScopedOverrides`), refusing stale guards, unknown nodes and
out-of-scope keys with its own errors before submission.
`canonical-async-settings.test.ts` pins that each scope lands exactly where
the synchronous command does, waits for acknowledgement, keeps undo/redo,
and rejects a competing queued edit instead of rebasing.

### The settings panel model and the height-range editor

The browser's generated settings panel kept its model inside its DOM class;
it is now production code of its own (`settingsPanel.ts`), which
`GeneratedSettingsPanel` draws and the shared core ports
(`settings::editor::panel`): the query a detail level and a search show
(unavailable fields included and counted with the Full Spectrum recipes,
"n settings shown; m unavailable."), sections by GUI group ("Process ·
Strength · Walls") or category, and per row the control (structured
editor, locked text, check box for a non-nullable boolean, choice list with
"Not set" for a nullable enum, text area sized from the GUI height, text
field with the numeric or decimal keyboard), the value it holds (typed
draft, else the codec's text), the origin badge in the browser's English,
"Use inherited", "Use default" (a generated default), unavailable reasons
in the browser's sentences, the Full Spectrum dependency and cross-field
issues. The drafts are the panel's own (`SettingsPanelModel`): set,
inherit and default, each widened by the reviewed Full Spectrum rules
(implicit drafts recorded), the Apply state (changed, invalid), and Apply's
one commit — the drafts replayed on a fresh editor, the Full Spectrum
expansion, the cross-field check (`SettingsDraftCommitError`), then the
editor's commit; none changing anything drops the drafts. The presentation
table now carries each definition's `multiline` and GUI `height`
(`generate-engine-options.mjs`). The scoped panel's words for a target
(picker text with override count, summary, heading) are shared too.

The semantic object editor's height ranges likewise
(`layerRangeEditor.ts`, `orcaxr_project::layer_range_editor`): an object's
ranges by height (UTF-16 ID ties, as the commands order them; the
controller's snapshot used `localeCompare`, which no valid project can
reach) with the merge command's decision for the selected range's
neighbours (`inspectLayerRangeMerge`, now `commands::inspect_layer_range_merge`),
typed bounds and split heights checked before anything is sent
(ECMAScript `trim`/`Number`), each operation's pending and success words,
and heights formatted as `Intl.NumberFormat('en-US', {maximumFractionDigits:
4, useGrouping: false})` formats them — which rounds the number's shortest
decimal spelling half away from zero, not its binary value
(123456789.12345 is "123456789.1235", where `toFixed(4)` writes …1234),
keeps the sign of -0 and writes every digit from 10²¹.

Hosts reach both through canonical JSON exchanges
(`settingsPanelExchange.ts`, `layerRangeEditorExchange.ts`): on a host
editor `panel_view`, `panel_row`, `panel_edit`, `panel_state`,
`panel_apply` (whose commit becomes the editor's guarded intent) and
`panel_cancel`; `settings_target_text`; on a captured project
`layer_range_editor`; and `layer_range_bounds`, `layer_range_split` and
`layer_range_messages`. WASM exports them; JNI adds eleven exports, read by
Kotlin `SettingsEditor.panel*`, `SettingsPanels` and `LayerRangeEditors`.
`settings-panel-vectors.mjs` records, from the production modules over
three states derived from the browser fixture (overrides at every scope,
Full Spectrum project keys, foreign keys, an out-of-bounds part value,
mergeable and unmergeable ranges, non-ASCII names), 18 panel sessions of
669 steps (103 views, 154 rows, 230 drafts, 72 states, 90 applies with 31
intents, 20 cancels), 22 target texts, 15 projections, 384 bounds checks,
84 splits, 42 operation messages and 20 refusals. Rust replays all of them
on editors opened from real store snapshots; WASM in Node, in Chrome's
module worker (`project-wasm-browser.mjs`, with the browser's own
`Intl.Collator` and NFKD folding) and JNI open each state as a session and
match every reply.

### Facet region selection

`facets::region` ports the browser's region selection (`FacetRegionSelection.ts`,
the pinned Orca `TriangleSelector`) for source facets. Face neighbours follow
`its_face_neighbors`: topological, opposite-winding pairs, and a non-manifold
edge pairs the first still-unpaired later face. Triangle selects the seed;
Fill is the state-aware bucket fill, crossing shared edges only to neighbours
with the seed's current state, refusing clipped neighbours but never the
seed, and stopping at the smart-fill angle; Height Range scans every facet in
transformed Z, optionally gated to overhangs through the double-then-float
inverse-transpose normal matrix; Gap Fill reports every same-state fragment
under the area threshold with its remap to the lowest ordered adjacent state.
Circle and Sphere brushes reproduce the upstream single-point and dragged
Capsule2D/3D vertex containment, cursor-ray-in-triangle and edge tests, with
connected propagation; only Circle culls back-facing neighbours, and clipping
applies to vertex containment but not to the ray or edge tests. Uniform
scaling divides the radius instead of transforming the geometry, exactly as
upstream does.

Upstream computes in Eigen `Vec3f`, and the browser reproduces that in doubles
with explicit `Math.fround`; the port mirrors it operation by operation, so an
`f64` always holds a float32 and thresholds land on the same side (the
browser's double rounding is innocuous for these operations). `Math.cos` is the
fdlibm port. Requests are validated with the browser's issue codes, paths,
messages and order, then the mesh, then topology staleness, then the selected
channel's assignments.

A request with prior refinement (the persisted `{ version, triangleCount,
splits }` record or dense mid-gesture roots, validated as the browser's raw
input) or with triangle splitting selects over the TriangleSelector working
tree (`region::refined`): Orca's one-, two- and three-side splits with shared
midpoints, propagated neighbour tables and touching-leaf walks; Triangle and
Fill resolve a split seed from the local hit; Gap Fill measures leaf patches;
brushes and height bands split adaptively at the pinned edge limits
(`min(√r²/5, 0.05)` and 0.1 mm). The result carries every working vertex, the
encoded roots and every leaf with its paint target flag, and Gap Fill
replacements name their leaves. `materialize` rebuilds the persisted leaves
for a render overlay. Tree-building failures — a split past the depth or node
budget, a hit outside the seed, a neighbour that does not share an oriented
edge — are the browser's single-issue refusals.

`facet-region-vectors.mjs` drives `selectFacetRegion` over a closed cube, an
icosphere, an open terrain, a patchwork grid and a non-manifold fan with a
degenerate facet, for all five channels: Triangle and Fill seeds at several
smart-fill angles, with clipping planes; Height Ranges under four transforms
and the overhang gate; Gap Fill thresholds under two state orders; and Circle
and Sphere strokes, single and dragged, from frontal and oblique cameras at
four radii under five transforms; then splitting strokes and a split height
band, and Triangle, Fill, clipped Fill, Gap Fill and brushes over the
refinement a stroke leaves, in dense and persisted form, with materialized
overlays — plus 44 refusals (including every malformed-refinement issue) and
2 stale topologies. Rust reproduces all 5,938 cases, 59 of them refined, and
every mesh's neighbour table exactly.

A stroke commits the tree `region::refinement_after` returns (the browser's
`facetRefinementAfterSelection`, which `PaintStrokeService` commits): a
refined selection's selected leaves painted with the target, or refined Gap
Fill's per-fragment leaf targets (`apply_refined_selection` and
`apply_refined_updates`, the browser's `applyFacetRefinedSelection` and
`applyFacetRefinedStateUpdates`), with every branch the update makes
homogeneous collapsed as `remove_useless_children()` does; Gap Fill over
unrefined facets yields the dense roots with each fragment replaced, and any
other selection commits ranges (`None`). The helpers check the selection as
the browser checks a host's — split topology, depth and node budgets, leaf
states for the channel, then the leaf list's order and states — and each
update's leaf reference, target state, existence and uniqueness. The corpus
records 190 commit trees (every refined selection painting and erasing,
refined and dense Gap Fill) and eleven refusals over a small materialized
selection; a 66-level split chain is recorded as its shape because it nests
past JSON readers' limits. Rust reproduces all of them.

Hosts select over a live session (`facets::region_exchange`, the browser's
`FacetRegionExchange.ts`). A `FacetRegionRequest` names a volume, a channel,
the seed facet, the tool and the optional clipping plane, selection transform
and overhang angle, and a page window; the session decodes that volume's mesh
asset, reads its annotations and answers a `FacetRegionReply`: a page of the
selected ranges and Gap Fill replacements (at most 4,096 of each) with the
`FacetGuard` a `facetStroke` intent commits them under, the selector's own
issues for invalid tool input, or a stale topology. An oversized page, an
unknown volume, an unreadable mesh and a disposed session refuse. Bindings:
WASM `ProjectSession.facet_region`, the JNI export `sessionFacetRegion` and
Kotlin `ProjectSession.facetRegion`. `facet-region-exchange-vectors.mjs` opens
a browser project with a painted icosphere and a support-painted terrain and
runs every tool, transforms, clipping, the overhang gate and paging windows;
Rust, WASM in Node and Chrome and JNI answer all 136 replies byte for byte and
both refusals, and 411 Kotlin checks cover the wrapper.

### Paint strokes over live sessions

A whole paint gesture runs over a session as the browser's painter drives
`PaintStrokeService` (`facets::paint_stroke`, the browser's
`PaintStrokeExchange.ts`). The host opens a stroke with a `PaintStrokeOpen` —
volume, channel and paint target, unpainted for erasing — under a current
session guard. The browser's checks run in its order: a channel no surface
paints (brim), an unknown volume, a non-model role, a target the channel
cannot hold and an unknown or unavailable palette filament refuse, then an
unreadable mesh. The stroke owns the opened snapshot's decoded mesh, the
channel's assignments and persisted refinement, so each `PaintStrokeSample`
(seed facet, tool, triangle splitting, clipping plane, transform and overhang
angle) runs on the stroke, off the session. A sample selects over that
snapshot and the tree the samples before it left: the persisted refinement
until a sample refines, then the stroke's own post-sample tree, passed to the
selector as typed roots (`region::Roots::Nodes`) rather than re-encoded JSON.
It accumulates the touched facets and the tree `region::refinement_after`
returns, and answers counts of selected facets and leaves, or the selector's
issues without changing the stroke. A `PaintStrokeOverlay` pages the touched
facets as ranges with the facet guard. `ProjectSession::stage_paint_stroke`
stages the gesture as one edit for `executeStaged`: the refined tree as
`facetRefinement` work, otherwise one `facetStroke` built natively
(`CapturedCommand::facet_stroke`, measured as its intent but never bounded by
the wire's page limits), with the browser's labels; a stroke that touched
nothing stages nothing, and staging refuses as stale once anything changed
since the stroke opened. Bindings: WASM `ProjectSession.paint_stroke` /
`stage_paint_stroke` and `ProjectPaintStroke.sample` / `overlay`, the JNI
exports `paintStrokeOpen`, `paintStrokeSample`, `paintStrokeOverlay` and
`stagePaintStroke`, and Kotlin `ProjectSession.paintStroke` /
`stagePaintStroke` with `ProjectPaintStroke`.

`paint-stroke-vectors.mjs` opens a browser project with a painted icosphere,
a support-painted terrain and a modifier, runs every open refusal, then
strokes — dragged Circles, splitting Spheres, Fill and Triangle over the
persisted refinement under clipping and a transform, a splitting erase and
its repeat, dense Gap Fill, Height Ranges on the seam and fuzzy-skin channels,
brushes and a band the painter's settings place on a scaled, a stretched and
a turned part, an empty stroke and two strokes racing — and commits each
through the browser's own facet commands. Rust, WASM in Node and Chrome and
JNI reproduce every sample reply and overlay page byte for byte and every
refusal, and each commit's outcome (11 applied, 1 unchanged, 1 nothing to
stage, 1 stale), revision, hash and undo label; the Kotlin wrapper replays
the whole corpus too (231 checks with its overlay packets and paint
facets).

### Paint overlay packets

Renderers draw paint from packets, not from the canonical record
(`facets::overlay`, the browser's `PaintOverlay.ts`, which the workspace's
overlay meshes are now built from). An overlay holds the facets one volume's
channel paints: every assigned leaf of the materialized refinement when the
channel is subdivided, otherwise each assignment's whole facets in order.
`ProjectSession::paint_overlay` captures the canonical overlay of a
`PaintOverlayRequest` (volume and channel), and `PaintStroke::preview` the
live preview the workspace draws mid-gesture: the stroke's tree collapsed and
materialized, or the touched facets in the target state, in first-touch
order. A capture owns its facets under the facet guard of the state it drew,
so it is read off the session: a `PaintOverlaySummary` (guard, facet count,
distinct states in first-drawn order), then packets of at most 16,384 facets,
each 40 bytes — nine little-endian float32 corners in volume space and a
little-endian uint32 index into the summary's states. Unknown volumes,
unreadable meshes, refused annotations and oversized packets refuse.
Bindings: WASM `ProjectSession.paint_overlay`, `ProjectPaintStroke.preview` and
`ProjectPaintOverlay.summary` / `packet`, the JNI exports
`sessionPaintOverlay`, `paintStrokePreview`, `paintOverlaySummary` and
`paintOverlayPacket`, and Kotlin `ProjectSession.paintOverlay`,
`ProjectPaintStroke.preview` and `ProjectPaintOverlay`.

The paint-stroke corpus records the preview after every sample and the
canonical overlay after every commit, then every channel of every volume, an
unknown volume and an oversized packet: 51 summaries, whole packets and paging
windows, packets compared by SHA-256 (refined previews reach 1,081 facets). Rust,
WASM in Node and Chrome, JNI and the Kotlin wrapper reproduce all of them.

### Paint facets and the painter's settings

Native renderers colour a volume's own facets instead of drawing a second
mesh over them, so the core serves overlays in that form too
(`facets::paint_facets`, the browser's `PaintFacets.ts`): whole source
facets as `[first, count, state]` runs in source order (a facet two regions
draw shows the later one), the leaves of subdivided facets as 44-byte
records (nine float32 corners in volume space, the source facet and the
state), and each state with the colour the workspace draws it in. The
colour rule is the browser's, now its own module (`paintOverlayColors.ts`,
which `OrcaWorkspace` imports): colour paint draws a filament's palette
display colour (`projectPaintPalette(state, { includeUnavailable: true })`),
support, seam and fuzzy-skin states their fixed colours, and an unpainted
state (an erasing preview) or a value nothing names white. An unrefined
channel is read from its sparse assignments alone, without decoding the
mesh; a refined one is materialized as the overlay is. A capture owns its
facets under the facet guard of the state read: a canonical JSON summary
(`{"colors","facets","guard","leaves","runs","states"}`), then packets of at
most 16,384 runs or leaves. `ProjectSession::paint_facets` captures the
canonical facets of a `PaintOverlayRequest`, `PaintStroke::preview_facets` a
stroke's live preview (its colours read from the opened snapshot).

The painter's settings are shared too (`facets::paint_tool`, the browser's
`paintSelectionInputs`, which `PaintStrokeService` now selects with, through
`PaintToolExchange.ts`): one pointer hit (facet, volume-local point and eye,
the previous point of a drag, and the part's placement) with the paint
tool's settings makes the paint stroke sample the workspace's painter
selects with — radius 2 mm, band 1 mm and gap 2 mm² when unset, each clamped
to the pinned gizmo limits; a smart-fill angle at or below 0° turns edge
detection off; Gap Fill orders colour by the palette's displayed filaments
and the other channels by their pinned states; splitting only for brushes
and bands; the overhang gate only when non-zero — or the painter's refusal
(`invalid_hit`: no source facet, a placement that is not finite and
invertible). A stroke takes samples so (`PaintStroke::sample_with`, its
palette order from the opened snapshot). The exchanges are canonical JSON:
`{"channel","hit","settings","stateOrder"}` →
`{"sample":"<PaintStrokeSample wire>"}` or `{"error","message"}`; a stroke's
`{"hit","settings"}` → `{"reply","sample"}`;
`{"channel","filaments","states"}` → `{"colors"}`.

The brush measures the bed's millimetres, as the person sees it and as
Orca's painter gizmo measures it. A hit's `placement` is the canonical
transforms of the instance it met and of the part inside it
(`{"instance","volume"}`, each `{"rotation","scale","translationMm"}`);
`paint_tool::place` (`PaintPlacement.ts`'s `placePaintHit`) composes them as
three.js composes the display meshes (`picking::compose_parts`, the instance
after the part) into the sample's facet selection transform — the matrix's
linear part and translation, and as scaling factors its singular values,
largest first (square roots of the eigenvalues of `LᵀL` by cyclic Jacobi
rotations: square roots and the four basic operations only, so every host
computes the same bits) — and Height Range starts at the hit's bed Z
(`float((trafo * hit).z())`). The selector divides the radius by the factors
when they agree (a uniform scale under any rotation or mirror) and selects
in the part's own millimetres; otherwise it moves the brush centres and the
eye onto the bed and selects there with the radius as given. So the sphere
is a ball of the set radius on the bed — on a non-uniformly scaled part an
ellipsoid in its own coordinates, stretched by the inverse of the scale
along each axis — the circle a cylinder of that radius along the view, and
the band a slab of bed Z from the hit's bed Z, across a part laid on its side
rather than up it. Orca reads uniformity off the diagonal of the polar
decomposition's scale factor instead; a part turned inside a non-uniform
instance can make that diagonal look uniform (a (2, 1, 1) stretch along the
part's (1, 1, 1) diagonal reads (4/3, 4/3, 4/3)) and size the brush in the
part's millimetres. The singular values never do, so the brush is the size
set on every placement. A hit without a placement is a part at the bed's
origin, unscaled and unrotated. Browser defect fixed: the workspace's
painter passed no placement and took the band's start from the hit's own Z,
so on a scaled part the brush and the band were measured in the part's
millimetres (a 200% part took a brush twice the size set) and a band on a
turned part ran along the part's Z; `OrcaWorkspace` now passes the placement
of the instance the ray met (regression tests in
`paint-target-pick.test.ts`: a 200% plate takes with 4 mm what its unscaled
copy takes with 2 mm, and a band on a stretched or laid-down column stays
within its bed-Z slab).
Bindings: WASM `paint_tool_sample`, `paint_facet_colors`,
`ProjectSession.paint_facets`, `ProjectPaintStroke.preview_facets` /
`sample_with` and `ProjectPaintFacets`; the JNI exports `paintToolSample`,
`paintFacetColors`, `sessionPaintFacets`, `paintStrokePreviewFacets`,
`paintStrokeSampleWith` and `paintFacetsSummary` / `Runs` / `Leaves`; Kotlin
`PaintTools`, `ProjectSession.paintFacets`, `ProjectPaintStroke.previewFacets`
/ `sampleWith` and `ProjectPaintFacets`.

`paint-tool-vectors.mjs` drives the production modules over every tool on
every channel, each parameter absent, inside and past its limits, splitting,
clipping planes, overhang gates, dragged brushes, awkward numbers, nine
placements (moved; a uniform 200% turned; laid on its side; non-uniform and
mirrored; non-uniform turned; a part turned inside a non-uniform instance; a
half-size part offset in a turned instance; a mirrored uniform scale; an
unnormalized quaternion) under every tool and a drag, 240 seeded
combinations and the painter's refusals, two unplaceable placements among
them (427 samples, 10 of them refusals, 29 malformed requests), and the
colours of every filament library of the paint palette corpus on every
channel for every kind of state (775 sets, 5 malformed). The paint-stroke
corpus now also records paint facets after every sample and commit (51
captures, runs and leaves by SHA-256, 25 with leaves, and an oversized
packet), and strokes the painter's settings place: a 200% sphere of 1.6 mm
(checked against the part's own 0.8 mm), a sphere and a splitting circle on
an instance stretched (2, 1, 0.5), and a band on a part laid on its side.
Rust, WASM in Node and JNI answer all of it byte for byte (the Chrome worker
carries the same replays); 1,661 Kotlin checks replay the painter's corpus
through the typed wrapper and 53 more the facets through
`ProjectPaintStrokeChecks`.

### Ray picking

`picking` answers which facet a ray meets, in printer space (millimetres,
bed-corner origin, Z up), as the workspace's raycast does: the browser's
`ProjectPickScene` (`picking.ts`) mirrors three.js — each volume's matrix is
its instance transform then its own, composed after the quaternion is
normalized, multiplied and inverted as `Matrix4` does, the ray transformed
as `Ray.applyMatrix4`, each facet met by `Ray.intersectTriangle` with back
faces culled (the display meshes' materials are front-sided) — and its web
test checks 243 rays against three.js raycasts on the real
`ThreeProjectSurface`: same volume, instance and facet, points and distances
within 1e-6 mm. `ProjectSession::pick_scene` captures one plate's volumes from
a `PickSceneRequest` (every volume, or model volumes only, as painting picks)
in plate order with decoded meshes shared by asset, so a host picks every
pointer move off the session and captures again when the project changes.
A `PickRay` answers the nearest hit — object, instance, volume, facet, the
point in printer and volume space, the ray origin in volume space (a camera
ray's eye, as a brush needs it) and the distance — or a miss; ties go to the
earlier volume, then the lower facet. Each mesh builds a bounding volume
hierarchy on first use (median splits, padded boxes); it keeps every
candidate within a 1e-9 relative slack of the nearest and decides between them
by the reference's own world distance, so it answers exactly as the
reference's exhaustive walk; a unit test checks 4,000 rays on a 18,432-facet
height field, ties at shared vertices included. An unknown plate, an
unreadable mesh and a disposed session refuse. Bindings: WASM
`ProjectSession.pick_scene` / `ProjectPickScene.pick`, the JNI exports
`sessionPickScene` and `pickScenePick`, and Kotlin `ProjectSession.pickScene`
/ `ProjectPickScene`.

`pick-vectors.mjs` records 243 rays — aimed at a sphere, its modifier cube on a
plain and a rotated non-uniformly scaled instance, and an open terrain on a
mirrored instance; from below the bed; past everything; with a zero direction
— in both scenes, and the unknown plate. Rust, WASM in Node and Chrome and JNI
answer all 486 picks byte for byte and the refusal; 976 Kotlin checks cover
the wrapper.

### Placement planning

`placement` plans the instance transforms the workspace's placement edits
submit — mirror, rotation and scale resets (separately or together), centring
on the printable area, scale-to-fit, lay flat by a local normal or by a picked
facet, and drop to bed — from the browser's `transformOperations.ts` through
`placementExchange.ts`. Centring takes the printable area (`areaMm`, its
corners) and centres on their midpoint; scale-to-fit takes the build volume
(`volumeMm`, its lowest and highest corners), fits the selection's bounds plus
upstream's 0.02 mm tolerance into the volume's extents, centres it on the
volume's centre and rests it on its floor (upstream's
`print_volume.center()`). Neither assumes the area starts at the bed corner. A `PlacementRequest` answers a `PlacementReply`: a plan
whose changes are one `setInstanceTransforms` intent (drop to bed also reports
each instance's lowest point and move), or the operation's own refusal code
and message, in the browser's order. Bounds walk the browser's way — instances
in order, then their model volumes — over the shared mesh arithmetic, with
lay-flat's probe transform substituted for its instance; lay flat by facet
takes the facet's normal as three's `Triangle.getNormal` computes it and turns
it by the volume's rotation, as the workspace does for a picked facet. Two
browser defects were fixed on the way: resetting rotation and scale together
left the rotation untouched (the merged change carried the scale reset's
original rotation), and lay flat and paint picks took the first part in scene
order rather than the nearest; workspace regression tests cover both.
Bindings: WASM `ProjectSession.plan_placement`, the JNI export
`sessionPlacement` and Kotlin `ProjectSession.planPlacement`.

`placement-vectors.mjs` plans 90 requests over the picking scene's plain,
rotated and non-uniformly scaled, and mirrored instances — every operation,
centring and scale-to-fit on areas and volumes from the bed corner, the U1's
(offset 0.5 × 1 mm), one far from the corner and a raised floor, lay flat by
five normals per instance and by facets of the sphere, the modifier and the
terrain — and 20 refusals (empty and repeated selections, unknown instances
and volumes, facets past a mesh, unusable normals, no or an inverted area or
volume). Rust, WASM in Node and Chrome and JNI answer all 90 byte for byte;
181 Kotlin checks cover the wrapper.

### Plate arrangement and bed fill

`placement::arrange` ports the browser's `arrange.ts` (through
`arrangeExchange.ts`): "Arrange" is a deterministic shelf packer over each
instance's canonical footprint (by default the model and support volumes;
any role set on request). It sorts by depth, then width, then UTF-16 ID; it
slides past reserved space; it keeps locked and non-printable instances and
every keep-out region clear; and it centres the packed block when nothing else
reserves space. Footprints stay inside the printable area (`bedAreaMm`, its
corners, which a printer may offset from the bed corner) inset by the bed
margin. An `ArrangeRequest` answers an `ArrangeReply`: the moved
instances (one `setInstanceTransforms` intent) with their footprints, those
that did not fit and those kept in place. "Fill bed with instances" lays copies
of one instance into the free space row by row without moving anything, up to
a copy limit; a `BedFillRequest` answers the new copies' transforms and
footprints and the free slots the limit withheld. Neither rotates anything.
Refusals carry the browser's codes and messages; the browser's fill reported
an unknown instance as an unknown plate and a bad copy limit as bad spacing,
fixed with regression tests. Bindings: WASM `plan_arrangement` /
`plan_bed_fill`, the JNI exports `sessionArrangement` / `sessionBedFill` and
Kotlin `ProjectSession.planArrangement` / `planBedFill`.

`arrange-vectors.mjs` arranges and fills a two-plate scene — the picking
scene's instances plus boxes of several scaled footprints and a non-printable
box — with default, tight and roomy spacing, a keep-out region, locked
instances, a too-small bed, the U1's area and one far from the bed corner (with
a tower there) and other role sets, and every refusal: 18 arrangement and 17
fill requests (14 refusals). Rust, WASM in Node and Chrome and JNI answer all
35 byte for byte; 71 Kotlin checks cover the wrapper.

### Wipe-tower auto-placement

`placement::wipe_tower` ports `wipeTowerPlacement.ts` (through
`wipeTowerExchange.ts`). It scores eight candidates — the printable
rectangle's corners and edge midpoints, inset by 1 mm — by the Chebyshev
clearance of the tower's whole printed footprint (the body grown by the brim,
plus the rib wall's overhang bound when the wall is ribbed) to every printable
part; the requested bias wins ties within 5 mm, or the largest clearance
wins outright. The bed is the requested rectangle, else the plate's then the
project's `printable_area` (a point list or a `,`/`;`-separated string), else a
legacy size. The tower width, brim, wall type and rib sizes are read with the
browser's JavaScript coercions (`Number(...)` of strings and arrays,
`String(...).trim().toLowerCase()`, `??` and `|| 60`). A `WipeTowerRequest`
answers the pick (body corner, clearance — absent when no part bounds it —
label and footprint) and the plate's tower as one `setPlateWipeTower` intent
sets it, keeping an existing tower's rotation and filament, or refuses an
unknown plate or a missing printable area. Bindings: WASM `plan_wipe_tower`,
the JNI export `sessionWipeTower` and Kotlin `ProjectSession.planWipeTower`.

`wipe-tower-vectors.mjs` places towers on four plates whose configuration
exercises every coercion path — a U1-style offset point list, a mixed-separator
string, garbage, string, array and zero tower widths, a ribbed wall and a null
brim — over the picking scene's parts, an empty plate and a plate with an
existing tower, under every bias and request override: 27 requests (3
refusals). Rust, WASM in Node and Chrome and JNI answer all 27 byte for byte;
55 Kotlin checks cover the wrapper. It also records the workspace's
auto-placement through the production controller, which
[the Android app](#android-wipe-tower-auto-placement) replays.

The tower's ghost — the translucent box the browser's workspace draws on the
plate before slicing (`OrcaWorkspace.rebuildWipeTowerGhost`) — is computed by
`wipeTowerGhost.ts` and ported as `placement::wipe_tower::ghost` (through
`wipeTowerGhostWire`). For a plate's enabled tower it answers the body's
front-left corner (`wipe_tower_x/y`, the libslic3r frame, never clamped onto
the bed), its side — the width of the footprint the slice preflight checks
(`wipeTowerFootprint`, now exported from `wipeTowerPlacement.ts` and shared
in Rust as `slicing::preflight::wipe_tower_footprint`: the plate's
configuration over the project's, `Number(prime_tower_width ??
wipe_tower_width) || 60`), drawn at least 1 mm — its height, the top of the
tallest model part on the plate (every instance's model parts as placed, by
the canonical bounds; modifiers, enforcers, blockers and negative parts print
nothing of their own), or a 30 mm stand-in with `standIn` when no model part
rises above the bed, and the margin the brim and rib wall print outside the
body. A plate without an enabled tower answers `none`; an unknown plate or a
box that is not finite (a width of `"1e400"`, a margin that overflows) is
refused. Bindings: WASM `wipe_tower_ghost`, the JNI export
`sessionWipeTowerGhost` and Kotlin `ProjectSession.wipeTowerGhost`.

Porting it found three browser defects, each fixed by drawing the browser's
ghost from the shared plan (`wipe-tower-ghost.test.ts` fails on the old code).
The ghost read its width and margin from the profile's base configuration
(`getSlicingConfiguration().config`), so a plate's own `prime_tower_width` and
brim — which the preflight and the auto-placer honour — were drawn as the
project's, contrary to the one footprint authority. Its height came from the
first display mesh of each instance only, so a taller second part rose out of
the ghost, and a modifier listed first set the height of a tower nothing
prints. And its body was drawn at least 1 mm wide but centred on the
configured width, so a thinner one stood off its corner. The legacy
`activePlateWipeTower`/`projectPrimeTower` reader, which nothing used any more,
is gone.

`wipe-tower-vectors.mjs` adds 13 ghosts: plates whose enabled towers take
width and margin from the plate, the project or neither (`??` past a null,
arrays, a rib wall reading the project's rib width), drawn no thinner than
1 mm, rising to a second model part above the first, turned and scaled
instances and a mirrored open mesh (never a modifier), or standing at 30 mm
over a model sunk below the bed; disabled and absent towers; two overflowing
boxes and an unknown plate (5 drawn, 5 none, 3 refused). Rust, WASM in Node
and Chrome and JNI answer all 13 byte for byte (27 Kotlin checks more), and
the journey records the active plate's ghost after every step.

### Workspace bed

`placement::bed` ports how the browser's workspace reads its bed from a
project (`web/src/workspace/WorkspaceBed.ts`, through
`WorkspaceBedExchange.ts`; `OrcaWorkspace` now calls the module for its
printer-space mapping, scale-to-fit height and arrange keep-out). The bed size
is the far corner of `printable_area` — the polygon as the profile's flattened
text (a string as is, a list of strings joined with commas, anything else
empty), split on `,` and `x` and read with `Number`
(`bedSizeFromProfile`), each side 200 mm when zero; the plate is drawn from
the bed corner to it and printer space is mapped with it. A far corner is not
a size: the printable area is the rectangle the polygon encloses
(`printableAreaRect`, shared with wipe-tower placement), whose origin a
printer may offset from the bed corner (the U1's sits at 0.5 × 1 mm). The
printable height is `parseFloat(String(printable_height))` (a list's first
entry) when positive. Placements use one box, the one the slice preflight
checks: the placement area (`areaMm`, where models are placed, centred,
arranged and filled) is the printable rectangle the preflight reads from the
configuration's engine strings (`preflightPrintableArea` /
`slicing::profile::preflight_printable_area`, its exact four-corner rectangle),
else the printable area, else the bed from its corner; the build volume
(`volumeMm`, which scale-to-fit fills) is that area from the bed up to the
height the preflight reads (`preflightPrintableHeight`), else the printable
height, and none without either. Where the preflight finds no rectangle or
height it refuses to slice, so a placement never leaves a volume the
preflight accepts. An enabled plate tower keeps a square of its drawn
width (`Number(prime_tower_width ?? wipe_tower_width) || 60`) clear when its
plate is arranged or filled. A project answers from the configuration the
workspace reads (`getSlicingConfiguration().config`): its base profile when it
records one, else its configuration — so a project-level override of
`printable_area` does not move the browser's bed. Requests are canonical JSON
(`{"config","wipeTower"}` → `{"areaMm","keepOut","printableArea",
"printableHeightMm","sizeMm","volumeMm"}`, the volume as `{"maxMm","minMm"}`
corners, an absent value or a keep-out edge JSON cannot carry `null`);
`state_bed_json` answers for one plate of a project. Bindings: WASM
`workspace_bed` and `CapturedProject.workspace_bed`, the JNI exports
`workspaceBed`/`projectWorkspaceBed`, Kotlin `WorkspaceBeds.of` and
`ProjectSnapshot.workspaceBed` (`WorkspaceBed.areaMm`, `volumeMm`).

`workspace-bed-vectors.mjs` reads 85 configurations through the production
module — the bundled printers' areas and heights (as lists and as text), every
coercion (`;` separators, upper-case `X` read as hexadecimal by `Number`,
whitespace, exponents, non-string entries, lone surrogates, infinite and huge
coordinates; rectangles the preflight reads and the polygon reader does not,
polygons only the latter reads, an area far from the bed corner), 16 height
spellings and 21 tower widths — refuses 14 malformed
requests, and opens three projects through the real controller (a fresh one,
towers on two plates, a base profile under an overriding configuration) for
12 plate beds. Rust, WASM in Node and Chrome and JNI answer all of it byte for
byte; 201 Kotlin checks cover the wrapper.

### Transform inspector fields

`placement::fields` ports the browser's Tool Settings panel for the Move,
Rotate and Scale tools (`web/src/workspace/TransformFields.ts`, through
`TransformFieldsExchange.ts`; `main.ts` and `OrcaWorkspace` now call the
module). Move shows millimetres, Rotate the degrees of three.js's Euler angles
in its default XYZ order (`Euler.setFromQuaternion` through
`Matrix4.makeRotationFromQuaternion`, the stored quaternion as given), Scale
percent, each as `toFixed(2)`; an edit reads each field with
`parseFloat(text) || 0`, sets the primary instance's translation, rotation
(`Quaternion.setFromEuler(...).normalize()` of the degrees in radians) or
scale (percent / 100), and carries the rest of the selection around it
(`primaryTransformEdit` over `projectMultiInstanceTransform`); every change is
then checked as the workspace checks it before submitting
(`cloneAndValidateTransform`, now `project/objects/transformValidation.ts`):
non-finite values, a zero scale and a zero rotation refuse in the browser's
words, as do a flat or unrotated pivot. The trigonometry is V8's:
`js_math::asin` and `atan2` join the fdlibm port. Bindings: WASM
`transform_fields`, `transform_field_edit` and `transform_rotation`, the JNI
exports of the same names, and Kotlin `TransformFields.values`, `edit`,
`eulerRadians` and `rotation` (`TransformTool` carries the panel titles).

`transform-field-vectors.mjs` drives the production module over three.js's
own classes: 101 field reads (gimbal-locked, unnormalized, mirrored, zero and
seeded rotations; tiny, huge and negative translations and scales), 1,720
Euler ↔ quaternion conversions (a 45° grid, seeded angles, round trips), 94
edits (every `parseFloat` spelling, single instances and selections carried
around each member, 25 refusals) and 19 malformed requests. Rust, WASM in
Node and Chrome and JNI answer all of them byte for byte; 1,936 Kotlin checks
cover the wrapper. The Android app applies an edit to the session's selection
in its [transform inspector](#android-transform-inspector).

### Transform gizmo

`placement::gizmo` ports the workspace's transform gizmo: three.js r184's own
`TransformControls` as `OrcaWorkspace.setup2DControls` configures it (size 1,
world space, no snaps, every axis and plane shown; Move, Rotate and Scale
select `translate`, `rotate` and `scale`), as `TransformGizmoExchange.ts`
drives the real class through its pointer API. Shared, operation for
operation and with V8's trigonometry: the handles' geometry (three's
cylinder, box, torus with its arc — `primitives::geometry::torus_arc` —
sphere, octahedron with detail-2 subdivision and plane generators, then
`setupGizmo`'s Euler-to-matrix baking, rounded to Float32 after each step as
three stores it, and `computeBoundingSphere`); the camera
(`updateProjectionMatrix`, `Object3D.lookAt` through `Matrix4.lookAt` and
`Quaternion.setFromRotationMatrix`, `Raycaster.setFromCamera` through
`unproject`); each render's handle placement (the screen-constant size from
the camera distance and field of view, axes facing the camera and planes
seen edge-on hidden with three's 1e-10 scale, rotate rings turned towards
the eye, the E ring and XYZE sphere looking at it, the helper lines, start
and end dots and delta line) and highlight (the axis and its letters yellow
and opaque); hover picking (`Mesh.raycast`: the world bounding sphere, the
ray in the mesh's inverse matrix, `Ray.intersectTriangle` with back faces
culled for the pickers and both sides for the drag plane, the world
distance, the nearest visible hit and the earlier one on a tie, as three's
stable sort leaves it); and the drags — translate along an axis or in a
plane, rotate (the XYZE trackball, an axis ring by the offset across the
eye, the E ring and a ring seen face-on by the angle between the hits) and
scale (per axis by the hits' ratio in the object's axes, uniformly by their
lengths) — in world and local space (scale always local; E, XYZE and XYZ
always world). Snaps and the ±∞ position bounds are unset in the browser
and not ported beyond the bounds' identity clamp.

Modelling choices, the same in the exchange and the port. Every pointer
event is preceded by a render (`scene.updateMatrixWorld(true)`), so the drag
plane and handles are current when it arrives: in the browser a mouse's
hover keeps them so, while a touch press there would use the previous
frame's plane. A press is the browser's `onPointerDown` — a hover, then a
down — with a render between them, and a press whose ray misses the drag
plane starts no drag (three would start one from stale start values; the
plane passes through the gizmo and faces the eye, so this is a guard rather
than a reachable case). An axis the mode has no plane for, reachable only by
changing the mode during a drag, faces the camera where three keeps the
previous frame's plane direction; hosts release before changing the mode.
A NaN hit distance (a non-finite scene) never picks. The exchange models the
controls, not the app around them: after a drag the browser's
`finishTransformGesture` re-syncs the proxy from the committed project
(`syncTransformProxy`), which a host does by attaching anew at the pose
below.

The core is stateless canonical JSON. A state
(`{"axis","changed","dragging","proxy","rotationAxis","start"}`) carries
what three keeps between events — the axis, the drag, the proxy's pose, the
last rotation axis and what the press captured — every number exactly
(`-0`, `NaN` and the infinities as strings), so a state written and read back
replays as three would; hosts keep it opaque. `attach_json` (`{"proxy"}`)
makes one for new controls attached to a proxy pose
(`{"position","quaternion","scale"}`); `step_json`
(`{"camera","event","mode","root","space","state"}`) applies one event
(`{"kind","x","y"}`: `hover`, `press`, `move` or `release`, the pointer in
normalized device coordinates), its `changed` saying the proxy moved (three's
`objectChange`, the change a host submits); `present_json`
(`{"camera","mode","root","space","state"}`) answers what the gizmo shows
(`{"axis","dragging","handles","proxy"}`: every handle of the mode's gizmo
group then its helper group, each `{"color","group","matrix","name","opacity",
"tag","visible"}`, the world matrix column-major and the colour in three's
linear working space); `geometry_json` the baked geometry of every mode's
gizmo, picker and helper handles (in the order a view lists them: Float32
positions, the triangle index or `null`, a mesh or a line strip) and the
plane's, built once. A camera is `{"aspect","far","fov","near","position",
"target","up"}` (0° < fov < 180°, aspect > 0, 0 < near < far). World units
are the host's: the root maps printer millimetres into them (the browser's
surface root sits at the bed's centre, rotated −90° about X and scaled by
0.00175; a host rendering in metres scales by 0.001), and in world space the
gizmo's axes are three's (Y up: printer Z). A step reads and writes a state
of about 430 bytes, renders the mode's handles (at most 29 with the
pickers) and casts the ray at its pickers' triangles (fewer than a hundred,
812 for the rotate rings); a view is 2–5 KB. In the project WASM a step takes
about 22 µs and a view 43 µs, so a host steps every pointer event and
presents once a frame; the geometry (226 KB) is read once.

What a drag submits is shared too: `gizmoDragChanges`
(`transformGizmoChanges.ts`, which `OrcaWorkspace`'s `objectChange` handler
now calls, with `transformFromObject`) gives one selected instance the
proxy's transform (its quaternion normalized) and carries a selection around
the proxy's pose at the press with `projectMultiInstanceTransform` —
`placement::fields::project`, now public. `changes_json`
(`{"initialProxy","mode","origins","proxy"}`, the tool's `move`, `rotate` or
`scale`) answers `{"changes"}` or `{"error":"invalid_drag","message"}` in the
workspace's words.

So is where the proxy stands. `transformProxy.ts` (which `OrcaWorkspace`'s
`syncTransformProxy` and `captureSelectedInstanceOrigins` now call) takes the
selection summary the workspace reads — the primary selected instance and
every selected instance — and gives the origins a drag carries (the primary
and the selected instances on its plate, in selection order; the primary
alone when the selection leaves it out) and the proxy's pose: one instance's
own (three's `Quaternion.normalize` of its rotation) or the centre of the
selection's bounds (`computeCanonicalInstanceBounds` over every volume role)
unrotated at unit scale. It needs meshes, so it is a session query:
`ProjectSession::plan_transform_proxy` (`placement::gizmo::proxy`,
`{"primaryInstanceId","selectedInstanceIds"}` → `{"origins",
"primaryInstanceId","proxy"}`, `{"proxy":null}` without a primary instance
the project has, or `{"error":"invalid_proxy","message"}` when the bounds
cannot be measured), bound as the WASM session's `plan_transform_proxy`, JNI
`sessionTransformProxy` and Kotlin `TransformGizmo.proxy(session, …)`.
`transform-proxy-vectors.mjs` opens the picking scene with a second plate
through `TransformProxyExchange.ts`: 19 selections (13 placed — plain,
rotated and scaled, mirrored and second-plate instances, pairs, the plate,
selections across plates and a primary outside them — 5 without a proxy and
a duplicated selection refused) and 8 malformed requests; Rust, WASM in Node
and Chrome and JNI over a live session agree byte for byte, and 45 Kotlin
checks cover the wrapper.

`transform-gizmo-vectors.mjs` drives the production exchange over 564
sequences of 14,161 events: 7,660 hovers (misses, and the centres and
vertices of every visible picker handle's triangles projected through
three's camera), 1,372 presses, 3,857 moves (3,693 changes; 36 rays off the
drag plane) and 1,272 releases, every one of the 19 mode and axis drags,
under 13 views (oblique, front, top-down and rolled, edge-on, along an axis,
at the 0.99 axis and 0.2 plane thresholds, from below, with Z up, and three
seeded), fields of view from 30° to 75° and six aspects, three roots (the
browser's, metres and millimetres) and five proxies (identity, rotated,
scaled, mirrored and a selection's pivot), in all three modes and both
spaces. It records each step's change and the SHA-256 of its view, the
geometry whole (66 handles and the plane), 198 drag changes (7 refused) and
34 malformed requests in the hosts' shapes. Rust, WASM in Node and Chrome and
JNI answer all of it bit for bit; 29,197 Kotlin checks cover the wrapper.
Bindings: WASM and JNI `transform_gizmo_attach`, `_step`, `_present`,
`_geometry` and `_changes` (`transformGizmo…` on `NativeProject`), and Kotlin
`TransformGizmo.attach`, `step`, `present`, `geometry` and `changes` over
`GizmoScene`, `GizmoCamera`, `GizmoState` and `GizmoView`. The Android
Workspace draws and drives it ([Android transform gizmo](#android-transform-gizmo)).

### Primitives and helper volumes

`primitives` ports how the browser creates new geometry. The six shapes of
the `add_primitive_*` actions (`primitives.ts`: a 20 mm cube, cylinder,
sphere, cone, 0.2 mm disc and torus) are three r184's generators operation
for operation (`primitives::geometry`: `BoxGeometry`, `CylinderGeometry` with
a cone's zero top radius, `SphereGeometry`, `TorusGeometry`, `rotateX` as
`Matrix4.makeRotationX` through `Vector3.applyMatrix4` with its perspective
divide, every coordinate the same double expression stored as Float32, V8's
`sin`/`cos` from `js_math`), then `toNonIndexed` and `extractTriangleMesh`,
which welds the triangle list into one closed surface (`meshWeld.ts`,
`mesh::weld`: corners within 1e-6 mm become one vertex, first corner's
coordinates kept in corner order, every triangle kept in its order); the
helper volumes' cube is
`createPrimitiveCubeGeometry` (24 vertices, two triangles a face), welded the
same way into a closed box of eight. Each
encodes as the browser's canonical mesh payload (`encodeIndexedMeshAsset`).
What a shape becomes in a project is planned against a session's
acknowledged state: a primitive (`addPrimitive` → `importGeometry` →
`prepareGeometryObject`) is an object named after its file (`cube.stl`), one
model part and one instance on the active plate (or a requested one, an
unknown plate refused as `Unknown plate …`), translated by
`geometryBedPlacement` — now its own module, which `OrcaWorkspace` calls —
to the printable area's centre (the midpoint of its corners) and onto the bed
from three's Float32 bounds (`Math.min`/`max` signed zeros kept); its mesh is shared with an asset the project already
holds with the same digest, layout and bytes, the first in code-unit ID
order, or else a new asset recording the file and `importedAt`; a matching
digest that is not this mesh refuses in the browser's words. A helper volume
(`addHelperVolume`) is a cube part of the object the primary selected
instance, object or part belongs to, named after its role and how many parts
of that role the object has ("Modifier 2"), on an asset of its own; without
such a selection it refuses as the browser does. IDs are drawn in the
browser's order from the request's list — a primitive's asset only when no
asset is shared — and the reply says how many it took. The exchange is
canonical JSON: `{"kind","sizeMm"}` → the payload's bytes;
`{"areaMm","ids","importedAt","kind","plateId","sizeMm"}` (the area
`{"xMax","xMin","yMax","yMin"}`) →
`{"assetJson","idsUsed","objectJson","plateId","reusedAsset"}`;
`{"ids","primary","role","sizeMm"}` →
`{"assetJson","idsUsed","objectId","volumeJson"}`; a refusal is
`{"refusal"}` and a malformed request `invalid_request`. Records travel as the
canonical JSON a host stages. One browser defect was fixed on the way: the
asset a new model shares was chosen by `localeCompare` order, so two assets
holding the same mesh (two helper cubes do) made the choice depend on the
runtime's locale; it is code-unit order now, with a regression test.
A second was found by the Android outputs smoke: `extractTriangleMesh` kept
three's triangle soup, so no two triangles shared a vertex and a wrapped
shape's seam vertices differed by float noise. The pinned engine sliced only
the cube from such a mesh — a cylinder, cone, sphere or disc reported "The
print is empty. The model is not printable with current print settings." (on
Android, Slice All Plates failed on a cylinder added to a second plate) and a
torus lost most of its layers — in the browser's WASM engine and Android's
alike. Every geometry the controller stores (primitives, calibration models,
a model loaded from a URL, the helper volumes' and a cube magnet's box) is
welded now; `every_primitive_is_one_closed_surface` proves each primitive and
the helper cube at three sizes is a closed 2-manifold of the right genus, and `primitive-slice.test.ts` slices every primitive with the shipped
engine (every layer extruding) and the smoke's journey — a cylinder added on
a second plate, sliced alone and by Slice All Plates.
Bindings: WASM `primitive_payload` and `ProjectSession.plan_primitive_object`
/ `plan_helper_volume`, the JNI exports `primitivePayload`,
`sessionPrimitiveObject` and `sessionHelperVolume`, and Kotlin
`Primitives.payload` and `ProjectSession.planPrimitiveObject` /
`planHelperVolume` (`PrimitiveShape`, `HelperVolumeRole`).

`primitive-vectors.mjs` reads every payload from a real controller's
repository — the six shapes at seven sizes and the helper cube at six, 48
meshes (the seven default ones byte for byte, the rest by length and digest)
and 11 malformed requests — and runs 37 plans (on areas from the bed corner,
the U1's and others offset from it) on real controllers in five
recorded states (an empty project, primitives on two plates with helper
volumes and a height range, two assets holding the cube's bytes under `a` and
`B`, and a foreign layout of the same bytes with and without a compatible
twin; 6 browser refusals), each undone, plus 16 malformed plans. Rust, WASM in
Node and Chrome and JNI answer all of them byte for byte; 221 Kotlin checks
cover the wrapper. The same corpus records a creation journey a native workspace replays.

### Paint palette

`facets::palette` ports `projectPaintPalette`: the filament library as the
painting palette. The inheriting default entry comes first, then physical
filaments by tool with `T` badges and materials, then mixed recipes with
their mode badge, gradient stops, recipe summary (`60% T1 / 40% T2`,
`T1 → T2`, manual patterns, rounded as V8 rounds) and engine slot. Disabled
recipes and recipes whose components the project no longer has are
unselectable rows with the browser's reasons; deleted Full Spectrum recipes
are dropped. Colours normalize as the browser does, and keyboard numbers
follow displayed order over selectable rows.

`paint-palette-vectors.mjs` harvests every distinct filament library from
the project corpora (147) and derives eight edge cases (names and colours,
bad colours, tool order, disabled and deleted recipes, missing components,
zero and odd weights, more than nine filaments). Rust matches all 310
palettes. Captured projects serve the palette to hosts
(`CapturedProject.paint_palette`, `ProjectSnapshot.paintPalette`), checked
through the settings projection replay.

### Objects tree

`objects_tree` ports the Objects panel's model: `projectObjectsTree` (plates
by order, then each object's parts with their settings, its instances, its
own settings and its height ranges by lower bound, with the browser's
labels, descriptions, printable state, filament badges, paint counts —
refined leaves where a channel is refined — and settings counts),
`buildObjectTreeView` (expansion, filter tokens that must all occur in a
row's search text, matched rows shown with their ancestors and descendants,
selection, focus and tree accessibility) and the panel's selection rules,
now shared code in `selectionRequest.ts`: replace, toggle (keeping the
previous primary while it remains selected) and range across the visible
rows from an anchor. Search text is folded by the host (`SearchFolding`:
NFKD, then US-English lowercase; ASCII is folded in the core), then loses
combining diacritics, is trimmed and has whitespace runs collapsed.

Hosts keep their view state and send it with each `ObjectTreeRequest` on a
captured project (`CapturedProject.object_tree`, `ProjectSnapshot.objectTree`):
a page of at most 64 visible rows, or the selection activating a row
commits. A request may carry the session's whole selection; the tree sees
only plates, objects, parts, instances and height ranges, as the panel does.
Porting found two browser defects, both fixed with regressions: a stable
imported ID with a lone surrogate made every row ID throw `URIError`
(`encodeURIComponent`), so such a project showed no Objects tree; and search
folding followed the host's default locale, so in a Turkish browser
"Instance" folded to "ınstance" and a lowercase query missed it.

`object-tree-vectors.mjs` records 1,957 browser answers over five states
derived from the browser fixture (non-ASCII, whitespace-laden and
lone-surrogate names and IDs, refined and sparse paint, mixed and inherited
filaments, fractional heights, out-of-order plates, a 40-object plate for
paging) and five model-vector states, with every text the browser folded.
Rust matches all of them; WASM in Node and Chrome and JNI answer the 943 on
the fixture states with the host's own folding, refuse a non-ASCII filter
without a folder, and 605 Kotlin checks cover the wrapper.

### Filament assignment and filament slots

`filaments::assignment` ports what the browser's assignment selector, its
selection filament bar and the headset's swatch row read
(`web/src/workspace/FilamentAssignment.ts`, extracted from
`CanonicalWorkspaceController.getFilamentAssignmentSnapshot` and
`setFilamentAssignments`): the selection's assignable scopes — an object, a
part or a height range, labelled as the browser labels them
(`Object / Part`, `Object / 0.3–7.1235 mm` by `formatZ`), with their own,
inherited and effective filament — each once in first-selected order, an
instance standing for its object (upstream has no per-copy filament); what
cannot take a filament (a plate, an instance the project lacks) kept apart
so a UI never applies to part of a selection; every filament offered,
physical heads by tool then mixed recipes by name, with the selector's
warnings (a disabled head or recipe, a tool outside the printer's heads, no
preset snapshot, a missing or disabled component, mixed materials); and the
assignments a choice makes, refused as the controller refuses them (no
scope, an unknown or disabled destination, an entity the project lacks). The
options were ordered by `localeCompare` in the runtime's locale, so a
Swedish or Turkish browser listed recipes differently; they are now ordered
by code unit (`compareCanonicalText`), as the core orders them — a browser
defect fixed with a regression test. The exchange is canonical JSON
(`FilamentAssignmentExchange.ts`: `{"refs"}` and `{"entities","filamentId"}`
against a project, a refusal as `{"error": message}`), served by captured
projects (`CapturedProject.filament_assignment`/`_changes`, JNI
`projectFilamentAssignment`/`Changes`).

The browser's Filament tab edits its slots — the palette, each slot's
filament and nozzle — and commits them as the live slicing configuration.
Its rules are now production functions in `CatalogSlicingConfiguration.ts`
that `OrcaWorkspace` calls: `editFilamentSlots` (`addFilamentSlot`: the
profile's own filament in `#cccccc` PLA, refused past 16 slots in the
browser's words; `removeAuxiliaryFilamentSlot`: only a slot past the
printer's heads; the palette's `setColor`; `setHeadNozzle`: only a slot
that exists, a nozzle only when it differs — each on slots first
synchronized to the palette) and `projectFilamentSlots` (an opened project's
adoption: physical filaments by tool, a `preset:` preset kept, the nozzle or
0.4, colours as `FilamentPalette.paletteSlotsFrom` normalizes them — `#`
added, an alpha channel dropped — a project without filaments keeping the
palette). `slicing::choices::{edit_slots, project_slots}` port them and
`configuration_exchange::{slots_json, project_slots_json}` answer the
browser's `filamentSlotsExchange` and `projectFilamentSlotsExchange`
(catalog `slicing_slots`, captured `filament_slots`; JNI
`catalogSlicingSlots`, `projectFilamentSlots`).

`filament-assignment-vectors.mjs` drives the production module and the
production controller: 36 selections over three states derived from the
browser fixture (heads out of tool order, a disabled head and recipe,
recipe names whose order differs between code units and any locale, every
distribution mode, mixed materials, inherited and local assignments,
non-ASCII and lone-surrogate names, fractional and 1e21 heights; 5 refused),
18 choices (10 refused) and 16 malformed requests, and a 10-step journey
over the state's canonical 3MF in which the controller's snapshot is the
exchange's answer after every step and each assignment leaves its hash and
undo label ("Assign filament", "Assign 3 scopes", nothing for a choice
already made, a disabled destination refused), then 7 undos. The slot cases
extend `slicing-configuration-vectors.mjs` (below): 96 slot edits (69
edited, 23 unchanged, 4 refused at the limit) and 27 project slots, edited
choices committed. Rust replays both; WASM in Node and a Chrome 150 worker
and the JNI exports answer every reply ([36, 18, 15, 16] and 96 + 27).

### The virtual filament library

`filaments::library` ports the browser's virtual filament library
(`VirtualFilamentLibrary.ts` and its canonical adapter): what the library
shows, what its author dialog computes, and the step each edit submits. The
browser's computations were spread through its DOM file and controller; they
are now production modules it calls — `virtualFilamentLibraryModel.ts` (the
snapshot and its checks, the dialog's fields and their defaults, each mode's
validation, the Match ranking, the Ratio pigment and Gradient previews, the
triangle picker, the rows' summaries), `VirtualFilamentMutation.ts` (the
controller's library snapshot and each edit's plan, which
`CanonicalWorkspaceController` executes) and the adapter's exported search
helpers — and `VirtualFilamentExchange.ts` answers in canonical JSON:

- the library a project shows (captured `virtual_filament_library`, JNI
  `projectVirtualFilamentLibrary`): its heads in engine order with their
  compatibility (`Head n` for a nameless head, `Unknown` for no material,
  colours as `#RRGGBB` with any alpha dropped), and every live FullSpectrum
  recipe projected back to the dialog's validated draft — its mode inferred
  as the adapter infers it, Ratio, Match and Gradient re-derived through the
  pinned projection, a saved Match recipe's own candidate — with its
  references and one-line summary; then the browser's snapshot checks, so a
  library the browser cannot show (an invalid colour) answers `{"error"}` in
  its words. Tombstones and recipes without FullSpectrum state are not
  listed. Porting fixed a browser defect with a regression: a head whose name
  or material was only spaces, or a recipe name whose 120-character cut ended
  in a space, made the adapter refuse the whole library; a blank label now
  reads as absent and the cut name is trimmed;
- the author dialog's opening fields (`virtual_filament_form_defaults`), and
  for typed fields (`virtual_filament_form`) the issues located by field and,
  for a Cycle pattern, by character; the preview line; the validated draft
  once complete; the Match ranking of saved and searched candidates (titles,
  weights, ΔE2000) and the search the fields ask for; the Ratio pigment
  preview and triangle marker; the Gradient preview;
- the triangle picker's proportions for a point (`virtual_filament_triangle`)
  and the pinned Match search's candidates over the library's compatible
  heads (`virtual_filament_match_search`, the browser's worker search);
- an edit's step on a project (captured `virtual_filament_mutation`, JNI
  `projectVirtualFilamentMutation`): add, edit, duplicate (keeping the
  source's availability), enable or disable, delete — removed when nothing
  references the recipe, else a tombstone keeping its references — as one
  intent batch with the browser's label ("Add <name>", "Edit mixed
  filament", "Enable/Disable mixed filament", "Remove mixed filament",
  "Delete mixed filament") and whether the browser submits it as one intent
  or a labelled transaction, or the refusal in the recipe's words (an
  incompatible pair, a disabled or unknown head, a recipe no longer there).

Beneath them, ported line for line: `authoring` (`mixedFilamentAuthoring.ts`:
each mode's checks and engine fields, the Ratio triangle's clamp and wire
weights, largest-remainder Match weights, minimums, CIEDE2000 in binary64 and
the ranking with its ≤ 0.5 pair preference), `cycle_pattern`
(`manualCyclePattern.ts`), `match_search` (`colorMatchSearch.ts`: coarse and
fine pair and triple searches with the browser's bounded heaps, float-staged
Lab and ΔE), `pigment::blend_multi` and `recipe` (`fullSpectrumRecipe.ts`:
the canonical row, the engine's Cycle pair and mix percentage, the
replacement an edit makes). Automatic pairs are not reconciled after an
edit: the browser generates them only when its preference is on, and it is
off by default.

`virtual-filament-vectors.mjs` drives the production modules over six states
derived from the browser fixture (heads in engine order with mixed, disabled
and uncategorized materials and colours with alpha; every mode's recipe, a
tombstone, a legacy recipe, a referenced one and an automatic pair; eleven
heads for bracketed tokens; a library that cannot be shown; the labels the
adapter once refused; one head; no heads): 6 libraries, 27 opened dialogs, 197 validations (96 complete), 12
triangle points, 12 searches, 51 edits (12 refused) and 20 malformed
requests; beneath them 78 Cycle patterns, 57 projections, 46 rankings, 3,000
ΔE pairs in both precisions, 401 blends, 16 palette searches with their
statistics and 19 recipes. A 14-step journey runs the browser's adapter over
the controller on the state's canonical 3MF — a recipe added in each mode
(the Match one from the search), one edited into another mode, a duplicate,
a disable and an enable, deletions removed and tombstoned, an incompatible
pair refused — with the library, the dialog's fields, search and draft, the
exchange's step and the controller's hash and label at each step, then 13
undos. Rust replays all of it; WASM in Node and a Chrome worker and the JNI
exports answer every reply ([6, 27, 197, 12, 12, 51, 13, 20]); and
`ProjectVirtualFilamentChecks` (105 checks) replays the journey on a real
`ProjectWorkspace`.

### Filament sync and model color recreation

Android filament management in the Prepare area (`FilamentPanels.kt`, `PrepareScreen.kt`,
`dev.orcaxr.nativeapp.project`) implements two primary operations aligned with the browser:

1. **Sync Filaments From Printer** (`printer_inspect_filaments`): `DeviceWorkspace.queryFilamentSlots`
   queries Moonraker filament/slot state (`/printer/objects/query?webhooks&extruder...`),
   parsing tool and multi-extruder mappings, spool IDs, materials and hex colors into
   `ProjectIntents.MoonrakerFilamentSlot`. `ProjectWorkspace.syncPhysicalFilaments(slots, newFilamentIds)`
   submits `ProjectIntents.Command.SyncPhysicalFilaments` to the Rust core, updating project slot
   configuration, materials and colors. `SlicingProfiles.adoptPrinterFilaments(workspace, slots)` then
   matches each head slot against compatible catalog presets via `FilamentPresetMatching.matchFilamentPreset`
   (matching vendor, grade, and material type) and re-binds `SlicingProfiles.heads`, staging updated
   slicing configuration so preflight and profile pickers immediately reflect the synchronized materials.
2. **Recreate Model Colors (Full-Spectrum)** (`recreate_model_colors_fullspectrum`):
   `RecreateModelColorsEngine` (`RecreateModelColors.kt`) inspects all model source colors across
   objects, volumes and facet color channels via `ProjectWorkspace.exportJson`. For each source color,
   it computes perceptual distance against physical filaments using `ColorMath.srgbToLab` and
   `ColorMath.deltaE2000`. Matches within threshold (ΔE ≤ 2.0) are bound directly; unmatched colors
   query `VirtualFilaments.search` across compatible physical heads to synthesize CMYK-White-Clear
   mixed blend recipes. `RecreateModelColorsDialog.kt` presents an interactive Compose modal displaying
   source and destination swatches, computed ΔE values, and physical/virtual override selectors.
   Applying matches executes `ProjectIntents.Command.RecreateModelColors` through
   `ProjectWorkspace.recreateModelColors`, atomically binding color mappings across the project graph.

### Printer policy

`orcaxr-printer` holds Moonraker workflow policy shared by every host, with
no I/O: hosts own transports, clocks and credentials and feed it the text
they received. `status` ports `PrintJobStatusModel`. A `/printer/objects/query`
result replaces earlier readings; `notify_status_update` params (or a bare
status) merge into the objects the model reads, nested records field by
field, and a patch that names none of them as an own key is ignored. The
projection keeps unreported fields absent, reads `canceled` as `cancelled`,
clamps progress, accepts whole layer numbers from zero, defaults a missing
target temperature to 0 and withholds the remaining-time extrapolation at or
below 2% progress. Text is parsed by `canonical::parse_javascript`: the
`JSON.parse` grammar, the last of duplicate keys and out-of-range numbers as
infinities (then treated as unreported), within bounds above what the browser
transport admits.

Bindings: WASM `PrintJobStatus`, the JNI `printJobStatus*` exports and Kotlin
`PrintJobStatus`. `print-job-status-vectors.mjs` records 68 browser traces
(873 steps: lifecycles, errors and cancels, query and notification shapes,
nested merges, numbers, text and refusals, plus 60 seeded traces); Rust,
WASM in Node and Chrome and JNI answer every step and leave the browser's
snapshot after each, and 1,747 Kotlin checks cover the wrapper. Porting fixed
two browser defects with regressions: `key in PRINT_JOB_OBJECTS` matched
`Object.prototype` names, so a `constructor` patch refreshed the snapshot,
and merging into object literals let a `__proto__` key replace a record's
prototype, so a patch could make the state `printing` by inheritance.

`control` ports `PrintJobControl.ts` and the action half of
`PrinterStatusSummary.ts`. Availability comes from the reported state and
Klippy readiness, never from what this client last asked for: pause needs a
printing job, resume a paused one, cancel either, and emergency stop and
firmware restart are always offered (also while the state is unreported). A
send plan posts to the command's endpoint, or is refused when the state does
not allow it or an expected file is no longer the one running; a failed send
reports the transport's code, a cancelled one says so. Guarded actions hold
back ordinary commands on a stale reading (recovery commands never depend on
a status query) and carry each command's hold (cancel and firmware restart
800 ms, emergency stop 1200 ms, pause and resume none). `HoldToConfirm` fires
a command only when released at least its hold after the press, taking the
host's clock once per call. `summary` ports the compact status: headline,
detail, clamped progress, facts (layer, elapsed, approximate time left,
temperatures), the reading's age once it can no longer be confirmed, the
recovery a dropped session offers and whether to show itself unasked, with
V8's rounding and number spelling.

Bindings: WASM `print_job_availability`, `print_job_command_plan`,
`print_job_command_failure`, `printer_status_summary`,
`guarded_printer_actions` and `HoldToConfirm`; the matching JNI exports;
Kotlin `PrinterControl` and `HoldToConfirm`. `printer-control-vectors.mjs`
records 45 availabilities, 1,125 send plans, 100 failure sentences, 1,173
summaries (every connection state and error, reading ages across each
boundary), 540 guarded lists and 8 hold traces (35 steps); Rust, WASM in
Node and Chrome and JNI answer all of them, and 3,019 Kotlin checks cover
the wrappers. Generated wire enums now derive `Copy`, and Kotlin codecs for
array roots use their list types.

`tools` ports `PrintToolMapping.ts` and `MoonrakerFilamentSlots.ts`. The
browser runs `/^T(\d+)\b/gm` and `^;\s*key\s*=\s*(.*)$` over the whole
G-code string; `ToolUsageScanner` runs the same patterns over the artifact's
bytes as they arrive (decoded as `TextDecoder` decodes them), keeping at most
one live attempt per declaration, since a line-start `;` either fails it or,
after `=`, begins its capture. A tool counts at a line start (after `\n`,
`\r`, U+2028 or U+2029) when its digits end at a non-word character, below
the sentinel 64; `\s` crosses line ends, so a declaration may span lines,
and `filament_colour` wins over `filament_color`. Slot replies keep the
browser's quirks: loaded flags `true`, `1`, `"1"`, `"true"`; labels lose
control characters by code point, are trimmed, then cut to 128 UTF-16 units;
materials uppercase with full case mapping before collapsing to a family; a
mapping colour uppercases before its hex test (so `ﬀﬀﬀ` reads as white).
Bindings: WASM and JNI `ToolUsageScanner`, `filament_slots` and
`tool_mapping`; Kotlin `ToolUsageScanner` and `PrinterTools`.
`printer-tools-vectors.mjs` records 100 artifacts (hand-written and seeded,
with a BOM, malformed bytes and every line terminator), 20 slot replies and
1,552 mappings; Rust scans each artifact whole and in chunks of 1, 2, 3, 5
and 64 bytes, WASM in Node and Chrome and JNI in 4 KiB appends, and 1,672
Kotlin checks cover the wrappers.

`preparation` ports `PrintStartOptions.ts` and the pure half of
`PrintJobSubmission.ts`. Capability lists come from `/printer/objects/list`,
`/printer/gcode/help` and `/server/info` replies (`result` or the payload
itself; anything malformed is unknown, never empty), and each name counts by
its first whitespace-separated word, lowercased. Levelling is offered for a
`bed_mesh` section or a named `BED_MESH_CALIBRATE`/`G29` command, a timelapse
for Moonraker's component, and an unasked printer is unknown rather than
unable. Plans check every chosen option against what was offered and order
the timelapse setting before levelling, whose script is URI-encoded with a
15-minute deadline. Readiness names the exact reported Klipper and print
states, refusing anything unrecognized; upload names keep the last path
segment with `.gcode`, one `_` per run of refused characters, no leading `_`
or `.`, at most 110 units; a transport failure reads with the server's text
summarized as the browser's error constructor summarizes it. Help command
names travel as a set in UTF-16 order, since only membership is ever asked.
`printer-preparation-vectors.mjs` records 929 answers; Rust, WASM in Node and
Chrome, JNI and 929 Kotlin checks agree on every one.

`workflow` ports `PrintWorkflowController.ts` with the `submitPrintJob`,
`preparePrintUpload` and `validatePrintUploadTarget` flow it drives, as an
effect machine. `PrintWorkflow` runs one send or stored reprint at a time;
every call answers a `PrintWorkflowStep`: the controller's phase, the
progress notices since the last step, the effects issued (each under an id),
and the operation's state. Effects are what the browser awaits or asks
synchronously: capture the session, whether the session or artifact is
still current, a request (`PrinterSend`), the upload, 16 random bytes, the
operator's decision, and `reconcile`, the one readiness query that is not
the operation's (it survives a cancel and carries its own 3-second
deadline). Hosts answer with `resolve` (an outcome) or `resolve_reply`
(Moonraker's `result` as JSON; text that is not JSON is the transport's
`invalid_response`). Internally the browser's async code is Rust async code
polled with a no-op waker: an effect future registers on first poll, a join
issues `Promise.all`'s requests in order, and every answer polls the
operation until it waits again or ends. `cancel` aborts the operation and
withdraws an open confirmation at once; the host fails the operation's
requests and upload in flight as `cancelled`, or lets a reply that already
arrived through, which is checked like any other. Refusals are codes:
`unavailable` (disposed, or an operation already running), `not_pending`
and `mismatch`. The checks, their order and every message are the
browser's: readiness and file management before confirmation, a 128-bit
unique name or an overwrite of exactly the file confirmed (never an active
one), the upload reply's root, path, size and upload-only mode, the stored
size, and before each preparation step and the start a fresh readiness,
mapping, capability and stored-file check; an ambiguous preparation or start
is never retried and is reported with one reconciled readiness.

The browser's sends run on this machine. `SharedPrintWorkflow` hosts it with
`PrintWorkflowController`'s public surface (`PrintWorkflow`, which both
implement): it captures the printer session (a lost session reaches the core
as a cancel), asks the operator, sends requests and the upload (the G-code's
UTF-8 bytes as the multipart file, with elapsed-time ticks while they go out)
over the session's transport, and answers the synchronous questions — random
bytes, whether the artifact and the session are current — at once. Failures
reject with the browser's error classes (`PrinterStorageError` for a refused
stored path). It passes the browser workflow's own 41 tests
(`print-workflow-shared.test.ts`). `PrintWorkflowSwitch` adopts it once the
core has loaded and no send is running; a running send finishes where it
started. All three hosts apply steps in the order the core produced them:
a synchronous answer's step once ran ahead of a cancel the question itself
caused (a session check that cancels), leaving the phase at `confirming`.

Bindings: WASM `PrintWorkflow`, the JNI `printWorkflow*` exports and Kotlin
`PrintWorkflow`. `printer-workflow-vectors.mjs` drives the production
controller through `PrintWorkflowExchange.ts`, which records each input and
the step it produced, over a scripted printer: 402 scenarios (19,688 steps)
covering sends with and without starting, overwrites and collisions,
readiness, mapping and capability drift after each mutation, unverified
uploads, uncertain preparation and starts with every reconciliation, refused
stored paths, controller misuse, and cancel (with and without late replies),
session loss and artifact staleness at every single effect. Rust, WASM in
Node and Chrome, JNI and 19,689 Kotlin checks reproduce every step. This
corpus pushed the Chrome runner's single `evaluate` call past the DevTools
pipe's 100 MiB message limit, so the page now fetches its four largest
corpora from its own intercepted origin. Porting
fixed four browser defects, each with a regression: the controller
re-checked currency after the printer accepted a start, so a session that
changed in that window reported "Send failed … Confirm a new send" for a
job that was printing; `assertStoragePath` let a lone surrogate through to
`encodeURIComponent`, which threw "URI malformed"; a readiness query the
operator cancelled read as an unknown state and was reported as "cannot
accept this operation" or "readiness changed"; and a reprint cancelled while
reading metadata reported a stale context. The reprint also re-checks the
abort after its session answers, since in the machine that answer is a step
a cancel can land in before the start request.

`session` ports `PrinterSessionController.ts`: the owner of one selected
printer and of every query, subscription and command in its session. It is
an effect machine with several tasks in flight: refreshes (asked for, or
started by the session when it connects, the job changes or a command ends),
connects and commands. A `PrinterSessionStep` reports how many times the
session changed, the effects issued (open a transport, answered with its
state; connect; a request or recovery command, each tagged with its epoch;
a confirmation dialog), the effects withdrawn, transports to close, epochs
ended, the task a call started and the tasks that finished (by task id).
Transport state changes and notifications are inputs; replies carry the
host's clock, which the status model stamps on its snapshot. An epoch
equals the generation: a printer switch, clear, status or generation change,
or a new socket ends it, and its requests fail as `cancelled` and its dialogs
are withdrawn at once, as the browser's transport and dialog guard do. Tasks
are polled when their effect settles, in the order effects settle; a task
the session starts is polled before anything else, and nothing runs while a
transport is being opened, so what the browser does synchronously happens
here in the same order. The status model a refresh publishes is shared with
it (the browser aliases one object), so a reset or a later query reaches
both. Queries answer directly: availability with the reason each command
is held back, `capture_intent` (bound to the printer, generation and
running job at press time), `confirm` (a single-use token for that intent),
`capture_lease` and `lease_current` for sends.

Bindings: WASM `PrinterSession`, the JNI `printerSession*` exports and
Kotlin `PrinterSession`. `printer-session-vectors.mjs` drives the production
controller through `PrinterSessionExchange.ts` over a scripted transport,
numbering its epochs as they are made and fixing its clock: 80 scenarios
(the browser's own session tests, connection and notification cases, leases,
refused identities and 40 seeded interleavings) of 3,254 steps, each with
the view after it, and 557 query replies. Rust, WASM in Node and Chrome, JNI
and 3,820 Kotlin checks reproduce every one.

The browser's printer session runs on this machine. `SharedPrinterSession`
hosts it with `PrinterSessionController`'s public surface (`PrinterSession`,
which both implement): it opens transports (subscribing them to the job
objects and answering the opening with their first state before any listener
runs), feeds their states and notifications in, carries out connects,
requests and recovery commands on each epoch's signal, and runs confirmation
dialogs; an epoch the core ends aborts that signal, and a failed exchange's
own error object is what the call rejects with. Intents and confirmations
are the core's ids behind frozen browser objects. It passes the browser
session's own tests (`printer-session-shared.test.ts`, 21 sessions). The
session exists from startup but the core loads on demand, so
`PrinterSessionSwitch` serves the browser controller until the core has
loaded and adopts the shared session while no printer is selected
(connecting waits for the core); a session in use keeps its implementation.

`moonraker` ports the transport's pure policy (`MoonrakerEndpoint.ts`,
`SessionCredentials.ts` and the helpers of `MoonrakerTransport.ts`). URLs
follow the WHATWG URL Standard through the `url` crate, with ICU4X IDNA, so
an entered endpoint normalizes exactly as `new URL` does: hosts, IPv4 in
every spelling, bracketed and bare IPv6, internationalized names, default
ports, dot segments and backslashes. A request path must be rooted, free of
traversal (also percent-encoded) and of credential-named query keys.
Credentials are one API key or one bearer token, never in a URL; a refused
response reports Moonraker's own message, with control runs, URLs, secrets
and credential-shaped assignments redacted and the text summarized. The
handshake reads the API version (array or string), components, warnings
and printer state into a capability manifest within the supported range;
reconnects back off exponentially with jitter. Porting fixed two endpoint
defects with regressions: the URL parser forgets a port equal to the
scheme's default, so `printer:80` became `printer:7125`, and an empty `?` or
`#` passed the query and fragment checks and stayed in the WebSocket URL,
which a WebSocket refuses. A server listing more than 256 components is
refused. Bindings: WASM and JNI `moonraker_*` functions
and Kotlin `MoonrakerPolicy`; `moonraker-policy-vectors.mjs` records 805
answers (85 endpoints, 180 paths, 14 credential sets, 144 refused responses,
44 handshakes, 11 policies, 264 delays, 14 subscriptions, 49 method checks),
reproduced by Rust, WASM in Node and Chrome, JNI and Kotlin. The project
core's package bound rose from 8 to 10 MiB for this (the measurements are in
`package-browser-core.mjs`); JNI exports may now return a `double`.

`transport` ports `MoonrakerTransport` as an effect machine with several
tasks in flight: a connect (shared by callers while it runs) with its
two-request handshake and socket, the identify and subscription frames, the
heartbeat and its timeout, reconnects with jittered backoff until the policy
is exhausted, and every request, upload, download and recovery command with
its deadline, a body deadline sized by the declared length, size bounds and
the caller's abort. Effects are what the browser awaits or asks
synchronously: fetch, read a body as text or bytes, open, write or close a
socket, arm or clear a timer, draw a random number; a step also lists the
tasks that finished, the effects to fail as aborted, and diagnostics. Hosts
answer with `resolve` (an outcome of the effect's kind) or `resolve_text`,
and feed socket events and fired timers in; an answer nothing awaits is
`not_pending`, one of another kind `mismatch`, and changes nothing. What
the browser does synchronously (a random draw, a socket's construction)
resumes before anything else, and woken tasks run in settle order, so
`Promise.all` and listener order hold. Text past `MAX_TEXT_UNITS` (2 Mi
UTF-16 units) decides every outcome by its length alone, so a host passes at
most one unit more. A step never carries a reply or notification params: a
finished result gives its UTF-16 length and a notification its id, and the
host takes the JSON text with `take_result(task)` or `take_params(id)`, once.
Steps are encoded under the intent contract's bounds (1 MiB, 131,072 nodes),
which a 200 KB `configfile` reply as UTF-16 units would exceed; with the
texts beside it, and at most 512 requests in flight and 256 server
components, every step stays within them.

Porting fixed browser defects. A socket blink aborted every HTTP request in
flight (the transfer the session generation was meant to keep), so an upload
was cut off mid-transfer and a start the printer may have accepted read
`cancelled`; a lost socket now leaves HTTP work alone, and a session that
cannot come back (reconnects exhausted or refused) ends it, as a failed
first connect does. The browser test that claimed the upload survived passed
only because its fake fetch ignored the abort signal. A request refused for
its deadline stayed in the active set for good; the deadline is now checked
before the request is counted.

Bindings: WASM `MoonrakerTransport`, the JNI `moonrakerTransport*` exports
and Kotlin `MoonrakerTransport`. `moonraker-transport-vectors.mjs` drives the
production transport through `MoonrakerTransportExchange.ts` over a scripted
fetch, socket, scheduler and random source: 84 scenarios (the browser's own
transport tests, configurations, handshake failures, deadlines, downloads,
headers, aborts, notifications, heartbeats, reconnects, refused answers,
text past every bound, a large reply and notification, the bounds and 30
seeded interleavings) of 2,533 steps, each with the state after it and the
64 result and params texts beside them, 94 replies and 20 refused answers.
Rust, WASM in Node and Chrome, JNI and 2,648 Kotlin checks reproduce every
one.

The browser runs its printer connections on this machine.
`SharedMoonrakerTransport` hosts it with the browser transport's public
surface (`MoonrakerConnection`, which both implement): it fetches, reads
bodies, opens and writes sockets, keeps timers and draws random numbers, and
translates between the contract and the browser's types. Steps apply strictly
in the order the core produced them; a synchronous effect (a socket's
construction, a random draw) is answered before any listener runs, so nothing
else reaches the core in between; a trap in the core is never swallowed, only
`not_pending` and `mismatch`. The host passes the browser transport's own tests
and both Moonraker simulators (a real HTTP server: uploads, storage, prints),
29 transports in all, with the same fakes
(`moonraker-transport-shared.test.ts`).

On Android, `MoonrakerClient` (core-bridge) hosts the same machine over
OkHttp 4.12: HTTP exchanges with no redirect followed (a redirect fails the
exchange, as `fetch` with `redirect: "error"` does), no retry and no deadline
of OkHttp's own, multipart uploads from the caller's fields and bytes, body
reads on an I/O pool bounded to what decides any outcome (text past
`MAX_TEXT_UNITS`, downloads past 256 MiB), an OkHttp WebSocket, scheduled
timers and `SecureRandom` draws. Every call into the core runs on the
client's one thread, steps apply in the core's order, and listeners run
there; calls answer `CompletableFuture`s with a `cancel()` that aborts as a
caller's signal would. `moonraker-client-test.mjs` runs it end to end on the
host JVM against the Moonraker simulator (a real HTTP and WebSocket server, on
a worker thread because the JNI bridge blocks the main one): handshake,
credentials, queries, a held upload cancelled in flight, upload and download
byte for byte, refusals before anything is sent, the printer's status
notification after a start, heartbeats, a 404 with the server's own detail,
recovery and a disconnect — 21 Kotlin checks, then what the printer received.
Plain HTTP and plain WebSockets reach only the local network:
`LanTransportPolicy` is a network interceptor on every client's OkHttp, so it
judges the address the connection actually reached, after name resolution —
loopback, link-local, RFC 1918, IPv6 unique-local (fc00::/7) or the RFC 6598
shared space VPN overlays use — and refuses anything else, or any cleartext
through a proxy, with `CleartextRefusedException` before a byte is sent. The
app's network security config permits cleartext because typed addresses
cannot be named by domain rules, and trusts only the system's certificate
anchors. Its checks redirect sockets to the simulator while a fake resolver
names a public or a private address, so only the judged address differs.
Android 17 adds a second gate: an app targeting it may not use the local
network until the operator grants `ACCESS_LOCAL_NETWORK` (the "nearby
devices" group), and a blocked TCP connection is not refused but left to
time out — indistinguishable from a printer that is switched off. So
`LocalNetworkAccess` judges every exchange before it connects: a `.local`
name (resolved by multicast DNS, which itself needs the permission) or an
address on the local network (private, link-local, unique-local or
multicast, IPv4-mapped included; never loopback or the public internet)
needs the permission, and without it the exchange fails at once with a
`LocalNetworkDeniedException` that names the remedy. It is an application
interceptor on the client's OkHttp, so it runs before resolution and
connection for HTTP and WebSocket alike, and it asks the permission afresh
for every exchange (`AndroidLocalNetwork.permission` reads it from the
platform; before Android 17 the network itself grants it), so a grant, a
denial or a revocation in the system settings takes effect on the next
exchange, with no state to go stale. The app declares the permission, which
implies no hardware feature. Its 28 checks classify addresses and names and
drive a client against the simulator: refused promptly while denied, a
`.local` name refused before it is resolved, connected once granted, its
next request refused after a revocation, and reaching the printer again on a
new grant — the simulator receives exactly the granted exchanges. Asking the
operator, and explaining a refusal, belong to the application shell.
`PrinterSessionClient` hosts the session machine over those clients the same
way: it opens a client when the core asks (subscribing it to
`status::OBJECTS` and answering the opening with its first state), feeds its
states and notifications in, runs connects, requests and recovery commands on
each epoch (cancelling what an ended epoch carried) and the dialogs commands
bring, and rejects a failed connect with the client's own fault. Against a
fresh simulator its 17 checks select, connect, identify a started job from
the printer's history, pause and resume it, spend an unconfirmed cancel, send
a confirmed one, stop with a dialog, and end a lease with a clear; the printer
receives exactly `start, pause, resume, cancel, emergency-stop`.
`PrintWorkflowClient` hosts the submission machine over a session lease:
it captures the session (one that ends reaches the core as a cancel), asks
the operator, sends requests and the multipart upload over the lease's
client — streamed from the artifact's source of known length, never held in
memory (`MoonrakerUpload` fails an upload whose source yields another length)
— answers random bytes and currency at once, and stops what a cancelled
operation started while the reconciling query runs on. Its 12 checks upload
under a fresh `part_<128-bit hex>.gcode` name and verify it, take the
requested name on an overwrite, offer the existing file's identity when the
operator then declines, reprint the stored file, and refuse a send to the busy
printer after a confirmation that names why; the printer holds exactly the
two uploads and one start.

It runs on the printer core, a package of its own (`core/browser/printer`,
`web/public/core-printer/<manifest-sha256>`, the `printer` feature; 1,495,957
WASM bytes against the project core's 8.8 MB, bounded at 3 MiB), loaded on
demand in its own chunk by `SharedPrinterCore`, verified like the preview core
(length, SHA-256, handshake) and precached by both service workers with its
host chunk, so a printer on the LAN stays reachable offline.
`printer-wasm-test.mjs` replays every printer corpus on the packaged bytes.
`PrinterConnections` selects the implementation: the shared core by default,
the browser transport as the rollback (`?printer-transport=typescript` or the
stored `orcaxr.printerTransport`), which also serves a connection made while
the core cannot load. A configured printer starts the load at startup, and
connecting waits for it.

### Printer storage

`orcaxr_printer::storage` ports `PrinterStorage.ts`: what is already on the
printer and what may be done with it. An operation (list a folder, read a
file's metadata, download, delete, move, rename, start a stored file) is
planned — the request or download it sends, or why it is refused before
anything leaves — and the host carries the exchange out; an exchange that
ended without a reply to read (done, failed with the transport's fault, or
cancelled: `PrinterExchangeOutcome`) is finished into its result, and a
listing or metadata reply is read as the browser reads it. Every operation
names its exact target: a path checked before anything is sent (not empty,
at most 4,096 UTF-16 units, no `.` or `..` segment to step outside the
`gcodes` root, no lone surrogate a URL cannot spell), a rename landing in
the file's own folder under a new name that may carry no separator. A
missing fact stays missing: a file Moonraker never scanned has no
modification time and no thumbnail, never a zero. Failure messages are the
browser's sentences, the transport's code or `cancelled` appended. Folders
list by name and files newest first (by UTF-16 code units, as JavaScript
compares strings), thumbnails largest first. Replies are parsed as
`JSON.parse` reads them (`canonical::parse_javascript`) under the 8 MiB
bound every printer reply shares (`reply::LIMITS`), so any reply the
transport admits (2 Mi UTF-16 units) is read whole.

Any such reply also crosses a binding. Results travel under the intent
contract's bulk tier, and the wire is linear in the reply: a listing carries
its path once and each entry's name (an entry's path is the two joined,
`entry_path`), metadata each thumbnail's path as the printer reported it
relative to the file's folder (`thumbnail_path`), and text a printer
reported is `PrinterReplyText` (up to 2 Mi units) rather than the edit
contract's 131,072. Operation text is bounded by the path rule, so every
request, destination and sentence fits. A test fills replies to the
transport's bound with the widest units — over 160,000 entries in the
longest folder, one name as long as a reply, over 40,000 thumbnails — and
each result encodes and decodes.

Porting fixed two browser defects: a modification time too large to be a
time in milliseconds became `Infinity`, which sorted and printed as
nonsense, and now reads as unreported, as a missing one does; and a path
longer than any a printer holds was sent whole, percent-encoded into a URL
no server accepts, and is now refused before anything is sent.

Bindings: WASM `printer_storage_plan`, `printer_storage_finish`,
`printer_storage_read` and `printer_storage_size`, the matching JNI
`printerStorage*` exports and Kotlin `PrinterStorage` (with `entryPath` and
`thumbnailPath`). `printer-storage-vectors.mjs` drives the production
functions through `PrinterStorageExchange.ts` over a scripted transport,
which checks each entry and thumbnail path the browser built is the joined
one: 218 plans (every operation over valid, hostile, edge-case and
bound-length paths and names), 1,460 finished exchanges (every operation
against every outcome and transport fault), 326 replies read (well-formed,
partial, mistyped and hostile listings and metadata, seeded random replies
and a listing of 3,000 files), each with the paths the browser joined, and
64 sizes. Rust, WASM in Node and Chrome, the printer core, JNI and 2,068
Kotlin checks reproduce every one, and Rust and Kotlin join the browser's
paths.

### Print history

`orcaxr_printer::history` ports `PrinterHistory.ts`: what a printer has
already printed. A page of job records or the printer's totals is planned
(the request, or why the page is refused: a limit outside 1–100 or a start
that is not a safe whole number), its exchange finished, and its reply read
as the browser reads it, through the same reply helpers and transport
endings as storage (`reply`). A page is a page: it holds no more rows than
it asked for and pages by the printer's own count. Reported or absent,
never zero: a job Klipper never finished has no end time, an outcome this
Moonraker build does not know reads as interrupted with its own word kept,
and a count that is not a whole number of jobs reads as unreported. The
module also ports how the history panel describes what it read — durations,
filament lengths, the gap against the slicer's estimate, a job's outcome
and facts, the totals line, and the pager's bounds and label — so a host
shows the browser's words (the job's start time aside, which each host
formats in its own locale).

The wire is linear in the reply, as storage's is: a page holds at most 100
jobs, a job carries the printer's own id only where it differs from the
filename the id falls back to (`job_id`), and printer-reported text is
`PrinterReplyText`. A test fills replies to the transport's bound — one job,
and a full page — with the widest ids, names and outcomes, and every result
and job view encodes.

Porting fixed five browser defects, each with a regression test: a start
time too large to be a time read as `Infinity`; a reply with more rows than
the page asked for showed the extra rows again on the next page; a count
that was negative, fractional or past the safe integers paged by it (a
`1e300`-job history); a start past the safe integers was sent as
`start=1e+21`, which the printer cannot read; and a gap against an estimate
too large to be a number read "+Infinity% vs estimate".

Bindings: WASM `print_history_plan`, `print_history_finish`,
`print_history_read`, `print_history_duration`, `print_history_filament`,
`print_history_job_view` (a bulk-tier input), `print_history_totals_text`
and `print_history_page_view`, the matching JNI `printHistory*` exports and
Kotlin `PrintHistory` (with `id`). `printer-history-vectors.mjs` drives the
production functions through `PrintHistoryExchange.ts`: 290 plans (every
start and limit edge), 1,363 finished exchanges, 258 replies read (each
with the ids the browser gave its jobs), 55 durations, 55 lengths, 76 job
views, 23 totals lines and 39 pager views. Rust, WASM in Node and Chrome,
the printer core, JNI and 2,159 Kotlin checks reproduce every one, and Rust
and Kotlin give every job the browser's id.

### Printer console

`orcaxr_printer::console` ports `PrinterConsole.ts`, the one printer surface
with no guard rails of its own: whatever is typed goes to the firmware. A
script is assessed before it is sent — each line named as Klipper names its
command, classified against the console's dangerous, caution and report-only
tables (anything else, every user macro included, is `caution`), the
riskiest line deciding, and a printing or paused job making anything that is
not report-only dangerous. A send is planned (refused when empty, longer
than 4,096 units, or holding text no URL can spell) and finished; the
printer's macros are read from `configfile.settings` with their parameters
taken from the bodies (`params.X`, `params['X']`, `|default(...)`) and their
risk from their own content; a macro invocation is spelled or refused; and
transcript lines are redacted on the way in (`moonraker::redact_text`),
notifications classified as received or error, and sent commands recalled
newest first without repeats. The host keeps the bounded transcript itself.

A command is named the way Klipper parses a line: runs of letters or a `*`,
the command taken from the first run and the text after it, after a leading
`N` line number. Older Klipper builds also skip anything before the first
letter, so the console reads a line the way that runs the most. Macro
parameters are written as Klipper's shell-like parser reads them back:
a value holding white space, a quote, a backslash or `#` is double-quoted
with `"` and `\` escaped, and a value holding `;` or a line break, or a name
Klipper would split, is refused, since Klipper cuts a line at `;` even inside
quotes. Macros list by name, then by section, so their order never depends
on the reply's key order. Results that carry a printer's or operator's text
(assessments, plans, results, invocations) travel on the bulk tier.

Porting fixed browser defects, each with a regression test: a line Klipper
runs as an emergency stop or a stepper release — `N10 M112`, `M112X`,
`M112*45`, `M84E`, and on older builds `1 M112` or `M 112` — was named by
its first token and read only as unknown; a script with a lone surrogate was
reported as "The printer refused …" though nothing was sent; macro values
holding `#` or a backslash arrived truncated or altered and a quoted line
break arrived as a backslash and `n`; and macros sharing a name listed in
the reply's key order.

Bindings: WASM `console_assess`, `console_plan`, `console_finish`,
`console_read`, `console_invocation`, `console_line`, `console_notification`
and `console_recent`, the matching JNI `console*` exports and Kotlin
`PrinterConsole`. `printer-console-vectors.mjs` drives the production
functions through `PrinterConsoleExchange.ts`: 408 assessments (line
numbers, glued parameters, comments, line endings, Jinja, case mapping,
every table entry and job state), 44 plans, 284 finished exchanges, 51
configuration replies read, 76 invocations, 33 transcript lines, 34
notifications and 28 recalls. Rust, WASM in Node and Chrome, the printer
core, JNI and 958 Kotlin checks reproduce every one.

### Printer cameras

`orcaxr_printer::camera` ports `PrinterCamera.ts`: watching the print.
A printer's camera list is read against the endpoint the session uses, each
reported URL resolved by the URL Standard (the `url` crate): a relative path
belongs to the printer's web origin — nginx on the scheme's default port,
where a stock install serves `/webcam/` — with Moonraker's own path kept as
a second candidate; an absolute URL on Moonraker's origin yields both; one
on the same host at another port is another service, loaded without the
printer's credential; another host is refused, so a camera list never makes
the app a request forwarder. Only snapshots are shown, at the camera's rate
bounded to 0.2–4 frames a second. A frame's route is planned
(`snapshot_plan`: the camera's own URL fetched directly within 8 seconds,
or Moonraker's path downloaded through the transport with the credential)
and a failed fetch read (`snapshot_failure`: cancelled, a status, a
timeout, the platform's own reason, or the transport's code); the routes
worth trying from a page (an image where the page can load it, a direct
fetch where it cannot, the transport last), the service's description, the
poll interval and a frame URL made unique per frame are answered too. The
browser's snapshot fetch now runs on the same planner and failure reader,
so the shell and the exchange share them. Requests carrying a camera back
travel on the bulk tier, since a camera holds the printer's own text.

Porting fixed two browser defects, each with a regression test: a relative
snapshot path on an IPv6 printer cut the host at its first `:`, giving
`http://[fd00/webcam/…`; and the service description quoted the camera's
own rate where frames are fetched at the bounded one ("0.1 fps" for a
camera polled at 0.2).

Bindings: WASM `camera_list_plan`, `camera_list_finish`,
`camera_list_read`, `camera_snapshot_plan`, `camera_snapshot_failure`,
`camera_mechanisms`, `camera_describe`, `camera_poll_interval` and
`camera_frame_url`, the matching JNI `camera*` exports and Kotlin
`PrinterCamera`. `printer-camera-vectors.mjs` drives the production
functions through `PrinterCameraExchange.ts`: 62 listings read against
twelve kinds of endpoint (relative, rooted, same origin, other ports and
hosts, IPv6, credentials, unreadable URLs, every service, rate and
rotation), 12 finished listings, 462 frame routes and 462 failed fetches,
616 route lists, 308 descriptions, 154 poll intervals and 154 frame URLs.
Rust, WASM in Node and Chrome, the printer core, JNI and 2,231 Kotlin
checks reproduce every one. The polling lifecycle (stopping when hidden or
disposed) and the route fallback state stay with each host's panel.

### Android home screen printer camera widget

Android home screens can host an interactive glanceable camera widget (`PrinterCameraWidgetProvider`, declared in `printer_camera_widget_info.xml` as a 3×2 resizable card) watching any configured printer:
- **Configuration Activity (`PrinterCameraWidgetConfigureActivity`)**: Launched when placing a widget or tapping setup. It presents saved printers from `PrinterDirectory`, queries Moonraker `/server/webcams/list` to enumerate available cameras, and provides a live preview bitmap before saving preferences via `PrinterCameraWidgetPrefs`.
- **URL Resolution (`PrinterCameraDiscovery`)**: Snapmaker U1 and Moonraker camera streamers often serve snapshots via reverse proxy (e.g. nginx on port 80) rather than Moonraker's daemon port 7125. `PrinterCameraDiscovery.resolveCandidateUrls` evaluates the web origin (default HTTP/HTTPS port) before trying Moonraker's direct host/port, ensuring snapshot streams (`/webcam/snapshot.jpg` and `/screen/snapshot`) resolve correctly regardless of reverse proxy topology.
- **Binder Transaction Safety & Downsampling (`PrinterCameraWidgetFetcher`)**: Android enforces a strict 1MB Binder buffer limit on IPC transactions, including `RemoteViews`. `PrinterCameraWidgetFetcher` decodes snapshots with `inSampleSize` downsampling and `Bitmap.Config.RGB_565` (bounded to 800×600), then applies hardware rotation and horizontal/vertical flips to match Moonraker's camera definition.
- **Interactivity & Deep Linking**: The widget includes an in-place refresh `ImageButton` that triggers an immediate background fetch with progress spinner without launching the application. Tapping the camera frame or card launches `MainActivity` with deep link extras (`EXTRA_NAV_AREA = "device"`, `EXTRA_PRINTER_ID`, `EXTRA_DEVICE_TAB = "camera"`), switching directly to the live camera tab for that printer.
- **Unit Testing Without Android Mocks (`SimpleJson`)**: Local JVM tests (`PrinterCameraWidgetTest`) parse camera listings and resolve candidate URLs using `SimpleJson`, a zero-dependency pure Kotlin JSON parser that runs without Android SDK stubs or external library changes.

### Printer directory

`orcaxr_printer::directory` ports `PrinterDirectory.ts`: named printers and
one default, kept on the device. Each entry owns its address, credential and
capability record, so nothing carries across a switch. A machine is the
endpoint its address names (`address`, the shared Moonraker endpoint
normalization), so `Printer.local`, `printer.local:7125` and
`http://printer.local:7125` are one printer while another port or a path
behind a proxy is another, and an address no endpoint can be made from is
refused when it is saved rather than discovered at connect time. The stored
directory is read (`load`: an unreadable store is an empty one, a repeated
id keeps its first printer, a default naming no printer falls to the first,
at most 16 printers) and written (`save`) in the browser's own stored form,
each entry's keys in one order — the browser now writes that order too,
whatever edits built the entry, so both hosts store the same text. Every
edit is a pure step: add (under an id the host draws), update, remove
(promoting the first remaining printer when the default goes), choose the
default, adopt a legacy single endpoint. Discovery is not ported: the
browser reports it unavailable, while Android offers the platform's own
(DNS-SD, under Android Device area).

Porting fixed five browser defects, each with a regression test: another
spelling of a saved address was saved as a second printer, each with its
own credential and tool map; an address no endpoint could be made from was
accepted until connect; a name at the length limit was cut inside an emoji,
keeping half a character; a repeated id in the store showed two printers of
which removing one removed both; and a tool count a reload would drop was
stored anyway.

Bindings: WASM `printer_directory_load`, `printer_directory_save`,
`printer_directory_add`, `printer_directory_update`,
`printer_directory_remove`, `printer_directory_set_default` and
`printer_directory_adopt`, the matching JNI `printerDirectory*` exports and
Kotlin `PrinterDirectory`. `printer-directory-vectors.mjs` drives the
production functions through `PrinterDirectoryExchange.ts` along 24 seeded
edit sequences and the printer limit: 37 stored directories loaded
(corrupt, partial, repeated ids, too many printers, stale defaults, long and
broken text, and every saved directory), 25 saved, 160 adds, 60 updates, 44
removals, 41 defaults and 15 adoptions. Rust, WASM in Node and Chrome, the
printer core, JNI and 382 Kotlin checks reproduce every one, and every saved
text loads back as itself.

### Remembered credentials

`orcaxr_printer::credentials` ports `RememberedCredentials.ts`: the printer
keys and slicer token remembered on a device, under a switch the operator
can turn off and a way to forget them. The record is read from and written
to the browser's stored text (`load`, `save`): a secret longer than any
issued key (4,096 units) is dropped rather than stored, at most 32
per-printer keys are kept, remembering off stores the switch and no secret,
and a record with nothing in it removes the stored text. The per-printer
keys are read in key order, so which are kept, and the order they are
written back in, never depend on how a store listed them; the browser now
reads them that way too (it used to keep whichever 32 a store listed first).
An id of `__proto__` is dropped, as assigning it on a plain JavaScript
object sets nothing.

On Android, `CredentialVault` (core-bridge) keeps that text sealed. The
`SealingCipher` is AES-256-GCM with the cipher's own random IV and the
purpose authenticated alongside, so a blob sealed for one use cannot be
opened as another; its key comes from a `SecretKeySource`, in the app a
non-exportable Android Keystore key (`AndroidKeyStoreKeys`), and the sealed
blob lives in a private preferences file (`SharedPreferencesBlobStore`)
that the app's backup and device-transfer rules exclude, as they exclude
all app data. Forgetting removes the blob and the key, so nothing sealed
before can be opened again, and a blob that no longer opens (tampered, or
its key gone) is forgotten rather than kept. The host checks run the vault
over a software key (17 checks: no secret in the clear, a fresh IV per seal,
the switch, tampering, a lost key, purpose binding, forgetting), and
`CredentialVaultTest` runs it over the real Keystore on an owned emulator.
The Android-only adapters live apart (`AndroidSecrets.kt`), so the host JVM
loads none of them.

Bindings: WASM `credentials_load` and `credentials_save`, the JNI
`credentials*` exports and Kotlin `RememberedCredentialsPolicy`.
`printer-credentials-vectors.mjs` drives the production functions through
`RememberedCredentialsExchange.ts`: 79 stored records loaded (corrupt,
hostile, oversized secrets, many keys in any order, ids past their length,
the switch, and every saved record) and 63 records saved; Rust, WASM in
Node and Chrome, the printer core, JNI and 142 Kotlin checks reproduce
every one.

### G-code artifact summary

`orcaxr_gcode::artifact` is the browser's G-code artifact summary
(`GcodeArtifactSummary.ts`): `summarize` reads, from the end of the file as
the browser does (the last 64 Ki units), the estimated and first-layer
times, total weight and cost, layer and tool-change counts and each tool's
length, volume and weight, and from anywhere the filament colours and types;
only that tail is decoded, the rest is searched line by line on the raw
bytes (two property tests prove the result equals decoding everything).
`describe` writes the panel's text (`≈45m 50s · 18.56 g · 225 layers · 88
tool changes` and one line per tool), now one definition shared with the
browser's `describeArtifactSummary`. `gcode-summary-vectors.mjs` records 101
browser summaries (both repository G-code fixtures, realistic Orca output,
odd numbers and durations, hostile colour text, 300 tools, CRLF, BOM,
invalid bytes, cuts around the 64 Ki boundary) and 31 durations; Rust
matches them exactly. Porting found that the browser put a G-code file's
`filament_colour` text straight into a swatch's CSS — a crafted file could
inject styles or make the page fetch a URL; only a hex colour now gets a
swatch, in both. The browser never fills per-layer times, so neither does
the core; totals the engine writes before a settings block longer than the
scanned tail are missed by both.

The preview session states it too: `Session::summary` reads the sealed
UTF-16 source (`summarize_text`, which a property test proves equal to
`summarize` over the bytes) and returns JSON `{summary, text}` in the
browser's field names, within the 8 MiB metadata bound (past it the call is
refused as `resource_limit` and the session kept). The shape is
`contracts/gcode-metadata.json`'s `Summary`, so the generated TypeScript and
Kotlin validators check every reply. The browser's Rust preview adapter now
takes the summary from its WASM session (`CoreGcodeSource.summary`); the
`?previewCore=typescript` reference keeps the TypeScript summarizer. Chrome
replays all 101 browser summaries through the WASM session and the contract
decoder (`summary-replay.mjs`, run by `wasm-smoke.mjs`), and Android through
JNI, the Kotlin validator and its types (`GcodeSummaryTest`, 4040 checks,
instrumented: the host JVM has no `org.json`). Porting found a browser
defect: the main thread refused a whole preview whose artifact listed more
than 256 tools (the corpus's 300-tool case), though its toolpaths were
fine. The bound is now 65536 entries, all a 64 Ki-unit trailer can hold, and
a preview with no summary opens too (a worker test covers both).

The status line a finished slice gets is shared too. The browser's rule
lived inline in `sliceNow`; it is now `SliceStatus.ts`
(`sliceStatusFigures`: `split('\n').length` lines, and layers the engine's
own stated total — the summary's `layerCount` — else its
`; CHANGE_LAYER`/`;LAYER_CHANGE` markers; `describeSliceStatus`: size in
whole KB as `toFixed(0)` rounds it, then lines, layers, warnings), and
`artifact::SliceTally` ports it for a file streamed in chunks of any size —
line breaks and markers counted as they pass, only the bytes that can hold
the trailer kept — with numbers spelled as JavaScript spells them.
`slice-status-vectors.mjs` records 40 browser artifacts (the repository
fixtures, stated totals that agree, differ, are zero or malformed or lie
past the trailer behind a long settings block, marker near-misses and
adjacency, CRLF, lone CR, BOM, three-byte text, KB rounding ties); Rust
matches all of them in five chunkings, and Android through JNI
(`NativeGcode.tally*`, at most eight live tallies, handles never reused)
and the Kotlin `SliceStatusTally`/`SliceStatus.describe`
(`ProjectSliceStatusChecks`, 563 host JNI checks). Prepare now words both
routes' slices with it; Android had counted only markers, so where the
engine states a total and counts differently its line disagreed with the
browser's. Preview already showed the shared artifact summary.

### Plate projection for slicing

`orcaxr_project::slicing::plate` is the browser's per-plate slice
projection (`plateProjection.ts`): `project_plate` refuses an unknown or
unprintable plate, then reduces the project to that plate as plate zero and
the active one — project-wide and this plate's custom G-code, thumbnails with
no plate or this plate, no extension blobs — keeping only the source assets
its volumes and kept thumbnails use (each must have its payload, or
`MissingAsset`), validated as the browser's `assertValidProjectState`, whose
fingerprint is the archive's source hash; `plate_print_overrides` is the
plate's configuration as the engine's wire strings (arrays joined by commas,
the bookkeeping keys and nulls skipped; a `__proto__` key never reaches the
overrides, as the browser's plain-object assignment drops it). Errors carry
the browser's sentences. `plate-projection-vectors.mjs` records 19 browser
cases (16 projections; unprintable, missing-asset and unknown plates) from the
model corpus and three variants (a second plate made unprintable, overrides of
every JSON shape, per-plate thumbnails and custom G-code with an unused
asset), and a Rust replay matches them byte for byte. The browser's
`SliceJobCoordinator` now imports the same exported `platePrintOverrides`.

Bindings project a session through its export capture: `ExportCapture::plate`
is the capture reduced to one plate (admitted under the host's timestamp
policy, at the capture's revision, reading only the frozen assets it keeps),
so the existing archive writer packages it and its project hash is the
archive's `sourceHash`; the capture's guard stays the caller's proof of the
live project. WASM `ProjectExport.plate`/`project`/`write_archive` (no
checkpoint guard: an export is never a save) and
`CapturedProject.plate_print_overrides`; JNI `exportPlate` (a capture in a
slot of its own; `exportArchive`/`exportProject` read it) and
`projectPlateOverrides`; Kotlin `ProjectExportCapture.plate`,
`ProjectSnapshot.platePrintOverrides`,
`ProjectExportSource.writePlateArchive` (completes an export, never a save),
`ProjectDocuments.savePlate` and `ProjectWorkspace.projectPlate` (a refused
plate fails with the browser's sentence before the provider opens). Plate
and asset IDs cross as JSON text. For hosts and replays without a session,
WASM `plate_projection`/`plate_print_overrides`, JNI
`plateProjection`/`platePrintOverridesJson` and Kotlin `PlateProjections`
answer the same over a state document of at most 1 MiB (canonical JSON:
`{assetIds, sourceHash, stateJson}` or `{error, message}`, `error` a
`plate_projection_*` code). The 19 cases replay in Rust, WASM in Node and
Chrome, JNI and 57 Kotlin checks; the archive replay also projects all 1,403
printable plates of the 1,225 opened archives through the capture (185
unprintable ones refused), each equal to the state-document projection, and
reopens one plate archive per project as exactly that plate and its assets.

### External slicer policy

`orcaxr_printer::slicer` is the browser's external-slicer route
(`ExternalEngineAttestation.ts`, `ExternalSlicerJobs.ts`) as pure steps over
`ExternalSlicer*` intents: `endpoint` makes a captured address canonical
(`canonicalExternalEndpoint`: the trimmed text as typed, HTTP when no scheme
is named, bare IPv6 bracketed, trailing slashes dropped; credentials, queries
and fragments refused); `attestation_plan` and `attestation` send
`GET /engine` and read its reply against the pinned build; `submit_plan` and
`job_plan` give the request each step sends (`POST /slice?async=1`, status,
`/gcode`, cancel, and a release bounded to 1 s), refusing a job ID no URL can
carry; `submission`, `poll`, `cancel` and `artifact` read each reply into the
next step or a failure whose kind (`failed`, `cancelled`, `alreadyDone`,
`alreadyFailed`, `alreadyReleased`, `unconfirmed`, and `retained` for an
artifact that came up short or did not match its checksum, which the server
still holds) and browser sentence the host reports; `download` reads each
attempt at a finished job's artifact (`readDownload`): accept it, fetch it
again — after a transfer that failed, or a `retained` verdict — while
`MAX_DOWNLOAD_ATTEMPTS` (3) allow, or fail with the transfer's or the
verdict's own words. Hosts own the transport, the bearer token, the poll interval
(700 ms in the browser) and the cancellation deadline (30 s, `timedOut`), and
decode reply bodies as UTF-8. G-code never crosses into the core: a host
streams the download once for its facts — length, SHA-256, whether it is
UTF-8, whether its text (a leading BOM dropped) is only JavaScript white
space — and `artifact` checks the job ID, `X-OrcaXR-Gcode-Bytes` and
`X-OrcaXR-Gcode-SHA256` against them, naming the job to release only when
the transfer named its digest. The pinned build
(`contracts/pinned-engine-provenance.json`) is written from
`pinnedEngineProvenance.ts` by the corpus generator, which fails when they
drift, and embedded by the core (`slicer::pinned`, `engine_supports`).

`external-slicer-vectors.mjs` drives the production functions through
`ExternalSlicerExchange.ts` (the job loops over a recording fetcher, the
artifact reader over real `Response`s): 72 endpoints, 230 attestation
replies, 156 job steps, 247 submission replies, 196 status polls, 44
cancellation replies, 49 artifacts and 102 download attempts (each distinct
verdict and four transport failures at six attempt numbers); Rust reproduces
every one.

Bindings: WASM `external_slicer_endpoint`, `_attestation_plan`,
`_attestation`, `_submit_plan`, `_job_plan`, `_submission`, `_poll`,
`_cancel`, `_artifact`, `_download` and `_supports` (in the printer and project cores),
the matching JNI `externalSlicer*` exports and Kotlin `ExternalSlicerPolicy`
(with the browser's 700 ms poll interval and 30 s cancellation deadline).
Replies, reads and steps travel on the intent bulk tier. WASM in Node and
Chrome, the printer core, JNI and 1,098 Kotlin checks reproduce every case.

Android hosts the route with `ExternalSlicerClient` (OkHttp, like
`MoonrakerClient`): no redirect (one fails the exchange, so the bearer token
never reaches another host), no retry, the local-network gate and cleartext
rule, reply bodies read to at most 1 MiB, the artifact streamed into the
caller's `ExternalSlicerOutput` while its length, SHA-256, UTF-8 validity and
JavaScript-blank text are computed. `slice` attests, submits the archive and
overrides (multipart `file` `project.3mf`, `overrides` JSON), polls,
downloads, judges and releases — fetching a finished job's artifact again,
into a fresh output, as the policy's `download` allows (the server keeps a
result until its release or expiry, a transfer in progress holding it), and
releasing it only once accepted; the POST is never aborted (its reply holds the only job ID a
cancel can name), a cancel arriving meanwhile is carried out once the reply
is read, and `cancel` ends in the policy's outcome or a
`CancellationException` once the server confirms. Transport failures reach
operators only as the network rules' own sentences or "could not be reached".
`external-slicer-client-test.mjs` drives it on the JVM against the real
server (`server/server.js` headless: a provenance manifest of the pinned
build from this repository's `server/patches/`, a runner writing one fixed
G-code): the Project area writes plate 1 of a two-plate project as its
archive (plate 2, unprintable, and an unknown plate are refused), which is
attested, submitted, polled, downloaded byte for byte and released; a
download cut off halfway and one whose first byte the server changed are each
fetched again into a fresh output, checked and released (the server records
two downloads, then the release); a held job is cancelled and confirmed; a failure reads in the policy's words; a
tokenless slice and an unusable address are refused before any upload; the
archive carries the `ProjectRevision` it was written from, which the plate's
`ProjectWorkspace.preflight` describes too (the unprintable plate's blocks)
and a new project leaves; and a connection left idle until the server
closed it is not reused (35 Kotlin checks, and the server's own record of
each request and upload). That last check failed before: the client never
retries, yet kept idle connections OkHttp's default five minutes while the
Node server closes them after six seconds (its 5 s keep-alive and 1 s of
grace), so connecting again after typing a token failed as unreachable.
`MoonrakerClient` already let them go after 2 s; the slicer client and
`PrinterExchanges` now share that pool (`LanTransportPolicy.idleConnections`).

### Android Project area

The app's Project area runs the project session as the browser's workspace
does, over the shared core and the `ProjectActor`. `ProjectWorkspace`
(core-bridge, host-testable) starts the actor with the browser's empty
project and carries out "New project", Open and Save through document
providers, model import, undo and redo, and the selection and object edits
below; its `ProjectView` (name, plates, dirty state, the next undo and redo
labels, the object tree's first page with plates expanded, the selection
and the actions the core enables) is rebuilt from the session's own effects
and history, never kept as a second project. `ProjectModel` is its host
adapter (a ViewModel, provider work on one worker thread) and
`ProjectScreen` its Compose surface; the shell's navigation is now
Workspace, Project and Device. Its actions carry the browser's action names
(`web/src/actions/groups/file.ts`), and a hardware keyboard has the
browser's edit shortcuts: Ctrl/Meta+Z undoes, Ctrl/Meta+Shift+Z and Ctrl+Y
redo, handled in `Activity.onKeyDown` so only keys no focused view consumed
reach them (a text field keeps its own); the emulator smoke drives them with
`input keycombination`.

New projects are shared: `orcaxr_project::model::fresh_project` is the
browser's "New project" (`freshProjectState`, extracted from
`CanonicalWorkspaceController.resetProject`), keeping the printer (unknown
fields included), the base profile — or the current configuration when none
was recorded — and the physical tools, and dropping mixed filaments, plates
and objects; `empty_project` is the project a session starts with.
`project-fresh-vectors.mjs` records both from the production browser over
the corpus's states, with identifiers drawn by the browser's UUID source
from recorded random words: 3 empty and 17 fresh cases (two of them rich
states made asset-free, so a host can open them from their document alone)
agree in Rust and through JNI (`NativeProject.projectEmpty`,
`ProjectSnapshot.fresh`, 27 Kotlin checks including refused word counts and
timestamps, and `NewProjects.timestamp` writing `toISOString`'s form). The
actor gained `resetFromSnapshot`, a guarded reset whose producer borrows the
snapshot being replaced. The browser's opt-in auto-pair generation, which
"New project" applies when enabled, has no preference on Android and is not
applied there.

`ProjectWorkspaceChecks` (27 checks over real JNI) start with the browser's
empty project; preview an STL import without changing the project, commit it
as one undoable entry, undo and redo it; refuse a lossy OBJ import until its
listed changes are acknowledged; write a shared copy (`export`, a complete
package) while the project stays unsaved; report a provider's write failure
with its code while the project stays dirty; save a 3MF, start a new project and open
the saved one back — in the canonical format — with the same tree; refuse a document that is not one
while keeping the project; and keep recent documents newest first, one per
document, at most eight. The screen previews an import with the notices the
operator accepts by importing (the preview counts the resulting project's
objects, not the additions), asks before New, Open or Back (from any
area) replaces or leaves unsaved changes — Save (to the document it last saved, or one the operator picks
then; it goes on only once the save is confirmed), Discard or Cancel —, saves to the document "Save as" created or to an opened one in
OrcaXR's own canonical package (`open` answers the archive format; a foreign
3MF, which saving would convert, is never overwritten by "Save"), keeps recent documents with persisted
read/write grants (released when an entry falls off; an entry whose grant or
document is gone is forgotten when it fails), and accepts a 3MF another app
opens or shares only as a `content:` URI, read through the same bounded Open
without keeping its grant. `android-project-smoke.py` drives it on an owned
emulator through the system document picker: import, undo, redo, Save as
(a ZIP package in Downloads), New, reopen from recents, the unsaved-changes
dialog (Cancel keeps them, Save writes them before New goes on, Discard drops
them), Share reaching the system's share sheet with a ZIP copy while the
project stays unsaved, Back asking from the Device area (Cancel stays,
Discard leaves),
a `file:` handover refused, and the recent document reopened after a
restart through its persisted grant. A model lands centred on the project's
own bed and dropped onto it, as the browser places an import. The smoke saves first only
to a document already saved; choosing a destination from that dialog is
unexercised. Share writes the copy to the app's cache (replacing the one shared before)
and offers it through `SharedProjects`, a read-only, unexported provider
serving only files directly in that folder by exact name, with a one-time
read grant.

Unsaved work survives the system ending the app, as the browser's recovery
store keeps it. `ProjectRecovery` (core-bridge) keeps one complete 3MF per
editing session in the app's private files (excluded from backups and device
transfer) with its project name, document, capture time, length, SHA-256 and
the identities a session guard reports (project id, semantic hash, asset
fingerprint), within the browser's 512 MiB budget; a copy is written to a
temporary file and renamed over the previous one only once complete, and one
whose bytes no longer match its record is listed as damaged and never
offered. `ProjectWorkspace` captures on the browser's timing — 5 s after the
latest change, never later than 30 s after the first unsaved one, nothing
for a clean project — through the actor's `exportDocument`, so a capture
never marks the project saved; it forgets its copy once the work is saved
or its changes are discarded. Restoring checks the copy before adoption, as
the browser's recovery proof does: the prepared document's identities
(`ProjectDocument.identity`, from the shared core's `PreparedDocument`)
must be those recorded, or the restore is refused and the project is
untouched; the copy stays until the operator discards it. The app also
captures at once whenever it leaves the screen with unsaved changes — sent
home, its window closed, swiped from Recents — since the system may end it
there and a closed window or removed task finishes it without asking; only
the very state the operator just chose to discard is not kept. The stopping
activity waits for that capture, up to 2 s, as Android waits for pending
preference writes when an activity stops: a removed task's process can be
ended moments after `onStop` returns. It lists
earlier sessions' copies with Restore and Discard.
`ProjectRecoveryChecks` (24 checks over real JNI) cover an interrupted
capture keeping the previous copy, the budget, damage, session names, the
capture timing with a controlled clock and scheduler, a clean project
cancelling it, discard on save and on Discard, a forged identity refused
before adoption, and a later session restoring the copy. The emulator smoke
imports a model, sends the app home, kills its process, relaunches (the
system restores the Project area the activity showed), restores the work and
discards the copy; removes the app's task (as a closed window or a swipe from
Recents does) under 4 s after an edit — before the timed capture — and finds
the work offered by the next session (the earlier rule, which skipped the
capture for a finishing activity, lost it: the step fails on it); and
reinstalls the app over itself while it runs, as an update does, after which
the updated app offers the work. Android cannot hold a closing window or an
update for a question, so those guards are the recovery copy. Process death
in the middle of a capture's or a save's write is exercised by the host
checks (an interrupted capture keeps the previous copy; a refused save never
opens the destination), not timed on a device.

A document has one writer. `DocumentOwners` (core-bridge) records, for the
app process, which window holds each document — the one it opened or last
saved to — weakly, so a window the system destroyed never blocks it. Open,
a recent document and "Save as" claim the document first; when another
window holds it, that window is brought forward (its task moved to the
front) and nothing is opened here, and a window created only to receive a
handed-over document another window holds closes after bringing that window
forward. Different documents coexist in different windows. Changes made
outside OrcaXR are caught by digest (`DigestingDocument`): what Open read and
Save wrote is hashed as it streams (Open reads the archive to its end, so
the hash is exact), and "Save" — including the save before New or Open —
first hashes the document as it is now; when it differs, the operator
chooses Overwrite, Save as or Cancel. `DocumentOwnersChecks` (14 checks)
cover claims, refusals, releases, a destroyed window's weak claim, and the
digests through the real archive Save and Open; the emulator smoke hands the
held document over again in a window of its own (the holder comes forward,
the new window closes) and appends a byte to the saved file from the shell
(Save asks; Cancel leaves the file as it is; Overwrite writes a package
again).

### Android selection and object edits

The Project area selects and edits through the session's own selection and
intents, as the browser's workspace does — never a host copy of either.

Selection is the session's (`ProjectSession.select`, the browser's
`SelectionStore`). `ProjectActor.select(plan)` runs a plan on the authority
against the state and selection it reads there, so a choice is never made on
a stale view, and answers `Selected` (with the selection effect delivered
first) or `NothingToDo`; a choice the session refuses (a primary not among
the refs, more refs or text than a selection holds) or a failing plan
refuses as INVALID_REQUEST and keeps the connection. `ProjectWorkspace`
follows the browser's controllers: `selectInstance` is a click on a model
(`selectModel`: one instance, or with Shift/Ctrl/Meta toggled among the
selected instances, other refs dropped, the last primary; an instance the
project no longer has selects nothing); `selectRow` is an Objects-tree row
(`objectTreeSelectionRequest`, resolved by the core's object tree: Replace,
Range from the last activated row, and Toggle applied to the whole
selection, keeping the primary unless it is the one removed; groups select
nothing); `selectAll` is the active plate's instances, the last primary
(none clears); `deselectAll` clears. The view reads each selection effect
(`ProjectView.selection`, at most 4096 refs; its instances are what the
renderer highlights), keeps the latest project snapshot so a selection-only
change re-pages the tree with the selection (rows report `selected`), and
owns the tree's expansion: plates open, everything else closed until its
disclosure opens it, and a model tapped in the Workspace opens its object
and instance group so its row shows. After each change the view also reads
which actions the core enables (`ProjectSession.capabilities` with the
Android shell's host facts: the flat workspace, preparing, no clipboard or
printer job): the Project area's `dom-menu` and `dom-inspector` actions, and
the `dom-context` menus of an object and a plate in catalogue order.

Every edit is one guarded intent and one undoable step with the core's own
history label. `execute(command)` and `transaction(label, commands)` submit
under the query guard. Edits of "the selected model" are planned on the
authority (`inspect`) from the selection and the query projection
(`ProjectFacts`), as the browser's controller reads its state, and execute
under that very state's guard — a change in between refuses them as stale:
Delete Selected (`deleteSelectedInstance`: the primary instance, "Delete
instance", or its object with its last instance, "Delete object"; the core
moves the selection to a neighbour), Delete All ("Delete all models"),
Printable (`setInstancePrintable`: printable unless every selected instance
is; each changed instance its own "Mark instance printable/unprintable",
chained on the previous receipt, an interruption reported with the browser's
completed count), Rename of an object, part or instance ("Rename object to
…", trimmed by ECMAScript's `trim` and bounded by `requireBoundedText`'s
160 units, refused with its words), Set as an individual object ("Set as
individual object", an object's only instance refused). Plates by ID, as the
browser's plate manager targets them: add ("Add Plate n": the next free
"Plate n", order after the last, made active), activate ("Change active
plate"), rename ("Rename plate to …", 120 units; the plate bar first checks
the plate manager's own rules), reorder and move one place ("Reorder
plates"), include or exclude ("Include plate in printing", "Exclude plate
from printing"), duplicate ("Duplicate plate"), delete ("Delete plate", the
last refused); the 36-plate limit is refused with the core's words before it
is asked. New IDs follow the browser's `UuidIdSource` (`ProjectIds`: a
version-4 UUID of `floor(word × 256)` bytes over secure 32-bit words) in the
browser's minting order; a duplicate's counts come from
`ProjectSnapshot.plateShape` (`commands::duplicate_plate_shape`, the counts
the command checks), since the query projection carries no plate custom
G-code or thumbnail counts.

Clone Selected and Add Instance match the browser's result rather than the
intent alternative: the browser's `duplicateSelectedInstance` stages a
`createInstance` of the primary instance's record (its name when it has one,
transform, printability and extension data — nothing else), where
`duplicateObject` would add a separate "… copy" object. The session stages
that record itself (`ProjectSession::stage_instance_copy`, JNI
`stageInstanceCopy`; the browser's zero-scale and zero-rotation refusals
included) and `ProjectActor.stage(plan)` executes it at once as one
"Create instance" that selects the copy.

The app: an Edit menu (Select All, Deselect All, Clone Selected, Delete
Selected, Delete All, Printable, Set as an individual object), a plate bar
(each plate activated by tapping it, its printing switch, and a menu: Rename
build plate, Move up, Move down, Duplicate, Delete build plate; Add build
plate below), and tree rows — a tap selects (Ctrl/Meta toggles, Shift extends
a range from a hardware keyboard), a check box toggles, a disclosure opens
and closes, and a long-press opens the row's menu (Rename for an editable
object or part, then the catalogue's context actions the app performs, which
act on the selection) without changing the selection, as the browser's
Objects panel does. Delete and Escape from a hardware keyboard are Delete
Selected and Deselect All when no focused view takes them. The Workspace's tap
selects in the project (Shift/Ctrl/Meta extend; a tap on nothing deselects
all) and the scene highlights the project's selected instances. The plate
menu of the tree, like the catalogue's actions, duplicates and deletes the
 active plate; the plate bar acts on its own plate. Transforms are the
inspector's and the Edit menu's placement entries ([below](#android-transform-inspector));
copy, cut, paste and the bed fill are [Android creation](#android-creation).

`ProjectEditChecks` (73 checks over real JNI) replay the browser's UUID
vectors from its seeded word source, every selection rule above and its
refusals, the capabilities a selection enables, each edit's single step,
label and undo, the refusals' words, the plate operations, the duplicate's
shape and the plate limit; a Rust staging test pins the copy's record and the
shape's counts. `ProjectEditingTest` (app JVM) covers row activation, rename
eligibility and the row and Edit menus. `android-edit-smoke.py` (run by
`emulator-smoke.py` before the adaptive smoke) imports two cubes, taps one in
the Workspace (its highlight and its checked tree row), deletes and undoes,
clones, makes the copy unprintable, deletes with the Delete key, deselects
with Escape, renames from a row's menu and adds, renames and deletes a plate;
it passes on both emulators.

### Android Workspace renderer

The Workspace area draws the project with the flat renderer, from the
session's own render deltas and mesh packets — never a second copy of the
project. The actor gained `inspect`, a read-only call run on its authority
between operations whose failure is its answer (never the connection's), and
`ProjectWorkspace` reads through it: `render` (a page of renderer deltas) and
`meshPacket` (one asset's packet, closed by the caller). In `renderer-api`,
platform-free and host-tested: `ProjectScene` applies render pages from the
snapshot it shows toward the session's (restarting from empty when the
session no longer holds its base, or when pages of one target arrive on
different bases) and lists the draws of the active plate — every instance
times every volume of its object, placed by `ModelTransform.fromCanonical`
(T·R·S, quaternion `[x, y, z, w]`, as the browser's `applyCanonicalTransform`)
and tinted with the volume's resolved display colour, or the browser
surface's default grey `#b8bec8`; `PacketMeshes` decodes a packet (chunk
table, float32 positions and normals, 16- or 32-bit indices, as
`mesh_packet.rs` writes them) into one mesh with baked flat shading; and
`SceneSync` pages the deltas on a thread of its own, fetches each newly
needed mesh once (a duplicate shares its source's), drops unused ones and
hands each change — or, to a renderer made afresh, everything known — to
its listener. `FilamentScene` (`renderer-filament`) uploads meshes in bounded
chunks as the viewport experiment does, shares each mesh among its draws
(one entity per chunk and draw, each with its own tinted material instance),
draws the bed's outline and 10 mm grid, frames the bed, picks the nearest
draw through each mesh's BVH and highlights the project's selected
instances; non-printable instances are translucent. `WorkspaceScreen` hosts
it on a `SurfaceView` that exists only while the app is resumed (drag
orbits, pinch zooms, a tap selects the picked instance in the project), and
the app now carries the renderer in every
build: both APKs pass `verify-artifacts.py` with six native libraries,
Filament's included, 16 KB aligned.

12 `renderer-api` JVM tests cover transforms, colours, delta paging and
packet decoding, and `ProjectSceneChecks` (13 checks over JNI) sync a real
session: the imported cube drawn once on the active plate, resting on the
bed inside the 200 mm plate, undo and redo as deltas, a duplicate sharing
its mesh, a full snapshot for a new renderer, "New project" emptying the
bed. The Project smoke compares Workspace screenshots on the emulator: an
imported model changes about 1,500 pixels of the framed bed, a tap on it
selects and re-tints it, and undo restores the empty bed. Shading is baked
flat (the browser lights its surface); paint is drawn as [Android painting](#android-painting)
describes, toolpaths in Preview.

### Android project bed and placement edits

The Workspace draws the project's own bed: `ProjectView.bed` is read with
every project effect (`ProjectSnapshot.workspaceBed` for the active plate, see
[Workspace bed](#workspace-bed)), so opening a U1 project draws its 270.5 ×
271 mm plate and a profile choice redraws it; a side the renderer cannot draw
is held within 1–5000 mm (`PreviewFraming.drawable`). Imports land centred on
its placement area and dropped onto the bed, as the browser places them, and
Preview draws the toolpaths on it.

`ProjectWorkspace` carries out the browser workspace's placement actions over
the shared planners: `dropToBed`, `mirror`, `resetTransforms` (rotation,
scale or both), `centerOnPlate` (the bed's placement area), `scaleToFit`
(its build volume; a project stating no printable height refuses with the
browser's status words), `layOnFace` (a local normal), `layOnFacet` (a picked
facet) and `arrangePlate` (the placement area, keeping the plate's tower
clear). Each plans on the
actor's authority against exactly the state the current guard names (another
edit landing first refuses as changed) and submits the plan as one guarded
`setInstanceTransforms` under the browser's gesture — `mirror:<axis>`,
`reset:<target>`, `center`, `scale-to-fit`, `lay-on-face`, `arrange:<plate>`,
or `batch:<n>` from the workspace's transform sequence for drop to bed — so a
repeated edit of the same instances coalesces into one undo entry as in the
browser, an edit that changes nothing records nothing, and a plan with no
changes (an arranged plate, a selection already fitting) submits nothing. A
keep-out edge JSON cannot carry (an infinite tower width) reaches the planner
as an inverted rectangle, which it refuses in the browser's words as it
refuses that edge.

`placement-edit-vectors.mjs` runs the production `CanonicalWorkspaceController`
over the browser's canonical 3MF of the picking scene in two scenes — a U1
printable area (offset 0.5 × 1 mm from the bed corner), and one far from the
corner (180–300 × 150–260 mm, 100 mm high) where every model starts outside
it — each with its height and a plate tower: 26 placement steps — repeated
mirrors that coalesce, every reset, a centre that changes nothing, scale to
fit twice, lay flat by a normal and by two facets, arrange twice, drop to bed
twice, scale everything to fit and centre two, and four refusals — recording
after each the semantic hash, undo label and count, what the workspace
reports and the instances the live slice preflight (the project as authored)
finds outside its build volume (none after any placement; the generator
asserts it), then undoing all 16 entries. `ProjectPlacementEditChecks` (181
checks over JNI per scene) opens the same bytes in a `ProjectWorkspace` with
the browser's hash and bed, applies every step through the wrappers with the
browser's hash, label, report or refusal and the core preflight's verdict
after each, and undoes back through every recorded state to the opened one;
the empty project refuses to scale to fit for want of a printable height.
Their UI and the inspector follow.

### Android placements inside the build volume

A printer's printable area need not start at the bed corner: the Snapmaker
U1's starts at 0.5 × 1 mm, and the bed's far corner (270.5 × 271 mm) is not its
size. "Scale to build volume" fitted the selection into a box from the bed
corner to that far corner and centred it on half the far corner, so a 20 mm
cube scaled to the U1's 270.05 mm height spanned [0.36, 0.61]–[270.14, 270.39]
mm and the slice preflight refused it as outside [0.5, 1, 0]–[270.5, 271,
270.05] mm, in the browser and on Android alike. Every placement now uses the
box the preflight checks, read once by the workspace bed (see
[Workspace bed](#workspace-bed)): its placement area (`areaMm`) and build
volume (`volumeMm`). Scale to fit fills the volume (one factor, upstream's
0.02 mm tolerance kept as the margin), centred on its centre and resting on
its floor; Centre on Plate centres on the area's centre; Arrange and Fill Bed
with Instances lay footprints inside the area inset by the 2 mm margin (on the
U1 the margin hid the offset; an area farther from the corner was left
entirely); a model import and the primitives are centred on the area (a
geometry-only 3MF import too, browser only). Drop to bed and lay flat move
only Z onto the bed's floor, which the preflight's volume shares, and copies,
pastes and added instances keep their source's placement: those were already
right. The wire carries the box: `PlacementCenter.areaMm`,
`PlacementScaleToFit.volumeMm` (`{minMm,maxMm}`), `ArrangeConstraintsInput.bedAreaMm`,
the primitive request's `areaMm` and the model import's
`[xMin, yMin, xMax, yMax]`; `OrcaWorkspace.placementBed` and Android's
`ProjectWorkspace` (from `ProjectView.bed` / `ProjectSnapshot.workspaceBed`)
pass the same `areaMm` and `volumeMm`. The drawn plate and XR drag clamps still
run from the bed corner to the far corner.

`build-volume-vectors.mjs` runs the production controller on an empty
project per bed — the U1's bundled printable area and 270.05 mm height, and
the far area with a plate tower — with seeded IDs: three primitives, an
arrangement, a 64-copy (U1) or 11-copy bed fill, centring the plate, scaling
the cube and then the plate to the build volume, and a cube import, recording
after each the semantic hash, undo label, the workspace's report and the
preflight's verdict (asserted to find nothing outside), then undoing all nine
entries. `ProjectBuildVolumeChecks` (74 checks over JNI per bed) replays each
journey in a `ProjectWorkspace` with the browser's IDs through `addPrimitive`,
`arrangeActivePlate`, `fillBed`, `centerSelectedOnPlate`, `scaleSelectedToFit`
and `prepareImport`/`commitImport` (its IDs are the device's own, so only its
label and verdict compare): the browser's hash and label after each, the
core's live preflight finding no model outside its build volume, and undo
back to the opened project. The browser's `placement-build-volume.test.ts`
scales a cube to the U1's bundled build volume and checks the live preflight
accepts it (and refuses the corner-based box), then places, arranges, fills,
centres, scales and imports on both beds. There is no new emulator smoke:
`android-local-slice-smoke.py` scales a cube to the U1's build volume and
slices it (the preflight refused that slice before this fix). No emulator
smoke has run for this change.

### Android transform inspector

The Project area shows the browser's Tool Settings panel for the selected
instance under its tree — all three transform tools at once, since the app
has no tool rail: Move (mm), Rotate (deg) and Scale (%), each with X, Y and
Z fields. `ProjectView.inspector` (`ProjectInspector`) is read with every
project or selection effect from the snapshot shown: the primary instance's
transform from its query row (`TX`…`SZ`, `ProjectInspection`), each tool's
values and two-decimal texts from [`TransformFields.values`](#transform-inspector-fields),
and how many instances an edit changes — the browser's
`captureSelectedInstanceOrigins`: the primary and the selection on its
plate (the primary alone when it is not among the refs). Without a primary
instance there is no inspector; the fields are enabled as the core enables
`tool_move`, `tool_rotate` and `tool_scale` on `dom-inspector`, where the
browser's panel invokes them.

A field keeps what is typed while it holds the focus (the browser updates
every input but the active one). The input's `change` event submits the
tool's three texts as typed when the field's text differs from what it held
at its last change (or when it took the focus): Enter from a hardware
keyboard, which keeps the focus and the typing as the browser's input does;
the soft keyboard's Done, which also puts the keyboard away; or the focus
leaving the field. So leaving after Enter submits nothing more unless the
text changed again. (Enter used to clear the focus; outside touch mode
Android hands it straight back, so the field went on showing its typing —
the browser's look by accident — and leaving it would have submitted the
same edit a second time.) `ProjectWorkspace.editTransform`
plans on the actor's authority from the session's whole selection and the
state it reads there: `TransformFields.edit` over the origins, then one
`setInstanceTransform` (one change) or `setInstanceTransforms` under that
state's guard, labelled as the browser labels it — "Transform instance" or
"Transform n instances". The browser's field edit names no gesture
(`OrcaWorkspace.commitSelectedPrimaryTransform` passes none), so its
controller draws `single:<n>` or `batch:<n>` from its transform sequence:
every field edit is its own undo entry and repeated edits of one field never
coalesce (only drags and the named placement gestures do). An edit that
changes nothing records nothing; a refused one (a zero scale, a non-finite
value, a zero rotation) fails in the browser's words, shown as its status
("Transform failed: …"), and after every edit the fields show the
selection's values again.

The Edit menu lists the placement actions after its edits, in catalogue
order, each enabled as the core enables it where the browser offers it
(`dom-menu`; `dom-toolbar` for Lay flat and Drop to bed): Lay flat, Mirror on
X/Y/Z, Reset Rotation, Reset Scale, Centre on Plate, Scale to build volume,
Drop to bed and Auto-arrange Plate; an object's or plate's long-press menu
offers the catalogue's own. They act on what `OrcaWorkspace` reads as the
action runs, read on the authority with the state the plan is made from
(`mirrorSelected`, `resetSelected`, `centerSelectedOnPlate`,
`scaleSelectedToFit`, `dropSelectedToBed`, `arrangeActivePlate` over the
planners above): the selected instances; for centre and scale to fit the
active plate's when none is selected; the primary and the selection on its
plate for drop to bed; the active plate for arrange. Outcomes the history
does not show get the browser's status (already on the bed, already filling
the build volume, already arranged, models that did not fit). Lay flat is
the browser's tool: while it is on (checked in the menu, until chosen again
or ended by the Workspace's Done), a Workspace tap lays the tapped facet on
the bed (`layOnFacet`; `FilamentScene.Pick` now names the volume) instead of
selecting, the Workspace shows the browser's status ("Lay flat: click the
facet that should rest on the bed.", "Click a model facet to lay it flat."
after a miss), and nothing happens while the core does not enable the tool,
as the browser's registry gate refuses it.

`ProjectTransformEditChecks` (509 checks over JNI) stand three imported
cubes in for the instances of the transform-field corpus's 94 edits: each
case's origins are set and its selection made, the inspector shows the
primary's fields as `TransformFields.values` reads them, and the edit leaves
every instance as the browser computed (69 cases), as one entry with the
browser's label (none when nothing changed) that undo takes back, or refuses
in the browser's words with history untouched (20); the 5 cases a session
cannot stage — a duplicate selection, origins it refuses to hold — are
counted. Repeated Move edits stay separate entries; rotate 90° about Z,
scale 200 %, a refused zero scale, the placement actions on the selection
and with none selected, and the capabilities that gate them complete it.
`ProjectEditingTest` and `TransformInspectorTest` (app JVM) cover the menu,
the statuses and the fields' change and follow rules.
`android-inspector-smoke.py` (run by `emulator-smoke.py` before the adaptive
smoke) imports a cube, selects it, lays a tapped face flat and undoes it,
types Move X, centres, raises and drops it, rotates 90° about Z, scales to
200 % and undoes, mirrors on X, then arranges two cubes as one "Transform 2
instances". An import selects nothing, as in the browser, so it selects the cube
with Select All first. It types into a field only once the field is emptied on both
sides of the caret and shows exactly the new text (a loaded emulator can drop Ctrl+A's
Ctrl, or place the tap's caret after a following key), since Enter commits whatever the
field holds, and then presses Tab to leave the field, which shows the applied value. It
finds a field by the scrolling container's own bounds, since the area bar's height varies
with the window and the text size. It passes on both emulators.

### Android transform gizmo

The Workspace draws and drives the shared core's gizmo
([`placement::gizmo`](#transform-gizmo)) as the browser's 2D shell does.
`ProjectWorkspace.transformProxy` reads where it stands for the selection
whenever the project or the selection changes, and once each drag ends
(`syncTransformProxy`): nowhere with nothing selected, at one instance's own
pose, at the centre of a selection's bounds unrotated. Its root puts the
printer's millimetres into render-space metres as `RenderSpace` does (−90°
about X, then a thousandth), and its camera is the Filament scene's (45°
vertical, 1 mm to 10 m).

A Compose canvas over the 3D view draws each visible handle of the mode —
the gizmo group, then its helpers — from the core's geometry, in its
colour (three's linear colour encoded to sRGB) and opacity, with no depth
test, as the browser draws its handles. Only the triangles facing the camera
are drawn, as three's front-side materials draw them (a closed handle's back
faces, wound the other way, cancelled its fill), each whole or not at all;
a line is clipped to the near and far planes.

A press — a finger, a pen, the left button — that the core picks on a
handle takes the touch: no orbit, no long-press menu. Each move steps the
gizmo, and when a step moves the proxy, `TransformGizmo.changes` (the one
instance, or the selection carried round the pivot) goes to one
`ProjectWorkspace.TransformGesture` under `transform-controls:<n>`, which,
as the browser's `AsyncTransformGesture`, keeps at most one edit in flight
and the latest pose waiting: the drag lands as one "Transform instance" (or
"Transform n instances") step. A refused change stops the drag with the
browser's "Transform stopped: …"; a second finger ends it where it is. A
mouse or pen hovering highlights the handle under it.

Move, Rotate and Scale (`tool_move`, `tool_rotate`, `tool_scale`, enabled
with an instance selected) join the model toolbar and the command palette,
and G, R and S choose them when no text field has the typing, showing the
Workspace. Each is the Workspace's one tool, as the browser's `setTool`:
choosing one ends Lay flat, Measure, Brim Ears, the drawn parts or painting.
The gizmo shows only while Move, Rotate or Scale is the tool
(`ProjectModel.gizmoShown`), as Orca shows one gizmo at a time; a tap on a
handle leaves the selection alone, as the browser's handler does when the
gizmo's axis is set. Both apps once drew the handles under every tool: in
the browser a paint stroke, a lay-flat click or a measure pick that began on
a handle also dragged the model (TransformControls listens on the same
canvas), and in both the handles covered what was painted or measured. The
browser's `setTool` now detaches them outside Move, Rotate and Scale
(`async-plate-presentation.test.ts`), and the paint smoke, whose recolour
check counted the handles' pixels as unchanged cube, found it.

Two choices differ from the browser on purpose: each gesture step is planned
against the state it applies to, where the browser carries one guard from
step to step (the app's project has no other editor while a finger drags);
and a touch press meets the current drag plane, since the core renders
before every event, where the browser's would meet the previous frame's.
`ProjectTransformGestureChecks` drives this over JNI on the host (38
checks): the proxy for none, one and two instances; a drag of the X arrow in
four moves lands as its last move, along the printer's X alone, one undo
entry that one undo takes back whole; a turn of the green ring carries two
instances round their pivot as "Transform 2 instances"; a finished gesture
takes nothing. `android-gizmo-smoke.py` drags the drawn arrow and ring on an
emulator and chooses the tools with G, R and S.

### Android creation

The Project area creates as the browser's workspace does, through the
browser's staged records. `ProjectStagedRecords` (core-bridge) is a typed
writer for the records the browser stages (`StagedProjectCommands.ts`, written
as `project-staged-replay.mjs` writes them for the core): `createInstance`,
`clipboardPaste`, `addVolume` and `addObjectWithAsset`, alone or as one
labelled transaction, each record (`StagedRecord`: one canonical JSON object,
text outside ASCII escaped) and payload (`StagedPayload`: its descriptor and
bytes) typed; the bytes are ASCII JSON, payloads are declared by descriptor
and streamed after the records, each distinct ID once in first-declaration
order. Staged intents are left out: the core charges a staged intent by its
exact text, which only the browser's encoder writes (Kotlin's wire writer
prints `1.0` for `1`). The host JNI replay of the staged corpus writes every
work it can type — 102 of them, instance copies, clipboard pastes, added parts
and objects with payloads, alone and in transactions — through the writer and
compares every reply, effect, state and staging charge with the browser's;
where a work's records survive a JSON round trip the bytes are the browser's
own (102 works, 116 Kotlin checks with the writer's typed rules).

`ProjectWorkspace` plans each creation on the actor's authority against
exactly the state the current guard names, writes its records and stages
them (`ProjectActor.prepareCommands`, or `preparePaste` through the
clipboard's own upload) under that guard, as one undoable step with the
browser's label: `addPrimitive` (each `add_primitive_*`, "Add cube.stl" on the
project's bed), `addHelperVolume` (`add_modifier`, `add_support_enforcer`,
`add_support_blocker`: "Add modifier to object", selecting the part; nothing
selected refuses in the browser's words), `fillBed` (`fill_bed_with_instances`:
copies of the last selected instance laid into its plate's free space on the
bed, keeping the active plate's tower clear, as one "Fill n instances" — one
copy is "Duplicate instance" — an instance record of ID, name when it has
one, the planned transform and its printability), `copySelected`
(`edit_copy`: the primary object's or instance's whole object and assets into
the actor's clipboard, replacing the copy held; the project is unchanged),
`cutSelected` (`edit_cut`: Copy, then Delete Selected when the primary is an
instance) and `paste` (`edit_paste`: the copy under fresh IDs on the active
plate, "Paste model"). Add Instance stays the session-staged copy of
[selection and object edits](#android-selection-and-object-edits). New IDs
follow the browser's draw order; `ProjectIds.giveBack` returns the asset ID a
shared mesh did not take. The core's capabilities see the clipboard (`edit_paste`
enabled once a copy is held, which New and Open keep, as the browser's
controller keeps it).

`ProjectCreateEditChecks` (145 checks over JNI) open the corpus journey's
browser 3MF (a U1 bed and a plate tower) with the browser's seeded IDs and
apply its 32 steps through the wrappers — every primitive (a second cube
sharing the first's mesh), the three helper volumes (one with a part
selected), an added instance, a 64-copy bed fill, copies, two pastes, cuts of
an object's last instance and of an instance, and with nothing selected a
refused helper, no instance, no fill and no copy — with the browser's hash,
undo label and result after each, then undo all 19 entries back to the
opened state. The app: an Add menu (the six primitives, then the helper
volumes) and the Edit menu's Cut, Copy and Paste first and Add Instance and
Fill Bed with Instances last, enabled as the core enables them; row menus
offer the bed fill for an object and the primitives for a plate; Ctrl/Meta+C,
+X and +V copy, cut and paste a model when no focused view takes the key (the
platform's keys: the browser's catalogue leaves them to page text). Labels
are the browser's messages (`contracts/android-strings.json`).
`ProjectEditingTest` covers the menus; `android-create-smoke.py` (run by
`emulator-smoke.py` before the adaptive smoke) adds a cube and a cylinder,
copies and pastes, pastes with Ctrl+V, adds an instance, cuts it with Ctrl+X
and pastes it back, and adds and undoes a modifier, each by its undo label; it
passes on both emulators.

### Android model tools

The Project area splits, simplifies and measures as the browser's workspace
does, through the shared core, each edit one guarded step with the core's
label.

Split. `ProjectWorkspace.splitToObjectsConfirmation` reads, on the actor's
authority, what Split to Objects would replace for the primary selected
instance ([split sources](#split-sources)), bound to the state and selection
it was read from; the screen shows the browser's confirmation (main.ts's
`window.confirm` words, the triangle count in the device's locale, OK and
Cancel). `splitSelectedToObjects` refuses it as stale in the browser's words
once the project or the selection changed, checks the source again and
commits one "Split to objects": an object of several volumes promotes them
(`separateObjectVolumes`), an object of one volume has its connected bodies
prepared on the authority (`volumeSplit`, its refusal in the core's words)
and staged as objects (`stageVolumeSplit`). `splitSelectedToParts` stages the
bodies as parts, one "Split volume to parts". IDs are drawn in the browser's
order (`drawVolumeSplitIds`, then `allocateSeparatedObjectIdentities`), and
the statuses are the flow's (`ModelToolStatus`: unavailable, cancelled, split
into n objects across all m instances, failed). The workspace's synchronous
limit of 50,000 triangles for one volume is kept, so the two refuse the same
models.

Simplify. The selection simplifies the model parts the browser's
`paintableSelectedVolumes` takes, the parts the painter erases — selected
parts, the parts of selected objects and of selected instances' objects,
else every model part on the active plate, never a helper volume, each once,
in the scene's order (`ProjectFacts.selectedModelParts`, the one Kotlin copy
of the rule, which the painter's Erase all takes too).
`previewSimplify(configuration)`
decimates each on the authority (`volumeSimplify`) and keeps the prepared
runs (`SimplifyPreview`, `SimplifyPart`): their counts, and the very payload
Apply installs, paged for the Workspace. The core then enables Apply and
Cancel (its `simplifyPreviewing` host fact). `applySimplifyPreview` installs
the parts one by one, each one "Replace mesh topology" under a fresh asset ID.
As in the browser, a part is guarded by its own mesh: a volume whose mesh
changed under the preview is refused with the browser's "Stale topology
guard" words. One whose mesh did not change is installed even after other
edits: the session stages only on the state a run was prepared on, so the
same decimation of the same mesh runs again and must give the previewed
digest. `cancelSimplifyPreview` drops the preview. `simplifySelected` is the
menu's Simplify (`simplify_model`): half of each part's triangles at once,
with the browser's statuses (nothing to simplify, simplified n parts, failed).

Measure. A pick is a tap in the Workspace while the Edit menu's Measure tool
is on; one Workspace tool runs at a time, as the browser's `setTool` allows,
so Lay flat, Measure and the paint tool turn each other off. The tap's hit in
the volume's own millimetres (`FilamentScene.Pick.localPoint`, as the painter
takes it) is what `ProjectWorkspace.measurePick` places in printer millimetres
(`ProjectMeasures.placedTransform`: the instance's then the volume's
transform, composed and multiplied as three.js does). The browser reaches the
same frame through its scene root's inverse; the two agree to rounding. The
pick resolves through the volume's captured features (`measureVolume`, kept by
mesh asset as the browser keeps its extractors, at most eight). A hole an
uneven scale distorts answers the browser's own words. `measure` compares two
picks, a third pick starting a new pair. `ProjectMeasures.readout` is the
Measure panel's readout: the bounded distance or else the line's or
plane's, its X/Y/Z parts, the angle in degrees and each circle's diameter,
written as `Number(value.toFixed(3))` writes them, with the panel's hints.

The app. The Edit menu gains Split to Objects, Split to Parts, Simplify
(decimate) and the Measure tool after its placement actions; an object's or
instance's long-press menu offers the catalogue's split and simplify. The
Project area's tools hold the Simplify panel (`SimplifyPanel`, opened from its
heading as the browser's Tools card section opens): decimate by triangle count
or shape error, Remove (%) and Max error fields that hand their values over as
an `<input type=number>` does (`SimplifyFields`), Preview, Apply, Cancel and
the panel's statuses. The Workspace draws a preview's decimated meshes in
place of the parts' own: `WorkspaceRenderer` uploads them under their own
keys and points those parts' draws at them, so `FilamentScene` uploads those
volumes from them. When the preview ends, the volumes are uploaded from their
own meshes again and take back the paint the scene shows
(`ProjectModel.sceneSnapshot`). A tool's pick on a previewed part is refused
as the browser refuses it: Lay flat, Measure and the painter work on the
project's mesh, not the preview's (`ToolPick`), and the tool's own panel says
"That part shows a simplify preview; apply or cancel it first." in the
browser's words. A card beneath the view's top strip shows the panel's status, Apply
and Cancel, whichever tool is on. The tool's panel takes the view's foot in
turn — the paint panel, the Measure panel (status, hint, picked features,
readout, Clear, Done; at most a third of the view, scrolling) or the Lay flat
card. While measuring, the Workspace draws the measured line and its distance
over the model, as the browser draws its annotation: a Compose overlay
projected through the camera (`OrbitCamera.project`, the inverse of its pick
ray), under the panels.

Repair is not offered. The browser's `repair_model` exports each selected
part as an STL and runs libslic3r's ADMesh cleanup and CGAL self-union in its
slicing engine. Android's engine runs only in the `:engine` slicing service,
and routing geometry-kernel operations through that job service is still
open (Phase 5).

Checking found a browser defect, which the painting unit fixed too.
`paintableSelectedVolumes` ignored selected instances, which is what a click
on a model selects. So with a model clicked, Simplify, Repair and Erase all
acted on every model on the plate. A selected instance now stands for its
object's model parts; `paint-target-pick.test.ts` holds a simplify regression
beside the painting's.

Building the Android preview found a second browser defect. A simplify preview
swaps each previewed part's display geometry. The workspace's paint, measure,
lay-flat and brim-ear picks still raycast that display, then read what they
met as the project's mesh. A stroke sent the preview's facet numbers to the
real mesh, a measure fed them to the canonical mesh's feature extractor, lay
flat took a decimated facet's normal, and an ear sat on the decimated surface.
`OrcaWorkspace.previewsVolume` now refuses the pick on the nearest part when
that part is previewed (`refusePreviewedPick`); a previewed part hides what
lies behind it. Parts the preview leaves alone, and every part once Apply or
Cancel ends the preview, take every tool as before. Each of the four
refusals in `simplify-preview-pick.test.ts` fails on the old code. The rule
is the host's alone: the core holds no preview geometry, which only a host
draws, so only the words are shared, through the strings contract.

`model-tool-vectors.mjs` runs the production controller over a canonical
3MF (a scaled, turned 20 mm block, a two-body pair with two instances, a
two-body object, a guarded object with a modifier, a sphere, and three
imported two-body models, one of them with an unknown extension key) with
seeded IDs. Its 39-step journey covers:

- splits: refusals before and after the confirmation, both strategies,
  parts then promotion, and imported models whose provenance every
  resulting object keeps;
- simplifications: previews applied by count and by error, nothing to
  simplify, a cancelled preview, a one-shot simplification and a whole
  plate's preview;
- picks and measurements: plane-to-plane distances, a corner to an edge and
  an angle between split parts.

After every step it records the semantic hash and undo label, then undoes all
ten entries. `ProjectModelToolChecks.journey` (191 checks over JNI) takes the
same steps through `ProjectWorkspace`. It has the browser's hash and label
after each, its flow statuses, confirmations, simplified parts and counts,
and its features and readout rows to rounding, and undoes back to the opened
state. `ProjectEditingTest` and `ModelToolsTest` (app JVM) cover the menus,
the fields, the statuses, the readout and the transform composition.
`renderer-api` tests cover the projection's round trip and the payload
decoding. `android-modeltools-smoke.py`, added to `emulator-smoke.py` before
the accessibility smoke, passes on both emulators. Its steps:

1. Import a two-body STL, split it to parts and to objects, and undo each.
2. Preview a sphere's simplification and apply it from the Workspace, by its
   counts and undo label.
3. Move a 20 mm cube beside the pair and read the 10 mm between the two
   tops picked with two taps. The models are read from the view with
   nothing selected (Escape): since the transform gizmo landed, a selected
   cube's handles were counted as its pixels and both taps missed.

### Android brim ears

The Workspace places brim ears as the browser's workspace does, through the
shared core ([brim-ear detection and the tool's view](#brim-ear-detection-and-the-tools-view),
[commands](#brim-ear-commands)).

The tool. Brim Ears (`tool_brim_ears`, enabled with an instance selected)
joins the model toolbar, the command palette and the Edit menu's model tools;
it is the Workspace's one tool with Lay flat, Measure, painting and the
gizmo's Move, Rotate and Scale, as the browser's `setTool`, and choosing it
again ends it. Its object is the browser's `brimEarTargetObject`: the one
object owning the model parts the selection takes on the active plate
(`ProjectFacts.selectedModelParts`, every part on the plate when nothing is
selected), none when they belong to several. `ProjectWorkspace.brimEars`
reads, on the authority, that object and its view — its ears, the stranded
ones and its base — whenever the project or the selection changes while the
tool is on.

A tap (no drag, a handle of the gizmo included, as the browser's click
handler takes it before the gizmo) meets only that object's parts, the
nearest, whatever lies in front of them, as the browser's ray meets only
them. Where it met the part, in the part's own millimetres
(`FilamentScene.Pick.localPoint`), is moved into the object's frame by the
part's transform composed as three.js composes it
(`ProjectBrimEars.objectPoint`; the browser reaches the same point through the
instance's `worldToLocal`, and the two agree to rounding), and
`ProjectWorkspace.placeBrimEarOnPart` commits one "Place brim ear" there, at
the object's base, with the panel's radius. A part a simplify preview draws
refuses the tap in the browser's words; a tap that meets none says "Click the
selected model to place a brim ear."; with no single object in scope, "Select
one model part before placing brim ears.".

The panel. While the tool is on, the browser's Brim ears panel takes the
view's foot in turn with the paint and Measure panels (a third of the view at
most, scrolling): its heading and Done; Place on corners (`brim_ears_auto`,
enabled with an object in scope, its tooltip the browser's), which places an
ear on every first-layer corner the core's detector finds with the panel's
radius as one "Place brim ears", or says why none; Clear all
(`brim_ears_clear`, with ears placed), one "Clear brim ears"; the Ear radius
field (`brim_ears_configure`; the three in one row that wraps only on a narrow
window, so the view above stays in sight), handed over as the browser's number input
hands it over (`BrimEarFields`) and refused outside 0.1–20 mm in its words,
the field then showing the radius again; the hint, the tool's last status (a
polite live region, the browser's status bar while the tool is on) and the
warning about ears that reach nothing (an assertive one, as the browser's
`role=alert`); and the placed ears in order, each its position and diameter
as the browser writes them (`Number(value.toFixed(2))`), a stranded one in the
error colour saying so, and its Remove (`brim_ears_remove`, one "Remove brim
ear", which TalkBack names with the ear). Place on corners and Clear all are
in the command palette too, and run without the panel: Place on corners then
opens the tool, as the browser's does, so its discs are on the model, and
shows the Workspace; a status with the tool off is the Project area's
message. The browser's panel lives in its sidebar with a Place ears button
that turns the tool on; here the panel exists only while the tool is on, so
Done takes that button's place.

The discs. While the tool is on, each placed ear is drawn as the browser
draws it (`refreshBrimEarPreview`): the pinned flat disc, three's
`CylinderGeometry(r, r, 0.2, 32)` lying on the bed, grey (`#b3b3b3`) where it
works and translucent red (`#ff4d4d` at half opacity) where it reaches
nothing, on every instance of its object, with that instance's own scale
undone as three's `decompose` reads it, so a disc is the ear's printed size.
`FilamentScene.setMarkers` draws such markers: unlit, tested against depth
but never writing it, after the models (three's `MeshBasicMaterial` with
`depthWrite: false` at render order 2), never picked or highlighted; they
follow their object's instances as the draws change and go when the tool
ends.

Checking it found two browser defects, each fixed with a regression. The
outline chainer followed each cut segment the way its triangle's first
crossed edge led, which a triangulation does not keep consistent: three's
box walls cut their two triangles opposite ways, so the Add menu's cube read
"No closed outline could be read from the first layer" — Place on corners
placed nothing and every placed ear was called stranded. A segment that only
ends where the chain stands is now walked backwards (`brimEarDetection.ts`
and `brim_ears`; `brim-ear-detection.test.ts`, and three's box in the
corpus; every earlier reply is unchanged). And Place on corners set its
status, then opened the tool, whose own status ("tool: brim_ears -
pinch-drag the model") replaced it, so the operator never read how many ears
were placed (`brim-ear-frames.test.ts`).

`ProjectBrimEarEditChecks` (134 checks over JNI on the host, via
`project-jni-test.mjs`) opens the journey's canonical 3MF and takes its 20
steps through `ProjectWorkspace` — selecting instances, an object's row and
nothing; taps through the part they met (the object-frame point the
browser's to rounding, the ear at the base, "Place brim ear", undone) and at
the browser's exact point; the detector's corners; a removal; clears; and the
cases that place nothing — with the browser's semantic hash, undo label,
target object and view after each, then undoes all 8 entries back to the
opened project, and checks the panel's and workspace's words. `AppActionsTest`,
`ProjectEditingTest` and `BrimEarsTest` (app JVM) cover the actions, the
menu, the field, the words and the discs' placement; `SceneMarkersTest`
(`renderer-api`) the disc's shape and the scale decomposition.
`android-brimears-smoke.py`, added to `emulator-smoke.py` after the gizmo
smoke, moves a cube toward the back of the bed, takes the tool from the
toolbar (dragged sideways to it on a phone), deselects with Escape (the
plate's only object stays the one ears go on), places ears on the cube's
corners (four, listed and drawn around its base), sets a 2.5 mm radius and
taps the cube for one more, has 50 mm refused, removes one and clears them,
each by its undo label, and ends the tool, its discs going with it. It passes
on a suite-sized API 34 emulator (720 × 1280 at 240 dpi, two cores); the API 37
suite has yet to run it.

### Android wipe-tower auto-placement

The app auto-places the active plate's wipe tower as the browser's
workspace does (`OrcaWorkspace.autoPlaceWipeTower`), through the shared core
([wipe-tower auto-placement](#wipe-tower-auto-placement)).
`ProjectWorkspace.autoPlaceWipeTower` plans on the authority from the state
the guard names: the workspace's bed ([§](#workspace-bed)) — its size always,
and its printable rectangle when a chosen catalog profile states it, as the
browser hands over its profile's (with the project slicing as authored, the
planner reads the plate's, then the project's, `printable_area`) — and
commits the plan's tower as one `setPlateWipeTower`, "Auto-place wipe
tower", keeping its rotation and filament; a tower already where the plan
puts it changes nothing and records nothing.

It is offered where the browser offers it: Auto-place Wipe Tower
(`auto_place_wipe`) in the Edit menu's model tools (the browser's Tools
menu) and the command palette, with the browser's "Auto-placed wipe tower."
or "Auto-place wipe tower failed." as the Project area's message; and the
browser's Process card switch "Auto-position wipe tower" beneath Prepare's
printer, process and filament pickers — off when the app starts, as the
browser's — which places
the tower when switched on and says "Auto-position wipe tower enabled." or
"… disabled." beneath it (and in the Project area). The whole row is the
switch, named by its words, with the browser's title as its tooltip, and
enabled as the core enables the action. The switch only records the choice,
as the browser's does: nothing places the tower again by itself.

The Workspace draws the active plate's tower as the browser's ghost
([wipe-tower auto-placement](#wipe-tower-auto-placement)):
`ProjectWorkspace.wipeTowerGhost` reads the core's plan on the authority
whenever the project changes (an edit, an undo, the active plate, a
placement), and `WipeTowerGhosts` draws it with `FilamentScene.setMarkers` —
a translucent grey box (`#9e9e9e` at 0.35, its outer sides only, as three.js
draws a material's front side) from the tower's corner, as wide as its
footprint and as tall as the plate's tallest model part, its twelve edges in
`#cfd8dc` at 0.8, and, where the brim and rib wall print outside the body,
that footprint outlined in amber (`#ffb74d` at 0.65) just above the bed's
grid (the browser's 0.0005 scene units, 2/7 mm). Markers now draw line
segments as well as facets (`MarkerShape.boxEdges`, `squareOutline`), and a
facet may carry a baked shade (`MarkerShape.box`): the box's faces are shaded
as the scene bakes a model's light (`PacketMeshes.shade`), where the
browser's material is lit. A box beyond the scene's transform range (±10⁹ mm)
draws nothing.

`wipe-tower-vectors.mjs` also records a journey through the production
`CanonicalWorkspaceController` on its project as a canonical 3MF (with a
project printable area, which a 3MF of several plates needs), 10 steps and
9 undo entries: the U1
plate placed twice (the second time changing nothing) and again after a
model moved, the ribbed plate whose disabled tower keeps its rotation and
filament, the plate whose area cannot be read (from the bed's size alone),
and the empty plate (no clearance) — each with and without the profile's
rectangle — recording the pick, the semantic hash and the undo label after
every step, then undoing them all. `ProjectWipeTowerEditChecks` (65 checks over
JNI on the host, via `project-jni-test.mjs`) takes the same steps through
`ProjectWorkspace` and matches the browser's pick, hash, label and the
active plate's ghost after each, then undoes back to the opened project. The
journey goes on to plates whose towers were already enabled, a part raised
on one (the ghost grows with it) and a stand-in: 14 steps and 13 undo
entries, 95 checks. `AppActionsTest` and `ProjectEditingTest` cover the
action and the menu, `WipeTowerGhostTest` (app JVM) the ghost's markers and
`SceneMarkersTest` (`renderer-api`) the box, its edges and the outline.
`android-wipetower-smoke.py`, added to `emulator-smoke.py` after the brim-ear
smoke, places the tower from the Edit menu, finds its ghost among the pixels
the placement changed in the Workspace (grey body and amber brim outline)
and undoes it, ghost and all; places it from the palette (each "Auto-place
wipe tower", undone); then switches Prepare's switch on (placed, "enabled")
and off ("disabled", the tower left where it is). It passes on a suite-sized
API 34 emulator; the API 37 suite has yet to run it.

### Android emboss text and SVG parts

The Workspace embosses text and adds SVG parts as the browser's workspace
does, through the shared core ([emboss fonts, drawings and drawn
parts](#emboss-fonts-drawings-and-drawn-parts), [SVG and embossed-text
parts](#svg-and-embossed-text-parts)).

The tools. Emboss Text (`add_emboss`) and SVG Part (`tool_svg`), enabled
with a model on the plate, join the model toolbar, the command palette and
the Edit menu's model tools; each is the Workspace's one tool with Lay flat,
Measure, Brim Ears, painting and the gizmo's, as the browser's `setTool`,
and choosing it again ends it. Taps still select while either is on, as the
browser's clicks do. What applying acts on is the browser's: the one object
the selection's model parts belong to (`brimEarTargetObject`), which a new
part is added to at its origin, and — when the selection is one model part
that is embossed text, or an SVG part — that part, which applying re-cuts
(`embossTargetVolume`, `svgTargetVolume`); a drawn part of the other kind is
not re-cut, its object gets a new part. `ProjectWorkspace.drawnPartTarget`
reads it on the authority whenever the project or the selection changes
while a tool is on.

Applying. `ProjectWorkspace.applyEmboss` (a font read by
`ProjectEmbossFont` and the panel's recipe) and `applySvgPart` (the drawing's
file bytes and the panel's size) run on the authority as one staged step:
the target read from the state and selection there, the part's identity
drawn as the browser draws it — a volume, an asset (and the drawing's
asset), before the cut, so a refused cut still spends them — the cut
prepared by the core, and staged as "Add embossed text", "Edit embossed
text", "Add SVG part" or "Edit SVG part". They answer `EmbossApplied` /
`SvgPartApplied`: nothing to apply to, the cut's refusal in the core's
words, or the part and the cut's summary.

The panels (`DrawnPartModel`, `DrawnPartTools.kt`). While a tool is on, the
browser's Emboss or SVG part panel takes the view's foot in turn with the
other tools' (a third of the view at most, scrolling): its heading and
Done; Load an emboss font / Load an SVG drawing, which open the system's
document picker — the file is read off the main thread, at most 64 MiB for
a font and 16 MiB for a drawing, and read by the core (a font that cannot be
read keeps the one there was; a drawing that cannot be read leaves none);
Add text / Update text and Add part / Update part (the browser's
`emboss_apply`, `svg_apply`), enabled with a font or drawing and something
to apply to; the file's name; the text (handed over as typed), Size, Depth,
Letter gap and Line gap, and the horizontal and vertical alignment; or Depth
and Width (0 keeps the drawing's size). Number fields show values as the
browser does (`Number(value.toFixed(3))`) and hand over what was typed as its
number input does (`HtmlNumberInput`), on Done, when the focus leaves, or as
Apply is pressed (as a click blurs the browser's field first); the recipe
takes them as given and the cut refuses what it cannot use, in the core's
words. Then the hint and the tool's last status (polite live regions) and,
for a drawing, what it holds that cannot be cut, listed (the first 64; the
browser lists all). The statuses are the browser's (`ProjectEmbossing`,
`ProjectSvgParts`): "Loaded … for embossing.", "Embossed the text as N
triangles." or the characters the font lacks and edges that did not close,
"Loaded … at W x H mm.", "Cut … at W x H mm." with the first thing not cut
(sizes as `toFixed(1)` writes them), "Emboss failed: …", "SVG part failed:
…", and the catalogue's "Choose a .ttf font file before embossing.",
"Select one model part to add embossed text to." and their SVG twins. The
palette runs Load (the tool opens with its picker) and Add (without the
panel, its status the Project area's message). Words the browser's tools
say about a browser not reading installed fonts are left out: an app is not
so limited (it does not list them yet).

`ProjectDrawnPartEditChecks` (99 checks over JNI on the host, via
`project-jni-test.mjs`) opens the journey's canonical 3MF with the browser's
seeded IDs and takes its 20 steps through `ProjectWorkspace` — selections
(an instance, an object's and a part's row, nothing); text added to the
base, re-cut at another size and alignment, refused for a font without the
glyphs (its IDs still spent), refused with no object in scope, added to the
pair; an SVG part added, re-cut at a width, refused for a drawing with no
shapes; a drawn part of the other kind left alone (each tool adds to its
object); an SVG part on a plain part — with the browser's outcome, part,
triangles, size, semantic hash, undo label and target after each, then
undoes all 8 entries; it also checks the tools' starting recipe and depth,
a font's naming of the recipe and the drawings' reads. `DrawnPartsTest`
(app JVM) covers the number input, the recipe and the words;
`AppActionsTest` (75 performed actions) and `ProjectEditingTest` the actions
and the menu. `android-drawnparts-smoke.py`, added to `emulator-smoke.py`
after the wipe-tower smoke, pushes the journey's font and a drawing to
Downloads, adds a cube, embosses "AOi" onto it through the picked font (the
browser's 904 triangles), has a text without glyphs refused, re-cuts the
text part selected in the tree, then switches to SVG Part, loads the
drawing (its size and the part that cannot be cut listed) and adds it, each
step by its undo label, and ends the tool. It passes on a suite-sized API 34
emulator (720 × 1280 at 240 dpi, two cores); neither emulator suite has run
it yet.

### Android assembly

The Workspace aligns models and explodes the view as the browser's
assembly flow does, through the shared core. The core's port is
`orcaxr_project::assembly` (`assemblyExchange.ts` over `assembly.ts`, the
pinned `GLGizmoAssembly` alignments and `Measure::get_assembly_action`):
which alignments two picked features allow, the transform one alignment
gives the second pick's instance, and the view-only exploded layout. Its
bindings are WASM `assembly_availability`/`assembly_alignment`/
`assembly_explosion`, the JNI exports of the same names and Kotlin
`ProjectAssembly`.

The browser's flow moved out of `OrcaWorkspace` into
`web/src/workspace/AssemblyAlignment.ts` so a corpus can run it:
`assemblySnapshot` (what the pair allows, whether the second pick's model
can move — not when both picks are on one instance — and the panel's hint)
and `planAssemblyStep` (refused without two picks on two models, or when the
model to move is gone; nothing for faces already aligned; the plan's refusal
as "Alignment failed: …"; otherwise the move and its "Applied …" status).
The workspace commits a move as one `setInstanceTransform`, "Transform
instance", and drops the picks, which described where the faces were.

The Android side. Assembly (`tool_assembly`, enabled with more than one
model) joins the model toolbar, the Edit menu's model tools and the palette;
as the browser's `assemblyView` it turns the Measure tool on with a fresh
pair and the browser's "Assembly: pick a face on each model, then choose an
alignment." Both are the browser's Measure tool; here the toolbar shows
which one was chosen, choosing the other switches to it, and only the
Assembly tool's panel explodes the view. Once two features are picked —
with either — the Measure panel shows the
browser's Align section (`AssemblySection`): the hint, then Parallel, Centre
coincidence, Flip over, Set gap with its Gap (mm) field (starting at the
measured gap, written as `Number(value.toFixed(3))`) and Turn about centre
with its Turn (°) field (90 to start), each enabled as the core allows the
pair and only when the second model can move. The fields hand over what was
typed as an `<input type=number>` does (`HtmlNumberInput`).
`ProjectAssemblies.view` is the snapshot; `ProjectWorkspace.alignAssembly`
refuses a pair before anything is read, then plans on the authority from the
second pick's instance as the guarded state places it — a missing instance
refused — and commits a move as one guarded `setInstanceTransform` under the
workspace's next `single:<n>` gesture, as the browser's controller commits
it. The panel's statuses are the browser's: its catalogue's words for the
refusals and faces already aligned (translated), and its templates "Applied
… Undo restores the previous placement." and "Alignment failed: …".
Align picked faces (`assembly_align`) and Explode the assembly
(`assembly_explode`) in the palette open the tool, whose panel holds the
faces and the factor; the browser's palette reports them unavailable without
their parameters.

The exploded view. Explode the assembly is a slider in the Assembly tool's
panel, from 1 (assembled) to 3 as upstream's assemble view slides it, kept
to a twentieth, shown while more than one model is on the plate.
`SceneExplosion` gives the core's offsets for each instance the active plate
draws (its canonical translation, in draw order) and moves only what is
drawn: each draw's placement stays canonical, so painting, measuring, Lay
flat and every edit read the project while picks meet the parts where they
are drawn. The offsets are recomputed from the draws on every scene update,
so an edit re-explodes from where the parts now stand. Brim-ear discs ride
on their instances, and the measured line's ends move with the parts they
were picked on. Ending the tool, or choosing Measure, assembles the view — the explosion
is the assembly tool's view, as upstream resets its ratio leaving the
assemble view — and a new, opened or restored project starts assembled with
no picks. The browser keeps its factor after its tool ends (it has no
control for it but the automation route).

Porting it found browser defects, each fixed with a regression
(`exploded-workspace.test.ts` and `MeasurePanel.test.ts` fail on the old
code). The exploded view composed its offsets from a baseline captured the
first time a part was exploded and never renewed, and every project change
put the parts back while the factor still read exploded, so a moved part
jumped back to its old place on the next adjustment; the view now
re-explodes from the canonical placement after every project change. A
measure pick read the exploded display, so a measurement — and an alignment
computed from it — was off by the explosion; picks now place the feature
where the project places the part. The measured line was drawn only by a
snapshot of two picks and never taken away, so Clear, an alignment and
leaving the tool left it standing; it now shows only while the tool has two
picks, and its ends follow an exploded view. A new or opened project kept
the old one's picks and explosion; both reset. The panel offered Flip over
for any pair, which failed on a point, edge or circle second; it now follows
the pair's `canReverseFeature2`. And it had no way to ask for the turn about
the face centre the core plans for two parallel faces: Turn about centre and
its Turn (°) field are new in both shells.

`assembly-vectors.mjs` now also records a journey through the production
`CanonicalWorkspaceController` and `AssemblyAlignment.ts` over a canonical
3MF (a block, a tilted lid, a two-instance twin and a pin), with each pick
taken as the workspace takes it (the scene root's inverse): parallel, centre
coincidence, the same pair again (nothing moves), parallel refused, a gap,
a gap without its distance, a turn about the face centre, a flip, two faces
of one model, one twin onto the other, one pick, a circle second, and the
exploded view at 2 and 1 — 37 steps, 6 undo entries, with the pick's
feature, the panel's snapshot, the outcome, status and committed transform,
the semantic hash and the undo label after each. Its availability,
alignment and explosion requests join the script every binding replays (605
requests now: 61 availability, 535 alignment, 253 planned, 9 explosion).
`ProjectAssemblyEditChecks` (166 checks over JNI on the host) takes the same
steps through `ProjectWorkspace`: each pick the browser's feature to
rounding and its summary exactly; then, with the browser's features (the
pair the operator picked), the snapshot, every outcome, status and
transform, the hash and the label exactly, and undoes all 6 entries.
`ProjectSceneExplosionChecks` (30 checks, `renderer-api`) opens the
journey's 3MF, applies its moves and, over a real scene's draws, gives the
browser's explosion request and offsets and draws each instance at its
translation plus its offset with its placement unchanged.
`AssemblyToolTest` (app JVM) covers the statuses, the pairing rule, the
factor's bounds, the measured line's and the discs' explosion;
`SceneExplosionTest` (`renderer-api`) the inputs and the moved draws;
`AppActionsTest` (78 performed actions) and `ProjectEditingTest` the actions
and the menu. Checking it found an Android defect too: the Edit menu's
Emboss Text and SVG Part read their enablement from actions the workspace
never asked the core about, so they were always disabled; the toolbar's
tools are now all read (`MODEL_TOOL_TOOLBAR_ACTIONS`).
`android-assembly-smoke.py`, added to `emulator-smoke.py` after the
drawn-parts smoke, adds two cubes side by side at the back of the bed, takes
Assembly from the toolbar, picks their tops (everything but Parallel
offered, the gap 0), has a 0 mm gap refused as already aligned, lifts the
second cube by a 25 mm gap and turns it over onto the first by centre
coincidence (each one "Transform instance", undone), explodes the view (the
project's undo label unchanged) and ends the tool, the view assembled
again.

### Android variable layer height, magnet cavities and layer events

The Workspace and Preview areas provide variable layer height, magnet cavity
creation, and layer event authoring matching the browser's tools.

Variable layer height (`variable_layer_height`). Enabled when an object or
instance is selected, the tool joins the model toolbar and the Tools menu. Its
overlay card (`VariableLayerHeightCard`) provides an adaptive quality slider
(0.0–1.0), "Adaptive" calculation (`applyAdaptiveLayerHeight`), "Smooth"
adjustment (`applySmoothLayerHeight` with radius 1–10 mm), and "Reset"
(`applyResetLayerHeight`). Edits dispatch through
`ProjectWorkspace.adaptiveLayerHeight`, `smoothLayerHeight`, and
`resetLayerHeight` to the core's layer height engine.

Magnet cavities (`add_magnet`). Added to the Add menu as "Add Magnet Hole", the
tool plans a negative volume cavity via `addHelperVolume(HelperVolumeRole.NEGATIVE_VOLUME)`
and renames it to "Magnet Hole" as the web workspace controller does, staging one
undoable volume addition.

Layer events (`preview_add_pause`, `preview_add_custom_gcode`). Wired directly into
`PreviewScreen`'s layer scrubber when inspecting a sliced toolpath with a valid
layer height (`topZMm`). The operator can insert pause events
(`LayerEventType.Pause`) or custom G-code commands (`LayerEventType.Custom`,
inserting `M117 layer at <Z> mm`) at the current height through
`ProjectModel.addLayerEvent` / `ProjectWorkspace.addLayerEvent`.

### Android wave overhangs

The Prepare area provides the Wave Overhangs Card (`WaveOverhangsCard`) inside
its Process settings list, matching upstream page order (Tab.cpp) and the web
implementation (`WAVE_OVERHANG_OPTIONS`).

The card defines 38 options across 8 groups (General, Detection, Pattern, Corner
Reinforcement, Motion, Cooling, Floor Layers, and Debug). Options are driven by
`WaveOverhangs`:
- Master switch on `wave_overhangs` enables or disables wave generation; sub-options
  reflect their conditional eligibility (e.g. corner taper requirements, Hilbert floor
  layers) and source origin (Override, Inherited, or Default).
- Group headers collapse and expand; General, Pattern, Motion, Cooling, and Floor are
  open by default.
- Quick-fix notice banners detect conflicting settings: overhang wall detection off
  (`detect_overhang_wall`), zero wall loops (`wall_loops`), spiral vase mode
  (`spiral_mode`), and unknown wave keys, offering one-tap resolution.
- Edits dispatch as canonical project settings overrides via
  `ProjectWorkspace.applyProjectSettingsOverrides` under monotonic revision guards,
  preserving unrelated overrides.
- "Reset to default" clears all wave overrides while preserving non-wave project settings.
- Resolution and mutation use a lightweight, portable parser (`MiniJson`), ensuring
  deterministic JVM and Android runtime execution free of framework mocking limitations.

### Android view menu, help menu, calibration models and reduce motion

The Project area, Workspace and Shell provide the View menu, the expanded Help menu,
preset management, built-in calibration / library models, and in-app reduce-motion control,
raising `AppActions.PERFORMED` to 116 actions.

View menu (`ViewMenu` in `ProjectScreen.kt`). Added beside the Edit and Add menus
in the Project area's menu bar:
- Wireframe toggle (`view_show_wireframe`), printable volume boundary box (`view_show_printable_box`),
  labels overlay (`view_show_labels`), overhang display (`view_show_overhang`),
  orientation navigator (`view_show_navigator`), outline toggle (`view_show_outline`),
  and perspective toggle (`view_perspective_toggle`).
- Each toggle is exposed through reactive state on `ProjectModel` (`wireframeOn`, `printableBoxOn`, etc.)
  with checkmarks in the menu reflecting active state.
- Printable boundary box: `FilamentScene.setPrintableBox(widthMm, depthMm, heightMm, visible)` renders
  the 12 bounding edges of the printable volume in cyan (`#4fc3f7`) with GPU lines geometry and
  invalidates the scene; `WorkspaceRenderer` synchronizes visibility with the model's state.
- Wireframe overlay: `FilamentScene.setWireframe(visible)` dynamically allocates an index buffer for line edges (`RenderableManager.PrimitiveType.LINES`, 6 line indices per facet triangle) sharing the chunk's packed vertex buffer, drawn using `wireframeMaterial` with priority 4 and `setPolygonOffset(-1f, -1f)` to avoid z-fighting against the shaded surface; `WorkspaceRenderer` synchronizes wireframe state with `ProjectModel.wireframeOn`.
- Perspective / orthographic toggle: `FilamentScene.setPerspective(enabled)` switches the Filament camera projection between perspective (`setProjection(FIELD_OF_VIEW, aspect, .001, 10.0, Camera.Fov.VERTICAL)`) and orthographic (`setProjection(Camera.Projection.ORTHO, -halfWidth, halfWidth, -halfHeight, halfHeight, .001, 10.0)` where `halfHeight = orbit.distance * tan(FIELD_OF_VIEW / 2)` and `halfWidth = halfHeight * aspect`). `OrbitCamera.ray` and `project` in `MeshPicking.kt` support orthographic ray casting with parallel rays scaled by `orbit.distance * extent`, verified by `OrbitGesturesTest`; `WorkspaceRenderer` synchronizes perspective state with `ProjectModel.perspectiveOn`.

Add menu calibration and library models (`ADD_MENU` in `ProjectEditing.kt`):
- "Calibration cube" (`add_calibration_cube`): generates a 20 mm calibration cube via `PrimitiveShape.CUBE`.
- "Calibration tower" (`add_calibration_tower`): generates a calibration test cylinder via `PrimitiveShape.CYLINDER`.
- "Add from library" (`add_handy_model`): opens the model intake picker via `documentRequest = "file_import_model"`.

Help menu and dialogs (`HelpMenu`, `HelpDialogs.kt`):
- "Keyboard Shortcuts" (`help_shortcuts`): opens `ShortcutsDialog` displaying common shortcuts
  (Undo, Redo, Cut, Copy, Paste, Delete, Select All, Deselect All, Move/Rotate/Scale gizmos, and Command Palette).
- "Tutorial" (`help_tutorial`): opens `TutorialDialog` displaying the 5-step slicing workflow.
- "Show Tip of the Day" (`help_tip_of_day`): opens `TipOfTheDayDialog` with rotating usage tips and "Next tip" navigation.
- "Check for Update" (`help_check_updates`): opens `CheckUpdatesDialog` showing version ("0.1.0-dev"), engine provenance, and up-to-date status.
- "Setup Wizard" (`help_setup_wizard`): opens `SetupWizardDialog` with getting-started printer/filament guidance and one-tap "Open Prepare".
- "Search Help" (`help_search`): focuses and opens the command palette over whichever area shows.
- "Documentation" (`help_docs`): dispatches `urlRequest` to `https://orcaxr.martinez.fyi`.
- "Report a Bug" (`help_report_bug`): dispatches `urlRequest` to `https://github.com/ignacio82/OrcaXR/issues/new`.
- "About OrcaXR" (`help_about`): opens `AboutDialog` with version ("0.1.0-dev"), engine provenance ("Snapmaker OrcaSlicer v2.3.4"),
  and pinned commit (`9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`).
- "Language…" (`help_language`): opens `LanguageDialog` listing all 19 supported locales (and system default),
  applying selection dynamically via Android 13+ `LocaleManager`.

Preset management (`PresetLibraryDialog.kt`):
- Actions `presets_install_printer`, `presets_create_custom`, `presets_update_custom`, `presets_delete_custom`,
  `presets_export_bundle`, and `presets_import_bundle` route to `PresetLibraryDialog`.
- Three tabs: Printers (installed printers: Snapmaker U1 4-head, Elegoo Centauri Carbon single head, with nozzle sizes and link to Prepare),
  Custom (authored custom presets), and Bundles (exporting and importing bundle archives).

Reduce motion (`MotionPreference.kt`):
- `MotionPreference` persists in-app animation preference in `orcaxr.motion`.
- `OrcaMotionScope` exposes `LocalReduceMotion`, allowing animation suppression across the UI.

### Android model repair and mesh Booleans

The Android application provides model repair and CSG mesh Boolean operations
matching the browser's tools (`OrcaWorkspace.repairModel` and
`OrcaWorkspace.booleanModels`), routed through the isolated `:engine` service
and executed against `libslic3r`'s native C++ geometry kernels.

Engine adapter and package. `liborcaxr_engine.so` exports ADMesh `repair`
and CGAL `boolean_mesh` in both Android ABIs (`x86_64` and `arm64-v8a`), bound to JNI
via `NativeEngine.nativeRepair` and `nativeBoolean` in `tools/native-engine/adapter/engine_jni.cpp`.
Repair loads binary STL input, runs `admesh_repair` (filling holes, fixing normals,
repairing facets), and writes binary STL output. Mesh Boolean loads two binary STL
inputs (placed in world bed coordinates), runs `libslic3r::MeshBoolean::cgal::boolean_mesh`
with operation `UNION`, `A_NOT_B` (subtract), or `INTERSECTION`, and writes binary STL output.
Both ABIs are built, stripped, and packaged with their manifest into `android/app/src/main/assets/engine/`.
Verified by `tools/native-engine/test-engine-adapter.py` passing 8/8 tests across both ABIs.

Process and IPC. `ILocalEngine.aidl` declares `startRepair` and `startBoolean`
with caller `IBinder` owner death links. `LocalEngineService` runs in the isolated
`:engine` process, executing jobs asynchronously in private staged directories under
`noBackupFilesDir`. Cancellation, cooperative termination, and process death tracking
are enforced by `LocalEngineClient`, matching slicing lifecycle guarantees.
Input STLs are sealed and verified by `LocalSlicing.stageRepair` and `stageBoolean`.
Output meshes are claimed and verified against the engine's reported length and SHA-256
via `LocalSlicing.claimMesh` (`LocalEngineResult.MeshCompleted`).

Core export, decoding, and topology guards. In `orcaxr-archive`, `exports::find_volume`
and `write_volume_binary_stl` export a volume's raw geometry in volume-local space
without instance/volume transforms, ensuring ADMesh repair preserves placement and annotations
are reset atomically. In `orcaxr-android`, `export_volume_stl` streams the local STL, and
`decode_stl_mesh` decodes resulting binary STL bytes directly into an `AssetPayload`
without round-tripping through disk files.
In `core-bridge`, `ProjectWorkspace.repairSelected` executes under a `TopologyGuard`
(asserting `volumeId`, `assetId`, `assetDigest`, `topologyRevision`, and `triangleCount`),
installing the repaired mesh via `StagedCommand.ReplaceVolumeMesh`.
`ProjectWorkspace.booleanSelected` exports both instances in world coordinates, executes
under a `BooleanGuard` (asserting `targetInstanceId`, `targetVolumeId`, `targetAssetId`,
`targetAssetDigest`, `targetTopologyRevision`, `targetTriangleCount`, and `otherInstanceId`),
installing the result via `StagedCommand.MeshBoolean` (which resets volume and instance
transforms since output is in bed space, and removes the second instance and its object if empty).

UI, actions, and localization. Actions `repair_model`, `mesh_boolean_union`,
`mesh_boolean_subtract`, and `mesh_boolean_intersection` join `ProjectEditing.TOOLS_MENU`,
`MODEL_TOOL_MENU_ACTIONS`, and `ProjectModel.perform()`, raising `AppActions.PERFORMED` to 120 actions.
Icons map to Material symbols `healing`, `merge`, and `join_inner`. All 4 actions and their
status/error strings are localized into 19 languages in `contracts/android-strings.json` and
generated `values-*/strings.xml` (0 refused).
Verified by `cargo test --all`, `./gradlew testDebugUnitTest`, `android-local-slice-smoke`,
and `android-modeltools-smoke` on an API 34 emulator.

### Android filaments

The app lists and assigns the project's filaments as the browser's
workspace does, through the shared core ([Filament assignment and filament
slots](#filament-assignment-and-filament-slots)) — never a second filament
list.

The Prepare area shows the browser's Filament tab under its pickers
(`FilamentList`): one row per filament slot of the project — its colour
swatch, `H-n` for a printer head or `A-n` for an extra palette colour, the
filament's name and type, a head's nozzle (the browser's 0.2/0.4/0.6/0.8)
or an extra colour's Del — then "+" (described as the browser's "Add an
auxiliary palette color (not a virtual recipe)") and the heads panel's "Open
virtual filament library", which brings the library (below) into view. A
swatch opens a colour editor (the palette's colours
or a typed `#rrggbb`, applied in lower case as the browser's colour input
reports it). `ProjectView.filamentSlots` (`ProjectSnapshot.filamentSlots`,
the slots the project's own physical filaments describe) and
`ProjectView.filaments` (the assignment snapshot of the selection) are read
with every project or selection effect. Each edit is
`ProjectWorkspace.editFilamentSlots`: on the actor's authority it adopts the
project's own slots (as the browser adopts an opened project's), applies the
browser's edit and stages the live configuration as one undoable "Update
slicing configuration"; a seventeenth slot is refused in the browser's words
(shown under the pickers), a head's slot is never removed. Adopting first is
deliberate: an edit starts from the project's current filaments, so an undone
slot, colour or nozzle never comes back with the next edit. The browser's
workspace keeps its palette beside the project and used to keep it through
undo, so after undoing an added slot its next colour edit brought the slot
back; its `undo` and `redo` now wait for a queued configuration and then
follow the project's filaments (`followProjectFilaments`: the palette, head
presets and nozzles from `projectFilamentSlots`, adopted without committing a
step, so redo stays available), regression-tested by
`web/src/workspace/__tests__/palette-follows-history.test.ts`. The Prepare pickers
follow the project's slots too (`SlicingProfiles.follow` on each change, so
undo and redo move them), choices start from the project's slots, an opened
or restored project's filaments become the slots a later choice starts from
(the browser's open; before this the app kept its previous palette), and
each extra slot has its own "Palette filament n" picker beside the heads',
as the browser's heads panel. Edits wait for a chosen profile: the browser
commits none for a project that slices as authored.

The Project area shows the browser's selection filament bar under the tree
(`SelectionFilamentBar`), only while the selection can take a filament and
holds nothing that cannot: the one scope's label or "n selected", a chip per
head and mixed filament (swatch, head number or M, name; described "Head n ·
name" with its warnings; the choice every scope shares pressed; disabled ones
not pressable) and "Default", which removes the local assignment. A press is
`ProjectWorkspace.assignFilament`: planned on the authority from the
session's whole selection — the core resolves the scopes and the
assignments, refusing as the browser's controller does — and executed as
one `setFilamentAssignments` under that state's guard, labelled by the core
("Assign filament", "Assign n scopes"); the bar then says "<name> assigned",
"Local assignment removed" or the refusal. Tree rows show the Objects
panel's indicators (not printable, a part's role, the filament — "(mixed)",
"(inherited)" — with its swatch, painted facets, custom settings). The
browser binds no shortcut to assignment: its digit keys pick the paint
filament, which belongs to painting.

`ProjectFilamentChecks` (76 checks over JNI) open the assignment corpus's
3MF in a `ProjectWorkspace` with the browser's hash and replay its journey —
each selection's snapshot equal to the browser's, each assignment's hash and
undo label (or refusal), the tree's physical and mixed badges, every undo —
then, on a cube configured with the catalog's default profile, add a slot
(grey PLA, the profile's filament), refuse a head's removal, undo and
recolour without bringing the slot back, change a nozzle, remove an extra
slot, fill sixteen and refuse the seventeenth, and assign the cube to the
last slot (its row's badge, one step, undone). `ProjectSlicingConfigurationChecks`
replay the slot edits and project slots through the Kotlin wrapper;
`FilamentsTest` (app JVM, 6 tests) covers the rows' labels, the bar's
visibility, chips, shared choice and status, the tree's indicators and
colour parsing. `android-filament-smoke.py` (run by `emulator-smoke.py`
before the adaptive smoke) adds a cube, adds a fifth slot in Prepare (A-5
and its picker), selects the cube with Select All, assigns it from the bar's
"Head 5" chip ("Undo Assign filament", the filament under the cube's row),
undoes it (the row shows none) and recolours the new slot from its swatch,
then drives the virtual filament library (below); it passes on both
emulators. Not yet done: the inspector selector's height-range scopes in
a panel of their own (the bar assigns ranges selected in the tree).

The Prepare area shows the browser's virtual filament library under the
Filaments list (`VirtualFilamentLibraryPanel`, through the shared core: [The
virtual filament library](#the-virtual-filament-library)): its heading and
"Add virtual filament" (offered with two heads a recipe can select, else
described as the browser describes why not), the library's status or the
last operation's ("Add request accepted for <name>." and the rest, in the
browser's words), why the library cannot be shown, the physical components
recipes reference (`H<n> · <name>`, material, colour and Available,
Incompatible or Disabled with the reason) and the virtual library — each
live recipe's badge, mode, availability and colour, its summary, and Edit,
Duplicate, Enable/Disable and Delete. `ProjectView.virtualFilaments`
(`ProjectSnapshot.virtualFilamentLibrary`) is read once per project
snapshot. The author dialog (`VirtualFilamentAuthorDialog`) opens on the
fields the core gives (`VirtualFilaments.opening`: the browser's defaults,
a row's recipe, a duplicate's " copy" name) and shows, for every change of
its fields, what the core answers (`VirtualFilaments.validate`): name, badge
colour (typed, or a palette swatch in upper case as the browser's picker
reports it), both surface offsets; the four modes — Ratio's two or three
heads, B percent slider and exact field, triangle proportions with the
triangle picker (tapped or dragged; `VirtualFilaments.triangleWeights`) and
the predicted mix; Cycle's pattern with its quick tokens and new-group
button, each located issue selecting its characters; Match's coverage note,
target, minimum and ranked candidates from the pinned search
(`VirtualFilaments.search` on a worker thread, after the browser's 160 ms
debounce, the newest search winning, a changed target or minimum dropping
the choice and the search); Gradient's heads, direction, sublayers and
vertical preview — then the issues, the preview line, Cancel and Add, Apply
changes or Create duplicate, enabled only for a complete draft with no
search pending and the project unchanged since the dialog opened (else the
browser's "reopen" message). The delete dialog reviews the recipe's
references. Each edit is `ProjectWorkspace.changeVirtualFilament`: planned
on the actor's authority from the state it reads (a new recipe's ID drawn
as the browser's controller draws it) and executed under that state's guard
as one undoable step with the browser's label — one intent, or the labelled
transaction the browser submits for an edit or a tombstone — a refusal
staying in the dialog ("The recipe was not changed: …", "<name> was not
deleted: …") or under the library for Enable/Disable. The platform-free
dialog rules (`VirtualFilamentDialogs`) keep the search's lifecycle, the
stale guard, the edit submitted and the picker's mapping; the core computes
the rest.

`ProjectVirtualFilamentChecks` (105 checks over JNI) open the library
corpus's 3MF in a `ProjectWorkspace` with the browser's hash and replay its
14-step journey: the view's library equal to the browser's at every step,
the dialog's fields opened as the browser opened them, the Match search's
candidates, the draft validated from the browser's fields, then the step's
hash and undo label (or the refused pair in the browser's words, the new
recipe under the browser's ID), every undo back to the opened state with the
library following, and the triangle picker. `VirtualFilamentDialogsTest`
(app JVM, 6 tests) covers the dialog rules over a stand-in core.
`android-filament-smoke.py` goes on from the Filaments list: "Open virtual
filament library", "Add virtual filament" (the browser's 50 % Ratio of the
first two heads, its exact cadence previewed), a name typed and Add ("Undo
Add <name>"), the row's Disable ("Undo Disable mixed filament"), its Delete
reviewed and confirmed ("Undo Remove mixed filament", the library empty),
and undo bringing it back, still disabled; it passes on both emulators.

### Android painting

The Workspace draws every part in its colour and its paint, as the browser
draws them, and paints as the browser's painter paints.

Colours. A part's tint is the colour of the filament it resolves to, from the
render deltas (`volumeDisplayColor`: the part's own filament, then its
object's; a physical filament's colour or a mixed recipe's display colour;
the browser draws no height-range colour), or the browser surface's neutral
`#b8bec8` when nothing is assigned; helper volumes draw as model parts do,
in the filament they resolve to, as the browser's surface draws every role
with one material. A change of filament is a retint alone: no mesh or paint
is sent again. Paint is drawn on the part's own facets: `SceneSync` reads every
drawn volume's [paint facets](#paint-facets-and-the-painters-settings) of the
channel shown — colour, or the channel the active paint tool authors (the
browser's `PAINT_TOOL_CHANNELS[tool] ?? 'color'`), so support, seam and
fuzzy-skin paint show only while their tool does — into `ScenePaint`
(renderer-api, platform-free), which keeps each painted volume's vertex
colours and hands on only the facets whose colour changed, in ranges of at
most 16,384 facets (short unchanged gaps ride along). A painted facet's
vertices carry its colour under the facet's baked shade with alpha 0; any
other facet's its shade with alpha 255. The two materials now mix by that
alpha — `mix(color, color × tint, color.a)` — then move toward the selection
accent by a `highlight` parameter, the transparent one premultiplying by its
opacity in the shader. `FilamentScene` uploads each drawn volume once (its
mesh's chunks with colour bytes of its own, shared by its object's
instances; picking indexes stay per mesh asset) and applies a paint change as
partial colour uploads (`setBufferAt` at the facet's offset) of the chunks a
range crosses: positions and indices are never sent again. Filament's Java
API cannot free a `BufferObject`, so positions are not shared between two
volumes of one asset. Leaves of subdivided facets are a small mesh of their
own drawn over the volume with a polygon offset, as the browser's overlay is.
While a stroke is in flight its preview shows over the paint at the browser's
55% (`PAINT_PREVIEW_MATERIAL`), a refined preview hiding the canonical paint
as the browser hides its overlay.

Painting. The Workspace's toolbar offers Paint (`tool_paint` on
`dom-toolbar`, enabled as the core enables it: a selected instance), and its
panel is the browser's paint panel (`PaintPanel.ts`): the channel (switching
tools as `configurePaint` does), the palette with its swatches, badges and
keys (the inheriting row erases) or the channel's states and Erase, the six
tools, the tool's parameters with the panel's ranges and steps, and Erase all
painting on selection (`paint_erase_all`); a hardware keyboard's `1`–`9`
choose the numbered rows (`paint_select_filament_N`) and Escape drops a
stroke in flight. `PaintToolState` (app, platform-free) holds the browser
workspace's paint state and statuses (`setTool` taking the first filament,
`setPaintFilament`, `setPaintFilamentByNumber`, `setPaintTool`,
`setPaintChannelState`). A drag that starts on a model paints: `PaintModel`
opens a stroke where the finger first met a part (`ProjectPainter.open`, on
the actor's authority), samples it on a worker thread at every move over
that part alone (`FilamentScene.pick` now answers the hit and the eye in the
part's own millimetres; moves arriving while a sample runs collapse into the
latest, its capsule sweeping from the last sample), previews it, and commits
on release as one undoable step with the browser's label ("Paint colour
facets", "Erase support facets", the refined tree's "Paint refined colour
facets") — a stroke that touched nothing submits nothing, a stale one nothing
either — then says what the browser's status says. Refusals use the
browser's words (`parameter-modifier volumes cannot be colour painted`,
`The paint placement must be finite and invertible`, `Paint failed: …`).
Samples are the browser's: the hit and eye in the part's own frame and the
placement of the draw the finger met (`ProjectScene.Draw.placement`, the
instance's and the part's canonical transforms), so the core measures the
brush and the band in the bed's millimetres, as
[the painter's settings](#paint-facets-and-the-painters-settings) describe.
Erase all (`ProjectPainter.eraseAll`) resets each model part the selection
paints as its own "Erase all colour facets". Two browser defects were fixed
on the way, with a workspace regression test: Erase all took every part on
the plate while an instance was selected (it now takes the selected
instance's object, as a selected object), and tried to reset helper volumes,
which refuse painting, failing part-way. Every tool the browser's panel
offers is here (Circle, Sphere, Triangle, Fill with its smart-fill angle,
Height range, Gap fill) and so is erasing; Smart Paint stays out of scope.

`ProjectPaintChecks` (45 checks over JNI) paint a cube given two filaments
where a pick ray meets it — the palette and its keys, the tools the core
enables, a Circle stroke previewed in the filament's colour and committed as
one "Paint colour facets" that undo and redo take back and restore, an erase
by Fill, support paint in its fixed colour, the painter's refusals (a flat
placement, an unknown filament, a modifier), the brush on the bed (on a 200%
placement a 4 mm sphere takes what the part's own 2 mm takes and 2 mm takes
less; a stretched placement's factors; the band from the hit's bed Z), an
untouched and a stale stroke committing nothing, and Erase all of the
selected instance's object, of every model part and of nothing left;
`ProjectScenePaintChecks` (13, renderer-api) follow a real session through
`SceneSync`: the object's filament tints its draw, a preview changes facet 0
alone at 55%, the stroke paints it in its own colour, undo returns its shade,
support paint shows only while support is the channel drawn, and a renderer
made afresh gets every painted facet. `ProjectSceneColourChecks` (9,
renderer-api) follow the base colours: an unassigned cube in the neutral
colour, its object's physical filament and then a mixed recipe's display
colour, its part's own filament over its object's, a modifier in its
object's filament and then its own, a height range's filament changing
nothing drawn, and undo recolouring — each a retint alone. The render-delta
corpus now assigns an object a mixed filament, a part its own filament and a
height range one (313 pages, 265 session requests; 50 Kotlin render checks).
`ScenePaintTest` (renderer-api) and `PaintToolTest` (app) cover the colour
arithmetic, ranges, previews, leaves, the panel state, its statuses and
refusals. `android-paint-smoke.py` (run by `emulator-smoke.py` before the
adaptive smoke) adds and selects a cube, opens Paint and chooses row 2 with
the keyboard's 2; assigns the cube to head 2 from the Project area's
selection filament bar (the project filaments unit's) and finds the
Workspace's pixels over the cube recoloured, then undoes it and finds them
as before; drags across the cube and finds the pixels it painted changed,
to the colour the assigned cube was drawn in; finds "Undo Paint colour
facets", undoes it and finds the cube drawn as before. It passes on both
emulators.

### Android Smart Paint

The shared Rust core (`orcaxr_project::smart_paint`) implements Smart Paint proposal
validation, 3D geometric projection, and transactional batch commit planning:

- Proposal validation (`proposal.rs`): Strictly enforces schema and domain bounds
  matching the TypeScript reference (`aiPaintProposal.ts`). A proposal is admitted
  only if it contains 1 to 32 regions with valid hex colours (`#RRGGBB`), normalised
  surface normal direction vectors, cone angle tolerances within (0, 180] degrees, and
  confidence values within [0.0, 1.0].
- Geometric projection (`projection.rs`): Projects candidate regions onto mesh facets
  using the volume's vertex coordinates and triangle indices. Facet bounding boxes are
  evaluated against the proposal's normalized extents, and triangle face normals are
  filtered against region normal cones. Layering proceeds in declared order so later
  regions cleanly overwrite earlier ones on shared triangles. Calculates exact facet
  coverage counts, percentage coverage, and weighted proposal confidence.
- Atomic commit planning (`plan.rs`): Assembles projected region assignments into a
  single transactional `wire::Batch` intent composed of `FacetStroke` commands with
  contiguous triangle ranges, guaranteeing atomic application or complete rollback.
- Geometry description: Exposes bounded bounding box dimensions (mm) and facet counts
  without leaking internal vertex data off-device.

The JNI layer (`orcaxr-android::project::smart_paint`) exports four methods:
`smart_paint_validate_proposal`, `smart_paint_describe_geometry`,
`smart_paint_project`, and `smart_paint_build_batch`. These are surfaced through
`ProjectSmartPaint.kt`, `ProjectSession.kt`, and `ProjectWorkspace.kt` (`smartPaintDescribe`,
`smartPaintProject`, `smartPaintBuildBatch`, `applySmartPaintBatch`).

The Compose UI (`SmartPaintDialog.kt`, `ProjectModel.kt`) provides:
- Explicit consent gates: Two independent checkboxes require user confirmation before
  sharing geometry bounding dimensions or attaching optional camera reference images.
- Proposal trigger & prompt configuration: Text input and trigger button driving the
  async AI generation session.
- Region review: Lists detected regions with confidence percentage, surface coverage,
  and triangle counts, with an interactive filament destination dropdown per region.
- Headless testability: Includes a portable pure-Kotlin `SimpleJson` parser, eliminating
  Android SDK `org.json` mocks in JVM unit tests.
- Action integration: 6 actions (`tool_smart_paint`, `tool_smart_paint_image`,
  `paint_smart_configure`, `paint_smart_request`, `paint_smart_apply`, `paint_smart_cancel`)
  wired into `AppActions.kt`, localized across 19 language sets, and verified in
  `SmartPaintActionsTest.kt`, `AppActionsTest.kt`, and `tests/smart_paint.rs`.

### Android settings panels

The Project area's tree rows lead to the inspector's other panels, as the
browser's Process card and Objects card offer them, through the shared core
([The settings panel model and the height-range editor](#the-settings-panel-model-and-the-height-range-editor)).
An object's or part's "Settings" row opens that node's settings; an object's
"Layer ranges (n)" row opens its height ranges. One panel shows at a time
under the tree (after the transform inspector), beside the Workspace from
840 dp; a setting's name and control share a line from 300 dp of column, as
the browser's sidebar grid has them, and stack on a narrower phone.

The settings panel is the browser's scoped settings panel: its heading
("Object settings — cube.stl"), "Settings for" with every node the project
has (`Object: Plate 1 › cube.stl — 2 overrides`, project and plates
included; another opens its panel), what the scope's values do, the detail
level (Simple, Advanced, Develop) and the search, the core's
"n settings shown; m unavailable.", then each GUI group and its settings —
the control the core names holding the inherited, default or overridden
value with its unit, the origin badge, "Draft changed", Unavailable or
Structured editor and Not applicable, "Use inherited" and "Use default",
the browser's unavailable and Full Spectrum notes and the issues in its
words — and Cancel and Apply. A field drafts every change as the browser's
`input` event does (keeping its typing while focused); Apply is enabled for
a valid change on the state the draft began on, commits every draft as one
`setScopedOverrides` (or `setProjectSettingsOverrides`) intent under that
state's guard — one undoable step the core labels "Update object
settings", "Update part settings" or "Update height range settings" — and
the panel reads the node again ("Applied n setting change(s) atomically.").
An invalid draft is refused before anything is submitted ("Fix the
highlighted validation errors before applying: …"), a draft setting what
the node holds applies nothing, a project changed meanwhile refuses in the
browser's words ("No settings were applied: The settings draft no longer
matches the displayed canonical project snapshot."). A project change
reloads a clean panel ("Project settings refreshed …") and keeps a draft as
the browser's conflict, until "Discard draft and reload current settings".
`ProjectSettings` (core-bridge, over `ProjectWorkspace`) opens a node's
panel on the authority with that state's guard and submits; `InspectorModel`
(app) hosts it on a worker thread; `SettingsShell` and `RangeForms` hold the
platform-free rules.

The height ranges are the semantic editor's: the object's ranges by height
(a listed range selects it, as its tree row does), "Add range" with its
bounds checked by the core as typed (finite, ordered, clear of every
other range), and for the selection's range "Selected 0 mm–5 mm" with its
Settings (the scoped panel on that range), "Apply boundaries", "Split
range", the merges the command allows (or why not) and "Delete selected
range" — each the browser's intent ("Add layer range", "Edit layer range",
"Split layer range", "Merge layer ranges", "Delete layer range", new IDs
drawn as the browser draws them) under the guard of the state the ranges
were read on, the operation's pending and success words in the status, a
stale panel refused as "Semantic object edit was prepared for a stale
canonical project revision". A range's filament is assigned from the
selection filament bar ([Android filaments](#android-filaments)). Layer
events are not part of this inspector in the browser: they live in its
Preview card, beside the G-code listing (`LayerEventPanel`), and stay with
Preview. The semantic editor's volume roles follow the selection
([Android volume roles](#android-volume-roles)).

`ProjectSettingsChecks` (1,363 checks over JNI) read every reply of the
panel corpus through the Kotlin wrappers, then on an imported cube list the
nodes with the browser's words, show the object's Simple view, apply a wall
count and an infill density (one "Update object settings" each, the node
holding exactly them), apply nothing for a held value, refuse an unreadable
one and a draft begun before another edit, reset with "Use inherited" and
undo it, apply a part's wall count, add a 0–5 mm range (selected), give it
its own wall count, edit, split (the upper range selected), refuse a stale
delete, merge and delete it, and undo all nine steps back to the import.
`InspectorPanelsTest` (app JVM) covers the rows that open panels, Apply's
enablement, conflicts and answers, and the range forms' words.
`android-settings-smoke.py` (in `emulator-smoke.py` before the
accessibility smoke) adds a cube and slices it, opens its Settings row,
applies a wall count of 6 and a 25% infill ("Undo Update object settings",
"Settings (1)", "Settings (2)"), slices again and finds more G-code lines,
resets the wall count by its key's "Use inherited", adds a 0–5 mm range
from the "Layer ranges (0)" row, applies its own wall count ("Undo Update
height range settings") and undoes it. It passes on both emulators (API 34,
and API 37 with 16 KB pages).

### Android volume roles

The browser's semantic editor shows its "Volume role" section for whatever
the selection names; the Project area shows it under the tree, after the
transform inspector, beside whichever panel a tree row opened. A selected
object, instance or height range gives the browser's hint ("Select a part
or semantic volume to inspect its role."); a selected part (a tree row of an
opened object) gives its summary ("Modifier 1 — Parameter modifier"), the
editor's status, and "Convert to": one radio row per role in Orca's order,
the current one marked, each other enabled only when the core offers it,
with the core's words under every role not offered ("This is the current
role; no conversion is needed.", "The last model part on an object cannot be
converted to a non-model role", …). Choosing one runs the browser's
`runOperation`: "Converting Modifier 1 to Negative volume…", then one
undoable "Convert volume to negative part" and "Converted Modifier 1 to
Negative volume.", or "The guarded operation was rejected; the canonical
view was not changed optimistically. …" (a stale read: "Semantic object
edit was prepared for a stale canonical project revision"); the section
then reads the project afresh, nothing changed optimistically. The status
is the editor's own and stays as the selection moves from part to part, as
the browser's does. The words come from the core
([Volume-role conversion](#volume-role-conversion)): the role names and
refusals are English in every language, as in the browser; the heading, the
hint and "Convert to" are the browser's translated messages. TalkBack hears
a heading, then a radio group whose rows read their role, their reason and
whether they are selected or disabled; the status is a live region (a
rejection assertive). `InspectorModel` reads a part's choices on its worker
with the state's guard (`ProjectSettings.volumeRoles`) on every project or
selection change and converts through `ProjectSettings.convertVolumeRole`;
`VolumeRoleSection` holds the platform-free rules (what the selection shows,
when a choice converts).

Set as Negative Part (`set_negative_part`) is where the catalogue offers it
on Android: the Add menu (the browser's menu offers it in the same section as
Add Modifier and the support volumes, after them) and the command palette,
enabled by the core for an instance selection, with the browser's glyph, words
and hint. It runs `ProjectWorkspace.setNegativePart`; a refusal reads "Set as
Negative Part failed: …", the browser's status. Its success words ("Set part
as negative volume.") are not shown, as the helper volumes' are not: the
history's label says which it did.

`InspectorPanelsTest` covers what the selection shows and which choices
convert; `ProjectEditingTest` the Add menu; `AppActionsTest` the glyph,
words and hint of all 62 performed actions. `android-roles-smoke.py` (in
`emulator-smoke.py` after the settings smoke) adds a cube (the hint), adds a
modifier and reads its choices (the current one marked and explained, every
other offered), converts it to a negative volume ("Undo Convert volume to
negative part", "Converted Modifier 1 to Negative volume.", the tree's
`negative-volume` indicator), selects the cube's own part and finds every
other role refused as the object's last model part, runs Set as Negative
Part from the Add menu and from the command palette ("Undo Add negative part
to object" each), and undoes back to the modifier. It passes on the
iteration emulator (API 34, x86_64, the branch's APK built without an
engine); the two suites have not run it yet.

### Android Preview area

The Preview area is the browser's "Open G-code Viewer…" (`file_open_gcode`)
over the shared core's G-code preview — no parsing of its own. `PreviewModel`
reads a picked document through a bounded stream (refused above 64 MB) and
runs the `GcodeSession` on a worker thread; `GcodePreviewPlan`
(`renderer-api`, platform-free, 10 JVM tests) ports the view state of the
browser's `GcodePreviewController`: whether a print loads whole or in bounded
windows, which window a top- or bottom-layer move loads, previous/next
window steps (single layer included), clamped and swapped layer ranges, the
hidden move types and the window notice word for word. The toolpaths draw as
`FilamentScene.setToolpath` lines in the core's colours, framed
(`PreviewFraming`, 4 tests) above the bed; the screen offers the 12 colour
modes in the browser's order and names, top and bottom layer sliders with the
layer's Z, single layer, the move filters (each a labelled toggle, so
accessibility services read its name) and the legend, value range and
layer count as the browser's panel words them. `android-preview-smoke.py`
opens a two-layer, two-tool reference through the system picker on the
emulator: about 520 pixels of the toolpath view take the core's colours
(the empty view has none), the tool mode and single layer each change the
picture, the preview survives leaving the area, and an empty file is refused
as the browser refuses it. Below the filters it shows what the file states —
estimated time, weight, layers, tool changes, and each tool's material,
length and weight beside a decorative swatch — as the browser's panel words
it (`GcodeSession.summary`; the smoke reads `≈42s · 0.02 g`). The bed is the
project's (`ProjectView.bed`), enlarged to the toolpath in 10 mm steps (G-code
carries no bed). The bottom navigation's labels now stay on
one line: with four areas a phone left "Workspace" wrapped.

### Android Prepare area

Slice, Cancel Slice, the job's progress, the slice's status line and the
send's progress (with Cancel send) stay above the area's list, as the browser
keeps Slice in its toolbar and its status in a status line: the profiles,
every filament slot and the virtual filament library run to several screens
(a project with eleven recipes to many), and the slice's result card — its
Preview and Send to Printer — heads the list, where the operator returns
after a slice. While the keyboard is up the bar steps aside, so the field
being typed in keeps the room above the keyboard (little, in landscape).

Prepare slices the active plate on the external slicer as the browser's
`sliceNow` does. Its connection is the browser's
`ExternalSlicerConnectionController` (`SlicerConnection`: the policy's
canonical endpoint, off until its engine attests within 8 s, generations
that make a check in flight moot, persisted as its record is and checked
again at start), with the browser panel's words ("Checking engine…",
"Online — attested" and the engine, or the policy's refusal). The bearer
token is the `slicerToken` of the one remembered-credentials record a process
shares (`SharedCredentials` over the `CredentialVault`), so the Device area's
keys never overwrite it, its remember switch keeps or drops it, and its
Forget clears it (in the browser's words). A slice attests the route again,
runs the shared preflight of the active plate (`ProjectWorkspace.preflight`,
the project's own printer and filaments, shown as the browser's panel cards
with Hide/Show; a blocking one refuses as `SlicePreflightError` does), writes
the one-plate archive (`projectPlate`, refused when its `ProjectRevision` is
not the preflight's), and — only to an endpoint the operator agreed to once —
uploads it, with "Cancel Slice" stopping before the upload or ending in the
client's confirmed outcome. The G-code streams into the app's cache through
`SliceStatusTally` (the shared core's count of what the browser's status
line says: lines, and layers by the engine's own total first) and is discarded
when the project changed meanwhile; otherwise Preview opens it
(`PreviewModel.openSlice`, keeping its revision) and withdraws it once the
project changes, by the browser's rule ([stale slices](#android-stale-slices)).
The platform-free flow has 11 JVM tests;
`android-prepare-smoke.py` drives it on the emulator suites (API 34, and the
16 KB API 37 image) against the real server on the host
(`external-slicer-serve.mjs`, reached at 10.0.2.2): the refusal without a
token; a cube imported into a new project, which starts from the catalog's
default profile and passes the preflight; another printer chosen from the
picker (one undoable step); the cube sliced after consent, shown in Preview,
a confirmed cancel, and the slice withdrawn once a model is imported; then
the multicolour hexagon, which carries its own printer and filaments, slicing
with them while the pickers say so. Its first run
found the client's stale keep-alive connection (above) and a server defect:
results in a temporary directory under a dot directory were never delivered
([runtime and deployment](runtime-and-deployment.md)). Slicing on the device's own engine
is [below](#android-local-slicing); Slice All Plates, the plate's pictures and
the repeatable download [further below](#android-slice-outputs). Wave overhangs are supported via [WaveOverhangsCard](#android-wave-overhangs). Not yet matched:
preflight actions (reveal, drop to bed), troubleshooting text.

### Android profile selection

Prepare chooses the catalog profile a project slices with, as the browser's
top-bar pickers do. `SlicingProfiles` (the browser workspace's `profile` and
head filaments) builds the bundled `profiles/catalog.json` — an asset the app
build copies from `web/public/profiles` — in the shared core with ICU's
English collator (`EnglishPresetCollator`, the browser's
`localeCompare(…, 'en')`; an instrumented test replays the browser's
collation pairs and builds the catalog in its exact profile order), once per
process: every window shares it (`ProfileCatalogs.shared`), since it never
changes and the core admits only four live documents — a catalog per window
beside each window's session left a second window's New Project none, which
the Project smoke's second window found. The
pickers are `ProfileCatalog.slicingChoices`, labels disambiguated, with
"Using the project's own settings" when nothing is chosen and "No compatible
presets" for an empty list; a printer with several heads (the choices'
`extruders`, the shared `profileExtruderCount`) has a filament picker per
head. A choice applies only when complete (`selectPresets`, the browser's
messages shown), is remembered as the browser's `orcaxr.profiles` (presets,
then names to fall back on), and becomes the project's configuration as one
undoable "Update slicing configuration": `ProjectWorkspace.applySlicingChoice`
stages it on the project's authority (`ProjectActor.configureSlicing`, which
now has the browser's staged-edit pool) and executes it. As the browser's new
document, a pristine project takes the remembered or default profile
(Snapmaker U1, 0.4 mm) as its baseline, with nothing to undo; New Project
keeps it. An opened or restored project slices with its own printer and
filaments (the authored preflight) until a profile is chosen; otherwise the
preflight is the chosen profile's exact presets for the project's tool count
(`ProfileCatalogs.preflightTarget`). `ProjectSlicingChoiceChecks` (11, real
session and catalog): a bare cube blocked as authored, the default applied as
one undoable step, the same choice changing nothing, the catalog preflight
passing, undo and redo moving across it, and a new project keeping it. That
last check found that the workspace appended a project document in one
chunk, so any document over the host's 64 KiB chunk — a fresh project
carrying a catalog configuration, or New Project after opening a project
with its own — failed as `input_limit`; documents are now appended in chunks.

### Android local slicing

Prepare slices on the device's own engine as the browser slices in-browser.
The route is the browser's rule (`sliceRoute`): the external slicer when the
operator turned it on and its engine attested — their preference — and
otherwise this device's engine, when the build carries it for one of the
device's ABIs and the device's measured memory admits a plate
(`LocalEngineState`: `ActivityManager` total/available/low memory, re-read
each time Prepare refreshes and again when a plate is staged). An external
slicer the operator did not turn on is never chosen in the device's place,
and none is ever chosen when the device cannot slice: the route line says so
("Slicing route: none." and why). The route line names the engine and the
largest plate the memory admits now; the switch's hint and the connection
statuses use the browser's "slicing locally" words when the device slices.

Engine and adapter. `tools/native-engine/build-engine-adapter.py` layers
over the verified `build-engine.py` recipe instead of extending it: it runs
that recipe's verification, then compiles only `tools/native-engine/adapter/`
(and the constructor regression `defaults_probe.cpp`) with the exact compile
and link lines the engine build gives its probe target (read from that build
tree's `build.ninja`, never written), `-fPIC`, a version script exporting
only `JNI_OnLoad` and the adapter's C entry points, and 16 KB pages, into
`build/adapter/<recipe>/<abi>/`. So an adapter edit never rebuilds libslic3r
(about 50 s per ABI against ~30 min), and an engine change gives the adapter
a new recipe. Its package (stripped `liborcaxr_engine.so`, the engine
package's TBB and libc++ stripped, the fixture driver, resources) is
verified for identity, every ELF's ABI, alignment, runtime closure and
exports; `test-engine-adapter.py` mutates real packages (8 cases per ABI).
The adapter (`engine_adapter.cpp`) reads the one-plate archive and overrides
exactly as the browser engine's project route does (`load_bbs_3mf` with
LoadModel | LoadConfig | AddDefaultInstances, the full configuration with its
enum maps, the project configuration, the overrides — a refused value
skipped and counted as the browser engine skips it — `normalize_fdm`, then
apply, validate with a warning object, process, export), so FullSpectrum and
every annotation channel reach the same engine. Before reading, it checks
each staged input's length and SHA-256; it binds the loader's staging to the
job, reports progress (percent and the engine's step name, printable ASCII,
128 bytes) to a polled state, stops cooperatively (`Print::cancel`, and the
3MF loader's own cancel flag before the print exists), reads the closed
G-code back for its length and SHA-256, and answers one ASCII result document
(completed, failed with a stable stage/code and the engine's words bounded to
the browser's 240 characters, cancelled, busy). Engine logging is off: its
messages can name projects and paths. Sizes: the stripped adapter is
17.8 MB (x86_64) and 16.2 MB (arm64), each ABI's four libraries 19.6/17.9 MB.

Process and job. `LocalEngineService` runs alone in `:engine` (not
exported; process separation, not an isolated sandbox), loads the library
once and refuses it unless its compiled identity (engine commit, engine
recipe, adapter recipe) matches the APK's `assets/engine/manifest.json`,
whose resources it copies out with checked digests. One job at a time:
`LocalSlicing.stage` (core-bridge) writes the plate's archive and overrides
— byte for byte what the external route uploads — into a private
no-backup job directory, syncs, seals and hashes them from the disk; Binder
(`ILocalEngine`) carries only the job's name, those identities, an owner
token, progress polls and the result document. `LocalEngineClient` puts the
service in the foreground first, polls every 250 ms, and on cancel asks for
a cooperative stop; after 10 s without one it ends that generation's
process (`Process.killProcess` of the PID the service reported) and admits
no further job until that process's death is observed. Outcomes stay
distinct (`LocalSlicing.outcome`): output to verify; failed (the browser
engine's "validate failed:" prefix for a refused print); cancelled, or
cancelled with the process ended; interrupted (the engine's process died
unasked — the editor keeps running with its project); unknown (neither a
result nor the death observed). An editor that dies cancels its job through
its owner token, and the service removes that job; jobs an earlier run left
are swept when Prepare starts. Output is published only after
`LocalSlicing.claim` (moved out of the job directory, a regular file of
exactly the reported length and SHA-256, strict UTF-8 as the browser's fatal
decoder, no NUL) and `publish` (the project still the `ProjectRevision` the
plate was staged from, else discarded); it lands where the external route's
does, so Preview, Send to Printer and the out-of-date withdrawal treat both
routes alike ([stale slices](#android-stale-slices)). A plate is admitted when the measured available memory covers
256 MiB plus 16 times its archive (provisional until devices are measured).

Foreground execution. While a job runs the service is a `dataSync`
foreground service — local file processing the operator started, with a
low-importance notification showing progress and a Cancel Slice action — so
a slice continues on task switch and screen lock; the editor may be cached
or frozen meanwhile (it polls; the engine never calls into it) and publishes
when it resumes, if the project is unchanged. Starting is only possible while
the app is in the foreground (a background start is refused in words);
Android 15's dataSync time limit (`onTimeout`) cancels the job. The
notification needs `POST_NOTIFICATIONS` from Android 13: Prepare asks once,
before the first local slice; denied, the slice still runs and the service
appears in the task manager without it.
Remaining to qualify: device thermal pressure, notification denial, the
dataSync daily limit, Doze, and reopening a job interrupted by process death
(the slice is lost; the project is not).

Packaging. Every app build packages the verified export (`bundleEngine`
runs `build-engine-adapter.py --export`), unless `-Porcaxr.localEngine=none`:
the hosted CI job has no engine build and uses it, and that APK says it
carries no engine. The build does not strip those libraries again (they
are stripped and hashed already; its own strip rewrote their bytes), so
`verify-artifacts.py --apk` can check the packaged engine libraries and
resources against the APK's engine manifest and the export, byte for byte.

Verified: `ProjectLocalSliceChecks` (77 host JNI checks on a real session)
stages a plate byte for byte as the external upload, reads well- and
ill-formed result and status documents, maps every end, and claims, refuses
(length, digest, invalid or truncated UTF-8, NUL, a link) and publishes or
discards output by revision; `LocalEngineRouteTest` (5 JVM tests) covers the
route, admission and words; Gradle assemble, unit tests, lint and both
androidTest compiles pass, and `verify-artifacts.py --apk` passes on the
debug APK (109.2 MB with the engine, which adds 17.9 MB arm64 and 19.6 MB
x86_64 of stored libraries) and the shrunk release APK (71.2 MB), whose R8
output keeps the JNI class and method names the library registers. The
instrumented `LocalEngineServiceTest` (a cube sliced through the service,
then a cube scaled to the build volume cancelled mid-slice; it takes the
app's shared profile catalog, as the core admits four documents at a time)
passes on the API 34 emulator and on physical Samsung Galaxy XR (`SM-I610`, ARM64 Snapdragon XR2+ Gen 2). `android-local-slice-smoke.py` (in
`emulator-smoke.py`: a cube from the Add menu, the local route and why, Slice
in the `:engine` process under notification denial, Preview's toolpaths, Prepare's size/lines/layers
against the published file read back, a cube scaled to the build volume
sliced with the service in the foreground, task switching (Home key) and screen lock (Power key) survived,
Cancel Slice, the engine process killed mid-slice with the editor surviving and a fresh engine for
the next slice, and the editor killed mid-slice with owner-token Binder cleanup of staged jobs in
`no_backup/engine-jobs` and service demotion) passes on both emulators (API 34 and API 37 16 KB pages). `emulator-slices.py --adapter`, which reruns the
eleven fixture comparisons through the adapter's C entry point (the one JNI
calls) with its fixture driver, matches the browser engine's references in
all eleven on the x86_64 emulator. Both routes now carry the plate's
pictures and slice every plate ([slice outputs](#android-slice-outputs)).
Physical device qualification for Phase 7 end-to-end local slicing and preview closed on Galaxy XR via `FullWorkflowDeviceTest`. Still open: ARM64 standalone CLI fixture execution and physical printer qualification. The summary line is the browser's, from the
shared core ([above](#g-code-artifact-summary)), on both routes.

### Android send to printer

Prepare's result card offers the browser's "Send to Printer"
(`send_to_printer`: `OrcaWorkspace.sendToPrinter`, the shell's
`onRequestPrintSubmission`, `PrintSubmissionDialog`) beside "Preview", for a
slice that is still current and a printer the Device area connected — the
browser connects as it sends; the app says to connect in the Device area
first. Currency is the browser's `isCurrent` (`SendGuard`): the same
published output (Prepare's `SlicedPlate`, by identity), the same active
plate and the unchanged `ProjectRevision`. A slice that fails it is refused in
the browser's words ("Slice the active plate before sending it to the
printer."), and the workflow asks again at every step, so a project edited
mid-send ends in the core's "The sliced artifact is no longer current…". The
artifact is the file in the app's cache under Prepare's sanitized
`<project>_<plate>.gcode` name: `PrintJobArtifacts` (core-bridge) reads its
SHA-256 and the tools it selects and declares with the shared
`ToolUsageScanner` (the browser's `summarizeGcodeToolUsage`) while holding the
file open, and the upload streams that same open file, so a slice that
replaces or deletes it meanwhile changes nothing sent and Moonraker's
checksum field still matches. `DeviceWorkspace.send` runs the shared workflow
over its session: the capture connects the active printer as the browser's
does and leases the session (a switch or disconnect ends the lease, which the
workflow takes as a cancel), and a print that started refreshes the session,
so the Device area's status summary shows the job. `DeviceModel` hosts it.
Its confirmation (`SendDialogView`, `SendDialog`), shown above whichever area
is open, is the browser's dialog: the printer and its state, the plate, the
file and its size (the exact name once chosen), the filaments, the
tool-mapping blockers and warnings, "Before printing" with unavailable options
disabled and the printer's reason, the exact-name choice in
`printOverwriteLabel`'s words, and "Upload and start print" (disabled, saying
why, while a blocker stands), "Upload only" and "Cancel"; a cancel or a
session that ends withdraws it. Progress and outcomes are the browser's status
lines (each phase, the upload's elapsed time, "Printing … verified on the
printer.", "Uploaded … verified; start it from the printer when ready.", "Send
cancelled; nothing was uploaded.", "Send failed: …"), and the button reads
"Cancel send" while a send runs. Send failures preserve unwrapped exception details
and causes rather than collapsing to an empty string, and log to `OrcaXRSend`.
`MainActivity` maintains `FLAG_KEEP_SCREEN_ON` on the window while foregrounded so
long-running local slicing, large 3MF renders and multi-megabyte G-code uploads over
slower Wi-Fi links are never severed by Android activity backgrounding or process freezing.
During print sends, `PrintSendService` runs as a foreground service (`dataSync`) holding a
`PowerManager.PARTIAL_WAKE_LOCK` and low-latency `WifiLock`, keeping CPU execution and Wi-Fi
transfers alive with a persistent status notification and cancel action so multi-minute uploads
and extended pre-print calibration (such as Snapmaker U1's 169-point bed mesh probing) continue
uninterrupted when the screen is locked, preventing WebSocket drops from cancelling the workflow
and leaving the printer to time out into unhomed idle stepper shutdown (`M84`).
During this preparation phase, both the Android Compose UI (and its ongoing notification) and the
browser DOM workspace run an active elapsed timer ticking each second
(`Preparing the printer with the confirmed options… (Xm YYs elapsed)`), providing continuous visual
confirmation that calibration is actively progressing.
Moonraker's `server.connection.identify` includes `url: "https://orcaxr.org"` per
the Moonraker 1.0+ specification. Bed leveling pre-print preparation automatically
homes the axes (`G28`) before running `BED_MESH_CALIBRATE` so probing succeeds
even when the printer starts with unhomed axes.

The platform-free flow has 9 JVM tests (`SendFlowTest`: the guard, every
status line, sizes, the exact-name label with `toISOString` dates and
`Number` text, the dialog's facts, options and decisions). 26 host checks
(`ProjectDeviceSendChecks`, against a simulator holding one filament) open a
two-tool artifact whose second tool lies past the scanner's first chunk,
replace its file and still store the original byte for byte, cancel an upload
in flight, refuse a second send while one waits for its confirmation,
withdraw a confirmation on cancel, read the confirmation's printer, state,
names, tools, blocker, colour warning and options, refuse a start while the
blocker stands, refuse stale artifacts before and after the operator
confirms, and start a one-tool print with timelapse and levelling chosen,
after which the status is active; the simulator receives exactly the three
uploads, `timelapse:true`, `BED_MESH_CALIBRATE` and one start, with only that
printer's key. `android-send-smoke.py` drives it on the emulator suites
against the simulator and the slicer stand-in: the simulator added and
connected, the hexagon sliced, the confirmation's printer, plate, file, tools
and the blocker for the empty second slot with starting unavailable, an
upload-only send verified, a send held by the printer and cancelled, then —
both filaments loaded — levelling and the exact name chosen and the print
started, the Device area showing it printing, and a model import leaving the
slice out of date with nothing to send; the printer receives the three
uploads, the levelling and one start. The Device area's Files tab reprints a
stored file through the same workflow (`DeviceWorkspace.startStored`, the
browser storage panel's `startStored`): the dialog in its stored-file mode
("Start stored file", "Start print", nothing uploaded), then "Printing
<file>." or "Print cancelled." in the browser's words; the device smoke
reprints the simulator's file and cancels it, and the host checks decline
one (28 checks). Not yet matched: sending every plate.

### Android stale slices

A slice is current by the browser's rule (`StoreProjectSliceSource.isCurrent`,
which `OrcaWorkspace.revalidatePublishedGcode` and the send's `isCurrent` apply
to the published G-code): the project store at the slice's revision and
semantic hash, and the asset bundle at its fingerprint. Android compares the
same three values (`ProjectRevision`) everywhere a slice is judged: the
preflight's state, both routes' captures (the external route's one-plate
archive and the local route's staged job, each from the guard
`ProjectWorkspace.projectPlate` exports under), the publication check of both
routes, Prepare's result card, Preview (`PreviewCurrency`) and Send
(`SendGuard`), each against the state the session last acknowledged
(`ProjectView.revision`), which every edit's completion refreshes.

An emulator probe once read "The project changed after this plate was
sliced; its G-code was withdrawn. Slice again." straight after a fresh slice
of a filled bed, with no step between staging and completion. The project's
state had not moved: on a real session the fill (64 instances, revision 4 to
68), an added instance, a paste, an arrangement, a primitive and an undo each
leave the view reporting exactly what the preflight judges and both captures
stage, through the recovery capture the edit scheduled (run between staging
and completion, five seconds after the fill on the emulator) and concurrent
preflights; the local route publishes, the result compares current, and an
edit after staging still withdraws it (`ProjectStaleSliceChecks`, 91 host JNI
checks). The words were Preview's: `PreviewModel` put its withdrawal notice
in its sticky message, and opening the next slice never cleared it, so after
any edit that withdrew a shown slice, the fresh one opened under the old
notice (the probe read the text while Preview showed the new slice). The
notice is now part of what the viewer shows (`PreviewState.withdrawn`),
published in order with everything else from the viewer's worker, and each
source the viewer reads replaces it — and replaces what it said of the last
source, as the browser clears its preview and status before showing each
new one — so a current slice never shows under it (`PreviewCurrencyTest`, 4
JVM tests: the emulator's sequence, refusal of a slice of a state the
project left, each of the three values withdrawing, opened files, failed
reads and dismissal). `android-local-slice-smoke.py` now checks that the
slice taken after undoing the scaling shows neither in Preview nor in
Prepare as withdrawn; it passes on both emulators.

### Android slice outputs

What a slice produces besides the engine's G-code — the plate's pictures,
every plate's result, and a result fetched again — as the browser produces
it, on both Android routes.

Thumbnails. The browser draws a plate's picture with its own WebGL renderer
(`PlateThumbnailRenderer`) and puts each size its printer's `thumbnails`
value asks for into the G-code's thumbnail block once the engine returns, on
both of its routes (`CanonicalSlicerClientRoute`), so the artifact it hashes,
previews and sends carries them. The uploaded or staged 3MF gets none: its
`Metadata/plate_N.png` are the project's own imported pictures, which the
one-plate projection already keeps. A GPU's pixels are its own (driver,
rasteriser, the canvas's PNG encoder), so no port reproduces the browser's
bytes, and the Filament renderer offscreen would be one more GPU. Android
therefore draws the same plate the same way in the shared core, in software,
deterministically: `orcaxr_archive::thumbnail` renders from the very capture
the plate's archive is written from (`ProjectExportCapture.thumbnails`, inside
`ProjectExportSource.writePlateArchive`, so no surface is needed and the
pictures are of the state the archive is) — every model part of the plate's
printable instances in its filament's colour (`volume_display_color`, else
the workspace's grey), framed by the browser's `frameCamera` (ported exactly
as `slicing::thumbnails::frame`), lit by the viewport's hemisphere and key
lights through three.js's standard material (roughness 0.72, metalness 0.04,
GGX), back faces culled, on transparency, stored as sRGB — and writes a PNG
(zlib) or a baseline JPEG (composited on black, as a canvas does). Its
arithmetic is IEEE and its trigonometry and powers the core's own fdlibm, so
Rust, WASM and JNI write the same bytes (the placement scene's three
pictures, asserted by digest in all three). What the value asks for
(`parseThumbnailList`), the block (`encodeThumbnailBlock`) and where blocks
go (`injectGcodeThumbnails`: after `; HEADER_BLOCK_END` and its blank line,
at the top without one, nowhere in a file that has its own) are the
browser's TypeScript ported to `orcaxr_project::slicing::thumbnails`; Android
streams a G-code once through the core's `Anchor` (`NativeGcode.anchor*`)
and writes it again with the blocks (`GcodeThumbnails.embed`), so a file of
any size is never held. Both routes add them before the status line's
figures are counted and before publication — the external route to the
downloaded artifact, the local one to the engine's claimed and verified
output (`LocalSlicing.withThumbnails`, its length and SHA-256 read again) —
so Prepare, Preview and Send read the bytes published. A picture is what a
display shows, so one that cannot be drawn is none, never a failed slice.

The port found three browser defects, each fixed with a regression test:
slicing every plate drew every file's picture from the active plate's models
(the port took no plate: `canonical-slicer-client-route.test.ts`); only an
object's first part was drawn, a modifier too when first — now every model
part of printable instances (`plateThumbnailMeshes`,
`plate-thumbnail.test.ts`); and three.js writes linear light into a plain
render target, so every PNG held linear values and came out darker than the
model on screen — the target now stores sRGB (`plate-thumbnail.test.ts`).

`slice-output-vectors.mjs` records 68 `thumbnails` values (the bundled
printers', and every `String`/`split`/`trim`/`\d`/`Number` coercion the list
makes), 19 blocks (every row remainder), 100 injections (header markers of
every placement, CRLF, a file with its own, none), 132 cameras and 44 slice
plans (the last four the production controller's journey of a cylinder added
on a second plate, sliced alone and by Slice All Plates), with 26 refusals; Rust replays them all (and every injection streamed
through an `Anchor` in seven chunk sizes), as do WASM in Node and JNI
(`slice-output-replay.mjs`, which also opens the placement scene as a
session and checks its plate's pictures against Rust's digests and its
captured plans against the state-document exchange).

#### The slice sidecar

What the browser binds a slice's output to lives in its coordinator: each
plate's result (`SlicePlateResult` in `CanonicalSliceJobResult`) carries the
job, the project's revision, store and asset-bundle fingerprints, the hash of
the archive the engine read and of the G-code it wrote, the profile snapshot
the plate was sliced with (`CanonicalStateProfileResolver`), the route's
metadata and engine (`CanonicalSlicerClientRoute`), the route's statistics and
the warnings; and `GcodeStatisticsModel` states which identities a statistics
sidecar must carry and how each is spelled (`GcodeStatisticsBinding`). Its
authoritative statistics artifact has no producer (P7.6: the engine does not
export its planner values), so what the browser reads after a slice is the
engine's own totals in the artifact (`GcodeArtifactSummary`).

The shared core computes each part as the browser does
(`orcaxr_project::slicing::sidecar`, through `SliceSidecarExchange.ts`): the
profile snapshot (`profiles`: one SHA-256 over the canonical effective
configuration; a printer, a process and a filament reference per engine slot,
an explicit canonical hash kept and any other hashed over its effective
profile), the binding's rules (`validate_binding`, first refusal first, in the
browser's words) and the route (`orcaxr_printer::slicer::route`: the endpoint
parsed and refused as `normalizedRoute` refuses it, the engine as
`validatedExternalEngine` names it, the ID from the endpoint's origin and
path; this device's engine is `Route::android_native`,
`slicer-client:android-native:<artifactHash>`, the counterpart of the
browser's `browser-wasm`). `SliceTally::summary` reads the engine's totals as
`summarize` reads the whole file while the bytes stream past (the first
colour and material statements kept as their lines pass, up to the metadata
bound; past it the summary is null). `sidecar` assembles the
`orcaxr.slice-output` document (version 1: `binding`, `profiles`, `route`,
`statistics` {`route`, `gcodeBytes`, `summary`}, `warnings`) and refuses it
unless the binding names the profiles' configuration and the route's engine.

Both Android routes publish it as `<file>.json` beside each plate's G-code,
written whole or not at all (`SliceOutputs.writeSidecar`): the job's ID (one
per job, shared by a set's plates), the plate, the state the archive was
written from (`ProjectRevision`), the SHA-256 of the archive the engine read
and of the published bytes (pictures included), the profiles of the capture
the archive was written from (`ProjectPlateArchive.profiles`), and the engine
— the external server's attested build named from its endpoint, or the
packaged engine's commit and its ABI's verified adapter-export manifest
digest (`LocalEngineState.packageSha256`, which names every library and
resource). Output that cannot be bound is not published. Preview and Send
keep refusing stale output by the browser's guard (`PreviewCurrency`,
`SendGuard`, above).

`slice-sidecar-vectors.mjs` records 57 profile snapshots (every plate of the
project model corpus and an unknown one; explicit, legacy, padded and blank
profile hashes and IDs, process IDs of every shape, mixed filaments on and
off), 66 routes (the external slicer corpus's endpoints, engines of every
shape) and 73 bindings (a valid one and each field broken in turn), with 21
malformed requests. Rust, WASM in Node and Chrome and JNI answer all of them
byte for byte (`slice-output-replay.mjs`, which also checks a captured
project's snapshots against the state document's and assembles sidecars on
this device's route); the printer core's package replays the routes
(`printer-wasm-test.mjs`). The tally's summary matches the browser's 101
summary cases in five chunkings in Rust and four over JNI.

Slice All Plates. The browser's `slice_all_plates` ("Slice All Plates", in
its menu) beside Slice and Cancel Slice in Prepare's bar. Its enablement is
the core's capability (`ProjectWorkspace.sliceActions`, with the two host
facts only Prepare knows — a slice running, the active plate's preflight
blocking — the browser's rule being the active plate's models, so an empty
active plate disables it, as in the browser). Which plates — the printable
plates holding a model, by plate order then UTF-16 ID — is the
coordinator's `selectPlateIds` behind the workspace's own refusal ("No
printable plate has models to slice."), ported as
`slicing::plate::slice_plan` (WASM `slice_plan` and
`CapturedProject.slice_plan`, JNI `slicePlan`/`projectSlicePlan`,
`ProjectWorkspace.slicePlan`). Prepare slices each plate in turn on the route
the rule chose (preflight, archive, route, pictures), with the browser's
progress ("Slicing: <step>", the route's percent, else the share of plates
done), keeps every plate's result and publishes the set only while the
project is still the state the plan read — else discards them all in the
browser's words. The status is the browser's (`SLICED n plate(s) in … ms`
and the total in whole KB, its warnings counted once each across plates);
Preview opens the active plate's result, else the first — the one Send to
Printer sends, as the browser's published G-code — and the result card lists
each plate's result and names that plate. Cancel Slice stops the plate in
flight and the job. The browser sent an empty printable plate to the engine,
which failed the whole job; it now passes over it (`slice-pipeline.test.ts`),
and Android follows. The single Slice runs the same path for the active
plate, so its warnings are now the browser's too (the archive's and the
preflight's), and its file's figures include the pictures.

Repeatable download. The browser's client said "The result was retained for
retry" yet never fetched a result again: a dropped transfer failed the
attempt (or re-sliced the whole plate once), though the server keeps a
finished result until its release or expiry and a transfer in progress
holds it. Now a finished job's artifact is fetched again — after a transfer
that failed, or a length or checksum mismatch (the policy's new `retained`
kind) — up to three times, after the poll interval, with the same checks,
and released only once accepted; a refusal (a released or expired result's
410, another job's artifact, an invalid checksum header, text that is not
UTF-8 or is empty) ends it at once (`readDownload`, ported as
`orcaxr_printer::slicer::download`; `external-slicer-jobs.test.ts` drives the
loop). `ExternalSlicerClient` writes each attempt into a fresh
`ExternalSlicerOutput`. The cancellation outcomes stay distinct: a cancel
while a result is fetched again is confirmed against a done job ("already
done"), never reported as cancelled.

Verified: `ProjectOutputChecks` (585 host JNI checks: the corpus through the
Kotlin owners, every injection streamed from a file, the placement scene's
pictures with Rust's bytes, and the Prepare journey on the default profile —
Slice All Plates enabled as the browser enables it, two plates with a model
and an empty one passed over, each plate's archive carrying its own two
pictures at the U1's 48 × 48 and 300 × 300, the G-code carrying them after its
header, a file with its own left alone, the local route's job publishing them,
an unprintable plate left out, each plate's archive mesh — the cube's
and the cylinder's added on the second plate — one closed surface, and the
local route's sidecar binding the published bytes, the archive, the state and
the plate's own profiles); `ProjectSliceSidecarChecks` (809 host JNI checks:
the sidecar corpus through the exchanges and the typed owners, this device's
route, sidecars bound and refused, and the summary corpus streamed through
the tally); the external slicer's client against the real
server cutting one download off halfway and corrupting another (35 checks,
the server recording two downloads and the release); the external slicer
policy's 102 download cases in Rust, WASM, JNI and Kotlin (1,098 Kotlin
checks); `SliceAllTest` (6 JVM tests); `SliceOutputsTest` (6 JVM tests: the
sidecar's place and atomic write, the job ID, the packaged engine's identity,
hashing as written and as read, the binding's canonical JSON); Rust tests
(`slice_outputs`, `slice_sidecar`, `artifact_summary`, `thumbnail`,
`slicer`); web tests. `android-outputs-smoke.py` (in
`emulator-smoke.py` before the accessibility smoke) drives Slice All Plates
on the device's engine with a cube on Plate 1 and a cylinder on Plate 2,
Preview on Plate 1, both results listed, both published files read back with
their two pictures right after the engine's header (PNGs of a model on
transparency, each plate its own), then on the external slicer a download cut
off and fetched again (the server's record) with the pictures at the top of a
file without a header, and Slice All Plates there; beside every published
file it reads the sidecar and checks it binds that file's SHA-256 and length,
its plate, one job per set, the profiles' configuration and the engine — the
APK's engine manifest commit and ABI package digest locally, the attested
stand-in build on the external slicer; it passes on both emulators. The
send smoke now reads the published file's size from the device, since the
file carries the plate's pictures.

### Android exports

The browser's File menu writes files the operator keeps: the sliced G-code
(Download, Export G-code…, Download All Plates, Export All Plates…), the
models (Export as one STL…, Export all objects as STLs…), the plated 3MF,
the configuration and the toolpaths as OBJ. Android writes each one as the
same bytes the browser downloads for the same project.

The browser's compressor. Every ZIP the browser writes comes from
`writeDeterministicZip`, which hands its members to fflate 0.8.3's
`zipSync`. The native writer (`orcaxr_archive::write`, [§](#shared-archive-container-and-canonical-staging))
writes equivalent archives whose compressed bytes differ (its DEFLATE is
flate2's), which is enough for a project the browser reopens but not for a
file that must be the browser's. `orcaxr_archive::fflate` ports fflate's
`deflateSync` and `zipSync` exactly as the writer calls them: the LZ77 hash
chains and the "rarest pair" match search, the hash width
`ceil(1.5 · clamp(ln n, 8, 13))` bits, blocks ending at 7,000 matches or
24,576 symbols unless fewer than 424 bytes remain, UZIP.js's two-queue
Huffman merge and length-limiting debt walk, a stored block whenever it is no
longer than either coding, and fflate's headers (the UTF-8 flag only for a
non-ASCII name, Unix 0644, 1980-01-01, no extra fields), members in the
browser's order (UTF-16, with array-index names first, as a JavaScript object
enumerates its keys). The port first read `Math.ceil(clamp) * 1.5` for the
width; the corpus caught it at 442,413 bytes, where the two differ.
`browser-zip-vectors.mjs` records 238 deflate streams (random, low-entropy,
run, periodic and G-code-like inputs at every hash-width step e^(2p/3),
around the stored-block, window and block-size boundaries, every level) and 8
archives (array-index names, stored suffixes in any case, non-ASCII names,
`__proto__`, empty members) by SHA-256 and length; Rust writes them all byte
for byte (`tests/fflate.rs`).

Model exports. The browser kept the STL actions' choices in its workspace;
they are production functions of `stlExport.ts` now, which the workspace and
the controller call: Export as one STL… takes the selected instances on the
active plate, else every instance on it (`stlExportInstanceIds`), merged into
one binary STL (`exportCanonicalStlFile`, offered under
`suggestedStlFilename` of the lone instance's, its object's or the project's
name); Export all objects as STLs… writes one STL per instance into the
browser's ZIP, its members named after the instances (each run outside
`a–z A–Z 0–9 _ -` one `_`, none at either end, a repeat numbered from 2
without regard to case) and a lone instance as its own STL
(`exportCanonicalStlArchive`). `outputNames.ts` holds the names the other
outputs are offered under (`orcaxr.gcode`, `<plate>.gcode`,
`<plate>_toolpaths.obj`, `orcaxr_config.json`), and the serializer's
`suggestedProjectFilename` the 3MF's. `orcaxr_archive::exports` ports them:
each vertex through its part's and its instance's transforms in binary64
(V8's `Math.hypot`, the quaternion normalized as `rotateVector` does) and
stored as binary32, the winding reversed under an odd number of mirrors,
modifiers and support volumes left out, a negative volume refused, every
refusal in the browser's words and before the first byte, the merged file
streamed and the archive written through the fflate port. Names are UTF-16:
a lone surrogate passes through NFKC (ICU4X's, Unicode 17; the browser's is
its runtime's ICU, and they agree on every character both encode), and the
120-unit limit may split a pair, as `slice` does. Hosts reach them through
`modelExportExchange.ts` — on an export capture `stl_export` (WASM
`ProjectExport.stl_export`, the reply and the file; JNI `exportStl`, the file
streamed through a `ProjectJsonSink` in chunks of at most 64 KiB) and
`export_name` — read by Kotlin `ModelExports`
(`ProjectExportCapture.writeStl`, `ProjectExportSource.writeStl`,
`ProjectDocuments.writeStl`, which opens the destination on the first byte,
so a refusal never touches it).

Export as 3MF…. The browser's is its Save: `exportPlate3mf` runs the
persistence controller's manual save, the serializer's package under
`suggestedProjectFilename` (the fallback without persistence names it
`-export.3mf`; production never takes it). The core's package members were
already the serializer's byte for byte ([§](#shared-archive-container-and-canonical-staging));
`package::write_browser` writes them through the fflate port instead of the
native writer, each member produced whole and compressed as it comes, so the
file is the browser's Save of the same state byte for byte, and a project
the serializer refuses (a character XML cannot carry, plates without a bed)
is refused before the first byte. The package writer is compiled once for
every caller (concrete asset lists, cancellation and destinations as trait
objects): its two instantiations had cost the project set 536 KB.
`exports::project_archive_json` replies `{"filename","mediaType","warnings"}`
or `{"refused":<code>}` (the core's save code; the browser's words are its
serializer's exception text, not ported); WASM `ProjectExport.project_archive_export`,
JNI `exportProjectArchive` (streamed), Kotlin `ProjectExportCapture.writeProjectArchive`,
`ProjectDocuments.writeProjectArchive` and `ProjectWorkspace.export3mf`.

`model-export-vectors.mjs` records 120 STL exports (85 files, 35 refused:
a negative volume, an empty plate, a repeated selection) over six states
built from the production controller's cube, cylinder and sphere and posed
(unnormalized rotations, mirrors, non-uniform scale, parts with their own
transforms, modifiers, support volumes; names empty, repeated in other
cases, with controls, reserved characters, compatibility forms, emoji, lone
surrogates and more than 120 units; selections empty, partial, reordered, on
another plate, unknown and repeated), 12 Export as 3MF… cases over those
states and the volume-role corpus's (painted parts on every channel, local
filaments, every role; 8 packages, 4 refused: a control character and lone
surrogates XML cannot carry, two plates without a bed), 78 names and 12
malformed requests.
Rust (`tests/model_exports.rs`), WASM in Node and in a Chrome 150 worker, and
JNI (`model-export-replay.mjs`: each state opened as a session, every export
through an export capture) answer all of them byte for byte.
`ProjectModelExportChecks` (493 host JNI checks) reads every reply and name
through the Kotlin owners, writes every export through `writeStl` and
`writeProjectArchive`, and on a `ProjectWorkspace` opens the posed state
(saved by the core as a 3MF) and exports it as the browser's 3MF of that
very state, as one STL and as an archive with nothing, one and another
instance selected — each the browser's file — without touching the history,
then finds a negative volume refused in the browser's words without the
destination opening, a destination that cannot open failing the export,
an empty plate refused (an empty project still exports as a 3MF, as the
browser saves one), and an imported cube exported as `cube.stl`.

Export Config…. The browser writes the active catalog profile
(`OrcaWorkspace.profile`, none while an opened project slices with its own
configuration: "No active profile to export.") as
`exportProfileConfigJson` in `ConfigIO.ts` — `JSON.stringify({orcaxr_config:
1, machineName, processName, filamentName, config}, null, 2)`, the names the
profile's own (`getProfileOptions` read them from it; the workspace now
calls the shared function). The bytes hang on `config`'s key order:
`{...machine, ...process, ...filament}` of the three presets' flattened
configurations, each `{...parentEffective, ...raw}` in the order its
catalog JSON object lists its keys (a repeated key keeps its first place and
its last value; array-index keys first, as JavaScript enumerates them). The
compiled catalog keeps configurations as sorted maps, so the order is
recovered from the catalog's own JSON: `JsonInput::record_orders` makes the
streaming parser note the property order of every object in a vendor's
`machine`/`process`/`filament` list as it parses (no second parse, nothing
recorded for other callers), `settings::config_export::KeyOrders` keys them
by vendor, kind and name (the first of two equal names, as the preset graph
keeps), and `config_json` walks each preset's parents for the effective
order, keeps the keys the flattened part holds and writes the values with the
browser's `JSON.stringify` quoting. `HostCatalog::config_json(i)` is profile
`i`'s file; WASM `ProfileCatalog.config_export`, JNI `catalogConfigExport`,
Kotlin `ProfileCatalog.configExport`. `config-export-vectors.mjs` records
every one of the 1,482 bundled profiles' files (SHA-256 and length; 18 MB of
JSON otherwise) and 9 profiles of two synthetic catalogs written whole
(repeated keys, a child's and a later preset's keys after the ones they
share, quotes, controls, line breaks, non-ASCII, emoji, an escaped lone
surrogate, numbers, booleans, arrays and nulls, an empty-config profile);
Rust (`tests/config_export.rs`), WASM in Node and in a Chrome worker and JNI
(`config-export-replay.mjs`, each catalog streamed and built from the same
text, every file found by profile ID) write all 1,491 byte for byte, and
`ProjectCatalogChecks` reads profile 0's through Kotlin (and the same file
from a catalog built with a reversed collator).

Export Toolpaths as OBJ…. The browser writes the published G-code's
extrusions (`exportToolpathsAsObj`, offered once the slice is the project's;
"Slice the plate before exporting toolpaths." otherwise) as
`exportToolpathsToObj` in `GcodeToolpath.ts`: the G-code parsed with no
options, its path sidecar checked, a header line, every extrusion record's
segments as two `v` lines each (a direct move unless it starts where it ends,
`===` on the coordinates; an arc's every interpolation edge and its final
edge, even an empty one), each coordinate `toFixed(4)` of its binary32
column, then one `l` line per segment, joined by `\n` with none after the
last, named `<active plate>_toolpaths.obj` (`model/obj`).
`orcaxr_gcode::toolpath_obj` writes the same file as a stream (the `l` lines
only count; `toFixed` is ryu-js's, ties away from zero, signed zeros kept,
`String(x)` from 1e21) over the parser's own model — the parse the browser
makes, whatever a session's own options (`Session::toolpath_obj` parses the
sealed source again with none). WASM `GcodeSession.toolpathObj` (the
computation set, the file whole), JNI `NativeGcode.toolpathObj` (streamed
through a `ProjectJsonSink` in chunks of at most 64 KiB, stopping when its
session closes) and Kotlin `ToolpathObj.write` (a session of its own over
the file's bytes, decoded as the browser decodes a file; a destination's own
failure rethrown as thrown). `toolpath-obj-vectors.mjs` records 39 cases
(26,012 segments): direct and arc extrusions (I/J and R arcs, full circles,
relative and inch modes, G92 resets), travel, retraction and wipe moves,
moves that go nowhere, coordinates whose `toFixed(4)` ties, rounds to a
signed zero or passes 1e21, a byte-order mark and CRLF, roles and tool
changes, the parity fixtures, 24 seeded random paths and a long one (whole up
to 16 KiB, else by SHA-256 and length). Rust (`tests/toolpath_obj.rs`, also
through a session whose limits would truncate its windows), WASM in Node and
in a Chrome worker (`toolpath-obj-replay.mjs`, in `wasm-smoke.mjs`) and JNI
(`ToolpathObjChecks`, 81 host checks: every case from its text and from its
bytes, a failing destination, a session closed mid-stream, an unsealed one)
write all of them byte for byte. The browser's validation of the parser's
own output, which no G-code fails, is the core's `invalid-model` code; past
the parser's 256 Mi-unit input the core refuses (`resource_limit`) where
the browser would export the truncated parse, and the browser's own failure
past V8's longest string has no Android counterpart.

Export Diagnostics…. The browser's shell gathers facts (its version, the
pinned engine commit and its route, the browser's user agent, language and
cores, the printer's state, the catalogue's action counts, the project's
shape from `diagnosticsProjectSummaryOf`, the recorder's events), builds the
bundle (`buildDiagnosticsBundle`: the newest 200 events, object names only
when asked, the first 64 each redacted and cut to 120 units, what was left
out; then `redactMoonrakerDiagnostic` over the whole of it, which redacts
every string again and cuts every array to its first 32 items — so a bundle
keeps at most 32 events, the oldest of the newest 200), shows its privacy
preview (`describeDiagnosticsBundle` in the browser's confirmation) and
writes `JSON.stringify(bundle, null, 2)` and a line break as
`orcaxr-diagnostics.json`. Its recorder keeps each event's scope to 64 units
and its message struck of the session's secrets (of at least 8 units) and
the pattern rules. These are production functions now (`diagnosticEntry`,
`diagnosticSecrets`, `diagnosticsProjectSummaryOf`, `diagnosticsCapabilities`)
behind `diagnosticsExchange.ts`, which reads a request's objects in the
input interface's order and only the keys it declares. `orcaxr_printer::diagnostics`
ports the bundle (`bundle_json`: the file, the preview and the kept events),
the event (`entry_json`) and the facts the core itself knows (`facts_json`:
the catalogue's 226 actions, 7 unavailable, and the pinned engine commit);
`orcaxr_archive::exports::diagnostics_summary_json` the project's shape of
an export capture. Hosts: WASM `diagnostics_bundle`, `diagnostic_entry`,
`diagnostics_facts` and `ProjectExport.diagnostics_summary` (project set),
JNI `diagnosticsBundle`, `diagnosticEntry`, `diagnosticsFacts` and
`exportDiagnosticsSummary`, Kotlin `Diagnostics` and
`ProjectWorkspace.diagnosticsSummary`. `diagnostics-vectors.mjs` records 12
bundles (the browser shell's facts with and without names, a minimal one,
every optional section, more than 200 events, 32 printer capabilities and
64 names, names past 120 units, numbers in exponent form, URLs, credential
assignments, controls and lone surrogates everywhere, and three of an
Android host's facts), 15 malformed bundle requests, 11 events (secrets
short and long, overlapping, at the 512-unit cut) and 7 malformed ones, and
the facts; `model-export-vectors.mjs` the shape of each of its 12 states.
Rust (`tests/diagnostics.rs`, `tests/model_exports.rs`), WASM in Node and
in a Chrome worker (`diagnostics-replay.mjs`, `model-export-replay.mjs`)
and JNI answer all of them byte for byte; `DiagnosticsChecks` (13 host
checks) writes every event a host records and every Android bundle through
`Diagnostics.Input`, and `ProjectModelExportChecks` reads the workspace's
shape. The Android recorder also strikes the tokens this device holds as
secrets.

Every redaction — the transport's diagnostics, the printer console's lines
and the diagnostics bundle — shares one pattern for credentials written out
as text (`CREDENTIAL_TEXT` in `SessionCredentials.ts`, `redact_assignments`
in `orcaxr_printer::moonraker`): a named assignment (`api_key=…`,
`bearer: …`, `x-api-key`, `access_token`), an HTTP Authorization header with
or without its scheme (`Authorization: Bearer …`, `authorization=Basic …`),
and a bare `Bearer <token>`. The pattern once struck only the assignments,
so a header a server echoed back kept its token; the policy corpus's
refused bodies carry each form (192 error answers), the browser's transport
test and the Rust `credential_text_is_struck_without_its_secret` check the
cases directly, and a word the pattern reads as a token (`the bearer token
was refused`) is struck too, which costs a diagnostic a word and never a
secret.

On Android the exports are the browser's File menu entries and its Download
actions: the Project area's Export menu (beside Share) lists Export G-code…,
Export All Plates…, Export as one STL…, Export all objects as STLs…, Export
as 3MF…, Export Config…, Export Toolpaths as OBJ…, Export Diagnostics…
and Download All Plates; Prepare's result card offers Download beside Preview and
Send to Printer, and Download All Plates under every plate's result; the
command palette lists all ten. Each is enabled as the browser's registry
gate judges it — the core's capability rules read with the Prepare area's
facts (`ProjectWorkspace.sliceActions` now takes the published slice's
`gcodeReady` and reads the output actions too) — and not while another
export is being written ("Another export is being written; wait for it to
finish."). `ExportModel` carries them out wherever they are chosen and
`ExportHost`, at the shell's root, meets the system: what is written is
fixed when the action is chosen, as the browser's download is — an STL is
written by the core, after every queued edit settles, into a private staging
file before the picker is asked for a place (a refusal asks for none and says
"STL export failed: …" or "STL export failed."), as is the 3MF ("Export 3MF
failed: …" with the core's reason) and the configuration (the profile the
project worker holds once every choice asked before has applied,
`SlicingProfiles.configExport`, found among the catalog's profiles by its
three presets; "No active profile to export." while an opened project slices
with its own) and the toolpaths (`ToolpathObj.write` over the published
G-code, still the project's when chosen, named after the active plate;
"Export OBJ failed: …" with the core's reason) and the diagnostics bundle
(this device's facts in the browser's shape: the app's version, the core's
engine commit and catalogue, the route Prepare slices on — `external-server`
or `android-native` — the platform's release, API level, language and cores
as the `browser` part, never the device's model or build, the printer's
state, the project's shape and `DiagnosticsLog`'s events: failures at the
Project area's and the exports' boundaries, redacted as recorded with the
external slicer's token and the printer's key struck; shown in the browser's
confirmation words before any place is asked for, and "Diagnostics export
cancelled; nothing was written." when declined), the G-code is the published
file, whose currency is checked again once a place is picked. The picker
creates the document under the browser's name with the type the device
associates with its extension (else `application/octet-stream`): a provider
keeps an extension only for its own type, and otherwise writes
`orcaxr.gcode.txt` or numbers a copy `orcaxr.gcode (1)`; so the file keeps
the browser's name and a copy is numbered `orcaxr (1).gcode`, as a browser
numbers a download. Download All Plates writes `<plate>.gcode` for each
plate of the last Slice All Plates into a folder the operator picks (the
browser downloads one file per plate); Export All Plates… slices every plate
first when their results are not the project's (the Prepare area runs the
Slice All Plates, with its consent and progress; the export goes on once
`PrepareModel.ended` moves, or stops when the slice did not publish). Copies
run on one worker; a provider failure is said in words ("There is no room
left for …", "OrcaXR can no longer write to …") and the half-written document
is removed. Outcomes are the browser's status words in the shell's snackbar
("Saved orcaxr.gcode.", "Downloaded 2 plate G-code file(s).", "Exported 1
model as 12 STL triangles.", "Plated geometry exported as 3MF.", "Exported
config.", "Sliced toolpaths exported as OBJ.", "Exported 3 log entries. No
project, addresses, or tokens are in the file."), the
catalogued ones in the operator's language. One deviation: the browser's
Export as 3MF… is its Save, so it also marks the project saved; on Android a
project's document is its own (Save writes it, Save as rebinds it), so the
export is a copy and the project's saved state is untouched, as Share's.

`ExportCommandsTest` (4 JVM tests: the ten and where they run, the gate
and the one-at-a-time rule, the browser's words, the providers' failures and
the document type), `AppActionsTest` (75 performed actions with their
glyphs, words and hints). `android-exports-smoke.py` (in `emulator-smoke.py` after
the outputs smoke) drives them through the system's picker on the engine-less
APK and reads every file back: `cube.stl` (the browser's header, 12 facets,
unit normals, the 20 mm cube on the bed), `Untitled_project_stls.zip` with
`cube_stl.stl` and `cube_stl_2.stl` — byte for byte the archive the browser's
own `writeDeterministicZip` writes from those members — `Untitled
project.3mf`, which the browser, reopening and saving it again, writes byte
for byte the same, the project still unsaved, `orcaxr_config.json` — the
browser's file of the chosen bundled profile byte for byte (its SHA-256 and
length among the corpus's, the profile the one its names give) — the
diagnostics preview declined (nothing written) and agreed:
`orcaxr-diagnostics.json` as the browser's `JSON.stringify` writes it, the
preview the browser's `describeDiagnosticsBundle` of that very file, the
project's shape without names and no address or token — a negative
part refused with no picker, then on the external slicer stand-in Download and the
palette's Export G-code… (`orcaxr.gcode`, `orcaxr (1).gcode`, each the
published file byte for byte), `Plate_1_toolpaths.obj` (byte for byte the
OBJ the browser's own `exportToolpathsToObj` writes from that G-code),
Download All Plates refused before a Slice All
Plates, and Export All Plates… slicing both plates and writing `Plate_1.gcode`
and `Plate_2.gcode` into a picked folder, each its plate's published file; an
edit withdraws them (neither Export G-code… nor Export Toolpaths as OBJ… is
offered). It passes on the iteration emulator (API 34, x86_64);
the two suites have not run it.

### Android Device area

The app's Device area is the first product area on Android, built only from
complete shared workflows. `DeviceWorkspace` (core-bridge, host-testable)
holds what the browser shell's printer flows do: the shared directory stored
as the browser stores it (a private preferences file, no secret in it), each
printer's API key its own in the `CredentialVault` (kept in memory for the
run while remembering is off, removed with its printer), the active printer
switched by clearing the session so nothing crosses from the printer before,
the active printer selected as soon as it is chosen (so its recovery
commands, which need neither a status reading nor the socket, are reachable
before and without a connection),
a `PrinterSessionClient` connecting with the active printer's key, the
status summary the browser renders, and the local-network permission judged
before any exchange. `DeviceModel` is its host adapter: a ViewModel running
every call that may block (storage, the Keystore, name resolution, the
session) on one worker thread and publishing a `DeviceState` projection to
Compose on the main thread — Compose holds projections and drafts, never a
second directory. `DeviceScreen` lists printers (the active one chosen by a
radio row), adds them (name, address, port), takes the active printer's key
with a remember switch and a forget action, asks for local-network access
when the active printer needs it (and, once refused for good, opens the
app's settings; the permission is read again on every resume), connects and
disconnects, shows the connection, the status headline, detail, progress and
facts, and offers every job command with the reason one is not available,
confirming a destructive one in a dialog the core asks for.

`ProjectDeviceWorkspaceChecks` (30 host checks against the simulator) offers
recovery and sends a firmware restart before any connection, adds, refuses,
switches and removes printers, keeps keys with their printers across
reloads, honours the remember switch and forgetting, reads an idle printer's
status, pauses a job another client started once the session identifies it,
cancels it through the dialog, and refuses a printer behind a denied
local-network permission promptly until it is granted; the simulator receives
only that printer's key. `android-device-smoke.py` drives the real app on an
owned emulator against the simulator on the host (10.0.2.2): add the
simulator, save its key, connect and read "Idle", restart with printer and
key remembered, reconnect, pause, resume and — confirmed — cancel a job
started elsewhere, disconnect and remove the printer; the printer receives
exactly `start, pause, resume, cancel`, every request with that key.

`PrinterExchanges` (core-bridge) carries out the shared storage, history,
console and camera operations over the session's client: the policy plans
each one, finishes it and reads its reply, and the class only performs the
exchange the plan names — a request or download through the client with the
credential, or a camera's own URL fetched directly without it (no redirect,
plain HTTP only to the local network, the local-network permission first, a
frame read whole up to 16 MiB and never past it). 20 host checks against the
simulator list, read, download byte for byte, rename and delete files and
refuse a traversal before anything is sent, page history and read totals,
send a script and refuse an empty one, read macros with their parameters,
list cameras against the endpoint and fetch a frame both through Moonraker
and directly; the simulator receives the script, no traversal, and only
that client's key.

Once connected, the Device area offers Status, Files, History, Console and
Camera tabs over `PrinterExchanges`. Files browses the printer's folders,
reads a file's metadata and prints or deletes it once confirmed. History
pages the printer's records with the browser's job descriptions, pager and
totals line. Console sends scripts after the shared assessment (anything not
report-only is confirmed first, with its reasons), keeps a bounded
transcript of the socket's `notify_gcode_response` lines redacted on the way
in, and runs macros with their parameters spelled by the shared invocation.
Camera lists the printer's cameras and polls frames only while the tab is
shown and the app is in front, at the camera's bounded rate, rotated and
flipped as mounted, trying its routes in order — an app has no page that
loads an image itself, so the browser's image route is a direct fetch — and
moving to the next when one fails; bytes that do not decode as an image
fail the route, as a browser's image would (the smoke found a web server
answering a missing snapshot with a 200 HTML page). The emulator smoke now
also deletes the job's file, reads three history records, sends `M105`
(its answer arriving over the socket), a confirmed `G28` and
`LOAD_FILAMENT TEMP=220`, and shows a camera frame fetched through Moonraker
after its web-origin URL fails. It also found that closing a subscription
after its client had closed threw; `MoonrakerClient` and
`PrinterSessionClient` subscriptions now close as a no-op then, and a client
check closes two after the client.

That run found a defect the host checks could not: `MoonrakerClient`
reused pooled HTTP connections with retries off, so the first request after
any idle gap longer than the server's keep-alive (the simulator's Node server
closes idle connections after 5 s, nginx after 75 s) failed on a connection
the server had closed — the job identity query, then every reconnect. Its
pool now lets an idle connection go after 2 s, and a client check idles past
the server's keep-alive before its next request. Retrying instead could
repeat a print start the printer had already received.

Discovery proposes and never saves. `PrinterDiscovery` (core-bridge,
host-testable) runs one generation at a time: a candidate is probed once per
run (by host and port), at most 32 per run, and a probe's answer for an
earlier run, or for a run that was stopped, is dropped when it arrives — so a
late probe can neither propose into a newer search nor touch anything the
operator chose meanwhile. `MoonrakerProbe` verifies a candidate by the
Moonraker handshake a connection makes, with no credential (a key is never
sent to a machine the operator has not added), each request and the socket's
opening bounded at 5 s, the local-network permission and cleartext policy
applied as for a connection. Only a machine that completes the handshake, or
answers that it needs a key, is proposed; a web page, a closed port or an
unusable version is not. `DeviceWorkspace.addDiscovered` saves a proposal as
any typed-in printer (under the hostname the printer gives itself, else its
advertised name), and `savedAs` recognises a proposal already saved under
another spelling of its address. `AndroidPrinterDiscovery` feeds a run from
the platform's DNS-SD browse across `_moonraker._tcp`, `_snapmaker._tcp` and `_octoprint._tcp`
(mapping Snapmaker MQTT port 1884 to Moonraker port 7125) for 15 s — Android 14+ resolving each service
with a `ServiceInfoCallback`, earlier releases one `resolveService` at a
time — alongside direct UDP broadcast DNS-SD PTR queries (`DirectDnsParser`) with a Wi-Fi `MulticastLock`
to ensure rapid response and tolerate platform mDNS daemon parser crashes on malformed NSEC records or packet size limits;
preferring an IPv4 address and never a link-local IPv6 one; no
address range is ever scanned. On Android 17 the Device screen asks for the
local-network permission before it searches (the system picker of
`DiscoveryRequest` is not used: verifying and connecting need the permission
anyway). The screen's "Find printers" lists each proposal with whether it
asks for a key and offers "Add", or names the saved printer at that machine.

`ProjectPrinterDiscoveryChecks` (27 host checks) probes an open simulator
(verified, named `orcaxr-simulator`), one requiring a key (proposed as
needing one; it receives no key until the operator enters it, then connects),
a web server and a closed port (neither proposed), a printer behind a denied
local-network permission (refused promptly, then probed once granted), and
drives runs with probes under the test's control: duplicates, an earlier
run's and a stopped run's answers, the 32-candidate bound, and a probe that
completes after the operator added another printer leaving the stored
directory untouched. `AndroidPrinterDiscoveryTest` (instrumented) advertises
`_moonraker._tcp` on the emulator and finds it offered at its port and an
IPv4 address; it caught the platform delivering callbacks after the finder
closed into its shut-down executor, which crashed the process — they are now
dropped. The emulator smoke ends by searching: a helper in the core's test
APK (`MoonrakerAdvertiser`, skipped without its arguments) advertises the
service on a port forwarded to the simulator, and the app finds it, shows it
verified, adds it, connects through the advertised port and removes it.

### Android adaptive shell, keyboard and file drop

The shell arranges the areas by the window's width (`LocalWindowInfo`'s
container size; no window-size-class dependency, none being in the offline,
verified Gradle cache): `ShellLayout` (platform-free) takes Material's classes
— a bottom bar below 600 dp, a navigation rail from 600 dp — and from 840 dp
shows the area's panel at the start beside a viewport, as the browser's flat
shell docks its parameter sidebar at the inline start of the 3D viewport
(`web/index.html`, `WorkspaceViews`): the Workspace beside Prepare and beside
Project (whose object tree is the browser sidebar's Objects card), the
toolpath view beside Preview's controls; the Workspace area is the viewport
itself and Device fills the work area, as the browser's Device page. The
panel is the sidebar's 356 dp, 312 dp in windows up to 1180 dp. Areas beside
the Workspace share one arrangement, so moving between them keeps its view.

Every control is reached with Tab and Shift+Tab and operated with Enter or
Space (Compose's clickables answer both); a dialog is a window of its own,
where the focus stays and wraps, and closing it gives the focus back.
`FocusVisibleTheme` raises the focused state layer to 24% (Material 3 draws
10%, which a keyboard user barely sees; the browser outlines `:focus-visible`)
for every ripple, the default indication included; the Preview sliders, on
which Material draws no focus, get `focusRing`. The multi-line Console field
passes Tab on (`tabMovesFocus`) instead of typing a tab, as a browser
textarea does; single-line and read-only fields already do.

Files dropped on the window (desktop windowing, ChromeOS, Samsung DeX) or opened/shared
from other applications (`ACTION_VIEW`, `ACTION_SEND` from Files by Google, Chrome downloads, cloud storage, messengers)
load as the browser's drop does (`intakeFiles`): `DropIntake` (platform-free)
decides each by its name — the extensions of the pinned dialogs, or for an
extension the browser does not know the type the provider reports, where the
browser would read the content — and plans the intake in order. The Android manifest
declares `ACTION_VIEW` and `ACTION_SEND` intent filters covering specific MIME types for 3MF (`model/3mf`, `application/vnd.ms-package.3dmanufacturing-3dmodel+xml`, `application/3mf`, `application/x-3mf`),
STL (`model/stl`, `application/sla`, `application/vnd.ms-pki.stl`, `application/x-stl`),
OBJ (`model/obj`, `model/wavefront-obj`), AMF (`model/amf`, `application/x-amf`), and G-code (`text/x-gcode`, `text/gcode`, `application/x-gcode`),
generic binary streams (`application/octet-stream`) to match files indexed by Android MediaStore/DownloadManager where extensions are unmapped in the OS MIME table,
and explicit extension filters (`.3mf`, `.stl`, `.obj`, `.amf`, `.gcode`, `.gco`, `.g`, `.nc`) with both `*/*` and untyped URIs, all marked `CATEGORY_BROWSABLE`.
Models (STL, OBJ, AMF, ZIP) import through the Project area's preview and 3MF projects
open through its Open, guarded for unsaved changes and refused as any
handed-over document when not `content:`; `ProjectModel.intake` takes them
one at a time, the next once nothing runs and no question waits (a project
another window holds brings it forward). A dropped or picked 3MF when
models already exist presents the browser's decision dialog (`ThreeMfIntakeDialog`,
`project_intake_*` resources): Open as project vs Import geometry only,
the latter staging through `orcaxr-archive`'s `models::geometry_merge`
(`prepare_geometry`), remapping stable IDs, deduplicating meshes, centering
on the bed and previewing through `prepareGeometryImport` before an undoable commit.
G-code opens in Preview (the last one dropped). The rest is
refused in the browser's words ("Failed to load x: x is not a recognised
model format", the STEP and SVG reasons) on a snackbar; the drop's prompt
is the browser's. The activity requests the drag's permissions, which last
as long as the window; a dropped document is untrusted input and joins no
recent list. 14 JVM tests (`ShellLayoutTest`, `DropIntakeTest`) cover the
layouts and the drop's decisions and words; `android-adaptive-smoke.py`
(last in `emulator-smoke.py`) checks the bar, Tab traversal and wrap,
Shift+Tab, Space and Enter, the focused button's pixels, a dialog keeping
and returning the focus and Escape, then resizes the display (`wm density`,
`wm size`, always restored) for the medium rail and the expanded panels and
crosses them with Tab. adb cannot drive a drag and drop. The smoke passes on
both emulators. The command palette, the toolbar, the context menus, hover,
trackpad and stylus input follow ([below](#android-command-palette-toolbar-and-context-menus)).
The browser's 3D view takes no keys of its own (its OrbitControls listen to
none): its keyboard reaches the scene through the catalogue's shortcuts, which
the app takes too, G, R and S choosing the gizmo's Move, Rotate and Scale
([Android transform gizmo](#android-transform-gizmo)).

### Android command palette, toolbar and context menus

The app reaches the catalogue's actions as the browser's flat shell does —
its command palette, its model toolbar and menu strip, its scene and Objects
context menus — and every one of them runs the call the menus make
(`ProjectModel.perform`), through the shell's runner, which first shows the
area the action needs: the Project area for New, Open, Save, Save As and
Import Model (its pickers and dialogs carry them out, from a
`documentRequest`), the Workspace for a camera view or a tool that takes its
touch, the Prepare area for Slice, Slice All Plates, Cancel Slice and Send
to Printer (which it carries out as its buttons do, below). What the app
performs is one list (`AppActions.PERFORMED`, 61 actions: the document
actions, Undo and Redo, the View menu's seven camera views, the Edit, Add
and placement menus, the model tools, the plates, the toolbar's Delete and
paint channels, and Prepare's four); nothing else is ever listed.
Their words are the browser's labels and hints (`action.<id>.label` and
`.hint`, `ActionTexts`, mapped in `contracts/android-strings.json`), their
symbols the browser's Material symbols and their menu shortcuts its menus'
(`OrcaActionGlyphs`: `android-tokens.mjs` writes each action's
`icon(a.icon).xr` symbol as a vector drawable, `ic_symbol_*`, and DomShell's
`shortcutHint` — Ctrl+Z, Ctrl+⇧+Z, Delete, Escape — for the actions the app
shows; `AppActionsTest` holds the app's list to the generated one).

The palette is `CommandPalette.ts`: Ctrl/⌘ K from anywhere, a text field
too, as the browser's `window` listener takes it (`MainActivity.windowKey`:
the content's root previews every key before the focused control, and
`onKeyDown` takes it when nothing is focused), the Workspace's search button (the browser's `#cmd-search-btn`:
the search symbol, "Search actions & settings" on windows wider than its
1180 px, ⌘K, its title as the tooltip) and the Project area's. It lists the
core's `command-palette` surface in catalogue order with its enablement
(`ProjectWorkspace.surfaceActions`, paged on the authority with the shell's
host facts, hidden actions left out, read again as the project, the
selection or the enablement change) limited to what the app performs; the
search is the browser's, through the shared core ([action presentation](#action-presentation)):
label, id or hint (in the app's language) containing the trimmed query, case
ignored. A row shows the symbol, the label and the hint — or the core's
reason when it is disabled, dimmed. ArrowDown/ArrowUp move the highlight, a
new search starts at the first row, the mouse highlights the row it rests
on; Enter or a click runs it and closes the palette, while one the core does
not enable leaves it open with the browser's status ("label: reason");
Escape, Ctrl/⌘ K, Back or a press outside close it — Escape and Ctrl/⌘ K
before an on-screen keyboard sees them (`onPreInterceptKeyBeforeSoftKeyboard`:
the keyboard took Escape to hide itself and the palette stayed open), and
opened from the keys the palette brings up no on-screen keyboard
(`showKeyboardOnFocus`); "No matching actions" when nothing matches. The
placeholder is the XR palette's message ("Search every action").

Slice, Slice All Plates, Cancel Slice and Send to Printer are listed, and
offered in the plate's scene menu, enabled as the Prepare area's buttons are,
not as the shell's capability host facts would have them (they know nothing
of slicing): the browser's palette asks its own slicing controller for these
(`UiState`'s `isSlicing`, `preflightBlocked`, `gcodeReady`), and so does the
app (`PrepareCommands`, platform-free, which Prepare's buttons now use too).
Slice needs a route (the external slicer turned on, else this device's
engine), an active plate with a model, no slice running, no blocking
preflight and the core's gate given those facts (`sliceActions`); Slice All
Plates a route, no slice running and that gate (which judges every plate);
Cancel Slice a slice running not yet being cancelled; Send to Printer the
published slice still current (`SendGuard`), a printer the Device area
connected and no send running. A disabled row says why: this device's
engine's reason, "No models to slice.", the browser's `not-slicing` and
`preflight-clear` words, the core's reason, or Send's own ("Slice the active
plate before sending it to the printer.", "A send is already in progress…",
"Connect to a printer in the Device area to send this plate."). While the
palette is open, whichever area shows, the active plate's preflight and the
core's gate are kept current as Prepare keeps them (`FollowSlicing`).
Running one shows the Prepare area and asks it (`PrepareModel.ask`), which
carries it out exactly as its button: the notification permission asked
once before the first local slice, an external slicer's upload consent, the
progress, Preview opening the result, a send's confirmation dialog — or, no
longer possible by then, says why on its status line.

The Workspace wears the browser's strip and model toolbar: its title, then
the strip's quick actions (Save Project, Undo, Redo — bare symbols enabled
as the core enables them on `dom-menu`, DomShell's `QUICK_ACTIONS`), the
palette's button and the theme switch; under it the model toolbar
(`dom-toolbar` in catalogue order, the app's eight: Lay flat | Paint | Drop
to bed, Delete | Support, Seam and Fuzzy-skin Painting | Measure), each run
of one catalogue group between hairlines (the browser's separators, from the
core's toolbar runs), each button its symbol named by its label, its tooltip
the hint or the core's reason, the Workspace's current tool shown pressed
(the browser's `.active`) and pressed again to end it, as the Edit menu's
Lay flat and Measure do; a paint channel's button starts painting that
channel or switches the painter to it. The toolbar floats centred over the
view's top edge from 600 dp and spans a phone's width beneath the strip,
scrolling sideways when narrower than its tools; the search button shows its
words only above 1180 dp. (The browser's phone layout moves the toolbar to
the viewport's foot; on Android the bottom bar and the tools' panels are
there, so it stays under the strip.)

The context menus are the browser's (`ContextMenu.ts`): sections per
catalogue group in `GROUPS` order with the group's label as a small
heading in the app's language (`ActionTexts.heading`: the section's group id
to an `action_group_<id>` resource carrying the browser's
`actionGroup.<id>.label`, as the browser's `groupLabel` words it — the
core's English label only for a group the app does not know), each entry the symbol,
label and menu shortcut, enabled as the core enables it (its reason as the
tooltip). A long press (finger or pen) or a secondary click (the mouse's
right button, a touchpad's two-finger click, a pen's button) on the
Workspace opens the scene's menu where it was: on a model, the object menu,
selecting that model alone first when it is not selected (the browser's
right-click), on nothing the plate's, the selection kept — limited to what
the app performs, named "Actions for the selected model" or "Actions for
this plate". An Objects-tree row's menu (Rename, then the same catalogue
menu for the row's kind, now in its sections) opens on a long press, a
secondary click, the keyboard's menu key or Shift+F10, as the browser's
Objects panel. The Edit and Add menus show the actions' symbols and
shortcuts, and are named as the browser's menu bar names those sections
(`menuSection.edit.label`, `menuSection.add.label`).

The paint palette's `1`–`9` choose its numbered rows whenever the paint tool
is on, unless a text field takes the typing (the browser's
`isShortcutEditingTarget`): the content's root takes them before any control
(`windowKey`, from its `onPreviewKeyEvent`), so a focused toolbar button or
chip no longer swallows the digit (it reached `onKeyDown` only when nothing
focused had taken it, which still takes it when nothing is focused).

Pointer and hover: buttons, menu entries and palette rows show the hand
pointer where the browser's `cursor: pointer` does, and tooltips appear on
mouse hover (Material's, persistent while the pointer stays; a long press by
touch or pen shows them too). The 3D views move as the
browser's OrbitControls move its camera (`OrbitGestures`, renderer-api,
platform-free; `ViewNavigation` maps Android's input to it, shared by the
Workspace and Preview): a drag orbits by 2π times the drag over the view's
height (the app turned 0.006 rad per pixel before), the right button — or
Ctrl/Meta/Shift with the left — pans in screen space, the middle button
dollies, two fingers pinch by their spread, and a wheel or trackpad scroll
(`ACTION_SCROLL`) or a touchpad's two-finger swipe (Android 14's
`CLASSIFICATION_TWO_FINGER_SWIPE`) zooms by `0.95^(|deltaY|·0.01)` with
Chrome's deltas (the platform's scroll factor in dp per notch, Ctrl + wheel
as a pinch ×10); a touchpad's pinch arrives as two fingers. Only the
camera's pitch and distance bounds differ from OrbitControls'. Preview's
camera had zoomed to 1 cm, below the 3 cm `OrbitCamera` accepts, which threw
on a deep pinch; it now stops at 3 cm. A stylus is a finger: it orbits, taps,
long-presses and paints alike; its button held as it touches is a secondary
click; its hover shows no tooltip (Material shows them for a mouse).

`ProjectCommandPaletteChecks` (1,949 checks over JNI) replay the action
presentation corpus through the Kotlin wrapper (`ActionPresentation`) and
run a real session: the palette lists the whole catalogue (226) in its order
with the core's reasons, a search finds the cube the Add menu's call adds as
"Add cube.stl", the toolbar's runs and its Delete enabled by the selection,
the object menu's sections (Edit, Scene) and the plate's (File, Edit, Scene,
Slice, System), Clone Selected and the toolbar's Delete each one step, and
Delete disabled with the browser's reason once nothing is selected.
`AppActionsTest` (7) and `OrbitGesturesTest` (4, renderer-api) cover the
platform-free parts. `android-palette-smoke.py` (in `emulator-smoke.py`
before the accessibility smoke) opens the palette with Ctrl+K, finds nothing
for "zzzz", closes it with Escape, adds the cube with "cube" and Enter (its
undo label), opens the scene's menu with a long press on the cube (its EDIT
and SCENE sections) and clones, deletes the copy with the toolbar's Delete,
opens the plate's menu on the bare plate, turns the camera to Top View from
the palette, then deselects and hovers the disabled Delete with
`input mouse tap` (Compose takes a mouse's first event as the pointer
entering) for its tooltip, read from a dump of every window or from its
pixels. adb cannot press a right button or drive a touchpad, so secondary
clicks and trackpad gestures are covered by the code paths the long press
and the JVM tests share. The smoke then finds Slice by its hint (a row
shows its hint only while enabled), whose Enter slices the plate on this
device's engine as Prepare's Slice does (Prepare shows; Preview opens the
result; Prepare says "Sliced on this device"), and Send to Printer, now with
a slice to send, is held back with "Connect to a printer in the Device area
to send this plate." — its Enter leaves the palette open with "Send to
Printer: …", and Escape closes it. `PrepareCommandsTest` (7) holds the
enablement and the reasons to Prepare's rules. The emulator smoke has not
run for these changes.

### Android localization

The app speaks the browser's languages through the browser's own catalogues
(`web/public/l10n`, extracted and seeded by `web/scripts/generate-messages.mjs`).
`contracts/android-strings.json` is the maintained mapping: every translatable
string resource of `android/app/src/main/res/values` is either mapped to the
browser message carrying the same English *in the same role* (with its ICU
arguments in `%1$s`, `%2$s` order) or listed as English only. Equal English in
another role is declined with a reason: the send dialog's "Plate" is not the XR
tool rail's group, whose upstream German is "Aktuelle Platte drucken".
`tools/cross-platform/android-strings.mjs` (check by default, `--write`; in the
contracts CI job) checks that each mapped English is still exactly the browser's
source text, fails when an English-only resource or a Kotlin literal of the app
(`src/main`, `src/debug`) carries a browser message's words without being mapped,
recorded or declined, and writes `values-<qualifier>/strings.xml` for each browser
language that translates a mapped message, plus `xml/locales_config.xml` (the
manifest's `localeConfig`: the system's per-app language setting offers English
and those languages). Qualifiers follow BCP-47: `pt-BR` is `pt-rBR`, `zh-Hans` and
`zh-Hant` are `b+zh+Hans`/`b+zh+Hant` (Android adds the likely script, so `zh-CN`
reads Hans and `zh-TW`/`zh-HK` Hant). Today 86 of 201 resources are mapped (one
plural), 115 stay English, 19 languages carry 748 translations and none is
refused — the browser's catalogues hold about a hundred upstream-seeded
messages each, mostly action names, so most Android text is English in every
language, as most browser text is.

Messages are parsed by the browser's `icu.ts` (`parseMessage`), never a second
grammar. Every argument becomes `%N$s`, which the host formats as the browser
does: text as is, a number as `{n, number}` (`MessageArguments.number`: ICU's
`NumberFormatter`, at most two fraction digits, half away from zero — V8's
`Intl.NumberFormat` from the same CLDR). One plural becomes `<plurals>`, the text
around it repeated in each form, its categories those the language selects;
`pluralMessage` passes the integer quantity and the formatted number. What
Android cannot say exactly is refused, never approximated (a refused translation
falls back to English, a refused English fails): select, `=N` and offset forms,
`selectordinal`, a second or nested plural, unit/date/time and styled numbers,
one argument used both as text and as a number, and characters a resource cannot
hold. Each conversion is rendered against the browser's `formatMessage` for
sample values (Android's form chosen by the same CLDR rules) and must agree, and
fixed vectors hold the converter and aapt2 escaping (apostrophes, quotes, a
leading `@`/`?`, collapsed and trimmed spaces) on every run.
`LocalizedResourcesTest` (JVM) holds every generated resource to its English's
format arguments and the offered languages to the generated ones.

Words that stay in Kotlin are recorded with the reason: status text a ViewModel
or workflow composes (`SendWords`' phases and outcomes, Prepare's connection and
slice statuses, the Device area's messages) and platform-free words the JVM
tests check (`PrepareWords.status`/`hint`, `SendDialogView`); the generator still
checks each says exactly what the browser says. The screen-only browser words
moved to resources: the preflight panel's hidden-issue count (a plural), "Send
to Printer" and "Cancel send", the Device tabs (Camera mapped), the empty folder
and the job no longer on the printer; the head filament label now takes the
browser's `{index}` as text. Resources are display only: canonical and file-name
text (the `Untitled project` base, G-code names, dates and numbers in sent
labels) stays in Kotlin with `Locale.ROOT`, so a language never reaches a
project, a protocol or a printer. Lint's `MissingTranslation` is off for the
English (partial catalogues are the browser's policy; the generator is the
gate). Debug builds enable Android's pseudo-locales, as the browser exercises
its own: `en-XA` expands and accents every resource (text left in Kotlin shows
plainly English), `ar-XB` mirrors the layout. `android-locale-smoke.py` (in
`emulator-smoke.py`, API 33+) sets the app's language as the system setting
does: in German the bar and the Project and Prepare areas show the German
catalogue's words (read through the contract) beside English for what the
browser lacks; under `ar-XB` the bar runs right to left and every area opens;
under `en-XA` the bar is pseudo-localized; the language is reset at the end.
It passes on both emulators. Holding the converter to the browser's
renderer found three `icu.ts` defects, fixed with regression tests: `#` was replaced in a plural's rendered text, so an
argument such as a file "Part #2" printed "Part 32"; `'#'` did not quote a
literal `#` in a plural; and `selectordinal` used cardinal rules ("2th").
The theme and accessibility follow ([below](#android-design-tokens-and-accessibility));
the Android-only words previously literal in Kotlin (the Device tabs' contents, model
messages, and preset hardware descriptions) are extracted to string resources in
`contracts/android-strings.json` and `strings.xml`, verified with `android-strings.mjs`,
JVM tests, and `android-device-smoke` on an API 34 emulator.

### Android design tokens and accessibility

The app wears the browser's design system. `tools/cross-platform/android-tokens.mjs`
(check by default, `--write`; in the contracts CI job after `android-strings.mjs`)
imports `web/src/ui/tokens.ts` — never parses it — and writes
`theme/OrcaTokens.kt`: both flat-shell themes' colour roles (`domThemes`, 27 roles
as ARGB), the viewport's wash (`gradient.viewport`, top and bottom) and the plate
skin (now `DomTheme.plate`, read by `OrcaWorkspace`'s flat skins too), the radii
(3/4/6 dp), spacing, motion (120/150/200 ms on `cubic-bezier(0.2, 0, 0, 1)`), the
family each CSS stack resolves to on Android (the first one the system ships:
Roboto, monospace) and the contrast pairs (`domContrastPairs`). The browser's type
ramp is its stylesheet's, so the generator reads it from `web/index.html`: one
named rule per role (page title 17/700, card heading 12.5/700, section heading
12/600, body 13, note 11 on 1.45, button 12.5/500, field label 12, unit 11, code
11 mono, and the narrow window's `@media (max-width: 768px) .view-tab` 12.5/600 for
the bar and rail), in sp, since Chrome on Android draws a CSS px as a dp; a rule
that moves or stops setting a size fails the check. It also writes the window's
background per system theme (`values{,-night}/orca_colors.xml`) and the theme
switch's icon from the browser's `dark_mode` Material symbol.

`OrcaTheme` builds Material's theme from them: the window is `bg` (the browser's
areas are pages on its grey), cards `bgCard`, menus and dialogs `bgElevated`, the
accent primary, the selected-row tint the containers, danger error and warn
tertiary, `strokeStrong` the outline (field and switch boundaries), `stroke` the
hairline; Material's type roles take the browser role of the same purpose (titles
its page title, nothing it draws being larger); shapes its radii. (Material 1.4
keeps its motion scheme internal, so components keep Material's motion; the
browser's motion tokens wait for the app's own animations.) `LocalOrcaTheme` gives the browser's
roles Material has none for (the chrome, the wash, the plate). The theme follows
the system's dark setting unless the browser's switch — at the Workspace's top
end, its `dark_mode` icon named "Switch to dark mode"/"Switch to light mode" and
pressed while dark, as `btn-theme` is — chose one, remembered under the browser's
key (`ThemeChoice`). The browser instead opens light whatever
`prefers-color-scheme` says (a desktop's scheme is not a preference about the
slicer Orca users know); Android's dark theme is the person's own setting, and an
accessibility one, so the app honours it. The system bars' icons follow the theme
shown.

Contrast is held to WCAG 2.2 AA (4.5:1 text, 3:1 a control's boundary or state).
`domContrastPairs` lists the 45 role pairs the browser's flat shell draws and
`web/src/ui/__tests__/tokens.test.ts` holds both themes to them; `OrcaThemeTest`
holds the generated values to the same pairs and the 32 pairs the app's
components draw (text on pages, cards, menus, dialogs, the selected row, the
status containers, the wash, the chrome and a snackbar; field boundaries,
checked controls, the shown area's indicator, issue edges) in both themes.
Checking them found browser defects, fixed with that regression test: the dark
theme's teal read 3.0:1 as link and menu text (a teal both dark enough under
white and light enough to read on graphite does not exist, so the dark theme's
fills are now light tones with dark ink, `#00b4a0`/`#191c1e`), dark danger 4.3:1
and white on it 3.5:1, light warnings 3.5:1, light accent, danger and "Ready" on
the grey window 4.2–4.45:1, `accentSoft` used as text at 3.7:1, and every field's
and switch's boundary about 1.4:1 (`strokeStrong` is now the 3:1 control
boundary; text fields and the switch's off track use it). The same test found
three panels reading custom properties no token defines (`--oxr-color-selection`,
`--oxr-surface-disabled`, `--oxr-color-bg-raised`): a selected filament option
fell back to dark text on the warning orange and a selected object row to a blue
neither theme chose. `selection` is now a role (an opaque teal tint that body and
muted text read on), and the test fails any `var(--…)` that resolves to nothing.

The 3D views wear the theme: `FilamentScene.setBackdrop` draws the viewport's
wash on a quad at the far end of the view, carried with the camera and exactly
the vertical field of view high, so the wash sits on the screen as the
browser's CSS gradient does (unlit, untoned, drawn last behind everything);
`setBedColors` draws the bed's outline and grid in the plate skin's major and
minor colours; the Workspace's words take the theme's ink. To an accessibility
service each 3D view is the browser's "Build plate" (`#viewport`); the Workspace
says the active plate, its objects and the selection by name
(`ProjectSceneSummary`, from `ProjectView.selectionNames`, which
`ProjectWorkspace` reads from the captured project with the inspector: an
instance by its object's name, since a collapsed object hides its instance
rows) in the browser's words where it has them ("Selection", "Nothing
selected", "Nothing on this plate yet."), Preview its status line. Both offer
the browser's View menu camera views (Default, Top, Front, Left, Right, Rear,
Bottom View) as accessibility actions — what the drag and pinch gestures leave
TalkBack, Switch Access and Voice Access: `CameraViews` frames the bed as
`OrcaWorkspace.frameCameraView` does (offsets in multiples of the bed's larger
side, its 0.03-unit focus lift and 0.0015-unit pole at the workspace's 1.75
scale; `OrbitCamera` now takes any pitch short of straight up or down). The
name, the state and the actions are set on the SurfaceView itself
(`ViewDescription.describe`): semantics on an `AndroidView`'s modifier never
reach the accessibility tree, so the first emulator run found an unnamed
surface. Headings
are marked (the Project's name, Plates, Plates and objects, Recent documents,
Prepare's plate, External slicer and preflight issues, G-code preview,
Printers); a switch and its words are one control (Use external slicer, Remember
printer keys); a tree row's long press (its menu) is labelled "Actions for
<name>"; file and folder rows are buttons; every control already carried the
browser's words.

Enlarged text cuts nothing that matters. The bar (`ShellBar`) keeps every
area's whole name: `NavigationRows` puts the five items on as few rows as fit,
their counts as even as rows allow — one row of equal items at the usual size,
as Material's bar, a second row at 1.3× or 2× or in a language with long words
— and the rail (`ShellRail`) grows from 80 dp to its widest name (at most a
third of the window, where a name wraps) and scrolls. Dialogs scroll their
content, so their buttons stay reachable. Reduced motion is the platform's:
Compose multiplies every animation's duration by the system's animator
duration scale, which "Remove animations" sets to 0, so each ends at once and
infinite ones show their end, as the browser's `prefers-reduced-motion` rule
does; the app adds no motion of its own beyond Material's components. The
browser's in-app "always reduce motion"
preference waits for an Android preferences surface. The window is edge to
edge: the Scaffold keeps content clear of the system bars, a display cutout
and (with no bottom bar) the keyboard (`safeDrawing`); the work area consumes
that padding and adds the keyboard's height beyond it (`imePadding`), so a
focused field stays above the keyboard while the bar stays under it; the bar
pads for the navigation bar and a side cutout.

`OrcaThemeTest`, `ThemeChoiceTest`, `NavigationRowsTest` and
`ViewDescriptionTest` (JVM) and `CameraViewsTest` (renderer-api) cover the
platform-free parts; `ProjectAccessibilityChecks` (18 host JNI checks) follows
`ProjectSceneSummary` on a real session through a cube, a cylinder, Select
All, Deselect All and a new plate and its undo. `android-accessibility-smoke.py`
(in `emulator-smoke.py` before the adaptive smoke) audits every area's
actionable nodes for names, checks no control lies under a system bar, turns
night mode on (the Project page's background and the Workspace's wash are the
dark tokens'; the switch's explicit light outranks it), sets font scale 2.0
(every area and its key controls, the Add printer dialog's fields and buttons,
the bar's five whole names), checks fields above the keyboard in landscape and
portrait and opens areas, a menu and a dialog with every animation scale at 0,
restoring each setting as it ends. It passes on both emulators.

### Automation and platform-specific integrations

OrcaXR maintains strict separation between portable canonical domain operations, target-specific
automation adapters, and browser-only platform integrations:

1. Canonical Action ID Preservation:
   - Action IDs in Android `AppActions.kt` (`PERFORMED`) match the canonical catalog
     (`contracts/action-catalog.json`) and web `ActionRegistry` byte-for-byte. No private
     or divergent action names are introduced for native platforms.
   - 153 native performed actions are validated across the catalog, action presentation vectors
     (`testdata/cross-platform/action-presentation-vectors.json`), and parity reports
     (`docs/parity/release-report.json`).

2. Native Test Automation:
   - Automated testing on Android runs via external Python harnesses (`tools/cross-platform/android-*.py`)
     interfacing with the Android OS through UI Automator, Accessibility Node hierarchies, and ADB shell commands.
   - Replays exercise realistic user journeys (drawing parts, assembly alignment, Brim Ears, Smart Paint,
     settings overrides, Filament swaps, slicing preflight) on both standard 4 KB page architectures (API 34)
     and 16 KB page architectures (API 37).

3. Browser-Only Integrations (Documented Non-Portable Boundaries):
   - **WebMCP (`WorkspaceTools.ts`, `webmcp-client.ts`)**: In-browser Model Context Protocol server/client
     adapter for external web AI agents over WebSocket/SSE. Not ported to Android; native automation uses
     Android Accessibility, test intents, and Compose test rules.
   - **Browser MediaPipe & Web Speech API**: Web-based speech recognition and vision models for multimodal
     command experiments. Android leaves voice and camera features to lazy native Android APIs (SpeechRecognizer,
     CameraX), ensuring optional external services never gate core startup or session readiness.
   - **WebXR & XRBlocks**: Web-based spatial rendering uses Three.js and WebXR device sessions. Native
     Android XR development targets Jetpack SceneCore and native Filament pipelines, not WebXR shims.
   - **Web File System Access API**: Web uses OPFS and `showOpenFilePicker`. Android uses the Storage Access
     Framework (`ProjectDocuments.kt`, `DocumentOwners`, `ActivityResultContracts.OpenDocument`) with
     persisted URI permissions.
   - **Moonraker Printer Communication**: Both platforms share the offline-first Moonraker HTTP/WebSocket
     boundary (`orcaxr_printer`), prohibiting vendor cloud proxies or telemetry dependencies.

### Action capabilities

`orcaxr_contracts::capabilities` ports the browser's action catalog and its
availability rules (`ActionRegistry`): which surfaces offer an action, the
catalog order `forSurface` and `forContext` list, and whether a workspace
state enables an action, with the browser's reason when it does not. An
action is hidden on a surface that does not offer it (with its XR
unsupported reason on XR surfaces) or whose visibility rule refuses the
state; it is disabled by an unavailable or blocked status, by a startup
feature it depends on (`initializationBlockReason`: the first core feature
not ready, with profiles and the settings schema added for slicing,
calibration, filament, settings and preset actions), by the first unmet
prerequisite, or by its enablement rule. Reasons carry the browser's
`AvailabilityCode` (and the unmet prerequisite), which the browser registry
reports alongside its text so a shell can explain a reason in its own words,
and render as that text in UTF-16, including host-supplied startup labels.

`generate-action-catalog.mjs` generates the catalog from the production
registry: every action in catalog order with its resolved capability, the
surface, group, context, status, mode, printer-job, startup-phase and
prerequisite vocabularies from their TypeScript unions, the prerequisite
rules from the registry source, and each enablement rule translated from its
arrow function into Rust. The translation admits the small boolean grammar
the registry uses — flags, `!`, `&&`, `||`, count comparisons and enum
equality — and refuses anything else, including a rule that reads a
workspace field the native state does not model. Optional browser flags read
as false when absent, so only their positive test is admitted.

`action-capability-vectors.mjs` records the registry's own answers: every
action on every surface over the initial state, representative workflows,
every startup phase of every application feature, and seeded combinations of
every field a rule reads, plus the surface and context listings. The Rust
replay matches each availability, code, prerequisite and reason, the
listings, the catalog order and that the native default state is
`INITIAL_UI_STATE`: 110 states, 372,900 availabilities and 59 distinct
reasons. The two paths no
catalog action takes today, a hiding visibility rule and a disabling status
without a reason, are pinned against the registry's own text.

### Differential replay

`differential-replay.mjs` drives the TypeScript session, the authority, and
the Rust session over WASM side by side through seeded command traces. Every
distinct session-trace state opens in both; each step is generated from the
authority's current state — renames, transforms, plates, object duplication
and conversion, height ranges, layer events, filament assignment and
remapping, part roles, brim ears, settings overrides with live or stale
guards, two-command transactions, undo, redo, host selections and requests
with a stale guard — mostly valid and sometimes not. Requests are raw JSON,
so a shape the contract refuses is refused by both sessions' own decoders.
After every step the reply, canonical state, semantic hash, asset
fingerprint, selection, history, history revision and the registry facts
the session decides must agree, and a host following each session's
renderer deltas from what it shows — with seeded page sizes, an occasional
unknown base and an occasional oversized page — must receive the same pages
as text. CI runs twelve seeds of a hundred steps over each of the 19 states
(22,800 steps, about a third of them refusals, and 23,154 render pages);
`ORCAXR_DIFFERENTIAL_SEEDS` and `ORCAXR_DIFFERENTIAL_STEPS` widen the search
locally, and 142,500 steps over fifty seeds agreed throughout, with 144,585
render pages.

### Capability exchange

`capabilities` in the project crate serves the catalog to hosts over a live
session. The session decides the facts it owns — instances on the active
plate, plates, selection, the primary instance, undo/redo and dirtiness —
through `canonicalUiFacts`, the function the browser's shell itself now
reads them through; the request carries the facts the host owns (mode,
slicing, G-code, printer, preflight, projection health, startup), so a host
cannot enable an action the project does not allow. A `CapabilityRequest`
asks for a page of at most 64 of a surface's actions, of a context menu, or
named actions (an unknown name is hidden); the `CapabilityPage` carries the
session revision and history revision it was read at, the facts, the total
and each action's availability with its code, prerequisite and text.

Bindings: WASM `ProjectSession.capabilities`, the JNI export
`sessionCapabilities` and Kotlin `ProjectSession.capabilities`.

`capability-exchange-vectors.mjs` records the facts at every step of the 76
session traces (1,981 steps) and, over real TypeScript sessions opened from
the 21 distinct trace states, capability pages as opened, after a selection
and after an acknowledged edit through the session wire protocol. Rust
checks the facts while replaying every trace natively and answers all 366
pages byte for byte; WASM in Node and Chrome and JNI open each state as a
real session, take the same selection and edit (matching its replies) and
match the pages, with 183 refusals; 15 Kotlin checks cover the wrapper,
including a selection the session, not the host, reports.

### Action presentation

`orcaxr_project::action_presentation` ports how the browser's shells
arrange catalogue actions (`web/src/ui/ActionPresentation.ts`, which
the DOM and XR command palettes, the context menus and the DOM model toolbar
now share — the XR palette had a copy of the DOM palette's matcher): the
palette's search, which keeps an action whose label, id or hint (as the
shell shows them, in its language) contains the query trimmed with
ECMAScript's whitespace, every text lowercased as `toLowerCase` does
(`js_math::case::lower`: Unicode 16, Final_Sigma, lone surrogates kept),
compared as UTF-16 code units, in the order given — no ranking beyond the
catalogue's order; a context menu's sections, the catalogue groups in
`GROUPS`' declared order (the generated catalogue now carries each group's
label and that order: `Group::label`, `Group::ORDER`); and the model
toolbar's runs, consecutive actions of one group. A section's heading and a
menu bar's section are worded by the shell, in its language: the browser's
`groupLabel` and `menuSectionLabel` look up `actionGroup.<id>.label` and
`menuSection.<id>.label`, which `generate-messages.mjs` derives from `GROUPS`
and `MENU_SECTIONS` as it derives the actions' own messages (the context
menus, the XR inspector's panels, the DOM and XR menu bars and the immersive
shell's section titles had shown the English labels under translated
entries; the DOM menu bar's dropdown ids are now the section's id, the same in
every language), and Android maps them as resources; the exchange's `label`
stays the catalogue's English. The exchange
(`ActionPresentationExchange.ts`) is canonical JSON: `palette_json` reads
`{"actions":[{"hint"?,"id","label"}],"query"}` and answers
`{"matches":[index]}`; `groups_json` reads `{"actions":[id],"layout":"context"|"toolbar"}`
and answers `{"groups":[{"actions":[index],"group","label"}]}`; malformed
requests and actions the catalogue lacks are `invalid_request`. Bindings:
WASM `command_palette`/`action_groups`, JNI `NativeProject.commandPalette`/
`actionGroups`, Kotlin `ActionPresentation`.

`action-presentation-vectors.mjs` records the browser's answers over the
whole catalogue in every language it ships (21 catalogues: the registry's own
text source over each `web/public/l10n` catalogue, plus one of case-mapping
edge cases — final sigma, dotted capital I, ß and ẞ, Cherokee, Georgian,
titlecase, lone and astral surrogates, ECMAScript whitespace): 1,827 searches
(1,502 matching; fixed queries and 60 seeded substrings per catalogue of
labels, hints and ids, case-changed, padded, some splitting a surrogate
pair), 92 sections and runs over the catalogue's menus and seeded selections
of it, and 23 malformed requests. Rust (`tests/action_presentation.rs`), WASM
in Node (`project-wasm-test.mjs`) and JNI (`project-jni-test.mjs`) answer
them byte for byte; the Kotlin wrapper replays them in
`ProjectCommandPaletteChecks`. The corpus requires Node's Unicode 16, the
core's pinned casing.

### Renderer deltas

`render` in the project crate (`renderProjection.ts` in the browser) is the
renderer's view of a project, normalized so one edit changes few records: a
plate carries its order, printable flag and whether it is active; an
instance its object, plate, transform and printable flag; a volume — once
per object, not per instance — its object, role, mesh asset, triangle count,
transform and resolved display colour (a physical tool's colour or a mixed
recipe's, absent when nothing is assigned). Switching plates touches plates,
recolouring a tool touches the volumes that use it, and moving an instance
touches that instance alone. Names, paint and settings are other
projections; geometry bytes are read from the asset repository by ID. The
browser's Three surface resolves colours through the same rule.

A host subscribes by revision rather than receiving the project after each
edit. A `RenderRequest` names the snapshot the host shows (`base`, a
revision and semantic hash), optionally the snapshot being paged (`target`,
the session's acknowledged one when absent), a start and a count of at most
64. The `RenderPage` carries the base it applies to, the target, the total
and the changes: removals first, children before parents, in the base's
order, then new or changed records, parents before children, in the
target's order. The session retains the last eight snapshots it served, so
a host pages toward a target even after newer edits and asks for the next
delta from the target it applied; a base it no longer holds is answered
from empty with no base, which tells the host to rebuild, and a released
target refuses `stale`. Disposal releases them and refuses `disposed`.

Bindings: WASM `ProjectSession.render`, the JNI export `sessionRender` and
Kotlin `ProjectSession.render`.

`render-delta-vectors.mjs` follows real TypeScript sessions opened from the
19 distinct trace states through a full sync, an empty delta, and deltas
after acknowledged moves, an added and re-activated plate, an object's
physical and then mixed filament (drawn in the recipe's display colour), a
part's own filament over its object's, a height range's filament (an empty
delta: the browser colours no range), a duplicate, printable toggles paged
across a newer edit, a deletion and renames, then an unknown base, an
unknown target, an oversized page and the released opening snapshot. Rust,
WASM in Node and Chrome and JNI open each state as a real session, take the
same edits (matching their replies) and answer all 313 pages byte for byte,
with 57 refusals; a Rust check applies the delta between every pair of
corpus projects to its base and rebuilds the target, and 50 Kotlin checks
cover the wrapper. Intent
encoding in Rust now writes numbers as JavaScript does (`1`, not `1.0`), so
every binding's wire text is byte-identical to the browser's.

### Worker-hosted sessions

`ProjectSessionWorker.ts` supervises a project session hosted off the UI
thread; `RustProjectSessionHost.ts` is the worker side over the shared Rust
core. The worker owns the authority and the browser holds only what it
acknowledged. Each worker incarnation opens under its own never-reused
session generation, and its channel drops replies tagged with another
incarnation, so a reply from a replaced worker is never taken for the
current one's; the session client already fails closed on a reply under
another generation.

When a worker errors, exits, delivers an undeliverable message or is
stopped, every operation still awaiting a reply is rejected as of unknown
outcome — never retried — and the supervisor counts them synchronously for
the recovery report. A client that failed closed (an unverifiable reply)
also marks its incarnation failed. `checkpoint()` captures the worker's
document and assets in declaration order and adopts them only when their
revision, semantic hash and asset fingerprint equal the acknowledgement of
a query answered just before; anything else keeps the previous checkpoint.
`recover()` stops the failed worker, opens a new incarnation with a new
generation from that acknowledged checkpoint — never from a UI view — and
refuses unless the recovered session reports the same content identity.
`dispose()` closes and stops the worker at once, even a hung one. The
worker host runs each exchange to its reply in order, consuming the
commit's effects before the acknowledgement leaves.

`session-worker-recovery.mjs` runs the Rust core in a real Node worker for
each of the 19 distinct trace states: an acknowledged edit, an adopted
checkpoint, a later acknowledged edit, then a hang (stopped by its owner)
or an exit with three edits in flight. All 57 are rejected as of unknown
outcome; a failed worker takes no work or checkpoint; each recovery opens a
new generation holding the checkpointed document, not the later edit, and
edits normally; recovery without a failure refuses and disposal stops the
worker. Web tests cover the same rules over an in-process worker, plus a
superseded incarnation's reply, a reply under a foreign generation, a
checkpoint whose identity was never acknowledged and a worker that cannot
open. The browser's own session still runs in process; this is the
lifetime a worker-hosted core will use when Rust sessions are enabled.

### Preset graph and profile catalog

`settings::presets` ports `PresetGraph`, the pinned v2.3.4 preset semantics:

- catalog and group validation with the browser's issue codes, paths and
  messages;
- preset IDs through `encodeURIComponent`, where a lone surrogate is the
  browser's `URI malformed`;
- vendor-local, then unique cross-vendor parent resolution, and inheritance
  depth and cycle detection;
- shallow effective overlays, sources, visibility and defaults;
- printer and print compatibility, where explicit lists, the
  direct-parent rule and exclusions decide, and a condition expression alone
  stays `unresolved`, since no engine evaluator runs, as in the browser;
- `resolveSelection`: process and filament replacement scoring by alias,
  layer height, preferred name and filament type, inherited extra slots,
  substitutions and deduplicated diagnostics.

`settings::catalog` ports `ProfileLoader`'s compile. It flattens each preset
to engine wire strings through the `profileKeys.ts` meta and safe key lists,
and builds every visible compatible machine/process/filament profile. Each
profile shares its three flattenings instead of storing a merged copy. The
module also covers catalog diagnostics with the browser's `|`-joined
deduplication, and selection reconciliation.

The browser orders presets with `localeCompare(…, 'en')`. That order is
visible in pickers and breaks replacement ties, so it is kept, not replaced
by code-unit order. `PresetGraph::build` takes a host `Collation` and ranks
every node once. `AsciiRootCollation` reproduces ICU's root collation exactly
for ASCII and controls: ignorable controls, whitespace, punctuation and
symbols, then digits, then case-folded letters with lower case first on a
tie. It refuses other text, so a host with non-ASCII presets passes its
platform collator rather than relying on a guess.

`preset-catalog-vectors.mjs` replays the bundled corpus: 353 nodes, 1,482
profiles, every preset's flattening, 2,699 compatibility assessments and 58
reconciliations. Nine synthetic catalogs cover every refusal and rule (429
assessments, 12 reconciliations), and 4,007 collation pairs pin the ASCII
order.

### Profile catalog host exchange

`settings::catalog_exchange` serves the catalog to hosts. A `CatalogUpload`
streams catalog JSON through the bounded document parser (explicit byte,
node, text-unit, number and depth budgets). Building consumes the upload with
the built-in ASCII root collation or a host collator. A refused graph still
loads, with its diagnostics and no profiles, as the browser's catalog does.

Reads return generated contract values, one at a time:

- diagnostics;
- every preset in picker order;
- compiled profiles and their engine configurations;
- selection reconciliation;
- `catalogPreflightTarget`. The selected machine, process and primary
  filament, plus each head's filament, become the `CatalogPreflightTarget` of
  a live `PreflightRequest`. The workspace now builds its own catalog target
  through the same helper.

Bindings:

- WASM: `ProfileCatalogUpload` and `ProfileCatalog`. A collator is any
  object with `compare(Uint16Array, Uint16Array)`; the browser passes
  `Intl.Collator('en')`.
- JNI: twelve exports. The `PresetCollator` callback receives complete UTF-16
  char arrays, and a throwing callback becomes `collation_failed` without
  exposing its text.
- Kotlin: `ProfileCatalogUpload` and `ProfileCatalog`, decoding every reply.

The preset corpus now also pins the exchanges of the bundled and a refused
catalog: diagnostics, all 353 presets, 42 sampled profiles with their
configurations, 60 reconciliations and 5 catalog targets. Rust, WASM in Node
and Chrome (through the browser's own collator) and JNI match all 506
replies. Each also checks 12 refusals: out-of-order chunks, rebuilds, reads
past the end, malformed requests and tool budgets. Number spelling is
semantic, so targets compare as decoded values. The Kotlin wrapper passes 15
checks, including a host collator that reorders presets, a throwing collator
and upload budgets.

### User preset library

`settings::library` ports `PresetLibrary.ts`: the printers an operator
installed and the presets they authored, over the pinned catalog. A host
supplies three policies per call through `LibraryHost`: the `en` collation,
the clock that stamps provenance, and `Date.parse` validity.

- Installing is visibility, not deletion. An uninstalled machine preset stays
  in the composed catalog with `instantiation: "false"`, because nozzle
  variants inherit from one another.
- A custom preset is an overlay on a base: `inherits` plus the keys it
  changes. Names (at most 120 units, unique per vendor, never a system
  name), bases (present, instantiable, acyclic), override keys (not
  library-owned, defined by some system preset of the kind, JSON at most
  eight levels deep) and provenance (licence, version, timestamps, lineage)
  are checked with the browser's messages and order.
- Every change rebuilds the composed graph before it replaces the state, so
  a refusal leaves the library exactly as it was. Uninstalling, renaming or
  deleting a base of another preset is refused.
- Bundles are sorted JSON (`stable_stringify`) pinned to the engine commit;
  import is all or nothing. Stored state drops and reports unreadable
  entries, and unreadable text becomes `unreadable_state`, a schema the
  build refuses, as the browser store does.
- `plan_catalog_update` reports added and removed models, removed variants
  and orphaned presets. `apply_catalog_update` moves onto the new catalog
  when nothing would be orphaned.
- The catalog fingerprint is FNV-1a over the WTF-8 of every preset's sorted
  identity and payload, joined by U+0001 as the browser joins them.
- `coerce_override_value` and `format_override_value` read and present
  typed override text in the inherited value's shape.

Two browser behaviours were not portable and are fixed in the browser. A
bundle that is not JSON reported the engine's own parse message; it now
reports "Bundle is not valid JSON.". A number that overflows to Infinity was
accepted into bundles and stored state; it is now malformed text in both,
since neither storage nor a native host can hold it. Override issues follow
JavaScript property order (`js_keys`: array indices first), not map order.

`preset-library-vectors.mjs` replays 14 scenarios (131 steps) over the
bundled corpus and six synthetic catalogs: installs, custom preset edits,
base lists, inventories, composed catalog and graph digests, 4 exports, 24
imports, 8 plans and 4 applies, and stored values and text. Every issue code
the browser emits occurs. Rust matches every result, state and digest, the
clock reads, 22 coercions, 12 formats and the stable JSON and WTF-8 digest
cases.

### Preset library host exchange

`settings::library_exchange` serves the library to hosts. A host creates a
`HostLibrary` from a catalog upload and the bytes it stored (none, or text
that may be unreadable, which loads as `unreadable_state`). It then submits
generated `LibraryOperation`s: the browser's install, create, update and
delete, plus `setInstalled` and `uninstall`. Create and update carry their
own `now`, so the exchange never reads a host clock and a replay is
deterministic. Collation and `Date.parse` validity come from the host on
every call.

Replies are contract values. An outcome is `{ok, issueCount}` and its issues
are read one at a time; the latest outcome of creation, an operation, an
import or a catalog update owns them. Bundles and stored text cross as UTF-8
bytes under explicit budgets: text that is not JSON is an `invalid-bundle`
outcome, while a budget breach refuses. Other reads: the view (configured,
fingerprint, vendors), custom presets with canonical override JSON, the
inventory, base presets, catalog update plans and applications, and the
override coercion and formatting helpers. `catalog` builds the composed
catalog as the profile catalog the app reads, as the browser's catalog
composer does.

Bindings:

- WASM: `PresetLibrary.create(upload, stored, limits, collator)` consumes a
  `ProfileCatalogUpload`; `plan_update` and `apply_update` consume one too.
  Timestamps use the browser's own `Date.parse`.
- JNI: sixteen exports. Creation consumes the upload slot in place and keeps
  the host's `PresetCollator` and `LocalTimestampResolver`; a throwing
  callback becomes `collation_failed` or `timestamp_service`.
- Kotlin: `ProfileCatalogUpload.library` and `PresetLibrary`, decoding every
  reply. `ProjectHandle.move` now also consumes into plain values.

The preset library corpus now carries each step's contract encodings. Rust,
WASM in Node and Chrome (through the browser's collator) and JNI replay all
14 scenarios from catalog and stored bytes and match 425 replies, with 184
refusals: consumed uploads, reads past the end, output budgets and
malformed operations. Inventories compare as decoded values, since number
spelling is semantic. The Kotlin wrapper passes 25 checks, including bundle
and stored-text round trips, a reordering collator, and failing collator and
timestamp callbacks.

### Canonical slice preflight

`runCanonicalSlicePreflight` is `orcaxr_project::slicing::preflight`. It has two
entry points. `preflight` takes a `ValidatedProject` and reuses its admission
report. `preflight_candidate` validates any typed candidate first, so graph
errors become blocking `invalid-project-state` issues, as in the browser. Both
also take an asset snapshot, the plate, typed `Constraints` and explicit
`Limits`.

`Constraints::validate` refuses malformed input first, with the browser's
messages. The checks then run in the browser's order:

- unknown and excluded plates, and plates with no printable instance;
- empty model meshes;
- exact model-volume bounds against the build volume, with `toFixed(3)`
  formatting, plus sinking and AABB overlaps;
- engine filament capacity;
- the filaments each printable object uses. These come from object and volume
  overrides, whole-facet paint, refined leaves, layer ranges and the wipe tower,
  in first-use order;
- disabled and deleted assignments, printer tool capability, unavailable
  components and FullSpectrum material compatibility
  (`filaments::compatibility`, the pinned category matrix);
- gradient clamps, duplicates and dropped tools;
- profile attestation, tool ranges, nozzle, material and temperature
  constraints;
- prime-tower relative E, ooze conflicts, diameter warnings and the brim
  footprint (`wipe_tower_footprint_margin_mm`);
- custom G-code NUL bytes and UTF-8 size.

Issue IDs join code, detail, path and entity references. Issues sort by
severity, code and ID, and equal IDs keep evaluation order, as in the stable
browser sort. `Preflight::to_value` is the browser result shape.

Unreadable meshes report the browser's own messages. Descriptor and payload
agreement are checked per volume. `mesh::validate_indexed` decides decode
refusals in `decodeIndexedMeshAsset` order. Bounds accumulate through
`Mesh::accumulate_bounds`, which separates zero quaternions from non-finite
transformed vertices. Each decoded mesh, or its refusal, is reused for the rest
of the run. Budget and cancellation failures refuse the whole preflight; they
are never reported as project faults.

The browser's `Number`, `String(number)`, `toFixed` and `trim` conversions now
have one home: `js_math::convert`. The archive re-exports it, and the layer-event
key and the validation, split and facet messages use it instead of private
copies.

`slice-preflight-vectors.mjs` runs the production function over 76 cases.
Together they cover all 28 codes, 8 mesh-refusal messages and 12 constraint
refusals: lone surrogates, coerced config spellings, scope-filtered plate keys,
tool order and the Unicode upper/lower-case mappings. Rust compares each result
as canonical JSON bytes, checks that the admitted path agrees, and pins budget
and cancellation refusals. Host endpoints are not yet native.

### Live profile preflight targets

`slicing::profile` ports `deriveLiveProfilePreflightConstraints` and
`LiveProfileSlicePreflight`. `derive` reads only the engine wire strings a
target declares. These are `printable_area` (exactly four distinct
axis-aligned corners, decimal coordinates only), `printable_height`, a
per-tool or uniform `nozzle_diameter`, and each tool's scalar
`filament_type` and temperature range. Missing required facts fail closed as
blocking diagnostics; missing optional facts are recorded as omissions.

A catalog target needs exact machine, process and filament preset identities.
An authored project attests from its own configuration. `attest` merges
blocking diagnostics into the canonical result as `missing-profile-attestation`
errors, and `preflight_target` derives, preflights and attests in one call.
Tool counts above the host's `max_tools` are refused rather than allocated.

`authored_target` builds an imported project's target from canonical state
alone: `settingsBaseConfig ?? config` plus the physical filaments, through
`engine_wire_config`. That function joins arrays with the option's PrintConfig
delimiter, writes objects with `js_math::convert::json_stringify`, and slices
the project's per-tool filament vectors. The browser helpers moved from
`OrcaWorkspace` into `AuthoredSlicingTarget.ts`, so both shells share one
source.

The browser's merged sort used `localeCompare`, so issue order depended on the
viewer's locale; filament IDs differing only in case swapped under a collation.
It now uses the canonical UTF-16 comparison, with a regression test.

`slice-profile-vectors.mjs` pins 31 derivations, 5 authored targets from
canonical states, 4 merged attestations and the 26 string-vector keys. Covered
cases include signed-zero corners, hex heights, and single-key objects rendered
as JSON. The catalog itself is not native, so a host supplies catalog profiles.

### Live preflight host exchange

Hosts run a live preflight on an `ExportCapture`, the frozen project and asset
bundle a save or slice already uses, so the result can never describe a newer
edit. The shared intent contract adds `PreflightRequest` and its replies.
Generated codecs exist for TypeScript, Rust and Kotlin, with the same
byte/node/depth budgets.

A request names the plate, a target and explicit budgets: mesh bytes,
vertices, indices, decoded assets, vertex visits and tools. The target is
either `authored` (the project's own configuration) or `catalog`. A catalog
target carries preset identities plus only the six facts the derivation reads
for the primary and each tool. `slicing::report::Report` holds the attested
result and its derivation. Hosts read it piecewise: a summary with counts,
then each issue, omission, printable instance and used filament as its own
contract value, so a large plate never needs one oversized message.

Malformed requests, non-stable plate IDs, budgets and cancellation refuse
with stable codes: `invalid_request`, `resource_limit` and `cancelled`.

- WASM: `ProjectSession.capture_export(guard)` returns `ProjectExport`, whose
  `preflight(json)` returns `ProjectPreflight`.
- JNI: `exportPreflight` plus five per-item readers. Closing the capture slot
  cancels a running preflight.
- Kotlin: `ProjectExportCapture.preflight(request)` returns a
  `ProjectPreflight` of decoded contract values.

The profile corpus now pins 7 live cases, 3 of them authored. It records
their TypeScript-encoded request and replies. Rust's `Report`, WASM (Node and
Chrome) and the JNI bridge each match 59 replies across the 7 cases and 42
refusals. The Kotlin wrapper re-encodes every decoded value and checks budget
and closed-capture refusals: 115 checks.

### Catalog slicing configuration

The step that turns a chosen catalog profile into the project's own slicing
configuration is shared. The browser's rules now live in one production
module, `web/src/workspace/CatalogSlicingConfiguration.ts`, which
`OrcaWorkspace` and `CanonicalWorkspaceController` call (the workspace keeps
the live state: the selected profile, each palette slot's filament and
nozzle, and the palette). The core ports it as:

- `slicing::choices`: the pickers' printer, process and filament choices in
  catalog order, labels disambiguated by name and then by the vendor the
  preset ID encodes (`" — "`), with the printer's heads (`extruders`,
  `profileExtruderCount`: its `nozzle_diameter` entries, one without one); `match_option` (a unique exact label, else a
  unique exact name, else the one containing match, ignoring case);
  `find_by_names` (`ProfileCatalog.find`); the default triple (Snapmaker U1
  0.4 / 0.20 Standard / Snapmaker PLA, else the first profile); `resolve`
  (`selectProfilePresets` after `reconcileSelection`: the completeness check,
  the exact profile of every slot and the operator's substitution messages in
  the browser's words) and `resolve_by_names` (`setProfileByNames`); and the
  slots a selection leaves (`resolved_slots`: the palette grown to the
  extruder count, never past 16 slots, each slot's filament and nozzle).
- `slicing::configuration`: `live_configuration`
  (`commitLiveSlicingConfiguration`: the profile's configuration with the
  palette's colours, one physical filament per slot keeping the ID the
  project gave that tool or `import:live:filament-slot-N`, its exact catalog
  filament's configuration and material, a mixed component left without its
  filament refused) and `next_state` (`nextSlicingState`: the project's
  overrides overlaid, or replaced when the configuration carries them; an
  unchanged configuration is no change; printer and filament records
  replaced whole; then `withReconciledAutoPairs`).
- `filaments::auto_pairs`: the stable-ID projection of the pinned
  `MixedFilamentManager::auto_generate` and its project adapter
  (`reconcileFullSpectrumAutoPairFilaments`), with `filaments::pigment`, the
  pinned `filament_mixer` polynomial in the browser's operation order. Its
  330-feature table (`filaments::mixer_model`) is generated from the
  browser's by `generate-filament-mixer.mjs`, checked in CI. Pairs regenerate
  only when enabled and for at most four physical filaments or a confirmed
  count; new identities are UUIDs over host-supplied random words, sixteen
  each, as the browser's UUID source draws them (too few words refuse as
  `ids-exhausted`).

Text compares as the browser's: `toLowerCase` is the pinned Unicode 16
table, now `orcaxr_project::js_math::case` (moved from the OPC module, which
uses it unchanged; Rust's own tables differ from V8 in 28 scalars),
`decodeURIComponent` is shared with the printer port, and a colour's
`toUpperCase` reads only `a`–`f` and U+FB00 (`ﬀ` upper-cases to `FF`), the
only units that upper-case into hexadecimal.

`slicing::configuration_exchange` is the hosts' contract, mirroring the
browser's `CatalogSlicingConfigurationExchange.ts`: canonical JSON requests
and replies over a live choice (`{profile, heads, nozzles, palette}`; a
profile the catalog no longer holds reads as none), with states and
configurations as JSON text of at most 1 MiB. `ProjectSession::stage_slicing_configuration`
computes the next state from the session's current project and stages it as
one "Update slicing configuration" `replaceProject`, validated when it
executes; no profile or no change stages nothing, and an orphaned component
or a refused reconciliation answers with the browser's message.

`slicing-configuration-vectors.mjs` drives the production module through
its exchange over the bundled catalog and a synthetic one (labels shared by
name and by vendor, a 17-nozzle printer, a filament named only by its
qualifier, ambiguous filament types, odd nozzle lists): 80 choice lists, 46
matches (Final_Sigma, `İ`, `ß`, `ﬀ`, the Kelvin sign, lone surrogates,
ambiguity), 46 selections by ID, name and default (unknown printers,
processes and filaments, substitutions, wider and narrower palettes, a stale
profile), 72 configurations against nine states (model-corpus states with
unknown members, lone surrogates and `__proto__` keys, overrides, a wipe
tower on a dropped tool, a mixed filament on a dropped tool, physical
filaments out of tool order with odd colours and nozzles) — 60
configured, 9 orphaned, 3 without a profile — and 133 next states under
every auto-pair policy (115 changed, 10 unchanged, 2 invalid, 3 auto-pair
refusals, 3 exhausted words), fed forward as a host feeds them, plus the
Filament tab's 96 slot edits and 27 project slots ([above](#filament-assignment-and-filament-slots)),
46 session commits and 27 malformed requests. Large replies are pinned by the
SHA-256 of their text. Rust replays all of it, committing on real sessions
with undo; WASM in Node and a Chrome 150 worker and the JNI exports answer
377 replies and 27 refusals, commit 43 live choices (undone each time) and
answer every slot edit and project's slots;
the Kotlin wrapper (`ProfileCatalog.slicingChoices`, `selectPresets`,
`selectByNames`, `defaultSelection`, `slicingConfiguration`, `editSlots`;
`SlicingConfigurations.match`, `nextState`, `words`;
`ProjectSession.stageSlicingConfiguration`, `ProjectSnapshot.filamentSlots`) passes 591 checks, including that
`LiveSlicingChoice.EMPTY` selects the browser's default. Porting found two
browser defects, fixed with regression tests: a slot with neither a preset
nor a name recorded `presetId: undefined`, so the canonical comparison threw
and the profile never committed; and a printer with more extruders than the
palette's 16 slots never left the loop that grew the palette.

The browser's production path stays on TypeScript: its project session does
not run on the core, so parity rests on the corpus. Not yet done: the
Android app's profile pickers and their workspace/actor operation (Prepare
still preflights only a project's own configuration).

## Edited canonical archive interchange

`archive_interchange` and `test-archive-interchange.mjs` exercise actual archive
bytes through both readers and real commands, without normalizing imported IDs.
The harness reuses all 385 canonical completion inputs, the 937 accepted package
inputs and all 956 foreign-import archives. Native Open goes through
`orcaxr_archive::open`, which completes envelope packages canonically and imports
every other 3MF as foreign BBS, like the browser's `deserialize`. For each initial
browser archive, native preparation begins under an Open
guard, completes import privately, then transfers immutable asset records into
`ProjectSession`. A guarded wire rename executes only after adoption and produces
one undo entry. The browser applies the same rename through its real `CommandBus`.
Full state, exact asset declarations/bytes and the import warning set must agree.

Both writers then serialize that edited input. Every expanded member's path,
length and SHA-256 must agree. The production browser and native reader open the
same native bytes and compare complete state/assets/warnings again. A second real
browser rename and Save supplies the exact returned bytes for guarded native
reimport. The harness checks all existing payloads and IDs survive native Save;
fixture reports deliberately copy small payloads and supply no allocation evidence.

The optimized run covers **2,278 initial archives** (1,322 canonical and 956
foreign): **116 matching import refusals** (109 canonical, 7 foreign), **2,162
native edits**, **three matching Save refusals**, and **2,159 complete
native/browser edited journeys**, 949 of them starting from foreign packages. All
2,159 browser outputs reimport in Rust with exact state/assets/warnings. The two
unresolved-origin cases and the preserved model-settings collision are reported
separately; they are accepted imports but do not count as successful Save
journeys. Earlier canonical-only debug and optimized reports agreed byte-for-byte.
The harness runs in CI alongside the package references; STL/OBJ/AMF, provider
publication and application UI/device execution remain open (WASM/JNI archive
tasks are covered in the previous section).

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
Production native renderer consumers and device latency/memory budgets remain
open; readable-text search is described below.

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

### Readable G-code text and search

`orcaxr_gcode::document` ports the browser `GcodeDocument` reader over the same
sealed UTF-16 source: lines end at `\n`, one trailing `\r` is not text, a final
newline does not start a line, and windows clamp exactly like the viewer. The
line index stores one `u32` start per line and is built on the first text request;
it never copies or lowercases the program. Search applies ECMAScript `trim` and
`toLowerCase` (Final_Sigma context, lone surrogates preserved) to the query and to
each line independently, then matches with KMP; ASCII lines need no allocation.

Per-line folding fixed a browser defect: lowercasing the whole program and mapping
offsets through the original line index put results on wrong lines whenever a
character's lowercase form had another length (one Turkish `İ` in an object-name
comment shifted every later match), and a query could span a newline. A search
returning exactly `limit` lines now reports `truncated: false`; `true` means at
least one further line matched. `contracts/gcode-buffer.json` generates the window
(1,024 lines / 1,048,576 units), result (500 default, 10,000 maximum) and query
(4,096 units) limits; `contracts/gcode-metadata.json` generates the `TextWindow`
and `TextSearch` validators. `Session.text_window`/`text_search`, WASM
`textWindow`/`textSearch` and Kotlin `GcodeSession.textWindow`/`search` expose it.
Kotlin recomputes the viewer clamp and line ordering; a native refusal such as
`resource_limit` leaves the session open, while an impossible reply closes it.

`tools/cross-platform/gcode-document-vectors.mjs` records 114 production-browser
sources (the 98 parser vectors, authored line-ending, Unicode, surrogate and
long-line cases, and a 25,000-line program), 1,536 windows and 18,710 searches.
The library, the session transport (4,093-unit chunks that split surrogate pairs)
and wasm-bindgen output in a non-isolated Chrome 150 worker match all of them.
`GcodeTextTest` replays the same corpus through real JNI but has not yet run on a
device or emulator; Android search qualification remains open.

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
the chosen adapter. Canonical project state, UI and renderer behavior remain in
their existing TypeScript owners; the Rust adapter takes the artifact summary
from the core, the reference adapter from TypeScript. The legacy explicit
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
of `build-wasm.py`, refusing a core executable past its set's bound (10 MiB for
the computation core, 12 MiB for the project core since 2026-10-11, 3 MiB for the
printer core; the measurements behind each rise are beside the check). Normal
`web` dev/build commands verify current source hashes,
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
The experimental project package uses `core/browser/project` and
`web/public/core-project/<manifest-sha256>`. It is excluded from precache and
preview inventory, keeping editor code out of the existing preview download.
The printer package (`core/browser/printer`, `web/public/core-printer/`) is a
production asset: both workers precache it and its host chunk, listed in the
offline inventory beside the preview's. The default WASM feature is `gcode`;
the project and printer builds disable defaults and select only `project` or
`printer` (`project` includes the printer bindings). Verify each package against its feature-bound manifest.
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
node tools/cross-platform/generate-opc-lowercase.mjs --verify-runtime
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/generate-filament-mixer.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/slicing-configuration-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/workspace-bed-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/slice-output-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/transform-field-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/placement-edit-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/build-volume-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/primitive-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/filament-assignment-vectors.mjs
node tools/cross-platform/generate-bbs-filament-keys.mjs
node web/scripts/run-tests.mjs opc-lowercase.test.ts
node tools/cross-platform/canonical-requests.mjs
node tools/cross-platform/generate-gcode-layout.mjs
node tools/cross-platform/generate-preview-catalog.mjs
node tools/cross-platform/generate-view-layout.mjs
node tools/cross-platform/generate-gcode-metadata.mjs
node tools/cross-platform/generate-gcode-requests.mjs
node tools/cross-platform/test-request-generator.mjs
node tools/cross-platform/generate-project-intents.mjs
node tools/cross-platform/generate-project-host.mjs
node tools/cross-platform/generate-project-query.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-query-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-query.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-host.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-archive.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-model-import.mjs
node tools/cross-platform/generate-setting-scopes.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/generate-engine-options.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/generate-action-catalog.mjs
node tools/cross-platform/test-project-intent-generator.mjs
node tools/cross-platform/project-intent-vectors.mjs
node tools/cross-platform/package-browser-core.mjs
node tools/cross-platform/package-browser-core.mjs --project
node web/scripts/run-tests.mjs gcode-packets.test.ts core-gcode-source.test.ts gcode-requests.test.ts rust-gcode-loading.test.ts project-intents.test.ts project-session-transport.test.ts GcodeDocument.test.ts GcodePanel.test.ts
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bindings-test.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/canonical-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-id-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/asset-repository-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/facet-refinement-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-model-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/settings-resolution-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/settings-codec-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/settings-editor-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/settings-projection-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/settings-panel-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/paint-palette-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/action-capability-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/capability-exchange-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/preset-catalog-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/preset-library-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/validation-value-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-validation-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/slice-preflight-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/slice-profile-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-store-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-command-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-session-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/project-input-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/archive-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/canonical-archive-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/canonical-complete-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/opc-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-facet-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-number-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-xml-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-model-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-metadata-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/bbs-settings-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/package-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/mesh-vectors.mjs
node web/scripts/run-tests.mjs bbs3mf-serializer.test.ts zip64-archive.test.ts deterministic-zip.test.ts
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/gcode-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/gcode-document-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/foreign-bbs-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/foreign-import-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/model-import-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/model-stage-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/model-transaction-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/preview-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/inspection-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/view-vectors.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/inventory.mjs
```

Run these in `core/` so the pinned Rust toolchain is selected. From the repository
root use `cargo +1.94.1`; `--manifest-path` alone does not select the toolchain or
its installed cross targets, even if another alias reports the same compiler version:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features --locked --jobs 2 -- -D warnings
cargo test --workspace --all-features --locked --jobs 2
cargo test -p orcaxr-contracts --test project_intents --release --locked --jobs 2
cargo test -p orcaxr-project --release --locked --jobs 2
cargo test -p orcaxr-archive --release --locked --jobs 2
cargo run -p orcaxr-archive --example archive_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example zip_write_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example zip_write_reference --release --locked --jobs 2 -- target/zip-write-references
node --import ../web/node_modules/tsx/dist/loader.mjs ../tools/cross-platform/test-zip-write.mjs target/zip-write-references/manifest.json
python3 ../tools/cross-platform/test-zip-write.py target/zip-write-references/manifest.json
cargo run -p orcaxr-archive --example canonical_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example canonical_benchmark --release --locked --jobs 2 -- --complete
cargo run -p orcaxr-archive --example opc_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example bbs_facet_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example bbs_xml_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example bbs_model_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example bbs_metadata_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example bbs_settings_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example package_benchmark --release --locked --jobs 2
cargo run -p orcaxr-archive --example package_reference --release --locked --jobs 2 -- target/package-references
node --import ../web/node_modules/tsx/dist/loader.mjs ../tools/cross-platform/test-package-write.mjs target/package-references/manifest.json
node --import ../web/node_modules/tsx/dist/loader.mjs ../tools/cross-platform/test-archive-interchange.mjs prepare target/archive-interchange
cargo run -p orcaxr-archive --example archive_interchange --release --locked --jobs 2 -- target/archive-interchange/input.json target/archive-interchange/native
node --import ../web/node_modules/tsx/dist/loader.mjs ../tools/cross-platform/test-archive-interchange.mjs exchange target/archive-interchange
cargo run -p orcaxr-archive --example archive_interchange --release --locked --jobs 2 -- target/archive-interchange/returns/input.json target/archive-interchange/returned
node --import ../web/node_modules/tsx/dist/loader.mjs ../tools/cross-platform/test-archive-interchange.mjs verify target/archive-interchange
cargo run -p orcaxr-project --example asset_repository_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example facet_sparsity_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example mesh_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_model_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example settings_resolution_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example validation_values_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_validation_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_store_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_command_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_session_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_input_benchmark --release --locked --jobs 2
cargo run -p orcaxr-project --example project_query_benchmark --release --locked --jobs 2
cargo check -p orcaxr-project --lib --locked --jobs 2 --target wasm32-unknown-unknown
cargo check -p orcaxr-project --lib --locked --jobs 2 --target aarch64-linux-android
cargo check -p orcaxr-project --lib --locked --jobs 2 --target x86_64-linux-android
cargo check -p orcaxr-archive --lib --locked --jobs 2 --target wasm32-unknown-unknown
cargo check -p orcaxr-archive --lib --locked --jobs 2 --target aarch64-linux-android
cargo check -p orcaxr-archive --lib --locked --jobs 2 --target x86_64-linux-android
cargo test -p orcaxr-gcode --lib --test preview --test inspection --test views --test session --test requests --test document_vectors --test document_session --release --locked --jobs 2
cargo audit
```

Run the platform checks from the repository root:

```sh
python3 tools/cross-platform/build-wasm.py
python3 tools/cross-platform/build-wasm.py --project
python3 tools/cross-platform/verify-artifacts.py --wasm --project-wasm
node tools/cross-platform/project-wasm-test.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/differential-replay.mjs
node tools/cross-platform/project-wasm-browser.mjs
node tools/cross-platform/wasm-smoke.mjs
node tools/cross-platform/generate-project-jni.mjs
node tools/cross-platform/generate-project-archive.mjs
node tools/cross-platform/generate-project-model-import.mjs
cargo build --manifest-path core/Cargo.toml -p orcaxr-android --locked --jobs 1
cargo build --manifest-path core/Cargo.toml -p orcaxr-android --release --locked --jobs 1
python3 tools/cross-platform/build-project-jvm.py
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-intent-kotlin.mjs
node --import ./web/node_modules/tsx/dist/loader.mjs tools/cross-platform/test-project-query.mjs --jni
node tools/cross-platform/project-jni-test.mjs
node tools/cross-platform/project-jni-test.mjs --release
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
checks, not renderer performance measurements. `--from <smoke>` (for example
`--from android-inspector-smoke`) runs the order from that smoke on, on the same
freshly owned AVD: every smoke installs the app it drives; `--only <smoke>` runs
that smoke alone. The runner waits until shared storage takes a file before
the first smoke, since a smoke pushing to Downloads at once would be refused
just after boot. Its density is the
`pixel_2` profile's 420 dpi, so the 720-pixel display is 274 dp wide. To test an
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
evidence. Physical ARM64, XR, Googlebook, sustained memory/thermal
measurements, the project workflows the app does not have yet, and supervised
printer qualification remain open. 16 KB runtime loading and API 37 behavior
have emulator evidence since: an owned API 37 x86_64 image with 16 KB pages runs
every smoke in `emulator-smoke.py` (see the plan's handoff), which is not device
evidence. No phase exit or release claim is closed by these foundation results.

Read-only inventory of a connected Samsung SM-I610 on 2026-10-04 reports Android
14/API 34, ARM64, Adreno 740, 16,066,684 KiB reported RAM, and 4,096-byte pages.
No native app was installed or exercised on that headset for this foundation
evidence. Refresh rate, supported input methods, and native performance still
need a recorded qualification run; available RAM is not an editor memory budget.
