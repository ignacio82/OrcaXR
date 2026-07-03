// OrcaXR WASM binding — Phase 1 feasibility surface.
//
// Mirrors the smallest useful slice of slic3r_jni.cpp's nativeSlice flow:
// STL bytes in → G-code text out, entirely inside the WASM sandbox
// (MEMFS for the temp files). The web workspace grows richer bindings
// (3MF, per-object transforms, painted facets) in Phase 3; this file
// exists to prove the pipeline end-to-end.

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <sys/stat.h>

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

#include <nlohmann/json.hpp>

#include <cstring>

#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/Utils.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/MeshBoolean.hpp"
#include "libslic3r/Format/STL.hpp"

namespace {

/**
 * Re-attach enum_keys_map to generic-enum options — full_print_config()
 * seeds them without it and any set_deserialize on such a key derefs a
 * null map. Ported verbatim from the Android slic3r_jni.cpp (field-
 * proven fix; covers the nullable variant too).
 */
void fixup_enum_keys_map(Slic3r::DynamicPrintConfig &cfg)
{
    const Slic3r::ConfigDef *config_def = cfg.def();
    if (config_def == nullptr) return;
    for (const auto &kv : config_def->options) {
        const auto &key = kv.first;
        const Slic3r::ConfigOptionDef &opt_def = kv.second;
        if (opt_def.type != Slic3r::coEnums || opt_def.enum_keys_map == nullptr)
            continue;
        Slic3r::ConfigOption *opt = cfg.option(key, false);
        if (opt == nullptr) continue;
        if (auto *en = dynamic_cast<Slic3r::ConfigOptionEnumsGeneric *>(opt)) {
            if (en->keys_map == nullptr) en->keys_map = opt_def.enum_keys_map;
        } else if (auto *enn = dynamic_cast<Slic3r::ConfigOptionEnumsGenericNullable *>(opt)) {
            if (enn->keys_map == nullptr) enn->keys_map = opt_def.enum_keys_map;
        }
    }
}

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
static void ensure_resources()
{
    static bool done = false;
    if (done) return;
    done = true;
    ::mkdir("/resources", 0777);
    ::mkdir("/resources/info", 0777);
    const struct { const char *path; const char *body; } kFiles[] = {
        {"/resources/info/nozzle_info.json", "{\n    \"version\": \"1.0.0.3\",\n    \"nozzle_hrc\": {\n        \"hardened_steel\": 55,\n        \"stainless_steel\": 20,\n        \"tungsten_carbide\": 85,\n        \"brass\": 2,\n        \"E3D\": 55,\n        \"undefine\": 0\n    }\n}"},
        {"/resources/info/filament_info.json", "{\n    \"version\": \"1.0.0.4\",\n    \"high_temp_filament\": [\n        \"ABS\",\n        \"ASA\",\n        \"ASA-CF\",\n        \"PC\",\n        \"PA\",\n        \"PA-CF\",\n        \"PA-GF\",\n        \"PA6-CF\",\n        \"PET-CF\",\n        \"PPS\",\n        \"PPS-CF\",\n        \"PPA-CF\",\n        \"PPA-GF\",\n        \"ABS-GF\",\n        \"ASA-AERO\"\n    ],\n    \"low_temp_filament\": [\n        \"PLA\",\n        \"TPU\",\n        \"TPU-AMS\",\n        \"PLA-CF\",\n        \"PLA-AERO\",\n        \"PVA\",\n        \"BVOH\",\n        \"PCTG\",\n        \"PETG\",\n        \"PETG-CF\",\n        \"SBS\"\n    ],\n    \"high_low_compatible_filament\":[\n        \"HIPS\",\n        \"PE\",\n        \"PP\",\n        \"EVA\",\n        \"PE-CF\",\n        \"PP-CF\",\n        \"PP-GF\",\n        \"PHA\"\n    ]\n}"},
        {"/resources/info/nozzle_incompatibles.json", "{\n    \"incompatible_nozzles\":{\n        \"Standard\":{\n            \"0.2\":[\n                \"Bambu PLA Marble\",\n                \"Bambu PLA Sparkle\",\n                \"Bambu PLA Wood\",\n                \"Bambu PLA Galaxy\",\n                \"Bambu PETG Translucent\"\n            ],\n            \"0.4\":[],\n            \"0.6\":[\n                \"Bambu PLA Silk+\",\n                \"Bambu PLA Silk\",\n                \"Bambu PLA Aero\",\n                \"Bambu ASA-Aero\"\n            ],\n            \"0.8\":[\n                \"Bambu PLA Silk+\",\n                \"Bambu PLA Silk\",\n                \"Bambu PLA Aero\",\n                \"Bambu ASA-Aero\"\n            ]\n        },\n        \"High Flow\":{\n            \"0.4\":[\n                \"Bambu PLA-CF\",\n                \"Bambu PETG-CF\",\n                \"Bambu ASA-CF\",\n                \"Bambu PAHT-CF\",\n                \"Bambu PET-CF\",\n                \"Bambu PA6-CF\",\n                \"Bambu PA6-GF\",\n                \"Bambu PPA-CF\",\n                \"Bambu PPS-CF\"\n            ],\n            \"0.6\":[],\n            \"0.8\":[]\n        }\n    }\n}"},
    };
    for (const auto &f : kFiles) {
        if (FILE *fp = fopen(f.path, "w")) { fputs(f.body, fp); fclose(fp); }
    }
    Slic3r::set_resources_dir("/resources");
}

// Shared tail: build config from overrides, slice [model], return G-code.
// [num_filaments] > 1 sizes the per-filament config vectors up front so
// volume extruder assignments beyond filament 1 aren't clamped back to 0.
std::string finish_slice(Slic3r::Model &model, const std::string &overrides_json,
                         int num_filaments = 1)
{
    const char *out_path = "/tmp/orcaxr_out.gcode";
    Slic3r::DynamicPrintConfig cfg = Slic3r::DynamicPrintConfig::full_print_config();
    fixup_enum_keys_map(cfg);
    if (num_filaments > 1) {
        cfg.set_num_extruders((unsigned int)num_filaments);
        fprintf(stderr, "[orcaxr] num_filaments = %d\n", num_filaments);
    }
    // Relative E + profile-supplied G92 E0 per layer (mirrors the Android
    // build; profiles like the ECC/U1 stock chains carry the reset in
    // their layer-change gcode).
    cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(true));

