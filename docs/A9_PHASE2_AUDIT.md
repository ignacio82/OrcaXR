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

### C1 — Toolchange retraction pre-injection (GCode.cpp) 🔴 HIGH

**Files:** `src/libslic3r/GCode.cpp`  
**Patch size:** Medium (~80–120 lines of logic to isolate and port)

**What the fork adds:**  
Snapmaker's `GCode.cpp` computes `toolchange_retract_str` from
`filament_retract_length_toolchange` and prepends it explicitly before
every `change_filament_gcode` emission. Upstream does not emit this
explicit pre-retract; retraction handling is folded into the wipe-tower
writer's pre-toolchange path instead.

For U1, `change_filament_gcode` is the physical tool-swap macro (Z-hop +
travel + M109 + M400 + T{n} + SM_PRINT_PREEXTRUDE_FILAMENT). When the
Snapmaker fork prepends `toolchange_retract_str`, each of the 385
toolchanges carries an extra retract+unretract pair that upstream's path
does not emit at the same code point.

**Why it affects timing:**  
Each extra retract/unretract at toolchange speed moves the E-axis
~2–6 mm both ways. At 45 mm/s × 385 toolchanges, the idle E-moves
accumulate 30–60 s per retraction pair. For 385 events this could add
2–4 min alone — not the full 3 h 42 m, but measurably contributes.

More importantly, the ordering of retract → toolchange macro → unretract
changes the firmware's pressure-advance state at each toolchange, and
GCodeProcessor's kinematics may model the resulting feedrate transitions
differently.

**U1 relevance:** HIGH — `filament_retract_length_toolchange` is a
per-extruder value set in the U1 filament profiles.

**Recommended action:** Port the `toolchange_retract_str` pre-injection
hunk as patch 0027. Check whether the upstream wipe-tower writer already
retracts at toolchange (to avoid double-retract after the port).

---

### C2 — ToolOrdering TSP extruder-order solver (ToolOrdering.cpp) 🔴 HIGH

**Files:** `src/libslic3r/GCode/ToolOrdering.cpp`  
**Patch size:** Large (~200 lines: `solve_extruder_order()` DP function +
`get_extruders_order()` wrapper + `#define USE_DP_OPTIMIZE`)

**What the fork adds:**  
Snapmaker adds a dynamic-programming shortest-Hamilton-path solver
(`solve_extruder_order`) that picks the extruder sequence minimizing
total flush volume per layer. Upstream uses a greedy nearest-neighbor
pass (`reorder_extruders_for_minimum_flush_volume` without DP).

Additionally, the fork's `reorder_extruders_for_minimum_flush_volume`
always reorders every layer (no `reorder_first_layer` guard). Upstream
skips reordering on layer 0 when `first_extruder == -1`.

**Why it affects timing:**  
For U1, `prime_volume = 45 mm³` normalizes all non-zero wipe transitions
to a flat value, so the DP solver cannot reduce total purge volume.
However:

1. The extruder sequence determines travel order within each layer, which
   changes the per-layer XY travel distance to/from the wipe tower.
2. The DP solver on equal-weight edges may produce a *different* sequence
   than the greedy pass — not necessarily shorter travel — changing which
   extruder ends each layer and thus which temperature hold is active
   between toolchanges.
3. First-layer reordering difference (upstream skips, fork reorders) can
   cascade into different wipe-tower depth budgets on layer 1+.

**U1 relevance:** HIGH — 385 toolchanges across 332 layers makes
per-layer ordering choices compound significantly.

**Recommended action:** Port as patch 0028 (after C1). The DP function is
self-contained; the `#define USE_DP_OPTIMIZE` guard makes it
straightforward to isolate. Validate by comparing ToolOrdering output
across layers in a known 4-filament slice.

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

### C4 — ramming_line_width_ratio config (WipeTower2.cpp + PrintConfig) 🟡 MEDIUM

**Files:** `src/libslic3r/GCode/WipeTower2.cpp`,
`src/libslic3r/PrintConfig.cpp/.hpp`  
**Patch size:** Small (~20 lines)

**What differs:**  
Upstream hardcodes `ramming_line_width_multiplicator = 2.0` for
multi-tool paths in `WipeTower2::toolchange_Wipe`. Snapmaker reads it
from `config.ramming_line_width_ratio` (a `coFloat` config key, default
likely 1.0 or 2.0).

**Why it affects timing:**  
If `ramming_line_width_ratio` is set to a value other than 2.0 in the U1
profile, the wipe path width changes. Narrower wipe moves require more
passes to cover the same area; more passes = more G-code = more time.

**U1 relevance:** MEDIUM — depends on what the U1 profile's
`ramming_line_width_ratio` value is. If it's 2.0 (matching the upstream
hardcode), this candidate has no effect.

**Recommended action:** Check U1 profile JSON for `ramming_line_width_ratio`.
If absent or == 2.0, retire this candidate. If non-2.0, port after C2.

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
the WipeTower2 depth allocation for layer 0 differs. WipeTower2 depth
directly controls wipe move length per toolchange. A deeper tower =
longer wipe moves = more G-code.

**U1 relevance:** MEDIUM — depends on whether `first_extruder` is
uninitialized (== -1) for the U1 profile at slice start. Part of C2's
patch (the DP solver); the parameter removal is a prerequisite for
`get_extruders_order()` to call the DP path uniformly.

**Recommended action:** Include this as part of C2 port (same patch
0028). Do not port in isolation.

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

## 6. Recommended Port Order

| Priority | Candidate | Patch # | Estimated impact on gap |
|---|---|---|---|
| 1st | C1 — toolchange retraction pre-injection | 0027 | Low–Medium (2–10 min) |
| 2nd | C2 + C5 — TSP extruder ordering + first-layer guard | 0028 | Unknown; needs build validation |
| 3rd | C4 — ramming_line_width_ratio (only if != 2.0 in U1 profile) | 0029 | Small |
| Defer | C3 — pressure-advance injection | — | Tiny; needs GCodeProcessor grep |

---

## 7. Uncertainty and Honest Assessment

After diffing all relevant files, **no single hunk definitively explains
a 32.6% gap** (3 h 42 m absolute). The candidates above are ranked by
plausibility but have not been validated by building and diffing actual
G-code output.

Likely the gap is **compound**: multiple small differences across
ToolOrdering, GCode.cpp retraction logic, and WipeTower2 parameters
accumulate across 385 toolchanges and 332 layers.

**The only reliable way to close this audit** is to build OrcaXR with
patch 0027 applied, slice the U1 test model, and diff the G-code vs
Snapmaker desktop. The `unicornEstimateMatchesDesktopWithinFivePercent`
test (currently `@Ignore`d) should be un-ignored as the regression guard
once the gap narrows to < 5%.

---

## 8. What Would Retire This Audit

- Gap < 5%: un-ignore `unicornEstimateMatchesDesktopWithinFivePercent`, delete this doc.
- Upstream OrcaSlicer adopts Snapmaker fork's retraction and TSP patches: delete candidates C1 and C2.
- OrcaXR version bump past 2.3.2: re-run this analysis against new upstream tag.
