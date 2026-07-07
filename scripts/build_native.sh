#!/usr/bin/env bash
# Cross-compile libslic3r for Android arm64-v8a via NDK.
#
# Two-phase build, mirroring OrcaSlicer's desktop pattern:
#   1. Build dependencies (Boost, TBB, CGAL, …) under deps/build-android/
#   2. Build libslic3r against the install tree those deps produced
#
# This is Phase 0 spike territory. Expect the first N runs to fail — each
# failure drives either a new entry in patches/ or a documented deviation
# in DESIGN.md. When the script runs clean end-to-end, Phase 0 is done.
#
# Usage: scripts/build_native.sh [-c]
#   -c   clean build (wipes deps/build-android and build-android)
#
# Env vars consulted:
#   ANDROID_HOME      required — path to Android SDK
#   ANDROID_NDK       optional — full path to NDK; defaults to $ANDROID_HOME/ndk/<NDK_VERSION>
#   NDK_VERSION       optional — defaults to the version pinned in CLAUDE.md
#   ANDROID_ABI       optional — defaults to arm64-v8a
#   ANDROID_PLATFORM  optional — defaults to android-31 (minSdk)
#   ORCAXR_JOBS       optional — compile job cap (default max(1, nproc-3))
#   ORCAXR_LOAD_LIMIT optional — pass `-l` load cap to Ninja builds
#   ORCAXR_BG_BUILD   optional — default 1; if 1 runs builds with nice/ionice

set -euo pipefail

# ---- config --------------------------------------------------------------

NDK_VERSION_DEFAULT="29.0.14206865"
ANDROID_ABI="${ANDROID_ABI:-arm64-v8a}"
ANDROID_PLATFORM="${ANDROID_PLATFORM:-android-31}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORCA_DIR="${REPO_ROOT}/third_party/OrcaSlicer"
PATCHES_DIR="${REPO_ROOT}/patches"
DEPS_BUILD_DIR="${ORCA_DIR}/deps/build-android-${ANDROID_ABI}"
LIBSLIC3R_BUILD_DIR="${ORCA_DIR}/build-android-${ANDROID_ABI}"
DEPS_DESTDIR="${DEPS_BUILD_DIR}/OrcaSlicer_dep"

CLEAN=0
while getopts "ch" opt; do
    case $opt in
        c) CLEAN=1 ;;
        h|*) sed -n '2,18p' "$0"; exit 0 ;;
    esac
done

: "${ANDROID_HOME:?ANDROID_HOME must be set (path to Android SDK)}"
: "${NDK_VERSION:=$NDK_VERSION_DEFAULT}"
: "${ANDROID_NDK:=$ANDROID_HOME/ndk/$NDK_VERSION}"

# Parallel job count. `cmake --build` / Ninja default to *every* core,
# which pegs the host for the duration of an hours-long C++ build and
# makes the desktop unusable. Default to `max(1, nproc - 3)` so a few
# cores stay free for the browser / editor / window manager. Override
# with `ORCAXR_JOBS=<n>` for headless or CI runs that want every core.
if [[ -z "${ORCAXR_JOBS:-}" ]]; then
    NCPU=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
    ORCAXR_JOBS=$(( NCPU > 3 ? NCPU - 3 : 1 ))
fi

# Keep host responsive by default: run expensive compile/link steps at
# lower scheduler + IO priority unless explicitly disabled.
ORCAXR_BG_BUILD="${ORCAXR_BG_BUILD:-1}"

build_cmd() {
    if [[ "$ORCAXR_BG_BUILD" == "1" ]]; then
        if command -v ionice >/dev/null 2>&1; then
            ionice -c 3 nice -n 10 "$@"
        else
            nice -n 10 "$@"
        fi
    else
        "$@"
    fi
}

TOOLCHAIN_FILE="${ANDROID_NDK}/build/cmake/android.toolchain.cmake"
if [[ ! -f "$TOOLCHAIN_FILE" ]]; then
    echo "error: NDK toolchain file not found: $TOOLCHAIN_FILE" >&2
    echo "       install NDK $NDK_VERSION via \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" >&2
    exit 1
fi

