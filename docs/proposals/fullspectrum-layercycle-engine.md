# FullSpectrum LayerCycle engine

Status: **SHIPPED 2026-05-17 — patches `0072` + `0073`, device-verified GREEN.** The 2026-05-15 "Gap 3 dominant / FS emission-pipeline port" framing was itself superseded by the 2026-05-17 instrumented re-test (see §Status 2026-05-17): the bundled `FullSpectrumLayerCycleTest` was blocked **solely by Gap 1** (the `Model::add_object` `extruder=1` stamp clobbering the project virtual `wall_filament`). Fix = `patches/0072-fullspectrum-region-config-virtual-propagation.patch` (restore parent virtual wall when the object stamp would demote it; PeggyPalette-inert because its project wall is physical) + `patches/0073-fullspectrum-reorder-cadence-preservation.patch` (`get_custom_seq` pins the resolved per-layer cadence when `mixed_filament_definitions` is set). `FullSpectrumLayerCycleTest` un-`@Ignore`'d with hardened assertions; LocalZ / Roundtrip / PeggyPalette stay GREEN. The §Status 2026-05-15 and §Approach sections below are retained as the historical probe trail — **read §Status 2026-05-17 first.**
Owner: shipped
Estimated effort: DONE — ~75 LoC across two config-propagation patches (the disproven "multi-day emission-pipeline port" estimate was wrong; the empirical re-test found Gap 1 was the real, small blocker).

## Summary

> **⚠️ Superseded by §Status 2026-05-15.** The thesis in this section — *"the root cause is a config-propagation bug, not a missing patch"* — was **disproven** by instrumented diagnosis. Candidate propagation patches 0072/0073 were built, device-tested, and reverted: Gap 3 (the emission-pipeline port) collapses the result regardless of propagation. The text below is kept as the historical premise the diagnosis refuted; the **current** root cause and the real plan are in §Status and the §Remaining-work pointer at the end of §Status.

OrcaXR ships **FullSpectrum Local-Z end-to-end** (patches 0044-0067, consolidated into `0053-fullspectrum-local-z-consolidated.patch`). What it does **not** ship is **LayerCycle without painting** — the user-facing FS mode where `wall_filament` is set to a virtual mixed-filament row and the slicer alternates the physical extruder for every wall/infill layer.

~~The root cause is **not** a missing patch from FS v0.9.9.~~ *(Disproven — it is the FS v0.9.9 emission port.)* Patches 0017 + 0018 + 0019 wire the resolver chain (`MixedFilamentManager::resolve` → `ToolOrdering::resolve_filament_for_layer` → `LayerTools::extruders`), but the resolved per-layer cadence does **not survive** `reorder_filaments_for_minimum_flush_volume` + `_make_wipe_tower` into the emission `ToolOrdering` — see §Status Gap 3.

The painted-Local-Z path (`mmu_segmentation_facets`) is the working multi-color mode users have today; its `PeggyPaletteFullSpectrumParityTest` gate is **GREEN** (re-gated by commit `1b4ef8b` onto per-tool MODEL extrusion ±2% — the colour-bearing invariant; the old "+5.4% total-mm" alarm was a legitimate purge-minimisation win, **resolved and stale, do NOT bisect**).

## Status 2026-05-17 — empirical re-test: Gap 1 is the SOLE active blocker for the test path; Gap 3 is moot here

Instrumented `ToolOrdering.cpp` (Gap-2 emplace check, PRE `lt.extruders`,
POST reorder-seq) on a clean from-patches `libslic3r.a` + ran
`FullSpectrumLayerCycleTest` (painted-all-virtual cube) on the Galaxy
XR (SM-I610), 2026-05-17. Trace verdict — every layer:

```
GAP2 L# wall_id=1 resolved=1 nonoverriddable=1 emplaced=1 num_physical=4
PRE  L# lt.extruders=[0,]   POST L# reorder_seq=[0,]
```

