// slic3r_jni.cpp — thin C++ ↔ Kotlin bridge over libslic3r.
//
// Phase 0: smoke-test entry (nativeVersionString) + a minimal slice
// pipeline (nativeSlice) that takes file paths for an input STL and an
// output G-code, configures libslic3r with full defaults, and runs
// process() + export_gcode() synchronously. Errors surface as a non-zero
// jint return; success is 0.
//
// libslic3r is not safe to call concurrently from the same process — the
// Kotlin side serializes calls onto a single background dispatcher
// (native calls serialized on a single background thread). Don't call from the
// Android UI thread.

#include <jni.h>
#include <chrono>
#include <cstdlib>
#include <exception>
#include <sstream>
#include <string>

// OrcaXR Android: scalable_malloc / scalable_free shim. tbb's
// scalable allocator is broken on Android arm64 (vectors using it
// come back with garbage data() pointers). Linker --wrap rewrites
// every call site to these stubs, which delegate to libc malloc/
// free. See app/src/main/cpp/CMakeLists.txt for the link options.
extern "C" {
    void* __real_scalable_malloc(std::size_t size);
    void  __real_scalable_free(void* ptr);
    void* __real_scalable_aligned_malloc(std::size_t size, std::size_t alignment);
    void  __real_scalable_aligned_free(void* ptr);
    void* __real_scalable_realloc(void* ptr, std::size_t size);
    void* __real_scalable_calloc(std::size_t nobj, std::size_t size);
    int   __real_scalable_posix_memalign(void** memptr, std::size_t alignment, std::size_t size);
    std::size_t __real_scalable_msize(void* ptr);

    void* __wrap_scalable_malloc(std::size_t size) {
        return std::malloc(size);
    }
    void __wrap_scalable_free(void* ptr) {
        std::free(ptr);
    }
    void* __wrap_scalable_aligned_malloc(std::size_t size, std::size_t alignment) {
        void* p = nullptr;
        if (posix_memalign(&p, alignment < sizeof(void*) ? sizeof(void*) : alignment, size) != 0) {
            return nullptr;
        }
        return p;
    }
    void __wrap_scalable_aligned_free(void* ptr) {
        std::free(ptr);
    }
    void* __wrap_scalable_realloc(void* ptr, std::size_t size) {
        return std::realloc(ptr, size);
    }
    void* __wrap_scalable_calloc(std::size_t nobj, std::size_t size) {
        return std::calloc(nobj, size);
    }
    int __wrap_scalable_posix_memalign(void** memptr, std::size_t alignment, std::size_t size) {
        return posix_memalign(memptr, alignment, size);
    }
    std::size_t __wrap_scalable_msize(void* /*ptr*/) {
        // libc has no equivalent; return 0 (callers use this for stats only).
        return 0;
    }
}

#include <libslic3r/libslic3r.h>
#include <libslic3r/Config.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/TriangleMesh.hpp>
#include <libslic3r/Format/3mf.hpp>
#include <libslic3r/Format/bbs_3mf.hpp>
#include <libslic3r/Semver.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/TriangleSelector.hpp>
#include <libslic3r/Orient.hpp>
#include <libslic3r/Arrange.hpp>
#include <libslic3r/Exception.hpp>
#include <libslic3r/CutUtils.hpp>
#include <libslic3r/MeshBoolean.hpp>
#include <boost/algorithm/string/predicate.hpp>
#include <tbb/global_control.h>

#include <miniz.h>

#include <cstring>
#include <fstream>
#include <vector>

#include <android/log.h>

#define ORCAXR_TAG "OrcaXR/jni"
#define ORCAXR_LOGI(...) __android_log_print(ANDROID_LOG_INFO,  ORCAXR_TAG, __VA_ARGS__)
#define ORCAXR_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, ORCAXR_TAG, __VA_ARGS__)

// Cached JavaVM, set in JNI_OnLoad. Needed so libslic3r's status_callback
// (invoked from TBB worker threads via Print::process()) can attach back
// to the JVM and call onProgress(int, String) on the Kotlin listener.
static JavaVM* g_jvm = nullptr;

extern "C" JNIEXPORT jint JNICALL
JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
    g_jvm = vm;
    return JNI_VERSION_1_6;
}

namespace {

struct ScopedUtf {
    JNIEnv* env;
    jstring jstr;
    const char* c;
    ScopedUtf(JNIEnv* e, jstring s) : env(e), jstr(s), c(env->GetStringUTFChars(s, nullptr)) {}
    ~ScopedUtf() { if (c) env->ReleaseStringUTFChars(jstr, c); }
    ScopedUtf(const ScopedUtf&) = delete;
    ScopedUtf& operator=(const ScopedUtf&) = delete;
};

/**
 * Transform the 8 corners of [local] through [xform] and return the
 * tight axis-aligned bbox of the result. Needed because
 * `ModelObject::raw_bounding_box()` returns object-local coords and
 * 3MF instance transforms typically carry both a non-uniform scale
 * (e.g. 1.29) and a plate-relative translation — applying the
 * world-space shift requires the world-space bbox, not the local one.
 */
static Slic3r::BoundingBoxf3 world_bbox_of(
    const Slic3r::BoundingBoxf3& local,
    const Slic3r::Transform3d& xform)
{
    Slic3r::BoundingBoxf3 out;
    for (int corner = 0; corner < 8; ++corner) {
        Slic3r::Vec3d c(
            (corner & 1) ? local.max.x() : local.min.x(),
            (corner & 2) ? local.max.y() : local.min.y(),
            (corner & 4) ? local.max.z() : local.min.z()
        );
        Slic3r::Vec3d w = xform * c;
        if (corner == 0) { out.min = out.max = w; }
        else             { out.merge(w); }
    }
    return out;
}

/**
 * Per-object placement: world translation to add to the object's
 * existing instance offset so the result lands at its assigned
 * row position with bottom flush to the bed plane.
 */
struct ObjectPlacement {
    Slic3r::Vec3d translation;          // world-space offset to apply
    Slic3r::BoundingBoxf3 world_bbox;   // pre-translation, for logging
};

/**
 * Lay out [objects] in a single row centered on [bed_center] (X,Y),
 * with their bottoms at z=0. Each object's footprint width comes
 * from its world-space bbox (= raw_bounding_box transformed through
 * its first instance's matrix). Objects are placed left-to-right
 * with a [gap_mm] gap between bbox edges. Single-object case
 * collapses to "center on bed_center, bottom on bed".
 *
 * Used by both nativeSlice (so multi-object 3MFs print without
 * overlap) and nativeWriteColoredGlb (so the XR preview matches
 * what will print). bed_center = workspace origin (0, 0) for the
 * preview path; bed_center = printable_area centroid for slicing.
 */
static std::vector<ObjectPlacement> row_layout(
    const std::vector<Slic3r::ModelObject*>& objects,
    const Slic3r::Vec2d& bed_center,
    double gap_mm = 5.0)
{
    std::vector<ObjectPlacement> out;
    out.reserve(objects.size());

    // Pass 1: world bboxes + total width.
    std::vector<Slic3r::BoundingBoxf3> wbb;
    wbb.reserve(objects.size());
    double total_width = 0.0;
    for (const Slic3r::ModelObject* mo : objects) {
        Slic3r::Transform3d xf = Slic3r::Transform3d::Identity();
        if (!mo->instances.empty()) xf = mo->instances.front()->get_matrix();
        Slic3r::BoundingBoxf3 b = world_bbox_of(mo->raw_bounding_box(), xf);
        total_width += (b.max.x() - b.min.x());
        wbb.push_back(b);
    }
    if (objects.size() > 1) total_width += gap_mm * (objects.size() - 1);

    // Pass 2: assign each object a target center; compute translation
    // = target - current. Y aligns to bed_center; Z drops bbox bottom
    // to z=0 regardless of where the 3MF authored it.
    double cursor_x = bed_center.x() - total_width / 2.0;
    for (size_t i = 0; i < objects.size(); ++i) {
        const auto& b = wbb[i];
        double w = b.max.x() - b.min.x();
        double current_cx = (b.min.x() + b.max.x()) * 0.5;
        double current_cy = (b.min.y() + b.max.y()) * 0.5;
        double target_cx = cursor_x + w / 2.0;
        Slic3r::Vec3d t(
            target_cx - current_cx,
            bed_center.y() - current_cy,
            -b.min.z()  // raise bbox bottom to z=0
        );
        out.push_back({t, b});
        cursor_x += w + gap_mm;
    }
    return out;
}

/**
 * Phase J in-XR painting authoring path. Per-triangle filament-slot
 * byte array (slot=0 → unpainted, slot=1..32 → tagged) gets serialized
 * onto a [ModelVolume]'s `mmu_segmentation_facets` so libslic3r's
 * existing multi-material segmentation pipeline picks it up at slice
 * time. No libslic3r patches needed — `mmu_segmentation_facets` is a
 * v2.3.x first-class field. See `docs/PHASE_J_PAINTING_PLAN.md` §4.6.
 *
 * Encoding mirrors `Model.cpp::CONST_FILAMENTS` — each non-zero slot
 * maps to a fixed hex string that `set_triangle_from_string` decodes
 * back into a leaf [EnforcerBlockerType]. We duplicate the table here
 * instead of reaching into Model.cpp's anonymous-namespace static so
 * a future libslic3r reorganization doesn't silently break paint
 * authoring at slice time.
 *
 * `set_triangle_from_string` requires strictly-increasing triangle_id
 * across calls, so we iterate the paint array in order and skip
 * unpainted entries.
 *
 * Returns the number of triangles authored (== number of non-zero
 * entries in `paint` clipped to the volume's tri count).
 */
static const char* const ORCAXR_PAINT_HEX[] = {
    "",   "4",  "8",  "0C", "1C",  "2C",  "3C",  "4C",  "5C",  "6C",
    "7C", "8C", "9C", "AC", "BC",  "CC", "DC",  "EC",  "0FC", "1FC",
    "2FC", "3FC", "4FC", "5FC", "6FC", "7FC", "8FC", "9FC", "AFC", "BFC",
    "CFC", "DFC", "EFC",
};
static constexpr size_t ORCAXR_PAINT_MAX_SLOT = (sizeof(ORCAXR_PAINT_HEX) / sizeof(ORCAXR_PAINT_HEX[0])) - 1;

static size_t apply_orcaxr_paint(
    Slic3r::ModelVolume& mv,
    const jbyte* paint,
    size_t paint_len)
{
    const size_t tri_count = mv.mesh().its.indices.size();
    if (tri_count == 0) return 0;
    if (paint == nullptr || paint_len == 0) return 0;
    // If the paint array is shorter than the mesh, only the prefix is
    // honored. Longer is silently truncated. Mismatch usually means the
    // caller paint state is stale (mesh was rotated/scaled and re-
    // baked elsewhere) — log so a regression at the boundary is
    // visible.
    if (paint_len != tri_count) {
        ORCAXR_LOGI("apply_orcaxr_paint: size mismatch paint=%zu tris=%zu (using min)",
                    paint_len, tri_count);
    }
    const size_t n = std::min<size_t>(tri_count, paint_len);
    mv.mmu_segmentation_facets.reset();
    mv.mmu_segmentation_facets.reserve(int(n));
    size_t authored = 0;
    for (size_t i = 0; i < n; ++i) {
        const unsigned int slot = static_cast<unsigned char>(paint[i]);
        if (slot == 0 || slot > ORCAXR_PAINT_MAX_SLOT) continue;
        mv.mmu_segmentation_facets.set_triangle_from_string(int(i), ORCAXR_PAINT_HEX[slot]);
        ++authored;
    }
    mv.mmu_segmentation_facets.shrink_to_fit();
    return authored;
}

// Phase XR_OBJ_8 — author per-triangle support paint onto
// `mv->supported_facets`. Encoding mirrors `apply_orcaxr_paint` but
// the state values are EnforcerBlockerType ordinals: NONE=0,
// ENFORCER=1, BLOCKER=2 (Slic3r/TriangleSelector.hpp:13). Higher
// values are reserved for FullSpectrum mixed-filament / per-extruder
// state; this paint surface only accepts 0/1/2.
//
// Returns the number of triangles authored (excluding the unpainted
// 0 entries).
static size_t apply_orcaxr_support(
    Slic3r::ModelVolume& mv,
    const jbyte* paint,
    size_t paint_len)
{
    const size_t tri_count = mv.mesh().its.indices.size();
    if (tri_count == 0) return 0;
    if (paint == nullptr || paint_len == 0) return 0;
    if (paint_len != tri_count) {
        ORCAXR_LOGI("apply_orcaxr_support: size mismatch paint=%zu tris=%zu (using min)",
                    paint_len, tri_count);
    }
    const size_t n = std::min<size_t>(tri_count, paint_len);
    mv.supported_facets.reset();
    mv.supported_facets.reserve(int(n));
    size_t authored = 0;
    for (size_t i = 0; i < n; ++i) {
        const unsigned int state = static_cast<unsigned char>(paint[i]);
        // Only ENFORCER (1) and BLOCKER (2) are valid for support
        // facets; anything else (including the unpainted 0) is a
        // pass-through. Encoded via the same ORCAXR_PAINT_HEX table
        // because state 1 and state 2 produce single-byte hex
        // strings "4" and "8" — the same ones libslic3r's painted
        // 3MF importer uses for ENFORCER / BLOCKER. (Slot 1 and 2
        // in CONST_FILAMENTS coincidentally match the
        // EnforcerBlockerType ordinals 1/2 because both enums
        // start from 0/NONE and step by 1.)
        if (state != 1 && state != 2) continue;
        mv.supported_facets.set_triangle_from_string(int(i), ORCAXR_PAINT_HEX[state]);
        ++authored;
    }
    mv.supported_facets.shrink_to_fit();
    return authored;
}

// Phase XR_OBJ_8 — author per-triangle seam paint onto
// `mv->seam_facets`. Same encoding as apply_orcaxr_support: state
// 1 = ENFORCER (force layer-start seam to land here), state 2 =
// BLOCKER (forbid seam from landing here). Higher values reserved.
static size_t apply_orcaxr_seam(
    Slic3r::ModelVolume& mv,
    const jbyte* paint,
    size_t paint_len)
{
    const size_t tri_count = mv.mesh().its.indices.size();
    if (tri_count == 0) return 0;
    if (paint == nullptr || paint_len == 0) return 0;
    if (paint_len != tri_count) {
        ORCAXR_LOGI("apply_orcaxr_seam: size mismatch paint=%zu tris=%zu (using min)",
                    paint_len, tri_count);
    }
    const size_t n = std::min<size_t>(tri_count, paint_len);
    mv.seam_facets.reset();
    mv.seam_facets.reserve(int(n));
    size_t authored = 0;
    for (size_t i = 0; i < n; ++i) {
        const unsigned int state = static_cast<unsigned char>(paint[i]);
        if (state != 1 && state != 2) continue;
        mv.seam_facets.set_triangle_from_string(int(i), ORCAXR_PAINT_HEX[state]);
        ++authored;
    }
    mv.seam_facets.shrink_to_fit();
    return authored;
}

// Rewrite tool-change tokens (`Tn`, `M104 Tn`, `M109 Tn`, …) in `gcode_path`
// according to `filament_map` (1-based vector — entry i is the 1-based
// physical extruder for project filament i). The post-processor runs
// AFTER libslic3r's `print.export_gcode` so it catches both:
//   - GCodeWriter::toolchange emissions (path 1, when no custom
//     change_filament_gcode handles the toolchange).
//   - User-supplied change_filament_gcode / machine_start_gcode templates
//     that substitute `T{next_extruder}` / `T{initial_extruder}` (path 2).
//     These bypass `GCodeWriter::toolchange` entirely because libslic3r's
//     `custom_gcode_changes_tool` (GCode.cpp:228) detects the template's
//     `T<filament_id>` and DROPS the writer's emit (GCode.cpp:972, 7644).
//
// Why post-process instead of patching the writer / placeholders:
//   - libslic3r's `next_extruder` / `initial_extruder` placeholders are
//     filament-id-indexed and used in *two* roles inside templates: array
//     indices into per-filament arrays (`nozzle_temperature[next_extruder]`,
//     `filament_multitool_ramming[next_extruder]`) AND as `T<n>` parameters.
//     Changing the placeholder semantics breaks the array-index uses.
//     Adding new placeholders + editing every profile's templates is more
//     surface area; rewriting the *output* lets every template stay as-is.
//
// Algorithm: walk the file line-by-line. For each non-comment line whose
// first non-whitespace char is `T`, `M`, or `G`, find every Tn token at
// either the start of the line OR after whitespace, and rewrite as
// T<filament_map[n]-1>. Comments (text after `;`) are left untouched.
// Bounds-check: a filament_id outside [0, filament_map.size()) is left
// alone (it's already a malformed reference; skewing it further hides
// the real bug).
//
// Identity maps (filament_map[i] == i+1 for every i) short-circuit at
// the top — we only touch the file when there's a real remap to apply.
//
// Returns true on success (including the no-op identity case), false if
// the file couldn't be read/written. On failure the gcode is left as
// libslic3r wrote it — the print may use the wrong extruder, but the
// gcode itself stays valid and the slicer is reported as Success.
static bool postprocess_remap_tool_commands(
    const std::string& gcode_path,
    const std::vector<int>& filament_map)
{
    if (filament_map.empty()) return true;
    bool is_identity = true;
    for (size_t i = 0; i < filament_map.size(); ++i) {
        if (filament_map[i] != int(i + 1)) { is_identity = false; break; }
    }
    if (is_identity) return true;

    std::ifstream in(gcode_path, std::ios::binary);
    if (!in) {
        ORCAXR_LOGE("postprocess_remap_tool_commands: open for read failed: %s", gcode_path.c_str());
        return false;
    }
    std::stringstream ss;
    ss << in.rdbuf();
    in.close();
    std::string content = ss.str();

    auto remap = [&](int filament_id) -> int {
        if (filament_id < 0 || size_t(filament_id) >= filament_map.size()) return filament_id;
        return filament_map[filament_id] - 1;
    };

    std::string out;
    out.reserve(content.size() + 1024);
    size_t total_lines = 0;
    size_t rewrites = 0;
    size_t pos = 0;
    while (pos <= content.size()) {
        size_t end = content.find('\n', pos);
        bool has_eol = (end != std::string::npos);
        const size_t line_end = has_eol ? end : content.size();
        std::string line = content.substr(pos, line_end - pos);
        pos = has_eol ? end + 1 : content.size() + 1;
        ++total_lines;

        // Skip comment-only / blank lines.
        size_t first = line.find_first_not_of(" \t");
        if (first == std::string::npos || line[first] == ';') {
            out += line;
            if (has_eol) out += '\n';
            continue;
        }
        // Only rewrite gcode command lines. Comments aside, that's lines
        // starting with G / M / T (the standard 3D-printer dialect).
        char cmd = line[first];
        if (cmd != 'G' && cmd != 'M' && cmd != 'T') {
            out += line;
            if (has_eol) out += '\n';
            continue;
        }

        // Walk the line, rewriting Tn tokens at boundaries (start or
        // post-whitespace), stopping at ';'. The boundary check is what
        // keeps us from rewriting things like "STR T2" inside an M-code
        // string literal — gcode doesn't actually have those, but the
        // boundary keeps the rule conservative.
        std::string rewritten;
        rewritten.reserve(line.size() + 8);
        size_t i = 0;
        bool changed = false;
        while (i < line.size()) {
            char c = line[i];
            if (c == ';') {
                rewritten.append(line, i, std::string::npos);
                break;
            }
            bool prev_is_boundary = (i == first) ||
                                    (i > 0 && (line[i - 1] == ' ' || line[i - 1] == '\t'));
            if (prev_is_boundary && c == 'T' &&
                i + 1 < line.size() && std::isdigit(static_cast<unsigned char>(line[i + 1]))) {
                size_t dig_end = i + 1;
                while (dig_end < line.size() && std::isdigit(static_cast<unsigned char>(line[dig_end]))) {
                    ++dig_end;
                }
                int filament_id = std::atoi(line.substr(i + 1, dig_end - i - 1).c_str());
                int new_id = remap(filament_id);
                rewritten += 'T';
                rewritten += std::to_string(new_id);
                if (new_id != filament_id) {
                    changed = true;
                    ++rewrites;
                }
                i = dig_end;
                continue;
            }
            rewritten += c;
            ++i;
        }
        out += rewritten;
        if (has_eol) out += '\n';
        (void)changed;
    }

    std::ofstream of(gcode_path, std::ios::binary | std::ios::trunc);
    if (!of) {
        ORCAXR_LOGE("postprocess_remap_tool_commands: open for write failed: %s", gcode_path.c_str());
        return false;
    }
    of.write(out.data(), static_cast<std::streamsize>(out.size()));
    of.close();
    if (!of.good()) {
        ORCAXR_LOGE("postprocess_remap_tool_commands: write failed: %s", gcode_path.c_str());
        return false;
    }
    ORCAXR_LOGI("postprocess_remap_tool_commands: %zu rewrites across %zu lines (filament_map size=%zu)",
                rewrites, total_lines, filament_map.size());
    return true;
}

/**
 * Pull `Metadata/project_settings.config` out of a .3mf zip and
 * extract a JSON array-of-strings field (e.g. `filament_colour`,
 * `flush_volumes_matrix`, `flush_multiplier`) into [out].
 *
 * Why this exists instead of relying on libslic3r's
 * DynamicPrintConfig populated by load_bbs_3mf: the BBS importer
 * routes project-config extraction through
 * `Model::get_backup_path()`, which on Android tries to create
 * `/orcaslicer_model/<date>/<pid>/...` under a non-writable root
 * (same root cause as gotcha #9 about LoadAuxiliary). The directory
 * creation throws, get_backup_path() swallows the exception and
 * returns the path anyway, then mz_zip_reader_extract_to_file fails
 * silently — net result: the config is never populated, and any
 * `config.option<ConfigOptionStrings>("filament_colour")` lookup
 * downstream returns nullptr. Reading the zip ourselves sidesteps
 * the whole backup-path machinery.
 *
 * The 3MF format is a plain ZIP, miniz is already linked in for
 * libslic3r's own use, and the JSON shape is stable: every
 * vector-typed config option (coFloats / coStrings / coBools / ...)
 * is serialized by `ConfigBase::save_to_json` as a JSON array of
 * stringified scalars (`"flush_volumes_matrix": ["0", "280", ...]`,
 * see Config.cpp:1483-1496). A regex-free single-pass scan suffices
 * because the field names are unambiguous in 3MF project-config
 * files (BambuStudio, OrcaSlicer, FullSpectrum all share the shape).
 *
 * Returns true when the key was found and the array was syntactically
 * complete (`[...]`), regardless of whether the array had entries —
 * an empty-but-explicit array is a valid signal (e.g. a multi-color
 * matrix file that happens to have all-zero same-color flush values
 * collapsed during authoring). Returns false when the file isn't a
 * 3MF, the key isn't present, or the brackets don't close.
 */
static bool extract_3mf_string_array(
    const char* zip_path,
    const char* json_key,
    std::vector<std::string>& out)
{
    out.clear();
    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_file(&zip, zip_path, 0)) {
        return false;
    }
    bool ok = false;
    int file_index = mz_zip_reader_locate_file(
        &zip, "Metadata/project_settings.config", nullptr, 0);
    if (file_index >= 0) {
        size_t uncomp_size = 0;
        void* p = mz_zip_reader_extract_to_heap(
            &zip, static_cast<mz_uint>(file_index), &uncomp_size, 0);
        if (p != nullptr && uncomp_size > 0) {
            std::string text(static_cast<const char*>(p), uncomp_size);
            mz_free(p);

            // Locate the "<key>" : <value> pair. Tolerant of whitespace
            // / line breaks / quoting style around the colon. Accept
            // either:
            //   - JSON array form `[ "v1", "v2", ... ]` (typical for
            //     `coFloats` / `coStrings` vectors with ≥2 entries)
            //   - JSON scalar string `"value"` (FullSpectrum and older
            //     OrcaSlicer serialize single-entry coFloats this way
            //     — `flush_multiplier` is a real-world example. Older
            //     extractors that only looked for `[...]` would skip
            //     past the scalar value and pick up the NEXT JSON array
            //     in the file, returning the wrong vector entirely.)
            const std::string key = std::string("\"") + json_key + "\"";
            size_t k = text.find(key);
            if (k != std::string::npos) {
                size_t colon = text.find(':', k + key.size());
                if (colon != std::string::npos) {
                    // Skip whitespace after the colon to peek at the
                    // value's first significant char.
                    size_t v = colon + 1;
                    while (v < text.size() && (text[v] == ' ' || text[v] == '\t' ||
                                                text[v] == '\n' || text[v] == '\r')) {
                        ++v;
                    }
                    if (v < text.size() && text[v] == '[') {
                        // Array form. Walk the array body and pull
                        // every quoted string between [ and ].
                        size_t rbr = text.find(']', v);
                        if (rbr != std::string::npos) {
                            size_t i = v + 1;
                            while (i < rbr) {
                                size_t q1 = text.find('"', i);
                                if (q1 == std::string::npos || q1 >= rbr) break;
                                size_t q2 = text.find('"', q1 + 1);
                                if (q2 == std::string::npos || q2 > rbr) break;
                                out.emplace_back(text.substr(q1 + 1, q2 - q1 - 1));
                                i = q2 + 1;
                            }
                            // Found the bracket pair and parsed
                            // cleanly, even if the array contained zero
                            // tokens. Caller distinguishes "absent"
                            // (false return) from "explicitly empty"
                            // (true return + empty out).
                            ok = true;
                        }
                    } else if (v < text.size() && text[v] == '"') {
                        // Scalar string form. Pull a single token
                        // honoring backslash escapes (same logic as
                        // extract_3mf_string_value).
                        size_t i = v + 1;
                        std::string buf;
                        bool found_close = false;
                        while (i < text.size()) {
                            char ch = text[i];
                            if (ch == '\\' && i + 1 < text.size()) {
                                buf.push_back(text[i + 1]);
                                i += 2;
                                continue;
                            }
                            if (ch == '"') {
                                found_close = true;
                                break;
                            }
                            buf.push_back(ch);
                            ++i;
                        }
                        if (found_close) {
                            out.emplace_back(std::move(buf));
                            ok = true;
                        }
                    }
                    // Other shapes (numbers, booleans, null, objects)
                    // aren't expected for the keys we care about and
                    // would represent malformed config — leave ok=false.
                }
            }
        }
    }
    mz_zip_reader_end(&zip);
    return ok;
}

