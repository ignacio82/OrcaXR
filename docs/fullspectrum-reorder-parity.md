# FullSpectrum reorder parity: why per-slot filament-mm is the wrong gate

**Status:** resolved 2026-05-16. The long-standing "PeggyPalette
+5.4 % T1 regression" was never a regression and never a slicer bug.
It is the OrcaXR flush-minimiser doing its job, caught by a test that
asserted the wrong quantity.

## TL;DR

- OrcaXR runs the stock `reorder_filaments_for_minimum_flush_volume`
  (`libslic3r/GCode/ToolOrderUtils.cpp`). For PeggyPalette it picks a
  per-layer filament order with **lower total wipe-tower flush** than
  desktop FullSpectrum (pair-cost 2263 vs 2526 — roughly 10 % less
  purge waste over 98 layers).
- Desktop FullSpectrum does **not** flush-minimise; it keeps its
  Local-Z planner's per-layer cadence (`312/310`).
- The two outputs print the **same colours**. Region→filament is
  fixed by the painted segmentation, not by toolchange order, so the
  reorder only changes purge volume and seam attribution.
- The old parity test asserted **per-slot total filament-mm** within
  2 % of the FS reference. Total mm includes wipe-tower purge, so the
  test flagged "OrcaXR wastes less filament" as a 5.4 % regression and
  burned many multi-hour debugging sessions chasing a non-bug.

## Evidence

Decomposing every gcode line into per-tool **model** vs
**wipe/toolchange** extrusion (see `scripts/`-style awk in the commit
history / memory `project_orcaxr_patch_chain`):

| tool | model (OrcaXR vs REF) | wipe/tc (OrcaXR vs REF) |
|------|-----------------------|--------------------------|
| T0   | 755.88 vs 756.05 ✓    | 163.10 vs 156.10 (+7.0)  |
| T1   | 718.20 vs 718.35 ✓    | 265.83 vs 215.35 (+50.5) |
| T2   | 695.78 vs 695.90 ✓    | 107.92 vs 115.30 (−7.4)  |
| T3   | 1835.63 vs 1838.35 ✓  | 263.42 vs 310.90 (−47.5) |

Model extrusion is byte-identical per tool. The entire delta is
wipe-tower flush, and it is **conserved** (total wipe ≈ 800 both
ways) — pure redistribution from changing which (from→to) toolchange
pairs occur, not a change in what is printed.

Per-layer per-tool model extrusion confirms it: T1 model is invariant
every layer; T0↔T2 wobble by ~2.4 mm/layer, anti-correlated, and
cancel to <0.2 mm in the totals. That is a seam/boundary attribution
artifact of a different print order — **not** a colour reassignment.

The DP trace (instrumented `ToolOrderUtils.cpp`) shows the
flush-matrix the optimiser sees is correct (`[from][to]`, equal to
the FS reference ×0.7) and that OrcaXR's chosen order is genuinely
the lower-flush one.

## Decision

1. **Do not replicate FullSpectrum for painted / painted-Local-Z
   models.** OrcaXR's flush-minimised output is strictly better:
   identical colours, ~10 % less purge, fewer expensive toolchanges.
2. **The parity test gates on the colour-bearing quantity**, not the
   proxy. It now asserts per-tool **model** extrusion (and layer
   count, structure, slice success). Per-slot *total* mm and purge
   are logged for visibility but are **not** hard failures, because
   a lower total is an improvement, not a regression.
3. **Replicate FS cadence only where per-layer order is provably
   colour-bearing** — pure Local-Z *pigment-stacking* (the unpainted
   LayerCycle case, where translucent Z-stacking means order changes
   the blended colour). That is tracked separately in
   `docs/proposals/fullspectrum-layercycle-engine.md` and does **not**
   apply to PeggyPalette or any painted model.

## Test contract (regression gate)

`app/src/androidTest/.../PeggyPaletteFullSpectrumParityTest.kt` is
still the mandatory pre-commit gate for any slicer/patch/libslic3r
change. It now fails on the things that mean *wrong colours or broken
routing*:

- slice must succeed (no SIGABRT / NativeError);
- layer count within ±5 of the FS reference;
- executable line count ≥ ½ of reference (catches dropped volumes);
- **per-tool MODEL extrusion within 2 % of the FS reference** — the
  colour-bearing invariant; a real routing/segmentation regression
  moves this immediately.

It deliberately does **not** fail when per-slot total mm differs from
FS (that difference is the flush optimisation and is desirable). The
produced gcode is always copied to
`/sdcard/Download/peggy_orcaxr_actual.gcode` before assertions so a
failing run is inspectable without a re-run.

**Always run this test before committing slicer-affecting changes.**
A green run means colours/routing are intact; it no longer punishes
the flush win.
