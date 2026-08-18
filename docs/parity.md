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
  - **The dimension is drawn, and that lifted the XR block (`EVID-105`).** The measurement is now a
    line and a label on the model. Its endpoints come from the measurement *result* rather than the
    picked features, because those differ — a point-to-plane distance is measured to the foot of the
    perpendicular, and drawing to the plane's origin would show a line that is not the number beside
    it. The annotation is rebuilt on every read rather than updated, since a stale line next to a
    fresh number is worse than none.
    With the readout in the scene, `tool_measure` and `measure_clear` are no longer withheld from
    XR. The withheld reason was about the readout, never about picking: **four paint tools on the
    same XR toolbar already pick features by ray against a mesh**, so that half was demonstrably
    possible all along. `measure_clear` also joins the back-out invariant, which now covers seven
    actions.

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
  - **The exploded view renders now (`EVID-104`).** `setExplosionFactor` applies the projection to
    the *display* objects and to nothing else, which is the acceptance clause exactly: canonical
    placement is never touched, and the factor is workspace state rather than a command, because an
    exploded view that entered undo history would be an edit pretending to be a camera. Offsets are
    composed from an assembled baseline held per instance, since applying them to already-offset
    positions makes every adjustment push the parts further out — a trace demonstrates that drift
    directly rather than asserting the guard exists. `assembly_explode` is a real action and is
    **not** withheld from XR: the factor is bounded, so it is a stepper rather than a typed field,
    and looking inside an assembly is what a headset is good for.
    A small correctness fix fell out: at factor 1 the offsets were `-0`, which is numerically zero
    but not `Object.is` zero, so a caller asking "is this assembled" with a strict comparison would
    have been told the parts had moved when they had not.
  - **Outstanding:** upstream's same-object (volume-level) alignment mode and its on-canvas
    alignment handles remain, as does XR for the alignment actions themselves — those five still
    declare an `xrUnsupportedReason`, and only the explosion control is reachable in a headset.

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
  - **Import now says so (`EVID-106`):** a project arriving with `use_surface` or `per_glyph` set
    raises a warning naming the *divergence* — the geometry will not be what the file describes —
    rather than a note about an unimplemented feature. Preserving the flag is still right, since
    dropping it would silently lose someone's work; arriving with it and saying nothing was the
    second half of that problem and is now closed. **The list is enforced against behaviour**, not
    trusted: a trace asserts `use_surface` still produces byte-identical geometry, so the moment
    someone implements it that check fails and the warning has to be removed with it. An
    unimplemented feature that still warns is a lie harder to notice than the original silence,
    because it looks like diligence. `per_glyph` is enforced the same way (`EVID-109`), against a
    two-glyph string — a single letter cannot tell "cut each glyph separately" from "cut the string
    as one", so a one-character fixture would have passed against a working implementation.
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
  - **Inherited presentation, and the bug it was hiding (`EVID-110`):** `fill` and `stroke` are
    inherited SVG properties and only an element's own attributes were read. Every drawing tool
    wraps its output in groups, so `<g fill="none" stroke="#000">` around a path — the ordinary
    shape of line art from Illustrator, Inkscape or Figma — left the path looking fillable and it
    **extruded as a solid**, silently. The `stroke-only` notice written for precisely this case
    never fired. Presentation now threads down through containers, a child's own value overrides
    its ancestor's, and an element that states nothing is still filled, which is SVG's default.
  - **Stylesheets too, with the cascade in SVG's order (`EVID-111`):** `<style>` blocks were
    ignored, and that was the same silent-solid bug in a second disguise — a class-based
    `fill:none` extruded as a solid, which is what every drawing tool that writes classes rather
    than attributes produces. Element, `.class` and `#id` selectors are read now, and the cascade
    runs in SVG's order rather than the intuitive one: a presentation *attribute* is the weakest of
    the three, weaker than any stylesheet rule, while an inline `style` is the strongest. A rule
    inside a comment is not a rule. A selector beyond those forms is **reported** through the
    existing unsupported channel rather than ignored, so a drawing that relies on a combinator
    still extrudes but says why. `!important` is read as a flag rather than as part of the colour
    (`EVID-112`) — the value `none !important` compared unequal to `none`, so a stroked path
    carrying it was read as filled, reachable from a plain inline `style` with no stylesheet
    involved — and its precedence is honoured: an important rule outranks an inline style, which is
    the one place CSS and the intuitive order disagree. And a conditional at-rule is **skipped rather
    than applied** (`EVID-113`): the rule matcher paired a selector with the next balanced block and
    walked straight into `@media print { … }`, applying a print-only declaration to the geometry —
    the inverse failure, turning a filled shape into nothing and refusing a whole drawing for a rule
    the document had scoped away.
  - **Import now says so (`EVID-106`):** the same warning covers an SVG part arriving with
    `use_surface`, for the same reason — the operator is told the imported geometry differs from
    the file rather than being left to notice.
  - **Outstanding:** `use_surface` is stored and round-trips but is not applied; there is no golden
    oracle against the pinned engine (the sweep proves closure, not equality); and all
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
  - **Preview and mode switch (2026-08-16):** `prepareSimplifyVolume` decimates without touching
    canonical state and `applyPreparedSimplify` installs exactly what it produced, with
    `simplifyVolume` now the composition of the two so every existing caller is unchanged. The
    Accept clause's "the preview matches the applied result" is therefore **structural, not
    tested-and-hoped**: apply receives the same prepared object the preview drew, rather than
    re-running the same settings and trusting them to land in the same place. Decimation is the one
    edit where this matters most, because what it removed cannot be inspected afterwards.
    `previewSimplify` / `applySimplifyPreview` / `cancelSimplifyPreview` own the session on the
    workspace: preview swaps the display geometry for the decimated mesh and nothing else, so
    cancel is a restore of the display and canonical state was never in play. Both pinned modes are
    exposed — `use_count` with a ratio, or a quadric `max_error` limit. The prepared result carries
    the guard read when it was computed, so a part that changed under a long preview is refused by
    the existing topology command rather than silently overwritten.
    Six traces pin it: preview records no command and leaves the stored mesh byte-identical; apply
    installs the previewed triangles exactly and the previewed vertices exactly at storage
    precision (float32 — asserted as the rounding rather than tolerated as a delta, so the two
    cannot drift behind a tolerance); a looser error budget removes more than a tight one; the
    same ratio prepares the same mesh twice; a prepared decimation is refused once the volume has
    moved on; and undo after an applied preview restores every triangle.
  - **Controls (2026-08-16):** `ui/dom/SimplifyPanel.ts` fronts the session, and
    `simplify_preview`, `simplify_apply`, and `simplify_cancel` are real registry actions owned by
    P5.3 in the evidence ledger — the one-shot `simplify_model` stays with P5.2's topology command,
    since the two make different parity claims over the same decimation. Both pinned modes are
    selectable, and the inactive mode's field is disabled rather than hidden: a control that
    vanishes reads as unsupported, and both are supported. Apply and cancel are inert until
    something is previewing, and a second preview cannot stack on the first. The readout reports
    the counts and the share removed rather than a verdict, and says out loud when a run stopped at
    its error limit instead of reaching the target — which is the case where a bare "it worked"
    would be a false success. Six panel traces pin all of that.
    The panel is fetched on demand rather than carried at first paint, and the brim-ears panel
    beside it was moved to the same treatment in the same change: adding this crossed the main
    chunk budget by 1.1 KB, and the fix was to stop shipping two disclosure-gated panels to
    everyone rather than to raise the guard.
  - **Outstanding:** upstream's per-object configuration persistence remains. The three preview
    actions do reach the headset's Panels menu (`xr-inspector`); what has not been confirmed is a
    human driving them there, which is P10.5.
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
  - **Automatic placement (2026-08-16):** `project/objects/brimEarDetection.ts` implements the
    pinned auto-detect. The outline is cut from the mesh just above its base rather than taken from
    a bounding box, because an ear holds a *corner* and a plus-shaped part has eight of them where
    a box has four; the cut chains its segments into closed loops and drops the collinear midpoints
    tessellation introduces, so what is measured is the shape and not its triangulation. A corner
    qualifies when its interior angle is at or below `max_angle` — the pinned 125° default — and
    when it turns *outward* against the loop's own winding, since the reflex corner of a concave
    outline is material on both sides and does not peel. Detections closer together than
    `detection_radius` are thinned to the sharpest, which makes the result independent of triangle
    order. Seven traces cover a box (four right-angled corners), a 48-sided prism (nothing sharp
    enough, with the reason said out loud), a hexagon that passes at 125° and fails at 100°, an
    L-shape whose reflex corner is excluded and whose reversed winding gives the same answer, the
    thinning tie-break, and indexed versus non-indexed meshes agreeing.
    The detector is wired: `brim_ears_auto` is a real registry action behind a "Place on corners"
    control in the panel, inert until exactly one part is in scope. It places the whole detected
    set through `AddBrimEarsCommand`, a new plural command, so one undo removes them all — eight
    undo steps for one act is noise, since the operator asked for "hold this part down" rather than
    for eight separate decisions. Existing ears are kept, so auto-placing after a manual placement
    adds rather than replaces.
  - **Slice proof and the bug it found (2026-08-16):** the Accept clause was finally asked, by
    driving the pinned WASM engine headlessly — the first test in this repo to do so — and asking
    it exposed a real bug that had made placed ears do nothing at all.
    The pinned engine discards any ear whose transformed world Z is above the bed
    (`Brim.cpp:867`). An object's local origin is its centre, so an ear stored at `z = 0` sits at
    mid-height and every single one was silently dropped: a clean slice, no error, no brim. Both
    placement paths now write the part's *base* Z instead — the detector takes the outline's own
    minimum, and a click takes the part's bounding-box floor rather than wherever up the wall the
    ray landed. With that, four ears on a 20 mm cube produce `;TYPE:Brim` and more first-layer
    extrusion than the same cube without them, while the bare run has no brim at all.
    Two further corrections fell out. `brim_type` must be `painted` (`btPainted`) for *placed*
    points to be consumed; `brim_ears` (`btEar`) is the automatic corner detector and ignores
    them (`Brim.cpp:929-930`), so the obvious-looking value is the wrong one. And the archive side
    was correct all along — `Metadata/brim_ear_points.txt` in the pinned format, keyed by the
    1-based model-object index the reader resolves (`bbs_3mf.cpp:2021`) — which is why the
    archive-level tests had passed for months while nothing worked.
  - **On-model preview, and the second silent failure it closes (2026-08-16):**
    `project/objects/brimEarPreview.ts` ports the pinned renderer's judgement, not just its
    drawing. Each ear is a flat disc on the part in the pinned colours and the pinned 0.2 mm
    height, parented to the part's display mesh so it inherits the transform, with the part's world
    scale divided back out — the pinned `instance_scaling_matrix_inverse`, because an ear is a
    fixed number of millimetres on the bed and a marker that grew with a scaled model would
    misstate the size of the thing it stands for.
    The half worth having is `find_single` (`GLGizmoBrimEars.cpp:1179-1221`): an ear whose disc
    reaches neither the part nor an ear that does prints an island of brim, holds nothing, and
    **says nothing** — it slices clean, exactly like the ears the Z bug was dropping. Those ears are
    now red on the model, flagged in the list, and announced above it through `role="alert"`, which
    is the only place an operator can learn it before the print does. Anchoring is transitive, as
    upstream's union is: a chain of overlapping ears reaching the part is held.
    Two deliberate differences. The disc is treated as a true circle rather than upstream's
    inscribed polygon, which only ever moves the answer toward the material the slicer will
    actually lay down. And connectivity grows pairwise instead of by unioning into one outline,
    which selects the same ears — a union of overlapping shapes covers no ground none of its
    members covers — while staying a fixed-point loop that does not depend on placement order, a
    property its traces pin directly.
  - **XR reach (2026-08-16):** `brim_ears_auto` and `brim_ears_clear` no longer declare an
    `xrUnsupportedReason`. Neither takes a parameter, and — this is what changed — the on-model disc
    preview above means their result is drawn in the scene rather than only in the DOM list, so a
    headset operator is not acting blind. Automatic placement now opens the ear tool as part of
    placing, because in a headset the scene is the only report there is and placing eight ears while
    showing nothing would be exactly the false success this feature keeps producing. The other three
    stay unsupported with sharper reasons than the shared one they used to share: a radius needs a
    numeric field, and removing *one* ear needs the indexed list.
  - **Outstanding:** hover and selected ear states are not exposed (the port carries their pinned
    colours but nothing drives them yet); `tool_brim_ears` and `brim_ears_remove` remain DOM-only —
    the modal placement tool needs a pointer on the mesh, and removing *one* ear needs the indexed
    list. `brim_ears_configure` is XR-reachable as of `EVID-086`: the radius is bounded, so it is a
    stepper rather than a typed field.
    The slice proof runs against the browser engine in Node; no hardware print has confirmed an ear
    physically holds a corner down (P8.6).

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
  - **XR number entry (2026-08-17):** the parameter form renders in a headset as steppers.
    Several actions across this registry are withheld from XR with one sentence — "no in-headset
    number entry exists yet" — and it was true: a text field needs a keyboard nobody wants in a
    headset. But a calibration parameter does not need free text. The pinned definition carries a
    `step` and a `range`, so the only values worth reaching are the ones a decrement and an
    increment walk through; choices cycle and booleans toggle, because the definition enumerates
    them. Bounds come from the definition, never from the surface, so a stepper cannot offer a value
    the compiler would refuse — a control that walked past a limit and then reported an error would
    have lied about what it could do. Both shells render from the same `CalibrationFormPreview`, so
    they cannot show different values for one parameter. Five traces cover stepping by the declared
    step, stopping at both bounds, refusing a fixed parameter on every surface rather than only in
    the DOM, cycling choices, and — the one that matters for trust — a fractional step producing
    `0.3` rather than `0.30000000000000004`.
    **The stepper lives in its own leaf module** importing a type and no code: taking it from
    `form.ts` pulled the compiler, the definitions and the generated catalog into the main chunk,
    84 KB for four lines of arithmetic.
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
  - **Bands now carry their overrides (2026-08-17):** `applyCalibrationPlan` installs a compiled
    plan's effects onto an object — each per-height effect becomes one canonical layer range
    carrying that band's `layer`-scope engine overrides, object-scope keys go onto the object, and
    print-scope keys onto the project config, which is safe because a calibration owns its own
    session and the operator's project is held aside. This closes the bullet demanding that
    "generated bands must carry real engine overrides rather than visual labels alone": the compiler
    had been producing them and nothing installed them, so a temperature tower was a tower shape
    printed entirely at one temperature — indistinguishable from a working calibration until it was
    measured. The whole plan is one transaction, because a tower installed halfway prints its upper
    bands at the wrong settings and its G-code looks perfectly reasonable. Three traces: every band
    with a z range becomes a range whose config holds the exact keys and values the effect declared;
    installing is one undo entry and one undo removes all of it; and an unknown object is refused.
  - **Then the engine was asked, and it corrected the above (2026-08-17):** the first version of
    `applyCalibrationPlan` wrote each band's `layer`-scope override into a layer range and stopped
    there. Two facts, both invisible from the archive and both fatal, came out of putting it to the
    slicer (`EVID-076`). **A layer range whose config omits `layer_height` crashes the pinned WASM
    engine** with an out-of-bounds memory access, so a band that only wanted to set a temperature
    took the slicer down; every band now carries the process layer height. And a range-scoped
    `nozzle_temperature` does not change the print at all — it is a filament option and the
    region-config path does not apply it — so the tower would have printed end to end at one
    temperature, which is exactly the failure the materialisation was written to fix. Bands now also
    install their `customGcode` as authored layer events, the channel upstream's own tower uses and
    the one already proven to reach the program (`EVID-062`). A third rule fell out: a layer event
    must be above the plate, so the base band is not a change but the setting the print starts with,
    and its overrides go to print scope.
  - **And then all fifteen were swept (`EVID-077`):** materialisation now refuses rather than
    half-installing, because two more silent no-ops were sitting in it. Seven workflows express
    their effects per object or per line rather than per height, and the code reported success while
    installing nothing at all. The four flow families were worse: they sweep `print_flow_ratio`
    across a grid of patches, and accumulating those onto the single placed object kept whichever
    came last and dropped the other eight — a project that slices, prints, and calibrates nothing.
    A third refusal names `retraction_length`, which is a filament setting the print preset does not
    hold, so a retraction tower's base value has nowhere to land in this build. **7 of 15 install
    and 8 refuse by name**, and a trace holds that every workflow gives one of those two answers
    with nothing left behind on a refusal. Per-object and per-line placement is the work that would
    turn those eight into installs, and it needs the pinned resource geometry that is still
    outstanding.
  - **Every installable mechanism is now engine-verified (`EVID-078`):** the seven that install use
    three mechanisms between them, and all three were put to the slicer rather than assumed. A
    range-scoped `outer_wall_speed` **does** change the print — which could not be taken for granted
    after range-scoped `nozzle_temperature` turned out inert, and which is the whole of what
    `max-volumetric-speed` and `vfa` rely on; had it been inert they would have installed cleanly
    and measured nothing. `SET_PRESSURE_ADVANCE`, `M205` and `SET_INPUT_SHAPER` reach the program
    verbatim through the layer-event channel, so the pressure-advance, junction-deviation and
    input-shaping families are not silently filtered on the way out. With the temperature oracle
    from `EVID-076`, no installable workflow now depends on an unverified path.
  - **Why the other eight stay refused, and what would change it (`EVID-079`):** their geometry is
    not generated, it is an upstream resource — `flowrate-test-pass1.3mf` is a plate of patches, the
    tolerance gauge is one of upstream's handy models. Their per-object effects carry **no
    positions**: `flow-pass-1`'s nine effects have `positionMm: null`, because upstream does not lay
    them out, the resource does. Inventing a layout would produce a plausible plate that measures
    something other than what the workflow means, so it is not being invented. What has been done
    instead is to make the pin worth something: all **18** pinned resources are now verified by git
    blob against the tree, failing rather than skipping when the submodule is absent. That check is
    load-bearing for the loader that would follow, because the audited resource envelopes used for
    bed-fit came from those exact files, and a resource that quietly changed would place a
    calibration off the bed.
  - **The geometry ships now (`EVID-087`), and the 14 MB figure was wrong.** The number quoted
    against this decision was the whole `resources/calib` tree, most of which the *installing*
    workflows never touch because they use generated geometry. The five files the refusing
    workflows actually need are **1.7 MB**, and they are excluded from the service worker's
    precache, so an operator who never runs a flow or tolerance calibration downloads none of them
    and the installable app does not grow. The resources are verified on arrival against the git
    blob the inventory audited — computed the way Git computes it, `blob <len>\0<content>` over
    SHA-1, checked against `git hash-object` itself rather than against a second implementation of
    the same idea — and a mismatch **refuses** the load rather than warning, because the compiler's
    bed-fit numbers came from exactly those bytes.
  - **Pieces are matched by meaning, never by index (`EVID-088`).** The obvious way to give each
    patch its setting — zip the resource's objects against the plan's effects in order — is wrong,
    and silently. `flowrate-test-pass1.3mf` stores its nine patches in *lexicographic* name order
    (`flowrate_0`, `flowrate_10`, `flowrate_15`, `flowrate_20`, `flowrate_5`, `flowrate_m10`, …)
    while the effects run 0.8 → 1.2 ascending, so zipping would print the −20 % setting on the
    patch labelled 0 % and mis-assign every patch after it. The plate would slice, print and measure
    perfectly, and the number it taught the operator would be nonsense. The match reads what the
    name means — `flowrate_m20` is −20 %, a ratio of 0.8, the effect whose value is 0.8 — and any
    piece that does not find exactly one effect refuses the whole mapping, because a partial one is
    the scrambled plate with fewer pieces.
  - **The archives can actually be opened now (`EVID-089`).** Every upstream calibration 3MF was
    refused by the reader with "ZIP64 archives exceed the supported browser envelope". The refusal
    was reasonable and its premise was not: these files are 150 KB. They are ZIP64 in *form* —
    the writer emits the records unconditionally — not in size, and eight workflows were blocked on
    geometry the reader was declining to open for a reason that did not apply. ZIP64 is read at
    three levels, because upstream uses all three: the end-of-central-directory record, the
    per-entry extended-information field, and the matching field on each local header. **Widening
    what can be parsed widened nothing that is accepted:** every existing bound — entry count,
    directory extent, path safety, compression method, local/central agreement, total size — now
    applies to the ZIP64 values exactly as it did to the 32-bit ones, a 64-bit field beyond
    `Number.MAX_SAFE_INTEGER` is refused rather than truncated, and traces hold that a truncated or
    corrupted archive is still refused rather than followed.
  - **Both upstream naming encodings are understood, and the reading is proved (`EVID-090`).**
    Upstream names flow patches two ways and the difference is the decimal point: an integer is a
    percentage (`flowrate_m9` → 0.91) and a decimal is an absolute offset from 1
    (`flowrate_m0.005` → 0.995). That was derived by reading each archive's names against its own
    plan's values rather than assumed — reading `flowrate_0.05` as five percent would land it on
    the wrong patch and mis-label a whole plate. The proof is a **bijection across all four
    archives**: every piece finds exactly one setting and every setting exactly one piece, for 9,
    10, 11 and 16 pieces. One wrong rule anywhere and some piece or some setting is left over.
  - **The flow families install (`EVID-091`).** `applyFlowCalibrationResource` puts the upstream
    patches and the compiled ratios together and makes the result the project — correct rather than
    heavy-handed, because a calibration owns its own session and what is replaced is the empty
    project that session handed over, with the operator's work held aside where cancelling still
    returns it untouched. Config is written into the state *before* it is installed, so the project
    is never briefly a plate of patches all printing at the same ratio, a state an autosave or a
    slice could catch. A mapping with any problem installs nothing at all. **Four of the eight
    refusals are now installs**, leaving `pressure-advance-line`, `pressure-advance-pattern`,
    `retraction-tower` and `tolerance-extension`.
  - **And the plate was put to the engine (`EVID-092`).** `EVID-091` closed by naming the gap
    rather than assuming past it: per-object config is a different scope from anything with an
    oracle, and range-scoped `nozzle_temperature` had already proved completely inert at exactly
    this kind of boundary. So the placed plate was sliced twice — once with the calibration's nine
    ratios, once with every patch flattened to 1.0 — and the filament totals differ. Flow ratio
    scales extrusion, so identical totals would have meant a plate of nine identical squares that
    slices, prints and measures like a calibration. Per-object `print_flow_ratio` reaches the
    toolpaths.
  - **`retraction-tower` was refused by my own rule, not by the engine (`EVID-093`).** Its refusal
    read as a limitation and was a bug: the base-band handler routed *every* layer-scope key to
    print scope, and `retraction_length` is a filament option the print preset does not hold. Asking
    the engine settled it — a range-scoped retraction length changes the print, unlike a
    range-scoped temperature — so the routing now applies only to keys whose range form is
    **empirically** inert. That list is one key long and every entry is a slice trace, because
    membership cannot be guessed from scope: `nozzle_temperature`, `outer_wall_speed` and
    `retraction_length` are all non-print options and all three behave differently. A comment-only
    `customGcode` also no longer becomes a layer event, since an event that changes no setting
    implies a mechanism that is not the one working. **Eight of fifteen now install through the
    per-height path and four more through the resource path**, leaving `pressure-advance-line`,
    `pressure-advance-pattern` and `tolerance-extension`.
  - **`tolerance-extension` is refused for a different reason than the other two (`EVID-094`).** Its
    plan compiles to six pieces at six bed positions carrying **no engine overrides at all**,
    against `OrcaToleranceTest.stl` — verified to be a single binary solid of 15,518 triangles.
    Placing them would produce six identical gauges labelled 0 mm through 0.4 mm: a plate that
    slices, prints and measures nothing while looking exactly like a calibration. The refusal now
    says that, instead of "cannot yet materialise", which invited a future fix of placing six
    copies. Whatever distinguishes upstream's clearances is not in the compiled plan, and that is a
    gap in the job model rather than in placement.
  - **The two pressure-advance sweeps are generated G-code, not projects (`EVID-095`).** Reading
    them settles what "draws lines" meant. `pressure-advance-line` is **51 lines that all sit at
    z 0.2 mm** and differ only in Y; `pressure-advance-pattern` is 17 across four rows at the same
    single height. A layer range is a z band, so nothing in a model can tell those apart — the
    setting has to change *inside* a layer at a coordinate, and the model-to-slicer path has no hook
    there. Upstream writes this G-code itself rather than slicing a model. The refusal says that
    now, because "cannot yet materialise" promised a placement that is never going to be the
    mechanism. **This closes the reading of all fifteen workflows:** twelve install, and the three
    that do not each refuse for a different and now-accurate reason — a job-model gap
    (`tolerance-extension`) and a pipeline that is not slicing (the two sweeps).
  - **The sweep bodies are generated, and the preamble is refused on purpose (`EVID-096`).**
    `project/calibration/lineProgram.ts` emits what encodes the calibration: per line, the command
    that sets its value, a travel to its start, and an extruding move to its end, with extrusion
    computed as a rectangular bead. It **does not** emit a complete program, and that is a safety
    decision rather than an unfinished one. The U1's own start G-code is 5,623 characters carrying
    44 template tokens — bed mesh calibration, nozzle cleaning at discard positions, per-extruder
    auto-feed, `{if curr_bed_type == …}` Z-offset branches, `{nozzle_temperature[initial_extruder] -
    90}` expressions. Evaluating those is the slicer's job. A hand-written substitute would produce
    a file that looks complete and skips bed levelling on someone's actual machine, where the
    failure is a toolhead into a bed rather than a bad measurement. What is missing is returned as
    data, not prose, so a caller cannot mistake the body for a printable file.
  - **And the preamble is solved rather than refused (`EVID-097`).** The templates never needed
    reimplementing: the slicer evaluates them on every slice, so the machine's real start and end
    G-code are taken from the engine's own output for an ordinary project — the same code, profile
    and filament that would have produced them for a normal print.
    `extractMachineEnvelope` splits a donor slice at its first `;LAYER_CHANGE` and its last
    `;TYPE:Custom` block, and **refuses an envelope that is not one**: a preamble that never homes
    or never heats, an epilogue that never ends the print. Those refusals are exercised against
    *mutated real engine output* rather than invented fixtures, because that is what a profile
    change or an extraction bug would actually look like. A wrapped sweep is verified to prepare,
    calibrate and shut down **in that order** — presence alone would pass a program that calibrated
    before it levelled.
  - **Reachable now, and split at the safe boundary (`EVID-098`).** `calib_sweep_export` builds the
    program and saves it. **Export is offered; send is not** — a file an operator can open and read
    is the safe half of P8.3's export/send, while putting a generated program straight onto a
    machine is the half no supervised print has cleared. A sliced project is the precondition rather
    than an inconvenience: the sweep borrows the machine's own start sequence from it, and the
    refusal says exactly that instead of reporting a generic unavailability. Nothing partial is ever
    returned — an operator handed a file expects to be able to print it — so a plan that does not
    compile, or an envelope that fails its safety checks, yields a reason and no file.
  - **`tolerance-extension` is one gauge, not six pieces (`EVID-099`).** `EVID-094` read its effects
    correctly and drew the wrong conclusion from them. The plan's required envelope is
    57.937 × 14.401 × 6.401 mm; the shipped gauge measures 57.936 × 14.400 × 6.400. The envelope is
    **one copy plus a fit margin** — and six copies of a 57.9 mm part cannot sit at the 38.571 mm
    spacing the effects give, because they would overlap by nineteen millimetres. The six effects
    are the reading key for a single gauge whose clearances are cut into its geometry, which is
    exactly what the instruction sheet already publishes. `placeSingleGaugeCalibration` places it,
    guarded by that envelope comparison so a future plan genuinely wanting several copies is
    refused rather than quietly printed as one. **All fifteen workflows now have a materialisation
    path.**
  - **And the gauge is reachable (`EVID-100`).** `calib_place_geometry` loads the model through
    `loadCalibrationResource`, so a resource that is not the audited bytes refuses the placement
    rather than being printed — the bed-fit numbers were audited from exactly those bytes. It opens
    a calibration session so the operator's project is held aside, and **cancels that session again
    if the placement is refused**, because a refused action must not leave someone inside an empty
    calibration they never asked for. Only the single-gauge shape is handled here: the flow families
    come through `applyFlowCalibrationResource` and the sweeps are generated programs, and one
    function covering all three would be pretending three mechanisms are one.
    Pinned resource and generated-geometry loading remain.

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
  - **Separate session (2026-08-17):** the snapshot that protects the operator's project is built.
    `beginCalibrationSession` holds the whole canonical state aside and hands the editor a clean
    project carrying the same printer, profile, and physical tools — the machine being calibrated
    has to be the machine that prints the test. `cancelCalibrationSession` installs the held state
    wholesale rather than un-doing step by step, so whatever the calibration did, however many
    commands and however many new meshes, none of it can survive. `keepCalibrationSession` is the
    other way out and is explicit rather than implied: a caller says which of "give me my project
    back" and "I meant to replace it" they mean. `addCalibration` now opens a session instead of
    dropping a test model onto the operator's plate, which was the behaviour the plan's "cancellation
    must not overwrite it" clause was written against — undo is not preservation, it is a request
    that the operator remember to.
    Five traces: the session starts on an empty plate while the printer travels with it; cancelling
    after two calibration imports restores a byte-identical state *and* the same
    `projectFingerprint`; keeping lets the held project go and a later cancel is refused rather than
    silently succeeding; a session cannot nest, because the second begin would strand the real
    project behind the calibration; and a cancel with nothing held is refused rather than treated as
    a reset. **The asset repository is held with the state**, which the first attempt did not do —
    `session.reset` replaces the repository with the snapshot it is handed and validates against
    exactly that, so holding only the state produced a cancel that threw.
  - **Session controls (2026-08-17):** `calib_session_discard` and `calib_session_keep` are registry
    actions, and `ui/dom/CalibrationSessionBar.ts` is a viewport banner rather than a panel — the
    fact that someone's project is waiting behind the calibration has to be visible wherever they
    are looking, because the failure it prevents is deciding this *is* the project now and building
    on a temperature tower. The banner is absent entirely when no session is open, since a chrome
    slot that usually says nothing trains people to stop reading it, and it is a `status` rather
    than an `alert` because nothing is wrong. Discard is never withheld in a headset and is now in
    the back-out invariant alongside `paint_smart_cancel` and the rest: an operator can enter a
    calibration session from either shell, and a way out that only one shell offers is a trap.
  - **Parameters and preview (2026-08-17):** `project/calibration/form.ts` turns a pinned definition
    into an editable form and asks the compiler what the current values would build. Parameter
    dialogs, preview, and regenerate are one question — "what would these settings actually make?" —
    and `compileCalibrationJob` already answers it, so nothing here re-implements a rule: an
    out-of-range temperature comes back as the compiler's own issue, with its path, and regenerate
    is asking again rather than a second code path.
    The care is in the parsing, because that is where a form loses information. `Number('')` is 0,
    so a cleared field is reported as absent instead of quietly calibrating at zero; an unreadable
    entry says which entry; and nothing is put to the compiler while any value is unreadable,
    because it would report the *absence* of a parameter, which reads as a different fault than the
    typo that caused it. A parameter the definition marks uneditable cannot be steered by passing an
    edit anyway, and an edit naming a key the definition does not have is ignored rather than
    injected into the request.
    Ten traces, and one of them found a real bug: **a round-trip trace — every definition's
    displayed defaults must read back as themselves — caught that several calibrations default
    `speeds` and `accelerations` to an empty list, which the first parser refused as blank, making
    those workflows uncompilable from their own defaults.**
  - **Panel and contextual docs (2026-08-17):** `ui/dom/CalibrationParametersPanel.ts` renders the
    form and sends edits back as text. It holds no rules of its own — not a range, not a choice
    list, not a unit — because the pinned definition and the compiler own those, and a panel that
    re-states a limit is one that will eventually disagree with the thing enforcing it. Issues are
    resolved to the field that caused them through the compiler's own `$.parameters.<key>` path,
    marked `aria-invalid`, and tied to their input with `aria-describedby`, so an operator is told
    which box is wrong rather than that something is; an issue belonging to no field is still said,
    rather than swallowed. "Add to project" is inert while nothing compiles, so a bad value can
    never be silently substituted for a good one, and the preview line reports what the plan
    contains rather than the word "valid" — the operator is asking about the print, not the form.
    `project/calibration/docs.ts` supplies the contextual links, pinned to
    `PINNED_CALIBRATION_COMMIT` rather than to a branch: a link to a moving `main` documents
    whatever upstream is doing today, which need not be what this build does. **Every target is
    checked against the pinned tree by a trace, and its absence is a failure rather than a skip** —
    a link check that quietly skips is how a dead link ships. Four workflows share the one flow-rate
    guide because upstream documents them together; inventing four pages would imply four guides
    that do not exist.
  - **Mounted, with the build truthfully withheld (2026-08-17):** the panel is in the shell behind a
    workflow chooser, and `OrcaWorkspace.calibrationPrerequisites()` derives the printer, nozzle,
    filament, and process facts from the live canonical config rather than from a stand-in, so the
    preview describes the machine the operator actually has. Where the config carries no value the
    fallback is the conservative one — a smaller bed, a narrower temperature window, a slower
    machine — because a calibration refused for not fitting is a nuisance while one accepted on an
    assumed-larger bed crashes a toolhead. Switching workflows clears the edits rather than carrying
    them, since two definitions can share a parameter key and mean different things by it.
    **"Add to project" is withheld and says why.** The compiler produces a plan, but materialising
    one into the canonical project graph is still P8.2 work, so the control stays visible, is
    disabled, and carries the reason — the preview line still reports what the settings would build,
    because that is the value of a preview and it does not depend on being able to act on it. The
    menu entries continue to add the existing alpha geometry, which the reason says out loud.
  - **Measurement instructions (2026-08-17):** `project/calibration/instructions.ts` builds the key
    to a printed calibration, and the panel shows it once a plan compiles. Bands are read from the
    plan's own effects rather than re-derived from the parameters, so the sheet and the installed
    G-code cannot disagree about which band was which value — an instruction sheet off by one band
    produces a confident measurement of the wrong thing, which then gets written into a preset and
    printed with from then on. Ordinals are 1-based because that is how an operator counts bands off
    a print. A print whose effects have no height is **not** described as stacked: a flow plate's
    patches are placed across the bed, and "the third band up" would send someone to the wrong part
    of it. The sheet also names what to measure and which preset key a recorded result will write
    to, before one is recorded. Five module traces and one panel trace, the panel one built from a
    real compiled plan rather than a stub.
  - **Plan inspection (2026-08-17):** `project/calibration/verify.ts` evaluates the
    `sliceAssertions` the compiler emits, which nothing had ever run. An assertion nobody evaluates
    is decoration — it reads like a guarantee in the plan JSON, in an evidence row and in a review,
    while guaranteeing nothing. The panel now refuses to offer a plan that breaks its own
    definition and says which statement it broke, in terms of the print rather than a JSON path.
    Worth stating plainly: several assertions are computed by the compiler from the plan they
    describe, so on a freshly-compiled plan they are near-tautological. Their value is on a plan
    that has *travelled* — stored, transported, or handed through a consumer that dropped or
    rewrote effects — which is exactly when a calibration silently stops being one.
  - **Parameters through the registry (2026-08-17):** the panel's field values lived in the shell,
    which meant only that panel could drive them — against this project's own rule that every action
    an operator can take is one the registry can take. The workflow choice and the edits are
    workspace state now, behind `calib_choose`, `calib_configure`, and `calib_reset_parameters`.
    All three are MCP tools, all three carry `xr-inspector` because none declares an
    `xrUnsupportedReason`, and the reset joins the back-out invariant. Validation of the workflow id
    is deliberately *not* duplicated in the workspace: the pinned definitions are the authority and
    `buildCalibrationForm` already reports `unknown-definition`, and importing the catalog to check
    it twice put 54 KB of generated inventory into the main chunk that every visitor paid for.
  - **Slice, end to end (2026-08-17):** a temperature tower compiled, materialised through
    `applyCalibrationPlan`, serialized from what the controller holds, and put to the engine — with
    every band the plan declared asserted present in the program by temperature. Everything before
    this verified halves: the materialisation against canonical state, the band mechanisms against
    the engine with hand-built archives. The join between them was assumed, and every assumption of
    that shape checked this session has been wrong at least once.
  - **Export and send (2026-08-17):** the calibration banner now carries Slice, Save G-code, and
    Send to printer alongside the two ways out. They route through the same registry actions the
    toolbar uses — `slice_active_plate`, `save_gcode_to_downloads`, `send_to_printer` — because a
    calibration is an ordinary project while its session is open, and a second code path for
    slicing it would drift from the one everything else is tested against. They live on the banner
    rather than being left to the toolbar for a specific reason: with a session open those actions
    act on the calibration, not on the project waiting behind it, and the banner is the thing that
    says so. Saving and sending stay inert until there is G-code; sending is withheld **with its
    reason** when no printer is connected, while saving stays available, because a file needs no
    printer. Four traces cover the gating, the withheld reason, the message naming what is acted
    on, and each control reporting once.
  - **Missing:** and building a compiled plan into the project is P8.2. The saved preset is
    versioned but is device state rather than a canonical undo step, so "undoable" in the project
    sense is not met. Geometry and semantic G-code have not been compared against official
    examples, and no result in this path has been measured on hardware.