/**
 * Read a mesh container (STL/3MF/AMF/OBJ/STEP) into a Slic3r::Model.
 *
 * For .3mf we dispatch through `Model::read_from_archive` rather than
 * `Model::read_from_file`. The latter's .3mf branch only calls
 * `load_bbs_3mf`, which silently returns an empty model for Prusa /
 * MakerWorld / generic 3MF files that don't carry BBS metadata
 * (verified in field with a Bambu-shared 3MF — the load "succeeded"
 * but `model.objects.empty()` triggered a misleading "couldn't be
 * read because it's empty" exception). `read_from_archive` sniffs
 * Prusa-vs-BBS and routes to the correct loader (`load_3mf` for
 * Prusa / standard 3MF, `load_bbs_3mf` for BBS-flavored ones).
 *
 * Throws std::exception on failure (caller catches).
 */
static Slic3r::Model load_mesh_container(
    const char* path,
    Slic3r::DynamicPrintConfig* out_config = nullptr)
{
    if (boost::algorithm::iends_with(path, ".3mf") ||
        boost::algorithm::iends_with(path, ".zip.amf"))
    {
        // OrcaSlicer ships two 3MF readers and they're both flaky:
        //
        //   load_3mf       — Prusa/Slic3r standard 3MF spec. Fast,
        //                    permissive, doesn't require BBS metadata.
        //   load_bbs_3mf   — Bambu Studio extended 3MF (plates,
        //                    project presets, embedded preset bundle).
        //                    Returns an empty model on standard /
        //                    hybrid 3MFs (verified in field on a
        //                    Bambu-shared multicolor file: no crash,
        //                    just `model.objects.empty()`). Earlier
        //                    versions also segfault inside
        //                    semver_free if the caller passes a null
        //                    file_version pointer — handled below.
        //
        // OrcaSlicer's Model::read_from_archive uses PrusaFileParser
        // to pick which loader runs, but its heuristic is
        // BBS-leaning and misroutes most consumer 3MFs. Try the
        // standard loader first and only fall back to BBS when it
        // doesn't extract any objects — that's the inverse of
        // upstream's order but matches what loaders we actually
        // hit on real-world files.
        Slic3r::Model model;
        Slic3r::DynamicPrintConfig local_config;
        Slic3r::DynamicPrintConfig& cfg_ref =
            out_config != nullptr ? *out_config : local_config;
        Slic3r::ConfigSubstitutionContext subs(
            Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);

        try {
            if (Slic3r::load_3mf(path, cfg_ref, subs, &model, /*check_version=*/false)
                && !model.objects.empty()) {
                ORCAXR_LOGI("load_mesh_container: load_3mf ok (%zu objects)",
                            model.objects.size());
                return model;
            }
        } catch (const std::exception& e) {
            ORCAXR_LOGI("load_mesh_container: load_3mf threw, falling back: %s", e.what());
        }

        // Fallback: BBS loader. Always pass a real Semver — passing
        // nullptr crashes inside semver_free at offset 0x10 when the
        // BBS importer destructs its file_version member.
        model = Slic3r::Model();
        Slic3r::PlateDataPtrs plate_data;
        std::vector<Slic3r::Preset*> project_presets;
        Slic3r::Semver file_version;
        bool is_bbl = false;
        // LoadStrategy is a bitmask. AddDefaultInstances alone is
        // NOT enough — `LoadModel = 4` is the bit that actually
        // extracts mesh objects out of the BBS plate containers
        // (verified in field: a Bambu Studio 3MF returned
        // `is_bbl=1, objects=0` until we OR'd in LoadModel).
        // LoadConfig pulls the embedded DynamicPrintConfig.
        //
        // DO NOT add LoadAuxiliary (16): the BBS importer treats it
        // as "extract project resources to disk" and tries to write
        // to `/orcaslicer_model/<date>/<pid>/Auxiliaries/...` which
        // is on Android's read-only root filesystem — load fails
        // with `boost::filesystem::create_directories: Read-only
        // file system [system:30]`. Painting data
        // (`mmu_segmentation_facets`) is parsed unconditionally by
        // `bbs_3mf.cpp:4895` regardless of LoadAuxiliary.
        const auto strategy = static_cast<Slic3r::LoadStrategy>(
            static_cast<int>(Slic3r::LoadStrategy::LoadModel)            |
            static_cast<int>(Slic3r::LoadStrategy::LoadConfig)           |
            static_cast<int>(Slic3r::LoadStrategy::AddDefaultInstances));
        if (Slic3r::load_bbs_3mf(path, &cfg_ref, &subs, &model,
                                  &plate_data, &project_presets,
                                  &is_bbl, &file_version,
                                  /*proFn=*/nullptr,
                                  strategy,
                                  /*project=*/nullptr,
                                  /*plate_id=*/0)) {
            ORCAXR_LOGI("load_mesh_container: load_bbs_3mf ok (%zu objects, is_bbl=%d)",
                        model.objects.size(), is_bbl);
        } else {
            ORCAXR_LOGE("load_mesh_container: both 3MF loaders failed for %s", path);
        }
        return model;
    }
    return Slic3r::Model::read_from_file(path);
}

} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeVersionString(JNIEnv* env, jclass) {
    Slic3r::DynamicPrintConfig cfg;
    std::ostringstream oss;
    oss << "libslic3r " << SLIC3R_VERSION
        << " [print config keys: " << cfg.keys().size() << "]";
    return env->NewStringUTF(oss.str().c_str());
}

