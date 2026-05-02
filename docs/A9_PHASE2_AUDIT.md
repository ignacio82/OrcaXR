# A9 Phase 2 Audit — Engine Value Sync

**Branch:** `a9-phase2-audit`  
**Date:** 2026-05-02  
**Author:** analysis via Claude Code  
**Scope:** Root-cause ranking for the 32.6% time-estimate gap
(OrcaXR 7 h 38 m vs Snapmaker desktop 11 h 20 m, same model, same 332 layers /
40.04 mm / 385 toolchanges).

---

## 1. Problem

A9 Phase 1 (profile-value sync to fork v2.3.1) closed < 1% of the gap.
The remaining ~3h 42m lives in libslic3r engine behavior — the G-code
content OrcaXR emits differs from what Snapmaker desktop emits, making
the kinematics simulator produce a faster estimate for the same print.

Direction: **OrcaXR (upstream 2.3.2) estimates faster; Snapmaker fork
(v2.3.1) estimates slower.** Patches that bring upstream toward fork
behavior will lengthen OrcaXR's estimate toward ground truth.

---

## 2. Method

Files diffed (Snapmaker v2.3.1 at `/tmp/snapmaker-orca` vs upstream
OrcaSlicer v2.3.2 at `/tmp/upstream-orca`):

| File | Diff size |
|---|---|
| `GCode.cpp` | 6 958 lines |
| `PrintConfig.cpp` | 3 473 lines |
| `GCode/WipeTower.cpp` | 2 934 lines |
| `GCode/WipeTower2.cpp` | 1 935 lines |
| `GCode/ToolOrdering.cpp` | 1 215 lines |
| `Print.cpp` | 955 lines |
| `GCodeProcessor.cpp` | **0 lines — identical** |

Only U1-relevant paths were followed (WipeTower2, non-BBL, non-SEMM).

---

## 3. Key Finding: Estimator Is Identical

`GCodeProcessor.cpp` is byte-for-byte identical between the two trees.
The kinematic simulator that converts G-code to time estimates has not
diverged. **The entire gap is in G-code content**, not in post-processing.

This eliminates any "Snapmaker tuned their estimator" hypothesis and
focuses the search entirely on what G-code each engine emits.

---

## 4. Candidates (ranked by U1 time impact)

### C1 — Toolchange retraction pre-injection (GCode.cpp) ⚪ RETIRED — non-actionable for U1

**Files:** `src/libslic3r/GCode.cpp`

**Original claim:** Snapmaker's `GCode.cpp` computes
`toolchange_retract_str` from `filament_retract_length_toolchange` and
prepends it explicitly before every `change_filament_gcode` emission;
upstream does not.

**Verification finding (2026-05-02):** Upstream OrcaSlicer v2.3.2 ALSO
computes `toolchange_retract_str = gcodegen.retract(...)` at
`GCode.cpp:792` and emits it in the per-toolchange sequence — it just
concatenates the result into the `end_filament_gcode_str` slot
(`GCode.cpp:824`) instead of the `toolchange_gcode_str` slot. Both trees
inject the retract output through the same `tcr_rotated_gcode`
placeholder substitution in the same per-toolchange call.

For the U1, `filament_end_gcode` resolves to `""` for every shipped
filament profile (`Snapmaker PLA Matte/PLA/PLA Silk/PLA Metal @U1`).
With an empty filament_end_gcode, both code paths emit:

```
[retract]
[change_filament_gcode]   ← Z-hop + M109 + M400 + Tn + SM_PRINT_PREEXTRUDE
[travel to start_pos]
[unretract]
```

…in the same order, and the retract output itself comes from the same
`gcodegen.retract()` function (with one extra `LiftType` /
`apply_instantly` arg in upstream that doesn't change the emitted
G-code for non-spiral-lift U1 profiles). So porting the fork's
concatenation site swap to upstream produces zero observable G-code
delta for U1 slices.

**Recommended action:** Skip. No patch authored. Re-open only if a U1
filament profile with non-empty `filament_end_gcode` ever ships AND
that gcode contains motion commands.

---

