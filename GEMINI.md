# GEMINI.md

Canonical technical context for OrcaXR. Auto-loaded by Claude Code via
CLAUDE.md and by Codex via AGENTS.md at the start of every session in
this repo. Read this before any non-trivial work.

## Self-update mandate

**When any claim in this file or its maintained topic documents becomes
wrong or incomplete, fix it in the same commit as the code change that caused
the drift.** Do not append
errata sections. Do not let this file rot.

Update triggers (save it here, not as a throwaway comment):

- **Build quirks** — NDK flags, CMake workarounds, dependency version pins
  that matter, things that broke once and will break again.
- **Dependency gotchas** — versions of libs with known bugs, incompatibilities
  between Jetpack XR artifacts, upstream OrcaSlicer commits that must/must-not be picked up.
- **Architectural decisions** reached in conversation — module splits,
  threading model, JNI boundaries. Record the decision *and the reason*.
- **User preferences** expressed during work — how they want commits
  structured, code style calls, what they consider out-of-scope.
- **Non-obvious code behavior** — things that surprised you reading the
  code and will surprise the next session too.

Do **not** record things already derivable from code (paths, signatures, module names) unless load-bearing
*and* easy to get wrong. Keep this file under ~500 lines; split into a
separate doc if it grows past that.

## User preferences

**Always ship the best version, never the easiest.** When asked for
improvements or fixes, do not present an "easy vs. best" tradeoff and
do not ask the user to pick. List the improvements and execute all of
them in priority order. Only stop to confirm if there's a genuinely
irreversible action or a specification ambiguity the code cannot
resolve. The user wants OrcaXR to be the best it can be, period —
asking for permission to do less work wastes their time.

**For overnight / async work:** ship verified end-to-end commits. Build and
run relevant tests before calling work done. Keep the implementation plan's
checkboxes, evidence and next steps current so another AI can resume after a
token/context handoff; leave incomplete integration and device gates unchecked.

## Mission

Build an XR-first 3D printing slicer for Web and XR devices. Not a port of
OrcaSlicer's wxWidgets UI — a ground-up XR UX with OrcaSlicer's slicing
engine (`libslic3r` via WASM) as the computational core.

## Target platform

- **Primary:** Web browsers and XR devices via WebXR/XRBlocks.
- **Target printers:** Snapmaker U1 (4-head toolchanger), Elegoo Centauri
  Carbon. Both are Klipper + Moonraker; this codebase has *no* serial, USB, or vendor-cloud printer support.
- **Current release:** no native Android application; native PCVR is not targeted.
- **Under development:** native Android for phones, tablets,
  Googlebook and Android XR, with selective shared Rust migration. See the
  [native Android and Rust plan](docs/android-native-rust-plan.md). The initial
  Compose shell and Rust computation bindings are development infrastructure,
  not a usable native slicer. Current release support remains unchanged. Browser
  preview uses Rust parsing, projection and inspection behind the existing session
  interface, with TypeScript startup rollback. Debug Android builds include a flat
  Filament fixture workbench; it has no canonical editing or document import.
  A separate SceneCore rc01 experiment APK uses the same packed mesh, with
  bounded immutable chunk replacement for sample paint. SDK contract and
  non-XR startup checks do not qualify its spatial rendering; see native-core
  evidence before selecting an XR renderer.
  Current-engine Android tooling verifies TBB probes, both-ABI libslic3r builds
  and eleven x86_64 fixture comparisons against the published browser engine.
  App slicing is Galaxy XR qualified; standalone ARM64 CLI fixtures remain; see slicing doc.
  [Canonical slice fixtures](docs/engineering/native-slice-fixtures.md) exercise eleven
  authored archives through the browser engine; these are reference inputs.
  Shared Rust G-code search is browser-qualified; rendering/device gates stay open; no PCVR.

## Stack

| Layer | Choice |
|---|---|
| UI | HTML/JS/CSS |
| 3D & XR | XRBlocks for Spatial UI, 3D interaction, WebXR |
| Slicing core | OrcaSlicer `libslic3r` via WASM in the browser or via the Node.js backend server |
| Network | `fetchLocalNetwork`; typed Moonraker HTTP/WebSocket boundary (live read-only handshake/slot inspection) |

## Read the relevant technical context

Before changing an area, read its maintained topic document and follow its constraints. Update that document in
the same commit when behavior changes; do not append a second source of truth.