// nativeSlice — slice a single STL into a single G-code file. Optional
// (configKeys, configValues) arrays apply key/value overrides on top of
// libslic3r's full default print config (set_deserialize_nothrow per
// pair; bad pairs are skipped with a log line, not a fatal error).
//
// [jProgressListener] (may be null) is a Kotlin SlicerProgressListener
// instance whose `onProgress(int percent, String message)` method gets
// invoked from libslic3r's status callback. Fires from TBB worker
// threads — we attach to the JVM via the cached g_jvm. Throttled on the
// C++ side (skip when percent+text are unchanged from the prior tick)
// because libslic3r emits hundreds of duplicate ticks per slice.
//
// Returns 0 on success, negative on failure (-1 read STL, -2 validate,
// -3 process/export, -4 unknown).
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeSlice(
    JNIEnv* env, jclass,
    jstring jStlPath, jstring jOutGcodePath,
    jobjectArray jConfigKeys, jobjectArray jConfigValues,
    jobject jProgressListener,
    jintArray jVirtualRemap,
    jbyteArray jPaintFilamentIndex,
    /* Phase XR_OBJ_4 — user-authored extra volumes attached to
     * model.objects.front() before slice. Parallel arrays:
     *   jExtraVolumePaths[i]      = STL/3MF path of the volume mesh
     *   jExtraVolumeTypes[i]      = libslic3r ModelVolumeType ordinal
     *                                (matches Kotlin's
     *                                ModelVolumeType.nativeOrdinal)
     *   jExtraVolumeTransforms    = 12 floats per volume:
     *                                 tx, ty, tz, rxDeg, ryDeg, rzDeg,
     *                                 sxPct, syPct, szPct,
     *                                 mirrorXSign, mirrorYSign,
     *                                 mirrorZSign
     * All three may be null/empty for "no extras" (existing behavior). */
    jobjectArray jExtraVolumePaths,
    jintArray    jExtraVolumeTypes,
    jfloatArray  jExtraVolumeTransforms,
    /* Phase XR_OBJ_8 — per-triangle support paint, sized to the
     * source mesh's triangle count. 0=unpainted, 1=ENFORCER,
     * 2=BLOCKER. Authored onto `mv->supported_facets` BEFORE
     * Print::apply via apply_orcaxr_support. Null = no authored
     * support paint; embedded 3MF facets (if any) pass through. */
    jbyteArray jSupportFlags,
    /* Phase XR_OBJ_8 — per-triangle seam paint. Same encoding /
     * scope as jSupportFlags but flows into `mv->seam_facets`. */
    jbyteArray jSeamFlags,
    /* Phase XR_OBJ_4 (final) — per-object config overrides applied
     * onto `model.objects.front()->config()` after load and before
     * Print::apply. Same parallel-array shape as jConfigKeys /
     * jConfigValues but the values land on the OBJECT's local config
     * rather than the global Print config. Sparse SAFE_KEYS subset:
     * layer_height, wall_loops, sparse_infill_density, etc. Null /
     * empty = no per-object overrides (existing behavior). */
    jobjectArray jObjectConfigKeys,
    jobjectArray jObjectConfigValues)
{
    ScopedUtf stl(env, jStlPath);
    ScopedUtf out(env, jOutGcodePath);
    ORCAXR_LOGI("nativeSlice: stl=%s out=%s listener=%s",
                stl.c, out.c, jProgressListener ? "yes" : "no");

    // Snapshot the virtual remap once so we can apply it after the
    // model loads. The array is sized to slot_count (project filaments).
    // virtual_remap[i] == 0 means project filament (i+1) keeps its face
    // state unchanged — its painted faces print on its assigned physical
    // extruder via the existing filament_map pipeline. virtual_remap[i] ==
    // K (>0) means the project filament has been remapped to virtual
    // mixed-filament slot K — its painted faces get rewritten from state
    // (i+1) to state (num_physical + K) so PrintApply produces a painted
    // region tagged with the virtual ID, and ToolOrdering's resolve_mixed_
    // 1based hook then alternates per layer.
    std::vector<int> virtual_remap;
    if (jVirtualRemap != nullptr) {
        const jsize n = env->GetArrayLength(jVirtualRemap);
        if (n > 0) {
            virtual_remap.assign(static_cast<size_t>(n), 0);
            env->GetIntArrayRegion(jVirtualRemap, 0, n, virtual_remap.data());
        }
    }

    // Resolve the listener method id once before slicing starts. The
    // global ref keeps the Kotlin object alive across the slice; the
    // method id is stable for the lifetime of the class. Both get
    // released after process()/export_gcode() return.
    jobject  listener_global = nullptr;
    jmethodID on_progress_mid = nullptr;
    if (jProgressListener != nullptr && g_jvm != nullptr) {
        listener_global = env->NewGlobalRef(jProgressListener);
        if (listener_global != nullptr) {
            jclass cls = env->GetObjectClass(listener_global);
            on_progress_mid = env->GetMethodID(cls, "onProgress", "(ILjava/lang/String;)V");
            env->DeleteLocalRef(cls);
            if (on_progress_mid == nullptr) {
                ORCAXR_LOGE("nativeSlice: SlicerProgressListener.onProgress(I,String) not found — skipping callback");
                env->ExceptionClear();
                env->DeleteGlobalRef(listener_global);
                listener_global = nullptr;
            }
        }
    }

    try {
        // Slic3r::Model::read_from_file dispatches by extension and
        // handles STL / 3MF / AMF / OBJ / STEP. The 3MF path also
        // populates the embedded DynamicPrintConfig if the caller
        // passes one — we DON'T pass it here because the user's
        // selected profile (passed via jConfigKeys/jConfigValues)
        // should take precedence over whatever the 3MF embeds.
        // Future: add an opt-in flag to honor the 3MF's embedded
        // profile when the user wants to slice exactly as authored.
        Slic3r::Model model;
        try {
            model = load_mesh_container(stl.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeSlice: read_from_file failed: %s", e.what());
            return -1;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeSlice: no objects in %s", stl.c);
            return -1;
        }
        // STL has no instance metadata; ensure every object has at
        // least one instance so the print pipeline has something to
        // arrange. 3MF/AMF that already define instances are left
        // alone — replicating their embedded layout.
        for (Slic3r::ModelObject* mo : model.objects) {
            if (mo->instances.empty()) mo->add_instance();
        }

        // Phase XR_OBJ_4 — attach user-authored extra volumes to the
        // first ModelObject. These are the volumes the Compose UI's
        // "Add Part / Add Modifier / Add Negative Volume / Add
        // Support Enforcer / Blocker" flow appended to the selected
        // PlacedModel. They share the parent object's instance pose
        // (so user-level translate / rotate / scale on the WHOLE
        // model still moves the parts together) but carry their own
        // ModelVolume::m_transformation for per-volume positioning
        // relative to the primary mesh.
        //
        // Loaded the same way as the primary mesh: load_mesh_container
        // → take the first volume's mesh from the source's first
        // ModelObject. Multi-object source files get the first object
        // only — same convention as nativeSliceMulti.
        if (jExtraVolumePaths != nullptr) {
            const jsize n_extras = env->GetArrayLength(jExtraVolumePaths);
            if (n_extras > 0) {
                Slic3r::ModelObject* mo = model.objects.front();
                std::vector<int> v_types(n_extras, 0);
                if (jExtraVolumeTypes != nullptr &&
                    env->GetArrayLength(jExtraVolumeTypes) >= n_extras) {
                    env->GetIntArrayRegion(jExtraVolumeTypes, 0, n_extras, v_types.data());
                }
                std::vector<float> v_tforms(n_extras * 12, 0.f);
                bool have_tforms = (jExtraVolumeTransforms != nullptr &&
                                    env->GetArrayLength(jExtraVolumeTransforms) >= n_extras * 12);
                if (have_tforms) {
                    env->GetFloatArrayRegion(jExtraVolumeTransforms, 0, n_extras * 12, v_tforms.data());
                }
                for (jsize i = 0; i < n_extras; ++i) {
                    jstring jp = (jstring) env->GetObjectArrayElement(jExtraVolumePaths, i);
                    if (jp == nullptr) continue;
                    bool added = false;
                    {
                        ScopedUtf p(env, jp);
                        Slic3r::Model src;
                        try {
                            src = load_mesh_container(p.c);
                        } catch (const std::exception& e) {
                            ORCAXR_LOGE("nativeSlice: extra volume read failed for %s: %s", p.c, e.what());
                        }
                        if (!src.objects.empty() && !src.objects.front()->volumes.empty()) {
                            Slic3r::TriangleMesh mesh =
                                src.objects.front()->volumes.front()->mesh();
                            // Coerce the int ordinal into ModelVolumeType.
                            // Values match Slic3r::ModelVolumeType exactly
                            // (Model.hpp:341-348). Out-of-range falls back
                            // to MODEL_PART.
                            Slic3r::ModelVolumeType vtype = Slic3r::ModelVolumeType::MODEL_PART;
                            switch (v_types[i]) {
                                case 0: vtype = Slic3r::ModelVolumeType::MODEL_PART; break;
                                case 1: vtype = Slic3r::ModelVolumeType::NEGATIVE_VOLUME; break;
                                case 2: vtype = Slic3r::ModelVolumeType::PARAMETER_MODIFIER; break;
                                case 3: vtype = Slic3r::ModelVolumeType::SUPPORT_BLOCKER; break;
                                case 4: vtype = Slic3r::ModelVolumeType::SUPPORT_ENFORCER; break;
                                default: break;
                            }
                            Slic3r::ModelVolume* mv = mo->add_volume(std::move(mesh), vtype, false);
                            mv->name = std::string("part_") + std::to_string(i);
                            if (have_tforms) {
                                const float tx     = v_tforms[i * 12 + 0];
                                const float ty     = v_tforms[i * 12 + 1];
                                const float tz     = v_tforms[i * 12 + 2];
                                const float rxDeg  = v_tforms[i * 12 + 3];
                                const float ryDeg  = v_tforms[i * 12 + 4];
                                const float rzDeg  = v_tforms[i * 12 + 5];
                                const float sx     = (v_tforms[i * 12 + 6] / 100.0f) * v_tforms[i * 12 + 9];
                                const float sy     = (v_tforms[i * 12 + 7] / 100.0f) * v_tforms[i * 12 + 10];
                                const float sz     = (v_tforms[i * 12 + 8] / 100.0f) * v_tforms[i * 12 + 11];
                                mv->set_offset(Slic3r::Vec3d(tx, ty, tz));
                                mv->set_rotation(Slic3r::Vec3d(rxDeg * M_PI / 180.0,
                                                               ryDeg * M_PI / 180.0,
                                                               rzDeg * M_PI / 180.0));
                                mv->set_scaling_factor(Slic3r::Vec3d(sx, sy, sz));
                            }
                            ORCAXR_LOGI("nativeSlice: extra volume[%d] added '%s' type=%d",
                                        i, p.c, int(vtype));
                            added = true;
                        }
                    }
                    env->DeleteLocalRef(jp);
                    (void)added;
                }
            }
        }

        // Apply the FullSpectrum virtual-filament remap before the
        // print pipeline reads any face state. For each project
        // filament index i where virtual_remap[i] > 0, walk every
        // ModelVolume's mmu_segmentation_facets and rewrite the
        // EnforcerBlocker state from (i+1) → (num_physical + K). We
        // need num_physical from the caller's filament_diameter —
        // pull it out of the configKeys array before applying. The
        // rewrite is idempotent (re-running with the same remap
        // produces no further changes once the source state is
        // consumed) and gracefully no-ops when the source state
        // isn't present in the file.
        if (!virtual_remap.empty()) {
            size_t num_physical_for_remap = 0;
            if (jConfigKeys != nullptr && jConfigValues != nullptr) {
                const jsize nk = env->GetArrayLength(jConfigKeys);
                for (jsize i = 0; i < nk; ++i) {
                    jstring jk = (jstring) env->GetObjectArrayElement(jConfigKeys, i);
                    if (jk == nullptr) continue;
                    bool found = false;
                    {
                        ScopedUtf k(env, jk);
                        if (std::strcmp(k.c, "filament_diameter") == 0) {
                            jstring jv = (jstring) env->GetObjectArrayElement(jConfigValues, i);
                            if (jv != nullptr) {
                                ScopedUtf v(env, jv);
                                size_t commas = 0;
                                for (const char *p = v.c; *p; ++p) if (*p == ',') ++commas;
                                num_physical_for_remap = commas + 1;
                                env->DeleteLocalRef(jv);
                            }
                            found = true;
                        }
                    }
                    env->DeleteLocalRef(jk);
                    if (found) break;
                }
            }
            if (num_physical_for_remap == 0) num_physical_for_remap = 1;

            size_t total_rewrites = 0;
            for (Slic3r::ModelObject *mo : model.objects) {
                for (Slic3r::ModelVolume *mv : mo->volumes) {
                    if (mv == nullptr || mv->mmu_segmentation_facets.empty())
                        continue;
                    for (size_t i = 0; i < virtual_remap.size(); ++i) {
                        const int vk = virtual_remap[i];
                        if (vk <= 0) continue;
                        const unsigned int src_state = unsigned(i + 1);
                        const unsigned int dst_state = unsigned(num_physical_for_remap) + unsigned(vk);
                        if (dst_state > unsigned(int(Slic3r::EnforcerBlockerType::ExtruderMax)))
                            continue;
                        mv->mmu_segmentation_facets.set_enforcer_block_type_limit(
                            *mv,
                            Slic3r::EnforcerBlockerType::ExtruderMax,
                            Slic3r::EnforcerBlockerType(int(src_state)),
                            Slic3r::EnforcerBlockerType(int(dst_state)));
                        ++total_rewrites;
                    }
                }
            }
            ORCAXR_LOGI("nativeSlice: applied %zu virtual-remap rewrites (num_physical=%zu)",
                        total_rewrites, num_physical_for_remap);
        }

        // Phase J: OrcaXR-authored paint state. The Compose shell hands
        // us a byte array sized to the source mesh's triangle count;
        // every non-zero byte is a filament slot tag (1..32) we serialize
        // onto the volume's mmu_segmentation_facets. Painting overrides
        // any embedded 3MF paint — the user's in-XR edits are the source
        // of truth on slice. Applies to the FIRST volume of the FIRST
        // object only; multi-volume 3MFs would need per-volume paint
        // state, deferred to v2 of Phase J.
        if (jPaintFilamentIndex != nullptr && !model.objects.empty() &&
            !model.objects.front()->volumes.empty()) {
            const jsize paint_len = env->GetArrayLength(jPaintFilamentIndex);
            if (paint_len > 0) {
                jbyte* paint = env->GetByteArrayElements(jPaintFilamentIndex, nullptr);
                if (paint != nullptr) {
                    Slic3r::ModelVolume* mv = model.objects.front()->volumes.front();
                    const size_t authored = apply_orcaxr_paint(*mv, paint, size_t(paint_len));
                    ORCAXR_LOGI("nativeSlice: authored %zu painted triangles", authored);
                    env->ReleaseByteArrayElements(jPaintFilamentIndex, paint, JNI_ABORT);
                }
            }
        }

        // Phase XR_OBJ_8 — OrcaXR-authored support paint. Same shape
        // as the color paint above but flows into mv->supported_facets
        // instead of mv->mmu_segmentation_facets. State 1=ENFORCER,
        // 2=BLOCKER. Applies to the first volume of the first object
        // (matches Phase J's color-paint scope).
        if (jSupportFlags != nullptr && !model.objects.empty() &&
            !model.objects.front()->volumes.empty()) {
            const jsize sup_len = env->GetArrayLength(jSupportFlags);
            if (sup_len > 0) {
                jbyte* sup = env->GetByteArrayElements(jSupportFlags, nullptr);
                if (sup != nullptr) {
                    Slic3r::ModelVolume* mv = model.objects.front()->volumes.front();
                    const size_t authored = apply_orcaxr_support(*mv, sup, size_t(sup_len));
                    ORCAXR_LOGI("nativeSlice: authored %zu support-painted triangles", authored);
                    env->ReleaseByteArrayElements(jSupportFlags, sup, JNI_ABORT);
                }
            }
        }

        // Phase XR_OBJ_8 — OrcaXR-authored seam paint. Same shape
        // as the support paint above but flows into mv->seam_facets.
        if (jSeamFlags != nullptr && !model.objects.empty() &&
            !model.objects.front()->volumes.empty()) {
            const jsize seam_len = env->GetArrayLength(jSeamFlags);
            if (seam_len > 0) {
                jbyte* seam = env->GetByteArrayElements(jSeamFlags, nullptr);
                if (seam != nullptr) {
                    Slic3r::ModelVolume* mv = model.objects.front()->volumes.front();
                    const size_t authored = apply_orcaxr_seam(*mv, seam, size_t(seam_len));
                    ORCAXR_LOGI("nativeSlice: authored %zu seam-painted triangles", authored);
                    env->ReleaseByteArrayElements(jSeamFlags, seam, JNI_ABORT);
                }
            }
        }

        // Phase XR_OBJ_4 (final) — per-object config overrides. Apply
        // onto the FIRST object's local DynamicPrintConfig before
        // Print::apply consumes the model. Same shape as the global
        // cfg apply pattern (set_deserialize_nothrow + log per-pair).
        // Multi-object scenarios (a 3MF with N objects) currently
        // share the same overrides — future polish would key per-
        // ModelObject if/when the UI offers per-object selection in
        // a multi-object plate.
        if (jObjectConfigKeys != nullptr && jObjectConfigValues != nullptr &&
            !model.objects.empty()) {
            const jsize n_keys = env->GetArrayLength(jObjectConfigKeys);
            const jsize n_values = env->GetArrayLength(jObjectConfigValues);
            const jsize n = (n_keys < n_values) ? n_keys : n_values;
            if (n > 0) {
                Slic3r::ModelObject* mo = model.objects.front();
                Slic3r::ConfigSubstitutionContext substitutions(
                    Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);
                for (jsize i = 0; i < n; ++i) {
                    jstring jk = (jstring) env->GetObjectArrayElement(jObjectConfigKeys, i);
                    jstring jv = (jstring) env->GetObjectArrayElement(jObjectConfigValues, i);
                    if (jk == nullptr || jv == nullptr) {
                        if (jk) env->DeleteLocalRef(jk);
                        if (jv) env->DeleteLocalRef(jv);
                        continue;
                    }
                    {
                        ScopedUtf k(env, jk);
                        ScopedUtf v(env, jv);
                        ORCAXR_LOGI("nativeSlice: object cfg %s=%s", k.c, v.c);
                        // ModelConfig (Slic3r::ModelConfig in
                        // PrintConfig.hpp:1975) only exposes
                        // `set_deserialize` (throws), not a `_nothrow`
                        // sibling — wrap it ourselves so a single bad
                        // key doesn't abort the whole slice. The
                        // global cfg path uses cfg.set_deserialize_nothrow
                        // which is the DynamicPrintConfig method;
                        // ModelConfig wraps a DynamicPrintConfig but
                        // doesn't surface the nothrow variant.
                        try {
                            mo->config.set_deserialize(k.c, v.c, substitutions);
                        } catch (const std::exception& e) {
                            ORCAXR_LOGE("nativeSlice: rejected object config %s=%s: %s",
                                        k.c, v.c, e.what());
                        } catch (...) {
                            ORCAXR_LOGE("nativeSlice: rejected object config %s=%s (unknown)",
                                        k.c, v.c);
                        }
                    }
                    env->DeleteLocalRef(jk);
                    env->DeleteLocalRef(jv);
                }
            }
        }

        Slic3r::Print print;
        // Print::m_isBBLPrinter is uninitialized in the default ctor —
        // happens to read as garbage, often true. When true, GCode export
        // tries to write the full config dump as a comment block at the
        // top of the .gcode, which crashes inside ConfigOptionEnumsGeneric
        // because some enum option has no name table loaded (the BBL path
        // assumes a loaded preset bundle, which we don't have). Force it
        // to false to take the non-BBL G-code path.
        print.is_BBL_printer() = false;

        Slic3r::DynamicPrintConfig cfg = Slic3r::DynamicPrintConfig::full_print_config();

        // -- Patch up ConfigOptionEnumsGeneric instances. ----------------
        // The "generic enum" config options (extruder_type,
        // nozzle_volume_type, default_nozzle_volume_type,
        // overhang_fan_threshold, …) carry a runtime
        // keys_map pointer that resolves string values to ints during
        // deserialize. PrintConfig.cpp populates ConfigOptionDef::
        // enum_keys_map at static-init time, but
        // FullPrintConfig::defaults() seeds these options with the
        // initializer-list constructor (Config.hpp:2097), which does
        // *not* copy keys_map onto the instance. Net effect: any
        // set_deserialize_nothrow against one of these keys dereferences
        // a null keys_map → SIGSEGV on arm64 Release.
        //
        // u1-slicer-for-android sidesteps this by only ever using typed
        // ConfigOptionEnum<T>::set_key_value calls, never the generic
        // string-deserialize path. We load profile JSONs at runtime and
        // need the generic deserialize to work, so instead of
        // dispatching per-key we walk every option once and re-attach
        // the keys_map ConfigOptionDef already knows about. After this,
        // set_deserialize_nothrow on extruder_type / nozzle_volume_type
        // / overhang_fan_threshold succeeds normally.
        if (const Slic3r::ConfigDef* config_def = cfg.def()) {
            for (const auto& kv : config_def->options) {
                const auto& key = kv.first;
                const Slic3r::ConfigOptionDef& opt_def = kv.second;
                if (opt_def.type != Slic3r::coEnums || opt_def.enum_keys_map == nullptr)
                    continue;
                Slic3r::ConfigOption* opt = cfg.option(key, false);
                if (auto* en = dynamic_cast<Slic3r::ConfigOptionEnumsGeneric*>(opt)) {
                    if (en->keys_map == nullptr) {
                        en->keys_map = opt_def.enum_keys_map;
                    }
                }
            }
        }
        // ---------------------------------------------------------------

        // Force relative E distances. Profiles that carry their own
        // `before_layer_change_gcode` (Snapmaker U1's stock profile, for
        // example) emit `G92 E0` per layer, which `Print::validate()`
        // rejects under absolute E (the validator's exact error:
        // "G92 E0 was found in before_layer_gcode, which is incompatible
        // with absolute extruder addressing"). The Snapmaker stack's
        // `fdm_common.json` sets `use_relative_e_distances=1` for the
        // same reason; we mirror it here so any profile chain that
        // doesn't inherit fdm_common still slices. Single-extruder
        // profiles without per-layer reset are fine either way.
        cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(true));

        // Apply caller-supplied key/value overrides. Errors per pair are
        // logged but non-fatal — caller can ship a config that touches
        // some keys we don't have plumbed yet without dying.
        if (jConfigKeys != nullptr && jConfigValues != nullptr) {
            jsize n_keys = env->GetArrayLength(jConfigKeys);
            jsize n_values = env->GetArrayLength(jConfigValues);
            jsize n = (n_keys < n_values) ? n_keys : n_values;
            Slic3r::ConfigSubstitutionContext substitutions(Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);
            for (jsize i = 0; i < n; ++i) {
                jstring jk = (jstring) env->GetObjectArrayElement(jConfigKeys, i);
                jstring jv = (jstring) env->GetObjectArrayElement(jConfigValues, i);
                if (jk == nullptr || jv == nullptr) {
                    if (jk) env->DeleteLocalRef(jk);
                    if (jv) env->DeleteLocalRef(jv);
                    continue;
                }
                {
                    ScopedUtf k(env, jk);
                    ScopedUtf v(env, jv);
                    // Log every attempt BEFORE invoking the slicer.
                    // set_deserialize_nothrow can SIGSEGV inside
                    // ConfigOptionEnumsGeneric::deserialize when the
                    // enum's name table wasn't populated by a preset
                    // bundle (we don't load one). Per-key trace makes
                    // the offender visible in the crash log.
                    ORCAXR_LOGI("nativeSlice: cfg %s=%s", k.c, v.c);
                    bool ok = cfg.set_deserialize_nothrow(k.c, v.c, substitutions);
                    if (!ok) ORCAXR_LOGE("nativeSlice: rejected config: %s=%s", k.c, v.c);
                }
                env->DeleteLocalRef(jk);
                env->DeleteLocalRef(jv);
            }
        }

        // Auto-center the model on the bed. OrcaSlicer's GUI handles
        // this via the Plater's auto-arrange; our headless path doesn't,
        // so an STL whose vertices straddle the origin (typical centered
        // cube: -10..10 x -10..10) lands on the printable area's lower-
        // left corner (0,0) and the skirt extends to negative X/Y. The
        // U1 firmware then aborts mid-print with "X axis exceeded travel
        // limit". Compute the printable area's centroid and translate
        // the instance so the model's bbox center lands there.
        Slic3r::Vec2d bed_center(100.0, 100.0); // fallback for 200x200
        if (auto* pa = dynamic_cast<const Slic3r::ConfigOptionPoints*>(cfg.option("printable_area"))) {
            const auto& pts = pa->values;
            if (!pts.empty()) {
                Slic3r::Vec2d sum(0.0, 0.0);
                for (const auto& p : pts) sum += p;
                bed_center = sum / static_cast<double>(pts.size());
                ORCAXR_LOGI("nativeSlice: bed center (%.2f, %.2f) from %zu points",
                            bed_center.x(), bed_center.y(), pts.size());
            }
        }

        // Auto-arrange in a row centered on the bed. Single-object
        // case puts it at bed center; multi-object 3MFs (e.g. two
        // dragons) get spaced left-to-right with a 5mm gap so they
        // don't print on top of each other.
        auto placements = row_layout(model.objects, bed_center);
        for (size_t i = 0; i < model.objects.size(); ++i) {
            Slic3r::ModelObject* mo = model.objects[i];
            const auto& p = placements[i];
            ORCAXR_LOGI("nativeSlice: object[%zu] world_bbox (%.1f..%.1f, %.1f..%.1f, %.1f..%.1f) -> shift (%.2f, %.2f, %.2f)",
                        i,
                        p.world_bbox.min.x(), p.world_bbox.max.x(),
                        p.world_bbox.min.y(), p.world_bbox.max.y(),
                        p.world_bbox.min.z(), p.world_bbox.max.z(),
                        p.translation.x(), p.translation.y(), p.translation.z());
            for (auto* inst : mo->instances) {
                inst->set_offset(inst->get_offset() + p.translation);
            }
            print.auto_assign_extruders(mo);
        }

        print.apply(model, cfg);
        auto err = print.validate();
        if (!err.string.empty()) {
            ORCAXR_LOGE("nativeSlice: validate failed: %s", err.string.c_str());
            if (listener_global) env->DeleteGlobalRef(listener_global);
            return -2;
        }

        if (listener_global != nullptr && on_progress_mid != nullptr) {
            // Capture by value into the std::function — the lambda
            // outlives this stack frame because Print holds it as
            // m_status_callback and may invoke it from worker threads
            // spawned inside process(). All JNI traffic goes through
            // g_jvm + AttachCurrentThread; we never assume the calling
            // thread is already attached.
            int last_pct = -2;
            std::string last_msg;
            print.set_status_callback(
                [listener_global, on_progress_mid, last_pct, last_msg]
                (const Slic3r::PrintBase::SlicingStatus& s) mutable {
                    // Throttle: libslic3r fires the callback at every
                    // internal step. Drop duplicates of (percent, text)
                    // so we don't flood the JNI bridge for a 30 s slice
                    // that would otherwise emit ~thousands of identical
                    // ticks.
                    if (s.percent == last_pct && s.text == last_msg) return;
                    last_pct = s.percent;
                    last_msg = s.text;

                    if (g_jvm == nullptr) return;
                    JNIEnv* cb_env = nullptr;
                    bool attached = false;
                    if (g_jvm->GetEnv(reinterpret_cast<void**>(&cb_env), JNI_VERSION_1_6) != JNI_OK) {
                        if (g_jvm->AttachCurrentThread(&cb_env, nullptr) != JNI_OK || cb_env == nullptr)
                            return;
                        attached = true;
                    }
                    jstring jmsg = cb_env->NewStringUTF(s.text.c_str());
                    cb_env->CallVoidMethod(listener_global, on_progress_mid,
                                           static_cast<jint>(s.percent), jmsg);
                    if (cb_env->ExceptionCheck()) {
                        cb_env->ExceptionDescribe();
                        cb_env->ExceptionClear();
                    }
                    if (jmsg) cb_env->DeleteLocalRef(jmsg);
                    if (attached) g_jvm->DetachCurrentThread();
                });
        } else {
            print.set_status_silent();
        }
        // OrcaSlicer 2.3.2's `apply_mm_segmentation` (PrintObjectSlice.cpp:885)
        // SIGSEGVs on Android arm64 when slicing painted multi-color 3MFs:
        // a TBB parallel_for body races on `std::vector<ExPolygon>`
        // reallocation under ARM64's weak memory ordering, leaving
        // `region.expolygons` with a dangling data pointer that
        // `get_extents` then dereferences (fault addresses look like
        // ASCII bytes from a freed std::string, e.g. 0x65646f6b = "kode").
        //
        // Fix: the three slicing-pipeline TUs that own / produce the
        // racy data (TriangleMeshSlicer.cpp, PrintObjectSlice.cpp,
        // MultiMaterialSegmentation.cpp) each `#define
        // ORCAXR_TBB_SERIAL_ACTIVE 1` at the top of the file, which
        // activates the per-TU TBB parallel_for serial shim from
        // patches/tbb_serial/. All other libslic3r TUs keep real
        // parallelism (a broad shim deadlocks because some libslic3r
        // task_group patterns genuinely need concurrent workers).
        // No global_control wrapper is needed and it would actively
        // hurt: capping the whole pool also deadlocks the working
        // task_group sites in the non-shimmed TUs.
        ORCAXR_LOGI("nativeSlice: shim-serialized slicing pipeline (MMS/POS/TMS)");
        auto t_proc_start = std::chrono::steady_clock::now();
        print.process();
        auto t_proc_end = std::chrono::steady_clock::now();
        auto proc_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_proc_end - t_proc_start).count();
        ORCAXR_LOGI("nativeSlice: TIMING print.process() = %lld ms", (long long)proc_ms);

        Slic3r::GCodeProcessorResult result;
        auto t_exp_start = std::chrono::steady_clock::now();
        std::string written = print.export_gcode(out.c, &result, nullptr);
        auto t_exp_end = std::chrono::steady_clock::now();
        auto exp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t_exp_end - t_exp_start).count();
        ORCAXR_LOGI("nativeSlice: TIMING export_gcode = %lld ms", (long long)exp_ms);
        ORCAXR_LOGI("nativeSlice: TIMING total = %lld ms (process %lld + export %lld)",
                    (long long)(proc_ms + exp_ms), (long long)proc_ms, (long long)exp_ms);
        ORCAXR_LOGI("nativeSlice: G-code written to %s", written.c_str());

        // OrcaXR Phase L: rewrite `Tn` / `M104 Tn` / `M109 Tn` ... using
        // the user-supplied filament_map. The Snapmaker U1's
        // `change_filament_gcode` and `machine_start_gcode` templates
        // emit `T<filament_id>` literally (via the
        // `next_extruder` / `initial_extruder` placeholders), and
        // libslic3r's `custom_gcode_changes_tool` then drops the
        // writer's own toolchange — so without this post-processor the
        // gcode the printer sees is filament-id-indexed, ignoring the
        // user's physical-slot picker. See the postprocess function
        // comment for the full reasoning.
        if (auto* fm = cfg.option<Slic3r::ConfigOptionInts>("filament_map")) {
            postprocess_remap_tool_commands(written, fm->values);
        }

        if (listener_global) env->DeleteGlobalRef(listener_global);
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeSlice: exception %s", e.what());
        if (listener_global) env->DeleteGlobalRef(listener_global);
        return -3;
    } catch (...) {
        ORCAXR_LOGE("nativeSlice: unknown exception");
        if (listener_global) env->DeleteGlobalRef(listener_global);
        return -4;
    }
}