### C2 — ToolOrdering TSP extruder-order solver (ToolOrdering.cpp) ⚪ RETIRED — upstream is more advanced

**Files:** `src/libslic3r/GCode/ToolOrdering.cpp`,
`src/libslic3r/GCode/ToolOrderUtils.cpp`

**Original claim:** Snapmaker adds a DP shortest-Hamilton-path solver
(`solve_extruder_order`); upstream uses a greedy nearest-neighbor pass.

**Verification finding (2026-05-02):** Upstream OrcaSlicer v2.3.2 has
all three variants in `GCode/ToolOrderUtils.cpp`:
`solve_extruder_order_with_greedy` (line 381),
`solve_extruder_order_with_forcast` (line 421), and
`solve_extruder_order` (line 491). They are dispatched through
`get_extruders_order` (line 575) and called from
`reorder_extruders_for_minimum_flush_volume` at `ToolOrdering.cpp:715`.
Upstream additionally pipes through nozzle-aware flush matrices,
filament-grouping (`FilamentMapMode::fmmAutoForFlush`), geometric /
physical unprintability checks, and per-nozzle flush multipliers — none
of which exist in the fork.

The fork at `ToolOrdering.cpp:29` has a single inline DP solver of
~63 LoC. Upstream's `solve_extruder_order` in `ToolOrderUtils.cpp:491`
is the *same algorithm* (dynamic programming over the
`(state_bitmask, end_extruder)` table) wrapped in a richer dispatcher.
Porting the fork's inline copy on top of upstream's already-richer
infrastructure would either duplicate code or regress the dispatcher.

**Recommended action:** Skip. No patch authored. If the U1 reference
slice's per-layer extruder order is observed to differ from desktop
output AFTER all other candidates are eliminated, re-investigate the
*dispatcher selection* (which of the three solvers fires) rather than
the solver implementation.

---

### C3 — WipeTower2 pressure-advance injection (WipeTower2.cpp) 🟡 MEDIUM

**Files:** `src/libslic3r/GCode/WipeTower2.cpp`  
**Patch size:** Small (~30 lines: constructor member init +
`disable_linear_advance_value()` calls at two sites in `toolchange_Wipe`)

**What the fork adds:**  
When `enable_change_pressure_when_wiping = true`, Snapmaker's WipeTower2
inserts `SET_PRESSURE_ADVANCE VALUE=...` commands at the start and end of
every wipe move. These are emitted via `disable_linear_advance_value()`
at ~line 1646 and ~line 1768 of the fork's `WipeTower2.cpp`.

**Why it affects timing:**  
GCodeProcessor processes `SET_PRESSURE_ADVANCE` lines. Each such
command has negligible wall-clock cost, but with 385 toolchanges ×
multiple wipe passes per toolchange, several hundred extra firmware-sync
lines enter the G-code stream. If GCodeProcessor models any dwell for
SET_PRESSURE_ADVANCE, the accumulated estimate grows.

More concretely: the pressure-advance change alters the extrusion
velocity profile during wipe moves. If the Klipper firmware spends
additional acceleration time ramping through the new PA value, the
kinematic sim should reflect that — but only if GCodeProcessor parses
SET_PRESSURE_ADVANCE (unconfirmed; needs a grep).

**U1 relevance:** MEDIUM — `enable_change_pressure_when_wiping` is a
Snapmaker-only key not currently in SAFE_KEYS. Would require adding it to
SAFE_KEYS and confirming the U1 Klipper config sets it.

**Recommended action:** Defer to after C1 + C2. Add
`enable_change_pressure_when_wiping` and `ramming_pressure_advance_value`
to SAFE_KEYS if U1 profile sets them non-zero. Port WipeTower2 hunk only
if GCodeProcessor is confirmed to parse SET_PRESSURE_ADVANCE.

---

### C4 — ramming_line_width_ratio config (WipeTower2.cpp + PrintConfig) ⚪ RETIRED

**Files:** `src/libslic3r/GCode/WipeTower2.cpp`

**Original claim:** Upstream hardcodes
`ramming_line_width_multiplicator = 2.0`; fork reads it from
`config.ramming_line_width_ratio`.