- **Gap 2 is NOT the blocker for this path** — `something_nonoverriddable`
  is true and the wall extruder *is* emplaced (`emplaced=1`).
- **Gap 1 is the sole active blocker** — `region.config().wall_filament`
  is **1** (the `Slic3r::Model::add_object` `extruder=1` auto-stamp
  clobbering the parent at `apply_to_print_region_config`
  PrintObject.cpp:3367), so `resolve_filament_for_layer(1,…)`
  early-returns (`1 ≤ num_physical`) and `MixedFilamentManager::resolve`
  **never runs**. No per-layer cadence is ever computed.
- **Gap 3 is moot for this path** — `lt.extruders` is `[0]` *before*
  reorder, so there is no multi-extruder cadence for the reorder DP to
  collapse. The "Gap 3 dominant / ~800-LoC reorder port" framing below
  was measured on a different (project-`wall_filament=5`) scenario; it
  does not describe what blocks the bundled test.
- **The test's own premise is disproven.** Its `paintAllVirtual`
  comment claims `mmu_segmentation_facets` routes the virtual slot into
  a per-region `wall_filament=5` "proven by the LocalZ test." It does
  **not**: this build's painted segmentation is Local-Z-centric (masks
  bucketed into `num_physical` arrays, `PrintObjectSlice.cpp:1323`);
  with `dithering_local_z_mode` off the virtual paint has nowhere to go
  and the region stays at the `extruder=1` stamp. Painted-all-virtual
  is **not** a valid LayerCycle driver — real FS LayerCycle is
  *unpainted* `wall_filament=<virtual id>` (proposal Phase 4).