    // Apply flat key=value overrides (a flattened OrcaSlicer profile from
    // the web ProfileLoader). Rejections are logged, never fatal.
    if (!overrides_json.empty()) {
        Slic3r::ConfigSubstitutionContext subs(Slic3r::ForwardCompatibilitySubstitutionRule::Enable);
        try {
            auto j = nlohmann::json::parse(overrides_json);
            size_t applied = 0, rejected = 0;
            for (auto it = j.begin(); it != j.end(); ++it) {
                const std::string key = it.key();
                const std::string value = it.value().is_string()
                    ? it.value().get<std::string>()
                    : it.value().dump();
                if (cfg.set_deserialize_nothrow(key, value, subs)) {
                    ++applied;
                } else {
                    ++rejected;
                    fprintf(stderr, "[orcaxr] cfg rejected: %s=%s\n", key.c_str(), value.c_str());
                }
            }
            fprintf(stderr, "[orcaxr] profile overrides: %zu applied, %zu rejected\n", applied, rejected);
        } catch (const std::exception &e) {
            fprintf(stderr, "[orcaxr] overrides parse failed: %s\n", e.what());
        }
    }
    // The absolute-E fallback stays for profile-less slicing.
    if (overrides_json.empty())
        cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(false));

    // Consistency guard: relative E requires a per-layer G92 E0 in the
    // layer-change gcode. If the applied profile ended up without one
    // (partial profile load, hand-rolled config, …), flip to absolute E
    // instead of failing validate().
    {
        auto contains_g92 = [&cfg](const char *key) {
            const auto *opt = cfg.option<Slic3r::ConfigOptionString>(key);
            return opt != nullptr && opt->value.find("G92 E0") != std::string::npos;
        };
        const auto *rel = cfg.option<Slic3r::ConfigOptionBool>("use_relative_e_distances");
        if (rel != nullptr && rel->value &&
            !contains_g92("layer_change_gcode") &&
            !contains_g92("before_layer_change_gcode")) {
            fprintf(stderr, "[orcaxr] relative E without per-layer G92 E0 — forcing absolute E\n");
            cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(false));
        }
    }
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
    std::remove(out_path);
    return gcode;
}

