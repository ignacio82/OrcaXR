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
  between Jetpack XR artifacts, upstream OrcaSlicer commits that must/must-not
  be picked up.
- **Architectural decisions** reached in conversation — module splits,
  threading model, JNI boundaries. Record the decision *and the reason*.
- **User preferences** expressed during work — how they want commits
  structured, code style calls, what they consider out-of-scope.
- **Non-obvious code behavior** — things that surprised you reading the
  code and will surprise the next session too.

Do **not** record things already derivable from reading the code (file
paths, function signatures, module names) unless they're load-bearing
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

**For overnight / async work:** ship verified end-to-end commits, not
plans. Build, run the relevant tests, and iterate until green before
calling it done. A failing test left for the user to find is a
half-finished task.

## Mission

Build an XR-first 3D printing slicer for Web and XR devices. Not a port of
OrcaSlicer's wxWidgets UI — a ground-up XR UX with OrcaSlicer's slicing
engine (`libslic3r` via WASM) as the computational core.

## Target platform

- **Primary:** Web browsers and XR devices via WebXR/XRBlocks.
- **Target printers:** Snapmaker U1 (4-head toolchanger), Elegoo Centauri
  Carbon. Both are Klipper + Moonraker; this codebase has *no* serial,
  USB, or vendor-cloud printer support.
- **Not currently targeted:** native Android, native PCVR.

## Stack

| Layer | Choice |
|---|---|
| UI | HTML/JS/CSS |
| 3D & XR | XRBlocks for Spatial UI, 3D interaction, WebXR |
| Slicing core | OrcaSlicer `libslic3r` via WASM in the browser or via the Node.js backend server |
| Network | `fetchLocalNetwork`; typed Moonraker HTTP/WebSocket boundary (live read-only handshake/slot inspection) |

## Read the relevant technical context

This file contains the cross-cutting rules. Before changing an area, read its
maintained topic document and follow its constraints. Update that document in
the same commit when behavior changes; do not append a second source of truth.

| Area | Required context |
| --- | --- |
| Canonical graph, history, imports, settings, geometry, painting, statistics, parity | [Project contracts](docs/engineering/project-contracts.md), [parity plan](docs/parity.md) |
| DOM/XR surfaces, registry, input, XRBlocks APIs and lifecycle | [XR and UI](docs/engineering/xr-and-ui.md) |
| Browser startup, persistence, printers, external slicing, server and deployment | [Runtime and deployment](docs/engineering/runtime-and-deployment.md) |
| Mesh storage/import/export, preview, memory, responsiveness | [Large-model contracts](docs/engineering/large-models.md) |
| WASM/native engine changes and build gotchas | [Current slicing constraints](docs/engineering/slicing.md), [Snapmaker build notes](wasm/patches/README-snapmaker.md) |
| Retired Android/JNI implementation only | [Historical Android notes](docs/historical/android-slicer-notes.md) |

The Android notes preserve old patches and investigations. They are not the
production engine or profile authority. Native Android and native PCVR remain
out of scope unless the user explicitly changes the target.

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
- Generate parity manifests/reports through `tools/parity/`; never hand-edit
  them. Mapping a leaf or rendering a control is not evidence of live parity.
  Preserve incomplete human review, security, firmware, calibration and Galaxy
  XR gates until their evidence exists.
- Generate settings and scope tables from pinned definitions. Engine precedence
  is object, then part, then height range; the last wins. Reject authoring at
  unsupported scopes while preserving imported values for lossless round trips.
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
- `ActionRegistry` is the sole invocation/availability gateway for DOM, XR,
  menus, shortcuts, command palette and contextual Objects actions. A capability
  marked implemented needs a real handler and evidence. A DOM-only dialog must
  declare its XR exclusion until a complete headset flow exists.
- Canonical slice preflight uses exact catalog/imported configuration. Three
  display defaults are never safety inputs. Imported projects slice as authored,
  without silently rebinding to a convenient bundled preset or dropping settings.
- Published G-code binds exact project/revision/config/asset/engine identities.
  Preview, download and send reject drift. Keep output hashing and authoritative
  sidecar provenance intact; missing information remains unavailable.
- SHA-256 identifies artifacts/project/config outputs. Canonical FNV-1a64
  identifies source assets and semantic snapshots where explicitly defined.
  Never substitute one for the other or infer engine statistics from observations.
- Standard BBS projection and the canonical envelope have different roles.
  Consumed metadata is not also retained as an opaque blob. OPC relationships
  may only target members actually present in the package.
- BBS plate membership comes from `(object_id, instance_id)` metadata, with
  exact source plate origins. Canonical transforms remain plate-local. Component
  IDs are model-part-local; resolve normalized paths, cycles/depth/expansion
  limits and transforms before flattening. Never guess membership from geometry.
