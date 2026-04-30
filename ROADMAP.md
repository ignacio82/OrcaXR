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

### A6. Bed-collision check (full mesh-vs-bed) 🟢 Shipped

> **Files:** `BedCollision.kt`, `BedCollisionTest.kt`, `StlPreviewGlb.kt`, `StlPreviewGlbTest.kt`, `MainActivity.kt::previewStl`, `UiPanels.kt::LeftProjectPanel` + `BottomRightSummaryPanel`.

`BedCollision.detect(mesh, bedXmm, bedYmm, recenterToBed)` walks the transformed mesh's vertices against the bed polygon and returns either `Ok` or `Off(offendingTriCount, offendingTriIndices, overflowX, overflowY, worstOverflowXmm, worstOverflowYmm)`. Wired into the STL preview pipeline alongside the legacy bbox `bedFit` summary; the result drives a red banner in `LeftProjectPanel` and disables the Slice button via the same gating shape as `FilamentRules.Result.Forbidden`. `StlPreviewGlb.write` now also paints the offending triangles in saturated red (overrides paint slot color so the off-bed warning is never hidden by user paint), so the user can read both *which* axes overflow (banner) and *which faces* poke off the bed (preview GLB).

**Shipped:** commit `e6937e3` — `BedCollision.detect`, banner, Slice gate, `BedCollisionTest` (6 tests). Commit `61875bb` — bed-collision now also runs on the 3MF preview path via `deriveStlFor` + `StlReader`. Commit `6aa1151` — `StlPreviewGlb.write` `offBedTriIndices` parameter wired into `previewStl`, `StlPreviewGlbTest` (5 tests covering default/red/paint-vs-offbed/out-of-range/empty). Flips A6 to fully shipped.

### A7. Toolpath rendering as triangulated tubes 🟡 Partial — geometry shipped + capped, miter joins + 500k stress pending

> **Files:** `ToolpathGlb.kt`, `ToolpathGlbTest.kt`, `UserPreferences.kt`, `UiPanels.kt::BottomLayerPreviewPanel`, `MainActivity.kt::XrShell` (toolpathTubes state + LE re-bake).

`ToolpathGlb.write(tubes = true)` emits a 4-sided rectangular prism (8 verts × 12 tris × 36 indices) per extrusion segment. Cross-section is built by tangent t = normalize(end−start), reference axis = world-Z (or world-Y when tangent is nearly Z-aligned to keep the cross product well-conditioned), then side = normalize(cross(t, ref)) and up = normalize(cross(side, t)). Travels stay LINES inside the same TRIANGLES primitive via degenerate-triangle hairlines so we don't pay for a second draw call. Switch + persistence wired through `UserPreferences.toolpathTubes` (SharedPreferences, mirrors the existing `showTravels` flag) and surfaced as a "Tubes" Switch in the bottom layer-preview panel.

**Pending — entry-criteria for the green flip:**
- Above `ToolpathGlb.TUBES_SEGMENT_CAP` (currently 50k segments) the writer silently falls back to LINES because materializing positions+colors+indices for the full 500k-segment dragon (~170 MB JVM heap) would OOM at the typical 256 MB Android process cap. Streaming-tube generation (sequence-based GlbBuilder API) is the follow-up that lifts the cap.
- Mitered joins between connected segments (today every prism is independent; corners read as a small bevel). Requires a connectivity-graph build over `ParsedToolpath.segments`.
- Visual verification on Galaxy XR — current verification is geometry-level (vertex / index counts, doubleSided flag, bbox sanity, vertical-segment cross-product guard).

**Shipped:** commit `9731320` — `ToolpathGlb.write(tubes = …)` + `TUBES_SEGMENT_CAP` fallback + `UserPreferences.toolpathTubes` + `BottomLayerPreviewPanel` Switch + `ToolpathGlbTest` (6 tests covering lines baseline / tubes counts / tube bbox / cap fallback / travels-as-hairlines / vertical-segment Y-axis fallback).

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

### B3. Slot picker filament-type dropdown 🟢 Shipped