std::string slice_stl_to_gcode_inner(const std::string &stl_bytes,
                                     const std::string &overrides_json)
{
    ensure_resources();
    // Pick the extension by content so Model::read_from_file dispatches the
    // right parser: a 3MF is a ZIP ("PK\x03\x04"); everything else is STL.
    const bool is_3mf = stl_bytes.size() > 4 && stl_bytes[0] == 'P' &&
                        stl_bytes[1] == 'K' && stl_bytes[2] == 0x03 &&
                        stl_bytes[3] == 0x04;
    const char *in_path = is_3mf ? "/tmp/orcaxr_in.3mf" : "/tmp/orcaxr_in.stl";
    write_all(in_path, stl_bytes);
    fprintf(stderr, "[orcaxr] model written (%zu bytes, %s)\n", stl_bytes.size(),
            is_3mf ? "3mf" : "stl");

    Slic3r::Model model = Slic3r::Model::read_from_file(in_path);
    if (model.objects.empty())
        throw std::runtime_error("model loaded but contains no objects");
    model.add_default_instances();
    fprintf(stderr, "[orcaxr] model loaded: %zu object(s)\n", model.objects.size());
    std::string gcode = finish_slice(model, overrides_json);
    std::remove(in_path);
    return gcode;
}

/**
 * Slice a PAINTED model: [positions] is a flat Float32 array of triangle
 * corners in printer space (9 floats/triangle, already baked & bed-dropped);
 * [tri_filament] gives each triangle's 0-based filament index. Triangles are
 * split into one ModelVolume per filament, each assigned that extruder, so
 * libslic3r emits real multi-material tool changes. This sidesteps the Bambu
 * 3MF loader entirely (which rejects hand-authored files).
 */
std::string slice_painted_inner(const std::vector<float> &positions,
                                const std::vector<int> &tri_filament,
                                int filament_count,
                                const std::string &overrides_json)
{
    ensure_resources();
    const size_t num_tris = tri_filament.size();
    if (num_tris == 0 || positions.size() < num_tris * 9)
        throw std::runtime_error("painted slice: empty or malformed geometry");
    if (filament_count < 1) filament_count = 1;

    Slic3r::Model model;
    Slic3r::ModelObject *obj = model.add_object();
    obj->name = "painted";
    int volumes = 0;
    for (int f = 0; f < filament_count; ++f) {
        indexed_triangle_set its;
        for (size_t t = 0; t < num_tris; ++t) {
            if (tri_filament[t] != f) continue;
            const int base = (int)its.vertices.size();
            for (int k = 0; k < 3; ++k) {
                const size_t o = t * 9 + k * 3;
                its.vertices.emplace_back(positions[o], positions[o + 1], positions[o + 2]);
            }
            its.indices.emplace_back(base, base + 1, base + 2);
        }
        if (its.indices.empty()) continue;
        Slic3r::TriangleMesh mesh(its);
        Slic3r::ModelVolume *v = obj->add_volume(mesh);
        v->set_type(Slic3r::ModelVolumeType::MODEL_PART);
        v->config.set_key_value("extruder", new Slic3r::ConfigOptionInt(f + 1));
        volumes++;
    }
    if (volumes == 0)
        throw std::runtime_error("painted slice: no triangles assigned");
    model.add_default_instances();
    fprintf(stderr, "[orcaxr] painted model: %d volume(s)\n", volumes);
    return finish_slice(model, overrides_json, filament_count);
}