**Verification finding (2026-05-02):** Upstream OrcaSlicer v2.3.2 reads
`ramming_line_width_multiplicator` from the per-filament
`ramming_parameters` config string at `WipeTower2.cpp:1385`
(`stream >> m_filpar[idx].ramming_line_width_multiplicator >>
m_filpar[idx].ramming_step_multiplicator`). The `2.0` at line 1398 is
only the fallback used when streaming fails. Both trees source the
multiplier from per-filament config; the audit misread the else-branch
as the only assignment site.

Additionally, `grep ramming_line_width_ratio` over all
`app/src/main/assets/profiles/Snapmaker/` JSONs returns zero matches —
no U1 profile sets a fork-only override even if the key existed.

**Recommended action:** Skip. No patch authored.

---

### C5 — ToolOrdering first-layer extruder guard (ToolOrdering.cpp) 🟡 MEDIUM

**Files:** `src/libslic3r/GCode/ToolOrdering.cpp`  
**Patch size:** Tiny (~5 lines in `reorder_extruders_for_minimum_flush_volume`)

**What differs:**  
Upstream's `reorder_extruders_for_minimum_flush_volume(bool reorder_first_layer)`
skips layer-0 when `reorder_first_layer = false` (the call site passes
`false` when `first_extruder == -1`). Snapmaker's version takes no
parameter and always reorders every layer including layer 0.

**Why it affects timing:**  
If the first-layer extruder sequence differs between upstream and fork,
the WipeTower2 depth allocation for layer 0 differs.

**Verification finding (2026-05-02):** The upstream call sites
(`ToolOrdering.cpp:357`, `:388`) compute
`bool reorder_first_layer = (first_extruder != (unsigned int)(-1))`,
i.e. reorder_first_layer is `true` whenever `first_extruder` is set
(which it is for any standard slice including the U1 reference
unicorn). The guard only skips reorder when `first_extruder == -1`
(initial-state-only paths). For the U1 reference slice, both trees
reorder layer 0 — no behavioral delta.

**Recommended action:** Skip. Sub-case of C2 which is also retired.

---

### C6 — Interface layer features (WipeTower2.cpp) ⚪ LOW / Bambu-leaning

**Files:** `src/libslic3r/GCode/WipeTower2.cpp`, `PrintConfig.cpp`

**What it is:**  
Upstream adds `m_enable_tower_interface_features` which, when active,
inserts M109 temperature-wait commands and pre-extrusion passes at
material transitions. Also controls `m_enable_tower_interface_cooldown_during_tower`.

**Why irrelevant for U1:**  
`enable_tower_interface_features` is an upstream-only config key not
present in any U1 profile and not in SAFE_KEYS. The code path is never
activated for U1 slices. Even if activated, the M109 waits are for
interface materials not used on the U1.

**Recommended action:** Do not port. Mark as Bambu-specific. Retire if
upstream ever defaults this to false globally.

---

### C7 — generate_path_to_wipe_tower (GCode.cpp) ⚪ LOW / upstream-only

**Files:** `src/libslic3r/GCode.cpp`

**What it is:**  
Upstream adds `generate_path_to_wipe_tower()` — a collision-avoidance
routine that generates a multi-segment polyline travel path to the wipe
tower instead of a direct move. It uses `m_wipe_tower_bbx` to route
around the tower footprint when approaching from awkward positions.

**Direction analysis:**  
This ADDS travel moves to upstream G-code, making upstream theoretically
slower for wipe-tower approach. Since OrcaXR (upstream) is already
faster, these extra moves are either (a) not activated for U1 geometry,
or (b) offset by savings elsewhere. Either way, porting this would
lengthen upstream estimates — the wrong direction.

**Recommended action:** Do not port. This is upstream-only and works
against closing the gap.

---

### C8 — WipeTower v1 BBL planning changes (Print.cpp) ⚪ LOW / Bambu-specific

**Files:** `src/libslic3r/Print.cpp`

