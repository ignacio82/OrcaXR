# WASM-port snapshot of third_party/SnapmakerOrca (fork v2.3.4)

The web slicer engine is built from the Snapmaker/OrcaSlicer fork
(v2.3.4, FullSpectrum-native since 2.3.3) — the SAME source the external
slicer container's CLI builds from, so web and CLI G-code match at the
source level. The fork checkout is a plain gitignored clone; this
directory makes the build reproducible:

- `snapmaker-fork-wasm-port.diff` — `git diff 9fd12ff <port commit>` of the
  fork tree: the
  Emscripten gates (deps recipes, CMakeLists, Thread/Platform/STEP/Model),
  the wasm32 Arachne underflow fix, the never-called
  `init_filament_option_keys()` ctor fix, the `normalize_fdm`
  wipe_tower_filament null-guard (same as server/patches/0002), the
  restored `append_full_config` call (its EMSCRIPTEN gate is gone —
  `fixup_enum_keys_map()` already runs on the slice config, and without the
  dump the emitted CONFIG_BLOCK carries only the `first_layer_*` scalars, so
  `filament_colour` / `filament_type` never reach the G-code), the
  FullSpectrum
  `GCodeProcessor::run_post_process` filament-stats OOB guard (same as
  server/patches/0003 — virtual mixed-filament ids overrun the physical
  per-extruder stat vectors; a benign heap-corrupting write on native but a
  hard wasm32 trap that silently killed the in-browser slicer), and the
  **wave-overhang port** described below.

## Wave overhangs

The diff carries a port of
[dennisklappe/OrcaSlicer-WaveOverhangs](https://github.com/dennisklappe/OrcaSlicer-WaveOverhangs)
release **v0.4.0** (`f6a901d5`): the generator in `src/libslic3r/WaveOverhangs/`
(new files — `git apply` creates them) and its integration in PerimeterGenerator,
PrintObject, Fill, GCode, GCodeWriter, CoolingBuffer, the two support generators,
and the config definitions. It was produced by applying upstream's
`3e4af2c7..f6a901d5` libslic3r changes to this tree and resolving every reject
and fuzzed hunk by hand (one fuzzed hunk had landed the wave speed override
after the feed rate was already computed, which would have printed every wave
line at full speed). These changes deliberately differ from upstream, each
pinned by `wasm/test_slice_wave_overhang.mjs`:

- Fill carving, inner-wall clipping, and the floor/support masks claim only the
  overhang components the waves actually filled. Upstream claims the island's
  whole overhang zone, so an island with a waved shelf and a span the generator
  left to the bridge pipeline lost the bridge's infill and walls on that layer
  with nothing printed in their place.
- The fan and nozzle-temperature overrides are scoped to a run of consecutive
  wave (or Hilbert-floor) paths, closing at the next other extrusion, before a
  tool change, and at the end of the layer. Upstream toggled both around every
  line — the fan fell back to normal during each inter-line travel and the
  hotend target flipped every few seconds — and restored filament 1's
  temperature whichever tool was printing.
- `apply_extra_perimeters` is told which `loops` entry is the current island's.
  Upstream takes `loops->entities.back()`, which reads past an empty vector (a
  wasm32 trap) or grafts the overhang paths onto the previous island when an
  island produced no walls.
- Tree supports subtract wave coverage instead of clearing every overhang on a
  layer that has any, matching the normal support generator.
- The `; WAVE_OVERHANG_BUILD` line names `v0.4.0` and the Snapmaker base rather
  than the fork's own version macros, which this tree does not have.

With `wave_overhangs` off the engine must emit G-code byte-identical to the
pre-wave build except for the 38 new keys in the trailing CONFIG_BLOCK; that
was checked on cube, Benchy, an Elegoo profile, and a FullSpectrum project
when this port landed.

## Untracked files

Copy in `untracked/src/libslic3r/{tbb,oneapi}` (TBB serial shims) and
`untracked/src/libslic3r/orcaxr_wasm_stubs_snapmaker.cpp` as
`src/libslic3r/orcaxr_wasm_stubs.cpp` (the fork has no draco importer, so the
DRC stubs are dropped).

Note: the web app slices FullSpectrum *project* 3MFs synchronously
(`sliceProjectSync` in `wasm/slic3r_wasm.cpp`, wired in
`SlicerClient.sliceProject`) rather than on the async start/poll worker
path — a heavy FS slice crashes when run on an Emscripten pthread worker in
the browser but completes on the module's main thread (root-caused to the
browser pthread-worker context, not memory/stack/logic). Follow-up: host
the module in a dedicated JS Worker to restore async, non-blocking UX.

