# Native Android and shared Rust implementation plan

**Status:** implementation in progress, started 2026-10-04 at the user's request.
**Last reconciled:** 2026-10-07. Checked items below are implemented and verified
within their stated scope; unchecked items still require work. A checked sub-item
does not close its parent task, phase exit, or physical-device gate. This document
defines the required work; it does not change supported release platforms.

## Current handoff

Keep this checklist current as work completes, including before a context or agent
handoff. Record the implementation, verification and remaining limits together;
do not mark a task complete merely because code exists or a target compiles.
Detailed evidence and reproducible commands live in
[native-core](engineering/native-core.md) and the phase entries below.

- [x] Establish shared Rust computation, generated contracts and development
  WASM/JNI bindings; production browser preview uses the Rust adapter (Phase 3).
- [x] Implement and replay the currently ported project/session/command families,
  staged document adoption, captured queries and Kotlin actor ownership (Phase 4).
  Complete command coverage and production native editing are still open.
- [x] Implement bounded ZIP read/write, canonical-envelope staging, OPC
  reconciliation and complete BBS/canonical package output from frozen captures
  (Phase 5). Independent browser Open/Save checks cover 947 native packages,
  including ten real native edits; this is the native-export direction only.
- [x] Qualify canonical completion on the host: 229 workspace tests, 81 optimized
  archive tests, strict Clippy, format checks and the archive/completion/package
  ownership probes pass.
  The archive also checks for wasm32 and both Android ABIs using Rust 1.94.1.
- [x] Rebuild and verify both WASM packages and Android/JNI libraries. Executables,
  glue and 285 JVM classes retain their previously tested identity; this retains
  earlier binding replay evidence rather than claiming a fresh replay.
- [x] Pass the production web build, offline inventory and bundle-size checks
  with the refreshed artifact sets. The full web quality gate remains open below.
- [x] Complete canonical archive import after envelope/OPC staging: reconcile
  regenerated BBS metadata, adopt unowned members with deterministic IDs, validate
  the completed bundle, and produce a guarded prepared document.
  The host corpus compares 385 browser imports (276 accepted / 109 refused),
  including complete state, exact asset bytes/IDs and warnings. Guarded adoption,
  eleven budget families, cancellation and timestamp failure have native tests.
- [x] Add bounded native BBS model-XML syntax/namespace admission as the first
  foreign-import seam. Its streaming event/sanitized-text behavior matches all
  466 production-browser-derived cases (319 accepted / 147 refused), including
  arbitrary UTF-8 chunk splits and resource/cancellation failures. The reference
  generator is in native-core CI. This is not model-part projection or import.
- [x] Capture fourteen independent foreign-3MF archive expectations through the
  production browser serializer: seven accepted projects and seven refusals,
  with exact ZIP input bytes, complete canonical state, asset descriptors/bytes,
  warnings and preserved entries. Generation is bound to browser serializer,
  model parser, XML validator and ZIP-writer source hashes and is checked in CI.
- [x] Add a bounded streaming structural reader for one 3MF model part. It
  projects local object IDs, units, materials, packed mesh coordinates/indices,
  build items, component references/transforms and Production Extension paths.
  It also decodes BBS color, support, seam and fuzzy-skin roots into sparse
  canonical facet channels, including the legacy fuzzy alias. The foreign corpus
  exercises seven accepted packages, painted/refined facets, invalid channel states,
  unsupported units and duplicate IDs; color slots remain import placeholders
  until package metadata can resolve printer filament IDs. This is a library
  projection, not a complete metadata reader or importer.
- [x] Add bounded cross-part Production Extension reference validation and
  component-graph expansion. It preserves part-local IDs and build order,
  validates package paths and every object/build reference, rejects cycles, and
  enforces explicit part/object/reference/depth/expansion limits. The 14-archive
  browser corpus exercises internal and external references, missing parts and
  objects, and a component cycle. ZIP structural staging now invokes this
  resolver before returning its private result.
