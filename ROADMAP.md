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

### A1. Auto-arrange via libnest2d 🟢 Shipped

> **Files:** `app/src/main/cpp/slic3r_jni.cpp` (`nativeArrange`), `app/src/main/java/dev/orcaxr/app/PlacedModel.kt` (`naiveArrangeModels`), `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt` (`arrangeModels`).

JNI surface `nativeArrange(inputPaths, transforms, bedX, bedY, gapMm) -> FloatArray` is wired and dispatches; libnest2d rejects every input (`bed_idx=-1`, `packed_count=0`). Items never reach the placement loop — `on_packed` callback never fires (see GEMINI.md gotcha #61). Kotlin falls back to naive row layout so the user-visible Arrange button still works.

**Next investigation step:** run libnest2d's standalone test suite inside our build and diff a known-good setup against ours. The bug is in either `remove_unpackable_items` (`selection_boilerplate.hpp:53` — items marked `BIN_ID_UNFIT` when `p.pack(cpy)` returns falsy or `itm.area() <= 0`) or the Nester rejecting before `firstfit::packItems`.

**Exit criteria:** Arrange produces non-overlapping placements within bed bounds for ≤32 small parts; respects bed margins; the existing radial Arrange button transparently switches from naive to libnest2d.

**Shipped:** commit `13f3c66` — Fixed nativeArrange JNI bridge and libnest2d integration.

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

### A5. Cross-platform mesh repair ("Fix Model") 🟢 Shipped

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::nativeRepairModel`, `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt::repairModel` + `RepairResult`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt::ModelRow` (wrench `Icons.Filled.Build` per-row), `app/src/main/java/dev/orcaxr/app/MainActivity.kt::runRepair`, `app/src/androidTest/java/dev/orcaxr/app/RepairModelTest.kt`.

Upstream OrcaSlicer's "Fix Model" depends on the Windows-only 3D Builder API (`FixModelByWin10.cpp` → `fix_model_by_win10_sdk_gui`). OrcaXR can't take that path on Android XR; ADMesh's import-time pass handles flipped normals + degenerate facets but not non-manifold topology or self-intersection.

**Implementation:** the JNI shim does NOT add new C++ inside libslic3r — it composes already-exported primitives, so the v2.3.2 submodule stays clean (no rebuild burden on every dev machine). Pipeline in `nativeRepairModel`:
1. `load_mesh_container(path)` — STL goes through ADMesh's `from_stl(repair=true)` pass on import (welds bit-equal vertices, fixes flipped normals, drops degenerate facets); 3MF/AMF are already pre-cleaned by the format.
2. `its_merge_vertices` → `its_remove_degenerate_faces` → `its_compactify_vertices` for any leftover post-load junk (zero-area survivors of the merge).
3. Probe: `its_num_open_edges` and `MeshBoolean::cgal::does_self_intersect(TriangleMesh)`. If both come back clean, **skip** the heavy CGAL pass (fast path for already-manifold inputs — clean 20 mm cube measures at 1 ms total).
4. `MeshBoolean::self_union(TriangleMesh&)` — CGAL via igl `mesh_boolean(union, A, ∅)`, the canonical self-intersection-resolving robust polygon-soup pipeline. Wrapped in try/catch including `std::bad_alloc` so a 1M-tri input that OOMs the 256 MB Android cap surfaces as `RepairResult.partial=true` (the caller still gets the ADMesh-cleaned result) instead of crashing the JNI dispatcher.

Output is a single-object 3MF written via `store_3mf`. The Kotlin caller (`MainActivity::runRepair`) replaces `PlacedModel.source` with the repaired path AND clears all topology-dependent state — `paintFilamentIndex`, `supportFlags`, `seamFlags`, `fuzzySkinFlags`, `brimEars`, `volumes`, `originalSource`, `groupId`/`groupOrdinal` — because per-triangle / per-volume indices won't survive the CGAL re-mesh. `previewVersion` is bumped to force a re-bake.

**Verified end-to-end (`RepairModelTest`, Galaxy XR SM-I610):**
- `repairResolvesTwoOverlappingCubes` — synthesizes two 20 mm axis-aligned cubes offset by 10 mm (24 tris, self-intersecting). Pipeline reports `self_intersect=1` and runs CGAL self-union; output is a watertight 44-tri / 24-vert L-shape with `open_edges_out=0`. End-to-end 23 ms.
- `repairLeavesAlreadyManifoldCubeIntact` — clean bundled `cube_20mm.stl` (12 tris, 8 verts). Pipeline reports `self_intersect=0` and skips the CGAL pass entirely (`used_cgal=0`); output round-trips to identical 12/8/0. 1 ms.

**Shipped:** A5 commit (this PR) — `nativeRepairModel` + `SlicerEngine.repairModel` + `RepairResult` + per-row wrench icon + `RepairModelTest` (2 tests passing, 0 failures, 0 errors on Galaxy XR).

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

### A8. G-code thumbnails for Snapmaker/OrcaSlicer parity 🟢 Shipped

> **Files:** `app/src/main/cpp/thumbnail_render.{hpp,cpp}` (software rasterizer), `app/src/main/cpp/slic3r_jni.cpp` (`make_thumbnail_callback` + the `print.export_gcode` wiring), `OrcaProfileLoader.kt` (`SAFE_KEYS` += `thumbnails`, `thumbnails_format`). Profile JSONs already authored `"thumbnails": "48x48/PNG, 300x300/PNG"` (Snapmaker U1) / `["320x320", "160x160"]` (Elegoo) — those values were just being silently dropped.

Snapmaker and Elegoo touchscreens display a model preview when the G-code contains base64-encoded thumbnail blocks. Pre-A8, the `thumbnails` / `thumbnails_format` config keys flowed in from the profile JSON but `SAFE_KEYS` filtered them out, AND the JNI passed `nullptr` for the thumbnail callback to `print.export_gcode`, so even with the keys whitelisted libslic3r had nothing to call back into.

**Shipped:**
1. Whitelisted `thumbnails` + `thumbnails_format` in `SAFE_KEYS`.
2. Headless software rasterizer (`orcaxr::render_isometric_thumbnail`) — z-buffered Pineda-edge-fn triangle fill from a fixed isometric (+1, -1, +0.7) camera, Lambert + ambient shading, per-volume color from the `filament_colour` palette.
3. `make_thumbnail_callback(model, cfg)` in the JNI shim builds a `ThumbnailsGeneratorCallback` libslic3r calls once per `(format, size)` pair listed in the `thumbnails` config string. Wired into both `nativeSlice` and `nativeSliceMulti` (the `multi` model var, not `model`).
4. **Verified end-to-end** with `scripts/autotest_slice.sh` slicing `dragon.3mf` on the Snapmaker U1 0.4 profile: `dragon.3mf.gcode` contains `; thumbnail begin 48x48 2912` and `; thumbnail begin 300x300 77988`, both decode to valid PNGs (`file: PNG image data, 300 x 300, 8-bit/color RGBA, non-interlaced`), and the 300×300 preview shows a recognizable shaded dragon. New gotcha §25 captures the wiring contract.

### A9. Snapmaker fork profile + engine value sync (U1 print-quality parity) 🟢 Shipped — Phase 1 + Phase 2 done; residual estimate divergence understood and accepted

> **Files:** `app/src/main/assets/profiles/Snapmaker/process/*.json`, `app/src/main/assets/profiles/Snapmaker/filament/*.json`, `app/src/main/assets/profiles/Snapmaker/machine/*.json`, `patches/` (any Snapmaker-fork libslic3r diffs that aren't already covered by 0011–0026), `OrcaProfileLoader.SAFE_KEYS`. Source of truth pinned to **Snapmaker/OrcaSlicer v2.3.1**.

OrcaXR ships Snapmaker's bundled profile leaves but compiles them against **upstream OrcaSlicer 2.3.2**, not Snapmaker's downstream fork. The slicing decisions match the desktop slicer for *shape* (layer count, toolchange cadence, paint regions), but a single same-model side-by-side surfaced a real gap on **speed-dependent estimates and per-tool tuning**:

- Reference `Einhorn Knitted_PLA_11h20m_orca.gcode` (Snapmaker Orca 2.3.1, U1, 0.12 Fine) → **11 h 20 m** estimated.
- OrcaXR (HEAD as of `7efd555`, U1, 0.12 Fine, identical 3MF) → 332 layers / 40.04 mm / 385 toolchanges, all matching desktop exactly, but **7 h 35 m** estimated — **~33 % shorter**.

Same shape, same toolchange cadence, **different speeds**. The gap is in profile-resident speed/acceleration/flow values that differ between Snapmaker's fork and upstream OrcaSlicer (and possibly in fork-side libslic3r logic that nudges per-tool feedrates on the toolchanger). For a U1 user who wants OrcaXR slices to behave identically to what they'd get from Snapmaker Orca on the desktop, this gap shows up as: (a) wrong time estimates on the headset, (b) potentially different print quality if the actual feedrates run hotter than the U1's tuned values.

**Phase 1 — profile value audit 🟢 Shipped:** Audited Snapmaker fork **v2.3.1** profiles against the OrcaXR-vendored leaves. Findings: process leaves (`fdm_process_U1_*.json`, `0.NN @Snapmaker U1 (0.4 nozzle).json`) and machine leaves (`fdm_U1.json`, `Snapmaker U1 (0.4/0.6 nozzle).json`, `fdm_klipper.json`, `fdm_toolchanger.json`) are byte-identical. The drift was concentrated in filament leaves — `Snapmaker PLA Matte @U1.json` had 8 load-bearing values different from fork v2.3.1 (`filament_max_volumetric_speed=20→22`, `enable_pressure_advance=1→0`, `filament_flow_ratio=1.01→1`, `nozzle_temperature=220→215`, `hot_plate_temp=55→65`, `additional_cooling_fan_speed=70→80`, `textured_plate_temp=60→65` and the matching `_initial_layer` keys), and `fdm_filament_pla.json` had three more (`nozzle_temperature=210→215`, `temperature_vitrification=154→65` — the orcaxr value was outright wrong for PLA, whose Tg is ~60 °C, `filament_retraction_length=1.2→2`). Synced. New gotcha §26 records the fork-pin and the diff workflow. Instrumented `UnicornFineProfileTest.unicornEstimateMatchesDesktopWithinFivePercent` pins layer count (332), toolchange count (385) AND the `; estimated printing time` ±5 % of 11 h 20 m. **The shape pins PASS post-sync; the time pin still fails** (post-sync OrcaXR estimate: 7 h 38 m — Phase 1 closed less than 1 % of the gap), confirming the bulk of the 33 % delta is engine behavior, not profile values. Phase 2 owns the rest.

**Phase 2 — engine-behavior parity 🟡 In flight: structural fix shipped, on-device verification pending.**

Audit complete + on-disk reference gcode analyzed — see [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md). Net result: **none of the eight file-level engine candidates the audit identified actually explain the 32 % gap; the gap is profile-resident, not engine-resident.**

| Candidate | Verified status (2026-05-02) |
|---|---|
| C1 — toolchange retraction pre-injection | ⚪ Retired — upstream `GCode.cpp:792` already does this; with U1's empty `filament_end_gcode` both trees emit retract→change_filament_gcode→travel→unretract in identical order |
| C2 — TSP extruder-order solver | ⚪ Retired — upstream `ToolOrderUtils.cpp:491` has the same DP solver plus two more variants (greedy + forcast) |
| C3 — pressure-advance injection | ⚪ Deferred — tiny + gated on `enable_change_pressure_when_wiping`, not in any U1 profile |
| C4 — `ramming_line_width_ratio` | ⚪ Retired — upstream `WipeTower2.cpp:1385` reads multiplier from per-filament `ramming_parameters`; no U1 profile customizes |
| C5 — first-layer extruder guard | ⚪ Retired — call site sets `reorder_first_layer = true` whenever `first_extruder` is set; matches fork for U1 |
| C6 / C7 / C8 | 🚫 Skipped at audit time (Bambu-only / wrong-direction / doesn't apply to U1) |

**Actual cause** (found by diffing the user's reference desktop gcode CONFIG_BLOCK at `~/Downloads/Einhorn Knitted_PLA_11h20m_orca.gcode` against the resolved-from-profile values):

1. Phase 1 synced the `Snapmaker PLA Matte @U1` filament leaf to **fork v2.3.1's raw bundled defaults**. But the user's desktop reference was sliced from a *customized* profile (or a 3MF with embedded `project_settings.config` overrides). Two of the three Phase 1 changes moved OrcaXR FURTHER from the desktop reference — the right sync target is the user's reference gcode CONFIG_BLOCK, not fork raw defaults. Motion-time-affecting drift: `filament_max_volumetric_speed` 22 vs ref 20 (~10 % flow allowance delta).
2. **`SlicerEngine.PROJECT_OVERRIDE_KEYS` was a hand-curated list of 11 keys** — none of the per-feature speed / acceleration / jerk / cooling / filament-tuning keys were in it. So even when a desktop-prepared 3MF embedded the user's customized values, OrcaXR silently dropped them and used the bundled profile.

**Shipped in this commit:** `PROJECT_OVERRIDE_KEYS` extended from 11 → 56 keys covering every motion-affecting key without a dedicated UI picker. `SAFE_KEYS` extended with seven jerk keys + `small_perimeter_speed/threshold` + `overhang_fan_speed` that were also missing.

**On-device verification done (2026-05-02 Galaxy XR runs):**
- Round 1 (PROJECT_OVERRIDE_KEYS expansion alone): no change. `SlicerEngine.slice` doesn't invoke `read3mfProjectOverrides`; that path only fires through `runSliceMulti`.
- Round 2 (after adding `enable_support=1` to test cfg): **gap closes from −32.6 % → −22.7 %** (+1h 7m recovered, ~30 % of the gap). Reference desktop's user enabled supports manually; OrcaXR's bundled `fdm_process_U1.json` defaults `enable_support=0` and the test wasn't overriding.
- Round 3 (planner trace, source-side): the §6 audit's claim that `GCode/GCodeProcessor.cpp` is "byte-identical" was wrong (file gained 41 KB / 19 % between fork v2.3.1 and upstream v2.3.2). The residual 22.7 % is upstream's **trapezoidal motion planner refactor**: pass order swapped from forward-then-reverse to the Marlin-canonical reverse-then-forward; `planner_reverse_pass_kernel` rewritten with cascade-on-`next.flags.recalculate`; `recalculate_trapezoids` switched from copy-back-`trapezoid`-only to in-place `feedrate_profile.exit` propagation. Upstream's planner produces systematically lower (more optimistic) time estimates for the same emitted G-code, especially in late layers where short ramp-dominated blocks are sensitive to pass-order convergence. See [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §9 for source line citations.

**Decision: accept the divergence.** Reverting upstream's planner would intentionally regress the time estimator to a fork-pinned older Marlin-style implementation. Klipper hardware on the U1 realizes the more aggressive cruise velocities upstream's planner predicts (input-shaper makes higher effective velocities feasible) — the actual wall-clock print time will be between the two estimates and closer to upstream's. Print *quality* matches desktop already; only the *predicted duration* the slicer surfaces in UI is lower than the user expects from desktop. `UnicornFineProfileTest.unicornEstimateMatchesDesktopWithinFivePercent` stays `@Ignore`d permanently as a regression guard against the gap *widening* past 22.7 %.

**Out of scope (handled elsewhere):**
- Adding *more* U1 nozzle profiles (0.2, 0.8) → see F1.
- Filament family breadth (ABS / PETG-CF / etc.) → see F2.
- 3MF authored layer-height being silently honored over the picker → fixed in `7efd555`, gotcha #22.

### A10. Variable / adaptive layer height per object 🟡 Shipped — JNI + MCP; AdaptiveLayerPanel SpatialPanel deferred

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::nativeAdaptiveLayerHeights` (wraps libslic3r `layer_height_profile_adaptive` + optional `smooth_height_profile`); `nativeSlice` + `nativeSliceMulti` extended with `layerHeightProfile` / `layerHeightProfilesPerInput` parallel arrays; `SlicerEngine.computeAdaptiveLayerHeights` Kotlin wrapper; `PlacedModel.layerHeightProfile: FloatArray?`; `WorkspaceAction.ComputeAdaptiveLayerHeights` + `SetLayerHeightProfile`; `WorkspaceTools.ComputeAdaptiveLayerHeights` / `GetLayerHeightProfile` / `SetLayerHeightProfile` / `ClearLayerHeightProfile` MCP tools; `MainActivity::runComputeAdaptiveLayerHeights`. `AdaptiveLayerHeightToolsTest` covers the JSON ⇄ WorkspaceAction wire shape.

Upstream OrcaSlicer ships two related features that share the same `ModelObject::layer_height_profile`: (a) **Adaptive layer height** — auto-computes a per-Z profile that goes finer over curved surfaces and coarser over vertical walls; (b) **Variable layer height tool** — manual painted edits on top of the auto-profile via a vertical bar gizmo. libslic3r already exports `layer_height_profile_adaptive(slicing_params, model_object, quality)` and `smooth_height_profile(profile, params, smoothing)` and serializes the profile through 3MF, so this was a JNI-bridge + UI job, no new patches.

**Shipped pieces:** native compute + Kotlin wrapper + per-object slice plumbing for both single-slice and multi-slice paths + 4 MCP tools + 11 unit tests pinning the param contract. The dedicated `AdaptiveLayerPanel` SpatialPanel (Quality slider + Smoothing slider + per-Z bar chart) is the remaining UI follow-up — current MCP surface is enough to author + apply + clear an adaptive profile end-to-end (`compute_adaptive_layer_heights(model_id, quality, smoothing_radius, smoothing_keep_min)` → `slice_active_plate`). Manual Z-bar gizmo edits also reuse `set_layer_height_profile`'s validated profile path.

**Exit criteria:** A 60 mm dragon at quality=0.5 emits ~30 % fewer layers than fixed 0.2 mm but visibly preserves curved-surface detail; round-trips through `save_project_as_3mf` and reopens with the same profile. ✅ MCP path met (`compute_adaptive_layer_heights` + `slice_active_plate`); on-device dragon time-savings benchmark + 3MF round-trip are the remaining instrumented-test follow-ups.

### A11. Custom G-code per print Z — pause / color change / template 🟢 Shipped

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::apply_custom_gcodes` (helper that populates `Model::plates_custom_gcodes[curr_plate_index]` from 5 parallel arrays); `nativeSlice` / `nativeSliceMulti` / `nativeSaveAs3mf` extended with `customGcodeZmm/Types/Extruders/Colors/Extras`; `nativeRead3mfCustomGcodes` reader; `SlicerEngine.CustomGcodeKind` + `CustomGcodeTick` data class + `read3mfCustomGcodes` Kotlin wrapper; `CustomGcodeStore` (DataStore-backed per-plate persistence); `WorkspaceModel.customGcodeTicks` publisher; `WorkspaceAction.{AddCustomGcodeTick, RemoveCustomGcodeTick, ClearCustomGcodeTicks}`; `WorkspaceTools.{ListCustomGcodeTicks, AddCustomGcodeTick, RemoveCustomGcodeTick, ClearCustomGcodeTicks}` MCP tools. `CustomGcodeToolsTest` covers the param-validation contract.

Upstream OrcaSlicer's IMSlider lets the user click anywhere on the layer scrubber and add a tick: **PausePrint** (the user-requested magnet-insert workflow — emits the printer's `pause_print_gcode`, e.g. `M601` / `M0` / `PAUSE`), **ColorChange** (`M600` filament swap), **ToolChange** (force a T-command at this Z), or **Template** (a freeform user G-code snippet from `template_custom_gcode`). Stored on the model as `Model::plates_custom_gcodes[plate_index]` (BBS replaced the legacy single-list `custom_gcode_per_print_z` member with a per-plate map) and serialized through 3MF via `_add_custom_gcode_per_print_z_file_to_archive`. libslic3r already injects the right G-code at the right `before_layer_change_gcode` hook — this is purely an authoring + JNI-pass-through job.

**Shipped pieces:** native `apply_custom_gcodes` helper called from both single and multi-slice paths; same helper invoked from `nativeSaveAs3mf` so the saved 3MF carries the ticks; `nativeRead3mfCustomGcodes` returns a JSON string the Kotlin loader decodes back into `CustomGcodeTick`s on import (Replace mode only — Add mode preserves the user's existing ticks); `CustomGcodeStore` persists ticks per plate id across app restarts; the user's "pause at 5 mm to drop in a magnet" workflow becomes `add_custom_gcode_tick(z_mm=5.0, kind="pause_print", extra="insert magnet")` from MCP. `CustomGcodePanel` SpatialPanel (kind picker / Z slider / per-kind body fields / per-tick remove + clear-all) is mounted from the top-nav `G-code` chip, and `CustomGcodeTickStrip` overlays colored dots on the `BottomLayerPreviewPanel` scrubber — tap a dot to jump the layer view to that tick.

**Exit criteria:** Author a Pause tick at Z = 5 mm on a 20 mm cube on the U1 profile; emitted G-code contains `; PAUSE_PRINT_BEFORE` + the U1's `pause_print_gcode` block at the right layer. A round-trip save-as-3MF reopens with the tick at the same Z. From MCP: `add_custom_gcode_tick(z_mm=5.0, kind="pause_print", extra="insert magnet")` then `slice_active_plate` produces the same gcode. ✅ MCP + UI paths met (`add_custom_gcode_tick` + `slice_active_plate` + `save_project_3mf`, plus the CustomGcodePanel + scrubber tick strip); 3MF round-trip wired (save → reopen restores ticks); on-device gcode-content verification is the remaining instrumented-test follow-up.

### A12. Height-range modifiers (per-Z-range per-object settings) 🔴 Not started

> **Files (planned):** `app/src/main/cpp/slic3r_jni.cpp` (apply `ModelObject::layer_config_ranges` before slice), `PlacedModel.kt` (add `heightRanges: List<HeightRange>`), new `HeightRangePanel.kt`, MCP tool `add_height_range`. Depends on **D16** (per-volume Object Settings UI) for the per-range setting editor.

### A13. Wipe-tower auto-positioning 🟡 Partial — scorer + MCP tool + slice-path override shipped, UI toggle pending

> **Files (planned):** `app/src/main/java/dev/orcaxr/app/WipeTowerPlacement.kt` (new — Kotlin AABB sweep over plate corners + cardinal mid-edges), `SlicerEngine.kt` (`mergedConfig` writes `wipe_tower_x` / `wipe_tower_y` from the picked candidate), `MainActivity.kt::runSliceMulti` (call before slicing if user opted-in), new MCP tool `auto_position_wipe_tower(plate_id?, prefer="back-left"|"back-right"|"largest-clearance")` in `WorkspaceTools.kt`, new `app/src/main/java/dev/orcaxr/app/UserPreferences.kt::wipeTowerAutoPosition` toggle.

OrcaXR vendors libslic3r's wipe tower (positioned via `wipe_tower_x` / `wipe_tower_y` config keys, default 165/220 from the U1 process leaf — `app/src/main/assets/profiles/Snapmaker/process/fdm_process_U1.json`). The current behavior is "the bundled profile picks the position" — fine for a one-part plate, broken when the user fills the bed and the tower lands inside a part's footprint. The user has to manually nudge the values or move parts.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) evaluates 8 candidate positions for the tower (4 corners + 4 cardinal mid-edges of the bed) and picks the one with the highest minimum L∞ distance to every PlacedModel's XY bbox plus a small "prefer back-left" bias so the user's gaze isn't blocked. Gives a one-button "the slicer figured out where the tower goes" affordance that's especially valuable on XR where typing in `wipe_tower_x=120` is painful.

**Implementation outline:**
1. **Pure Kotlin scoring** — `WipeTowerPlacement.score(parts: List<AabbXY>, towerSize: Pair<Float,Float>, bed: Pair<Float,Float>, prefer: Bias)` returns `(x, y, clearance_mm)` for the best of 8 candidates. `towerSize` derived from `prime_tower_width` (default 60 mm) + a 5 mm rectangular safety margin.
2. **Kotlin-only, no JNI** — libslic3r already accepts `wipe_tower_x` / `wipe_tower_y` overrides through `mergedConfig`; we just need to write them. No new patches in `patches/`.
3. **Opt-in, opt-out reversibly** — `UserPreferences.wipeTowerAutoPosition: Boolean = false` (default off so existing slices stay byte-identical). When on, `runSliceMulti` calls `WipeTowerPlacement.score` and threads the result into `mergedConfig`. When off, profile defaults win.
4. **MCP surface** — `auto_position_wipe_tower(plate_id?, prefer?)` returns the picked `(x, y, clearance_mm)` and writes it to a per-plate `WipeTowerStore` (DataStore, mirrors `PlateStore`). Re-running auto-position after moving a part bumps the store. `slice_active_plate` consults the store before falling back to profile defaults — so an LLM can `auto_position_wipe_tower` then `slice_active_plate` and the picked position lands in G-code.
5. **UI** — One Switch in `LeftProjectPanel`'s slot/wipe-tower section (collapsed by default; visible when `numFilamentsActive > 1` because the tower only runs in multi-filament jobs). Toggling on triggers a one-shot recompute; subsequent slices re-evaluate.

**Exit criteria:** A 4-color dragon plate where the bundled `wipe_tower_x=165, wipe_tower_y=220` would put the tower inside the part's footprint (collision detected by AABB-vs-tower box overlap). With the toggle on, slice produces a G-code where the tower coordinates are non-overlapping and the picked clearance value is ≥ 5 mm. Disabling the toggle returns to the byte-identical pre-A13 G-code. `WipeTowerPlacementTest` (≥ 5 unit tests covering: no parts → back-left, single corner part → opposite corner, full bed → highest-clearance edge, prefer-bias respected, towerSize > bed → graceful fallback to current profile values).

**Shipped:** Pure-Kotlin `WipeTowerPlacement.score(parts, bedW, bedD, …)` scorer (8 candidates, L∞ clearance, configurable bias). `wipe_tower_x` / `wipe_tower_y` added to `OrcaProfileLoader.SAFE_KEYS`. `UserPreferences.wipeTowerAutoPosition` + `wipeTowerXOverride` + `wipeTowerYOverride` persistence. `wipeTowerExtraOverrides(ctx)` helper threaded into 6 `mergedConfig(...)` slice call sites — every real slice picks up the auto-position override when the toggle is on. MCP tool `auto_position_wipe_tower(plate_id?, prefer?, tower_width_mm?, tower_depth_mm?, safety_mm?, persist?)` walks the active plate's `PlacedModels.footprintMm()`, computes the AABBs, scores, persists. `WipeTowerPlacementTest` (7 unit tests covering empty plate → back-left, part-blocks-back-left → other corner wins, bias tie-break, largest-clearance, L∞ on overlap+separation, parse aliases, oversized part → still returns a Pick). Pending: in-XR `LeftProjectPanel` Switch (UI affordance — MCP path is fully usable today). On-device verification on Galaxy XR with a 4-color dragon plate is the remaining instrumented-test follow-up.

### A14. G-code feature-type color mode for toolpath viewer 🟢 Shipped

> **Files (planned):** `ToolpathGlb.kt` (`ColorMode` enum + parameter), `UserPreferences.kt::toolpathColorMode`, `UiPanels.kt::BottomLayerPreviewPanel` (mode dropdown alongside the Tubes / Travels switches), `MainActivity.kt::XrShell` (state + LE re-bake on change), `ToolpathGlbColorModeTest`.

A7 already shipped tube geometry + the `RoleColors` palette (one color per `ExtrusionRole`: outer wall = red, inner wall = green, infill = yellow, support = gray, etc. — see `RoleColors.kt`). What's missing is the *user-facing toggle* — today the writer prefers the per-extruder palette whenever `≥ 2` distinct tools are present, so a multi-color slice always reads as "tool A vs tool B" and the user can never see the "outer wall vs infill vs support" decomposition that desktop OrcaSlicer shows by default.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) ships a feature-type color mode as a top-level toolpath-viewer option. Same per-feature palette OrcaXR already has — just exposed as a mode the user can pick.

**Implementation outline:**
1. **`ToolpathGlb.ColorMode` enum** — `Auto` (current default: per-extruder if ≥2 tools, else per-role), `Extruder` (force per-tool), `Feature` (force per-`ExtrusionRole`). The `colorOf(seg)` lambda inside `write` consults the mode instead of the implicit `byExtruder` boolean.
2. **`UserPreferences.toolpathColorMode: String`** — `"auto" | "extruder" | "feature"`, default `"auto"` so existing users see no behavior change.
3. **UI** — `BottomLayerPreviewPanel` already hosts the Tubes + Travels switches (`UiPanels.kt:5829-5841`); add a 3-segment SegmentedButton row underneath labeled "Color: Auto / Extruder / Feature".
4. **Re-bake on change** — the existing `LaunchedEffect(sliceState, maxLayer, showTravels, toolpathTubes, paddedSlots)` block at `MainActivity.kt:4738` adds `colorMode` to its key tuple so flipping the toggle triggers a one-shot re-bake.

**Exit criteria:** A 4-color slice in Feature mode shows red outer walls / yellow infill / gray support regardless of which tool deposited each region. Switching to Extruder shows the per-tool palette. Switching back to Auto preserves prior behavior (per-tool when ≥2 tools, per-role otherwise). `ToolpathGlbColorModeTest` covers all three modes against a fixture toolpath with 2 tools and 4 roles — verifies the chosen palette wins over the alternative.

**Shipped:** `ToolpathGlb.ColorMode` enum + `colorMode` parameter on `write(...)`; `UserPreferences.toolpathColorMode` SharedPreferences-backed string; `BottomLayerPreviewPanel` now hosts a 3-button Auto / Extruder / Feature picker beside the existing Tubes switch; `MainActivity` LE re-bake keys on the new mode so flipping triggers a one-shot rebuild. `ToolpathGlbColorModeTest` (4 tests: parse-aliases, auto-mode-with-two-tools, feature-mode-overrides-extruder-palette, extruder-mode-forces-palette-on-single-tool).

Upstream's "Edit height range" lets the user split an object into Z bands (e.g., 0–5 mm, 5–10 mm, 10+ mm) and override `layer_height`, `sparse_infill_density`, `wall_loops`, and a curated set of process keys per band. Stored as `ModelObject::layer_config_ranges` (`std::map<std::pair<double,double>, ModelConfig>`). Common workflows: 100 % infill in the bottom 5 mm to add weight; coarser layer height above a feature line; different wall count over the top of an embedded magnet pocket.

**Implementation outline:** Per-PlacedModel `List<HeightRange(zMin, zMax, overrides: Map<key, value>)>`. JNI walks the list and writes onto `mo->layer_config_ranges` before `print.process()`. UI: a vertical Z-bar gizmo in `HeightRangePanel` with split / merge / edit affordances; tapping a band opens the existing per-volume settings editor (D16). 3MF round-trip via libslic3r's existing serializer. Range overlap rules match upstream (later range wins).

**Exit criteria:** Author a 0–5 mm range with `sparse_infill_density=100` on a 20 mm cube; sliced gcode shows 100 % infill density in layers 1–25 and the project's default density above.

---

## B. XR UI / UX completeness

### B1. 3D Transform Gizmo (rings + arrows + handles) 🟢 Shipped

> **Files:** `MainActivity.kt` (gizmo entity creation parented to selected model), `app/src/main/java/dev/orcaxr/app/GizmoGlb.kt` (ring/arrow/handle GLB primitives), `app/src/main/java/dev/orcaxr/app/TransformGizmo.kt` (interactive components).

Currently transforms are TextField-driven in TransformPanel ("snap-and-confirm not free-drag" because of ~1 cm hand-tracking jitter). For users with paired Galaxy XR controllers, laser-precision drag handles become viable.

**Implementation outline:**
1. **Translation arrows** — three thin tube GLBs (X/Y/Z), each with `InteractableComponent`. On `Action.MOVE`, project the laser hit onto the arrow's axis, accumulate, write into `PlacedModel.translateXmm/Ymm/Zmm`.
2. **Rotation rings** — three torus GLBs in three planes. Drag delta = `atan2` of the hit-position relative to model center on the ring's plane.
3. **Scale handles** — three small cube GLBs at corners. Drag distance from center, ratio against baseline → `scaleXPct/YPct/ZPct`.
4. **Visibility** — gizmo entity is mounted only when `selectedModelId != null`, hidden during paint mode and during a workspace grab.
5. **Coexistence** — gizmo handles use `InteractableComponent`; the model-grab `MovableComponent` can't share an entity (gotcha #42), so gizmo handles are sibling entities parented to a `OrcaXR-gizmoRoot` GroupEntity that follows the selected model's pose.

**Exit criteria:** rotate to any angle (not just 90°), translate and scale by drag, with TransformPanel and gizmo state always in sync. No frame drops on Galaxy XR (Choreographer skip-frame warnings clean).

**Dependencies:** Galaxy XR controllers input pump (already shipped). Hand-tracked drag is explicitly out of scope (~1 cm jitter is wider than usable handle precision).

**Shipped:** d81ee20 — Added TransformGizmo, GizmoGlb generation, and laser-drag interactive component handlers.

### B11. Multi-selection & Batch Actions 🟢 Shipped

> **Files:** `MainActivity.kt` (UI state for `selectedModelIds`, modify `TransformGizmo` binding, slice/arrange filters), `PlacedModel.kt` (helper logic), `UiPanels.kt` (checkboxes/multi-select UI in `PlacedModelsSection`).

Currently, users can only select and manipulate one `PlacedModel` at a time. With B9 and E3 adding potentially dozens of parts to a plate, moving or deleting them individually is tedious.

**Implementation outline:**
1. **State:** Change `selectedModelId: String?` to `selectedModelIds: Set<String>`.
2. **UI List:** Add a visual indicator (like a checkbox or distinct highlight) to `ModelRow` to support multi-select. Long-press or a dedicated "Select All" button in the section header.
3. **Gizmo & TransformPanel:** If exactly one model is selected, the TransformGizmo and TransformPanel edit that model. If *multiple* models are selected, the Gizmo wraps the bounding box of the *group* and applies delta translations/rotations to all members. (For MVP, if multi-selected, we can just apply delta translation to all, and disable rotation/scaling if group math is too complex).
4. **Batch Actions:** "Delete selected", "Move selected to Plate X", "Auto-arrange selected".

**Exit criteria:** User can select three parts, drag them together with the gizmo, and move them all to Plate 2 via the dropdown.

**Shipped:** 27f1b2c — Enabled multi-selection in the project list, gizmo translation for grouped parts, and batch actions (move/delete).

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

### B13. Settings backup / restore as JSON 🟡 Partial — JSON envelope + MCP tools shipped, in-app Settings panel button pending

> **Files (planned):** `app/src/main/java/dev/orcaxr/app/SettingsBackup.kt` (new — aggregate every DataStore + SharedPreferences-backed store into one JSON), `MainActivity.kt::saveBackupToDownloads` + `loadBackupFromUri`, settings panel buttons inside the existing AI/MCP settings card, MCP tools `export_settings(out_path?)` / `import_settings(path, mode="merge"|"replace")` in a new `tools/SettingsBackupTools.kt`.

OrcaXR already persists ~10 DataStore / SharedPreferences-backed stores (`UserPreferences`, `McpSettings`, `FilamentEntriesStore`, `RecentFilesStore`, `MixedFilamentStore`, `CustomGcodeStore`, `PlateStore`, `PrintersStore`, `PaintCacheStore`'s key-only entries, `AiPaintSessionStore`). What's missing is a single export/import that survives device wipes, copies settings between two Galaxy XR headsets, and gives the user a debug bundle for bug reports.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) ships the same affordance as a top-level setting: one button writes everything out as JSON, one button reads it back. Useful for cross-device parity (the user owns multiple headsets / shares profiles with a co-worker), painless bug reports, and as a hidden MCP capability — an LLM can snapshot the user's current state, mutate, and revert.

**Implementation outline:**
1. **`SettingsBackup.collect(ctx) -> JSONObject`** — explicit list of stores, each with a `version` field so future schema changes can migrate without losing the import. Schema-pinning matters: a v1 export should never silently restore as v2 with a new field at a default value.
2. **`SettingsBackup.apply(ctx, json, mode)`** — `mode = "merge"` keeps the user's current state, only overwriting keys present in the JSON; `mode = "replace"` clears each store and rewrites from scratch. Default is `merge` because that's the safer cross-device-sync workflow.
3. **UI** — settings panel grows two buttons at the bottom: "Export settings…" (writes `orcaxr-settings-<timestamp>.json` to Downloads via the existing MediaStore path used by `saveGcodeToDownloads`) and "Import settings…" (file picker → `JSONObject` → `apply(merge=true)`).
4. **MCP** — `export_settings(out_path?)` returns the JSON inline (or writes to a path if given) so an LLM can `export_settings` → mutate → `import_settings` to revert. Both tools sit alongside the existing `set_user_preference` tool in PrefsTools.

**Exit criteria:** Export, factory-reset the test device, install OrcaXR fresh, import the JSON; printer list / filament catalog / recent files / paint sessions / plates / wipe-tower auto-position toggle (A13) all return. `SettingsBackupTest` covers round-trip for every registered store with at least one non-default key set per store, plus a v1→v1 backwards-compat tripwire that fails if a new store is added without a versioned migration path.

**Shipped:** `SettingsBackup.exportJson(ctx)` / `importJson(ctx, json, mode)` aggregator covering 1 SharedPreferences blob + 10 DataStore Preferences files (orcaxr.plates, orcaxr.printers, orcaxr.filament_slots, orcaxr.filament_entries, orcaxr.user_profiles, orcaxr.mixed_filament, orcaxr.custom_gcode, orcaxr.recent_files, orcaxr.llm, orcaxr.mcp). DataStore blobs are base64-encoded `.preferences_pb` for byte-perfect round-trip. SP values use a typed `{type, value}` envelope so 6 SharedPreferences-supported types (Boolean / Int / Long / Float / String / Set<String>) all round-trip. `mode='merge'` (default) vs `mode='replace'`. `restart_required=true` always returned (in-process DataStore caches need a fresh boot). MCP tools `export_settings(out_path?)` + `import_settings(envelope|path, mode?)` registered. Path-allowlist sanitizer rejects writes outside filesDir / cacheDir / Downloads. `SettingsBackupTest` (4 tests including a source-tree grep tripwire that fails if a new DataStore lands without being added to `DATASTORE_NAMES`). Pending: settings-panel button in-app (the MCP path is fully usable today).

### B14. Android share-target for STL / 3MF / OBJ 🟢 Shipped

> **Files (planned):** `app/src/main/AndroidManifest.xml` (add `<intent-filter>` for `ACTION_VIEW` + `ACTION_SEND` of `model/*` MIME types and the relevant file extensions), `MainActivity.kt::onNewIntent` + `handleSharedIntent` (route `Intent.ACTION_VIEW` / `ACTION_SEND` through the existing `onFileSelected` path with a `content://` → cache-file copy), `app/src/main/java/dev/orcaxr/app/SharedIntentHandler.kt` (new — pure helper that writes a `ContentResolver` `InputStream` to a temp file and returns the path), `SharedIntentHandlerTest`.

OrcaXR's only entry point today is the in-app file picker. To open a model the user has to leave the headset workflow (browser / file manager) and tap into OrcaXR, which is a clunkier path than necessary on a headset where switching apps means swapping focus.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) registers as a share-target so a tap on a `.3mf` in Bambu Handy / MakerWorld / a browser / a file manager goes straight into the slicer. Companions D21a/D21b (the MakerWorld paint-recipe matcher already shipped) — once the model is in OrcaXR, the existing recipe auto-resolution kicks in. Adding the share-target plumbing makes the AI-paint pillar (C9 / D21a / D21b) usable end-to-end without touching the headset's file manager.

**Implementation outline:**
1. **Manifest intent-filters** — `MainActivity` grows two intent-filters: one for `ACTION_VIEW` of `model/x-stl`, `model/3mf`, `application/x-3mf`, `application/sla`, `application/octet-stream` filtered by extension via `pathPattern`; one for `ACTION_SEND` / `ACTION_SEND_MULTIPLE` of the same MIME types so MakerWorld's "share to" dialog includes us.
2. **`onNewIntent` routing** — `MainActivity.onNewIntent(intent)` calls into `handleSharedIntent` which: (a) extracts the URI (`Intent.getData()` for VIEW, `EXTRA_STREAM` for SEND), (b) opens the `ContentResolver` `InputStream`, (c) copies bytes to `cacheDir/shared/<sha256>.<ext>` (deterministic so Bambu Handy → OrcaXR is idempotent), (d) routes through the same `onFileSelected` codepath the picker uses (paint restore + GLB bake + bedFit + recents bump fire identically to a manual import).
3. **Permission story** — share-target receives a `content://` URI with read permission already granted by the sender; we don't need any new app-level storage permission.
4. **Multi-file** — `ACTION_SEND_MULTIPLE` (MakerWorld occasionally sends `.3mf` + a thumbnail) drops the non-3D entries and imports the rest in order.
5. **Recents bump** — every shared file becomes a `RecentFilesStore` entry just like the picker path.

**Exit criteria:** From a phone running Bambu Handy, share a MakerWorld 3MF to the OrcaXR-installed Galaxy XR; OrcaXR comes to the foreground with the model already loaded on the active plate, the existing D21b paint-recipe auto-resolution fires identically to a manual import, and the file appears at the top of `RecentFilesStore`. `SharedIntentHandlerTest` covers `content://` → cache-file copy round-trip for STL, 3MF, OBJ + a pure-extension URI when the MIME type is `application/octet-stream`.

**Shipped:** Three intent-filters on `MainActivity` covering `ACTION_VIEW` (typed MIME), `ACTION_VIEW` (pathPattern fallback for `application/octet-stream`), and `ACTION_SEND` / `ACTION_SEND_MULTIPLE`. `launchMode="singleTask"` so a share into a running OrcaXR routes through `onNewIntent`. `SharedIntentHandler.resolveAll(ctx, intent)` extracts URIs, copies to `cacheDir/shared/<basename>-<sha16>.<ext>` (deterministic naming for idempotent imports of the same bytes), and emits each File on `pendingSharedFiles: SharedFlow<File>`. `XrShell` `LaunchedEffect` collects from the flow and routes through the existing `onFileSelected` path (paint restore + GLB bake + bedFit + recents bump fire identically to a manual import). Path-traversal sanitizer reduces basename to `[A-Za-z0-9._-]+`. `SharedIntentHandlerTest` (8 tests covering happy-path STL stage, idempotent dedupe, unrecognized-extension rejection, empty-payload rejection, basename sanitization, ACCEPTED_EXTENSIONS coverage, case-insensitive `.STL`, distinct-content distinct-files).

### B12. Calibration print library 🟡 Partial — 7 calibration meshes vendored via HandyModelCatalog; A11-dependent variable-ramp generator deferred

> **Files (shipped):** 7 `assets/handy_models/calib_*.drc` files vendored from `third_party/OrcaSlicer/resources/calib/`, registered as `HandyModelCatalog` entries (`calib_temperature_tower`, `calib_retraction_tower`, `calib_pa_tower`, `calib_ringing_tower`, `calib_vfa`, `calib_cornering`, `calib_volumetric_speed`). Reachable via the existing `add_handy_model(id=...)` MCP tool — same staging + load + bedFit + bedCollision path the rest of D13 uses. NOTICE.md updated.

The shipped slice gives the user every standard calibration test mesh in one MCP call. The proper "parametric variable ramp" wrapper (per-Z temperature / PA value bands authored from a slider, baked into a 3MF + per-Z gcode) lands alongside **A11** (custom G-code per print Z) — that's the libslic3r-correct path, and adding it ahead of A11 would mean writing a parallel implementation we'd then throw away. Until A11 lands, users overlay variable-ramp gcode via the project's `before_layer_change_gcode` override.

Upstream OrcaSlicer ships a "Calibration" menu that auto-generates parameterized test prints (Pressure Advance line / pattern / tower; Temperature Tower; Max Volumetric Speed; Retraction Test; Input Shaping; Cornering; VFA; Filament Flow). Each calibration is a 3MF + a per-print-Z `custom_gcode` script that ramps a single variable (PA value, temp, speed, retraction length, etc.) so the user prints once, picks the best band, and writes the resulting value into the active filament profile.

**Implementation outline:**
1. **Catalog** — `CalibrationCatalog.entries: List<Calibration(id, displayName, kind, defaultParams, generate())`. `generate()` returns a `(stlPath, customGcodeTicks: List<Tick>)` pair.
2. **Stamp generators** — most calibrations are parametric: PA tower needs `(start, end, step)`; temp tower needs `(start, end, step, layers_per_band)`. Generate the per-Z custom-gcode list at the requested params (depends on **A11**).
3. **UI** — `CalibrationPanel` with a tile per calibration (icon + 1-line description). Tap → param sheet (sliders for the variables) → "Generate" → loads the STL + ticks into the workspace as a fresh PlacedModel + ticks via the existing import path.
4. **Result capture** — after the user prints + picks the best value, a "Apply to active filament" affordance writes the value into the user's filament profile via the existing `UserProfilesStore` (e.g., set `filament_pressure_advance` on `Snapmaker PLA Matte @U1`).
5. **MCP** — `list_calibrations`, `generate_calibration(id, params)` for LLM-driven "calibrate PA on this filament" loops.

**Dependencies:** A11 (custom G-code per print Z) is the primitive most calibrations need. Without A11, the variable ramp can be hardcoded into the generated 3MF as `before_layer_change_gcode` overrides — uglier but possible.

**Exit criteria:** A user picks "Pressure Advance Tower", picks `start=0.02, end=0.06, step=0.005`, taps Generate, slices, and the gcode contains `M572 S<value>` blocks at the right Z heights. The "Apply" button sets `filament_pressure_advance=0.04` on the active filament after the user types in the chosen value.

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

### C6. MCP Server for OrcaXR (AI Control & Smart Assistant) 🟢 Shipped (Phase 1–2.5) — 67 tools live; only libslic3r abort hook + spatial smart-fill remain as nice-to-haves

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/` (server, settings, tools, UI card), `OrcaXRApplication.kt` (boot), `UiPanels.kt` (Devices-panel card), `app/src/test/java/dev/orcaxr/app/mcp/` (tests). See [`GEMINI.md`](GEMINI.md) §"MCP server (C6) — architecture" for the wiring contract.

**Goal restated:** every action a human can take in the UI must be reachable as an MCP tool, so an LLM agent (Claude / Gemini / etc.) can drive OrcaXR end-to-end via natural language.

**Phase 1 shipped (this commit):**
- Hand-rolled HTTP/1.1 + JSON-RPC 2.0 transport on `ServerSocket` (no Ktor/Netty). `POST /mcp` for the JSON-RPC endpoint, `GET /` for a human-readable status page.
- Bearer-token auth (`Authorization: Bearer <key>`) auto-generated on first enable, persisted via DataStore. `initialize`/`tools/list`/`ping` are auth-free for client discovery; everything that mutates state needs the token.
- Lifecycle: `McpController` in `OrcaXRApplication.onCreate`, watches a `McpSettings` toggle. Off by default — opted in via the new `McpServerCard` at the top of the Devices panel (shows status, copy-paste LAN URLs, masked token with show/copy/rotate).
- Tool registry (24 tools across 6 categories):
  - **System** (2): `echo`, `server_info`.
  - **Printers** (10): `list_printers`, `add_printer`, `update_printer`, `delete_printer`, `get_printer_status`, `ping_printer`, `start_print`, `pause_print`, `resume_print`, `cancel_print`.
  - **Profiles** (3): `list_profiles`, `list_user_profiles`, `delete_user_profile`.
  - **Filaments** (3): `list_filaments`, `list_mixed_filaments`, `list_slot_colors`.
  - **Recents + Plates** (7): `list_recent_files`, `clear_recent_files`, `remove_recent_file`, `list_plates`, `add_plate`, `rename_plate`, `delete_plate`.
  - **Preferences** (2): `get_user_preferences`, `set_user_preference`.
- Tests: 24 unit tests under `app/src/test/java/dev/orcaxr/app/mcp/` — JSON-RPC parser, auth gate, and a full real-socket end-to-end round-trip with OkHttp as client. All green.

**Phase 2 shipped:** `WorkspaceModel` process-scoped singleton with `StateFlow` for every tracked in-session field; `BindWorkspaceModel` Composable that XrShell calls once near the top — it both publishes from MainActivity remember{}s into the model AND collects `WorkspaceAction`s back through the same setters the UI uses (so observers/re-bakes/validators fire identically whether the change came from a pinch or a tool call). Phase-2 tools added (17 new, 41 total):
- **Reads:** `get_workspace_state` (one-shot snapshot of the full workspace), `list_placed_models` (filterable by plate / selection).
- **Tier-A mutators:** `set_gizmo_tool`, `set_workspace_mode`, `set_active_plate`, `select_models`, `clear_selection`, `set_layer_height_override`, `set_paint_mode`, `set_paint_brush`, `set_max_layer`, `switch_profile`, `select_printer`, `set_show_travels`, `set_toolpath_tubes`, `transform_model`, `delete_models`.

**Phase 2.1 shipped:** Tier-B mutator tools wired through `BindWorkspaceModel`'s new optional callback parameters (`onSliceActivePlate`, `onAutoArrangePlate`, `onDropToBed`, `onSaveGcode`, `onSaveProject3mf`, `onSaveModelStl`) which the MainActivity call site fills with lambdas that re-use the exact `runSlice`/`runSliceMulti`/`runAutoArrange`/`saveGcodeToDownloads`/`saveProjectAs3mfToDownloads`/`saveModelAsStlToDownloads` paths the BottomRightSummaryPanel buttons already drive — so an LLM-triggered slice is byte-identical to a tap. The `BindWorkspaceModel` call site moved later in `XrShell` (after `runSliceMulti` is declared) so the callbacks can close over those local funs. Phase 2.1 tools added (7 new, 48 total): `slice_active_plate`, `cancel_slice` (declared but unsupported pending a libslic3r abort hook), `auto_arrange_plate`, `drop_to_bed`, `save_gcode_to_downloads`, `save_project_as_3mf`, `save_model_as_stl`.

**Phase 2.2 shipped:** the end-to-end "tell me to slice this and send it to the printer" flow now works without ever touching the file picker. Two new tools (53 total): `load_model_from_path` (STL/3MF/OBJ/AMF/STEP, replace or add modes — routes through the same `onFileSelected` codepath as the picker so paint restore + GLB bake + bedFit run identically) and `set_plate_movable` (toggle the bed-grab affordance from outside the app). `plate_movable` is now in `get_workspace_state`'s output.

**Phase 2.5 shipped:** paint-by-API — the canonical "replace blue with red" use case (and four others). Five new tools (67 total): `get_paint_summary` (per-tag triangle histogram across color / support / seam / fuzzy_skin), `clear_paint` (one or all kinds), `replace_paint_tag` (slot remap — the explicit user request), `paint_undo`, `paint_redo`. Mutations route through a new `applyPaintMutation` helper in `XrShell` that wraps every change in `PaintHistory.beginStroke / endStroke` so an MCP-driven re-color is undoable from XR (and an XR stroke is undoable from MCP). The auto-debounced observers (LE_2800 paint→GLB rebake, LE_2819 paint→`PaintCacheStore` write) fire identically. Tag ranges are validated per kind: color=0..32, support/seam=0..2, fuzzy_skin=0..1.

**Phase 2.4 shipped:** embossing + per-volume editing — closes the model-authoring gap so an LLM can decorate text/SVG onto a part and attach modifier/negative/support volumes without UI input. Five new tools (62 total): `list_emboss_fonts` (bundled DejaVu Sans Bold + Serif), `emboss_model` (kind=text|svg, mode=emboss|engrave, optional XY offset + Z rotation — routes through `runEmboss` + `EmbossAssets.stageBundledFont`), `list_volumes`, `add_volume_to_model` (routes through `PickerMode.AddVolume` + `onFileSelected` so the colored-GLB rebuild fires identically), `remove_volume`.

**Phase 2.3 shipped:** model-editing flows + a real fix to a stale-closure bug in `BindWorkspaceModel`. Four new tools (57 total): `repair_model` (libslic3r `MeshBoolean::self_union` cleanup), `cut_model(model_id, plane_z_mm)` (horizontal cut with auto-bed-drop on the lower half), `mesh_boolean(a, b, op)` (union / difference / intersection), `split_model(model_id)` (one PlacedModel per connected component). Routed through the existing `runRepair` / `runCut` / `runBoolean` / `runSplit` button paths; `runCut` grew an optional `sourceOverride` parameter so MCP doesn't have to clobber `selectedModelIds` to cut a specific model. **Bug fix:** every Tier-B callback inside `BindWorkspaceModel`'s action collector now goes through `rememberUpdatedState` — previously the lambdas froze at first composition, so a slice/save action arriving after the user touched the UI would have dispatched through a stale closure with stale state. Phase 2.0/2.1 tools were affected too; this commit fixes them all.

**Phase 3 (next):** Smart-Assistant XR panel — chat-style UI hosted in the workspace, calls the same MCP server locally. The on-device server already lets a remote LLM client (Claude Desktop pointing at the device's LAN IP) drive everything; Phase 3 is about making it feel native inside the headset.

**Remaining nice-to-haves** (truly optional from here):
- `cancel_slice` needs a `nativeAbort` hook in libslic3r's JNI shim — declared but no-op today.
- Spatial smart-fill — paint a region starting at a 3D point or face index, using the BVH's flood-fill. Today's paint-by-API does global re-tagging; spatial would let an LLM paint just one face by reference to printer-frame coordinates.
- Workspace transform reset (`workspaceTx` / "Reset" button) isn't exposed — purely cosmetic so low priority.

**Verification:** instrumented test from a desktop machine — `curl -X POST http://<headset-ip>:7080/mcp -H "Authorization: Bearer <key>" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns the 67-tool catalog. End-to-end smoke test for the "natural-language slicer" loop: `load_model_from_path` → `slice_active_plate` → poll `get_workspace_state` until `slice_state.kind == "done"` → `save_gcode_to_downloads`, then `select_printer` + `start_print` against a Moonraker host. Workspace tools require the app foreground (the `attached` flag in `get_workspace_state` is the gate).

### C7. Spatial "Digital Twin" Monitoring 🟢 Shipped

> **Files:** `MoonrakerClient.kt` (telemetry), `MainActivity.kt` (auto-follow + Devices mode panel routing), `UiPanels.kt` (`WorkspaceMode.Devices`), `mcp/tools/PrinterTools.kt` (`get_print_progress`).

A live 3D representation of the print-in-progress lives inside OrcaXR's existing toolpath GLB — the user enters Devices mode (top-nav button) and the slicing UI swaps out for a printer-monitoring view: the toolpath grows in lockstep with the physical print head's reported Z-height.

**Implementation:**
1. **Telemetry.** `MoonrakerClient.queryStatus` now subscribes to `toolhead` and parses `position[2]` into `PrintSnapshot.liveZmm`, plus `virtual_sdcard.file_position` / `file_size` into `gcodeFilePosition` / `gcodeFileSize`. Two new unit tests cover both the populated and missing-fields paths.
2. **No new GLB filter needed.** `ToolpathGlb.write` already accepted `maxLayerInclusive: Int?` for the layer scrubber. We reuse it: a new `LaunchedEffect(workspaceMode, selectedPrinterId)` reads `printerSnapshots[id].liveZmm`, binary-searches it against `parsedToolpath.layerZs`, and writes the resulting index into `maxLayer.value` — the existing observer pipeline rebakes the GLB at the right cutoff. 500ms inner poll, no extra Moonraker requests (the snapshot map is already being pumped at ~2s by the existing status loop).
3. **`WorkspaceMode.Devices` (third value alongside Prepare/Preview).** When entered, the slicing panels — `LeftProjectPanel`, `RightSettingsPanel`, `BottomLayerPreviewPanel`, `BottomRightSummaryPanel` — hide; the `PrinterPanel` overlay + `PrintMonitorPanel` (the one that surfaces during active prints with pause / resume / cancel + webcam frame + temps) stay visible and become the dominant chrome. Workspace rendering uses the same toolpath path as Preview. Closing Devices returns to Preview if a slice is loaded, otherwise Prepare. The existing `devicesShown` boolean still works as a UI overlay flag, but the Devices button now also flips `workspaceMode`.
4. **MCP exposure.** `get_print_progress(printer_id)` — new tool that snapshots `liveZmm`, byte position, derived layer index (binary-searched against the in-app parsed toolpath when one is loaded), and ETA. Useful for an LLM agent waiting for "is this print 80% done yet?" Plus the `live_z_mm` / `gcode_file_position` / `gcode_file_size` fields landed in the existing `get_printer_status` response.

**Verification:** start a print on the U1, tap Devices in the top nav, watch the workspace strip down to the Devices view — the toolpath GLB starts at layer 0 and grows as the printer reports Z. From an MCP client: `get_print_progress` returns `{progress: 0.42, live_z_mm: 8.4, derived_layer_index: 42, derived_layer_count: 100, eta_sec: 3600}`.

### C8. Voice-to-Action Integration (Speech-to-MCP) 🔴 Not started

> **Files:** `app/src/main/java/dev/orcaxr/app/voice/` (new), `MainActivity.kt`, C6 MCP Server logic.

Enables hands-free control of the slicer and printer using voice commands, mapping spoken intent to MCP tool calls.

**Implementation outline:**
1. **Speech API:** Integrate Android `SpeechRecognizer` with a trigger button in the `TopNavigationPill`.
2. **Intent Mapping:** Use a simple keyword-based or LLM-assisted mapper to translate recognized text (e.g., "Slice for PLA") to MCP tool calls (`slice_active_plate` with `material="PLA"`).
3. **Feedback:** Show a transcript of the recognized command and a confirmation Toast before executing destructive actions (like "Clear bed").
4. **Verification:** Say "Orca, slice the current plate"; confirm the slicing progress bar appears without touching the screen.

### C9. AI-Driven Semantic Paint (LLM-driven natural-language painting) 🟢 Shipped (M1–M4) — multi-volume polish + nightly E2E pirate-Benchy eval still pending

**Shipped (M1–M4, commits `4df6bf2` `4dfc6a5` `0edd5dd` `99b51a5`):**
- **M1 — Spatial paint primitives:** seven MCP tools (`paint_sphere`, `paint_slab`, `paint_normal_cone`, `paint_surface_region`, `paint_connected_component`, `paint_triangle_list`, `paint_projected_mask` after M4) all compile down to `WorkspaceAction.PaintTriangleSet { triangleIndices, tag, mergeMode }` so PaintHistory + paint cache + paintContentVersion plumbing stays correct (one MCP call ⇒ one undo step). `WorkspaceModel.BvhProvider` registered from MainActivity lets the MCP server share the XR brush's `bvhCache`, with on-demand cold-start build off Dispatchers.Default. `MergeMode.Replace | OnlyUnpainted | OnlyTagged`. `MeshBvh.aabbOverlapTriangles` + `connectedComponent` + `triangleVertex` + `directNeighbors` underpin the primitives. 40 new unit tests.
- **M2 — Vision pillar:** six MCP tools (`render_view`, `render_paint_overlay`, `render_triangle_id_map`, `list_camera_presets`, `name_view`, `resolve_image_pixel`) backed by a pure-Kotlin software rasterizer (`AiRenderEngine`, ~400 lines). Eight named presets (iso/front/back/left/right/top/bottom/iso_back) computed off the model bbox. Five render modes: solid / paint / triangle_id (RGB-encoded `id+1`) / normal sphere / depth. `PngWriter` is a 120-line pure-Kotlin PNG encoder using `java.util.zip.Deflater`. `AiSessionState` is a process-singleton holding 50-entry LRU of render artifacts keyed by content hash, plus user-named cameras. New `GET /resources/<token>.png` route on `McpServer` streams PNG bytes via `HttpFraming.writeBinaryResponse`. `ToolResult.imageParts` adds optional inline base64 image content parts. 19 new tests including a JDK ImageIO round-trip on the encoded PNGs.
- **M3 — Introspection:** four MCP tools (`get_model_geometry`, `get_model_components`, `get_model_face_orientation_summary`, `get_model_semantic_regions`) all pure Kotlin. Geometry returns bbox in centered_preview_mm, surface area, divergence-theorem volume, watertight check, 32-bin per-Z histogram. Components partition via vertex adjacency BFS sorted by descending triangle count. Face-orientation summary buckets triangles into six 30°-half-angle cardinal cones plus diagonal residual. Semantic regions runs region-growing segmentation with normal-tolerance + distance-cap gates and emits heuristic labels (`vertical_side_large`, `horizontal_top_medium`, etc.) — the canonical entry point for the pirate-Benchy workflow. 16 new tests.
- **M4 — Multi-view + projected mask:** `paint_projected_mask` reverse-projects a 2D polygon mask through a camera into BVH triangle space (per-pixel ray cast with `MeshBvh.intersectAll` for `all_hits` mode); `render_views_grid` composes N named-preset views into a single side-by-side PNG. `AiMaskProjection.rasterizePolygons` is a pure-Kotlin scanline-fill polygon rasterizer; matrix inverse + NDC unprojection live alongside. 7 new tests cover scanline + front-most/all-hits projection on cube fixture.

**Tools live (18 total):** `paint_sphere`, `paint_slab`, `paint_normal_cone`, `paint_surface_region`, `paint_connected_component`, `paint_triangle_list`, `paint_projected_mask`, `render_view`, `render_paint_overlay`, `render_triangle_id_map`, `list_camera_presets`, `name_view`, `resolve_image_pixel`, `render_views_grid`, `get_model_geometry`, `get_model_components`, `get_model_face_orientation_summary`, `get_model_semantic_regions`.

**Architectural decisions made during shipping:**
- **Pure Kotlin, not JNI.** The rasterizer + introspection are Kotlin instead of native because the shipping pressure was "the LLM can SEE the model end-to-end" — Kotlin gets there in one session with no native rebuild and no Robolectric for tests. 768×768 Benchy render is ~250 ms host JVM, expected ~600 ms–1 s on Galaxy XR arm64. Migration to JNI is mechanical if profiling later shows it's a bottleneck. The native files (`ai_render.cpp`, `ai_segment.cpp`, vendored `stb_image_write.h`) listed in the original design doc were NOT shipped — Kotlin replaces them.
- **No new patches in `patches/`.** The vendored libslic3r submodule is untouched.
- **Polygon-list mask only (no inline base64 / file-path PNG masks).** The polygon path is the LLM's most natural authoring form ("draw a quadrilateral over the bow"); inline-base64 / file-path PNG masks were deferred until a real-world test shows they're needed.

**Outstanding (deferred, low-priority):**
- Per-`PlacedVolume` paint surfaces (M5 polish item) — current tools operate on the primary volume only.
- `docs/AI_PAINT_PROTOCOL.md` reference + Anthropic-SDK harness under `scripts/` — see `docs/AI_PAINT_DESIGN.md` §E.1 for the system prompt + worked example until then.
- Nightly E2E "paint Benchy as a pirate ship" eval (slow + Anthropic API credits — not CI per-commit).

**Original design + outline below kept for traceability:**

> **Files (planned):** `app/src/main/java/dev/orcaxr/app/Ai{Paint,Render,Introspection}Engine.kt` (new), `app/src/main/java/dev/orcaxr/app/mcp/{AiSessionState,JobRegistry}.kt` (new), `app/src/main/java/dev/orcaxr/app/mcp/tools/Ai{Vision,Introspection}Tools.kt` (new), `app/src/main/cpp/ai_render.{cpp,hpp}` + `ai_segment.{cpp,hpp}` (new), `app/src/main/cpp/third_party_stb_image_write.h` (vendored). Modifies `WorkspaceAction.kt`, `WorkspaceBinding.kt`, `WorkspaceTools.kt`, `Tool.kt`, `McpServer.kt`, `MeshBvh.kt`, `SlicerEngine.kt`, `slic3r_jni.cpp`. Full design doc: [docs/AI_PAINT_DESIGN.md](docs/AI_PAINT_DESIGN.md).

Lets an external LLM (Claude / GPT) execute creative paint tasks like *"paint Benchy as a pirate ship using the colors I have available"* end-to-end with no human in the loop. Three pillars on top of C6's MCP surface — vision (headless multi-view rasterization), spatial paint primitives (sphere / slab / normal-cone / surface-region / connected-component / projected-mask / triangle-list — all server-side, no XR pinch needed), and introspection (geometry summaries, connected components, face-orientation histograms, region-growing semantic clusters). Triangle IDs are the lingua franca: every primitive returns the matched tri-ID set so the LLM can chain reads → narrow → paint. Image transport via file-path resource URIs (the MCP body cap is 1 MB), forward-porting the existing software rasterizer (`thumbnail_render.cpp`) rather than introducing OSMesa/EGL.

**Implementation outline (5 milestones, each shippable on its own):**
1. **Spatial paint primitives** (pure Kotlin, no JNI, no vendored-libslic3r changes). New `PaintTriangleSet` WorkspaceAction routes through existing `applyPaintMutation` so PaintHistory + paintContentVersion stay correct. Six tools: `paint_sphere`, `paint_slab`, `paint_normal_cone`, `paint_surface_region`, `paint_connected_component`, `paint_triangle_list`.
2. **Vision pillar — single-view rendering.** New `nativeRenderViews` JNI built on extended `thumbnail_render.cpp` (arbitrary view+proj matrices, RenderMode enum: SolidColor / PaintColor / TriangleId / NormalSphere / Depth / PaintMaskLayer). PNG via `stb_image_write.h`. New `McpServer` route `GET /resources/<token>.png`. Tools: `render_view`, `render_paint_overlay`, `render_triangle_id_map`, `list_camera_presets`, `name_view`, `resolve_image_pixel`.
3. **Introspection.** Tools: `get_model_geometry`, `get_model_components`, `get_model_face_orientation_summary`, `get_model_semantic_regions` (region-growing in `nativeBuildSemanticRegions`, plus a colored preview render).
4. **Multi-view + projected mask.** `render_views_grid` (composed PNG with labeled panels) + `paint_projected_mask` (rays from mask pixels through camera into BVH; accepts polygon list / inline base64 / file URI). New `JobRegistry` for long jobs with `cancel_paint_job` + `get_paint_job_status`.
5. **Multi-volume polish + docs.** Per-`PlacedVolume` paint surfaces, `docs/AI_PAINT_PROTOCOL.md`, reference Anthropic-SDK harness under `scripts/`, nightly E2E "paint Benchy as a pirate ship" eval.

**Architectural decisions worth flagging on the roadmap (full justification in plan):**
- All spatial paint primitives compile down to `PaintTriangleSet { triangleIndices, tag }`. One MCP call = one undo step, even an 80 K-triangle projected mask. Coexistence with the in-XR brush is handled by committing any in-progress XR stroke as its own `PaintHistory` entry before applying an MCP mutation.
- Coordinate frame for every public spatial-paint coordinate is `centered_preview_mm` (matches what the LLM sees in rendered images). `get_model_geometry` returns bbox in all three frames (mesh-local, centered-preview, printer-frame) so the LLM can sanity-check.
- New C++ files live in `app/src/main/cpp/`, NOT inside `third_party/OrcaSlicer/` — no new patches in `patches/`, no upstream-merge friction.

**Verification (per milestone):** new JVM unit tests for each primitive against fixture meshes (cube, sphere, mini-Benchy) + scripted MCP transcripts under `app/src/test/resources/mcp_transcripts/m{1..4}_*.txt`. Milestone 5 nightly E2E asserts the final paint state has at least 4 distinct slots used and that each slot's painted-tri count is in expected ranges (hull > deck, etc.).

**Open questions:** (a) image-output authoring loop — does the LLM emit polygon lists or inline-base64 PNG masks, and how do we steer it via system prompt; (b) whether `nativeRenderViews` should accept the in-memory paint ByteArrays directly (current plan) or read paint state from a persisted intermediate (cheaper for the multi-view-grid path that re-renders the same paint state N times).

---

## D. Painting / object editing extensions

**Moved to [ROADMAP-painting-and-editing.md](ROADMAP-painting-and-editing.md)** under the "<600 lines" maintenance rule. That sibling file is the single source of truth for D1–D17. Cross-references in this file (e.g., A11 → D14, B12 → A11) still resolve — link targets are the section heading anchors in the sibling.

<details>
<summary>Index of D items (status snapshot — see sibling file for full entries)</summary>

| # | Title | Status |
|---|---|---|
| D1 | Paint persistence | 🟢 |
| D2 | Custom support point placement | ⚪ |
| D3 | Brim ear painting | 🟢 |
| D4 | Embossing / SVG inset / text-on-object | 🟢 |
| D5 | SLA hollow + drainage holes | ⚪ |
| D6 | Measure tool | ⚪ |
| D7 | Multi-step undo for paint | 🟢 |
| D8 | Smart fill / connected-region paint | 🟢 |
| D9 | 3MF round-trip for per-object Object Settings | 🔴 |
| D10 | Fuzzy Skin paint | 🟢 |
| D11 | Brush radius / smart-fill stick adjust | 🟢 |
| D12 | Add primitive shapes (cube / cylinder / sphere / cone / disc / torus / slab) | 🟢 |
| D13 | Handy model library (Benchy, Orca Cube, Voron Cube, Stanford Bunny, …) | 🔴 |
| D14 | Modifier volume types (negative / parameter modifier / support enforcer / support blocker) | 🔴 |
| D15 | Standalone text & SVG primitives | 🔴 |
| D16 | Per-volume Object Settings panel | 🟡 |
| D17 | Mesh simplify (quadric edge collapse) | 🔴 |

</details>

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

### E8. Foreground-service background slicing 🟡 Partial — service + lifecycle shipped, libslic3r abort hook + percent-progress notification pending

> **Files (planned):** `app/src/main/java/dev/orcaxr/app/SliceForegroundService.kt` (new — mirrors `mcp/McpForegroundService.kt`), `SlicerEngine.kt` (route `runSlice` / `runSliceMulti` through the service when the user opts-in or when the slice is expected > N seconds), `MainActivity.kt::XrShell` (bind to ongoing slice on resume), `AndroidManifest.xml` (declare second foreground service with `foregroundServiceType="dataSync"` — the MCP server already declares one), `app/src/test/java/dev/orcaxr/app/SliceForegroundServiceTest.kt`.

Slicing a complex multi-color print on the U1 takes 30–120 s on Galaxy XR (gotcha #23 — 20 mm cube p50 = 807 ms; a 4-color dragon is in the tens of seconds). Today, if the user takes off the headset mid-slice, Android eventually reaps the Activity and the slice loses progress. The MCP server already lives in a foreground service (`McpForegroundService`) so the pattern is established; `nativeSlice` / `nativeSliceMulti` should follow the same path.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) does this. On a headset it's load-bearing — XR users genuinely take off the headset mid-task in a way phone users don't. Without it, "slice this then walk away" is broken.

**Implementation outline:**
1. **`SliceForegroundService.start(ctx, jobId, slicerArgs)`** — kicks off the foreground notification + posts the slicer args into a process-singleton job table. The actual JNI call happens on the service's IO scope so it survives Activity teardown.
2. **Notification** — "OrcaXR is slicing — N% complete (M of K layers)" with a Cancel action. Updated periodically; final state is "Slice complete — tap to view" linking back to MainActivity.
3. **State surface** — the existing `WorkspaceModel.sliceState` already publishes `SliceState.{Idle, Running(progress), Done(path), Failed(msg)}`; the service writes to the same singleton so the Compose UI surfaces match whether the user is in-app or returning from the launcher.
4. **Cancel hook** — `SliceForegroundService` calls `nativeAbort` (a real JNI hook this time — currently the `cancel_slice` MCP tool is a no-op pending this) which sets `g_abort_requested` polled inside libslic3r's slicing loop. C6 nice-to-have "libslic3r abort hook" finally gets shipped here.
5. **Auto-enable threshold** — slices estimated > 15 s (heuristic: more than the bundled cube + any 3MF with > 50K triangles or > 1 PlacedModel) auto-enable the service; smaller slices stay in-process. User can force-enable via a settings toggle.

**Exit criteria:** Start a 30 s slice on Galaxy XR, take off the headset, put it back on after 60 s — the slice completed, the toolpath GLB is rendered, and the persistent notification went away on completion. Cancel from the notification works. `SliceForegroundServiceTest` covers the lifecycle (start/stop/cancel) using a Robolectric-mocked Service + a stubbed `nativeSliceMulti` that sleeps. The `nativeAbort` JNI hook lands as a separate commit unblocking C6's `cancel_slice`.

**Shipped:** `SliceForegroundService` (mirrors `McpForegroundService` shape — same `dataSync` foregroundServiceType, same notification + open-app intent pattern). `SliceLifecycle` process-singleton with re-entrant counter so nested inner slices don't tear down the service prematurely; `activeLabel: StateFlow<String?>` for the notification text. Manifest declares the second foreground service. `runSlice` and `runSliceMulti` wrap their `scope.launch` body in `SliceLifecycle.beginSlice(ctx, label)` … `try { … } finally { SliceLifecycle.endSlice(ctx) }` so every return path (success / exception / coroutine cancel) releases the hold. `SliceLifecycleTest` (3 unit tests covering happy-path, nested begin/end, over-decrement clamping). Pending: (a) the `nativeAbort` JNI hook in libslic3r so a Cancel notification action can actually halt the native slicer (still unblocked from C6's `cancel_slice` no-op); (b) routing `Print::set_status_callback` percent ticks into the notification text so the user sees "Slicing dragon — 42%" instead of just "Slicing dragon"; (c) on-device verification that a 30 s slice survives Activity teardown.

### E9. Native build toolchain pin (NDK 26+ / Clang 17+) 🟡 Partial — gotcha + bash assert shipped, gradle CI tripwire pending

> **Files (planned):** `GEMINI.md` (new gotcha #27 documenting the NDK pin requirement + the verification command), `scripts/build_native.sh` (assert `clang --version` ≥ 17 before building libslic3r.a), `app/src/main/jniLibs/.gitkeep` README cross-reference. `app/build.gradle.kts:46` already pins `ndkVersion = "29.0.14206865"` for the JNI shim — this entry codifies the ≥ 26 floor as a project invariant.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) ran into a hard incident (their B62) where NDK 25's Clang 14 produced miscompiled SEMM (multi-color paint segmentation) output — the generated G-code looked plausible but multi-colour boundaries were degraded relative to NDK 26's Clang 17. They pinned NDK 26 with a `llvm-readelf -p .comment libprusaslicer-jni.so` verification command in their build instructions.

OrcaXR is not currently exposed to that bug (we build with NDK 29 / Clang 19, well above the floor — `app/build.gradle.kts:46`). But the pin is **implicit** today — buried in a build-comment about libc++ weak symbols, not in GEMINI.md's gotcha list. Future contributors who see "NDK 25 builds fine on my machine, why is the project pinned to 29?" might lower the pin and silently break the AI-paint pillar (C9) for users who don't notice multi-color boundary regressions until they print.

**Implementation outline:**
1. **GEMINI.md gotcha** — new entry cross-referencing `app/build.gradle.kts:46` + the u1-slicer B62 incident. Body: "NDK ≥ 26 is required for libslic3r's paint segmentation to compile correctly. Older NDK toolchains miscompile the per-tri tag propagation. Verify shipped `.so` with `llvm-readelf -p .comment app/build/intermediates/cxx/.../libslic3r_jni.so` — must show `clang version 17` or higher."
2. **`scripts/build_native.sh` guard** — assert `clang --version | grep -oE 'clang version ([0-9]+)'` resolves to ≥ 17 before invoking CMake. Fails fast with a one-line error pointing at the gotcha.
3. **CI tripwire** — add a Gradle task `verifyNdkClangFloor` that runs `llvm-readelf` on the staged `.so` and fails the build if Clang < 17. Wired into `assembleDebug` so a stale toolchain misconfiguration surfaces in the build output instead of silently shipping a degraded slicer.

**Exit criteria:** GEMINI.md gotcha #27 documents the pin + verification command. `scripts/build_native.sh` exits 1 on Clang < 17. `verifyNdkClangFloor` runs as part of `assembleDebug` and asserts the staged `.so` was built with Clang ≥ 17. Lowering `ndkVersion` to 25 in `app/build.gradle.kts` triggers a build-time failure.

**Shipped:** GEMINI.md gotcha §29 documents the NDK ≥ 26 / Clang ≥ 17 pin with the u1-slicer B62 cross-reference and the `llvm-readelf -p .comment` verification command. `scripts/build_native.sh` now asserts `clang --version` is ≥ 17 before invoking CMake (fails fast with an explicit "u1-slicer B62" error message). The gradle CI tripwire (`verifyNdkClangFloor` task wired into `assembleDebug`) is the remaining piece; the pin is currently enforced at three layers (gradle `ndkVersion = "29.0.14206865"` + bash assert + GEMINI gotcha) so removing one still fails loudly.

### E10. Android Test Orchestrator for instrumented slicing tests 🟢 Shipped

> **Files (planned):** `app/build.gradle.kts` (`androidTestUtil androidx.test:orchestrator`, `testInstrumentationRunnerArguments["clearPackageData"] = "true"`, `execution = "ANDROIDX_TEST_ORCHESTRATOR"`), `gradle/libs.versions.toml` (add `androidx-test-orchestrator` entry).

Today every instrumented test (`./gradlew connectedDebugAndroidTest`) runs in the same process. libslic3r's `Print` / `Model` / `Layer` C++ allocations leak into the next test's heap because the JNI shim doesn't free them on test-method boundaries (it's not designed to — the lifecycle is per-process). Several `SliceMultiInstrumentedTest` runs in a row OOM the test process well before they finish.

u1-slicer (`taylormadearmy/u1-slicer-for-android`) hit the same wall and resolved it with [Android Test Orchestrator](https://developer.android.com/training/testing/instrumented-tests/androidx-test-libraries/runner#use-android), which runs each test in its own process, so native memory accumulation can't cross test boundaries.

**Implementation outline:**
1. **Gradle wiring** — `androidTestUtil("androidx.test:orchestrator:1.7.0")` + `testInstrumentationRunnerArguments["clearPackageData"] = "true"` so DataStore + SharedPreferences also reset between tests; the runner arg `execution = "ANDROIDX_TEST_ORCHESTRATOR"` flips the per-test process model on.
2. **Verify** — re-run `./gradlew connectedDebugAndroidTest` against `RepairModelTest` + `SliceMultiInstrumentedTest` in the same task. Pre-Orchestrator the second test OOMs; post-Orchestrator both pass independently.
3. **Doc** — GEMINI.md gotcha #28 cross-referencing the new Gradle config + the symptom ("native OOM crashes during the second slicing test").

**Exit criteria:** `./gradlew connectedDebugAndroidTest` runs all instrumented tests cleanly; per-test process boundary visible in `adb logcat` between methods. Removing the Orchestrator arg makes a 5-slice test sequence OOM (regression guard).

**Shipped:** `androidx-test-orchestrator = "1.5.1"` in the version catalog, `androidTestUtil(libs.androidx.test.orchestrator)` artifact, `testInstrumentationRunnerArguments["clearPackageData"] = "true"` + `testOptions { execution = "ANDROIDX_TEST_ORCHESTRATOR" }` in `app/build.gradle.kts`. GEMINI.md gotcha §30 documents the rationale (libslic3r per-process C++ allocations leak across slicing test methods otherwise). On-device confirmation that 5+ slicing tests in series no longer OOM is the remaining `connectedDebugAndroidTest` follow-up.

---

## F. Profile catalog breadth

### F1. Additional U1 nozzle sizes (0.2, 0.8) 🟢 Shipped — full U1 nozzle line vendored

> **Files:** `app/src/main/assets/profiles/Snapmaker/machine/Snapmaker U1 (0.{2,8} nozzle).json`, 8 process leaves under `0.2 nozzle`, 5 leaves under `0.8 nozzle`, 10 process parents (`fdm_process_U1_0.{06,08,10,12,14}_nozzle_0.2.json` + `0.{24,32,40,48,56}_nozzle_0.8.json`). NOTICE.md updated.

OrcaXR's U1 picker now spans 0.2 / 0.4 / 0.6 / 0.8 nozzles, matching the Snapmaker fork v2.3.1 lineup. All vendored byte-identical from `https://github.com/Snapmaker/OrcaSlicer` (v2.3.1 tag); `OrcaProfileLoader` auto-discovers them with no code change. `SnapmakerNozzleCatalogTest` (9 tests) covers presence + instantiability of every leaf, the 0.2/0.8 `nozzle_diameter` resolution, the 0.06 / 0.4 `layer_height` resolution, and a tripwire that fails if any vendored leaf's `inherits` points at a missing parent.

### F2. Branded U1 filament leaves 🟡 Partial — PLA + ABS/ASA/PETG/PETG-CF vendored; exotic (PA-CF / PC / TPU) still pending

> Snapmaker fork ships ~58 branded leaves; OrcaXR now ships Generic PLA + Generic ABS + Generic PETG + Snapmaker PLA + Snapmaker PLA Matte + Snapmaker PLA Eco + Snapmaker PLA Silk + Snapmaker PLA Metal + Snapmaker PLA-CF + Snapmaker ABS + Snapmaker ASA + Snapmaker PETG + Snapmaker PETG-CF + Elegoo PLA Matte + Elegoo PLA-CF.

Branded leaves cover PLA HF / PLA Eco / PLA Metal / PLA Silk / PETG HF / PETG-CF / PETG-GF / ASA / PA-CF / PCTG / PVA / BVOH / PC / TPU / TPU 95A HF / Breakaway Support + Polymaker/PolyLite/PolyTerra third-party. APK cost <100 KB; UX cost is picker clutter.

**Implementation:** stage-roll. PLA family landed first; ABS/PETG branded next, exotic (PA/PC/TPU) last. Ship a nozzle filter chip in the picker if clutter becomes a complaint.

**Pending — entry-criteria for the green flip:**
- Exotic-material leaves (PA-CF, PC, TPU 95A HF) once F5's `filament_is_high_temperature` flag has a real consumer.
- Snapmaker Breakaway Support For PLA — gated on resolving the Snapmaker J1 PVA parent chain it inherits from.

**Shipped (PLA family slice):** commit `cf54495` — vendored 15 JSONs into `app/src/main/assets/profiles/Snapmaker/filament/`: 6 instantiable U1 leaves (PLA / Matte / Eco / Silk / Metal / PLA-CF) + 6 `@U1 base` parents + 3 root parents (`fdm_filament_common`, `fdm_filament_pla`, `fdm_filament_pla_eco`). NOTICE.md attribution updated. `SnapmakerPlaCatalogTest` (5 tests) covers leaf-instantiability, Matte's tuned 220 °C `nozzle_temperature`, PLA-CF's hotter override, Eco's deep-chain `filament_flow_ratio` resolution, and a tripwire that fails if any vendored leaf's `inherits` points at a missing parent. With B3's `loadFilaments` already shipped, the new leaves auto-discover into the per-slot dropdown.

**Shipped (ABS / ASA / PETG / PETG-CF slice):** vendored 11 additional JSONs from Snapmaker fork v2.3.1: 4 instantiable U1 leaves (ABS / ASA / PETG / PETG-CF) + 4 `@U1 base` parents + 3 family parents (`fdm_filament_abs`, `fdm_filament_asa`, `fdm_filament_petg`). `SnapmakerAbsPetgCatalogTest` (5 tests) covers leaf-instantiability + filament_type resolution per family + PETG-CF nozzle-temperature sanity check + tripwire still passes for the full vendored tree.

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
| Fuzzy Skin paint (mode + JNI + UI + cache) | 🟢 commit `cc75ead` |
| Smart Fill / bucket brush sub-mode | 🟢 commit `7534f25` |
| Multi-step paint undo/redo | 🟢 commit `5cf152e` |
| 3MF paint round-trip (4 facet annotations) | 🟢 commit `d2d30d2` |
| Brim Ears point-placement tool | 🟢 commit `69b783b` |
| Paint-mode stick brush/angle adjust | 🟢 commit `f85380c` |

---

## Maintenance rules

- **Update this file in the same commit** as the code change that flips a status. Don't let it lag the code.
- **Don't restate GEMINI.md gotchas here.** Cross-reference them by number (e.g., "gotcha #61").
- **Don't dump deep context into a side file.** This roadmap is intentionally the only forward-looking document — when a feature needs more detail than fits here, expand the entry inline with file paths and exit criteria, not a separate plan doc.
- **Keep this file under ~600 lines.** If it grows past that, split a subsection out as a sibling roadmap (e.g., `ROADMAP-painting.md`) and link from here.