> **Files:** `FilamentEntriesStore.kt` (catalog-name default + legacy short-name remap on JSON load), `OrcaProfileLoader.kt::loadFilaments` (Material name → flattened key/value map), `MainActivity.kt::XrShell` (`filamentsCatalog` remembered + threaded into `mergedConfig` calls + `LeftProjectPanel.filamentTypes` from catalog keys), `UiPanels.kt::ColorMappingPanel` + `ModelColorRow` + `MaterialChooser` (dropdown sourced from catalog instead of hardcoded `FILAMENT_TYPES`), `MergedConfigSlotTypesTest`.

`OrcaProfileLoader.loadFilaments(ctx)` walks every brand under `assets/profiles/<brand>/filament/` and returns a `Map<String, Map<String, String>>` keyed by leaf-filament short name (e.g. `Generic PLA`, `Elegoo PLA Matte`) with the flattened key/value config for that filament. `mergedConfig()` `resize()` now keys by config-name string and prefers the per-slot filament catalog entry's value over the active profile's vector at the per-slot resize step — so picking "Generic PETG" on slot 1 raises that extruder's `nozzle_temperature` to 240 without rewriting the profile, while slot 0's "Generic PLA" stays at 215. Falls back to the profile vector for unknown materials, then to fillFromIndex0/last (legacy behavior preserved when `slotTypes` / `allFilaments` are empty). `MaterialChooser` dropdown is now sourced from `filamentsCatalog.keys.sorted()` so vendoring new branded leaves immediately enriches the picker; default short-name `"PLA"` migrated to catalog name `"Generic PLA"` and the JSON load path remaps the legacy short names to catalog equivalents for back-compat.

**Shipped:** commit `2a4b21c` — `OrcaProfileLoader.loadFilaments` + `mergedConfig` per-slot override path + dropdown wiring + `MergedConfigSlotTypesTest` (3 tests covering slot override, unknown-type fallback, empty-slotTypes legacy path).

### B4. Galaxy XR Controller bindings — face buttons 🟢 Shipped

> **Files:** `MainActivity.kt::onKeyDown`, `MainActivity.kt::XrShell` button collector LE, `ControllerInput.kt::buttons` SharedFlow, `TestController.GamepadButton` test command.

Input pump, Sliced-mode axis layer scrubbing, and Prepare-mode stick X/Y nudge + rotate were shipped earlier. The face-button collector now lives in the XrShell `LaunchedEffect(controllerInput)` block:

- **A** → contextual confirm (multi-model → `runSliceMulti`, single → `runSlice`, empty → bundled cube).
- **B** → contextual cancel (Preview → Prepare; otherwise no-op so system back still routes through the OS).
- **X** → Prepare ↔ Preview toggle, Toast hint when no slice exists yet.
- **Y** → toggle `showTravels`.
- All bindings gated `repeatCount == 0` at the Activity layer so holding a button doesn't auto-repeat toggles.
- `TestController.Command.GamepadButton(button)` shim drives `controllerInput.emitButton(button)` so a workstation harness can exercise every binding without paired hardware.

### B5. Galaxy XR Controller help card 🟢 Shipped

> **Files:** `ControllerHelpCard.kt` (data + Composable), `ControllerHelpTest.kt`, `UiPanels.kt::TopNavigationPill` (Help button), `MainActivity.kt` (helpShown state + SpatialPanel mount).

`ControllerHelp.entries` is a curated list of `Entry(input, action, note?)` rows covering every face button (A/B/X/Y) plus stick bindings for both Prepare and Preview modes. `ControllerHelpCard(onClose)` renders that list as a key/value list inside a SpatialPanel-friendly Compose surface; the TopNavigationPill grows a `?` Help button that toggles the panel via the new `helpShown` state in `XrShell`. Tests assert that every face button is documented, both stick modes appear, and a tripwire pins the entry count so a binding addition or removal forces an update to the help data.

**Shipped:** commit `aac69c2` — `ControllerHelp.entries` data layer, `ControllerHelpCard` Composable, top-nav Help icon, `ControllerHelpTest` (5 tests).

### B6. XR tooltip primitive 🟡 Partial — chip + popover shipped, gizmo/B2 reuse pending