- [~] **P8.4 — Implement the connected-printer calibration wizard where Moonraker exposes the
  outcome.** Cover printer/preset/filament selection, compatibility checks, start/progress,
  coarse/fine stages, live result collection or manual entry, save, cancellation, recovery, and
  history.
  - Vendor-proprietary automatic measurement without a Moonraker equivalent must remain an
    explicit adaptation/blocker; provide the generic printed-test path for the same tunable
    parameter, not a fake automatic result.
  - **Accept:** supported U1/Elegoo workflows survive disconnect/reconnect and save traceable
    results; unavailable automation is clearly distinguished from manual calibration.
  - **Current:** the distinction the second Accept clause asks for exists and is pinned.
    `project/calibration/automation.ts` classifies all 15 workflows, and only resonance testing
    comes out automatic: Klipper's `SHAPER_CALIBRATE` sweeps an axis against an accelerometer and
    derives the shaper frequency and damping itself, then saves them with `SAVE_CONFIG`. Every
    other workflow is read off the printed part — the best colour on a temperature tower, the
    smallest clearance that still fits — and no printer reports what a human sees.
    `TUNING_TOWER` can ramp a parameter over Z, but the compiler already emits per-band
    overrides; ramping was never the hard part.
    Availability is judged against the machine actually connected, read from
    `/printer/objects/list`, so three answers stay distinct: this cannot be automated at all,
    this printer lacks the parts (naming `resonance_tester` and the accelerometer kinds it
    accepts), and nobody has asked the printer yet. A printed test remains available in every
    case, so an unequipped machine is told what it is missing rather than refused.
  - **Missing:** the wizard itself — printer/preset/filament selection, compatibility checks,
    start and progress, coarse and fine stages, live result collection, cancellation, and recovery
    across a disconnect — is not built; the classification is what a wizard would gate on. Running
    `SHAPER_CALIBRATE` and reading its result back is not implemented, and no part of this has
    been exercised against a real Klipper instance or either target printer.

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