# Roadmap E9 — assert Clang ≥ 17 (i.e. NDK ≥ 26). Older toolchains
# miscompile libslic3r's paint segmentation code in subtle ways that
# only surface as degraded multi-color boundaries in printed output —
# u1-slicer's B62 incident is the canonical reference. We pin via
# NDK_VERSION above, but if a user overrides $ANDROID_NDK to a
# locally-installed older NDK we want to fail fast, not 90 minutes
# into a libslic3r rebuild.
NDK_CLANG_BIN="${ANDROID_NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin/clang"
if [[ -x "$NDK_CLANG_BIN" ]]; then
    NDK_CLANG_MAJOR=$("$NDK_CLANG_BIN" --version 2>/dev/null | head -1 | grep -oE 'clang version [0-9]+' | grep -oE '[0-9]+' | head -1 || echo 0)
    if (( NDK_CLANG_MAJOR < 17 )); then
        echo "error: NDK toolchain Clang version $NDK_CLANG_MAJOR < 17 — refusing to build." >&2
        echo "       libslic3r's paint segmentation miscompiles on Clang < 17 (u1-slicer B62)." >&2
        echo "       Use NDK ≥ r26b. See GEMINI.md gotcha on the toolchain pin." >&2
        exit 1
    fi
fi

echo "=== OrcaXR native build ==="
echo "  NDK         : $ANDROID_NDK"
echo "  ABI         : $ANDROID_ABI"
echo "  platform    : $ANDROID_PLATFORM"
echo "  deps build  : $DEPS_BUILD_DIR"
echo "  libslic3r   : $LIBSLIC3R_BUILD_DIR"
echo "  clean       : $CLEAN"
echo "  jobs        : $ORCAXR_JOBS"
echo "  bg build    : $ORCAXR_BG_BUILD"
if [[ -n "${ORCAXR_LOAD_LIMIT:-}" ]]; then
    echo "  load limit  : $ORCAXR_LOAD_LIMIT"
fi
echo

# ---- apply patches -------------------------------------------------------
#
# Patches live under patches/ and are applied inside the OrcaSlicer
# submodule on each invocation. The submodule starts from a clean v2.3.2
# checkout (we reset it below) so patches apply predictably.

echo "--- resetting OrcaSlicer submodule to pinned tag"
git -C "$ORCA_DIR" reset --hard HEAD
git -C "$ORCA_DIR" clean -fdx -e "build-android-*" -e "deps/build-android-*" -e "deps/DL_CACHE"

