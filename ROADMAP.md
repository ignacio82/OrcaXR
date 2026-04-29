# OrcaXR Roadmap

Forward-looking feature roadmap. **This is the single source of truth for "what's next."** Every feature listed here is enough for a fresh AI session to pick it up, execute it, and verify it without re-discovering prior context.

When you ship a feature: change its status from `🔴` / `🟡` to `🟢` and add a one-line note with the commit SHA, then update the dependent items it unblocks. Do this in the same commit as the code change (mirrors the GEMINI.md self-update mandate).

## How to use this file

1. **Pick a feature** — prefer items with `🔴 Not started` and no unmet dependencies, then `🟡 Partial` items.
2. **Read GEMINI.md** for the load-bearing technical constraints — every Jetpack XR rendering gotcha and libslic3r gotcha applies. The numbered gotchas there are referenced directly from this file (e.g., "gotcha #61").
3. **Read the existing code** at the file paths each entry calls out — that's where the deep context lives.
4. **Land the change**, then update this file in the same commit:
   - flip the status emoji
   - add a `**Shipped:** <commit-sha> — <one line>` row at the bottom of the feature block
   - bump any unblocked downstream features

## Status legend

| Symbol | Meaning |
|---|---|
| 🟢 | Shipped & verified (on Galaxy XR or via instrumented test) |
| 🟡 | Partial / scaffolded — has a working fallback but not the real thing |
| 🔴 | Not started |
| ⚪ | Deliberately deferred — has an entry-criterion that hasn't been met (hardware, upstream merge, user request) |
| 📌 | Open design question — needs a decision before the depending feature can land |

---

## A. Slicing engine correctness & libslic3r parity

Highest priority — these are correctness gaps users see directly in printed output.

### A1. Auto-arrange via libnest2d 🟡 Partial — fallback in place

> **Files:** `app/src/main/cpp/slic3r_jni.cpp` (`nativeArrange`), `app/src/main/java/dev/orcaxr/app/PlacedModel.kt` (`naiveArrangeModels`), `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt` (`arrangeModels`).

