# FullSpectrum LayerCycle engine

Status: proposed
Owner: TBD
Estimated effort: 1–2 weeks of engine work + 1 week of hardware verification on Snapmaker U1

## Summary

OrcaXR ships **FullSpectrum Local-Z end-to-end** (patches 0044-0067, consolidated into `0053-fullspectrum-local-z-consolidated.patch`; PeggyPalette parity within ±0.3 % per slot as of 2026-05-14). What it does **not** ship is **LayerCycle without painting** — the user-facing FS mode where `wall_filament` is set to a virtual mixed-filament row and the slicer alternates the physical extruder for every wall/infill layer.

The root cause is **not** a missing patch from FS v0.9.9. Patches 0017 + 0018 + 0019 already wire the resolver chain (`MixedFilamentManager::resolve` → `ToolOrdering::resolve_filament_for_layer` → `LayerTools::extruders`). The gap is a **config propagation bug** in OrcaXR's v2.3.2 baseline: a top-level `wall_filament=<virtual id>` in the project slice config never reaches `PrintRegionConfig`, so every region keeps its default `wall_filament=1` and the FS resolver path is never consulted.

`FullSpectrumLayerCycleTest` is `@Ignore`d with this exact diagnosis (verified 2026-05-12 on Galaxy XR): *"region.config().wall_filament stays at 1 even when the slice config map says 5."* The painted-Local-Z workaround (`mmu_segmentation_facets`) is what users have today.

This proposal closes the propagation gap so LayerCycle works **without requiring the user to paint every triangle**.

## Why now

1. **GEMINI.md gotcha #20** documents the gap and references this test.
2. **Local-Z is the only working FS mode today**, and it requires explicit paint operations. LayerCycle is the easier UX (set virtual row in `MixedAdvancedEditor`, every wall alternates, no paint needed) — exactly what FS desktop users expect.
3. **Pointillisme is `#if 0`'d upstream** (FS v0.9.9), so the next FS-mode win is LayerCycle, not Pointillisme.
4. **The fix is small** compared to the Local-Z port: this is hundreds of LoC of config plumbing, not thousands of LoC of a new sub-Z planner.

## Approach

A four-phase, **shippable-at-each-phase** plan. Each phase ends with an instrumented test removed from `@Ignore` and a single commit on `main`. No big-bang merges. No half-finished patches.

### Phase 1 — Diagnose the propagation gap (1–2 days)

**Goal:** identify exactly which call frame drops the virtual filament id between `new_full_config["wall_filament"]=5` (project config map) and `PrintObject::region(0).config().wall_filament=1`.

Three suspects, in priority order:

1. **`Print::apply` config-diff** at `PrintApply.cpp:1325-1410`. `m_default_region_config.diff(new_full_config)` may not include `wall_filament` in `region_diff` if the static `PrintRegionConfig` defaults already register `wall_filament=5` (unlikely but worth confirming via a log probe).
2. **`apply_to_print_region_config`** chain inside `region_config_from_model_volume` (PrintObject.cpp:3399-3450). This walks ModelObject → ModelVolume → material configs; if any of them carry an explicit `wall_filament=1` (e.g. from a previously-loaded 3MF object config), they will silently shadow the project default.
3. **`get_create_region`** dedup (PrintApply.cpp:1057). Region identity is hashed; if the hash key omits `wall_filament`, the old region is reused with stale config.

**Deliverable:** a one-page write-up at `docs/A9_PHASE1_LAYERCYCLE_DIAG.md` (parallel to `A9_PHASE2_AUDIT.md`) recording which frame is at fault, with a diagnostic patch in the working tree (`logf("[FS-LC] wall_filament prop: ...")` in three places). Patch is removed once Phase 2 lands.

**Tooling:** the FS desktop instrumented build (`ratdoux/OrcaSlicer-FullSpectrum` at tag `v0.9.9`) is the canonical reference. Compare the log output from a 4-physical + 1-virtual LayerCycle slice on FS desktop vs. OrcaXR for the same project. Whichever frame logs a different value is the bug site.

### Phase 2 — Fix the propagation (3–5 days)

**Goal:** make `region.config().wall_filament` reflect the project config map for **fresh** Print loads (no held-over ModelObject state) and for **3MF-loaded** projects (where ModelObject config does carry `wall_filament`, but should still be overridable at the project level).