/// [max_threads] caps TBB parallelism for this call. Must stay below the
/// pre-allocated Emscripten pthread pool: workers beyond the pool would
/// need the JS event loop to spawn — which this synchronous call is
/// blocking — so an uncapped TBB (one worker per core) deadlocks the
/// first parallel_for on many-core machines. 1 = fully serial.
std::string slice_stl_to_gcode(const std::string &stl_bytes, int max_threads,
                               const std::string &overrides_json)
{
    if (max_threads < 1) max_threads = 1;
    fprintf(stderr, "[orcaxr] tbb max parallelism = %d, heap = %zu MB\n",
            max_threads, emscripten_get_heap_size() / (1024 * 1024));
    tbb::global_control tbb_limit(
        tbb::global_control::max_allowed_parallelism, (size_t)max_threads);
    try {
        return slice_stl_to_gcode_inner(stl_bytes, overrides_json);
    } catch (const std::exception &e) {
        return std::string("ORCAXR_ERROR: ") + e.what();
    } catch (...) {
        return std::string("ORCAXR_ERROR: unknown C++ exception");
    }
}

std::string heap_report()
{
    char buf[64];
    snprintf(buf, sizeof buf, "%zu", emscripten_get_heap_size());
    return std::string(buf);
}

std::string version_string()
{
    return std::string("libslic3r/OrcaSlicer WASM feasibility build");
}

std::string repair_stl_inner(const std::string &stl_bytes)
{
    const char *in_path = "/tmp/repair_in.stl";
    const char *out_path = "/tmp/repair_out.stl";
    write_all(in_path, stl_bytes);

    Slic3r::Model model;
    try {
        model = Slic3r::Model::read_from_file(in_path);
    } catch (const std::exception &e) {
        throw std::runtime_error(std::string("read failed: ") + e.what());
    }
    if (model.objects.empty()) {
        throw std::runtime_error("empty model");
    }

    Slic3r::ModelObject* mo = model.objects.front();
    Slic3r::TriangleMesh mesh = mo->mesh();
    if (mesh.empty()) {
        throw std::runtime_error("mesh empty after aggregation");
    }

    Slic3r::its_merge_vertices(mesh.its);
    Slic3r::its_remove_degenerate_faces(mesh.its);
    Slic3r::its_compactify_vertices(mesh.its);

    if (mesh.its.indices.empty()) {
        throw std::runtime_error("mesh consumed by cleanup pass");
    }

    const size_t open_after_admesh = Slic3r::its_num_open_edges(mesh.its);
    bool self_intersect = false;
    try {
        self_intersect = Slic3r::MeshBoolean::cgal::does_self_intersect(mesh);
    } catch (...) {
        self_intersect = true;
    }

    if (open_after_admesh > 0 || self_intersect) {
        Slic3r::TriangleMesh attempt = mesh;
        try {
            Slic3r::MeshBoolean::self_union(attempt);
            if (!attempt.empty()) {
                mesh = std::move(attempt);
            }
        } catch (...) {
            // Keep ADMesh result on failure
        }
    }

    if (!Slic3r::store_stl(out_path, &mesh, true)) {
        throw std::runtime_error("store_stl failed");
    }

    std::string out_bytes = read_all(out_path);
    std::remove(in_path);(void)0;
    std::remove(out_path);
    return out_bytes;
}