JNI surface `nativeArrange(inputPaths, transforms, bedX, bedY, gapMm) -> FloatArray` is wired and dispatches; libnest2d rejects every input (`bed_idx=-1`, `packed_count=0`). Items never reach the placement loop — `on_packed` callback never fires (see GEMINI.md gotcha #61). Kotlin falls back to naive row layout so the user-visible Arrange button still works.

**Next investigation step:** run libnest2d's standalone test suite inside our build and diff a known-good setup against ours. The bug is in either `remove_unpackable_items` (`selection_boilerplate.hpp:53` — items marked `BIN_ID_UNFIT` when `p.pack(cpy)` returns falsy or `itm.area() <= 0`) or the Nester rejecting before `firstfit::packItems`.

**Exit criteria:** Arrange produces non-overlapping placements within bed bounds for ≤32 small parts; respects bed margins; the existing radial Arrange button transparently switches from naive to libnest2d.

### A2. FullSpectrum engine emission ⚪ Deferred — waiting on Snapmaker upstream merge

> **Patches required:** `0025-fullspectrum-engine-emission.patch` (new). **Patch budget:** ~3700 LoC in `PrintObjectSlice.cpp` alone.

Mixed-filament data layer (patches 0015–0019, 0023, 0024) and config keys are landed; `nativeWriteColoredGlb` paint preview works; project-side overrides flow through `mergedConfig`. What's missing: alternating-layer G-code emission. Requires porting Snapmaker's `feature_mix_filament_sm` deltas in `PrintObjectSlice.cpp` (+3749), `LayerRegion.cpp` (+118), `GCode.cpp` (+490), `GCode/ToolOrdering.cpp`.

**Entry criteria:**
1. Snapmaker `feature_mix_filament_sm` branch merges to their main (PRs #270/#272/#276/#277/#278 in flight as of 2026-04-29). Pin to a stable SHA before porting.
2. Dedicated ASAN sweep of `PrintObjectSlice`'s parallel_for sites with the new code (interacts with our patch 0014 TBB serial shim).

**Exit criteria:** A 2-physical-filament + 1-virtual-mix project produces alternating T0/T1 commands per layer in painted regions; existing 4-color dragon autotest preserves the gotcha #23 baseline (442 T-cmds, 17.4 MB, 4 filaments used).

### A3. Filament → physical extruder full port 🟡 Partial — Kotlin-side modulo wraps, libslic3r-side unported

> **Patch:** `0028-filament-physical-extruder-map.patch` (not yet authored).

Kotlin-side `mergedConfig()`/`computeFilamentMap()` already enforces `(target % numPhysical) + 1` so 5+ filaments cycle into real T-commands without going OOB. The full Snapmaker PR #160 port (libslic3r-aware `m_filament_extruder_map` member, `get_physical_extruder()` accessor, per-filament-prefixed config-vector inheritance) remains queued for if/when a regression that resize-from-index-0 doesn't cover surfaces.

**Trigger to schedule:** any user-reported defect on a 5+-filament U1 project where Kotlin-side resize doesn't match Snapmaker desktop output (e.g., wrong `retraction_length` baked into a T-command).

### A4. Honor 3MF-authored flush settings 🟢 Shipped (commit `9bf4f55`)

> **Files:** `slic3r_jni.cpp::extract_3mf_string_array` + `nativeRead3mfFlushSettings`, `SlicerEngine.read3mfFlushSettings`, `OrcaProfileLoader.SAFE_KEYS` (`flush_volumes_matrix`, `flush_multiplier`).

3MF-authored `flush_volumes_matrix` and `flush_multiplier` extracted via direct miniz read (same pattern as filament_colour, gotcha #10b workaround), surface-validated against `n*n*nozzle_count`, fall back to a synthesized 30 mm³ default matrix. Project overrides are now hooked into `mergedConfig` ahead of the libslic3r 280 mm³ default.

### A5. Cross-platform mesh repair ("Fix Model") 🔴 Not started

> **Recommended path:** CGAL `Polygon_mesh_processing` — already cross-compiled and proven on Galaxy XR. OpenVDB voxel-repair is a future optimization (unblocks tree supports + SLA hollowing too, but requires NDK cross-compile work for OpenVDB/Blosc/IlmBase/OpenEXR).

Upstream OrcaSlicer's "Fix Model" depends on the Windows-only 3D Builder API (`FixModelByWin10.cpp` → `fix_model_by_win10_sdk_gui`). ADMesh's import-time pass handles flipped normals + degenerate facets but not non-manifold topology, internal shells, or severe self-intersection. CGAL is already linked into `libslic3r_jni.so` for boolean ops.

**Implementation outline:**
1. **C++** — `src/libslic3r/MeshBoolean.cpp`: new `libslic3r::MeshBoolean::cgal::repair(TriangleMesh&)` that runs `repair_polygon_soup` → `orient_polygon_soup` → `Surface_mesh` conversion → `corefine_and_compute_union(mesh, mesh)` to resolve self-intersections.
2. **JNI** — `slic3r_jni.cpp`: `nativeRepairModel(inputPath, outputPath) -> Int` (return repair stats: tris_in, tris_out, fixed_count). Heap is the OOM risk — guard with try/catch and surface OOM as a Toast in Compose.
3. **Kotlin** — `SlicerEngine.repairModel()` suspend wrapper on the existing single-thread JNI dispatcher.
4. **UI** — wrench-icon button in `PlacedModelsSection` per row; show indeterminate progress for the seconds-long CGAL pass; bump `previewVersion` to re-bake the GLB.

**Exit criteria:**
- Repair on a known non-manifold MakerWorld 3MF (commit a fixture under `app/src/androidTest/assets/`) produces a watertight result (`its.indices.size()` decreases, no holes).
- Repair on a 1M-tri mesh either succeeds or surfaces an OOM Toast cleanly without crashing the JNI dispatcher.
- CGAL parallel_for sites respect the TBB serial shim (gotcha #17).

### A6. Bed-collision check (full mesh-vs-bed) 🟡 Partial — gating shipped, GLB highlight pending

> **Files:** `BedCollision.kt`, `BedCollisionTest.kt`, `MainActivity.kt::previewStl`, `UiPanels.kt::LeftProjectPanel` + `BottomRightSummaryPanel`.

`BedCollision.detect(mesh, bedXmm, bedYmm, recenterToBed)` walks the transformed mesh's vertices against the bed polygon and returns either `Ok` or `Off(offendingTriCount, offendingTriIndices, overflowX, overflowY, worstOverflowXmm, worstOverflowYmm)`. Wired into the STL preview pipeline alongside the legacy bbox `bedFit` summary; the result drives a red banner in `LeftProjectPanel` and disables the Slice button via the same gating shape as `FilamentRules.Result.Forbidden`. Unit tests cover the cube / slab / empty-mesh / translate-with-recenter cases.

**Pending — entry-criterion for the green flip:**
- Render the offending triangles in red on the preview GLB (today the banner alone tells the user which axes overflow). Touches `StlPreviewGlb` / `GlbBuilder` to emit a vertex-color override array keyed off `BedCollision.Result.Off.offendingTriIndices`.

**Shipped:** commit `e6937e3` — `BedCollision.detect`, banner, Slice gate, `BedCollisionTest` (6 tests). Follow-up commit `<pending>` — bed-collision now also runs on the 3MF preview path via `deriveStlFor` + `StlReader`.

### A7. Toolpath rendering as triangulated tubes 🔴 Not started

> **Files:** `ToolpathGlb.kt`, `GlbBuilder.kt`. Cost: ~6–8× triangle count vs LINES.

Today toolpaths render as `mode=LINES` (1 vertex per segment endpoint). Tubes mean a 4-sided extrusion around each segment with mitered joints — closer to desktop OrcaSlicer's GL viewer. Higher visual fidelity at the cost of triangle count.

**Implementation outline:** extend `ToolpathGlb.write` with a `TubeMode` flag. Emit a 4-sided prism per segment; share end-caps between connected segments. Stress-test at 500k segments before shipping (gotcha #11 — `nativeWriteColoredGlb` OOM on big meshes — applies here too; stream to BufferedOutputStream).

**Exit criteria:** A 500k-segment dragon toolpath renders without OOM at 60 fps on Galaxy XR; a togglable preference persists the user's tubes-vs-lines pick across sessions (DataStore).

---

## B. XR UI / UX completeness

### B1. 3D Transform Gizmo (rings + arrows + handles) 🔴 Not started

> **Files:** `MainActivity.kt` (gizmo entity creation parented to selected model), `GlbBuilder.kt` (ring/arrow/handle GLB primitives), `UiPanels.kt` (numeric Transform side-panel — already shipped as TransformPanel; this adds the 3D direct-manipulation surface alongside).

Currently transforms are TextField-driven in TransformPanel ("snap-and-confirm not free-drag" because of ~1 cm hand-tracking jitter). For users with paired Galaxy XR controllers, laser-precision drag handles become viable.

**Implementation outline:**
1. **Translation arrows** — three thin tube GLBs (X/Y/Z), each with `InteractableComponent`. On `Action.MOVE`, project the laser hit onto the arrow's axis, accumulate, write into `PlacedModel.translateXmm/Ymm/Zmm`.
2. **Rotation rings** — three torus GLBs in three planes. Drag delta = `atan2` of the hit-position relative to model center on the ring's plane.
3. **Scale handles** — three small cube GLBs at corners. Drag distance from center, ratio against baseline → `scaleXPct/YPct/ZPct`.
4. **Visibility** — gizmo entity is mounted only when `selectedModelId != null`, hidden during paint mode and during a workspace grab.
5. **Coexistence** — gizmo handles use `InteractableComponent`; the model-grab `MovableComponent` can't share an entity (gotcha #42), so gizmo handles are sibling entities parented to a `OrcaXR-gizmoRoot` GroupEntity that follows the selected model's pose.

**Exit criteria:** rotate to any angle (not just 90°), translate and scale by drag, with TransformPanel and gizmo state always in sync. No frame drops on Galaxy XR (Choreographer skip-frame warnings clean).

**Dependencies:** Galaxy XR controllers input pump (already shipped). Hand-tracked drag is explicitly out of scope (~1 cm jitter is wider than usable handle precision).

### B2. Mixed-Filament UX panel for FullSpectrum 🔴 Not started

> **Files:** existing `MixedColorsPanel.kt` + `MixedFilamentStore.kt` (scaffold landed in commit `734410b`); needs full buildout.

The current `ColorMappingPanel` and `VirtualColorsSection` (`UiPanels.kt:585-871`) cover basics — virtual rows, A+B swap, ratio slider. Rewrite the UX to match FullSpectrum v0.9.8's actual surface (the prior scaffold misnamed several modes — `LayerCycle / Pointillisme / Local-Z` are NOT parallel modes; per-layer alternation is just on by default, dithering and Local-Z are orthogonal modulators).

**Implementation outline (in slices):**
- **B2.1** rename header to "Mixed Filaments" (FullSpectrum's `_L("Mixed Filaments")`).
- **B2.2** add three creation buttons: Add Gradient (existing "+ New mix"), Add Pattern (`mf.manual_pattern = "12"`), Add Color (opens B2.5 dialog).
- **B2.3** keep the existing "Advanced ▾" inline expander pattern (`UiPanels.kt:927-933`); do NOT add a separate popup.
- **B2.4** per-row controls: component swatch pickers (2D weight surface for 3+ components, single slider for 2), manual pattern field with chip-builder (XR keyboard is too painful), bias row gated on `mixed_filament_component_bias_enabled`, apparent-color preview via FilamentMixer (NOT naive RGB lerp).
- **B2.5** Color-Match dialog: 2D color simplex (line/triangle/quad/radial), laser-drag a cursor, live blend update, Delta-E-sorted preset chips, OK creates a row with `distribution_mode` auto-set.
- **B2.6** "Mixed Filaments" optgroup in Settings — group 11 keys into sub-accordions (Local-Z, Step / Painted zones, Bias, Region adjustment, Advanced ordered dithering, Wipe tower, Cadence height overrides). **Do not surface** `mixed_filament_gradient_mode`, `mixed_filament_pointillism_pixel_size`, `mixed_filament_pointillism_line_gap` (hidden in v0.9.8 — research-grade only).
- **B2.7** auto-generation prompt when filament count changes (mirrors FullSpectrum's `Plater::confirm_auto_generated_gradients`).
- **B2.8** tooltip plates for non-obvious settings (Local-Z bounds, Bias semantics, region collapse interaction).

**Dependency on A2** — the panel can author mixed-filament definitions and persist them, but they only affect G-code output once engine emission lands.

**Exit criteria:** A user with 2 physical filaments can author a "blue+yellow=green" virtual mix via Color-Match; the row persists in `MixedFilamentStore`; the apparent-color swatch matches the Kubelka–Munk blend; once A2 lands, slicing emits alternating-layer G-code in painted regions.

### B3. Slot picker filament-type dropdown 🔴 Not started

> **Files:** `FilamentSlotsStore.kt` (DataStore schema migration), `UiPanels.kt` slot-picker UI, `OrcaProfileLoader.kt` filament list (already discovers all types in `assets/profiles/`).

Today the per-slot picker only exposes color (preset palette + hex). Bundled filament JSONs (Phase 3.20 work) include type metadata (PLA Matte, PLA-CF, ABS, PETG, etc.). The UX should let the user pick a *type* per slot so slicing config picks the right `filament_*` key set per slot.

**Implementation outline:**
1. DataStore schema migration from `{color}` → `{color, type}` per slot. Migration default: keep all existing slots as `Generic PLA` for back-compat.
2. Slot picker UI gains a type dropdown alongside the color square, populated from `OrcaProfileLoader.filamentEntries(activePrinter)`.
3. `mergedConfig()` reads per-slot type and resolves the matching filament JSON's keys (this already happens for the active filament; extend to per-slot).

**Exit criteria:** A 4-slot U1 project with slots `{Generic PLA, PLA-CF, ABS, PETG}` slices with each slot's tuned `filament_*` keys (e.g., per-slot `nozzle_temperature`, `pressure_advance`, `fan_max_speed`) reflected in the G-code header.

### B4. Galaxy XR Controller bindings — face buttons 🟢 Shipped

> **Files:** `MainActivity.kt::onKeyDown`, `MainActivity.kt::XrShell` button collector LE, `ControllerInput.kt::buttons` SharedFlow, `TestController.GamepadButton` test command.

Input pump, Sliced-mode axis layer scrubbing, and Prepare-mode stick X/Y nudge + rotate were shipped earlier. The face-button collector now lives in the XrShell `LaunchedEffect(controllerInput)` block:

- **A** → contextual confirm (multi-model → `runSliceMulti`, single → `runSlice`, empty → bundled cube).
- **B** → contextual cancel (Preview → Prepare; otherwise no-op so system back still routes through the OS).
- **X** → Prepare ↔ Preview toggle, Toast hint when no slice exists yet.
- **Y** → toggle `showTravels`.
- All bindings gated `repeatCount == 0` at the Activity layer so holding a button doesn't auto-repeat toggles.
- `TestController.Command.GamepadButton(button)` shim drives `controllerInput.emitButton(button)` so a workstation harness can exercise every binding without paired hardware.

### B5. Galaxy XR Controller help card 🔴 Not started

Quick-reference card for bindings, surfaced via in-app help / about path. Update GEMINI.md only if a non-obvious keycode emerges that future bindings must avoid.

**Exit criteria:** A user can open a help panel in XR and see the binding list; the help panel is reachable via a `?` icon on the top nav.

### B6. XR tooltip primitive 🔴 Not started

> Reused by setting hints, gizmo handle labels (B1), and progressive disclosure for mixed-filament settings (B2).

Implement once: a small `Surface` + `Text` plate that follows laser hover for ~600 ms and dismisses on hover-out. Same pattern as Compose `Tooltip` but rendered as a child SpatialPanel.

**Exit criteria:** Hover the `?` chip on any setting and a plate appears within 600 ms with the long-form explanation.

### B7. Empty-state guidance 🔴 Not started

When `placedModels` is empty, replace the bed with a floating, laser-interactable "Import 3MF/STL" panel rather than rendering an empty plate.

**Implementation outline:** A new SpatialPanel mounted in `XrShell` when `placedModels.isEmpty()` that wraps the existing `FilePickerPanel` invocation with a prominent CTA + recent-files row.

### B8. Numeric input validation 🟢 Shipped

> **Files:** `NumericValidation.kt`, `NumericValidationTest.kt`, `UiPanels.kt::AxisFieldRow` + `TransformAxisSection` + `SettingNumericEditor` + `QualityTab` layer-height field.

`NumericValidation.validate(text, min, max)` returns `Ok(value) | NotANumber | OutOfRange(value, min, max)` — pure, unit-tested. TransformPanel pipes `Ranges.translateMm` (-500..500), `Ranges.rotateDeg` (-1080..1080), and `Ranges.scalePct` (1..2000) into Translate / Rotate / Scale via `AxisFieldRow`.

Print-settings tabs (Quality / Speed / Support) consult `NumericValidation.printSettingRanges` — a curated per-libslic3r-key range table (layer_height 0.04..1.5, all `*_speed` 0.1..1000, sparse_infill_density 0..100, support_threshold_angle 0..90, nozzle_temperature 100..400, etc.). `SettingNumericEditor` and the QualityTab layer-height TextField surface invalid input via `isError` red outline + a one-shot Toast on first out-of-range commit; keys absent from the table fall back to libslic3r's silent clamp (the legacy behavior).

**Tests:** 12 — parse, trim, blank, NaN/Infinity, both bounds, inclusive, transform-range sanity, print-setting key coverage (every Speed-tab key), layer_height typo guard (20 mm rejected), validate end-to-end on a print-setting range.

**Shipped:** commits `7fa3970` (TransformPanel) + `5a4328b` (Print Settings tabs).

---

## C. Connectivity & monitoring

### C1. Print queue (Moonraker queue plugin) ⚪ Deferred — wait for user demand

> **Files:** `MoonrakerClient.kt`, `UiPanels.kt::PrintMonitorPanel`.

Moonraker exposes a job queue plugin (`/server/job_queue/*`). The user has stated the workflow is one-job-at-a-time today. Ship if/when a real workflow ask appears.

**Implementation outline (when scheduled):** `MoonrakerClient.queryJobQueue()`, list/add/remove/move job actions, a queue panel adjacent to PrintMonitorPanel.

### C2. Bed mesh visualization ⚪ Deferred — wait for SceneCore heatmap shader path

Render the probed bed-mesh grid as a heatmap GLB on the build plate. Today we'd hand-roll vertex colors; ship once SceneCore (or an `androidx.xr.compose.material3` future release) exposes a clean heatmap material.

**Trigger to schedule:** SceneCore alpha14+ release notes mention a vertex-color or heatmap material.

### C3. Telemetry opt-in 🔴 Not started — needs backend decision

> Local crash reporting (`CrashReporter`, JSON files under `${filesDir}/crashes/`) is shipped; remote shipping is what's missing.

📌 **Open design question:** what backend? Options: (a) Sentry self-hosted; (b) Anthropic-style minimal POST endpoint; (c) GitHub Issues auto-filed via GitHub App. Decision shapes the data-format + privacy story.

**Implementation outline (post-decision):**
1. UserPreferences: `telemetryOptIn: Boolean = false` (DataStore).
2. Settings UI: a checkbox + privacy explainer in About panel.
3. `CrashReporter` POST when opt-in is true; queue offline; redact filenames.

**Exit criteria:** Toggle opt-in, force-crash via debug broadcast, confirm event lands at the chosen backend; toggle off, confirm no egress.

### C4. AFC slot auto-population 🟢 Shipped

"Sync" TextButton in `LeftProjectPanel` reads cached `printerLoadedFilaments` and overwrites project slots with what the printer reports. Hidden until Detect populates the cache.

### C5. Filament runout badges 🟢 Shipped

`MoonrakerClient.queryStatus` subscribes to `filament_detect`; `LivePrintStatus` renders amber "T_N empty" pills during an active print. Hidden when the printer doesn't expose `filament_detect`.

---

## D. Painting / object editing extensions

### D1. Paint persistence 🟡 Partial — local cache shipped, 3MF round-trip pending

> **Files:** `PaintCacheStore.kt`, `PaintCacheStoreTest.kt`, `MainActivity.kt::previewStl` restore + `LaunchedEffect(placedModels.map { … paintFilamentIndex/supportFlags/seamFlags })` save.

`PaintCacheStore` keys per-triangle paint by source-file SHA-256. Storage is `${filesDir}/paint_cache/<sha>.bin` (raw header + three optional ByteArrays for paintFilamentIndex / supportFlags / seamFlags) instead of DataStore Preferences — base64-encoding 1.4 MB arrays through Preferences would be slower and more memory-thrashing than a direct file-cache mirror of the existing GLB/STL cache pattern. Atomic writes via tmp+rename, mtime-based LRU at `MAX_ENTRIES = 50`.

Wired into `XrShell`:
- **Restore:** in `previewStl`, after `StlReader.read` returns `triCount`, hash the source and call `paintCache.restore(hash, triCount)`. On hit, copy the three arrays into the matching PlacedModel via a `placedModels.map { copy(...) }`. Restore only fires when the model has no paint yet so a cache hit can't clobber fresh in-session edits.
- **Save:** a debounced (300 ms) `LaunchedEffect` keyed on every model's `paintFilamentIndex / supportFlags / seamFlags` writes via `Dispatchers.IO`. A clear-paint round-trips because `PaintCacheStore.save` deletes the entry when every array is null/all-zero.

**Pending — entry-criteria for the green flip:**
- Write paint state into `mmu_segmentation_facets` of an exported 3MF via `nativeSaveAs3mf` so a save-as-3MF opened in desktop OrcaSlicer shows the same painted regions.
- Surface a "Clear paint cache" / "Cache size" affordance in Settings (today the cap is invisible to the user).

**Tests:** `PaintCacheStoreTest` covers round-trip, tri-count mismatch, missing-file, blank-array prune, null-array prune, LRU eviction at the cap boundary, hash stability, content-divergent hashes, corrupt-file fallback, and `Entry.equals`.

**Shipped:** commit `c913e4e` — `PaintCacheStore` + on-load restore + on-mutate save + 10 tests.

### D2. Custom support point placement ⚪ Deferred — SLA-leaning, FDM-only stack today

Per-point support placement (vs paint-region enforcer/blocker). Upstream uses `GLGizmoSlaSupports`. Useful for FDM tree-supports tuning but defer until a user requests it; current Support Enforcer paint mode covers the common case.

### D3. Brim ear painting ⚪ Deferred

Paint per-edge brim ears ("only here"). Profile-side `brim_type=auto` works today. Wait for user request.

### D4. Embossing / SVG inset / text-on-object ⚪ Deferred

Upstream's `GLGizmoEmboss` is a separate large feature. Compose-SpatialPanel-native text-on-mesh is conceivable but a multi-session feature. Defer.

### D5. SLA hollow + drainage holes ⚪ Deferred — FDM stack only

Upstream's `GLGizmoHollow` is SLA-leaning. U1 + Centauri Carbon are FDM. Out of scope until a resin printer enters target hardware.

### D6. Measure tool ⚪ Deferred

Hand-track distance/angle between picked points/edges/faces (upstream's `GLGizmoMeasure`). Useful but additive; user hasn't requested it.

### D7. Multi-step undo for paint ⚪ Deferred

Today only single-step "clear paint" exists. Full undo stack (per-stroke ring buffer) is a v3 nicety.

### D8. Smart fill / connected-region paint ⚪ Deferred

Upstream's "paint connected facets up to a normal-angle threshold." User can drag-paint manually for v1; smart fill is a productivity boost.

### D9. 3MF round-trip for per-object Object Settings 🔴 Not started

> **Files:** `nativeSaveAs3mf` (already preserves `ModelVolume::config` via libslic3r `store_3mf`); the gap is whether OrcaXR-authored `PlacedModel.configOverrides` is written to and read from `Metadata/model_settings.config`.

📌 **Open question:** confirm we want per-object `configOverrides` (e.g., `layer_height=0.4` on a single object) to persist into 3MFs. Currently in-memory only.

**Implementation outline (post-decision):**
1. Native: extend `nativeSaveAs3mf` to also write per-object overrides into the 3MF (libslic3r already serializes `ModelObject::config` if it's set; OrcaXR's overrides must be transferred from `PlacedModel.configOverrides` onto `ModelObject::config` before save).
2. Native: extend the load path so loaded 3MFs populate `PlacedModel.configOverrides` from `ModelObject::config`.
3. Round-trip test: load a fixture with overrides, save through `nativeSaveAs3mf`, reload, assert overrides match.

---

## E. Architecture / scaling beyond MVP

### E1. Module split 🔴 Not started — ship when single-module pain bites

> See GEMINI.md "Module layout" section for the aspirational split.

Currently single `:app` module. The aspirational split: `:slicer:xr` (XR presentation), `:slicer:core` (domain), `:slicer:native` (JNI), `:data` (printer connectivity), `:settings` (DataStore). Do NOT speculatively split — wait for boundaries to hurt.

**Trigger to schedule:** Compose recompositions cross JNI/UI boundaries in unobvious ways, or build times exceed ~3 min, or a non-XR form factor enters scope.

### E2. Hilt DI 🔴 Not started — bundled with E1

Currently no DI, single-module Compose state. Add Hilt when E1 lands.

### E3. Multi-plate (`PartPlate`) ⚪ Deferred

Snapmaker U1 + Centauri Carbon both run one plate at a time. Upstream's `PartPlate.cpp` + `PartPlate.hpp` is multi-thousand lines. Re-enters scope only if a user starts queueing prints.

### E4. Companion phone app 📌 Open design question

> **Status:** blocked on numeric/text-entry decision (G1).

Possible role: parameter editing on a phone screen for users who don't want to type via XR keyboard. Decision shapes whether the slicing UI ships as profiles-first (no freeform numeric entry) or hybrid.

**Decision input needed:** does the user prefer (a) profiles-first, (b) phone companion, (c) Bluetooth keyboard, (d) hybrid?

### E5. Phone / TV form factors ⚪ Deferred — XR must be solid first

> See GEMINI.md "Target platform" section.

Out of scope until XR has a 1.0-quality release.

### E6. Vision Pro port ⚪ Deferred indefinitely

Full Metal + RealityKit rewrite — essentially a separate product, not a port.

### E7. Multi-user collaborative slicing ⚪ Deferred

Shared XR space, multiple users editing the same scene. Speculative.

---

## F. Profile catalog breadth

### F1. Additional U1 nozzle sizes (0.2, 0.8) 🔴 Not started — APK cost <100 KB

Snapmaker fork ships 0.2/0.4/0.6/0.8 nozzle variants; OrcaXR has 0.4 + 0.6 (0.6 shipped in commit `878fe25`). 0.2 + 0.8 remain.

**Implementation:** vendor `assets/profiles/Snapmaker/machine/Snapmaker U1 (0.2 nozzle).json` + `(0.8 nozzle).json` and the matching `process/0.{08,12,16}` (for 0.2) and `process/0.{40,52,60}` (for 0.8) leaves byte-identical from Snapmaker fork. AGPL attribution stays in NOTICE.md. `OrcaProfileLoader` auto-discovers — no code change.

**Exit criteria:** picker shows 0.2 / 0.4 / 0.6 / 0.8 nozzle entries; cube slices on each; AFC sync still works.

### F2. Branded U1 filament leaves 🔴 Not started

> Snapmaker fork ships ~58 branded leaves; OrcaXR ships Generic PLA + Generic ABS + Generic PETG + Elegoo PLA Matte + Elegoo PLA-CF.

Branded leaves cover PLA HF / PLA Eco / PLA Metal / PLA Silk / PETG HF / PETG-CF / PETG-GF / ASA / PA-CF / PCTG / PVA / BVOH / PC / TPU / TPU 95A HF / Breakaway Support + Polymaker/PolyLite/PolyTerra third-party. APK cost <100 KB; UX cost is picker clutter.

**Implementation:** stage-roll. Land the PLA family (HF/Eco/Metal/Silk) first, ABS/PETG branded second, exotic (PA/PC/TPU) third. Ship a nozzle filter chip in the picker if clutter becomes a complaint.

### F3. Centauri Carbon profile breadth 🔴 Not started

Currently 0.2 + 0.4 nozzles, Elegoo PLA Matte + PLA-CF + Generic PETG/ABS. Mirror F2 for the Centauri Carbon side. Defer until the user requests a specific filament; Centauri-tuned leaves are harder to source than Snapmaker-fork-vendored ones.

### F4. `requires_top_cover` flag 🟢 Shipped

Patch `0026-requires-top-cover-flag.patch` + Compose-side `TopCoverRule.kt` warning banner.

### F5. `filament_is_high_temperature` flag 🟢 Shipped

Patch `0025-filament-high-temperature-flag.patch` registers the coBools key. Dormant infrastructure; bundled profiles don't set it (single-color PLA fleet today). Becomes load-bearing when F2's PA-CF / ABS-CF / PEEK leaves land.

---

## G. Open design questions (📌 — resolve before depending features land)

These block downstream work. The user should call them; AI should surface them.

### G1. Numeric / text entry strategy 📌 Blocks B1 polish, E4 (companion app)

Options: (a) profiles-first (no freeform numeric entry — only preset pick + relative tweak sliders); (b) companion Android phone app for parameter editing; (c) assume paired Bluetooth keyboard; (d) hybrid.

**Current state:** TransformPanel ships TextField with the system XR keyboard. Per-key Print Settings TextField in Quality/Strength/Speed tabs also use the keyboard. So the "hybrid" path is implicitly half-shipped.

**Decision needed:** Is the keyboard-first path the long-term answer, or do we want a phone companion / Bluetooth fallback for power users?

### G2. Local vs remote slicing default 📌 Currently local-only

Slice on-device for everything? Offer a "slice on paired PC/server" mode? Both? Galaxy XR thermal + memory budget so far holds (gotcha #23: 20mm cube p50=807ms / peak 262 MB / Δ1.1°C over 10 runs). Not a forcing function yet.

**Decision needed:** ship a remote-slicing fallback, or commit fully to on-device?

### G3. Printer connectivity scope expansion 📌 Currently Klipper/Moonraker only

Add OctoPrint? Bambu cloud? Snapmaker native? The user's two printers (Snapmaker U1 + Elegoo Centauri Carbon) are both Klipper + Moonraker — already covered. Adding OctoPrint costs the most engineering (different polling shape, different upload endpoint) for the smallest user base.

**Decision needed:** stay Moonraker-only, or commit to OctoPrint as a parallel backend?

### G4. 3MF round-trip for Object Settings 📌 Open — see D9

---

## Appendix: Already-shipped milestones (do not re-implement)

Brief reference index. Use `git log --oneline --grep=<phase>` for the full commit chain.

| Feature | Status |
|---|---|
| Phase 0 — Cross-compile spike (libslic3r → arm64) | 🟢 |
| Phase 1 — Viewer MVP (load STL, slice, layer scrub) | 🟢 |
| Phase 2 — Polish, profiles, multi-panel XR shell | 🟢 |
| Phase 3 (most) — Connectivity, multi-color, multi-model, hand-tracking gizmos | 🟢 |
| Selection bbox (yellow outline + tap-to-select) | 🟢 commit `efc0430` |
| TransformPanel — numeric XYZ + mirror + place-on-bed | 🟢 commit `836d270` |
| Lay-on-face + Convert units + Auto-orient | 🟢 commits `1d9efdf`, `472f158`, lay-on-face |
| Multi-volume JNI bridge + per-object Object Settings | 🟢 commits `36782db`..`dd64382` |
| Cut tool | 🟢 commit `39ce263` |
| Mesh boolean + Split + A/B picker UX | 🟢 commits boolean-phase, `40b54d1` |
| Support paint, Seam paint, Clone-pattern | 🟢 commits `0f744e7`, `6cb5f45` |
| SAFE_KEYS expansion + Pressure Advance | 🟢 |
| Profile breadth — 0.6 nozzle U1, Generic ABS, Generic PETG | 🟢 commit `878fe25` |
| Filament map modulo (Kotlin-side) | 🟢 commit `ef8b9a2` |
| Wipe-tower stability fixes (3 patches) | 🟢 commit `fd9dd42` |
| Filament/bed compatibility rules | 🟢 commit `f6a7505` |
| Multi-model UI | 🟢 commit `85e9a10` |
| Snapmaker small flags (high-temp, top-cover, slot edit isolation) | 🟢 commit `fa05537` |
| Moonraker AFC sync + filament-runout badges | 🟢 commit `fa05537` |
| FullSpectrum F.1 — LocalZOrderOptimizer scaffold | 🟢 patch 0023 |
| FullSpectrum F.3 — bbs_3mf max-filament-id helper | 🟢 patch 0024 |
| In-XR laser color paint + slice integration | 🟢 commit `dfdd3c5` |
| Galaxy XR controllers — input pump | 🟢 commit `dfdd3c5` |
| Galaxy XR controllers — Sliced-mode layer scrubbing | 🟢 |
| Galaxy XR controllers — Prepare-mode stick X/Y nudge + rotate | 🟢 |
| UI/UX — Radial menu wiring | 🟢 commit `0d78d26` |
| UI/UX — Top nav pill cleanup | 🟢 |
| UI/UX — Speed + Support print-settings tabs | 🟢 |
| PreviewPalette swatch row ("as-will-print") | 🟢 commit `410e860` |
| Flush-tower volume fix (3MF-authored matrix) | 🟢 commit `9bf4f55` |

---

## Maintenance rules

- **Update this file in the same commit** as the code change that flips a status. Don't let it lag the code.
- **Don't restate GEMINI.md gotchas here.** Cross-reference them by number (e.g., "gotcha #61").
- **Don't dump deep context into a side file.** This roadmap is intentionally the only forward-looking document — when a feature needs more detail than fits here, expand the entry inline with file paths and exit criteria, not a separate plan doc.
- **Keep this file under ~600 lines.** If it grows past that, split a subsection out as a sibling roadmap (e.g., `ROADMAP-painting.md`) and link from here.