Likely shapes the fix takes, depending on which Phase 1 frame is the root cause:

- **If `apply_to_print_region_config` is the issue** (most likely): add a patch `0054-fullspectrum-region-config-virtual-filament-propagation.patch` that allows the project-level config to override ModelObject `wall_filament` when the project value targets a virtual row (i.e., `wall_filament > num_physical_filaments`). This is the FS-desktop semantic. ModelObject overrides are still honored for physical filament selection.
- **If `region_diff` is the issue**: extend the diff allowlist in `PrintApply.cpp:1325` to always re-check the three FS-relevant region keys (`wall_filament`, `solid_infill_filament`, `sparse_infill_filament`) on virtual-row config changes. A patch in `0054` of similar scope.
- **If `get_create_region` is the issue**: include `wall_filament` / `solid_infill_filament` / `sparse_infill_filament` in the region hash key so virtual-row changes force a new region instance. ~10 LoC.

**Acceptance criteria for Phase 2:**

1. **Headless smoke test** (new, JVM-only): construct a `DynamicPrintConfig` with one virtual mixed-filament row + `wall_filament=5`, apply via `Print::apply`, assert `print.regions()[0].config().wall_filament == 5`. Lives in `app/src/androidTest/java/dev/orcaxr/app/FullSpectrumWallFilamentPropagationTest.kt`.
2. **No regression in the Local-Z parity test** (`PeggyPaletteFullSpectrumParityTest`). The PeggyPalette slice is painted-Local-Z and must stay within ±2 % per slot.

### Phase 3 — Un-ignore `FullSpectrumLayerCycleTest` and harden (2–3 days)

**Goal:** the bundled `FullSpectrumLayerCycleTest` passes on a connected arm64-v8a Android device (Pixel 10 Pro XL or Galaxy XR; both are confirmed-attached today).

Tasks:

- Remove the `@Ignore` annotation in `FullSpectrumLayerCycleTest.kt:46`.
- Confirm the existing assertions hold:
  - `T0` count ≥ 1
  - `T1` count ≥ 1
  - Ratio of `T0/T1` is in `[0.2, 5.0]` (sanity bound on cycle balance)
- **Add a stricter assertion**: for a 20 mm cube at 0.2 mm layer height (≈ 100 layers) with one LayerCycle row mixing T0 + T1 at 1:1 ratio, expect ≥ 40 of each toolchange. (Current bounds permit a 5× imbalance, which is too lax once the path is real.)
- **Add a third assertion**: every odd layer index emits T0, every even layer index emits T1 (or vice versa, depending on which extruder seeded the cycle). Parses the G-code's `;LAYER:` comments + the following T-command. Catches a regression in the modulo-cycle math in `MixedFilament.cpp::resolve`.

### Phase 4 — UX surface and hardware verification (3–5 days)

**Goal:** a user can author a LayerCycle row in the XR + mobile UI (no special config needed), slice, and print on the Snapmaker U1 with alternating-extruder layers visible in the print.

Tasks:

