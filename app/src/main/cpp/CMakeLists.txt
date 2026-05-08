# OrcaXR native bridge.
#
# Links a thin JNI shim (slic3r_jni.cpp) against the pre-built
# libslic3r.a produced by scripts/build_native.sh, plus all of
# libslic3r's transitive C++ dep archive. Result: slic3r_jni.so
# staged into the APK under jniLibs/arm64-v8a/.
#
# libslic3r.a is ~1.3 GB and links to ~20 transitive static archives
# (Boost, TBB, CGAL, OpenVDB, OpenCV, OCCT, Draco, NLopt, GMP, MPFR,
# OpenSSL::Crypto, JPEG, PNG, ZLIB, EXPAT, Freetype, Clipper2, mcut,
# admesh, qhull, miniz, qoi, semver, libnoise, glu-libtess). The first
# link attempt WILL surface missing symbols / archive ordering issues;
# expected, documented in DESIGN.md's compile grind log.

cmake_minimum_required(VERSION 3.22)
project(slic3r_jni CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Optional: build slic3r_jni.so with AddressSanitizer to debug the
# multi-color slicing race in libslic3r's MMS code path. Enable by
# passing -DORCAXR_ASAN=ON to AGP/CMake (or set the project property
# in app/build.gradle.kts: defaultConfig.externalNativeBuild.cmake.arguments
# += "-DORCAXR_ASAN=ON"). Pair with rebuilt libslic3r.a via
# ORCAXR_ASAN=1 ./scripts/build_native.sh — both the .a and the .so
# need ASAN flags so all instrumented code resolves __asan_* symbols
# at the .so link step. The runtime
# (libclang_rt.asan-aarch64-android.so) ships in jniLibs/ and gets
# preloaded by app/src/main/resources/lib/<abi>/wrap.sh on app start.
option(ORCAXR_ASAN "Build with AddressSanitizer (debug only)" OFF)
if (ORCAXR_ASAN)
    message(STATUS "OrcaXR: AddressSanitizer enabled for slic3r_jni")
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer -fno-optimize-sibling-calls)
    add_link_options(-fsanitize=address)
endif()

# Audit H15 (2026-05-07) — hardening flags for the in-tree JNI shim.
# Apply via add_compile_options so they hit slic3r_jni.cpp,
# nanosvg_impl.cpp, and thumbnail_render.cpp; the libslic3r static
# archives are pre-built upstream and aren't reached by these flags
# (their hardening is libslic3r's concern). Defense-in-depth against
# format-string bugs / stack-smashing in the shim's argument parsing
# and ByteArray/JNI marshalling — every JNI entry takes attacker-
# influenced bytes (model files, paint masks, gcode paths).
#
# - `-Wformat=2 -Wformat-security` — surface non-literal format
#   strings at compile time. Cheap, no runtime cost.
# - `-fstack-protector-strong` — emit canaries on functions that take
#   a buffer-sized array or address-of-local. ABI-stable, ~1% perf.
# - `-D_FORTIFY_SOURCE=2` — replace memcpy / strcpy / sprintf with
#   bounds-checked variants when the compiler can prove the size.
#   No-op at -O0 (debug); active at -O1+ which AGP uses for release.
# - `-fstack-clash-protection` — probe the stack page-by-page so a
#   pathological allocation can't jump the guard page. Available on
#   AArch64 since clang 12; we pin Clang ≥ 17 (gotcha #29) so always
#   present.
add_compile_options(
    -Wformat=2
    -Wformat-security
    -fstack-protector-strong
    -D_FORTIFY_SOURCE=2
    -fstack-clash-protection
)

