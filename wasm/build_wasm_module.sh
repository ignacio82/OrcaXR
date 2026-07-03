#!/usr/bin/env bash
# OrcaXR: link the Phase-1 WASM slicer module (slic3r.mjs + slic3r.wasm)
# from the Emscripten-built libslic3r + deps. Run after
#   ninja -C third_party/OrcaSlicer/build-wasm libslic3r
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ORCA="$HERE/../third_party/OrcaSlicer"
BIN="$ORCA/build-wasm"
DEST="$ORCA/deps/build-wasm/destdir/usr/local"
OUT="$HERE/dist"
mkdir -p "$OUT"

source ~/emsdk/emsdk_env.sh >/dev/null 2>&1

ARCHIVES=(
    # libslic3r's own archives (deeper call graph first)
    "$BIN/src/libslic3r/liblibslic3r_cgal.a"
    "$BIN/src/libslic3r/liblibslic3r.a"
    "$BIN/deps_src/admesh/libadmesh.a"
    "$BIN/deps_src/clipper/libclipper.a"
    "$BIN/deps_src/clipper2/libClipper2.a"
    "$BIN/deps_src/glu-libtess/libglu-libtess.a"
    "$BIN/deps_src/mcut/libmcut.a"
    "$BIN/deps_src/miniz/libminiz_static.a"
    "$BIN/deps_src/qoi/libqoi.a"
    "$BIN/lib/libsemver.a"
    # Cross-compiled deps
    "$DEST/lib/libboost_filesystem.a"
    "$DEST/lib/libboost_thread.a"
    "$DEST/lib/libboost_log.a"
    "$DEST/lib/libboost_log_setup.a"
    "$DEST/lib/libboost_locale.a"
    "$DEST/lib/libboost_chrono.a"
    "$DEST/lib/libboost_atomic.a"
    "$DEST/lib/libboost_date_time.a"
    "$DEST/lib/libboost_iostreams.a"
    "$DEST/lib/libboost_program_options.a"
    "$DEST/lib/libboost_nowide.a"
    "$DEST/lib/libboost_container.a"
    "$DEST/lib/libtbb.a"
    "$DEST/lib/libtbbmalloc.a"
    "$DEST/lib/libopenvdb.a"
    "$DEST/lib/libblosc.a"
    "$DEST/lib/libHalf-2_5.a"
    "$DEST/lib/libIex-2_5.a"
    "$DEST/lib/libIlmThread-2_5.a"
    "$DEST/lib/libImath-2_5.a"
    "$DEST/lib/libnlopt.a"
    "$DEST/lib/liblibnoise_static.a"
    "$DEST/lib/libgmp.a"
    "$DEST/lib/libmpfr.a"
    "$DEST/lib/libjpeg.a"
    "$DEST/lib/libpng16.a"
    "$DEST/lib/libexpat.a"
    "$DEST/lib/libfreetype.a"
    "$DEST/lib/libqhullcpp.a"
    "$DEST/lib/libqhullstatic_r.a"
    # NOTE: no libz.a — miniz_static exports the zlib-compatible symbols
    # (inflate*/deflate*) and a second definition collides at link. On
    # Android libz is a SHARED system lib so the overlap never surfaced.
)

for a in "${ARCHIVES[@]}"; do
    [[ -f "$a" ]] || { echo "missing archive: $a" >&2; exit 1; }
done

em++ -O2 -pthread -fwasm-exceptions --profiling-funcs -sASSERTIONS=1 \
    -isystem "$HERE/shim-include" \
    -I "$ORCA/src" \
    -I "$ORCA/src/libslic3r" \
    -I "$BIN/src/libslic3r" \
    -isystem "$ORCA/deps_src/eigen" \
    -isystem "$ORCA/deps_src" \
    -isystem "$ORCA/deps_src/clipper2/Clipper2Lib/include" \
    -isystem "$ORCA/deps_src/libnest2d/include" \
    -isystem "$ORCA/deps_src/miniz" \
    -isystem "$ORCA/deps_src/clipper" \
    -isystem "$ORCA/deps_src/libigl" \
    -isystem "$DEST/include" \
    "$HERE/slic3r_wasm.cpp" \
    -Wl,--start-group "${ARCHIVES[@]}" -Wl,--end-group \
    -lembind \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createSlic3r \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=268435456 \
    -sSTACK_SIZE=5242880 \
    -sDEFAULT_PTHREAD_STACK_SIZE=5242880 \
    -sMAXIMUM_MEMORY=4294967296 \
    -sPTHREAD_POOL_SIZE=10 \
    -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_RUNTIME_METHODS=FS \
    -o "$OUT/slic3r.mjs"

echo "OK: $OUT/slic3r.mjs + slic3r.wasm"