1. **MixedAdvancedEditor** already speaks the v0.9.9 wire format (per GEMINI.md gotcha #20). Audit that the "LayerCycle" distribution mode is the default for a new row when the user adds one — and that the `wall_filament=<virtual id>` is automatically set in the slice config when a row is enabled (currently the user has to know to override `wall_filament` manually, which is a sharp edge).
2. **Profile-level toggle** on the U1 profile: "Use FullSpectrum LayerCycle for walls" — a single switch that maps to `wall_filament=<first enabled virtual row id>` in the merged slice config. Avoids the user having to think about 1-based virtual filament IDs.
3. **MCP tool** for AI-driven access: `set_layer_cycle_walls(printer_id, row_index)` so OrcaAI can toggle it via natural language. Mirror the existing `set_mixed_filament_row` / `list_mixed_filaments` pattern.
4. **Hardware print** on Snapmaker U1: a small two-color test object (20 mm cube, A=red PLA, B=white PLA, 1:1 LayerCycle). Confirm visible horizontal bands in the printed part — that's the FS "layer cake" effect. Document the result in `docs/A9_PHASE3_LAYERCYCLE_HW.md`.

## What this proposal does **not** change

- **Local-Z** stays as-is. PeggyPalette parity must not regress.
- **Pointillisme** stays gated. Upstream FS v0.9.9 has it `#if 0`'d (GEMINI.md gotcha at line 255); we wait for v0.9.10+.
- **The 17 FullSpectrum PrintConfig keys** registered in patch 0016 stay as-is. No new config keys needed for LayerCycle.
- **The MixedFilamentManager wire format** is frozen at FS v0.9.9 parity — no Kotlin-side or 3MF-side schema changes.

## Risks and open questions

1. **Phase 1 may find that the propagation gap is in upstream OrcaSlicer v2.3.2, not in OrcaXR's patches** — i.e. v2.3.2 introduced a regression that FS v0.9.9 doesn't have (FS sits on Snapmaker/OrcaSlicer 2.3, an older base). If so, the fix is closer to a backport of FS's v0.9.9 `PrintApply.cpp` than a small patch. Mitigation: scope Phase 2 as up-to-three-day investigation; if the diff balloons, return to the user with options before merging.
2. **Per-region config dedup** (`get_create_region`) is shared with the painted-Local-Z path. If we change the region hash key, we risk doubling the region count on PeggyPalette (38 painted slots → 38 regions today; could become 38×N if the hash includes more keys). Mitigation: the Phase 2 test must include PeggyPalette and assert region count is unchanged.
3. **ModelObject overrides** are a legitimate user knob (per-object wall filament). Phase 2's fix must preserve that semantic for **physical** filament IDs; only virtual-row IDs (`wall_filament > num_physical_filaments`) follow the project-default override path. Otherwise we break a use case OrcaSlicer desktop users rely on.
4. **`enable_infill_filament_override`** (PrintRegion.cpp:18) is the ternary between `sparse_infill_filament` and `wall_filament`. Its propagation needs to be checked alongside `wall_filament` in Phase 1 — a fix that propagates `wall_filament` but not this toggle will surface as "walls alternate, infill doesn't."

## Testing pyramid

- **JVM unit** (`FullSpectrumWallFilamentPropagationTest`): config-apply propagation only. Runs on every CI build, no native dependency beyond `libslic3r_jni.so`.
- **Instrumented headless** (`FullSpectrumLayerCycleTest`, un-ignored at Phase 3): slice a 20 mm cube, assert T0/T1 alternation in the emitted G-code. Runs on connected arm64-v8a device (`./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=dev.orcaxr.app.FullSpectrumLayerCycleTest`).
- **Instrumented regression** (`PeggyPaletteFullSpectrumParityTest`): painted-Local-Z parity ±2 % per slot. Must stay green.
- **Hardware print** (Phase 4 acceptance): visible-bands test on Snapmaker U1. Photo in `docs/A9_PHASE3_LAYERCYCLE_HW.md`.

## Source-of-truth references

- **FS desktop**: `ratdoux/OrcaSlicer-FullSpectrum` at tag `v0.9.9` (commit `b3c41fda`). FS sits on Snapmaker/OrcaSlicer 2.3, not upstream Org/v2.3.2 — read **semantically**, not via `git apply`.
- **The propagation chain in our tree**:
  - `third_party/OrcaSlicer/src/libslic3r/PrintApply.cpp:1325-1410` (region_diff + apply_only)
  - `third_party/OrcaSlicer/src/libslic3r/PrintObject.cpp:3399-3450` (`region_config_from_model_volume`)
  - `third_party/OrcaSlicer/src/libslic3r/PrintApply.cpp:1057` (`get_create_region` dedup)
- **The resolver chain (already shipped)**:
  - Patch 0015 — `MixedFilament.cpp::resolve` (LayerCycle modulo math at lines 1980-1988)
  - Patch 0018 — `PrintApply.cpp:1361-1364` (`load_custom_entries`)
  - Patch 0019 — `ToolOrdering.cpp:693-710 + 749 + 780-784` (`resolve_filament_for_layer` lambda + four call sites)

## Self-update mandate hook

If any claim in this doc becomes wrong (e.g. the propagation gap turns out to be elsewhere, or Pointillisme un-gates upstream and we want to chain it), fix this file in the same commit as the code change. Don't append errata.

The GEMINI.md text at line 255 currently states the gap as "patches still required" with a long list — that paragraph **must be rewritten** when Phase 2 lands, since the gap will then be propagation-only, not patch-set-missing.
