# Audit H15 (2026-05-07) — assert all 8 `__wrap_scalable_*` trampolines
# landed in the linked libslic3r_jni.so. The `-Wl,--wrap=foo` linker
# directive renames any reference to `foo` into `__wrap_foo` at link
# time; if our trampolines DIDN'T land (e.g. lld changed semantics, the
# slic3r_jni.cpp definitions got renamed, --whole-archive grabbed an
# upstream definition first) we'd silently regress to TBB's broken
# scalable_malloc on Android arm64 (gotcha #18) and crash deep inside
# MMU slicing.
#
# Run as: cmake -DSO_PATH=/path/to/libslic3r_jni.so -DCMAKE_NM=/path/to/llvm-nm -P assert_wrap_symbols.cmake
#
# Required symbols — must match the `-Wl,--wrap=` set in CMakeLists.txt.
set(REQUIRED_WRAP_SYMBOLS
    __wrap_scalable_malloc
    __wrap_scalable_free
    __wrap_scalable_aligned_malloc
    __wrap_scalable_aligned_free
    __wrap_scalable_realloc
    __wrap_scalable_calloc
    __wrap_scalable_posix_memalign
    __wrap_scalable_msize
)

if(NOT EXISTS "${SO_PATH}")
    message(FATAL_ERROR "assert_wrap_symbols: SO_PATH does not exist: ${SO_PATH}")
endif()

if(NOT CMAKE_NM OR CMAKE_NM STREQUAL "CMAKE_NM-NOTFOUND")
    # AGP doesn't always populate CMAKE_NM — fall back to the
    # toolchain's llvm-nm which lives next to clang.
    get_filename_component(_toolchain_bin "${CMAKE_C_COMPILER}" DIRECTORY)
    set(CMAKE_NM "${_toolchain_bin}/llvm-nm")
    if(NOT EXISTS "${CMAKE_NM}")
        message(WARNING "assert_wrap_symbols: llvm-nm not found, skipping check (this is best-effort)")
        return()
    endif()
endif()

execute_process(
    COMMAND "${CMAKE_NM}" -D --defined-only "${SO_PATH}"
    OUTPUT_VARIABLE _nm_output
    RESULT_VARIABLE _nm_status
)

if(NOT _nm_status EQUAL 0)
    message(WARNING "assert_wrap_symbols: nm exited with ${_nm_status}, skipping check")
    return()
endif()

set(_missing "")
foreach(_sym IN LISTS REQUIRED_WRAP_SYMBOLS)
    if(NOT _nm_output MATCHES " ${_sym}\n")
        list(APPEND _missing "${_sym}")
    endif()
endforeach()

if(_missing)
    message(FATAL_ERROR
        "Audit H15 — missing __wrap_scalable_* trampoline(s) in "
        "${SO_PATH}: ${_missing}\n"
        "This regresses gotcha #18 (tbb::scalable_malloc broken on "
        "Android arm64). Check that slic3r_jni.cpp still defines the "
        "trampolines and that -Wl,--wrap=scalable_* is still in "
        "CMakeLists.txt's add_link_options.")
endif()

message(STATUS "assert_wrap_symbols: all 8 __wrap_scalable_* trampolines present in $<filename(${SO_PATH})>")