## Toolchain

**Emscripten 6.0.2**, exactly (`./emsdk install 6.0.2 && ./emsdk activate 6.0.2`).
The published `slic3r.mjs` glue is byte-identical to what 6.0.2 emits for
`build_wasm_module_snapmaker.sh`, so a rebuild that leaves `slic3r.mjs` unchanged
has used the right toolchain; any other release rewrites the glue. emsdk installs
every release into the same `upstream/` directory, so installing another one
replaces 6.0.2 — reinstall before building. The deps superbuild also needs
`makeinfo` (texinfo) and `m4` for GMP.

## Rebuild from a clean fork clone

    git clone --depth 1 --branch v2.3.4 https://github.com/Snapmaker/OrcaSlicer.git third_party/SnapmakerOrca
    cd third_party/SnapmakerOrca && git apply ../../wasm/patches/snapmaker-fork-wasm-port.diff
    cp -r ../../wasm/patches/untracked/src/libslic3r/{tbb,oneapi} src/libslic3r/
    cp ../../wasm/patches/untracked/src/libslic3r/orcaxr_wasm_stubs_snapmaker.cpp \
       src/libslic3r/orcaxr_wasm_stubs.cpp   # fork-adapted stubs (no DRC)
    source ~/emsdk/emsdk_env.sh; export EMSCRIPTEN=$EMSDK/upstream/emscripten
    emcmake cmake -S deps -B deps/build-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DDESTDIR=$PWD/deps/build-wasm/destdir -DFLATPAK=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    ninja -C deps/build-wasm dep_Boost dep_CGAL dep_GMP dep_MPFR dep_TBB dep_ZLIB \
      dep_EXPAT dep_PNG dep_JPEG dep_FREETYPE dep_NLopt dep_Qhull dep_Cereal \
      dep_libnoise dep_Blosc dep_OpenEXR dep_OpenVDB
    emcmake cmake -S . -B build-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DSLIC3R_GUI=OFF -DORCA_TOOLS=OFF -DSLIC3R_STATIC=ON -DSLIC3R_ENC_CHECK=OFF \
      -DCMAKE_PREFIX_PATH=$PWD/deps/build-wasm/destdir/usr/local \
      -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
      -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      "-DCMAKE_CXX_FLAGS=-pthread -fwasm-exceptions -DORCAXR_TBB_SERIAL_ACTIVE -I<repo>/wasm/shim-include" \
      "-DCMAKE_C_FLAGS=-pthread -fwasm-exceptions"
    ninja -C build-wasm libslic3r libslic3r_cgal admesh clipper glu-libtess mcut miniz_static qoi semver
    bash ../../wasm/build_wasm_module_snapmaker.sh

A sandbox that cannot reach `codeload.github.com` or `mpfr.org` can still build:
clone each dependency's tag with git, `git archive` it, and point the recipe's
`URL`/`URL_HASH` at the local tarball in the working tree only (the sources are
the same tags; MPFR's `.tar.xz` is Ubuntu's `mpfr4_4.2.2.orig.tar.xz`).

## Changing the engine

Commit engine edits in the fork tree and regenerate the diff commit-to-commit,
never from the working tree (which may hold local recipe rewrites or shims):

    git -C third_party/SnapmakerOrca diff 9fd12ff HEAD > wasm/patches/snapmaker-fork-wasm-port.diff

Before publishing, prove the diff reproduces the tree that was built: add a
worktree at `9fd12ff`, `git apply` the diff, and check `git diff HEAD` there is
empty. Then relink, copy `wasm/dist/{slic3r.mjs,slic3r.wasm}` to
`web/public/slicer/`, update `wasm/artifact-provenance.json`, its adjacent copies
in `wasm/dist/` and `web/public/slicer/`, and the hash literal in
`web/src/slicer/pinnedEngineProvenance.ts` together, and run
`npm --prefix wasm run verify:artifacts`, `npm --prefix web run security:check`
(which holds the pin to the manifest), and `npm --prefix wasm run test:wave`.
