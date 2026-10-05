cmake_minimum_required(VERSION 3.22)

# Added from the pinned engine's src/ directory; the engine remains the root
# CMake project because its recipes use CMAKE_SOURCE_DIR for bundled libraries.
if (NOT ANDROID OR NOT TARGET libslic3r)
    message(FATAL_ERROR "Configure this probe through the Android engine build")
endif()

add_executable(orcaxr_slice_probe slice_probe.cpp defaults_probe.cpp)
target_compile_features(orcaxr_slice_probe PRIVATE cxx_std_17)
target_include_directories(orcaxr_slice_probe PRIVATE "${CMAKE_SOURCE_DIR}/src")
target_link_libraries(orcaxr_slice_probe PRIVATE libslic3r boost_libs cereal::cereal nlohmann_json)