std::string repair_stl_to_stl(const std::string &stl_bytes, int max_threads)
{
    if (max_threads < 1) max_threads = 1;
    tbb::global_control tbb_limit(
        tbb::global_control::max_allowed_parallelism, (size_t)max_threads);
    try {
        return repair_stl_inner(stl_bytes);
    } catch (const std::exception &e) {
        return std::string("ORCAXR_ERROR: ") + e.what();
    } catch (...) {
        return std::string("ORCAXR_ERROR: unknown C++ exception");
    }
}

std::string mesh_boolean_inner(const std::string &stl_a, const std::string &stl_b, const std::string &op)
{
    const char *in_a = "/tmp/bool_a.stl";
    const char *in_b = "/tmp/bool_b.stl";
    const char *out_path = "/tmp/bool_out.stl";
    write_all(in_a, stl_a);
    write_all(in_b, stl_b);

    Slic3r::Model modelA, modelB;
    try {
        modelA = Slic3r::Model::read_from_file(in_a);
        modelB = Slic3r::Model::read_from_file(in_b);
    } catch (const std::exception &e) {
        throw std::runtime_error(std::string("read failed: ") + e.what());
    }

    if (modelA.objects.empty() || modelB.objects.empty()) {
        throw std::runtime_error("empty model");
    }

    Slic3r::TriangleMesh meshA = modelA.objects.front()->mesh();
    Slic3r::TriangleMesh meshB = modelB.objects.front()->mesh();

    if (!modelA.objects.front()->instances.empty()) {
        meshA.transform(modelA.objects.front()->instances.front()->get_matrix());
    }
    if (!modelB.objects.front()->instances.empty()) {
        meshB.transform(modelB.objects.front()->instances.front()->get_matrix());
    }

    std::vector<Slic3r::TriangleMesh> result_meshes;
    try {
        Slic3r::MeshBoolean::mcut::make_boolean(meshA, meshB, result_meshes, op.c_str());
    } catch (const std::exception &e) {
        throw std::runtime_error(std::string("make_boolean failed: ") + e.what());
    }

    if (result_meshes.empty()) {
        throw std::runtime_error("result is empty");
    }

    Slic3r::TriangleMesh merged = result_meshes.front();
    for (size_t i = 1; i < result_meshes.size(); ++i) {
        merged.merge(result_meshes[i]);
    }

    if (merged.empty()) {
        throw std::runtime_error("merged result is empty");
    }

    if (!Slic3r::store_stl(out_path, &merged, true)) {
        throw std::runtime_error("store_stl failed");
    }

    std::string out_bytes = read_all(out_path);
    std::remove(in_a);
    std::remove(in_b);
    std::remove(out_path);
    return out_bytes;
}

std::string mesh_boolean_to_stl(const std::string &stl_a, const std::string &stl_b, const std::string &op, int max_threads)
{
    if (max_threads < 1) max_threads = 1;
    tbb::global_control tbb_limit(
        tbb::global_control::max_allowed_parallelism, (size_t)max_threads);
    try {
        return mesh_boolean_inner(stl_a, stl_b, op);
    } catch (const std::exception &e) {
        return std::string("ORCAXR_ERROR: ") + e.what();
    } catch (...) {
        return std::string("ORCAXR_ERROR: unknown C++ exception");
    }
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
        g_slice_result = slice_stl_to_gcode(stl, max_threads, std::string());
        g_slice_state.store(2);
    }).detach();
}

/// Slice a file already written into MEMFS (e.g. via JS `FS.writeFile`,
/// which avoids the JS-string marshalling that corrupts binary bytes).
void start_slice_file(const std::string &path, int max_threads,
                      const std::string &overrides_json)
{
    int expected = 0;
    if (!g_slice_state.compare_exchange_strong(expected, 1)) return;
    std::thread([path, max_threads, overrides_json]() {
        try {
            g_slice_result =
                slice_stl_to_gcode(read_all(path.c_str()), max_threads, overrides_json);
        } catch (const std::exception &e) {
            g_slice_result = std::string("ORCAXR_ERROR: ") + e.what();
        }
        g_slice_state.store(2);
    }).detach();
}