- [~] **P10.1 — Establish a coherent responsive information architecture.** Keep Prepare,
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
  - **Current:** the acceptance above is a human study and stays open, but its automatable half
    is now a release gate (`EVID-063`). The production E2E walks the five sizes that bracket the
    breakpoints — desktop, tablet portrait, phone landscape, phone portrait, and the CSS-pixel
    budget a browser at 200% zoom leaves — and at each one asserts that nothing overflows
    horizontally, with the palette shut and again with it open, and that the command palette
    offers exactly the catalog the widest layout offers. That second assertion is the machine-
    checkable form of "progressive disclosure without hiding uncommon parity functions": a
    control may move at a narrow size, but if it stops being reachable the count drops and the
    gate fails. The widest layout is walked first so it sets the reference, which compares the
    shell against itself rather than against a test-only handle on the registry.

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
    Perspective/orthographic switching and auto-perspective are now classified rather than
    deferred. They are not "not yet": the render camera is created and owned by xrblocks as a
    `PerspectiveCamera`, and inside a session WebXR supplies its own projection matrix per view.
    Forcing an orthographic matrix onto that camera would render orthographically while
    `Raycaster` still branched on the camera type, so every pick would be computed against a
    projection the operator is not looking through — right-looking and wrong. Recorded as
    `ADAPT-14`, and both actions now say that instead of implying an implementation is coming.
  - **Missing:** the G-code window, the remaining context-menu surfaces, and the P0
    surface-manifest classification pass are untouched. Neither the outline nor the navigator has
    had a visual review.

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

- [~] **P12.1 — Audit upstream drift before qualification.** Fetch latest release metadata and
  rerun P0 extraction against both pinned v2.3.4 and latest. Do not silently bump. If the target
  changes, record the decision, clean-apply the WASM patch set, regenerate manifests/schema,
  rebuild both engines, rerun golden tests, and reopen every affected hardware-sensitive item.
  - **Accept:** source/patch/artifact/profile hashes and drift report are attached; every delta has
    a plan disposition.
  - **Current:** `tools/parity/drift.mjs` runs the audit and `docs/parity/upstream-drift.json` is
    its report (`EVID-064`). `--audit` reaches upstream, resolves the newest release tag, extracts
    at both commits, and hashes every tracked engine artifact, patch, and profile alongside the
    manifest's own source blobs. `--check` is offline and is in the quality gate: it refuses a
    report audited against a different pin, refuses a delta with no disposition, and refuses an
    artifact whose bytes on disk differ from the committed ones. **The pin is never bumped by this
    tool** — it stays a constant in `tools/parity/source.mjs` that a human edits.
  - **First finding — upstream is one release ahead, and the pin holds.** v2.3.5 changes seven of
    the seventeen extracted source files. The parity-visible part of that is small and exactly
    known: five new settings (`filament_colour_mode`, `filament_is_high_temperature`,
    `filament_multi_colors`, `filament_tower_ironing_area`, `wipe_tower_wall_gap`, none removed)
    and two new tab placements. The other five files are inert for parity — verified per file, not
    assumed: no menu-construction line is added or removed in `MainFrame.cpp`, `Plater.cpp`, or
    `PresetComboBoxes.cpp`, so all 124 menu actions and 2 device pages stand, and `GUI_App.cpp`'s
    256 added lines are desktop bootstrap (bundled `flutter_web` copying, version logging, Win32
    device notifications) that touches no file-wildcard line, so all 16 format filters stand.
  - **The extractor refuses v2.3.5, and that is the check working.** Its PrintConfig sanity
    constant expects 744 active literal registrations and finds 749. So the *leaf-level* inventory
    at v2.3.5 is unknown rather than unchanged, and the report says so with nulls rather than
    zeroes. The first version of this tool got this wrong — it reported "0 parity source files
    changed" for a release that changed seven — because it derived the file diff from two manifests
    and one of them was missing. The file diff now reads blobs directly, needs no extractor, and is
    always available; §20b's rule about a null being a suspect fixture applied to the auditor
    itself.

- [ ] **P12.2 — Run independent workflow parity review.** A reviewer who did not implement the
  feature executes the coverage matrix against official Snapmaker Orca and OrcaXR using the same
  fixtures/profiles. Record outcome, steps, time, errors, output comparisons, UX/a11y findings,
  and artifacts on desktop, mobile, and XR.
  - **Accept:** no `partial`, `unavailable`, false-success, silent-loss, or undocumented behavior
    remains in a core parity workflow; approved adaptations meet their outcome tests.

- [~] **P12.3 — Run engine and artifact qualification.** Rebuild WASM, browser assets, server
  WASM/CLI, and profiles from documented clean sources; verify hashes/provenance; run all project,
  config, 3MF, G-code, hostile-input, cancellation, memory, and route-comparison corpora.
  - **Accept:** required artifacts are reproducible; semantic tolerances pass; no stale bundle or
    uncommitted developer-local fixture participates.
  - **Current (`EVID-102`):** the acceptance clause "no stale bundle or uncommitted developer-local
    fixture participates" is now a gate. `tools/parity/artifact-qualification.mjs` checks every file
    under the engine, patch, profile and calibration-geometry roots against the commit, in both
    directions — a modified tracked file means the tests ran against something nobody else has, and
    an untracked one means an artifact exists only on one machine and would be missing from a fresh
    clone. It protects the evidence rather than the build: every slice result recorded here was
    produced by *some* engine binary, and if that binary is not the committed one then none of those
    results describe the artifact anyone else would get. 214 files across four roots qualify.
  - **Route comparison exists now (`EVID-103`).** `tools/parity/route-comparison.mjs` slices one
    project through both engines and compares them **semantically**, because byte equality is the
    wrong bar — the two builds legitimately differ in headers, timings and generator strings. What
    must agree is what the printer does: layer count and extrusion roles and printer commands
    exactly, filament proportionally, since an absolute threshold would pass a real divergence on a
    large print and fail rounding noise on a small one. It **refuses to run without the external
    CLI rather than skipping**: a qualification step that quietly passes when it could test nothing
    is how a divergence ships.
    Six traces drive it against real engine output, and the ones that matter are the failing ones —
    a dropped extrusion role, a dropped command, a layer-count difference, and a filament gap past
    tolerance are each caught by name. A comparator verified only on identical inputs is a check
    that can never report anything, which is indistinguishable from no corpus at all.
  - **Not qualified here, and the tool says so in its own output:** rebuilding the WASM engine or
    the server CLI from clean sources needs the Emscripten toolchain, and route comparison is
    recorded as *present but not runnable here* — the external CLI lives in the qualification
    container. A corpus that exists but cannot run is not the same as one that does not exist, and
    the report keeps them apart.

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