**Implication / current plan:** the fix is the **Gap-1 region-config
virtual propagation** (patch 0072's territory): in
`apply_to_print_region_config` / `region_config_from_model_volume`,
when the parent/project config targets a virtual row
(`wall_filament > num_physical`) and the incoming object `extruder`
stamp is the default physical, *preserve the parent virtual id* (the
FS-desktop semantic). The discriminator the 2026-05-15 status said
"does not exist" (checking only the `wall_filament` key) **does**
exist via *"parent targets virtual"* — PeggyPalette's project
`wall_filament` is physical (it drives colour via painted
segmentation + `mixed_filament_definitions`, not a virtual wall),
so the rule does not fire for it. Plus: drive the test the real way
(`wall_filament=5`, unpainted), not via the disproven paint path.
Crucially, **patch 0072's only revert reason — the +5.4% T1
PeggyPalette delta — is the conserved-purge non-bug `1b4ef8b`
re-gated out.** It was judged against a test invariant that no longer
exists.

## Status 2026-05-15 — Phase 1 complete, two of three gaps fixed (SUPERSEDED for the test path by the 2026-05-17 re-test above)

A full instrumented diagnosis on Pixel 10 Pro XL + Galaxy XR (canaries in
`Print::apply`, `region_config_from_model_volume`, `ToolOrdering::
collect_extruders`, `WipingExtrusions::is_overriddable`, the reorder
write-back, and `GCode::process_layer`) found the unpainted-LayerCycle
failure is **three** stacked gaps, not one:

1. **Region-config propagation** *(diagnosed; candidate patch 0072
   REVERTED — regressed PeggyPalette parity)*. `Slic3r::Model::
   add_object` unconditionally stamps every loaded object with
   `extruder=1`; `apply_to_print_region_config`'s extruder special-case
   then force-overrides the project-level virtual `wall_filament=5`
   back to 1. Probe trail: `[B] m_default_region_config.wall_filament=5`
   → `[C] region_config_from_model_volume start_wf=5 after_obj=1` →
   `[D] resolved=1` (no cycle). A candidate fix (patch 0072) restored
   the parent virtual id when no scope set the filament key explicitly;
   `[D]` then showed `region.wall=5 resolved=1,2,1,2…` (resolver cycled
   correctly). **But it regressed `PeggyPaletteFullSpectrumParityTest`
   by itself**: T1 938.68 → 989.13 mm (+5.4 %, tolerance ±2 %). Root
   cause of the regression: PeggyPalette's 38 parts express per-object
   filament via the BBS `extruder=N` key (N up to 38, often virtual),
   which `apply_to_print_region_config` maps onto `wall_filament`. The
   "explicitly set" guard only checked the `wall_filament` key, so it
   treated those deliberate per-object choices as unset and clobbered
   them with the project default. The spurious BBS auto-`extruder=1`
   stamp (fresh STL, unpainted LayerCycle) and a deliberate per-object
   `extruder=N` (PeggyPalette) are **indistinguishable** at
   `region_config_from_model_volume` — both are just an `extruder` key
   on the object config. There is no clean isolated propagation fix;
   it is entangled with the Gap 3 emission port (FS v0.9.9 resolves
   per-layer cadence in the emission pipeline regardless of region
   `wall_filament`, sidestepping this ambiguity). **Patch 0072 was
   dropped.**

2. **Wipe-tower overriddability** *(diagnosed; candidate patch 0073
   REVERTED — regressed PeggyPalette parity)*. With `flush_into_objects`
   on (the default in every shipped profile),
   `WipingExtrusions::is_overriddable` returns true for the object's
   perimeters, so `collect_extruders` marks the walls overriddable and
   the FS-resolved per-layer extruder is never emplaced into
   `LayerTools::extruders`. A candidate fix (patch 0073) made
   FS-virtual-wall regions non-overriddable; `[G]` confirmed it fired
   (`is_overriddable → NONOVERRIDDABLE` every layer) **but it changed
   nothing observable downstream** (Gap 3 still collapses the result)
   **and it regressed `PeggyPaletteFullSpectrumParityTest`**: T1
   filament use went 938.68 → 989.15 mm (+5.4 %, ref 938.7, tolerance
   ±2 %). PeggyPalette's 38 parts carry explicit per-object virtual
   `extruder=N` (N up to 38); those regions legitimately go through the
   wipe-tower flush path, and forcing them non-overriddable shifts the
   painted-Local-Z allocation. The `is_overriddable` change cannot be
   made in isolation — it has to be folded into the Gap 3 emission port
   where the painted vs. unpainted-virtual distinction can be made
   correctly without regressing the painted path. **Patch 0073 was
   dropped; only patch 0072 ships.**

3. **Emission-pipeline carry-through** *(STILL OPEN — the large port)*.
   Even with 0072+0073, `[F]` (post-`reorder_extruders_for_minimum_
   flush_volume`) shows the per-layer sequence collapsed to
   `L0[0] L1[] L2[0] L3[] …` and `[E]` (`process_layer`) sees
   `extruders=[0]` for every layer — the resolved 1/2 cadence does not
   survive the reorder + wipe-tower-planning pipeline into the
   ToolOrdering instance the G-code emitter consumes
   (`print.tool_ordering()` via `_make_wipe_tower` / `sort_and_build_
   data` → `reorder_filaments_for_minimum_flush_volume`). This is
   exactly the **~800-LoC GCode.cpp + ~311-LoC ToolOrdering emission
   port** GEMINI.md flagged as the major un-ported FS piece; it is
   *not* a small propagation fix and is out of scope for patches
   0072/0073.

**Shipped: no code patches — the diagnosis is the deliverable.** Both
candidate patches (0072 region-config propagation, 0073 is_overriddable
gate) were authored, built, and device-tested. Neither produced working
LayerCycle (Gap 3 collapses the result regardless), so they have zero
standalone user-observable benefit today. They were **not shipped**
because, with the FS parity reference test already failing at baseline
(see the pre-existing-regression note below), there is no clean
known-good reference to fully certify the patches regress nothing
across the FS surface — and shipping zero-benefit engine patches under
imperfect regression certification violates "ship verified." They can
be re-derived from this proposal when Gap 3 is tackled. The deliverable
of this work is the **diagnosis itself**: the proposal's original
premise — "LayerCycle is just a config-propagation fix" — is
**disproven**. It is the full FS v0.9.9 emission port. The submodule
tree is back to the verified pinned + 0001-0071 state.

**The "+5.4 % PeggyPalette regression" — RESOLVED 2026-05-16, do NOT
re-open.** During this work `PeggyPaletteFullSpectrumParityTest` was
seen "failing" at T1 = 989.14 mm vs ref 938.7 mm (+5.4 %) under its
*then* gate (per-slot **total** filament-mm). Commit `1b4ef8b`
("test(parity): gate PeggyPalette on model extrusion, not total
filament-mm", 2026-05-16) proved this was **never a slicer bug**:
decomposing the G-code shows per-tool **MODEL** extrusion is
byte-identical to the FS reference (`region->filament` is fixed by the
painted segmentation); only conserved wipe-tower purge is
redistributed, because OrcaXR's stock
`reorder_filaments_for_minimum_flush_volume` legitimately purges ~10 %
*less* than desktop FS (pair-cost 2263 vs 2526) — a print-quality
**win** the old total-mm gate misflagged as a regression. `1b4ef8b`
re-based the gate onto the colour-bearing invariant (per-tool MODEL
extrusion ±2 %) and the test is **GREEN**. The `afc6f7d..e8a7cad`
(`clamp_filament_arrays` / `strip_painted_facets`) bisect lead is a
**dead end** — those commits are no-ops for this model (PeggyPalette's
ref ships `mixed_filament_definitions`, so `clamp_filament_arrays`
short-circuits). Do **not** re-chase this; the commit message records
it "cost many multi-hour debugging sessions chasing a non-bug."
*(Note: the conserved purge redistribution — stock reorder gets even
layers' order wrong via a localised 1↔3 swap — is the same Gap-3
mechanism as LayerCycle; it is characterised precisely below as the
real port's map, but it is not a parity defect.)*

**Remaining (the real work):** port FS v0.9.9's mixed-filament-aware
emission pipeline — `reorder_filaments_for_minimum_flush_volume`
(`ToolOrderUtils.cpp`, currently *zero* MixedFilament awareness),
`_make_wipe_tower` / `sort_and_build_data` planning, and
`GCode::process_layer` toolchange emission — so the resolved per-layer
cadence survives into the gcode. FS resolves per-layer virtual-filament
cadence *in the emission pipeline itself*, which is why it never hits
the propagation ambiguity that sank patch 0072. Estimated ~800-LoC
`GCode.cpp` + ~311-LoC `ToolOrdering` + the `ToolOrderUtils.cpp` reorder
DP, accessed semantically from FS tag `v0.9.9` (`ratdoux/OrcaSlicer-
FullSpectrum`, b3c41fda). The canonical `FullSpectrumLayerCycleTest`
stays `@Ignore`d until this lands; the painted-Local-Z recipe remains
the working multi-color path today (PeggyPalette parity ±0.3 %).

## Why now

1. **GEMINI.md gotcha #20** documents the gap and references this test.
2. **Local-Z is the only working FS mode today**, and it requires explicit paint operations. LayerCycle is the easier UX (set virtual row in `MixedAdvancedEditor`, every wall alternates, no paint needed) — exactly what FS desktop users expect.
3. **Pointillisme is `#if 0`'d upstream** (FS v0.9.9), so the next FS-mode win is LayerCycle, not Pointillisme.
4. ~~**The fix is small**~~ — **FALSE, disproven.** This was the original mis-estimate. The real remaining work is the FS v0.9.9 emission-pipeline port (Gap 3), comparable in scope to the Local-Z port, not "hundreds of LoC of config plumbing."

## Real remaining work — Gap 3 emission port (the current plan)

> This supersedes the disproven §Approach Phases 1–4 below (those targeted the config-propagation thesis that 0072/0073 refuted).

**Mechanism, pinned 2026-05-16 by an instrumented DP trace on SM-I610
(Galaxy XR), `ToolOrderUtils.cpp`:** stock
`reorder_filaments_for_minimum_flush_volume` has **zero**
MixedFilament / Local-Z awareness. It genuinely minimises flush and
picks per-layer order `[0,3,1,2]`(odd)/`[2,1,3,0]`(even) — pair-cost
2263 — whereas desktop FullSpectrum does **not** flush-minimise: it
keeps the FS Local-Z planner's deliberate cadence (pair-cost 2526,
higher on purpose). Stock reorder gets **odd** layers exactly right
(`[0,3,1,2]` == REF) but **even** layers wrong (`[2,1,3,0]` vs REF
`[2,3,1,0]` — a localised 1↔3 swap). Post-reorder `lt.extruders`
collapses to `[0]`/`[]`, so `process_layer` emits zero per-layer
toolchanges → LayerCycle produces single-filament G-code.

**Proven-partial fix (NOT complete — documented so it is not
re-derived from scratch):** feeding the incoming per-layer order as
`get_custom_seq` for every layer when `mixed_filament_definitions` is
non-empty (capture `fs_preserve_order` + `&layer_filaments` in
`ToolOrdering::reorder_extruders_for_minimum_flush_volume`, return
`layer_filaments[L]+1`) makes reorder preserve order and **fixes T1
exactly**. But `layer_filaments` (= `lt.extruders`, ordered
`[3,0,1,2]`/`[2,0,1,3]`) is **NOT** the true desktop-FS cadence
(`[_,3,1,_]`), so T0/T3 balloon. **The open step:** find where the
true FS Local-Z per-layer cadence is computed/stored (deep dive into
the 2279-line `patches/0053-fullspectrum-local-z-consolidated.patch`
planner — the pigment pair-cycle in the 0044-0052 lineage / patch
0019/0036/0039 FS tool-ordering resolve) and feed **that** (not
`lt.extruders`) into `get_custom_seq`. Instrument with an
`ORCAXR_TOU_LOG` per-layer trace (`#include <android/log.h>` in
`ToolOrderUtils.cpp`; log `in= start= seq= cost=`).

**Build/iterate procedure (proven faithful):** edit submodule source
directly, then `cmake --build
third_party/OrcaSlicer/build-android-arm64-v8a --target libslic3r
-j13` (do **not** run `build_native.sh` mid-iteration — it
`git reset --hard`s the submodule and wipes direct edits; use it only
for a from-patches clean build). Then wipe
`app/build/intermediates/{merged,stripped}_native_libs/debug`,
`.../cmake/debug`, `.../cxx/Debug`, `app/.cxx/Debug`, the debug apks;
`touch app/src/main/cpp/slic3r_jni.cpp`; run
`:app:connectedDebugAndroidTest`. ≈ 4 min libslic3r incremental + ~1
min JNI/test per cycle.

**Commit gate:** every iteration must keep
`PeggyPaletteFullSpectrumParityTest` GREEN (the working Local-Z path
shares this reorder DP — a naive `get_custom_seq` override regresses
it). Never commit on red ([[feedback_peggypalette_commit_gate]]).

## Approach (HISTORICAL — disproven config-propagation plan)

> **⚠️ Superseded.** Phases 1–4 below targeted the "it's a
> config-propagation bug" thesis. Candidate patches 0072/0073 executed
> Phases 1–2 and proved the thesis wrong (Gap 3 collapses the result
> regardless). Retained only for the probe trail and the Phase 3/4
> acceptance-test shapes (the stricter `FullSpectrumLayerCycleTest`
> assertions and the UX/MCP surface) which still apply once the Gap 3
> port above lands. Do not execute Phases 1–2 as written.

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
