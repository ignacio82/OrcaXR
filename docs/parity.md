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
| Printer | Legacy Moonraker and generic clients existed at baseline; end-to-end parity and hardware coverage were not established. | Current replacement seams: typed [`printer` boundary](../web/src/printer/index.ts), [`main.ts`](../web/src/main.ts) |
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

### Implemented foundation tranche (updated 2026-07-30)

The historical table above remains the reproducible starting observation. The current worktree
adds the following dependency-safe foundation; checkbox state and residual qualification gaps in
P0/P1/P6/P10/P11 remain authoritative:

- A deterministic exact-blob extractor maps 1,622 upstream leaves in 13 families from 17 pinned
  source blobs. Duplicate, missing, stale, and synthetic action/setting mutations fail closed.
- One composition-root capability registry is injected into the workspace and every catalogue
  surface. Fifty status-only or cutover-unsafe capabilities are explicitly unavailable;
  the other 76 actions are conservatively partial until their workflow gates pass. DOM, menus, shortcuts,
  command palette, and XR invoke the same availability guard.
- `web/src/project/` supplies a UI-independent canonical graph, immutable assets, stable IDs,
  inheritance/validation, selection, bounded transactional history, revision guards, staged
  import, legacy-v1 migration, canonical slice coordination, ports, and a deterministic
  BBS-compatible 3MF adapter. The live workspace now derives project/plate/model/selection/
  transform/history/save/open/slice state from one canonical controller and a one-way Three projection.
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
  - **Current:** one registry instance and invocation guard is constructed at the composition root
    and injected into every catalogued surface. Empty-state/native-XR load, targeted plate add/
    delete, and tool-close aliases resolve through that same instance; bounded invocation data
    preserves exact plate, Objects-tree, semantic-edit, settings, and virtual-filament targeting. All 154 actions have exactly one real parity-task owner and
    containing-phase anchor; metadata-only IDs explicitly provide no behavioral evidence. Current
    status is 112 partial, 42 unavailable, and zero implemented. Remaining direct contextual controls,
    upstream leaf-to-local reachability, and full browser interaction coverage remain open under
    P11.2/P12.

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
    a public bounds-checked indexed-mesh codec, resolvers, validation, stable branded IDs, and
    deterministic generated-graph tests (`EVID-003`). Live application adoption is separately
    tracked by P1.6.

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
    checkpoints, independent dirty categories, revision guards, and history subscriptions that
    refresh every attached surface even when a helper executes directly on the bus. Atomic
    commands now cover exact plate deletion and immutable asset-plus-object insertion with
    selection and byte-exact undo/redo. Promise-returning transactions are rejected and their
    synchronous mutations roll back, so asynchronous preparation cannot escape an atomic command
    boundary. Live transforms, plate operations, selection delete/duplicate, profile/config edits,
    imported-project replacement, and undo/redo now execute through the canonical controller;
    projection-only topology/paint paths are unavailable. The full paint/settings/assignment/tree
    command catalogue remains open.

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
    and rejects traversal, corruption, bombs, and cancellation. Foreign multi-plate import now
    resolves exact model-instance membership plus authoritative `printable_area`, subtracts the
    pinned virtual-bed origin into plate-local transforms, and restores that origin only in the
    standard export; empty plates retain their grid position and ambiguous metadata fails with a
    typed error. Production-extension split model parts now resolve root `p:path` references by
    qualified package path plus model-local object ID, recursively flatten same-part child graphs
    with composed transforms and repeated references, scope BBS part metadata to its parent, and
    preserve the original split members and relationships opaquely; canonical save emits a local
    flattened core without stale `p:path`. Missing/conflicting members or IDs, unsafe paths,
    malformed XML, cycles, depth over 64, and expansion over 16,384 nodes fail closed. The
    read-only MarbleRunTube headless import/save/reopen smoke in `EVID-014` passed. Preserved OPC
    relationships are now emitted only when their target is present in the same package, so a
    projection that drops opaque members cannot produce an archive the engine refuses to load.
    Project settings are now written the way the engine reads them: every value is a JSON string
    or array of strings, and every per-filament option named by the pinned
    `Preset::filament_options()` list carries one entry per physical filament. Both were
    load-bearing rather than cosmetic — `ConfigBase::load_from_json` drops any option whose array
    holds a number, and the engine derives its filament count from `filament_diameter.size()`, so
    a scalar there clamped every per-object extruder assignment back to tool 1 and silently
    printed a multicolor plate in one colour. Some BBS
    projections still use the OrcaXR envelope, general affine shear still projects through the
    existing canonical TRS decomposition, and official Snapmaker GUI open/save interoperability
    remains unverified.

- [~] **P1.4 — Make import transactional and diagnosable.** Parse/validate in a worker, preview
  conflicts and unit corrections, then commit once. Cancellation or failure leaves the project
  unchanged. Detect duplicate assets and preserve source filename/provenance.
  - **Accept:** malformed and cancelled imports do not mutate history; very large archives keep
    UI/XR frames responsive; warnings identify each repaired/dropped unsupported field.
  - **Current:** the coordinator passes cloned state/assets to a browser BBS worker, validates and
    deduplicates its staged result, preserves import provenance, exposes immutable repair/conflict/
    drop diagnostics and acknowledgement, rejects cancellation/stale previews, and commits project/
    assets/selection as one undoable command. The live Open Project route presents every repair,
    conflict, dropped field, and diagnostic in an accessible modal; blocked previews are reviewable
    but cannot commit, and each required notice must be checked before the exact acknowledged IDs
    are submitted. Preview lifecycle tokens are released exactly once on confirm/cancel. Mesh
    sources (STL/OBJ/AMF/ZIP) now share the same coordinator through a merge-mode model parser, so
    adding a model is also a previewed, cancellable, single-command transaction; a clean source
    commits without prompting while any repair, conflict, or dropped field requires the explicit
    modal acknowledgement. Interactive alternative selection for resolvable conflicts, worker
    routing for mesh decode, large-archive responsiveness traces, and complete corpus qualification
    remain.

- [~] **P1.5 — Slice only canonical project state.** Build an in-memory or temporary compatible
  3MF for every edited project and use `startSliceProject`/external project slicing. Eliminate
  the edited-geometry metadata-loss fallback.
  - Version the worker protocol and transfer project/slice snapshots immutably. A slice result
    records project revision, profile hashes, engine commit, and warnings.
  - **Accept:** changing a part filament, paint facet, layer override, mixed recipe, instance,
    or plate is reflected in G-code and preview; stale slice completion never replaces a newer
    result.
  - **Current:** the coordinator captures one immutable canonical source and serializes a distinct
    one-plate BBS 3MF inside each requested plate job; each result records its own input hash plus
    project/profile/engine/output hashes. Actual asset bytes join the revision guard, so asset-only
    drift and stale/superseded publication fail closed. Current/all plates, retry, recovery, timeout,
    and cancellation are covered headlessly. The live workspace now slices the active canonical
    plate through that coordinator and the verified browser-WASM route, publishes only a revision/
    project-hash/asset-hash guarded artifact, and revalidates preview/download reads after undo/redo.
    Scene-baked STL and immutable imported-byte fallbacks were deleted. External canonical slicing
    is no longer fail-closed by construction: the server proves which engine it runs on `/engine`
    and the client compares that to what this build accepts, per engine kind. A WASM server must
    match the exact artifacts the client verified for itself. A CLI server runs the official
    Snapmaker Orca binary, which has no WASM artifacts to compare, so it proves the upstream commit
    it was built from and the OrcaXR patches applied on top — the entire difference from stock
    upstream — each by name and digest. Requiring WASM digests of a native binary is what
    previously made the CLI route refuse itself, which is the one route that exists to match
    desktop output. `npm --prefix web run security:check` fails when `server/patches/` drifts from
    the pinned set, so an engine this build has never seen cannot receive canonical work. Official
    G-code oracles, all-plate UI, and hardware acceptance remain open.
    Making that route usable also required `server/patches/0004`: any project whose plates carry
    names — which OrcaXR's own projects do — segfaulted the CLI in
    `PartPlateList::load_from_3mf_structure -> set_plate_name -> generate_plate_name_texture`,
    which builds a GL texture through the GUI application that a headless CLI does not have. A
    project with unnamed plates never reaches that path, which is why it went unnoticed. The plate
    name is already stored and forwarded to the print, so skipping only the texture leaves CLI
    output identical to the GUI's.

- **Large painted projects.** A real 1.9M-triangle painted project the pinned engine opens was
  refused by five separate flat limits, each of which conflated model size with attack surface: a
  refinement carries one root per source triangle, so a fixed node cap is really a cap on how many
  triangles a painted mesh may have. The aggregate budgets now scale with the geometry the archive
  actually spells out (`refinementNodeBudget`), the save-side JSON allowance tracks the project's
  own triangle totals, the canonical envelope is bounded by its own text length — every JSON node
  costs at least a character, and ZIP guards already bound those — and the fingerprint streams its
  UTF-8 instead of materializing 144 MB as a JS array. Expansion far beyond the geometry is still
  refused, which is what those budgets are for. Per-facet tree depth and size caps are unchanged.

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
    a recovery payload. The live workspace's plates, models, selection, transforms, save, open,
    slice, profile configuration, and history now derive from one `CanonicalWorkspaceController`;
    its Three surface is a one-way stable-ID projection with explicit printer-to-world mapping and
    fail-closed health. Dormant raw-project checkpoints, scene-based project read/write, and scene-
    baked slicing were deleted. Recovery persistence/UI and indexed/facet-rich legacy migration
    coverage remain open.

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
  - **Current:** a canonical projection emits every listed row type
    with stable keys/IDs, assignment/paint/printable/editability indicators, ancestor-preserving
    filtering, retained expansion, entity replace/toggle/range selection, keyboard focus
    navigation, tree accessibility metadata, and an O(1) fixed-row virtual window. The live DOM
    sidebar renders that tree with search, roving keyboard focus, modifier multi-selection,
    touch-sized controls, explicit touch/pen long-press plus pointer/keyboard context menus, inline
    rename/reveal, canonical scene selection, owning-plate activation, framing, and undo/redo;
    registry architecture guards and the production smoke cover the live boundary. A deterministic
    10,000-row DOM test enforces a bounded virtual window and a two-second first-render ceiling.
    XR rendering, every-row pointer/keyboard/touch Playwright coverage, richer context actions, and
    10,000-row browser/device profiling remain open.

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
  - **Current:** canonical commands cover object/volume/instance rename, printable state, subtree-aware
    delete, independent duplicate with collision-checked injected IDs, shared instance
    create/delete, precomputed multi-instance placement as one transaction, cross-plate move,
    no-op suppression, selection repair, and byte-exact undo/redo without deleting shared assets.
    Live DOM object/part rename is registry-routed and browser-tested. Add Instance and Fill Bed
    with Instances are live registry actions: the first shares the selected object's parts and
    paint, the second plans deterministic copies into the plate's remaining free space without
    moving anything already placed, reports the slots a copy cap withheld, and commits as one
    undoable transaction; a production browser pass covers both with undo. Remaining lifecycle
    UI/action wiring (move to plate, merge, reload), topology operations, asset GC, 3MF/oracle, and
    official Orca qualification remain open.

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
    scopes atomically, and provide byte-reversible undo/redo; the Objects tree projects
    inherited/effective badges. A live accessible DOM selector displays stable IDs, physical and
    mixed metadata/recipes/warnings, inherited/effective state, explicit inherit, and guarded batch
    apply through the action registry; the production smoke covers assignment plus undo/redo.
    Richer printer compatibility, live scene/material propagation, wipe/preview updates, official
    3MF round-trip, and G-code behavior oracles remain open.

- [~] **P2.4 — Add semantic volumes.** Support ordinary part, parameter modifier, negative
  volume, support enforcer, support blocker, and other upstream volume roles. Provide “Add
  part/modifier” from file and primitives; expose role conversion only when valid.
  - Resolve volume overlap/order and setting scope like the engine. Indicate non-manifold,
    outside-bed, below-bed, and non-printable states without hiding the row.
  - **Accept:** each role changes slice results as expected and survives 3MF round-trip.
  - **Current:** a canonical conversion command and preflight inspection support all five modeled
    roles, preserve pinned upstream role ordering, reject conversion of the final model volume,
    and reject changes that would silently discard role-incompatible filament or facet paint.
    Exact no-op/undo/redo and standard BBS metadata round-trip are tested. A live accessible DOM
    editor projects exact conversion decisions and sends revision/hash/object-guarded role changes
    through the shared action registry. Add-from-source UI, geometry status, slice-result oracles,
    official round-trip, and XR wiring remain open.

- [~] **P2.5 — Add per-object/part settings and height ranges.** Rows can attach a curated
  settings subset, remove overrides, compare effective values, copy/paste settings, and add,
  edit, split, merge, or delete non-overlapping layer-height ranges.
  - Use the generated P6 schema and engine dependency rules, not duplicated control metadata.
  - **Accept:** overrides affect only the intended object/part/Z range; conflicts and gaps are
    explained; serialization and undo pass.
  - **Current:** guarded canonical commands add, edit, split, merge, and delete sorted,
    non-overlapping ranges with stable IDs, exact no-op/undo/redo, deterministic selection repair,
    and strict compatible-config/filament merge rules; BBS standard metadata round-trip is tested.
    The live DOM editor adds/edits/splits/merges/deletes ranges through one guarded action path,
    exposes exact merge-block reasons, and never updates optimistically. Generated-schema setting
    attach/remove/compare/copy-paste, printer-dependent minimum spans, conflict-choice UX,
    engine-effect oracles, and XR wiring remain open.

- [~] **P2.6 — Deliver Objects outcomes in responsive and XR UI.** Narrow screens use a
  persistent/dismissible sheet with retained selection. XR uses a scalable world-space tree or
  details panel, ray/direct selection, scrolling, and controller-accessible context actions.
  - **Accept:** the same part assignment, instance management, and override flows complete on
    desktop, 390×844 touch viewport, and the reference Galaxy XR session without returning to
    another device.
  - **Current:** the canonical DOM tree lives inside the existing responsive inspector/bottom-sheet,
    retains selection/expansion across projection updates, virtualizes rows, and exposes touch-sized
    controls plus a long-press context menu that suppresses the synthetic selection click. Stable-ID
    object/part/range filament assignment is also available in the responsive DOM inspector.
    Complete touch workflow coverage, instance/settings outcomes, and the world-space XR
    tree/details surface remain open.

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
[`colorMatchSearch.ts`](../web/src/project/filaments/colorMatchSearch.ts),
[`VirtualFilamentLibrary.ts`](../web/src/ui/dom/VirtualFilamentLibrary.ts), and
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
    enable lifecycle without palette indexes. The BBS/config adapter derives the transient engine
    namespace from physical rows followed by enabled mixed rows without changing stored intent,
    and the live library/assignment surfaces retain stable IDs across save/reopen. A tool slot the
    selection never named now inherits the chosen filament instead of the catalog's first
    compatible preset, matching how Orca fills a new extruder: the previous behaviour handed a
    four-tool printer one PLA and three ABS slots, so the first two-colour slice failed on the
    engine's filament-temperature check. Loaded/device
    mapping, physical reorder/replace dependency UX, official field/oracle comparison, and hardware
    qualification remain open.

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
    authoring is restricted to enabled physical components as required by the pinned engine. A
    live accessible DOM editor now authors all four modes, supports add/edit/duplicate/enable/
    delete, preserves the complete implemented wire fields, previews outcomes, and round-trips
    through canonical save/open. Auto-generated physical pairs are opt-in (off by default), require
    count-bound confirmation above four physical rows, preserve edited custom rows and deletion
    tombstones, and reconcile deterministically as physical rows change. Merge/apply, XR-native
    authoring, broader compatibility policy, and official field-by-field qualification remain open.

- [~] **P3.3 — Implement Ratio mode faithfully.** Offer two- and three-filament selection,
  two-color ratio slider/numeric input, the three-color triangle picker used by the reference,
  ratio normalization, live predicted color, badges, and mix-effect preview.
  - Reuse tested `FilamentMixer`/gamut math where equivalent; version coefficients/calibration
    rather than baking unexplained constants into UI code.
  - **Accept:** boundary ratios, component swap, three-way normalization, predicted color, and
    emitted definition match reference fixtures within documented numeric/color tolerances.
  - **Current:** the live dialog supports two-component slider/numeric authoring and a keyboard/
    pointer SVG barycentric triangle for three components. Raw out-of-triangle coordinates use
    the shared pinned four-pass clamp/renormalize routine; predicted two-color pigment and
    three-color sRGB previews update without mutating the project before submit. Official color/
    emitted-definition tolerances, richer mix-effect rendering, touch/XR qualification, and
    component add/remove/swap polish remain open.

- [~] **P3.4 — Implement Cycle mode faithfully.** Support reference code/pattern entry,
  component badges, parsing/validation, manual pattern editing, cycle preview, and mix-effect
  preview. Preserve the exact sequence rather than reducing it to an average color.
  - Accept legacy single-digit tokens and the modern slash-separated form for multi-digit
    physical IDs; commas separate per-perimeter groups. Provide quick-filament insertion and
    normalize with the engine's `MixedFilamentManager::normalize_manual_pattern`, while retaining
    a clear validation location for malformed/unknown tokens.
  - **Accept:** valid and invalid code corpus matches upstream acceptance; layer/tool ordering and
    G-code repeat pattern match the reference semantic oracle.
  - **Current:** a source-located headless parser matches the pinned native bracket notation and
    acceptance/rejection corpus, accepts slash authoring for multi-digit IDs, normalizes
    deterministically back to engine syntax, preserves exact perimeter groups and flattened
    sequences, validates available IDs with typed locations, and provides quick-token encode/append
    helpers. Exhaustive 1–99 ID and 9,801 pair tests pass. The live dialog now provides pattern
    entry, quick insertion, component badges, validation/preview, and canonical persistence.
    Layer/tool-order G-code oracles plus touch/XR qualification remain open.

- [~] **P3.5 — Implement Match mode faithfully.** Provide component selection, target color via
  swatch/hex/color picker, minimum mix ratio and other upstream constraints, ranked recipe
  candidates, out-of-gamut feedback, and explicit selection of the applied match.
  - Show predicted versus target color and a meaningful distance/confidence value. Preserve the
    chosen recipe; do not recompute it unexpectedly on reopen.
  - **Accept:** official sample targets and boundary colors choose equivalent recipes within a
    recorded tolerance; inaccessible color alone is never the only status cue.
  - **Current:** a bounded browser worker searches pinned two/three-component pigment candidates
    from target hex, minimum ratio, component set, and offsets; it returns ranked predicted colors
    and ΔE values for explicit user selection. Request identity, timeout, cancellation, worker
    crash/error, dialog close, canonical revision drift, and latest-wins target changes are covered;
    the chosen stable recipe persists and reopens. Official sample/tolerance comparison,
    out-of-gamut copy/visualization, and touch/XR qualification remain open.

- [~] **P3.6 — Implement Gradient mode faithfully.** Select two physical components, direction
  A→B/B→A, the upstream 80%→20% or 20%→80% component-A endpoints, and the vertical gradient
  preview. Persist exact `gradient_start`/`gradient_end` values and validate the effective
  model/Z domain. User-editable endpoints, if added, are a separately tested enhancement.
  - Assigning the gradient to an object or part must retain its recipe identity through
    transforms, plate moves, reload, 3MF, paint remap, and slicing.
  - **Accept:** start/end and reverse-direction fixtures produce reference-equivalent layer-wise
    mixing/tool behavior; UI preview and G-code preview agree.
  - **Current:** the live editor supports two stable physical components, A→B/B→A direction,
    pinned 80→20/20→80 endpoints, vertical preview, exact stored start/end fields, assignment,
    transform-safe identity, and canonical save/reopen. Reference layer-wise G-code comparison,
    effective model-Z validation, paint remap, and XR qualification remain open.

- [~] **P3.7 — Expose FullSpectrum advanced process controls with exact engine semantics.** Cover
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
  - **Current:** generated settings metadata and the live settings surface expose the implemented
    FullSpectrum keys with engine labels/types/bounds and dependency semantics, including local-Z,
    dithering, offsets, collapse, painted-zone, and wipe-tower controls. Schema-to-native GUI
    completeness, every dependency/value mutation, and representative geometry/G-code oracles
    remain open.

- [~] **P3.8 — Integrate recipes everywhere.** Show compact mixed badges and human-readable
  ratios/pattern/gradient in the filament panel, Objects tree, assignment menus, painting palette,
  legends, warnings, project summary, and preview. Editing/deleting a recipe previews all
  affected entities and remaps atomically.
  - The physical-filament panel and virtual library remain visually distinct. “Add Virtual” may
    never create a plain physical slot.
  - **Accept:** a recipe can be created, assigned to one part, used to paint another region,
    edited, remapped, saved, sliced, previewed, sent, and reopened without identity loss.
  - **Current:** physical slots and the virtual library are distinct live surfaces; mixed badges,
    names, mode/recipe summaries, warnings, and stable IDs appear in the library and Objects
    assignment selector. Create/edit/duplicate/disable/delete, assignment, save/reopen, and
    generated slicing configuration retain recipe identity. Painting palette, complete legends/
    warnings/project summary, atomic dependency remap UX, verified slice/preview/send, and XR
    surfaces remain open.

- [~] **P3.9 — Validate engine and hardware behavior.** Extend browser and external slicer
  protocols only as needed to carry canonical project/config data; keep both on the same pinned
  fork. Add preflight for incompatible heads/materials, missing components, gradient bounds,
  wipe-tower feasibility, and unsupported printer capability.
  - Run reference jobs for Ratio/Cycle/Match/Gradient on Snapmaker U1. On Elegoo Centauri Carbon,
    explicitly prove supported outcome or record an adaptation/blocker based on actual hardware
    capability; never imply FullSpectrum hardware support from UI availability.
  - **Accept:** semantic G-code comparison passes, preview matches tool/mix changes, U1 prints the
    qualification specimens, and safety review signs off temperatures/tool mapping/purge.
  - **Current:** the preflight half is implemented and covered (`EVID-033`). Canonical preflight
    now refuses, against the pinned engine's own rules, a mixed row on a target declaring fewer
    than two physical tools (`mixed-filament-unsupported-printer`), a physical assignment past the
    declared tool count that `region_config_from_model_volume` would silently collapse to tool 1
    (`filament-tool-out-of-range`), a recipe whose components violate the pinned material matrix
    (`incompatible-mixed-components`), a project above `MAXIMUM_FILAMENT_NUMBER`
    (`filament-count-exceeds-engine-limit`), the narrow gradient repairs canonical validation
    admits — endpoints inside `(0, 1)` but outside the manager's `[0.01, 0.99]` clamp, and
    duplicate or beyond-tool-count entries `decode_gradient_component_ids` drops
    (`gradient-recipe-out-of-bounds`) — and the `Print::validate()` prime-tower preconditions
    (`wipe-tower-requires-relative-e`, `wipe-tower-ooze-prevention-conflict`, plus the upstream
    mixed-diameter warning). Capability is declared only by the resolved target's tool count, so
    an undeclared capability stays unevaluated rather than assumed. Both engines already share the
    pinned fork and carry canonical project/config data, so no protocol extension was required.
  - **Outstanding:** every hardware bullet. Ratio/Cycle/Match/Gradient reference prints on the U1,
    the Elegoo Centauri Carbon supported-outcome-or-blocker determination, semantic G-code
    comparison against official Orca, and the temperature/tool-mapping/purge safety sign-off all
    need physical printers and remain unproven. This item cannot reach `[x]` from software alone.

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
    brim channels tied to topology revision, plus an optional versioned source-face/child-path
    refinement tree for every channel. Headless normalization/validation rejects stale topology,
    invalid values, duplicate/out-of-range faces, shared/cyclic/noncanonical trees, inconsistent
    sparse roots, and bounded-depth/node violations. Exact uppercase BBS subdivision streams now
    import/export color, support, seam, and fuzzy-skin leaves, while the derived live overlay
    materializes those same leaves after reopen for every rendered instance. Brim geometry/anchors,
    mesh face-map workflows, official fixtures, and official-Orca round-trip equivalence remain
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
    behavior, defensive snapshots, and project/topology stale-result rejection. A UI-independent
    `PaintStrokeService` now resolves a canonical volume, decodes its immutable mesh once per
    asset digest, runs the pinned selector, and commits; the live DOM surface streams pointer
    samples into an accumulated selection with a derived preview overlay and commits exactly one
    labelled command on release, while Escape and pointer cancellation discard the gesture without
    touching canonical state. Orbit control is suspended for the duration of a stroke. Ray/brush/fill
    selection geometry, clipping, adjacency, source-located filter semantics, deterministic
    refined-leaf state application, and recursive homogeneous-child collapse now exist in the
    shared headless selector/commit contract. Streamed adaptive samples accumulate one exact
    post-sample tree under the first sample's project/topology/volume guard; Gap Fill retains each
    component's snapshot-derived target rather than repainting the union with the active swatch.
    Reopen-safe refined previews and canonical overlays are derived per rendered instance. Stylus
    pressure, touch/XR input, haptics, worker routing, deterministic live-surface traces, and
    performance qualification remain open.

- [~] **P4.3 — Implement all six color-paint tools.** Provide Circle, Sphere, Triangle, Height
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
  - **Current:** all six tools are selectable in the live paint panel with their exposed
    parameters (brush radius, smart-fill angle, band height, gap-area threshold), paint/erase
    modes, and Erase All on the selection; a source-pinned headless selector implements Circle,
    Sphere, Triangle, Height Range, connected/smart Fill, and snapshot-based Gap Fill over
    canonical indexed geometry.
    Circle/Sphere reproduce swept point/ray/edge capsule predicates; selection honors world-space
    transforms, clipping, strict threshold boundaries, edge adjacency, upstream per-tool angle
    filtering, and inverse-transpose overhang normals. Opt-in adaptive refinement reproduces the
    pinned one/two/three-side recursive topology, float32 shared midpoint reuse, stable
    source-face/child-path leaf IDs, and direct/propagated split adjacency for Fill and Gap Fill.
    Refined commits apply disjoint targets and recursively collapse homogeneous children; malformed,
    cyclic, ambiguous, too-deep, or oversized trees fail closed. Focused traces cover geometry,
    refinement, per-component Gap Fill, state application, streamed commit guards, degenerate
    inputs, and validation, and the production browser smoke paints through the real panel and
    canvas. Refined state now persists canonically and through the exact standard BBS projection;
    live cursor/wireframe/section-clipping controls, vertical/horizontal filters, touch/XR input,
    and official golden traces remain open.

- [~] **P4.4 — Use the full physical-plus-virtual paint palette.** Palette entries show stable
  assignment ID, keyboard number, physical color or virtual recipe/gradient badge, name, and
  unavailable/compatibility state. The default/unpainted state inherits object/part assignment.
  - Painting with a mixed filament writes the virtual assignment state understood by the pinned
    engine; never flatten it to a predicted RGB or physical palette index.
  - **Accept:** physical and each FullSpectrum mode can be painted on separate facets, survives
    save/open, and produces expected segmentation/tool behavior.
  - **Current:** one canonical palette projection feeds the DOM panel, the XR swatch row, and the
    stroke service. Rows carry the stable physical or mixed ID, tool/mode badge, name, recipe
    summary, gradient stops, the derived transient engine slot, and an explicit `1`–`9` number that
    nine registry actions dispatch; the first row is the default/inherit state that erases back to
    the object or part assignment. Disabled recipes and recipes whose components no longer exist are
    listed with machine-readable unavailable reasons and cannot be selected or painted. A stroke
    stores the stable filament ID — physical or mixed — and never a slot index or predicted RGB, and
    a painted recipe reopens with the same identity after canonical save. Standard-BBS export maps
    stable IDs to the transient material slots the file declares, including exact refined leaves,
    but emits color states only for the pinned consumer's safe slots `1..64`; an unavailable or
    higher slot stays lossless in the canonical envelope, and a partially unrepresentable refined
    source root is omitted from the standard projection with an explicit warning. Official-Orca
    colour round-trip, per-mode fixtures on separate facets, compatibility policy, and
    segmentation/tool oracles remain open.

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
    object/part/layer assignments, sparse and refined color facets, wipe-tower assignment, and
    physical recipe components, coalesces collided facet/component data, recursively collapses
    homogeneous remapped leaves, preserves source definitions, rejects self/disabled destinations
    and virtual destinations for physical-only recipe components, and round-trips through history.
    Reference discovery/preview UX,
    default-state and deletion/reorder hooks, cancellation flow, tombstone retention policy,
    live legends/surfaces, save/reopen, and G-code comparison remain open.

- [~] **P4.6 — Implement support painting.** Support enforcer, blocker, and reset/erase states;
  brush/smart-fill behavior; clipping and visibility; clear all; rendering; 3MF annotation; and
  generated-support results must match upstream intent.
  - **Accept:** [support-paint guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_support_painting)
    scenarios show support only where expected, round-trip through official Orca, and undo.
  - **Current:** the canonical support channel supports enforce and block states, sparse triangle
    ranges, stroke commands, selection geometry, adaptive splitting, homogeneous child collapse, and
    BBS 3MF annotation export/import. Support painting is live: the shared paint tool authors the
    support channel through the same pointer gesture, tool set, and one-command history, with
    enforce/block/erase states shown as labelled coloured options and a channel-specific overlay,
    and a browser smoke paints and undoes a support stroke. Generated-support result comparison,
    live 3D cursor/clipping controls, official round-trip, and XR input remain open.

