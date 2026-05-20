---
description: Untangle FullSpectrum patches 0053-0068 so build_native.sh succeeds from a clean v2.3.2 baseline
---

Untangle the OrcaXR FullSpectrum patch chain so `scripts/build_native.sh` succeeds end-to-end from a clean v2.3.2 baseline. Goal: every patch in `patches/00*.patch` applies in order without `error: patch does not apply`, and `PeggyPaletteFullSpectrumParityTest` shows per-slot filament use converging toward the desktop FullSpectrum reference (T0=913, T1=939, T2=816, T3=2154; today it's T0=2878, T1=296, T2=356, T3=1291 with same total).

Read these memory entries first: `project_orcaxr_patch_chain.md` (full audit of failure clusters + recommended approach) and `reference_peggypalette_parity_test.md` (how to run the regression). Then read `patches/0053-fullspectrum-wipetower2-local-z-scaffold.patch` and the brim-chamfer patches 0020-0022 to see the concrete dup pattern.

Recommended approach (from the memory): rather than rebasing 16 patches hunk-by-hunk, build the "as-running" working tree by applying 0001-0068 piece by piece with `--reject` and hand-resolving, then `git diff` it against the c724a3f5 baseline to produce a single consolidated patch that **replaces** all of 0053-0068. Sanity-check by reverting submodule + running `./scripts/build_native.sh` from clean and verifying it completes; rebuild `libslic3r.a` (~5 min incremental); reinstall APK on the Galaxy XR; rerun the parity test. If pre-staging is needed, the 3MF lives at `/sdcard/Download/Quick Share/PeggyPalette38+Mini+BRYW.3mf` on the headset and the reference at `/home/ignacio/Downloads/WhoShrunkPeggyPalette_PLA_2h15m_fullspectrum.gcode` locally.

Galaxy XR wireless-debug ADB pairing must be live — confirm with `adb devices -l` showing `model:SM_I610` before starting. Headset transport id changes each session.

Don't commit anything until the parity test runs green and the per-slot numbers move toward FullSpectrum's. Expect this to be a multi-hour session.