> **Files:** `SpatialTooltip.kt` (`SettingHelpChip` + `TooltipState`), `SettingDescriptions.kt`, `SettingDescriptionsTest.kt`, `TooltipStateTest.kt`, `UiPanels.kt::SettingNumericEditor` (chip wired in beside the row label).

`SettingHelpChip(description)` renders a 20 dp circular `?` chip; tap toggles a Compose `Popup` showing the description on a `Color(0xFF2A2F33)` plate (max 320 dp wide, ~3 lines of body text). The popover auto-dismisses after 6 s so a stuck-open tooltip doesn't linger when the user's gaze drifts. Tap-to-toggle rather than pure hover because the laser cursor's ~1 cm hand-tracking jitter makes a hover-only trigger feel twitchy in XR; back-press and outside-tap also dismiss.

`SettingDescriptions.byKey` maps libslic3r config keys → 1-line descriptions sourced from OrcaSlicer's `PrintConfig.cpp` `tooltip()` strings (translated where applicable). 18 entries cover every key currently surfaced in Quality / Speed / Support tabs plus a handful pre-populated for adjacent keys (`sparse_infill_density`, `wall_loops`, `nozzle_temperature` …) so a Strength-tab buildout doesn't have to backfill.

**Pending — entry-criteria for the green flip:**
- Reuse on B1 gizmo handle labels and B2 mixed-filament settings rows. Today the chip is wired into `SettingNumericEditor` only — applying it broadly is gated on those features landing.
- True laser-hover (vs tap) trigger once XR's pointer-event reliability is good enough to swap out the tap interaction without trading legibility for jitter.

**Shipped:** commit `2d25680` — `SpatialTooltip` + `SettingDescriptions` + 12 unit tests (5 description coverage / convention / count + 7 TooltipState transitions). Wired into `SettingNumericEditor` so every documented Quality / Speed / Support row grows a `?` chip.

### B7. Empty-state guidance 🟢 Shipped

> **Files:** `RecentFilesStore.kt`, `RecentFilesCodecTest.kt`, `UiPanels.kt::EmptyStatePanel` + `RecentFileRow`, `MainActivity.kt::XrShell` (recents collection + empty-state mount + `onFileSelected` recents bump).

`EmptyStatePanel(recents, onPickFile, onSliceBundledCube, onOpenRecent)` is mounted when `placedModels.isEmpty() && !showFilePicker && !isLoadingModel`, so a fresh-install user lands on a floating CTA card instead of an empty bed. Three affordances: a prominent green "Import 3MF or STL" button, a secondary "Slice the bundled 20 mm cube" path that mirrors the controller-A empty-bed shortcut, and a "Recent" list of the last 12 successful loads tapped to open instantly. `RecentFilesStore` (DataStore Preferences, JSON-encoded) writes a new entry on every successful `onFileSelected` and is filtered through `validRecents` so deleted/unmounted paths don't surface as broken shortcuts. Re-opening the same file bumps it to the top instead of double-listing; the cap drops the oldest entry on overflow.

**Shipped:** commit `f00c60e` — `RecentFilesStore` + `RecentFilesCodec` (8 tests covering encode-decode round-trip / garbage input / blank-path drop / upsert-at-head / de-dupe-by-path / cap eviction / empty-singleton / JSON shape lock) + `EmptyStatePanel` + XrShell mount + `onFileSelected` recents bump.

### B8. Numeric input validation 🟢 Shipped

> **Files:** `NumericValidation.kt`, `NumericValidationTest.kt`, `UiPanels.kt::AxisFieldRow` + `TransformAxisSection` + `SettingNumericEditor` + `QualityTab` layer-height field.

`NumericValidation.validate(text, min, max)` returns `Ok(value) | NotANumber | OutOfRange(value, min, max)` — pure, unit-tested. TransformPanel pipes `Ranges.translateMm` (-500..500), `Ranges.rotateDeg` (-1080..1080), and `Ranges.scalePct` (1..2000) into Translate / Rotate / Scale via `AxisFieldRow`.