// nativeSliceMulti — slice N input meshes laid out on the same bed
// into a single G-code file. Each input contributes one ModelObject
// to the shared Slic3r::Model; per-input transforms (XYZ translate,
// XYZ rotation, per-axis scale, per-axis mirror) are applied to that
// object's instance.
//
// [inputPaths] is a String[] of mesh-container paths (STL/3MF/AMF/
// OBJ/STEP). For 3MF/AMF inputs we take only the FIRST object's mesh
// — multi-object containers' extra objects are dropped (caller can
// pre-flatten via nativeConvertToStl if they need the full hierarchy).
//
// [transforms] is a flat float[] of 12 values per input (Phase XR_OBJ_2;
// pre-Phase-XR_OBJ_2 callers passed 4 values per input — back-compat is
// preserved by the length check below: a 4-floats-per-input call zeros
// the unsupplied axes implicitly via the same code path that runs when
// the user hasn't touched the new TransformPanel knobs):
//   [0] translateXmm  (offset from bed center, mm)
//   [1] translateYmm  (offset from bed center, mm)
//   [2] translateZmm  (vertical lift, mm; auto-bed-drop ignores this for
//                      the per-object grouping but the instance-Z still
//                      passes through to libslic3r's slicing)
//   [3] rotXdeg       (X-axis rotation in degrees)
//   [4] rotYdeg       (Y-axis rotation in degrees)
//   [5] rotZdeg       (Z-axis rotation in degrees)
//   [6] scaleXPct     (per-axis scale percent, 100 = identity)
//   [7] scaleYPct
//   [8] scaleZPct
//   [9] mirrorXSign   (-1 = mirror, +1 = identity)
//   [10] mirrorYSign
//   [11] mirrorZSign
//
// Centers the group bbox on the printable area's centroid the same
// way nativeSlice does for a single model — keeps prints inside the
// printer's safe travel envelope.
//
// Returns 0 on success, negative on failure (-1 read, -2 validate,
// -3 process/export, -4 unknown).
//
// Stride detection: the array length is `n_inputs * stride`, where
// stride is either 4 (legacy) or 12 (post-Phase-XR_OBJ_2). We pick
// whichever divides evenly and matches a known stride; mismatches
// fail with -1.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeSliceMulti(
    JNIEnv* env, jclass,
    jobjectArray jInputPaths,
    jfloatArray  jTransforms,
    jstring      jOutGcodePath,
    jobjectArray jConfigKeys,
    jobjectArray jConfigValues,
    jobject      jProgressListener,
    jobjectArray jPaintFilamentIndices)
{
    ScopedUtf out(env, jOutGcodePath);
    const jsize n_inputs = jInputPaths != nullptr ? env->GetArrayLength(jInputPaths) : 0;
    ORCAXR_LOGI("nativeSliceMulti: %d inputs out=%s listener=%s",
                n_inputs, out.c, jProgressListener ? "yes" : "no");
    if (n_inputs == 0) {
        ORCAXR_LOGE("nativeSliceMulti: no inputs");
        return -1;
    }
    int stride = 0;
    if (jTransforms != nullptr) {
        const jsize tlen = env->GetArrayLength(jTransforms);
        if (tlen == n_inputs * 12) stride = 12;
        else if (tlen == n_inputs * 4) stride = 4;
    }
    if (stride == 0) {
        ORCAXR_LOGE("nativeSliceMulti: transforms array length %d does not match %d inputs (need %d or %d floats)",
                    jTransforms == nullptr ? 0 : env->GetArrayLength(jTransforms),
                    n_inputs, n_inputs * 4, n_inputs * 12);
        return -1;
    }

    // Same listener resolution dance as nativeSlice — see comments there.
    jobject  listener_global = nullptr;
    jmethodID on_progress_mid = nullptr;
    if (jProgressListener != nullptr && g_jvm != nullptr) {
        listener_global = env->NewGlobalRef(jProgressListener);
        if (listener_global != nullptr) {
            jclass cls = env->GetObjectClass(listener_global);
            on_progress_mid = env->GetMethodID(cls, "onProgress", "(ILjava/lang/String;)V");
            env->DeleteLocalRef(cls);
            if (on_progress_mid == nullptr) {
                env->ExceptionClear();
                env->DeleteGlobalRef(listener_global);
                listener_global = nullptr;
            }
        }
    }

    // Pull transforms into a plain C++ vector for callback-safe access.
    jfloat* tv = env->GetFloatArrayElements(jTransforms, nullptr);
    std::vector<float> transforms(tv, tv + (n_inputs * stride));
    env->ReleaseFloatArrayElements(jTransforms, tv, JNI_ABORT);

    try {
        Slic3r::Model multi;
        for (jsize i = 0; i < n_inputs; ++i) {
            jstring jp = (jstring) env->GetObjectArrayElement(jInputPaths, i);
            if (jp == nullptr) {
                ORCAXR_LOGE("nativeSliceMulti: null path at index %d", i);
                if (listener_global) env->DeleteGlobalRef(listener_global);
                return -1;
            }
            // Inner scope so ScopedUtf releases its UTF chars BEFORE
            // we DeleteLocalRef(jp) at the bottom of the iteration —
            // releasing after invalidation triggers JNI gotcha #3
            // (the "popped reference at index N" abort). All uses of
            // p.c live inside this block.
            {
                ScopedUtf p(env, jp);
                Slic3r::Model src;
                try {
                    src = load_mesh_container(p.c);
                } catch (const std::exception& e) {
                    ORCAXR_LOGE("nativeSliceMulti: read failed for %s: %s", p.c, e.what());
                    env->DeleteLocalRef(jp);
                    if (listener_global) env->DeleteGlobalRef(listener_global);
                    return -1;
                }
                if (src.objects.empty()) {
                    ORCAXR_LOGE("nativeSliceMulti: empty model from %s", p.c);
                    env->DeleteLocalRef(jp);
                    if (listener_global) env->DeleteGlobalRef(listener_global);
                    return -1;
                }
                // Phase XR_OBJ_4 — clone the source's first ModelObject
                // (preserving every volume, including modifiers /
                // negative volumes / support enforcers/blockers /
                // per-volume mmu_segmentation_facets / supported_facets
                // / seam_facets / per-volume DynamicPrintConfig) instead
                // of taking the merged TriangleMesh and building a
                // single-volume model from it.
                //
                // Pre-Phase-XR_OBJ_4 the JNI did
                //   `Slic3r::TriangleMesh mesh = src.objects.front()->mesh();
                //    multi.add_object(name, path, std::move(mesh));`
                // which silently flattens multi-volume 3MFs (Bambu /
                // MakerWorld painted dragons with N volumes per object)
                // into a single solid mesh — losing per-face
                // mmu_segmentation_facets and printing single-color
                // when plated alongside another model. Gotcha #29.
                //
                // For 3MFs with N>1 ModelObjects we still take only
                // objects.front() — multi-object containers' extra
                // objects need their own plate slot.
                Slic3r::ModelObject* mo = multi.add_object(*src.objects.front());
                // Reset the cloned source's instances and pose. The
                // 3MF on disk may carry instance offsets; we apply the
                // user's per-input transforms below, then ensure_on_bed
                // lifts the mesh to z=0 (after user transforms because
                // X/Y rotation can tilt the mesh and shift its lowest
                // point).
                mo->name = std::string("model_") + std::to_string(i);
                mo->clear_instances();
                mo->add_instance();

                ORCAXR_LOGI("nativeSliceMulti: model[%d] cloned %zu volumes from %s",
                            i, mo->volumes.size(), p.c);
                // Volume-level facet survival diagnostic. Logs which
                // per-face annotations made the trip through the deep
                // clone; useful for triaging multi-color regressions.
                for (size_t vi = 0; vi < mo->volumes.size(); ++vi) {
                    const Slic3r::ModelVolume* mv = mo->volumes[vi];
                    if (!mv->mmu_segmentation_facets.empty() ||
                        !mv->seam_facets.empty() ||
                        !mv->supported_facets.empty()) {
                        ORCAXR_LOGI("  volume[%zu] '%s' type=%d mmu=%s seam=%s support=%s",
                                    vi, mv->name.c_str(), int(mv->type()),
                                    mv->mmu_segmentation_facets.empty() ? "no" : "yes",
                                    mv->seam_facets.empty() ? "no" : "yes",
                                    mv->supported_facets.empty() ? "no" : "yes");
                    }
                }

                // Phase J per-input paint state. jPaintFilamentIndices
                // is a String[]-sized array of jbyteArray (one per
                // input, parallel to jInputPaths); null entries skip
                // painting for that input. We override the PRIMARY
                // volume's paint when the caller supplies one — the
                // primary volume is `mo->volumes.front()` (the first
                // MODEL_PART). Modifier / negative / support volumes
                // keep their cloned-from-3MF facet annotations.
                if (jPaintFilamentIndices != nullptr) {
                    const jsize n_paints = env->GetArrayLength(jPaintFilamentIndices);
                    if (i < n_paints) {
                        jbyteArray jp_paint = (jbyteArray) env->GetObjectArrayElement(jPaintFilamentIndices, i);
                        if (jp_paint != nullptr) {
                            const jsize paint_len = env->GetArrayLength(jp_paint);
                            if (paint_len > 0) {
                                jbyte* paint = env->GetByteArrayElements(jp_paint, nullptr);
                                if (paint != nullptr) {
                                    Slic3r::ModelVolume* mv = mo->volumes.front();
                                    const size_t authored = apply_orcaxr_paint(*mv, paint, size_t(paint_len));
                                    ORCAXR_LOGI("nativeSliceMulti: model[%d] authored %zu painted triangles (override)",
                                                i, authored);
                                    env->ReleaseByteArrayElements(jp_paint, paint, JNI_ABORT);
                                }
                            }
                            env->DeleteLocalRef(jp_paint);
                        }
                    }
                }

                // Apply per-input transform. Stride 4 = legacy (XY translate
                // + Z rotation + uniform scale), stride 12 = Phase XR_OBJ_2
                // full-axis (XYZ translate + XYZ rotation + per-axis scale
                // + per-axis mirror sign).
                float tx = 0.f, ty = 0.f, tz = 0.f;
                float rxDeg = 0.f, ryDeg = 0.f, rzDeg = 0.f;
                float sx = 1.f, sy = 1.f, sz = 1.f;
                if (stride == 4) {
                    tx     = transforms[i * 4 + 0];
                    ty     = transforms[i * 4 + 1];
                    rzDeg  = transforms[i * 4 + 2];
                    const float u = transforms[i * 4 + 3] / 100.0f;
                    sx = u; sy = u; sz = u;
                } else { // stride == 12
                    tx     = transforms[i * 12 + 0];
                    ty     = transforms[i * 12 + 1];
                    tz     = transforms[i * 12 + 2];
                    rxDeg  = transforms[i * 12 + 3];
                    ryDeg  = transforms[i * 12 + 4];
                    rzDeg  = transforms[i * 12 + 5];
                    sx     = transforms[i * 12 + 6] / 100.0f;
                    sy     = transforms[i * 12 + 7] / 100.0f;
                    sz     = transforms[i * 12 + 8] / 100.0f;
                    sx *= transforms[i * 12 + 9];   // mirrorXSign (-1 / +1)
                    sy *= transforms[i * 12 + 10];  // mirrorYSign
                    sz *= transforms[i * 12 + 11];  // mirrorZSign
                }
                Slic3r::ModelInstance* inst = mo->instances.front();
                const double rxRad = rxDeg * M_PI / 180.0;
                const double ryRad = ryDeg * M_PI / 180.0;
                const double rzRad = rzDeg * M_PI / 180.0;
                inst->set_rotation(Slic3r::Vec3d(rxRad, ryRad, rzRad));
                inst->set_scaling_factor(Slic3r::Vec3d(sx, sy, sz));
                inst->set_offset(Slic3r::Vec3d(tx, ty, tz));
                // Phase XR_OBJ_4 — ensure_on_bed() AFTER the user
                // transforms because rotation can move the lowest
                // point. translate_instances ADDS to the current
                // offset, so the user's tx/ty/tz survive. The Z drop
                // from `min_z()` is computed in world space (volume
                // mesh × volume transform × instance matrix), so
                // it picks up tilt-induced shifts that row_layout's
                // post-pass would otherwise have to handle. Without
                // this, a cloned 3MF whose source instance offset is
                // discarded slices with "empty first layer" — gotcha
                // surfaced when the dragon's natural mesh position
                // (centered at z=0) gets cloned.
                mo->ensure_on_bed();

                ORCAXR_LOGI("nativeSliceMulti: model[%d] '%s' t=(%.1f,%.1f,%.1f) r=(%.1f,%.1f,%.1f)° s=(%.2f,%.2f,%.2f) post-bed-z=%.2f",
                            i, p.c, tx, ty, tz, rxDeg, ryDeg, rzDeg, sx, sy, sz,
                            mo->instances.front()->get_offset().z());
            }
            env->DeleteLocalRef(jp);
        }

        Slic3r::Print print;
        print.is_BBL_printer() = false;
        Slic3r::DynamicPrintConfig cfg = Slic3r::DynamicPrintConfig::full_print_config();
        if (const Slic3r::ConfigDef* config_def = cfg.def()) {
            for (const auto& kv : config_def->options) {
                const auto& key = kv.first;
                const Slic3r::ConfigOptionDef& opt_def = kv.second;
                if (opt_def.type != Slic3r::coEnums || opt_def.enum_keys_map == nullptr) continue;
                Slic3r::ConfigOption* opt = cfg.option(key, false);
                if (auto* en = dynamic_cast<Slic3r::ConfigOptionEnumsGeneric*>(opt)) {
                    if (en->keys_map == nullptr) en->keys_map = opt_def.enum_keys_map;
                }
            }
        }
        cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(true));

        if (jConfigKeys != nullptr && jConfigValues != nullptr) {
            jsize n_keys = env->GetArrayLength(jConfigKeys);
            jsize n_values = env->GetArrayLength(jConfigValues);
            jsize n = (n_keys < n_values) ? n_keys : n_values;
            Slic3r::ConfigSubstitutionContext substitutions(
                Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);
            for (jsize i = 0; i < n; ++i) {
                jstring jk = (jstring) env->GetObjectArrayElement(jConfigKeys, i);
                jstring jv = (jstring) env->GetObjectArrayElement(jConfigValues, i);
                if (jk == nullptr || jv == nullptr) {
                    if (jk) env->DeleteLocalRef(jk);
                    if (jv) env->DeleteLocalRef(jv);
                    continue;
                }
                {
                    ScopedUtf k(env, jk);
                    ScopedUtf v(env, jv);
                    cfg.set_deserialize_nothrow(k.c, v.c, substitutions);
                }
                env->DeleteLocalRef(jk);
                env->DeleteLocalRef(jv);
            }
        }

        // Compute the printable-area centroid (same fallback as nativeSlice).
        Slic3r::Vec2d bed_center(100.0, 100.0);
        if (auto* pa = dynamic_cast<const Slic3r::ConfigOptionPoints*>(cfg.option("printable_area"))) {
            const auto& pts = pa->values;
            if (!pts.empty()) {
                Slic3r::Vec2d sum(0.0, 0.0);
                for (const auto& p : pts) sum += p;
                bed_center = sum / static_cast<double>(pts.size());
            }
        }

        // Collect world bboxes of every instance so we can shift the
        // whole group onto the bed. The user's per-input (tx, ty) are
        // relative to the eventual group center; we just translate
        // everything by (bed_center - group_centroid_xy) and drop Z
        // so the lowest point sits at z=0.
        Slic3r::BoundingBoxf3 group_bb;
        bool first = true;
        std::vector<Slic3r::BoundingBoxf3> per_inst;
        per_inst.reserve(n_inputs);
        for (Slic3r::ModelObject* mo : multi.objects) {
            Slic3r::Transform3d xf = mo->instances.front()->get_matrix();
            Slic3r::BoundingBoxf3 b = world_bbox_of(mo->raw_bounding_box(), xf);
            per_inst.push_back(b);
            if (first) { group_bb = b; first = false; } else { group_bb.merge(b); }
        }
        Slic3r::Vec3d group_shift(
            bed_center.x() - (group_bb.min.x() + group_bb.max.x()) * 0.5,
            bed_center.y() - (group_bb.min.y() + group_bb.max.y()) * 0.5,
            -group_bb.min.z()
        );
        for (size_t i = 0; i < multi.objects.size(); ++i) {
            Slic3r::ModelObject* mo = multi.objects[i];
            Slic3r::ModelInstance* inst = mo->instances.front();
            inst->set_offset(inst->get_offset() + group_shift);
            print.auto_assign_extruders(mo);
            ORCAXR_LOGI("nativeSliceMulti: object[%zu] world_bbox before shift (%.1f..%.1f, %.1f..%.1f, %.1f..%.1f) group_shift (%.2f, %.2f, %.2f)",
                        i,
                        per_inst[i].min.x(), per_inst[i].max.x(),
                        per_inst[i].min.y(), per_inst[i].max.y(),
                        per_inst[i].min.z(), per_inst[i].max.z(),
                        group_shift.x(), group_shift.y(), group_shift.z());
        }

        print.apply(multi, cfg);
        auto err = print.validate();
        if (!err.string.empty()) {
            ORCAXR_LOGE("nativeSliceMulti: validate failed: %s", err.string.c_str());
            if (listener_global) env->DeleteGlobalRef(listener_global);
            return -2;
        }

        if (listener_global != nullptr && on_progress_mid != nullptr) {
            int last_pct = -2;
            std::string last_msg;
            print.set_status_callback(
                [listener_global, on_progress_mid, last_pct, last_msg]
                (const Slic3r::PrintBase::SlicingStatus& s) mutable {
                    if (s.percent == last_pct && s.text == last_msg) return;
                    last_pct = s.percent;
                    last_msg = s.text;
                    if (g_jvm == nullptr) return;
                    JNIEnv* cb_env = nullptr;
                    bool attached = false;
                    if (g_jvm->GetEnv(reinterpret_cast<void**>(&cb_env), JNI_VERSION_1_6) != JNI_OK) {
                        if (g_jvm->AttachCurrentThread(&cb_env, nullptr) != JNI_OK || cb_env == nullptr)
                            return;
                        attached = true;
                    }
                    jstring jmsg = cb_env->NewStringUTF(s.text.c_str());
                    cb_env->CallVoidMethod(listener_global, on_progress_mid,
                                           static_cast<jint>(s.percent), jmsg);
                    if (cb_env->ExceptionCheck()) {
                        cb_env->ExceptionDescribe();
                        cb_env->ExceptionClear();
                    }
                    if (jmsg) cb_env->DeleteLocalRef(jmsg);
                    if (attached) g_jvm->DetachCurrentThread();
                });
        } else {
            print.set_status_silent();
        }
        // Same MMS race workaround as nativeSlice — see the comment
        // in nativeSlice for the full rationale. Per-TU shim, no
        // global_control wrapper.
        ORCAXR_LOGI("nativeSliceMulti: shim-serialized slicing pipeline (MMS/POS/TMS)");
        print.process();

        Slic3r::GCodeProcessorResult result;
        std::string written = print.export_gcode(out.c, &result, nullptr);
        ORCAXR_LOGI("nativeSliceMulti: G-code written to %s", written.c_str());

        // Same Tn → physical-extruder rewrite as nativeSlice. See
        // postprocess_remap_tool_commands for the full rationale.
        if (auto* fm = cfg.option<Slic3r::ConfigOptionInts>("filament_map")) {
            postprocess_remap_tool_commands(written, fm->values);
        }

        if (listener_global) env->DeleteGlobalRef(listener_global);
        return 0;
    } catch (const Slic3r::SlicingErrors& e) {
        // Per-object slice errors. The bare `e.what()` is just
        // "Errors"; the per-object messages live in `errors_`. Log
        // each so a multi-input slice failure is debuggable without
        // round-tripping through the desktop slicer.
        ORCAXR_LOGE("nativeSliceMulti: SlicingErrors with %zu per-object messages:",
                    e.errors_.size());
        for (const auto& err : e.errors_) {
            ORCAXR_LOGE("  object[%zu]: %s", err.objectId(), err.what());
        }
        if (listener_global) env->DeleteGlobalRef(listener_global);
        return -3;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeSliceMulti: exception %s", e.what());
        if (listener_global) env->DeleteGlobalRef(listener_global);
        return -3;
    } catch (...) {
        ORCAXR_LOGE("nativeSliceMulti: unknown exception");
        if (listener_global) env->DeleteGlobalRef(listener_global);
        return -4;
    }
}

