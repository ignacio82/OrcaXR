# WASM-port snapshot of third_party/OrcaSlicer working tree

The OrcaSlicer submodule is intentionally never committed (ignore=dirty).
This directory snapshots the working tree that produces the WORKING
`slic3r.wasm`, so the build is reproducible from a clean checkout:

- `wasm-port-tracked-changes.diff` — `git diff` of the submodule at the
  time of the Phase-1/2 milestone. NOTE: this includes BOTH the Android
  FullSpectrum patch chain (applied by scripts/build_native.sh) AND the
  Emscripten-specific changes (all gated `if (EMSCRIPTEN)` /
  `#ifdef __EMSCRIPTEN__`).
- `untracked/` — new files in the submodule tree: the TBB serial shim
  copies (tbb/, oneapi/tbb/ incl. the WASM-added task-group-free umbrella,
  parallel_pipeline shim), `orcaxr_wasm_stubs.cpp`, plus patch-chain files
  (filament_mixer, MixedFilament, …).

To rebuild: apply the diff + copy `untracked/` into the submodule, then
follow the recipe in the project memory / `wasm/build_wasm_module.sh`
(deps superbuild `deps/build-wasm` with `-fwasm-exceptions -pthread`,
`ninja libslic3r`, then the link script).