# OrcaXR Android: tbb's scalable_malloc/scalable_free appear to be
# broken on Android arm64 — vectors using `tbb::scalable_allocator<X>`
# (notably Slic3r::Points = vector<Point, scalable_allocator<Point>>)
# come back with garbage internal data() pointers, which crashes
# get_extents/bounding_box deep inside the MMU slicing pipeline even
# under our serial TBB shim. Link-time wrap so every call to
# scalable_malloc/scalable_free routes through libc malloc/free
# instead — no header changes, no template breakage, just intercept
# the two functions. Defined in slic3r_jni.cpp as __wrap_scalable_*
# stubs that delegate to malloc/free.
add_link_options(
    -Wl,--wrap=scalable_malloc
    -Wl,--wrap=scalable_free
    -Wl,--wrap=scalable_aligned_malloc
    -Wl,--wrap=scalable_aligned_free
    -Wl,--wrap=scalable_realloc
    -Wl,--wrap=scalable_calloc
    -Wl,--wrap=scalable_posix_memalign
    -Wl,--wrap=scalable_msize
)

# Paths to the out-of-tree libslic3r build. Parameterized on ANDROID_ABI
# so other ABIs can be added later without editing this file.
set(ORCAXR_REPO_ROOT   "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")
set(ORCAXR_ORCA_ROOT   "${ORCAXR_REPO_ROOT}/third_party/OrcaSlicer")
set(ORCAXR_DEPS_DIR    "${ORCAXR_ORCA_ROOT}/deps/build-android-${ANDROID_ABI}/OrcaSlicer_dep/usr/local")
set(ORCAXR_SLIC3R_BIN  "${ORCAXR_ORCA_ROOT}/build-android-${ANDROID_ABI}")

if (NOT EXISTS "${ORCAXR_SLIC3R_BIN}/src/libslic3r/liblibslic3r.a")
    message(FATAL_ERROR
        "liblibslic3r.a not found at ${ORCAXR_SLIC3R_BIN}/src/libslic3r/.\n"
        "Run scripts/build_native.sh from the repo root first.")
endif()

include_directories(
    "${ORCAXR_ORCA_ROOT}/src/libslic3r"
    # libslic3r_version.h is generated at libslic3r build time under
    # the out-of-tree build directory, not the source tree.
    "${ORCAXR_SLIC3R_BIN}/src/libslic3r"
    "${ORCAXR_ORCA_ROOT}/deps_src/clipper2/Clipper2Lib/include"
)

# SYSTEM include dirs — mirroring libslic3r's own compile flags (extracted
# from the working build.ninja at
# third_party/OrcaSlicer/build-android-arm64-v8a/build.ninja). Notable
# quirk: `deps_src/admesh/..` silently adds deps_src/ itself to the search
# path, which is how `#include "semver/semver.h"` resolves even though
# semver/ only publishes its own dir.
include_directories(SYSTEM
    "${ORCAXR_ORCA_ROOT}/src"
    "${ORCAXR_ORCA_ROOT}/src/eigen"
    "${ORCAXR_ORCA_ROOT}/src/libigl"
    "${ORCAXR_ORCA_ROOT}/deps_src/admesh"
    "${ORCAXR_ORCA_ROOT}/deps_src/admesh/.."
    "${ORCAXR_ORCA_ROOT}/deps_src/clipper"
    "${ORCAXR_ORCA_ROOT}/deps_src/eigen"
    "${ORCAXR_ORCA_ROOT}/deps_src/glu-libtess"
    "${ORCAXR_ORCA_ROOT}/deps_src/glu-libtess/include"
    "${ORCAXR_ORCA_ROOT}/deps_src/libigl"
    "${ORCAXR_ORCA_ROOT}/deps_src/libnest2d/include"
    "${ORCAXR_ORCA_ROOT}/deps_src/mcut/include"
    "${ORCAXR_ORCA_ROOT}/deps_src/miniz"
    "${ORCAXR_ORCA_ROOT}/deps_src/nanosvg"
    "${ORCAXR_ORCA_ROOT}/deps_src/semver"
    "${ORCAXR_DEPS_DIR}/include"
    "${ORCAXR_DEPS_DIR}/include/opencascade"
    "${ORCAXR_DEPS_DIR}/include/OpenEXR"
    "${ORCAXR_DEPS_DIR}/sdk/native/jni/include"
)