// nativeSaveAs3mf — write [model] (loaded via Model::read_from_file
// from any supported format) to a 3MF at [outPath], embedding the
// supplied (key, value) config pairs. The 3MF can be re-opened by
// OrcaXR or desktop OrcaSlicer with the user's slice settings intact.
//
// Implementation: load the source mesh container (STL/3MF/OBJ/AMF),
// build a DynamicPrintConfig from full_print_config + the keys_map
// fixup + caller overrides (mirrors nativeSlice's setup so the saved
// 3MF is consistent with what we would have sliced), then call
// libslic3r's `store_3mf`.
//
// Returns 0 on success, negative on failure.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeSaveAs3mf(
    JNIEnv* env, jclass,
    jstring jInputPath, jstring jOutPath,
    jobjectArray jConfigKeys, jobjectArray jConfigValues)
{
    ScopedUtf in(env, jInputPath);
    ScopedUtf out(env, jOutPath);
    ORCAXR_LOGI("nativeSaveAs3mf: %s -> %s", in.c, out.c);

    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeSaveAs3mf: read failed: %s", e.what());
            return -1;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeSaveAs3mf: source has no objects");
            return -1;
        }
        for (Slic3r::ModelObject* mo : model.objects) {
            if (mo->instances.empty()) mo->add_instance();
        }

        Slic3r::DynamicPrintConfig cfg = Slic3r::DynamicPrintConfig::full_print_config();
        // Same keys_map fixup as nativeSlice — generic-enum options
        // need their runtime keys_map pointer attached before deserialize.
        if (const Slic3r::ConfigDef* config_def = cfg.def()) {
            for (const auto& kv : config_def->options) {
                const auto& key = kv.first;
                const Slic3r::ConfigOptionDef& opt_def = kv.second;
                if (opt_def.type != Slic3r::coEnums || opt_def.enum_keys_map == nullptr)
                    continue;
                Slic3r::ConfigOption* opt = cfg.option(key, false);
                if (auto* en = dynamic_cast<Slic3r::ConfigOptionEnumsGeneric*>(opt)) {
                    if (en->keys_map == nullptr) {
                        en->keys_map = opt_def.enum_keys_map;
                    }
                }
            }
        }
        cfg.set_key_value("use_relative_e_distances", new Slic3r::ConfigOptionBool(true));

        if (jConfigKeys != nullptr && jConfigValues != nullptr) {
            jsize n_keys = env->GetArrayLength(jConfigKeys);
            jsize n_values = env->GetArrayLength(jConfigValues);
            jsize n = (n_keys < n_values) ? n_keys : n_values;
            Slic3r::ConfigSubstitutionContext substitutions(Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);
            for (jsize i = 0; i < n; ++i) {
                jstring jk = (jstring) env->GetObjectArrayElement(jConfigKeys, i);
                jstring jv = (jstring) env->GetObjectArrayElement(jConfigValues, i);
                if (jk == nullptr || jv == nullptr) {
                    if (jk) env->DeleteLocalRef(jk);
                    if (jv) env->DeleteLocalRef(jv);
                    continue;
                }
                {
                    ScopedUtf k(env, jk);
                    ScopedUtf v(env, jv);
                    cfg.set_deserialize_nothrow(k.c, v.c, substitutions);
                }
                env->DeleteLocalRef(jk);
                env->DeleteLocalRef(jv);
            }
        }

        if (!Slic3r::store_3mf(out.c, &model, &cfg, /*fullpath_sources=*/false)) {
            ORCAXR_LOGE("nativeSaveAs3mf: store_3mf failed");
            return -3;
        }
        ORCAXR_LOGI("nativeSaveAs3mf: wrote %s", out.c);
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeSaveAs3mf: exception %s", e.what());
        return -3;
    } catch (...) {
        ORCAXR_LOGE("nativeSaveAs3mf: unknown exception");
        return -3;
    }
}

