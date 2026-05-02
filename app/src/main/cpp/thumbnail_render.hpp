// thumbnail_render.hpp — software rasterizer that turns an in-memory
// Slic3r::Model into an isometric RGBA preview suitable for embedding
// in G-code as a `; thumbnail begin` block (see GCodeThumbnails::
// export_thumbnails_to_file).
//
// Headless: no OpenGL, no EGL context — runs on whichever thread calls
// it. libslic3r's GUI uses an offscreen GL framebuffer for the same
// purpose, but we have no GL context inside the JNI shim and don't
// want to set one up just for thumbnail generation.

#pragma once

#include <string>
#include <vector>

namespace Slic3r {
class Model;
struct ThumbnailData;
}

namespace orcaxr {

// Render a model thumbnail into [out].
//
// out.pixels is filled with `width * height * 4` RGBA bytes laid out
// top-to-bottom (row-major). Background pixels get `bg_*` (with alpha
// 0 if `transparent_bg`, else 255). On any error (empty model, zero
// extent, etc.) the buffer is left as background only — never throws.
//
// `filament_colors` is the per-extruder palette as hex strings
// (`#RRGGBB`); each volume's `extruder_id` (1-based) indexes into it.
// Unmatched / unparseable entries fall back to neutral gray.
void render_isometric_thumbnail(const Slic3r::Model&            model,
                                unsigned int                    width,
                                unsigned int                    height,
                                const std::vector<std::string>& filament_colors,
                                bool                            transparent_bg,
                                Slic3r::ThumbnailData&          out);

} // namespace orcaxr