add_library(slic3r_jni SHARED
    slic3r_jni.cpp
    nanosvg_impl.cpp
    thumbnail_render.cpp
    # M8b — native BVH ray-mask projection. Self-contained
    # (libslic3r-free) C++ port of AiMaskProjection.project for
    # paint_projected_mask. Lives behind an opt-in NativeBvh flag in
    # Kotlin; the existing Kotlin path is the default until on-device
    # parity + speedup are confirmed via benchmark_native_bvh.
    ai_bvh.cpp
    ai_bvh_jni.cpp
)

# First-pass link set. libslic3r.a goes inside --whole-archive because we
# cannot predict which of its ~58k symbols the (future, growing) JNI shim
# will actually reference; without --whole-archive, gc-sections would
# strip anything the current stub doesn't touch, only for the link to
# fail the moment we add a second JNI entry. Dep archives stay outside so
# the linker can gc-sections them freely.
#
# Ordering matters: libslic3r_cgal.a before libslic3r.a (deeper call
# graph consumes shallower); deps in dependency order (CGAL → GMP/MPFR;
# OpenVDB → TBB/Blosc/OpenEXR; etc.).
#
# TODO(phase 0): the full dep list needs to be enumerated. Expect the
# first Gradle build to surface undefined-symbol batches; resolve each
# by adding the missing archive here. Record each fix in DESIGN.md's
# compile grind log.
# Collect all the static archives — libslic3r + its deps — into a single
# --start-group/--end-group block. Static archive link order matters for
# traditional linkers (each .a is read once) and this archive set is
# densely interdependent (CGAL↔GMP↔Boost, OCCT's 30-lib sibling mesh,
# OpenVDB↔TBB↔Blosc↔OpenEXR). Group linking has the linker re-scan the
# set until all symbols resolve or it stalls, at cost of a longer link.
file(GLOB ORCAXR_OCCT_LIBS "${ORCAXR_DEPS_DIR}/lib/libTK*.a")
set(ORCAXR_STATIC_ARCHIVES
    # libslic3r's own built archives (deeper call graph first)
    "${ORCAXR_SLIC3R_BIN}/src/libslic3r/liblibslic3r_cgal.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/admesh/libadmesh.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/clipper/libclipper.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/clipper2/libClipper2.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/glu-libtess/libglu-libtess.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/mcut/libmcut.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/miniz/libminiz_static.a"
    "${ORCAXR_SLIC3R_BIN}/deps_src/qoi/libqoi.a"
    "${ORCAXR_SLIC3R_BIN}/lib/libsemver.a"

    # Installed deps under destdir (Boost 1.84 ships system+regex as
    # header-only, so no .a for those).
    "${ORCAXR_DEPS_DIR}/lib/libboost_filesystem.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_thread.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_log.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_log_setup.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_locale.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_chrono.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_atomic.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_date_time.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_iostreams.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_program_options.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_nowide.a"
    "${ORCAXR_DEPS_DIR}/lib/libboost_container.a"
    "${ORCAXR_DEPS_DIR}/lib/libtbb.a"
    "${ORCAXR_DEPS_DIR}/lib/libtbbmalloc.a"
    "${ORCAXR_DEPS_DIR}/lib/libopenvdb.a"
    "${ORCAXR_DEPS_DIR}/lib/libnlopt.a"
    "${ORCAXR_DEPS_DIR}/lib/libdraco.a"
    "${ORCAXR_DEPS_DIR}/lib/liblibnoise_static.a"
    "${ORCAXR_DEPS_DIR}/lib/libgmp.a"
    "${ORCAXR_DEPS_DIR}/lib/libmpfr.a"
    "${ORCAXR_DEPS_DIR}/lib/libcrypto.a"
    "${ORCAXR_DEPS_DIR}/lib/libjpeg.a"
    "${ORCAXR_DEPS_DIR}/lib/libpng16.a"
    "${ORCAXR_DEPS_DIR}/lib/libexpat.a"
    "${ORCAXR_DEPS_DIR}/lib/libfreetype.a"
    "${ORCAXR_DEPS_DIR}/lib/libqhullcpp.a"
    "${ORCAXR_DEPS_DIR}/lib/libqhullstatic_r.a"
    # OpenCV's Android install parks static libs under sdk/native/...
    "${ORCAXR_DEPS_DIR}/sdk/native/staticlibs/arm64-v8a/libopencv_world.a"
    # OpenCV's Android build includes tegra_hal (ARM NEON / Carotene
    # optimized routines) and libcpufeatures as 3rdparty sub-libs.
    "${ORCAXR_DEPS_DIR}/sdk/native/3rdparty/libs/arm64-v8a/libtegra_hal.a"
    "${ORCAXR_DEPS_DIR}/sdk/native/3rdparty/libs/arm64-v8a/libcpufeatures.a"
    "${ORCAXR_DEPS_DIR}/sdk/native/3rdparty/libs/arm64-v8a/liblibtiff.a"
    "${ORCAXR_DEPS_DIR}/sdk/native/3rdparty/libs/arm64-v8a/liblibpng.a"
    ${ORCAXR_OCCT_LIBS}
)