// nativeWriteColoredGlb — read a 3MF (or any format) and emit a GLB
// with per-vertex color sourced from each ModelVolume's painted MMU
// segmentation. Every triangle assigned to extruder N renders with
// `palette[N-1]`; un-painted regions render with each volume's default
// extruder color. Used by the in-XR preview path so a multi-color
// 3MF (e.g. a Bambu painted dragon) shows its actual color regions
// rather than a flat single-color mesh.
//
// Palette: jPaletteRgb is the authoritative palette. Caller (the
// Kotlin load pipeline) is responsible for seeding it with the 3MF's
// embedded `filament_colour` on first load (see
// SlicerEngine.read3mfFilamentColours + the previewStl handler) and
// for honoring user edits on subsequent renders. The JNI does NOT
// overlay the embedded colors on top of jPaletteRgb because that
// would clobber user edits — every re-render would reset to the
// authored colors.
//
// jPaletteRgb is a flat float array of [r0,g0,b0, r1,g1,b1, ...] in
// 0..1, length = 3*N.
//
// Returns 0 on success, negative on failure.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeWriteColoredGlb(
    JNIEnv* env, jclass,
    jstring jInputPath, jstring jOutGlbPath,
    jfloatArray jPaletteRgb,
    jbyteArray jPaintFilamentIndex)
{
    ScopedUtf in(env, jInputPath);
    ScopedUtf out(env, jOutGlbPath);
    ORCAXR_LOGI("nativeWriteColoredGlb: %s -> %s", in.c, out.c);

    // Build the user-palette layer first; the 3MF-embedded layer (if
    // any) overlays on top after the load.
    constexpr int MAX_SLOTS = 16;
    float palette[MAX_SLOTS][3];
    for (int i = 0; i < MAX_SLOTS; ++i) {
        palette[i][0] = palette[i][1] = palette[i][2] = 1.0f;
    }
    if (jPaletteRgb != nullptr) {
        jsize plen = env->GetArrayLength(jPaletteRgb);
        jsize slots = std::min<jsize>(plen / 3, MAX_SLOTS);
        if (slots > 0) {
            jfloat* pv = env->GetFloatArrayElements(jPaletteRgb, nullptr);
            for (jsize i = 0; i < slots; ++i) {
                palette[i][0] = pv[i * 3 + 0];
                palette[i][1] = pv[i * 3 + 1];
                palette[i][2] = pv[i * 3 + 2];
            }
            env->ReleaseFloatArrayElements(jPaletteRgb, pv, JNI_ABORT);
        }
    }

    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeWriteColoredGlb: read failed: %s", e.what());
            return -1;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeWriteColoredGlb: model has no objects");
            return -2;
        }

        // Phase J §G: OrcaXR-authored paint flows into the same
        // mmu_segmentation_facets the loop below reads. Same volume
        // selection rule as nativeSlice (first volume of first
        // object). Overrides any embedded 3MF paint.
        if (jPaintFilamentIndex != nullptr && !model.objects.front()->volumes.empty()) {
            const jsize paint_len = env->GetArrayLength(jPaintFilamentIndex);
            if (paint_len > 0) {
                jbyte* paint = env->GetByteArrayElements(jPaintFilamentIndex, nullptr);
                if (paint != nullptr) {
                    Slic3r::ModelVolume* mv = model.objects.front()->volumes.front();
                    const size_t authored = apply_orcaxr_paint(*mv, paint, size_t(paint_len));
                    ORCAXR_LOGI("nativeWriteColoredGlb: authored %zu painted triangles", authored);
                    env->ReleaseByteArrayElements(jPaintFilamentIndex, paint, JNI_ABORT);
                }
            }
        }

        // Aggregator — append every triangle here with its color, then
        // stream the result out as a GLB at the end.
        std::vector<float> positions;   // xyz xyz xyz...
        std::vector<float> colors;      // rgb rgb rgb...
        std::vector<int>   indices;     // 0,1,2, 3,4,5, ...

        auto emit = [&](const indexed_triangle_set& its,
                        const float rgb[3],
                        const Slic3r::Transform3d* transform)
        {
            if (its.empty()) return;
            int base = static_cast<int>(positions.size() / 3);
            // Vertices.
            for (const auto& v : its.vertices) {
                Slic3r::Vec3d p(v.x(), v.y(), v.z());
                if (transform) p = (*transform) * p;
                positions.push_back(static_cast<float>(p.x()));
                positions.push_back(static_cast<float>(p.y()));
                positions.push_back(static_cast<float>(p.z()));
                colors.push_back(rgb[0]);
                colors.push_back(rgb[1]);
                colors.push_back(rgb[2]);
            }
            // Indices.
            for (const auto& t : its.indices) {
                indices.push_back(base + t[0]);
                indices.push_back(base + t[1]);
                indices.push_back(base + t[2]);
            }
        };

        // Lay out objects in a row centered on (0, 0). The build
        // plate GLB lives in the same workspace frame and is
        // centered at the origin, so this puts the row of objects
        // visually on the plate. Multi-object 3MFs (two dragons,
        // calibration sets, etc.) get spaced 5mm apart instead of
        // stacked on top of each other.
        std::vector<Slic3r::ModelObject*> objs(
            model.objects.begin(), model.objects.end());
        auto placements = row_layout(objs, Slic3r::Vec2d(0.0, 0.0));

        for (size_t i = 0; i < model.objects.size(); ++i) {
            const Slic3r::ModelObject* mo = model.objects[i];
            Slic3r::Transform3d inst_xform = Slic3r::Transform3d::Identity();
            if (!mo->instances.empty()) {
                inst_xform = mo->instances.front()->get_matrix();
            }
            // Compose the row-layout shift on top of the instance
            // transform: vertices first go through inst_xform
            // (object-local -> world), then get translated by the
            // row-layout placement.
            Slic3r::Transform3d row_shift = Slic3r::Transform3d::Identity();
            row_shift.translation() = placements[i].translation;
            inst_xform = row_shift * inst_xform;

            ORCAXR_LOGI("nativeWriteColoredGlb: object[%zu] '%s' world_bbox (%.1f..%.1f, %.1f..%.1f, %.1f..%.1f) -> shift (%.2f, %.2f, %.2f)",
                        i, mo->name.c_str(),
                        placements[i].world_bbox.min.x(), placements[i].world_bbox.max.x(),
                        placements[i].world_bbox.min.y(), placements[i].world_bbox.max.y(),
                        placements[i].world_bbox.min.z(), placements[i].world_bbox.max.z(),
                        placements[i].translation.x(), placements[i].translation.y(), placements[i].translation.z());
            for (const Slic3r::ModelVolume* mv : mo->volumes) {
                if (!mv->is_model_part()) continue;
                Slic3r::Transform3d vol_xform = inst_xform * mv->get_matrix();

                int default_slot = std::max(0, mv->extruder_id() - 1);
                if (default_slot >= MAX_SLOTS) default_slot = 0;
                ORCAXR_LOGI("  volume '%s': default_extruder=%d painted=%d",
                            mv->name.c_str(), mv->extruder_id(),
                            mv->is_mm_painted() ? 1 : 0);

                if (mv->is_mm_painted()) {
                    // Painted volume: enumerate per-extruder facet
                    // batches. The vector index matches
                    // EnforcerBlockerType: 0 = NONE (un-painted ->
                    // volume default), 1 = Extruder1, 2 = Extruder2,
                    // ... up to ExtruderMax.
                    std::vector<indexed_triangle_set> per_type;
                    mv->mmu_segmentation_facets.get_facets(*mv, per_type);
                    ORCAXR_LOGI("    mmu segmentation: %zu types", per_type.size());
                    for (size_t t = 0; t < per_type.size(); ++t) {
                        if (per_type[t].empty()) continue;
                        int slot = (t == 0)
                            ? default_slot
                            : static_cast<int>(t) - 1;
                        if (slot < 0 || slot >= MAX_SLOTS) slot = 0;
                        ORCAXR_LOGI("    type[%zu] -> slot %d (rgb %.2f,%.2f,%.2f) %zu tris",
                                    t, slot,
                                    palette[slot][0], palette[slot][1], palette[slot][2],
                                    per_type[t].indices.size());
                        emit(per_type[t], palette[slot], &vol_xform);
                    }
                } else {
                    // Unpainted volume: render the whole thing in
                    // the volume's default color.
                    emit(mv->mesh().its, palette[default_slot], &vol_xform);
                }
            }
        }

        if (indices.empty()) {
            ORCAXR_LOGE("nativeWriteColoredGlb: no triangles emitted");
            return -2;
        }

        // ---- Stream a minimal GLB. Same layout as Kotlin
        // GlbBuilder, simplified for our specific case (positions +
        // colors + u32 indices, TRIANGLES, KHR_materials_unlit). ----
        const size_t vertex_count = positions.size() / 3;
        const size_t index_count = indices.size();
        const uint32_t positions_bytes = static_cast<uint32_t>(positions.size() * 4);
        const uint32_t colors_bytes    = static_cast<uint32_t>(colors.size() * 4);
        const uint32_t indices_bytes   = static_cast<uint32_t>(indices.size() * 4);
        const uint32_t bin_body_bytes  = positions_bytes + colors_bytes + indices_bytes;

        // Bbox for the POSITION accessor.
        float xmin = INFINITY, xmax = -INFINITY;
        float ymin = INFINITY, ymax = -INFINITY;
        float zmin = INFINITY, zmax = -INFINITY;
        for (size_t i = 0; i + 2 < positions.size(); i += 3) {
            float x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
            if (z < zmin) zmin = z; if (z > zmax) zmax = z;
        }

        char json_buf[2048];
        int json_len = std::snprintf(
            json_buf, sizeof(json_buf),
            "{\"asset\":{\"version\":\"2.0\"},"
            "\"extensionsUsed\":[\"KHR_materials_unlit\"],"
            "\"scene\":0,\"scenes\":[{\"nodes\":[0]}],"
            "\"nodes\":[{\"mesh\":0}],"
            "\"meshes\":[{\"primitives\":[{"
                "\"attributes\":{\"POSITION\":0,\"COLOR_0\":1},"
                "\"indices\":2,\"material\":0,\"mode\":4}]}],"
            "\"materials\":[{\"name\":\"unlit\","
                "\"extensions\":{\"KHR_materials_unlit\":{}},"
                "\"pbrMetallicRoughness\":{\"baseColorFactor\":[1.0,1.0,1.0,1.0]}}],"
            "\"accessors\":["
                "{\"bufferView\":0,\"componentType\":5126,\"count\":%zu,\"type\":\"VEC3\","
                    "\"min\":[%.6f,%.6f,%.6f],\"max\":[%.6f,%.6f,%.6f]},"
                "{\"bufferView\":1,\"componentType\":5126,\"count\":%zu,\"type\":\"VEC3\"},"
                "{\"bufferView\":2,\"componentType\":5125,\"count\":%zu,\"type\":\"SCALAR\"}],"
            "\"bufferViews\":["
                "{\"buffer\":0,\"byteOffset\":0,\"byteLength\":%u,\"target\":34962},"
                "{\"buffer\":0,\"byteOffset\":%u,\"byteLength\":%u,\"target\":34962},"
                "{\"buffer\":0,\"byteOffset\":%u,\"byteLength\":%u,\"target\":34963}],"
            "\"buffers\":[{\"byteLength\":%u}]}",
            vertex_count, xmin, ymin, zmin, xmax, ymax, zmax,
            vertex_count, index_count,
            positions_bytes,
            positions_bytes, colors_bytes,
            positions_bytes + colors_bytes, indices_bytes,
            bin_body_bytes);
        if (json_len < 0 || json_len >= (int)sizeof(json_buf)) {
            ORCAXR_LOGE("nativeWriteColoredGlb: JSON header too large");
            return -3;
        }
        const uint32_t json_pad = (4 - (json_len % 4)) % 4;
        const uint32_t json_chunk_len = json_len + json_pad;
        const uint32_t bin_pad = (4 - (bin_body_bytes % 4)) % 4;
        const uint32_t bin_chunk_len = bin_body_bytes + bin_pad;
        const uint32_t total_len = 12 + 8 + json_chunk_len + 8 + bin_chunk_len;

        std::ofstream os(out.c, std::ios::binary | std::ios::trunc);
        if (!os) {
            ORCAXR_LOGE("nativeWriteColoredGlb: cannot open %s", out.c);
            return -3;
        }
        auto write_u32 = [&](uint32_t v) {
            char b[4] = {
                (char)(v & 0xff),
                (char)((v >> 8) & 0xff),
                (char)((v >> 16) & 0xff),
                (char)((v >> 24) & 0xff)
            };
            os.write(b, 4);
        };

        // Header.
        write_u32(0x46546C67); // 'glTF'
        write_u32(2);
        write_u32(total_len);
        // JSON chunk.
        write_u32(json_chunk_len);
        write_u32(0x4E4F534A); // 'JSON'
        os.write(json_buf, json_len);
        for (uint32_t i = 0; i < json_pad; ++i) os.put(' ');
        // BIN chunk.
        write_u32(bin_chunk_len);
        write_u32(0x004E4942); // 'BIN\0'
        os.write(reinterpret_cast<const char*>(positions.data()), positions_bytes);
        os.write(reinterpret_cast<const char*>(colors.data()), colors_bytes);
        os.write(reinterpret_cast<const char*>(indices.data()), indices_bytes);
        for (uint32_t i = 0; i < bin_pad; ++i) os.put(0);
        os.flush();
        if (!os) {
            ORCAXR_LOGE("nativeWriteColoredGlb: write failed");
            return -3;
        }

        ORCAXR_LOGI("nativeWriteColoredGlb: wrote %s (%zu verts, %zu indices)",
                    out.c, vertex_count, index_count);
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeWriteColoredGlb: exception %s", e.what());
        return -3;
    } catch (...) {
        ORCAXR_LOGE("nativeWriteColoredGlb: unknown exception");
        return -3;
    }
}

// nativeRead3mfFilamentColours — pull the embedded `filament_colour`
// JSON array out of a .3mf and return each entry as a String. Returns
// null if the file isn't readable / isn't a 3MF / has no filament_colour
// field. Returns an empty array if the field exists but is empty.
//
// Used by the Kotlin load pipeline so the project's filament list can
// snap to whatever the 3mf was authored with — same behavior as
// desktop OrcaSlicer + Snapmaker fork.
extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRead3mfFilamentColours(
    JNIEnv* env, jclass,
    jstring jInputPath)
{
    ScopedUtf in(env, jInputPath);
    if (!boost::algorithm::iends_with(in.c, ".3mf")) {
        return nullptr;
    }
    std::vector<std::string> colours;
    if (!extract_3mf_string_array(in.c, "filament_colour", colours) ||
        colours.empty())
    {
        // Preserve historical semantics for filament_colour
        // specifically: an absent or empty array is treated as
        // "no embedded palette, fall back to user-supplied colors."
        // Other callers (flush settings) draw the line differently.
        return nullptr;
    }
    jclass strCls = env->FindClass("java/lang/String");
    if (strCls == nullptr) return nullptr;
    jobjectArray arr = env->NewObjectArray(
        static_cast<jsize>(colours.size()), strCls, nullptr);
    if (arr == nullptr) {
        env->DeleteLocalRef(strCls);
        return nullptr;
    }
    for (size_t i = 0; i < colours.size(); ++i) {
        jstring js = env->NewStringUTF(colours[i].c_str());
        env->SetObjectArrayElement(arr, static_cast<jsize>(i), js);
        env->DeleteLocalRef(js);
    }
    env->DeleteLocalRef(strCls);
    ORCAXR_LOGI("nativeRead3mfFilamentColours: %zu colours from %s",
                colours.size(), in.c);
    return arr;
}

/**
 * Pull `Metadata/project_settings.config` out of a .3mf zip and
 * return the value of a single quoted-string config field as
 * `out`. Used for FullSpectrum's `mixed_filament_definitions`
 * (a single coString carrying the full row catalog) and any
 * other future scalar string config the user wants to round-trip
 * through 3MFs.
 *
 * Same rationale as `extract_3mf_filament_colours` — going through
 * libslic3r's load_bbs_3mf with LoadConfig fails on Android because
 * the project-config extraction path tries to write a temp file
 * under `/orcaslicer_model/<date>/.../Auxiliaries/...` which is on
 * a read-only mount (gotcha #9). Reading the zip via miniz directly
 * sidesteps that machinery.
 *
 * Returns true if the field was found and parsed (out may still be
 * empty for an explicitly-empty string value); false if the file
 * isn't a 3MF, project_settings.config is missing, or the key isn't
 * present.
 */
static bool extract_3mf_string_value(
    const char* zip_path,
    const char* json_key,
    std::string& out)
{
    out.clear();
    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_file(&zip, zip_path, 0)) {
        return false;
    }
    bool ok = false;
    int file_index = mz_zip_reader_locate_file(
        &zip, "Metadata/project_settings.config", nullptr, 0);
    if (file_index >= 0) {
        size_t uncomp_size = 0;
        void* p = mz_zip_reader_extract_to_heap(
            &zip, static_cast<mz_uint>(file_index), &uncomp_size, 0);
        if (p != nullptr && uncomp_size > 0) {
            std::string text(static_cast<const char*>(p), uncomp_size);
            mz_free(p);
            const std::string key = std::string("\"") + json_key + "\"";
            const size_t k = text.find(key);
            if (k != std::string::npos) {
                const size_t colon = text.find(':', k + key.size());
                const size_t q1 = (colon == std::string::npos)
                                    ? std::string::npos
                                    : text.find('"', colon);
                if (q1 != std::string::npos) {
                    // Find the matching closing quote, honoring backslash
                    // escapes. The serialized value uses ',' and ';' as
                    // separators and has no embedded quotes in practice,
                    // but the loop is correct even if it grows them.
                    size_t i = q1 + 1;
                    std::string buf;
                    bool found_close = false;
                    while (i < text.size()) {
                        char ch = text[i];
                        if (ch == '\\' && i + 1 < text.size()) {
                            buf.push_back(text[i + 1]);
                            i += 2;
                            continue;
                        }
                        if (ch == '"') {
                            found_close = true;
                            break;
                        }
                        buf.push_back(ch);
                        ++i;
                    }
                    if (found_close) {
                        out = std::move(buf);
                        ok = true;
                    }
                }
            }
        }
    }
    mz_zip_reader_end(&zip);
    return ok;
}

// nativeRead3mfMixedFilamentDefinitions — pull the embedded
// `mixed_filament_definitions` config string out of a .3mf and return
// it as a Java String. Returns null if the file isn't a 3MF / lacks
// project_settings.config / the key isn't present. The string format
// is the FullSpectrum compact serialization (see
// MixedFilamentManager::serialize_custom_entries) — Kotlin pipes it
// straight through MixedFilamentStore so opening a project .3mf
// authored with mixed-filament rows pre-populates the panel without
// any intermediate parse step.
extern "C" JNIEXPORT jstring JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRead3mfMixedFilamentDefinitions(
    JNIEnv* env, jclass,
    jstring jInputPath)
{
    ScopedUtf in(env, jInputPath);
    if (!boost::algorithm::iends_with(in.c, ".3mf")) {
        return nullptr;
    }
    std::string value;
    if (!extract_3mf_string_value(in.c, "mixed_filament_definitions", value)) {
        return nullptr;
    }
    ORCAXR_LOGI("nativeRead3mfMixedFilamentDefinitions: %zu bytes from %s",
                value.size(), in.c);
    return env->NewStringUTF(value.c_str());
}

// nativeRead3mfFlushSettings — pull project-level wipe-tower / flush
// settings out of a .3mf's `Metadata/project_settings.config` in one
// zip-open round trip. All values are returned as comma-joined CSVs,
// the wire format `set_deserialize_nothrow` accepts on the way back
// in (ConfigOptionFloatsTempl::deserialize splits on `,`, see
// Config.hpp:870; ConfigOptionFloat accepts a single number).
//
// Each key's JSON shape varies by serializer:
//   - vectors with ≥2 entries → JSON array of strings
//     (`"flush_volumes_matrix": ["0", "30", ...]`)
//   - single-entry coFloats    → scalar string
//     (`"flush_multiplier": "0.9"` — FullSpectrum and older
//     OrcaSlicer versions emit it this way; an extractor that only
//     looked for `[...]` would skip past the value and pick up the
//     NEXT array in the file, returning the wrong vector entirely.)
// `extract_3mf_string_array` handles both shapes uniformly.
//
// Envelope shape: String[5] = {
//   [0] flush_volumes_matrix CSV    — coFloats, n_filaments² × nozzle_count.
//                                     Authored 3MFs commonly carry per-pair
//                                     calibrated values (233-800 mm³ range)
//                                     vs libslic3r's 280 mm³ default.
//   [1] flush_multiplier CSV        — coFloats, nozzle_count. Authored
//                                     3MFs commonly use 0.9; libslic3r
//                                     default 0.3.
//   [2] prime_volume CSV            — coFloat scalar mm³ per prime pad.
//                                     Default 45; tuned 3MFs ~38.
//   [3] prime_tower_width CSV       — coFloat mm. Default 35; tuned ~28.
//   [4] prime_tower_brim_width CSV  — coFloat mm. Brim around the tower.
// }
// Any entry may be the empty string when the corresponding key is
// absent in the project config. null return = file isn't a 3MF /
// project_settings.config missing entirely → caller leaves all values
// at profile defaults.
//
// Why combined: each call pays one miniz zip-open + extract. Splitting
// into per-key JNI calls would 5× that cost on every 3MF load.
extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRead3mfFlushSettings(
    JNIEnv* env, jclass,
    jstring jInputPath)
{
    ScopedUtf in(env, jInputPath);
    if (!boost::algorithm::iends_with(in.c, ".3mf")) {
        return nullptr;
    }

    auto join_csv = [](const std::vector<std::string>& tokens) -> std::string {
        std::string out;
        for (size_t i = 0; i < tokens.size(); ++i) {
            if (i > 0) out.push_back(',');
            out += tokens[i];
        }
        return out;
    };

    struct Field { const char* key; std::vector<std::string> vals; };
    Field fields[] = {
        {"flush_volumes_matrix", {}},
        {"flush_multiplier", {}},
        {"prime_volume", {}},
        {"prime_tower_width", {}},
        {"prime_tower_brim_width", {}},
    };
    constexpr size_t kFieldCount = sizeof(fields) / sizeof(fields[0]);
    bool any_found = false;
    for (auto& f : fields) {
        if (extract_3mf_string_array(in.c, f.key, f.vals)) {
            any_found = true;
        }
    }
    if (!any_found) {
        return nullptr;
    }

    jclass strCls = env->FindClass("java/lang/String");
    if (strCls == nullptr) return nullptr;
    jobjectArray arr = env->NewObjectArray(static_cast<jsize>(kFieldCount), strCls, nullptr);
    if (arr == nullptr) {
        env->DeleteLocalRef(strCls);
        return nullptr;
    }
    for (size_t i = 0; i < kFieldCount; ++i) {
        const std::string csv = join_csv(fields[i].vals);
        jstring js = env->NewStringUTF(csv.c_str());
        env->SetObjectArrayElement(arr, static_cast<jsize>(i), js);
        env->DeleteLocalRef(js);
    }
    env->DeleteLocalRef(strCls);
    ORCAXR_LOGI("nativeRead3mfFlushSettings: matrix=%zu mult=%zu prime_vol=%zu tower_w=%zu brim_w=%zu from %s",
                fields[0].vals.size(), fields[1].vals.size(),
                fields[2].vals.size(), fields[3].vals.size(),
                fields[4].vals.size(), in.c);
    return arr;
}