/// Slice a painted model. [pos_path] is a raw little-endian Float32 buffer
/// of 9 floats/triangle; [fil_path] a raw Int32 buffer of one filament index
/// per triangle — both written into MEMFS by JS FS.writeFile.
void start_slice_painted(const std::string &pos_path, const std::string &fil_path,
                         int filament_count, int max_threads,
                         const std::string &overrides_json)
{
    int expected = 0;
    if (!g_slice_state.compare_exchange_strong(expected, 1)) return;
    std::thread([pos_path, fil_path, filament_count, max_threads, overrides_json]() {
        const int threads = max_threads < 1 ? 1 : max_threads;
        tbb::global_control tbb_limit(
            tbb::global_control::max_allowed_parallelism, (size_t)threads);
        try {
            std::string pos_bytes = read_all(pos_path.c_str());
            std::string fil_bytes = read_all(fil_path.c_str());
            std::vector<float> positions(pos_bytes.size() / sizeof(float));
            std::memcpy(positions.data(), pos_bytes.data(), positions.size() * sizeof(float));
            std::vector<int> tri_filament(fil_bytes.size() / sizeof(int));
            std::memcpy(tri_filament.data(), fil_bytes.data(), tri_filament.size() * sizeof(int));
            g_slice_result = slice_painted_inner(positions, tri_filament,
                                                 filament_count, overrides_json);
        } catch (const std::exception &e) {
            g_slice_result = std::string("ORCAXR_ERROR: ") + e.what();
        } catch (...) {
            g_slice_result = std::string("ORCAXR_ERROR: unknown C++ exception");
        }
        std::remove(pos_path.c_str());
        std::remove(fil_path.c_str());
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

std::atomic<int> g_repair_state{0};
std::string g_repair_result;

void start_repair(const std::string &stl_bytes, int max_threads)
{
    int expected = 0;
    if (!g_repair_state.compare_exchange_strong(expected, 1)) return;
    std::thread([stl = stl_bytes, max_threads]() {
        g_repair_result = repair_stl_to_stl(stl, max_threads);
        g_repair_state.store(2);
    }).detach();
}

std::string poll_repair()
{
    if (g_repair_state.load() != 2) return std::string();
    std::string out = std::move(g_repair_result);
    g_repair_result.clear();
    g_repair_state.store(0);
    return out;
}

std::atomic<int> g_boolean_state{0};
std::string g_boolean_result;

void start_boolean(const std::string &stl_a, const std::string &stl_b, const std::string &op, int max_threads)
{
    int expected = 0;
    if (!g_boolean_state.compare_exchange_strong(expected, 1)) return;
    std::thread([a = stl_a, b = stl_b, op, max_threads]() {
        g_boolean_result = mesh_boolean_to_stl(a, b, op, max_threads);
        g_boolean_state.store(2);
    }).detach();
}

std::string poll_boolean()
{
    if (g_boolean_state.load() != 2) return std::string();
    std::string out = std::move(g_boolean_result);
    g_boolean_result.clear();
    g_boolean_state.store(0);
    return out;
}

} // namespace

EMSCRIPTEN_BINDINGS(orcaxr_slic3r)
{
    emscripten::function("sliceStlToGcode", &slice_stl_to_gcode);
    emscripten::function("startSlice", &start_slice);
    emscripten::function("startSliceFile", &start_slice_file);
    emscripten::function("startSlicePainted", &start_slice_painted);
    emscripten::function("pollSlice", &poll_slice);
    emscripten::function("startRepair", &start_repair);
    emscripten::function("pollRepair", &poll_repair);
    emscripten::function("versionString", &version_string);
    emscripten::function("heapSize", &heap_report);
    emscripten::function("startBoolean", &start_boolean);
    emscripten::function("pollBoolean", &poll_boolean);
}