Print-settings tabs (Quality / Speed / Support) consult `NumericValidation.printSettingRanges` — a curated per-libslic3r-key range table (layer_height 0.04..1.5, all `*_speed` 0.1..1000, sparse_infill_density 0..100, support_threshold_angle 0..90, nozzle_temperature 100..400, etc.). `SettingNumericEditor` and the QualityTab layer-height TextField surface invalid input via `isError` red outline + a one-shot Toast on first out-of-range commit; keys absent from the table fall back to libslic3r's silent clamp (the legacy behavior).

**Tests:** 12 — parse, trim, blank, NaN/Infinity, both bounds, inclusive, transform-range sanity, print-setting key coverage (every Speed-tab key), layer_height typo guard (20 mm rejected), validate end-to-end on a print-setting range.

**Shipped:** commits `7fa3970` (TransformPanel) + `5a4328b` (Print Settings tabs).

### B9. Per-part selection & transform from multi-object archives 🟢 Shipped

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::nativeConvertToStl` (current single-STL flatten point — see below), new `nativeRead3mfObjectMetadata` + `nativeExtractObjectAsStl`, `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt` (import path), `PlacedModel.kt` (add `groupId: String?`, `groupOrdinal: Int`), `MainActivity.kt` (multi-object onFileSelected branch), `UiPanels.kt::PlacedModelsSection` (group header collapsing).

A multi-object 3MF (e.g. `passthroughboth.3mf` — `Inner.stl` + `Outer.stl`) currently lands as **one** `PlacedModel` because `nativeConvertToStl` (slic3r_jni.cpp:2585-2588) merges every object's mesh into a single STL before the Kotlin import path sees it. As a result the user can only select / transform / paint / assign-extruder the merged whole — exactly the gap reported on 2026-04-29 ("In OrcaSlicer I can select them individually, move them around, put them in different build plates"). `nativeWriteColoredGlb` (line 2043) already iterates the same archive's objects, so the per-object structure exists in libslic3r — it's only the import path that throws it away.

**Implementation outline:**
1. **JNI — enumerate without merging.** `nativeRead3mfObjectMetadata(path) -> Array<ObjectMeta>` returning per-object `(name, facetCount, bboxXYZ, defaultExtruder, instanceCount)`. Reads via `load_mesh_container` then walks `model.objects` without calling `merge`.
2. **JNI — per-object STL extraction.** `nativeExtractObjectAsStl(archive, objectIndex, outStlPath)` writes one `ModelObject::mesh()` to its own binary STL. Each PlacedModel gets its own preview/BVH/paint cache pinned to that STL — this keeps the existing per-PlacedModel paint cache (D1) and BedCollision (A6) paths working untouched.
3. **Kotlin import path.** When the loader sees `>1` object, instead of one PlacedModel from the merged STL it produces **N PlacedModels**, each with `objectIndex = i`, sharing a `groupId: String = sourceArchiveSha256`, and `groupOrdinal = i`. Single-object archives (the common case) still produce one PlacedModel — `groupId = null` — so the existing flat list code path is unchanged.
4. **PlacedModel data shape.** Add `val groupId: String? = null` and `val groupOrdinal: Int = 0`. No other field changes — selection bbox (commit `efc0430`), TransformPanel (commit `836d270`), paint cache (D1), gizmo (B1), BedCollision (A6) all keep working per-part for free.
5. **Slice path.** `runSliceMulti` already accepts N inputs with N transforms — just feed it the per-object extracted STLs with the per-PlacedModel transforms composed (group's collective offset + part's individual offset). No new JNI surface for slicing.
6. **UI grouping.** `PlacedModelsSection` grows a collapsible header per `groupId` (e.g. "passthroughboth.3mf — 2 parts") with a single chevron to expand/collapse the group's rows. A "Move group" affordance bulk-translates every part with the same `groupId`. Selection stays per-row (per-part).
7. **Save-as-3MF round-trip.** `nativeSaveAs3mf` packs all PlacedModels with the same `groupId` back as a multi-object archive — preserves the original archive structure on save.

**Why flat-with-`groupId` instead of a `PlacedModel { parts: List<PlacedPart> }` tree:** the tree shape is closer to upstream's `ModelObject`/`ModelVolume` hierarchy but every existing path (selection state, TransformPanel, paint cache, gizmo, BedCollision, slice dispatch) is keyed by single-PlacedModel today. Flat with groupId gets the user 90% of multi-part UX (independent selection, transform, paint, plate-assign) on a one-day diff; the tree shape is a v3 refactor we should only do if grouping operations start hurting.

**Exit criteria:**
- Loading `passthroughboth.3mf` produces 2 PlacedModels (`Inner.stl` and `Outer.stl`), each independently selectable, transformable, and paintable.
- Each part's TransformPanel edits don't disturb the other.
- Slicing produces a single G-code that reproduces both parts at their per-part transforms.
- A round-trip save-as-3MF reopened in desktop OrcaSlicer shows two objects with the OrcaXR-authored offsets preserved.
- Single-object .stl / .obj / single-object .3mf imports continue to produce one PlacedModel (no regression in the common case).

**Shipped:** 3364b9c — Multi-object 3MFs extracted to separate STLs, grouped by groupId with collapsible headers.

**Dependency for E3 multi-plate:** B9 is the prerequisite — without per-part addressability there's nothing to assign to a different plate.

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

**Tests:** `PaintCacheStoreTest` covers round-trip, tri-count mismatch, missing-file, blank-array prune, null-array prune, LRU eviction at the cap boundary, hash stability, content-divergent hashes, corrupt-file fallback, `Entry.equals`, and `sizeBytes` growth + clear.

**Shipped:** commit `c913e4e` — `PaintCacheStore` + on-load restore + on-mutate save + 10 tests. Follow-up commit `e8133db` — `PaintCacheStore.sizeBytes()`, "Storage" section in `ControllerHelpCard` showing cache size + entry count + Clear button (Toast on clear, helpVersion bump so the row refreshes immediately), `formatBytes` helper + 1 unit test, +1 PaintCacheStore unit test for the new `sizeBytes` method.

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

### E3. Multi-plate workspace 🟢 Shipped

> **Files:** `PlacedModel.kt` (add `plateId: Int = 1`), `MainActivity.kt::XrShell` (`activePlateId` state), new `app/src/main/java/dev/orcaxr/app/PlateStore.kt`, `UiPanels.kt` (plate-tab strip + "Move to plate N" context action), `SlicerEngine.kt` (per-plate slice dispatch).

**Shipped:** 3364b9c — Persistent virtual build plates with switching UI and per-plate slicing/arrangement.


User asked on 2026-04-29 to "put parts in different build plates" while working with `passthroughboth.3mf`. Re-scoped from the previous "wait for queue demand" deferral. Snapmaker U1 + Elegoo Centauri Carbon both run **one plate at a time** physically, so we DO NOT need to port upstream's `PartPlate.cpp` / `PartPlate.hpp` (multi-thousand lines, plate-switching mid-print, plate-aware G-code orchestration). What the user actually wants is the OrcaSlicer organization affordance — virtual plates as a workspace partition for slicing several jobs from one project — which is far cheaper.

**Implementation outline (cheap virtual-plate path):**
1. **Data.** `PlacedModel.plateId: Int = 1`. New `PlateStore` (DataStore Preferences) holds plate metadata (`id`, `label`, `createdAt`); plate 1 is auto-created on first launch and is undeletable.
2. **Active-plate state.** `XrShell` holds `activePlateId: Int`. All renderers (workspace GLB, BedCollision banner, TransformPanel target, gizmo) consume `placedModels.filter { it.plateId == activePlateId }`. Models on inactive plates render NOT AT ALL (no ghosting — keeps the bed visually unambiguous).
3. **Plate tab strip.** Right-edge SpatialPanel with one chip per plate (label + part count badge) plus a `+` chip that allocates a new plate and switches to it. Long-press a plate chip → rename / delete (delete blocks if plate has parts; user must move them off first).
4. **"Move to plate" action.** A row-level context action in `PlacedModelsSection` ("Move to ▾" → submenu of plates). For B9-grouped parts, "Move group to plate N" moves all parts sharing the `groupId`.
5. **Per-plate slice dispatch.** Slice button slices the active plate (current behavior preserved when there's only plate 1). New "Slice all plates" affordance (only visible with `plateCount > 1`) loops over plates running `runSliceMulti` per plate, produces N G-code files surfaced as a list with per-plate filament-usage / time totals.
6. **Send-to-printer.** Sequential — user picks one plate's G-code at a time and sends. Queueing multiple plates to Moonraker is a follow-up that re-enters C1 (Print queue) scope; until then the multi-plate workflow is "slice all → send plate 1 → wait → send plate 2."
7. **Save-as-3MF.** Per-PlacedModel `plateId` is written into project metadata so reopened-in-OrcaXR projects keep their plate assignments. Desktop OrcaSlicer ignores OrcaXR's plateId namespace; round-trip lossy on the desktop side (acceptable — desktop has its own PartPlate concept which we're deliberately not modeling).

**Why virtual plates instead of the full upstream `PartPlate`:**
- Both target printers print one plate at a time. The complex parts of `PartPlate` (plate-aware tool ordering, mid-print plate-change G-code, build-plate thumbnails per plate) buy nothing on this hardware.
- The user's actual ask is workspace organization — "I'm prepping three different prints from one project," not "I'm queueing a multi-plate job."
- Cheap to revert if upstream behavior is later needed: `plateId: Int` on PlacedModel is forward-compatible with mapping to `libslic3r::PartPlate` instances later.

**Exit criteria:**
- A user can create plate 2, move `Outer.stl` from plate 1 to plate 2, and slice both plates independently. Each plate's slice produces a G-code that contains only that plate's parts at their per-part transforms.
- Switching `activePlateId` between 1 and 2 swaps the rendered models without disturbing transforms or paint state.
- Re-opening a saved 3MF preserves plate assignments.
- Single-plate users see no UI change (plate strip stays collapsed when `plateCount == 1`).

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

### F2. Branded U1 filament leaves 🟡 Partial — PLA family vendored, ABS/PETG/exotic still pending

> Snapmaker fork ships ~58 branded leaves; OrcaXR now ships Generic PLA + Generic ABS + Generic PETG + Snapmaker PLA + Snapmaker PLA Matte + Snapmaker PLA Eco + Snapmaker PLA Silk + Snapmaker PLA Metal + Snapmaker PLA-CF + Elegoo PLA Matte + Elegoo PLA-CF.

Branded leaves cover PLA HF / PLA Eco / PLA Metal / PLA Silk / PETG HF / PETG-CF / PETG-GF / ASA / PA-CF / PCTG / PVA / BVOH / PC / TPU / TPU 95A HF / Breakaway Support + Polymaker/PolyLite/PolyTerra third-party. APK cost <100 KB; UX cost is picker clutter.

**Implementation:** stage-roll. PLA family landed first; ABS/PETG branded next, exotic (PA/PC/TPU) last. Ship a nozzle filter chip in the picker if clutter becomes a complaint.

**Pending — entry-criteria for the green flip:**
- Snapmaker-branded ABS / PETG / ASA U1 leaves (and the parents in their inheritance chains).
- Exotic-material leaves (PA-CF, PC, TPU 95A HF) once F5's `filament_is_high_temperature` flag has a real consumer.
- Snapmaker Breakaway Support For PLA — gated on resolving the Snapmaker J1 PVA parent chain it inherits from.

**Shipped (PLA family slice):** commit `cf54495` — vendored 15 JSONs into `app/src/main/assets/profiles/Snapmaker/filament/`: 6 instantiable U1 leaves (PLA / Matte / Eco / Silk / Metal / PLA-CF) + 6 `@U1 base` parents + 3 root parents (`fdm_filament_common`, `fdm_filament_pla`, `fdm_filament_pla_eco`). NOTICE.md attribution updated. `SnapmakerPlaCatalogTest` (5 tests) covers leaf-instantiability, Matte's tuned 220 °C `nozzle_temperature`, PLA-CF's hotter override, Eco's deep-chain `filament_flow_ratio` resolution, and a tripwire that fails if any vendored leaf's `inherits` points at a missing parent. With B3's `loadFilaments` already shipped, the new leaves auto-discover into the per-slot dropdown.

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