- [~] **P4.7 — Implement seam painting.** Enforce, block, and reset states; shared brush/fill
  controls; clear all; visualization; 3MF persistence; and seam placement integration.
  - **Accept:** [seam-paint guide](https://www.orcaslicer.com/wiki/print_prepare/prepare_seam_painting)
    fixtures compare seam positions in parsed G-code and preserve annotations in 3MF.
  - **Current:** the canonical seam channel supports prefer and avoid states, sparse triangle
    ranges, stroke commands, selection geometry, adaptive splitting, homogeneous child collapse, and
    BBS 3MF annotation export/import. Seam painting is live through the shared paint tool, channel
    tabs, and prefer/avoid/erase states with one undoable command per stroke. Seam-position G-code
    comparison, live cursor controls, official round-trip, and XR input remain open.

- [~] **P4.8 — Implement fuzzy-skin painting and brim ears.** Fuzzy painting includes the pinned
  v2.3.4 fixes and independently marks surface regions. Brim ears support placement, diameter,
  deletion, and slice integration as the upstream gizmo does.
  - **Accept:** reference models compare affected perimeters/brim geometry, 3MF state, and
    undo/redo. Dome-shaped fuzzy fixtures specifically guard the v2.3.4 regression.
  - **Current:** canonical fuzzySkin and brim channels support sparse boolean triangle ranges,
    stroke commands, selection geometry, adaptive splitting, homogeneous child collapse, and the
    lossless OrcaXR envelope. Fuzzy-skin leaves additionally import/export through the standard
    `paint_fuzzy_skin` attribute (and the pinned legacy `paint_fuzzy` reader alias); BBS defines no
    facet-paint attribute for brim, so authored brim state remains extension-only with an explicit
    warning until the actual brim-ear geometry/anchor model lands. Fuzzy-skin painting is live
    through the shared paint tool and channel tabs with one undoable command per stroke.
    Perimeter/brim geometry comparison, the dome-shaped v2.3.4 regression fixture, brim-ear gizmo
    controls, and XR input remain open.

- [~] **P4.9 — Integrate AI/semantic painting as an enhancement over the same state.** Repair
  current typing and placeholder color-distance logic; require a preview mask, chosen channel
  and destination, confidence/coverage, explicit apply, cancellation, and local undo command.
  - Do not send geometry or keys without informed consent. Keep manual tools fully functional
    offline; AI failure cannot change or degrade slice output.
  - Projection must end in canonical facet states, not vertex colors, so remap/3MF/slicing are
    identical to manual painting.
  - **Accept:** deterministic mocked-service tests, privacy/error tests, and manual correction of
    the generated mask all pass. AI remains outside core parity completion.
  - **Current:** Smart Paint is canonical and DOM-complete (`EVID-034`). `project/painting/
    aiPaintProposal.ts` strictly parses a bounded version-1 proposal — at most 32 regions, each a
    normalized-AABB box or a normal-direction cone with a stated label and `[0, 1]` confidence —
    and projects it against the volume's own mesh into exact source-triangle sets, with later
    regions overwriting earlier ones the way successive manual strokes layer. Free-form polygons
    are refused rather than projected against a camera the proposal never declared, and provider
    IDs are ignored in favour of positional ones. `AiPaintSession` owns the lifecycle: consent is
    per payload kind and per provider and is checked *before* anything leaves the device; a
    request only ever sends the prompt, the optional consented image, and — when geometry consent
    is given — a facet count plus bounding-box extent, never vertices, names, or IDs. The preview
    reports per-region and total coverage plus coverage-weighted confidence, the operator assigns
    or clears each region's destination and can exclude facets from a mask, and apply commits one
    labelled transaction through the same `PaintStrokeService` a manual stroke uses, so undo
    restores the byte-identical project. Cancel, provider failure, malformed output, an unknown
    volume, a rejected destination, and a revision/topology change between preview and apply all
    leave canonical state untouched. The same mask authors any facet channel, not just colour.
    `GeminiAiPaintPort` is a thin typed adapter that parses nothing and redacts session
    credentials from every error; the previous untyped `any` service and its placeholder colour
    distance are gone. `tool_smart_paint`, `tool_smart_paint_image`, and the four
    `paint_smart_*` panel actions are real registry handlers.
  - **Outstanding:** XR. All six actions declare an exact `xrUnsupportedReason` and are withheld
    from every XR surface (the XR toolbar is 17 actions, down from 19), because consent, the text
    prompt, and the per-region destination list are DOM-only; an in-headset consent and region
    flow has to exist before P4.9 can reach `[x]`. Also outstanding: an end-to-end pass against a
    real provider response, and the legacy pairwise gamut prototype's replacement —
    `recreate_model_colors_fullspectrum` remains an unavailable registry outcome because
    match-driven recolouring still has no pinned matching math or canonical route.

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

- [~] **P5.1 — Complete selection and transform behavior.** Multi-select, box select, select all,
  move, rotate, scale, mirror, reset, world/local coordinates, numeric entry, uniform scaling,
  drop to bed, center, lay on face, auto-orient, and camera framing must operate at selected
  object/part/instance scope.
  - Add snapping, keyboard nudging, unit handling, pivot/origin visibility, outside-bed and
    collision feedback, precise cancel, and one history transaction per drag.
  - Fix selection code that falls back to the first model. Derive Three manipulators from stable
    entity selection rather than render-array position.
  - **Accept:** transform matrices and bounds match reference fixtures after UI operations,
    undo/redo, 3MF round-trip, and slice; multi-selection never moves an unselected first model.
  - **Current:** pointer modifier selection and Select All retain exact stable instance IDs on the
    active plate. Move/rotate/scale gestures, numeric edits, and keyboard nudges project only the
    captured selection and commit one coalesced batch command with exact undo/redo; group gizmos
    use the canonical transformed-geometry bounds center rather than a render-array/first-model
    pivot. Drop to Bed matches the pinned per-instance minimum-Z behavior from immutable model
    mesh bytes, excludes modifier roles, and is shared by DOM/XR/automation through the registry.
    Mirror on X/Y/Z (a reversible negative scale component), Reset rotation, Reset scale, Centre on
    plate (one shared delta that preserves relative layout), and Lay flat (pick a facet, compose the
    shortest-arc rotation that turns it toward the bed, then rest on Z=0) are canonical commands
    with headless traces and browser coverage. Box/touch selection, part/object scope,
    coordinate-space controls, snapping, uniform lock, auto-orient, cancel traces, unit UI, and
    reference/XR qualification remain open.

- [~] **P5.2 — Complete mesh operations.** Deliver cut (plane, keep upper/lower, connectors where
  upstream exposes them), split to objects, split to parts, mesh Boolean union/difference/
  intersection, repair, simplify, and reload/replace with progress/cancel and topology impact.
  - Prefer pinned libslic3r/WASM algorithms or documented equivalent robust libraries; record
    exact tolerances and failure modes. Preserve transforms, configs, and annotations via maps
    where mathematically possible.
  - **Accept:** manifold/non-manifold, coplanar, disconnected, high-poly, and annotated corpus
    cases pass structural and geometry comparisons; no operation returns false success.
  - **Current:** a guarded topology-replacement command atomically installs a validated immutable
    indexed mesh, verifies volume/asset/digest/revision/triangle guards, bumps topology revision,
    invalidates every facet channel, preserves non-topology metadata and selection, garbage-
    collects only unreferenced assets, refreshes the stable Three projection, and owns exact
    asset/state undo/redo plus save/reopen. Split-to-parts preparation now reproduces the pinned
    opposite-directed shared-edge connectivity and component/face order, winding correction, and
    local-AABB recentering from immutable mesh bytes with progress/cancel seams; its guarded
    command commits a lossless triangle partition with fresh IDs, reset facet state, selection
    remapping, asset ownership/GC, persistence, and exact undo/redo. A deterministic ascending-face
    tie-break is documented for the pinned parallel builder's scheduling-sensitive non-manifold
    edge case. Split-to-objects now covers both pinned branches: unchanged model volumes promote
    directly with stable volume/annotation state, config inheritance, fresh object/instance IDs,
    and exact world placement; a disconnected single volume composes the prepared split and
    promotion as one atomic history entry. The live registry action captures an exact revision/
    hash/selection/object guard, presents every affected instance for explicit confirmation, and
    commits, cancels, or fails without partial canonical mutation. Rather than mirror upstream data
    loss, it blocks sub-three-facet fragments, modifiers/negative volumes, ambiguous layer-range/
    object-extension distribution, and single-volume synchronous analysis above 50,000 triangles.
    Worker progress/cancel, mapped annotations for topology-changing splits, and cut/Boolean/
    repair/simplify/reload algorithms and oracles remain gated.

- [ ] **P5.3 — Implement the remaining official gizmos.** Measure distances/angles/radii;
  assembly/explosion/alignment; emboss text; SVG emboss/part; simplify UI; and brim ears from P4.
  Hollowing is required only if exposed by the pinned Snapmaker FFF workflow manifest; otherwise
  classify the current placeholder accurately.
  - Persist editable parameters where upstream does. Provide precise handles, numeric fields,
    previews, apply/cancel, error messages, keyboard/touch/XR interactions, and undo.
  - **Accept:** golden geometry and parameter state compare within tolerances and reopen editable
    where the official project does.
  - **Split (2026-08-09):** this item is six independent gizmos over roughly 10,700 lines of pinned
    GUI plus `libslic3r/Measure.cpp`, with no shared acceptance gate; tracking them as one checkbox
    made partial delivery unreportable. It is therefore split into the children below, which
    together supersede nothing and remove no scope — P5.3 closes only when all six are `[x]`.
    Hollowing stays classified here: `GLGizmoHollow` is SLA-only in the pinned tree and is not
    exposed by the FFF workflow, so `tool_hollow` remains an accurate unavailable outcome rather
    than a gap.

- [~] **P5.3.1 — Measure distances, angles, and radii.** Port the pinned `libslic3r/Measure.cpp`
  surface-feature extraction (point, edge, circle, plane) and `get_measurement`, then expose exact
  distance (infinite/strict/XYZ), angle, and circle radius/diameter between any two picked
  features.
  - **Accept:** the ported extractor and measurement agree with the pinned implementation on a
    golden corpus of primitives and a real model, degenerate inputs fail closed, and the readout
    never rounds a value into existence.
  - **Current:** `project/objects/measure.ts` carries the port (`EVID-035`). Facets cluster into
    planes by the pinned `is_same_normal` 0.001-per-component test — a neighbour is queued but only
    claimed when it is popped and still matches the seed, which is what keeps a cube six planes
    instead of one — borders are walked from the boundary half-edges, and borders resolve to
    circles or edges under the pinned `>4`/`>8` vertex rules and `0.05` fit tolerance.
    `measureSurfaceFeatures` reproduces the pinned operand swap and every implemented branch:
    point-point with XYZ components, point-edge separating strict from infinite, point-circle on
    and off the axis, edge-edge nearest-pair with angle, edge-plane gated on perpendicularity,
    circle-plane, and plane-plane distance-or-angle. `featureAt` applies the pinned
    `feature_hover_limit` of 0.5 mm and the 10 %-of-length endpoint promotion.
    `transformSurfaceFeature` lifts a pick into world millimetres so two instances measure in one
    frame, and refuses a non-uniformly scaled circle because an ellipse has no single radius.
    `tool_measure` and `measure_clear` are real registry actions with a DOM readout that shows a
    stated reason wherever a number does not exist.
  - **Outstanding:** two documented deviations and XR. Circle fitting uses a deterministic
    algebraic least-squares fit instead of upstream's default-seeded `circle_ransac`, whose
    `std::sample` ordering is implementation-defined and so cannot be replicated exactly in
    another language; the error metric and threshold are unchanged. Circle-to-circle distance
    between non-parallel planes needs upstream's degree-8 polynomial root finder and is reported
    as explicitly unsupported rather than approximated. Both actions declare an
    `xrUnsupportedReason` because the readout is DOM-only. A differential corpus against a
    compiled pinned build, and the on-screen dimension annotations upstream draws, remain open.

- [~] **P5.3.2 — Assembly view, explosion, and alignment.** Provide the pinned assembly mode with
  an explosion factor and the `get_assembly_action` parallel/center-coincidence/reverse-rotation
  transforms, committed as canonical instance transforms.
  - **Accept:** each alignment reproduces the pinned transform within tolerance, explosion is a
    view-only projection that never mutates canonical placement, and every applied alignment
    undoes as one command.
  - **Current:** `project/objects/assembly.ts` carries the canonical half (`EVID-036`).
    `inspectAssemblyActions` is an exact port of `Measure::get_assembly_action`, including the
    signed `parallel_distance` along feature 1's normal and the rule that only a plane pair is
    actionable. `planAssemblyAlignment` is a pure function from two picked features plus the
    moving instance's transform to the transform it would have, covering all five pinned
    operations: parallel, centre coincidence (anti-parallel turn then close the gap),
    parallel distance, reverse rotation (a half turn about an in-plane axis through the face
    centre), and rotation around the face centre. The pinned `1e-3` guards are reproduced, so an
    already-aligned pair is a no-op instead of a rounding-sized nudge. One subtlety is pinned by
    test: upstream always rotates the moving normal to `-normal1`; `is_anti_parallel` changes only
    which already-aligned case is skipped, not the target. `projectExplosion` is view-only and
    returns centroid-relative offsets that are exactly zero at factor 1, so an exploded view can
    never move canonical placement.
    The planner is wired: `tool_assembly` and `assembly_align` are real registry actions, the
    Measure panel grows an Align group once two features are picked, each button reflects exactly
    what the pair allows, and applying one commits a single guarded instance transform that undoes
    as one entry. Two picks on the same model disable every alignment, because nothing can move.
  - **Outstanding:** the exploded view is a tested canonical projection but nothing renders it yet,
    so no explosion slider is offered rather than shipping a control that does nothing. Upstream's
    same-object (volume-level) alignment mode, its on-canvas alignment handles, and XR also remain;
    all six actions in this family declare an `xrUnsupportedReason`.

- [~] **P5.3.3 — Emboss text.** Text volumes with font, size, depth, alignment, per-character
  spacing, surface projection, and the pinned editable parameter set persisted for reopen.
  - **Accept:** golden geometry compares within tolerance and a saved project reopens the text
    still editable; no font is fetched at runtime under the app CSP.
  - **Current:** `project/objects/emboss.ts` lays text out in millimetres — line height, letter and
    line gap, skew, and both alignment axes — and extrudes it; `project/objects/truetypeOutlines.ts`
    reads `glyf` outlines, composite glyphs, and cmap formats 4 and 12 from a font the operator
    supplies. Nothing is fetched: a browser cannot enumerate installed fonts and the CSP forbids
    requesting one, so the font is always a picked file. That is recorded in the platform-adaptation
    register, not silently substituted.
    Counters are the hard part, and they are correct: contours are classified by winding direction —
    the rule fonts actually use — so a part that merely touches another (the cedilla of ç, the bars
    of #) stays solid instead of being read as a hole, and `project/objects/polygonTriangulation.ts`
    subtracts real holes through hole bridging with the two recovery passes a naive ear clipper
    lacks. Walls are derived from the cap's own boundary, so the solid is watertight by
    construction. The sweep in `truetypeOutlines.test.ts` extrudes every printable character of
    every system font present and requires them closed.
    `slic3rpe:text` and `slic3rpe:shape` are written and read on the part exactly as the pinned
    `bbs_3mf.cpp` does — including vertical `center` serialising as `middle` — so a saved project
    reopens with the text still editable, and a BBS project written elsewhere brings its recipe
    across. `AddEmbossTextCommand`/`EditEmbossTextCommand` add and re-cut the volume as single
    undoable commands that reset the facet annotations a re-cut invalidates. `add_emboss` is a real
    registry action with `emboss_load_font`, `emboss_configure`, and `emboss_apply` behind a DOM
    panel.
  - **Outstanding:** `use_surface` projection onto the model is stored and round-trips but is not
    yet applied — the mesh is extruded flat, so the flag is persisted rather than honoured;
    per-glyph embossing (`per_glyph`) is likewise stored but not yet cut as separate volumes; and
    boldness is stored without an outline-offset pass. There is no live preview before apply, no
    golden-geometry oracle against the pinned engine (the sweep proves closure, not equality), and
    all four actions declare an `xrUnsupportedReason` because choosing a font file and typing text
    are DOM-only. One system glyph in roughly 1400 (FreeSerif `4`) still comes out open; the mesh
    reports `openEdgeCount` and the status line says so rather than letting the slicer quietly
    repair it.

- [~] **P5.3.4 — SVG emboss and SVG part.** Import an SVG, resolve its paths to a mesh volume, and
  keep the pinned editable parameters.
  - **Accept:** golden geometry and parameter round-trip; unsupported SVG features are reported
    exactly rather than silently dropped.
  - **Current:** `project/objects/svgShapes.ts` resolves paths, rects, circles, ellipses, and
    polygons — with every path command including elliptical arcs and the smooth-curve reflections —
    through nested transforms, into closed contours in millimetres. The document's own physical
    size, its viewBox, and the 96dpi pixel convention all resolve to real millimetres, and the y
    axis is flipped so a cut part is not a mirror of the drawing. The reader is hand-written rather
    than `DOMParser`-based because the canonical layer has no DOM and because a real parser would
    hide exactly what this has to report.
    Extrusion is the same `extrude.ts` the text emboss uses, so SVG parts inherit its winding-based
    hole handling and cap-derived walls: all 7,314 Material Symbols production icons extrude to
    watertight solids, and a bounded slice of them runs in the gate.
    Unsupported features are named individually — text needing a font, raster images, `use`
    references, clip paths, masks, filters, gradients, stroked shapes with no fill, and units with
    no fixed physical size — each with the element and a sentence an operator can act on, surfaced
    both in the panel before cutting and in the status line after. `slic3rpe:shape` carries
    `filepath` and `filepath3mf` exactly as the pinned `bbs_3mf.cpp` writes them, so a saved part
    reopens with its drawing and parameters, and a shape without an SVG reference is never mistaken
    for one. `AddSvgPartCommand`/`EditSvgPartCommand` add and re-cut as single undoable commands
    that reset the annotations a re-cut invalidates; `tool_svg` stops being a coming-soon stub and
    gains `svg_load_drawing`, `svg_configure`, and `svg_apply` behind a DOM panel.
    The drawing itself is written into the package at `filepath3mf` and recovered on import as a
    canonical asset, so a reopened part can be re-cut rather than merely re-placed; the reference
    is emitted only when the file is actually stored, as upstream does, so it never names something
    the package lacks.
  - **Outstanding:** `use_surface` is stored and round-trips but is not applied; there is no golden
    oracle against the pinned engine (the sweep proves closure, not equality); CSS `style` blocks
    and presentation inheritance beyond a shape's own `fill`/`stroke` are not resolved; and all
    four actions declare an `xrUnsupportedReason` because choosing a file is DOM-only.

- [~] **P5.3.5 — Simplify UI.** Front the existing guarded topology-replacement command with the
  pinned decimation controls (ratio/error, preview, apply/cancel, progress).
  - **Accept:** the preview matches the applied result, annotations invalidate exactly as the
    guarded command already defines, and cancel leaves canonical state untouched.
  - **Current:** `project/objects/simplify.ts` implements quadric-error-metric edge collapse with
    the pinned `GLGizmoSimplify::Configuration` semantics (`EVID-037`): `use_count` drives a wanted
    triangle count through an exact port of `fix_count_by_ratio`, otherwise collapsing runs until
    the next edge would exceed `max_error`, whose defaults are the pinned 50 % and 1.0. A collapse
    that would flip a surviving face is refused, the source mesh is never mutated, progress is
    reported, and cancellation throws before anything is produced. `simplify_model` is a real
    registry action: `CanonicalWorkspaceController.simplifyVolume` stages the decimated mesh and
    installs it through the existing `ReplaceVolumeMeshCommand`, so the new topology, the
    invalidated facet channels, and asset ownership are one undoable entry — pinned by a test that
    decimates a sphere, checks the revision bump and the cleared support painting, then undoes to
    a byte-identical project.
  - **Outstanding:** the pinned gizmo's live preview and its error/count mode switch are not
    exposed yet — the action decimates at a ratio and reports the before/after counts rather than
    previewing first, so "the preview matches the applied result" is unproven. Upstream's
    per-object configuration persistence and XR also remain.
  - **Deviation:** upstream orders collapses through a bespoke mutable mini-heap whose tie-break
    depends on internal heap layout. This port uses a binary heap with lazy invalidation and an
    explicit deterministic tie-break, so the same mesh always decimates the same way; the quadric
    maths, thresholds, and count derivation are the pinned behaviour, but the exact triangle set
    will differ from a compiled upstream run.

- [~] **P5.3.6 — Brim ears.** The placement gizmo P4.8 deferred: pick anchor points, author the
  pinned ear geometry/parameters, and persist them.
  - **Accept:** placed ears reach the engine and the sliced result shows them; parameters reopen.
  - **Current:** ears are canonical per-object state (`EVID-038`). `BrimEarPoint` mirrors the
    pinned `ModelObject::brim_points` — object-local millimetres plus a front radius — and is
    validated. `serialization/brimEarPoints.ts` is an exact codec for
    `Metadata/brim_ear_points.txt`: the `brim_points_format_version=0` header, `object_id=<1-based>|`
    lines, `%f` six-decimal values in groups of four, and the pinned reader's error cases
    (missing pipe, malformed id, id 0, duplicate object) surfaced as typed warnings instead of
    silent drops. The writer numbers objects by the serializer's existing plate-ordered ordinal,
    which is the same 1-based index the pinned writer uses, and import restores ears onto that
    object or reports an out-of-range id. `AddBrimEarCommand`, `RemoveBrimEarCommand`, and
    `ClearBrimEarsCommand` are ordinary undoable commands — a removed ear returns at its original
    index. The `brim_ears` modal tool places an ear where the pointer meets the selected part, and
    `tool_brim_ears`, `brim_ears_configure`, `brim_ears_remove`, and `brim_ears_clear` are real
    registry actions behind a DOM panel that owns the radius and the placed list.
  - **Outstanding:** the acceptance bar is not met yet. Ears are written into the archive the
    engine reads, but no test slices a project with ears and confirms them in the G-code, and the
    pinned gizmo's automatic placement (`detection_radius`, `max_angle` auto-detect of overhang
    corners) and its on-model ear preview are not implemented — placement is manual only. All four
    actions declare an `xrUnsupportedReason`.

- [~] **P5.4 — Complete plate management.** Support up to the upstream limit (36): create,
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
  - **Current:** canonical commands enforce the pinned 36-plate ceiling and cover stable-ID rename,
    printable inclusion/exclusion, exact permutation reorder, final-plate delete protection, scoped
    metadata cleanup, atomic failure, no-op suppression, and exact undo/redo. Duplicate allocates
    fresh IDs for every editable descendant while sharing immutable assets and cloning exact
    plate-scoped G-code/thumbnail metadata. A live accessible, revision-guarded manager covers
    add/activate/rename/duplicate/delete/reorder/printable state through the action registry.
    Slice All Plates is live through the same revision/project/asset guard as the active-plate
    route: every printable plate retains its own named G-code result and download, and any drift
    withdraws the whole set instead of publishing a mixture of revisions. Locking, copy/move UI,
    plate settings, per-plate statistics, official round-trip, and cross-route qualification
    remain open.

- [~] **P5.5 — Match arrangement and placement outcomes.** Arrange all/current plate, automatic
  orientation, bed collision, top-cover/clearance constraints, sequential-print clearance, and
  wipe-tower placement use printer/profile constraints and deterministic seeds where possible.
  - **Accept:** fixture bounds never intersect forbidden zones; locked entities do not move;
    comparison screenshots and numeric placements meet recorded tolerances.
  - **Current:** auto-arrange is a canonical command: a deterministic shelf planner reads immutable
    asset bytes and canonical transforms, sorts by footprint so one project always yields one
    layout, keeps the bed margin, inter-object spacing, every declared exclusion (including the
    project's prime tower) and every locked or non-printable instance clear, centres the packed
    block when nothing else reserves space, preserves each instance's orientation, scale, and Z,
    reports instances that do not fit instead of stacking or pushing them off the bed, and commits
    one reversible transform batch; the live menu action and a production browser pass exercise it
    with undo. Per-vertex bed collision and overflow detection (`BedCollision.ts`) with axis
    overflow banners exist; wipe-tower 8-candidate Chebyshev clearance optimization
    (`WipeTowerPlacement.ts`) is implemented and unit tested. Rotation-aware nesting, automatic
    orientation, sequential-print clearance, top-cover constraints, and reference placement
    tolerances remain open.

- [~] **P5.6 — Implement authoritative import filters and behavior.** From the generated P0
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
  - **Current:** one signature-first dispatcher owns every model container. Extension alone never
    selects a decoder, a recognised extension that disagrees with a recognised signature fails
    closed, and 3MF, STEP, SVG, and G-code raise typed `requires-project-import`,
    `requires-native-kernel`, `requires-emboss-workflow`, and `not-a-model-format` reasons instead
    of being reinterpreted as meshes. Binary/ASCII STL, OBJ, AMF, gzip/ZIP-compressed AMF, and ZIP
    archives of those formats decode into deterministic welded indexed meshes: OBJ objects and
    `usemtl`/`g` sections become canonical objects and parts with MTL diffuse colours, AMF carries
    declared units, material names/colours, `slic3r.modifier` roles, and constellation instances,
    and archives import atomically with per-member skip notices. Every unit conversion, degenerate
    facet, dropped metadata field, merged multi-solid STL, and unloaded `mtllib` becomes a preview
    repair, dropped field, or diagnostic. Live import now runs through the P1.4 transactional
    coordinator: geometry becomes immutable deduplicated assets, names are disambiguated, objects
    are centred and dropped onto the active plate, commit is one undoable command, and a malformed,
    hostile, or cancelled source leaves canonical state untouched. Hostile inputs (DTD/entity AMF,
    traversal or corrupt archives, truncated STL, out-of-range OBJ indices, over-cap geometry) are
    rejected with stable reason codes. `file_import_zip` is therefore no longer an unavailable
    cutover gate. STEP/SVG decoding, URL/handy-model sources, drag/drop, whole-project-versus-
    geometry conflict handling, an external-engine STEP route, and official reference-corpus
    comparison remain open. One intake now serves the picker and drag-and-drop for every supported
    container: dropping or picking a 3MF asks whether to open it as a project or contribute only
    its geometry, mesh containers merge as models, and G-code opens read-only in the viewer. The
    geometry-only route reuses the canonical BBS reader, gives every merged entity fresh stable IDs,
    deduplicates identical meshes, centres the merged group on the plate, and reports the plates,
    filament library, project settings, custom G-code, and thumbnails it deliberately leaves behind.
    STEP/SVG decoding, URL/handy-model sources, and official corpora remain open.

- [~] **P5.7 — Complete export and G-code import/viewing.** Cover project 3MF, generic/core 3MF,
  current/all sliced 3MF, combined/separate or selected STL, current/all plate G-code, toolpath
  OBJ, preset/config bundles, logs/diagnostics, and standalone G-code open as inventoried.
  - Use File System Access API opportunistically and standards-based downloads elsewhere;
    preserve filenames, extensions, overwrite intent, progress, cancellation, and errors.
  - **Accept:** every visible format produces a non-empty valid artifact accepted by its oracle;
    unavailable browser-specific destinations use a documented equivalent flow.
  - **Current:** canonical project 3MF save and guarded current-plate G-code downloads are live.
    Export as one STL now merges an exact stable-ID selection (or active plate), composes
    volume/instance TRS from immutable indexed assets, fixes mirrored winding/normals, excludes
    non-printing modifiers, fails closed when negative-volume CSG is required, and downloads a
    deterministic binary artifact without reading Three. Generic/core or sliced 3MF variants,
    separate/multi STL, slice-all G-code, OBJ, standalone G-code viewing, File System Access,
    progress/cancel/overwrite flows, and official format oracles remain open.

- [~] **P5.8 — Add primitives and model sources coherently.** Match official primitive types,
  parameter editing, add-as-object/part/modifier behavior, handy-model catalog, and SVG/text
  entry. Cache remote catalogs safely and provide offline/permission/error states.
  - **Accept:** each source creates the intended semantic node and remains editable/persisted
    where promised; network failure never blocks local import.
  - **Current:** `PrimitiveKind` supports Cube, Cylinder, Sphere, Cone, Torus, Disc, and Slab types
    along with `ModelVolumeType` role bindings; `HandyModelCatalog` manages remote/offline model
    sources. Parameter editing UI and SVG text entry remain open.

- [~] **P5.9 — Implement variable/adaptive layer-height editing.** For an eligible selected
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
  - **Current:** `project/objects/layerHeightProfile.ts` ports the pinned `Slicing.cpp` editor and
    `SlicingAdaptive.cpp` generator, keeping upstream's own `[z, h, …]` representation and every
    constant that goes with it — the 0.1 mm resampling step, six smoothing rounds, the raised
    cosine falloff, `LAYER_HEIGHT_CHANGE_STEP`, and the 1.44/0.184 slope formula — so a profile is
    numerically comparable rather than merely plausible. All four manual actions are implemented,
    plus the biased Gaussian smoother with radius and Keep min, adaptive generation from the
    object's own triangles, and the layer boundaries a profile produces.
    Two behaviours are worth stating because both read backwards at first glance and getting either
    wrong would silently hand an operator the opposite of what they asked for: the pinned
    "Quality / Speed" factor is **finest at 0**, and a *vertical* wall takes the maximum layer
    height while a shallow, nearly horizontal surface takes the minimum. Both are pinned by test.
    The profile lives on the canonical object, is written to and read from
    `Metadata/layer_heights_profile.txt` in the pinned `object_id=N|z;h;…` form at `%f` precision,
    and every entry point — manual edit, adaptive, smooth, reset — is one undoable command. Reset
    clears the profile rather than writing a flat one, so an object that was never edited never
    grows a profile in its saved archive.
  - **Outstanding:** there is no on-canvas Z-profile editor or height/quality legend yet, so the
    algorithms are reachable through commands rather than by dragging on the model; no
    wheel/controller edit-radius control and no XR flow; the upstream conflict checks (organic
    support, unequal prime-tower profiles) and the `layer_config_ranges` interaction that suppresses
    edits inside a configured range are not enforced; and the preview does not yet re-render layer
    Z from an edited profile, so "alter layer Z as previewed" is proven by `objectLayersFromProfile`
    rather than on screen.

P5 exit gate: the generated prepare/file manifest has no unmapped behavior; all enabled tools
operate on canonical entities, survive history/3MF, and meet geometry/plate acceptance tests.

## 12. P6 — Engine-derived settings, profiles, and preferences

Upstream anchors: [`PrintConfig.cpp`][up-print-config], [`Preset.hpp`][up-preset],
[`PresetBundle.hpp`][up-preset-bundle], print/filament/printer tab construction in
[`Tab.cpp`][up-tab], [`Search.cpp`][up-search], and upstream guides for
[profile creation][up-profile-guide] and [preset bundles][up-preset-guide]. At this baseline,
the source contains roughly 783 `PrintConfigDef` entries; a static hand-maintained list cannot
be the parity oracle.

Local starting seams: [`engine-options.schema.json`](../web/src/settings/generated/engine-options.schema.json),
[`GeneratedSettingsPanel.ts`](../web/src/ui/dom/GeneratedSettingsPanel.ts),
[`PresetGraph.ts`](../web/src/settings/presets/PresetGraph.ts),
[`ProfileLoader.ts`](../web/src/slicer/ProfileLoader.ts),
[`profileKeys.ts`](../web/src/slicer/profileKeys.ts), and
[`verify-pinned-profile-overlays.mjs`](../web/scripts/verify-pinned-profile-overlays.mjs).

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
  - **Current:** schema v2 emits 816 definitions/809 unique runtime keys with types, defaults,
    bounds, enum maps, presentation metadata, applicability, provenance, and serialization rules.
    It now cross-checks the complete pinned `Tab.cpp` manifest inventory call-by-call and retains
    21 tabs, 93 groups, and 424 ordered literal placements covering 417 keys, with 420 exact
    definition bindings and four duplicate-owner bindings that remain ambiguous. The strict
    loader pins the inventory counts and full binding sets; ten source/schema mutation guards
    reject drift or truncation. Twenty-six dynamic placements, four custom widgets, 395
    definitions without a literal placement, predicates, reset/general-scope semantics, runtime
    C++ dump comparison, and locale catalogs remain explicit gaps. Dynamic placements, custom
    widgets, and unproven scopes fail closed; dependency and per-control reset rules are truthfully
    marked unenforced, so the schema still labels itself `foundation-partial`.

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
    deterministic mode/technology/search state plus the pinned page/group/order, classifies
    ambiguous/read-only/unknown/custom/no-literal definitions unavailable, parses and validates
    supported scalar/vector families, exposes inherited/default/changed/compare/reset state, and
    commits drafts atomically. The generated DOM panel groups fields by the pinned Process layout
    and edits the canonical project override layer through a revision/hash-guarded registry action;
    both draft and commit revalidate that authority, so Filament, Printer, Object, and Plate-only
    placements remain disabled. Three exact `set_project_bool` writes and a narrow pinned
    FullSpectrum project overlay are the only reviewed exceptions. Unknown raw engine keys survive,
    reset restores inheritance, and canonical save/reopen uses no shadow store. Dependencies,
    general scoped mutation seams, special widgets, engine-effect proofs, XR, locale, and
    cross-surface qualification remain open.

- [~] **P6.3 — Implement preset semantics.** Support system, user, and project presets for
  printer/process/filament; inheritance; compatibility expressions; multiple filament slots;
  project overrides; save/save-as/rename/delete; unsaved-change resolution; compare; import;
  export; and restore defaults.
  - Replace Cartesian-product selection with upstream-compatible filtering by printer, nozzle,
    process, material, vendor, and dependencies. Preserve selected compatible presets when other
    choices change; explain substitutions.
  - **Accept:** the profile corpus resolves the same compatible choices/effective config as the
    reference for U1 and Elegoo CC; conflict and unsaved-change flows are fully tested.
  - **Current:** an immutable canonical preset graph resolves same-vendor and unambiguous
    cross-vendor inheritance, rejects duplicate/missing/ambiguous/cyclic graphs, applies pinned
    explicit-list/direct-parent compatibility precedence, and fails condition expressions closed
    without an injected evaluator. Deterministic reconciliation preserves compatible printer,
    process, and multi-filament selections and records substitutions. `ProfileLoader` atomically
    retains its last-good catalog and now compiles 694 compatibility-valid triples instead of the
    prior 5,608 Cartesian combinations while retaining legacy IDs. A reproducible gate verifies
    93 same-path profile files byte-for-byte against the exact engine commit, imports their pinned
    inheritance closure, SHA-256-locks 106 OrcaXR-only target adaptations, and checks a sorted
    199-profile catalog. The live DOM/setup/XR selectors use canonical preset IDs and the same
    resolver: printer/process changes preserve compatible process and every physical/auxiliary
    filament slot, deterministically explain substitutions, expose only exact printer+process
    choices, fail incomplete/stale requests without mutation, and commit the exact displayed
    filament preset config to slicing. Expression evaluation, active-session catalog hot refresh,
    imported/ad-hoc rebinding, per-head nozzle reconciliation, stable graph-ID 3MF binding,
    user/project preset CRUD/vendor visibility, unsaved-change/compare/import/export/default
    flows, and U1/Elegoo reference qualification remain open.

- [~] **P6.4 — Add printer/filament creation and setup.** Provide setup wizard or equivalent for
  supported printer/nozzle/profile installation, custom printer creation, custom filament from
  a compatible base, profile updates, and explicit source/license/version metadata.
  - **Accept:** clean browser storage can be configured without developer tools; exported bundle
    reimports with inheritance and compatibility intact.
  - **Current:** `settings/presets/PresetLibrary.ts` holds what this operator installed and
    authored on top of the pinned corpus, and `ProfileCatalog` now compiles the *composed*
    catalog, so an installation decides what the whole app — pickers, preflight, slicing —
    can select. Three rules shape it. Installation is visibility, never deletion: an
    uninstalled machine keeps its entry with `instantiation: "false"`, because the 0.2 mm
    profile inherits from the 0.4 mm one and dropping the parent would break the child that
    stayed. A custom preset is an overlay on a system base — `inherits` plus the keys it
    changes — so upstream's direct-parent-name rule (`Preset.cpp:639-717`) carries the base's
    compatibility to it, and a corpus update reaches it through inheritance instead of
    freezing it. And every mutation is proven before it lands: a candidate state is normalized
    and the merged catalog rebuilt as a valid `PresetGraph`, so a rejected edit leaves the
    library byte-identical. Overrides are refused if they touch identity (`name`, `inherits`,
    `instantiation`), name a key no system preset of that kind defines, or carry a non-finite
    number; a base is offered only if the selected printer can actually use it, since the
    pinned corpus lists 68 selectable filaments and a Snapmaker accepts a fraction of them.
    Deleting, renaming, or uninstalling something another preset inherits from is refused and
    names the dependants. Provenance — source, licence, version, the exact lineage, and both
    timestamps — is mandatory and travels in the bundle. A bundle is refused whole when its
    format, schema, or engine commit does not match this build, while stored local state
    recovers what it can and reports the rest, because it is the operator's only copy. A
    setup made against a different corpus says so on load, which is the one moment a profile
    update is observable from inside the app.
  - **Missing:** the panel is DOM only; XR has none of it. `planCatalogUpdate`/
    `applyCatalogUpdate` are proven against a second corpus in tests but have no runtime path,
    because the corpus ships with the build. Editing an existing custom preset is reachable
    through the action and the library but has no panel control yet, vendor-scoped
    installation profiles are not offered, and hardware qualification of an authored printer
    remains unproven.

- [~] **P6.5 — Reuse the same schema at every scope and surface.** Project, plate, object, part,
  and height-range overrides share validation and effective-value resolution. Desktop, narrow
  touch, and XR render surface-specific controls over identical draft/commit state.
  - XR may group or search settings differently, but every applicable setting remains reachable,
    legible, and editable with controller/hand input.
  - **Accept:** a cross-surface test edits the same sampled settings and compares canonical state
    and generated config byte-for-byte.
  - **Current:** which settings a scope may hold, and the order the scopes layer in, are read from
    the pinned engine by `tools/settings-schema/generate-scopes.mjs` rather than transcribed. Two
    facts fall out of that, and both contradict what the UI nesting suggests. A plate may override
    exactly eight keys — five of which exist at no other scope — while an object may override 242,
    a part 123, and a height range 124; storing `wall_loops` on a plate is therefore not a weaker
    way of setting it, it is a value nothing will ever read. And a height range outranks the part
    it cuts through, because `region_config_from_model_volume` applies the object's config, then
    the part's, then the range's. `domain/settingScopes.ts` enforces both, and the generator fails
    rather than regenerating if either changes upstream.
    `resolveConfig` used to refuse to combine a part with a height range and to layer whatever it
    found in insertion order. It now layers in engine order and reports — instead of applying —
    every key stored where the engine will not read it, so a reader can no longer disagree with
    the slice.
    Authoring is strict and reading is lossless. `SetScopedOverridesCommand` refuses an
    out-of-scope key rather than dropping it, and copies through the keys a node stores that are
    not overrides at all (a plate's `locked`, an imported object's `extruder`), because P1's
    lossless round-trip outranks tidiness. The submitted map is the whole scope, so an omitted key
    resets to inherited.
    One panel serves all five. `ScopedSettingsPanel` puts a target picker in front of the same
    `GeneratedSettingsPanel`, and `SettingsDraftEditor` gained a `scope` that hides and refuses
    what that scope cannot hold — so there is still exactly one field renderer, one validator, and
    one commit path. Project-scope edits keep going through `settings_apply_project`; the other
    four go through `settings_apply_scoped`, both landing as single reversible commands.
    Verified in the production browser: selecting an object narrows the panel (a plate's
    `print_sequence` disappears), `wall_loops` applies to that object alone with the project's own
    override map untouched, and the change undoes and redoes as one entry.
  - **Missing:** the XR shell has no scoped settings surface at all — the picker and panel are DOM
    only, and `settings_apply_scoped` is reachable from the inspector and the command palette but
    from no XR surface, so "identical draft/commit state across desktop, touch, and XR" is proven
    for two of the three. The cross-surface test stands in for the third by driving the shared
    draft the way a controller would, with stepped values rather than typed text.

- [~] **P6.6 — Implement application preferences separately from slice settings.** Cover language,
  units, theme/system/high contrast, zoom-to-pointer, pan/rotate mapping, wheel direction,
  configurable shortcuts, autosave/recovery, privacy/network, external slicer endpoint, printer
  connections, AI provider/key handling, update behavior, and accessibility/XR comfort options.
  - Version and migrate storage; validate imports; allow reset/export; never persist secrets in
    plaintext `localStorage` by default.
  - **Accept:** preferences survive reload and migration, respect OS signals, do not leak into
    project config, and can be restored without clearing projects/presets.
  - **Current:** `settings/Preferences.ts` owns a versioned, migrating store for the settings that
    belong to this device rather than to a project. Migration is real rather than hypothetical: the
    slicer route shipped under unnamespaced `external_slicer_url`/`external_slicer_enabled` keys
    that collide with anything else on the origin, and v2 moves them under `orcaxr.` on first read,
    idempotently and without overwriting a value changed since. Export is versioned and deliberately
    secret-free so a setup can be shared or attached to a bug report; import validates the format
    and version and refuses any key outside the preference set, so a file from elsewhere cannot
    reach credentials, presets, or an arbitrary key on this origin. Reset clears the setup and
    provably leaves projects and presets alone — that separation is why the key list is explicit
    rather than a prefix sweep, since `orcaxr.profiles` shares the namespace and is the operator's
    work. Browser AI keys remain session-only.
    Only preferences with an observable effect are offered: a reduce-motion override that the
    stylesheet honours alongside the OS signal. Storing a setting nothing reads would look like it
    works, so the rest of the enumerated list is named as outstanding rather than shipped inert.
  - **Outstanding:** language, units, theme and high contrast, zoom-to-pointer, pan/rotate mapping,
    wheel direction, configurable shortcuts, autosave/recovery, update behaviour, and XR comfort
    options are all still absent — most need the behaviour they would control to exist first (the
    app has one dark theme and no unit-aware display layer). The printer API key and slicer token
    are now remembered on the device by default, which reverses this item's own "never persist
    secrets in plaintext `localStorage` by default" instruction; that was an explicit operator
    decision, is recorded as `ADAPT-10` and in the decision log, and remains behind a switch that
    erases what it stored.

- [~] **P6.7 — Correct config serialization at every boundary.** String vectors use semicolons;
  numeric vectors use commas as required by this port. Preserve escaping, percent/absolute
  distinction, nullable values, enum tokens, and G-code text.
  - **Accept:** generated round-trip tests cover every schema type through browser worker,
    project 3MF, config import/export, and external server; delimiter mutation tests fail.
  - **Current:** `ConfigIO` and `ProfileLoader` share the pinned PrintConfig delimiter classifier.
    Tests compare all 174 generated PrintConfig vector definitions: 26 unique `coStrings` keys
    use semicolons and every other vector uses commas. The schema-driven editor also fail-closes
    delimiter drift for its supported scalar/vector families. Escaping, special shapes, and
    browser-worker/3MF/server boundary matrices remain open.

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
    submit/retry terminal state, and supports cancellation, per-stage timeouts, retry/recovery,
    revision and overlapping-job supersession guards. A canonical preflight phase now runs before
    serialization or route submission and carries its warnings into the plate result. The
    versioned route contract records
    engine commit/artifact, profile identities, input revision/hash, SHA-256 project/output
    hashes, warnings, statistics, and route. On the server, `.3mf` plus ZIP signature writes
    `/tmp/in.3mf` and calls `startSliceProject`; STL calls `startSliceFile`, while extension/
    signature mismatches and unsupported inputs fail closed. The live current-plate workspace uses
    this coordinator and projects progress/cancel/result guards. Slice All Plates is live: one job
    covers every printable plate, each plate keeps its own G-code, byte size, and warnings, the
    whole set shares one revision/hash/asset guard so drift discards all of it rather than
    publishing a mix, and each plate can be downloaded as its own named artifact. Prompt
    The browser engine again emits the complete `CONFIG_BLOCK`: its Emscripten gate on
    `append_full_config` predated `fixup_enum_keys_map()`, and without the dump an OrcaXR artifact
    carried only the `first_layer_*` scalars, so nothing downstream — G-code re-import, the
    send-time filament mapping, desktop diffing — could recover `filament_colour`,
    `filament_type`, or `layer_height`. Prompt
    worker/process termination qualification, WASM/CLI semantic-oracle equivalence, per-plate
    statistics UI, and device qualification remain open.

- [~] **P7.2 — Implement complete preflight and actionable errors.** Validate printable objects,
  plate bounds/collisions, manifold/repair status, profile/nozzle/printer compatibility, settings,
  sequential clearance, assigned tools/materials/mixed components, temperature limits, wipe
  tower/purge, custom G-code, and device constraints before slice/send.
  - Distinguish warning from blocking error, link to the offending entity/setting, support
    “fix/reveal,” and never suppress engine diagnostics without an equivalent message.
  - **Accept:** fault-injection corpus maps each failure to stable code, affected entity, help,
    and allowed next actions; unsafe output cannot be sent.
  - **Current:** a read-only canonical preflight validates project structure, plate/printable
    instance availability, immutable mesh readability/emptiness, potential instance AABB overlap,
    active filament/virtual-component availability, deleted recipes, wipe-tower physical
    assignment, and bounded custom G-code before any serialization or engine call. Its injectable
    target constraints additionally cover exact transformed bounds/build height, sinking,
    nozzle/material compatibility, hotend temperature ranges, wipe-tower origin, and profile
    attestation. Every finding has a stable code/ID, severity, affected canonical entities, help,
    and structured fix/reveal actions; blocking results raise a typed error and warnings persist
    with the slice result. The live workspace and coordinator now share that validator: exact
    catalog selections conservatively derive offset rectangular XY/build-height bounds, physical
    nozzle mapping, selected-filament material, and its declared temperature interval, while
    ambiguous or unbound targets fail closed instead of inheriting scene/display defaults. An
    imported project attests from its own embedded printer/filament configuration instead of
    requiring catalog presets it cannot have, while a tool with no embedded configuration still
    fails closed. An
    accessible issue panel exposes stable severity/code/help/path/entity evidence and routes the
    supported Reveal and Select→Drop-to-bed fixes through the action registry. Arbitrary bed
    polygons, exact mesh and sequential/toolhead collision, manifold/repair/settings/purge/
    custom-command/device semantics, persisted profile attestation and import rebinding,
    engine-diagnostic merging, send gating, remaining fix workflows, and the full fault corpus
    remain open.

- [~] **P7.3 — Parse rich G-code move metadata.** Retain layer/Z, sequence index, role/line type,
  width, height, speed, fan, temperature, volumetric flow, tool/filament, filament ID, color-print
  ID, extrusion/travel/retract/unretract/wipe/seam/tool-change/pause/custom markers, and time.
  - Stream/partition data into GPU-friendly buffers; do not build one unfilterable line object.
  Preserve source offsets/line numbers for inspection without holding avoidable duplicate text.
  - **Accept:** parser fixtures and reference G-code compare segment counts/properties, bounds,
    layer/tool changes, and estimates; malformed commands degrade with explicit warnings.
  - **Current:** a source-pinned, bounded parser emits contiguous typed-array columns for linear
    extrusion, travel, retract/unretract, and wipe moves plus tool/color changes, pause, custom,
    layer, and wipe-boundary markers. It retains layer/role, width/height, feedrate, fan, hotend
    temperature, volumetric flow, tool/filament identities, source line/half-open offsets, and
    command `N` words while honoring modal units, coordinate/extrusion modes, and `G92`. Exact
    pinned two-character `G2`/`G3` commands now remain one semantic/source record and own a dense,
    bounded Float32 path-point slice plus direction and XY center; consumers never invent records
    for tessellation points. The port preserves pinned I/J-offset, P-truncation/full-circle,
    helical, ignored-extra-R, endpoint-state, 0.0125 mm chord-tolerance, terminal-edge, and
    Float32 assignment semantics, including P's distinct length formula and continued parsing
    after an arc. Record, path-point, and unsafe-numeric limits reject atomically before publishing
    a partial arc. A strict shared validator rejects non-dense slices, non-finite coordinates,
    forged semantic kinds, and inconsistent extrusion state in preview, inspection, statistics,
    and both renderers. The pinned classifier's nonzero-E rule is retained even for negative E;
    the bounded web adaptation substitutes finite width metadata where the upstream negative-E
    bridge formula can produce NaN. Twenty-two parser and six cross-consumer traces cover modal,
    arithmetic/ULP, malformed, subnormal, cap, suffix, identity, and compatibility behavior.
    Seam and exact color-print identity, authoritative time/estimate semantics, streaming
    partitions, and official reference corpora remain open.

- [~] **P7.4 — Implement official preview view types and filters.** Color by line/feature type,
  layer height, line width, speed, fan, temperature, volumetric flow, tool/filament, filament ID,
  and layer time linear/log. Provide accessible legends, ranges, units, clipping, role/tool
  visibility, and color-vision-safe alternatives.
  - Toggles cover travel, wipe, retract/unretract, seams, tool changes, color changes, pauses,
    custom G-code, shells, tool marker, and legend.
  - **Accept:** screenshot plus numeric-state tests compare every mode/filter at representative
    layers; no state is conveyed only by hue.
  - **Current:** a bounded headless projection covers the exact 12 pinned `EViewType` enum modes
    and emits compact record-index/value/validity/RGBA typed arrays. It composes role, physical
    tool, move/event, layer, record, and numeric-range masks; reports units and linear/log ranges;
    and builds coded, patterned, text-labelled legends so category/range state is not hue-only.
    Color-print mode fails closed without exact filament colors, layer-time linear/log fail closed
    without positive provenance-bearing processor durations, and incomplete parser prefixes remain
    explicitly limited. Eight tests cover every mode, filters, metadata gaps, caps, numeric state,
    and deterministic detached outputs. The live viewer now consumes that projection directly: a
    read-only preview session owns the parsed rich model, mode, layer window, and move-class
    filters; a one-way Three surface draws exactly the projected records with the projection's own
    RGBA and never intercepts picking; and an accessible DOM panel exposes all twelve modes, the
    layer sliders, single-layer mode, move filters, the coded/patterned legend, the numeric range
    with its unit and scale, and the exact reason a mode is unsupported. Arc interpolation expands
    only inside the render surface, duplicating the one projected record's exact RGBA onto every
    edge. Renderer/transform/sidecar limits clear stale geometry, restore model view, expose an
    actionable reason, and retain the layer/move controls needed to narrow a failed preview.
    Exact live tool colors, seams, shells, tool-marker rendering, sequential playback controls,
    screenshots, XR, and official golden output remain open.

- [~] **P7.5 — Add layer and sequential-move inspection.** Dual-handle layer/Z range, single-layer
  mode, sequential move range/playback, keyboard/controller shortcuts, custom G-code ticks,
  visible tool marker, camera focus, and optional synchronized G-code line window.
  - **Accept:** slider endpoints and playback select exact reference segments, remain usable by
    keyboard/touch/XR, and announce values accessibly.
  - **Current:** a bounded headless inspection model derives record-bearing layer/Z endpoints and
    unrenumbered sequential IDs from the rich typed columns. It composes layer, one-layer, record
    visibility, and move-span selection; emits accessible handle/cursor labels; and provides exact
    step plus directional, wrap-aware bounded playback sequences. Custom, pause, tool-change, and
    color-change ticks retain their layer, Z, source line, and half-open offsets. Optional state
    projects the current tool marker, geometric camera-focus bounds, and a line/character-bounded
    source window synchronized to the selected rich record without retaining the whole G-code in
    inspection state. Incomplete parser prefixes remain explicitly limited and malformed models,
    masks, ranges, source lengths, and playback requests fail closed. Eight tests cover endpoint
    identity, one-layer behavior, composed filters, ticks, source windows, stepping/playback,
    focus bounds, caps, immutability, and malformed/incomplete inputs. Arc focus includes every
    retained interpolation point without renumbering the sequential record or cursor endpoint.
    Live layer sliders and single-layer mode now drive that model from the DOM preview panel and
    announce their value.
    Ticks are rendered: every pause, colour change, tool change, and custom event in the artifact
    is listed with its layer and height, and choosing one moves the layer window to it. Each is
    reported at the height its layer prints at rather than at the record's own Z, which is
    wherever the toolhead happened to be when the marker was emitted. Fixing that surfaced a real
    defect in the layer index: it took the maximum Z over every record, so a retraction Z-hop on a
    travel overstated the layer height by the hop — layer heights now come from extrusions, with
    the observed Z retained only for a layer that prints nothing.
    Sequential move playback, tool-marker rendering, artifact-bound source plumbing,
    camera focus integration, controller/touch/XR interaction, screenshots, accessibility review,
    and official golden G-code remain open.

- [~] **P7.6 — Show complete statistics and conflicts.** Normal/silent estimates where available;
  prepare/model/total time; per-role/tool and model/total filament length/volume/weight/cost;
  layer/tool-change counts; plate/all-plate overview; purge/wipe amounts; warnings and conflicts.
  - Trace each number to parser/engine metadata and display assumptions such as density/cost.
  - **Accept:** statistics compare to official outputs within documented tolerance for golden
    fixtures and never reuse stale plate/profile results.
  - **Current:** a versioned headless projection contract now requires statistics captured in the
    same engine export as the G-code. An opaque verified-source handle is created only after a
    streaming SHA-256 pass over the exact `TextEncoder`-compatible UTF-8 output and parsing that
    same text, so rich observations cannot be paired with different bytes. Bindings require job,
    plate, and source revision plus canonical FNV-1a64 source/source-asset identities, SHA-256
    submitted-project/effective-config/G-code-output/engine-artifact identities, and the full engine
    commit. The JSON sidecar and every nested row use exact keys, canonical dense arrays, hard caps,
    bounded text/IDs, and finite arithmetic; malformed prototypes, sparse/cyclic/extra data,
    overflow, stale schemas, and forged verification/projection handles fail closed.

    Normal and optional silent planner time carries prepare/model/total, layer, move, role, ordered
    custom planner segments, and the processed `plannerBlockCount` used for a float32 accumulation-
    error reconciliation bound; move rows are a bounded subset, role/layer partitions cover total,
    and model time uses the pinned float32 subtraction before all-plate summation. Repeated custom
    kinds and remaining-before-subtraction semantics are preserved; a nonempty segment sequence must
    cover planner total, while the final synthetic tail is conditional rather than assumed. Exact
    per-tool model/support/wipe-tower/flush/total volumes plus `volumeSampleCount` use a separate
    double-accumulation reconciliation bound, and filament assumptions drive derived length, weight,
    material cost, normal-time cost, and total cost. The required sparse role-by-tool extension must
    completely reconcile each tool's model + support + wipe-tower volume, excluding flush. Missing
    positive-volume diameter/density/price,
    cost unit, time rate, or planned count is a strict leaf omission and propagates `null`, never a
    displayed zero. Rich typed columns remain labeled warning-free/degraded/prefix observations,
    never planner estimates.

    Conflict results distinguish exhaustive clear, non-exhaustive detected, not-run, and unsupported
    coverage with typed object/wipe-tower subjects; the pinned checker can report at most one detected
    conflict, so a finding is explicitly partial rather than exhaustive. All-plate projection requires
    one job/source/engine snapshot, groups by physical tool plus stable profile fingerprint, retains
    plate-scoped planner segments and rate assumptions, exposes mixed silent availability as partial,
    rejects mixed cost units, and does not invent a global layer/event timeline. If only some plates
    provide pricing metadata, it retains the sole known cost unit for labels while affected aggregate
    costs remain unavailable. Fourteen statistics tests plus five streaming-hash tests cover exact
    formulas and identities, UTF-8 chunk/surrogate semantics, planner reconciliation, conditional
    custom tails, role/tool completeness, observation degradation, omission propagation, conflict
    coverage, hostile shapes/caps/arithmetic, tool/profile aggregation, cost units, partial silent
    availability, immutability, and stale/incompatible/forged inputs. The WASM/native and external-
    server producers still discard or omit this sidecar. A WASM entry point for it was reverted
    because it referenced an engine header that exists only in a developer worktree, was never
    built into the checked-in artifacts, and therefore broke artifact provenance; landing it
    requires a committed `wasm/patches` entry, a rebuild, and a provenance update.

    A separate, weaker source is now live so a finished slice reports something honest today: the
    totals the engine writes into the artifact itself. `GcodeArtifactSummary` reads — never
    recomputes — per-tool filament length/volume/weight, total weight and cost, the tool-change
    count, the engine's own layer total, and the normal-mode time estimates, and the preview panel
    shows them beside a colour swatch whose identity is carried by the tool number and material
    rather than the colour. A figure the artifact never stated stays absent instead of displaying
    zero, an unrecognised duration is not guessed at, and only the trailer is scanned because that
    is where the engine writes these. This deliberately carries no per-role breakdown, cost unit,
    or engine-identity binding, so it does not satisfy the verified sidecar contract above. It did
    replace the slice status line's own layer count, which counted layer-change markers and
    disagreed with the engine's total by three on the smoke fixture. Canonical route binding, authoritative
    profile-to-tool fingerprints and cost-unit preferences, imported-output support, live plate/all-
    plate UI, official golden tolerances, screenshots, and accessibility review remain open.

- [~] **P7.7 — Complete output lifecycle.** View imported G-code, reslice after changes, retain
  per-plate results, download/export named artifacts, upload-only, send-and-print, and invalidate
  results precisely when project/profile changes affect them.
  - A result badge shows sliced revision and target printer/profile. Prevent sending stale or
    incompatible G-code unless the user explicitly revalidates it.
  - **Accept:** dirty-state matrix proves which edits invalidate which result; standalone G-code
    works without a model project; outputs from every route pass bounds/tool/temperature checks.
  - **Current:** standalone G-code opens read-only in the viewer through its own registry action
    and picker: it parses into the bounded rich model, drives the same preview projection as a
    slice result, and leaves the canonical project revision untouched, which a production browser
    pass asserts. Published slice artifacts remain bound to their exact semantic snapshot and fail
    closed after drift. An all-plate slice now retains one guarded result per plate and downloads
    each as its own named artifact. The sliced-revision/printer badge, an explicit revalidation flow
    before send, remaining export variants, and the full dirty-state matrix remain open.

- [~] **P7.8 — Author layer custom-G-code events and filament sequences.** On the layer slider,
  add/edit/delete pause, custom G-code, color/filament change, template, and other event types
  exposed by the pinned `IMSlider`; edit first-layer and per-layer tool/filament sequences where
  upstream permits them.
  - Resolve physical and virtual filament IDs through the canonical library and preflight. Show
    event badges/ticks, exact Z/layer, command preview, conflict warnings, and one undo transaction.
    Persist events and plate sequences in BBS 3MF and feed the engine rather than patching an
    already generated file invisibly.
  - **Accept:** each event survives save/open and appears at the expected parsed G-code location;
    delete/undo/cancel are exact; incompatible FullSpectrum/tool events block with a useful fix.
  - **Current:** authored events are canonical, guarded, and reach the engine. Each carries the
    engine's own facts — type, exact `top_z`, tool, colour, and the pause message or custom body —
    and is stored by height rather than by layer index, so a later layer-height change moves the
    event with the model instead of leaving it pointing somewhere else. Add, edit, and delete are
    one reversible command each, validated closed: a custom event needs a body, the profile-driven
    kinds must not carry one, colour and tool changes need a 1-based tool, and a plate refuses two
    events at the same height. The serializer now projects them into the engine's own
    `Metadata/custom_gcode_per_layer.xml` (numeric `type` codes plus the legacy `gcode` attribute
    older readers key off) and reads that file back, so a foreign Orca project's events import and
    an OrcaXR project's events are honoured by the slicer instead of living only in the OrcaXR
    envelope. The inspector panel offers only the kinds the selected printer profile can actually
    perform, naming the missing setting (`machine_pause_gcode`, `color_change_gcode`,
    `template_custom_gcode`) for the rest rather than emitting a marker the machine ignores.
    The G-code preview closes the loop: it lists the artifact's own events as located ticks and
    authors a new pause or custom event at the exact height of the layer on screen, so a magnet
    pocket is placed by looking at the model rather than by converting a layer number into
    millimetres. Authoring drops the published artifact on purpose — it no longer matches the
    project — so the preview closes and the status line asks for a re-slice. Badges on the slider
    itself, filament sequences, MultiAsSingle tool-change events, and template bodies remain.

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

- [~] **P8.1 — Generate and map the calibration inventory.** Extract the `CalibMode` enum, menu
  exposure, dialog parameters, generated resource models, required per-height/per-object config,
  device-only steps, and result fields. At minimum cover pressure advance tower/line/pattern;
  flow-rate Pass 1/Pass 2 and YOLO variants exposed by the baseline; temperature tower; maximum
  volumetric speed; VFA; retraction; input-shaping frequency; damping/zeta; junction deviation;
  and documented tolerance tests.
  - **Accept:** every generated and wizard calibration in the pinned menus has a P8 disposition,
    with unsupported printer firmware features identified before UI exposure.
  - **Current:** an exact-Git generator verifies the pinned commit/tree and source/resource blobs,
    extracts all 11 non-`None` `CalibMode` values, maps all 14 pinned menu variants plus the
    documented non-enum tolerance extension, and records dialog defaults/constraints, resources,
    per-height/per-object/generated-G-code effects, result fields, preset targets, and device
    requirements. A strict recursively frozen runtime catalog and 30 mutation tests fail closed on
    schema/source/workflow drift. Proprietary Bambu automatic paths are explicitly blocked behind
    their firmware/device requirements; 11 current bindings are honestly classified as
    alpha-geometry-only and four remain unbound. Generator/workflow implementation and the
    cross-cutting P10/P12 qualification gates remain open.

- [~] **P8.2 — Build a shared calibration job model.** A calibration definition specifies
  printer/nozzle/filament/process prerequisites, parameter names/units/ranges/steps, generated
  geometry, per-band overrides/custom G-code, expected labels, slice validation, result schema,
  and how a chosen result updates a preset.
  - Keep values editable until generation; validate count, range, bed fit, temperatures, motion,
    and firmware commands. Generated bands must carry real engine overrides rather than visual
    labels alone.
  - **Accept:** unit tests inspect project graph and parsed G-code for every step value at the
    intended Z/object/line; invalid ranges cannot produce a job.
  - **Current:** a source-commit/fingerprint-bound headless catalog covers all 15 P8.1 workflows
    with strict parameter kinds, defaults, units, numeric ranges/steps, audited resource envelopes,
    printer/nozzle/filament/process/firmware prerequisites, result fields, and preset targets. Its
    deterministic manual-job compiler emits bounded immutable band/object/line effects, real
    engine overrides, flavor-specific pressure-advance/input-shaping/junction/temperature commands,
    labels, fit transforms, and machine-readable slice assertions. It rejects stale definitions,
    unknown/fixed/missing parameters, unsafe temperature or motion ranges, non-integral/excessive
    sweeps, bed/build/source overflow, and missing firmware capabilities; proprietary automatic
    execution fails closed. Nine focused tests compile every default workflow and cover formulas,
    conditional defaults, command flavors, detachment, and the failure matrix, and the full 38-file
    canonical-project suite passes. Canonical project-graph materialization, pinned resource/
    generated-geometry loading, parsed sliced-G-code oracles for every effect, live dialogs,
    result application, and preset mutation remain P8.2/P8.3 work.

- [~] **P8.3 — Implement all generic calibration generators and instructions.** Provide parameter
  dialogs, preview, regenerate, slice, inspect, export/send, measurement instructions, result
  entry, and “save to filament/printer/process preset” for every P8.1 generic mode.
  - Link contextually to the pinned docs. Preserve the user's original project in a separate
    tab/session or recoverable snapshot; cancellation must not overwrite it.
  - **Accept:** geometry and semantic G-code match official examples within documented tolerance;
    saved results modify the correct canonical option and create an undoable/versioned preset.
  - **Current:** result entry and “save to preset” exist.
    `project/calibration/application.ts` holds the result-to-preset mapping, written out per
    workflow rather than inferred, because the relationship is not one-to-one and guessing would
    write a real number into the wrong option: one temperature result feeds both
    `nozzle_temperature` and `nozzle_temperature_initial_layer`; a pressure-advance result is
    inert unless `enable_pressure_advance` goes with it; the two input-shaping workflows target
    `input_shaper.*`, which no slicer preset holds at all. Those last ones produce an explicit
    hand-off — the exact lines for the printer's own configuration — instead of an override,
    because reporting "applied" while writing nothing is the worst outcome available. A test holds
    the table against the pinned inventory in both directions and asserts that every declared
    preset target is either bound to a measurement or supplied as a companion, so the mapping
    cannot drift.
    Saving refuses a result whose conditions have moved, reusing P8.5's own check, and the write
    itself goes through the P6.4 preset library rather than a bespoke path: the result becomes an
    operator-authored preset overlaid on the currently selected base, with provenance, a version
    that bumps on each save, and the library's refusal of unknown or reserved keys all applying.
    Each value is coerced into the shape the base already uses, so a key the engine reads as a
    list stays a list.
  - **Missing:** parameter dialogs, preview, regenerate, slice, inspect, and export/send for the
    generic modes are not built, and neither are the contextual documentation links or the
    separate-session snapshot that protects the operator's own project. The saved preset is
    versioned but is device state rather than a canonical undo step, so "undoable" in the project
    sense is not met. Geometry and semantic G-code have not been compared against official
    examples, and no result in this path has been measured on hardware.

- [ ] **P8.4 — Implement the connected-printer calibration wizard where Moonraker exposes the
  outcome.** Cover printer/preset/filament selection, compatibility checks, start/progress,
  coarse/fine stages, live result collection or manual entry, save, cancellation, recovery, and
  history.
  - Vendor-proprietary automatic measurement without a Moonraker equivalent must remain an
    explicit adaptation/blocker; provide the generic printed-test path for the same tunable
    parameter, not a fake automatic result.
  - **Accept:** supported U1/Elegoo workflows survive disconnect/reconnect and save traceable
    results; unavailable automation is clearly distinguished from manual calibration.

- [~] **P8.5 — Add calibration history and comparison.** Record printer/firmware/nozzle,
  filament/preset hashes, method, parameters, G-code/project hash, measurement, chosen result,
  operator, date, and linked preset version. Support inspect, compare, re-run, export, and delete.
  - **Accept:** results never auto-apply to a mismatched printer/nozzle/material; migrations and
    deletion are tested; secrets/device tokens are excluded from exports.
  - **Current:** `project/calibration/history.ts` is the ledger, and the thing it exists to
    prevent is a number being reused where it does not hold: a pressure-advance value measured on
    a 0.4 mm nozzle in PLA is simply wrong on a 0.6 mm nozzle in PETG, and applying it silently is
    worse than never calibrating. So every record carries the conditions it was measured under —
    printer model, firmware flavor and version, nozzle, material, and the filament and process
    preset hashes — and `assessCalibrationApplicability` names each mismatch instead of returning
    a boolean. Printer, nozzle, material, and filament preset block; a firmware bump is reported
    and does not. Applicability is judged against the *live* profile on every redraw, so changing
    nozzle or filament invalidates the affected rows immediately without removing them: a record
    that no longer applies is still evidence.
    A record is written once and never edited — correcting a measurement means recording another
    run — and its identity is the hash of its own content, so the same evidence recorded twice is
    one record rather than two. Recording refuses anything that would be unreadable later: a
    missing required field, a measurement the method does not define, or a chosen value that was
    never measured. Re-running is bound to the method's fingerprint, because recompiling old
    parameters under changed geometry would produce a number an operator would compare against the
    old one as if nothing had moved. Comparison reports per-parameter and per-measurement
    differences with a real delta only when both sides are numbers, and states the caveats that
    make two runs incomparable.
    Exports are deterministic and provably free of secrets: the record type has no field for a
    host or a token, and the exporter additionally walks the payload and refuses anything
    credential- or address-shaped rather than writing it. The stored form is the export form, so
    the same scan covers both. A schema-0 ledger — recorded before conditions were tracked —
    migrates forward with its conditions marked unknown, which keeps the history readable and
    comparable while making it permanently inapplicable; inventing conditions would be a lie that
    later auto-applies.
  - **Missing:** writing a chosen result into a filament, printer, or process preset is P8.3's
    "save to preset" work and is deliberately not done here, so `presetTargets` are recorded but
    never acted on. Re-run reports that a method is unchanged rather than compiling and staging the
    job, which needs the prerequisite derivation P8.3/P8.4 own. Importing a shared ledger has no UI
    control, the surface is DOM only, and no run in it has yet been taken on hardware (P8.6).

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

Local seams: the typed [`printer` transport](../web/src/printer/index.ts), bounded
[`MoonrakerFilamentSlots.ts`](../web/src/printer/MoonrakerFilamentSlots.ts), non-secret
[`PrinterEndpointPreferences.ts`](../web/src/printer/PrinterEndpointPreferences.ts), and
[`WebcamSession.ts`](../web/src/features/WebcamSession.ts). The superseded probe/send/client
implementations were removed when read-only live wiring moved to the typed boundary.

- [~] **P9.1 — Implement a secure, typed Moonraker connection service.** Manual URL, optional
  same-origin proxy, API key/auth flow, TLS validation guidance, capability discovery, version
  negotiation, WebSocket subscriptions, reconnect/backoff, heartbeat, cancellation, and
  structured errors feed one connection state machine.
  - Printer credentials use browser credential protection or session-only memory by default;
    never plaintext `localStorage`. Redact them from logs, diagnostics, URLs, and analytics.
  - **Accept:** mocked protocol tests cover auth, forbidden, version skew, disconnect during every
    mutation, stale event ordering, reconnect, cancellation, and redaction.
  - **Current:** a UI-independent typed transport provides explicit endpoint/same-origin-proxy
    normalization without scheme/port probing, session-only API-key/bearer credentials, bounded
    redacted diagnostics, version/capability handshakes, cancellable timeout-bounded HTTP,
    WebSocket subscriptions, stale-generation rejection, heartbeat, and reconnect/backoff with
    focused protocol tests. DOM Test Connection and read-only filament inspection invoke it only
    through `ActionRegistry`; only endpoint/port persist, known legacy stored API keys are purged,
    and changing endpoint or session credentials disposes the connection. Multi-printer setup,
    complete auth/TLS guidance, mutation fault matrices, and printer evidence remain open.

- [~] **P9.2 — Add printer setup, discovery, and multi-printer management.** Support named manual
  endpoints, local-network discovery only with explicit permission and viable browser/proxy
  support, capability/profile association, default printer, online/offline state, edit/remove,
  and fast switching without state leakage.
  - Avoid misleading browser subnet scans where platform restrictions prevent reliable results.
    Explain the proxy/manual alternative.
  - **Accept:** U1 and Elegoo CC can be added from a clean profile, reconnect after reload, switch
    safely, and retain independent queues/cameras/tool maps.
  - **Current:** `printer/PrinterDirectory.ts` holds named printers with one default, stored beside
    the other device settings. Each entry owns its address, its credential, and its reported
    capabilities and tool count; switching rebuilds the transport rather than reusing it, so no
    socket, key, or cached capability crosses from the machine that was selected before. A key that
    follows a switch is a key sent to the wrong printer, which is the failure this shape exists to
    prevent. Removing a printer deletes its credential with it, and removing the default promotes
    another rather than leaving an id that resolves to nothing at send time.
    An install configured before printers had names keeps working: its single endpoint is adopted
    as the first entry rather than dropped. A duplicate address is refused in both add and edit,
    because two entries for one machine each hold their own credential with no way to tell which a
    job used.
    Discovery is reported as unavailable rather than faked. A browser cannot enumerate a subnet, and
    a Scan button that finds nothing reads as "you have no printers" — a worse answer than saying
    the platform cannot do it — so `describeDiscovery` names the manual and proxy alternatives
    instead.
    Verified in the production browser with both machines: added from a clean profile, each keeping
    its own address and key across switches, and both present with the default selected after a
    reload.
  - **Outstanding:** capability and tool count are stored but nothing writes them yet from a live
    handshake, so they are populated only by explicit update; per-printer queues, cameras, and tool
    maps are not separated because none of those exist per-printer yet; profile association is not
    wired, so switching a printer does not switch the machine profile; and the acceptance names
    hardware qualification on both machines, which needs the printers in front of someone.

- [~] **P9.3 — Build pre-print selection and tool mapping.** Select printer/storage destination;
  refresh state; map every physical/mixed dependency to available head/tool/spool; validate
  printer model, bed/nozzle, material, firmware, storage, temperatures, and profile; choose
  upload-only or print; show progress and cancellation.
  - Present applicable options such as leveling, timelapse, and firmware macros only when the
    Moonraker capability manifest proves them. Do not imitate unsupported AMS/cloud toggles.
  - **Accept:** mapping is required for ambiguous/mismatched jobs; unsafe or out-of-bounds G-code
    blocks; upload cancel/retry does not start a partial file; virtual dependencies resolve to
    the intended U1 heads.
  - **Current:** a bounded query parses the Snapmaker Moonraker filament extension and preserves
    sparse physical slot identities such as H1/H3. The operator can now adopt those slots into the
    project as one undoable command: colour, type, vendor, and the machine's finer grade are
    written onto the matching tools, and a reported slot the project has no tool for is *added*
    rather than counted — a four-slot U1 could otherwise never be imported into a one-tool
    project, since the sync only ever recoloured tools that already existed and the button that
    ran it was hidden below two extruders. The reverse is reported, never done: a tool the printer
    did not report is kept, because objects may be assigned to it and an empty slot is no reason
    to strip those assignments. The grade stays out of `material`, which becomes `filament_type`
    in the exported 3MF and is matched against the pinned compatibility table; it rides in the
    filament name instead, and a machine that reports only a bare type never renames a richer
    project name to a poorer one. Verified against a real Snapmaker U1 over its Moonraker
    extension — four PLA slots of three grades — whose response is pinned as a parser fixture.
    Send-time mapping is now real and read-only: the artifact's own tool changes are compared
    against the loaded slots, a tool with no loaded filament blocks starting the print, and
    material/colour differences are reported as warnings the operator confirms. A printer that
    does not expose the slot object yields an explicit "not reported" warning for multi-tool jobs
    rather than a silent pass. Material comparison folds both sides to families, so a PLA-CF
    artifact matches a slot the printer reports as PLA. Destination/storage selection,
    multi-printer choice, firmware and
    bed/nozzle compatibility, and capability-proven leveling/timelapse options remain.

- [~] **P9.4 — Complete upload, queue, and print lifecycle.** Upload with atomic/unique naming,
  overwrite confirmation, progress, checksum/size verification, start, queue/reorder/remove,
  pause, resume, cancel, emergency-stop boundary, and completion/failure notification.
  - Use the Moonraker [file](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/)
    and [queue](https://moonraker.readthedocs.io/en/latest/external_api/job_queue/) APIs; make
    mutating confirmations and idempotency explicit.
  - **Accept:** integration tests use a Moonraker simulator; supervised hardware tests cover
    upload-only, print, pause/resume, cancel, reconnect, filename collision, and printer rejection.
  - **Current:** the guarded artifact for the active plate can be sent through the shared registry
    action. The flow reads printer state and loaded filaments, confirms the exact file, size, and
    tool mapping in a focus-trapped dialog, sanitizes the filename, and picks an unused name unless
    replacement is explicitly opted into. Upload progress is announced per phase, the send is
    cancellable from the same control that started it, and the stored size is verified against the
    submitted bytes before anything starts. Uploading and starting are separate buttons: a start is
    refused outright when Klipper is not ready or the machine is busy, while queueing a file during
    a running print stays allowed. The production smoke now drives the whole path against a real
    HTTP Moonraker simulator: a multicolor plate is sliced in the browser, a printer missing T1
    blocks the start while still allowing storage, cancelling uploads nothing, upload-only never
    starts a job, a second send of the same plate lands on an unused name, and the started file is
    byte-identical to the artifact. Note the operational precondition this surfaces: the page
    talks to the printer cross-origin with an `x-api-key` header, so Moonraker must list the exact
    page origin in `cors_domains` or every send fails at the preflight.
    Pause, resume, cancel, and the emergency-stop boundary are live as registry actions whose
    availability comes from the printer's own reported state, so a job started at the machine is
    as controllable as one sent from here. Each command is checked twice — the registry gates it
    on the state the panel is showing, and the transport call re-reads the machine and refuses if
    it has moved on to a different file — and the two irreversible ones stop at a confirmation
    that sends nothing when dismissed and never starts with focus on the destructive button. The
    emergency stop is deliberately available even when Klipper is down and every other command is
    refused, and its dialog states that Klipper stays halted until a firmware restart. Queue
    management (reorder/remove) and completion notification remain;
    hardware qualification is pending. The XR shell
    still reports the send path as unavailable in that shell rather than offering a half-wired
    confirmation, in line with the rest of the printer surfaces there.

- [~] **P9.5 — Implement live Status and Monitor outcomes.** Show state, file/thumbnail, overall
  and layer progress, elapsed/remaining/finish time, temperatures/targets, fans, speed/flow,
  axes/homing, load/unload when supported, lights, errors, and recovery actions. Controls declare
  capability and safe ranges before enabling.
  - Provide Storage (browse, upload, download, print, rename/move/delete with confirmation,
    metadata/thumbnails) and Moonraker update-manager status/check/update actions where the
    printer exposes them. Updates require explicit compatibility, power/state, progress, failure,
    reconnect, and recovery UX; otherwise offer information and the supported admin destination.
  - **Accept:** event-driven UI agrees with queried state, survives reconnect and background tab,
    announces critical changes accessibly, and never offers an unsupported command.
  - **Current:** a typed live model reads exactly the Klipper objects it declares
    (`webhooks`, `print_stats`, `virtual_sdcard`, `display_status`, `extruder`, `heater_bed`),
    seeds from one explicit query, then folds in `notify_status_update` pushes — partial patches
    merge field-by-field, so a nested layer update never drops the total. A field the printer does
    not report stays absent instead of defaulting, and the panel renders an em dash rather than a
    zero, because "0 %" and "not reported" are different facts. Remaining time is labelled as an
    approximation and withheld entirely below 2 % progress, where extrapolating from heat-up would
    be false precision. The inspector panel shows state, file, layer, nozzle/bed temperatures with
    targets, and a progress bar, and it re-seeds on reconnect so a dropped socket cannot leave a
    stale "printing" readout.
    Storage is now the other half of that panel. `printer/PrinterStorage.ts` browses the printer's
    own `gcodes` root through Moonraker's directory API rather than the flat list, because a
    machine that has been in service a while has folders and flattening them turns "which of these
    did I slice" into a scrolling exercise. A selected file shows the facts the printer itself
    scanned — size, estimated time, filament weight, slicer, and the slicer's own thumbnail — and a
    file it has never scanned shows an em dash for each, because "0 min" reads as a claim that a
    print takes no time. From there a file can be printed without re-slicing or re-uploading a
    byte, renamed in place, downloaded, or deleted behind a confirmation that states the file may
    exist nowhere else.
    Two rules make that safe. Every operation carries the exact path the last listing returned, so
    a delete cannot land on a neighbouring row if the folder changed underneath; and a path that
    would step outside the root is refused here rather than sent, so the request is never made.
    Thumbnails and downloads go through the transport's own authenticated fetch — putting the API
    key in a URL is refused by the transport, and an `<img>` pointed straight at the printer has no
    other way to authenticate.
    Fans, speed/flow, axes/homing, load/unload, lights, upload-from-disk, folder creation, and the
    update-manager surfaces remain.

- [~] **P9.6 — Add camera, console, macros, and history.** Discover webcam endpoints; render
  snapshot/MJPEG/WebRTC as supported with visibility-aware polling; provide G-code console with
  history and explicit dangerous-command confirmation; list/run macros with schema/parameters;
  show print history and statistics.
  - Treat printer-host content as untrusted; enforce CSP and safe media/URL handling.
  - **Accept:** simulator and hardware cover camera unavailable/recovery, macro errors, command
    redaction, history pagination, and narrow/XR layouts.
  - **Current:** the console is live, and the interesting work in it is knowing what a command does
    before it is sent. `printer/PrinterConsole.ts` classifies a script as reporting, moving/heating,
    or damaging, naming the exact consequence — `M84` releases the steppers and an unbraked Z axis
    can drop; `M112` leaves Klipper shut down until a firmware restart; `FORCE_MOVE` bypasses the
    kinematics. Three rules make that classification trustworthy rather than decorative. **Unknown
    is not safe**: anything the table does not recognise, including every user macro, is `caution`,
    because a console that stayed quiet about commands it had never heard of would be silent
    exactly where it matters. **Context is part of the answer**: `G1 Z10` is unremarkable on an idle
    machine and reckless mid-print, so the running job is read into the assessment rather than left
    to the caller. And a multi-line script takes the level of its riskiest line, because someone
    confirming a batch is confirming all of it.
    Only a reporting command sends straight through; everything else states its consequences and
    sends nothing if the confirmation is dismissed.
    Macros come from the printer's own `configfile.settings`, and their parameters are read out of
    each macro's body — `{params.SPEED|default(300)}` yields an optional `SPEED` of `300`, a bare
    `{params.LENGTH}` a required one. Klipper has no schema to ask for, and inventing one would
    describe a macro that does not exist. A macro's risk is its body's risk, so one that restarts
    the firmware is dangerous however innocuously it is named.
    Printer replies are untrusted host content: they arrive over `notify_gcode_response`, are
    redacted and length-bounded on the way into a bounded transcript, and are inserted as text and
    never as markup. The transcript is redacted on entry rather than at render time because it is
    copied into support bundles, where a value only hidden by the renderer has already leaked.
    Print history is live beside it. `printer/PrinterHistory.ts` pages the printer's own job record
    — filename, outcome, how long it actually printed, how much filament it used — and drives its
    pager from the count the printer reports rather than from how many rows happened to arrive,
    which is what keeps the last page reachable. Each completed run is compared with the slicer's
    own estimate as a signed percentage, but only when both numbers exist and the estimate is
    positive: a ratio against a missing estimate says nothing. A job Klipper never finished reports
    no duration and no filament rather than zeroes, an `end_time` of 0 reads as "not ended" instead
    of 1970, a file since deleted from the printer says so, and an outcome this build has never
    heard of is shown verbatim rather than relabelled.
    The camera completes the set, and how to show one was the decision that mattered. An `<img src>`
    or a `<video src>` pointed at the printer cannot carry the `x-api-key` header, so on any printer
    that requires one the feed would simply be a broken image — and the only way to make it load
    would be to put the key in the query string, which the transport refuses on purpose. Every
    camera is therefore rendered the one way that keeps the credential in a header: authenticated
    snapshots fetched as bytes and swapped into an object URL. Live MJPEG, WebRTC, and HLS are
    reported as unsupported with that exact reason rather than half-offered — `ADAPT-12`.
    The polling policy is part of the feature rather than an implementation detail, because every
    frame is its own request. The declared frame rate is capped at 4 fps, and the timer stops the
    moment nobody is watching: a hidden tab, a collapsed section, a disposed panel. A URL the camera
    list points at another host keeps only its path, so the page cannot be turned into a request
    forwarder by printer-host content, and a rotation or flip the camera declares is reproduced so
    the picture matches how the machine is actually mounted.
  - **Missing:** the console, macros, history, and camera are DOM only; XR has none of them. Live
    stream transports, history deletion and filtering, and supervised hardware qualification remain.

- [~] **P9.7 — Make printer workflows first-class on mobile and XR.** A compact status surface
  stays glanceable without obscuring preparation; critical cancel/stop actions are reachable but
  resistant to accidental activation; session loss has clear recovery.
  - **Accept:** send, monitor, pause/resume, and cancel complete with touch and XR controllers on
    reference devices, with the same safety confirmations and state as desktop.
  - **Current:** what a compact surface has to say lives in
    `printer/PrinterStatusSummary.ts`, and both a phone bar over the plate and a spatial card
    render it, so the two cannot drift. It presents itself only when something is happening, has
    gone wrong, or can no longer be confirmed — idle and connected stays out of the way, because
    obscuring preparation is exactly what a status surface must not do.
    Session loss is the part that changed behaviour elsewhere: the transport used to discard the
    job snapshot the moment the socket dropped, which threw away the most useful thing on screen
    mid-print. The last reading is now kept and labelled with its age, the recovery line says
    whether anything is retrying and when, and every lifecycle command is refused while it lasts
    — acting on a state nothing can confirm is guessing, and a pause that may not have arrived is
    worse than no pause. Both surfaces read that one answer, so the desktop panel cannot offer a
    command the phone refuses.
    Destructive commands are reachable but not trippable: pause and resume are one tap because
    being slow to reach them costs prints, while cancel and emergency stop are *held* — 800 ms and
    1200 ms — with the consequence stated during the hold, progress drawn as it fills, and nothing
    sent at all if it is released early or abandoned. A hold is the one confirmation gesture a
    thumb, a mouse, and a controller ray perform identically, and it replaces the desktop dialog on
    that surface rather than stacking on top of it (`ADAPT-13`).
  - **Missing:** the spatial card is built and driven from the same summary, but no XR hardware or
    simulator pass covers it, so controller-ray hold ergonomics, reach, and legibility are
    unproven. Sending and monitoring from XR still route through the DOM shell, and the reference
    -device qualification the Accept clause requires — touch and controllers on the Galaxy XR and a
    phone — remains.

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
  Core routes scene-gesture select lifecycle events to scripts; do not bind duplicate controller
  `selectstart`/`selectend` manipulation handlers. The only native `XRSession` `select` exception
  is the lifecycle-disposed synchronous file-picker activation listener; it must never mutate the
  scene and remains in the P10.10 instrumentation scope. Test release-off-target and overlapping
  controls.
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
  XRBlocks is the sole scene-gesture select dispatcher, with only the synchronous file-picker
  activation exception above. `OrcaWorkspace` owns one capability subscription; its idempotent
  disposal removes cards, subscriptions, controls, listeners, and owned GPU resources, and any
  descendant card hit suppresses scene manipulation. Hidden scripts can still auto-tick.
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
    Menus support keyboard navigation, and modal dialogs provide role/labels, Escape, focus trap,
    and focus restoration. Canonical workflow coverage and all required manual assistive/input
    reviews remain open.

- [~] **P10.3 — Complete shortcuts and command discovery.** Generate the shortcut catalog from
  action capabilities; cover global, Prepare, gizmos, Objects, and Preview behavior; allow safe
  remapping/conflict resolution; show context-specific help; support `1–9` filament assignment
  and preview slider controls where applicable.
  - Browser-reserved shortcuts receive discoverable alternatives. Keyboard actions obey current
    text-field/dialog context and never trigger destructive commands invisibly.
  - **Accept:** shortcut manifest maps every upstream outcome or adaptation, automated key tests
    pass, and the help dialog is current by construction.
  - **Current:** a strict catalog is generated from `ActionRegistry` shortcut declarations,
    normalizes exact modifier/key chords, rejects malformed or conflicting ownership, and ignores
    repeat/composition/partial chords. The composition-root dispatcher and generated Help table
    consume that catalog, and rendered controls expose the same declarations through
    `aria-keyshortcuts`; four focused tests pin every current gesture and platform alternative.
    Complete upstream mapping/context scopes, safe remapping, browser alternatives, `1–9`
    assignment, preview controls, and XR qualification remain open.

- [~] **P10.4 — Provide complete localization infrastructure.** Extract UI/help/errors, use
  message IDs with plural/number/unit/date formatting, allow runtime language switch, avoid
  fixed-width strings, and test pseudo-localization. Support RTL layout where web primitives
  make it feasible; document any geometry-direction exception.
  - **Accept:** no user-facing strings escape extraction except fixture/model data; pseudo-long
    and RTL runs have no clipped critical controls; locale never changes config serialization.
  - **Current:** only the last clause is met, and it is the one with teeth. Canonical ordering used
    `localeCompare` in eleven files, which collates by the *runtime's* locale — 'ä' sorts after 'z'
    in Swedish and with 'a' in German — so anything ordered by it that reaches a saved project made
    the bytes depend on the machine that produced them. Two operators would get different files
    from the same project, and a hash-guarded artifact would disagree with itself across a locale
    change. All eleven now use `compareCanonicalText`, which orders by code unit.
    Three guards keep it that way: the same project serialises to identical bytes under a stubbed
    foreign collation, the fingerprint does too, and a source scan fails the build on any new
    `localeCompare` under `src/project/`. The scan matters most — the byte tests only catch a leak
    the fixture happens to exercise, and the next one added may sort user-supplied names where the
    difference is real.
  - **Outstanding:** everything else. There is no message catalog, no message IDs, no extraction, no
    runtime language switch, no plural or unit formatting, no pseudo-localization run, and no RTL
    support; every user-facing string is still an English literal at its use site. This is the
    largest untouched item in the plan and needs a dedicated pass, not an increment.

- [~] **P10.5 — Qualify XR as a complete surface.** World scale, origin/recenter, seated/standing
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
  - **Current:** the structural half — "make the full action catalog reachable in menus/panels"
    and "gate XR actions using the same capability/selection state as DOM" — now holds and is
    enforced. It did not before: 54 of 195 actions, which is every printer, preset, calibration,
    and settings control, reached no XR surface and declared no reason. That is
    indistinguishable from an oversight, and it was one. Inspector-disclosure actions now derive
    an `xr-inspector` surface unless they declare `xrUnsupportedReason`, the XR menu bar grows a
    Panels section that renders them grouped by action group, and every row is gated through the
    same `registry.availability` call the DOM uses, so an action disabled on a screen is disabled
    in the headset for the same stated reason. Two registry tests hold the invariant: no action may
    be absent from XR without saying so, and a declared refusal must be a real sentence that does
    not also claim an XR surface. 25 actions remain deliberately unsupported, each with its reason.
  - **Missing:** everything that needs a headset. World scale, origin and recenter, seated and
    standing reach, dominant hand, ray versus direct interaction, manipulator precision, text
    entry, scrolling a long Panels list, dialogs, tooltips, haptics, occlusion, contrast, comfort,
    and session lifecycle are all unqualified, as is the 95%-of-frames budget. Reachability is not
    usability: these rows are now *present* in XR, but no one has yet confirmed they can be read or
    hit from a headset, and the DOM panels behind several of them (printer storage, console,
    camera, presets, calibration) still have no spatial equivalent beyond invoking their action.

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
    queue/jobs/rates/time, cancels process trees, and redacts public responses and logs. Browser
    AI secrets and typed Moonraker credentials are session-only; legacy plaintext AI keys and
    printer API keys are purged, only non-secret endpoint preferences persist, and transport
    errors/diagnostics are bounded and redacted. A saved external-slicer URL is not consent:
    routing is enabled only after a successful probe backed by explicit opt-in, replacement
    disables the old route before probing, failed replacement stays local, and disable/clear
    invalidates in-flight probes.
    Printer mutation now uses the same typed boundary behind explicit confirmation, artifact/tool
    mapping, unique-name/replace policy, stored-size verification, and state-derived lifecycle
    guards; cancel/emergency-stop re-read the live job before acting. Queue/storage mutations,
    reconnect-during-transfer and hardware qualification remain open. The hostile XML/G-code/
    client SSRF/license/static-scan matrix plus production threat review also remains open.

- [~] **P10.8 — Add offline/PWA and recovery guarantees.** App shell, profiles, help, local
  editing, save/export, and already-downloaded assets work offline; slicer update caching follows
  the repository's NetworkFirst rule. Autosave uses versioned snapshots with quota handling,
  crash recovery preview, explicit discard, and corruption fallback.
  - **Accept:** offline reload completes supported work; update never mixes incompatible worker/
    WASM/schema versions; forced crash/quota/corruption restores or clearly reports last safe data.
  - **Current:** app-shell/icons are precached; runtime content is NetworkFirst; slicer artifacts
    use a separate bounded cache; production offline reload is tested. A versioned, size-capped
    IndexedDB autosave ring skips unchanged revisions, prunes/retries on quota pressure, validates
    snapshots before offering the newest recoverable entry, falls back past corruption, and keeps
    recovery/discard explicit in headless tests. Composition-root capture/recovery UI, forced-crash
    qualification, and worker/WASM/schema atomic-update guarantees remain open.

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
  - **Current:** XRBlocks/UIKit and 98 Material SVGs are exact/local; typed signal setters, shared
    capability state, a seven-action finite rail plus menu overflow, CSP, and offline icon tests
    pass. An exact `UIPanelProperties`/`UIImageProperties` adapter now owns construction and
    signal-aware mutation for the registry action-button composite; its enabled, selected, busy,
    hover, destructive, and disposed states are guarded and headlessly tested without option-bag
    casts. Dialog, paged-list, progress/status, field, and broader card composites, the component
    gallery, visual review, and Galaxy XR review remain open.

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
  - **Current:** duplicate manual card updates/select manipulation handlers are removed. UI
    suppression is sticky from press through release per controller, controllers remain
    independent in unit coverage, and manipulation/painting targets the actual hit model rather
    than a first-model fallback. Input ownership now exposes exact start/update/end,
    allowed/suppressed-transition, active-controller, and UI-owned-controller snapshots; disposed
    guards reject stale events. Registry action handles invalidate callbacks idempotently before
    workspace teardown, and the DOM-dialog-only printer submission action is withheld from the XR
    menu with an explicit XR-native-confirmation requirement. The narrowly scoped native
    file-picker `select` listener remains an instrumented exception. Per-frame script/card counters,
    broader overlap/modal/release cases, retained-growth traces, simulator, and Galaxy XR evidence
    remain open.

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

- [~] **P11.1 — Complete project/file lifecycle.** New with dirty prompt, Open, Open Recent with
  thumbnail/missing-file handling, Save, Save As/copy, autosave/recovery, import conflicts,
  project metadata, and close/reset operate consistently with browser file capabilities.
  - Local-file handles are optional enhancements; standards downloads/uploads remain complete.
  Recent entries reveal storage origin and can be removed without deleting the project silently.
  - **Accept:** dirty-state/recovery matrix covers every operation and storage/browser mode; no
    project or preset change is discarded without confirmation.
  - **Current:** New Project now resolves dirty confirmation before replacing the complete
    canonical state/asset/selection/history authority, allocates fresh project/plate identities,
    retains the selected base profile and physical tools, clears project overrides and virtual
    recipes, and establishes a clean checkpoint. Canonical worker-preview Open and deterministic
    download Save/Save As exist. A bounded versioned autosave store can identify and validate the
    newest recoverable snapshot, report corruption, and explicitly discard recovery state, but it
    is not yet wired to live capture/startup recovery. Recent files, distinct Save versus Save As/
    file handles, live autosave/recovery, metadata UX, import conflicts, and the full dirty/browser
    matrix remain.

- [~] **P11.2 — Close every menu, toolbar, context, camera, and view gap.** File, Edit, View, Add,
  Prepare/tool, plate/object context, Calibration, Device, Help, scene cameras, perspective/
  orthographic, navigator, outlines/wireframe, zoom/frame, G-code window, and display toggles map
  to tested capabilities or adaptations.
  - Generate all surfaces from one action model while allowing platform-appropriate placement.
  A full-catalog search/command palette prevents hidden reachability gaps.
  - **Accept:** P0 surface manifest has no unclassified item and reachability tests pass for DOM,
    touch, keyboard, and XR.
  - **Current:** two View entries that rendered as UNAVAILABLE now work. The selection outline is
    a real silhouette — the same geometry drawn back-faces-only at a 2% offset — rather than a
    bounding box, because a box says roughly where a model is, which the transform gizmo already
    says, while an outline says *which* model is selected when two overlap. It needs no
    post-processing pass, which matters because the XR renderer owns its own pipeline. It is
    refreshed from the canonical selection change rather than from any one call site, so
    select-all, the Objects tree, and a click all keep it correct — the browser trace caught
    exactly that gap when only the click path was wired.
    The 3D navigator is an axis triad drawn in a scissored corner viewport after the main pass,
    reporting the desktop camera's orientation. It is display-only and declares itself
    XR-unsupported: in a headset the head is the camera and the workspace is already oriented in
    the room. Reachability for the DOM, touch, keyboard, and XR surfaces is now asserted by the
    registry tests added for P10.5.
  - **Missing:** perspective/orthographic switching and auto-perspective remain unimplemented —
    both need swapping the camera object that XR, OrbitControls, TransformControls, and the
    preview surface all hold, so they are their own increment. The G-code window, the remaining
    context-menu surfaces, and the P0 surface-manifest classification pass are untouched.

- [~] **P11.3 — Build contextual help and troubleshooting.** Help for each action/setting/error
  links to version-appropriate official docs or maintained OrcaXR adaptation docs. Include
  onboarding, shortcuts, FullSpectrum, parts/assignments, painting, profiles, preview, Moonraker,
  offline/XR, privacy/security, known limitations, diagnostics, and release notes.
  - Help is searchable, keyboard/screen-reader accessible, available offline for core flows, and
    generated/checkable for dead links and unmapped actions/settings.
  - **Accept:** link checker and help-coverage test pass; novice task study can recover from the
    standard preflight/error corpus without developer assistance.
  - **Current:** `help/HelpCatalog.ts` carries topic content for every area the item names and,
    more usefully, per-error troubleshooting for all 28 preflight codes. Those previously shared one
    sentence — "Resolve this issue before slicing or sending" — which is true and no use to someone
    who already knows something is wrong. Each code now says what the check saw and what clears it,
    and the preflight panel shows the fix beside the issue's own help rather than replacing it,
    because an issue's message can be specific to the values that tripped it in a way a
    code-keyed catalog cannot.
    Coverage is checked rather than maintained by hand: the test reads the codes out of
    `preflight.ts` and fails both when a code has no help and when help exists for a code the app
    no longer raises, so neither can drift. Links are checked for scheme and for pointing at a
    maintained origin. `help_search` searches topics, troubleshooting, and the action catalog in
    one index, in a live region so a screen reader hears the result count change, and every word of
    it is bundled rather than fetched so it works in the offline conditions it might be needed in.
  - **Outstanding:** the link check is static — scheme and allowlisted origin — and does not fetch,
    because the gate must pass offline; a periodic networked check is still needed to catch a link
    that rots. Setting-level help is not there: only actions and errors are covered, and the
    generated settings surface has thousands of keys. There is no onboarding walkthrough beyond the
    static tutorial, no release notes surface, and the novice task study the acceptance calls for
    needs people, so this item cannot close from implementation alone. Help search declares an
    `xrUnsupportedReason` for want of in-headset text entry.

- [~] **P11.4 — Implement diagnostics and support export.** Structured bounded logs, capability/
  profile/engine/browser/XR/printer state, worker crashes, performance snapshot, and sanitized
  project summary export to one archive after a privacy preview. Never include G-code/project,
  tokens, LAN URLs, or model names without explicit selection.
  - **Accept:** injected failures are diagnosable; redaction tests prove known secret/PII patterns
    absent; export logs action is no longer a placeholder.
  - **Current:** `diagnostics/DiagnosticsBundle.ts` records a bounded ring of structured entries —
    200, oldest dropped first, because a crash is near the end of a session — and redacts each one
    *as it is recorded* rather than on the way out, so a secret never sits in the buffer for some
    other reader to find. Live credentials are registered with the recorder as they are entered.
    The bundle carries app and engine version, route, browser and printer state, capability counts,
    and the project's shape; it never carries geometry, G-code, addresses, or tokens, and model
    names only on explicit opt-in, with the withheld list stated in the file itself.
    The privacy preview and the export are the same object: `describeDiagnosticsBundle` renders the
    bundle that will be written, so there is no summary that can drift from the file. `Export
    Diagnostics…` is a real action; the placeholder reason is gone.
    Proven in a real browser with an actual API key, slicer token, and LAN address typed in and an
    injected `RangeError`: none of the three secrets appear in the written file, and the failure
    does.
  - **Outstanding:** the bundle is one JSON file rather than an archive, which is enough to read and
    attach but does not yet carry worker crash dumps or profile snapshots as separate members; the
    performance section is defined but not populated (no heap or uptime source is wired); XR state
    is defined and unpopulated for the same reason; and the preview is a browser `confirm`, so the
    action declares an `xrUnsupportedReason` until an in-headset review flow exists.

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
  - **Current:** this plan, `GEMINI.md`, README, CONTRIBUTING, site/help claims, deploy comments,
    and active web commands describe the current foundation and limitations. DESIGN, root license,
    complete notices/link checks, and clean-clone documentation qualification remain open.

- [~] **P11.7 — Maintain the platform adaptation register.** For each native/cloud-only feature,
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
  - **Current:** the register carries all eight mandatory rows plus the three adaptations this
    implementation introduced — operator-supplied fonts, the reported SVG feature set, and
    device-remembered credentials — and a row for engine attestation. Each row now records what the
    user actually sees differently, the risk that difference carries, an owner, and the evidence
    that would settle it, rather than only naming a replacement mechanism. Decisions that reversed
    an earlier recorded one are logged as superseding entries with the reason, so the register and
    the decision log do not contradict each other.
  - **Outstanding:** every row is `proposed`. Approval is the acceptance criterion and it needs two
    human reviewers — one product, one engineering — so this item cannot close from
    implementation work alone. No `BLOCK-*` row has been raised yet, which is itself a claim worth
    a reviewer's attention: it asserts that no upstream outcome is unreachable, and the vendor-cloud
    rows (`ADAPT-03`, `ADAPT-05`) are the likeliest to become blockers under scrutiny.

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

| Feature family / required outcome | Primary tasks | 2026-07-30 current audit |
|---|---:|---|
| Upstream actions/settings/gizmos/formats/calibrations inventory and drift | P0.1, P12.1 | Exact pinned extractor maps 1,622 leaves/13 families from 17 Git blobs; manual upstream workflow sampling remains |
| Truthful menu/toolbar/context/shortcut/XR capability state | P0.2, P11.2 | One guarded registry reports 154 actions = 112 partial + 42 unavailable and zero implemented, with unique real task ownership/anchors; full upstream reachability remains |
| Clean-clone typecheck/test/build/CI and reproducible engine artifacts | P0.3, P12.3 | Aggregate local gate and artifact provenance pass; clean-clone CI/native rebuild qualification remains |
| Golden 3MF/config/G-code/security fixture oracle | P0.4 | Structural 3MF, semantic G-code, and hostile server fixtures pass; official Snapmaker corpus remains |
| Shared domain/action/surface boundaries | P0.5, P1.1–P1.2 | Canonical project/history, validated mesh codec, live one-way Three projection, and one injected guarded action registry exist; remaining contextual bypasses and feature commands are tracked explicitly |
| New/open/recent/save/save-as/dirty prompts/recovery | P1.3–P1.6, P11.1 | Dirty-confirmed canonical New, worker-preview/confirm Open, deterministic save, and a bounded corruption-aware autosave/recovery store exist; composition-root capture/recovery UI, recent files, and distinct Save As/file handles remain |
| BBS 3MF project and generic 3MF round-trip | P1.3 | Deterministic BBS core, lossless envelope, and qualified `p:path` split-model import exist; complete official Orca round-trip remains |
| Project/plate/object/volume/instance/layer-range model | P1.1, P2.1 | Canonical graph, immutable mesh assets/codec, atomic add/delete commands, live accessible/virtualized DOM tree, and one-way scene projection exist; XR and full edit outcomes remain |
| Selection set and synchronized scene/Object tree | P1.2, P2.1, P5.1 | Typed canonical plate/object/volume/instance/layer-range multi-selection synchronizes the live DOM tree and Three scene; XR and complete touch/large-project qualification remain |
| Object/part/instance add, clone, split, merge, move, reload | P2.2 | Canonical lifecycle subset plus live Add Instance and deterministic Fill Bed with Instances; move-to-plate UI, merge/reload, topology, and oracles are open |
| Per-object/per-part/per-height filament selection and inheritance | P2.3, P2.5 | Live guarded selector plus canonical stable-ID assignment/inheritance commands exist; scene/wipe/preview propagation and oracles are missing |
| Solid/modifier/negative/support-enforcer/blocker volume roles | P2.4 | Guarded live conversion and canonical persistence exist; add-from-source, slice oracles, official qualification, and XR remain |
| Per-object/part/layer settings | P2.5, P6.5 | Live height-range lifecycle plus one panel that edits plate/object/part/height-range overrides through an engine-generated scope table, with the height range outranking the part as the engine orders it; slice-effect fixtures and XR remain |
| Physical filament/tool/profile lifecycle and stable mapping | P3.1 | Stable canonical definitions, reversible lifecycle, live library/assignment, and transient engine numbering exist; device mapping/reorder UX/oracles remain |
| Virtual filament add/edit/duplicate/delete/remap | P3.2, P3.8 | Live four-mode CRUD, opt-in count-guarded auto pairs, tombstones, assignment, undo, and save/reopen exist; merge/apply, XR, and official qualification remain |
| FullSpectrum Ratio authoring and slicing | P3.3, P3.9 | Live two/three-component authoring, exact triangle normalization, prediction, and persistence exist; slice/hardware oracle remains |
| FullSpectrum Cycle authoring and slicing | P3.4, P3.9 | Live pattern authoring/preview/persistence and exhaustive parser corpus exist; layer/tool G-code oracle remains |
| FullSpectrum Match authoring and gamut search | P3.5, P3.9 | Bounded cancellable worker search, ranked explicit choice, ΔE, prediction, and persistence exist; official target/tolerance and hardware oracle remain |
| FullSpectrum Gradient authoring and Local-Z output | P3.6–P3.7, P3.9 | Live direction/endpoints/preview/persistence plus generated advanced settings exist; layer-wise and hardware oracles remain |
| Virtual filaments in parts, painting, legends, preview, persistence | P2.3, P3.8, P4.4 | Live part/range assignment, badges/library summaries, stable-ID physical/mixed paint palette, refined canonical/BBS persistence, and save/reopen exist; complete preview/send legends, XR authoring, and official output qualification remain |
| Canonical independent facet channels | P4.1–P4.2 | Five topology-aware sparse channels plus bounded version-1 refinement trees, guarded streamed stroke history, exact per-component Gap Fill, reopen-safe per-instance overlays, and exact color/support/seam/fuzzy BBS codecs exist; XR input and official oracles are missing |
| Color Circle/Sphere/Triangle/Height/Fill/Gap Fill | P4.3 | All six tools and their exposed parameters are live in the DOM paint panel over the source-pinned selectors, with derived exact-leaf overlays, one-command streamed gestures, and browser-verified strokes; section clipping, filters, wireframe, XR, and official goldens remain |
| Physical + virtual color palette, erase, clipping, filters | P4.3–P4.4 | Canonical palette with stable physical/mixed IDs, badges, gradients, `1`–`9` keys, unavailable reasons, inherit/erase, and Erase All is live in DOM and XR swatches; clipping, filters, and official oracles remain |
| Filament source→destination paint remapping | P4.5 | Canonical atomic many-to-one remap covers sparse and refined leaves, recursively collapses collisions, and is byte-exact through undo/redo; preview/UI/default/deletion/oracle flows are missing |
| Support painting | P4.6 | Live enforce/block/erase refined strokes on the canonical support channel with labelled per-instance overlays and standard BBS persistence; generated-support and official round-trip oracles remain |
| Seam painting | P4.7 | Live prefer/avoid/erase refined strokes on the canonical seam channel with standard BBS persistence; seam-position G-code oracle and official round-trip remain |
| Fuzzy-skin painting and brim ears | P4.8 | Live refined fuzzy-skin strokes persist through standard BBS attributes; brim remains canonical-envelope-only because BBS has no facet attribute, and the brim-ear gizmo, perimeter/brim oracles, and dome regression fixture remain |
| AI-assisted painting and color recreation through canonical annotations | P4.9 | Smart Paint projects a bounded typed proposal into canonical facets behind explicit per-payload consent, with a correctable preview mask and one undoable commit; XR is excluded by declared reason, and colour recreation stays unavailable pending pinned matching math |
| Safe painted slicing without monochrome fallback | P4.10, P7.1 | Canonical live current-plate coordinator and revision/project/asset guard exist with no scene/raw-source fallback; paint-authoring/oracle/send evidence remains pending |
| Move/rotate/scale/mirror/lay/auto-orient/numeric transforms | P5.1 | Stable-ID multi-select/select-all, bounds-center group transforms, numeric/nudge batching, Drop to Bed, mirror X/Y/Z, reset rotation/scale, centre on plate, and facet-pick Lay flat are canonical commands; auto-orient, coordinate spaces, snapping, box select, and XR remain |
| Cut/split/Boolean/repair/simplify | P5.2 | Guarded immutable topology replacement, pinned shared-edge split-to-parts, and a live explicitly confirmed, stale-guarded, atomic single-/multi-volume split-to-objects path preserve assets, placement, config, and unchanged-topology annotations while blocking lossy or over-cap synchronous cases; worker progress/cancel and cut/Boolean/repair/simplify algorithms/oracles remain gated |
| Measure/assembly/emboss/SVG/simplify/brim gizmos | P5.3 | Mostly placeholders or disconnected code |
| Multi-plate lifecycle, settings, lock/reorder/current/all slice | P5.4 | Live guarded add/activate/rename/duplicate/delete/reorder/printable management and revision-guarded all-plate slicing with one named result/download per printable plate exist; locks/settings/move-copy, per-plate statistics, and route qualification remain |
| Collision-aware arrangement/orientation/wipe tower | P5.5 | Deterministic canonical auto-arrange honours margins, spacing, exclusions, locked instances, and prime tower, commits one reversible batch, and is browser-verified; rotation-aware nesting, auto-orientation, and sequential clearance remain |
| Import 3MF/STL/STEP/SVG/OBJ/AMF/ZIP as appropriate | P5.6 | One signature-first intake serves the picker and drag-and-drop: 3MF opens as a project or merges geometry-only with reported drops, STL/OBJ/AMF/compressed-AMF/ZIP decode into canonical objects/parts/units/materials/instances, G-code opens read-only, and hostile or unsupported input fails closed with typed reasons; STEP/SVG decoding, URL/handy sources, and official corpora remain |
| Export project/core/sliced 3MF, STL variants, G-code, OBJ, bundles/logs | P5.7 | Canonical project/G-code download and deterministic selected-or-plate binary STL exist; remaining variants/viewers/destinations/oracles are open |
| Primitives, text/SVG, handy/URL model sources | P5.8 | Primitives/catalog partial |
| Variable/adaptive layer-height profile editor | P5.9 | Action is a placeholder; helper is disconnected |
| Complete generated engine settings schema | P6.1 | Deterministic 816-definition/809-key schema v2 includes the complete pinned 21-tab/93-group/424-literal-placement `Tab.cpp` inventory; dynamic/composite placement, predicates, reset/general-scope semantics, runtime dump, and locale remain |
| Process Quality/Strength/Speed/Support/Multimaterial/Others | P6.2 | Live generated panel consumes pinned Process page/group/order and fails non-Process/custom/unplaced fields closed; dependencies, remaining widgets, complete reachability, and engine proofs are missing |
| Filament pages and printer/extruder/machine-G-code pages | P6.2 | Exact placement metadata exists, but the project panel deliberately disables these scopes until canonical surface-specific mutation seams, widgets, and engine proofs exist |
| System/user/project preset inheritance/compatibility/lifecycle | P6.3 | Immutable inheritance/compatibility graph, fail-closed filtered loader, exact-pinned/locked corpus gate, and live canonical-ID printer/process/multi-slot reconciliation with accessible substitution reasons exist; expression evaluation and full preset CRUD/conflict/import/export lifecycle remain |
| Result entry and save-to-preset | P8.3 | A pinned per-workflow result-to-preset mapping, asserted against the inventory in both directions, that writes through the P6.4 library as a versioned operator preset and refuses a result whose conditions moved; firmware-only workflows hand off exactly what to put in the printer instead of pretending to apply. Parameter dialogs, preview/regenerate/slice/inspect, doc links, session snapshots, and official-example comparison remain |
| Calibration history, comparison, re-run, export | P8.5 | A ledger that records the conditions each measurement was taken under and refuses to offer a result whose printer, nozzle, material, or filament preset has changed; content-addressed records, fingerprint-bound re-run, schema-0 migration, and a deterministic export proven free of addresses and credentials. Writing a result into a preset (P8.3), ledger import, XR, and hardware runs (P8.6) remain |
| Setup/custom printer/custom filament/bundle import/export | P6.4 | Installation, custom presets as overlays on a system base, provenance, and a deterministic bundle exist and decide what the whole app can select; editing an existing preset has no panel control, a runtime corpus-update path and XR remain |
| Settings search/modes/dependencies/validation/reset/compare | P6.2–P6.5 | Live Process panel has pinned grouping plus headless modes/search/validation/inheritance/reset/compare, and the same panel now serves all five override scopes from a generated per-scope key table; predicates and the XR surface are missing |
| Application preferences, storage migration, secret handling | P6.6 | AI and printer credentials are session-only with legacy plaintext purge/redaction; printer endpoint-only preferences are sanitized, while broader preferences/dialog lifecycle remains missing |
| Correct config types/vector delimiters across boundaries | P6.7 | Shared ConfigIO/ProfileLoader classifier covers all 174 generated vector definitions; escaping/special/full boundary matrix remains |
| Revisioned current/all plate slice, cancel, progress, route parity | P7.1 | Live current-plate and all-plate browser slicing use the canonical coordinator and actual-asset guard, retaining per-plate results and downloads; external attestation, route/oracle parity, and per-plate statistics remain |
| Preflight and actionable engine/project/device errors | P7.2 | Live UI and coordinator share canonical pre-route checks, exact catalog-derived build/nozzle/material/temperature constraints, fail-closed target attestation, structured accessible findings, and registry-routed Reveal/Drop-to-bed actions; remaining fixes and complete engine/device safety matrix remain |
| Rich G-code parsing and standalone G-code open | P7.3, P7.7 | Bounded typed-column parser plus a read-only standalone viewer that never mutates the project; exact pinned XY G2/G3 semantics use one source record with a bounded dense path sidecar and keep the suffix available, while strict consumers expand geometry without renumbering. Seams, exact color-print/time semantics, official corpora, and streaming partitions remain |
| All preview color modes/move filters/legends | P7.4 | The live viewer renders the bounded projection for all 12 pinned modes with a DOM panel for modes, layer window, move filters, coded legend, numeric range, and unsupported-mode reasons; seams/shells/marker, screenshots, XR, and goldens remain |
| Layer and sequential-move sliders/playback/G-code window | P7.5 | Live layer sliders, single-layer mode, and located event ticks that move the layer window drive the bounded inspection model with announced values; sequential playback, marker rendering, source window UI, camera focus, artifact binding, and official goldens remain |
| Complete estimates/material/tool/conflict/all-plate statistics | P7.6 | Opaque exact-UTF-8/SHA verification plus a strict bounded sidecar now enforce canonical export identities, float32 planner and sample-count-bounded double material reconciliation, unavailable propagation, non-exhaustive conflict disclosure, and tool+profile-safe aggregation, and the engine's own artifact totals (per-tool filament, weight, cost, tool changes, layers, time) are read and shown after a slice; the sidecar's engine/external producers, canonical route binding, per-role breakdown, all-plate UI, accessibility, and official goldens remain |
| Layer pauses/custom G-code/color changes/filament sequences | P7.8 | Guarded canonical authoring from the inspector or the G-code preview's current layer, an engine-format `custom_gcode_per_layer.xml` projection that round-trips foreign projects, profile-gated event kinds, and located preview ticks are live; slider badges and filament sequences remain |
| Calibration generators and real per-band output | P8.1–P8.3 | Exact pinned inventory covers 11 modes, 14 menu variants, tolerance, and device gates; a fingerprint-bound compiler validates all 15 manual workflows and emits bounded band/object/line plans with engine overrides, firmware commands, labels, fit data, result/preset schema, and slice assertions. Canonical geometry materialization, live workflows, and parsed sliced-G-code oracles remain; 11 bindings are still alpha geometry and four unbound |
| Connected calibration wizard, save/history | P8.4–P8.6 | Missing |
| Secure Moonraker connection and multi-printer setup | P9.1–P9.2 | Typed transport plus a named-printer directory with per-printer credentials and leak-free switching, proven in the production browser; live capability capture, per-printer queues/cameras, profile association, and hardware evidence remain |
| Pre-print validation/tool mapping/upload/start | P9.3–P9.4 | Send-time tool mapping, confirmed upload with unique naming and size verification, and an explicitly confirmed start are live and covered end-to-end against a Moonraker simulator in the production browser; destination/storage selection, queue and lifecycle control, reconnect during transfer, and hardware qualification remain |
| Full action catalog reachable in XR | P10.5 | Inspector actions derive an `xr-inspector` surface and render in a grouped Panels menu gated by the same availability call as the DOM; two registry tests refuse any action that is absent from XR without a stated reason. Headset qualification of reach, legibility, input, and frame budget remains |
| Compact status, guarded stop, session recovery | P9.7 | One surface-neutral summary drives a phone bar over the plate and a spatial card; a dropped socket keeps the last reading, ages it, and refuses every command until the machine can confirm itself; cancel and emergency stop are held rather than tapped (`ADAPT-13`). XR hardware ergonomics and reference-device qualification remain |
| Live status/control/storage/queue/history | P9.4–P9.5 | Push-driven job state, progress, layer, and temperatures plus state-derived pause/resume/cancel, an always-reachable emergency stop, and a storage browser that reprints, renames, downloads, and deletes the printer's own files are live; queue reorder/remove, history, update manager, and hardware qualification remain |
| Camera/console/macros/history | P9.6 | A G-code console that classifies every command before it is sent, confirms anything that moves/heats/halts, reads the printer's own macros with the parameters their bodies declare, a paged print history with totals and estimate comparison, and cameras shown as authenticated snapshots that stop fetching when hidden; live stream transports (`ADAPT-12`) and XR remain |
| Responsive desktop/tablet/mobile IA and complete states | P10.1 | Useful recent shell work; parity unverified |
| WCAG AA, keyboard, screen reader, non-color states | P10.2–P10.3 | Axe, headless tree semantics, keyboard menus/modal focus, registry-derived shortcut dispatch/help/ARIA metadata, and conflict tests pass; complete contexts/remapping workflows and manual assistive review remain |
| Localization/pseudo-localization/RTL-safe layout | P10.4 | Locale-invariant serialization is proven and guarded; extraction, message IDs, runtime switching, pseudo-localization, and RTL are all missing |
| XRBlocks typed design system, correct reactive API, local assets | P10.9 | Exact pins, local icons, audited UI/UIBlocks contract, and an exact-typed signal-aware action-button adapter with guarded states/disposal exist; full composite kit/gallery remains |
| Complete XR workflows and common capability gating | P2.6, P10.5, P10.9–P10.10 | Shell exists and DOM-only printer submission is truthfully withheld from XR pending a native confirmation flow; many workflows and input modes remain missing |
| XR update/input ownership, cleanup, comfort, headset budgets | P10.10 | Duplicate owners removed; per-controller sticky UI suppression, transition snapshots, actual-hit targeting, stale-event refusal, and idempotent handle/guard disposal are tested foundations; frame counters/headset budgets remain |
| Bundle/frame/memory/worker/WASM resource budgets | P10.6, P10.10 | Production chunk budgets pass; runtime/frame/memory/device budgets remain |
| Client/server/archive/printer/AI security | P10.7 | Bounded server/archive abuse, session-only AI/Moonraker secrets, purge/redaction, and fail-closed external-slicer opt-in/probe foundations pass; full threat/device review remains |
| PWA offline, coherent updates, autosave/crash recovery | P10.8 | Offline/CSP/update contract and production reload smoke pass; a bounded versioned autosave ring proves quota pruning, corruption fallback, validation, recovery choice, and discard headlessly, while live capture/startup UX and atomic worker/WASM/schema updates remain |
| Complete menus/cameras/views/shortcuts/help/preferences | P11.2–P11.3 | Shortcut help is generated from the guarded action catalog and basic help claims are truthful; many menu/view behaviors, contextual help, and preferences remain missing |
| Diagnostics/log export and privacy preview | P11.4 | Real bundle with record-time redaction and a preview that is the file itself; archive members, performance/XR population, and an XR review flow remain |
| Typed permissioned MCP/voice/AI automation | P11.5 | Scaffolds; remote/unpinned risk |
| Canonical docs, setup, license/provenance consistency | P11.6 | Core claims/commands/docs are corrected; DESIGN, root license/notices, link checks, and full qualification remain |
| Native/cloud outcome adaptations | P11.7 | Register complete with per-row user-visible difference, risk, owner, and evidence; every row still `proposed` and awaiting product + engineering approval |
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
| `EVID-001` | P0.1 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626` | 2026-07-17 | `npm --prefix web run parity:verify`; generated manifest/disposition mutations | Node 22.21.0 | Pass: 1,622 leaves, 13 families, 17 exact blobs; deterministic and action/setting/stale/duplicate mutations rejected | Codex automated review; official binary/manual sample pending |
| `EVID-002` | P0.4 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run parity:oracles`; 11 CC0 artifacts and five required mutations | Node 22.21.0 | Pass: structural 3MF and semantic G-code mutations, relationships/extensions, ZIP normalization/tolerances | Codex automated review; Snapmaker-generated reference pending |
| `EVID-003` | P0.5, P1.1–P1.3 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run architecture:check`; `npm --prefix web run test:project`; structural parity 3MF | Node 22.21.0; headless | Pass: boundaries; 9 domain, 8 history, 3 session, and 4 BBS serializer tests | Codex review; P0.5/P1.1 verified; P1.2/P1.3 residuals documented |
| `EVID-004` | P0.2, P11.2 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run test:unit`; registry/XR capability fixtures | Node 22.21.0 | Pass: 111 actions = 77 partial + 34 unavailable; guards/surfaces/seven-action XR rail verified; zero false implemented | Codex automated review; full upstream reachability pending |
| `EVID-005` | P0.3, P10.2, P10.6, P10.8–P10.10 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run quality`; production build/E2E/offline/axe/size/CSP/icons | Chrome for Testing 150.0.7871.24; desktop/mobile emulation; no headset | Pass: 20/20 unit files, 3 integration files, production capability smoke, offline reload, 24 axe rules, 97 local XR icons, bundle budgets | Codex automated review; manual browser/AT/headset matrices pending |
| `EVID-006` | P6.1 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run settings:verify`; runtime loader test | Node 22.21.0 | Pass: deterministic 816 definitions/809 keys; eight fail-closed mutations; strict loader | Codex automated review; GUI/runtime C++ qualification pending |
| `EVID-007` | P10.7, P11.5 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix server test`; WebMCP tests; Compose config; CSP/security contract | Node 22.21.0; Docker 28.3.1; loopback/non-loopback fixtures | Pass: 20 server tests covering auth/CORS/bounds/bombs/rates/queue/cancel/timeouts/log redaction; typed local WebMCP contract | Codex automated review; production threat/static/license review pending |
| `EVID-008` | P0.3, P3.9, P7.1 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | artifact ledger `9fd12ff...` | 2026-07-17 | `npm --prefix wasm run verify:artifacts`; cube/profile/project/painted/prime-tower/FullSpectrum smokes | Node 22.21.0 WASM; no printer | Pass: exact output/input provenance; FullSpectrum 15.0 MB G-code, 1,944 layers, 1,188 tool changes, T0–T3 | Codex automated review; clean rebuild/native/printer parity pending |
| `EVID-009` | P0.3 aggregate | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `./scripts/quality.sh` | Node 22.21.0; Chrome 150; Docker 28.3.1; no hardware | Pass: complete repository wrapper including all package installs/gates and three zero-vulnerability production audits | Codex automated review; clean-clone CI execution pending |
| `EVID-010` | P1.4–P1.6, P2.1–P2.3, P3.1–P3.2, P4.1–P4.2, P4.5, P6.2, P6.7, P7.1 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run test:project`; `npm --prefix web run test:settings`; typecheck; architecture check; pinned `MixedFilament.hpp` source audit | Node 22.21.0; headless | Pass: 12/12 project files (67 tests), 2/2 settings files (5 tests), pure boundaries, physical-only recipe components, exact undo/cancel/stale/no-op guards | Codex automated review; live UI/engine/official-Orca/device qualification pending |
| `EVID-011` | P0.3, P0.5, P4.10, P6.1–P6.2, P10.2, P10.6, P10.8–P10.10 | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `npm --prefix web run quality` | Node 22.21.0; Chrome 150; desktop/mobile emulation; no headset | Pass: 30/30 unit files, 3/3 integration files, 12/12 project files, 2/2 settings files, exact parity/schema/oracles, production/offline/axe/size gates | Codex automated review; manual browser/AT/headset and official workflow matrices pending |
| `EVID-012` | P0.3 aggregate; supersedes `EVID-009` for this worktree | `5f2bd25908fbb9080a4e262462919c670989b3d7` | `9fd12ff...` | 2026-07-17 | `./scripts/quality.sh` | Node 22.21.0; Chrome 150; Docker 28.3.1; WASM; no hardware | Pass: clean installs, web/server/WASM suites, real cube/profile/project/paint/prime-tower/FullSpectrum slices, Compose validation, and three zero-vulnerability production audits. One earlier browser-ready timeout was followed by four direct offline passes and this complete wrapper pass. | Codex automated review; clean-clone CI/headset/printer/native rebuild pending |
| `EVID-013` | P0.2–P0.3, P1.5, P3.2, P4.9, P6.6–P6.7, P7.1, P9.1, P10.2, P10.7, P10.10, P11.3, P11.6 | Current worktree atop `20c42867cd29d203eaa7d2afb6bae33dff29eeb2`; commit pending | `9fd12ff...` | 2026-07-20 | `npm --prefix web run quality`; `npm --prefix server test` | Node 22.21.0; Chrome for Testing 150.0.7871.24; desktop/mobile emulation; no headset/printer | Pass: 34/34 unit, 3/3 integration, 13/13 project, 2/2 settings, and 1/1 XR files; 22 server tests; 112 actions = 77 partial + 35 unavailable; 98 local icons; E2E/offline/24-rule axe pass; bundle main 2,080,342 bytes, JS 8,394,204 bytes, CSS 0 | Codex automated review; canonical live migration, official workflow, AT/headset/printer, threat, and independent review pending |
| `EVID-014` | P1.3 split-model import only | Current worktree atop `20c42867cd29d203eaa7d2afb6bae33dff29eeb2`; commit pending | `9fd12ff...` | 2026-07-20 | `npm --prefix web run test:project -- bbs3mf-serializer.test.ts`; architecture check; focused ESLint/Prettier/diff checks; read-only `tsx` deserialize and in-memory save/reopen of `MarbleRunTube_V7.3mf` | Node 22.21.0; headless; no GUI/device/printer | Pass: 17/17 project files; 20,401,604-byte source resolved 26 external model parts into 5 plates, 28 objects, 29 volumes, and 28 instances; 75 opaque members preserved; 14 virtual-grid transforms normalized; 48,194,991-byte/109-entry canonical save had no `p:path`, reopened with equal canonical state, and retained 102 asset payloads | Codex automated review; arbitrary-affine geometric oracle and official Snapmaker GUI open/save remain pending |
| `EVID-015` | P0.2, P1.4, P5.6 | Current worktree atop `5ff753d`; commit pending | `9fd12ff...` | 2026-08-07 | `npm --prefix web run quality`; `model-formats.test.ts`; `ModelImportParser.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: 20 format-decode traces (STL binary/ASCII, OBJ+MTL, AMF units/materials/modifiers/constellations, compressed AMF, ZIP atomicity, renamed-archive/STEP/SVG/G-code/empty/noise/truncated/limit rejections) and 6 staging traces (single-command commit with exact undo/redo, bed placement, OBJ part structure, AMF unit conversion, archive dedup/renaming, untouched project on failure); registry now reports 126 actions = 77 partial + 49 unavailable | Automated review; official Orca import-corpus comparison, drag/drop, and STEP/SVG routes pending |
| `EVID-016` | P4.2–P4.4, P10.2 | Current worktree atop `2f1423a`; commit pending | `9fd12ff...` | 2026-08-07 | `npm --prefix web run quality`; `src/project/painting/__tests__/painting.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no headset/printer | Pass: 10 painting traces (palette projection/engine slots/unavailable reasons, stable-ID strokes with exact undo/redo, mixed-recipe painting without flattening, erase and erase-all, swept brush and no-op suppression, rejected targets/filaments/hits, modifier refusal, cancellation, canonical save/reopen identity) plus a production browser pass that activates the paint tool, selects a swatch and tool, paints with a real pointer gesture, and undoes/redoes the labelled command; registry now reports 137 actions = 89 partial + 48 unavailable | Automated review; official Orca colour round-trip, segmentation/G-code oracles, touch/XR, and manual accessibility review pending |
| `EVID-017` | P4.6–P4.8, P10.5 | Current worktree atop `563fbf8`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/project/painting/__tests__/painting.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no headset/printer | Pass: 12 painting traces including independent support/seam/fuzzy-skin channels, per-channel erase, per-stroke history, and rejection of a state that does not belong to its channel; the production browser pass now also switches to the support channel, paints `block` with a real pointer gesture, checks the labelled command, and undoes it; the XR rail stays finite at seven while the three new modal tools live in Tools overflow; registry reports 137 actions = 92 partial + 45 unavailable | Automated review; generated-support/seam/perimeter oracles, official round-trip, dome fuzzy fixture, brim ears, and XR input pending |
| `EVID-018` | P5.5, P0.2 | Current worktree atop `20b9052`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/project/objects/__tests__/arrange.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: 6 arrangement traces (deterministic repeat layout with no intersecting footprints inside margins, centred packed block, locked-instance and exclusion clearance, reported non-fitting instances, preserved orientation/scale/Z with an exact transform batch, rejected bed/spacing/exclusion/plate inputs) plus a production browser pass that arranges the imported models through the menu action and undoes the single labelled command; registry reports 137 actions = 93 partial + 44 unavailable | Automated review; rotation-aware nesting, auto-orientation, sequential clearance, and reference placement tolerances pending |
| `EVID-019` | P7.4–P7.5, P7.7 | Current worktree atop `c03f8b8`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/slicer/__tests__/gcode-preview-session.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no headset/printer | Pass: 6 preview-session traces (default full-layer window, move-class filtering, clamped/reversed/single-layer windows, every pinned mode with units and legend codes, explicit unsupported colour-print metadata, published move filters) plus a production browser pass that opens a standalone G-code file, asserts the canonical revision is unchanged, switches to a numeric mode with unit and range, collapses to a single announced layer, and reveals travel moves | Automated review; seams/shells/tool marker, sequential playback, screenshots, XR, official goldens, and the result badge/dirty matrix pending |
| `EVID-020` | P5.1 | Current worktree atop `c659f5f`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/project/objects/__tests__/transform-operations.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: 6 transform traces (axis-exact reversible mirror with untouched rotation/position, independent rotation and scale resets, shared-delta centring verified against canonical bounds, facet lay-flat that turns the chosen normal down and rests the instance on Z=0 without XY drift, already-down and degenerate-normal handling, deterministic 180° alignment) plus a production browser pass that mirrors and centres through the Edit menu and undoes each command; registry reports 145 actions = 102 partial + 43 unavailable | Automated review; auto-orient, coordinate-space controls, snapping, reference tolerances, and XR pending |
| `EVID-021` | P2.2, P5.5 | Current worktree atop `d0bd45b`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/project/objects/__tests__/arrange.test.ts` | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: 8 arrangement/bed-fill traces including deterministic free-space fill that never overlaps the source or existing instances, respects the bed margin, keeps the source orientation, and reports withheld slots at the copy cap, plus a production browser pass that adds an instance, undoes it, fills the plate, and undoes that too; registry reports 147 actions = 104 partial + 43 unavailable | Automated review; move-to-plate UI, merge/reload, and official Orca counts pending |
| `EVID-022` | P7.1, P7.7, P10.7 | Current worktree atop `3874841`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `npm --prefix web audit --omit=dev --audit-level=high` | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: live all-plate slicing retains one guarded artifact per plate with per-plate download, drift discards the whole set, and the production gate stays green; the production dependency surface now audits clean after dropping an unused `serve-handler`, moving the test-only `jsdom`/`puppeteer` to devDependencies, and pinning the patched transitive `protobufjs` | Automated review; per-plate statistics UI, external route attestation, and hardware qualification pending |
| `EVID-023` | P5.6, P1.4, P11.1 | Current worktree atop `b32f941`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; live browser probes with `PeggyPalette.3mf` (3.3 MB, 41 volumes, 4 physical + 40 mixed) | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: the picker and drag-and-drop share one intake; a picked 3MF offers Open-as-project versus geometry-only, project mode replaces canonically in ~13 s and geometry mode merges in ~5 s while listing the dropped plates/filaments/settings/custom-G-code/thumbnails; the production smoke drops an OBJ onto the window, imports it, clears the drop affordance, and undoes it | Automated review; STEP/SVG, URL sources, and official corpus comparison pending |
| `EVID-024` | P1.3, P3.9, P7.1, P7.2, P10.7, P12.3 | `5037e02` | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `npm --prefix wasm run verify:artifacts`; `test_slice_cube.mjs`, `test_slice_painted.mjs`, `test_slice_project_fs.mjs`; browser slice of `PeggyPalette.3mf` | Node 22.21.0; Chrome for Testing 150 with the production CSP; no printer | Pass: the rebuilt CSP-safe engine slices cube (0.3 s), painted two-material (2 tool changes), and the FullSpectrum project (15.0 MB, 1,944 layers, 1,188 tool changes, T0-T3) headlessly; in the production browser build the imported FullSpectrum project passes preflight and slices to 13.97 MB / 98 layers / 296 tool changes / T0-T3 in 72 s; serializer and preflight regressions are covered by 11 serializer and 5 preflight traces | Automated review; official Orca comparison and hardware print qualification pending |
| `EVID-025` | P9.3, P9.4, P1.3, P3.1, P7.1 | Current worktree atop `1a5dcdd`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `npm --prefix wasm run verify:artifacts`; `wasm/test_slice_cube.mjs`, `wasm/test_slice_project_fs.mjs`; production-browser send probe against a local Moonraker simulator | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP; no hardware | Pass: a browser-authored two-object plate with a per-object filament assignment now slices to T0+T1 (2.07 MB, 222 layers) where it previously collapsed to T0 — the project writer emits engine-readable string values and per-filament vectors, unrequested tool slots inherit the chosen filament, and the engine emits its full `CONFIG_BLOCK` again so the artifact declares `filament_colour`/`filament_type`; the production smoke then sends that plate: a printer missing T1 blocks the start and stores nothing when cancelled, upload-only never starts a job, a repeat send takes an unused name, and the started file is byte-identical (checksum + length) to the artifact; the FullSpectrum path was proven on the same build with `PeggyPalette.3mf` (4 physical + 34 mixed), which opens, slices in 69 s to 13,995,772 bytes / 98 layers / 296 tool changes / T0-T3 with `mixed_filament_definitions` in its config block, maps all four tools to loaded slots with no notices, and uploads and starts byte-identically; 10 submission, 6 mapping, 5 simulator, and 8 preset-graph traces cover the protocol; registry reports 149 actions = 107 partial + 42 unavailable and the bundle budget holds at main 2,083,790 bytes | Automated review; queue/pause/resume/cancel, reconnect during transfer, `cors_domains` field setup, and supervised hardware qualification pending |
| `EVID-026` | P9.4, P9.5 | Current worktree atop `e257117`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/printer/__tests__/print-job-status.test.ts`, `print-job-control.test.ts`, `moonraker-print-simulator.test.ts`; production-browser lifecycle pass in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP and WebSocket; no hardware | Pass: 7 status traces (partial-patch merging that preserves sibling fields, unreported state as `unknown` rather than idle, withheld remaining estimate below 2 %, ignored foreign objects) and 6 control traces (state-derived availability, one documented endpoint per command, refusal without any request, refusal when the running file changed, distinct failure and cancellation) plus 2 simulator traces that drive pause/resume/cancel over the real transport and halt a shut-down Klipper; in the production browser the started job appears in the live panel with file, layer 11/98, and 219.6 °C → 220 °C, a state change made only at the simulator reaches the panel by push and re-derives every control, pause and resume act immediately, and both irreversible commands send nothing when their confirmation is dismissed; registry reports 153 actions = 111 partial + 42 unavailable, 26 axe rules pass, and the bundle budget holds at main 2,100,357 bytes | Automated review; queue reorder/remove, storage browsing, history, background-tab behaviour, and supervised hardware qualification pending |
| `EVID-027` | P7.8 | Current worktree atop `0c43ac4`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/project/__tests__/layer-events.test.ts`, `bbs3mf-serializer.test.ts`; `wasm/test_slice_project_fs.mjs` against hand-built event archives; production-browser authoring pass in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; no hardware | Pass: 6 command traces (reversible add/edit/delete, print-order projection, refusal of a duplicate height, and per-type validation) and a serializer trace that emits the engine's exact attributes (`type` 4/1/0 with the matching legacy `gcode`, `plate_info`, `MultiExtruder` mode), round-trips through the canonical envelope, and recovers the same events from the BBS file alone once the envelope is removed; the engine honours the projection — a pause at 2 mm emits `;PAUSE_PRINT` + `M600` at Z 2.05 and a custom event emits its body at the requested height, while a colour change without `color_change_gcode` emits an empty marker, which is why that kind is offered only when the profile declares one; in the production browser an authored pause at 3.4 mm reaches the sliced artifact exactly once with the profile's own `M600` body; registry reports 154 actions = 112 partial + 42 unavailable and the bundle budget holds at main 2,116,190 bytes | Automated review; layer-slider authoring, preview ticks, filament sequences, and official Orca comparison pending |

| `EVID-028` | P7.5, P7.8 | Current worktree atop `6d82177`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/slicer/__tests__/gcode-inspection-model.test.ts`; production-browser preview pass in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; no hardware | Pass: 9 inspection traces including a new one pinning that a retraction Z-hop on a travel no longer raises the reported layer height (a layer authored against 3.4 mm read 3.85 mm before the fix and 3.45 mm after — the first layer at or above the request) and that a travel-only layer still reports its observed Z; in the production browser the pause authored earlier comes back as a located tick, choosing it moves the layer window to that layer, authoring a custom event from the viewer records the layer's own height, and the published artifact is dropped so the preview closes rather than showing a view the project no longer produces; an opened G-code file lists its tick but offers no authoring, because it is not this project's artifact; the bundle budget holds at main 2,119,077 bytes | Automated review; slider badges, playback, tool-marker rendering, and official goldens pending |

| `EVID-029` | P7.6 | Current worktree atop `b3a0798`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; `src/slicer/__tests__/gcode-artifact-summary.test.ts`; production-browser preview pass in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; no hardware | Pass: 6 summary traces covering per-tool length/volume/weight with colour and material, a stated zero kept as a real zero against an absent field left absent, every duration shape the engine writes plus rejection of the ones it does not, refusal to coerce a malformed or negative count, and trailer-only scanning proven on a 2.8 MB artifact; in the production browser the sliced plate reports 225 layers, a positive time estimate and total weight, and exactly the two tools it uses, with the panel showing each tool's material and mass; the bundle budget holds at main 2,123,148 bytes | Automated review; the verified sidecar's engine producer, per-role breakdown, cost units, all-plate UI, and official goldens pending |

| `EVID-030` | P6.1–P6.2, P10.8 | `33f0534` | `9fd12ff...` | 2026-08-08 | `node tools/settings-schema/self-test.mjs`; `node tools/settings-schema/generate.mjs --check --no-fetch`; `npm --prefix web run test:settings`; focused `GeneratedSettingsPanel.test.ts`; TypeScript typecheck; production build; offline contract/smoke | Node 22.21.0; Chrome for Testing 150; headless; no hardware | Pass: deterministic 5,383,500-byte schema v2; 816 definitions/809 keys; exact 21-tab/93-group/424-placement inventory; 10 fail-closed mutations; 5/5 settings files and 7/7 generated-panel cases. Full duplicate-owner binding sets and fixed inventory counts reject relationally valid truncation; symbol-derived surfaces and draft/commit guards reject non-Process relabeling; dependency/reset is pinned as unenforced rather than falsely fail-closed. Both production workers cache the content-hashed schema NetworkFirst, and an offline reload fetches and parses schema v2 | Automated and independent code review; runtime C++ dump, predicates/reset/general scopes, widget families, engine-effect fixtures, and cross-surface/browser/XR qualification pending |
| `EVID-031` | P1.3, P4.1–P4.8, P10.6–P10.7 | Current worktree atop `33f0534`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; 18 BBS serializer, 3 codec, 17 painting, 7 remap, and repeated-instance overlay traces; `npm --prefix web run test:project`; `npm --prefix web run parity:oracles` | Node 22.21.0; Chrome for Testing 150 with production CSP; headless; no hardware | Pass: exact bounded version-1 source-root/child-path persistence and uppercase BBS color/support/seam/fuzzy codec, first-nonempty fuzzy alias, safe `1..64` color consumer cap, whole-root/extension-only warnings, reserved-attribute authority, package-global decode and sparse/refined component-materialization budgets, and fail-closed legacy-false migration. Streamed adaptive paint keeps first-sample volume/revision authority, applies each Gap Fill component's target, commits one labelled history entry, remaps/collapses refined leaves, reopens exact overlays, and retains one overlay per repeated instance. All 46 project test files, parity's 11 artifacts, production E2E/offline reload, 26 axe rules, and bundle budgets pass (`main=2,166,514`, JS total `9,451,681`) | Two independent code reviews clean; compiled upstream differential, official Orca GUI round-trip/G-code comparison, XR/touch authoring, and hardware qualification pending |
| `EVID-032` | P7.3–P7.5, P7.7, P10.2 | Current worktree atop `4f54604`; commit pending | `9fd12ff...` | 2026-08-08 | `npm --prefix web run quality`; eight focused parser/consumer/render/workspace suites; exact `GCodeProcessor.cpp`, `GCodeReader.cpp`, `Circle.cpp`, and viewer-source audit | Node 22.21.0; Chrome for Testing 150 with production CSP; headless; no headset/printer | Pass: 69 focused traces (22 parser, 6 path-consumer, 8 preview, 14 statistics, 9 inspection, 5 surface, 3 workspace, 2 DOM) retain one semantic/source record for CW/CCW, major/quarter/full-circle/P/helical arcs, exact Float32 metrics and interpolation, complete suffixes, dense sidecar identity, projection colours, focus, and recoverable renderer failure. Malformed/forged/non-finite/overflow/cap inputs fail before partial publication. Full production E2E, offline reload, 26 axe rules, and bundle budgets pass. | Two independent code reviews clean; compiled upstream differential/golden corpus, streaming partitions, XR, and hardware qualification pending |
| `EVID-033` | P3.9 preflight half only | Current worktree atop `12cb3d4`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/slicing/preflight.test.ts`, `src/workspace/__tests__/profile-preflight-constraints.test.ts`; exact `MixedFilament.cpp/.hpp`, `PrintObjectSlice.cpp`, `Print.cpp`, and `libslic3r.h` source audit | Node 22.21.0; Chrome for Testing 150 with the production CSP; headless; **no printer** | Pass: 16 preflight traces (8 new) and 6 profile-derivation traces (1 new) refuse each silent engine repair — a mixed row on a target declaring fewer than two physical tools, an assignment past the declared tool count that `region_config_from_model_volume` would collapse to tool 1, a PLA+PETG recipe under the pinned compatibility matrix, 65 addressable filaments against `MAXIMUM_FILAMENT_NUMBER`, gradient endpoints inside `(0, 1)` but outside the manager's `[0.01, 0.99]` clamp, a duplicated and a beyond-tool-count gradient component `decode_gradient_component_ids` would drop, and the `Print::validate()` prime-tower preconditions with the upstream mixed-diameter case kept a warning rather than a stop. Capability comes only from the resolved target's tool count, so an undeclared capability stays unevaluated and a malformed one throws. 120/120 unit, 4/4 integration, 46/46 project, 5/5 settings, and 1/1 XR files pass; registry reports 154 actions = 112 partial + 42 unavailable; 27 axe rules pass; bundle main 1,831,454 bytes, JS total 9,487,382 | Automated review; **no hardware evidence** — U1 Ratio/Cycle/Match/Gradient reference prints, the Elegoo Centauri Carbon outcome-or-blocker determination, official-Orca semantic G-code comparison, and the temperature/tool-mapping/purge safety sign-off are all still outstanding, so P3.9 stays `[~]` |
| `EVID-034` | P4.9, P0.2, P10.8 | Current worktree atop `d8655f0`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/painting/__tests__/aiPaint.test.ts`, `src/ui/dom/__tests__/SmartPaintPanel.test.ts`; production-browser Smart Paint consent gate in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; headless; **no assistant configured, no headset, no printer** | Pass: 9 projection/session traces (strict parsing of nine malformed shapes including a polygon and an inverted box, positional region IDs, box-and-cone projection with later regions overwriting earlier ones and coverage-weighted confidence, a preview that leaves the project byte-identical, one undo entry for a whole multi-region mask, unassigned and excluded regions painting nothing, per-payload and per-provider consent refused before the port is ever called, provider failure/malformed output/cancellation/stale-guard all leaving canonical state untouched, support-channel authoring, unknown volume and rejected destination) and 5 panel traces (ask gated on consent plus prompt, separate consent intents, exact coverage/confidence rendering, stable-ID-only destinations per channel, announced unavailable/busy/error states). In the production browser the panel is mounted and registry-routed: with one part selected it comes into scope, asking is blocked until geometry consent and a prompt exist, consent is recorded canonically rather than in the DOM alone, and an unconfigured assistant reports a reason while canonical history is unchanged. Two regressions this work introduced were caught and fixed before commit: a static provider import pulled the 362 kB `@google/genai` chunk into startup and the app stopped booting offline (now a lazy port; offline smoke green again), and `paint_smart_request` gated on `hasInstanceSelection` while the panel gated on canonical part scope, so an enabled button was silently refused (both now agree on `modelCount`). 122/122 unit, 4/4 integration, 47/47 project, 5/5 settings, and 1/1 XR files pass; registry reports 158 actions = 118 partial + 40 unavailable with the XR toolbar down to 17; 27 axe rules pass; bundle main 1,860,574 bytes, JS total 9,518,498 | Automated review; **XR is unimplemented by design here** — all six actions declare an exact `xrUnsupportedReason` — and a real-provider round trip, official-Orca comparison, and touch/AT review remain pending |
| `EVID-035` | P5.3.1, P0.2 | Current worktree atop `ceb9dde`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/objects/__tests__/measure.test.ts`, `src/ui/dom/__tests__/MeasurePanel.test.ts`; line-by-line audit of pinned `Measure.cpp`, `Measure.hpp`, and `Geometry/Circle.cpp` | Node 22.21.0; Chrome for Testing 150; headless; no headset | Pass: 16 measurement traces against closed-form oracles on hand-built primitives — a 10 mm cube resolves exactly six planes of two facets each and measures 10 mm across and 90° between adjacent faces; a 24-gon prism cap resolves to a circle of exactly the construction radius while a 6-gon cap stays a polygon of edges, matching the pinned `>8`/`4..8` split; two coaxial caps measure their exact height; point-point carries signed XYZ components; point-edge separates strict from infinite past the endpoint; point-circle is exact on and off the axis; edge-edge reports the nearest pair and a right angle while parallel edges report none; edge-plane measures only when perpendicular to the normal; plane-plane gives distance when parallel and angle when not; a pick inside the pinned 0.5 mm hover limit claims the edge and one within the endpoint limit promotes to a point; and world transforms move a feature into millimetres while refusing a non-uniformly scaled circle. Plus 4 panel traces proving the readout renders only values the measurement produced. 124/124 unit, 4/4 integration, 48/48 project, 5/5 settings, and 1/1 XR files pass. One `test:a11y` run timed out waiting for boot immediately after the E2E Chrome suite; run alone and on a clean full re-run it passes 27 axe rules, so it is recorded as contention, not a regression. Bundle main 1,880,332 bytes, JS total 9,538,256 | Automated review; **two documented deviations** — a deterministic algebraic circle fit replaces upstream's default-seeded `circle_ransac` because `std::sample` ordering is implementation-defined, and circle-to-circle across non-parallel planes is reported unsupported rather than approximated — plus a differential corpus against a compiled pinned build, on-screen dimension annotations, and XR all pending |
| `EVID-036` | P5.3.2, P0.2 | Current worktree atop `86c03c1`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/objects/__tests__/assembly.test.ts`, `src/ui/dom/__tests__/MeasurePanel.test.ts`; audit of pinned `Measure::get_assembly_action` and the `set_to_parallel` / `set_to_center_coincidence` / `set_parallel_distance` / `set_to_reverse_rotation` / `set_to_around_center_of_faces` implementations | Node 22.21.0; Chrome for Testing 150; headless; no headset | Pass: 10 assembly traces against closed-form expectations — availability reproduces the pinned plane-pair rules including the signed parallel distance and its sign flip below the reference plane; parallel turns the moving normal onto `-normal1`; an already-aligned pair refuses rather than nudging; centre coincidence turns then lands the moving face centre exactly on the fixed one; parallel distance places the face at an exact signed offset for positive, zero, and negative gaps; reverse rotation flips the face and mirrors the origin through the plane; a 90° face-centre rotation sends (5,0,0) to (0,5,0); explosion is exactly zero at factor 1 and centroid-relative above it; and an alignment composes correctly onto an already-rotated instance. Plus 3 new panel traces: controls appear only with two picks, follow exactly what the pair allows, disable entirely when both picks are on one model, and commit the gap field's exact value. 125/125 unit, 4/4 integration, 49/49 project, 5/5 settings, and 1/1 XR files pass; registry reports 160 actions = 122 partial + 38 unavailable with the XR toolbar at 15; 27 axe rules pass; bundle main 1,889,827 bytes | Automated review; **the exploded view is computed but not rendered**, so no explosion slider is offered rather than a control that does nothing; upstream's same-object volume-level mode, on-canvas alignment handles, a differential corpus against a compiled pinned build, and XR all remain |
| `EVID-037` | P5.3.5, P0.2 | Current worktree atop `25093cf`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/objects/__tests__/simplify.test.ts`; audit of pinned `QuadricEdgeCollapse.cpp` and `GLGizmoSimplify::Configuration` | Node 22.21.0; Chrome for Testing 150; headless; no headset | Pass: 9 simplification traces — the pinned `fix_count_by_ratio` reproduced across both saturating ends and its rounding; a 50 % count-driven run on a 528-triangle sphere respects the budget, keeps the bounding radius within 0.75 mm, leaves no degenerate triangle, and compacts vertices; the same input decimates identically twice, so the deterministic tie-break holds; an error-driven run with a 1e-6 budget removes nothing and reports `stoppedOnError`, while a 1.0 budget removes triangles and never applies a collapse at or above the threshold; a ratio of 0 is byte-identical to the source; the source mesh is never mutated; progress ends at 100 and cancellation throws before producing anything; and degenerate meshes, a non-positive maximum error, a non-finite ratio, and a 100 % ratio all fail closed. A ninth trace installs a decimated sphere through `ReplaceVolumeMeshCommand` and proves the topology revision advances, support painting is invalidated, the whole change is one undo entry, and undo restores a byte-identical project. 126/126 unit, 4/4 integration, 50/50 project, 5/5 settings, and 1/1 XR files pass; registry reports 160 actions = 123 partial + 37 unavailable; 27 axe rules pass; bundle main 1,902,723 bytes | Automated review; **deviation:** upstream orders collapses through a bespoke mutable mini-heap whose tie-break depends on internal heap layout, so this port's binary heap with an explicit deterministic tie-break will not produce a bit-identical triangle set — the quadric maths, thresholds, and count derivation are the pinned behaviour. The pinned gizmo's live preview and error/count mode switch, per-object configuration persistence, a differential corpus against a compiled build, and XR all remain |
| `EVID-038` | P5.3.6, P1.3, P0.2 | Current worktree atop `fe7521c`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `src/project/objects/__tests__/brimEars.test.ts`, `src/ui/dom/__tests__/BrimEarsPanel.test.ts`; audit of pinned `BrimEarsPoint.hpp` and the `bbs_3mf.cpp` brim-ear reader/writer | Node 22.21.0; Chrome for Testing 150; headless; no printer | Pass: 7 brim-ear traces — the encoder emits the pinned header, `object_id=<1-based>|`, and `%f` six-decimal values while omitting objects with no ears entirely; a round trip is exact; the pinned reader's five error cases (missing pipe, malformed id, id 0, duplicate object, trailing values) each surface as a typed warning while every complete point still survives; a future format version is reported rather than guessed; add/remove/clear each undo exactly, with a removed ear returning at its original index and a full unwind restoring a byte-identical project; and impossible radii, non-finite coordinates, and unknown indices fail closed both in the command and in canonical validation. Plus 3 panel traces covering the locked radius without a single selected part, the pressed state, and per-ear removal. 128/128 unit, 4/4 integration, 51/51 project, 5/5 settings, and 1/1 XR files pass; registry reports 164 actions = 127 partial + 36 unavailable with the XR toolbar at 14; 27 axe rules pass; bundle main 1,918,076 bytes | Automated review; **the acceptance bar is not met**: ears are written into the archive the engine reads, but no test slices a project with ears and confirms them in the G-code, and the pinned gizmo's automatic placement (`detection_radius` / `max_angle` overhang detection) and on-model preview are absent — placement is manual only. XR is excluded by declared reason on all four actions |
| `EVID-039` | P1.3, P1.4, P3.1, P7.1, P9.3, P10.7, P12.3 | Current worktree atop `0ce15cb`; commit pending | `9fd12ff...` | 2026-08-09 | `npm --prefix web run quality`; `npm --prefix server test`; `npm --prefix wasm run verify:artifacts`; `wasm/test_slice_project_fs.mjs` on the canonical projection of a real 4-colour Bambu X1C project (`drew.3mf`, 2.5 MB, 3 plates, 33 parts); live external-server slice of the same bytes | Node 22.21.0; Chrome for Testing 150; local WASM external server; no printer | Pass: a real Bambu project that previously could not slice at all now slices on both engines to 214 layers, 13 tool changes, T0-T3 — 31.2 MB in-browser and 32.7 MB through the external server. Four defects were found and fixed: (1) import preserved `model_settings.config` and `project_settings.config` as opaque blobs *after* consuming them, so on save the originals overwrote the regenerated files — silently discarding every canonical edit and reinstating object ids the regenerated core no longer had, which made the engine reject the archive ("can not find object for assemble item, id=10"); preservation now excludes a consumed path only when the writer regenerates it, so a consumed path the writer does not emit stays preserved as the only carrier of that data. (2) The project declares neither `use_relative_e_distances` nor layer G-code and the pinned default is true, so `Print::validate()` refused it; the writer now supplies the `G92 E0` the engine names and warns. (3) `ThreeProjectSurface` rendered every volume with one shared grey material, so a 4-filament project looked single-colour; each volume now takes its resolved filament colour. (4) The preset selector marked no option selected when an imported project owns its configuration, so the browser displayed the first catalog entry and implied a printer nobody chose; it now shows an explicit disabled placeholder. 130/130 unit, 4/4 integration, 52/52 project, 5/5 settings, 1/1 XR files and 24 server tests pass; 27 axe rules pass; bundle main 1,923,499 bytes | Automated review plus a real-file end-to-end slice on both engines; official-Orca comparison of the regenerated metadata and hardware print qualification remain |
| `EVID-040` | P6.5, P6.2, P0.2 | Current worktree atop `eff7cd0`; commit pending | `9fd12ff...` | 2026-08-10 | `npm --prefix web run quality`; `node tools/settings-schema/generate-scopes.mjs --check`; `src/project/__tests__/scoped-settings.test.ts`, `src/project/__tests__/scoped-settings-cross-surface.test.ts`; the scoped-override step in `scripts/e2e-smoke.mjs`; audit of pinned `Tab.cpp` (`plate_keys`, `TabPrintObject`, `TabPrintPart`, `TabPrintLayer`), `Preset.cpp`, `PrintConfig.hpp`, and `region_config_from_model_volume` | Node 22.21.0; Chrome for Testing 150 with the production CSP; headless; **no headset**, no printer | Pass: the scope table is generated from four pinned blobs rather than transcribed — 527 project keys, 8 plate, 242 object, 123 part, 124 height-range — and the generator refuses to regenerate if `TabPrintModel`'s key expression or the region-config application order changes upstream. 12 scope traces prove the narrow cases: a plate cannot hold `wall_loops`, a part cannot hold `brim_type` or `layer_height`, five plate keys exist at no other scope, and a height range outranks the part it cuts through regardless of the order the layers are supplied in. `resolveConfig` no longer refuses a part-plus-range resolution and no longer layers a key stored where the engine will not read it, reporting it instead. 4 cross-surface traces edit one sampled setting at each of the five scopes twice — once as typed text, once as a controller-style stepped value serialized by the same codec — and require identical canonical state, identical project fingerprints, and byte-identical `Metadata/project_settings.config` and `Metadata/model_settings.config`; the same edits undo to the starting project and survive a save/reopen. In the production browser the shipped picker narrows the panel when an object is selected (a plate's `print_sequence` disappears), `wall_loops` applies to that object with the project's own override map untouched, and the change undoes and redoes as one entry. 149/149 unit, 4/4 integration, 66/66 project, 7/7 settings, and 1/1 XR files pass; registry reports 171 actions = 138 partial + 33 unavailable; 27 axe rules pass; bundle main 2,065,551 bytes, JS total 9,735,345 | Automated review; **XR is absent, not adapted** — the picker and panel are DOM only and `settings_apply_scoped` reaches no XR surface, so the third surface in P6.5's acceptance is stood in for by the stepped-input path rather than proven on a headset. Engine-effect fixtures (a slice whose G-code shows the height range beating the part), official-Orca comparison of a scoped project, and touch/AT review remain |
| `EVID-041` | P9.5, P9.4, P0.2 | Current worktree atop `1257df5`; commit pending | `9fd12ff...` | 2026-08-10 | `npm --prefix web run quality`; `src/printer/__tests__/printer-storage.test.ts`, `src/printer/__tests__/moonraker-storage-simulator.test.ts`; the storage step in `scripts/e2e-smoke.mjs`; Moonraker file-manager API (`/server/files/directory`, `/server/files/metadata`, `/server/files/move`, `DELETE /server/files/gcodes/<path>`) | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP and WebSocket; **no hardware** | Pass: 8 boundary traces (folders before files and files newest first, seconds-to-milliseconds modification times, thumbnails resolved against the file's own folder and ordered largest first, an unscanned file reporting nothing rather than zeroes, four traversal and empty-target refusals that never reach the printer, exact encoded paths for delete/move/download/start, a rename that stays in its folder, and cancellation separated from failure) and 6 integration traces that drive the real `MoonrakerTransport` over HTTP: DELETE reaching the file manager, a PNG arriving as bytes rather than JSON-parsed, a move leaving the source gone and its metadata following it, and a stored file starting a print while the printer's file count is unchanged. In the production browser the shipped panel navigates into a folder, selects a scanned file and renders 1 h 30 min, 21.5 g, and a `blob:` thumbnail fetched with the session credential; reprints it with nothing uploaded; renames it in place; and deletes it only after a confirmation, with a dismissed confirmation removing nothing and a sibling thumbnail surviving the delete. The transport gained a guarded `download` with its own 256 MB cap so a file need never be reached by putting the API key in a URL. 151/151 unit, 5/5 integration, 66/66 project, 7/7 settings, and 1/1 XR files pass; registry reports 176 actions = 143 partial + 33 unavailable; 27 axe rules pass; bundle main 2,083,245 bytes, JS total 9,753,039 | Automated review; **no hardware evidence** — upload-from-disk, folder creation, job queue reorder/remove, print history, the Moonraker update manager, background-tab behaviour, and supervised qualification on the U1 and the Elegoo CC all remain, so P9.5 stays `[~]` |
| `EVID-042` | P9.6, P0.2, P10.7 | Current worktree atop `6c54152`; commit pending | `9fd12ff...` | 2026-08-10 | `npm --prefix web run quality`; `src/printer/__tests__/printer-console.test.ts`; the console step in `scripts/e2e-smoke.mjs`; Klipper G-code command reference and Moonraker `/printer/gcode/script`, `/printer/objects/query?configfile`, and `notify_gcode_response` | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP and WebSocket; **no hardware** | Pass: 10 console traces — a reporting command is safe while an unrecognised one is `caution` rather than assumed harmless, each moving/heating/halting command names its own consequence, a multi-line script takes its riskiest line and lists each command once, the running job escalates a move to dangerous while leaving a pure query safe, an empty or over-4096-character script is refused before it reaches the printer, macros are read from `configfile.settings` with dotted and bracketed `params` reads and their `|default(...)` values, a macro body that restarts the firmware is dangerous however it is named, Klipper's placeholder description is dropped, the transcript redacts the API key on entry and stays bounded at its limit, and the retype history is newest-first without repeats. In the production browser `M115` sends with no confirmation and its answer arrives over `notify_gcode_response` rather than the HTTP reply; `M84` reports "Z axis can drop" and sends nothing when the confirmation is dismissed; and `PARK_HEAD` is discovered from the printer's configuration with `X=0, Y=200`, prompts for both, and sends exactly `PARK_HEAD X=10 Y=190` after confirmation. 152/152 unit, 5/5 integration, 66/66 project, 7/7 settings, and 1/1 XR files pass; registry reports 179 actions = 146 partial + 33 unavailable; 27 axe rules pass; bundle main 2,099,370 bytes, JS total 9,769,164. One `offline:check` run timed out waiting for boot immediately after the E2E Chrome suite; run alone and on a clean full re-run it passes, so it is recorded as contention, not a regression | Automated review; **the camera and print history are untouched**, so P9.6 stays `[~]`: no webcam discovery or MJPEG/WebRTC rendering, no history or statistics surface, no XR console, and no supervised hardware run of the dangerous-command paths |
| `EVID-043` | P9.6, P0.2 | Current worktree atop `d2433bc`; commit pending | `9fd12ff...` | 2026-08-10 | `npm --prefix web run quality`; `src/printer/__tests__/printer-history.test.ts`; the history step in `scripts/e2e-smoke.mjs`; Moonraker `/server/history/list` and `/server/history/totals` | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP; **no hardware** | Pass: 8 history traces — a page carries the printer's own count rather than its row count, a record with no filename is dropped because it identifies nothing, an unfinished job reports no duration and no filament with `end_time` 0 read as "not ended" rather than 1970, a deleted file is flagged so a reprint is not implied, an outcome this build does not know keeps its raw value and renders as `Interrupted (server_exit)`, four out-of-range page requests are refused before reaching the printer, totals carry only the fields reported, and the estimate comparison is withheld unless both numbers exist and the estimate is positive. In the production browser 23 seeded jobs render with `23 jobs · 21 h 5 min printing · 96.60 m filament`, the running job shows an em dash for both its duration and its filament, the deleted file reads "No longer on the printer", a completed run reports `+10% vs estimate`, and the pager goes `Page 1 of 2` → `Page 2 of 2` with three remaining rows and Older disabled at the end. 153/153 unit, 5/5 integration, 66/66 project, 7/7 settings, and 1/1 XR files pass; registry reports 180 actions = 147 partial + 33 unavailable; 27 axe rules pass; bundle main 2,109,935 bytes, JS total 9,779,729 | Automated review; **the camera remains the one untouched quarter of P9.6** — no webcam discovery, no snapshot/MJPEG/WebRTC — and history deletion, date filtering, per-filament statistics, XR, and supervised hardware qualification all remain |
| `EVID-044` | P9.6, P10.7, P0.2 | `4b26785` | `9fd12ff...` | 2026-08-11 | `npm --prefix web run quality`; `src/printer/__tests__/printer-camera.test.ts`; the camera step in `scripts/e2e-smoke.mjs`; Moonraker `/server/webcams/list` plus an authenticated snapshot fetch | Node 22.21.0; Chrome for Testing 150 with the production CSP; simulated Moonraker over real HTTP; **no hardware** | Pass: 7 camera traces — a stream-only camera is listed with the exact reason it cannot be shown rather than half-offered, an absolute URL on another host keeps only its path so printer-host content cannot make the page a request forwarder, a declared rotation and flip are reproduced, the declared frame rate is clamped to 4 fps, a URL on the printer’s own host is kept as reported, and a printer with no camera component is reported as such instead of as an empty list. In the production browser the panel renders authenticated snapshots and stops fetching the moment the section is hidden. Two defects were found only by driving the real browser: `view_webcam` is a menu action, so an inspector-side invoke silently returned false until `INSPECTOR_MIRRORED` covered it, and the visibility subscription stopped the timer without re-rendering, so the paused caption never appeared | Automated review; live MJPEG/WebRTC/HLS transports (`ADAPT-12`), an XR surface, and supervised hardware camera qualification all remain |
| `EVID-045` | P6.4, P6.3, P0.2 | Current worktree atop `d2466d5`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/settings/presets/PresetLibrary.test.ts`; the setup step in `scripts/e2e-smoke.mjs`; the pinned corpus in `public/profiles/catalog.json` | Node 22.21.0; Chrome for Testing 150 with the production CSP; real `localStorage`, a real Blob export, and a real file picker; **no hardware** | Pass: 20 library traces — an unconfigured browser still offers every printer the corpus ships, installing one nozzle hides its siblings while leaving the parent the installed profile inherits through, an unknown model or nozzle is refused with the list of what exists and the state stays byte-identical, a custom printer keeps its base’s compatibility through the pinned direct-parent-name rule, bases are filtered to what the selected printer can use, an override touching identity or naming a key no system preset defines is refused, deleting or renaming or uninstalling something another preset inherits from names the dependants, an edit keeps the creation date and moves the updated one, a bundle round-trips byte-identically with inheritance and compatibility intact, a bundle from another engine or schema is refused whole while stored state drops only the record it cannot read, a corpus change is reported on load, a planned update lists added and removed models before anything moves and refuses to orphan an authored preset, the store survives storage that refuses to write, and an override is read back in the shape the base already uses. Against the real corpus, installing the U1 0.4 mm narrows the compiled profiles to that machine with no orphaned process or filament. In the production browser an empty-storage session installs two printers, survives a real reload, authors a filament preset over a system base with a seeded override field, has a colliding name refused without writing anything, exports a bundle whose bytes are read from the Blob, deletes the preset, brings it back through the file picker, and refuses a bundle from another engine without clearing what it omitted. 158/158 unit, 5/5 integration, 67/67 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 172 tests and `{implemented:0, partial:155, unavailable:32, blocked:0}`; 27 axe rules pass; bundle main 2,185,003 bytes, JS total 10,022,361 | Automated review; the JS-total budget was raised from 10,000,000 to 10,400,000 in the same change (roughly 7.2 MB of the total is pinned vendor code, and the main-chunk budget is the real regression guard). Editing an existing custom preset has no panel control, there is no runtime path for a corpus update, XR has none of this surface, and hardware qualification of an authored printer remains unproven |
| `EVID-046` | P9.7, P9.4, P10.6, P0.2 | Current worktree atop `da3cd0d`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/printer/__tests__/printer-status-summary.test.ts`; the phone step in `scripts/e2e-smoke.mjs`; the simulator’s new `dropSockets()` | Node 22.21.0; Chrome for Testing 150 with the production CSP at a 390×844 viewport; simulated Moonraker over real HTTP and a real websocket; **no XR hardware, no phone hardware** | Pass: 12 summary and hold traces — an unconfigured or idle-and-connected printer keeps the surface off screen while a running, paused, errored, or unconfirmable one puts it on, a heater at no target reads as one number rather than an arrow to zero, progress the printer never reported stays absent instead of zero, a lost session keeps the last reading and leads with its age rather than its percentage, an errored connection takes its sentence from the shared code table because the diagnostic deliberately carries no message, exactly the destructive commands are the held ones with the emergency stop the longest, a stale reading disables every command with one reason, a hold released a millisecond early runs nothing, an abandoned hold runs nothing even if the control is released later, and a zero-hold command fires on release. In the production browser at 390×844 the bar renders inside the shell with no horizontal overflow, a tap on cancel sends nothing and says a longer hold is needed, a hold the pointer leaves sends nothing, pause and resume each land in one tap, dropping every websocket leaves the last reading on screen labelled `Last reading …`, tone `attention`, every command disabled with a reason, and a recovery line that says it is retrying on its own — which it then does, unassisted, after which the commands return and a completed 1.1 s hold cancels the print with no second dialog anywhere on screen. 159/159 unit, 5/5 integration, 67/67 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 173 tests and `{implemented:0, partial:156, unavailable:32, blocked:0}`; 27 axe rules pass; bundle main 2,172,450 bytes, JS total 10,045,219 | Automated review; the five panels behind closed `<details>` were moved to dynamic imports in the same change, which took 33 KB out of first paint and brought the main chunk back under its budget rather than raising it. **No XR or phone hardware was involved**: the spatial card is built from the same summary and driven by the same hold machine, but controller-ray ergonomics, reach, and legibility are unproven, and the reference-device qualification P9.7 requires remains |
| `EVID-047` | P8.5, P8.2, P10.7, P0.2 | Current worktree atop `82cc47c`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/calibration/history.test.ts`; the calibration step in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; real `localStorage` and a real Blob export; **no hardware, no measured print** | Pass: 11 ledger traces — a run is recorded with the conditions it was measured under and is content-addressed so identical evidence recorded twice is one record, a definition alone suffices to record against so no printer envelope has to be fabricated, a missing required field or a chosen value that was never measured is refused, a nozzle, material, printer, or filament-preset change blocks applicability while a firmware bump only warns, an inconclusive run is inapplicable whatever matches, two runs compare with a delta only when both sides are numbers and with caveats when they are not comparable, re-run is refused when the method fingerprint has moved, the ledger deduplicates and deletes by id, an export is deterministic and refuses a payload carrying an address or a credential-shaped key at any depth, and a schema-0 record migrates forward readable, comparable, and permanently inapplicable. In the production browser two results are recorded through the shipped form, a run with no measurement is refused and writes nothing, the two compare with a `-0.2` delta and no caveats, changing the nozzle greys both rows with the condition named, the export contains both records and matches no address or credential pattern, and a confirmed delete reaches storage rather than only the list. 160/160 unit, 5/5 integration, 68/68 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 179 tests and `{implemented:0, partial:162, unavailable:32, blocked:0}`; 27 axe rules pass; bundle main 2,179,087 bytes, JS total 10,134,203 | Automated review; the calibration catalog and ledger were moved behind the panel's own dynamic import in the same change, which kept the main chunk inside its budget rather than raising it. Applying a result to a preset, staging a re-run, ledger import, XR, and any hardware-measured run remain |
| `EVID-048` | P8.3, P8.5, P6.4, P0.2 | Current worktree atop `4ff906a`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/calibration/application.test.ts`; the pinned calibration inventory | Node 22.21.0; Chrome for Testing 150 with the production CSP; **no hardware, no measured print, no official-example comparison** | Pass: 7 mapping traces — the table covers every one of the 15 pinned workflows, every bound result key is a declared result field, every preset key is a declared preset target, every declared target is either bound or supplied as a companion so nothing upstream targets is silently ignored, and the firmware hand-off flag is exactly the set of workflows whose declared scope is firmware. A flow ratio maps to `filament_flow_ratio`; a pressure-advance result carries `enable_pressure_advance = 1` with the reason attached; one temperature result feeds two keys with the second explaining itself; an input-shaping result produces two `printer.cfg` lines, no overrides, and a warning rather than an error; a result measured on another nozzle, material, or printer is refused with the mismatch named while still describing what it would have changed; and a tolerance run applies only once its derived compensations are recorded. 161/161 unit, 5/5 integration, 69/69 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 180 tests and `{implemented:0, partial:163, unavailable:32, blocked:0}`; 27 axe rules pass; bundle main 2,181,400 bytes, JS total 10,142,114 | Automated review; **this is one slice of P8.3** — parameter dialogs, preview, regenerate, slice, inspect, export/send, contextual documentation links, and the separate-session snapshot are all absent, the saved preset is versioned device state rather than a canonical undo step, and neither geometry nor semantic G-code has been compared against official examples |
| `EVID-049` | P10.5, P0.2 | Current worktree atop `0c33bdd`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/actions/__tests__/parity.test.ts` | Node 22.21.0; Chrome for Testing 150 with the production CSP; **no XR hardware and no simulator session** | Pass: the catalog went from 54 of 195 actions silently absent from every XR surface to 0, with 25 remaining absences each carrying a stated reason. Two new registry tests hold it: one refuses an action that reaches no `xr*` surface without an `xrUnsupportedReason`, the other requires every declared refusal to be a real sentence that does not simultaneously claim an XR surface, and asserts the `xr-inspector` surface is exactly the inspector-disclosure actions and that the XR shell actually renders it. 161/161 unit, 5/5 integration, 69/69 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 182 tests and `{implemented:0, partial:163, unavailable:32, blocked:0}`; 27 axe rules pass; bundle main 2,182,726 bytes, JS total 10,143,440 | Automated review; **reachability is not usability**. Nothing here was seen in a headset or a simulator: reach, legibility, ray versus direct input, scrolling a list this long, dominant hand, and the frame budget are all unqualified, and several inspector actions still open no spatial panel of their own |
| `EVID-050` | P11.2, P10.5, P0.2 | Current worktree atop `5b81dc1`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; the View step in `scripts/e2e-smoke.mjs` | Node 22.21.0; Chrome for Testing 150 with the production CSP; **no XR hardware, no visual review** | Pass: in the production browser nothing is outlined before the toggle, exactly the selected instance is outlined after it, deselecting removes the outline and reselecting brings it back, switching the toggle off disposes every outline, the navigator toggles on and off through the workspace's own reported state, and neither action renders an UNAVAILABLE badge any more. The browser found a real gap while this was written: outlines were refreshed from the click path only, so select-all left them stale; they now refresh from the canonical selection change, which every path goes through. Declared-unavailable actions dropped from 32 to 30. 161/161 unit, 5/5 integration, 69/69 project, 8/8 settings, and 1/1 XR files pass; capability parity reports 184 tests and `{implemented:0, partial:165, unavailable:30, blocked:0}`; 27 axe rules pass; bundle main 2,185,101 bytes, JS total 10,145,824 | Automated review; **no one has looked at either overlay**. The outline's offset and colour and the navigator's size and placement are unreviewed, perspective/orthographic and auto-perspective remain unimplemented, and the P0 surface-manifest classification pass has not been run |
Correction note (2026-07-20): the provisional local-commit cells in `EVID-001`–`EVID-012`
were filled with the commit that landed those runs. Their historical commands, counts, results,
dates, and residual limitations were not refreshed.

Store large reports, normalized comparison JSON, traces, screenshots, videos, and hardware photos
under the CI artifact URL named in the row; do not bloat Git with generated G-code. Small golden
fixtures and expected semantic summaries live in `testdata/parity/` with licenses and SHA-256.

### Platform-adaptation register

Each row records what upstream does, what OrcaXR does instead, **what the user actually sees
differently**, the risk that difference carries, who owns it, and what evidence would settle it.
A row is only approved when a product and an engineering reviewer both accept the outcome
equivalence; "proposed" means the replacement is implemented and argued, not that anyone has
signed it off. Anything with no equivalent outcome is a `BLOCK-*` row, never a quiet omission.

| ID | Upstream outcome | OrcaXR equivalent | User-visible difference | Risk | Owner | Evidence | Class / approval |
|---|---|---|---|---|---|---|---|
| `ADAPT-01` | Native file dialogs, recent paths, shell reveal | Browser picker and download, File System Access where the browser offers it, recent handles and metadata, diagnostics export | No OS "reveal in folder"; recents are handles this origin was granted, not arbitrary paths; a denied permission means re-picking the file | A saved project the operator cannot find again; a re-grant prompt mistaken for data loss | Engineering | P5.6–P5.7, P11.1, browser matrix | Platform-adapted / proposed |
| `ADAPT-02` | Serial/USB and native LAN discovery | An explicit Moonraker endpoint, plus an optional permissioned local proxy | The printer must be typed in once rather than appearing by itself; Chrome's Local Network Access prompt gates plain-HTTP LAN endpoints | An operator concluding the printer is unsupported when it is merely not auto-found | Engineering | P9.1–P9.2, U1/Elegoo setup study | Platform-adapted / proposed |
| `ADAPT-03` | Vendor cloud login, device binding, cloud transport | An authenticated direct Moonraker connection and a local multi-printer manager | No account, and no access to a printer that is only reachable through the vendor cloud | A printer usable in the vendor app and unreachable here | Product | P9, security review, outcome comparison | Platform-adapted / proposed |
| `ADAPT-04` | AMS / vendor filament slot UI | Target-printer head, tool, and spool capability with FullSpectrum dependency mapping, and one-command sync from the machine's own reported slots | Slot state is what the printer reports over Moonraker, not a vendor-specific widget; a slot the firmware does not report cannot be shown | A mapping that looks complete while the machine disagrees | Engineering | P3.9, P9.3, live Snapmaker U1 four-slot sync | Platform-adapted / proposed |
| `ADAPT-05` | Vendor publish and model-cloud pages | Local, URL, and approved-catalog import/export with explicit provenance, and no forced account | No in-app model marketplace or publishing | An expectation of one-click sharing that does not exist | Product | P5.8, P10.7, user study | Platform-adapted / proposed |
| `ADAPT-06` | Desktop windowing, DPI handling, update installer | Responsive PWA, browser zoom, accessible scaling, controlled service-worker plus profile and engine version reporting | Updates arrive by reload rather than an installer; no OS window chrome | An operator unsure which engine build produced an artifact | Engineering | P10.1–P10.5, P10.8–P10.10 | Platform-adapted / proposed |
| `ADAPT-07` | Desktop mouse, 3D input conventions, native shortcuts | Documented mouse, keyboard, touch, and XR bindings with a command-palette alternative for every action | Chorded mouse gestures are replaced by explicit modes; some flows are DOM-only and say so | Muscle memory from the desktop app not transferring | Engineering | P5.1, P10.2–P10.5, P10.9–P10.10 | Platform-adapted / proposed |
| `ADAPT-08` | Desktop font enumeration for text embossing | A font file the operator picks, read as TrueType `glyf` outlines | No system font list; the operator supplies a `.ttf` (or `.ttc`) once per text part, and an OpenType/CFF font is refused by name rather than silently producing nothing | Text that cannot be recreated later without the same font file to hand | Engineering | P5.3.3, system-font sweep over 12 fonts × 117 glyphs | Platform-adapted / proposed |
| `ADAPT-09` | Desktop SVG import with full CSS and paint-server support | Filled shapes resolved to contours, with every unsupported construct reported by element and reason | Text, raster images, `use`, clip paths, masks, filters, gradients, and stroke-only shapes are named in the panel before cutting instead of quietly missing from the part | A drawing that cuts into a part the operator did not expect | Engineering | P5.3.4, 7,314-icon watertightness sweep | Platform-adapted / proposed |
| `ADAPT-10` | Desktop credential storage in an OS profile | Printer API key and slicer token kept in this browser's storage, behind an explicit switch that also erases them | Secrets survive a reload as they would on the desktop, but anything able to run script on this origin can read them; the app's CSP — no remote script, nothing inlined — is what bounds that | A shared machine retaining a working printer credential | Product | P6.6, P9.1, P10.7, first-run E2E | Platform-adapted / proposed |
| `ADAPT-11` | Desktop slicing with a locally trusted binary | The verified browser WASM engine, or an external server that proves its engine over `/engine` before receiving canonical work | An external slicer must publish provenance — matching WASM artifacts, or the pinned commit plus the pinned patch set for a CLI — and is refused by name otherwise | An unattested engine silently producing different G-code | Engineering | P7.1, P12.3, live CLI attestation and slice | Platform-adapted / proposed |
| `ADAPT-12` | A live MJPEG, WebRTC, or HLS camera feed | Authenticated snapshots fetched through the same credentialed transport as every other printer call, at up to 4 fps, paused whenever nobody is watching | The picture updates a few times a second instead of continuously, and a camera that offers only a stream is listed with that reason rather than shown | An `<img>` or `<video>` pointed at the printer cannot send `x-api-key`, so on a secured printer the feed would be a broken image; making it load would mean putting the key in the URL, which the transport refuses. Snapshots keep the credential in a header and work for every service type | Engineering | P9.6, P10.7, hardware camera qualification | Platform-adapted / proposed |
| `ADAPT-13` | A modal confirmation dialog before a destructive printer command | On the compact status surface, a press-and-hold — 800 ms to cancel, 1200 ms for an emergency stop — that states the consequence while it fills and sends nothing if released early | The desktop panel keeps its dialog; on the phone bar and the spatial card the gesture is the confirmation, and no second dialog follows | A modal over a status bar on a phone is dismissed by the same thumb that opened it, and a controller ray has no comfortable way to reach a dialog button that appears where it was not looking. A hold is the one gesture a thumb, a mouse, and a ray perform identically, and it cannot be completed by a brush past the control. Two confirmations for one act teaches people to dismiss both without reading either | Engineering | P9.7, P9.4, P10.5, reference-device qualification | Platform-adapted / proposed |

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
| 2026-07-17 | Fail closed instead of slicing stale FullSpectrum bytes or flattening painted semantics | Exact semantic snapshots and canonical revision/hash guards prevent a successful but mislabeled monochrome or stale artifact | P1.5, P4.10, P7.1 | Fault/unit tests complete; canonical live adoption and engine-route qualification pending |
| 2026-07-17 | Restrict authored mixed-filament components and component remaps to stable physical-head IDs | Pinned `MixedFilament.hpp` defines `component_a`, `component_b`, and gradient IDs as 1-based physical filament IDs; nested virtual recipes have no v2.3.4 engine semantics | P3.1–P3.2, P4.5 | Type/runtime/command tests complete; official serializer/UI qualification pending |
| 2026-07-20 | Resolve 3MF Production references by normalized package path plus model-local object ID, preserve original split members opaquely, and strip `p:path` from the generated flattened core | Production object IDs are local to each model part, so a global numeric-ID map aliases valid resources; retaining source members preserves unsupported metadata without leaving generated components bound to stale external IDs | P1.3 | Qualified graph and malformed-input tests plus read-only MarbleRunTube headless smoke pass; affine oracle and official GUI round-trip pending |
| 2026-07-20 | Bind every published G-code artifact to the exact submitted semantic snapshot; make preview/download/send fail closed after drift and keep real printer mutation disabled until mapping, preflight, confirmation, integrity, and reconnect are complete | A successful stale artifact or direct print bypass can act on content different from the visible project and is safety-critical | P1.5, P7.1–P7.2, P9.3–P9.4 | Workspace guard tests pass; canonical live coordinator and printer hardware lifecycle pending |
| 2026-07-20 | Keep browser AI and Moonraker credentials session-only by default; purge known plaintext AI keys and redact credentials from URLs, errors, and diagnostics | Browser storage, logs, and copied diagnostics must not become durable secret stores | P6.6, P9.1, P10.7 | Focused secret/transport tests pass; production threat review pending |
| 2026-07-20 | Make `web/src/printer/` the future single Moonraker connection boundary and retire legacy clients when live wiring lands | Explicit typed endpoint/state/transport semantics avoid probe drift, stale events, duplicated credentials, and unsafe mutation paths | P9.1–P9.6, P10.7 | Headless protocol suite passes; live UI/mutation/hardware wiring pending |
| 2026-07-20 | Live-wire the typed Moonraker boundary only for registry-guarded handshake and read-only sparse slot inspection; never compress or auto-apply physical slot identities | A reported H1/H3 set cannot safely become palette rows 1/2 or inherit project temperatures; inspection is useful only if it cannot silently change print intent | P0.2, P9.1, P9.3, P10.7 | Focused transport/parser/preference tests pass; mapping, mutation, and hardware review pending |
| 2026-07-20 | Activate external-slicer routing only after a successful probe backed by explicit opt-in; persisted URL metadata alone never enables it | A stale saved endpoint or failed replacement must not silently upload project geometry outside the browser after the user selected Off | P7.1, P10.7 | Focused preference/race tests pass; production threat/device review pending |
| 2026-07-23 | Make `CanonicalWorkspaceController` the live workspace owner and delete raw-project/scene-baked save, open, and slice fallbacks | A dormant second state model could reintroduce metadata loss or publish G-code for content different from the visible canonical project | P1.2, P1.4–P1.6, P7.1 | Focused controller/import/action tests pass; full quality, official Orca/G-code, browser/XR, and hardware qualification pending |
| 2026-08-07 | Dispatch every model import by content signature first, fail closed on extension/signature disagreement, and route mesh sources through the transactional canonical import coordinator | Parsing an unknown container as STL silently produced wrong geometry, and a direct add bypassed preview/undo guarantees that project import already provided | P1.4, P5.6, P0.2 | Format/staging tests and the web quality gate pass; official corpus and drag/drop qualification pending |
| 2026-08-07 | Make colour painting a canonical live tool: one UI-independent stroke service, a stable-ID palette shared by DOM and XR, and derived overlays; delete the legacy display-colour paint panel and brush state | A second display-colour paint path could not persist, undo, or slice, and kept the tool honest only by staying disabled; the canonical facet channels already existed | P4.2–P4.4, P0.2 | Painting/registry/shortcut tests and the production browser smoke pass; official round-trip, XR, and hardware evidence pending |
| 2026-08-08 | Author every facet channel through one live paint tool set, and make the XR rail an explicit finite list instead of "any action with a tool" | Support, seam, and fuzzy-skin painting differ only by channel and assigned state, so a second implementation would duplicate the stroke, history, and overlay contracts; letting new modal tools auto-join the rail would silently break the finite-rail requirement | P4.6–P4.8, P10.5 | Channel traces and the browser support-paint pass; oracles, official round-trip, and headset review pending |
| 2026-08-08 | Keep XR component construction behind exact pinned types and explicitly withhold any action whose only completion flow is DOM-only | Guessed option bags bypass the reactive API contract, while advertising printer submission in-headset without an XR confirmation strands a safety-critical workflow | P10.7, P10.9–P10.10 | Typed adapter/action/gesture tests pass; composite gallery, native printer dialog, simulator, and headset review pending |
| 2026-08-08 | Treat the complete manifest-backed literal `Tab.cpp` inventory as generated settings layout authority; fail dynamic/widget/scope gaps closed and label unresolved dependency/reset behavior unenforced | A definition key alone does not prove that a user can reach or safely edit it, and self-consistent generated relationships can hide truncation unless fixed inventory counts and every owner binding are independently pinned. Calling imperative predicates or per-control reset rules fail-closed while their exact fields remain editable would be false, so their distinct disposition is loader-pinned | P6.1–P6.2, P6.5 | Generator/self-test, strict-loader, editor, live-panel, and independent review traces pass; runtime dump and remaining GUI semantics/surfaces pending |
| 2026-08-08 | Render the live preview from the bounded rich model plus preview projection, and delete the ad-hoc line renderer's role in the viewer | The projection already owns colour, filtering, legends, and explicit metadata gaps; a second renderer would invent colours the source never carried and could not report why a mode is unsupported | P7.3–P7.5, P7.7 | Session traces and the browser standalone-G-code pass; goldens, playback, and XR pending |
| 2026-08-08 | Keep each pinned XY G2/G3 command as one source-addressable semantic record with a bounded dense path sidecar, expanding it only in geometry consumers | Inspection, statistics, playback, and source windows require stable unrenumbered command identity, while rendering needs the pinned Float32 interpolation. Fake move rows would multiply metadata and source IDs. Parser limits therefore publish no partial arc; the lower render cap clears stale geometry and retains narrowing controls. Negative-E arcs keep the pinned Extrude kind but use finite width metadata instead of propagating NaN. | P7.3–P7.5, P7.7, P10.2 | 69 focused traces, full web quality, source audit, and two independent reviews pass; official compiled differential/goldens, streaming, XR, and hardware remain |
| 2026-08-08 | Let pinned-engine gates verify committed locks/manifests when `third_party/SnapmakerOrca` is absent, and revert the unbuilt WASM statistics entry point | CI and clean clones have no developer checkout, so `profiles:verify`/`calibration:verify` crashed instead of proving anything; separately, a source edit that was never compiled into the published artifacts broke provenance and would have advertised an engine capability the shipped binary lacks | P0.3, P6.3, P7.6, P8.1, P12.3 | Full web gate passes with and without the checkout; `verify:artifacts` passes again |
| 2026-08-08 | Build the browser engine with `-sDYNAMIC_EXECUTION=0`, attest imported projects from their own embedded configuration, and never emit an OPC relationship to a part this package does not contain | embind's `new Function` invokers made every in-browser slice fail under the app's own CSP; requiring catalog presets blocked slicing any imported project, which is the main multicolor/FullSpectrum workflow; and a preserved relationship left dangling by the one-plate projection made the pinned engine reject the archive entirely | P1.3, P3.9, P7.1, P7.2, P10.7 | Engine, serializer, and preflight traces plus a live browser FullSpectrum slice; hardware print qualification pending |
| 2026-08-08 | Enable real printer mutation behind an explicit two-button confirmation, live tool mapping, and byte-exact size verification, superseding the 2026-07-20 decision to keep it disabled | The conditions that decision named are now met: the artifact is bound to its semantic snapshot, the job's tools are compared against the printer's reported slots, the filename never silently replaces a stored file, and the stored size is checked before anything starts. Storing a file and starting a print stay separate actions, because only the second one moves a machine | P9.3–P9.4, P1.5, P7.1 | Submission, mapping, and simulator traces plus a production-browser send pass; queue/lifecycle control, reconnect during transfer, and supervised hardware qualification pending |
| 2026-08-08 | Write BBS project settings the way the engine reads them — string-valued, with one entry per filament for every key in the pinned `Preset::filament_options()` — and inherit the chosen filament into tool slots the selection never named | `ConfigBase::load_from_json` silently drops an option whose array holds numbers, and `num_extruders` comes from `filament_diameter.size()`, so a scalar clamped every per-object extruder to tool 1: a two-colour plate sliced, uploaded, and would have printed in one colour with no error anywhere. The default palette independently paired PLA with ABS, which the engine refuses outright | P1.3, P3.1, P7.1, P9.3 | Serializer, preset-graph, and engine traces plus a browser T0+T1 slice; official Orca round-trip of the rewritten settings pending |
| 2026-08-08 | Restore `append_full_config` in the Emscripten build | The gate predated `fixup_enum_keys_map()`, which already runs on the slice config at both wasm entry points; without the dump an OrcaXR artifact carried no `filament_colour`/`filament_type`, so the send-time mapping could never compare materials or colours and our own G-code re-import lost every process key | P7.1, P9.3, P12.3 | Engine cube/project slices and `verify:artifacts` pass with the rebuilt artifacts; desktop G-code diffing pending |
| 2026-08-08 | Derive every printer lifecycle control from the machine's own reported state, and re-read that state at the transport before sending — refusing outright when the printer has moved on to a different file | A control surface that trusts what this client last did is wrong the moment anyone touches the printer's own screen, and a stale panel that pauses or cancels the *next* job is worse than one that refuses. Availability and the guard therefore both come from the printer | P9.4, P9.5 | Status, control, simulator, and production-browser lifecycle traces pass; queue control and hardware qualification pending |
| 2026-08-09 | Prove an external slicer's engine over `/engine` before sending it canonical work, and accept a CLI engine on its pinned commit plus pinned patch set rather than on WASM artifact digests | Comparing every external server against the browser's own WASM digests structurally forbade the CLI route, which is the one that exists to match desktop output; a native binary has no such artifacts. Its real identity is the commit it was built from and the patches applied on top, and those patches are the entire difference from stock upstream, so an unknown or altered one is refused by name | P7.1, P12.3 | Server 24/24 including the swapped-binary path, client matrix across correct/extra/missing/tampered/silent/wrong-commit, live attestation and slice against the deployed server; hardware print pending |
| 2026-08-09 | Remember the printer API key and external-slicer token on the device by default, superseding the 2026-07-20 decision to keep browser credentials session-only | That decision was right about browser storage being a poor secret store and wrong about the consequence: a server published beyond loopback refuses to start without a token, the client had nowhere to put one, and canonical slicing was therefore permanently blocked on every correctly secured deployment. Re-typing both on every reload also made the app unusable as a daily tool. The trade is now explicit rather than implied — an operator switch that also erases what is stored, and a CSP that admits no remote script — and diagnostics redaction is unchanged. The AI-key half of the 2026-07-20 decision stands | P6.6, P9.1, P10.7 | Focused store tests plus a production-browser configure/reload/forget cycle; shared-device threat review pending |
| 2026-08-09 | Scale every facet-refinement budget with the source triangle count instead of a flat node cap | A refinement carries exactly one root per triangle, so a fixed ceiling is really a cap on how many triangles a painted mesh may have. A real 1.9M-triangle painted project the pinned engine opens was refused in six places — import, validation, save, reopen, and twice more on the render path, where the failure showed as a multicolour model drawn in one colour. What needs bounding is expansion beyond the geometry the archive already spelled out, which the ZIP guards independently limit | P1.3, P4.2 | Budget and validation traces, plus the real file opening, saving, reopening, and slicing to 490 layers across three tools |
| 2026-08-08 | Keep the emergency stop offered when Klipper is down and every other command is refused, and gate it on one confirmation rather than a typed phrase | The state where nothing else is allowed is exactly the state where a hard stop is needed; and friction that delays a real stop is worse than the accidental click it prevents. The dialog instead spends its words on the consequence — Klipper stays halted until a firmware restart | P9.4 | Control traces cover the halted-Klipper case; the browser pass proves a dismissed confirmation sends nothing |
| 2026-08-08 | Store layer events by exact height and project them into the engine's own `custom_gcode_per_layer.xml`, offering only the kinds the selected printer profile declares a body for | A layer index is invalidated by any layer-height change, while the engine resolves a height against the layers it actually produced. And an event kept only in the OrcaXR envelope never reaches the slicer at all: the operator would see a pause in the project and none in the print. Colour change and template take their body from profile settings, so offering them without one emits an empty marker the machine ignores | P7.8, P1.3 | Command, serializer, engine, and production-browser traces pass; slider authoring, preview ticks, and filament sequences pending |
| 2026-08-08 | Report a layer's height from its extrusions, and locate an event by its layer rather than by the record's own Z | The layer index took the maximum Z over every record, so a retraction Z-hop on a travel overstated the layer by the hop; anything authored or located against it was placed at a height the printer never prints at. An event marker is likewise emitted before the Z move that follows a layer change, so its record Z belongs to the previous layer | P7.5, P7.8 | An inspection trace pins both the hopped and travel-only cases; the browser pass shows a pause authored at 3.4 mm reported at 3.45 mm, the first layer at or above it |
| 2026-08-08 | Show the totals the engine wrote into the artifact rather than recomputing them from parsed toolpaths, and make the slice status line use the engine's own layer count | The slicer already accounted for every extrusion, purge, and tool change; a second derivation would produce subtly different numbers with no way to say which is right. Counting layer-change markers disagreed with the engine's total by three on the smoke fixture, and two disagreeing layer counts in one UI is worse than either | P7.6, P7.1 | 6 summary traces plus a browser pass; the verified sidecar contract, per-role breakdown, and cost units remain the open half |
| 2026-08-09 | Make canonical preflight refuse every silent FullSpectrum/prime-tower repair the pinned engine would perform, and derive printer capability only from the resolved target's physical tool count | The engine does not report these: it clamps an out-of-tool-count extruder back to tool 1, clamps gradient endpoints into `[0.01, 0.99]`, drops duplicate and beyond-count gradient components while decoding, and refuses an incompatible material pair — each producing a print the project never authored, with no error anywhere. Capability had no honest source either, so it is taken from the target itself and left unevaluated when undeclared, never inferred from the authoring UI having allowed a virtual row. New checks go in preflight only where `validateProjectState` cannot already see them, because preflight short-circuits on canonical errors and duplicating them would be noise | P3.9, P7.2, P3.1 | 16 preflight and 6 derivation traces plus the full web gate pass (`EVID-033`); every hardware bullet — U1 reference prints, the Elegoo CC determination, official G-code comparison, and safety sign-off — remains unproven, so P3.9 stays `[~]` |
| 2026-08-09 | Let an assistant propose paint regions but never paint: a bounded typed proposal is projected onto the volume's own facets, previewed, corrected, and committed through the same `PaintStrokeService` as a manual stroke | A model cannot address our stable IDs or our tessellation, and the removed prototype proved that anything writing display colours directly cannot persist, undo, remap, or slice. Restricting proposals to normalized boxes and normal cones keeps projection exact and deterministic, while free-form polygons would need a camera the proposal never declared. Consent is per payload kind and per provider and is checked before the request, because a privacy promise made after the bytes leave is not a promise. And the provider SDK loads lazily: importing it statically pulled a ~360 kB chunk into startup and the app stopped booting with no network, which breaks the requirement that manual painting keeps working offline | P4.9, P0.2, P10.8 | 9 projection/session and 5 panel traces, a production-browser consent-gate pass, and the full web gate (`EVID-034`); XR is withheld by declared reason on all six actions, and a real-provider round trip remains unproven |
| 2026-08-09 | Split P5.3 into six per-gizmo children, and port measurement with two stated deviations rather than a silent approximation | P5.3 bundled roughly 10,700 lines of pinned GUI across six unrelated gizmos behind one checkbox, so partial delivery could not be reported honestly. For measurement itself, upstream's `circle_ransac` seeds `std::mt19937` and draws through `std::sample`, whose ordering is implementation-defined — bit-exact replication is impossible in another language, so a deterministic algebraic fit with the pinned error metric and threshold is strictly better than pretending to match. Circle-to-circle across non-parallel planes needs a degree-8 polynomial root finder; reporting it unsupported is honest, while an approximation would be a wrong dimension on a part someone prints | P5.3, P5.3.1 | 16 measurement and 4 panel traces against closed-form oracles plus the full web gate (`EVID-035`); a compiled differential corpus and XR remain |
| 2026-08-09 | Decimate with our own deterministic quadric-error collapse and install it through the existing guarded topology command | Upstream's collapse order depends on a bespoke mutable mini-heap's internal layout, so a bit-identical port is not achievable and pretending otherwise would be a false parity claim; an explicit deterministic tie-break is reproducible, which is what a user actually needs when they re-run a decimation. Routing the result through `ReplaceVolumeMeshCommand` rather than a bespoke path means the new topology, the invalidated facet channels, and asset ownership are already one undoable transaction with the guards that command enforces | P5.3.5, P5.2 | 9 traces including a guarded install that undoes to a byte-identical project (`EVID-037`); the pinned live preview and a compiled differential corpus remain |
| 2026-08-08 | Persist refined facet intent as a bounded version-1 source-root/child-path tree and make the exact BBS nibble stream a secondary projection with explicit representability limits | Sparse source faces cannot identify a subdivided child after save/reopen. The pinned stream reverses child order and hexadecimal output, carries wire states through 255, but the pinned color consumer supports only material states `1..64`; if any refined child is unavailable, omitting the whole standard root is safer than changing sibling topology, while the canonical envelope remains lossless. Package-global decode and component-materialization budgets prevent compact component graphs from amplifying refined or sparse annotations, and legacy sparse fuzzy `false` is validated then migrated to inherited state rather than making schema-v1 files unreadable | P1.3, P4.1–P4.8, P10.6–P10.7 | 18 serializer, 3 codec, painting/remap/overlay traces, full web quality, and two independent code reviews pass; compiled upstream differential and official GUI/G-code/hardware qualification pending |
| 2026-08-10 | Generate which settings each scope may override, and the order the scopes layer in, from the pinned engine rather than transcribing them; refuse an out-of-scope override on write while preserving foreign keys on read | The two facts that matter here both contradict what the UI nesting implies — a plate may override eight keys and not the 242 an object may, and a height range outranks the part it cuts through — so a hand-written table would drift into a project that looks configured and slices as if it were not. Strict on write is what makes the failure visible at the moment someone causes it; lossless on read is what keeps P1's round-trip guarantee, since a plate's `locked` and an imported object's `extruder` are stored on those nodes without being overrides at all | P6.5, P6.2, P1.3 | Generator `--check` against four pinned blobs, 12 scope traces, a 4-trace cross-surface comparison of canonical state and both generated 3MF configs, and a production-browser scoped edit; XR surface and slice-effect fixtures pending |
| 2026-08-10 | Give the printer's own files a first-class browser, and never reach one by putting the API key in a URL | Sending a plate is half a print workflow; the other half is the file already on the machine, and without a browser an operator has to leave for Fluidd to reprint something OrcaXR can already see. Authenticating thumbnails and downloads through the transport rather than an `<img src>` keeps the existing refusal of credentials-in-URLs intact, at the cost of a new guarded byte path with its own size cap. Every operation carries the exact path the last listing returned, because a delete that lands on a neighbouring row is unrecoverable | P9.5, P9.4 | 8 boundary traces, 6 integration traces over real HTTP, and a production-browser browse/reprint/rename/delete pass; hardware and the update manager pending |
| 2026-08-10 | Classify every console command before sending it, treat anything unrecognised as risky rather than safe, and let the running job escalate the answer | A console is the one printer surface with no guard rails of its own. A table that only warned about commands it knew would be silent exactly where it matters, since a user macro can contain anything; and the same move is unremarkable idle and reckless mid-print, so the machine's current state has to be read rather than remembered by the caller. The cost is that ordinary macros ask for confirmation the first time, which is the right side to err on | P9.6, P10.7 | 10 classifier/macro/transcript traces plus a production-browser query, a dismissed stepper release that sent nothing, and a parameterised macro run; camera, history, XR, and hardware pending |
| 2026-08-10 | Page the print history from the count the printer reports, and withhold every derived number whose inputs are missing | Paging from the returned row count silently makes the last page unreachable once a page is short. And the derived numbers are the ones most likely to mislead: an estimate comparison against a missing or zero estimate is not a 100 % overrun, and a job that never finished did not print in zero seconds using zero filament. Both cases now read as em dashes, which says what is true — the printer did not say | P9.6 | 8 history traces plus a production-browser pass over 23 seeded jobs including an unfinished one, a deleted file, an unknown outcome, and paging to the last job and back; camera, hardware, and XR pending |
| 2026-08-11 | Render every printer camera as authenticated snapshots, and stop fetching the moment nobody is watching | An `<img>` or `<video>` pointed at the printer cannot send `x-api-key`, so on a secured machine the feed is a broken image, and the only way to make it load is to put the key in the URL — which the transport refuses on purpose. Snapshots keep the credential in a header and work for every service type, at the cost of a few frames a second. And because every frame is its own request, polling is part of the feature rather than an implementation detail: a hidden tab or a collapsed section must stop costing the printer requests | P9.6, P10.7 | 7 camera traces plus a production-browser pass that shows snapshots and then stops fetching once hidden (`EVID-044`); live stream transports (`ADAPT-12`), XR, and hardware qualification pending |
| 2026-08-16 | Make installation a visibility filter over the pinned corpus, and a custom preset an overlay on a system base rather than a flattened config | Removing an uninstalled machine looks correct and breaks the catalog: Snapmaker’s and Elegoo’s nozzle variants inherit from one another, so dropping the 0.4 mm profile because only the 0.2 mm was installed would orphan the profile that stayed. Hiding it keeps the chain intact and still makes it unselectable everywhere — pickers, preflight, and slicing all read the composed catalog. Storing an overlay rather than a copy is what makes an authored preset survive a corpus update and keep its base’s compatibility through upstream’s direct-parent-name rule; a flattened config would be frozen at the version it was authored against and compatible with nothing. Local state and a bundle are then deliberately asymmetric: a bundle is refused whole because the operator still has the file, while stored state drops only the record it cannot read, because it is the only copy of their setup | P6.4, P6.3, P6.2 | 20 library traces including a real-corpus narrowing check, plus a production-browser pass that configures an empty browser and round-trips the whole setup through a bundle (`EVID-045`); a runtime corpus-update path, preset editing in the panel, XR, and hardware qualification pending |
| 2026-08-16 | Keep the last reading when the session drops — labelled with its age and with every command refused — and make destructive commands held rather than tapped | Discarding the snapshot the moment the socket went was the safe-looking choice and the wrong one: mid-print it throws away the most useful thing on screen, while the print carries on regardless. Keeping it is only honest if it is marked, so the age leads the detail line and every lifecycle command is refused until the machine can confirm itself — a pause that may not have arrived is worse than no pause. The gesture is the other half. A modal over a phone status bar is dismissed by the thumb that opened it and a controller ray has no comfortable way to reach a button that appeared where it was not looking, so the confirmation became a hold that states its consequence while it fills; it then replaces the desktop dialog on that surface rather than stacking on it, because two confirmations for one act teach people to dismiss both | P9.7, P9.4, P10.5 | 12 summary and hold traces plus a production-browser pass at 390×844 that drops every websocket mid-print, recovers unassisted, and then cancels only on a full hold (`EVID-046`); XR and phone hardware ergonomics pending |
| 2026-08-16 | Record the conditions a calibration measurement was taken under, and refuse to offer a result whose conditions have moved | A calibration number is only meaningful with the machine, nozzle, and material it was measured on; a pressure-advance value from a 0.4 mm nozzle in PLA is wrong on a 0.6 mm nozzle in PETG, and applying it silently is worse than never calibrating. Judging applicability against the live profile rather than a remembered one is what makes that guarantee hold after a filament change. The record stays visible either way, because evidence that no longer applies is still evidence — and a schema-0 record migrates forward with unknown conditions rather than being dropped or given invented ones, since an invented condition is a lie that later auto-applies. The export carries no secret by construction *and* by proof: the type has no field for one and the exporter refuses a payload that contains anything credential- or address-shaped, because this is the file someone attaches to a forum post | P8.5, P8.2, P10.7 | 11 ledger traces plus a production-browser pass that records two results through the shipped form, compares them, invalidates both with a nozzle change, exports, and deletes (`EVID-047`); applying a result to a preset (P8.3) and hardware runs (P8.6) pending |
| 2026-08-16 | Write the calibration result-to-preset mapping out per workflow instead of deriving it, and hand firmware targets over rather than applying them | The inventory says which preset keys a workflow targets but not which measured field feeds which key, and the relationship is not one-to-one: one temperature result feeds two keys, a pressure-advance number is inert without its enable flag, and the input-shaping workflows target Klipper configuration no preset can hold. Any derivation would eventually put a real number in the wrong option, which is a worse failure than refusing. Writing it out costs a table that a test holds against the inventory in both directions, so it cannot drift silently. For the firmware cases the honest output is instructions, not a write: reporting "applied" while writing nothing is the worst outcome available. And the write itself reuses the preset library's validated path so versioning, provenance, and key refusal come for free rather than being reimplemented next to it | P8.3, P8.5, P6.4 | 7 mapping traces including a both-directions inventory check and a refusal under changed conditions (`EVID-048`); dialogs, preview/slice/inspect, official-example comparison, and hardware pending |
| 2026-08-16 | Derive an XR surface for inspector actions, and make "absent from XR" a thing an action has to say out loud | Surfaces were derived from disclosure, and `inspector` mapped to a DOM surface only. The effect was that every printer, preset, calibration, and settings control was missing from the headset while looking exactly like work that had not been done yet — 54 of 195 actions, none of which had ever declared themselves unsupported. Deriving `xr-inspector` fixes the reachability; the test is what stops it recurring, because the failure mode here is silence rather than error. An action may still be XR-unsupported, but now it has to say so in a sentence, and it may not claim both a reason and a surface | P10.5, P0.2 | Catalog reachability measured before and after (54 → 0 silent absences) plus two registry invariants and the full gate (`EVID-049`); every headset-dependent acceptance clause — reach, legibility, input modes, frame budget — pending |
| 2026-08-16 | Draw the selection outline as an inverted-hull silhouette refreshed from the canonical selection, and make the navigator display-only | A bounding box would have been easier and would have answered a question the transform gizmo already answers; the question an outline exists for is which of two overlapping models is selected, and only a silhouette answers it. Doing it with back-face geometry rather than a post-processing pass keeps it working in a renderer whose pipeline is not ours to extend. Refreshing from the canonical selection change rather than from `selectModel` is what makes it correct for select-all and the Objects tree — wiring the click path alone looked right and was not. The navigator reports orientation and does not accept clicks: a target that small is a miss on a touch screen and a fight with a controller ray, and the named camera actions already cover going to a face | P11.2, P10.5 | A production-browser pass over toggle, follow, and dispose plus the full gate (`EVID-050`); visual review, perspective/orthographic, and auto-perspective pending |
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