// nativeRead3mfProjectOverrides — generic project_settings.config
// reader. Caller supplies an array of libslic3r config keys; we return
// a parallel String[] of comma-joined CSVs (one entry per input key).
// Empty string ⇒ key absent in the 3MF or value couldn't parse.
//
// Used to honor 3MF-authored process overrides that desktop OrcaSlicer
// puts in `; different_settings_to_system =` (layer_height,
// sparse_infill_density, sparse_infill_pattern, seam_position, etc.).
// Without this, OrcaXR's bundled profile defaults silently override
// the user's per-print tuning — observable as +27 layers / 10% extra
// print time vs the desktop slice on the dragon fixture.
//
// Why a separate endpoint from nativeRead3mfFlushSettings: the flush
// group needs special validation (matrix size, multiplier replication)
// before forwarding to libslic3r — this generic path is pure pass-
// through. Both share extract_3mf_string_array for the actual scan.
//
// Returns:
//   - null  — file is not a .3mf, or project_settings.config is missing.
//   - String[keys.length] — parallel to input. Empty string for any
//     key not authored.
extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRead3mfProjectOverrides(
    JNIEnv* env, jclass,
    jstring jInputPath,
    jobjectArray jKeys)
{
    ScopedUtf in(env, jInputPath);
    if (!boost::algorithm::iends_with(in.c, ".3mf")) {
        return nullptr;
    }
    if (jKeys == nullptr) {
        return nullptr;
    }
    const jsize key_count = env->GetArrayLength(jKeys);
    if (key_count <= 0) {
        return nullptr;
    }

    auto join_csv = [](const std::vector<std::string>& tokens) -> std::string {
        std::string out;
        for (size_t i = 0; i < tokens.size(); ++i) {
            if (i > 0) out.push_back(',');
            out += tokens[i];
        }
        return out;
    };

    jclass strCls = env->FindClass("java/lang/String");
    if (strCls == nullptr) return nullptr;
    jobjectArray arr = env->NewObjectArray(key_count, strCls, nullptr);
    if (arr == nullptr) {
        env->DeleteLocalRef(strCls);
        return nullptr;
    }

    bool any_found = false;
    size_t total_chars = 0;
    for (jsize i = 0; i < key_count; ++i) {
        jstring jKey = static_cast<jstring>(env->GetObjectArrayElement(jKeys, i));
        std::string csv;
        std::vector<std::string> vals;
        // ScopedUtf releases the UTF chars on scope-exit. Per GEMINI.md
        // gotcha #3, the release MUST happen before DeleteLocalRef on
        // the same jstring — releasing chars from a deleted local ref
        // is a JNI abort. Easier to just drop the explicit delete and
        // let the JVM auto-clean local refs at function return; with
        // <50 keys per call we're nowhere near the 512 default local
        // ref table size.
        {
            ScopedUtf key(env, jKey);
            if (extract_3mf_string_array(in.c, key.c, vals)) {
                any_found = true;
                csv = join_csv(vals);
            }
        }
        total_chars += csv.size();
        jstring js = env->NewStringUTF(csv.c_str());
        env->SetObjectArrayElement(arr, i, js);
        env->DeleteLocalRef(js);
    }
    env->DeleteLocalRef(strCls);

    if (!any_found) {
        // Distinguish "no project_settings.config / not a 3MF" from
        // "config exists but none of the requested keys set." The
        // former is the common case for non-tuned-by-desktop sources
        // (Bambu Studio exports without explicit per-print tuning,
        // FDM-from-elsewhere). null lets Kotlin skip the cache.
        return nullptr;
    }
    ORCAXR_LOGI("nativeRead3mfProjectOverrides: %d keys requested, %zu chars total from %s",
                key_count, total_chars, in.c);
    return arr;
}

// nativeConvertToStl — read any libslic3r-supported mesh container
// (STL/3MF/AMF/OBJ/STEP) and emit a single binary STL with all
// objects' volumes merged. Used by the Kotlin preview pipeline so a
// .3mf can be visualized via the same StlReader path as native .stl
// files. Slicing itself doesn't need this — `nativeSlice` reads the
// original container directly.
//
// Returns 0 on success, negative on failure (-1 read, -2 empty model,
// -3 write).
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeConvertToStl(
    JNIEnv* env, jclass,
    jstring jInputPath, jstring jOutStlPath)
{
    ScopedUtf in(env, jInputPath);
    ScopedUtf out(env, jOutStlPath);
    ORCAXR_LOGI("nativeConvertToStl: %s -> %s", in.c, out.c);

    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeConvertToStl: read failed: %s", e.what());
            return -1;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeConvertToStl: model has no objects");
            return -2;
        }

        // Merge every object's mesh into one. Each ModelObject::mesh()
        // already concatenates its own volumes; we then merge across
        // objects so a multi-part 3MF lands as a single STL the
        // preview/transform code can hand-roll without caring about
        // the source's internal structure.
        Slic3r::TriangleMesh merged;
        for (const Slic3r::ModelObject* mo : model.objects) {
            merged.merge(mo->mesh());
        }
        if (merged.empty()) {
            ORCAXR_LOGE("nativeConvertToStl: merged mesh is empty");
            return -2;
        }

        if (!merged.write_binary(out.c)) {
            ORCAXR_LOGE("nativeConvertToStl: write_binary failed");
            return -3;
        }
        ORCAXR_LOGI("nativeConvertToStl: wrote %s (%zu facets)",
                    out.c, merged.facets_count());
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeConvertToStl: exception %s", e.what());
        return -3;
    } catch (...) {
        ORCAXR_LOGE("nativeConvertToStl: unknown exception");
        return -3;
    }
}

// nativeRead3mfObjectMetadata — enumerate objects in a 3MF without merging.
extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRead3mfObjectMetadata(
    JNIEnv* env, jclass, jstring jPath)
{
    ScopedUtf path(env, jPath);
    try {
        Slic3r::Model model = load_mesh_container(path.c);
        if (model.objects.empty()) return nullptr;

        jclass metaClass = env->FindClass("dev/orcaxr/app/SlicerEngine$ObjectMeta");
        if (metaClass == nullptr) return nullptr;
        jmethodID metaCtor = env->GetMethodID(metaClass, "<init>", "(Ljava/lang/String;IFFFII)V");
        if (metaCtor == nullptr) return nullptr;

        jobjectArray result = env->NewObjectArray(model.objects.size(), metaClass, nullptr);

        for (size_t i = 0; i < model.objects.size(); ++i) {
            const Slic3r::ModelObject* mo = model.objects[i];
            
            // mesh() concatenates all volumes for this object.
            Slic3r::TriangleMesh mesh = mo->mesh();
            Slic3r::BoundingBoxf3 bbox = mesh.bounding_box();
            Slic3r::Vec3f size = bbox.size().cast<float>();

            jstring name = env->NewStringUTF(mo->name.c_str());
            
            int extruder = 0;
            // ModelConfig has a non-template option(opt_key) member that
            // hides the inherited template option<TYPE>(...) from
            // ConfigBase. Reach the underlying DynamicPrintConfig via
            // .get() so the templated lookup resolves.
            const Slic3r::ConfigOptionInt* opt = mo->config.get().option<Slic3r::ConfigOptionInt>("extruder");
            if (opt) {
                extruder = opt->value;
            } else if (!mo->volumes.empty()) {
                extruder = mo->volumes.front()->extruder_id();
            }

            jobject meta = env->NewObject(metaClass, metaCtor,
                name,
                (jint)mesh.facets_count(),
                (jfloat)size.x(),
                (jfloat)size.y(),
                (jfloat)size.z(),
                (jint)extruder,
                (jint)mo->instances.size()
            );

            env->SetObjectArrayElement(result, i, meta);
            env->DeleteLocalRef(meta);
            env->DeleteLocalRef(name);
        }

        env->DeleteLocalRef(metaClass);
        return result;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeRead3mfObjectMetadata: %s", e.what());
        return nullptr;
    } catch (...) {
        ORCAXR_LOGE("nativeRead3mfObjectMetadata: unknown exception");
        return nullptr;
    }
}

// nativeExtractObjectAsStl — pull a single object's mesh from a container.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeExtractObjectAsStl(
    JNIEnv* env, jclass, jstring jArchivePath, jint jObjectIndex, jstring jOutStlPath)
{
    ScopedUtf archivePath(env, jArchivePath);
    ScopedUtf outStlPath(env, jOutStlPath);

    try {
        Slic3r::Model model = load_mesh_container(archivePath.c);
        if (jObjectIndex < 0 || (size_t)jObjectIndex >= model.objects.size()) {
            ORCAXR_LOGE("nativeExtractObjectAsStl: oob index %d (size %zu)", jObjectIndex, model.objects.size());
            return -1;
        }

        const Slic3r::ModelObject* mo = model.objects[jObjectIndex];
        Slic3r::TriangleMesh mesh = mo->mesh();
        if (mesh.empty()) {
            ORCAXR_LOGE("nativeExtractObjectAsStl: object %d mesh is empty", jObjectIndex);
            return -2;
        }

        if (!mesh.write_binary(outStlPath.c)) {
            ORCAXR_LOGE("nativeExtractObjectAsStl: write_binary failed for %s", outStlPath.c);
            return -3;
        }
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeExtractObjectAsStl: exception %s", e.what());
        return -4;
    } catch (...) {
        ORCAXR_LOGE("nativeExtractObjectAsStl: unknown exception");
        return -4;
    }
}

// nativeArrange — Phase XR_OBJ_7. Pack N input meshes onto a
// rectangular bed using libslic3r's `arrange()` algorithm. Replaces
// the naive left-to-right row-layout in `PlacedModel.autoArrangeModels`
// — that helper is kept as a fallback when the JNI returns null.
//
// Inputs:
//   jInputPaths — String[] of mesh-container paths, parallel to the
//     transforms tuple.
//   jPriorTransforms — float[N*9] of (txMm, tyMm, rotZdeg, sxPct, syPct,
//     szPct, mirrorX, mirrorY, mirrorZ). The priors pre-position
//     each model so already-placed models pin and the algorithm
//     packs incoming additions around them. Mirror sign-bits feed
//     into the per-axis scale.
//   jBedWmm / jBedHmm — bed dimensions in mm. Rectangular bed centered
//     on (0, 0) in arrange coordinate space.
//   jGapMm — minimum inter-object gap in mm.
//
// Returns float[N*3] = (txMm, tyMm, rotZdeg) per input on success;
// null on any failure (read fail / empty model / arrange threw).
//
// Threading: Arrange.cpp has no `tbb::parallel_for` calls, so this
// runs serial regardless of patch 0014's TBB serial shim coverage.
extern "C" JNIEXPORT jfloatArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeArrange(
    JNIEnv* env, jclass,
    jobjectArray jInputPaths,
    jfloatArray  jPriorTransforms,
    jfloat       jBedWmm,
    jfloat       jBedHmm,
    jfloat       jGapMm)
{
    const jsize n_inputs = jInputPaths != nullptr ? env->GetArrayLength(jInputPaths) : 0;
    ORCAXR_LOGI("nativeArrange: %d inputs bed=%.1f×%.1f mm gap=%.1f mm",
                n_inputs, jBedWmm, jBedHmm, jGapMm);
    if (n_inputs == 0) {
        ORCAXR_LOGE("nativeArrange: no inputs");
        return nullptr;
    }
    if (jPriorTransforms == nullptr || env->GetArrayLength(jPriorTransforms) < n_inputs * 9) {
        ORCAXR_LOGE("nativeArrange: priors array too short (need %d floats)", n_inputs * 9);
        return nullptr;
    }
    jfloat* tv = env->GetFloatArrayElements(jPriorTransforms, nullptr);
    std::vector<float> priors(tv, tv + (n_inputs * 9));
    env->ReleaseFloatArrayElements(jPriorTransforms, tv, JNI_ABORT);

    try {
        Slic3r::Model model;
        for (jsize i = 0; i < n_inputs; ++i) {
            jstring jp = (jstring) env->GetObjectArrayElement(jInputPaths, i);
            if (jp == nullptr) {
                ORCAXR_LOGE("nativeArrange: null path at index %d", i);
                return nullptr;
            }
            // Inner scope so ScopedUtf releases UTF chars BEFORE we
            // DeleteLocalRef(jp) — gotcha #3. Inverting that order
            // throws "JNI ERROR (app bug): jstring is an invalid local
            // reference (popped reference at index N in a table of
            // size 0)".
            bool ok = true;
            {
                ScopedUtf p(env, jp);
                Slic3r::Model src;
                try {
                    src = load_mesh_container(p.c);
                } catch (const std::exception& e) {
                    ORCAXR_LOGE("nativeArrange: read failed for %s: %s", p.c, e.what());
                    ok = false;
                }
                if (ok && src.objects.empty()) {
                    ORCAXR_LOGE("nativeArrange: empty model from %s", p.c);
                    ok = false;
                }
                if (ok) {
                    Slic3r::TriangleMesh mesh = src.objects.front()->mesh();
                    std::string name = std::string("model_") + std::to_string(i);
                    Slic3r::ModelObject* mo = model.add_object(name.c_str(), p.c, std::move(mesh));
                    mo->add_instance();
                    // Apply prior transforms (translate / Z-rotate /
                    // per-axis scale × mirror sign). X/Y rotation is
                    // intentionally dropped here — get_arrange_polygon
                    // zeroes Z then takes the rotated convex hull,
                    // and X/Y rotations would tilt the silhouette
                    // off-bed in the polygon math.
                    Slic3r::ModelInstance* inst = mo->instances.front();
                    const float tx     = priors[i * 9 + 0];
                    const float ty     = priors[i * 9 + 1];
                    const float rzDeg  = priors[i * 9 + 2];
                    const float sx     = (priors[i * 9 + 3] / 100.0f) * priors[i * 9 + 6];
                    const float sy     = (priors[i * 9 + 4] / 100.0f) * priors[i * 9 + 7];
                    const float sz     = (priors[i * 9 + 5] / 100.0f) * priors[i * 9 + 8];
                    inst->set_offset(Slic3r::Vec3d(tx, ty, 0.0));
                    inst->set_rotation(Slic3r::Vec3d(0.0, 0.0, rzDeg * M_PI / 180.0));
                    inst->set_scaling_factor(Slic3r::Vec3d(sx, sy, sz));
                }
            }
            env->DeleteLocalRef(jp);
            if (!ok) return nullptr;
        }

        // Build ArrangePolygons from each ModelObject's instance.
        // get_arrange_polygon takes a void* to avoid the
        // arrangement::ArrangePolygon type leaking into Model.hpp;
        // pass &ap of the right type.
        Slic3r::DynamicPrintConfig cfg;
        std::vector<Slic3r::arrangement::ArrangePolygon> items(n_inputs);
        const coord_t inflation = Slic3r::scaled<coord_t>(jGapMm / 2.0f);
        for (size_t i = 0; i < (size_t)n_inputs; ++i) {
            Slic3r::ModelObject* mo = model.objects[i];
            mo->instances.front()->get_arrange_polygon(&items[i], cfg);
            // Don't reset translation/rotation — they reflect the
            // user's prior offsets via set_offset/set_rotation above
            // (which get_arrange_polygon read into the ArrangePolygon).
            // libnest2d uses these as initial positions; resetting
            // them all to (0, 0) makes the input degenerate (every
            // item starts at the same spot) and the placer bails out.
            items[i].itemid = (int)i;
            // libslic3r's `_arrange` resets `min_obj_distance` to 0
            // because it expects items to be PRE-INFLATED by half
            // the gap on each side. Without setting inflation per
            // polygon, the placement returns bed_idx = UNARRANGED
            // for everything (libnest2d treats zero-inflation items
            // with an internal min_obj_distance of 0 as "no fit"
            // when they're packed at origin).
            items[i].inflation = inflation;
            // BBS arrange's libnest2d port treats items with
            // bed_temp == print_temp == 0 as "no temperature
            // assigned, place anywhere". The compatibility check
            // (Print::is_filaments_compatible) is consulted via
            // filament_temp_type, but only when filament_temp_type
            // != -1 on at least one item. Force a sane default:
            // first_bed_temp / print_temp / vitrify_temp at typical
            // PLA values so items go through the "all compatible"
            // fast path.
            items[i].first_bed_temp = 60;
            items[i].bed_temp = 60;
            items[i].print_temp = 200;
            items[i].vitrify_temp = 240;
            const auto& bb = items[i].poly.contour.bounding_box();
            ORCAXR_LOGI("nativeArrange: poly[%zu] %zu points bbox=(%.1f..%.1f, %.1f..%.1f) mm extrude_ids=%zu inflation=%ld",
                        i, items[i].poly.contour.size(),
                        Slic3r::unscale<double>(bb.min.x()), Slic3r::unscale<double>(bb.max.x()),
                        Slic3r::unscale<double>(bb.min.y()), Slic3r::unscale<double>(bb.max.y()),
                        items[i].extrude_ids.size(), inflation);
        }

        // Rectangular bed described as 4 corner points (Points).
        // Both the Points-template (via call_with_bed → Box dispatch)
        // and direct BoundingBox-template paths produce bed_idx=-1
        // for every input on OrcaXR — see investigation summary in
        // gotcha #61. The bedpts here are kept as-is so the Points
        // we pass into BoundingBox(bedpts) below is a valid 4-corner
        // rectangle.
        Slic3r::Points bedpts;
        bedpts.emplace_back(Slic3r::scaled<coord_t>(-jBedWmm / 2.0), Slic3r::scaled<coord_t>(-jBedHmm / 2.0));
        bedpts.emplace_back(Slic3r::scaled<coord_t>( jBedWmm / 2.0), Slic3r::scaled<coord_t>(-jBedHmm / 2.0));
        bedpts.emplace_back(Slic3r::scaled<coord_t>( jBedWmm / 2.0), Slic3r::scaled<coord_t>( jBedHmm / 2.0));
        bedpts.emplace_back(Slic3r::scaled<coord_t>(-jBedWmm / 2.0), Slic3r::scaled<coord_t>( jBedHmm / 2.0));

        // Bed bbox in scaled coords for diagnostics. process_arrangeable
        // forces CW; libnest2d's nfpInnerRectBed bails out (returns
        // empty NFP) when item swidth > bedW or sheight > bedH. With
        // BoundingBox(bedpts), bedW = scaled(jBedWmm), bedH = scaled(jBedHmm).
        Slic3r::BoundingBox bedbb_diag(bedpts);
        ORCAXR_LOGI("nativeArrange: bed bbox scaled (%lld..%lld, %lld..%lld) → %.1f×%.1f mm",
                    (long long)bedbb_diag.min.x(), (long long)bedbb_diag.max.x(),
                    (long long)bedbb_diag.min.y(), (long long)bedbb_diag.max.y(),
                    Slic3r::unscale<double>(bedbb_diag.size().x()),
                    Slic3r::unscale<double>(bedbb_diag.size().y()));

        Slic3r::arrangement::ArrangeParams params;
        params.min_obj_distance = Slic3r::scaled<coord_t>(jGapMm);
        params.parallel = false;
        params.allow_rotations = false;
        params.do_final_align = false;
        params.allow_multi_materials_on_same_plate = true;
        params.printable_height = 256.0f;
        // No-op progress / stop callbacks so libnest2d's progressIndicator
        // path doesn't try to invoke a null function pointer when an item
        // is packed (line 783 in Arrange.cpp's AutoArranger ctor).
        // params.on_packed fires per successful placement — log so we
        // can tell if libnest2d is rejecting at remove_unpackable_items
        // (no on_packed at all) vs failing somewhere later (some on_packed
        // before the rejection).
        int packed_count = 0;
        params.progressind = [&packed_count](unsigned n, std::string name) {
            ORCAXR_LOGI("nativeArrange: progressind n=%u name=%s", n, name.c_str());
        };
        params.on_packed = [&packed_count](const Slic3r::arrangement::ArrangePolygon& ap) {
            packed_count++;
            ORCAXR_LOGI("nativeArrange: on_packed bed_idx=%d t=(%.1f,%.1f)",
                        ap.bed_idx,
                        Slic3r::unscale<double>(ap.translation.x()),
                        Slic3r::unscale<double>(ap.translation.y()));
        };
        params.stopcondition = []() { return false; };

        // Try the BoundingBox overload directly. Bypasses call_with_bed's
        // rectangle-detection dispatch — if Points fails but BoundingBox
        // works, the bug is in the dispatch (1.0 - parea/area_bb < 1e-3
        // or the to_circle test). If both fail the bug is deeper.
        Slic3r::BoundingBox bedbb(bedpts);
        try {
            Slic3r::arrangement::arrange(items, {}, bedbb, params);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeArrange: arrange() threw: %s", e.what());
            return nullptr;
        } catch (...) {
            ORCAXR_LOGE("nativeArrange: arrange() unknown exception");
            return nullptr;
        }
        ORCAXR_LOGI("nativeArrange: post-arrange packed_count=%d", packed_count);
        // Post-arrange: dump each item's bed_idx — distinguishes
        // BIN_ID_UNFIT (-1, marked by remove_unpackable_items) from
        // never-attempted (also -1, but distinguishable via the count
        // of progressind callbacks).
        for (size_t i = 0; i < (size_t)n_inputs; ++i) {
            ORCAXR_LOGI("nativeArrange: post item[%zu] bed_idx=%d translation_scaled=(%lld,%lld)",
                        i, items[i].bed_idx,
                        (long long)items[i].translation.x(),
                        (long long)items[i].translation.y());
        }

        // Read back results: each ArrangePolygon's `translation` is in
        // SCALED coords, `rotation` in radians. Convert to mm and
        // degrees. If ANY item came back UNARRANGED (bed_idx = -1),
        // signal "couldn't pack" by returning null so the Kotlin
        // caller falls back to its naive row-layout helper. This
        // preserves user-visible Arrange behavior while we figure
        // out the libnest2d setup bug that's currently rejecting
        // every input — symptom is bed_idx = -1 across the board
        // even for trivially-fitting cubes on a huge bed.
        std::vector<jfloat> out(n_inputs * 3);
        constexpr double rad_to_deg = 180.0 / M_PI;
        bool all_arranged = true;
        for (size_t i = 0; i < (size_t)n_inputs; ++i) {
            const auto& ap = items[i];
            out[i * 3 + 0] = (jfloat)Slic3r::unscale<double>(ap.translation.x());
            out[i * 3 + 1] = (jfloat)Slic3r::unscale<double>(ap.translation.y());
            out[i * 3 + 2] = (jfloat)(ap.rotation * rad_to_deg);
            ORCAXR_LOGI("nativeArrange: model[%zu] bed_idx=%d t=(%.1f,%.1f) rotZ=%.1f°",
                        i, ap.bed_idx, out[i*3+0], out[i*3+1], out[i*3+2]);
            if (ap.bed_idx < 0) all_arranged = false;
        }
        if (!all_arranged) {
            ORCAXR_LOGE("nativeArrange: at least one item bed_idx=-1, returning null for fallback");
            return nullptr;
        }
        jfloatArray jOut = env->NewFloatArray(n_inputs * 3);
        if (jOut == nullptr) return nullptr;
        env->SetFloatArrayRegion(jOut, 0, n_inputs * 3, out.data());
        return jOut;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeArrange: outer exception %s", e.what());
        return nullptr;
    } catch (...) {
        ORCAXR_LOGE("nativeArrange: outer unknown exception");
        return nullptr;
    }
}

