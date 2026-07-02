// OrcaXR WASM binding — Phase 1 feasibility surface.
//
// Mirrors the smallest useful slice of slic3r_jni.cpp's nativeSlice flow:
// STL bytes in → G-code text out, entirely inside the WASM sandbox
// (MEMFS for the temp files). The web workspace grows richer bindings
// (3MF, per-object transforms, painted facets) in Phase 3; this file
// exists to prove the pipeline end-to-end.

#include <emscripten/bind.h>

#include <pthread.h>

// Emscripten's pthreads lack the GNU pthread_setname_np extension that
// TBB/Boost call to label worker threads — purely cosmetic, so no-op it.
extern "C" int pthread_setname_np(pthread_t, const char *) { return 0; }

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <thread>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

#include <tbb/global_control.h>

#include <boost/log/core.hpp>
#include <boost/log/trivial.hpp>

#include "libslic3r/Model.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"

namespace {

std::string read_all(const char *path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error(std::string("cannot read ") + path);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

void write_all(const char *path, const std::string &bytes)
{
    std::ofstream out(path, std::ios::binary);
    if (!out) throw std::runtime_error(std::string("cannot write ") + path);
    out.write(bytes.data(), (std::streamsize)bytes.size());
}

/// Slice an STL (raw file bytes) with default FDM settings, returning the
/// G-code text. Failures return a sentinel "ORCAXR_ERROR: <message>"
/// string — a WebAssembly.Exception crossing into JS carries no message,
/// so errors are passed by value instead.
std::string slice_stl_to_gcode_inner(const std::string &stl_bytes)
{
    const char *in_path = "/tmp/orcaxr_in.stl";
    const char *out_path = "/tmp/orcaxr_out.gcode";
    write_all(in_path, stl_bytes);
    fprintf(stderr, "[orcaxr] stl written (%zu bytes)\n", stl_bytes.size());

    Slic3r::Model model = Slic3r::Model::read_from_file(in_path);
    if (model.objects.empty())
        throw std::runtime_error("model loaded but contains no objects");
    model.add_default_instances();
    fprintf(stderr, "[orcaxr] model loaded: %zu object(s)\n", model.objects.size());

    Slic3r::DynamicPrintConfig cfg = Slic3r::DynamicPrintConfig::full_print_config();
    // The stock defaults enable relative extruder addressing without the
    // matching per-layer G92 E0 reset and fail validate(). Use absolute E.
    cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(false));
    fprintf(stderr, "[orcaxr] config ready\n");

    Slic3r::Print print;
    print.apply(model, cfg);
    fprintf(stderr, "[orcaxr] print.apply done\n");
    auto err = print.validate();
    if (!err.string.empty())
        throw std::runtime_error("validate failed: " + err.string);
    fprintf(stderr, "[orcaxr] validate ok\n");
    fprintf(stderr, "[orcaxr] probe: BOOST_LOG_TRIVIAL...\n");
    BOOST_LOG_TRIVIAL(info) << "orcaxr boost.log probe";
    fprintf(stderr, "[orcaxr] probe: boost.log OK — processing...\n");

    print.set_status_callback([](const Slic3r::PrintBase::SlicingStatus &st) {
        fprintf(stderr, "[orcaxr] %d%% %s\n", st.percent, st.text.c_str());
    });
    print.process();
    fprintf(stderr, "[orcaxr] process done — exporting gcode\n");

    Slic3r::GCodeProcessorResult result;
    print.export_gcode(out_path, &result, nullptr);
    fprintf(stderr, "[orcaxr] export done\n");

    std::string gcode = read_all(out_path);
    std::remove(in_path);
    std::remove(out_path);
    return gcode;
}

/// [max_threads] caps TBB parallelism for this call. Must stay below the
/// pre-allocated Emscripten pthread pool: workers beyond the pool would
/// need the JS event loop to spawn — which this synchronous call is
/// blocking — so an uncapped TBB (one worker per core) deadlocks the
/// first parallel_for on many-core machines. 1 = fully serial.
std::string slice_stl_to_gcode(const std::string &stl_bytes, int max_threads)
{
    if (max_threads < 1) max_threads = 1;
    fprintf(stderr, "[orcaxr] tbb max parallelism = %d\n", max_threads);
    tbb::global_control tbb_limit(
        tbb::global_control::max_allowed_parallelism, (size_t)max_threads);
    try {
        return slice_stl_to_gcode_inner(stl_bytes);
    } catch (const std::exception &e) {
        return std::string("ORCAXR_ERROR: ") + e.what();
    } catch (...) {
        return std::string("ORCAXR_ERROR: unknown C++ exception");
    }
}

std::string version_string()
{
    return std::string("libslic3r/OrcaSlicer WASM feasibility build");
}

} // namespace

// ---- async slice API -------------------------------------------------
// TBB worker scheduling on Emscripten needs the main JS thread in its
// event loop (oneTBB WASM_Support.md): a synchronous exported call that
// blocks main deadlocks the first parallel region. So the slice runs on
// its own pthread; JS starts it, returns to the event loop, and polls.
namespace {
std::atomic<int> g_slice_state{0}; // 0=idle 1=running 2=done
std::string g_slice_result;

void start_slice(const std::string &stl_bytes, int max_threads)
{
    int expected = 0;
    if (!g_slice_state.compare_exchange_strong(expected, 1)) return;
    std::thread([stl = stl_bytes, max_threads]() {
        g_slice_result = slice_stl_to_gcode(stl, max_threads);
        g_slice_state.store(2);
    }).detach();
}

/// Slice a file already written into MEMFS (e.g. via JS `FS.writeFile`,
/// which avoids the JS-string marshalling that corrupts binary bytes).
void start_slice_file(const std::string &path, int max_threads)
{
    int expected = 0;
    if (!g_slice_state.compare_exchange_strong(expected, 1)) return;
    std::thread([path, max_threads]() {
        try {
            g_slice_result = slice_stl_to_gcode(read_all(path.c_str()), max_threads);
        } catch (const std::exception &e) {
            g_slice_result = std::string("ORCAXR_ERROR: ") + e.what();
        }
        g_slice_state.store(2);
    }).detach();
}

/// "" while running; the G-code (or "ORCAXR_ERROR: ...") once done.
/// Reading the result resets the machine to idle.
std::string poll_slice()
{
    if (g_slice_state.load() != 2) return std::string();
    std::string out = std::move(g_slice_result);
    g_slice_result.clear();
    g_slice_state.store(0);
    return out;
}
} // namespace

EMSCRIPTEN_BINDINGS(orcaxr_slic3r)
{
    emscripten::function("sliceStlToGcode", &slice_stl_to_gcode);
    emscripten::function("startSlice", &start_slice);
    emscripten::function("startSliceFile", &start_slice_file);
    emscripten::function("pollSlice", &poll_slice);
    emscripten::function("versionString", &version_string);
}