- [x] Connect ZIP, XML admission, one-part projection and graph resolution into
  `read_xml::package::read_model_structure`. It streams only the root and
  referenced model parts, verifies each required member's archive integrity,
  shares geometry, title, encoded-facet, refinement-node and annotation-
  materialization budgets across parts, and returns no result on any failure.
  The corpus exercises all seven accepted packages; low aggregate geometry, title
  and facet budgets reject their corresponding fixtures. Thirteen focused
  scanner, parser, graph and package tests, strict Clippy and format checks pass;
  the crate checks for wasm32 and both Android ABIs. Reproducible commands and
  scope are in [native-core evidence](engineering/native-core.md#bounded-foreign-model-staging).
  This is structural staging, not a canonical project candidate or a complete
  foreign-format importer.
- [x] Project standard BBS facet paint during bounded model-part parsing. Decode
  explicit roots under shared package byte/node budgets, build sparse canonical
  color/support/seam/fuzzy-skin channels under a materialization budget, and
  verify paint states, refinement trees, the legacy fuzzy alias and refusals
  against browser-authored ZIP fixtures. Real filament-ID resolution still
  depends on BBS metadata parsing and remains open.
- [x] Preserve bounded unknown extension attributes on foreign model objects,
  components, build items and facets. Resolve attribute namespaces, exclude
  namespace declarations/standard fields and the separately interpreted
  Production Extension path, and share count/text budgets across model parts.
  Browser-authored expected state and archive tests cover all four element types;
  graph leaves identify their source component edge without copying attributes
  across expanded occurrences. Canonical extensionData assembly remains open.
- [x] Complete native foreign BBS/3MF import in `bbs::foreign::import`: metadata
  members read with the browser's exact expression/number semantics, physical and
  FullSpectrum filament identities, paint-slot resolution, plate membership and
  origins, canonical assembly, OPC, regenerated-member exclusion, adoption and
  admission. All 956 browser-derived archives agree (949 accepted / 7 refused:
  envelope-stripped package corpus, 11 real Orca/BBS files, 8 authored metadata
  cases), as do the 15 authored foreign references. Three browser defects found
  on the way were fixed: empty builds, undeclared SVG drawings and unrepresentable
  layer events. Library scope only; bindings and adoption remain open below.
- [x] Expose canonical and foreign archive Open and complete package Save through
  owned WASM/JNI tasks driven by one generated host policy
  (`contracts/project-archive.json`); every detailed limit derives from it and
  failures map to shared redacted codes. The Kotlin actor schedules Open through
  `openDocument`/`resetDocument` (guarded adoption) and Save through
  `saveDocument` with `ProjectExportSource.writeArchive`. 1,341 browser archives
  (1,225 accepted, 1,223 saved, acknowledged and reopened) agree in Node WASM, a
  Chrome 150 worker and host JNI (debug and release); seven actor journeys pass.
  The instrumented Android test has not run on a device.
- [x] Add the provider-neutral document layer for archive Open/Save:
  open-ended staging for unsized/nonseekable streams (shared `ArchiveInput`),
  stale-size fallback, redacted provider codes, package-before-truncate Save with
  checkpoint only after provider close, and a `ContentResolver` adapter. Six
  actor journeys pass over real JNI; 670 of the 1,341 replayed archives use the
  open-ended path in every host. Instrumented tests compile but have not run.
- [x] Port signature-first STL/OBJ/AMF/compressed-AMF/ZIP model decoding
  (`orcaxr_archive::models`): all 260 browser cases agree exactly (116 decoded,
  144 refusals), including the six shipped model files. One browser defect
  (prototype keys as extensions/units/attributes) was fixed on the way.
- [x] Stage decoded models as a project merge (`models::stage`): 237 browser
  cases agree on IDs, state, assets and notices, including chained imports.
- [x] Port the import preview/normalization (`orcaxr_project::import`) and the
  undoable `Import <filename>` commit (`ProjectSession::commit_import`): 21
  browser transactions agree on preview, confirmation refusals, committed
  state/assets/history and undo/redo.
- [x] Bind model import to WASM/JNI host tasks and the Kotlin actor
  (`prepareImport`/`commitImport`): the 21 browser transactions replay in Node,
  Chrome 150 and host JNI; seven actor journeys pass. Instrumented tests compile
  but have not run on a device.
- [ ] Wire provider Open/Save and model import into the application UI
  (pickers, persisted grants, recent files, share intents) in Phase 7.
- [x] Share bounded G-code text windows and case-insensitive line search through
  Rust, WASM and JNI (Phase 3). Browser, host and Chrome WASM replays agree on
  18,710 searches; the Android instrumented replay has not run on a device yet.
- [x] Exercise edited archive interchange through guarded native Open, native
  session commands and browser commands: 2,159 complete journeys from 2,278
  canonical and foreign archives (949 foreign) in the optimized host harness.
  Application/provider journeys remain open.
- [ ] Extend round trips to foreign formats and application/provider bindings,
  finish remaining command/query coverage and production session integration,
  then continue the app/device gates.

**Resume here:** finish the remaining command families. Archive Open/Save,
provider documents and STL/OBJ/AMF/ZIP model import (decode, stage, preview,
undoable commit) now run in the shared core with owned WASM/JNI tasks and Kotlin
actor operations ([native-core](engineering/native-core.md#signature-first-model-decoding)).
Layer ranges, layer events, brim ears, layer-height profiles, physical and
mixed filaments, project/scoped setting overrides, volume-role conversion and
whole-facet paint strokes, project rename, plate wipe towers, auto-pair
reconciliation, model-colour recreation and multi-volume split to objects are
ported. So are the payload-carrying commands for add object, add object with
asset, add volume, mesh topology replacement, mesh booleans, split to parts,
single-volume split to objects, and SVG and embossed-text parts. They install
validated payload leases without copying bytes. Whole-project replacement and
refined (dense-root) facet commits are native too, so every browser command
class now has a native counterpart replayed against browser-authored traces.
All of them stage through command uploads: records declare their payload
descriptors, then the bytes stream per declared payload, through Rust, WASM and
JNI/Kotlin. Session cutover, the application shell and the device gates remain. Each family adds intent variants to
`contracts/project-intents.json` (definitions before first use; regenerate with
`generate-project-intents.mjs --write`), maps them in
`web/src/project/PreparedProjectCommands.ts`, appends a scenario to
`project-command-vectors.mjs`, regenerates the dependent captured-command/
session/staged/query/document/clipboard corpora (every CI generator in
`.github/workflows/native-core.yml` must pass in check mode), routes any
browser `Math` through `orcaxr_project::js_math`, and ports the command under
`core/crates/orcaxr-project/src/commands/`. Then continue Phase 6 (native
slicing) and the Phase 7 application shell.
Retain earlier binding replay evidence only when executable and JVM input
identities still agree; otherwise rerun it. This host can run headless Chrome,
git and memory-capped Gradle compiles; the full web quality gate, emulator runs
and fresh dependency advisories still need an unloaded machine.

`CanonicalArchiveSource::complete` now performs OPC/BBS reconciliation and adoption;
only its completed result can produce the prepared document for guarded Open/reset.
Exact regenerated-member comparison uses the bounded ZIP pull reader and verifies
unread tails even after a mismatch. SVG path/collision checks still run when missing
printable area allows metadata preservation. Browser envelope admission now also
rejects missing/mistyped required SVG recipe fields, matching the native schema.
The interchange harness preserves these semantics; foreign import now shares
the completed-archive result. Archive bindings, provider tasks and native UI
remain unfinished; library prepared-document tests do not qualify those flows.

The interchange harness now executes the previously planned three-step journey:
Open the same browser bytes, adopt under the original native guard and apply a real
rename in both implementations; compare native/browser Save member bytes and both
readers of the same native archive; make a second browser command edit, save and
reimport those exact bytes in Rust. Existing IDs and preserved payloads stay exact.
Debug and optimized results agree. Missing origins and the preserved model-settings
collision remain explicit Save refusals, never successful round trips.

For the next foreign-import tranche, start from production `importBbsCore` in
`web/src/project/serialization/bbsCore.ts` and the serializer's `deserializeForeign`
flow. Capture independent archive expectations before porting model-part parsing,
unit conversion, production-extension path resolution and component expansion.
Preserve model-part-local object IDs, the shared facet budget, depth/expansion
limits, exact plate membership/origins and consumed-versus-absorbed member policy.
Then assemble/admit the canonical bundle and extend this actual interchange
harness to the foreign inputs. The current OPC compatibility scanner is not a
full model XML parser. Archive task bindings and provider integration follow the
completed format adapters; do not bypass guarded prepared-document adoption.

Use `cargo +1.94.1` from the repository root, or run Cargo inside `core/`;
`--manifest-path core/Cargo.toml` alone does not select its pinned toolchain.
Work is committed on `main`; repository tests, generators and maintained evidence
are the durable record.

## Implementation status

Initial Stage A evidence is maintained in [native-core build and evidence](engineering/native-core.md).
The development shell, bounded Rust canonicalizer, generated request bindings,
cross-language fixtures, migration inventory, artifact checks, and new CI workflow
exist. The canonicalization envelope requires named object fields and rejects
positional arrays and duplicate keys independently of inner JSON semantics.
Phases 0 and 1 remain open: physical baselines, complete transport/session
contracts, native offline manifests, and clean-runner qualification are still required.
No renderer, native slicing route, native project editing, or XR journey is
qualified by these foundation tests. Phase 2 now has a debug-only flat Filament
fixture workbench with bounded mesh uploads, picking, display paint ranges and
a Rust toolpath projection; see the [experiment contract](engineering/native-core.md#flat-renderer-experiment).
The separate SceneCore rc01 candidate now builds against the same mesh contract,
with SDK validation tests and non-XR startup checks. Spatial rendering and update
latency remain unverified; the Linux/SwiftShader XR-image diagnostic did not boot.
The SceneCore comparison, physical-device qualification and production Android
slicing route remain open. Neither renderer candidate closes a Phase 2 checklist item or exit.
The [native engine dependency probe](engineering/slicing.md#native-android-dependency-feasibility)
now builds the current pin's TBB runtime for both ABIs, verifies its packaged
dependency closure and ELF alignment, and executes allocator/task checks on an
x86_64 Android emulator. The full-engine port now passes clean builds for both
ABIs, ELF alignment/dependency checks and seven package mutation tests per ABI.
After fixing result transport and import staging, the final clean x86_64 package
passes actual constructor checks and all eleven native/reference comparisons
with unchanged oracle tolerances. There is no ARM64 execution or application
slicing route yet.
The [canonical slice reference corpus](engineering/native-slice-fixtures.md)
now verifies eleven real archive slices through the published WASM engine, covering
physical/mixed paint, scoped settings, support and wave paths. Its captured
inputs and output summaries now have matching x86_64 emulator slice comparisons;
ARM64 execution and the application capture/preflight workflow remain unqualified.

The first Phase 3 computation implementation now includes the Rust rich G-code
parser, immutable source/index ownership, bounded windows, cooperative native
cancellation, and generated packed-column layouts through WASM/JNI. The linked
engineering document records differential and resource evidence. The 12-mode Rust
preview projection, bounded inspection and playback now have development WASM/JNI
session bindings and independently generated source/window expectations. Generated
browser metadata validation and the bounded worker-side source owner now replay
the actual WASM corpus. Production browser preview now uses the Rust worker
adapter, with a fixed startup reference choice and verified offline asset pair. Readable
text windows and line search are shared through Rust and browser-qualified; Android
JNI search replay, production native rendering, native asset integration, and device budgets remain required to qualify
Stage B fully. No phase exit is closed by the browser integration alone.

The Android host now has validators generated from the same 26 metadata shapes,
strict bounded JSON parsing, model/arc/source checks and index-page continuity
checks. Projection, inspection and playback now bind their columns and metadata
to an explicit captured model from the same session and requested source window.
The renderer checks the capture identity before consuming the view. These
development bindings still require production integration and device qualification.
Source options and preview/inspection/playback requests now share a schema that
generates Rust decoders, TypeScript types/guards and Kotlin types/encoders/guards.
This covers the G-code computation transport. Project command coverage,
production projection transport and worker/JNI session integration in Phases 1/4 remain open.

Phase 4 now has a local asynchronous facade over the existing TypeScript session,
with guarded FIFO mutation, ordered summary queries, bounded operation batches,
and authoritative acknowledgements. Production Undo/Redo and the seven plate
lifecycle operations await it through ActionRegistry. Object/part renames,
instance printability and single/batch transforms now use the same transport;
derived placement tools await their edits. DOM/XR gestures coalesce pending
poses under an explicit owner and cancel on selection/tool/lifetime changes.
Numeric transforms, DOM/XR gestures and DOM lay-on-face now use declared registry
routes; result-bearing invocation preserves the actual command acknowledgement.
Project and scoped settings commits await guarded settings intents.
Plate controls retain their
busy state until acknowledgement; stale requests reject without edits. The seven
plate payloads now use a versioned shared schema generating TypeScript,
Rust and Kotlin types, bounded encoders/decoders and serializable command batches.
Generated session envelopes now carry connection generations, request IDs,
version negotiation, identity/history guards, bounded acknowledgements/errors,
ordered queries, cancellation and close. Production plate/history operations
exchange these strings through a local adapter; the TypeScript bus remains the
executor. Lost replies fail closed without automatic retries, and completed edits
whose summary exceeds the wire budget remain explicitly completed. Selection and
projection subscriptions are still local. Production worker/JNI project integration,
revisioned projections, crash recovery and remaining workflows are still required. See
[project contracts](engineering/project-contracts.md).

The Rust project crate now also owns immutable asset records, read-only leases,
opaque rollback versions, transactional public restore and streaming bundle
fingerprints. Independent TypeScript traces and an allocation probe cover this
library boundary. The five-channel facet computation model now also validates
sparse assignments and version-2 split trees, normalizes and remaps them together,
and budgets temporary dense roots explicitly. Differential fixtures and sparse
allocation evidence are linked below. Lossless schema-1 typed candidates, immutable
graph ownership, streamed full-state fingerprints, empty-project construction and
basic graph/filament selectors now exist too. Eleven TypeScript-derived states,
record/literal drift checks and an allocation probe cover this model boundary.
Rust settings scope eligibility, strict layered resolution, import sanitization,
explanations and project configuration selectors now use the same pinned engine
table as the browser, with independent TypeScript comparisons. Compatibility
helpers now preserve pinned V8 timestamp parsing and exact layer-event rounding;
Node/Chromium reference corpora cover both V8 integer profiles and host timezone
conversion boundaries. Semantic graph validation now covers declared layouts,
references, settings-base consistency, mixed recipes, transforms, topology/paint,
layer events and extension references/paths. `ValidatedProject` retains the proof
on immutable candidates; 622 TypeScript-derived states compare ordered diagnostics.
Native project/selection stores now provide immutable change receipts, revision
guards, monotonic restoration and ordered selection pruning. An independent
311-step TypeScript trace checks these library owners. Native command/history
execution covers nineteen intents: seven plate operations, object/volume/instance
renames, instance printability, single/batch transforms and six object lifecycle
operations, with 1,108 reference steps. Local full-record instance creation and
paste add 197 steps in a separate corpus. They now have budgeted record input,
session-owned staged references and guarded execution, with a further 331-request
independent endpoint corpus. WASM/JNI now replay those 331 requests through 109
guarded chunked uploads, with 103 shared boundary refusals. Production worker transport,
asset import and native editing UI remain open. Browser clone/add-instance/fill-bed
now await the local staged transport. Clipboard paste also queues one guarded
local command that restores missing descriptors/immutable bytes atomically.
Rust now matches that library operation across 17 browser-authored traces / 130
steps, with six native boundary/fault tests and zero-payload-copy allocation
probes. WASM/JNI now expose four bounded clipboard owners per core instance.
Capture binds a current object query node and guard; paste attaches selected data
to a separately budgeted command upload with fresh destination authority. Ten
clipboard captures and 53 shared boundary refusals cover sorted projections,
stale/foreign targets, limits, source closure and retained-command lifetimes.
Six Kotlin ownership scenarios cover high-level close and transfer behavior.
Android now schedules guarded clipboard copy/paste through its bounded actor;
browser task isolation, archive import and native editing remain open.
A native session executes the existing guarded string protocol, validates exact
asset-bundle membership and settles a bounded queue; 1,380 reference requests cover
its replies and effects. Staged bulk input now reads chunked canonical JSON,
admits the graph and transfers declared payloads into immutable asset records;
2,433 independent JSON cases and an allocation probe cover this boundary. A
separate optional project WASM package now exposes uploads, sessions, immutable
effects/captures and bounded reads. Actual Node-worker replay matches all 1,380
requests and 6,137 host Date.parse cases, including retained-buffer lifetimes.
The browser runner is implemented but cannot start Chrome in this environment.
The Android project JNI binding and Kotlin owners now replay the same 1,380
requests in debug/release on the host JVM. An explicit ZoneId resolver matches
36,822 fixed-zone timestamp checks and 48 historical/DST conversions; capacity,
ownership, reentry and close races have separate coverage. Both Android ABIs
compile, but fresh APK assembly and device execution remain unqualified for this
binding. A Kotlin actor now bounds command/query, bulk preparation and guarded Open/reset work on owned
executors; ordered effect delivery precedes completion, and close preserves confirmed
outcomes while distinguishing uncertain active edits. A portable strict Kotlin
protocol parser allows the actual decoder and actor to run in JVM/JNI checks.
Opaque actor guards retain no large IDs or native handles, so valid identifiers
beyond the small wire budget still authorize bulk commands and reset. Native
reply-to-effects transfer now preserves its reserved slot at capacity. Application
integration and device scheduling qualification
remain open. Option/profile validation, remaining command families,
archive decoding and production adoption integration,
production worker transport and bounded remote projections remain open. Explicit
browser bulk export still needs task isolation. Android now freezes complete
project/asset bundles and streams them on owned export tasks; successful handoff
and a current capture are required before acknowledging a saved checkpoint.
Rust now assembles complete BBS/canonical packages from those frozen captures;
archive bindings and storage-provider handoff remain open. These APIs do not
enable Android editing.
Prepared document replacement now has Rust and WASM/JNI Open/reset bindings.
Its source guard and operation identity prevent stale or superseded input from
publishing; clean history, ordered effects and asset record identity are preserved.
Sixteen browser-authored scenarios compare 59 steps through both bindings; seven
Kotlin ownership scenarios pass. Archive decoding, production
application integration and document UI are still required for native Open.
The Kotlin actor supplies guarded preparation/commit scheduling for this seam.
Captured queries now expose nine entity kinds through WASM/JNI: paged children,
numeric inspector/transform metadata, filament inheritance and mesh declarations.
The shared schema generates Rust codes and TypeScript/Kotlin packet validators.
This removes full-document export from those reads, while paint summaries,
resolved settings, capabilities, renderer packets and revisioned subscriptions
still need implementation and production integration.

Build an adaptive native Android application for phones, tablets, Googlebook,
and Android XR while preserving the web application. Introduce Rust as a shared
implementation of selected computation and, subsequently, the canonical project
core. Keep the pinned Snapmaker Orca C++ slicing engine. Deliver the migration in
independently verifiable stages, with measured native performance and project
compatibility determining when each stage becomes the default.

This plan owns the Android and Rust migration sequence. [The parity plan](parity.md)
continues to own upstream feature scope and evidence. [GEMINI.md](../GEMINI.md)
and its engineering topic documents remain the authority for current behavior.
Implementation changes must update the relevant contracts in the same commit.

## Intended outcomes and boundaries

| Area | Intended outcome |
| --- | --- |
| Android phones and tablets | Native Compose interface, touch and keyboard input, native viewport, reliable open/save/recovery, local and external slicing |
| Googlebook | The same application adapted to resizable desktop windows, mouse, trackpad, keyboard, file handling, and multiple document sessions |
| Android XR headsets and supported wired XR glasses | Spatial panels and a spatial model workspace, with complete headset workflows and qualified input methods |
| Other browser and WebXR devices | Continue using the web application; Jetpack XR does not establish native support for every XR operating system |
| Audio and display glasses | A later, separately qualified companion experience for status and notifications; the full slicer workspace is not assumed appropriate |
| Shared behavior | One implementation per migrated capability, used through native Android bindings and browser WASM bindings |
| Slicing | The existing Snapmaker Orca v2.3.4 source pin, configuration semantics, and output provenance on every route |
| Printers | Snapmaker U1 and Elegoo Centauri Carbon through Moonraker, preserving existing command and submission safeguards |

The work does not include rewriting libslic3r in Rust, adopting a new upstream
slicer version, adding serial/USB/vendor-cloud printer backends, or implementing
native PCVR. A WebView wrapper would not satisfy the native rendering objective.
The old Android app is historical reference material; this is a new application
based on the current project and engine contracts.

## Platform evidence and decisions to validate

The following facts were checked on 2026-10-04. Recheck them when establishing
the build matrix; these are research observations, not a complete dependency lock.

| Observation | Consequence for this plan |
| --- | --- |
| Compose for XR lists `1.0.0-beta01`, released September 23, 2026, and a known problem when an Activity creates many panels | Pin a tested version and include repeated panel creation/disposal in qualification. [Release notes](https://developer.android.com/jetpack/androidx/releases/xr-compose) |
| SceneCore lists `1.0.0-rc01`, released September 9, 2026, and has custom mesh APIs | Evaluate native mesh rendering early; API availability does not prove efficient painting or toolpath rendering. [Release notes](https://developer.android.com/jetpack/androidx/releases/xr-scenecore) |
| Googlebook guidance emphasizes adaptive Android apps and desktop input/window behavior | Treat desktop usability as an acceptance surface from the beginning. [Developer guidance](https://developer.android.com/develop/adaptive-apps/guides/googlebook/overview) |
| Rust has Android and WebAssembly compilation targets | Share platform-neutral crates with separate bindings and scheduling adapters. [Target support](https://doc.rust-lang.org/rustc/platform-support.html) |
| Android native libraries must accommodate devices using 16 KB memory pages | Validate every packaged native dependency, including transitive renderer and engine libraries. [Android guidance](https://developer.android.com/guide/practices/page-sizes) |
| Android 17 enforces local-network protections for applications targeting SDK 37 or higher | Implement permission-aware Moonraker and external-slicer access; native networking is not permission-free. [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission) |

Default architecture choices in this proposal are Kotlin/Compose for platform UI,
Rust for shared domain/computation, C++ for slicing, Filament as the first flat
viewport candidate, and SceneCore as the first spatial viewport candidate.
Filament provides an Android rendering API, but its suitability for our workload
still needs measurement. [Filament project](https://github.com/google/filament).

Keep renderer implementations behind a common projection contract. If SceneCore
cannot meet the spatial editing requirements, evaluate a custom OpenXR renderer
in a separate prototype with an explicit Compose/panel integration investigation.
Do not assume a custom renderer can replace SceneCore without affecting UI
composition, depth, input, or resource ownership. This decision must precede broad
XR feature implementation.

## Repository starting point

| Current implementation | Reuse and migration responsibility |
| --- | --- |
| `web/src/project/domain/`, `store.ts`, `assets.ts`, `history/`, `session.ts` | Behavioral reference for project schema, stable IDs, revision guards, immutable assets, transactions, history, and dirty checkpoints |
| `web/src/project/ports.ts` | Starting point for host-independent import, serialization, slicing, and persistence contracts |
| `web/src/project/import/`, `serialization/`, `migration/` | Authoritative import semantics, canonical envelope, BBS projection, preserved metadata, and old-schema recovery |
| `web/src/project/objects/`, `annotations/`, `painting/`, `filaments/` | Preparation, topology, painting, and FullSpectrum behavior to migrate by feature family |
| `web/src/slicer/RichGcodeModel.ts`, `GcodePreviewSession.ts`, `WorkerGcodePreviewSession.ts` | First bounded Rust extraction: parsing, indexing, windowing, and preview projections |
| `web/src/project/slicing/`, `web/src/slicer/CanonicalSlicerClientRoute.ts` | Preflight, immutable slice capture, job lifecycle, thumbnails, and artifact freshness |
| `web/src/actions/`, `web/src/settings/`, `web/src/l10n/` | Shared action identities, capability reasons, generated settings, and localization sources |
| `web/src/persistence/`, `web/src/printer/` | Recovery behavior and printer/session/submission state machines; platform I/O remains replaceable |
| `wasm/`, `server/patches/`, `wasm/artifact-provenance.json` | Current engine build inputs and provenance; preserve exact source and route-specific patch identities |
| `testdata/parity/`, `tools/parity-oracles/`, `tools/parity/` | Existing structural and semantic comparisons; extend coverage without relabeling synthetic fixtures as hardware evidence |
| `scripts/build_native.sh`, `docs/historical/android-slicer-notes.md` | Retired upstream-v2.3.2 Android work; inspect useful NDK/JNI lessons but do not run it as the production Snapmaker build |

At the plan baseline there was no active Gradle application or Cargo workspace.
The initial development implementations now exist under `android/` and `core/`;
their exact verification scope is recorded in the linked engineering document.
The project command bus is synchronous and accepts executable command objects;
introducing a worker-backed Rust core therefore requires an API migration, not
just replacing imports. Current browser slicing also has a fixed 256 MiB shared
heap and ten engine workers. Neither that allocation nor historical desktop
timings can be treated as a native-device memory or speed guarantee.

See [project contracts](engineering/project-contracts.md),
[large-model contracts](engineering/large-models.md),
[runtime contracts](engineering/runtime-and-deployment.md),
[XR contracts](engineering/xr-and-ui.md), and
[slicing constraints](engineering/slicing.md) before implementing their areas.

## Target architecture

```mermaid
flowchart TD
  Web[Web UI and WebXR] --> WebHost[TypeScript host and worker adapters]
  Android[Adaptive Compose UI] --> AndroidHost[Kotlin host adapters]
  XR[Compose for XR UI] --> AndroidHost
  WebHost --> Wasm[Rust WASM bindings]
  AndroidHost --> JNI[Rust Android bindings]
  Wasm --> Core[Shared project and computation core]
  JNI --> Core
  Core --> Projection[Immutable viewport and preview projections]
  Projection --> Three[Three and XRBlocks adapter]
  Projection --> Flat[Native flat viewport adapter]
  Projection --> Spatial[SceneCore spatial adapter]
  WebHost --> BrowserEngine[Existing C++ WASM engine worker]
  AndroidHost --> Service[Owned Android slicer service process]
  Service --> NativeEngine[Pinned C++ engine through JNI]
  WebHost --> Server[Existing attested slicing server]
  AndroidHost --> Server
```

The diagram describes code ownership, not one shared runtime across devices.
Each open project session has its own authoritative core. Browser workers,
Android processes, and separate devices communicate through versioned messages
or project files; they do not share raw pointers or implicitly synchronize edits.

### Proposed repository layout

The following paths are new deliverables, not existing commands or modules:

```text
core/
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  crates/
    orcaxr-contracts/       # Protocol types, errors, capabilities
    orcaxr-project/         # Stable IDs, graph, history, settings, guards, sessions
    orcaxr-archive/         # Model import, canonical and BBS 3MF codecs
    orcaxr-geometry/        # Mesh representation, picking, paint computation
    orcaxr-gcode/           # Parser, index, bounded preview projections
    orcaxr-workflows/       # Shared slice and printer policy/state machines
    orcaxr-wasm/            # Browser bindings only
    orcaxr-android/         # Android JNI bindings only
android/
  app/                     # Application composition and distribution
  core-bridge/             # Kotlin API to the Rust session
  engine-service/          # Process ownership and IPC
  engine-jni/              # Narrow C++ entry points
  platform/                # Documents, recovery, permissions, networking
  renderer-flat/           # Native viewport implementation
  renderer-xr/             # SceneCore adapter and XR lifecycle
  ui-adaptive/             # Phone, tablet, desktop Compose screens
  ui-xr/                   # Spatial layouts and input
  benchmark/               # Device journeys and performance capture
  gradle/libs.versions.toml
contracts/                 # Versioned transport schemas and shared manifests
tools/cross-platform/       # Contract replay, artifact checks, benchmarks
testdata/cross-platform/    # Redistributable fixtures and expected traces
```

Create modules when their implementation starts. Keep the project and computation
crates free of Android, DOM, Three, networking clients, renderer objects, and
libslic3r linking requirements. The native engine remains a separate build so
changes to UI or Rust logic do not rebuild OrcaSlicer unnecessarily.

### State and command ownership

Every project mutation goes through one session command gateway. A request carries
protocol version, session generation, request ID, expected revision, and a typed
command payload. A response carries the committed revision, canonical identities,
history/dirty status, capability changes, and bounded projection deltas.

Use a versioned schema under `contracts/` as the wire-format authority, with
generated host types and runtime validators. Keep transport protocol version,
persisted project schema version, core ABI version, and engine identity distinct.
A core/host handshake checks their supported ranges before opening a session.
Host transports own authentication and I/O; the core returns typed effects and
consumes identity-bound results, keeping network availability out of domain tests.

Convert executable TypeScript commands into serializable intents incrementally.
First introduce an asynchronous facade backed by today's TypeScript command bus;
then implement the same facade over Rust. UI handlers must await acknowledgement
and handle rejection. A drag or stroke may display a temporary projection while
work is pending, but only the core can commit it. Cancel, stale revision, changed
topology, or failed validation discards that temporary projection.

Transactions carry a bounded list of typed operations. They cannot contain a
callback that crosses the worker/JNI boundary. Preserve atomic rollback,
selection restoration, command coalescing, history retention, no-op behavior,
dirty categories, and monotonic revisions, including failed-command behavior.

Never switch authoritative implementations in the middle of a live session.
Switch through a verified snapshot after pending work settles, or at application
startup. During migration a session uses either the TypeScript core or the Rust
core. Differential test runners may execute both on isolated fixtures; production
does not dual-write project state.

### Data and compatibility contracts

Document the existing canonical encoding before implementing it in Rust. Equality
must cover UTF-16 code-unit key ordering, JSON escaping and surrogate handling,
JavaScript-compatible finite-number formatting, negative zero, array order, IDs,
unit conventions, and binary mesh endianness. Rust's default string ordering and
JSON formatting are not sufficient evidence of compatibility.

Preserve the distinct FNV-1a64 semantic/source identities and SHA-256
project/configuration/artifact identities exactly where each is currently used.
Add cross-language fixtures for every identity boundary. Pass 64-bit values
through JavaScript as explicitly encoded values, never lossy Numbers.

Maintain the existing canonical envelope and BBS semantics, including unknown
members, component relationships, plate-local transforms, scoped overrides,
physical/mixed filament IDs, refined facet version 2, and authored profiles.
No file-format bump is required merely because implementation language changes.
If a genuinely incompatible feature requires one, introduce an explicit migration,
read compatibility, and recovery/rollback policy before publishing it.

Keep current archive bytes identical where deterministic writer bytes are part
of the contract. Where compression or nonsemantic container metadata changes,
require structural/semantic equality and an explicit reviewed change to byte-level
expectations; the output must still carry the digest of its actual bytes.

### Buffer ownership and concurrency

Use packed mesh and preview columns with checked lengths, strides, offsets, and
topology identities. Bulk data crosses a boundary once per owned operation where
possible. Measure copies explicitly; do not call a transfer zero-copy merely
because it uses a direct buffer or a typed array.

In Android, use generation-checked handles and explicit close/cancel lifetimes.
JNI retains a native buffer until its consumer and any GPU upload have finished.
Catch C++ exceptions at the C++ boundary, prevent Rust unwinding across JNI/C ABI,
and return bounded typed errors. Check callbacks arriving after session disposal.

In the browser, keep expensive computation in owned workers. WASM memory growth
invalidates borrowed views, so bindings must reacquire views or copy into owned
transfer buffers before returning. Ordinary ArrayBuffer transfers must work
without cross-origin isolation; optional shared-memory acceleration is separately
qualified. Rust WASM and the C++ WASM engine initially have separate heaps, so
budget archive transfer and peak coexistence explicitly.

Publish the Rust browser module and its binding glue as one versioned, verified
asset set. Extend the existing cache/update and provenance checks so a service
worker cannot combine a new host with stale WASM. Preserve the unsaved-work guard
on updates and test offline startup, missing assets, and rollback. Local Android
core/engine manifests must similarly identify the libraries actually packaged
and loaded, not unrelated build-directory copies.

The canonical session worker must not run an uninterruptible long parser or
geometry operation. Schedule bounded chunks or dispatch expensive work to owned
task workers operating on immutable captures. Cooperative cancellation handles
normal work; forced task-worker termination cannot discard the authoritative
project session. Limit concurrent import, preview, save, and slice work according
to a single host resource policy.

### Rendering contracts

Rendering consumes project projections and cannot modify authoritative geometry
or configuration. Use one explicit millimetre-to-metre and axis/handedness
conversion per platform adapter, with fixtures for transforms, normals, winding,
nonuniform scale, picking rays, and mirrored geometry.

Geometry assets have immutable topology IDs. Transforms, selection, and palette
changes update only the relevant projection. Painting previews update bounded
overlays or attribute ranges; avoid rebaking and reloading an entire GLB per
stroke. Validate the actual SceneCore buffer/material capabilities before
committing to that implementation. Flat rendering must work on non-XR devices
without initializing an XR session.

Qualify vertex/index limits, facet-color representation, GPU chunking, clipping
planes, transparency, and instancing on both renderer candidates. Pin any shader
or material compiler to its runtime version and package its generated assets for
offline use. Renderer simplification may reduce display detail, but must retain
selection/topology mapping and cannot alter the authoritative slice geometry.

G-code renderers consume the shared projection's colors, filters, semantic record
IDs, and bounded path data. They do not independently classify extrusion roles or
invent statistics. Keep thumbnail creation platform-specific, but attach its
bytes before final artifact hashing and preserve the engine sidecar binding to
the final published artifact.

### Engine and job contracts

Build Android from Snapmaker Orca v2.3.4 commit
`9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`. Separate common behavior patches from
platform build adaptations in a reviewed build-input manifest. Android patches
must not be silently added to the exact CLI patch set expected by existing
clients. Define a new native-Android engine identity and explicit compatibility
rules while retaining fail-closed checks for older routes.

Use a narrow JNI adapter accepting an immutable canonical slice capture and its
verified BBS archive/configuration inputs. Return typed progress, cancellation,
diagnostics, G-code, and statistics sidecar. Do not substitute geometry-only STL
or the retired profile loader. FullSpectrum and all annotation channels must
reach the same pinned engine behavior as web/server slicing.

Run libslic3r in an application-owned, non-exported service process so an engine
crash does not take down the editor. This is process separation, not an assumed
Android isolated-process sandbox. Start with one local slicing job at a time.
Pass large input/output through private staged files or file descriptors; Binder
messages carry metadata and progress, not entire models or G-code.

Successful native return alone does not publish a file. Close/flush the owned
output, verify type/size/digest/sidecar, revalidate job and project identities,
then make the result available. On cancel, request cooperative engine stop, then
terminate only the owned service process after a bounded deadline if necessary.
Wait for that generation's process death before releasing capacity or starting
another job. Retain the editor's snapshot and distinguish interrupted, failed,
cancelled, and unknown outcomes.

A service is not a promise of unlimited background execution. Phase 6 must choose
and verify a permitted execution model for long local slices. Foreground-service
types and restrictions apply; `specialUse`, if needed, requires a documented use
case and Play review. Do not disguise slicing as media processing or assume
WorkManager removes those restrictions. If a distribution target cannot support
continued local work in the background, expose that limit and preserve explicit
external slicing. [Foreground service guidance](https://developer.android.com/develop/background-work/services/fgs/service-types).

### Persistence and transport contracts

Platform adapters own actual I/O. The core owns dirty state, exact save guards,
import transactions, and eligibility to publish or submit a slice.

Android uses document-provider APIs for user files and app-private storage for
recovery. Stage writes and atomically replace app-private records where supported;
arbitrary document providers cannot be assumed to support atomic replacement,
seek, fsync, or local filesystem paths. A failed save never clears dirty state.
A provider's successful write/close is reported as provider acknowledgement,
without promising physical disk durability beyond that provider's contract.

Preserve the existing five-second idle/thirty-second maximum recovery scheduling,
three snapshots per project/session, and initial 512 MiB recovery budget until
measured changes are deliberately specified. Preserve unknown future schemas,
validate identity before restore, and reopen recovered projects as dirty. Separate
sessions must not silently overwrite each other's document or recovery lineage.

Moonraker HTTP/WebSocket transport lives in Kotlin on Android and TypeScript on
the web. Shared workflow code owns session generations, readiness, tool mapping,
artifact freshness, command guards, and uncertain submission outcomes. Native
external-slicer requests authenticate as native clients; never fabricate browser
origin headers to claim the server's same-origin authorization.

## Migration stages

| Stage | Production authority | What changes |
| --- | --- | --- |
| A | Existing TypeScript project and C++ slicing | Add contracts, fixtures, native experiments, and measurements |
| B | TypeScript project, Rust leaf computation | Replace preview and measured geometry operations behind existing ports; Rust has no separate project state |
| C | TypeScript by default; Rust project in isolated qualification sessions | Replay identical command/import/save traces and compare every committed result |
| D | Rust project for complete, qualified sessions | Browser and Android use the same core implementation; TypeScript remains a controlled rollback adapter during a defined compatibility window |
| E | Rust project for supported production releases | Remove replaced runtime implementations after qualification; retain independent golden fixtures and oracles |

Do not activate Stage D for a project that needs an unimplemented command, import
format, setting scope, or recovery schema. Inventory that coverage before session
creation. During internal development, unsupported capabilities are explicit;
native production release requires the feature coverage described in Phase 10.

## Phase 0 Establish scope and measurable baselines

**Dependencies:** none. **Deliverables:** fixture inventory, device matrix,
baseline report, and resolved build/release assumptions.

- [ ] Inventory every implemented workflow and current explicit limitation from
  the action registry and parity evidence. Record the source commit so later web
  improvements cannot disappear from native scope unnoticed.
- [ ] Define reference devices: an ARM64 phone, tablet or large-screen device,
  Galaxy XR, Googlebook hardware when available, and an x86_64 emulator/desktop
  environment. Record OS, GPU, RAM, refresh rate, page size, and input devices.
  Emulator evidence never closes a physical-device gate.
- [ ] Select redistributable small, medium, and large fixtures, including roughly
  two million facets with substantial paint, repeated instances, multiple plates,
  FullSpectrum recipes, malformed archives, and large/arc-heavy G-code. Generate
  synthetic stress assets; keep private models outside Git.
- [ ] Record web load/import time, first useful frame, drag/paint latency, command
  commit time, preview indexing/window time, slice duration, cancellation,
  recovery duration, total process memory, and thermal behavior.
- [ ] Capture both local-WASM and external-slicer journeys. Compare native and
  web on the same physical device, files, profiles, engine inputs, and conditions.
- [ ] Fix a compatible AGP/Gradle/JDK/Kotlin/Compose/XR/NDK/Rust toolchain matrix
  after a minimal build; choose minimum/target SDK deliberately. Do not assume
  XR artifact versions align or let optional XR support exclude ordinary devices.
- [x] Inspect historical application ID/signing/storage expectations before
  selecting upgrade versus separate-install behavior for retired APK users.
  Record the result without assuming old data is compatible.
  Historical commit `7f16e6b` establishes the old ID; the new development app uses
  a separate ID and does not migrate old storage. Signing/publication remain
  release work. See [build decisions](engineering/native-core.md#build-decisions).

**Exit gate:** published baseline inputs and repeatable measurement procedure;
numeric device memory ceilings and support limits are recorded before optimization.
Unowned hardware is an explicit qualification dependency, not simulated success.

## Phase 1 Add build foundations and shared contracts

**Dependencies:** Phase 0. **Deliverables:** minimal Android application, Rust
workspace, versioned protocol, CI jobs, and cross-language test runner.

- [ ] Add pinned Gradle wrapper/toolchain, version catalog, dependency verification,
  Cargo lockfile/toolchain, Android manifests, and release/debug configuration.
  Build `arm64-v8a` and `x86_64`; qualify each actual device ABI before claiming it.
- [ ] Create a minimal Compose Activity and an optional XR feature boundary.
  Verify installation and startup on a non-XR emulator without loading XR runtime
  services, model files, or the slicing engine. Check manifest feature declarations
  and package filtering so optional XR/camera capabilities do not exclude phones
  or Googlebook from installation.
- [ ] Implement a small Rust operation through Android JNI and browser WASM.
  Use direct JNI for the initial narrow Android boundary and wasm-bindgen for
  browser exports; pin binding tools and generated artifacts together. Validate
  error propagation, disposal, cancellation tokens, and buffer accounting.
- [x] Define versioned command/result/error schemas and generate TypeScript and
  Kotlin types. Keep runtime validation at untrusted boundaries; generated types
  alone do not validate messages. Unknown protocol versions fail explicitly.
  Establish the schema generator's authority and require a clean regeneration
  diff, including Rust types, before either host can change its message shape.
- [x] Add cross-language trace fixtures for IDs, number encoding, hashes, mesh
  layouts, and errors. Include non-BMP names, control characters, malformed
  surrogate input, empty payloads, large sizes, and stale generations.
- [ ] Extract action/settings/profile/localization manifests from current
  authorities for Android packaging. Check generated output instead of manually
  copying inventories. Package required assets for offline use.
- [ ] Extend CI with host Rust tests, WASM browser tests, Android assemble/lint/JVM
  tests, binding regeneration checks, dependency checks, and artifact provenance.
  Keep the existing web/server/WASM gates unchanged.

**Exit gate:** a clean checkout builds the minimal app and both Rust targets;
native/WASM contract vectors agree; incompatible binaries/messages are rejected.

## Phase 2 Prove native rendering and engine feasibility

**Dependencies:** Phase 1. **Deliverables:** measured viewport experiments,
Snapmaker NDK build proof, and an explicit renderer decision.

- [ ] Render the same packed mesh fixture in a flat Filament candidate and a
  SceneCore candidate. Include transforms, selection, clipping, instancing,
  per-facet colors, transparency, and a representative toolpath window.
- [ ] Exercise continuous picking and paint overlays on the large fixture.
  Measure upload size/count, draw calls, frame pacing, memory, and update latency.
  Inspect actual SceneCore APIs for mutable attribute/material support; do not
  infer update behavior from static model-loading demonstrations.
- [ ] Test context loss, Activity recreation, Home Space/Full Space transitions,
  panel creation/disposal, hidden UI, and repeated scene teardown. Account for
  CPU and GPU buffers retained by each renderer.
- [ ] Cross-compile the current pinned Snapmaker engine from a clean source tree
  for both initial ABIs. Audit the old TBB allocator, threading, POD initialization,
  JNI lifetime, and NDK compiler issues against this fork before reusing any patch.
- [ ] Slice fixed canonical fixtures through a minimal native adapter and compare
  outputs with the current routes. This fixture harness does not introduce a
  second editable project model or legacy profile implementation.
- [ ] Check 16 KB alignment and dependency loading in the installed APK. Confirm
  required geometry libraries and engine operations can be packaged within the
  selected distribution format.
- [ ] Record the flat/spatial renderer selection and any required alternative
  prototype. Resolve blockers before building the full XR interface.

**Exit gate:** real-device proof of usable mesh/toolpath updates and a valid slice
from the current engine. A cube render or successful linker invocation alone is
insufficient. Document measured benefits and remaining limits without promising
that native code automatically reduces total memory.

## Phase 3 Move G-code computation into Rust

**Dependencies:** Phase 1; use Phase 2 renderers for native integration.
**Deliverables:** shared parser/index/projection and production browser adapter.

- [x] Port the current rich parser's modal state, source spans, tools, extrusion
  roles, layer handling, statistics observations, and bounded diagnostics.
  Preserve UTF-16 source-offset semantics where the existing browser API exposes
  them, or version an explicit byte/character offset translation.
- [x] Preserve one semantic record per G2/G3 source command, exact Float32 operation
  order, bounded interpolation, cap failures without partial arcs, and unsupported
  metadata reporting. Do not enable compiler optimizations that change required
  floating-point behavior without differential proof.
- [x] Implement streaming source/index ownership and checkpointed windows with
  the existing maximum of 240,000 rich records per window. Keep huge layers
  traversable and release previous sources on replacement.
- [ ] Port preview filtering/color projection and bounded inspection/search
  behavior. Keep engine-authoritative statistics distinct from parser observations.
  - [x] Implement twelve-mode projection, bounded inspection and playback with
    independent source/window expectations and WASM/JNI session bindings.
  - [x] Implement bounded readable-text windows and line search in Rust with
    WASM/JNI bindings; 1,536 windows and 18,710 searches match the production
    browser through the library, session transport and Chrome WASM. Per-line
    folding also fixed a browser defect that moved results onto wrong lines.
  - [ ] Replay the search corpus through Android JNI on an emulator or device.
- [ ] Replace the browser worker implementation behind its existing session
  interface; account for source conversion and WASM transfer overhead in benchmarks.
  Keep a startup-selectable reference adapter during qualification.
  Browser integration and packaged/offline loading now exist; the production
  regression exercises both adapters including conversion and transfer. This
  task remains open for the required repeated device performance measurements.
  - [x] Integrate the production worker adapter, startup rollback selection and
    verified offline asset loading; exercise both adapters in browser regressions.
  - [ ] Complete repeated performance measurements on the reference devices.
- [ ] Bind the same library to Android and render the resulting columns through
  the native viewport. Verify identical semantic IDs and projections across hosts.
- [ ] Add fuzz/property tests for malformed numbers, huge lines, truncated arcs,
  unsupported commands, invalid UTF-8, and allocation caps; retain independent
  expected results so both adapters cannot agree on the same new bug unnoticed.

**Exit gate:** differential fixtures and existing preview tests pass; memory and
latency budgets pass on browser and native targets; cancellation and repeated-open
tests show bounded resource use. Retire the old parser from production only after
the rollback window defined in Phase 11.

## Phase 4 Migrate project state and command execution

**Dependencies:** Phase 1 and the binding lessons from Phase 3.
**Deliverables:** asynchronous facade, Rust session, generated command bindings,
and replay coverage for the complete current command inventory.

- [ ] Introduce the asynchronous command/query facade over the current TypeScript
  implementation. Update action handlers, drag/stroke completion, imports,
  settings commits, undo/redo, autosave, and slice capture to await authoritative
  results. Keep all mutations behind ActionRegistry's invocation boundary.
  The local facade, production Undo/Redo and seven plate lifecycle routes exist,
  including acknowledgement-aware UI and guarded Objects reveal. Generated
  request/reply messages now serve these operations through an in-process string
  adapter with handshake, cancellation, close and bounded queue ownership. The
  object/part rename, instance printability, single/batch transforms and derived
  placement routes now await that adapter too. DOM/XR gestures keep one dispatched
  command and one latest pose, chain only acknowledged guards, and invalidate on
  every selection change, tool replacement or disposal. Release waits for final
  settlement; cancellation and lost replies never roll back or retry committed
  work. Multi-instance printability retains separate undo entries and reports
  partial completion. Controller, registry and presentation regressions cover
  these transitions. Numeric inputs and DOM/XR transform gestures now pass every
  dispatched edit through declared registry surfaces, preserving actual receipts
  and original availability refusals. DOM lay-on-face uses its scene action;
  the unfinished XR lay-on-face scene interaction remains undeclared. Object and
  instance deletion, plate clearing, cut and instance conversion now await their
  registered actions too; independent duplication and plate movement have guarded
  async controller APIs. Duplicates return captured operation summaries, and cut
  keeps its completed clipboard copy on failed/uncertain deletion without late UI
  publication. Clone/add-instance/fill-bed now await measured staged work through
  their registry actions. Guarded full-record capture precedes submission; fill
  retains one transaction even above 64 commands. Captured operation summaries,
  stale/closed refusal, failed-member rollback, pool exhaustion and uncertain
  acknowledgements have controller and presentation coverage. Clipboard paste now
  follows that local route with immutable selected asset captures and atomic
  restoration, including SVG drawings. Project and scoped settings commits from
  the DOM settings panels and the wave-overhang card now submit
  `setProjectSettingsOverrides` and `setScopedOverrides` intents through the same
  adapter, the intents a native settings session returns. Stale guards, unknown
  nodes and out-of-scope keys refuse with the browser's own errors before
  submission; the synchronous workspace settings wrappers are gone. Height-range,
  part-role and layer-event edits (with the height-range and negative-part tools
  and the headset's layer-event author, now through its registry action) submit
  their intents the same way, validating each command before submission, as do
  filament assignment, filament remapping, wipe-tower placement and the virtual
  filament library (add, edit, duplicate, enable, delete and automatic-pair
  reconciliation). An edit or delete that reconciles automatic pairs stays one
  transaction: the reconciliation is computed on a scratch store from the edited
  state and guarded by the revision and fingerprint it will meet. Helper volumes,
  magnet holes and split-to-parts/objects carry their new mesh bytes as measured
  staged work (within the clipboard's asset budget); adaptive layer heights and
  volume separation submit intents, as do brim ears and adopting a printer's
  loaded filaments (with its new filament IDs drawn before submission). Mesh
  simplification, repair, Boolean results and embossed-text and SVG parts
  (added or re-cut) carry their new meshes as staged work too. Facet painting
  commits each stroke as a facetStroke intent (refined strokes as staged work),
  and a Smart Paint mask commits its regions as one labelled transaction, each
  guarded by the scratch-store state the region before it leaves. Profile,
  nozzle and filament-slot changes commit as staged project replacement through
  one serialized queue: each commit reads the live profile and the acknowledged
  state when it runs, a stale refusal recomputes rather than rebases, and what
  reads the committed configuration refreshes on acknowledgement. Primitives,
  library and calibration models and single-gauge placement add their object and
  mesh bytes as staged work, identical bytes stored once. In
  process, a command the session refuses reports the browser's own error; the
  wire still carries only `commandFailed`. Other workflows, remote projections
  and production worker/JNI execution are not migrated yet. Browser capture and
  placement planning still run synchronously.
  - [x] Route the plate/history, rename, transform and specified lifecycle/staged
    browser actions through guarded asynchronous acknowledgements.
  - [x] Route project and scoped settings commits through guarded settings
    intents.
  - [x] Route height-range, part-role and layer-event edits through guarded
    intents, keeping the browser's own refusal messages in process.
  - [x] Route filament assignment, filament remapping, wipe-tower placement and
    the virtual filament library through guarded intents.
  - [x] Route helper volumes, magnet holes, splits and adaptive layer heights
    through guarded intents and measured staged work.
  - [x] Route brim ears and printer filament adoption through guarded intents.
  - [x] Route mesh simplification, repair, Booleans and emboss/SVG parts through
    measured staged work.
  - [x] Route facet painting, erase-all and Smart Paint through guarded intents
    and staged refinements.
  - [x] Route profile, nozzle and filament-slot changes through serialized staged
    project replacement.
  - [x] Route primitive, library and calibration model adds through staged work.
  - [ ] Migrate remaining editing/import/save/slice routes and isolate
    preparation work; preserve the registry boundary for every mutation.
- [ ] Port domain schemas, validation, IDs, canonical formatting/hashing,
  immutable asset repository, selectors, and session lifecycle into Rust.
  Use immutable shared asset ownership and bounded history; transform/undo must
  not copy mesh payloads. The Rust project crate now ports stable UTF-16 IDs,
  branded entity families, injected UUID generation and immutable asset ownership
  with independent TypeScript fixtures. Asset traces compare public/internal
  restoration, metadata/content fingerprints, record/version identity and failures;
  an allocation probe verifies mesh bytes are shared through history snapshots.
  Five-channel facet validation, split lookup/visitation, normalization and
  paint-preserving remapping also exist in Rust, with independent TypeScript
  traces and a sparse-allocation probe. Typed schema-1 candidates now retain every
  modeled field and unknown metadata, share immutable child/paint allocations,
  stream full-state fingerprints and provide empty-project construction plus
  graph lookup, topology comparison and filament inheritance selectors. Independent
  references cover 33 record layouts, 11 literal domains, 11 full states, four
  factories and five direct candidate edits. These are not command traces.
  Project configuration selectors now also preserve engine precedence, ignored
  settings and local/inherited/source projections through the shared scope table.
  Semantic graph validation and a separate immutable admission type now exist,
  with 622 independent reference states, explicit host timestamp policy and a
  sparse allocation probe. The browser's unknown-channel and shared-range
  diagnostics now survive save/reopen. Native project and selection stores now
  own admitted snapshots, monotonic revisions, content equality and ordered
  selection state. Immutable receipts expose committed changes to the native
  session; 311 independent trace steps cover replacement, rollback, refusals,
  guards, full content, allocation identity and selection. Session dispatch,
  complete live projections and production worker/JNI project transport remain open. The native
  session now owns an admitted graph, checks exact repository metadata/membership,
  and interprets the existing string protocol through a 32-request queue. It binds
  generation/project/asset/history guards, settles cancellation and close, keeps
  rollback effects with failures, and distinguishes unavailable post-commit
  summaries from failed operations. An independent endpoint corpus has 1,380
  requests in 1,306 groups over 60 traces, plus eight bundle-admission cases.
  Host-local save acknowledgement checks the serialized identity and owner;
  history-only changes remain valid saves but invalidate queued command guards.
  Native staged input now accepts chunked UTF-8 canonical documents under explicit
  resource budgets, admits their graphs, and checks declared asset payloads before
  transferring ownership into an immutable repository. It supports large documents
  independently of stateless request limits. The optional project WASM binding
  now transfers documents/assets, opens guarded sessions and returns immutable
  effects/captures. Node-worker replay compares full state and ordered effects
  for the 1,380-request corpus; 91 refusals and 6,137 Date.parse cases check host
  boundaries. Browser execution remains unqualified. Android now has the same
  session endpoint through JNI, Kotlin capture owners and an explicit host timezone
  service. Debug/release JVM replay passes the full session corpus, 75 refusals,
  36,822 fixed-zone timestamp checks, 48 historical/DST cells and nine Kotlin
  ownership scenarios. Prepared immutable bundles now support guarded Open/reset
  through Rust, WASM/JNI and Kotlin owners. Sixteen independent browser scenarios
  compare 59 lifecycle steps, including superseded/failed Opens, edits during
  preparation, selection/history-only changes, equal resets and history clearing.
  Atomic commit moves admitted records and checks source/operation identity;
  source leases, repository ownership and protocol counters remain valid. Archive
  decoding, dirty confirmation, Android runtime qualification and crash recovery
  remain open. A Kotlin actor now owns bounded command/query execution and guarded
  Open/reset and bulk command preparation, with separate authority, preparation
  and ordered-effect workers. Its original twelve real-JNI host scenarios cover
  cancellation, stale/superseded Opens, rollback, close and twenty open/edit/close
  cycles. Sixteen additional scenarios cover native preparation quotas, immutable
  source snapshots, pool charges, reset history rules, oversized IDs and twenty
  staged-edit/undo cycles. The independent 70-instance fixture matches its complete
  receipt/effect sequence through the actor. Reply-to-effects conversion reuses its
  reserved slot. Open/reset also retain confirmed adoption when resource pressure
  prevents the optional summary query; callers can query again after freeing handles.
  Clipboard selection/capture now runs on preparation workers from immutable
  guarded source versions; paste uploads own selected data across clear/replacement.
  Thirteen additional JNI checks and two complete TypeScript fixture comparisons
  cover this actor flow. Export now freezes project/assets together and streams
  JSON through bounded JNI callbacks on a preparation worker. Complete bundle
  consumption and successful host handoff precede save acknowledgement; edits keep
  the checkpoint stale, while history-only changes remain valid. Confirmed handoff
  survives unavailable checkpoint resources and projection failure. Thirteen
  shared host/device scenarios cover byte agreement, all UTF-16 units, concurrent
  changes, limits, cancellation and close. Archive bindings, storage-provider
  handoff, native application integration and live projections still need complete
  workflows. Browser full JSON export still requires owned task isolation.
  - [x] Port lossless IDs/schema-1 records, asset ownership, graph admission,
    fingerprints, project/selection stores and guarded session execution.
  - [x] Implement bounded staged input and guarded prepared-document Open/reset
    through Rust/WASM/JNI; compare all 59 independent lifecycle steps.
  - [x] Implement Kotlin actor ownership for commands, preparation, clipboard and
    export with host JVM/JNI lifecycle/failure checks.
  - [ ] Integrate live application projections, archive adoption, recovery and
    Android runtime qualification; isolate browser bulk export work.
- [x] Port commands and transaction/history semantics by family, preserving
  rollback revision behavior, coalescing, checkpoint acknowledgement, selection,
  and history retention accounting. Test every command's failed and stale cases.
  Every browser command class now has a native port. Each replays browser-authored
  traces: prepared intents (67 traces / 1,659 steps), captured records (11 / 197),
  clipboard (17 / 130), payload-carrying commands (24 / 348) and staged work
  (56 / 934). The history below records how the families arrived.
  The native command owner first executed nineteen prepared intents: seven plate
  commands, three entity renames, instance printability, single/batch transforms,
  object/instance deletion, plate clearing, independent object duplication,
  cross-plate movement and conversion of an instance to an independent object.
  An independent TypeScript corpus covers 1,108 steps in 51 traces, comparing full
  states, hashes, revisions, selection, ordered effects, history and asset identity.
  It includes exact UTF-16 retention thresholds, failed preparation versus failed
  execution, plate limits, metadata duplication, no-ops, undo/redo, gesture
  coalescing, optional names, imported metadata and atomic batches. Lifecycle
  traces cover neighboring selection, empty-plate history, ID collisions, shared
  asset retention and conversion's intentionally narrower instance record.
  Two additional local commands now capture full instance/clipboard records;
  197 steps across 11 independent traces cover metadata ownership, insertion
  order, paste after source deletion, exact retention, graph failures and atomic
  70-instance batches. Separate chunked record input has explicit operation
  budgets and preserves complete UTF-16/unknown fields. Local history no longer
  inherits the small wire protocol's batch/label limits; generated admission
  limits remain unchanged. Session-owned staged handles now retain the original
  preparation guard, charge both ready and queued work under explicit limits and
  release payloads immediately on cancellation/close. Generated execute/release
  references and the local asynchronous adapter preserve one-use ownership and
  uncertain outcomes. A separate 32-trace / 331-request endpoint corpus compares
  those transitions against TypeScript, including atomic 70-command batches.
  Eight native and sixteen browser-host tests cover limits, stale guards, large
  records, immediate release and lost acknowledgements. Encoded input charges
  do not replace resident-memory budgets. WASM/JNI now expose a separately budgeted
  chunked upload contract: four preparations per core instance retain the original
  guard through reading, sealing and one-use transfer. Both bindings replay 109
  uploads / 331 requests, with 103 shared refusal cases; seven Kotlin ownership
  scenarios check consumed handles and ready-reference cleanup. Two native tests
  additionally cover concurrent preparation limits, full metadata beyond the
  small wire ceilings, exact option bounds and permit release on every failure.
  The browser's clone/add-instance/fill-bed routes now use the local staged adapter,
  with 23 controller cases and acknowledgement-aware registry/presentation checks.
  Clipboard paste now adds 13 browser controller checks for reset/deletion,
  stale/closed guards, uncertain replies, newer clipboard ownership and 3MF
  save/reopen; eleven asset tests check bounded subsets, conflicts, rollback,
  exact record retention and zero mesh copies. Rust now ports the asset-bearing
  operation with 17 browser-authored traces / 130 steps comparing contents,
  ordered effects, asset identity and exact input/history charges. Six native
  tests exercise capture limits, source consistency, foreign ownership and
  retryable apply/undo/redo failures. A release probe runs twenty cycles over an
  8 MiB asset without payload-sized allocations. WASM/JNI now expose bounded
  clipboard owners captured from current object query nodes and session guards.
  Paste uploads attach immutable selected data; their JSON carries only new IDs
  and a destination. Ten captures, 53 shared refusals and six Kotlin ownership
  scenarios check sorted projection targets, stale/foreign owners, quota release,
  source closure and retained-command lifetimes. Production document adoption
  integration remains required. The Kotlin actor now schedules ordinary staged
  command uploads with guarded immutable source captures, bounded workers and
  cancellation, then admits and executes each input once. Clipboard preparations
  share the four-owner native quota with completed captures and scan frozen sources
  outside the authority. Publication checks the original guard and latest copy/clear;
  paste captures selected data before its producer starts. Clear/replacement keeps
  accepted pastes valid while refusing new uses of obsolete clipboard identities.
  Thirteen JNI scenarios and two independent fixture replays cover the host flow.
  These libraries do not enable
  the Android editing UI.
  Native fault tests exercise failures after publication, undo/redo retries,
  coalescing/estimation failure and reserved rollback capacity. Other command
  families, production worker/JNI project transport and editor integration remain
  unimplemented; this does not close the command inventory or Phase 4 exit gate.
  - [x] Port the nineteen prepared intents and local full-record creation/paste,
    including asset-bearing clipboard restoration, undo/redo and rollback.
  - [x] Replay the ported session/staged families through WASM and host JNI and
    verify bounded upload/clipboard ownership and failure settlement.
  - [x] Port the five layer-range intents (`addLayerRange`,
    `editLayerRangeBounds`, `splitLayerRange`, `mergeLayerRanges`,
    `deleteLayerRange`): the browser command corpus (1,162 steps, 54 new) and
    session/WASM/JNI replays agree, including refusal messages and selection
    repair. Ranges are created empty over the wire; settings and filaments stay
    with their scoped commands.
  - [x] Port the three layer-event intents (`addLayerEvent`, `editLayerEvent`
    with keep/clear/value field patches, `deleteLayerEvent`): the corpus (1,226
    steps, 64 new) covers every event type, graph-validation refusals (height,
    duplicate height key, tool index, custom code, plate, ID reuse), foreign-field
    stripping on edit, plate deletion and transactions; session/WASM/JNI agree.
  - [x] Port the four brim-ear intents (`addBrimEar`, `addBrimEars`,
    `removeBrimEar`, `clearBrimEars`): the corpus (1,267 steps, 41 new) keeps the
    browser's undo quirks (undoing one placement pops the last ear; undoing a
    clear that removed nothing publishes no project change; an emptied list drops
    the key) and its radius/index/object refusals; session/WASM/JNI agree.
  - [x] Port the four layer-height intents (`adjustLayerHeightProfile`,
    `smoothLayerHeightProfile`, `adaptiveLayerHeightProfile`,
    `resetLayerHeightProfile`) with the pinned `Slicing.cpp` profile algorithms.
    Adaptive reads the first volume's mesh in the session (the browser command
    and workspace now do the same), and both engines bound the work (object
    height, layer count, smoothing radius) instead of looping on extreme input.
    The corpus (1,338 steps, 71 new) matches bit for bit through a V8-exact
    `js_math` (fdlibm sin/cos/exp, V8 hypot), which also corrects the AMF
    rotation decoder; session/WASM/JNI agree.
  - [x] Port the seven filament intents (`setFilamentAssignments`,
    `setObjectFilament`, `setVolumeFilament`, `setLayerRangeFilament`,
    `remapFilaments`, `setFilamentEnabled`, `syncPhysicalFilaments`) as
    validated whole-state snapshot commands. The corpus (1,406 steps, 68 new)
    covers scoped assignment, many-to-one remap through facet refinement
    collapse and mixed-recipe merges, tombstone enable/disable and printer
    adoption with caller-supplied IDs. Two browser bugs were fixed on the way:
    re-enabling a disabled filament failed validation, and printer sync drew a
    fresh adopted-tool ID on every apply, orphaning redone references.
  - [x] Port the six mixed-filament intents (`addMixedFilament`,
    `editMixedFilament`, `duplicateMixedFilament`, `setMixedFilamentEnabled`,
    `tombstoneMixedFilament`, `removeMixedFilament`). Recipes travel typed
    (components, distributions, full-spectrum state with upstream mode codes);
    free-form `config`/`extensionData` travel as canonical JSON text, nested at
    most 16 deep so every resulting state stays parseable natively. The corpus
    (1,483 steps, 77 new) covers recipe-shape and component refusals,
    full-spectrum duplication (FNV-derived upstream IDs), tombstones and
    dependency-checked removal with sorted reference paths.
  - [x] Port the two setting-override intents (`setProjectSettingsOverrides`,
    `setScopedOverrides`): revision/hash-guarded, with redo refused if the
    stored settings diverged, scoped keys checked against the generated scope
    table (out-of-scope stored keys preserved), and maps as canonical JSON
    text. The corpus (1,516 steps, 33 new) covers every scope, stale guards,
    scope refusals, unknown targets and guarded transactions.
  - [x] Port `convertVolumeRole`: the browser's refusals (unknown volume,
    last model part, facet paint, local filament) and upstream role order on
    every conversion; the corpus (1,537 steps, 21 new) covers each refusal,
    re-sorting, no-ops and transactions.
  - [x] Port whole-facet paint strokes (`facetStroke`): the browser's
    preparation is now shared by its commit function and a request-driven
    command, and the native port matches it (guards, range normalization,
    canonical regrouping, refinement roots, sparse-validation issue counts). The
    corpus (1,569 steps, 32 new) covers every channel, invalid values and
    ranges, stale guards and topology, non-model volumes and transactions.
    Dense refined-root commits will use the staged path.
  - [x] Port `renameProject`, `setPlateWipeTower` and `reconcileAutoPairs`
    (a revision/hash-guarded replacement of the mixed-filament list with typed
    recipes). The corpus (1,598 steps, 29 new) keeps the browser's quirks: a
    rename to the same name is still an entry, and the wipe tower's history
    estimate is a fixed 128.
  - [x] Port `recreateModelColors`: printer-slot adoption (candidate IDs,
    then caller-supplied IDs drawn once per tool), recreated recipes, and
    remapping by source filament or by normalized hex colour through
    wipe towers, scoped assignments, source-material colours and paint
    (including the volume/project `originalFilamentColors` fallback). The
    corpus (1,614 steps, 16 new) also fixed the browser command's redo
    instability for adopted tools.
  - [x] Port multi-volume split to objects (`separateObjectVolumes`). It is
    revision/hash-guarded and uses a new browser request command that
    fingerprints the source like the workspace does. It has the browser's
    source and identity refusals, transfers instance offsets through
    quaternions, remaps the selection and swaps whole states. The corpus
    (1,659 steps, 45 new) pins the history estimate at the retention boundary.
  - [x] Port the payload-carrying record commands (`AddObjectCommand`,
    `AddObjectWithAssetCommand`, `AddVolumeCommand`). Payloads become
    validated `StagedAsset` leases that the repository adopts by reference on
    every apply and redo. A new browser-authored corpus
    (`project-asset-command-vectors`, 6 traces / 87 steps) covers bundle
    consistency, digest and immutable conflicts, role-ordered volume
    insertion, shared payloads in transactions, rollback, and history charges
    at the byte boundary.
  - [x] Stage payload-carrying commands through command uploads. The staging
    contract gains eleven record kinds and a `splitToObjects` work. Uploads
    declare each payload's descriptor in their records, then stream the bytes
    per declared payload after `seal`, as bundle input does: exact offsets,
    bounded chunks, and digest validation that discards only that payload. The
    last payload prepares the commands on the preparation task. Budgets are an
    upload's payload count and bytes, and a pool's `assetBytes`; each distinct
    payload is charged once per work. The browser captures and the endpoint
    pool match, and the browser's split-to-objects runs as a staged program.
    Every asset-corpus trace replays through staging (55 traces / 895 groups):
    natively, then as 287 JSON uploads with streamed payloads through WASM
    (Node, Chrome) and JNI. The boundary suites add payload refusals, and a
    Kotlin `ProjectAssetWriter` streams payloads through the actor.
  - [x] Port mesh topology replacement and mesh booleans (`ReplaceVolumeMeshCommand`,
    `MeshBooleanCommand`). Both are guarded by their starting topology and
    re-validate stored meshes without materializing them (`validate_indexed`).
    Removed payloads are kept as leases, so undo restores the same records.
    Three browser boolean bugs were fixed first: undo now restores the declared
    asset order exactly, a boolean of an instance with itself is refused, and
    history no longer stringifies payload bytes as index-keyed objects. The
    asset corpus is now 13 traces / 177 steps.
  - [x] Port split to parts (`SplitVolumeToPartsCommand`) and the
    single-volume split to objects (`commitPreparedVolumeSplitToObjects`).
    The native preparation runs the browser's checks against live state
    without publishing, then batches the split with a promotion that
    fingerprints its source after the split commits. The browser now
    validates prepared parts before opening its transaction, so invalid input
    no longer publishes a rollback (regression-tested). Traces come from the
    browser's real shared-edge preparation (asset corpus: 18 traces / 250
    steps).
  - [x] Port SVG and embossed-text parts (`AddSvgPartCommand`,
    `EditSvgPartCommand`, `AddEmbossTextCommand`, `EditEmbossTextCommand`) as
    two native kinds keyed by recipe. They keep the browser's naming rules, its
    `<type>:undo` revert reasons, its refusals and its mesh-only reference
    check. Traces come from the browser's real SVG and glyph preparation
    (asset corpus: 20 traces / 301 steps).
  - [x] Port whole-project replacement (`ReplaceProjectCommand`): validated
    on every apply, the selection pruned against each side, and history
    charged for both states. Traces cover pruning, refusal, labels and
    retention (asset corpus: 23 traces / 325 steps).
  - [x] Port refined facet commits (`commitFacetRefinement`) as
    `prepare_facet_refinement` and a `facetRefinement` staged work. Dense
    roots (strict selector-node shapes) collapse into whole-facet assignments
    and split trees. The browser's checks run against the live state without
    publishing, the encoding and result are validated by issue count, and a
    result that changes nothing executes nothing. Otherwise the prepared
    stroke command applies. Traces cover every channel, staleness, non-model
    volumes, root counts, both validation stages and noops (asset corpus 24 /
    348; staged 56 / 934 through Rust, WASM and JNI).
- [x] Port settings resolution, physical/mixed filament identities, profile
  selection semantics, and canonical slice preflight. Consume the generated
  pinned schema/catalog rather than reconstructing defaults in Kotlin.
  Rust scope eligibility, strict layer validation/resolution, explanations,
  explicit import sanitization and project config selectors now exist. The table
  comes from the browser's pinned extractor; 3,439 layer cases and 100 graph
  queries compare reference results/errors. Canonical slice preflight, live
  profile targets, their host exchange and the option-value codec are now
  native too, as are the preset graph, the compiled profile catalog and its
  host exchange, and the user preset library and its host exchange.
  Condition expressions stay unresolved, as in the browser, which ships no
  evaluator. The settings editor (field support, projection and search,
  drafts, stepping and Full Spectrum rules) and its host exchange are native
  as well.
  - [x] Port generated scope eligibility, layered resolution, import sanitization
    and configuration selectors with independent reference cases.
  - [x] Port canonical slice preflight (`slicing::preflight`) with FullSpectrum
    material compatibility, exact mesh-refusal messages, explicit budgets and a
    76-case browser corpus covering all 28 issue codes and 12 constraint refusals.
  - [x] Port live profile preflight targets (`slicing::profile`): catalog and
    authored-project constraint derivation, attestation merging and the
    authored target from canonical state (31 derivations, 5 authored targets,
    4 attestations). The browser's locale-dependent merged sort is fixed.
  - [x] Expose live preflight on export captures through WASM, JNI and Kotlin
    with generated contract codecs, piecewise replies, budgets and
    cancellation (7 live cases, 59 replies, 42 refusals per binding).
  - [x] Port the engine-option value codec (`settings::options`): a generated
    816-definition storage table, draft parsing, validation, serialization,
    configuration decoding and commits (161 contracts, 13,191 cases). The
    browser's locale-dependent key order is fixed.
  - [x] Port the preset graph and profile catalog (`settings::presets`,
    `settings::catalog`): validation, inheritance, compatibility, selection
    reconciliation and the compiled 1,482-profile bundled catalog, ordered by
    an exact host-injected `en` collation.
  - [x] Expose the catalog to hosts (WASM, JNI, Kotlin): bounded upload, host
    or built-in collation, piecewise presets/profiles/configurations,
    reconciliation and catalog preflight targets (506 replies per binding).
  - [x] Port the user preset library (`settings::library`): installation,
    custom presets, bundles, stored state and catalog updates, with the
    browser's non-portable parse message and Infinity acceptance fixed
    (14 scenarios, 131 steps over the bundled and six synthetic catalogs).
  - [x] Expose the preset library to hosts (WASM, JNI, Kotlin): catalog and
    stored-byte creation, contract operations stamped by the request, bundles
    and state as bounded bytes, piecewise issues and the composed profile
    catalog (425 replies and 184 refusals per binding).
  - [x] Port the settings editor (`settings::editor`): generated
    presentation and GUI placements, field support, projection and search
    under host collation and folding, the draft editor, stepping, stepper
    rows and Full Spectrum rules (816 fields, 61 queries, 5,856 stepping
    origins, 10 row views).
  - [x] Expose the settings editor to hosts (WASM, JNI, Kotlin) with host
    collation and search folding (14,938 replies and 78 refusals per
    binding; 24 Kotlin checks).
- [ ] Provide bounded object-tree, inspector, capability, selection, and renderer
  projections. Subscribe to revisioned deltas; do not send the complete project
  or all geometry to every panel after each edit.
  Immutable query captures now provide nine entity kinds and eight child relations
  through WASM/JNI. Numeric pages contain at most 64 rows; names/IDs retain complete
  UTF-16 through bounded chunk reads. Plate/range sorting checks an explicit entry
  budget before allocation. The independent corpus compares 5,987 nodes across
  365 admitted captures. This covers canonical hierarchy, numeric inspector data,
  transforms, filament inheritance and source declarations. Settings pages, the
  paint palette, action capabilities and revisioned renderer deltas over live
  sessions are served too; full tree presentation/paint summaries and paint
  overlay packets are not.
  - [x] Expose bounded captured hierarchy/inspector/transform/filament queries
    through WASM/JNI with generated packet validation and independent replay.
  - [x] Port the settings projection (`settings::scoped`): scoped edit
    targets, node override snapshots with foreign keys and the chain,
    explanations and the project override snapshot (17 targets, 119
    explanations).
  - [x] Expose the settings projection on project captures, with settings
    sessions that open a node's editor and turn its commit into the guarded
    project intent (275 replies per binding; intents execute natively).
  - [x] Port the paint palette projection (`facets::palette`) and serve it on
    captured projects (147 corpus libraries and 8 variants, 310 palettes).
  - [x] Port the action catalog and its availability rules
    (`orcaxr_contracts::capabilities`), generated from the production registry
    (226 actions; 372,900 availabilities over 110 states).
  - [x] Serve capabilities to hosts over live sessions, with the facts the
    session decides (`canonicalUiFacts`, shared with the browser shell) and
    structured reason codes (366 pages per binding; facts at 1,981 trace steps).
  - [x] Add renderer projections and revisioned deltas (`render`): normalized
    plate, instance and volume records with resolved colours, paged deltas
    from the snapshot a host shows, retained served targets, reset and stale
    answers (259 pages and 57 refusals per binding; 23,154 differential
    pages agree in CI and 144,585 locally; the browser surface shares the
    colour rule).
- [x] Make worker/service generation changes invalidate pending replies. Implement
  explicit session disposal and recovery after the core worker fails; recover
  only from acknowledged snapshots/journal entries, never an optimistic UI view.
  A supervisor gives each worker incarnation a fresh generation and drops
  replies from superseded ones; a failure rejects work in flight as of unknown
  outcome, and recovery reopens from the last checkpoint whose identity matched
  an acknowledgement. A real worker hosting the Rust core recovers all 19 trace
  states from hangs and exits (57 unknown outcomes reported). The browser's
  session still runs in process until Rust sessions are enabled.
- [x] Replay imports and command traces against TypeScript and Rust in isolated
  sessions. Compare state, semantic hashes, assets, dirty/history state,
  capabilities, errors, and exports after every step.
  Seeded differential replay drives both sessions through generated command
  traces from every distinct trace state and compares the reply, canonical
  state (the export), semantic hash, assets, selection, history and the
  capability facts after every step (22,800 steps in CI; 142,500 agreed
  locally), beside the fixed session, staged, clipboard and query corpora.
  Imports replay through both as archive opens and save round trips (1,341
  cases) and model-import transactions with undo/redo.

**Exit gate:** complete current command coverage with no unexplained semantic
differences. The browser still passes its full quality gate through the facade.
Rust remains an internal session choice until Phase 5 closes archive compatibility.

## Phase 5 Migrate archives and editing computation

**Dependencies:** Phase 4. **Deliverables:** shared import/export, geometry,
painting, and FullSpectrum operations that can support real native projects.

- [ ] Port signature-first STL/OBJ/AMF/ZIP import and complete foreign 3MF
  metadata/canonical assembly, transaction preview/commit, deterministic imported
  IDs, and legacy schema migrations. Enforce archive expansion/member/depth/size
  limits and safe paths.
  The shared `orcaxr-archive` crate now implements bounded ZIP/ZIP64 indexing,
  safe member paths, streaming stored/DEFLATE reads, exact length/CRC checks and
  cooperative cancellation over host-owned staged input. Seventy-five independent
  browser cases and four shipped ZIP64 calibration files qualify the container
  boundary; six native scenarios and an allocation probe cover malformed input,
  cancellation and bounded I/O. Browser ZIP64 validation was tightened for five
  malformed directory cases without changing valid file bytes. Browser authoring
  also preserves literal `__proto__` members through canonical Open/Save, fixing
  silent renaming while retaining ordinary deterministic bytes. Canonical-envelope
  staging now incrementally decodes bounded UTF-8/BOM JSON, performs dense-facet
  and false-fuzzy migrations with validation before removal, admits the graph
  under a host timestamp policy and verifies exact asset mappings, lengths,
  digests and declared blob bytes. The owning intermediate retains every member
  and verifies unknown members too; it cannot be consumed as a completed import.
  Independent browser helpers compare 109 cases (46 accepted envelope stages),
  separately recording later full-import acceptance. An 8 MiB allocation probe
  shows one asset allocation per load and no retained allocations after success
  or late integrity failure. Bounded OPC reconciliation now merges preserved
  relationships/content types and re-admits the staged graph while retaining the
  original archive and asset identities. Canonical completion now regenerates and
  compares BBS metadata, preserves externally modified members, adopts every
  unowned file with exact compressed-archive-derived IDs and recognizes plate PNG
  thumbnails. The final graph is re-admitted before prepared-document conversion.
  Independent browser comparisons cover 385 inputs (276 accepted / 109 refused),
  complete state/assets/warnings and unknown metadata. Foreign import and the
  WASM/JNI archive tasks are now complete (sub-items below); STL/OBJ/AMF and
  application/provider import remain required. This does not close the archive
  task or phase gate.
  - [x] Implement and independently verify bounded ZIP/ZIP64 indexing, streaming
    reads, integrity checks, cancellation and safe member paths.
  - [x] Stage canonical envelopes, legacy facet migrations and declared assets
    under explicit budgets, then reconcile OPC metadata without losing ownership.
  - [x] Complete BBS reconciliation and unowned-member adoption for canonical
    archives; admit the final bundle before guarded document replacement.
  - [x] Decode standard BBS color/support/seam/fuzzy-skin facet roots into sparse
    channels during bounded foreign model parsing, with shared package byte,
    refinement-node and annotation-materialization limits. Verify paint/refinement
    and refusal behavior against browser-authored ZIP fixtures.
  - [x] Retain bounded unknown extension attributes on objects, components,
    build items and facets, with namespace resolution and shared package count/
    text budgets; preserve component-edge identity through graph expansion.
  - [x] Complete native foreign BBS/3MF import: BBS metadata/settings with the
    browser's exact expression and number semantics, filament/FullSpectrum and
    paint-slot resolution, plate origins, canonical extensionData and candidate
    assembly, OPC, regenerated-member exclusion, adoption and admission. 956
    browser-derived archives and 15 authored references agree exactly.
  - [x] Bind canonical and foreign Open and package Save to owned WASM/JNI
    tasks under one generated host policy, with guarded actor adoption, Save
    checkpoint handoff, cooperative JNI cancellation and shared redacted codes;
    replayed over 1,341 browser archives in three hosts.
  - [x] Port STL/OBJ/AMF/ZIP detection and decoding with exact browser parity
    on 260 cases.
  - [x] Stage decoded models as merges with exact browser parity (237 cases).
  - [x] Port the import preview and undoable commit (21 transactions agree).
  - [x] Bind model import to WASM/JNI host tasks and the Kotlin actor.
  - [ ] Provider lifetimes and import UI in the application (Phase 7).
- [ ] Port canonical-envelope and BBS authoring, scoped overrides, plate origins,
  assembly transforms, custom G-code, modifier/negative volumes, annotations,
  mixed recipes, and unknown metadata preservation. A consumed metadata member
  cannot later overwrite a newly generated authoritative member. The three OPC
  metadata writers now produce deterministic XML under explicit limits, with
  pinned Unicode 16 casing and shared validated relationship resolution.
  Ninety-two production-helper cases cover merged metadata/warnings and exact
  outputs. Repeated browser Open/Save preserves unusual member names, bytes and
  project identity through inferred per-part content types.
  The bounded BBS facet hex codec now preserves the browser's exact wire states,
  split order and aggregate decode accounting. Sparse assembly consumes only
  explicitly encoded roots; output borrows computation or persisted trees through
  a fixed buffer. Independent production-browser references cover all 256 wire
  states, channel mapping, depth/budget failures and sparse collapse. BBS numeric
  and XML streaming primitives now preserve compact float32 coordinates, exact
  double transforms, UTF-16/XML character rules and bounded provisional output.
  Browser references cover exponent boundaries and all single Unicode code
  points. The core-model author now combines admitted immutable state, borrowed
  mesh leases, physical/enabled-mixed materials, sparse paint, stable numeric IDs,
  plate origins, component/build transforms and preserved extension attributes.
  Complete core XML and refusals match independent browser cases; preparation
  and writing have separate resource/cancellation checks. Native model settings,
  layer ranges/events, brim ears and layer-height profiles now use the same
  prepared IDs, with borrowed configuration, editable emboss recipes and captured
  SVG drawing leases. Exact member bytes/refusals match independent browser
  references. Native project settings now preserve all 98 physical-vector keys,
  imported-vector precedence, extruder-reset scripts, wipe-tower projections and
  ordinary/exact FullSpectrum rows. Complete settings bytes and typed projection
  warnings agree with 508 independent browser cases; four-decimal output agrees
  with 4,108 independent double-bit samples. Complete package assembly now streams
  the canonical envelope, BBS members, captured assets and preserved metadata from
  one frozen bundle. Independent browser references cover 1,032 package cases
  (937 accepted, 95 refused), including warning inventory and asset mappings.
  The production browser opens and saves 947 emitted native packages, including
  ten real native rename edits. Canonical import now has separate host evidence;
  1,210 actual edited canonical journeys now pass the host harness. Shared SVG
  paths require identical bytes;
  a missing drawing never borrows another part's reference. The native ZIP/ZIP64
  container writer now streams into an empty private seekable destination with
  bounded compression/index storage and cancellation. It preserves literal BOM
  member names, deterministic UTF-16 ordering and same-limit readable compression
  ratios. Independent browser/Python readers verify its output, including actual
  65,535/65,536-member directories. A sparse host test streams a 4 GiB member and
  reads a following member beyond 32-bit offsets. This container API has no
  application binding; file-provider publication and Save handoff are still open.
  - [x] Port and verify OPC, facet/numeric/XML primitives, core-model authoring,
    model/project settings, scoped metadata, SVG/emboss and FullSpectrum output.
  - [x] Stream the canonical envelope and complete deterministic ZIP/ZIP64 package
    from frozen project/assets with exact preserved-member collision policy.
  - [x] Compare all 1,032 independent package cases, including full warning
    inventory, member bytes and mappings; exercise native capture lifetimes,
    cancellation, output failures and bounded memory.
  - [ ] Bind package jobs to host tasks and qualify actual provider publication
    and Save checkpoint acknowledgement in the application.
- [ ] Verify web-to-native-to-web round trips and reverse round trips, including
  a real edit between each save. Compare untouched preserved members exactly and
  semantic structure independently; never use STL as the project interchange.
  - [x] Open all 947 emitted native packages in the production browser, compare
    state/assets/warnings, then save/reopen all 947; ten include native edits.
  - [x] Repeat through completed canonical archive import with real edits and
    saves on each side: 1,210 debug/release host journeys preserve exact full state,
    asset IDs/bytes and warnings through both implementations. The initial
    109 import refusals and three Save refusals remain separate.
  - [x] Repeat the edited journeys from 956 foreign BBS/3MF archives: 949
    native foreign Opens, edits, Saves and browser returns agree exactly.
  - [ ] Qualify STL/OBJ/AMF and application/provider round trips, including
    WASM/JNI task ownership, publication and physical-device execution.
- [ ] Port measured geometry operations in order: packed mesh codec/bounds,
  picking and region selection, paint/refined-facet computation, then preparation
  operations required by the capability inventory. Reuse pinned native geometry
  kernels through an explicit adapter where they already own the algorithm.
  The Rust mesh codec now validates immutable asset bytes and exposes borrowed
  vertex/triangle reads, deterministic packed authoring and explicitly budgeted
  expansion. Canonical instance bounds use exact vertices and volume/instance
  transforms, with captured metadata agreement and role filtering. Independent
  browser fixtures compare bytes, float bits and refusals; a two-million-vertex /
  two-million-triangle host probe checks allocation ownership. Bindings, production
  renderer packets, picking/region selection and device qualification remain open.
  - [x] Port immutable packed mesh validation, deterministic authoring and exact
    transformed bounds; verify the two-million-vertex/triangle ownership probe.
  - [ ] Bind the geometry operations and finish picking/selection, preparation
    kernels, renderer packets and device qualification.
- [ ] Preserve topology-change remap/rejection rules for every paint channel,
  stable filament assignments, one transaction per stroke, stale-preview guards,
  mirrored/instance transforms, and bounded overlay memory.
- [ ] Preserve current measurement, emboss/SVG, split/merge, simplify, assembly,
  variable-layer-height, brim-ear, and wipe-tower behavior and explicit limitations.
  Maintain the exact footprint/origin safety contract for placement/preflight.
- [ ] Route retained C++ geometry-kernel operations through the owned native job
  service, with the same input identity and cancellation checks as slicing.
  Serialize incompatible kernel/slice jobs and bound their shared resource use;
  do not load a second unbudgeted engine into the editor process.
- [ ] Run hostile-file and fuzz corpora against both native and WASM archive
  paths. Keep import failures transactional and diagnostics bounded.
- [ ] Enable complete Rust-backed browser sessions only after all current project
  operations, save/recovery, and old-file compatibility pass their gates.

**Exit gate:** edited projects survive cross-platform round trips without loss;
canonical identities match; large-model copy/resource budgets hold. The native
application now has a shared authoritative project implementation to build on.

## Phase 6 Integrate production native slicing

**Dependencies:** Phase 2 engine proof and Phase 5 project archives.
**Deliverables:** versioned Android engine artifacts, owned job service, local and
external slice routes, and verified output publication.

- [ ] Create reproducible clean-source build tooling under a new Android-specific
  entry point. Pin source, common/platform patches, NDK, dependency inputs,
  compiler flags, ABI, and every packaged library hash. Keep build concurrency
  conservative on the shared host.
- [ ] Implement the service/JNI contract described above, including bounded input
  staging, one-job admission, progress, thread-safe callbacks, cooperative cancel,
  hard-stop escalation, process-death observation, and cleanup after editor death.
- [ ] Reuse canonical preflight and exact captured configuration. Exercise U1
  toolchanges, CC profiles, FullSpectrum modes, support/seam/fuzzy/color painting,
  layer events, scoped overrides, and every engine feature currently claimed.
- [ ] Generate the statistics sidecar, render thumbnails from captured geometry,
  finalize the exact G-code bytes, and bind output to project/revision/config/
  assets/engine. Preview, save, and send reject stale output.
- [ ] Implement the native external-slicer client with explicit credentials,
  connection-generation capture, existing attestation, result digest/length
  validation, repeatable download, leases, and cancellation outcomes.
- [ ] Define local/external route selection using measured resource limits and
  user preferences. Show the selected route and reason; do not upload models or
  silently reroute work to a server the user has not configured and authorized.
- [ ] Qualify foreground/background execution for each SDK/distribution target.
  Test task switching, screen lock, thermal pressure, notification denial where
  relevant, service timeout, process death, and reopening an interrupted job.

**Exit gate:** qualified fixtures produce materially equivalent G-code across
Android, browser, and server; service crashes leave the editor/recovery usable;
cancelled or incomplete output cannot become a sendable artifact.

## Phase 7 Build the adaptive Android application

**Dependencies:** Phases 3–6; visual shell work can begin after Phase 1.
**Deliverables:** complete flat-device preparation, slicing, preview, and project
storage journeys on phone, tablet, and desktop-sized windows.

- [ ] Implement Prepare, Preview, Device, and Project navigation with the existing
  action names and semantics. Use ViewModels/coroutines as host adapters to the
  core; Compose state contains projections and drafts, never a second project.
- [ ] Adapt inspector/object tree, toolbars, menus, command palette, dialogs,
  settings, and progress states to narrow, medium, and wide windows. Support
  keyboard traversal, shortcuts, hover, context menus, trackpad navigation,
  touch gestures, stylus input when supported, and file drag/drop.
- [ ] Integrate the flat renderer with panel resizing, visibility, lifecycle,
  selection, painting, model tools, and preview controls. Keep CPU work and
  loading off the UI thread; avoid per-frame Compose recomposition for meshes.
- [ ] Implement document open/create/save-as/share, recent files, provider URI
  grants, externally revoked grants, nonseekable input, disk-full errors, and
  large-file streaming. Validate incoming open/share intents as untrusted input.
  `ProjectDocuments`/`ContentProjectDocument` in core-bridge already handle
  unsized/nonseekable input, stale sizes, revoked grants, disk-full codes and
  package-before-truncate Save; pickers, grants, recent files and intents remain.
- [ ] Implement recovery storage and Save/Discard/Cancel guards for back,
  navigation, new/open/replace, window close where observable, and app updates.
  Test process death during capture, write, commit, and restore.
- [ ] Introduce document-session ownership for multiple windows. Different
  documents may coexist; reopening an already-owned document focuses its owner
  or opens an explicit read-only view. External changes require conflict handling
  before overwrite. Do not create two unsynchronized writers to one document.
- [ ] Generate Android localization resources and design tokens from maintained
  sources. Preserve placeholder/plural behavior and canonical locale independence.
  Test TalkBack, enlarged text, RTL/pseudo-locales, contrast, reduced motion,
  keyboard focus, edge-to-edge system bars, and IME insets.

**Exit gate:** open a large painted project, edit it, undo/redo, save/reopen,
slice locally or externally, inspect toolpaths, and recover after process death
on physical Android devices. Desktop resizing/input is verified separately from
touch behavior; Googlebook remains unqualified until tested on real hardware.

## Phase 8 Build complete Android XR workflows

**Dependencies:** Phase 2 renderer decision and Phase 7 shared workflows.
**Deliverables:** spatial workspace with complete authoring and output flows.

- [ ] Implement an XR capability adapter for session availability, space mode,
  supported input, anchors, and rendering lifecycle. Only initialize perception
  and request permissions when the selected feature requires them.
- [ ] Build spatial menus, tabs, inspector, object tree, tool rail, preview
  scrubber, dialogs, and notifications from the same action/capability inventory.
  Preserve labels and all paint channels; a button is unavailable until its full
  completion flow works inside the headset.
- [ ] Implement model/plate manipulation, ray picking, paint strokes, direct
  manipulation where supported, and modal gesture ownership. Cancel correctly
  on tracking loss, interrupted gestures, hidden panels, or disposed sessions.
- [ ] Preserve physical scale and ergonomic layout constraints from DESIGN.md
  while measuring the actual native density conversion. Implement recenter,
  pin/unpin, panel movement, readable text, and collision/occlusion behavior.
- [ ] Make project opening, save destination selection, credentials, settings,
  error recovery, and print confirmation completable in XR. Test system panels
  and transitions instead of assuming flat Android dialogs are sufficient.
- [ ] Qualify Home Space/Full Space transitions, repeated XR entry/exit,
  passthrough/perception permission denial, panel disposal, headset removal,
  and long sessions. Release hidden renderer/camera work.
- [ ] Test every advertised hand/controller/gaze/keyboard method on hardware that
  actually supports it. Separate headset and wired-glasses capability records;
  keep browser/WebXR regressions in the existing gate.

**Exit gate:** the representative end-to-end workflow succeeds wholly in-headset
with recorded latency, readability, reach, error handling, and fatigue review.
An emulator or spatial screenshot cannot close this phase.

## Phase 9 Integrate printers and platform services

**Dependencies:** Phase 7; shared policy extraction can start after Phase 4.
**Deliverables:** native Moonraker integration, shared command policy, camera,
credential storage, and explicit permission/error flows.

- [ ] Port printer/session/submission state machines into shared workflow code
  and run the browser transport through the same policy. Preserve authoritative
  query versus partial-notification merging, reconnection generations, unknown
  readiness, tool mapping, and immutable command/job identities.
- [ ] Implement Kotlin HTTP/WebSocket transport, explicit endpoint management,
  credential entry, and optional discovery. Discovery proposes verified endpoints
  and cannot overwrite preferences while a stale probe completes.
- [ ] Support intentional HTTP LAN connections through an explicit transport
  policy. Android configuration must allow the intended user-entered endpoints;
  application routing restricts cleartext requests to those selected local
  services. Do not send credentials across unexpected redirects or disable TLS
  certificate validation to make arbitrary HTTPS endpoints work.
- [ ] Handle local-network permission grant, denial, revocation, and re-entry,
  including SDK 37 behavior. Keep manual endpoint entry and platform-supported
  discovery distinct; avoid indiscriminate subnet scanning.
- [ ] Store remembered printer/slicer secrets using Android Keystore-backed
  encryption and clear them on explicit forget. Keep AI credentials memory-only
  unless a separate preference is deliberately introduced. Exclude secrets and
  private model contents from logs, backups, crash attachments, and test fixtures.
- [ ] Implement upload/prepare/start with digest and artifact checks, random
  non-overwriting names, post-upload revalidation, explicit overwrite handling,
  and unknown-outcome recovery. Never blindly retry an uncertain print start.
- [ ] Implement status/history/storage/console/camera features matching current
  scope. Camera subscriptions stop when hidden/disposed; emergency stop and the
  distinct firmware-restart action remain reachable without successful status
  queries. Preserve existing operator confirmations and supervised print gates.
- [ ] Test with the existing printer simulator before qualified, supervised U1
  and CC trials. Automated tests do not issue commands to real printers.

**Exit gate:** identical simulator traces produce equivalent policy decisions
on web and Android; permissions and reconnects are handled correctly; supervised
printer evidence closes only the specific behaviors actually observed.

## Phase 10 Complete feature coverage and optional experiences

**Dependencies:** Phases 7–9. **Deliverables:** native capability/evidence matrix,
remaining product workflows, and explicitly scoped companion support.

- [ ] Extend parity tooling to distinguish web DOM, WebXR, Android flat, and
  Android XR support and evidence. Generate manifests/reports through tooling;
  an implemented web handler cannot automatically mark Android implemented.
- [ ] Close native UI and shared-core coverage for all current implemented
  feature families: object/part/instance tools, FullSpectrum, painting channels,
  preparation/geometry, settings/profiles, slicing/preview/statistics, calibration,
  printer operations, recovery/help/diagnostics, localization, and accessibility.
- [ ] Port calibration definition binding, prerequisites, generated resources,
  preview/application, and history. Carry current unsupported firmware/automatic
  execution cases forward visibly; native packaging does not make them valid.
- [ ] Port Smart Paint proposal validation and operator correction through the
  shared transaction pipeline. Adapt provider transport, camera/voice features,
  and consent per provider/payload where they exist in the current app. Optional
  services remain lazy and cannot gate core startup.
- [ ] Inventory existing automation and platform-specific integrations. Preserve
  action IDs and implement deliberate native adapters where applicable; document
  browser-only integrations explicitly rather than claiming automatic portability.
- [ ] Qualify Googlebook file, window, keyboard, trackpad, DPI, and lifecycle
  behavior on actual hardware. Reassess package ABI coverage from that hardware.
- [ ] Design the display/audio-glasses companion as a separate feature package
  using a host-device connection: printer state, progress, completion/failure,
  and a handoff into the main application. Verify current glasses APIs/devices
  before implementation. Do not project a full editor or expose unqualified
  destructive voice/gesture commands.
- [ ] Complete companion disconnect/reconnect, notification privacy, permission,
  battery, and device-availability tests when hardware is available. Track this
  target independently; its absence does not block a qualified headset release.

**Exit gate:** every current product capability has per-target implementation
evidence or an explicit reviewed platform limitation. Upstream parity work still
open in docs/parity.md stays open. Companion support is marked complete only with
its own implementation and device evidence.

## Phase 11 Qualify releases and retire replaced implementations

**Dependencies:** all required gates for the target being released.
**Deliverables:** reproducible release candidates, compatibility/rollback proof,
hardware evidence, and maintained operating documentation.

- [ ] Run the complete web/server/WASM gate plus Rust, Android, cross-language,
  archive round-trip, engine route, hostile-input, lifecycle, and performance
  suites. Perform a fresh native source build for each shipped ABI.
- [ ] Verify installed APK/AAB artifacts, dependency and license notices,
  corresponding engine source/patch availability, native symbols, 16 KB loading,
  signing configuration, permissions, and current distribution requirements.
  No signing keys or release credentials enter the repository.
- [ ] Measure download/install size by ABI and package the native engine and
  required profiles through the chosen signed distribution artifacts. Verify a
  fresh installation can perform the promised offline workflow. Any later
  optional asset-delivery design needs its own missing/update/rollback behavior;
  do not rely on fetching arbitrary executable libraries at runtime.
- [ ] Run repeated import/edit/save/slice/preview/delete and cancellation/crash
  soaks on real devices. Verify recovery under low storage, memory pressure,
  thermal throttling, renderer failure, application upgrade, and process death.
- [ ] Conduct independent project/engine review and supervised U1/CC print
  qualification for the release corpus. Preserve existing outstanding operational,
  credential, security, and Galaxy XR gates until new evidence closes them.
- [ ] Use internal candidates, then a limited tester release, then production
  publication under the repository's release authorization. Artifact creation is
  separate from uploading/publishing it or commanding a real printer.
- [ ] Keep the previous compatible app and Rust/TypeScript adapter selection
  available for one full release qualification cycle. Exercise downgrade/open
  and restore from snapshots; never discard future-schema recovery data.
- [ ] Remove replaced TypeScript implementations only after the shared core has
  passed the full cycle and the rollback strategy no longer depends on them.
  Retain contract fixtures, semantic oracles, and regression traces independently
  of the new implementation. Remove obsolete Android build paths or label/archive
  them explicitly when the replacement is usable.
- [ ] Update GEMINI.md, topic contracts, README, user help, recovery guidance,
  generated capability reports, and release limitations to describe what shipped.
  Record exact commit, toolchain, artifact hashes, devices, measurements, and
  reviewers for each closed milestone.

**Exit gate:** a new user can install a qualified artifact and complete the
supported workflow, existing users retain their projects/recovery, and every
published support/performance claim has reproducible evidence.

## Performance and correctness acceptance

These are proposed engineering targets, not measured results. Phase 0 must name
the fixture/device combinations and memory ceilings. A failed target triggers
optimization or an explicit product-scope decision; it must not be hidden by
raising a threshold until a check passes.

| Area | Acceptance requirement |
| --- | --- |
| Interactive flat viewport | Sustain the chosen 60 Hz baseline within its 16.7 ms frame budget for the standard interaction trace; record p50/p95/p99 and missed frames |
| Interactive XR viewport | Meet the tested device's active refresh budget; record compositor/application metrics separately and observe missed-frame streaks |
| Gesture feedback | Proposed p95 input-to-visible-preview target of 50 ms; measure end-to-end, including host/binding/GPU work |
| Command completion | Proposed p95 250 ms for ordinary transforms/settings on the large fixture; longer geometry operations show progress and remain cancellable |
| Native benefit | Demonstrate a material improvement on the same hardware; initial target is at least 20% lower p95 interaction latency on the large painted fixture, with no unexplained memory regression |
| Memory | Respect the Phase 0 per-device ceiling across editor, engine process, workers, and reported GPU allocations; no low-memory kills in the supported corpus |
| Resource lifetime | Twenty repeated open/edit/preview/close cycles return to the documented bounded cache baseline without growing live handles, threads, or model buffers |
| Asset copies | Preserve the existing zero-payload-copy transform/undo contract; measure copy volume for import/export and JNI/WASM/renderer transfers |
| Cancellation | UI acknowledges cancellation within 100 ms; each worker/job has a documented completion/termination deadline, with a proposed five-second local-engine escalation bound |
| Recovery | Preserve acknowledged project state and save identity across the enumerated failure points; observe the five-/thirty-second scheduling contract during active execution |
| Engine output | Exact bindings and required sidecar identities; semantic G-code comparison with reviewed existing tolerances, not assumed byte equality across architectures |
| Cross-platform project behavior | Exact canonical identities and equivalent command traces; structural 3MF equality and exact preserved payloads |
| Web regression | Full existing quality and bundle gates pass; Rust startup/download/transfer costs are included, and optional modules load only when needed |

Use at least five cold/warm operation runs and sufficiently long interaction
traces for percentile measurements; save raw traces, not only averages. Run
sustained sessions of at least thirty minutes to reveal thermal changes. Record
charging/power mode, concurrent load, and instrumentation overhead. Compare
release builds and separate instrumented memory experiments from uninstrumented
latency measurements.

## Verification interfaces

Existing repository commands remain mandatory according to the affected area:

```sh
npm --prefix web run quality
npm --prefix web run bench:assets
npm --prefix web run bench:preview
npm --prefix web run test:recovery-storage
npm --prefix server test
npm --prefix server run test:integration
npm --prefix server run test:deployment
npm --prefix wasm run verify:artifacts
npm --prefix web run parity:oracles
npm --prefix web run parity:report
npm --prefix web run parity:report:check
./scripts/quality.sh
```

Implemented development checks and their entry points are documented in
[native-core](engineering/native-core.md) and `.github/workflows/native-core.yml`.
From the repository root, the host Rust checkpoint runs with:

```sh
cargo +1.94.1 fmt --manifest-path core/Cargo.toml --all -- --check
cargo +1.94.1 clippy --manifest-path core/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo +1.94.1 test --manifest-path core/Cargo.toml --workspace --all-features --locked
cargo +1.94.1 test --manifest-path core/Cargo.toml -p orcaxr-archive --release --locked
```

The following verification responsibilities remain required in full; the presence
of an entry point or a host result does not establish browser/device qualification:

| Check | What it proves |
| --- | --- |
| Rust format/lint/host tests | Workspace quality and deterministic domain behavior |
| WASM browser suite | Actual browser bindings, worker scheduling, buffer lifetime, and ordinary/non-isolated execution |
| Android JVM and device suites | Host policy plus real JNI, native libraries, document providers, process lifecycle, and rendering |
| Contract replay | Matching command traces and identities across TypeScript, native Rust, and browser Rust |
| Archive interchange | Edited web/native round trips, preservation, schema compatibility, and malformed-input rejection |
| Engine route comparison | Pinned Android/browser/server behavior for the same captured project/configuration |
| Artifact verifier | Source/patch/toolchain identity, packaged ABI set, binary hashes, native dependency alignment, and coherent bindings |
| Device performance suite | Repeatable workload/trace capture against the fixed device budgets |
| Capability report | Per-target handler, end-to-end test, hardware evidence, and explicit unavailable reason |

Layer tests so quick domain/binding checks run on every relevant change and
expensive clean engine builds run whenever engine/build inputs change and for
release candidates. Device availability failures must report unverified rather
than silently skipping required release tests. Existing audits and redacted
secret scans continue; add Rust/Gradle dependency auditing appropriate to the
locked toolchains.

## Milestones and dependency order

| Milestone | Required phases | Concrete review artifact |
| --- | --- | --- |
| M0 Baseline and build contracts | 0–1 | Reproducible minimal app, shared binding tests, baseline report |
| M1 Native feasibility | 2 | Real-device viewport traces and a correct pinned-engine slice |
| M2 Shared preview | 3 | The same parser/projection running in the web release and native harness |
| M3 Shared project core | 4–5 | Complete command replay and edited cross-platform project round trips |
| M4 Native flat workflow | 6–7 | Installable candidate that imports, edits, saves, slices, previews, and recovers |
| M5 Native spatial and printer workflow | 8–9 | Complete headset journey and qualified printer policy/transport |
| M6 Supported native release | 10–11 | Capability coverage, device evidence, reproducible artifacts, rollback proof |
| M7 Glasses companion | Relevant Phase 10 tasks and Phase 11 gates | Separately qualified status/handoff experience on supported glasses |

After Phase 1, rendering/engine feasibility and the first Rust extraction can
proceed independently. Shared project migration is the critical dependency for
production native editing. Adaptive UI scaffolding may develop against immutable
fixture projections, but real mutations must wait for the shared command contract.
Do not treat the early renderer experiment as a nearly finished application.

Estimate and schedule each milestone after measuring its predecessor. The largest
uncertainties are full command/archive migration, native renderer update behavior,
the current engine's Android dependency build, and access to target hardware.
Calendar commitments before M1 would conceal those uncertainties. Track engineering
effort separately from device availability and external distribution review.

## Risks and required decisions

| Risk | Required response and evidence |
| --- | --- |
| SceneCore cannot update large painted meshes efficiently | Resolve in Phase 2; compare a custom-renderer experiment before expanding XR UI |
| Rust and TypeScript canonicalization disagree | Block session cutover; extend explicit number/string/hash vectors and independent oracles |
| Async commands change editing semantics | Land the TypeScript facade first and exercise stale completion, undo, cancel, and transaction failure |
| Two project models emerge | Keep one authority per session; Kotlin/UI data is projection only; production has no dual writes |
| Additional WASM/JNI copies erase the expected gain | Measure peak coexistence and copy volume; redesign buffer/session boundaries before rollout |
| Retired Android patches alter the current engine | Reproduce the defect against the current pin and compare route output before accepting a patch |
| Native engine crashes or ignores cancellation | Owned service process, bounded stop escalation, generation-safe cleanup, and recovery tests |
| SDK background restrictions interrupt slices | Qualify the supported execution model; preserve captured jobs and explicit external routing |
| Desktop windows overwrite one project | Document ownership, revision/URI guards, external-change checks, and conflict tests |
| Android permissions recreate LAN failures | Distinguish permission, authentication, TLS, timeout, and unavailable-printer states in tested flows |
| Native support is mistaken for full upstream parity | Generate per-target coverage and retain all unresolved upstream/hardware evidence gates |
| Googlebook or glasses hardware is unavailable | Continue host/emulator work and hold the affected device claim open |
| Migration grows beyond bounded Rust extraction | Require performance or shared-authority value for each crate; keep UI/platform transport in their native languages |

## Implementation sequence and handoff discipline

The foundation, engine/viewport experiments and G-code extraction now have the
scoped evidence recorded above. Continue from the current handoff checklist;
finish the shared project/archive seam while retaining the unresolved baseline,
renderer and device dependencies. Broad native authoring begins only once the
shared command and archive foundations can preserve real projects.

Track completion using the existing parity evidence convention: task, commit,
date, fixture hashes, commands, device/OS/toolchain, result artifacts, reviewer,
and unresolved limits. Check verified tasks in the same change as their evidence.
For partial work, check concrete sub-items and leave the parent open. Before each
handoff, update the next action, test failures/environment limits and uncommitted
work state; do not require the next agent to reconstruct status from chat history.