// nativeAutoOrient — Phase XR_OBJ_3. Read the input mesh, hand it to
// libslic3r's `orientation::orient(ModelObject*)` (Orient.cpp:517),
// and return the resulting instance Euler angles as a float[3] in
// degrees (XYZ order, matching `PlacedModel.rotXDeg/rotYDeg/rotZDeg`).
//
// Single-object orient runs serial inside libslic3r — `_orient`'s
// `tbb::parallel_for` only fires when meshs_.size() >= 2 (Orient.cpp
// :492), and `orient(ModelObject*)` constructs an `AutoOrienter`
// directly rather than going through `_orient`. So this entry point
// is safe on Android arm64 without the patch-0014 TBB serial shim
// being extended to cover Orient.cpp.
//
// Returns null jfloatArray on any error (read fail / empty model /
// orient threw / no instances). The Kotlin side falls back to
// "no rotation change" on null — better than crashing.
extern "C" JNIEXPORT jfloatArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeAutoOrient(
    JNIEnv* env, jclass,
    jstring jInputPath)
{
    ScopedUtf in(env, jInputPath);
    ORCAXR_LOGI("nativeAutoOrient: %s", in.c);
    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeAutoOrient: read failed: %s", e.what());
            return nullptr;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeAutoOrient: empty model");
            return nullptr;
        }
        Slic3r::ModelObject* mo = model.objects.front();
        if (mo->instances.empty()) {
            mo->add_instance();
        }
        try {
            Slic3r::orientation::orient(mo);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeAutoOrient: orient threw: %s", e.what());
            return nullptr;
        } catch (...) {
            ORCAXR_LOGE("nativeAutoOrient: orient unknown exception");
            return nullptr;
        }
        // libslic3r stores instance rotation as Vec3d Euler angles
        // (radians). orient() mutates the instance via obj->rotate(),
        // which decomposes to Euler internally.
        const Slic3r::Vec3d rot = mo->instances.front()->get_rotation();
        constexpr double rad_to_deg = 180.0 / 3.14159265358979323846;
        jfloat out[3] = {
            (jfloat)(rot.x() * rad_to_deg),
            (jfloat)(rot.y() * rad_to_deg),
            (jfloat)(rot.z() * rad_to_deg),
        };
        ORCAXR_LOGI("nativeAutoOrient: rotation = (%.2f, %.2f, %.2f)°",
                    out[0], out[1], out[2]);
        jfloatArray jOut = env->NewFloatArray(3);
        if (jOut == nullptr) return nullptr;
        env->SetFloatArrayRegion(jOut, 0, 3, out);
        return jOut;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeAutoOrient: outer exception %s", e.what());
        return nullptr;
    } catch (...) {
        ORCAXR_LOGE("nativeAutoOrient: outer unknown exception");
        return nullptr;
    }
}

// nativeCutObject — Phase XR_OBJ_5. Wrap libslic3r's
// `Cut::perform_with_plane()` (CutUtils.hpp:58). Cuts the input mesh
// along a horizontal plane at [planeZmm], optionally flipping /
// placing-on-cut-face / keeping-only-one-half via [attrMask], and
// writes the resulting ModelObject(s) as a multi-object 3MF at
// [outputPath]. Caller can then load the 3MF via the existing
// `nativeSlice` / `LOAD_3MF` paths to get N PlacedModels (one per
// cut piece).
//
// [attrMask] bits (matches the Kotlin-side enum bitmask):
//   0x01  KeepUpper
//   0x02  KeepLower
//   0x04  FlipUpper
//   0x08  FlipLower
//   0x10  PlaceOnCutUpper
//   0x20  PlaceOnCutLower
// Must specify at least one of KeepUpper / KeepLower; otherwise
// `perform_with_plane` returns an empty result and the JNI returns
// -2.
//
// Returns 0 on success, -1 on read fail, -2 on cut produced empty
// result, -3 on store_3mf fail, -4 on unknown C++ exception.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeCutObject(
    JNIEnv* env, jclass,
    jstring jInputPath,
    jstring jOutputPath,
    jfloat  jPlaneZmm,
    jint    jAttrMask)
{
    ScopedUtf in(env, jInputPath);
    ScopedUtf out(env, jOutputPath);
    ORCAXR_LOGI("nativeCutObject: %s -> %s plane_z=%.2f mm attrs=0x%x",
                in.c, out.c, jPlaneZmm, jAttrMask);
    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeCutObject: read failed: %s", e.what());
            return -1;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeCutObject: empty model");
            return -1;
        }
        Slic3r::ModelObject* mo = model.objects.front();
        if (mo->instances.empty()) mo->add_instance();
        // ensure_on_bed so the picked plane Z is bed-relative.
        mo->ensure_on_bed();

        // Cut matrix: identity rotation, translation by Z. The +Z
        // axis of the matrix's basis is the cut plane normal; the
        // origin is on the plane. Future XR_OBJ_5 polish: accept a
        // full Transform3d so the user can cut along X / Y axes too.
        Slic3r::Transform3d cut_matrix = Slic3r::Transform3d::Identity();
        cut_matrix.translation() = Slic3r::Vec3d(0.0, 0.0, double(jPlaneZmm));

        // libslic3r's `enum_bitmask::operator|=` has a buggy upstream
        // impl (Model_objectCutAttribute = int RHS won't compile);
        // we use `|` exclusively, which returns the right type and
        // is verified instantiated in upstream code paths.
        // ModelObjectCutAttributes is constructible from a single
        // option_type, so seed with KeepUpper/KeepLower (always at
        // least one of those is needed, gated below).
        Slic3r::ModelObjectCutAttributes attrs =
            (jAttrMask & 0x01) ? Slic3r::ModelObjectCutAttributes(Slic3r::ModelObjectCutAttribute::KeepUpper)
                               : Slic3r::ModelObjectCutAttributes(Slic3r::ModelObjectCutAttribute::KeepLower);
        if ((jAttrMask & 0x01) && (jAttrMask & 0x02))
            attrs = attrs | Slic3r::ModelObjectCutAttribute::KeepLower;
        if (jAttrMask & 0x04) attrs = attrs | Slic3r::ModelObjectCutAttribute::FlipUpper;
        if (jAttrMask & 0x08) attrs = attrs | Slic3r::ModelObjectCutAttribute::FlipLower;
        if (jAttrMask & 0x10) attrs = attrs | Slic3r::ModelObjectCutAttribute::PlaceOnCutUpper;
        if (jAttrMask & 0x20) attrs = attrs | Slic3r::ModelObjectCutAttribute::PlaceOnCutLower;
        // KeepAsParts: post-process the result into separate
        // ModelObjects rather than a single multi-volume ModelObject.
        // OrcaXR pattern is "user picks each as its own PlacedModel
        // afterward".
        attrs = attrs | Slic3r::ModelObjectCutAttribute::KeepAsParts;

        Slic3r::Cut cut(mo, /*instance=*/0, cut_matrix, attrs);
        Slic3r::ModelObjectPtrs result;
        try {
            // perform_with_plane returns a const-ref into the Cut's
            // internal m_model. Copy the pointers — the Cut destructor
            // calls m_model.clear_objects() so we can't keep the refs
            // around past `cut`'s scope.
            result = cut.perform_with_plane();
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeCutObject: perform_with_plane threw: %s", e.what());
            return -2;
        }
        if (result.empty()) {
            ORCAXR_LOGE("nativeCutObject: perform_with_plane returned empty");
            return -2;
        }
        ORCAXR_LOGI("nativeCutObject: %zu pieces produced", result.size());

        // Build the output Model. add_object(*src) deep-clones each
        // ModelObject (via assign_copy — same path Phase 4's
        // multi-volume preservation uses), so volumes / facets /
        // configs all survive.
        Slic3r::Model outModel;
        for (const Slic3r::ModelObject* src : result) {
            outModel.add_object(*src);
        }
        if (!Slic3r::store_3mf(out.c, &outModel, /*config=*/nullptr,
                               /*fullpath_sources=*/false)) {
            ORCAXR_LOGE("nativeCutObject: store_3mf failed");
            return -3;
        }
        ORCAXR_LOGI("nativeCutObject: wrote %s with %zu objects",
                    out.c, outModel.objects.size());
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeCutObject: exception %s", e.what());
        return -4;
    } catch (...) {
        ORCAXR_LOGE("nativeCutObject: unknown exception");
        return -4;
    }
}

// nativeMeshBoolean — Phase XR_OBJ_6. Wrap libslic3r's
// `MeshBoolean::mcut::make_boolean` to combine two meshes into one
// via a boolean op. Output is a single-object 3MF whose lone volume
// is the result.
//
// [op]: 0=Union (A∪B), 1=Difference (A\B), 2=Intersection (A∩B).
// Maps to upstream's string-based opt: "UNION" / "A_NOT_B" /
// "INTERSECTION" (per GLGizmoMeshBoolean.cpp:347/365/383).
//
// Returns 0 on success, -1 on read fail, -2 on empty boolean result
// (operands disjoint for Intersection / fully covered for
// Difference), -3 on store_3mf fail, -4 on unknown C++ exception.
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeMeshBoolean(
    JNIEnv* env, jclass,
    jstring jPathA,
    jstring jPathB,
    jint    jOp,
    jstring jOutputPath)
{
    ScopedUtf a(env, jPathA);
    ScopedUtf b(env, jPathB);
    ScopedUtf out(env, jOutputPath);
    const char* op_str =
        (jOp == 0) ? "UNION" :
        (jOp == 1) ? "A_NOT_B" :
        (jOp == 2) ? "INTERSECTION" : "UNION";
    ORCAXR_LOGI("nativeMeshBoolean: A=%s B=%s op=%s -> %s",
                a.c, b.c, op_str, out.c);
    try {
        Slic3r::Model modelA, modelB;
        try {
            modelA = load_mesh_container(a.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeMeshBoolean: A read failed: %s", e.what());
            return -1;
        }
        try {
            modelB = load_mesh_container(b.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeMeshBoolean: B read failed: %s", e.what());
            return -1;
        }
        if (modelA.objects.empty() || modelB.objects.empty()) {
            ORCAXR_LOGE("nativeMeshBoolean: empty model");
            return -1;
        }
        Slic3r::TriangleMesh meshA = modelA.objects.front()->mesh();
        Slic3r::TriangleMesh meshB = modelB.objects.front()->mesh();
        // Apply the source instances' poses to the meshes so the
        // boolean operates on world-space geometry. Without this,
        // two cubes loaded from the same STL coincide and Difference
        // returns empty.
        if (!modelA.objects.front()->instances.empty()) {
            meshA.transform(modelA.objects.front()->instances.front()->get_matrix());
        }
        if (!modelB.objects.front()->instances.empty()) {
            meshB.transform(modelB.objects.front()->instances.front()->get_matrix());
        }

        std::vector<Slic3r::TriangleMesh> result_meshes;
        try {
            Slic3r::MeshBoolean::mcut::make_boolean(meshA, meshB, result_meshes, op_str);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeMeshBoolean: make_boolean threw: %s", e.what());
            return -2;
        }
        if (result_meshes.empty()) {
            ORCAXR_LOGE("nativeMeshBoolean: result is empty");
            return -2;
        }
        // Merge result pieces into a single TriangleMesh. mcut may
        // return multiple disconnected components (e.g. Difference
        // that splits A into two parts); we treat all of them as a
        // single output for now. Future polish: emit as separate
        // PlacedModels.
        Slic3r::TriangleMesh merged = result_meshes.front();
        for (size_t i = 1; i < result_meshes.size(); ++i) {
            merged.merge(result_meshes[i]);
        }
        if (merged.empty()) {
            ORCAXR_LOGE("nativeMeshBoolean: merged result is empty");
            return -2;
        }
        ORCAXR_LOGI("nativeMeshBoolean: %zu pieces, %zu facets total",
                    result_meshes.size(), merged.facets_count());

        Slic3r::Model outModel;
        const std::string name = std::string("boolean_") + op_str;
        Slic3r::ModelObject* mo = outModel.add_object(
            name.c_str(), out.c, std::move(merged));
        mo->add_instance();
        if (!Slic3r::store_3mf(out.c, &outModel, /*config=*/nullptr,
                               /*fullpath_sources=*/false)) {
            ORCAXR_LOGE("nativeMeshBoolean: store_3mf failed");
            return -3;
        }
        ORCAXR_LOGI("nativeMeshBoolean: wrote %s", out.c);
        return 0;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeMeshBoolean: exception %s", e.what());
        return -4;
    } catch (...) {
        ORCAXR_LOGE("nativeMeshBoolean: unknown exception");
        return -4;
    }
}

// nativeSplitObject — Phase XR_OBJ_6. Wrap `ModelObject::split`
// (Model.cpp:1822 — splits a multi-component mesh into one
// ModelObject per disconnected component). Each output object is
// written as a separate 3MF in [outDir]; the caller plates them
// individually as PlacedModels.
//
// Returns Array<String> of output 3MF paths on success; null on
// failure. An array of length 1 means the input was already a
// single component (split is a no-op semantically — we still write
// the output 3MF so the caller has a uniform contract).
extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeSplitObject(
    JNIEnv* env, jclass,
    jstring jInputPath,
    jstring jOutDir)
{
    ScopedUtf in(env, jInputPath);
    ScopedUtf dir(env, jOutDir);
    ORCAXR_LOGI("nativeSplitObject: %s -> %s", in.c, dir.c);
    try {
        Slic3r::Model model;
        try {
            model = load_mesh_container(in.c);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeSplitObject: read failed: %s", e.what());
            return nullptr;
        }
        if (model.objects.empty()) {
            ORCAXR_LOGE("nativeSplitObject: empty model");
            return nullptr;
        }
        Slic3r::ModelObject* mo = model.objects.front();
        if (mo->instances.empty()) mo->add_instance();

        Slic3r::ModelObjectPtrs new_objects;
        try {
            mo->split(&new_objects);
        } catch (const std::exception& e) {
            ORCAXR_LOGE("nativeSplitObject: split threw: %s", e.what());
            return nullptr;
        }
        if (new_objects.empty()) {
            // Single-component input — synthesize a single output
            // entry pointing at the original mesh so the caller can
            // treat split as idempotent.
            new_objects.push_back(mo);
        }
        ORCAXR_LOGI("nativeSplitObject: %zu output objects", new_objects.size());

        // Build N output 3MFs.
        std::vector<std::string> out_paths;
        out_paths.reserve(new_objects.size());
        for (size_t i = 0; i < new_objects.size(); ++i) {
            Slic3r::ModelObject* obj = new_objects[i];
            std::string out_path = std::string(dir.c) + "/split_" + std::to_string(i) + ".3mf";
            Slic3r::Model outModel;
            outModel.add_object(*obj);
            if (!Slic3r::store_3mf(out_path.c_str(), &outModel,
                                   /*config=*/nullptr,
                                   /*fullpath_sources=*/false)) {
                ORCAXR_LOGE("nativeSplitObject: store_3mf failed for %s", out_path.c_str());
                return nullptr;
            }
            out_paths.push_back(out_path);
            ORCAXR_LOGI("nativeSplitObject: wrote %s", out_path.c_str());
        }

        jclass strCls = env->FindClass("java/lang/String");
        jobjectArray jOut = env->NewObjectArray(jsize(out_paths.size()), strCls, nullptr);
        for (size_t i = 0; i < out_paths.size(); ++i) {
            jstring jp = env->NewStringUTF(out_paths[i].c_str());
            env->SetObjectArrayElement(jOut, jsize(i), jp);
            env->DeleteLocalRef(jp);
        }
        env->DeleteLocalRef(strCls);
        return jOut;
    } catch (const std::exception& e) {
        ORCAXR_LOGE("nativeSplitObject: exception %s", e.what());
        return nullptr;
    } catch (...) {
        ORCAXR_LOGE("nativeSplitObject: unknown exception");
        return nullptr;
    }
}