if compgen -G "${PATCHES_DIR}/*.patch" > /dev/null; then
    echo "--- applying patches from $PATCHES_DIR"
    for p in "${PATCHES_DIR}"/*.patch; do
        echo "  apply $(basename "$p")"
        git -C "$ORCA_DIR" apply --whitespace=nowarn "$p"
    done
else
    echo "--- no patches in $PATCHES_DIR (fresh checkout)"
fi

# ---- TBB serial shim -----------------------------------------------------
#
# libslic3r's apply_mm_segmentation triggers a SIGSEGV on Android arm64
# when slicing multi-color 3MFs (fault addr 0x65646f6b ≈ ASCII "kode"
# from a freed-and-reused std::vector<ExPolygon> data pointer). Root
# cause: ARM64's weak memory ordering races inside TBB's parallel_for
# when `multi_material_segmentation_by_painting` reallocates ExPolygon
# vectors concurrently across worker threads — the upstream OrcaSlicer
# code assumes x86's stronger TSO ordering. taylormadearmy/u1-slicer-for-android
# independently root-caused this and ships a header-only TBB serial
# shim that replaces parallel_for/parallel_reduce/etc. with serial loops.
#
# OPT-IN: a *blanket* serial replacement deadlocks libslic3r in places
# that genuinely rely on TBB concurrency (worker-scheduling around
# task_group waits, atomic-counter barriers, etc.) — we observed the
# slicer thread freeze with utime stuck at ~24 s of CPU and zero
# progress. So the shim is gated on `ORCAXR_TBB_SERIAL_ACTIVE`. The
# header at `src/libslic3r/tbb/parallel_for.h` (etc.) is the FIRST
# entry on libslic3r's -I path; with the macro defined it provides
# serial implementations, otherwise it forwards to the real TBB via
# `#include_next`.
#
# We then patch the two TUs that own the racy code paths
# (MultiMaterialSegmentation.cpp + PrintObjectSlice.cpp where
# apply_mm_segmentation is inlined) to define the macro at the top
# of the file, and ONLY those TUs run serial. Everything else in
# libslic3r keeps real parallelism.
#
# Revisit when libslic3r adds explicit ARM64 memory barriers around
# the racy ExPolygon move/swap, or we find a more surgical fix.

# TBB serial shim — *narrow per-TU* activation.
#
# Background: a TBB parallel_for body inside libslic3r races on
# `std::vector<ExPolygon>` reallocation under ARM64's weak memory
# ordering, leaving a dangling data pointer that crashes
# `get_extents` (PrintObjectSlice.cpp:885 in apply_mm_segmentation).
#
# Past attempts:
#   1. Narrow shim, only MMS + POS  → still crashed in apply_mm_segmentation
#      with the same pattern. The corrupted vector is *fed in from upstream
#      slicing code* (TriangleMeshSlicer), so MMS+POS alone isn't enough.
#   2. Broad shim, whole libslic3r  → DEADLOCKED. Some libslic3r code
#      uses TBB constructs (task_group + parallel_for nesting?) that
#      genuinely need real workers; serial parallel_for hangs them.
#   3. global_control(max_allowed_parallelism, 1 or 2) from JNI →
#      DEADLOCKED for the same reason as #2.
#   4. AddressSanitizer-instrumented build → useless: this is a
#      deadlock (when TBB is capped) or a race that produces
#      already-freed memory in another thread; ASAN doesn't catch
#      either reliably.
#
# Current strategy (#5): activate the shim only for the THREE TUs
# in the slicing pipeline that we believe own / produce the racy
# data (MultiMaterialSegmentation.cpp, PrintObjectSlice.cpp,
# TriangleMeshSlicer.cpp). Each of these source files now has
# `#define ORCAXR_TBB_SERIAL_ACTIVE 1` at the top of the file
# (committed to third_party/OrcaSlicer); the shim header forwards
# to real TBB unless that macro is defined, so all OTHER libslic3r
# TUs (PrintObject.cpp, Brim.cpp, Print.cpp, etc.) keep real
# parallelism and the deadlock-prone task_group constructs work.
#
# All this script needs to do is drop the shim headers in front of
# real TBB on libslic3r's include path. No CMakeLists patching.
#
# Slow but correct: serial slicing on a 4-color 700k-tri mesh runs
# multi-minute (10-20 min observed). Do NOT abort prematurely if the
# slicer thread looks idle — libslic3r has CPU-light phases (callbacks,
# small computations) interleaved with bursts.
if [[ -d "${PATCHES_DIR}/tbb_serial/tbb" ]]; then
    echo "--- installing TBB serial shim headers (per-TU activation)"
    # libslic3r consumers include parallel_for via two paths:
    #   #include <tbb/parallel_for.h>          (legacy forwarder)
    #   #include <oneapi/tbb/parallel_for.h>   (oneapi-direct)
    # Drop identical shim headers into BOTH paths so whichever
    # spelling a TU uses, our serial implementation wins (when the
    # TU defines ORCAXR_TBB_SERIAL_ACTIVE; otherwise the shim
    # header `#include_next`s through to real TBB).
    for shim_subdir in tbb oneapi/tbb; do
        SHIM_DST="${ORCA_DIR}/src/libslic3r/${shim_subdir}"
        mkdir -p "$SHIM_DST"
        cp "${PATCHES_DIR}/tbb_serial/tbb/"*.h "$SHIM_DST/"
    done

    # Force libslic3r .o files to recompile when the shim contents
    # change. Ninja's dep tracking doesn't pick up new headers under
    # existing -I paths (the prior compile only scanned the real TBB
    # location), so we purge the libslic3r build outputs to get fresh
    # compile commands. The marker stores a hash of the shim files +
    # the patched .cpp files so any tweak to either invalidates it
    # and triggers another purge — important when iterating on the
    # shim semantics.
    SHIM_HASH=$( { cat "${PATCHES_DIR}/tbb_serial/tbb/"*.h \
                       "${ORCA_DIR}/src/libslic3r/MultiMaterialSegmentation.cpp" \
                       "${ORCA_DIR}/src/libslic3r/PrintObjectSlice.cpp" 2>/dev/null \
                   | sha256sum | awk '{print $1}'; } )
    SHIM_MARKER="${LIBSLIC3R_BUILD_DIR}/.tbb_serial_shim_installed"
    if [[ -d "$LIBSLIC3R_BUILD_DIR" ]]; then
        if [[ ! -f "$SHIM_MARKER" ]] || [[ "$(cat "$SHIM_MARKER" 2>/dev/null)" != "$SHIM_HASH" ]]; then
            echo "    purging libslic3r .o files (shim hash changed)"
            find "${LIBSLIC3R_BUILD_DIR}/src/libslic3r/CMakeFiles/libslic3r.dir" -name "*.o" -delete 2>/dev/null || true
            rm -f "${LIBSLIC3R_BUILD_DIR}/src/libslic3r/liblibslic3r.a"
        fi
    fi
fi

# ---- clean (if requested) -----------------------------------------------

if [[ $CLEAN -eq 1 ]]; then
    echo "--- clean: removing $DEPS_BUILD_DIR and $LIBSLIC3R_BUILD_DIR"
    rm -rf "$DEPS_BUILD_DIR" "$LIBSLIC3R_BUILD_DIR"
fi

# ---- phase 1: deps -------------------------------------------------------

echo
echo "--- phase 1: configure deps"
mkdir -p "$DEPS_BUILD_DIR"

cmake -S "$ORCA_DIR/deps" -B "$DEPS_BUILD_DIR" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DANDROID_ABI="$ANDROID_ABI" \
    -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
    -DCMAKE_BUILD_TYPE=Release \
    -DDESTDIR="$DEPS_DESTDIR" \
    -DFLATPAK=OFF

echo "--- phase 1: build deps"
DEPS_BUILD_ARGS=(cmake --build "$DEPS_BUILD_DIR" -j "$ORCAXR_JOBS")
if [[ -n "${ORCAXR_LOAD_LIMIT:-}" ]]; then
    DEPS_BUILD_ARGS+=(-- -l "$ORCAXR_LOAD_LIMIT")
fi
build_cmd "${DEPS_BUILD_ARGS[@]}"

# ---- phase 2: libslic3r --------------------------------------------------

echo
echo "--- phase 2: configure libslic3r"
mkdir -p "$LIBSLIC3R_BUILD_DIR"

# Optional: build libslic3r with AddressSanitizer to catch the
# multi-color slicing race. Enable with: ORCAXR_ASAN=1 ./build_native.sh
#
# We pass `-fsanitize=address -fno-omit-frame-pointer` as global
# CXX/C flags via CMAKE_*_FLAGS_INIT; each TU compiled here gets
# instrumented. Linking is N/A (libslic3r is a static archive); the
# JNI .so picks up the ASAN runtime via -fsanitize=address at its
# own link step, see app/src/main/cpp/CMakeLists.txt.
#
# Dependencies (Boost, CGAL, TBB, …) stay un-instrumented — their
# code isn't checked, but ASAN's malloc interceptor still tracks
# every allocation globally, so reads/writes from instrumented
# libslic3r code into dep-allocated memory still get caught.
#
# Cost: 2-3x compile time, .a grows from 1.3 GB to ~3 GB, slice
# runs ~5x slower. Acceptable for a one-shot debug session; flip
# the env var off once the bug is found and patched.
if [[ "${ORCAXR_ASAN:-0}" == "1" ]]; then
    echo "--- phase 2: AddressSanitizer ENABLED for libslic3r"
    # The NDK toolchain file uses add_compile_options() (not
    # CMAKE_CXX_FLAGS) for its flags, and CXXFLAGS env vars never
    # reach the actual compile commands either. The reliable path is
    # to inject `add_compile_options(-fsanitize=address ...)` into
    # libslic3r's own CMakeLists.txt so it propagates to every TU.
    # We do this BEFORE running cmake configure so the generated
    # build.ninja picks up the flags.
    LIBSLIC3R_CMAKELISTS="${ORCA_DIR}/src/libslic3r/CMakeLists.txt"
    if [[ -f "$LIBSLIC3R_CMAKELISTS" ]] && ! grep -q "ORCAXR_ASAN_FLAGS" "$LIBSLIC3R_CMAKELISTS"; then
        python3 - "$LIBSLIC3R_CMAKELISTS" <<'PYEOF'
import sys, re
path = sys.argv[1]
src = open(path).read()
inject = (
    "\n# OrcaXR Android: AddressSanitizer flags for the libslic3r\n"
    "# target. -fno-omit-frame-pointer + -fno-optimize-sibling-calls\n"
    "# keep stack traces accurate so the ASAN report can pinpoint the\n"
    "# racy multi-color slicing code path.\n"
    "set(ORCAXR_ASAN_FLAGS -fsanitize=address -fno-omit-frame-pointer -fno-optimize-sibling-calls)\n"
    "target_compile_options(libslic3r PRIVATE ${ORCAXR_ASAN_FLAGS})\n"
)
m = re.search(r"add_library\s*\(\s*libslic3r\b[^)]*\)", src, re.DOTALL)
if not m:
    sys.stderr.write("ERROR: could not find add_library(libslic3r ...)\n")
    sys.exit(1)
out = src[:m.end()] + inject + src[m.end():]
open(path, "w").write(out)
PYEOF
    fi
fi

cmake -S "$ORCA_DIR" -B "$LIBSLIC3R_BUILD_DIR" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
    -DANDROID_ABI="$ANDROID_ABI" \
    -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="${DEPS_DESTDIR}/usr/local" \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
    -DOpenCV_DIR="${DEPS_DESTDIR}/usr/local/sdk/native/jni" \
    -DSLIC3R_GUI=OFF \
    -DSLIC3R_STATIC=ON \
    -DSLIC3R_BUILD_SANDBOXES=OFF \
    -DSLIC3R_BUILD_TESTS=OFF \
    -DBUILD_TESTING=OFF \
    -DSLIC3R_PCH=OFF \
    -DSLIC3R_ENC_CHECK=OFF \
    -DORCA_TOOLS=OFF

echo "--- phase 2: build libslic3r"
# Memory pressure under ASAN forces a lower job count than the
# CPU-responsiveness cap above: ASAN's shadow memory pushes peak RSS
# to 8-10 GB on heavy TUs (bbs_3mf.cpp, anything pulling Boost.Geometry
# / OpenVDB), so even `-j 2` OOMs and ninja reports `unable to rename
# temporary 'X.cpp-HASH.o.tmp'` (Clang SIGKILL'd between writing and
# renaming). Force serial when ASAN is on; total wall time 1.5-2 h
# but builds complete deterministically.
LIBSLIC3R_JOBS="$ORCAXR_JOBS"
if [[ "${ORCAXR_ASAN:-0}" == "1" ]]; then
    LIBSLIC3R_JOBS=1
fi
LIBSLIC3R_BUILD_ARGS=(cmake --build "$LIBSLIC3R_BUILD_DIR" --target libslic3r -j "$LIBSLIC3R_JOBS")
if [[ -n "${ORCAXR_LOAD_LIMIT:-}" ]]; then
    LIBSLIC3R_BUILD_ARGS+=(-- -l "$ORCAXR_LOAD_LIMIT")
fi
build_cmd "${LIBSLIC3R_BUILD_ARGS[@]}"

# Record the shim hash so subsequent runs skip the .o purge unless
# the shim contents change. Set after a successful build so an
# interrupted build doesn't leave the marker on a stale archive.
if [[ -d "${PATCHES_DIR}/tbb_serial/tbb" ]] && [[ -d "$LIBSLIC3R_BUILD_DIR" ]]; then
    SHIM_HASH=$( { cat "${PATCHES_DIR}/tbb_serial/tbb/"*.h \
                       "${ORCA_DIR}/src/libslic3r/MultiMaterialSegmentation.cpp" \
                       "${ORCA_DIR}/src/libslic3r/PrintObjectSlice.cpp" 2>/dev/null \
                   | sha256sum | awk '{print $1}'; } )
    echo "$SHIM_HASH" > "${LIBSLIC3R_BUILD_DIR}/.tbb_serial_shim_installed"
fi

echo
echo "=== success ==="
echo "libslic3r.a at: $LIBSLIC3R_BUILD_DIR/src/libslic3r/"
find "$LIBSLIC3R_BUILD_DIR/src/libslic3r" -name 'libslic3r*.a' 2>/dev/null | head