- [~] **P12.6 — Publish a traceable parity release.** Generate feature/adaptation/evidence reports
  from manifests, include upstream and engine hashes, known limitations, migration/recovery,
  privacy/security, supported browser/device/printer matrix, and user documentation.
  - **Accept:** all parent/child tasks required for the claim are `[x]`, every row has evidence,
    no `[!]` blocks the advertised scope, installed artifacts pass smoke tests, and rollback is
    rehearsed.
  - **Current (`EVID-101`):** the acceptance is gated on everything else, but the *deliverable* is
    built and should have been built first — P12.2's reviewer and P12.5's security sign-off both
    need something to review, and until now the only artifact was this 3,400-line document.
    `tools/parity/release-report.mjs` generates `docs/parity/release-report.json` from the manifests
    rather than from prose: task states and evidence rows from the plan's own checkboxes and table,
    inventory counts from the parity manifest, upstream drift from its audit, and git blob hashes
    for the engine, the WASM patch set and the shipped calibration geometry.
    **Its first section says the claim cannot be made**, naming each outstanding human gate
    individually rather than counting them, because a report that reads as a summary of
    achievements is the one that gets skimmed and quoted. `--check` is in the quality gate, so the
    report cannot drift from the plan it describes.

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
| Automatic vs. manual calibration, per printer | P8.4 | All 15 workflows classified against what Klipper actually measures — only resonance testing is automatic — with availability judged from the connected printer's own object list, so "cannot be automated", "this printer lacks the parts", and "not asked yet" stay three different answers. The wizard, running SHAPER_CALIBRATE, and hardware remain |
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
| Responsive desktop/tablet/mobile IA and complete states | P10.1 | Layout and full palette reachability gated across five viewports (`EVID-063`); comparative task studies and visual review unmet |
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
| `EVID-051` | P8.4, P8.1, P0.2 | `45577c0` | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/calibration/automation.test.ts` | Node 22.21.0; **no Klipper instance and no hardware** | Pass: 6 classification traces — every one of the 15 workflows is classified with a justification, automatic implies a real command and manual implies no required parts, only the two input-shaping workflows come out automatic, a manual workflow reports manual whatever the printer says, resonance testing is offered only when both `resonance_tester` and one of four accepted accelerometer kinds are present (matched on the Klipper "kind name" convention), a printer missing them is told exactly what it lacks with the printed test still offered, an unasked printer reports unknown rather than absent, and the object-list parser accepts Klipper's wrapped and unwrapped shapes while rejecting six malformed ones. 162/162 unit, 5/5 integration, 70/70 project, 8/8 settings, and 1/1 XR files pass; bundle main 2,185,101 bytes, JS total 10,145,824 | Automated review; **the classification is a judgement about Klipper, not a measurement of it** — no Klipper instance was queried and neither target printer was consulted, so the accelerometer list and the automatic/manual split are asserted from the documented command set. The wizard, the `SHAPER_CALIBRATE` run itself, disconnect/reconnect survival, and traceable saved results all remain |
| `EVID-052` | P5.3.6, P4.8, P0.2 | Current worktree atop `348aa7c`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/objects/__tests__/brim-ear-detection.test.ts` | Node 22.21.0; **no slice and no hardware** | Pass: 7 detection traces — a box places exactly four ears at its corners each carrying the configured radius, a 48-sided prism places none and says why, a hexagon passes the 125° default and fails a 100° threshold, an L-shape excludes its reflex corner and returns the same corners when its winding is reversed, colliding detections thin to the sharpest while a zero radius keeps all of them, a plus-shaped outline reports eight outward corners where a bounding box would report four, a box cross-section reads as a four-point loop of the right area after collinear midpoints are dropped, empty and flat meshes are refused with stated reasons, and an indexed mesh agrees with the same mesh as a triangle soup. 163/163 unit, 5/5 integration, 71/71 project, 8/8 settings, and 1/1 XR files pass; bundle main 2,185,235 bytes, JS total 10,145,958 | Automated review; the detector is **not wired to an action or a panel** yet, so placement in the running app is still manual. No test slices a project with ears and confirms them in the G-code, which is what P5.3.6's Accept clause actually asks for, and the pinned on-model preview and XR remain |
| `EVID-053` | P5.3.6, P7.1, P0.2 | Current worktree atop `471edba`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/brim-ears-slice.test.ts`; the pinned `bbs_3mf.cpp` and `Brim.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no browser and no hardware** | Mixed, and recorded as such. Pass: the engine loads and slices headlessly in Node — a 20 mm cube produces a real 166-layer program — which is the first time this repo has run the engine outside a browser. The archive carries the ear points in the pinned format under `object_id=1`, the 1-based model-object index the pinned reader looks up, with four values per ear; and `brim_type = painted` reaches the engine. **Fail, and the point of the exercise:** the sliced result contains no `;TYPE:Brim` and the first layer extrudes identically with and without four ears, so P5.3.6's "the sliced result shows them" does not hold. Two corrections fell out: `painted` (`btPainted`), not `brim_ears` (`btEar`), is the value that consumes placed points, and the failure mode is a clean slice with no error — which is how the assumption survived untested. 163/163 unit, 5/5 integration, 72/72 project, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,028 bytes, JS total 10,151,751 | Automated review; the gap is asserted as observed so it trips in either direction, but **it is not fixed**. The cause is unidentified past the archive and config being correct, and no hardware print has confirmed anything |
| `EVID-054` | P5.3.6, P7.1, P0.2 | Current worktree atop `facc417`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/brim-ears-slice.test.ts`; `src/project/objects/__tests__/brim-ear-detection.test.ts`; the pinned `Brim.cpp` and `bbs_3mf.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass, and it found a bug. Driving the engine headlessly showed that placed brim ears produced no brim whatsoever: the pinned engine discards an ear whose transformed world Z is above the bed (`Brim.cpp:867`), and an object's local origin being its centre made every `z = 0` ear sit at mid-height and be dropped — silently, with a clean slice and no error, which is how the archive-level tests passed for months while nothing worked. Both placement paths now write the part base Z. After the fix a 20 mm cube with four ears slices to a program containing `;TYPE:Brim` with more first-layer extrusion than the same cube without them, and the bare run contains no brim at all, so P5.3.6's "the sliced result shows them" now holds. 8 detection traces pin the base-Z rule and the corner geometry. Also corrected: `painted` (`btPainted`), not `brim_ears` (`btEar`), is the value that consumes placed points. 163/163 unit, 5/5 integration, 72/72 project, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,163 bytes, JS total 10,151,886 | Automated review; the proof runs against the browser engine in Node, and **no hardware print has confirmed an ear physically holds a corner down** (P8.6). The pinned on-model preview and XR remain |
| `EVID-055` | P2.5, P7.1, P6.5, P0.2 | Current worktree atop `3499dbd`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/layer-range-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: a height range does reach the engine and does change the print. A 20 mm cube with a 0–6 mm range overriding `layer_height` from 0.2 to 0.1 slices to a program with at least half again as many layers inside that band as the same cube without the range, and exactly the same number of layers above it — so the override applies where it was authored and leaks nowhere else. An object-scope
`wall_loops` override likewise increases the engine's own reported filament total while leaving
the layer count untouched, which covers the second of P6.5's five scopes against the engine
rather than against the archive. The archive half is asserted alongside it: `Metadata/layer_config_ranges.xml` is present and carries the overridden key. This is the second engine-visible claim checked with the headless harness, chosen because the pinned reader resolves ranges by the same 1-based model-object index that silently dropped every brim ear (`bbs_3mf.cpp:2016` beside `:2021`); unlike the ears, this one was already correct. 163/163 unit, 5/5 integration, 73/73 project, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,163 bytes, JS total 10,151,886 | Automated review; the confirmation is against the browser engine in Node, and no hardware print has been made. The bound is deliberately loose (≥1.5× rather than exactly 2×) because the first layer keeps its own height and the engine may snap the band edge — asserting an exact ratio would test rounding rather than the override. A first attempt measured `;TYPE:Inner wall` markers and read 99 vs 99 —
those count sections, one per layer either way, with the loops inside them; the engine's own
filament total is the honest measure, and checking that before calling it a bug is what kept a
second false finding out of this ledger. The browser suites were re-run alone after failing on
`#app-boot.ready` with two WASM slice suites ahead of them, matching the contention precedent in
`EVID-035` |
| `EVID-056` | P6.5, P7.1, P0.2 | Current worktree atop `13861f6`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/scoped-overrides-slice.test.ts`; `wasm/slic3r_wasm.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Mixed, and specific. Of P6.5's five override scopes, four are now proven against the engine rather than against the archive: a height range halves its band's layer height and leaves the layers above it untouched, an object override raises the engine's own filament total without changing the layer count, and a part override does the same. **A plate override does not reach the slice at all.** The cause is located rather than guessed: the archive does carry plate settings (`buildBbsCore` writes them under `<plate>` in `model_settings.config`) and the engine does parse them into `PlateDataPtrs`, but the WASM entry point deletes that structure immediately after loading and never applies it (`wasm/slic3r_wasm.cpp:346`), so the slice runs on the project config alone. Closing it does **not** need a rebuilt engine, though: the same test proves the remedy path, because `spiral_mode` handed to `sliceProjectSync` through the existing per-slice override channel does reach the print and halves the filament. The engine slices exactly one plate, so that plate's own overrides belong in that channel. Wiring it means carrying them through the coordinator to `CanonicalSlicerClientRoute`, whose `overrides` map is currently captured once at construction rather than per slice. Two false alarms were caught before being recorded as findings: counting `;TYPE:Inner wall` markers reads the same either way because they count sections rather than loops, and a first plate attempt used `sparse_infill_density`, which the generated scope table does not grant the plate — the serializer was right to drop it. 163/163 unit, 5/5 integration, 71/71 project, 3/3 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,163 bytes, JS total 10,151,886 | Automated review; the plate gap is asserted as observed so it trips when fixed, but **it is not fixed**, and nothing here has been confirmed on hardware. The WASM slice suites moved to their own `test:slice` script that runs after the browser suites, because running them first starved the browser suites of CPU and timed them out |
| `EVID-057` | P6.5, P7.1, P5.4, P0.2 | Current worktree atop `550ffa4`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/slice-pipeline.test.ts`; `src/project/__tests__/scoped-overrides-slice.test.ts` | Node 22.21.0; **no hardware** | Pass: the plate-scope gap `EVID-056` located is now wired shut. A slice request carries `plateOverrides` — the keys owned by the plate actually being sliced, in engine wire form — and `CanonicalSlicerClientRoute` merges them over its composition-level map, the plate's own keys winning because they belong to the plate in hand. Presentation bookkeeping the plate node also carries (`plater_id`, its name, lock and printable state) is left behind, since it is not print configuration and the engine would reject it. A pipeline trace pins both halves: a plate configured with `spiral_mode` reaches the route as an override, and none of the four bookkeeping keys does. This closes the last of P6.5's five scopes to be proven against the engine rather than the archive, and needed no change to the engine or a rebuilt artifact — the earlier claim that it did was wrong and is corrected in `EVID-056`. 163/163 unit, 5/5 integration, 71/71 project, 3/3 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; the headless slice still asserts the *archive* alone does not carry a plate override, which remains true and is the reason this channel exists. An end-to-end confirmation that a plate override authored in the running app reaches printed G-code, and any hardware print, remain |
| `EVID-058` | P4.6, P7.1, P0.2 | Current worktree atop `e84c96e`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/support-paint-slice.test.ts`; `src/project/__tests__/sliceHarness.ts`; the pinned `PrintConfig.cpp` and `TriangleSelector.hpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: painted support enforcers do reach the engine. Under the documented enforcer-only gate (`support_type = normal(manual)`, `PrintConfig.cpp:5183`) a cantilever with an unpainted overhang gets no support at all; painting its underside raises `;TYPE:Support` and `;TYPE:Support interface` and adds material (1,645 mm against 1,275 mm), and a blocker on the same facets raises none. The slice fixtures moved to a shared `sliceHarness` so a claim about what reaches the print costs one call. **Three fixture errors were caught and corrected before any of them was recorded as a bug:** a plain cube has no overhang, so an enforcer on its wall correctly produces nothing; a lifted cube is not an overhang but a floating object, which the engine rightly refuses to slice; and Orca labels the feature `;TYPE:Support`, not `;TYPE:Support material`, so the first marker read as "no support" on a run that generated plenty. Only the third looked identical to the brim-ear bug. 163/163 unit, 5/5 integration, 71/71 project, 4/4 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; the confirmation is that the engine emits support toolpaths, not that a printed part is supported — no hardware print has been made (P8.6). Seam, fuzzy-skin, and colour paint remain unchecked against the engine |
| `EVID-059` | P4.8, P7.1, P0.2 | Current worktree atop `0992484`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/fuzzy-paint-slice.test.ts`; the pinned `PrintObjectSlice.cpp` and `PrintApply.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass, first attempt, because the gate was read before the fixture was written. Fuzzy skin needs no global setting: the segmentation runs whenever `is_fuzzy_skin_painted()` holds (`PrintObjectSlice.cpp:5291`) and the painted region's config is forced to `FuzzySkinType::All` whatever the project asked for (`PrintApply.cpp:1108`). So a project set to `fuzzy_skin = none` is the right baseline, and a wall painted fuzzy is broken into over 20 % more extrusion moves than the same wall unpainted, while an empty annotation leaves the move count identical — the channel is inert when it carries nothing, so the first comparison measures the paint rather than the act of carrying one. Fuzz is counted in moves rather than filament because jitter displaces a wall without lengthening it. 163/163 unit, 5/5 integration, 71/71 project, 5/5 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; the confirmation is that the engine emits fuzzified toolpaths, not that a printed surface is textured — no hardware print has been made (P8.6). Seam paint and colour output remain unchecked headlessly |
| `EVID-060` | P4.7, P7.1, P0.2 | Current worktree atop `e519b58`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/seam-paint-slice.test.ts`; the pinned `SeamPlacer.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: a painted seam enforcer moves the seam. The gate is unconditional — `SeamPlacer.cpp:715` reads a volume's enforcers and blockers whenever `is_seam_painted()` holds — so a default project is the right baseline, and painting one wall moves the seam centroid across the object rather than by rounding, while an empty annotation leaves it exactly where it was. **The direction of the move is deliberately not asserted:** seam coordinates are bed coordinates and the loader centres the object, so a directional claim would be about the coordinate frame rather than about the paint — this ledger has already paid for four assertions that turned out to be about the fixture. With this every facet-paint channel except colour has been put to the engine. 163/163 unit, 5/5 integration, 71/71 project, 6/6 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; the confirmation is that the seam placer honours the paint, not that a printed seam lands where the operator wanted (P8.6). Colour output still has no headless oracle, and per-band calibration effects remain blocked on P8.2 |
| `EVID-061` | P4.3, P7.1, P0.2 | Current worktree atop `bb93756`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/color-paint-slice.test.ts`; the pinned `PrintObjectSlice.cpp` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: a facet painted with a second physical filament adds tool changes to the sliced program. The gate is `num_extruders > 1 && is_mm_painted()` (`PrintObjectSlice.cpp:176`), and the filament id is taken from the state being sliced rather than written as a literal, since an annotation naming an unknown filament is a different test rather than a weaker one. **A fifth fixture error was caught here:** the first assertion required the unpainted baseline to change tools zero times, but this fixture already assigns filaments per object and so changes tools without any paint — that would have been a claim about the fixture, so what is measured is the tool changes the paint *adds* to the very same project. With this, every facet-paint channel — colour, support, seam, fuzzy skin — has been put to the engine. 163/163 unit, 5/5 integration, 71/71 project, 7/7 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; this proves the segmentation reaches the toolpaths, not that the printed colours are right — FullSpectrum's own mixing still has no headless oracle, and the Android PeggyPalette parity test remains the only check on it. No hardware print has been made (P8.6) |
| `EVID-062` | P7.8, P7.1, P0.2 | Current worktree atop `7579eea`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/__tests__/layer-event-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: a pause authored at 4 mm appears in the sliced program at 4 mm. The browser suite already exercised this inside a fifteen-step workflow, which says the app works rather than what the engine does with one event; this is the headless oracle. It asserts the height as well as the presence, because a pause in the wrong layer is worse than none — the operator acts on it — and it asserts the layer count is unchanged, so the pause is an insertion rather than a re-slice. Two canonical rules were met rather than worked around: an authored event needs a stable entity id, and only a `custom` event carries its own G-code — a pause takes the printer profile's `machine_pause_gcode`, M600 on this target. This closes the last row of the engine-visible inventory that was not blocked on other work. 163/163 unit, 5/5 integration, 71/71 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; this proves the command is emitted at the right height, not that a printer honours it — no hardware print has been made (P8.6). FullSpectrum mixing and per-band calibration effects remain the two engine-visible claims without a headless oracle, the latter blocked on P8.2 |
| `EVID-063` | P10.1, P10.2, P0.3 | Current worktree atop `f3db013`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; the `surviveEveryViewport` step in `scripts/e2e-smoke.mjs` | Chrome for Testing 150.0.7871.24 driving the production build; five emulated viewports; **no headset, no hardware, no human study** | Pass: the shell holds its layout and all **196** palette actions at desktop 1280×720, tablet portrait 820×1180, phone landscape 844×390, phone portrait 390×844, and 640×360 — the CSS-pixel budget a browser at 200% zoom leaves, which is the case a device-name breakpoint always misses. Horizontal overflow is asserted twice per size, with the palette shut and again with it open, since a dialog that overflows has broken the layout just as thoroughly as a toolbar that does. The catalog assertion is the machine-checkable half of “progressive disclosure without hiding uncommon parity functions”: the widest layout is walked first and sets the reference, so a control that a narrow size moves is fine and a control it strands drops the count and fails the gate. This replaces a single 390px overflow check that asserted one property at one size. 163/163 unit, 5/5 integration, 71/71 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,545 bytes, JS total 10,152,268 | Automated review; **P10.1's acceptance is unmet** — it asks for comparative task studies against the reference application and a visual review of every state and viewport, neither of which a machine can perform. What is proven here is that no supported size loses a control or breaks the layout, not that the resulting arrangement is good. Safe-area insets and the virtual keyboard are named by the task and are not covered by emulated viewports |
| `EVID-064` | P12.1, P0.1, P0.2 | Current worktree atop `c606629`; commit pending | `9fd12ff...` → `761718a...` | 2026-08-16 | `node tools/parity/drift.mjs --audit`; `npm --prefix web run parity:drift`; `npm --prefix web run parity:verify` | Node 22.21.0; `git ls-remote` against `github.com/Snapmaker/OrcaSlicer`; **no headset, no hardware** | Pass: the pin is **one release behind** — pinned `v2.3.4`, latest `v2.3.5` — and 7 of the 17 extracted source files changed. Nine deltas are recorded and all nine are dispositioned. The parity-visible surface of the release is five new settings and two new tab placements; the other five changed files are verified inert rather than assumed inert (zero menu-construction lines touched across `MainFrame.cpp`/`Plater.cpp`/`PresetComboBoxes.cpp`, zero file-wildcard lines touched in `GUI_App.cpp`, and no inventory leaf cites `GUI_App.hpp` at all). The extractor **refuses** v2.3.5 on its own sanity constant (744 → 749 active registrations), so the leaf inventory there is recorded as unknown, not unchanged. **A bug in this tool was found and fixed before the report was recorded:** the first version derived the file diff from two manifests and, with the newer extraction having failed, reported *0 changed files* for a release that changed seven — the same shape of false negative §20b was written about, this time in the auditor. The diff now reads blobs directly and needs no extractor. Provenance covers 215 tracked files across engine, patches, and profiles, with worktree sha256 and committed blob recorded separately so a developer-local artifact fails the gate. 163/163 unit, 5/5 integration, 71/71 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **the pin was deliberately not bumped** — see the `target` disposition. This audits the target, it does not qualify a new one: P12.3's rebuild-and-requalify and P12.4's hardware runs are what a bump would require, and neither has happened. The `--check` gate cannot notice a release published after the last `--audit`; that needs the network and is run deliberately |
| `EVID-065` | P5.3.6, P5.3, P0.2 | Current worktree atop `752cd39`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/project/objects/__tests__/brim-ear-preview.test.ts`; `src/ui/dom/__tests__/BrimEarsPanel.test.ts`; the pinned `GLGizmoBrimEars.cpp` | Chrome for Testing 150.0.7871.24; Node 22.21.0; **no headset, no hardware** | Pass: placed ears now render as the pinned flat discs on the model, and the pinned `find_single` check is ported — an ear reaching neither the part nor an ear that does is drawn red, flagged in the list, and announced as an alert. This closes a second silent failure in the same feature: such an ear slices clean and prints an island of brim holding nothing, reporting no error anywhere, which is what the Z bug in `EVID-053` also did. Nine traces pin the judgement — a disc inside, straddling, and clear of the outline; a transitive chain that is anchored and the same chain orphaned when its first link goes; order-independence of the fixed point; radius changing the answer; a stepped solid whose *wide* base is what an ear must reach; and empty or flat geometry refused rather than guessed. Two panel traces pin that the alert and the per-row flag appear only when an ear is stranded. Disc scale divides out the part's world scale on the correct axis — the cylinder's height axis is its local Y, which the flat-lay rotation sends to world Z, so compensating y with y would have left the disc the one thing on screen that is not the size it claims. 171/171 unit, 5/5 integration, 73/73 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,195,021 bytes, JS total 10,155,744 | Automated review; the *visual* preview is asserted only as far as the DOM reaches — that discs appear on the right part in the right state is not machine-checked, and P10.5's headset session and P12.2's independent review are where a human confirms it. Hover and selected ear states carry pinned colours but nothing drives them. No hardware print has confirmed an ear holds a corner down (P8.6) |
| `EVID-066` | P5.3.5, P5.3, P0.2 | Current worktree atop `3a1182d`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-simplify-preview.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: decimation is split into a prepare that commits nothing and an apply that installs exactly what prepare produced, which makes "the preview matches the applied result" a property of the structure rather than one a test has to keep re-checking — apply is handed the same prepared object, not a second run of the same settings. Both pinned modes are now reachable (`use_count` ratio, and quadric `max_error`). Six traces: preview records no command and leaves the stored mesh byte-identical; apply installs the previewed triangles exactly, and the previewed vertices exactly at float32 storage precision — asserted as `Math.fround` of the prepared values rather than tolerated as a delta, so the two cannot quietly drift behind a tolerance; a looser error budget removes more than a tight one; the same ratio prepares the same mesh twice; a stale prepared decimation is refused by the existing topology guard once the volume has moved on; and undo restores every triangle. 171/171 unit, 5/5 integration, 74/74 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,198,143 bytes, JS total 10,158,866 | Automated review; **the preview's DOM surface is not built** — preview/apply/cancel are workspace API and are not yet controls, so an operator still reaches only the one-shot `simplify_model` action. Upstream's per-object configuration persistence and XR remain. The decimation itself keeps the `EVID-037` deviation: a deterministic binary heap rather than upstream's layout-dependent mini-heap, so the exact surviving triangle set differs from a compiled upstream run |
| `EVID-067` | P5.3.5, P5.3, P10.6, P0.3 | Current worktree atop `06570f8`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; `src/ui/dom/__tests__/SimplifyPanel.test.ts` | Chrome for Testing 150.0.7871.24; jsdom 29; **no headset, no hardware** | Pass: the preview session `EVID-066` built is now reachable by an operator. `simplify_preview`, `simplify_apply`, and `simplify_cancel` are registry actions owned by P5.3, and `ui/dom/SimplifyPanel.ts` fronts them with both pinned modes selectable. Six traces: apply and cancel are inert until something is previewing and a second preview cannot stack on the first; preview needs a selection; the mode switch decides which limit is sent, with the inactive field disabled rather than hidden; the readout reports counts and share removed; an error-limited run says it stopped short rather than implying it hit the target. **The main-chunk budget was crossed by 1.1 KB and was not raised** — the simplify panel and the brim-ears panel beside it are now fetched on demand, which is the same call made twice before this session, and main came in at 2,197,136 bytes against a 2,200,000 guard. 172/172 unit, 5/5 integration, 74/74 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass | Automated review; P5.3.5 stays open on upstream's per-object configuration persistence. **Correction (`EVID-068`): this row first said all three actions were DOM-only, which was wrong** — none declares an `xrUnsupportedReason`, so all three carry `xr-inspector` and render in the headset's Panels menu. The claim was written from intent rather than from the registry. That the previewed mesh is what an operator *sees* on the model is asserted only through the workspace API in `EVID-066`; a human confirms the rendering at P10.5 and P12.2 |
| `EVID-068` | P5.3.6, P2.6, P10.9, P0.2 | Current worktree atop `19a4841`; commit pending | `9fd12ff...` | 2026-08-16 | `npm --prefix web run quality`; the registry's own `capability.surfaces` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass, and **it opens by correcting `EVID-067`**: that row claimed the three simplify actions were DOM-only. They are not — none declares an `xrUnsupportedReason`, so `surfacesFor` gives all three `xr-inspector` and they render in the headset's Panels menu. The claim was written from what was built rather than read from the registry, which is the same mistake in miniature that §20b is about. The registry was then asked directly, and the answer also showed which actions really are DOM-only: the brim-ear five. Two of those are now lifted. `brim_ears_auto` and `brim_ears_clear` take no parameters, and the on-model disc preview (`EVID-065`) means their result is drawn in the scene rather than only in the DOM list — automatic placement opens the ear tool as part of placing, so a headset operator sees the discs appear instead of nothing. The remaining three keep an `xrUnsupportedReason`, now specific rather than shared: a radius needs a numeric field, removing one ear needs the indexed list, and the modal placement tool needs a pointer on the mesh. 173/173 unit, 5/5 integration, 74/74 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,196,962 bytes, JS total 10,166,314 | Automated review; **no headset has run any of this.** What is verified is that the registry offers these actions on XR surfaces and that their results are scene-visible by construction — not that a person in a Galaxy XR can find and use them, which is P10.5's session and remains the gate. The lifted reasons are a claim this session is making, and P12.2's independent reviewer is who should test it |
| `EVID-069` | P4.9, P2.6, P10.9, P0.2 | Current worktree atop `860e85f`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/actions/__tests__/parity.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass: the shared-reason pattern from `EVID-068` was looked for across the whole registry rather than left as a one-off, and it had struck twice. `paint_smart_cancel` carried the Smart Paint family's sentence about choosing destinations per region in a DOM list — which describes `paint_smart_apply`, not the discard beside it. Discarding needs no region editor, takes no parameter, and clears a scene overlay, so its disappearance is the confirmation. The effect of the block was concrete: a mask proposed in the DOM shell survives into an immersive session, so an operator could see pending state in a headset and have no way out of it. That is now lifted. **The invariant is pinned rather than the instance:** a trace asserts that every action whose only effect is to remove pending or placed state — `paint_smart_cancel`, `brim_ears_clear`, `brim_ears_auto`, `simplify_cancel` — reaches an XR surface, because a shared reason is exactly how this got wrong twice and a third family would go the same way. The remaining 22 blocked actions were read individually; each names a genuine DOM dependency (a file picker, a text field, a numeric entry, an indexed list, or a readout surface). 173/173 unit, 5/5 integration, 74/74 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,196,838 bytes, JS total 10,166,190 | Automated review; **no headset has run this.** The claim verified is that the registry offers these actions on XR surfaces and that each removes state visible in the scene — not that an operator can find them, which is P10.5. `paint_smart_apply` stays withheld and should: choosing destinations per region genuinely needs the DOM list |
| `EVID-070` | P8.3, P1.5, P0.2 | Current worktree atop `738167b`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-calibration-session.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: a calibration no longer costs the operator their project. `addCalibration` opened by dropping a test model onto whatever plate was in front of the operator; it now holds the whole canonical state aside and hands the editor a clean project with the same printer, profile, and physical tools. Cancelling installs the held state wholesale rather than un-doing, so no number of calibration commands or new meshes can leave a trace. Five traces, the central one asserting that a cancel after two calibration imports restores a byte-identical state and the same `projectFingerprint`; the others cover the explicit keep, refusal to nest, and refusal to cancel with nothing held. **A wrong assumption was caught by the test rather than shipped:** the first version held only the state, on the stated belief that assets are immutable and additive. They are not — `session.reset` replaces the repository with the snapshot it is handed and validates the state against exactly that, so cancel threw instead of restoring. The comment asserting the false property is now the comment explaining the true one. 173/173 unit, 5/5 integration, 75/75 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,198,574 bytes, JS total 10,167,926 | Automated review; this is one clause of P8.3, which stays open on parameter dialogs, preview, regenerate, slice, inspect, export/send, and the contextual documentation links. No DOM or XR surface offers keep/discard yet — the session is reachable through the workspace API and is entered automatically by `addCalibration`, so an operator can currently get their project back only through that API. Geometry has still not been compared against official examples, and nothing here has been measured on hardware (P8.6) |
| `EVID-071` | P8.3, P2.6, P10.6, P0.3 | Current worktree atop `1e81c82`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/ui/dom/__tests__/CalibrationSessionBar.test.ts`; `src/actions/__tests__/parity.test.ts` | Chrome for Testing 150.0.7871.24; jsdom 29; **no headset, no hardware** | Pass: the protection recorded in `EVID-070` is now one an operator can invoke. `calib_session_discard` and `calib_session_keep` are registry actions, and the banner sits in the viewport rather than an inspector because the risk it addresses is someone not knowing their project is held. Four traces: nothing renders while no session is open; an open one names both ways out and carries `role="status"` rather than `alert`, since nothing is wrong; the held project is named when it has a name; and both controls report exactly once with neither lingering after the session closes. Discard joins the back-out invariant from `EVID-069`, which now covers five actions. **The main-chunk budget was crossed by 450 bytes and again was not raised** — the emboss panel, still eagerly imported and disclosure-gated, was moved to an on-demand fetch, and main came in at 2,195,289 against the 2,200,000 guard. 174/174 unit, 5/5 integration, 75/75 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass | Automated review. **One gate run failed and was not treated as green:** the offline smoke timed out waiting for `#app-boot.ready`. It passed standalone and the whole gate passed on a re-run, so it is recorded as the `EVID-035` contention flake rather than as a fix. P8.3 stays open on parameter dialogs, preview, regenerate, slice, inspect, export/send, and the contextual documentation links; geometry has not been compared against official examples and nothing has been measured on hardware (P8.6) |
| `EVID-072` | P8.3, P8.1, P0.2 | Current worktree atop `a8ecc47`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/form.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: calibration parameters are editable and their result is previewable, for every pinned workflow. The preview is asserted to be `deepEqual` to what `compileCalibrationJob` returns directly — a preview that agrees only approximately with what gets built is a preview of something else. Ten traces cover the sweep over all definitions, the compiler-owned rejection of an out-of-range value reported with its path, a cleared number treated as absent rather than as zero, an unreadable number named rather than coerced, an uneditable parameter that cannot be steered by a caller's edit, a stray key that is ignored rather than injected into the request, and determinism of a re-ask. **A real bug was found by a round-trip trace rather than shipped:** several calibrations default `speeds` and `accelerations` to an empty list, and the first parser read empty as blank and refused it — those workflows could not compile from their own defaults. The trace that caught it (every definition's displayed defaults must read back as themselves, and compile to the same plan) is now the general guard. 174/174 unit, 5/5 integration, 76/76 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,195,289 bytes, JS total 10,172,224 | Automated review; **no surface renders this form yet** — it is a module with traces, not something an operator can reach, and that is the next step rather than a claim being made here. P8.3 also stays open on slice, inspect, export/send, and the contextual documentation links. Geometry has not been compared against official examples and nothing has been measured on hardware (P8.6) |
| `EVID-073` | P8.3, P10.2, P0.3 | Current worktree atop `5df6dff`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/ui/dom/__tests__/CalibrationParametersPanel.test.ts`; `src/project/calibration/docs.test.ts`; the pinned `doc/calibration/` tree | Node 22.21.0; jsdom 29; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: the parameter form has a panel, and every calibration has a contextual documentation link that goes somewhere real. Seven panel traces: a compiling form offers to build and states what it would build; a non-compiling one cannot be built from; an issue marks the field that caused it and not the others, with `aria-invalid` and `aria-describedby` binding the message to its input; an issue belonging to no field is still reported; a fixed parameter is visible but inert; reset is inert until something changed; and an edit reports the text as typed. Four documentation traces, the load-bearing one asserting that **every link target is a file that exists in the pinned tree**, failing rather than skipping when the submodule is absent — a link check that skips quietly is how a dead link ships. Links name `PINNED_CALIBRATION_COMMIT` and are asserted not to reference `main` or `master`, so documentation cannot drift away from the behaviour it describes; the four flow stages share the one upstream guide rather than implying four that do not exist. 174/174 unit, 5/5 integration, 78/78 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,195,289 bytes, JS total 10,172,224 | Automated review; **the panel is not mounted in the shell** — it is a component with traces, so no operator reaches it yet, and it has no XR surface. P8.3 stays open on that, on slice, inspect, and export/send for the generic modes. The documentation links are verified to exist at the pinned commit, not that their content matches OrcaXR's behaviour, which is P12.2's reviewer. Nothing here has been measured on hardware (P8.6) |
| `EVID-074` | P8.3, P8.2, P0.3 | Current worktree atop `93b392e`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/ui/dom/__tests__/CalibrationParametersPanel.test.ts` | Chrome for Testing 150.0.7871.24; jsdom 29; **no headset, no hardware** | Pass: the parameter panel is mounted behind a workflow chooser and previews against the operator's real machine — `calibrationPrerequisites()` reads bed, build height, nozzle diameter and temperature range, filament type, flow ratio, volumetric ceiling, retraction, layer and line width, speeds and accelerations from the live canonical config. Absent values fall back conservatively on purpose: a calibration refused for not fitting is a nuisance, one accepted on an assumed-larger bed is a crash. Switching workflow clears edits, because two definitions can share a key and mean different things by it. **The build control is withheld rather than faked** — the compiler yields a plan, but materialising one into the canonical graph is P8.2, so the button is visible, disabled, and states the reason, while the preview still reports what the settings would produce. A trace holds exactly that: withheld, says why, and the plan summary survives the withholding. 174/174 unit, 5/5 integration, 78/78 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,198,934 bytes, JS total 10,206,561 | Automated review; **`maxLayerHeightMm` is derived as 0.8 × nozzle diameter rather than read** — no config key states it — and the firmware block asserts Klipper capabilities rather than probing them, so a Marlin target would be described wrongly here; both are flagged rather than hidden, and P8.4's connected-printer path is where firmware becomes a fact instead of an assumption. The panel has no XR surface. Nothing has been measured on hardware (P8.6) |
| `EVID-075` | P8.2, P8.3, P6.7, P0.2 | Current worktree atop `6f2782b`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-calibration-session.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: a compiled calibration plan's effects reach the canonical project graph. Each per-height effect becomes one layer range carrying that band's `layer`-scope engine overrides; object and print scopes are routed to the object and project config through the existing scoped-override path. This closes P8.2's "generated bands must carry real engine overrides rather than visual labels alone" — the compiler produced them and nothing installed them, so a temperature tower was a tower shape printed at one temperature throughout, which is indistinguishable from a working calibration until someone measures it. Three traces: a band's installed config holds the exact keys and values its effect declared, asserted per band rather than in aggregate; the install is a single undo entry and one undo removes every band, because a plan applied halfway produces upper bands at the wrong settings with entirely reasonable-looking G-code; and an unknown object is refused. **The main-chunk budget was crossed by 31 bytes and again was not raised** — the SVG panel, tool-gated and still eager, moved to an on-demand fetch; main 2,196,140 against the 2,200,000 guard, the fourth time this session the answer was to stop shipping something everyone pays for. 174/174 unit, 5/5 integration, 78/78 project, 8/8 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this installs the overrides, it does not prove the slicer honours them** — no parsed-G-code oracle checks that band *n* printed at its declared temperature, which is P8.2's remaining acceptance and the natural next use of the headless engine harness from `EVID-053`. Pinned resource and generated-geometry loading remain, so the geometry is still the alpha generator's. Nothing has been measured on hardware (P8.6) |
| `EVID-076` | P8.2, P8.3, P7.8, P0.2 | Current worktree atop `884fbf9`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/calibration-band-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass, **and it overturns `EVID-075`.** That row recorded that compiled bands now carry real engine overrides. Asking the engine showed the installation was wrong in two ways the archive could not see. First: **a layer range whose config omits `layer_height` crashes the pinned engine outright** with an out-of-bounds memory access — bisected across four archives (no range, empty range, temperature-only range, layer-height range) and now a trace. Every band carries the process layer height as a result. Second: a range-scoped `nozzle_temperature` is a filament option the region-config path never applies, so the tower would have sliced end to end at one temperature — the precise failure `EVID-075` claimed to have fixed. Bands install their `customGcode` as authored layer events instead, the channel upstream's own tower uses and the one `EVID-062` already proved reaches the program; the trace asserts each band's `M104` is present *and* that the commanded temperatures are distinct, since three bands all printing at the project temperature would satisfy a weaker check and calibrate nothing. A third rule surfaced while fixing it: a layer event must be above the plate, so the base band is the print's starting setting rather than a change. 174/174 unit, 5/5 integration, 78/78 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,196,674 bytes, JS total 10,208,495 | Automated review; this proves a band's command reaches the sliced program at its height, not that a printer honours it or that the resulting tower measures correctly — P8.6's supervised print is the only thing that can say so. Only the temperature family is covered by an oracle; the pressure-advance, input-shaping, and flow families emit different commands and have not been put to the engine. Pinned resource and generated-geometry loading remain, so the geometry is still the alpha generator's |
| `EVID-077` | P8.2, P8.3, P0.2 | Current worktree atop `260111b`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-calibration-session.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: all fifteen pinned workflows were put through materialisation, and the sweep found two more silent no-ops in code committed twenty minutes earlier. Seven workflows place their effects per object or per line rather than per height, and `applyCalibrationPlan` reported success while installing nothing. The four flow families were worse than nothing: they sweep `print_flow_ratio` across a grid of patches, and accumulating those onto one placed object kept the last value and dropped eight — a plan that slices and calibrates nothing while reporting `objectKeys > 0`. Both now refuse by name. A third refusal names `retraction_length`, a filament setting the print preset does not hold, which had been surfacing as an unrelated scope error from three layers down. **7 install, 8 refuse**, and the trace asserts every workflow gives one of those two definite answers, that a refusal names itself and says "Nothing was changed", and that no half-installed bands remain. 174/174 unit, 5/5 integration, 78/78 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,197,764 bytes, JS total 10,209,585 | Automated review; **eight of fifteen workflows cannot be materialised at all**, which is now stated rather than mimed — per-object and per-line placement needs the pinned resource geometry that P8.2 still lists as outstanding. Of the seven that install, only the temperature family has an engine oracle (`EVID-076`); pressure-advance-tower, junction-deviation, the two input-shaping sweeps, max-volumetric-speed and vfa emit different commands and have not been put to the slicer. Nothing has been measured on hardware (P8.6) |
| `EVID-078` | P8.2, P8.3, P7.8, P0.2 | Current worktree atop `9ca2128`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/calibration-band-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: the seven installable workflows use three mechanisms between them and all three are now engine-verified. A range-scoped `outer_wall_speed` reaches the program as a changed feedrate — asserted by reading `G1 ... F` back and converting mm/min to mm/s — which is the entirety of what `max-volumetric-speed` and `vfa` rely on and could not be assumed once range-scoped `nozzle_temperature` had proved inert; inert speed would have meant two more workflows installing cleanly and measuring nothing. `SET_PRESSURE_ADVANCE`, `M205` and `SET_INPUT_SHAPER` survive the layer-event channel verbatim, so pressure-advance, junction-deviation and the two input-shaping sweeps are not filtered out by the G-code writer on their way to a printer that would have honoured them. With `EVID-076`'s temperature oracle, **no installable workflow now rests on an unverified path.** 174/174 unit, 5/5 integration, 78/78 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass | Automated review; this verifies the three *mechanisms*, not each of the seven workflows end to end — a plan whose 300 bands each carry a correct command is not proven band-by-band, only that such a command arrives. The eight refusing workflows remain unmaterialisable pending per-object and per-line placement. And no printer has executed any of these commands: that a Klipper host accepts `SET_INPUT_SHAPER` at the frequency a sweep chose is P8.6's supervised print, which has not happened |
| `EVID-079` | P8.2, P12.1, P12.3, P0.1 | Current worktree atop `769b496`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/features/__tests__/calibration-resources.test.ts`; the pinned `resources/` tree | Node 22.21.0; **no headset, no hardware** | Pass: all **18** calibration resources the inventory names are verified by git blob hash against the pinned tree, and the calibration pin is confirmed to be a commit that tree actually holds. This closes a provenance gap that mattered: the resource envelopes the compiler uses for bed-fit were audited from those exact files, so a resource that had quietly changed would place a calibration off the bed while every other check stayed green. Missing submodule fails the trace rather than skipping it. **A deliberate non-action is recorded here too:** the eight refusing workflows were investigated rather than force-fitted, and their per-object effects carry `positionMm: null` — `flow-pass-1` has nine effects and no layout, because upstream does not place them, the resource does. Inventing a plate layout would have produced a plausible calibration that measures something other than what the workflow means, so it was not invented. 174/174 unit, 5/5 integration, 78/78 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass | Automated review; this verifies the resources are the audited ones, **not that they are loaded** — nothing reads them yet, and doing so is a payload decision (14 MB in the pinned tree against a 4.8 MB precache) and a redistribution question about vendored upstream assets, which is the operator's call rather than one to make silently mid-session. Until then eight of fifteen workflows refuse by name (`EVID-077`) |
| `EVID-080` | P8.3, P10.2, P0.2 | `d7c6480` | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/instructions.test.ts`; `src/ui/dom/__tests__/CalibrationParametersPanel.test.ts` | Node 22.21.0; jsdom 29; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: P8.3's measurement instructions exist and reach the operator. Bands are read from the compiled plan's effects rather than re-derived from parameters, and a trace asserts value, label and z-range identity with the effect at the same index for **every** pinned workflow — a sheet that recomputes a formula can disagree with the G-code that was installed, and being off by one band produces a confident measurement of the wrong value that then lands in a preset. A print with no height bands is not described as stacked: `flow-pass-1` is located as "piece n on the plate", asserted *not* to say "from the bed". The sheet names what to measure and which preset key a result writes to before one is recorded. **A fixture lie was removed rather than worked around:** the panel tests passed `plan: {} as never`, which the new code exposed by actually reading `plan.effects`; all three now use a real compiled plan. 174/174 unit, 5/5 integration, 79/79 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,197,764 bytes, JS total 10,211,222 | Automated review; the instructions are asserted to correspond to the compiled plan, **not to a physical print** — that the third band of a real tower is visibly at 20 mm is P8.6's supervised print. The sheet has no XR surface. P8.3 stays open on slice, inspect, and export/send for the generic modes. **Recorded one commit late:** `d7c6480` shipped the code saying "Recorded as EVID-080" while the docs edit had failed on a stale anchor, so this row arrived in the follow-up commit |
| `EVID-081` | P8.3, P8.2, P0.2 | Current worktree atop `7b84adc`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/verify.test.ts`; `src/ui/dom/__tests__/CalibrationParametersPanel.test.ts`; the pinned `compiler.ts:966` predicate | Node 22.21.0; jsdom 29; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: the compiler's `sliceAssertions` are evaluated for the first time, and the panel will not offer a plan that breaks one. Five traces, including the check on the checker — a plan with a band removed must fail its own effect-count assertion, or every pass above it means nothing — plus a substituted resource blob and a plan of inert effects. Failures are phrased for an operator ("the geometry is X, not the audited Y") and a trace asserts no message hands back a JSON path. **Two evaluator bugs of mine were caught by the sweep rather than shipped:** it read `resources[0]` for every resource assertion, so the input-shaping family's second tower reported a false failure — the index is parsed from the path now, and an unparseable path returns a distinct sentinel that fails loudly instead of comparing against `undefined`; and its "actionable" predicate omitted placement, failing `tolerance-extension`, whose six gauges differ only in position. The predicate is now copied from `compiler.ts:966` rather than reinterpreted. 174/174 unit, 5/5 integration, 80/80 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,197,764 bytes, JS total 10,213,423 | Automated review; **the honest limit is recorded in the module itself** — several assertions are computed by the compiler from the plan they describe, so on a freshly-compiled plan they are near-tautological; their value is on a plan that has travelled. This is plan-level inspection, not G-code inspection: what the slicer does with an installed plan is `EVID-076`/`EVID-078`. P8.3 stays open on slice and export/send surfaces for the generic modes, and on an XR surface |
| `EVID-082` | P8.3, P2.6, P10.6, P0.3 | Current worktree atop `5796ab1`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/actions/__tests__/parity.test.ts` | Chrome for Testing 150.0.7871.24; Node 22.21.0; **no headset, no hardware** | Pass: calibration parameters are reachable from the registry, and therefore from MCP and from a headset. `calib_choose`, `calib_configure` and `calib_reset_parameters` own the workflow choice and the edits, which moved from shell-local state into the workspace — a panel that owns its own field values is a panel only that panel can drive, which breaks this project's rule that every operator action is a registry action. None declares an `xrUnsupportedReason`, so all three carry `xr-inspector`; the reset joins the back-out invariant from `EVID-069`, now six actions. **A 54 KB regression was caught by the budget and fixed at the cause:** validating the workflow id in the workspace pulled the whole generated calibration catalog into the main chunk, to make a check `buildCalibrationForm` was already making — the duplicate authority is gone, and narrowing happens at the surface that already holds the catalog. Main came in at 2,195,207 against the 2,200,000 guard after moving the tool-gated measure panel to an on-demand fetch, the fifth time this session the answer was to stop shipping something everyone pays for rather than raise the line. 174/174 unit, 5/5 integration, 80/80 project, 9/9 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **no headset has driven these** — what is verified is that the registry offers them on an XR surface, not that the parameter panel itself renders in XR, which it does not: the DOM panel is still the only rendering of the form. P8.3 stays open on slice and export/send surfaces for the generic modes |
| `EVID-083` | P8.3, P8.2, P0.2 | Current worktree atop `da5504b`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/calibration-materialise-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: the real path is joined end to end for the first time — compile, materialise through the controller, serialize the controller's own state, slice. Every band the plan declared above the plate is asserted commanded *by its temperature*, not merely that some `M104` appears; a tower that commands one temperature nine times would pass the weaker check and calibrate nothing. Prior evidence covered the two halves separately (`EVID-075`/`EVID-077` against canonical state, `EVID-076`/`EVID-078` against the engine with hand-built archives) and the join between them was assumed. **Two fixture errors of mine were caught by the run rather than recorded:** swapping only the effective config broke the canonical invariant that effective equals base plus overrides — the plan writes real overrides, so base and effective must move together — and a `BoxGeometry` is centred on the origin, so a 90 mm tower spanned −45..45 and the engine had no layers above 45 mm, dropping the top four bands and failing for a reason unrelated to the code under test. 174/174 unit, 5/5 integration, 80/80 project, **10/10 slice**, 8/8 settings, and 1/1 XR files pass; bundle main 2,195,207 bytes, JS total 10,216,296 | Automated review; this is one workflow end to end, not seven — the other six installable ones share the mechanisms verified in `EVID-078` but have not each been driven through the full path, which is minutes of engine time per workflow rather than a missing capability. Export/send for the generic modes remains unbuilt, and nothing here has been printed (P8.6) |
| `EVID-084` | P8.3, P9.2, P10.2, P0.3 | Current worktree atop `0d021e3`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/ui/dom/__tests__/CalibrationSessionBar.test.ts` | Chrome for Testing 150.0.7871.24; jsdom 29; **no headset, no hardware, no printer** | Pass: P8.3's last unblocked clause. Slice, Save G-code and Send to printer are on the calibration banner, routed through the same registry actions the toolbar uses rather than a second path that could drift. Placing them on the banner is the point: with a session open they act on the calibration and not on the held project, and the banner is what says so — a trace asserts the message states it and names the held project. Saving and sending are inert until G-code exists; sending is withheld **with its reason** when no printer is connected while saving stays available, since a file needs no printer and a control greyed with no explanation teaches operators the app is broken. Eight banner traces in total. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,195,810 bytes, JS total 10,217,406 | Automated review; **nothing has been sent to a real printer from a calibration session** — the send path is the one `EVID-013`'s live-Moonraker e2e covers for ordinary projects, and it is the same action, but the calibration case has not been driven against a printer. The banner is DOM-only. P8.3's remaining gap is now the XR rendering of the parameter form, plus the eight workflows blocked on resource geometry |
| `EVID-085` | P8.3, P10.9, P2.6, P10.6 | Current worktree atop `abd4ee9`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/form.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass: the calibration parameter form renders in XR, which required inventing the number entry this registry had been declaring impossible. A stepper needs no keyboard and cannot leave the definition's own values: bounds and step come from the pinned definition, choices cycle because the definition enumerates them, and a fixed parameter refuses to step on every surface rather than only in the DOM. Both shells build from one `CalibrationFormPreview`, so they cannot disagree about a value. Five traces, including a fractional step yielding `0.3` rather than `0.30000000000000004` — a calibration field showing that is a field nobody trusts again. **An 84 KB regression was caught by the budget and fixed at the cause, for the second time this session:** importing the stepper from `form.ts` pulled the compiler, definitions and generated catalog into the main chunk, so the arithmetic now lives in a leaf module that imports a type and no code. Main 2,197,652 bytes against the 2,200,000 guard. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **no headset has rendered this** — the stepper arithmetic is unit-tested and the XR rows are built by the same code path as every other Panels row, but that a person can reach and press them in a Galaxy XR is P10.5. The other actions withheld for "no in-headset number entry" (`brim_ears_configure`, `svg_configure`, emboss size) **keep their reasons**: the pattern that would serve them now exists, but building it for them is work not yet done, and lifting a reason on the strength of a pattern would be a false claim |
| `EVID-086` | P5.3.6, P5.3.4, P2.6, P10.9 | Current worktree atop `f39424c`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; the registry's own `capability.surfaces` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass: the stepper pattern from `EVID-085` was built for the two other actions it genuinely serves, rather than left as a claim. `brim_ears_configure` (radius, 0.1–20 mm) and `svg_configure` (depth and width) now carry `xr-inspector`, verified by reading the registry rather than by assuming the edit worked. Only bounded settings are offered: a stepper with no limits is a typed field with extra steps and would let a headset reach a value the DOM would refuse. SVG depth cannot reach zero, because a zero-depth part is geometry the slicer discards without complaint. **`emboss_configure` keeps its reason and that is the point** — its blocker is *text*, not a number, and no stepper solves it; lifting it alongside the others would have been the false claim `EVID-085` explicitly declined to make. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,198,661 bytes, JS total 10,220,257 | Automated review; **no headset has pressed these.** What is verified is that the registry offers them on an XR surface and that the rows are built by the same path as every other Panels row; that they are reachable and usable in a Galaxy XR is P10.5. `tool_brim_ears` and `brim_ears_remove` stay DOM-only for reasons a stepper does not address |
| `EVID-087` | P8.2, P12.3, P10.6, P0.1 | Current worktree atop `6018285`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/resources.test.ts`; `git hash-object` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: the upstream geometry the eight refusing workflows need is shipped and verified. **A number this session had escalated as a blocking decision was wrong and is corrected here:** the 14 MB quoted was the whole `resources/calib` tree, including towers the installing workflows never load because they use generated geometry. What the refusing ones actually need is five files totalling **1.7 MB**, excluded from the precache — 143 entries at 4,844 KiB, essentially unchanged — so anyone who never opens a flow or tolerance calibration downloads none of it. Loading verifies the git blob id the inventory audited and **refuses** a mismatch rather than warning, because the compiler's bed-fit numbers were audited from exactly those bytes and different geometry under the same name would print off the plate with nothing complaining. Five traces: the blob framing checked against `git hash-object` itself rather than a reimplementation of it, every shipped file matching its audited hash, the shipped copies byte-identical to the pinned tree (copied, not regenerated), tampered bytes refused, and a missing file reported rather than yielding an empty plate. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this ships and verifies the geometry, it does not yet place it** — per-object and per-line materialisation is the work that turns the eight refusals into installs, and it now has real geometry to place instead of an invented layout. The files are vendored from Snapmaker's AGPL-3.0 tree, which the repository already carries as a submodule and whose source remains available; that is a redistribution the licence contemplates, and it is recorded here rather than left implicit |
| `EVID-088` | P8.2, P8.3, P0.2 | Current worktree atop `cfe5c85`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/resourceObjects.test.ts`; the shipped `flowrate-test-pass1.3mf` | Node 22.21.0; **no headset, no hardware** | Pass, and it caught a bug before it was written. Per-object materialisation needs each resource piece paired with a plan effect, and the obvious pairing — zip by index — is wrong: the real resource stores its nine patches in lexicographic name order (`flowrate_0`, `flowrate_10`, `flowrate_15`, `flowrate_20`, `flowrate_5`, `flowrate_m10`, …) while the effects run 0.8 → 1.2 ascending. Zipping would have printed the −20 % setting on the patch labelled 0 % and mis-assigned every patch after it, producing a plate that slices, prints and measures perfectly while teaching the operator a nonsense number — the worst failure available to a calibration. **This was found by reading the resource before writing the pairing, not by testing it afterwards.** The match reads the percentage the name encodes; a trace pins that the two orders genuinely differ by asserting the 0 % patch takes ratio 1 while the first effect does not. Any piece that fails to find exactly one effect refuses the whole mapping, and three traces cover the ways that happens: a plate missing a patch, a patch the plan has no setting for, and a name that is not a patch name. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this is the pairing, not the placement** — installing the matched pieces as canonical objects still needs the resource parsed into geometry and added to the project, which is the next step and now has a correct pairing to use. Only the flow family's naming is understood; the pressure-advance line and pattern encode their sweeps differently and have not been read. Nothing has been printed (P8.6) |
| `EVID-089` | P8.2, P1.5, P11.6, P0.2 | Current worktree atop `855b228`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/zip64-archive.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset, no hardware** | Pass: all four shipped flow archives open, yielding exactly the 9, 10, 11 and 16 pieces their plans expect. They had been refused outright as "ZIP64 archives exceed the supported browser envelope" — a guard whose premise did not hold for a 150 KB file that is ZIP64 only because its writer emits the records unconditionally. ZIP64 is now read at all three levels upstream uses: the end record, the per-entry extended-information field (positional, so the caller states which fields carry sentinels — a fixed layout would take the wrong eight bytes for any entry not using all of them), and the same field on each local header, without which a sentinel was being compared against a real size and every archive looked inconsistent. **This widened what can be parsed and nothing that is accepted:** entry count, directory extent, path safety, compression method, local/central agreement and total size all apply to the ZIP64 values unchanged, a 64-bit field above `Number.MAX_SAFE_INTEGER` is refused rather than truncated, and the central-directory extent stays an *equality* against the ZIP64 record's own offset so no unaccounted bytes sit between them. Three traces, two of them adversarial: a truncated archive and a corrupted ZIP64 signature are both still refused. The full hostile-input and round-trip suites pass unchanged. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,623 bytes | Automated review; this is security-sensitive code and the review of it is automated — **P12.5's security sign-off is exactly the gate that should look hardest at this change**, and it has not happened. Opening the archives is not placing their objects: materialisation still has to add the parsed pieces to the project, and only the pass-1 percent naming is understood — `Orca-LinearFlow` names pieces `flowrate_0.01`, a different encoding this build deliberately does not guess at |
| `EVID-090` | P8.2, P8.3, P0.2 | Current worktree atop `3f57e46`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/zip64-archive.test.ts`; `src/project/calibration/resourceObjects.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: the second upstream naming encoding was **derived rather than guessed**, and the derivation is proved. `EVID-089` closed noting that only pass-1's percent form was understood and that `Orca-LinearFlow`'s `flowrate_0.01` would not be guessed at. Reading each archive's names beside its own plan's values settled it: an integer suffix is a percentage, a decimal suffix is an absolute offset from 1, and the decimal point is the discriminator. The proof is a bijection across **all four** archives — 9, 10, 11 and 16 pieces each finding exactly one setting, and every setting exactly one piece. That is a hard property: one wrong rule anywhere leaves a piece or a setting over, so it fails rather than degrades. Reading `flowrate_0.05` as five percent would have placed it beside the 1.05 patch and mis-labelled the plate — the same silent-scramble failure `EVID-088` was written against, one encoding further in. 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,191,623 bytes | Automated review; this completes the *pairing* for all four flow resources. **Placement remains**: adding the parsed pieces to the canonical project with their matched settings is the step that turns the four flow refusals into installs. The pressure-advance line and pattern, and `tolerance-extension`, are a different shape again — lines and placed gauges rather than named patches — and have not been read. Nothing here has been printed (P8.6) |
| `EVID-091` | P8.2, P8.3, P0.2 | Current worktree atop `e0e9ca3`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/zip64-archive.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: a flow calibration installs as a real plate. The archive opens (`EVID-089`), its bytes are the audited ones (`EVID-087`), its patches pair with the plan's ratios by meaning (`EVID-088`, `EVID-090`), and now they are placed. The load-bearing assertion is **per patch**: nine distinct ratios on nine named patches, with `flowrate_0` at 1, `flowrate_m20` at 0.8 and `flowrate_20` at 1.2 — distinctness alone would survive a shuffle, and a count would survive nine identical ratios. A second trace drives pass-2's plan against pass-1's plate and asserts that a mapping which does not line up installs **nothing**, leaving the plate empty rather than partly built. Config is written before the state is installed, so there is no instant at which the project is a plate of patches all at one ratio. **Four of the eight refusing workflows are now installs.** 174/174 unit, 5/5 integration, 80/80 project, 10/10 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,193,286 bytes | Automated review; the placed plate has **not been sliced through the engine** — the per-object path is new and only the per-height path has an engine oracle (`EVID-076`, `EVID-078`, `EVID-083`), so whether `print_flow_ratio` per object reaches the toolpaths is asserted at the canonical level only. Given that range-scoped `nozzle_temperature` turned out inert at exactly this kind of boundary, that gap is worth naming rather than assuming past. `pressure-advance-line`, `pressure-advance-pattern`, `retraction-tower` and `tolerance-extension` still refuse. Nothing printed (P8.6) |
| `EVID-092` | P8.2, P8.3, P0.2 | Current worktree atop `35dbd90`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/flow-calibration-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass, and it closes the gap `EVID-091` named instead of leaving it named. Per-object `print_flow_ratio` reaches the toolpaths. **Slicing once could not have shown this** — a plate whose patches all silently printed at 1.0 would produce G-code and a perfectly ordinary filament total — so the same placed plate is sliced twice, once with the calibration's nine ratios and once with every patch flattened to 1.0, and the totals must differ. Flow ratio scales extrusion, so identical totals would mean nine identical squares that slice, print and measure exactly like a calibration. This is the fifth engine-visible claim put to the slicer this session and the first of them to hold on the first ask; the four before it did not, which is why it was asked at all. 174/174 unit, 5/5 integration, 80/80 project, **11/11 slice**, 8/8 settings, and 1/1 XR files pass; bundle main 2,193,286 bytes | Automated review; this proves the ratios reach the toolpaths, not that a printed plate measures correctly — which patch is the right one is what P8.6's supervised print on the U1 and Elegoo CC exists to answer, and it has not happened. The remaining four refusals (`pressure-advance-line`, `pressure-advance-pattern`, `retraction-tower`, `tolerance-extension`) are drawn lines and placed gauges rather than named patches, a shape this build has not read |
| `EVID-093` | P8.2, P8.3, P0.2 | Current worktree atop `367d6f5`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/calibration-band-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware** | Pass: `retraction-tower` installs, and the reason it did not was mine. `EVID-077` recorded its refusal as a fact about the build — `retraction_length` is a filament option the print preset cannot hold — but the key only reached print scope because the base-band handler routed *every* layer-scope key there. Putting it to the engine showed a range-scoped retraction length changes the program while a range-scoped temperature does not, so the routing now applies only to keys whose range form is empirically inert. **That list is one key long and every entry is a slice trace**, because membership cannot be inferred from scope: `nozzle_temperature`, `outer_wall_speed` and `retraction_length` are all non-print options and all three behave differently — a rule derived from their scope would have been wrong about two of them. Separately, a comment-only `customGcode` no longer becomes a layer event; `retraction-tower`'s is `; Calib_Retraction_tower: …`, and installing it would have added an event per band that changes nothing while implying a mechanism that is not the one working. 174/174 unit, 5/5 integration, 80/80 project, 11/11 slice, 8/8 settings, and 1/1 XR files pass | Automated review; the trace shows the banded retraction changes the program's filament total, **not that each band retracts its own declared length** — a per-band assertion would need the retraction moves parsed per z, which this does not do. Three workflows still refuse: `pressure-advance-line` and `pressure-advance-pattern` draw lines, and `tolerance-extension` places gauges, shapes this build has not read. Nothing printed (P8.6) |
| `EVID-094` | P8.2, P8.1, P0.2 | Current worktree atop `4542184`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-calibration-session.test.ts`; the shipped `OrcaToleranceTest.stl` | Node 22.21.0; **no headset, no hardware** | Pass: `tolerance-extension` was read rather than left described as blocked, and it turns out to be refused for a different reason than the other two. Its plan compiles to six pieces at six bed positions with **no engine overrides on any of them**, against a resource verified to be a single binary STL solid (15,518 triangles, one mesh). Placing them would put six identical gauges on the bed labelled 0 mm through 0.4 mm — a plate that slices, prints and measures nothing while being indistinguishable from a working calibration. **The refusal message was the problem as much as the refusal:** "cannot yet materialise" reads as missing capability and invites a future fix of placing six copies, which would ship exactly that plate. It now names the real cause, and a trace asserts both the premise (this plan genuinely carries no per-piece setting) and the message. 174/174 unit, 5/5 integration, 80/80 project, 11/11 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this is a gap in the job model, not in placement** — whatever distinguishes upstream's six clearances is not in the compiled plan, and finding it means reading how upstream's own tolerance flow varies them, which has not been done. `pressure-advance-line` and `pressure-advance-pattern` remain refused for the original reason: they draw lines, a shape this build does not place. Nothing printed (P8.6) |
| `EVID-095` | P8.2, P8.1, P0.2 | Current worktree atop `2dad74e`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/canonical-calibration-session.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: the last two refusals were read, and "draws lines, a shape this build does not place" turns out to have been the wrong description. `pressure-advance-line` is **51 lines all at z 0.2 mm**, differing only in Y; `pressure-advance-pattern` is 17 across four rows at that same single height. A layer range is a z band, so no model can distinguish them — the setting must change mid-layer at a coordinate, which the model-to-slicer path has no hook for, and upstream generates this G-code directly rather than slicing anything. The refusal names that, since "cannot yet materialise" promised a placement that will never be the mechanism. A trace asserts the premise (every line really is in one layer) alongside the message, so the claim cannot rot into a slogan. **All fifteen workflows have now been read:** twelve install; the three that do not refuse for three different, accurate reasons. 174/174 unit, 5/5 integration, 80/80 project, 11/11 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,194,028 bytes | Automated review; **this is a description of a limit, not its removal.** Supporting the two sweeps means generating a G-code program directly — a second output pipeline beside the slicer, with its own correctness story — and that is not built and is not a small addition. Recording it accurately is what stops it being attempted as a placement. Nothing printed (P8.6) |
| `EVID-096` | P8.2, P8.3, P0.2 | Current worktree atop `cd8294d`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/calibration/lineProgram.test.ts`; the pinned profile's `machine_start_gcode` | Node 22.21.0; **no headset, no hardware, nothing sent to a printer** | Pass: the two sweeps' calibration bodies are generated — 51 and 17 lines, each preceded by its own command, with rectangular-bead extrusion. The trace that matters asserts **the command precedes the move it applies to and nothing else sets the value in between**; emitting it after would draw every line at its predecessor's setting, including the first at whatever the machine happened to hold, and the file would look entirely normal. `M83` is asserted present because without it the first E value would be read as absolute and extrude metres. **The complete program is refused, deliberately.** The U1's `machine_start_gcode` was measured at 5,623 characters with 44 template tokens — bed mesh calibration, nozzle cleaning, per-extruder auto-feed, bed-type Z-offset branches, `{nozzle_temperature[initial_extruder] - 90}` — and evaluating those is the slicer's job. A hand-written preamble would ship a file that looks complete and skips bed levelling on a real machine. The gap is returned as structured `missing` data so a caller cannot treat the body as printable. 174/174 unit, 5/5 integration, 80/80 project, 11/11 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **nothing here has been sent to a printer and the body is not printable by design.** Completing it needs the slicer's template evaluation applied to a machine preamble, which is a real piece of work and a safety-critical one — P12.5's security review and P8.6's supervised print are both gates that should see it before any operator does. The extrusion model is the same rectangular approximation upstream uses; whether the printed lines are dimensionally right is a hardware question |
| `EVID-097` | P8.2, P8.3, P9.2, P0.2 | Current worktree atop `d50c234`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/machine-envelope-slice.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **no hardware, nothing sent to a printer** | Pass, and it turns `EVID-096`'s safety refusal into a safe implementation. The machine templates never needed reimplementing — the slicer evaluates them on every slice — so the preamble is borrowed from the engine's own output for an ordinary project. A trace asserts the borrowed head homes, runs `BED_MESH_CALIBRATE`, cleans the nozzle, and **contains no surviving `{` or `}`**, which is the direct check that these are evaluated results rather than template text. Two safety refusals are driven against *mutated real engine output* rather than invented fixtures, since that is what a profile change or an extraction bug would actually look like: a preamble stripped of `G28` and an epilogue stripped of its ending are both rejected. A wrapped sweep is asserted to prepare, calibrate and shut down **in that order** — presence alone would pass a program that calibrated before it levelled. 174/174 unit, 5/5 integration, 80/80 project, **12/12 slice**, 8/8 settings, and 1/1 XR files pass | Automated review, and this is the part that most wants a human: **no program produced this way has been sent to a printer.** The envelope is the engine's own and the order is checked, but whether a U1 executes a borrowed preamble followed by foreign moves exactly as it does its own print is precisely what P8.6's supervised print exists to establish, and P12.5's review should see a path that assembles files for a physical machine. Nothing wires this into a surface yet — it is two tested modules, not an operator-reachable action |
| `EVID-098` | P8.3, P8.2, P9.2, P2.6 | Current worktree atop `c669dbf`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality` | Chrome for Testing 150.0.7871.24; Node 22.21.0; **no headset, no hardware, nothing sent to a printer** | Pass: the sweep generator is an operator-reachable action. `calib_sweep_export` compiles the plan, borrows the machine envelope from the last real slice, wraps the body and saves the file; it is an MCP tool and carries `xr-inspector` like the rest of the calibration group. **The split is the point: export is offered and send is not.** A file an operator can open and read is the safe half of P8.3's export/send clause; putting a generated program directly onto a machine is the half that no supervised print has cleared, and offering it would be the first outward-facing risk this session took without evidence. Requiring a sliced project is stated as the reason it exists — the sweep borrows that machine's own start sequence — rather than surfacing as a generic unavailability. A plan that does not compile, or an envelope failing the homing/heating checks, returns a reason and no file, because a partial program is worse than none to someone who is about to print it. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,198,528 bytes | Automated review; **no file produced by this path has been printed, and send remains withheld deliberately.** P8.6's supervised print on the U1 and Elegoo CC is what would justify offering send, and P12.5's review should see a path that assembles G-code for a physical machine before an operator does. `tolerance-extension` remains blocked on its job-model gap (`EVID-094`) |
| `EVID-099` | P8.2, P8.3, P0.2 | Current worktree atop `6ead091`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/tolerance-gauge.test.ts`; the shipped `OrcaToleranceTest.stl` | Node 22.21.0; **no headset, no hardware** | Pass, **and it overturns `EVID-094`.** That row read the effects right — six pieces, no engine overrides — and concluded the job model had a gap. Measuring the gauge settled it instead: the plan's required envelope is 57.937 × 14.401 × 6.401 mm and the STL's bounding box is 57.936 × 14.400 × 6.400, so the envelope describes **one copy plus a fit margin**. A trace makes the arithmetic explicit — a 57.9 mm gauge cannot repeat every 38.571 mm without overlapping by nineteen millimetres — so six placements were never the design. The six clearances are the reading key for a single printed gauge, which `calibrationInstructions` already publishes and a trace asserts. `placeSingleGaugeCalibration` places it, guarded by the envelope comparison so a plan that genuinely wants several copies is refused rather than silently printed as one. With this, **all fifteen pinned workflows have a materialisation path**. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass; bundle main 2,199,188 bytes | Automated review; **this places the gauge, it does not prove the printed clearances measure correctly** — that the 0.1 mm feature really is 0.1 mm on a U1 is what P8.6's supervised print establishes, and it is the entire purpose of this calibration. The placement is not yet wired to an action, so an operator reaches it through the workspace API rather than a control |
| `EVID-100` | P8.3, P8.2, P2.6, P10.6 | Current worktree atop `a08ea82`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality` | Chrome for Testing 150.0.7871.24; Node 22.21.0; **no headset, no hardware** | Pass: the gauge placement is an operator-reachable action rather than workspace API. `calib_place_geometry` is an MCP tool carrying `xr-inspector`, and it loads through `loadCalibrationResource` so geometry that is not the audited bytes refuses the placement instead of being printed — the compiler's bed-fit numbers came from those exact bytes, and a substituted model would place a calibration off the plate silently. **A refused placement cancels the calibration session it opened**, so an operator is never left inside an empty calibration they did not ask for; that is the failure an eager session-open would have introduced. The single-gauge shape is the only one this handles, with the flow families and the generated sweeps kept on their own paths, because one entry point covering three mechanisms would hide which one ran. **The main-chunk budget was crossed by 1.5 KB and was not raised for the seventh time this session** — the inspector-gated layer-event panel moved to an on-demand fetch; main 2,195,781 against the 2,200,000 guard. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **nothing placed this way has been printed.** Whether the gauge's 0.1 mm clearance measures 0.1 mm is the whole purpose of the calibration and only P8.6's supervised print answers it. The verification is that the bytes are the audited ones, not that the audit was right about them |
| `EVID-101` | P12.6, P12.2, P12.5, P0.1 | Current worktree atop `08d7e43`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `npm --prefix web run parity:report`; `tools/parity/test.mjs` | Node 22.21.0; **no headset, no hardware** | Pass: P12.6's deliverable exists. The report is generated from manifests rather than prose — task states and evidence rows parsed from this document, inventory counts from the parity manifest, drift from its audit, and git blob hashes for the engine, patch set and calibration geometry — and `--check` is in the quality gate so it cannot drift from what it describes. It leads with the statement that the parity claim is **not permitted**, naming all five outstanding human gates individually rather than counting them. **A false positive in its first run was fixed rather than reported:** it named `P1.1` as complete with no evidence, which `EVID-003` plainly covers — the row writes `P1.1–P1.3` as a range and the parser read that as one opaque token. A phantom gap in the section a reviewer is meant to trust most is worse than no report, so range expansion is now pinned by a self-test, alongside two properties the report must never soften: the claim is never reported as permitted, and every gate says which it is and what it requires. Current state: 102 tasks, 2 complete, 7 unstarted, 101 evidence rows. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **the report describes the plan, it does not audit it** — a task marked `[~]` with a generous Current paragraph counts the same as one with a sparse honest note, and only P12.2's independent reviewer can tell those apart. That is the point of building it now rather than at the end: it is an input to that review, not a substitute for it |
| `EVID-102` | P12.3, P12.5, P0.1 | Current worktree atop `c346ec4`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `npm --prefix web run parity:artifacts` | Node 22.21.0; **no headset, no hardware** | Pass: P12.3's checkable acceptance clause is a gate. 214 committed files across four artifact roots — engine, WASM patch set, profiles, calibration geometry — are verified against the commit in both directions: a modified tracked file means the tests ran against bytes nobody else has, an untracked one means an artifact exists only on this machine. This protects the *evidence* more than the build: every slice result in this ledger was produced by some engine binary, and if that binary is not the committed one then none of them describe the artifact another person would get. **Two absences are reported by the tool in its own output rather than left to inference:** rebuilding the engine or server CLI from clean sources needs the Emscripten toolchain, and **route comparison has no suite at all** while the other seven named corpora do — listing only the covered ones would have read as full coverage of P12.3's list, so the gap is a deliberate entry. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this qualifies artifacts, it does not rebuild them.** P12.3 asks for reproduction from clean sources and that has not happened; a hash matching itself proves the tests and the commit agree, not that the binary can be regenerated. Route comparison — the same project through the in-browser WASM route and the external server route, compared — remains unwritten, and it is the corpus most likely to find a divergence nothing else would |
| `EVID-103` | P12.3, P0.2, P11.6 | Current worktree atop `92f1f24`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/__tests__/route-comparison.test.ts` | Node 22.21.0 driving the shipped WASM engine directly; **the external CLI is absent, so the comparison itself has not been run** | Pass: the corpus `EVID-102` named as missing now exists. The comparator reads the facts a printer acts on — layers, filament, extrusion roles, printer commands — and compares them semantically, since the two builds legitimately differ in headers and generator strings while byte equality would drown a real divergence in that noise. Filament is compared proportionally and everything else exactly: a dropped `M104` or a missing brim role is never a tolerance question. **The traces that carry this are the failing ones.** Six run against real engine output, four of them asserting the comparator *reports* a dropped role, a dropped command, a layer-count difference and a filament gap past tolerance — a comparator verified only on identical inputs is a check that can never say anything, which this session has now seen four times in other guises. It refuses to run without the CLI rather than skipping. 189/189 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **the two routes have not actually been compared.** The external OrcaSlicer CLI lives in the qualification container and is absent here, so what is proven is that the comparator works, not that the engines agree — and they may not, which is the entire reason P12.3 names this corpus. Running it is a P12.3 step for whoever has the container, and the artifact report now records the corpus as present but not runnable here rather than folding it in with the ones that do not exist |
| `EVID-104` | P5.3.2, P5.3, P2.6, P0.2 | Current worktree atop `0da8a13`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/workspace/__tests__/exploded-view.test.ts` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass: the exploded view is rendered, and rendered in the one way the acceptance allows. `setExplosionFactor` writes to display objects only; canonical placement is untouched and the factor is workspace state rather than a command, since an exploded view in undo history would be an edit pretending to be a camera. **The trace that earns its place demonstrates the drift rather than asserting the guard:** composing offsets from already-exploded positions really does land somewhere other than going straight to the factor, which is why the renderer holds an assembled baseline per instance. Others pin that the offsets sum to zero — so an opening assembly stays centred rather than wandering off the plate — and that a factor below one is refused rather than imploding the view. **A small correctness fix came out of it:** at factor 1 the offsets were `-0`, numerically zero but not `Object.is` zero, so a caller checking "is this assembled" with a strict or deep comparison would have been told the parts had moved when they had not; the documented "exactly zero at factor 1" now holds under equality too. `assembly_explode` reaches XR because a bounded factor is a stepper, not a typed field. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **the projection is verified, the rendering is not** — that the parts visibly separate on screen is asserted only as far as the display objects' positions, and no headset or human has seen it, which is P10.5 and P12.2. Upstream's volume-level alignment mode and its on-canvas handles remain unbuilt, and the five alignment actions stay DOM-only |
| `EVID-105` | P5.3.1, P5.3, P2.6, P10.9 | Current worktree atop `9d2061a`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/actions/__tests__/parity.test.ts`; the registry's own `capability.surfaces` | Node 22.21.0; Chrome for Testing 150.0.7871.24; **no headset** | Pass: P5.3.1's on-screen dimension annotation exists, and building it made an XR exclusion obsolete. The line is drawn between the points the engine measured between rather than the picked features — a point-to-plane distance is measured to the foot of the perpendicular, and a line to the plane's origin would not be the length shown beside it. With the readout in the scene, `tool_measure` and `measure_clear` are lifted. **The evidence that the other half was never blocked was already in the registry:** four paint tools on the same XR toolbar pick features by ray against a mesh, so picking in a headset was demonstrably possible while measure was withheld for a reason that only described its readout. The registry test that encoded the old truth was updated rather than deleted, including its comment, which had said measure's flow was DOM-only. `measure_clear` joins the back-out invariant, now seven actions. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **no headset has drawn this annotation.** What is verified is that the registry offers the actions and the line uses the measured endpoints; that a dimension is legible in a Galaxy XR is P10.5. `tool_assembly` stays withheld and correctly so — choosing an alignment is a DOM list, not a readout. The two documented deviations (algebraic circle fit, degree-8 solver) and the differential corpus against a compiled pinned build remain open |
| `EVID-106` | P5.3.3, P5.3.4, P1.5, P0.2 | Current worktree atop `5be2ea2`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/import/__tests__/unhonoured-settings.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: settings this build preserves but does not apply no longer arrive silently. `use_surface` and `per_glyph` round-trip faithfully and change nothing, so a project whose text is projected onto a curved surface imports as a flat extrusion — correct preservation, and a silent divergence from what the file describes. Import now warns, and **the warning is about the divergence rather than the gap**: a trace asserts it does not say "unsupported" or "not implemented", because that tells an operator about a roadmap when what they need to know is that the model in front of them is not the model in the file they opened. A control trace holds that an ordinary project raises nothing, since a warning that fires on every import is one nobody reads. The flags are read from the parsed state rather than the archive text, so a comment mentioning `use_surface` cannot raise a warning about geometry nobody asked for. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; **this reports the divergence, it does not remove it.** Applying surface projection and per-glyph cutting is real geometry work and remains outstanding on both tasks, as does the golden oracle against a compiled pinned build. The list of unhonoured settings is maintained by hand — removing an entry is part of implementing it, and nothing enforces that pairing |
| `EVID-107` | P5.3.3, P5.3.4, P0.2 | `d0d934d` | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `src/project/import/__tests__/unhonoured-settings.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: the pairing `EVID-106` closed by naming as unenforced is now enforced. That row admitted the unhonoured-settings list was maintained by hand with nothing tying an entry to the behaviour it describes — so implementing `use_surface` without deleting its warning would leave the app telling operators their geometry diverges when it no longer does. **That lie is harder to notice than the original silence, because it looks like diligence:** a warning nobody can reproduce gets explained away rather than investigated. A trace now asserts `use_surface` produces byte-identical positions and indices whether set or not, checking the list against behaviour rather than intent — while the setting genuinely changes nothing the warning is honest, and the moment it changes something this fails and forces the entry out with it. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; the enforcement covers `use_surface` through the emboss mesh builder. `per_glyph` has no equivalent behavioural check — its effect would be a different *number of volumes* rather than different geometry from one builder call, so this trace shape does not reach it, and the gap is named rather than assumed covered. **Recorded one commit late:** `d0d934d` shipped saying "Recorded as EVID-107" while the docs edit had failed on a reflowed anchor — the third time this session an `&&` chain committed code after a silent docs failure |
| `EVID-108` | P12.6, P0.1, P0.2 | Current worktree atop `d0d934d`; commit pending | `9fd12ff...` | 2026-08-17 | `npm --prefix web run quality`; `tools/parity/test.mjs`; `npm --prefix web run parity:report` | Node 22.21.0; **no headset, no hardware** | Pass: the failure mode that produced three late evidence rows this session is now caught by machine rather than by reading output. A generated docs edit asserts an anchor, the anchor has been reflowed by an earlier edit, the edit fails — and the `&&` chain runs on and commits the code, so a commit message says "Recorded as EVID-nnn" and nothing was. It happened at `45577c0`, `d7c6480` and `d0d934d`, each caught only because the output was read. The release report now scans the last 200 commit messages for `Recorded as EVID-nnn` and **fails** when the table does not carry that row. **The detection is a pure function with its own test**, because a guard nobody has seen fire is indistinguishable from one that cannot: a trace feeds it a claim with no row and asserts it is reported, and a claim that was recorded and asserts it is not. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; this catches the *claim* without a row, not a row that misdescribes what it covers — an evidence entry can still be generous about what was proven, which is what P12.2's independent reviewer is for. It also only looks back 200 commits, which is ample now and is a horizon rather than a guarantee |
| `EVID-109` | P5.3.3, P0.2 | Current worktree atop `90b8693`; commit pending | `9fd12ff...` | 2026-08-18 | `npm --prefix web run quality`; `src/project/import/__tests__/unhonoured-settings.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: `EVID-107` closed by naming `per_glyph` as the entry with no behavioural check, and it now has one. Both entries in the unhonoured-settings list are held against behaviour rather than intent, so implementing either forces its warning out. **The fixture detail is the whole of it:** the trace uses a two-glyph string, because cutting one character separately is indistinguishable from not cutting it separately — a single-letter fixture would have passed against a working per-glyph implementation and left the warning in place, which is the exact failure the enforcement exists to prevent. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; this holds that the flags change nothing, which is what makes the import warning honest — it does not implement surface projection or per-glyph cutting, and both remain outstanding geometry work on P5.3.3 and P5.3.4 |
| `EVID-110` | P5.3.4, P1.5, P0.2 | Current worktree atop `0294c18`; commit pending | `9fd12ff...` | 2026-08-18 | `npm --prefix web run quality`; `src/project/objects/__tests__/svgShapes.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass, **and it found a real defect while closing a documented gap.** "Presentation inheritance beyond a shape's own `fill`/`stroke` is not resolved" was recorded as a limitation; it was a silent wrong-geometry bug. `fill` and `stroke` are inherited SVG properties, and reading only an element's own attributes meant `<g fill="none" stroke="#000">` around a path — the ordinary output shape of Illustrator, Inkscape and Figma — left the path looking fillable, so **a line drawing extruded as a solid with no notice at all**; the `stroke-only` warning written for exactly this case could never fire on a grouped drawing. Confirmed by probe before the fix and pinned by three traces after: a grouped line drawing is refused through both the attribute and `style` forms; a child setting its own fill still becomes solid, because treating an ancestor's `none` as final is the opposite failure and equally silent; and a grouped shape stating no fill is still solid, since SVG defaults `fill` to black and the fix must not make silence mean "none". 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; CSS `<style>` blocks with class selectors are still unresolved, and that gap is now the only one of the two — a drawing whose fill comes from a stylesheet rule rather than an attribute or an inline `style` will still be read as filled. No SVG from a real drawing tool has been imported end to end here; the traces are hand-written documents exercising the parser |
| `EVID-111` | P5.3.4, P1.5, P0.2 | Current worktree atop `ea56aa9`; commit pending | `9fd12ff...` | 2026-08-18 | `npm --prefix web run quality`; `src/project/objects/__tests__/svgShapes.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: the last named SVG gap, and — probed before being believed — the same silent-solid defect as `EVID-110` in a second disguise. A class-based `fill:none` extruded as a solid with no warning, which is what every drawing tool that writes classes rather than attributes produces. Element, `.class` and `#id` selectors are resolved now. **The cascade runs in SVG's order rather than the intuitive one:** a presentation attribute is the weakest of the three — weaker than any stylesheet rule — while an inline `style` is the strongest, and two traces pin both directions, because reversing them would silently pick the wrong paint for any themed document. A rule inside a comment is not a rule. A selector beyond those forms is reported through the existing unsupported channel rather than ignored, so a drawing relying on a combinator still extrudes and says why. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; this is not a CSS engine and does not claim to be — combinators, attribute selectors, media queries and `!important` are unread, and the first three are now *reported* rather than silently dropped while `!important` is not detected at all. External stylesheets are out of reach under the app CSP and always were. No SVG from a real drawing tool has been imported end to end; the traces are hand-written documents |
| `EVID-112` | P5.3.4, P1.5, P0.2 | Current worktree atop `992eb8b`; commit pending | `9fd12ff...` | 2026-08-18 | `npm --prefix web run quality`; `src/project/objects/__tests__/svgShapes.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass, and it corrects `EVID-111`, which listed `!important` as "not detected at all" — a description that made it sound inert. It was not inert: the flag lives in the *value*, so `fill: none !important` compared unequal to `none` and a stroked path carrying it was read as filled. **Reachable from a plain inline `style` with no stylesheet involved**, which makes it the third distinct route to the same silent solid in this one parser. It is now parsed off the value, and its precedence is honoured — an important rule outranks an inline style, the one place CSS and the intuitive order disagree. Both directions are pinned, because honouring only the first would make every inline style useless and only the second would ignore `!important` entirely. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; three silent-solid routes have now been found in this parser (inherited presentation, stylesheet rules, `!important`), each by probing a line the plan described as a limitation. That rate suggests the remaining unread CSS — combinators, attribute selectors, media queries — deserves the same treatment rather than trust, though those are at least *reported* now. No SVG from a real drawing tool has been imported end to end |
| `EVID-113` | P5.3.4, P1.5, P10.6, P0.2 | Current worktree atop `628ba79`; commit pending | `9fd12ff...` | 2026-08-18 | `npm --prefix web run quality`; `src/project/objects/__tests__/svgShapes.test.ts` | Node 22.21.0; **no headset, no hardware** | Pass: the fourth defect in this parser, and the first that fails in the *opposite* direction. `EVID-112` closed by saying the remaining unread CSS deserved probing rather than trust; probing it found that `@media print { .line { fill: none } }` was being applied. The rule matcher pairs a selector with the next balanced `{…}`, which walks into a conditional block, so a print-only declaration turned a filled shape into nothing and the drawing was refused with "nothing that can become a solid part" — for a rule the document had scoped away. At-rules are now skipped to their matching brace and reported. **Two traces in opposite directions**, because skipping everything from the first `@` onward would silently drop the stylesheet's real content and put the parser back to solidifying line art: a rule *after* an at-rule still applies, and a statement at-rule ends at its semicolon. Nested `@supports{@media{…}}` skips to the correct brace. Main chunk crossed by 518 bytes and **again not raised** — the inspector-gated scoped-settings panel moved to an on-demand fetch, eighth time this session; main 2,158,764. 191/191 unit, 5/5 integration, 80/80 project, 12/12 slice, 8/8 settings, and 1/1 XR files pass | Automated review; four defects have now been found in this one parser by probing lines the plan called limitations, and they failed in both directions — three silently solidifying line art, one silently refusing a valid drawing. Attribute selectors and combinators remain unread and reported. No SVG from a real drawing tool has been imported end to end, which is the check most likely to find the fifth |

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
| `ADAPT-14` | Orthographic projection and automatic perspective switching | Perspective only, with both actions declaring the reason rather than a "not implemented yet" placeholder | The View menu keeps both entries and both explain why they are unavailable; the named camera actions (top, front, left, and the rest) still frame a model from any axis | The render camera is created and owned by the XR runtime as a perspective camera, and inside a session WebXR supplies its own projection matrix per view. Overriding it would render orthographically while `Raycaster` still branched on the camera type, so every pick would be computed against a projection the operator is not looking through. A wrong click target that looks correct is worse than a stated absence | Engineering | P11.2, P10.5, P5.1 | Platform-adapted / proposed |

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
| 2026-08-16 | Classify what a connected printer can measure for itself before building anything that measures | P8.4's own clause is that unavailable automation must be visibly distinguished from manual calibration, and the honest finding is that Klipper measures exactly one family of these workflows without a human: resonance testing. Everything else is read off the printed part. Writing that down first means a wizard cannot later be built on the assumption that more is automatable than is, and it keeps three answers distinct that would otherwise collapse into one refusal — not automatable at all, not on this machine, and not asked yet. A machine without an accelerometer is told what it lacks and still offered the printed test, because the test is the fallback rather than the consolation | P8.4, P8.1, P8.3 | 6 classification traces over all 15 workflows and Klipper's object-list shape (`EVID-051`); the wizard, the actual SHAPER_CALIBRATE run, and hardware pending |
| 2026-08-16 | Detect brim-ear corners from the first-layer outline cut out of the mesh, and only where the corner turns outward | A bounding box would have been a few lines and would have been wrong for every part that is not a box: an ear holds a corner down, and a plus-shaped footprint has eight corners where its bounding box has four. Cutting the mesh is what makes the answer about the shape, and dropping the collinear points the tessellation introduces is what keeps a quad wall from reading as two edges with a corner between them. The winding test is the other half: a concave outline has reflex corners that are material on both sides, and an ear there costs plastic and is harder to remove than the part it was meant to hold. Thinning by the sharper of any colliding pair makes the result independent of triangle order, which a per-vertex walk otherwise would not be | P5.3.6, P4.8 | 7 detection traces over box, prism, hexagon, L, plus, and indexed-versus-soup meshes (`EVID-052`); wiring it to the gizmo, a sliced-G-code confirmation, and the on-model preview pending |
| 2026-08-16 | Run the pinned engine headlessly, and assert a known gap as observed rather than deleting the test | P5.3.6 claimed ears reach the engine and left "the sliced result shows them" untested for months; asking the question took a Node harness around the shipped WASM engine, which now exists and is reusable for any engine-visible feature. The answer was no, and the honest response is neither to weaken the assertion until it passes nor to drop the test: it asserts what the engine actually does today, with the reason and the pinned source lines beside it, so the moment the behaviour changes the test fails and someone updates the claim. A silent gap that survives because nothing exercises it is the failure this whole document exists to prevent | P5.3.6, P7.1 | A headless slice of a 20 mm cube with and without four ears, plus the archive-format assertions that do hold (`EVID-053`); the cause of the gap, and any hardware confirmation, pending |
| 2026-08-16 | Store a brim ear at the part base rather than where it was placed, after driving the engine headlessly revealed that none of them worked | The archive was right, the format was right, the object id was right, and the feature did nothing: the engine drops any ear above the bed, and a centred local origin put every ear at mid-height. Nothing reported it because the failure is a clean slice. The lesson is the one the whole evidence discipline is built on — an archive-level assertion proves the file, not the feature, and only asking the engine closes that gap. A brim ear is a first-layer feature, so its Z is the part base by definition rather than wherever up a wall a ray happened to land | P5.3.6, P7.1, P8.6 | A headless slice of a 20 mm cube with and without four ears, before and after the fix, plus 8 detection traces (`EVID-054`); hardware confirmation pending |
| 2026-08-16 | Prove each override scope against the engine, and give the slice suites their own script | The brim-ear bug showed that an archive assertion proves the file and not the feature, so the same question was put to all five of P6.5's scopes. Four hold; the plate scope is parsed and then thrown away by the WASM entry point, which is a located cause rather than a symptom and needs a rebuilt engine to close. Two apparent findings were checked and withdrawn before reaching this ledger — a metric that counts sections rather than loops, and a key the plate scope was never granted — which is the discipline that makes the real ones worth trusting. The slice suites now run after the browser suites under their own script: three WASM slice pairs ahead of Chrome starved it and timed out `#app-boot.ready`, and a suite that fails on ordering teaches people to re-run rather than to read | P6.5, P7.1, P0.2 | Four scopes proven and one gap located with its exact line (`EVID-056`); the plate fix, and every hardware confirmation, pending |
| 2026-08-16 | Read the engine's own source for every gate and marker a slice test depends on, and treat a null result as a suspect fixture before a suspect feature | Four claims have now been put to the engine, and the score is one real bug and four fixture errors of mine — a cube with no overhang, a floating object the engine refuses outright, a marker string Orca does not use, and a config key the plate scope never owned. Every one of them produced exactly the symptom a genuine bug produces: a clean run with the feature missing. The discipline that separates them is cheap and mechanical — read the pinned source for the enum, the gate, and the label; check the archive actually carries what the test thinks it does; and only then believe the null. Without it this ledger would already contain four findings that are not true, which would make the one that is worthless | P4.6, P7.1, P0.2 | Support paint proven end to end through the engine, with the three corrected fixtures named (`EVID-058`) |
| YYYY-MM-DD |  |  |  |  |