# Audit H15 — assert the `__wrap_scalable_*` trampolines (gotcha #18 —
# tbb::scalable_malloc miscompiles on Android arm64) actually landed
# in the linked .so. A future `lld` change could silently break the
# `-Wl,--wrap=` mechanism (e.g. if symbol pre-mangling diverges); the
# slicer would then crash deep inside the MMU pipeline with no
# obvious signal pointing back at the link wrapping. Run `nm` on the
# output .so and require all 8 wrap symbols to be present. Fast
# (single nm call); no toolchain dependencies beyond what AGP already
# pulls.
function(orcaxr_assert_wrap_symbols target)
    add_custom_command(TARGET ${target} POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSO_PATH=$<TARGET_FILE:${target}>
            -DCMAKE_NM=${CMAKE_NM}
            -P ${CMAKE_CURRENT_SOURCE_DIR}/assert_wrap_symbols.cmake
        VERBATIM)
endfunction()

target_link_libraries(slic3r_jni PRIVATE
    # --whole-archive for libslic3r.a was tempting (grab all 58k symbols
    # regardless of what the shim calls today), but it drags in 4
    # unresolved externals the current shim never reaches:
    #   - RGB2HSV (defined in src/slic3r/Utils/, GUI layer — not linked)
    #   - Slic3r::ExtrusionEntity::string_to_role
    #   - Slic3r::png::write_rgb_to_file_scaled
    #   - Slic3r::string_to_double_decimal_point
    # Let --gc-sections prune. When we add a JNI entry that transitively
    # needs any of these, we'll either vendor the missing .cpp sources
    # into the shim or take the layering issue upstream.
    "-Wl,--start-group"
    "${ORCAXR_SLIC3R_BIN}/src/libslic3r/liblibslic3r.a"
    ${ORCAXR_STATIC_ARCHIVES}
    "-Wl,--end-group"

    # System libs.
    # -lc++_shared explicit because AGP 9 + NDK r29 + externalNativeBuild
    # don't auto-add it. Without it,
    # __from_chars_floating_point<float> (a weak libc++ symbol that
    # libslic3r references via std::from_chars) goes unresolved.
    "-lc++_shared"
    log
    android
    z
    m
)

# Audit H15 — register the wrap-symbol assertion for slic3r_jni. Done
# AFTER target_link_libraries so the link command has been registered
# (the POST_BUILD command attaches to the link step, not the compile
# step).
orcaxr_assert_wrap_symbols(slic3r_jni)
