# WASM-port snapshot of third_party/SnapmakerOrca (fork v2.3.4)

The web slicer engine is built from the Snapmaker/OrcaSlicer fork
(v2.3.4, FullSpectrum-native since 2.3.3) — the SAME source the external
slicer container's CLI builds from, so web and CLI G-code match at the
source level. The fork checkout is a plain gitignored clone; this
directory makes the build reproducible:

- `snapmaker-fork-wasm-port.diff` — `git diff` of the fork tree: the
  Emscripten gates (deps recipes, CMakeLists, Thread/Platform/STEP/Model),
  the wasm32 Arachne underflow fix, the never-called
  `init_filament_option_keys()` ctor fix, the `normalize_fdm`
  wipe_tower_filament null-guard (same as server/patches/0002), the
  `append_full_config` EMSCRIPTEN gate, and the FullSpectrum
  `GCodeProcessor::run_post_process` filament-stats OOB guard (same as
  server/patches/0003 — virtual mixed-filament ids overrun the physical
  per-extruder stat vectors; a benign heap-corrupting write on native but a
  hard wasm32 trap that silently killed the in-browser slicer).

Note: the web app slices FullSpectrum *project* 3MFs synchronously
(`sliceProjectSync` in `wasm/slic3r_wasm.cpp`, wired in
`SlicerClient.sliceProject`) rather than on the async start/poll worker
path — a heavy FS slice crashes when run on an Emscripten pthread worker in
the browser but completes on the module's main thread (root-caused to the
browser pthread-worker context, not memory/stack/logic). Follow-up: host
the module in a dedicated JS Worker to restore async, non-blocking UX.
- Untracked files to copy in: `untracked/src/libslic3r/{tbb,oneapi}`
  (TBB serial shims) and `untracked/src/libslic3r/orcaxr_wasm_stubs.cpp`
  (drop the DRC stubs — the fork has no draco importer; see the fork
  copy of the file in the diff era).

Rebuild from a clean fork clone:
  git clone --depth 1 --branch v2.3.4 https://github.com/Snapmaker/OrcaSlicer.git third_party/SnapmakerOrca
  cd third_party/SnapmakerOrca && git apply snapmaker-fork-wasm-port.diff
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
  ninja -C build-wasm libslic3r
  bash wasm/build_wasm_module_snapmaker.sh