## 20b. Engine-visible claims, and which have been asked

An archive assertion proves the file, not the feature. Every claim in this
table was passing at the archive level — the bytes were written, the format was
pinned, the round trip held — and one of them was completely broken in the
print. `src/project/__tests__/sliceHarness.ts` drives the shipped WASM engine
headlessly in Node, so putting the question to the slicer costs one call.

| Claim | Asked? | Result |
| --- | --- | --- |
| Placed brim ears appear in the print | Yes (`EVID-053`, `EVID-054`) | **Was broken.** Every ear discarded for being above the bed; fixed by storing the part base Z |
| A height range changes its own band | Yes (`EVID-055`) | Holds |
| An object override reaches the print | Yes (`EVID-055`) | Holds |
| A part override reaches the print | Yes (`EVID-056`) | Holds |
| A plate override reaches the print | Yes (`EVID-056`, `EVID-057`) | **Was missing.** Parsed then discarded by the WASM entry; fixed by routing plate keys through the per-slice override channel |
| Painted support enforcers and blockers | Yes (`EVID-058`) | Holds |
| Painted seam preference | Yes (`EVID-060`) | Holds |
| Painted fuzzy skin | Yes (`EVID-059`) | Holds |
| Painted colour | Yes (`EVID-061`) | Holds |
| FullSpectrum virtual-filament output | Browser only | The e2e slices a multicolour plate; no headless oracle for the mixing itself |
| Per-band calibration effects | Not yet | Blocked on canonical materialisation of a calibration job (P8.2) |
| Authored layer events (pause, colour change) | Yes (`EVID-062`) | Holds, at the authored height |

Two rules earned the hard way, both recorded in the decision log:

1. **Read the pinned source for every gate, enum, and marker a slice test
   depends on.** Four of the five null results seen so far were the test's
   fault, not the code's — a cube with no overhang, a floating object the
   engine refuses outright, a marker string Orca does not use
   (`;TYPE:Support`, not `;TYPE:Support material`), and a config key the
   plate scope never owned.
2. **Treat a null as a suspect fixture before a suspect feature.** Every one of
   those produced exactly the symptom a real bug produces: a clean run with the
   feature missing. A ledger that recorded them would be worth nothing, and
   would make the two genuine findings worthless with it.

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
