// thumbnail_render.cpp — see header for design notes.
//
// Implementation: per-triangle rasterization with a float Z-buffer in
// view space, single directional light + ambient, fixed isometric
// camera at (+1, -1, +0.7) looking at the model AABB centroid.
//
// Z-buffer is conventional max-keep (camera looks down -view_z, so a
// LARGER view-z means closer to camera). Edge-function fill (Pineda
// 1988) with no backface culling — some printable meshes have mixed
// triangle winding and culling them removes half the silhouette.

#include "thumbnail_render.hpp"

#include <libslic3r/Model.hpp>
#include <libslic3r/TriangleMesh.hpp>
#include <libslic3r/GCode/ThumbnailData.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace orcaxr {

namespace {

struct V3 {
    float x, y, z;
};
inline V3    operator-(V3 a, V3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3    cross(V3 a, V3 b)
{
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}
inline V3 normalize(V3 a)
{
    float L = std::sqrt(dot(a, a));
    return L > 0.f ? V3{ a.x / L, a.y / L, a.z / L } : V3{ 0, 0, 0 };
}

inline int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    return -1;
}

bool parse_hex_color(const std::string& s, uint8_t& r, uint8_t& g, uint8_t& b)
{
    const char* p   = s.c_str();
    if (*p == '#') ++p;
    if (std::strlen(p) < 6) return false;
    int n[6];
    for (int i = 0; i < 6; ++i) {
        n[i] = hex_nibble(p[i]);
        if (n[i] < 0) return false;
    }
    r = static_cast<uint8_t>((n[0] << 4) | n[1]);
    g = static_cast<uint8_t>((n[2] << 4) | n[3]);
    b = static_cast<uint8_t>((n[4] << 4) | n[5]);
    return true;
}

// Pineda edge function: positive when (cx, cy) is on the left of edge a→b.
inline float edge_fn(float ax, float ay, float bx, float by, float cx, float cy)
{
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

struct Tri {
    V3      v[3];
    uint8_t color[3];
};

} // namespace

void render_isometric_thumbnail(const Slic3r::Model&            model,
                                unsigned int                    width,
                                unsigned int                    height,
                                const std::vector<std::string>& filament_colors,
                                bool                            transparent_bg,
                                Slic3r::ThumbnailData&          out)
{
    out.set(width, height);
    if (width == 0 || height == 0) return;

    // Background fill (near-white, light gray).
    const uint8_t bg_r = 242, bg_g = 242, bg_b = 242;
    const uint8_t bg_a = transparent_bg ? 0 : 255;
    for (unsigned int i = 0; i < width * height; ++i) {
        out.pixels[4 * i + 0] = bg_r;
        out.pixels[4 * i + 1] = bg_g;
        out.pixels[4 * i + 2] = bg_b;
        out.pixels[4 * i + 3] = bg_a;
    }

    auto get_color_for = [&](int extruder_id) -> std::array<uint8_t, 3> {
        std::array<uint8_t, 3> col = { 180, 180, 180 };
        if (extruder_id < 1) extruder_id = 1;
        size_t idx = static_cast<size_t>(extruder_id - 1);
        if (idx < filament_colors.size()) {
            uint8_t r = 180, g = 180, b = 180;
            if (parse_hex_color(filament_colors[idx], r, g, b)) col = { r, g, b };
        }
        return col;
    };

    // Collect all printable triangles in world space.
    std::vector<Tri> tris;
    tris.reserve(2048);

    for (const Slic3r::ModelObject* mo : model.objects) {
        if (mo == nullptr) continue;
        // Object-level extruder id (used as fallback when a volume
        // doesn't declare its own). ModelConfig::extruder() returns
        // a plain int; .has() guards against an absent key (returns 0).
        int obj_extruder = mo->config.has("extruder") ? mo->config.extruder() : 1;
        for (const Slic3r::ModelInstance* inst : mo->instances) {
            if (inst == nullptr) continue;
            if (!inst->printable) continue;
            const Slic3r::Transform3d Mi = inst->get_matrix();
            for (const Slic3r::ModelVolume* mv : mo->volumes) {
                if (mv == nullptr) continue;
                if (!mv->is_model_part()) continue; // skip support enforcers/blockers/modifiers
                Slic3r::Transform3d MV = Mi * mv->get_matrix();
                int                 extruder = mv->extruder_id();
                if (extruder < 1) extruder = obj_extruder;
                auto                col      = get_color_for(extruder);
                const auto&         its      = mv->mesh().its;
                for (const stl_triangle_vertex_indices& tri : its.indices) {
                    Tri T;
                    for (int k = 0; k < 3; ++k) {
                        Slic3r::Vec3f   vf = its.vertices[tri[k]];
                        Eigen::Vector3d p  = MV * vf.cast<double>();
                        T.v[k]             = { static_cast<float>(p.x()),
                                               static_cast<float>(p.y()),
                                               static_cast<float>(p.z()) };
                    }
                    T.color[0] = col[0];
                    T.color[1] = col[1];
                    T.color[2] = col[2];
                    tris.push_back(T);
                }
            }
        }
    }

    if (tris.empty()) return;

    // View basis. Camera placed in the +X, -Y, +Z octant (viewer's
    // upper-front-right) looking at the AABB centroid; +Z is up. This
    // matches the angle desktop OrcaSlicer uses for its plate preview.
    const V3 view_z   = normalize(V3{ +1.0f, -1.0f, +0.7f });
    const V3 world_up = { 0.f, 0.f, 1.f };
    const V3 view_x   = normalize(cross(world_up, view_z));
    const V3 view_y   = normalize(cross(view_z, view_x));

    // Light: a soft front-top-left key light. Diffuse only.
    const V3 light_dir = normalize(V3{ -0.4f, +0.6f, +1.0f });

    // Project all triangle vertices to view space.
    std::vector<std::array<V3, 3>> proj(tris.size());
    float min_x = std::numeric_limits<float>::infinity();
    float min_y = std::numeric_limits<float>::infinity();
    float max_x = -std::numeric_limits<float>::infinity();
    float max_y = -std::numeric_limits<float>::infinity();
    for (size_t i = 0; i < tris.size(); ++i) {
        for (int k = 0; k < 3; ++k) {
            const V3 p = tris[i].v[k];
            const V3 vs{ dot(p, view_x), dot(p, view_y), dot(p, view_z) };
            proj[i][k] = vs;
            if (vs.x < min_x) min_x = vs.x;
            if (vs.y < min_y) min_y = vs.y;
            if (vs.x > max_x) max_x = vs.x;
            if (vs.y > max_y) max_y = vs.y;
        }
    }

    float ext_x = max_x - min_x;
    float ext_y = max_y - min_y;
    if (ext_x <= 0.f) ext_x = 1.f;
    if (ext_y <= 0.f) ext_y = 1.f;
    const float center_x  = 0.5f * (min_x + max_x);
    const float center_y  = 0.5f * (min_y + max_y);
    const float margin    = 1.10f;
    const float scale_x   = static_cast<float>(width) / (ext_x * margin);
    const float scale_y   = static_cast<float>(height) / (ext_y * margin);
    const float scale     = std::min(scale_x, scale_y);
    const float half_w    = 0.5f * static_cast<float>(width);
    const float half_h    = 0.5f * static_cast<float>(height);

    auto to_px = [&](V3 v) -> std::array<float, 3> {
        const float px = (v.x - center_x) * scale + half_w;
        // Image origin is top-left; view +Y goes "up", so flip.
        const float py = half_h - (v.y - center_y) * scale;
        return { px, py, v.z };
    };

    std::vector<float> zbuf(static_cast<size_t>(width) * height,
                            std::numeric_limits<float>::lowest());

    for (size_t ti = 0; ti < tris.size(); ++ti) {
        const Tri& T = tris[ti];

        // World-space face normal for shading. If the mesh has flipped
        // winding for some triangles, |dot(n, light_dir)| keeps the
        // surface lit from one side. (We could also conditional-flip
        // n based on dot(n, view_z) — both choices look fine.)
        const V3 e1 = T.v[1] - T.v[0];
        const V3 e2 = T.v[2] - T.v[0];
        const V3 n  = normalize(cross(e1, e2));
        const float diffuse = std::max(0.f, std::abs(dot(n, light_dir)));
        // Slight asymmetric ambient so back-facing tris aren't pitch
        // black after the |abs| bake (otherwise a triangle whose
        // normal points exactly at the light gets the same brightness
        // as one pointing away).
        const float lit = std::min(1.f, 0.45f + 0.65f * diffuse);
        const uint8_t r = static_cast<uint8_t>(std::min(255.f, T.color[0] * lit));
        const uint8_t g = static_cast<uint8_t>(std::min(255.f, T.color[1] * lit));
        const uint8_t b = static_cast<uint8_t>(std::min(255.f, T.color[2] * lit));

        std::array<std::array<float, 3>, 3> px;
        for (int k = 0; k < 3; ++k) {
            auto a = to_px(proj[ti][k]);
            px[k]  = { a[0], a[1], a[2] };
        }

        const float min_px = std::min({ px[0][0], px[1][0], px[2][0] });
        const float max_px = std::max({ px[0][0], px[1][0], px[2][0] });
        const float min_py = std::min({ px[0][1], px[1][1], px[2][1] });
        const float max_py = std::max({ px[0][1], px[1][1], px[2][1] });
        int ix0 = std::max(0, static_cast<int>(std::floor(min_px)));
        int iy0 = std::max(0, static_cast<int>(std::floor(min_py)));
        int ix1 = std::min(static_cast<int>(width) - 1, static_cast<int>(std::ceil(max_px)));
        int iy1 = std::min(static_cast<int>(height) - 1, static_cast<int>(std::ceil(max_py)));
        if (ix1 < ix0 || iy1 < iy0) continue;

        const float area = edge_fn(px[0][0], px[0][1], px[1][0], px[1][1], px[2][0], px[2][1]);
        if (std::abs(area) < 1e-5f) continue;
        const float inv_area = 1.f / area;
        const bool  cw       = area < 0.f;

        for (int iy = iy0; iy <= iy1; ++iy) {
            for (int ix = ix0; ix <= ix1; ++ix) {
                const float fx = static_cast<float>(ix) + 0.5f;
                const float fy = static_cast<float>(iy) + 0.5f;
                float       w0 = edge_fn(px[1][0], px[1][1], px[2][0], px[2][1], fx, fy);
                float       w1 = edge_fn(px[2][0], px[2][1], px[0][0], px[0][1], fx, fy);
                float       w2 = edge_fn(px[0][0], px[0][1], px[1][0], px[1][1], fx, fy);
                bool inside = cw ? (w0 <= 0 && w1 <= 0 && w2 <= 0)
                                 : (w0 >= 0 && w1 >= 0 && w2 >= 0);
                if (!inside) continue;
                const float bw0   = w0 * inv_area;
                const float bw1   = w1 * inv_area;
                const float bw2   = w2 * inv_area;
                const float depth = bw0 * px[0][2] + bw1 * px[1][2] + bw2 * px[2][2];
                const size_t idx  = static_cast<size_t>(iy) * width + static_cast<size_t>(ix);
                if (depth > zbuf[idx]) {
                    zbuf[idx]                  = depth;
                    out.pixels[4 * idx + 0]    = r;
                    out.pixels[4 * idx + 1]    = g;
                    out.pixels[4 * idx + 2]    = b;
                    out.pixels[4 * idx + 3]    = 255;
                }
            }
        }
    }
}

} // namespace orcaxr
