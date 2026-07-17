<!-- markdownlint-disable MD013 MD060 -->

# OrcaXR ↔ Snapmaker OrcaSlicer parity plan

> Canonical implementation plan. This document supersedes the now-removed historical
> `docs/orca_parity_plan.md`, whose action counts and completion claims were not trustworthy.

| Plan field | Value |
|---|---|
| Parity target | Snapmaker OrcaSlicer v2.3.4, commit `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626` |
| Initial repository audit | 2026-07-12 UTC |
| Overall status | `IN_PROGRESS`; the truth/quality/domain foundation tranche is implemented, while manual P0 qualification and P1–P12 product parity remain open |
| Broad parity claim | **Not permitted** until P12.6 is `[x]` |
| Primary targets | Snapmaker U1, Elegoo Centauri Carbon; desktop/mobile web and Galaxy XR |

## 1. Contract, baseline, and scope

The target is user-outcome parity with Snapmaker's OrcaSlicer **v2.3.4**, tag
[`v2.3.4`](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.3.4), commit
[`9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`](https://github.com/Snapmaker/OrcaSlicer/tree/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626),
published 2026-06-11. The comparison target is the Snapmaker fork, not upstream
SoftFever/OrcaSlicer. The checked-in browser slicer and the external CLI must continue to
come from that same source revision.

The audited local `third_party/SnapmakerOrca` checkout is at that commit; its known dirty files
are the OrcaXR WASM/build port, while the compared GUI sources match the tag. P0 must turn that
state into a reproducible, reviewable patch set with source and artifact hashes. A moving tag or
an unexplained dirty checkout is not an acceptable parity baseline.

“Parity” means that a user can complete the same preparation, configuration, slicing,
preview, calibration, and printer-management workflows and obtain materially equivalent
results. Pixel-for-pixel desktop imitation is not required; the web, mobile, and spatial
interfaces should use their platform well. Their usability, feedback, accessibility, and
visual finish must be at least as good as the official application.

The supported production targets are Snapmaker U1 and Elegoo Centauri Carbon. Additional
printers and profile families may be added, but do not weaken or bypass acceptance tests for
these two. Printer communication is implemented through Moonraker. Serial/USB discovery,
native filesystem integration, OS shell integration, and vendor-cloud-only functions need
outcome-equivalent web adaptations rather than desktop APIs.

The following rules prevent “parity” from becoming a count of visible buttons:

1. Every visible action must declare one of `implemented`, `partial`, `unavailable`, or
   `blocked`, plus a machine-readable reason for every state except `implemented`.
2. An action that only changes a status string, opens an empty shell, or silently drops data
   is not implemented. It must be disabled or clearly labelled until its acceptance tests
   pass.
3. Imported projects must round-trip without losing supported object hierarchy, instances,
   settings, paint, filament assignments, mixed-filament definitions, or plate metadata.
4. Slicing edited projects must use the same canonical project state as the editor. Falling
   back to a geometry-only path that discards metadata is not parity.
5. A web adaptation may be accepted only when the same user outcome is possible and the
   difference is documented in the adaptation register. “Not applicable” is not a shortcut.
6. All upstream settings and actions are covered by generated manifests. New upstream items
   fail the drift check until mapped, implemented, adapted, or explicitly blocked.

### Status notation

- `[ ]` not complete.
- `[~]` implementation exists but the complete acceptance gate has not passed.
- `[x]` complete and verified; the evidence ledger contains reproducible proof.
- `[!]` externally blocked; owner, blocker, and next review date are recorded.

Do not mark an item `[x]` because code exists, a button is wired, or one happy path works.
Only change it after all acceptance bullets for that item pass in CI and the evidence ledger
is updated. If implementation reveals missing work, update this plan in the same change:
split the item, add dependencies and tests, update the coverage matrix, and retain a
“superseded by” note so scope cannot disappear silently.

### Upstream references

Use commit-pinned source as the behavioral authority and the official manual for user-facing
intent. Useful entry points are:

- [Snapmaker OrcaSlicer source at the parity commit][up-root] and the
  [v2.3.4 release notes](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.3.4).
- [v2.3.3 FullSpectrum release notes](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.3.3),
  which introduce Ratio, Cycle, Match, and Gradient mixing.
- [Official OrcaSlicer wiki](https://www.orcaslicer.com/wiki/), including
  [basic preparation](https://www.orcaslicer.com/wiki/print_prepare/prepare_basic),
  [object organization](https://www.orcaslicer.com/wiki/print_prepare/prepare_object_set),
  [color painting](https://www.orcaslicer.com/wiki/print_prepare/prepare_color_painting),
  [support painting](https://www.orcaslicer.com/wiki/print_prepare/prepare_support_painting),
  and [seam painting](https://www.orcaslicer.com/wiki/print_prepare/prepare_seam_painting).
- [Moonraker API documentation](https://moonraker.readthedocs.io/en/latest/external_api/introduction/),
  [file API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/), and
  [job queue API](https://moonraker.readthedocs.io/en/latest/external_api/job_queue/).
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and
  [WebXR Device API](https://www.w3.org/TR/webxr/) for platform quality gates.
- [XRBlocks Spatial UI][xrblocks-ui], [UIBlocks][xrblocks-uiblocks],
  [Inputs][xrblocks-inputs], and [Simulator][xrblocks-simulator] manuals for spatial intent,
  checked against the version-pinned [UIBlocks implementation guide][xrblocks-uiblocks-guide],
  [samples][xrblocks-uiblocks-samples], and [testing guide][xrblocks-testing-guide].

## 2. Definition of done and evidence policy

Every implementation item below inherits this definition of done unless it explicitly adds
stricter criteria.

- **Behavior:** all documented paths, edge cases, undo/redo behavior, errors, and destructive
  confirmations work. No placeholder handler or false success message remains.
- **Data:** stable IDs, units, configuration inheritance, and references survive save/open,
  autosave recovery, browser reload, and upstream OrcaSlicer round-trip. Unknown 3MF metadata
  is preserved when safe rather than silently discarded.
- **Slicer:** configuration reaches the Snapmaker engine with correct types and vector
  delimiters; project slicing produces valid G-code and expected tool/filament behavior.
- **Interfaces:** desktop pointer/keyboard, narrow touch layout, and XR controllers/hands can
  complete the same outcome. A compact XR rail may expose only common tools if the full set
  remains reachable in menus or panels.
- **Quality:** loading, empty, disabled, progress, success, cancellation, and error states are
  designed; focus is restored after dialogs; controls meet WCAG 2.2 AA contrast, name, role,
  keyboard, target-size, and reduced-motion requirements.
- **Verification:** unit and integration tests cover state and serialization; Playwright covers
  the user flow; representative 3MF/G-code golden fixtures cover engine behavior; relevant
  real hardware and XR scenarios are recorded.
- **Documentation:** user help, limitations, migration notes, and the parity/adaptation manifests
  are updated. Upstream source and manual links identify the compared behavior.
- **Performance:** interaction remains responsive on the reference mobile/XR device; long work
  runs in a worker and can be cancelled; budgets in P10 are met.

Evidence is recorded in §20. An evidence row must include task ID, commit, date, commands,
fixture(s), browser/device/printer, result links or artifacts, reviewer, and any residual
limitation. A later regression reopens the item to `[~]` or `[ ]`.

## 3. Audited starting point (2026-07-12)

This table is an observation, **not** completion credit. “Present” means code was found; it
does not satisfy the definition of done.

| Area | Baseline observation | Primary local anchors |
|---|---|---|
| Application shell | Menus, DOM shell, XR shell, profiles, plates, slicing, and preview exist. The central workspace is a ~3,800-line coordinator. | [`main.ts`](../web/src/main.ts), [`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts), [`DomShell.ts`](../web/src/ui/dom/DomShell.ts), [`XrShell.ts`](../web/src/ui/xr/XrShell.ts) |
| XRBlocks UI | Required bootstrap and raycast sorting exist, but direct non-reactive property writes, invalid CSS-like/behavior options, fake types, duplicate card updates and controller dispatch, incomplete UI-hit suppression/disposal, runtime CDN icons, and unqualified XR scrolling make the current surface unreliable. | [`main.ts`](../web/src/main.ts), [`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts), [`XrShell.ts`](../web/src/ui/xr/XrShell.ts), [`package-lock.json`](../web/package-lock.json) |
| Capability truth | 111 actions report no `comingSoon` entries, but at least 34 handlers are status-only placeholders, including undo/redo, several exports, send-to-printer, view modes, split-to-parts, and most gizmos. | [`ActionContext.ts`](../web/src/actions/ActionContext.ts), [`ActionRegistry.ts`](../web/src/actions/ActionRegistry.ts), [`gizmos.ts`](../web/src/actions/groups/gizmos.ts) |
| Scene model | Workspace selection is a flat `ModelEntry`; plates own model arrays. There is no integrated object/volume/instance/layer-range tree. `PlacedModels` has a separate, incomplete volume concept. | [`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts), [`PlacedModels.ts`](../web/src/features/PlacedModels.ts), [`PlateStore.ts`](../web/src/features/PlateStore.ts) |
| Project I/O | 3MF save/open handles geometry, plate transforms, and an OrcaXR metadata document. It does not preserve the full Orca object hierarchy, part settings, facet annotation state, or all FullSpectrum data. | [`Project3mf.ts`](../web/src/features/Project3mf.ts), [`Write3mf.ts`](../web/src/features/Write3mf.ts), [`Paint3mf.ts`](../web/src/features/Paint3mf.ts) |
| FullSpectrum | Imported virtual definitions can be previewed and passed through project slicing. “Add Virtual Filament” currently adds an ordinary palette slot; there is no integrated authoring/editing lifecycle for Ratio/Cycle/Match/Gradient. | [`MixedFilamentStore.ts`](../web/src/features/MixedFilamentStore.ts), [`MixedFilamentPreview.ts`](../web/src/features/MixedFilamentPreview.ts), [`filamentMixerModel.ts`](../web/src/features/filamentMixerModel.ts), [`FilamentPalette.ts`](../web/src/workspace/FilamentPalette.ts) |
| Painting | 3MF triangle-selector decoding and a painted-volume slicing path exist. Live painting is a radius-based vertex-color mutation, not canonical per-facet painting, and most official tools/remapping are absent. | [`Paint3mf.ts`](../web/src/features/Paint3mf.ts), [`PaintedSlice.ts`](../web/src/features/PaintedSlice.ts), [`PaintHistory.ts`](../web/src/features/PaintHistory.ts), [`AiPaintEngine.ts`](../web/src/features/AiPaintEngine.ts) |
| Settings | A hand-maintained inspector and partial key list exist. Some controls are intentionally shown without backend behavior, and enum/domain metadata is incomplete. | [`SettingsInspector.ts`](../web/src/ui/dom/SettingsInspector.ts), [`SettingsConfig.ts`](../web/src/actions/SettingsConfig.ts), [`profileKeys.ts`](../web/src/slicer/profileKeys.ts) |
| Slicing | Browser WASM, worker slicing, project-3MF slicing, painted-volume slicing, and external async slicing exist. Edited geometry can fall back to a lossy path. | [`SlicerClient.ts`](../web/src/slicer/SlicerClient.ts), [`sliceWorker.ts`](../web/src/slicer/sliceWorker.ts), [`slic3r_wasm.cpp`](../wasm/slic3r_wasm.cpp), [`server.js`](../server/server.js) |
| Preview | A basic line toolpath renderer exists, far short of the official viewer's filters, legends, statistics, and inspection modes. | [`GcodeToolpath.ts`](../web/src/slicer/GcodeToolpath.ts) |
| Printer | Moonraker and generic printer clients exist; end-to-end parity and hardware coverage are not established. | [`MoonrakerClient.ts`](../web/src/features/MoonrakerClient.ts), [`PrinterClient.ts`](../web/src/net/PrinterClient.ts), [`PrintSendFlow.ts`](../web/src/features/PrintSendFlow.ts) |
| Tests/build | `npm run build` passes with ~2.03 MB main and ~4.92 MB Spark chunks. `tsc --noEmit` fails. Several TS tests fail or are stale; the parity test scans a removed Android tree; package scripts and CI do not provide a reliable web gate. | [`package.json`](../web/package.json), [`parity.test.ts`](../web/src/actions/__tests__/parity.test.ts), [workflow directory](../.github/workflows/) |

Three release-blocking correctness examples shape the early phases:

- The current FullSpectrum route treats an imported project as unchanged when the model **count**
  is unchanged. A move, rotation, scale, setting edit, or paint edit may therefore slice the
  original 3MF bytes rather than visible state; adding/deleting can switch to a flattened path
  that loses mixed semantics.
- A painted-slice engine failure currently falls back to monochrome output. This can look like a
  successful job with the wrong material/color intent.
- The external server's WASM worker writes an uploaded project to `/tmp/in.stl` and calls the
  mono entry point, so CLI and browser/server routes are not yet semantically interchangeable.

Known strengths should be retained: the Snapmaker v2.3.4 engine source is shared by WASM and
CLI; imported as-authored 3MF can use project slicing; mixed-filament preview math, mesh cut,
mesh split, paint decoding, painted slicing, and project/config tests already cover useful
building blocks. They are inputs to the work below, not reasons to skip it.

### Implemented foundation tranche (2026-07-17)

The historical table above remains the reproducible starting observation. The current worktree
adds the following dependency-safe foundation; checkbox state and residual qualification gaps in
P0/P1/P6/P10/P11 remain authoritative:

- A deterministic exact-blob extractor maps 1,622 upstream leaves in 13 families from 17 pinned
  source blobs. Duplicate, missing, stale, and synthetic action/setting mutations fail closed.
- All local actions now use one capability registry. The 34 audited status-only placeholders are
  explicitly unavailable; every other action is conservatively partial until its workflow gate
  passes. DOM, menus, shortcuts, command palette, and XR invoke the same availability guard.
- `web/src/project/` supplies a UI-independent canonical graph, immutable assets, stable IDs,
  inheritance/validation, selection, bounded transactional history, revision guards, staged
  import, legacy-v1 migration, canonical slice coordination, ports, and a deterministic
  BBS-compatible 3MF adapter. The live legacy workspace has not migrated yet.
- The 3MF/G-code oracle corpus, generated engine-option schema, local XR icon bundle, CSP/offline
  contracts, production browser/axe smoke tests, artifact provenance checks, and bounded external
  server test harness now run through the repository quality interface.

This tranche does not complete the downstream Objects, FullSpectrum authoring, paint, prepare,
settings UI, preview, calibration, printer, or release-qualification phases. Headless Objects,
filament/recipe, facet-annotation, and settings-editor foundations below are not live product UI.

## 4. Target architecture and invariants

Build parity around one canonical, serializable project graph. UI meshes, tree rows, worker
messages, 3MF parts, and slicer configuration are projections of this graph, never competing
sources of truth.

```text
ProjectState
├── metadata, project config, custom G-code, thumbnails, unknown 3MF extensions
├── FilamentLibrary
│   ├── PhysicalFilament (stable ID, preset, material, color, tool/head)
│   └── MixedFilament (stable virtual ID, components, distribution, gradient, settings)
└── Plate[]
    ├── plate config, printable state, arrangement and wipe-tower state
    ├── Object[]
    │   ├── shared source mesh and object-level config
    │   ├── Volume/Part[] (model/modifier/negative/enforcer/blocker + config + filament ref)
    │   ├── Instance[] (transform, printable state)
    │   ├── LayerRange[] (height interval + config)
    │   └── FacetAnnotations (color/support/seam/fuzzy/brim with topology revision)
    └── selection references (ephemeral, never index-based)
```

Required invariants:

- Every persisted entity has a UUID or imported stable identifier. Array indexes and display
  names are not references.
- Physical tools and mixed/virtual filaments occupy an explicit shared assignment namespace;
  deleting or reordering either performs a transactional remap of every dependent object,
  part, paint facet, wipe-tower setting, and mixed-filament component.
- Instances share object parts, settings, and annotations as OrcaSlicer does; instance
  transforms and printable state remain instance-local.
- A part inherits its object's filament/config until it owns an override. Clearing an object
  filament override clears or explicitly remaps incompatible child overrides, matching the
  upstream rule.
- Mesh-changing operations increment a topology revision and either transfer annotations with
  a tested mapping or ask for confirmation before invalidating them.
- All mutations are commands with atomic `apply`/`revert`, serialization coverage, dirty-state
  classification, and human-readable history labels.
- Expensive geometry, archive, parsing, and slicing work occurs in workers with progress,
  cancellation, stale-result rejection, and structured errors.
- The project serializer emits and consumes the upstream BBS 3MF representation. OrcaXR
  extensions are namespaced and optional; they never replace upstream-compatible metadata.
- Settings are keyed by the engine's canonical option names and typed from a generated schema.
  UI labels are presentation metadata, not storage keys.

Refactor toward bounded modules (`project`, `selection`, `history`, `filaments`, `painting`,
`geometry`, `settings`, `slicing`, `preview`, `devices`) and thin DOM/XR adapters. Do not
attempt a risky all-at-once rewrite of `OrcaWorkspace`; introduce the store and command bus,
move one vertical workflow at a time, and keep migration adapters until golden tests pass.

## 5. Dependency order

```text
P0 truth + green gates
  └─ P1 canonical project graph + lossless 3MF + command history
      ├─ P2.1–P2.4 object/part/instance core
      └─ P6.1 generated settings schema
             └─ P2.5 scoped overrides + P3 FullSpectrum + P4 paint + P5 prepare/files
                    └─ P7 slicing and G-code preview
                        ├─ P8 calibration (also needs P6 preset lifecycle)
                        └─ P9 Moonraker/device workflows (also needs P3 tool mapping)
P10 cross-platform UX, accessibility, localization, and performance runs through P1–P9
P11 application-level workflows closes remaining menu/help/project gaps
P12 independent parity audit, hardware qualification, and release
```

P7 job infrastructure may begin after P1, and P6 schema work can run alongside P2 core, but
their phase exit gates retain the dependencies shown above. P3, P4, and P5 can proceed as
parallel vertical slices once their P1/P2/P6 prerequisites exist.

P10.9's typed XRBlocks foundation precedes production XR feature-panel expansion. P10.10's
single-owner input/update lifecycle and automation may develop alongside those panels, but no
XR workflow may be verified until it passes that gate on the simulator and target headset.

Do not build production FullSpectrum or paint authoring on the current flat palette/mesh state.
Small prototypes are fine, but P1 and the relevant P2 selection/assignment paths are release
dependencies.

## 6. P0 — Make scope and quality gates truthful

Upstream anchors: [`GUI_App.cpp`][up-gui-app], [`MainFrame.cpp`][up-main-frame],
[`Plater.cpp`][up-plater], [`PrintConfig.cpp`][up-print-config], and the complete
[`Gizmos` directory][up-gizmos].

Local starting seams: [`ActionContext.ts`](../web/src/actions/ActionContext.ts),
[`ActionRegistry.ts`](../web/src/actions/ActionRegistry.ts),
[`parity.test.ts`](../web/src/actions/__tests__/parity.test.ts),
[`package.json`](../web/package.json), and [current CI](../.github/workflows/ci.yml).

- [~] **P0.1 — Generate an upstream parity manifest.** Add a pinned extractor under
  `tools/parity/` that records source commit, menu/action identifiers, gizmos, setting keys,
  setting modes, preset types, calibration flows, supported import/export filters, preview
  color/filter modes, and device pages. Store deterministic JSON in `docs/parity/`.
  - Parse authoritative registries where possible; use a small reviewed YAML overlay only for
    runtime-built UI or user-outcome groupings that source parsing cannot infer.
  - Add every item to exactly one local task ID or adaptation ID. Fail on duplicates, missing
    mappings, stale source paths/symbols, or an upstream item with no disposition.
  - Record the source revision and extractor version in generated output. Never edit generated
    manifests by hand.
  - Use the audit's approximate 783 `PrintConfigDef` entries, 493 explicit tab-option placements,
    and 122 tab groups as initial sanity checks, not hand-maintained completion metrics; explain
    any extractor-count difference from exact source syntax.
  - **Accept:** two consecutive generations are byte-identical; mutation fixtures prove that
    adding a fake upstream action/setting fails CI; a reviewer checks a sample from each family
    against the official binary/manual.
  - **Current:** extraction, exact source anchors, dispositions, determinism, and fail-closed
    mutation tests pass for 1,622 leaves. The official binary/manual sample review is pending.

- [~] **P0.2 — Replace boolean/implicit action availability with a capability registry.** Each
  action declares status, reason, supported surfaces, prerequisites, handler, test IDs, and
  help link. Menus, keyboard shortcuts, command palette, DOM toolbar, and XR menus consume it.
  - Convert the status-only handlers in `ActionContext` and helper-generated gizmos to
    `partial` or `unavailable`; disable them with an explanatory tooltip/panel.
  - Add a guard that fails when an `implemented` action has no handler, only calls `setStatus`,
    is not reachable on an applicable surface, or lacks an integration-test mapping.
  - Remove numeric “N actions wired / 0 coming soon” claims. Report capability states grouped
    by workflow and backed by the manifest.
  - **Accept:** registry tests enumerate every action and surface; a UI test proves unavailable
    actions cannot produce false success; the 34+ known placeholders are either implemented or
    truthfully classified.
  - **Current:** one registry and invocation guard serves every current surface; 34 placeholders
    are unavailable and the remainder are partial. Upstream leaf-to-local reachability and full
    browser interaction coverage remain open under P11.2/P12.

- [~] **P0.3 — Establish one green web quality command and CI job.** Add pinned scripts for
  `typecheck`, unit/integration tests, lint/format check, build, parity drift, and end-to-end
  smoke tests; `npm test` must work after `npm ci` without global `tsx`.
  - Fix existing TypeScript failures rather than excluding files: AI response typing, remote
    import declarations, empty `ToolName`, shared-buffer/worker types, XRBlocks types, and
    palette-state typing are known starting points.
  - Repair or replace stale tests that scan deleted Android code, depend on Vite-only
    `import.meta.env`, assume old XR toolbar contents, or compare obsolete token casing.
  - Replace the obsolete Gradle-only CI path with web/WASM/server jobs; retain an explicit
    check that the checked-in WASM matches its source build.
  - **Accept:** a clean clone passes the single documented command and all required CI jobs;
    intentional type/test/parity failures make the job fail.
  - **Current:** `./scripts/quality.sh` and split web/server/WASM/parity CI jobs exist; typecheck,
    tests, production E2E/axe/offline checks, CSP, size, audits, and artifact hashes are gated.
    A clean-clone CI run and the optional native source container build are still required.

- [~] **P0.4 — Build the parity fixture corpus and oracle harness.** Commit only redistributable,
  compact fixtures plus generation recipes for: multi-object/multi-part/multi-instance 3MF;
  object/part/layer overrides; each annotation type; physical and mixed assignments; all four
  FullSpectrum modes; modifiers/negative volumes; multiple plates; custom G-code; STEP/STL/OBJ;
  and representative G-code.
  - Provide structural 3MF comparison that normalizes ZIP order/timestamps but checks model
    graph, config, annotations, and extensions.
  - Provide G-code semantic comparison for tool order, layer/tool changes, extrusion totals,
    bounds, feature roles, temperatures, time/filament estimates, and stable warning sets.
  - Generate reference artifacts with the pinned Snapmaker Orca CLI/app and record exact
    command/profile/source hashes; do not rely on opaque screenshots alone.
  - **Accept:** the harness detects a deliberately removed part assignment, paint facet, mixed
    definition, setting, and tool change.
  - **Current:** the redistributable synthetic corpus and all five required semantic mutations
    pass structural 3MF and semantic G-code self-tests. Snapmaker-generated references, large/
    hostile variants, and remaining comparator semantics are not yet qualified.

- [x] **P0.5 — Add a lightweight architecture boundary before feature expansion.** Define
  interfaces for project store, command/history, selection, serializer, slice adapter, and
  surface adapters. Add dependency rules so domain code cannot import DOM/XR/Three UI objects.
  - **Accept:** a headless test can create, mutate, serialize, reopen, and slice a tiny project
    without constructing `OrcaWorkspace` or a browser shell.
  - **Verified:** the boundary checker and headless add → transform → serialize → reopen → slice
    session pass without browser, Three, XRBlocks, or workspace construction (`EVID-003`).

P0 exit gate: all P0 items pass, baseline manifests are committed, CI is green from a clean
clone, and no placeholder is presented as complete.

## 7. P1 — Canonical project graph, history, and lossless 3MF

Upstream anchors: [`Model.hpp`][up-model], [`bbs_3mf.cpp`][up-bbs-3mf],
[`Project.cpp`][up-project], [`ProjectDirtyStateManager.cpp`][up-dirty], and
[`TriangleSelector.hpp`][up-triangle-selector].

Local starting seams: [`Project3mf.ts`](../web/src/features/Project3mf.ts),
[`Write3mf.ts`](../web/src/features/Write3mf.ts),
[`PlateStore.ts`](../web/src/features/PlateStore.ts),
[`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts), and
[`SlicerClient.ts`](../web/src/slicer/SlicerClient.ts).

- [x] **P1.1 — Implement typed project entities and invariants from §4.** Include plates,
  objects, volumes/parts with semantic type, instances, layer ranges, configs, facet fields,
  physical/mixed filaments, custom G-code, thumbnails, source assets, and extension blobs.
  - Keep source geometry separate from Three.js render objects; reference transferable/indexed
    buffers and explicit transforms/units.
  - Implement inheritance resolvers for project → plate → object → part/layer settings and for
    object → part filament assignment. Expose both effective and locally overridden values.
  - Validate dangling IDs, duplicate IDs, non-invertible transforms, invalid layer ranges,
    incompatible modifiers, out-of-range tool IDs, and cyclic mixed definitions.
  - **Accept:** property tests generate graphs and verify validation, clone/instance semantics,
    inheritance, stable IDs, and deterministic serialization.
  - **Verified:** the canonical model includes every listed entity, separate immutable assets,
    resolvers, validation, stable branded IDs, and deterministic generated-graph tests
    (`EVID-003`). Live application adoption is separately tracked by P1.6.

- [~] **P1.2 — Introduce command history and dirty-state tracking.** All editor mutations,
  including paint strokes, assignment remaps, settings changes, tree reorder, and plate moves,
  use atomic commands.
  - Support transaction/coalescing for drags, paint strokes, and multi-selection; bound memory;
    preserve a saved checkpoint; reject async results created against stale topology/revisions.
  - Dirty categories distinguish project data, presets, and printer/device state so save prompts
    match upstream intent.
  - **Accept:** undo/redo round-trips every command class, restores selection and derived views,
    and reaches byte-equivalent serialized state after undoing to a checkpoint.
  - **Current:** the bounded command bus proves atomic transactions, drag coalescing, rollback,
    checkpoints, independent dirty categories, and revision guards. Legacy workspace mutations
    and the full paint/settings/assignment/tree command catalogue do not use it yet.

- [~] **P1.3 — Replace geometry-only export with BBS-compatible 3MF read/write.** Map every
  supported entity to upstream 3MF model/config structures used by `load_bbs_3mf`.
  - Preferred implementation is a narrow worker/WASM or sidecar-native adapter around the pinned
    libslic3r BBS 3MF loader/writer, with a versioned project DTO, rather than an independently
    guessed TypeScript XML dialect. A browser-native writer is acceptable only after the same
    golden corpus proves field-for-field equivalence and official Orca interoperability.
  - Preserve object/volume relationships, instance transforms, plate placement, printable
    flags, config inheritance, per-part filaments, layer ranges, facet annotations, mixed
    definitions, custom G-code, thumbnails, profile references, and wipe-tower state.
  - Retain safe unknown relationships/files/extensions on open/save. Reject malformed ZIP/XML
    safely with a file/member/field-specific error; defend against path traversal and ZIP bombs.
  - Add explicit schema/version migration for existing OrcaXR metadata. Never infer stable IDs
    from mutable names.
  - **Accept:** each P0 corpus file passes Orca → OrcaXR → Orca and OrcaXR → Orca → OrcaXR
    structural comparison with no supported semantic loss; official Orca opens the outputs
    without repair warnings.
  - **Current:** the deterministic browser adapter emits BBS core/model/project/layer structures,
    round-trips the canonical envelope, preserves unknown safe entries/relationships/attributes,
    and rejects traversal, corruption, bombs, and cancellation. Some BBS projections still use
    the OrcaXR envelope, and official Snapmaker open/save interoperability remains unverified.

- [~] **P1.4 — Make import transactional and diagnosable.** Parse/validate in a worker, preview
  conflicts and unit corrections, then commit once. Cancellation or failure leaves the project
  unchanged. Detect duplicate assets and preserve source filename/provenance.
  - **Accept:** malformed and cancelled imports do not mutate history; very large archives keep
    UI/XR frames responsive; warnings identify each repaired/dropped unsupported field.
  - **Current:** the headless coordinator passes cloned state/assets to an injected parser,
    validates and deduplicates its staged result, preserves import provenance, exposes explicit
    repair/conflict/drop diagnostics and acknowledgement, rejects cancellation/stale previews,
    and commits project/assets/selection as one undoable command. Concrete STL/3MF workers,
    interactive conflict policy, large-archive responsiveness, and UI/corpus qualification remain.

- [~] **P1.5 — Slice only canonical project state.** Build an in-memory or temporary compatible
  3MF for every edited project and use `startSliceProject`/external project slicing. Eliminate
  the edited-geometry metadata-loss fallback.
  - Version the worker protocol and transfer project/slice snapshots immutably. A slice result
    records project revision, profile hashes, engine commit, and warnings.
  - **Accept:** changing a part filament, paint facet, layer override, mixed recipe, instance,
    or plate is reflected in G-code and preview; stale slice completion never replaces a newer
    result.
  - **Current:** the headless coordinator serializes one immutable canonical BBS 3MF snapshot,
    proves that each listed edit changes submitted bytes, records project/profile/engine and
    input/output hashes, supports current/all plates, retry/recovery/timeout/cancel, and rejects
    stale or superseded publication. The legacy workspace and real WASM/server routes are not
    adapted to it yet, so live semantic/oracle/UI/hardware acceptance remains open.

- [~] **P1.6 — Migrate existing workspace data incrementally.** Write adapters from flat
  `ModelEntry`, `PlateStore`, `FilamentPalette`, and existing OrcaXR JSON into `ProjectState`,
  then move render, save, slice, and selection consumers to projections of the store.
  - Delete legacy sources only after fixtures prove equivalent behavior; add a migration note
    and recovery path for locally saved projects.
  - **Accept:** existing sample models/projects still open, arrange, save, slice, and preview;
    no second mutable model list remains.
  - **Current:** explicit Project3mf-v1 and flat ModelEntry/PlateStore/FilamentPalette adapters
    create deterministic IDs and immutable deduplicated assets, convert legacy units/axes,
    validate/repair canonical output, preserve provenance, and retain rejected/unmapped values in
    a recovery payload. Workspace wiring, recovery persistence/UI, indexed/facet-rich legacy data,
    and the no-second-model-list exit condition remain open.

P1 exit gate: the golden project corpus round-trips through official Orca and every edit uses
the canonical graph and history.

## 8. P2 — Objects panel, parts, instances, and per-scope assignment

Upstream anchors: [`GUI_ObjectList.cpp`][up-object-list],
[`ObjectDataViewModel.cpp`][up-object-model], [`GUI_ObjectList.hpp`][up-object-list-h],
[`Model.hpp`][up-model], and the official
[object organization guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_object_set).

Local starting seams: the flat [`ModelEntry` workspace](../web/src/workspace/OrcaWorkspace.ts),
disconnected [`PlacedModels.ts`](../web/src/features/PlacedModels.ts),
[`FilamentPalette.ts`](../web/src/workspace/FilamentPalette.ts), and
[`SettingsInspector.ts`](../web/src/ui/dom/SettingsInspector.ts).

- [~] **P2.1 — Build the hierarchical Objects panel.** Render plate, object, volume/part,
  instance root/instance, settings, layer root/layer range, and info/error rows with stable IDs.
  Show printable, filament/color, support/color-paint, sinking, and editable-state indicators
  where applicable.
  - Support keyboard/touch multi-selection, shift ranges, context menus, rename, expand/collapse,
    reveal-in-scene, scene-to-tree synchronization, filtered search, and virtualization for
    large projects.
  - Selection is entity-based: an object, a part, or one/many instances is distinguishable in
    the inspector and viewport. Hidden/collapsed rows do not lose selection.
  - **Accept:** Playwright covers pointer, keyboard, and touch navigation over every row type;
    10,000 rows remain responsive; DOM semantics form a valid accessible tree/grid.
  - **Current:** a headless projection over canonical `ProjectState` emits every listed row type
    with stable keys/IDs, assignment/paint/printable/editability indicators, ancestor-preserving
    filtering, retained expansion, entity replace/toggle/range selection, keyboard focus
    navigation, tree accessibility metadata, and an O(1) fixed-row virtual window. DOM/XR
    rendering, pointer/touch/context actions, rename/reveal/scene synchronization, Playwright,
    and measured 10,000-row browser/device performance remain open.

- [~] **P2.2 — Implement object/part/instance lifecycle.** Add, import as object/part, rename,
  delete, internal cut/copy/paste, duplicate/clone, create instance, fill bed with instances,
  split to objects, split to parts, merge, assemble/disassemble, reload/replace mesh, and move to
  another plate; toggle printable state at object/instance scope. Browser system-clipboard
  integration is optional; the in-project clipboard and shortcuts must work without extra
  permission.
  - Instances share source object content and annotations; “clone as independent object” makes
    an explicit deep copy. Preserve transforms in the correct local/plate coordinate system.
  - Show confirmation and annotation/config impact before topology-changing split/merge/reload.
  - **Accept:** operation sequences round-trip in 3MF and undo/redo; official Orca reports the
    same object/part/instance counts and transforms.
  - **Current:** canonical commands cover object/instance rename, printable state, subtree-aware
    delete, independent duplicate with collision-checked injected IDs, shared instance
    create/delete, precomputed multi-instance placement as one transaction, cross-plate move,
    no-op suppression, selection repair, and byte-exact undo/redo without deleting shared assets.
    UI/action wiring, bed-fill placement, topology operations, asset GC, 3MF/oracle, and official
    Orca qualification remain open.

- [~] **P2.3 — Implement per-object, part, and layer-range filament assignment.** The selector includes
  every physical head and enabled virtual/mixed filament with badge, name, recipe, material,
  preset, color/gradient, compatibility warnings, and inherited/effective state.
  - Selecting an object assigns its default. Selecting one or multiple parts or height ranges
    assigns only those scopes. “Default/inherit” removes the local override. Batch actions are
    one undo transaction.
  - Match upstream clearing/remapping behavior when object defaults, tools, recipes, or parts
    change. Never store a transient palette index.
  - Update scene materials, tree badges, legend, paint palette, settings validation, wipe tower,
    3MF, slicer input, and preview from the same assignment event.
  - **Accept:** a multi-part fixture assigns physical tools and each mixed mode to individual
    parts; save/reopen and official Orca preserve it; G-code semantic comparison sees the
    expected tool/mix behavior.
  - **Current:** canonical commands assign or clear stable physical/mixed IDs at object, volume,
    and layer-range scope, validate enabled destinations and ownership, batch heterogeneous
    scopes atomically, and provide byte-reversible undo/redo; the headless Objects tree projects
    inherited/effective badges. Selector UX, compatibility detail, legacy workspace/scene
    propagation, wipe/preview updates, official 3MF round-trip, and G-code behavior oracles remain
    open.

- [ ] **P2.4 — Add semantic volumes.** Support ordinary part, parameter modifier, negative
  volume, support enforcer, support blocker, and other upstream volume roles. Provide “Add
  part/modifier” from file and primitives; expose role conversion only when valid.
  - Resolve volume overlap/order and setting scope like the engine. Indicate non-manifold,
    outside-bed, below-bed, and non-printable states without hiding the row.
  - **Accept:** each role changes slice results as expected and survives 3MF round-trip.

- [ ] **P2.5 — Add per-object/part settings and height ranges.** Rows can attach a curated
  settings subset, remove overrides, compare effective values, copy/paste settings, and add,
  edit, split, merge, or delete non-overlapping layer-height ranges.
  - Use the generated P6 schema and engine dependency rules, not duplicated control metadata.
  - **Accept:** overrides affect only the intended object/part/Z range; conflicts and gaps are
    explained; serialization and undo pass.

- [ ] **P2.6 — Deliver Objects outcomes in responsive and XR UI.** Narrow screens use a
  persistent/dismissible sheet with retained selection. XR uses a scalable world-space tree or
  details panel, ray/direct selection, scrolling, and controller-accessible context actions.
  - **Accept:** the same part assignment, instance management, and override flows complete on
    desktop, 390×844 touch viewport, and the reference Galaxy XR session without returning to
    another device.

P2 exit gate: every object hierarchy fixture can be created and edited from the UI, assigns
filament at object/part scope, and round-trips/slices correctly.

## 9. P3 — FullSpectrum physical and virtual filament workflow

Behavioral authority: [v2.3.3 FullSpectrum notes](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.3.3),
[`MixedFilamentDialog.cpp`][up-mixed-dialog], [`MixedFilament.hpp`][up-mixed-filament],
[`MixedFilament.cpp`][up-mixed-filament-cpp], [`MixedColorMatchPanel.cpp`][up-match-panel],
[`MixedGradientSelector.cpp`][up-gradient], the active color-mixing sidebar in
[`Plater.cpp`][up-plater], configuration in [`PrintConfig.cpp`][up-print-config], and slicer
integration in [`PrintApply.cpp`][up-print-apply], [`PrintObjectSlice.cpp`][up-print-slice],
[`ToolOrdering.cpp`][up-tool-ordering], [`GCode.cpp`][up-gcode], and
[`WipeTower2.cpp`][up-wipe-tower].

Local starting seams: [`MixedFilamentStore.ts`](../web/src/features/MixedFilamentStore.ts),
[`MixedFilamentPreview.ts`](../web/src/features/MixedFilamentPreview.ts),
[`filamentMixerModel.ts`](../web/src/features/filamentMixerModel.ts),
[`FullSpectrumGamut.ts`](../web/src/features/FullSpectrumGamut.ts),
[`GamutMatcher.ts`](../web/src/features/GamutMatcher.ts), and
[`FilamentPalette.ts`](../web/src/workspace/FilamentPalette.ts).

- [~] **P3.1 — Replace palette indexes with a stable filament library.** Physical entries store
  head/tool identity, profile reference/hash, material/type, vendor, display color, nozzle and
  temperature compatibility, loaded/unloaded state, and optional device mapping. Virtual
  entries reference stable physical IDs and cannot recursively reference virtual entries unless
  upstream explicitly supports it.
  - Import profile colors and printer capabilities without overwriting project choices. Reorder,
    replace, disable, and delete operations run the transactional dependency remapper.
  - Persist references by stable identity, then have the slice/3MF adapter build the upstream
    UI-ordered assignment namespace: physical IDs first and each enabled mixed row at
    `physical_count + enabled_ordinal`. Preserve upstream `stable_id`, disabled rows, and
    tombstones so rebuilding that transient numbering never changes project intent.
  - **Accept:** reordering/replacing physical tools does not alter object, part, facet, mixed,
    or G-code intent; invalid recipes become actionable warnings rather than dangling IDs.
  - **Current:** the canonical graph stores stable physical/mixed IDs plus tool, preset/hash,
    material/vendor, color, nozzle, config, and enabled state; validated reversible commands
    cover assignment, remap, referenced-definition tombstoning, and mixed add/edit/duplicate/
    enable lifecycle without palette indexes. Loaded/device mapping, upstream auto-row/tombstone
    parity, reorder/replace dependency UX, the transient engine namespace, persistence migration,
    live surfaces, and G-code/oracle qualification remain open.

- [~] **P3.2 — Implement the “Add Virtual Filament” dialog and complete CRUD lifecycle.** The
  dialog has Ratio, Cycle, Match, and Gradient modes; two/three component choice where allowed;
  component add/remove/swap; live badge/preview; validation; cancel without mutation; add; edit;
  duplicate; merge/apply; and delete with dependency review.
  - Persist all upstream fields: stable ID; component A/B; the three-component Ratio/Match
    representation in `gradient_component_ids` plus slash-separated
    `gradient_component_weights`; ratios/mix percentage; manual cycle/pattern; pointillism/
    distribution mode; local-Z/sub-layer values; gradient enabled,
    start/end/direction; component surface offsets; enabled/deleted/custom/auto-origin flags;
    UI mode; and display color.
  - Match upstream maximum-count and compatible-material rules. Distinguish hard errors (missing
    head, unsupported combination, invalid ratio/code) from warnings (similar colors, recipe
    quality). Do not silently normalize a user's valid recipe.
  - Reproduce the manager's auto-generated physical pairs and lifecycle: an edited pair becomes
    a custom row with stable origin; deleting an auto pair leaves a tombstone so regeneration or
    physical-row reorder cannot resurrect it unexpectedly. Keep enabled/deleted/custom/origin
    state distinct from temporary UI expansion/filtering.
  - **Accept:** all dialog paths, validation boundaries, keyboard/touch interaction, undo, and
    save/reopen pass; serialization is compared field-by-field with official v2.3.4 output.
  - **Current:** canonical commands add, rename/edit, duplicate, enable/disable, and safely
    remove stable-ID recipes with exact undo/redo, defensive input snapshots, deterministic
    dependency paths, no-op suppression, and tombstones for referenced definitions. Ratio,
    Cycle, Match, and Gradient state is validated without silently normalizing user values, and
    authoring is restricted to enabled physical components as required by the pinned engine.
    The dialog, complete upstream field model/wire format, auto-pair origin/regeneration rules,
    merge/apply flow, compatibility warnings, preview, persistence, DOM/touch/XR interaction,
    and official field-by-field qualification remain open.

- [ ] **P3.3 — Implement Ratio mode faithfully.** Offer two- and three-filament selection,
  two-color ratio slider/numeric input, the three-color triangle picker used by the reference,
  ratio normalization, live predicted color, badges, and mix-effect preview.
  - Reuse tested `FilamentMixer`/gamut math where equivalent; version coefficients/calibration
    rather than baking unexplained constants into UI code.
  - **Accept:** boundary ratios, component swap, three-way normalization, predicted color, and
    emitted definition match reference fixtures within documented numeric/color tolerances.

- [ ] **P3.4 — Implement Cycle mode faithfully.** Support reference code/pattern entry,
  component badges, parsing/validation, manual pattern editing, cycle preview, and mix-effect
  preview. Preserve the exact sequence rather than reducing it to an average color.
  - Accept legacy single-digit tokens and the modern slash-separated form for multi-digit
    physical IDs; commas separate per-perimeter groups. Provide quick-filament insertion and
    normalize with the engine's `MixedFilamentManager::normalize_manual_pattern`, while retaining
    a clear validation location for malformed/unknown tokens.
  - **Accept:** valid and invalid code corpus matches upstream acceptance; layer/tool ordering and
    G-code repeat pattern match the reference semantic oracle.

- [ ] **P3.5 — Implement Match mode faithfully.** Provide component selection, target color via
  swatch/hex/color picker, minimum mix ratio and other upstream constraints, ranked recipe
  candidates, out-of-gamut feedback, and explicit selection of the applied match.
  - Show predicted versus target color and a meaningful distance/confidence value. Preserve the
    chosen recipe; do not recompute it unexpectedly on reopen.
  - **Accept:** official sample targets and boundary colors choose equivalent recipes within a
    recorded tolerance; inaccessible color alone is never the only status cue.

- [ ] **P3.6 — Implement Gradient mode faithfully.** Select two physical components, direction
  A→B/B→A, the upstream 80%→20% or 20%→80% component-A endpoints, and the vertical gradient
  preview. Persist exact `gradient_start`/`gradient_end` values and validate the effective
  model/Z domain. User-editable endpoints, if added, are a separately tested enhancement.
  - Assigning the gradient to an object or part must retain its recipe identity through
    transforms, plate moves, reload, 3MF, paint remap, and slicing.
  - **Accept:** start/end and reverse-direction fixtures produce reference-equivalent layer-wise
    mixing/tool behavior; UI preview and G-code preview agree.

- [ ] **P3.7 — Expose FullSpectrum advanced process controls with exact engine semantics.** Cover
  `mixed_color_layer_height_a/b`, gradient mode, mixed-filament lower/upper height bounds,
  advanced dithering, pointillism pixel size/gap, component bias and surface indentation,
  region collapse, definitions, `dithering_z_step_size`, `dithering_local_z_mode` (“Subdivide
  Mix Layer”), `dithering_local_z_whole_objects` (“Full domain”),
  `dithering_local_z_infill` (“Apply subdivision to infill”),
  `dithering_local_z_direct_multicolor`, `dithering_step_painted_zones_only`, and
  `local_z_wipe_tower_purge_lines`.
  - Generate labels, types, units, defaults, bounds, and dependencies from the P6 schema.
  - **Accept:** each control changes only the intended config key; enabled/disabled dependencies
    match upstream; representative values change slice geometry/G-code as the reference does.

- [ ] **P3.8 — Integrate recipes everywhere.** Show compact mixed badges and human-readable
  ratios/pattern/gradient in the filament panel, Objects tree, assignment menus, painting palette,
  legends, warnings, project summary, and preview. Editing/deleting a recipe previews all
  affected entities and remaps atomically.
  - The physical-filament panel and virtual library remain visually distinct. “Add Virtual” may
    never create a plain physical slot.
  - **Accept:** a recipe can be created, assigned to one part, used to paint another region,
    edited, remapped, saved, sliced, previewed, sent, and reopened without identity loss.

- [ ] **P3.9 — Validate engine and hardware behavior.** Extend browser and external slicer
  protocols only as needed to carry canonical project/config data; keep both on the same pinned
  fork. Add preflight for incompatible heads/materials, missing components, gradient bounds,
  wipe-tower feasibility, and unsupported printer capability.
  - Run reference jobs for Ratio/Cycle/Match/Gradient on Snapmaker U1. On Elegoo Centauri Carbon,
    explicitly prove supported outcome or record an adaptation/blocker based on actual hardware
    capability; never imply FullSpectrum hardware support from UI availability.
  - **Accept:** semantic G-code comparison passes, preview matches tool/mix changes, U1 prints the
    qualification specimens, and safety review signs off temperatures/tool mapping/purge.

P3 exit gate: a user can author—not merely view—every FullSpectrum mode, assign it to individual
parts and paint, round-trip it with official Orca, and produce qualified U1 output.

Upstream note: `SameLayerPointillisme` exists in the v2.3.4 data model, but its G-code sequence
implementation is compiled out and returns no sequence. It is therefore **not** a v2.3.4 parity
requirement. If OrcaXR enables it, track it as enhancement `E-FS-01`, with separate safety and
hardware evidence; do not use it to satisfy any P3 item.

## 10. P4 — Facet annotations and painting parity

Upstream anchors: [`GLGizmoMmuSegmentation.cpp`][up-color-paint],
[`GLGizmoMmuSegmentation.hpp`][up-color-paint-h], [`GLGizmoPainterBase.hpp`][up-painter],
[`TriangleSelector.hpp`][up-triangle-selector], [`Model.hpp`][up-model],
[`MultiMaterialSegmentation.cpp`][up-segmentation], [`bbs_3mf.cpp`][up-bbs-3mf], and the
[official color-painting guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_color_painting).
Related tools live in [`GLGizmoFdmSupports.cpp`][up-support-paint],
[`GLGizmoSeam.cpp`][up-seam-paint], [`GLGizmoFuzzySkin.cpp`][up-fuzzy-paint], and
[`GLGizmoBrimEars.cpp`][up-brim].

Local starting seams: [`Paint3mf.ts`](../web/src/features/Paint3mf.ts),
[`PaintedSlice.ts`](../web/src/features/PaintedSlice.ts),
[`PaintHistory.ts`](../web/src/features/PaintHistory.ts),
[`AiPaintEngine.ts`](../web/src/features/AiPaintEngine.ts), and the live paint path in
[`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts).

- [~] **P4.1 — Store semantic, topology-aware facet annotations.** Replace vertex display-color
  mutation as the editing source of truth with separate sparse fields for color/MMU state,
  support state, seam state, fuzzy-skin state, and brim-ear geometry/anchors per model volume.
  - Implement the upstream triangle-selector state model and subdivision encoding needed for
    exact 3MF import/export. Keep render colors as a derived overlay.
  - Associate every field with mesh/topology revision. Mesh operations must provide a face map,
    explicitly invalidate affected annotations after confirmation, or preserve the original
    source until a mapping completes.
  - **Accept:** imported official facet fixtures decode and re-encode to identical semantic
    states; overlapping channels remain independent; no vertex-sharing artifact changes a
    neighboring face.
  - **Current:** canonical volumes own independent sparse color, support, seam, fuzzy-skin, and
    brim channels tied to topology revision. Headless normalization/validation rejects stale
    topology, invalid values, duplicate/out-of-range faces, and deterministically preserves
    overlapping channels. Upstream subdivision encoding, brim geometry/anchors, render-overlay
    adoption, mesh face-map workflows, official fixtures, and Orca round-trip equivalence remain
    open.

- [~] **P4.2 — Build a common paint engine and command model.** Share ray casting, section
  clipping, face visibility, brush sampling, triangle subdivision, edge adjacency, filters,
  preview overlays, stroke transactions, and undo/redo across all paint channels.
  - A stroke starts on pointer/controller down, streams previews, and commits one history command
    on release; cancellation restores the exact prior field. Async fill results use topology and
    command revision checks.
  - Inputs support mouse/stylus pressure where useful, touch with accidental-camera-motion
    suppression, XR ray and direct touch, dominant-hand switching, and haptic/visual feedback.
  - **Accept:** deterministic input traces yield the same facets on every surface; undo/redo and
    cancel are exact; painting a large mesh stays within P10 frame/worker budgets.
  - **Current:** a channel-generic headless stroke operation implements paint/erase/reset and a
    guarded command commits one atomic history entry with exact undo/redo, cancellation/no-op
    behavior, defensive snapshots, and project/topology stale-result rejection. Ray/brush/fill
    geometry, clipping/visibility/adjacency, preview overlays, pointer/touch/XR input, haptics,
    worker routing, deterministic surface traces, and performance qualification remain open.

- [ ] **P4.3 — Implement all six color-paint tools.** Provide Circle, Sphere, Triangle, Height
  Range, Fill, and Gap Fill with the upstream-visible parameters and cursor/overlay feedback.
  - Circle paints screen-facing projected radius; Sphere paints a 3D radius; Triangle can use
    refined triangle subdivision; Height Range uses model/plate Z semantics; Fill respects
    connected/smart-fill bounds; Gap Fill bridges narrow unpainted regions by threshold.
  - Provide pen radius, smart-fill angle, edge detection, gap threshold, vertical/horizontal
    filters, section clipping/reset, wireframe, paint/erase, erase all, and number-key filament
    selection. Explain unavailable options per active tool.
  - **Accept:** a golden mesh and camera/input script checks exact selected facets for each tool,
    filter, clipping plane, threshold boundary, erase, and refined-triangle case against official
    reference output.

- [ ] **P4.4 — Use the full physical-plus-virtual paint palette.** Palette entries show stable
  assignment ID, keyboard number, physical color or virtual recipe/gradient badge, name, and
  unavailable/compatibility state. The default/unpainted state inherits object/part assignment.
  - Painting with a mixed filament writes the virtual assignment state understood by the pinned
    engine; never flatten it to a predicted RGB or physical palette index.
  - **Accept:** physical and each FullSpectrum mode can be painted on separate facets, survives
    save/open, and produces expected segmentation/tool behavior.

- [~] **P4.5 — Implement explicit filament remapping.** Present every currently referenced
  source filament and a destination selector supporting identity and many-to-one mappings.
  Preview affected objects/parts/facets and warnings before applying one undoable transaction.
  - Remap state `0`/default using upstream semantics; update object/part assignments, triangle
    states, mixed components, legends, and configs consistently. Preserve tombstones while undo
    or saved projects still reference them.
  - Trigger the same resolver when tools or recipes are deleted/reordered. Never silently map to
    the first color.
  - **Accept:** remap fixtures cover sparse IDs, virtual IDs, many-to-one, default state, deleted
    recipes, cancellation, undo/redo, save/reopen, and G-code comparison.
  - **Current:** one canonical command performs validated many-to-one stable-ID remaps across
    object/part/layer assignments, color facets, wipe-tower assignment, and physical recipe
    components, coalesces collided facet/component data, preserves source definitions, rejects
    self/disabled destinations and virtual destinations for physical-only recipe components, and
    round-trips through history. Reference discovery/preview UX,
    default-state and deletion/reorder hooks, cancellation flow, tombstone retention policy,
    live legends/surfaces, save/reopen, and G-code comparison remain open.

- [ ] **P4.6 — Implement support painting.** Support enforcer, blocker, and reset/erase states;
  brush/smart-fill behavior; clipping and visibility; clear all; rendering; 3MF annotation; and
  generated-support results must match upstream intent.
  - **Accept:** [support-paint guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_support_painting)
    scenarios show support only where expected, round-trip through official Orca, and undo.

- [ ] **P4.7 — Implement seam painting.** Enforce, block, and reset states; shared brush/fill
  controls; clear all; visualization; 3MF persistence; and seam placement integration.
  - **Accept:** [seam-paint guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_seam_painting)
    fixtures compare seam positions in parsed G-code and preserve annotations in 3MF.

- [ ] **P4.8 — Implement fuzzy-skin painting and brim ears.** Fuzzy painting includes the pinned
  v2.3.4 fixes and independently marks surface regions. Brim ears support placement, diameter,
  deletion, and slice integration as the upstream gizmo does.
  - **Accept:** reference models compare affected perimeters/brim geometry, 3MF state, and
    undo/redo. Dome-shaped fuzzy fixtures specifically guard the v2.3.4 regression.

- [ ] **P4.9 — Integrate AI/semantic painting as an enhancement over the same state.** Repair
  current typing and placeholder color-distance logic; require a preview mask, chosen channel
  and destination, confidence/coverage, explicit apply, cancellation, and local undo command.
  - Do not send geometry or keys without informed consent. Keep manual tools fully functional
    offline; AI failure cannot change or degrade slice output.
  - Projection must end in canonical facet states, not vertex colors, so remap/3MF/slicing are
    identical to manual painting.
  - **Accept:** deterministic mocked-service tests, privacy/error tests, and manual correction of
    the generated mask all pass. AI remains outside core parity completion.

- [~] **P4.10 — Remove unsafe paint fallback.** If painted project generation or engine slicing
  fails, show a blocking, actionable error and retain the last valid result. Never report success
  after silently slicing monochrome.
  - **Accept:** injected encoder/worker/engine failures cannot yield a downloadable/sendable
    mislabeled monochrome job.
  - **Current:** painted engine failure, a disabled painted engine, and the geometry-only external
    route now fail closed and retain the prior valid result. As-authored FullSpectrum bytes require
    an exact semantic snapshot match across project bytes, paint buffers, profiles, overrides,
    palette, heads, virtual definitions, and tower controls; edits and non-exclusive imports fail
    closed rather than using stale or flattened input. Fault-injected end-to-end download/send UI
    coverage and canonical edited-project routing remain open.

P4 exit gate: every official painting channel and color tool is authorable on DOM, touch, and
XR; color remapping includes mixed filaments; facet state round-trips and drives verified G-code.

## 11. P5 — Prepare tools, geometry, plates, and file interchange

Upstream anchors: the active manager in [`GLGizmosManager.cpp`][up-gizmos-manager], object and
plate menus in [`GUI_Factories.cpp`][up-factories], [`PartPlate.hpp`][up-plates],
[`PartPlate.cpp`][up-plates-cpp], [`PlateSettingsDialog.cpp`][up-plate-settings], and file
lifecycle in [`MainFrame.cpp`][up-main-frame], [`Plater.hpp`][up-plater-h], and
[`Model.hpp`][up-model].

Local starting seams: [`MeshCut.ts`](../web/src/features/MeshCut.ts),
[`MeshSplit.ts`](../web/src/features/MeshSplit.ts),
[`EmbossOp.ts`](../web/src/features/EmbossOp.ts),
[`SimplifyModel.ts`](../web/src/features/SimplifyModel.ts),
[`AdaptiveLayer.ts`](../web/src/features/AdaptiveLayer.ts),
[`BedCollision.ts`](../web/src/features/BedCollision.ts), and
[`WipeTowerPlacement.ts`](../web/src/features/WipeTowerPlacement.ts).

- [ ] **P5.1 — Complete selection and transform behavior.** Multi-select, box select, select all,
  move, rotate, scale, mirror, reset, world/local coordinates, numeric entry, uniform scaling,
  drop to bed, center, lay on face, auto-orient, and camera framing must operate at selected
  object/part/instance scope.
  - Add snapping, keyboard nudging, unit handling, pivot/origin visibility, outside-bed and
    collision feedback, precise cancel, and one history transaction per drag.
  - Fix selection code that falls back to the first model. Derive Three manipulators from stable
    entity selection rather than render-array position.
  - **Accept:** transform matrices and bounds match reference fixtures after UI operations,
    undo/redo, 3MF round-trip, and slice; multi-selection never moves an unselected first model.

- [ ] **P5.2 — Complete mesh operations.** Deliver cut (plane, keep upper/lower, connectors where
  upstream exposes them), split to objects, split to parts, mesh Boolean union/difference/
  intersection, repair, simplify, and reload/replace with progress/cancel and topology impact.
  - Prefer pinned libslic3r/WASM algorithms or documented equivalent robust libraries; record
    exact tolerances and failure modes. Preserve transforms, configs, and annotations via maps
    where mathematically possible.
  - **Accept:** manifold/non-manifold, coplanar, disconnected, high-poly, and annotated corpus
    cases pass structural and geometry comparisons; no operation returns false success.

- [ ] **P5.3 — Implement the remaining official gizmos.** Measure distances/angles/radii;
  assembly/explosion/alignment; emboss text; SVG emboss/part; simplify UI; and brim ears from P4.
  Hollowing is required only if exposed by the pinned Snapmaker FFF workflow manifest; otherwise
  classify the current placeholder accurately.
  - Persist editable parameters where upstream does. Provide precise handles, numeric fields,
    previews, apply/cancel, error messages, keyboard/touch/XR interactions, and undo.
  - **Accept:** golden geometry and parameter state compare within tolerances and reopen editable
    where the official project does.

- [ ] **P5.4 — Complete plate management.** Support up to the upstream limit (36): create,
  select, rename, duplicate, delete, reorder, lock, printable/excluded state, move/copy selected
  instances between plates, select/delete all, arrange, auto-orient, reload, and per-plate slice
  progress/result.
  - Plate settings cover bed type, print sequence, spiral-vase override, custom first-layer
    filament order, custom layer-range filament order, arrangement exclusions, and wipe-tower
    placement/state.
  - Respect locked plates/objects, per-plate safe zones, toolhead clearance, sequential printing,
    and printer bed geometry. Never lose settings when changing active plate.
  - **Accept:** multi-plate corpus and operations round-trip through official Orca; slice current
    and slice all produce correctly named, isolated results and statistics.

- [ ] **P5.5 — Match arrangement and placement outcomes.** Arrange all/current plate, automatic
  orientation, bed collision, top-cover/clearance constraints, sequential-print clearance, and
  wipe-tower placement use printer/profile constraints and deterministic seeds where possible.
  - **Accept:** fixture bounds never intersect forbidden zones; locked entities do not move;
    comparison screenshots and numeric placements meet recorded tolerances.

- [ ] **P5.6 — Implement authoritative import filters and behavior.** From the generated P0
  manifest support project/model 3MF, STL, STEP/STP, SVG, OBJ, AMF, and ZIP/archive paths exposed
  by v2.3.4; support drag/drop, picker, URL/handy-model import where applicable, and “whole
  project versus geometry only” conflict handling.
  - Dispatch by validated content/signature plus extension. Do not parse every non-3MF file as
    STL. Preserve object names, parts, units, materials/colors, and transforms when the format
    carries them. Report substitutions and unsupported metadata.
  - Route formats whose native dependencies are impractical in browser WASM (notably STEP if the
    pinned OpenCASCADE path is not built) through the authenticated external engine with explicit
    consent/progress/cancel, or ship a verified browser decoder. Offline UI must say why that
    format is unavailable; it may not reinterpret the bytes as another mesh format.
  - **Accept:** format corpus imports with reference-equivalent object/part counts, bounds, units,
    names, and warnings; malformed and hostile files are rejected safely.

- [ ] **P5.7 — Complete export and G-code import/viewing.** Cover project 3MF, generic/core 3MF,
  current/all sliced 3MF, combined/separate or selected STL, current/all plate G-code, toolpath
  OBJ, preset/config bundles, logs/diagnostics, and standalone G-code open as inventoried.
  - Use File System Access API opportunistically and standards-based downloads elsewhere;
    preserve filenames, extensions, overwrite intent, progress, cancellation, and errors.
  - **Accept:** every visible format produces a non-empty valid artifact accepted by its oracle;
    unavailable browser-specific destinations use a documented equivalent flow.

- [ ] **P5.8 — Add primitives and model sources coherently.** Match official primitive types,
  parameter editing, add-as-object/part/modifier behavior, handy-model catalog, and SVG/text
  entry. Cache remote catalogs safely and provide offline/permission/error states.
  - **Accept:** each source creates the intended semantic node and remains editable/persisted
    where promised; network failure never blocks local import.

- [ ] **P5.9 — Implement variable/adaptive layer-height editing.** For an eligible selected
  object, render the Z profile and height/quality legend; support manual add-detail/remove-detail,
  reset-to-base, local smoothing, wheel/controller edit-radius adjustment, Adaptive with
  Quality/Speed factor, Smooth with radius and Keep min, and full Reset. Use the pinned
  [`GLCanvas3D` editor][up-canvas] and [`SlicingAdaptive`][up-adaptive-slicing] algorithms or a
  proven engine-equivalent worker API.
  - Store the canonical object layer-height profile, include it in history and BBS 3MF, and
    invalidate/recompute slices precisely. Enforce nozzle/min/max layer limits and upstream
    conflicts such as incompatible organic support or unequal prime-tower profiles.
  - Touch/XR controls need explicit add/remove/reset modes rather than depending on mouse-button
    chords; show the resulting height at the cursor accessibly.
  - **Accept:** manual/adaptive/smooth/reset profiles compare numerically with reference fixtures,
    round-trip through official Orca, alter layer Z/heights as previewed, and undo exactly.

P5 exit gate: the generated prepare/file manifest has no unmapped behavior; all enabled tools
operate on canonical entities, survive history/3MF, and meet geometry/plate acceptance tests.

## 12. P6 — Engine-derived settings, profiles, and preferences

Upstream anchors: [`PrintConfig.cpp`][up-print-config], [`Preset.hpp`][up-preset],
[`PresetBundle.hpp`][up-preset-bundle], print/filament/printer tab construction in
[`Tab.cpp`][up-tab], [`Search.cpp`][up-search], and upstream guides for
[profile creation][up-profile-guide] and [preset bundles][up-preset-guide]. At this baseline,
the source contains roughly 783 `PrintConfigDef` entries; a static hand-maintained list cannot
be the parity oracle.

Local starting seams: [`SettingsConfig.ts`](../web/src/actions/SettingsConfig.ts),
[`SettingsInspector.ts`](../web/src/ui/dom/SettingsInspector.ts),
[`ProfileLoader.ts`](../web/src/slicer/ProfileLoader.ts),
[`profileKeys.ts`](../web/src/slicer/profileKeys.ts),
[`ConfigIO.ts`](../web/src/features/ConfigIO.ts), and
[`SettingsBackup.ts`](../web/src/features/SettingsBackup.ts).

- [~] **P6.1 — Generate a complete typed option schema from the pinned engine.** Extract key,
  storage type, scalar/vector shape, enum domain/labels, nullable/percent semantics, units,
  default, min/max, mode, category, tooltip, CLI name, technology/printer applicability,
  aliases/deprecations, and serialization delimiter.
  - Separately extract tab/page/group/order, visibility/enabling dependencies, special widgets,
    reset rules, and allowed object/part/layer scope from `Tab.cpp` and related builders.
  - Prefer a small commit-pinned C++ schema dumper linked to libslic3r's runtime
    `PrintConfigDef` over regex for option semantics. Use source extraction plus a reviewed
    overlay for GUI layout/dependencies that exist only in wxWidgets code. Emit versioned JSON
    consumed identically by browser, workers, and server.
  - Handwritten overlays require source link, rationale, owner, and test. Detect bogus keys such
    as display values currently present in `profileKeys.ts`.
  - **Accept:** every upstream config entry and explicitly placed tab option is represented or in
    an approved internal-only exclusion; schema generation is deterministic and drift-tested.
  - **Current:** the exact-blob generator emits 816 definitions/809 unique runtime keys with
    types, defaults, bounds, enum maps, presentation metadata, applicability, provenance, and
    serialization rules; a strict runtime loader and eight mutation guards pass. Tab/page/group
    layout, predicates, widget/reset/scope semantics, runtime C++ dump comparison, and locale
    catalogs remain open, so the generated schema labels itself `foundation-partial`.

- [~] **P6.2 — Implement the complete settings editor.** Cover Process pages Quality, Strength,
  Speed, Support, Multimaterial, and Others; Filament pages Filament, Cooling, Advanced,
  Multimaterial, Dependencies, and Notes; Printer basics, machine G-code, motion limits,
  multimaterial, and per-extruder pages.
  - Render correct number, percent, enum, bool, string, multiline/G-code, color, curve/table,
    scalar/vector, point, and nullable controls. Use exact units/ranges and locale-safe parsing.
  - Give multimaterial regression fixtures explicit coverage for filament-for-features (walls,
    infill, support and other exposed roles), prime/wipe tower, purge/flush volumes and options,
    ooze/tool-change behavior, and every FullSpectrum option. The v2.3.4 restoration of the
    feature-specific infill filament is a required oracle case.
  - Implement simple/advanced/expert modes, search, highlighted matches, dependency visibility,
    validation, warning/error links, default/inherited/changed indicators, reset, and compare.
  - Remove the policy of displaying controls without backend behavior. Such controls are
    `unavailable` until their value can round-trip to the engine and affect output where expected.
  - **Accept:** every applicable upstream option is reachable at its valid scope and has an
    exact UI → typed config → serialization → reopen contract test; schema-driven component tests
    cover every widget/type. Differential family fixtures and targeted critical-option cases
    prove engine effect. An option cannot be classified implemented solely because its key is
    present or passed to the worker.
  - **Current:** a headless editor derives fields only from the generated catalog, projects
    deterministic mode/technology/search state, classifies ambiguous/read-only/unknown/special
    definitions unavailable, parses and validates supported scalar/vector families, exposes
    inherited/default/changed/compare/reset state, and commits drafts atomically. Generated GUI
    layout/dependencies/scope, special widgets, persistence, engine-effect proofs, DOM/XR, locale,
    and cross-surface qualification remain open.

- [ ] **P6.3 — Implement preset semantics.** Support system, user, and project presets for
  printer/process/filament; inheritance; compatibility expressions; multiple filament slots;
  project overrides; save/save-as/rename/delete; unsaved-change resolution; compare; import;
  export; and restore defaults.
  - Replace Cartesian-product selection with upstream-compatible filtering by printer, nozzle,
    process, material, vendor, and dependencies. Preserve selected compatible presets when other
    choices change; explain substitutions.
  - **Accept:** the profile corpus resolves the same compatible choices/effective config as the
    reference for U1 and Elegoo CC; conflict and unsaved-change flows are fully tested.

- [ ] **P6.4 — Add printer/filament creation and setup.** Provide setup wizard or equivalent for
  supported printer/nozzle/profile installation, custom printer creation, custom filament from
  a compatible base, profile updates, and explicit source/license/version metadata.
  - **Accept:** clean browser storage can be configured without developer tools; exported bundle
    reimports with inheritance and compatibility intact.

- [ ] **P6.5 — Reuse the same schema at every scope and surface.** Project, plate, object, part,
  and height-range overrides share validation and effective-value resolution. Desktop, narrow
  touch, and XR render surface-specific controls over identical draft/commit state.
  - XR may group or search settings differently, but every applicable setting remains reachable,
    legible, and editable with controller/hand input.
  - **Accept:** a cross-surface test edits the same sampled settings and compares canonical state
    and generated config byte-for-byte.

- [ ] **P6.6 — Implement application preferences separately from slice settings.** Cover language,
  units, theme/system/high contrast, zoom-to-pointer, pan/rotate mapping, wheel direction,
  configurable shortcuts, autosave/recovery, privacy/network, external slicer endpoint, printer
  connections, AI provider/key handling, update behavior, and accessibility/XR comfort options.
  - Version and migrate storage; validate imports; allow reset/export; never persist secrets in
    plaintext `localStorage` by default.
  - **Accept:** preferences survive reload and migration, respect OS signals, do not leak into
    project config, and can be restored without clearing projects/presets.

- [~] **P6.7 — Correct config serialization at every boundary.** String vectors use semicolons;
  numeric vectors use commas as required by this port. Preserve escaping, percent/absolute
  distinction, nullable values, enum tokens, and G-code text.
  - **Accept:** generated round-trip tests cover every schema type through browser worker,
    project 3MF, config import/export, and external server; delimiter mutation tests fail.
  - **Current:** the schema-driven codec fail-closes delimiter drift and round-trips bool, integer,
    float, percent/absolute, string, enum, point, nullable, and supported vector values using the
    generated separator contract. Escaping/special shapes and browser-worker/3MF/server boundary
    matrices remain open.

P6 exit gate: the generated schema has complete disposition, all supported settings reach the
engine at each valid scope, and profiles/preferences have tested lifecycle behavior.

## 13. P7 — Slicing, validation, preview, and output inspection

Upstream anchors: [slicing call hierarchy][up-slicing-guide], [`GCodeProcessor.hpp`][up-processor],
[`GUI_Preview.hpp`][up-preview], [`GCodeViewer.hpp`][up-viewer],
[`GCodeViewer.cpp`][up-viewer-cpp], and [`IMSlider.cpp`][up-slider].

Local starting seams: [`SlicerClient.ts`](../web/src/slicer/SlicerClient.ts),
[`sliceWorker.ts`](../web/src/slicer/sliceWorker.ts),
[`GcodeToolpath.ts`](../web/src/slicer/GcodeToolpath.ts),
[`slic3r_wasm.cpp`](../wasm/slic3r_wasm.cpp), [`server.js`](../server/server.js), and
[`slice_worker.mjs`](../server/slice_worker.mjs).

- [~] **P7.1 — Make slicing a cancellable, revisioned job pipeline.** Support current/all plates,
  browser WASM and external engine routing, explicit queue state, progress phases, cancellation,
  retry, timeouts, worker recovery, and stale-result rejection.
  - Snapshot canonical project and effective profiles. Record engine commit/artifact hash, input
    revision/hash, output hash, warnings, estimates, and route. The same project/config must reach
    WASM and CLI; route choice cannot change semantics silently.
  - Fix the server WASM path so project 3MF uses the project entry point rather than writing it as
    `/tmp/in.stl` and invoking mono slicing.
  - **Accept:** cancellation terminates work and child processes promptly; current/all-plate jobs
    stay isolated; identical supported inputs meet the semantic oracle across WASM/CLI.
  - **Current:** a headless coordinator snapshots canonical state/assets once, serializes only a
    compatible project 3MF, isolates current/all printable plates, exposes queued/serializing/
    submit/retry terminal state, and supports cancellation, per-attempt timeouts, retry/recovery,
    revision and overlapping-job supersession guards. Its versioned route contract records
    engine commit/artifact, profile identities, input revision/hash, SHA-256 project/output
    hashes, warnings, statistics, and route. Live WASM/server adapters and progress projection,
    legacy workspace adoption, prompt worker/process termination, the server project-entry fix,
    WASM/CLI semantic-oracle equivalence, and device qualification remain open.

- [ ] **P7.2 — Implement complete preflight and actionable errors.** Validate printable objects,
  plate bounds/collisions, manifold/repair status, profile/nozzle/printer compatibility, settings,
  sequential clearance, assigned tools/materials/mixed components, temperature limits, wipe
  tower/purge, custom G-code, and device constraints before slice/send.
  - Distinguish warning from blocking error, link to the offending entity/setting, support
    “fix/reveal,” and never suppress engine diagnostics without an equivalent message.
  - **Accept:** fault-injection corpus maps each failure to stable code, affected entity, help,
    and allowed next actions; unsafe output cannot be sent.

- [ ] **P7.3 — Parse rich G-code move metadata.** Retain layer/Z, sequence index, role/line type,
  width, height, speed, fan, temperature, volumetric flow, tool/filament, filament ID, color-print
  ID, extrusion/travel/retract/unretract/wipe/seam/tool-change/pause/custom markers, and time.
  - Stream/partition data into GPU-friendly buffers; do not build one unfilterable line object.
  Preserve source offsets/line numbers for inspection without holding avoidable duplicate text.
  - **Accept:** parser fixtures and reference G-code compare segment counts/properties, bounds,
    layer/tool changes, and estimates; malformed commands degrade with explicit warnings.

- [ ] **P7.4 — Implement official preview view types and filters.** Color by line/feature type,
  layer height, line width, speed, fan, temperature, volumetric flow, tool/filament, filament ID,
  and layer time linear/log. Provide accessible legends, ranges, units, clipping, role/tool
  visibility, and color-vision-safe alternatives.
  - Toggles cover travel, wipe, retract/unretract, seams, tool changes, color changes, pauses,
    custom G-code, shells, tool marker, and legend.
  - **Accept:** screenshot plus numeric-state tests compare every mode/filter at representative
    layers; no state is conveyed only by hue.

- [ ] **P7.5 — Add layer and sequential-move inspection.** Dual-handle layer/Z range, single-layer
  mode, sequential move range/playback, keyboard/controller shortcuts, custom G-code ticks,
  visible tool marker, camera focus, and optional synchronized G-code line window.
  - **Accept:** slider endpoints and playback select exact reference segments, remain usable by
    keyboard/touch/XR, and announce values accessibly.

- [ ] **P7.6 — Show complete statistics and conflicts.** Normal/silent estimates where available;
  prepare/model/total time; per-role/tool and model/total filament length/volume/weight/cost;
  layer/tool-change counts; plate/all-plate overview; purge/wipe amounts; warnings and conflicts.
  - Trace each number to parser/engine metadata and display assumptions such as density/cost.
  - **Accept:** statistics compare to official outputs within documented tolerance for golden
    fixtures and never reuse stale plate/profile results.

- [ ] **P7.7 — Complete output lifecycle.** View imported G-code, reslice after changes, retain
  per-plate results, download/export named artifacts, upload-only, send-and-print, and invalidate
  results precisely when project/profile changes affect them.
  - A result badge shows sliced revision and target printer/profile. Prevent sending stale or
    incompatible G-code unless the user explicitly revalidates it.
  - **Accept:** dirty-state matrix proves which edits invalidate which result; standalone G-code
    works without a model project; outputs from every route pass bounds/tool/temperature checks.

- [ ] **P7.8 — Author layer custom-G-code events and filament sequences.** On the layer slider,
  add/edit/delete pause, custom G-code, color/filament change, template, and other event types
  exposed by the pinned `IMSlider`; edit first-layer and per-layer tool/filament sequences where
  upstream permits them.
  - Resolve physical and virtual filament IDs through the canonical library and preflight. Show
    event badges/ticks, exact Z/layer, command preview, conflict warnings, and one undo transaction.
    Persist events and plate sequences in BBS 3MF and feed the engine rather than patching an
    already generated file invisibly.
  - **Accept:** each event survives save/open and appears at the expected parsed G-code location;
    delete/undo/cancel are exact; incompatible FullSpectrum/tool events block with a useful fix.

P7 exit gate: every preview mode/filter/statistic in the generated manifest is covered; edited
canonical projects slice without metadata loss, and failures never masquerade as safe output.

## 14. P8 — Calibration workflows

Upstream anchors: [`calib.hpp`][up-calib], [`calib_dlg.hpp`][up-calib-dialogs],
[`CalibrationPanel.hpp`][up-calib-panel], [`CalibrationWizard.hpp`][up-calib-wizard], the
[pinned calibration documentation][up-calib-docs], and the official wiki's
[calibration index](https://www.orcaslicer.com/wiki/#calibrations).

Local starting seams: [`CalibrationRampGenerator.ts`](../web/src/features/CalibrationRampGenerator.ts),
[`Primitives.ts`](../web/src/features/Primitives.ts), calibration actions in
[`calibration.ts`](../web/src/actions/groups/calibration.ts), and project-scoped settings from P6.

- [ ] **P8.1 — Generate and map the calibration inventory.** Extract the `CalibMode` enum, menu
  exposure, dialog parameters, generated resource models, required per-height/per-object config,
  device-only steps, and result fields. At minimum cover pressure advance tower/line/pattern;
  flow-rate Pass 1/Pass 2 and YOLO variants exposed by the baseline; temperature tower; maximum
  volumetric speed; VFA; retraction; input-shaping frequency; damping/zeta; junction deviation;
  and documented tolerance tests.
  - **Accept:** every generated and wizard calibration in the pinned menus has a P8 disposition,
    with unsupported printer firmware features identified before UI exposure.

- [ ] **P8.2 — Build a shared calibration job model.** A calibration definition specifies
  printer/nozzle/filament/process prerequisites, parameter names/units/ranges/steps, generated
  geometry, per-band overrides/custom G-code, expected labels, slice validation, result schema,
  and how a chosen result updates a preset.
  - Keep values editable until generation; validate count, range, bed fit, temperatures, motion,
    and firmware commands. Generated bands must carry real engine overrides rather than visual
    labels alone.
  - **Accept:** unit tests inspect project graph and parsed G-code for every step value at the
    intended Z/object/line; invalid ranges cannot produce a job.

- [ ] **P8.3 — Implement all generic calibration generators and instructions.** Provide parameter
  dialogs, preview, regenerate, slice, inspect, export/send, measurement instructions, result
  entry, and “save to filament/printer/process preset” for every P8.1 generic mode.
  - Link contextually to the pinned docs. Preserve the user's original project in a separate
    tab/session or recoverable snapshot; cancellation must not overwrite it.
  - **Accept:** geometry and semantic G-code match official examples within documented tolerance;
    saved results modify the correct canonical option and create an undoable/versioned preset.

- [ ] **P8.4 — Implement the connected-printer calibration wizard where Moonraker exposes the
  outcome.** Cover printer/preset/filament selection, compatibility checks, start/progress,
  coarse/fine stages, live result collection or manual entry, save, cancellation, recovery, and
  history.
  - Vendor-proprietary automatic measurement without a Moonraker equivalent must remain an
    explicit adaptation/blocker; provide the generic printed-test path for the same tunable
    parameter, not a fake automatic result.
  - **Accept:** supported U1/Elegoo workflows survive disconnect/reconnect and save traceable
    results; unavailable automation is clearly distinguished from manual calibration.

- [ ] **P8.5 — Add calibration history and comparison.** Record printer/firmware/nozzle,
  filament/preset hashes, method, parameters, G-code/project hash, measurement, chosen result,
  operator, date, and linked preset version. Support inspect, compare, re-run, export, and delete.
  - **Accept:** results never auto-apply to a mismatched printer/nozzle/material; migrations and
    deletion are tested; secrets/device tokens are excluded from exports.

- [ ] **P8.6 — Qualify calibration on both target printers.** Use safe material/temperature
  ranges and supervised small jobs; compare dimensions/surface/tool behavior and saved config.
  - **Accept:** the hardware ledger contains at least one successful applicable run for every
    mode, or an approved adaptation row with protocol/capability evidence and manual outcome.

P8 exit gate: calibration inventory is complete, generators alter real G-code correctly, results
can be applied safely, and target-printer evidence exists.

## 15. P9 — Moonraker, printers, and print operations

Upstream outcome references: [`DeviceManager.hpp`][up-device-manager],
[`SelectMachine.hpp`][up-select-machine], [`SendToPrinter.hpp`][up-send-printer],
[`StatusPanel.hpp`][up-status-panel], [`Monitor.cpp`][up-monitor], [`SendJob.hpp`][up-send-job],
and [`PrintJob.hpp`][up-print-job]. Implement equivalent outcomes through the
[Moonraker API](https://moonraker.readthedocs.io/en/latest/external_api/introduction/), not
Snapmaker/Bambu private cloud protocols.

Local starting seams: [`MoonrakerClient.ts`](../web/src/features/MoonrakerClient.ts),
[`PrinterClient.ts`](../web/src/net/PrinterClient.ts),
[`PrintSendFlow.ts`](../web/src/features/PrintSendFlow.ts),
[`WebcamSession.ts`](../web/src/features/WebcamSession.ts), and
[`SubnetScanner.ts`](../web/src/features/SubnetScanner.ts).

- [ ] **P9.1 — Implement a secure, typed Moonraker connection service.** Manual URL, optional
  same-origin proxy, API key/auth flow, TLS validation guidance, capability discovery, version
  negotiation, WebSocket subscriptions, reconnect/backoff, heartbeat, cancellation, and
  structured errors feed one connection state machine.
  - Printer credentials use browser credential protection or session-only memory by default;
    never plaintext `localStorage`. Redact them from logs, diagnostics, URLs, and analytics.
  - **Accept:** mocked protocol tests cover auth, forbidden, version skew, disconnect during every
    mutation, stale event ordering, reconnect, cancellation, and redaction.

- [ ] **P9.2 — Add printer setup, discovery, and multi-printer management.** Support named manual
  endpoints, local-network discovery only with explicit permission and viable browser/proxy
  support, capability/profile association, default printer, online/offline state, edit/remove,
  and fast switching without state leakage.
  - Avoid misleading browser subnet scans where platform restrictions prevent reliable results.
    Explain the proxy/manual alternative.
  - **Accept:** U1 and Elegoo CC can be added from a clean profile, reconnect after reload, switch
    safely, and retain independent queues/cameras/tool maps.

- [ ] **P9.3 — Build pre-print selection and tool mapping.** Select printer/storage destination;
  refresh state; map every physical/mixed dependency to available head/tool/spool; validate
  printer model, bed/nozzle, material, firmware, storage, temperatures, and profile; choose
  upload-only or print; show progress and cancellation.
  - Present applicable options such as leveling, timelapse, and firmware macros only when the
    Moonraker capability manifest proves them. Do not imitate unsupported AMS/cloud toggles.
  - **Accept:** mapping is required for ambiguous/mismatched jobs; unsafe or out-of-bounds G-code
    blocks; upload cancel/retry does not start a partial file; virtual dependencies resolve to
    the intended U1 heads.

- [ ] **P9.4 — Complete upload, queue, and print lifecycle.** Upload with atomic/unique naming,
  overwrite confirmation, progress, checksum/size verification, start, queue/reorder/remove,
  pause, resume, cancel, emergency-stop boundary, and completion/failure notification.
  - Use the Moonraker [file](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/)
    and [queue](https://moonraker.readthedocs.io/en/latest/external_api/job_queue/) APIs; make
    mutating confirmations and idempotency explicit.
  - **Accept:** integration tests use a Moonraker simulator; supervised hardware tests cover
    upload-only, print, pause/resume, cancel, reconnect, filename collision, and printer rejection.

- [ ] **P9.5 — Implement live Status and Monitor outcomes.** Show state, file/thumbnail, overall
  and layer progress, elapsed/remaining/finish time, temperatures/targets, fans, speed/flow,
  axes/homing, load/unload when supported, lights, errors, and recovery actions. Controls declare
  capability and safe ranges before enabling.
  - Provide Storage (browse, upload, download, print, rename/move/delete with confirmation,
    metadata/thumbnails) and Moonraker update-manager status/check/update actions where the
    printer exposes them. Updates require explicit compatibility, power/state, progress, failure,
    reconnect, and recovery UX; otherwise offer information and the supported admin destination.
  - **Accept:** event-driven UI agrees with queried state, survives reconnect and background tab,
    announces critical changes accessibly, and never offers an unsupported command.

- [ ] **P9.6 — Add camera, console, macros, and history.** Discover webcam endpoints; render
  snapshot/MJPEG/WebRTC as supported with visibility-aware polling; provide G-code console with
  history and explicit dangerous-command confirmation; list/run macros with schema/parameters;
  show print history and statistics.
  - Treat printer-host content as untrusted; enforce CSP and safe media/URL handling.
  - **Accept:** simulator and hardware cover camera unavailable/recovery, macro errors, command
    redaction, history pagination, and narrow/XR layouts.

- [ ] **P9.7 — Make printer workflows first-class on mobile and XR.** A compact status surface
  stays glanceable without obscuring preparation; critical cancel/stop actions are reachable but
  resistant to accidental activation; session loss has clear recovery.
  - **Accept:** send, monitor, pause/resume, and cancel complete with touch and XR controllers on
    reference devices, with the same safety confirmations and state as desktop.

P9 exit gate: both target printers pass the connection/send/monitor qualification matrix, and
every vendor-specific upstream outcome is mapped to a real Moonraker equivalent or approved
adaptation—not a placeholder.

## 16. P10 — UX, accessibility, spatial design, localization, performance, and security

P10 is continuous: every P1–P9 change must include its applicable work here rather than defer
quality until the end.

Local starting seams: [`DomShell.ts`](../web/src/ui/dom/DomShell.ts),
[`XrShell.ts`](../web/src/ui/xr/XrShell.ts), [`tokens.ts`](../web/src/ui/tokens.ts),
[`main.ts`](../web/src/main.ts), [`OrcaWorkspace.ts`](../web/src/workspace/OrcaWorkspace.ts),
[`package.json`](../web/package.json),
[`vite.config.ts`](../web/vite.config.ts), [`coi-serviceworker.js`](../web/public/coi-serviceworker.js),
and the external [`server`](../server/).

### XRBlocks spatial-UI implementation contract

This contract is part of every XR acceptance gate, not optional styling guidance.

- **Version and authority:** `package.json` and the lockfile exact-pin `xrblocks@0.17.0` and
  `@pmndrs/uikit@1.0.74`. For any implementation, use this precedence: installed
  version's types/source and `src/addons/uiblocks/SKILL.md`; version-matched source/samples;
  official XRBlocks manual; generic UIKit knowledge. Prose examples conflict with 0.17.0 on
  constructors, card defaults, colors, callback propagation, and behavior properties. Never
  guess or silence a mismatch with `any`/`@ts-ignore`; review this contract on every upgrade.
- **System boundary:** use core `View`/`Panel`/`SpatialPanel` and its grid, pager, scrolling-text,
  or virtual-keyboard views only for lightweight standalone panels. Use UIBlocks for OrcaXR's
  rich production surfaces. Never mix core and UIBlocks children in one physical panel. Make
  one `UICard` per independently posed pivot and compose its header/body/footer/overlay from
  nested `UIPanel`s; a section is not a reason for another card. `AdditiveUICard` remains
  experimental until an explicit passthrough/performance qualification approves it.
- **Bootstrap and ownership:** before `xb.init`, call `options.enableUI()` and
  `options.uikit.enable(uikit)`; during script initialization install
  `xb.core.input.raycaster.sortFunction = raycastSortFunction`. Construct one `UICore` per
  owning script. `createCard()` registers and attaches a card automatically; never add it again.
  `unregister()`, `clear()`, and `dispose()` are destructive and must release descendants,
  signals, textures, materials, listeners, and store subscriptions through a tested owner.
- **Units and layout:** core views use parent-relative `x`/`y` and fractional width/height;
  rerun their layout traversal after hierarchy/property changes. UIBlocks card pose and
  `sizeX`/`sizeY` are metres; `pixelSize` is metres per Yoga layout pixel; numeric child sizes,
  spacing, type, radius, and manipulation margins are layout pixels. Always set physical size,
  pixel density, anchors, flex direction/alignment, gaps/padding, and child sizing explicitly;
  0.17.0 source defaults to `0.001 m/px` and a `0.2 m` square despite conflicting guidance.
  Use `width: 'auto'` and centered alignment deliberately for shrink-wrap. Use strokes/shadows,
  not large Z gaps, for hierarchy; reserve tiny measured offsets for actual z-fighting.
- **Exact primitives and reactive state:** the pinned constructors are `UIPanel(options)`,
  `UIText(text, options)`, `UIImage(src, options)`, and `UIIcon(iconName, options)`. Use
  `fillColor`, `strokeWidth`, `strokeColor`, and `cornerRadius`, never CSS-like `backgroundColor`
  or `border*`. Mutate live visuals/layout only through typed signal-aware setters such as
  `setFillColor`, `setStrokeColor`, `setStrokeWidth`, `setCornerRadius`, `setProperties`,
  `setText`, `setColor`, and `setOpacity`; direct `.fillColor`, `.color`, `.opacity`, or `.width`
  writes are not the API. Standardize on deterministic six/eight-digit hex colors and at most
  four gradient stops; avoid manual/source-conflicting `rgba()`/`hsla()` strings.
- **Product components:** UIBlocks does not supply stable semantic buttons, toggles, fields,
  selects, trees, menus, tooltips, dialogs, focus management, or an XR-proven scroll control.
  P10.9 must build typed OrcaXR composites over `UIPanel`/text/image: card, labelled button,
  toggle, swatch, tabs, tooltip, paged/virtualized list, dialog, progress, toast, numeric/text
  entry plus virtual keyboard, and contextual inspector. Until real-headset scrolling is proven,
  use paging, search, tabs, and disclosure rather than assuming `overflow: 'scroll'` works.
  Modal overlays sharing a pivot belong inside its card and must block background handlers. Do
  not use `window.prompt()` in XR or cycle an opaque choice on each pinch; present an explicit,
  labelled, reversible list/dialog with confirm and cancel.
- **Interaction:** a UIBlocks button is a composed panel with guarded `onClick()` plus explicit
  idle, hover, pressed, selected, disabled, busy, destructive, and focus-equivalent states.
  The v0.17 wrapper consumes the hit; a callback return value does not control bubbling. Share
  action IDs, enablement, selection, undo state, validation, help, and errors with the DOM
  surface. Mark every card as UI so a hit anywhere beneath it suppresses model manipulation.
  Core already routes select lifecycle events to scripts; do not bind duplicate controller
  `selectstart`/`selectend` handlers. Test release-off-target and overlapping controls.
- **Behaviors:** use only the pinned signatures: `HeadLeashBehavior({offset, posLerp?, rotLerp?})`,
  `BillboardBehavior({mode, lerpFactor?})`,
  `ManipulationBehavior({draggable?, faceCamera?, manipulationMargin?,
  manipulationCornerRadius?})`, `ObjectAnchorBehavior({target, mode, positionOffset?,
  rotationOffset?})`, and `ToggleAnimationBehavior({showAnimation, hideAnimation, duration?})`.
  `distance`, `heightOffset`, `lerpSpeed`, and `constrainToCameraY` are invalid in 0.17.0. Avoid
  combining behaviors that both own rotation; prefer cylindrical billboarding for upright world
  panels, gentle head leash only for critical HUDs, object anchors for contextual UI, and a
  visible header/frame for manipulation.
- **Lifecycle and performance:** `ScriptsManager` is now the sole per-frame card update owner and
  XRBlocks is the sole select dispatcher. `OrcaWorkspace` owns one capability subscription; its
  idempotent disposal removes cards, subscriptions, controls, listeners, and owned GPU resources,
  and any descendant card hit suppresses scene manipulation. Hidden scripts can still auto-tick.
  P10.10 must instrument counts, keep hidden expensive nodes out of the live hierarchy where safe,
  prove recursive cleanup/open-close stability, and record draw/raycast/frame/memory/input metrics
  on the target headset. Do not claim a visibility optimization without traces.
- **Comfort, visuals, access, and assets:** derive placement from `xb.user.height`,
  `xb.user.panelDistance`, and safe-space bounds. Use eye/chest-height, relaxed-field-of-view,
  arm/ray-reachable composition and validate physical type/target sizes at the actual density and
  distance; 20–28 layout-pixel body text around 1.5–1.75 m is only a starting hypothesis.
  Establish shared density/type/spacing/shape/elevation/motion tokens, opaque-enough passthrough
  backplates, contrast at every gradient stop, stroke/shadow separation, non-color state cues,
  visible labels/hints, and brief purposeful motion with reduced-motion and high-contrast modes.
  UIBlocks exposes no ARIA/screen-reader tree, so retain a complete semantic DOM counterpart and
  explicit XR role/label/hint/value/state/status metadata. `UIIcon` and emoji helpers fetch remote
  assets in 0.17.0; production controls must use bundled white/tintable SVGs and local fonts so
  offline/PWA/CSP/privacy behavior is deterministic.

- [ ] **P10.1 — Establish a coherent responsive information architecture.** Keep Prepare,
  Preview, Device, settings, Objects, plates, filament library, action menus, status, and help
  discoverable at desktop, tablet, and phone sizes. Define breakpoints by available space, not
  device names; support portrait/landscape, safe-area insets, virtual keyboard, 200% zoom, and
  browser UI resizing.
  - Use progressive disclosure without hiding uncommon parity functions. Preserve work and
    focus when panels collapse or move. Every async flow has designed loading/empty/progress/
    cancelled/error/success states.
  - **Accept:** comparative task studies for import/arrange, part assignment, virtual gradient,
    paint/remap, slice/inspect, and send require no more steps/time than reference without a
    documented usability benefit; visual review approves all state/viewports.

- [~] **P10.2 — Meet WCAG 2.2 AA and robust input semantics.** Semantic HTML/ARIA, full keyboard
  menus/tree/dialogs/sliders/gizmos, visible focus, focus trapping/restoration, screen-reader
  labels/live regions, non-color cues, accessible charts/legends, 44×44 CSS-pixel targets,
  reduced motion, high contrast, and 200% text/zoom are release gates.
  - Automated axe has zero serious/critical findings, but manual NVDA/JAWS or VoiceOver,
    keyboard-only, switch/touch, color-vision, and high-contrast checks remain required.
  - **Accept:** accessibility test matrix covers every canonical workflow and error state. Any
    inaccessible alternative reopens its feature item.
  - **Current:** a production-build axe smoke gate passes with no serious/critical findings.
    Canonical workflow coverage and all required manual assistive/input reviews remain open.

- [ ] **P10.3 — Complete shortcuts and command discovery.** Generate the shortcut catalog from
  action capabilities; cover global, Prepare, gizmos, Objects, and Preview behavior; allow safe
  remapping/conflict resolution; show context-specific help; support `1–9` filament assignment
  and preview slider controls where applicable.
  - Browser-reserved shortcuts receive discoverable alternatives. Keyboard actions obey current
    text-field/dialog context and never trigger destructive commands invisibly.
  - **Accept:** shortcut manifest maps every upstream outcome or adaptation, automated key tests
    pass, and the help dialog is current by construction.

- [ ] **P10.4 — Provide complete localization infrastructure.** Extract UI/help/errors, use
  message IDs with plural/number/unit/date formatting, allow runtime language switch, avoid
  fixed-width strings, and test pseudo-localization. Support RTL layout where web primitives
  make it feasible; document any geometry-direction exception.
  - **Accept:** no user-facing strings escape extraction except fixture/model data; pseudo-long
    and RTL runs have no clipped critical controls; locale never changes config serialization.

- [ ] **P10.5 — Qualify XR as a complete surface.** World scale, origin/recenter, seated/standing
  reach, dominant hand, ray/direct interaction, grab/manipulator precision, panels, keyboard/text
  entry, scrolling, dialogs, tooltips, haptics, occlusion, color/contrast, comfort, and session
  lifecycle must work on simulator and Galaxy XR hardware under the XRBlocks contract above.
  - Keep the tool rail finite; make the full action catalog reachable in menus/panels. Gate XR
    actions using the same capability/selection state as DOM. Test mouse, both controller rays,
    hands/pinch, gaze/select where available, dominant-hand changes, modal blocking, text entry,
    and every long-list alternative; the simulator does not emulate the WebXR API.
  - **Accept:** every canonical task completes without leaving XR; at least 95% of measured
    frames meet the device refresh interval during representative edit/paint/preview workloads;
    headset review finds no unreadable, unreachable, ambiguous, or fatiguing critical control.

- [~] **P10.6 — Enforce performance and resource budgets.** Establish reference devices and
  record startup/interactive times, main-thread long tasks, frame time, GPU/JS/WASM memory,
  import/save, paint/fill, preview, slice, cancellation, network, and bundle/chunk sizes.
  - Initial gates: interaction tasks under 50 ms; no retained growth after repeated
    load/delete/slice cycles; large work cancellable in workers; no >5% regression in agreed
    budgets without review; desktop/mobile interaction at display refresh; XR target from P10.5.
  - Split the current ~2.03 MB main and ~4.92 MB Spark payload by route/feature. Keep slicer WASM
    NetworkFirst and outside precache; route before predictable WASM OOM with an explicit choice.
  - **Accept:** CI size/perf smoke gates and repeatable device traces exist; memory/OOM tests
    leave the project recoverable and disclose external routing.
  - **Current:** deterministic production chunk-size budgets run in CI. Route splitting, runtime
    latency/memory budgets, cancellation/OOM recovery, and reference-device traces remain open.

- [~] **P10.7 — Harden client, external slicer, and file pipeline.** Bundle and pin WebMCP rather
  than executing `@latest`; define CSP compatible with COOP/COEP; validate archives/XML/G-code;
  sanitize model/catalog metadata; minimize AI/printer secrets and permissions.
  - External server defaults to localhost or authenticated deployment; restrict origins; limit
    request/file/JSON/decompression size, rate, concurrency, CPU/memory/time; cancel/reap child
    processes; bound/persist jobs intentionally; redact engine/internal errors; make its container
    reproducible from a clean clone with a commit-pinned engine.
  - Run dependency, secret, license, and static scans. Document threat boundaries for local LAN
    printers, remote slicer, third-party model/AI services, and hostile projects.
  - **Accept:** abuse tests cover auth/CORS, traversal/ZIP bomb, oversized input, injection,
    cancellation/timeouts, secret/log leakage, SSRF/untrusted webcam URL, and resource exhaustion.
  - **Current:** WebMCP is exact-pinned/local/typed; CSP and local assets are gated; the server
    defaults to loopback, fails closed for non-loopback auth/origins, bounds uploads/JSON/ZIP/
    queue/jobs/rates/time, cancels process trees, and redacts public responses and logs. The full
    hostile XML/G-code/client SSRF/license/static-scan matrix and production threat review remain.

- [~] **P10.8 — Add offline/PWA and recovery guarantees.** App shell, profiles, help, local
  editing, save/export, and already-downloaded assets work offline; slicer update caching follows
  the repository's NetworkFirst rule. Autosave uses versioned snapshots with quota handling,
  crash recovery preview, explicit discard, and corruption fallback.
  - **Accept:** offline reload completes supported work; update never mixes incompatible worker/
    WASM/schema versions; forced crash/quota/corruption restores or clearly reports last safe data.
  - **Current:** app-shell/icons are precached; runtime content is NetworkFirst; slicer artifacts
    use a separate bounded cache; production offline reload is tested. Autosave, quota/corruption
    recovery, and worker/WASM/schema atomic-update guarantees remain open.

- [~] **P10.9 — Build a version-pinned XRBlocks design system and typed adapter.** Exact-pin the
  qualified XRBlocks/UIKit pair and isolate addon imports behind a typed, mockable adapter. Remove
  UIBlocks `any`/`@ts-ignore`, fake mutable-field interfaces, invalid `backgroundColor`/`border*`/
  `constrainToCameraY` options, and every direct reactive-property assignment. Build the product
  components and shared DOM/XR physical/visual/state tokens required by the contract, with one
  card per pivot and nested flex layout.
  - Add a component gallery covering every state, density, long/pseudo-localized label, gradient
    endpoint, icon fallback, modal composition, and destructive/busy/error condition. Keep the
    finite tool rail and design the object tree, FullSpectrum editor, painting, settings, preview,
    and device flows as contextual spatial compositions rather than desktop-window replicas.
  - **Accept:** strict typecheck rejects undocumented properties and direct mutations; unit and
    visual tests cover every composite/state/token; all critical icons/fonts render with network
    disabled and CSP enforced; design/accessibility review approves the gallery in DOM, simulator,
    and Galaxy XR without API suppressions or runtime asset fetches.
  - **Current:** XRBlocks/UIKit and 97 Material SVGs are exact/local; typed signal setters, shared
    capability state, a seven-action finite rail plus menu overflow, CSP, and offline icon tests
    pass. The complete composite adapter/gallery, visual review, and Galaxy XR review remain open.

- [~] **P10.10 — Qualify XRBlocks input, lifecycle, cleanup, and headset performance.** Instrument
  script/card update counts and input dispatch, then leave exactly one update owner and one select
  lifecycle path. Make any hit beneath any `UICard` suppress workspace gestures; prove modal
  isolation, release-off-target behavior, overlap ordering, disabled guards, and simultaneous
  pointers. Add deterministic teardown for cards/subtrees, UIKit resources, GPU assets, window/
  canvas/controller listeners, and store subscriptions; make hidden expensive surfaces lazy or
  safely paused based on traces rather than `visible` assumptions.
  - Exercise wrappers with XRBlocks testing frame stepping and click/point automation, simulator
    snapshots, and real-headset mouse/controller/hand/gaze, manipulation, paging, keyboard,
    recenter/session, reduced-motion, passthrough, offline, repeated open/close, and recovery runs.
    Track physical target/readability measurements, scripts/cards/panels, draw calls, raycast work,
    CPU/GPU frame time, input latency, GPU/JS memory, and leaked listeners/resources.
  - **Accept:** counters prove one update and one input transition per frame/event; lifecycle and
    repeated-open/close tests show no retained growth or stale handler; no UI hit mutates the scene;
    all input/comfort/offline cases pass in simulator and Galaxy XR, with the P10.5 frame target and
    recorded evidence for budgets, screenshots/video, physical dimensions, and reviewer findings.
  - **Current:** duplicate manual card updates/select handlers are removed, UI ancestry blocks
    scene gestures, and disposal is deterministic and idempotent. Counter/snapshot automation,
    retained-growth traces, simultaneous-input cases, and simulator/Galaxy XR evidence remain.

P10 exit gate: all canonical flows pass the viewport/input/accessibility/XR/performance/security
matrices and independent visual/interaction review rates them at least official quality.

## 17. P11 — Application, help, diagnostics, and automation surface

Upstream anchors: menus in [`MainFrame.cpp`][up-main-frame], project lifecycle in
[`Plater.hpp`][up-plater-h], shortcuts in [`KBShortcutsDialog.cpp`][up-shortcuts], preferences in
[`Preferences.cpp`][up-preferences], and the generated P0 manifest.

Local starting seams: the [`action groups`](../web/src/actions/groups/),
[`helpContent.ts`](../web/src/actions/helpContent.ts),
[`SystemTools.ts`](../web/src/mcp/SystemTools.ts), and
[`WorkspaceTools.ts`](../web/src/mcp/WorkspaceTools.ts).

- [ ] **P11.1 — Complete project/file lifecycle.** New with dirty prompt, Open, Open Recent with
  thumbnail/missing-file handling, Save, Save As/copy, autosave/recovery, import conflicts,
  project metadata, and close/reset operate consistently with browser file capabilities.
  - Local-file handles are optional enhancements; standards downloads/uploads remain complete.
  Recent entries reveal storage origin and can be removed without deleting the project silently.
  - **Accept:** dirty-state/recovery matrix covers every operation and storage/browser mode; no
    project or preset change is discarded without confirmation.

- [ ] **P11.2 — Close every menu, toolbar, context, camera, and view gap.** File, Edit, View, Add,
  Prepare/tool, plate/object context, Calibration, Device, Help, scene cameras, perspective/
  orthographic, navigator, outlines/wireframe, zoom/frame, G-code window, and display toggles map
  to tested capabilities or adaptations.
  - Generate all surfaces from one action model while allowing platform-appropriate placement.
  A full-catalog search/command palette prevents hidden reachability gaps.
  - **Accept:** P0 surface manifest has no unclassified item and reachability tests pass for DOM,
    touch, keyboard, and XR.

- [ ] **P11.3 — Build contextual help and troubleshooting.** Help for each action/setting/error
  links to version-appropriate official docs or maintained OrcaXR adaptation docs. Include
  onboarding, shortcuts, FullSpectrum, parts/assignments, painting, profiles, preview, Moonraker,
  offline/XR, privacy/security, known limitations, diagnostics, and release notes.
  - Help is searchable, keyboard/screen-reader accessible, available offline for core flows, and
    generated/checkable for dead links and unmapped actions/settings.
  - **Accept:** link checker and help-coverage test pass; novice task study can recover from the
    standard preflight/error corpus without developer assistance.

- [ ] **P11.4 — Implement diagnostics and support export.** Structured bounded logs, capability/
  profile/engine/browser/XR/printer state, worker crashes, performance snapshot, and sanitized
  project summary export to one archive after a privacy preview. Never include G-code/project,
  tokens, LAN URLs, or model names without explicit selection.
  - **Accept:** injected failures are diagnosable; redaction tests prove known secret/PII patterns
    absent; export logs action is no longer a placeholder.

- [~] **P11.5 — Make automation/MCP honest and safe.** Expose typed project/action APIs over the
  same command/capability layer with permission scopes, confirmation for destructive/send/print
  operations, cancellation, revision checks, audit trail, and schema/version negotiation.
  - Voice and AI actions resolve to capability IDs and canonical commands; they cannot bypass
    disabled state, validation, undo, privacy, or printer confirmations.
  - **Accept:** contract tests cover every exposed tool, permission denial, malicious arguments,
    stale revision, cancellation, undo, and capability parity. Automation is an enhancement and
    cannot substitute for missing manual UI.
  - **Current:** the WebMCP client is local, exact-versioned, loopback-by-default, bearer-protected,
    schema-checked, timeout/size bounded, and avoids CDN/eval/global injection. Canonical command
    routing, per-tool permissions/confirmation, audit, revision/cancellation, and full contracts
    remain open.

- [~] **P11.6 — Reconcile canonical repository documentation and licensing.** Update `GEMINI.md`,
  `README.md`, `CONTRIBUTING.md`, `DESIGN.md`, CI/deploy instructions, engine provenance, commands,
  architecture, supported targets, limitations, and missing/stale roadmap references as facts
  change. Add the root license files/notices required by declared dependencies and distribution.
  - Follow the `GEMINI.md` self-update mandate in every implementation change; the parity plan
    and canonical context must not contradict each other.
  - **Accept:** clean-clone setup/build/test/deploy/server/WASM instructions work; docs/link/license
    checks pass; no current claim references removed Android paths as the production app.
  - **Current:** this plan and `GEMINI.md` now describe the foundation and gates. Repository-wide
    README/DESIGN/contributing/license cleanup and clean-clone documentation qualification remain.

- [ ] **P11.7 — Maintain the platform adaptation register.** For each native/cloud-only feature,
  record upstream outcome, parity class, web replacement, user-visible difference, risk, owner,
  acceptance tests, and approval. Initial mandatory rows are:
  - Native file dialogs/recent files → browser picker/download/File System Access plus recovery.
  - OS shell/config folder/log folder → in-app preferences/diagnostics export.
  - Serial/USB/native LAN discovery → explicit Moonraker endpoint and optional authorized proxy.
  - Snapmaker/Bambu cloud login, binding, AMS, publishing, and multi-device cloud pages → target-
    printer Moonraker upload/tool mapping/status/storage/history, plus URL/local model import where
    it preserves the user outcome; proprietary-only automation remains a named blocker.
  - Desktop windowing/DPI/update installer → responsive PWA, browser zoom, app/profile/engine
    version reporting and controlled service-worker updates.
  - Desktop 3D input conventions → documented mouse/touch/keyboard/XR-equivalent bindings.
  - **Accept:** product and engineering reviewers approve each outcome equivalence; anything
    without equivalent outcome stays `[!]` and prevents the broad parity release claim.

P11 exit gate: every generated application surface is implemented or approved as an adaptation,
help/diagnostics are complete, and canonical docs describe the shipping system accurately.

## 18. P12 — Independent parity qualification and release

- [ ] **P12.1 — Audit upstream drift before qualification.** Fetch latest release metadata and
  rerun P0 extraction against both pinned v2.3.4 and latest. Do not silently bump. If the target
  changes, record the decision, clean-apply the WASM patch set, regenerate manifests/schema,
  rebuild both engines, rerun golden tests, and reopen every affected hardware-sensitive item.
  - **Accept:** source/patch/artifact/profile hashes and drift report are attached; every delta has
    a plan disposition.

- [ ] **P12.2 — Run independent workflow parity review.** A reviewer who did not implement the
  feature executes the coverage matrix against official Snapmaker Orca and OrcaXR using the same
  fixtures/profiles. Record outcome, steps, time, errors, output comparisons, UX/a11y findings,
  and artifacts on desktop, mobile, and XR.
  - **Accept:** no `partial`, `unavailable`, false-success, silent-loss, or undocumented behavior
    remains in a core parity workflow; approved adaptations meet their outcome tests.

- [ ] **P12.3 — Run engine and artifact qualification.** Rebuild WASM, browser assets, server
  WASM/CLI, and profiles from documented clean sources; verify hashes/provenance; run all project,
  config, 3MF, G-code, hostile-input, cancellation, memory, and route-comparison corpora.
  - **Accept:** required artifacts are reproducible; semantic tolerances pass; no stale bundle or
    uncommitted developer-local fixture participates.

- [ ] **P12.4 — Run target hardware qualification.** On recorded U1 and Elegoo CC firmware,
  nozzle, profile, and material combinations, inspect G-code then supervise compact prints for
  single material, multi-part assignment, painted physical colors, every supported FullSpectrum
  mode, modifiers/support/seam/fuzzy/brim, calibration, multi-plate/send, pause/resume/cancel, and
  reconnect/recovery.
  - **Accept:** safety, dimensions, boundary/surface quality, tool mapping/purge, and operational
    results are signed in the hardware ledger; unsupported FullSpectrum on a target is reported
    accurately rather than simulated.

- [ ] **P12.5 — Pass release quality and security review.** Run all commands in §21; complete
  accessibility, browser/viewport, XR, performance/memory, offline/recovery, threat-model, abuse,
  dependency/license, privacy, and visual review gates. Resolve every critical/high finding.
  - **Accept:** evidence is attached and waivers contain owner, rationale, user impact, mitigation,
    expiry, and approval. A waiver cannot relabel missing core behavior as parity.

- [ ] **P12.6 — Publish a traceable parity release.** Generate feature/adaptation/evidence reports
  from manifests, include upstream and engine hashes, known limitations, migration/recovery,
  privacy/security, supported browser/device/printer matrix, and user documentation.
  - **Accept:** all parent/child tasks required for the claim are `[x]`, every row has evidence,
    no `[!]` blocks the advertised scope, installed artifacts pass smoke tests, and rollback is
    rehearsed.

P12 exit gate: the broad “full feature parity with Snapmaker OrcaSlicer v2.3.4 for the declared
OrcaXR targets” claim may be made only after P12.6 is verified.

## 19. Feature-family coverage matrix

This human-readable matrix is the minimum scope guard. The generated P0 manifests become the
leaf-level authority and may expand it. “Baseline” is an audited observation, not a completion
status. No row is complete until all mapped tasks and applicable cross-cutting P10/P12 gates are
`[x]`.

| Feature family / required outcome | Primary tasks | 2026-07-17 baseline |
|---|---:|---|
| Upstream actions/settings/gizmos/formats/calibrations inventory and drift | P0.1, P12.1 | Exact pinned extractor maps 1,622 leaves/13 families from 17 Git blobs; manual upstream workflow sampling remains |
| Truthful menu/toolbar/context/shortcut/XR capability state | P0.2, P11.2 | One guarded registry reports 77 partial and 34 unavailable actions; full upstream reachability remains |
| Clean-clone typecheck/test/build/CI and reproducible engine artifacts | P0.3, P12.3 | Aggregate local gate and artifact provenance pass; clean-clone CI/native rebuild qualification remains |
| Golden 3MF/config/G-code/security fixture oracle | P0.4 | Structural 3MF, semantic G-code, and hostile server fixtures pass; official Snapmaker corpus remains |
| Shared domain/action/surface boundaries | P0.5, P1.1–P1.2 | Canonical project/history and guarded action boundaries exist; legacy live workspace migration remains |
| New/open/recent/save/save-as/dirty prompts/recovery | P1.3–P1.6, P11.1 | Transactional import, migration, session, and deterministic save foundations exist; live/recovery UX remains |
| BBS 3MF project and generic 3MF round-trip | P1.3 | Deterministic BBS core plus lossless envelope exists; complete official Orca round-trip remains |
| Project/plate/object/volume/instance/layer-range model | P1.1, P2.1 | Canonical graph and headless tree exist; live workspace adoption is missing |
| Selection set and synchronized scene/Object tree | P1.2, P2.1, P5.1 | Canonical entity selection and headless accessible tree/navigation exist; DOM/scene sync is missing |
| Object/part/instance add, clone, split, merge, move, reload | P2.2 | Canonical lifecycle subset covers rename/delete/duplicate/instances/move; topology/UI/oracle work remains |
| Per-object/per-part/per-height filament selection and inheritance | P2.3, P2.5 | Canonical stable-ID assignment/inheritance commands exist; selector/live propagation/oracles are missing |
| Solid/modifier/negative/support-enforcer/blocker volume roles | P2.4 | UI actions are placeholders |
| Per-object/part/layer settings | P2.5, P6.5 | Missing |
| Physical filament/tool/profile lifecycle and stable mapping | P3.1 | Canonical stable-ID definitions and reversible lifecycle commands exist; live/device/engine mapping is missing |
| Virtual filament add/edit/duplicate/delete/remap | P3.2, P3.8 | Canonical physical-component CRUD/tombstone/removal commands exist; full field model/dialog/live integration remains |
| FullSpectrum Ratio authoring and slicing | P3.3, P3.9 | Preview/parser building blocks only |
| FullSpectrum Cycle authoring and slicing | P3.4, P3.9 | Preview/parser building blocks only |
| FullSpectrum Match authoring and gamut search | P3.5, P3.9 | Disconnected/mock helpers only |
| FullSpectrum Gradient authoring and Local-Z output | P3.6–P3.7, P3.9 | Imported project path only |
| Virtual filaments in parts, painting, legends, preview, persistence | P2.3, P3.8, P4.4 | Canonical part/range assignment accepts enabled mixed IDs; paint/legend/preview/live persistence is missing |
| Canonical independent facet channels | P4.1–P4.2 | Five topology-aware sparse channels and guarded stroke history exist; live paint/subdivision/oracles are missing |
| Color Circle/Sphere/Triangle/Height/Fill/Gap Fill | P4.3 | Radius vertex brush only |
| Physical + virtual color palette, erase, clipping, filters | P4.3–P4.4 | Physical radius/color/size only |
| Filament source→destination paint remapping | P4.5 | Canonical atomic many-to-one remap exists; preview/UI/default/deletion/oracle flows are missing |
| Support painting | P4.6 | Placeholder |
| Seam painting | P4.7 | Placeholder |
| Fuzzy-skin painting and brim ears | P4.8 | Placeholders |
| AI-assisted painting through canonical annotations | P4.9 | Scaffolded, typed/logic defects |
| Safe painted slicing without monochrome fallback | P4.10, P7.1 | Fail-closed guard and canonical revisioned slice coordinator exist; live route/fault/send gate is pending |
| Move/rotate/scale/mirror/lay/auto-orient/numeric transforms | P5.1 | Core subset present; scope/selection incomplete |
| Cut/split/Boolean/repair/simplify | P5.2 | Useful partial implementations |
| Measure/assembly/emboss/SVG/simplify/brim gizmos | P5.3 | Mostly placeholders or disconnected code |
| Multi-plate lifecycle, settings, lock/reorder/current/all slice | P5.4 | Basic plates/arrange only |
| Collision-aware arrangement/orientation/wipe tower | P5.5 | Partial helpers; parity unverified |
| Import 3MF/STL/STEP/SVG/OBJ/AMF/ZIP as appropriate | P5.6 | Picker STL/3MF; dispatch claims exceed behavior |
| Export project/core/sliced 3MF, STL variants, G-code, OBJ, bundles/logs | P5.7 | Partial; several actions placeholders |
| Primitives, text/SVG, handy/URL model sources | P5.8 | Primitives/catalog partial |
| Variable/adaptive layer-height profile editor | P5.9 | Action is a placeholder; helper is disconnected |
| Complete generated engine settings schema | P6.1 | Deterministic 816-definition/809-key foundation exists; GUI layout/runtime dump/dispositions remain |
| Process Quality/Strength/Speed/Support/Multimaterial/Others | P6.2 | Headless generated-schema editor supports core field families; GUI layout/special widgets/engine proofs are missing |
| Filament pages and printer/extruder/machine-G-code pages | P6.2 | Headless schema fields exist without complete generated pages, special widgets, live UI, or engine proofs |
| System/user/project preset inheritance/compatibility/lifecycle | P6.3 | Profile load/select partial |
| Setup/custom printer/custom filament/bundle import/export | P6.4 | Profile files exist; lifecycle missing |
| Settings search/modes/dependencies/validation/reset/compare | P6.2–P6.5 | Headless modes/search/validation/inheritance/reset/compare exist; dependencies/scopes/live surfaces are missing |
| Application preferences, storage migration, secret handling | P6.6 | Fragmented local storage; no full dialog |
| Correct config types/vector delimiters across boundaries | P6.7 | Generated-schema codec fail-closes delimiter drift for supported families; special/boundary matrix remains |
| Revisioned current/all plate slice, cancel, progress, route parity | P7.1 | Headless canonical coordinator covers current/all, cancel/retry/timeout/revision/provenance; live progress/routes/oracle remain |
| Preflight and actionable engine/project/device errors | P7.2 | Partial |
| Rich G-code parsing and standalone G-code open | P7.3, P7.7 | Minimal line parser; open missing |
| All preview color modes/move filters/legends | P7.4 | Missing |
| Layer and sequential-move sliders/playback/G-code window | P7.5 | Missing/placeholders |
| Complete estimates/material/tool/conflict/all-plate statistics | P7.6 | Missing |
| Layer pauses/custom G-code/color changes/filament sequences | P7.8 | Store scaffold exists; authoring missing |
| Calibration generators and real per-band output | P8.1–P8.3 | Some geometry generators; effect unverified |
| Connected calibration wizard, save/history | P8.4–P8.6 | Missing |
| Secure Moonraker connection and multi-printer setup | P9.1–P9.2 | Basic clients/probe only |
| Pre-print validation/tool mapping/upload/start | P9.3–P9.4 | Basic DOM flow and truthful capability gates exist; complete preflight/tool mapping/hardware flow remains |
| Live status/control/storage/queue/history | P9.4–P9.5 | Missing |
| Camera/console/macros/history | P9.6 | Snapshot scaffold; rest missing |
| Responsive desktop/tablet/mobile IA and complete states | P10.1 | Useful recent shell work; parity unverified |
| WCAG AA, keyboard, screen reader, non-color states | P10.2–P10.3 | Axe smoke and headless tree semantics pass; complete workflows and manual assistive review remain |
| Localization/pseudo-localization/RTL-safe layout | P10.4 | Missing |
| XRBlocks typed design system, correct reactive API, local assets | P10.9 | Exact pins, local icons, and audited UI/UIBlocks contract exist; full qualified component kit remains |
| Complete XR workflows and common capability gating | P2.6, P10.5, P10.9–P10.10 | Shell exists; many workflows and input modes missing |
| XR update/input ownership, cleanup, comfort, headset budgets | P10.10 | Duplicate owners removed and disposal is idempotent; instrumentation/headset budgets remain |
| Bundle/frame/memory/worker/WASM resource budgets | P10.6, P10.10 | Production chunk budgets pass; runtime/frame/memory/device budgets remain |
| Client/server/archive/printer/AI security | P10.7 | Bounded authenticated server/archive abuse suite passes; full threat/device/AI review remains |
| PWA offline, coherent updates, autosave/crash recovery | P10.8 | Offline/CSP/update contract and production reload smoke pass; autosave/crash recovery UX remains |
| Complete menus/cameras/views/shortcuts/help/preferences | P11.2–P11.3 | Broad shell, many false or missing behaviors |
| Diagnostics/log export and privacy preview | P11.4 | Placeholder |
| Typed permissioned MCP/voice/AI automation | P11.5 | Scaffolds; remote/unpinned risk |
| Canonical docs, setup, license/provenance consistency | P11.6 | Contradictory/stale docs; root license absent |
| Native/cloud outcome adaptations | P11.7 | Not yet reviewed |
| Independent desktop/mobile/XR/engine/hardware qualification | P12.2–P12.6 | Not performed |

## 20. Operating the plan and recording evidence

### Parity classes

Every generated leaf feature and manual task has exactly one class:

- **Exact:** behavior/data/output should match v2.3.4; surface presentation may be responsive.
- **Platform-adapted:** native/cloud mechanism differs, but the user outcome and safety are
  equivalent. Requires an approved adaptation row.
- **Enhancement:** additional OrcaXR capability. It cannot satisfy or hide a missing parity item.
- **Blocked:** no safe equivalent is currently implementable. It remains visible in scope and
  prevents a broad parity claim if it affects the declared targets.
- **Not applicable:** the upstream outcome truly does not exist for supported technology/targets.
  Requires source evidence and product/engineering approval; use sparingly.

### Required task record

When a broad item is split for implementation, use this complete record in this file or a linked
generated issue. Parent checkboxes remain open until every required child is verified.

```markdown
### [ ] Pn.n.child — Imperative outcome

Status: NOT_STARTED | DISCOVERY | BLOCKED | IN_PROGRESS |
        IMPLEMENTED_UNVERIFIED | VERIFIED | REGRESSION
Parity class: Exact | Platform-adapted | Enhancement | Blocked | Not applicable
Upstream baseline: pinned source symbols and official user docs
Local baseline: precise files/symbols and observed limitation
Dependencies: task IDs
Platforms: engine, desktop, mobile, XR, U1, Elegoo CC as applicable
Risks: data loss, compatibility, safety, performance, privacy

User outcome:
- Given/when/then behavior, including errors and cancellation.

Implementation:
- [ ] Domain and command/history changes.
- [ ] DOM/mobile presentation.
- [ ] XR presentation.
- [ ] 3MF/config/preset persistence and migration.
- [ ] engine/worker/server/device integration.
- [ ] help/accessibility/security/performance work.

Acceptance:
- [ ] Automated unit/integration/E2E/golden assertions.
- [ ] Manual comparative and applicable hardware assertions.
- [ ] No silent fallback, stale result, dangling reference, or data loss.

Evidence: EVID-nnn or Pending
```

### Checkoff and plan-update rules

1. Only `VERIFIED` receives `[x]`; code-complete without full evidence is `[~]` and
   `IMPLEMENTED_UNVERIFIED`.
2. A parent requires all children, acceptance bullets, surfaces, engine routes, and applicable
   hardware. A passing build or visible button never completes a parent.
3. A regression immediately reopens the checkbox, changes status to `REGRESSION`, links the
   failing evidence, and blocks dependent release gates.
4. Discovery that changes scope, architecture, dependencies, risks, or acceptance criteria must
   update this plan in the same change **before** completion. Add missing work; do not erase it.
5. Split partial work into stable IDs. If an item is replaced, retain `Superseded by Pn.n...` and
   migrate evidence. Never renumber existing public IDs simply to make the list tidy.
6. Criteria can be strengthened freely. Weakening or classifying Not applicable needs a decision
   row stating source evidence, user impact, alternatives, owner, approvers, and review date.
7. Upstream additions are appended and mapped; they are never silently omitted. Generated counts
   and percentages come from the verifier, not hand-edited prose.
8. Update `GEMINI.md` and any affected setup/design/user docs with new durable facts, commands,
   gotchas, or decisions in the same change.
9. Evidence is immutable except for correction notes. New runs supersede old rows; they do not
   rewrite history. Expired browser/firmware/upstream evidence triggers requalification.

### Evidence ledger

| Evidence ID | Task(s) | Local commit | Upstream/engine hash | Date | Commands and fixtures | Browser/device/printer | Result/artifact | Reviewer |
|---|---|---|---|---|---|---|---|---|
| `EVID-000` | Baseline audit only; no completion credit | Pending current worktree commit | `9fd12ff...` | 2026-07-12 | `npm run build`; typecheck; 13 TS test-file audit; painted WASM test | Local Chromium-capable dev host; no hardware | Build passed; typecheck and 4 test files failed; see §3 | Codex audit; independent review pending |
| `EVID-001` | P0.1 | Uncommitted worktree; commit pending | `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626` | 2026-07-17 | `npm --prefix web run parity:verify`; generated manifest/disposition mutations | Node 22.21.0 | Pass: 1,622 leaves, 13 families, 17 exact blobs; deterministic and action/setting/stale/duplicate mutations rejected | Codex automated review; official binary/manual sample pending |
| `EVID-002` | P0.4 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run parity:oracles`; 11 CC0 artifacts and five required mutations | Node 22.21.0 | Pass: structural 3MF and semantic G-code mutations, relationships/extensions, ZIP normalization/tolerances | Codex automated review; Snapmaker-generated reference pending |
| `EVID-003` | P0.5, P1.1–P1.3 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run architecture:check`; `npm --prefix web run test:project`; structural parity 3MF | Node 22.21.0; headless | Pass: boundaries; 9 domain, 8 history, 3 session, and 4 BBS serializer tests | Codex review; P0.5/P1.1 verified; P1.2/P1.3 residuals documented |
| `EVID-004` | P0.2, P11.2 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run test:unit`; registry/XR capability fixtures | Node 22.21.0 | Pass: 111 actions = 77 partial + 34 unavailable; guards/surfaces/seven-action XR rail verified; zero false implemented | Codex automated review; full upstream reachability pending |
| `EVID-005` | P0.3, P10.2, P10.6, P10.8–P10.10 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run quality`; production build/E2E/offline/axe/size/CSP/icons | Chrome for Testing 150.0.7871.24; desktop/mobile emulation; no headset | Pass: 20/20 unit files, 3 integration files, production capability smoke, offline reload, 24 axe rules, 97 local XR icons, bundle budgets | Codex automated review; manual browser/AT/headset matrices pending |
| `EVID-006` | P6.1 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run settings:verify`; runtime loader test | Node 22.21.0 | Pass: deterministic 816 definitions/809 keys; eight fail-closed mutations; strict loader | Codex automated review; GUI/runtime C++ qualification pending |
| `EVID-007` | P10.7, P11.5 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix server test`; WebMCP tests; Compose config; CSP/security contract | Node 22.21.0; Docker 28.3.1; loopback/non-loopback fixtures | Pass: 20 server tests covering auth/CORS/bounds/bombs/rates/queue/cancel/timeouts/log redaction; typed local WebMCP contract | Codex automated review; production threat/static/license review pending |
| `EVID-008` | P0.3, P3.9, P7.1 | Uncommitted worktree; commit pending | artifact ledger `9fd12ff...` | 2026-07-17 | `npm --prefix wasm run verify:artifacts`; cube/profile/project/painted/prime-tower/FullSpectrum smokes | Node 22.21.0 WASM; no printer | Pass: exact output/input provenance; FullSpectrum 15.0 MB G-code, 1,944 layers, 1,188 tool changes, T0–T3 | Codex automated review; clean rebuild/native/printer parity pending |
| `EVID-009` | P0.3 aggregate | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `./scripts/quality.sh` | Node 22.21.0; Chrome 150; Docker 28.3.1; no hardware | Pass: complete repository wrapper including all package installs/gates and three zero-vulnerability production audits | Codex automated review; clean-clone CI execution pending |
| `EVID-010` | P1.4–P1.6, P2.1–P2.3, P3.1–P3.2, P4.1–P4.2, P4.5, P6.2, P6.7, P7.1 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run test:project`; `npm --prefix web run test:settings`; typecheck; architecture check; pinned `MixedFilament.hpp` source audit | Node 22.21.0; headless | Pass: 12/12 project files (67 tests), 2/2 settings files (5 tests), pure boundaries, physical-only recipe components, exact undo/cancel/stale/no-op guards | Codex automated review; live UI/engine/official-Orca/device qualification pending |
| `EVID-011` | P0.3, P0.5, P4.10, P6.1–P6.2, P10.2, P10.6, P10.8–P10.10 | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `npm --prefix web run quality` | Node 22.21.0; Chrome 150; desktop/mobile emulation; no headset | Pass: 30/30 unit files, 3/3 integration files, 12/12 project files, 2/2 settings files, exact parity/schema/oracles, production/offline/axe/size gates | Codex automated review; manual browser/AT/headset and official workflow matrices pending |
| `EVID-012` | P0.3 aggregate; supersedes `EVID-009` for this worktree | Uncommitted worktree; commit pending | `9fd12ff...` | 2026-07-17 | `./scripts/quality.sh` | Node 22.21.0; Chrome 150; Docker 28.3.1; WASM; no hardware | Pass: clean installs, web/server/WASM suites, real cube/profile/project/paint/prime-tower/FullSpectrum slices, Compose validation, and three zero-vulnerability production audits. One earlier browser-ready timeout was followed by four direct offline passes and this complete wrapper pass. | Codex automated review; clean-clone CI/headset/printer/native rebuild pending |

Store large reports, normalized comparison JSON, traces, screenshots, videos, and hardware photos
under the CI artifact URL named in the row; do not bloat Git with generated G-code. Small golden
fixtures and expected semantic summaries live in `testdata/parity/` with licenses and SHA-256.

### Platform-adaptation register

| ID | Upstream outcome/mechanism | OrcaXR equivalent | Class/status | Required evidence |
|---|---|---|---|---|
| `ADAPT-01` | Native file dialogs, recent paths, shell reveal | Web picker/download/File System Access where available, recent handles/metadata, diagnostics export | Platform-adapted / proposed | P5.6–P5.7, P11.1, browser matrix |
| `ADAPT-02` | Serial/USB/native discovery | Explicit Moonraker endpoint and optional permissioned local proxy/discovery | Platform-adapted / proposed | P9.1–P9.2, U1/Elegoo setup study |
| `ADAPT-03` | Vendor cloud login/binding/device transport | Authenticated Moonraker connection and local multi-printer manager | Platform-adapted / proposed | P9, security review, outcome comparison |
| `ADAPT-04` | AMS/vendor filament slot UI | Target-printer head/tool/spool capability and FullSpectrum dependency mapping | Platform-adapted / proposed | P3.9, P9.3, hardware G-code/print |
| `ADAPT-05` | Vendor publish/model-cloud pages | Local/URL/approved catalog import/export with explicit provenance; no forced account | Platform-adapted / proposed | P5.8, P10.7, user study |
| `ADAPT-06` | Desktop window/DPI/update installer | Responsive PWA, browser zoom, accessible scaling, controlled service-worker/profile/engine updates | Platform-adapted / proposed | P10.1–P10.5, P10.8–P10.10 |
| `ADAPT-07` | Desktop mouse/3D input and native shortcuts | Documented mouse/keyboard/touch/XR bindings and command palette alternatives | Platform-adapted / proposed | P5.1, P10.2–P10.5, P10.9–P10.10 |

“Proposed” is not approval. P11.7 owns the completed decision record. If proprietary automation
has no equivalent, add a `BLOCK-*` row rather than calling it done or Not applicable.

### Decision and change log

| Date | Decision/change | Reason and evidence | Affected tasks | Approvers |
|---|---|---|---|---|
| 2026-07-12 | Pin initial parity target to Snapmaker v2.3.4 / `9fd12ff...`; supersede `orca_parity_plan.md` | Latest audited Snapmaker release; old plan measures visible actions and has false positives | All | Initial planning decision; product/engineering confirmation pending |
| 2026-07-12 | Treat same-layer pointillisme as enhancement, not v2.3.4 parity | Upstream executor is compiled out at pinned commit | `E-FS-01`, P3 | Initial source audit; review on baseline bump |
| 2026-07-12 | Use version-pinned UIBlocks for rich production cards and core Spatial UI only for separate lightweight panels; one card per spatial pivot | XRBlocks explicitly forbids mixing the systems on one panel; UIBlocks supplies nested Yoga layout while card-per-section increases cost and transform/depth drift | P10.5, P10.9–P10.10 | Documentation/source audit; headset review pending |
| 2026-07-17 | Make exact Git-blob extraction and generated dispositions the scope authority | Dirty worktrees and visible-action counts cannot prove upstream coverage; deterministic source anchors and mutations can detect drift | P0.1, P6.1, P12.1 | Automated review complete; official binary/manual sample pending |
| 2026-07-17 | Make the canonical project graph/history and action capability registry the only new domain/invocation boundaries | UI-owned mutable lists and direct handlers caused metadata loss, stale async results, and false success across surfaces | P0.2, P0.5, P1 | Foundation tests complete; live migration pending |
| 2026-07-17 | Use a deterministic browser BBS-core projection plus a versioned lossless OrcaXR envelope as the P1.3 adapter foundation | It permits safe incremental migration and byte-preservation of unknown entries without claiming guessed TypeScript XML is officially interoperable | P1.3 | Structural oracle passes; official Orca round-trip pending |
| 2026-07-17 | Bundle XR icons locally and leave `ScriptsManager`/XRBlocks as the sole frame/input owners | CDN icons violate offline/CSP/privacy requirements; duplicate lifecycle ownership caused double work and stale handlers | P10.8–P10.10 | Browser tests complete; headset/performance review pending |
| 2026-07-17 | Fail closed instead of slicing stale FullSpectrum bytes or flattening painted semantics | Exact semantic snapshots and canonical revision/hash guards prevent a successful but mislabeled monochrome or stale artifact | P1.5, P4.10, P7.1 | Fault/unit tests complete; live download/send and engine-route qualification pending |
| 2026-07-17 | Restrict authored mixed-filament components and component remaps to stable physical-head IDs | Pinned `MixedFilament.hpp` defines `component_a`, `component_b`, and gradient IDs as 1-based physical filament IDs; nested virtual recipes have no v2.3.4 engine semantics | P3.1–P3.2, P4.5 | Type/runtime/command tests complete; official serializer/UI qualification pending |
| YYYY-MM-DD |  |  |  |  |

## 21. Verification interface and matrices

The clean-clone repository interface now exists. It installs exact lockfiles and runs web,
server, WASM, provenance, parity, oracle, security, offline, browser, accessibility, and audit
gates in dependency order:

```bash
./scripts/quality.sh
```

CI splits the same contract into web, parity, server, WASM, and secret-scan jobs. For targeted
iteration use the package contracts rather than bypassing their subchecks:

```bash
npm --prefix web run quality
npm --prefix web run test:project
npm --prefix web run test:settings
npm --prefix server test
npm --prefix wasm run verify:artifacts
npm --prefix web run parity:verify
npm --prefix web run settings:verify
npm --prefix web run parity:oracles
```

The native Snapmaker CLI image is intentionally an explicit, long-running source-build gate. A
real deployment token and exact browser origin are required by the fail-closed Compose contract:

```bash
ORCAXR_BUILD_CONTAINER=1 \
ORCAXR_SERVER_TOKEN='<at-least-32-random-bytes>' \
ORCAXR_ALLOWED_ORIGINS='https://exact-app-origin.example' \
./scripts/quality.sh
```

Artifact verification proves that the two checked-in WASM copies match the recorded engine,
source/patch-input aggregate, and output hashes. It does not replace the native source build.
Tests use committed/generated fixtures, never developer downloads or removed Android paths. The
remaining manual official-Orca, browser-matrix, headset, printer, and independent-review rows are
release evidence, not steps silently implied by this automated command.

### Golden fixture matrix

| Fixture family | Minimum variants | Assertions |
|---|---|---|
| Basic geometry | cube, manifold organic, non-manifold, high-poly | units, bounds, repair, slice roles, memory |
| Hierarchy | multi-object, multi-part, repeated instances, names/transforms | counts, stable IDs, sharing, selection, round-trip |
| Semantic volumes | modifier, negative, support blocker/enforcer, overlaps | role/config inheritance and sliced geometry |
| Scope settings | project/plate/object/part/layer range, reset/inherit | effective config and isolated G-code effect |
| Plates | multiple, locked, excluded, sequential, custom filament order | placement/settings/current/all results |
| FullSpectrum | Ratio 2/3, Cycle patterns, Match targets, Gradient both directions/ranges | serialized fields, layer/tool order, purge, preview |
| Color paint | every tool/filter/clip, physical/virtual, remap many-to-one | exact facet states and segmentation/tool paths |
| Other paint | support, seam, fuzzy dome, brim ears | annotations and support/seam/perimeter/brim output |
| Formats | project/core 3MF, STL, STEP/STP, SVG, OBJ, AMF, ZIP, G-code | dispatch, units/names/hierarchy, safe errors |
| Preview | all roles/tools/view types/markers/times | segment metadata, filter visibility, statistics |
| Calibration | every generated mode at boundary values | band config/custom G-code, labels, saved result |
| Hostile | traversal, ZIP bomb, malformed XML/mesh/G-code/config, huge input | bounded rejection, no mutation/leak/crash |

### Browser, viewport, input, and XR matrix

- Desktop DOM: current and previous stable Chrome/Chromium, Edge, Firefox, and Safari where the
  required cross-origin isolation/WASM feature set is supportable; record every approved browser
  exclusion rather than failing silently.
- Mobile/tablet DOM: Android Chrome and Samsung Internet; iOS/iPadOS Safari; representative
  360×800, 390×844, 768×1024, portrait/landscape, software keyboard, touch and stylus where
  available.
- Desktop viewports: 1280×720, 1440×900, and 1920×1080; include 200% browser/text zoom and OS
  high contrast/reduced motion.
- Inputs: pointer, keyboard-only, screen reader, touch, pen, switch-equivalent navigation, and
  gamepad/controller where supported.
- XR: XRBlocks automation/simulator on every PR smoke path, with the limitation that it does not
  emulate WebXR APIs; Galaxy XR hardware with both controller rays, hand tracking/pinch, and gaze
  where exposed for release. Cover seated/standing, left/right dominant hand, simultaneous
  pointers, select-release-off-target, modal interception, paging/keyboard, panel manipulation,
  passthrough/high contrast/reduced motion, offline assets, recenter, and session interruption.
  Record pose, physical card/target/type dimensions, viewing/reach distance, update/input counts,
  frame/latency/memory trace, repeated-open cleanup, screenshots/video, and fatigue observations.

### Hardware evidence record

For every hardware run record: task/evidence ID; printer model/serial alias; firmware and
Moonraker/Klipper versions; nozzle/head map; printer/process/filament preset names and hashes;
material and lot; project/G-code SHA-256; engine/source hash; safety review; expected tool,
temperature, bounds, purge, and motion invariants; actual dimensions/visual result; photos/logs;
operator; date; pass/fail and follow-up. Inspect semantic G-code before every first print of a
new fixture.

## 22. Material risks and stop conditions

| Risk | Early signal / stop condition | Mitigation and owner tasks |
|---|---|---|
| Lossy 3MF rewrite invalidates the foundation | Official Orca repairs, drops, or changes hierarchy/config/paint | Stop dependent feature checkoff; P0.4, P1.3, upstream BBS format oracle |
| Mixed ID reorder sends the wrong tool | Any dangling/index-based assignment or preview/G-code mismatch | Block send; stable IDs and transactional remap in P3.1/P4.5/P9.3 |
| Edited FullSpectrum project slices original bytes | Slice input revision differs from visible project | Remove fallback; P1.5/P7.1 revision/hash gate |
| Painted failure silently becomes monochrome | Painted job returns mono success or loses virtual state | Block artifact; P4.10 and fault injection |
| WASM memory/thread limits freeze mobile/XR | Frame loss, OOM, non-cancellable job, mixed artifact versions | Workers/cancel/routing/versioning in P1.5/P7.1/P10.6/P10.8 |
| Hand-built settings diverge from engine | Unknown key/type, fake enum, ignored UI value | Generated schema and sampled engine oracle in P6 |
| FullSpectrum output is unsafe or unsupported on hardware | Unmapped head, material/temp/purge incompatibility | P3.9/P7.2/P9.3 hardware preflight; explicit blocker |
| Browser/LAN threat crosses into printer control | Token leak, unauthenticated server, arbitrary host/media/file | P9.1/P10.7 security gate; stop remote deployment |
| Monolith creates multiple sources of truth | Feature mutates Three/UI array without project command | Boundary tests P0.5; incremental P1 migration before feature completion |
| XR visual success hides unreachable workflows | Action works only in DOM or frame budget fails | Common capabilities plus P2.6/P10.5/P12.2 hardware gate |
| XRBlocks UI looks correct but is stale, double-driven, or leaks | Direct signal writes do nothing; update/input fires twice; hidden cards tick; remote icons disappear | Typed adapter and component gallery P10.9; lifecycle/input/offline/device traces P10.10 |
| Upstream changes during implementation | Latest inventory has unmapped additions/fixes | P0.1/P12.1 drift report; explicit baseline-bump decision |

## 23. Pinned source links

All `up-*` links below resolve to the audited Snapmaker commit, not a moving branch. The
XRBlocks manual links are moving user documentation; their implementation-guide, sample, and
testing links are pinned to the qualified `v0.17.0` tag and must be advanced deliberately with
P10.9.

[xrblocks-ui]: https://xrblocks.github.io/docs/manual/UI/
[xrblocks-uiblocks]: https://xrblocks.github.io/docs/manual/UIBlocks/
[xrblocks-inputs]: https://xrblocks.github.io/docs/manual/Inputs/
[xrblocks-simulator]: https://xrblocks.github.io/docs/manual/Simulator/
[xrblocks-uiblocks-guide]: https://github.com/google/xrblocks/blob/v0.17.0/src/addons/uiblocks/SKILL.md
[xrblocks-uiblocks-samples]: https://github.com/google/xrblocks/tree/v0.17.0/src/addons/uiblocks/samples/basic
[xrblocks-testing-guide]: https://github.com/google/xrblocks/blob/v0.17.0/skills/xb-testing/SKILL.md

[up-root]: https://github.com/Snapmaker/OrcaSlicer/tree/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626
[up-gui-app]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GUI_App.cpp
[up-main-frame]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/MainFrame.cpp
[up-plater]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Plater.cpp
[up-plater-h]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Plater.hpp
[up-print-config]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/PrintConfig.cpp
[up-gizmos]: https://github.com/Snapmaker/OrcaSlicer/tree/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos
[up-gizmos-manager]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmosManager.cpp
[up-model]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/Model.hpp
[up-bbs-3mf]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/Format/bbs_3mf.cpp
[up-project]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Project.cpp
[up-dirty]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/ProjectDirtyStateManager.cpp
[up-triangle-selector]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/TriangleSelector.hpp
[up-object-list]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GUI_ObjectList.cpp
[up-object-list-h]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GUI_ObjectList.hpp
[up-object-model]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/ObjectDataViewModel.cpp
[up-mixed-dialog]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/MixedFilamentDialog.cpp
[up-mixed-filament]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/MixedFilament.hpp
[up-mixed-filament-cpp]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/MixedFilament.cpp
[up-match-panel]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/MixedColorMatchPanel.cpp
[up-gradient]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/MixedGradientSelector.cpp
[up-print-apply]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/PrintApply.cpp
[up-print-slice]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/PrintObjectSlice.cpp
[up-tool-ordering]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/GCode/ToolOrdering.cpp
[up-gcode]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/GCode.cpp
[up-wipe-tower]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/GCode/WipeTower2.cpp
[up-color-paint]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoMmuSegmentation.cpp
[up-color-paint-h]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoMmuSegmentation.hpp
[up-painter]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.hpp
[up-segmentation]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/MultiMaterialSegmentation.cpp
[up-support-paint]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoFdmSupports.cpp
[up-seam-paint]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoSeam.cpp
[up-fuzzy-paint]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoFuzzySkin.cpp
[up-brim]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Gizmos/GLGizmoBrimEars.cpp
[up-factories]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GUI_Factories.cpp
[up-plates]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/PartPlate.hpp
[up-plates-cpp]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/PartPlate.cpp
[up-plate-settings]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/PlateSettingsDialog.cpp
[up-canvas]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GLCanvas3D.cpp
[up-adaptive-slicing]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/SlicingAdaptive.cpp
[up-preset]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/Preset.hpp
[up-preset-bundle]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/PresetBundle.hpp
[up-tab]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Tab.cpp
[up-search]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Search.cpp
[up-profile-guide]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/doc/developer-reference/How-to-create-profiles.md
[up-preset-guide]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/doc/developer-reference/Preset-and-bundle.md
[up-slicing-guide]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/doc/developer-reference/slicing-hierarchy.md
[up-processor]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/GCode/GCodeProcessor.hpp
[up-preview]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GUI_Preview.hpp
[up-viewer]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GCodeViewer.hpp
[up-viewer-cpp]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/GCodeViewer.cpp
[up-slider]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/IMSlider.cpp
[up-calib]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/libslic3r/calib.hpp
[up-calib-dialogs]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/calib_dlg.hpp
[up-calib-panel]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/CalibrationPanel.hpp
[up-calib-wizard]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/CalibrationWizard.hpp
[up-calib-docs]: https://github.com/Snapmaker/OrcaSlicer/tree/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/doc/calibration
[up-device-manager]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/DeviceManager.hpp
[up-select-machine]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/SelectMachine.hpp
[up-send-printer]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/SendToPrinter.hpp
[up-status-panel]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/StatusPanel.hpp
[up-monitor]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Monitor.cpp
[up-send-job]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Jobs/SendJob.hpp
[up-print-job]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Jobs/PrintJob.hpp
[up-shortcuts]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/KBShortcutsDialog.cpp
[up-preferences]: https://github.com/Snapmaker/OrcaSlicer/blob/9fd12ffb2b1b80c9fb4c14564754d2ec1573a626/src/slic3r/GUI/Preferences.cpp