- Paint stores stable physical/mixed filament IDs and sparse refined-facet
  version-2 state, not palette colors or one canonical object per triangle.
  Topology-changing operations must explicitly remap or reject dependent data.
- Smart Paint is a validated, bounded proposal plus operator correction and one
  canonical transaction. Check per-provider/payload consent before sending data.
- Wipe towers reserve their complete printed footprint against the printable
  rectangle's actual origin, including brim/ribs. A bed's far corner is not its
  size; planning, ghosts and preflight share the same footprint authority.

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

- Plain HTTP LAN is intentional. Assume secure-context APIs are absent: WebCrypto
  subtle/randomUUID, service workers, clipboard and isolation must degrade explicitly.
  Content SHA-256 has a byte-identical fallback; getRandomValues supplies random IDs.
- HTTPS-to-HTTP LAN failures need an actionable Local Network Access/mixed-content
  diagnosis. Prefer the operator's same-origin all-in-one server when available.
  Do not misreport a browser block as an offline printer or guess schemes/ports.
- `web/src/printer/` is the Moonraker boundary. Full authoritative queries replace
  state; partial notifications alone merge. Unknown/missing readiness fails closed.
- Printer commands bind immutable printer session/job identities. Reconfirm changed
  jobs, reconnects and switches; reject duplicate/stale gestures. Emergency stop
  and distinct firmware restart remain reachable without successful status queries.
- Submission owns upload, preparation, start, cancellation and uncertain outcomes.
  Revalidate artifact/session/tool mapping/readiness after upload and before mutation.
  Use random non-overwriting names; explicit overwrite binds exact fresh metadata
  and cannot replace an active file. Do not retry an uncertain start blindly.
- Discovery probes without mutating preferences, then atomically commits endpoint,
  enabled state and attestation only for the still-current connection generation.
  Preserve explicit disable; unavailable storage leaves session-only operation.
- Printer/slicer credentials are optionally remembered in device-local storage,
  which is not encrypted by OrcaXR. AI keys are tab-memory only. Never log credentials,
  full engine errors or unbounded private data. Source cleanup does not revoke keys.
- Native output stays private until successful process exit and bounded regular-file
  validation. Track the owned process group after leader exit, escalate TERM to KILL,
  and wait for live descendants before freeing capacity. Retain container `init: true`.
- Downloads are repeatable until terminal TTL or explicit release. Active transfers
  hold leases. Capacity refuses new work instead of evicting unexpired results.
  The browser validates digest/length before best-effort release; old servers use TTL.
- Cancellation has one independent deadline for DELETE, response bodies, polling and
  delays. Distinguish confirmed cancellation, already-terminal and unknown outcomes.
- Serve known static assets before API rate limits. Reserved API misses never return
  SPA HTML. Preserve caching, COOP/COEP, permissions, authentication and upload limits.
- Trust forwarded protocol/identity only from the actual trusted socket peer; auth,
  CORS and rate identity share that rule. Tailscale userspace sidecar shares the app
  namespace and adds access while base Compose intentionally keeps LAN publication.

## Memory and engine gotchas

- Rollback uses opaque repository-owned handles sharing immutable asset records
  and cached fingerprints. Public mutable reads and untrusted imports still copy
  and validate. Production `peek()` consumers must never mutate descriptors/bytes.
- Preserve the measured zero-payload-copy command path and bounded worker lifetimes.
  Read the detailed large-model document before changing mesh parsing/serialization,
  painting, preview or history. Do not commit private real-world qualification models.
- Browser G-code preview indexes in an owned worker before allocating rich columns.
  Each window holds at most 240,000 records; checkpoints inside large layers and
  Previous/Next moves preserve access. Source replacement terminates the worker.
- Rich G-code preview preserves semantic record IDs, tool/modal state, source spans,
  arc interpolation and explicit incomplete-prefix diagnostics. Rendering consumes
  projected colors/filtering and reports unsupported metadata honestly.
- A pinned G2/G3 arc remains one semantic source record; no partial arc is published
  on parser cap failure. Preserve Float32 operation order and bounded path-point data.
- Never instantiate WASM to warm the cache: each instance commits a 256 MiB shared
  heap and ten workers. Prefetch/drain bytes only. Shrinking the thread pool without
  device qualification can deadlock synchronous threaded slicing.
- `/slicer/` uses NetworkFirst and is excluded from precache. A service worker from
  an earlier production/preview visit can control the same origin's dev server.
- PrintConfig `coStrings` vectors use semicolons; other vectors use commas. BBS JSON
  values are strings/string arrays, with complete physical-filament vector lengths.
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
  or expose findings in logs. Maintenance SSH verifies known hosts and uses keys/
  agent or an explicit terminal password prompt.
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