| Area | Required context |
| --- | --- |
| Canonical graph, history, imports, settings, geometry, painting, statistics, parity | [Project contracts](docs/engineering/project-contracts.md), [parity plan](docs/parity.md) |
| DOM/XR surfaces, registry, input, XRBlocks APIs and lifecycle | [XR and UI](docs/engineering/xr-and-ui.md) |
| Browser startup, persistence, printers, external slicing, server and deployment | [Runtime and deployment](docs/engineering/runtime-and-deployment.md) |
| Mesh storage/import/export, preview, memory, responsiveness | [Large-model contracts](docs/engineering/large-models.md) |
| WASM/native engine changes and build gotchas | [Current slicing constraints](docs/engineering/slicing.md), [Snapmaker build notes](wasm/patches/README-snapmaker.md) |
| Native Android and shared Rust implementation (app strings: `contracts/android-strings.json`; `values-*` and the theme's `OrcaTokens.kt`, from `web/src/ui/tokens.ts`, are generated) | [Native Android and Rust plan](docs/android-native-rust-plan.md), [native-core build and evidence](docs/engineering/native-core.md) |
| Retired Android/JNI implementation only | [Historical Android notes](docs/historical/android-slicer-notes.md) |

The Android notes preserve old patches and investigations. They are not the
production engine or profile authority. Native Android development follows
the linked plan; it does not revive the retired app or its engine/profile
baseline. Native PCVR remains out of scope unless the user changes the target.

## Source pins and generated evidence

- Production browser WASM, Node/WASM, native server CLI, parity extraction and
  oracles all use **Snapmaker OrcaSlicer v2.3.4**, exact commit
  **`9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`**.
- **XRBlocks 0.17.0** and **UIKit 1.0.74** remain exact pins. Inspect installed
  source/types before using their API; unversioned examples are not authority.
- `third_party/SnapmakerOrca` is a developer checkout. Truth tooling reads exact
  Git blobs at the pinned commit, never an uncommitted worktree. Clean clones
  use the tooling's supported source-fetch paths.
- `wasm/artifact-provenance.json` binds engine revision, build inputs and output
  hashes. Verify canonical and every required/present deployed copy, including
  its adjacent manifest. Reject partial copies. Publish binary and manifest as
  one validated versioned set. Hash agreement alone does not prove a clean rebuild.
- Engine patches must be reproducible from the tracked build inputs. Update
  patches, rebuild, publish and update provenance together. Browser/server source
  and patch identities must agree before an external engine is usable.
- Generate parity manifests/reports through `tools/parity/`; never hand-edit them. Mapping a leaf or
  rendering a control is not evidence of live parity. Preserve incomplete human review, security,
  firmware, calibration and Galaxy XR gates until their evidence exists.
- Generate settings and scope tables from pinned definitions. Engine precedence is object, then part,
  then height range; the last wins. Reject authoring at unsupported scopes while preserving imported
  values for lossless round trips. Rust scope eligibility, layered resolution and project config
  selectors use the same pinned extractor. Resolved views borrow immutable values. Ignored local keys
  must not hide inherited values, and ignored-setting diagnostics use canonical UTF-16 key order so
  save/reopen preserves them. Browser settings commits await guarded intents, the same commands a native
  session executes.
- The web profile corpus is a pinned overlay: registered vendor leaves are exact
  mirrors; local target adaptations are SHA-256 locked. Add complete compatible
  nozzle families. Never hand-edit a mirrored leaf or generated catalog.

## Canonical project and action boundaries

- `web/src/project/` owns the UI-independent graph and history. Domain code must
  not import DOM, XRBlocks or Three UI objects. The explicit Three surface stays
  a direct browser adapter, excluded from the headless project index.
- Legacy live state is a migration source, never a second canonical model.
  Mutations use commands and stable IDs; imports stage, validate, preview and
  commit transactionally. Cancel, failure and stale confirmation preserve state.
- Production Undo/Redo and plate add/duplicate/delete/activate/rename/reorder/
  printability await the local asynchronous session facade through ActionRegistry.
  Queued mutations bind both project/asset identity and a monotonic history revision; equal-looking history replacement can still invalidate them.
  Plate payloads are generated, bounded serializable intents; the TypeScript bus
  remains the executor. Generated string messages now carry session generations,
  guards, handshake, acknowledgements, cancellation and close through a local
  transport adapter. The host-generated connection nonce never consumes the
  injected project ID source. Lost/malformed replies fail the client closed without
  retry; a committed operation whose summary exceeds the wire budget reports a
  distinct completed outcome. Plate UI success follows acknowledgement; canonical subscriptions
  own selection and projection updates. Objects reveal checks the activation
  receipt and current selection before applying late camera/selection work.
  Object/part rename, instance printability, single/batch transforms and derived placement
  tools use that transport too. A drag owns one dispatched edit and one latest pending pose,
  advances only from its own receipt, and cancels immediately on selection/tool changes or
  disposal; cancellation never undoes committed steps. Multi-instance printability keeps
  separate undo entries and reports a completed count on interruption. Named actions await
  these results. Numeric transforms, DOM/XR drags and DOM lay-on-face invoke declared registry
  routes; gestures get the actual receipt and recheck availability per dispatched pose.
  Object/instance deletion, plate clearing, cut and instance conversion await registered
  actions; object copies and plate moves have guarded async APIs. Cut publishes its copy before
  queued deletion; a failed/uncertain deletion keeps that clipboard; late replies never republish it.
  Clone/add-instance/fill-bed/paste await measured staged work, keeping history and captures;
  clipboard captures share asset records; paste restores missing bytes in rollback.
  Settings/range/role/layer-event/filament/wipe-tower/helper/split/brim/sync/mesh/model-add/import/paint/profile routes submit; build commands
  first (prepare errors become invalidRequest), local apply errors keep their message, and
  batched auto-pair reconciles guard on a scratch-store prediction of the edited state.
- Prepared command intents use ASCII JSON with UTF-16 unit arrays for all text.
  The shared schema generates TS/Rust/Kotlin types and converters; Rust writes JS numbers.
  Reject duplicate/unknown/missing fields, positional objects, unsupported versions and exhausted
  byte/node/depth budgets before domain execution. Local submission captures data properties without getters
  or mutable caller-owned descendants. Kotlin protocol JSON uses a portable bounded parser and shared
  lexical checks (Android JsonReader needs them for G-code metadata). Renderers page `render` deltas from
  the shown snapshot (unknown base = rebuild), colours via `volumeDisplayColor`; mesh packets keep three's
  normals bit-exact. Region selection, refined too, is float32-exact; overlays page 40-byte facet packets.
- A pending `EditorSession.open` owns its source revision/asset guard and operation identity.
  Newer opens, reset and disposal invalidate it; a failed newer open cannot revive an older
  read. Cooperative cancellation never replaces the final owner/identity check before commit.
  Worker-hosted sessions (`ProjectSessionSupervisor`): a generation per incarnation, in-flight
  work fails as unknown outcome, recovery only from acknowledged checkpoints; wasm-bindgen
  `open`/`effects` consume their objects (never `free` them after).
- `ActionRegistry` is the sole invocation/availability gateway for DOM, XR,
  menus, shortcuts, command palette and contextual Objects actions. A capability
  marked implemented needs a real handler and evidence. DOM-only dialogs declare
  XR exclusions. Rules stay in `generate-action-catalog.mjs`'s boolean grammar.
- Slice preflight uses exact catalog/imported configuration, never display
  defaults; imported projects slice as authored, never rebound to a bundled preset.
  Native `slicing`/`settings` replay browser vectors; order is UTF-16, never
  `localeCompare`, except presets/fields (host `Collation`); field search folds via
  host `SearchFolding`. Read TS byte-exact (`cat -A`): fingerprints join on U+0001.
- Published G-code binds exact project/revision/config/asset/engine identities.
  Preview, download and send reject drift. Keep output hashing and authoritative
  sidecar provenance intact; missing information remains unavailable.
- Native project IDs preserve UTF-16 code units, including lone surrogates and
  imported NULs. Match ECMAScript whitespace and ASCII namespace/UUID rules;
  do not normalize case or substitute Rust Unicode whitespace/lossy strings.
  Project IDs belong to the domain; transport request/session handles are separate.
- Rust schema-1 project candidates retain unknown fields at every record boundary,
  optional-field absence and complete UTF-16 text. Immutable child collections,
  configurations and sparse paint payloads are shared across candidate edits;
  full-state FNV hashing streams without copying them. `ProjectData` is a typed
  candidate with a cached fingerprint. `ValidatedProject` separately admits that
  immutable candidate after graph/reference/layout, settings-base consistency,
  mixed-recipe, topology and paint checks. Reusing it retains the validation proof;
  it owns no store revision, asset-byte attestation, command bus or history.
  Do not substitute strict ISO parsing or Rust rounding for the existing graph
  validator's `Date.parse` and layer-event `toFixed(4)` compatibility requirements.
  The Rust compatibility helpers now reproduce pinned V8 timestamp syntax and exact four-decimal
  collision keys. Browser `Math.sin/cos/tan/acos/exp/round/hypot/min/max` in ported code must use
  `orcaxr_project::js_math` (V8 12.4's own fdlibm port): the `libm` crate's FreeBSD trig differs from V8
  in the last bit for ~1% of inputs; `Number`/`String`/`toFixed`/`trim` go through `js_math::convert`.
  One `Math.fround` per step ports as f32 math, but frounded terms summed before one `fround` (split
  signed volume) sum in f64. Legacy timezone overflow needs an explicit V8 integer profile;
  timezone-less dates need a host resolver with matching DST and historical rules. Resolver failure must
  propagate, never default to UTC or become an invalid-data diagnostic. Graph admission uses that
  explicit policy. Unknown paint-channel diagnostics use canonical UTF-16 ordering; layer-range
  diagnostics retain original array positions, including repeated shared records.
  Both must survive save/reopen. The native project store now publishes admitted
  state with monotonic revisions, including equal replacements and rollback.
  Project/selection changes are immutable receipts returned with native session
  replies for host dispatch after commit; callbacks do not live in the stores.
  Selection preserves ordered deduplication, primary fallback and graph pruning.
  Low-level revision/hash guards are not session ownership or asset/history guards.
  Native counters stop at the protocol's safe-integer maximum; transaction owners
  must preflight capacity for their publications and rollback before mutating.
  A Rust command owner executes seven plate intents plus object/volume/instance
  rename, instance printability, single/batch transforms, object/instance deletion,
  plate clearing, independent duplication, plate moves and instance-to-object
  conversion, with bounded undo/redo, coalescing, dirty checkpoints and atomic project/asset/selection
  rollback. Local instance creation/paste retain full immutable records; clipboard paste
  also restores selected assets atomically. Bulk decoders require explicit budgets. Session-owned one-use staging
  retains preparation guards and charges ready/queued work until release or commit;
  cancellation drops its payload immediately. Limits count encoded input units plus,
  for mesh payloads streamed after the records, their bytes. WASM/JNI upload owners parse bounded UTF-8 separately;
  four preparation permits cover parsing, sealing and transfer, then the finished
  pool owns the charge. Detached input owns its original guard, never a live session;
  hosts cancel preparation tasks on lifetime changes. WASM handles are module-local;
  separate sealing alone provides neither worker isolation nor interruptibility.
  Bounded clipboard hosts capture current object queries and paste under fresh guards.
  Local transactions preserve domain batch sizes/labels; small wire limits apply at admission. Failed outcomes retain ordered rollback receipts; the session
  must consume them before acknowledging failure. Batch preparation precedes
  execution; a failing executed member publishes its inner and outer rollback.
  Plate duplicate/delete history shares admitted snapshots, and plate duplicate source guards
  compare full canonical content without retaining large serialized strings.
  A native session now checks exact bundle membership/metadata, owns a bounded
  request queue and executes the generated string protocol. Nonces are host-owned;
  queued edits check project, assets and history, while save acknowledgement checks
  the captured export identity without treating history-only changes as stale.
  Cancel/close release prepared data immediately but keep bounded settlement slots.
  Post-commit summary overflow reports receiptUnavailable, never false rollback.
  Staged native document input now parses bounded UTF-8 chunks under explicit
  operation budgets, preserving UTF-16 escapes and last-key-wins persisted JSON.
  It does not inherit the stateless request parser's byte/node ceilings. An admitted
  graph and its declared asset budgets precede payload transfer; digest-checked
  owned buffers move into immutable records without a second mesh copy. Staging
  never replaces live state. Hosts must schedule final graph admission/hash work
  off authority. Prepared bundles commit under source/operation guards; Open/reset
  clear history atomically. Rust ZIP/ZIP64, envelope staging and BBS package output are bounded;
  OPC uses pinned Unicode 16 casing; canonical archive completion reconciles BBS
  and adopts unknown members; edited canonical interchange has host tests. Bounded
  native model-XML admission matches 466 production-derived browser cases; ZIP
  structural staging uses the one-part reader and bounded cross-part resolver for
  basic 3MF meshes, units, components and build items. It also decodes standard
  BBS paint roots into sparse facet channels under shared package budgets and
  retains bounded unknown object/component/build/facet attributes. Foreign Open writes the metadata
  members a Save regenerates (to a sink), so values XML 1.0 cannot carry refuse as in the browser. Canonical admission
  checks schema-1 shapes generated from the core's `record!` declarations (`project-shape.ts`). `bbs::foreign` matches browser
  foreign import; `models` matches its STL/OBJ/AMF/ZIP decode/stage/preview/undoable commit and 3MF geometry merge (WASM/JNI/actor). Archive Open/Save are owned WASM/JNI tasks; all limits derive from
  `contracts/project-archive.json`; Kotlin `ProjectDocuments` adapts provider streams (truncates only after packaging); the app's Project area (`ProjectWorkspace`/`ProjectModel`: new/open/save-as/import/undo, recents with persisted grants, incoming VIEW/SEND as untrusted, `ProjectRecovery` per-session copies restored only on matching identity, `DocumentOwners` one writer per document + digest conflict on Save); Workspace = `SceneSync`→`FilamentScene` from render deltas + mesh packets (actor `inspect`); Preview = G-code viewer on `GcodeSession` + `GcodePreviewPlan` + the shared artifact summary (`Session::summary`, also the browser's Rust-adapter source); Prepare = `PrepareModel` slices the active plate (or every plate, each G-code with its plate's core-drawn pictures: [§](docs/engineering/native-core.md#android-slice-outputs)) on the attested external slicer, or with it off on the device's own engine in a `:engine` service ([§](docs/engineering/native-core.md#android-local-slicing)) (Printer/Process/Filament pickers over the bundled catalog (`SlicingProfiles`; core `slicing::configuration` staged as one undoable step; a new project starts from the default profile; an opened project slices as authored until a profile is chosen); consent once per endpoint; result opens in Preview, withdrawn when the project changes; "Send to Printer" sends a still-current slice to the connected printer via `DeviceWorkspace.send`, upload streamed from the held file). Slicing route core: `orcaxr_printer::slicer` (external engine attestation/jobs) + `slicing::plate` runs on the actor (`ProjectWorkspace.projectPlate` writes one plate's archive from the export capture; `ExternalSlicerClient` hosts the route: no redirect/retry, POST never aborted — its reply holds the only cancellable job ID), "New project" = shared `fresh_project`. Project WASM exposes immutable effects/captures; Node-worker replay agrees.
  Browser timestamps use the host's Date.parse with lossless UTF-16 conversion. Hosts must bound inputs before wasm-bindgen copies them and
  dispatch effects before acknowledgement. Explicit JSON export allocates the
  whole serialized capture; chunk reads do not make it a live projection or
  interruptible authority-worker operation. The separate editor package stays
  outside preview downloads/precache. Android now exposes the same session through
  JNI and Kotlin owners, with bounded nonreused handles and an explicit ZoneId
  timestamp resolver. Reserve reply capacity before mutations; refuse reentry
  during callbacks. Concurrent close invalidates the owner without waiting for
  work, and Kotlin releases late captures. A mutation racing close may have
  committed and must not be retried. Debug/release JVM replay qualifies these
  bindings, not Android runtime behavior. A bounded Kotlin actor now schedules
  commands, Open/reset, bulk/clipboard preparation, save/export and ordered effects.
  Opaque actor guards avoid wire ID limits; prepared work keeps its original guard.
  Reserved reply slots preserve confirmed results at capacity and projection failure.
  Copy scans frozen input off authority; paste owns its captured data. Save streams
  frozen bundles; only a successful, still-current handoff clears dirty state.
  App integration remains open. Captured queries expose bounded pages, transforms,
  filament inheritance and asset declarations; `objects_tree` pages visible tree rows
  (host-folded search). Read names/IDs in bounded UTF-16 chunks. Query addresses never
  become command IDs. Plate/range sorting has an explicit entry budget and belongs on an owned projection executor. Authored
  mesh declarations are not validated GPU buffers. Production subscriptions,
  worker/JNI integration, other command families and Android editing beyond selection/object/plate/transform edits and creation (primitives, helper volumes, clipboard, bed fill through a typed staged-record writer: [native-core](docs/engineering/native-core.md#android-creation)), filaments (list, slot edits, assignment, virtual library: [§](docs/engineering/native-core.md#android-filaments)), model tools (split, simplify, measure, assembly, emboss/SVG parts; no repair: [§](docs/engineering/native-core.md#android-model-tools)) and settings panels (scoped settings, height ranges: [§](docs/engineering/native-core.md#android-settings-panels)) remain open.
- SHA-256 identifies artifacts/project/config outputs. Canonical FNV-1a64
  identifies source assets and semantic snapshots where explicitly defined.
  Never substitute one for the other or infer engine statistics from observations.
- Canonical JSON cloning preserves own `__proto__` properties as data without
  changing object prototypes. Imported descriptor/config keys must not disappear
  or become inherited properties during a defensive copy.
- Standard BBS projection and the canonical envelope have different roles.
  Consumed metadata is not also retained as an opaque blob. OPC relationships
  may only target members actually present in the package.
- BBS plate membership comes from `(object_id, instance_id)` metadata, with
  exact source plate origins. Canonical transforms remain plate-local. Component
  IDs are model-part-local; resolve normalized paths, cycles/depth/expansion
  limits and transforms before flattening. Never guess membership from geometry.
- Paint stores stable physical/mixed filament IDs and sparse refined-facet version-2 state, not
  palette colors or one canonical object per triangle. Topology-changing operations must explicitly
  remap or reject dependent data. Rust validates all five sparse channels; BBS hex decoding budgets
  explicit roots across channels, and writing borrows existing trees. Sparse import assembly never
  expands unpainted roots. Normalize/remap assignments and splits together so collapsed paint
  survives. Dense expansion requires an explicit host root budget; the stateless canonicalizer's
  parser limits are not persisted project limits. Graph validation now checks annotation/source
  topology consistency; revision plate requests have native session guards; native paint strokes
  stage one guarded commit each; splits/simplifications prepare on a guard and stage under host IDs.
  Emboss takes glyph contours or a font file (the core's port of the browser's TrueType reader), SVG the file's bytes (as `File.text()`); a part stores the drawing it names.
  Assembly plans are session-free (two features in, one `setInstanceTransform` out); an exploded view moves drawn instances only: picks/edits read canonical placement.
- Smart Paint is a validated, bounded proposal plus operator correction and one
  canonical transaction. Check per-provider/payload consent before sending data.
- Wipe towers reserve their complete printed footprint against the printable rectangle's actual origin,
  including brim/ribs; planning, ghosts and preflight share one footprint authority. A bed's far corner is
  not its size: every placement uses `WorkspaceBed` `areaMm`/`volumeMm`, the box the slice preflight checks
  ([§](docs/engineering/native-core.md#android-placements-inside-the-build-volume)). The workspace three.js world is scaled, Y-up and bed-centred: geometry tools read
  printer mm via `root.matrixWorld⁻¹ × display.matrixWorld`; brim ears are object-local (all model parts, instance transform only). Shared bed/inspector fields/Android placement: [native-core](docs/engineering/native-core.md#workspace-bed); Android inspector: [§](docs/engineering/native-core.md#android-transform-inspector).

## Surface and startup ownership

- Core workspace, shell, required profiles and settings determine readiness.
  Optional unused camera, printer, AI and XR features remain idle. Failed optional
  initialization degrades health; failed core data disables dependent actions.
- Initialization scopes own resources before mounting, settle cancellation,
  reject late results, and dispose partial initialization. Retry is single-flight.
  A failed module load can require reload, which must use the unsaved-work guard.
- Shell surface lifetimes own handlers, callback bindings, subscriptions, panels
  and observers. Preserve cached documents on persisted pagehide; permanent
  departure releases them. Lazy children must inherit shell cancellation.
- Controllers expose typed intents/results and explicit disposal. Keep dependency
  construction in the composition root and UI-independent behavior in controllers.
- The XR rail renders all `xr-toolbar` actions in declared group order with labels,
  including every painting channel. Do not reinstate the obsolete seven-action rail.
- One physical spatial surface uses one `UICard` pivot and one UI system. Never
  mix core View children with UIBlocks children on the same surface. Set physical
  dimensions and pixel size explicitly; use exact-typed `XrUiAdapter` mutations.
- UIBlocks needs all three: `enableUI()`, `uikit.enable(uikit)`, and its raycaster
  sort function. Bundled local icons must work offline and under CSP.
- `ScriptsManager` owns card updates and Core owns scene gesture dispatch. No
  second update loop or scene selectstart/selectend path. The lifecycle-owned
  synchronous XR file-picker activation exception never manipulates the scene.
- Hidden scripts are not automatically free. Preserve per-controller gesture
  suppression, modal cancellation, keyboard access and equivalent DOM controls.
  Simulator rendering does not qualify controller/hand/gaze behavior on hardware.
- Camera polling has one cancellable frame at a time. Hiding, changing or disposing
  the panel cancels pending work; recheck visibility and identity after connection.

## Persistence and recovery

- Snapshot serialization never clears dirty state. Only manual download handoff
  followed by an exact project/revision/semantic/asset guard acknowledges a saved
  checkpoint. A browser download confirms handoff, not completion of a disk write.
- Browser serialization uses an owned worker and one prioritized queue. Coalesce
  autosaves; manual export has priority after active work. Unavailable workers
  disable recovery visibly; explicit manual export may fall back on the main thread.
- Recover after five idle seconds, with a thirty-second maximum scheduling delay.
  IndexedDB insertion, sequence allocation and retention are one transaction.
  Keep three snapshots per project/session, default 512 MiB total budget, and do
  not prune another tab's lineage or unsupported future-schema records.
- Validate archive integrity and canonical identity before recovery through the
  existing import pipeline. Recovered content stays dirty until manually saved.
- DOM and XR expose recover/download/discard and Save/Discard/Cancel. Guard New,
  Open/Replace, startup reload, app navigation and PWA update. Only dirty projects
  install beforeunload; use visibility changes for best-effort capture.
- PWA updates are explicit and coordinated with persistence. Do not auto-reload or
  activate a worker over unsaved edits. Keep unknown recovery versions intact on
  rollback. See [operator recovery guidance](docs/project-recovery.md).

## Networking, printer and server safety

- Plain HTTP LAN is intentional (Android: cleartext only to local addresses, `LanTransportPolicy`). Assume secure-context APIs are absent: WebCrypto
  subtle/randomUUID, service workers, clipboard and isolation must degrade explicitly.
  Content SHA-256 has a byte-identical fallback; getRandomValues supplies random IDs.
- HTTPS-to-HTTP LAN failures need an actionable Local Network Access/mixed-content
  diagnosis. Prefer the operator's same-origin all-in-one server when available.
  Do not misreport a browser block as an offline printer or guess schemes/ports.
- `web/src/printer/` is the Moonraker boundary. Full authoritative queries replace
  state; partial notifications alone merge. Unknown/missing readiness fails closed. `orcaxr-printer` ports
  status, control, summary, tool mapping, preparation, send workflow, session, transport (effect machines), storage, history, console, camera and the printer directory (plan/finish/read + panel text; console names commands as Klipper parses them; camera URLs by WHATWG; a saved printer is the endpoint its address names; printer text on the intent `bulk` tier) and Moonraker URL/credential/handshake policy (WHATWG `url`); merge prototype-free, own keys only. A socket blink never aborts HTTP work; replies/params leave steps via `take_*`. Browser printer connections, session and sends run on it (`SharedMoonrakerTransport`/`SharedPrinterSession`/`SharedPrintWorkflow`, printer-only core, precached); `?printer-transport=typescript` = rollback. Android: `MoonrakerClient` (OkHttp, no retry, so every LAN client keeps idle connections only 2 s via `LanTransportPolicy.idleConnections()` — Node closes them at 6 s and a reused dead one fails; `LocalNetworkAccess` refuses LAN exchanges up front without SDK 37's `ACCESS_LOCAL_NETWORK`; lifecycle verified by `emulator-smoke.py --api 37`), `PrinterSessionClient`, `PrintWorkflowClient` host them; the app's Device area (`DeviceWorkspace`/`DeviceModel`) drives them; its discovery (`PrinterDiscovery`, DNS-SD `_moonraker._tcp` via `AndroidPrinterDiscovery`) only proposes printers a keyless handshake verified, stale runs dropped, nothing saved until added.
- Printer commands bind immutable printer session/job identities. Reconfirm changed jobs, reconnects and switches; reject duplicate/stale gestures. Emergency stop
  and distinct firmware restart remain reachable without successful status queries.
- Submission owns upload, preparation, start, cancellation and uncertain outcomes.
  Revalidate artifact/session/tool mapping/readiness after upload and before mutation.
  Use random non-overwriting names; explicit overwrite binds exact fresh metadata
  and cannot replace an active file. Do not retry an uncertain start blindly.
- Discovery probes without mutating preferences, then atomically commits endpoint,
  enabled state and attestation only for the still-current connection generation.
  Preserve explicit disable; unavailable storage leaves session-only operation.
- Printer/slicer credentials are optionally remembered in device-local storage (browser: not
  encrypted; Android: `CredentialVault`, Keystore AES-GCM, forget drops key). AI keys are tab-memory only. Never log credentials,
  full engine errors or unbounded private data. Source cleanup does not revoke keys.
- Native output stays private until successful process exit and bounded regular-file
  validation. Track the owned process group after leader exit, escalate TERM to KILL,
  and wait for live descendants before freeing capacity. Retain container `init: true`.
- Downloads are repeatable until terminal TTL or explicit release. Active transfers
  hold leases. Capacity refuses new work instead of evicting unexpired results.
  Clients re-fetch a dropped/short/mismatched download (≤3), validate, then release; old servers use TTL.
- Cancellation has one independent deadline for DELETE, response bodies, polling and
  delays. Distinguish confirmed cancellation, already-terminal and unknown outcomes.
- Serve known static assets before API rate limits. Reserved API misses never return
  SPA HTML. Preserve caching, COOP/COEP, permissions, authentication and upload limits.
- Trust forwarded protocol/identity only from the actual trusted socket peer; auth,
  CORS and rate identity share that rule. Tailscale userspace sidecar shares the app
  namespace and adds access while base Compose intentionally keeps LAN publication.

## Memory and engine gotchas

- Rollback uses opaque repository-owned handles sharing immutable asset records
  and cached fingerprints. Public mutable reads and borrowed import payloads still
  copy; consumed native transfers validate before moving their owned buffers.
  Production `peek()` consumers must never mutate descriptors/bytes.
  The Rust repository shares immutable records through owner-bound snapshots and
  read-only leases. Digest lookup follows insertion order; lists/fingerprints use
  UTF-16 ID order. Public restore validates before publishing and creates fresh
  record identities even for equal content. The native command owner uses these
  snapshots for rollback; worker/JNI project integration and editing UI remain open.
- Preserve zero-payload-copy commands and bounded workers. Native BBS authoring borrows
  mesh/paint/configuration/emboss/recipe data; resource IDs differ from sidecar ordinals.
  Read [large-model contracts](docs/engineering/large-models.md) before mesh/paint/preview/history changes; never commit private models.
- Browser G-code preview indexes in an owned worker before allocating rich columns.
  Each window holds at most 240,000 records; checkpoints inside large layers and
  Previous/Next moves preserve access. Source replacement terminates the worker.
- Rich G-code preview preserves semantic record IDs, tool/modal state, source spans, arc
  interpolation and incomplete-prefix diagnostics; letters are ASCII only (upstream reads bytes).
  Rendering consumes projected colors/filtering and reports unsupported metadata honestly.
- Android decodes G-code bytes with `decode_utf8` (TextDecoder's rules); views require an explicit
  captured model and exact requested window. Validate output relations before rendering and keep
  the capture identity; matching dimensions alone cannot associate two packets. `core-bridge` androidTest
  runs only on an emulator (`android-smoke.py`, disk-backed AVD home): rerun it whenever its corpora change.
- Canonicalization and G-code transport types come from shared request schemas. Rust decoding must require objects: ordinary Serde struct decoding also accepts
  positional arrays. Reject duplicate envelope/option keys; only the inner JSON
  being canonicalized keeps JavaScript's last-key-wins behavior.
- A pinned G2/G3 arc remains one semantic source record; no partial arc is published
  on parser cap failure. Preserve Float32 operation order and bounded path-point data.
- Never instantiate slicing-engine WASM to warm the cache: each instance commits a 256 MiB shared
  heap and ten workers. Prefetch/drain bytes only. Shrinking the thread pool without
  device qualification can deadlock synchronous threaded slicing.
- `/slicer/` uses NetworkFirst and is excluded from precache. A service worker from
  an earlier production/preview visit can control the same origin's dev server.
- PrintConfig `coStrings` vectors use semicolons; other vectors use commas. BBS JSON
  values are strings/string arrays, with complete physical-filament vector lengths.
- The native BBS loader stages embedded configuration in `Model`'s backup path
  even without `LoadAuxiliary`. Set an owned, writable job directory before load;
  mesh-load success alone does not prove configuration loaded. Never fall back
  to generic settings after a staging failure.
- Engine static initialization can log before `main()`. Internal native fixture
  results use an exclusive private file, accepted only after exit zero and bounded
  regular-file validation; stdout is diagnostic data, not the result protocol.
- On wasm32, cast vector size to signed before subtracting one for signed loops.
  Unsigned `size() - 1` otherwise zero-extends into a huge signed 64-bit index.
- The native CLI needs typed machine/process/filament preset inputs and
  `--arrange 0 --orient 0`. Preserve source patches for partial-config null guards
  and headless multi-filament loading. Do not change U1 start G-code casually.

## Verification and delivery

Use the existing gates; fix failures instead of weakening them or raising bundle
ceilings. Run the full web gate for web changes. Prefer focused regressions before
behavior changes, then the complete required gate and a verified commit.

```sh
npm --prefix web run quality
npm --prefix server test
npm --prefix wasm run verify:artifacts
npm --prefix web run parity:report
npm --prefix web run parity:report:check
npm --prefix server run test:deployment
./scripts/quality.sh
```

Additional targeted commands:

```sh
npm --prefix web run profiles:verify
npm --prefix web run settings:verify
npm --prefix web run calibration:verify
npm --prefix web run bench:assets
npm --prefix web run bench:preview
npm --prefix web run test:recovery-storage
npm --prefix server run test:deployment:container
npm --prefix server run test:native:container
```

- Run full development-dependency audits at moderate severity for web, server and
  wasm. Run the configured source secret scan with redaction; do not weaken rules
  or expose findings in logs. Run directory scans from the source snapshot root;
  absolute scan roots bypass the anchored schema-key allowlists. Maintenance SSH
  verifies known hosts and uses keys/agent or an explicit terminal password prompt.
- Release qualification includes Compose validation, fresh native source/container
  assembly, supported HTTP/HTTPS browser checks, process reaping, real slicing and
  artifact verification. Keep builds at conservative priority/concurrency on the
  shared host (`ORCA_BUILD_JOBS=1` when busy); never terminate unrelated workloads.
- Real deployment tests use Express, the built UI, a printer simulator and an
  ephemeral HTTPS proxy. They do not authorize real machine commands or deployment.
- Record actual evidence in [audit remediation status](docs/audit-remediation-status.md)
  and generated parity reports. Explicitly preserve outstanding operational
  credential rotation, independent review/security and supervised U1/CC/Galaxy XR
  qualification. Automated browser/renderer tests are not hardware evidence.

## Related design and patch guidance

- [DESIGN.md](DESIGN.md) — XR UX specifications and baselines.
- [Patch rules](patches/README.md) — rules for reproducible engine patches.