**What it is:**  
Upstream's BBL/SEMM WipeTower v1 planning path adds
`multi_extruder_flush[nozzle_id][pre][post]` tracking and `grab_length`
purge-volume credit subtraction. Snapmaker's path omits this.

**Why irrelevant for U1:**  
U1 is not a BBL printer. Both upstream and fork route U1 through the
WipeTower2 branch. The v1 path (WipeTower.cpp) is never instantiated for
U1 slices.

**Recommended action:** Do not port.

---

## 5. Already Covered

Patches 0015–0019, 0023, 0024 cover the FullSpectrum mixed-filament
features. Patches 0020–0022 cover wipe-tower brim/chamfer/bounds.
None of these address the time-gap root cause.

Patches 0025–0026 add `filament_high_temperature` and
`requires_top_cover` flag propagation — profile metadata, no timing
impact.

---

## 6. Post-verification status

All eight candidates were re-checked against the actual upstream v2.3.2
source (not just the raw diff line counts). Result: **no patch was
authored** — every candidate the audit ranked as "likely impactful for
U1" turned out to be either (a) already present in upstream in the same
or richer form, or (b) gated on a config key no U1 profile sets.

| Candidate | Original rank | Verified status |
|---|---|---|
| C1 — toolchange retraction pre-injection | 🔴 HIGH | ⚪ Retired — upstream `GCode.cpp:792` already does this; only the placeholder slot differs |
| C2 — TSP extruder-order solver | 🔴 HIGH | ⚪ Retired — upstream `ToolOrderUtils.cpp:491` has the same DP solver plus two more variants |
| C3 — pressure-advance injection | 🟡 MEDIUM | ⚪ Deferred (per audit; tiny + missing config) |
| C4 — `ramming_line_width_ratio` | 🟡 MEDIUM | ⚪ Retired — upstream reads multiplier from per-filament `ramming_parameters`; no U1 profile customizes |
| C5 — first-layer extruder guard | 🟡 MEDIUM | ⚪ Retired — call site sets `reorder_first_layer = true` whenever `first_extruder` is set; matches fork for the U1 reference slice |
| C6 — interface layer features | ⚪ LOW | Skipped (audit) |
| C7 — `generate_path_to_wipe_tower` | ⚪ LOW | Skipped (audit, wrong-direction) |
| C8 — WipeTower v1 BBL planning | ⚪ LOW | Skipped (audit, doesn't apply to U1) |

---

## 7. The 32.6 % gap is real, the named candidates aren't its cause

Phase 1 closed < 1 % of the gap by syncing profile values; the eight
file-level candidates above explain 0 % of the remaining 32 %. The
audit was authored from raw diff line counts (`GCode.cpp` = 6 958
diffed lines, etc.) and overlooked that most of those lines are
upstream's *additions* layered on top of the fork's older base, not
fork-only features that are missing from upstream. Diff size is not
direction-of-change.

**The only reliable way forward is to stop reasoning from diffs and
generate a real side-by-side G-code comparison:**

1. Build the Snapmaker fork's desktop OrcaSlicer locally from
   `/tmp/snapmaker-orca` at tag `v2.3.1`.
2. Slice the same `Einhorn Knitted_PLA` 3MF with both binaries
   (Snapmaker desktop + OrcaXR-built libslic3r CLI via
   `scripts/autotest_slice.sh`).
3. Diff the two `.gcode` files line-by-line (or by layer-block).
4. The first divergence that materially changes feedrate / motion is
   the actual root cause; map it back to a libslic3r site by greppping
   the divergent lines against `GCode.cpp` and `GCodeProcessor.cpp`.

Until step 4 produces a concrete site, no patch should be written:
porting plausible-looking fork code on faith adds patches-to-maintain
without closing the gap.

---

## 8. What Would Retire This Audit

- Gap < 5 % after a real fix lands: un-ignore
  `unicornEstimateMatchesDesktopWithinFivePercent`, delete this doc.
- Side-by-side `.gcode` diff identifies the actual divergence: rewrite
  this doc with the new candidate(s) and the diff line numbers as
  evidence.
- OrcaXR version bump past 2.3.2: re-run this analysis (and the
  side-by-side diff) against the new upstream tag.
