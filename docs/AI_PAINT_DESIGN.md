# Plan: AI-Driven Semantic Paint for OrcaXR

## Executive summary

To enable an external LLM to autonomously execute tasks like *"paint Benchy as a pirate ship using my available colors,"* OrcaXR needs three new pillars on top of the existing MCP/WorkspaceAction/JNI stack:

1. **Vision** — a headless multi-view renderer that produces PNGs the LLM can see, including overlays the LLM authors against (paint preview, triangle-ID color encoding, axis labels).
2. **Spatial paint primitives** — pure server-side paint operations (sphere, slab, normal-cone, surface-region, connected-component, projected mask, raw triangle list) that don't require an XR pinch.
3. **Introspection** — geometry summaries, components, face-orientation histograms, semantic regions so the LLM can reason about the model without coordinate guessing.

Plus a **conductor** layer (system prompt + worked example + failure-mode handling) and a phasing plan that ships value at each milestone.

The three biggest architectural calls in this design:

- **Triangle IDs are the lingua franca.** All paint primitives compile down to "set of triangle indices + tag." The LLM never invokes triangle indices directly except via the `paint_triangle_list` escape hatch — but every other primitive returns the matched triangle indices in its result, so a chain of read tools narrows to a triangle set the LLM can refine across calls.
- **Image transport: file-path with a content-resource URI, NOT inline base64.** MCP HTTP body cap is **1 MB** (`HttpFraming.MAX_BODY_BYTES`). A 512×512 PNG with paint+overlay is 100–400 KB; multi-view grids at 768×768 push 800 KB — too close to the cap once you wrap in JSON. We write the PNG to `${cacheDir}/mcp_renders/<token>.png` and return both an `image` content part (base64, only for small thumbnails ≤ 200 KB) and a `file://` resource URI. The Anthropic Messages API accepts file-based images via the SDK's image input, and Claude Desktop reads `resource://` URIs. Tools that must include the image inline use a strict 256×256 default.
- **Forward-port the existing software rasterizer.** `thumbnail_render.cpp` already proves headless rasterization works inside the JNI shim with no GL context. The vision pipeline forks/extends it rather than introducing OSMesa or EGL — both would require new NDK deps and the GEMINI.md rule against modifying vendored libslic3r.

---

## A. Architecture

### A.1 Component diagram (high-level data flow)

```
┌────────────────────────────────────────────────────────────────────┐
│  External LLM (Claude / GPT)                                       │
│  ─ calls MCP tools, reads images from ToolResult image+resource    │
│  ─ holds context: camera_id list, last triangle-ID map token       │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ JSON-RPC over HTTP / Bearer token
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  McpServer  (existing, no changes to transport)                    │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  WorkspaceTools (extended)                                         │
│  ┌────────────────────────────┐  ┌─────────────────────────────┐   │
│  │ Vision tools               │  │ Spatial paint tools         │   │
│  │   render_view              │  │   paint_sphere              │   │
│  │   render_views_grid        │  │   paint_slab                │   │
│  │   render_paint_overlay     │  │   paint_normal_cone         │   │
│  │   render_triangle_id_map   │  │   paint_surface_region      │   │
│  │   list_camera_presets      │  │   paint_connected_component │   │
│  │   resolve_image_pixel      │  │   paint_projected_mask      │   │
│  │                            │  │   paint_triangle_list       │   │
│  ├────────────────────────────┤  ├─────────────────────────────┤   │
│  │ Introspection tools        │  │ Existing paint tools        │   │
│  │   get_model_geometry       │  │   set_paint_brush, ...      │   │
│  │   get_model_components     │  │   replace_paint_tag, ...    │   │
│  │   get_model_face_summary   │  └─────────────────────────────┘   │
│  │   get_model_semantic_regions                                    │
│  └────────────────────────────┘                                    │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  WorkspaceAction (extended sealed interface)                     │
│   PaintTriangleSet, PaintProjectedMask, RenderRequest (...)      │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  WorkspaceBinding (handler) — runs on UI / IO dispatcher         │
│   – PaintTriangleSet → applyPaintMutation (existing helper)      │
│   – PaintProjectedMask → AiPaintEngine.projectMask + apply       │
│   – RenderRequest → AiRenderEngine.render → file path            │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌────────────────────────┬─────────────────────────────────────────┐
│  AiPaintEngine.kt      │  AiRenderEngine.kt                      │
│  – uses MeshBvhCache   │  – calls SlicerEngine.nativeRenderViews │
│  – uses StlReader      │  – buffers PNG to mcp_renders/<token>   │
│  – mesh-frame math     │  – passes paint state + tri-ID encoding │
└────────────────────────┴────────────────────────┬────────────────┘
                                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  JNI surface (slic3r_jni.cpp) — NEW functions:                   │
│   nativeRenderViews(...)         → PNG bytes per view            │
│   nativeBuildSemanticRegions(...) → coarse cluster ids           │
│   (existing nativeWriteColoredGlb is reused for paint state in   │
│    the rendered image; tri-ID encoding bypasses it)              │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  app/src/main/cpp/ai_render.{cpp,hpp}  (extends thumbnail_render)│
│   – Camera = view+proj 4x4 (or named preset)                     │
│   – Modes: solid color | paint | tri-ID | normals | depth        │
│   – Slic3r::Model assembled in-memory from paint ByteArrays      │
│  app/src/main/cpp/png_encode.{cpp,hpp}  (libslic3r already links │
│   miniz; reuse; OR include miniz_tdef png helper)                │
└──────────────────────────────────────────────────────────────────┘
```

### A.2 Data shapes (JSON conventions)

These are the universal field conventions for every new tool:

- **Coordinate frames** — explicitly named in every coordinate-bearing field. We have at least three frames in play, and gotcha #11d in GEMINI.md proves this is footgun-prone:
  - `mesh_local_mm` — the original disk STL/3MF triangle vertices, exactly as the slicer sees them. Used by `nativeSlice`, `nativeSliceMulti` paint payloads, and brim ears.
  - `centered_preview_mm` — the GLB-render frame: bbox XY-center at origin, Z-min at 0. Used by the existing BVH (gotcha #11d), `nativeWriteColoredGlb`, and `paint_split_plane`. **THIS IS THE FRAME ALL NEW SPATIAL PAINT PRIMITIVES USE BY DEFAULT** — it matches what the LLM sees in rendered images.
  - `printer_frame_mm` — bed-relative coords with Z=0 on the bed. Equivalent to mesh_local_mm for already-grounded models, but PlacedModel transforms (`translateXmm`, `translateYmm`, `translateZmm`, rotZ) apply on top. Used by bed-fit / collision logic.
  - `world_meters` — Jetpack XR scene space. Never exposed to the LLM.
- Every field that takes a coordinate carries a `_frame` sibling (e.g. `{"x_mm": 12.5, "y_mm": 0, "z_mm": 30, "frame": "centered_preview"}`) **only when the default is ambiguous.** For most spatial paint primitives the frame is fixed at `centered_preview_mm` and documented in the tool description.
- **Triangle IDs** — `tri_id` is always an integer 0 ≤ id < `total_triangle_count` from `get_model_geometry`. They are stable across paint state changes (paint mutates the parallel ByteArray; the source mesh is read-only for the session).
- **Tag values** — same encoding as the existing paint tools: 0 = unpainted, 1..32 = filament slot for `kind=color`, 0/1/2 for support/seam, 0/1 for fuzzy.
- **Resolution units** — image dimensions in pixels, all coords in millimeters. No normalized [-1, 1] anywhere in the public API.

### A.3 Triangle-ID stability

This is the load-bearing claim of the whole design.

- The "source-of-truth triangle index space" is the **triangle order in the derived STL** that `deriveStlFor(PlacedModel.source)` produces. This is what the existing BVH builder, `paintFilamentIndex`, `supportFlags`, etc. all use. Per gotcha #11d / #11g, libslic3r's binary STL writer produces deterministic ordering for a given input file.
- When does this break?
  - **Source file is replaced** (boolean op, repair, cut, emboss) — paint state is dropped (gotcha #21, #27, #28). Documented as "any model-level mesh edit invalidates triangle IDs and resets paint."
  - **Per-volume PlacedVolume edits** — volumes have their own paint arrays sized to that volume's mesh; a model's `total_triangle_count` is the *primary* volume's mesh only. The Phase 2 introspection tool `list_volumes` exposes per-volume IDs separately.
- The LLM sees triangle IDs **only** through:
  1. `get_model_geometry` returns `total_triangle_count`.
  2. `render_triangle_id_map` returns a PNG where each pixel encodes a triangle ID (see B.3 below) plus a side-channel `id_lookup_token` for `resolve_image_pixel`.
  3. Every spatial-paint primitive returns the `triangle_indices` array it matched (capped at `max_indices_returned: 4096` to avoid blowing the 1 MB body cap; LLM gets a `truncated: true` flag if the match was bigger).
  4. `paint_triangle_list` accepts an `int[]` directly as the escape hatch.
- The contract: **a triangle ID returned by tool A in a session is valid for tool B in the same session, as long as no model-mesh-mutating action happens between them.** A `clear_workspace_state` or `reload` in the future would invalidate; we can add a `model_revision` int to `get_model_geometry` later.

### A.4 Image transport

Decision: **file path + image content part for small renders, file path only for large.**

Why:
- MCP HTTP body cap is 1 MB (`HttpFraming.MAX_BODY_BYTES`). Inline base64 PNG at 768×768 with paint overlays runs ~600–900 KB encoded. Multi-view grid (`render_views_grid`) at 4 panels of 512×512 routinely exceeds.
- Claude / Anthropic SDK accepts `image` content parts as `{type: "image", source: {type: "base64", media_type: "image/png", data: "..."}}`, and Claude Desktop reads `resource://` URIs from `tools/list/resources`.
- We sidestep the body cap by writing the PNG to `${ctx.cacheDir}/mcp_renders/${tokenHex}.png` and returning a **resource URI** in `structuredContent.image_uri` (e.g. `file:///data/data/dev.orcaxr.app/cache/mcp_renders/abc123.png`). The HTTP server gains a new `GET /resources/<token>.png` endpoint that streams the file with `Content-Type: image/png`. Claude reads it as a resource part.
- For renders **under** 200 KB (small thumbnails, single-view 256×256), we ALSO inline base64 in the `content` array — this is what Claude's tool-use loop sees natively without a resource fetch.
- A bounded **render cache LRU** at `cache/mcp_renders/` matching `PaintCacheStore`'s pattern (50 entries, oldest-mtime evicted) keeps disk in check.
- Tokens are content-hashed (SHA-256 of view spec + paint state version + mesh id), so identical re-renders are O(1) lookups — important when the LLM iterates and re-renders the same view repeatedly.

### A.5 Closed-loop state preservation

Between LLM tool calls these survive in `WorkspaceModel` / process-singletons:

- `placedModels` (paint state included).
- `MeshBvhCache` per-session BVH per model (already exists).
- `PaintHistory` per model (already persistent across actions).
- New: `AiSessionState` — process-scoped `kotlinx.coroutines.flow.MutableStateFlow` holding:
  - `lastRenderToken: String?` — the most recent `render_view` token, so the LLM can refer to "the camera I just rendered from" without re-providing the matrix.
  - `cameraPresets: Map<String, CameraSpec>` — named cameras the LLM created (`name_view "bow"`, `name_view "stern"`).
  - `tokensByContent: LRU<String, RenderArtifact>` — content-hashed render cache (above).
  - `semanticRegionsCache: Map<modelId, SemanticRegionResult>` — cached output of `get_model_semantic_regions` so it doesn't re-cluster on every call.
- Disk persistence (across app restarts): paint state already persists via `PaintCacheStore`. We add a **per-session-only** AI session state — restarting OrcaXR resets cameras and triangle IDs. This is intentional: triangle IDs survive only as long as the source file is unchanged, and the cleanest contract is "AI session = one app run."

---

## B. The vision pillar

### B.1 Camera model and presets

- Two input modes:
  - **Named preset.** `view_name: "iso" | "front" | "back" | "left" | "right" | "top" | "bottom" | "iso_back"` — eight standard views computed from the model's centered-preview AABB. The LLM uses these for orienting itself ("show me the back so I know where the stern is").
  - **Custom view+projection.** `view_matrix_4x4: float[16]` (row-major) + `projection: {kind: "perspective"|"orthographic", fov_deg?, aspect?, near, far}` + `width_px`, `height_px`. The LLM uses this when it knows what it wants (e.g. "now zoom 2x on the bow region I just identified").
- Recommendation: ship presets first; add custom matrix in Phase 2.
- **`paint_projected_mask` requires the LLM to *re-cite* the camera spec**, not just the view name — we can't trust that the named preset's resolution matches the mask resolution the LLM cooked up. The `render_view` response includes a stable `camera_descriptor` blob (view+proj+width+height as JSON) and the LLM passes that descriptor verbatim to `paint_projected_mask`.

### B.2 Render modes

A single JNI entry point, `nativeRenderViews`, handles all of them via a `mode` enum:

```cpp
// app/src/main/cpp/ai_render.hpp
namespace orcaxr {
enum class RenderMode {
    SolidColor,        // unlit per-volume tint, like thumbnail
    PaintColor,        // current paintFilamentIndex blended onto faces
    TriangleId,        // each triangle gets a unique RGB encoding tri_id
    NormalSphere,      // RGB = (n.x*.5+.5, n.y*.5+.5, n.z*.5+.5)
    Depth,             // 16-bit depth → RGB packed
    PaintMaskLayer,    // single tag rendered as solid; everything else gray
};

struct RenderRequest {
    int               model_index;            // index in Slic3r::Model::objects
    int               width_px, height_px;
    float             view_matrix[16];        // row-major mesh-local → camera
    float             proj_matrix[16];
    RenderMode        mode;
    int               focus_tag = -1;         // for PaintMaskLayer
    bool              transparent_bg = false;
    bool              draw_axes = false;      // tiny RGB axis triad in corner
    bool              draw_bbox = false;      // wireframe AABB
    std::vector<std::string> palette_hex;     // for PaintColor
    const uint8_t*    paint_filament_index;   // optional, sized to tri count
    int               paint_filament_index_len;
};

struct RenderResult {
    std::vector<uint8_t> png_bytes;
    int                  width_px, height_px;
    // For TriangleId mode: 6-channel encoding metadata so the
    // Kotlin side can decode pixel→tri_id.
    int                  tri_id_red_shift, tri_id_green_shift, tri_id_blue_shift;
    int                  tri_id_max;
};

void render_views(const Slic3r::Model& model,
                  const std::vector<RenderRequest>& reqs,
                  std::vector<RenderResult>& out);
} // namespace orcaxr
```

Implementation reuses `thumbnail_render.cpp`'s edge-function rasterizer. New code:

- **Camera math.** Replace the hard-coded isometric basis with caller-supplied 4×4 view + 4×4 projection. Pineda fill stays; depth is now NDC-z keep (closer = larger after perspective divide; matches the existing convention).
- **Triangle-ID encoding.** RGB packs the triangle index: red = (id >> 16) & 0xFF, green = (id >> 8) & 0xFF, blue = id & 0xFF. A 1.4M-triangle dragon needs 21 bits — fits in 24-bit color with no alpha use. Background is `(0, 0, 0)` (id 0 is reserved as "no hit" because triangle 0 of a real mesh is rarely silhouetted; we offset by +1 so a hit pixel reading `(0, 0, 0)` is unambiguously background — id 1 maps to RGB `(0, 0, 1)`).
  - **No interpolation, no anti-aliasing** in tri-id mode — flat fill of the triangle's id, exactly like a stencil buffer. Anti-aliased edges would corrupt id pixels.
- **PNG encoding.** miniz already links into libslic3r as the GLB / 3MF zip writer. Reuse `miniz_tdef`'s PNG output via libslic3r's existing path or include `stb_image_write.h` as a single-header drop-in — the latter is a 700-line file we add to `app/src/main/cpp/` as `third_party_stb_image_write.h`. **Decision: stb_image_write.h.** miniz can do PNG but the API is harder; stb is one function and we already vendored stb_truetype for Emboss (gotcha #28).

### B.3 New JNI surface

```kotlin
// SlicerEngine.kt
private external fun nativeRenderViews(
    modelArchivePath: String,           // STL/3MF/derived
    objectIndex: Int,                   // for multi-object 3MFs
    paintFilamentIndex: ByteArray?,
    supportFlags: ByteArray?,
    seamFlags: ByteArray?,
    fuzzySkinFlags: ByteArray?,
    paletteHex: Array<String>,
    /** Flat array of N requests, each contributing 16+16+1+1+1+1+1+1
     *  floats/ints. Passed flat instead of as a parcelable to keep
     *  the JNI surface narrow (ScopedUtf, no java reflection). */
    viewMatricesRowMajor: FloatArray,   // 16 floats per request
    projMatricesRowMajor: FloatArray,   // 16 floats per request
    widths: IntArray,
    heights: IntArray,
    modes: IntArray,                    // RenderMode ordinals
    focusTags: IntArray,                // -1 except for PaintMaskLayer
    flags: IntArray,                    // bit 0 = transparent, bit 1 = axes, bit 2 = bbox
    /** Output: parallel array of PNG bytes per request. JNI side
     *  encodes via stb_image_write into in-memory buffers. */
    outPngPaths: Array<String>,         // pre-allocated paths the JNI writes to
): Int                                  // 0 = ok, negative = error code
```

Why pass output paths in instead of returning byte arrays? Allocation: a 4-view grid at 768×768 PNGs returns ~3 MB through JNI. JVM array marshaling at that size is allocation-heavy and brittle on arm64 (we already saw the GLB writer OOM on big ByteBuffers — gotcha #11). Writing to a pre-named path lets the Kotlin side stream out without ever holding all the bytes in heap.

Tri-ID lookup metadata (the encoding shifts and max id) flows back via a parallel `outTriIdInfo: IntArray` so Kotlin can decode pixel → tri-id without calling back into the JNI.

### B.4 New MCP tools

```
list_camera_presets
  Input: { model_id: string }
  Output: structured = {
    presets: [
      { name: "iso", description: "Default 3/4 view, +X right, -Y back, +Z up" },
      { name: "front", description: "Camera at -Y, looking +Y" },
      ...
    ],
    bbox_centered_preview: { x_min, x_max, y_min, y_max, z_min, z_max }
  }

render_view
  Input: {
    model_id: string,
    view_name?: "iso"|"front"|"back"|"left"|"right"|"top"|"bottom"|"iso_back",
    custom?: {
      view_matrix_4x4: float[16],     // row-major, mesh-local → camera
      projection: { kind: "perspective", fov_y_deg: float, aspect: float,
                    near: float, far: float }
                | { kind: "orthographic", scale_mm: float, near: float, far: float }
    },
    width_px?: int = 512,             // capped at 768
    height_px?: int = 512,
    mode?: "paint" | "solid" | "normals" | "depth" | "paint_mask",
    focus_tag?: int,                  // for paint_mask: only this slot opaque
    inline?: bool = false,            // if true AND result < 200 KB, also inline base64
    draw_axes?: bool = true,
    draw_bbox?: bool = false,
    transparent_bg?: bool = false
  }
  Output: ToolResult.content =
    [{type:"text", text:"Rendered iso (mode=paint, 512×512, 142 KB)"},
     // optional image part if inline=true and small enough:
     {type:"image", source: {type:"base64", media_type:"image/png", data:"..."}}]
  structuredContent = {
    image_uri: "file:///data/data/dev.orcaxr.app/cache/mcp_renders/abc123.png",
    width_px: 512, height_px: 512,
    camera_descriptor: { view_matrix_4x4: [...], projection: {...},
                         width_px: 512, height_px: 512 },
    bytes: 145312,
    render_token: "abc123"            // pass to paint_projected_mask
  }

render_views_grid
  Input: { model_id: string, view_names: string[], width_px?: int = 384,
           height_px?: int = 384, mode?: "paint" }
  Output: same as render_view but image is a single PNG composed of N panels
          arranged left-to-right with text labels burned in by the rasterizer.
          Useful for "give me all six orthographic views in one call" → one
          1152×384 PNG well under the body cap.

render_paint_overlay
  Convenience wrapper for render_view with mode="paint" forced and
  draw_bbox=true. Same shape.

render_triangle_id_map
  Input: { model_id: string, view_name?, custom?, width_px?, height_px? }
  Output: structuredContent = {
    image_uri: "...",
    encoding: { red_shift: 16, green_shift: 8, blue_shift: 0, id_max: 1421339 },
    camera_descriptor: {...},
    render_token: "def456"
  }
  No inline image (PNG is meant to be machine-decoded, not LLM-viewed).
  But also returns a coarse bucketed PREVIEW — a paint-mask render
  showing 8 broad regions colored visually so the LLM can see "ok the
  hull is the red region in the preview, the stern is yellow" before
  asking to paint by mask.

resolve_image_pixel
  Input: { render_token: string, x_px: int, y_px: int }
  Output: structuredContent = { tri_id: int, hit: bool }
  Lets the LLM ask "what triangle is at (x=234, y=120) in that triangle-ID
  render I made?" without having to decode the PNG itself. Saves the
  LLM from having to reason about pixel-encoded ids in vision input.

name_view
  Input: { name: "bow", camera_descriptor: {...} }  // or copy from render_view
  Output: structured = { name: "bow", saved: true }
  Adds a named camera the LLM can refer back to via render_view{view_name:"bow"}.
  Per-session only.
```

### B.5 Resolution / size budget

Empirical sizing for PNG bytes at typical paint-overlay complexity:

| Size      | Bytes (typical) | Use                                    |
|-----------|-----------------|----------------------------------------|
| 256×256   | 25–60 KB        | Inline thumbnails the LLM sees natively |
| 512×512   | 90–250 KB       | Default for `render_view`. Fits inline if simple. |
| 768×768   | 200–500 KB      | "Look closely" zoom. Resource-only.    |
| 4×384²    | 250–500 KB      | `render_views_grid` 4-up               |

Hard cap on input width/height: 1024 px. Above that we warn and clamp. The JNI rasterizer is single-threaded and 1024² with a 1.4 M-tri model is ~2.5 s on the Galaxy XR — slow enough to hint at a budget without blocking explicit large requests.

---

## C. The spatial paint pillar

### C.1 New WorkspaceAction cases

All new spatial paint primitives compile down to the same two shapes:

```kotlin
sealed interface WorkspaceAction {
    // ... existing cases ...

    /**
     * Paint a precomputed set of triangle indices. The lowest-level
     * primitive — every spatial paint MCP tool eventually translates
     * to this. Single source of truth for paint history + cache
     * persistence + paintContentVersion bump.
     */
    data class PaintTriangleSet(
        val modelId: String,
        val kind: PaintKind,
        val triangleIndices: IntArray,
        val tag: Int,
        val mergeMode: MergeMode = MergeMode.Replace,
    ) : WorkspaceAction

    enum class MergeMode {
        /** Overwrite tag for matched triangles regardless of prior state. */
        Replace,
        /** Set tag only for triangles whose current tag is 0 (unpainted). */
        OnlyUnpainted,
        /** Set tag only for triangles whose current tag matches `whereTag`. */
        OnlyTagged,
    }

    /**
     * Paint by reverse-projection of a 2D mask. The mask is the
     * silhouette of the painted region as authored in image space
     * by the LLM. Every mask pixel that's "on" casts a ray from the
     * camera through the pixel center; every triangle the ray hits
     * (configurable: front-most only or all hits) gets `tag`.
     */
    data class PaintProjectedMask(
        val modelId: String,
        val kind: PaintKind,
        val cameraDescriptor: AiCameraDescriptor,
        /** PNG bytes of the mask. Single-channel: any pixel with
         *  alpha > 127 OR with R+G+B > 0 is "on". Same dims as
         *  cameraDescriptor.{width,height}. */
        val maskPngPath: String,
        val tag: Int,
        val depthMode: DepthMode = DepthMode.FrontFacingOnly,
        val mergeMode: MergeMode = MergeMode.Replace,
    ) : WorkspaceAction

    enum class DepthMode {
        /** Only the front-most triangle along each ray gets painted. */
        FrontFacingOnly,
        /** Every triangle along the ray gets painted (paints "through"
         *  the mesh — e.g. paint both sides of a thin wall). */
        AllHits,
    }
}
```

**Why one PaintTriangleSet primitive instead of N specialized actions?** Symmetry with `replace_paint_tag` and `paint_split_plane` — those are also "compute triangle set + tag" — and it concentrates the PaintHistory + paintCacheStore + paintContentVersion plumbing in *one* place. The spatial primitives below are MCP tools that compute a triangle index list and emit `PaintTriangleSet`. Less code drift over time.

### C.2 The seven primitives

For each: tool name → JSON schema → triangle-set computation → integration notes.

#### (a) `paint_sphere` — paint by 3D ball

```
Input:
  model_id: string
  kind?: "color" (default) | "support" | "seam" | "fuzzy_skin"
  center_mm: { x: float, y: float, z: float }  // centered_preview frame
  radius_mm: float
  tag: int
  merge?: "replace" (default) | "only_unpainted" | "only_tagged"
  where_tag?: int                              // for merge=only_tagged
  back_face_filter?: bool = false              // skip triangles whose
                                                // outward normal faces away
                                                // from center (so e.g. only
                                                // outer hull, not inner walls)
Output: structured = {
  triangle_count: int,
  painted_count: int,                          // after merge filter
  truncated_indices: bool,
  triangle_indices: int[]                      // capped at 4096
}
```

- **Implementation:** pure Kotlin in `AiPaintEngine`. Uses `MeshBvh` (already cached). Uses an existing-or-new `MeshBvh.aabbOverlapTriangles(min, max)` recursion that descends nodes whose AABB intersects the sphere's AABB and emits leaf triangles whose centroid is within `radius_mm`. For full correctness against thin meshes we add a `vertexInRadius` test (any vertex within the sphere ⇒ include).
- **History:** emits one `PaintTriangleSet`; the existing `applyPaintMutation` records before/after snapshots.
- **Cache:** unchanged — paint is per-model, written once after all triangles are batched.

#### (b) `paint_slab` — paint by axis-aligned z-band ("below the waterline")

```
Input:
  model_id, kind, tag, merge, where_tag (as above)
  axis: "x" | "y" | "z"
  min_mm: float                                // -inf allowed via "−Infinity"
  max_mm: float
  test: "centroid" (default) | "any_vertex" | "all_vertices"
```

- **Implementation:** linear scan of the mesh's positions array. No BVH needed; this is O(triCount) and we already pay that for `paint_split_plane`. Reuse the same Dispatchers.IO read-mesh path.
- For "below the waterline" the LLM passes `axis: "z", min_mm: -infinity, max_mm: 8` plus `tag: 4` (let's say slot 4 is brown).

#### (c) `paint_normal_cone` — paint faces whose normal points in a direction

```
Input:
  model_id, kind, tag, merge, where_tag
  direction: { x: float, y: float, z: float }   // need not be unit
  half_angle_deg: float                          // 0..90, smaller = stricter
  sign?: "outward" | "inward" | "both" = "outward"
```

- **Implementation:** linear scan; for each triangle compute `MeshBvh.triangleNormal(i)` (already exists), test `dot(n, direction.normalize()) > cos(half_angle_deg)`.
- Use cases: "paint the bottom of the hull" = direction=(0,0,-1), half_angle=45°. "Paint everything horizontal-ish" = direction=(0,0,1), half_angle=15°.

#### (d) `paint_surface_region` — seed + smart-fill (geodesic + dihedral angle)

```
Input:
  model_id, kind, tag, merge
  seed:
    | { tri_id: int }
    | { center_mm: {x,y,z}, ray_dir?: {x,y,z} }   // BVH raycast to find seed
    | { camera_descriptor: {...}, x_px: int, y_px: int }  // pixel → ray → tri
  max_dihedral_deg?: float = 30
  max_radius_mm?: float                          // hard distance cap
  max_triangles?: int = 65536
```

- **Implementation:** wraps `MeshBvh.smartFillBfs` (already exists). The flexible seed form is the value-add — the LLM doesn't need to know the triangle id. The pixel-seed form expects the LLM to have just rendered a triangle-id map (or any view) and pick a pixel; we resolve via `BVH.intersect` after re-projecting the pixel's ray.
- **Use case** (canonical for Benchy hull): LLM renders an `iso` view, sees the hull as a continuous gentle-curvature region, calls `paint_surface_region` with the camera+pixel from the rendered image and `max_dihedral_deg: 25`. The smart-fill stops at the gunwale.

#### (e) `paint_connected_component` — paint a whole connected sub-mesh

```
Input:
  model_id, kind, tag, merge
  seed: (same forms as above)
```

- **Implementation:** new `MeshBvh.connectedComponent(seed)` that does a vertex-adjacency BFS with no angle gate — pure topology. Useful when Benchy is actually multiple meshes (some Benchy STLs have separate hull / cabin / smokestack components).
- **Performance:** one-shot per seed, reuses adjacency CSR (already lazily built).

#### (f) `paint_projected_mask` — paint via a 2D mask in image space

```
Input:
  model_id, kind, tag, merge
  camera_descriptor: { view_matrix_4x4, projection, width_px, height_px }
  mask_image_uri: "file://..."                 // PNG written by the LLM
                                                // OR a render_token from
                                                // a prior render_view
  mask_inline?: { media_type: "image/png", data: "<base64>" }
                                                // for masks small enough
  depth_mode?: "front_facing_only" (default) | "all_hits"
  back_face_filter?: bool = true
```

- **Why this primitive matters most.** This is the LLM's most natural authoring form: "I'll show you exactly which area I want painted by drawing on the screenshot." The LLM's vision input is a PNG; if the LLM can generate a PNG (via tool use that returns the original image with paint marks added, OR via Claude's image-output capabilities, OR by emitting a polygon list that we rasterize on-device into a PNG), we can paint precisely the region the LLM identified.
- **Mask formats we accept** (in priority order):
  1. **Polygon list** (preferred for simple regions) — `polygons: [[x1,y1, x2,y2, ...], ...]`. We rasterize into a mask in Kotlin (4-line scanline fill, no JNI).
  2. **Inline base64 PNG** (preferred for irregular regions ≤ 200 KB). Parse via `BitmapFactory.decodeByteArray`.
  3. **File path PNG** (fallback for big masks the LLM uploaded via a separate channel — Phase 3 nice-to-have, the LLM rarely emits big masks autonomously).
- **Reverse-projection algorithm:**
  1. For each "on" pixel `(px, py)` in the mask:
     - Compute world-space ray `origin + t*direction` from camera intrinsics: NDC coords `(ndc_x, ndc_y) = (2*px/width - 1, 1 - 2*py/height)`, unproject via `inv(proj * view) * (ndc_x, ndc_y, -1, 1)` to a world-space point on the near plane; ray dir = that point − camera origin.
     - Intersect against the model's `MeshBvh`. In `FrontFacingOnly` mode take the front-most hit; in `AllHits` mode walk all hits along the ray.
     - Optionally reject hits whose outward normal points away from the camera (back-face filter — typical for paint).
  2. Collect into a `Set<Int>`, emit `PaintTriangleSet`.
- **Performance.** A 512×512 mask with 30% fill is ~80 K rays. Each ray is a BVH descent (typically O(log N) AABB tests + a few leaf triangle hits) — ~40 µs each on the Galaxy XR. Total: ~3 s for a dense mask. We run it on Dispatchers.Default and surface progress through a polling tool result (see B.4) — return immediately with a job token and let the LLM poll `get_paint_job_status(job_id)` for progress on long jobs.
- **Cancellation.** A new MCP tool `cancel_paint_job(job_id)` for the LLM to abandon an in-flight project.

#### (g) `paint_triangle_list` — raw escape hatch

```
Input:
  model_id, kind, tag, merge
  triangle_ids: int[]                          // capped at 65536
```

- The lowest-level primitive — used by tests and by an LLM that's done its own analysis (e.g. it called `render_triangle_id_map` and decoded the PNG itself). Routes directly to `PaintTriangleSet`.

### C.3 Integration with existing systems

- **PaintHistory** — every primitive routes through `applyPaintMutation` → `beginStroke`/`endStroke`. **One MCP call = one undo entry.** This means a `paint_projected_mask` that paints 80 K triangles is one undo step, not 80 K. The user / LLM can then `paint_undo` to reverse a wrong projection without losing all prior strokes. Already true for the existing `paint_split_plane`.
- **PaintCacheStore** — unchanged; `applyPaintMutation` already triggers persistence.
- **paintContentVersion** — bumped exactly once per primitive call by `applyPaintMutation` (gotcha #11h).
- **In-XR coexistence with brush paint** — if the user is brush-painting via XR controller while an MCP `paint_projected_mask` lands:
  - The XR brush mutates the stroke buffer in-place (gotcha #11f) and bumps `paintContentVersion` only at stroke close. An MCP-triggered mutation lands as a fresh ByteArray on `placedModels`. **Race window:** if MCP wins after the user stamped but before stroke close, the user's strokes since DOWN get clobbered.
  - Mitigation: in `applyPaintMutation`, before the transform, call `paintHistory.cancelStroke(modelId)` if a pending stroke exists, AND read the current placedModels' ByteArray (which is the live stroke buffer, since stamps are in-place). This commits the user's in-progress stroke into the snapshot the MCP transform diffs from.
  - Document this as: "An MCP paint call during an in-progress XR stroke commits the XR stroke as a separate undo step before applying the MCP change." Predictable, no data loss.

### C.4 Test strategy

For each primitive: a JVM unit test that builds a small known mesh (cube, two spheres, a Benchy fixture mini), runs the primitive, asserts the matched triangle set against a golden hash. Plus a single `MeshBvhProjectedMaskTest` that builds a 64×64 mask with three known-position circles and asserts which triangles get painted on a unit cube + sphere fixture.

---

## D. The introspection pillar

### D.1 New tools

#### `get_model_geometry`

```
Input: { model_id }
Output: structuredContent = {
  total_triangle_count: int,
  bbox_centered_preview: { x_min, x_max, y_min, y_max, z_min, z_max },
  bbox_mesh_local:        { ... },
  bbox_printer_frame:     { ... },           // includes PlacedModel xform
  size_mm: { x, y, z },                      // bbox extents
  surface_area_mm2: float,
  volume_mm3: float,
  watertight: bool,
  open_edge_count: int,
  per_axis_histogram: {
    z: [ {min: 0, max: 5, area_mm2: ...}, {min:5, max:10, ...}, ... ]
  },
  centroid_centered_preview: {x, y, z}
}
```

- **Implementation:** all in Kotlin from the cached `StlMesh`. surface area is `sum(|cross(e1,e2)|)/2`, volume is `sum(dot(v0, cross(v1,v2)))/6` (the classic divergence-theorem trick), open-edge count comes from libslic3r already (we expose what's already in `ObjectMeta.openEdgeCount`). The histogram (32 bins along Z by default) is one O(triCount) pass.

#### `get_model_components`

```
Input: { model_id }
Output: structuredContent = {
  components: [
    {
      component_id: 0,
      triangle_count: int,
      triangle_indices_sample: int[],         // up to 32 representative tris
      bbox_centered_preview: {...},
      centroid: {x,y,z},
      surface_area_mm2: float,
      volume_mm3: float
    },
    ...
  ]
}
```

- Implementation: BFS in `MeshBvh` over vertex adjacency (already exists) but iterating until every triangle is assigned a component id. Each component returns sample triangles (which the LLM can hand to `paint_triangle_list` or `paint_connected_component`). For big components, the sample is uniformly chosen across the component's bbox.

#### `get_model_face_orientation_summary`

```
Input: { model_id, bins?: int = 6 }
Output: structuredContent = {
  buckets: [
    { name: "up", normal: [0,0,1], area_mm2: ..., triangle_count: ...,
      cone_half_angle_deg: 30 },
    { name: "down", normal: [0,0,-1], ... },
    { name: "front", normal: [0,-1,0], ... },
    ...
  ],
  total_area_mm2: float
}
```

- Implementation: 6 cone buckets (±X, ±Y, ±Z) at 30° half-angle each. Triangles outside any bucket count as "diagonal." LLM uses this for "paint the underside" without having to author a cone manually.

#### `get_model_semantic_regions`

```
Input: {
  model_id,
  max_regions?: int = 12,
  min_region_area_pct?: float = 1.5      // drop tiny clusters
}
Output: structuredContent = {
  regions: [
    {
      region_id: 0,
      label: "horizontal_top_large",        // best-effort heuristic label
      triangle_count: int,
      area_mm2: float,
      bbox: {...},
      centroid: {x,y,z},
      mean_normal: {x,y,z},
      mean_curvature: float,
      triangle_indices_sample: int[]
    }, ...
  ],
  preview_image_uri: "file://...",          // colored region map render
  preview_palette: {                         // for the LLM to read
    "0": "#FF6B00", "1": "#7BC8FF", ...
  }
}
```

- **Algorithm.** Region growing: sort triangles by surface area (descending). For each unassigned triangle (a seed), BFS outward via vertex adjacency, accepting neighbors whose normal is within `seed_normal ± 35°` AND whose centroid is within `0.3 * model_bbox_diagonal` of the seed centroid. Walk until exhaustion. Result is a set of clusters whose interior is "consistent surface" (a flat top, a curved hull side, etc.). Heuristic label = `<orientation>_<size>` ("horizontal_top_large" for Z-up + biggest bucket).
- **Why pick this over edge-based segmentation?** Region growing is O(triCount × avg_neighbors), runs in ~150 ms on a Benchy (~40 K tris) on the Galaxy XR's CPU and produces clusters that match human intuition for printable parts. A more sophisticated approach (multi-scale curvature, MSDM2) would be Phase 4 — region growing gets 80% of the value.
- **Implementation site:** new `app/src/main/cpp/ai_segment.cpp` because it benefits from native speed on big meshes; also reachable from a Kotlin fallback for the small ones. JNI: `nativeBuildSemanticRegions(stlPath, maxRegions, minAreaPct) → IntArray (region id per triangle) + per-region stats`.
- **The preview image.** The tool calls into `nativeRenderViews` with a region-id-as-color render mode (one new `RenderMode::RegionColor`). The LLM gets a single PNG showing all regions colored, plus the palette mapping in JSON. This is the **single most useful tool** for the pirate-ship task — it lets the LLM say "paint region 3 brown" without ever having to deal with triangle indices.

### D.2 Worked example: Benchy semantic regions

Expected output for a 40K-triangle Benchy at `max_regions=10`:

```
regions: [
  {region_id:0, label:"vertical_side_large", area:7600 mm², centroid:{0, 16, 22},  // hull port side
   mean_normal:{-0.95, -0.20, 0.05}, ...},
  {region_id:1, label:"vertical_side_large", area:7400 mm², centroid:{0, -16, 22},  // hull starboard
   mean_normal:{0.95, -0.20, 0.05}, ...},
  {region_id:2, label:"horizontal_top_medium", area:3200 mm², centroid:{0, 0, 38},  // cabin roof
   mean_normal:{0, 0, 1.0}, ...},
  {region_id:3, label:"vertical_side_medium", area:2200 mm², centroid:{0, 6, 30},   // cabin front
   mean_normal:{0, -0.95, 0.30}, ...},
  {region_id:4, label:"horizontal_bottom_large", area:2900 mm², centroid:{0, 0, 0}, // hull underside
   mean_normal:{0, 0, -1.0}, ...},
  {region_id:5, label:"diagonal_medium", area:1850 mm², centroid:{0, 22, 12},        // bow rake
   mean_normal:{0, -0.5, 0.85}, ...},
  ...
]
```

For the pirate-ship task the LLM looks at this list and the preview image, and can immediately decide:
- regions 0+1 → hull → brown (slot 4)
- region 2 → roof → red (slot 1)
- regions 3 + cabin sides → the "deck house" → leave default
- region 4 → hull bottom → brown
- region 5 → bow rake → brown

Then it issues 4–5 `paint_triangle_list` or `paint_surface_region(seed=region.triangle_indices_sample[0], dihedral=25)` calls to execute.

---

## E. The conductor — system prompt + tool-use loop

### E.1 Reference system prompt

```
You are an expert 3D-print artist driving OrcaXR's MCP server. You can
see the model by rendering views, and you can paint it by issuing
spatial paint primitives.

Coordinate frames matter:
- All spatial paint coordinates are in centered-preview millimeters:
  bbox XY-center is at (0,0,bbox_z_min). +Z is up. +X is right when
  viewed from the iso preset. +Y is depth-back.
- Triangle IDs are integers from 0 to total_triangle_count-1 reported by
  get_model_geometry. They are stable across paint mutations within
  this session, but invalidated by repair_model / cut_model / mesh_boolean
  / split_model / emboss_model. Re-fetch geometry after any of those.

Workflow:
1. Call list_placed_models and get_workspace_state to see what's on the
   bed. Pick the model_id you want to work on (typically the first, or
   the largest by triangle count).
2. Call list_filaments and list_slot_colors to see the user's available
   colors. Map every color you intend to apply to a slot 1..N. NEVER use
   a slot beyond what's in list_filaments — the user's printer may not
   have it loaded.
3. Call get_model_semantic_regions and look at preview_image_uri to
   understand the model's structure. Cross-reference with
   render_view{view_name:"iso"} and render_view{view_name:"front"} to
   build a mental map.
4. Plan: write down (in your reasoning) which region maps to which
   filament slot, with brief justification.
5. Execute: for each region, call paint_triangle_list using
   region.triangle_indices_sample if it covers the whole region, OR
   paint_surface_region with a seed from the region for a smart-fill,
   OR paint_projected_mask if you need to cut across regions.
6. After each significant paint action, call render_paint_overlay to
   see the result. If something is wrong, paint_undo and try again.
7. When satisfied, do NOT slice unless asked — surface the result for
   user review.

Hard rules:
- Do NOT call slice_active_plate or save_* unless the user says so.
- Do NOT use more than 6 distinct filament slots in one model unless
  the user's printer reports >6 slots in list_slot_colors. Most printers
  this session connects to are 4-toolchanger.
- Do NOT paint moving parts that need to clear during printing
  (overhangs, thin spans). The semantic regions tool labels these as
  "fragile_*" — leave them at their default tag.

When you get stuck:
- If a render shows nothing, the model may have invalid bounds; call
  get_model_geometry and verify size_mm.
- If a paint call returns painted_count: 0, your seed didn't hit
  geometry. Re-render with mode="triangle_id" and resolve_image_pixel
  on a pixel inside the visible region.

Answer in plain English what you did, then end with the structured
plan: {region_id_or_descr → slot_n → reason}.
```

### E.2 Worked example: end-to-end transcript for "paint Benchy as a pirate ship"

User: *"Load the Benchy STL, then paint it to look like a pirate ship using the colors I have available."*

Claude's tool calls (abbreviated):

1. `list_placed_models` → empty bed.
2. `list_recent_files` → finds `Benchy.stl`.
3. `load_model_from_path { path: "...Benchy.stl", mode: "Replace" }`.
4. `list_placed_models` → returns `model_id = "m_x7k1"`.
5. `list_filaments` → Claude reads the user's project palette: slot 1 = beige, slot 2 = white, slot 3 = red, slot 4 = brown, slot 5 = black, slot 6 = gold. *Slots 1, 4, 5, 6 line up surprisingly well with pirate-ship colors. White and red can be sails / accents.*
6. `list_slot_colors { printer_id: ... }` → confirms the printer has 4 physical slots loaded matching beige, brown, red, black.
7. `get_model_geometry { model_id }` → 41,288 triangles, size 60×30×48 mm, single component, watertight.
8. `get_model_semantic_regions { model_id, max_regions: 10 }` →
    - region 0: hull port side, area 4500
    - region 1: hull starboard, area 4500
    - region 2: deck top (horizontal Z+), area 1200
    - region 3: cabin port wall, area 800
    - region 4: cabin starboard wall, area 800
    - region 5: cabin roof, area 600
    - region 6: bow rake (diagonal Z+,Y-), area 400
    - region 7: smokestack cylinder, area 600
    - region 8: hull underside, area 300
    - …
   plus `preview_image_uri`.
9. `render_view { model_id, view_name: "iso", mode: "paint", inline: true }` → Claude sees the model unpainted, gets its bearings.
10. **Plan:** hull (regions 0, 1, 6, 8) → slot 4 (brown). Deck (region 2) → slot 4 (brown, lighter than default would help, but only 4 is brown). Cabin walls (regions 3, 4) → slot 1 (beige). Cabin roof (region 5) → slot 3 (red). Smokestack (region 7) → slot 5 (black). Add paint waterline: a slab of `z_min..z_min+5mm` → slot 5 (black, like a typical waterline stripe).
11. `paint_triangle_list { model_id, kind: "color", tag: 4, triangle_ids: [...region 0 sample...] }` — but Claude realizes region samples won't paint the *whole* region, just samples. Switches strategy:
12. `paint_surface_region { model_id, kind: "color", tag: 4, seed: { tri_id: <region 0 sample[0]> }, max_dihedral_deg: 25 }` → 4612 triangles painted. (region 0 + a bit of bow that's continuous with the hull).
13. `paint_surface_region { kind: "color", tag: 4, seed: { tri_id: <region 1 sample[0]> }, max_dihedral_deg: 25 }` → 4540 triangles painted (starboard hull).
14. `paint_surface_region { tag: 4, seed: { tri_id: <region 8 sample[0]> } }` → underside (281 tris).
15. `paint_normal_cone { tag: 4, direction: {x:0, y:-0.5, z:0.85}, half_angle_deg: 25 }` → bow rake.
16. `paint_surface_region { tag: 1, seed: { tri_id: <region 3 sample[0]> } }` → cabin port side.
17. `paint_surface_region { tag: 1, seed: { tri_id: <region 4 sample[0]> } }` → cabin starboard.
18. `paint_surface_region { tag: 3, seed: { tri_id: <region 5 sample[0]> } }` → cabin roof.
19. `paint_connected_component { tag: 5, seed: { camera_descriptor: ..., x_px: 380, y_px: 145 } }` after rendering an iso view to find a smokestack pixel → smokestack tube.
20. `paint_slab { kind: "color", axis: "z", min_mm: -infinity, max_mm: 5, tag: 5, merge: "only_unpainted" }` → waterline stripe (only_unpainted so we don't overwrite the painted hull bottom).
21. `render_paint_overlay { model_id, view_name: "iso" }` → Claude sees the result. Looks like a pirate ship! No major issues.
22. `render_views_grid { model_id, view_names: ["front", "back", "left", "right"] }` → confirm symmetry. Looks good.
23. Finishing message: *"Painted Benchy as a pirate ship: hull and bow brown (slot 4), cabin walls beige (slot 1), cabin roof red (slot 3), smokestack and waterline black (slot 5). Used 4 colors total. Slice when you're ready."*

### E.3 Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| `paint_*` returns `painted_count: 0` | seed missed geometry, or bbox is in wrong frame | Re-render in tri-id mode, pick interior pixel, retry |
| LLM cites slot 7 but printer has 4 slots | LLM ignored `list_slot_colors` | System-prompt rule + tool result error: "Slot 7 exceeds list_slot_colors count (4). Re-plan." |
| LLM picks pixel hit on background | `resolve_image_pixel` returns `hit: false`. LLM must pick again. | Tool helper returns "no triangle at pixel; valid pixels are at..." with bbox of populated tri-id pixels. |
| Two regions overlap (paint_sphere bleeds across cabin/hull) | radius too big | LLM calls `paint_undo` and retries with smaller radius or `paint_surface_region` instead. |
| `paint_projected_mask` paints both sides of thin geometry | `depth_mode: "all_hits"` was used | Re-do with `front_facing_only`. |
| `model_id` lookup returns null after `repair_model` | mesh edit dropped paint and reset triangle IDs | LLM must re-fetch `get_model_geometry` after any mesh edit. The plan's hard rule (E.1) covers this. |
| User's printer has no usable colors for the task | `list_slot_colors` shows only 1 distinct color | Tool surfaces the constraint; LLM either explains it can't differentiate, or asks the user to load more spools. Doesn't silently paint everything one slot. |

---

## F. Phasing

Each milestone leaves the system more capable than before. No half-built tools.

### Milestone 1: Spatial paint primitives (the cheapest big win)

**Files added/touched:**
- `app/src/main/java/dev/orcaxr/app/AiPaintEngine.kt` (new) — pure-Kotlin impls of sphere/slab/normal-cone/surface-region/connected-component/triangle-list, all using the cached `MeshBvh`.
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceAction.kt` — add `PaintTriangleSet` + `MergeMode`.
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceBinding.kt` — handler for `PaintTriangleSet` calling `applyPaintMutation` with the matching `kind` setter.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt` — six new `Tool` classes: `PaintSphere`, `PaintSlab`, `PaintNormalCone`, `PaintSurfaceRegion`, `PaintConnectedComponent`, `PaintTriangleList`.
- `app/src/main/java/dev/orcaxr/app/MeshBvh.kt` — add `aabbOverlapTriangles(min, max)` and `connectedComponent(seed)` to round out adjacency-BFS variants. Keep adjacency builder as-is.

**No new JNI surface.** No vendored-libslic3r changes. Reuses `MeshBvhCache` so all existing performance work (gotcha #11f, lazy adjacency build, BFS buffer reuse) carries over.

**Test strategy:**
- New `PaintSphereTest`, `PaintSlabTest`, `PaintNormalConeTest`, `PaintSurfaceRegionTest`, `PaintConnectedComponentTest`, `PaintTriangleListTest` — fixture mesh = unit cube + a 32-tri sphere. Assert exact triangle counts and indices against goldens.
- New `mcp/tools/SpatialPaintToolsTest` — drives the JSON-RPC layer end-to-end with an in-process MCP server (matching the pattern in existing `mcp/` tests).
- New scripted MCP transcript at `app/src/test/resources/mcp_transcripts/m1_spatial_paint.txt` — text format, one JSON-RPC call per line, validated by `McpTranscriptRunner` (we'll need to add this small helper) against expected `painted_count` per call. This catches multi-call interaction bugs (paint A, paint_undo, paint B should leave only B painted).

**Capability after milestone:** the LLM can paint anything it can specify in 3D space. It can't see the result yet, but a human can verify by looking at the on-bed preview.

### Milestone 2: Vision pillar — single-view rendering

**Files added/touched:**
- `app/src/main/cpp/ai_render.{cpp,hpp}` (new) — extends `thumbnail_render.cpp`'s rasterizer with arbitrary view+proj matrices and the `RenderMode` enum. Reuses Pineda fill, edge functions, depth buffer.
- `app/src/main/cpp/third_party_stb_image_write.h` (vendored) — single-header PNG writer.
- `app/src/main/cpp/slic3r_jni.cpp` — new `Java_dev_orcaxr_app_SlicerEngine_nativeRenderViews` that loads the model from disk (single STL only in M2; multi-volume waits for M5), constructs `RenderRequest`s from the flattened JNI args, calls `orcaxr::render_views`, writes PNGs to caller-supplied paths.
- `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt` — `nativeRenderViews` declaration + `suspend fun renderViews(...)` Kotlin wrapper.
- `app/src/main/java/dev/orcaxr/app/AiRenderEngine.kt` (new) — Kotlin orchestrator: builds matrices for named presets, maintains LRU at `cache/mcp_renders/`, computes content-hash tokens, returns image URIs.
- `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt` (new) — process-scoped session cache (named cameras, render token map).
- `app/src/main/java/dev/orcaxr/app/mcp/McpServer.kt` — new GET route `GET /resources/<token>.png` that streams the PNG file with `Content-Type: image/png` (auth still required).
- `app/src/main/java/dev/orcaxr/app/mcp/Tool.kt` — extend `ToolResult` to support image content parts (`asImage(media_type, base64)`).
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionTools.kt` (new) — `RenderView`, `RenderPaintOverlay`, `RenderTriangleIdMap`, `ListCameraPresets`, `NameView`, `ResolveImagePixel`.

**New JNI signature (full):**

```cpp
extern "C" JNIEXPORT jint JNICALL
Java_dev_orcaxr_app_SlicerEngine_nativeRenderViews(
    JNIEnv* env, jobject self,
    jstring jModelArchivePath,
    jint    jObjectIndex,
    jbyteArray jPaintFilamentIndex,
    jbyteArray jSupportFlags,
    jbyteArray jSeamFlags,
    jbyteArray jFuzzySkinFlags,
    jobjectArray jPaletteHex,
    jfloatArray jViewMatricesRowMajor,
    jfloatArray jProjMatricesRowMajor,
    jintArray   jWidths, jintArray jHeights,
    jintArray   jModes,            // RenderMode ordinals
    jintArray   jFocusTags,
    jintArray   jFlags,
    jobjectArray jOutPngPaths,
    jintArray   jOutTriIdInfo);    // 4 ints per request: rShift, gShift, bShift, idMax
```

**Test strategy:**
- `AiRenderEngineTest` (host JVM, native lib pre-loaded): renders a 1-cm cube at iso, asserts pixel-counts of the dominant face match expected, asserts PNG file is valid (parse header).
- `RenderModeTriIdTest`: renders a cube, decodes the PNG, asserts every populated pixel decodes to a tri_id in [0, 11] (12 cube triangles), asserts background is `(0,0,0)`.
- MCP transcript test `m2_render_loop.txt`: load cube, render iso, paint top with `paint_normal_cone`, render again, assert resource URI returns image bytes via `GET /resources/<token>.png` and that the second render's bytes differ from the first.

**Capability:** the LLM can see the model and verify its paint actions. Closed loop is functional.

### Milestone 3: Introspection

**Files added/touched:**
- `app/src/main/java/dev/orcaxr/app/AiIntrospection.kt` (new) — pure-Kotlin `get_model_geometry`, face-orientation summary (also pure-Kotlin), and a Kotlin fallback for `get_model_components` (BVH adjacency-BFS).
- `app/src/main/cpp/ai_segment.{cpp,hpp}` (new) — region-growing segmentation. Native because dragon-class meshes (1.4 M tris) need the speed.
- `app/src/main/cpp/slic3r_jni.cpp` — `nativeBuildSemanticRegions(stlPath, maxRegions, minAreaPct, normalToleranceDeg, distanceCapMm)` returns `(IntArray regionIdPerTri, FloatArray perRegionStats)`.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiIntrospectionTools.kt` (new) — `GetModelGeometry`, `GetModelComponents`, `GetModelFaceOrientationSummary`, `GetModelSemanticRegions`. The last one calls into M2's render with a new `RenderMode::RegionColor` for the preview image.
- `app/src/main/cpp/ai_render.cpp` — add `RenderMode::RegionColor` (one new branch in the per-triangle color-pick step that reads from a passed-in `int[] tri_to_region` and looks up a deterministic palette).

**Test strategy:**
- `GetModelGeometryTest`, `FaceOrientationTest` — golden values for cube, sphere, Benchy fixture.
- `SemanticRegionsTest` — Benchy fixture must produce ≥ 8 regions including a hull side, hull bottom, deck top, cabin roof. Use approximate matching: assert each expected label is present in the result, allow other regions in between.
- MCP transcript `m3_introspect.txt` — load Benchy, run all four introspection tools, assert structured shapes.

**Capability:** the LLM has a map. The pirate-ship task is now executable end-to-end.

### Milestone 4: Multi-view + projected mask

**Files added/touched:**
- `app/src/main/java/dev/orcaxr/app/AiRenderEngine.kt` — add `renderViewsGrid` that calls `nativeRenderViews` with N requests, then composes via `Bitmap.createBitmap` + Canvas drawing into one PNG with text labels.
- `app/src/main/java/dev/orcaxr/app/AiPaintEngine.kt` — add `applyProjectedMask` that:
  1. Reads the mask PNG via `BitmapFactory`.
  2. For each "on" pixel, computes a world-space ray from the inverse view-projection.
  3. Calls `MeshBvh.intersect` (or new `intersectAll` for `depth_mode: all_hits`).
  4. Returns the matched triangle index set.
- `app/src/main/java/dev/orcaxr/app/MeshBvh.kt` — add `intersectAll(origin, direction): IntArray` (collects all triangle hits along a ray, used for `all_hits` mode).
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceAction.kt` — add `PaintProjectedMask` + `DepthMode` + `AiCameraDescriptor`.
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceBinding.kt` — handler for `PaintProjectedMask` that runs `applyProjectedMask` on Dispatchers.Default + emits a `PaintTriangleSet` when complete.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionTools.kt` — `RenderViewsGrid`.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt` — `PaintProjectedMask` Tool that accepts polygon list, inline base64 PNG, or file URI.
- `app/src/main/java/dev/orcaxr/app/mcp/JobRegistry.kt` (new) — for long jobs: returns a `job_id`, exposes `get_paint_job_status`, `cancel_paint_job`. Use `kotlinx.coroutines.Job` underneath.

**Test strategy:**
- `MaskProjectionTest`: known-camera, known-mask (a circle in the center of a 64×64 mask), known cube — assert paints exactly the front face triangles.
- `MaskProjectionAllHitsTest`: same setup with thin shell, assert paints front and back face.
- MCP transcript `m4_projected_mask.txt`: render iso of cube, send polygon mask covering a quadrant, assert paint count.

**Capability:** the LLM's most expressive paint primitive is online.

### Milestone 5: Multi-volume support, polish, docs

- Extend `nativeRenderViews` and the introspection tools to handle multi-volume `PlacedModel`s (multiple `PlacedVolume`s under one `PlacedModel`). Each volume has its own paint arrays — surfaced via `list_volumes` (already exists) and a `get_volume_geometry` parallel to `get_model_geometry`.
- Document the new tool surface in a `docs/AI_PAINT_PROTOCOL.md` covering frames, triangle stability, and the worked example.
- Ship a reference `claude_run.py` SDK harness (under `scripts/`) that uses Anthropic's Python SDK with the system prompt from E.1 and a `PaintBenchyAsPirateShip` evaluation script that grades the result against an expected slot-distribution histogram.
- Long-job progress tool `get_paint_job_status(job_id)`.

**Test strategy for E2E:** `scripts/run_e2e_pirate_test.sh` boots an emulator, sideloads the APK, launches Claude with the system prompt + a bundled Benchy STL, runs the conductor loop, asserts the final paint state has at least 4 distinct slots used and that each slot's painted-tri count is in expected ranges (hull > deck, etc.). Grades pass/fail. Runs in CI nightly, not per-commit (it's slow + uses Anthropic API credits).

---

### Milestone 6: Procedural paint + frustum selection (efficiency / ergonomics)

Two cheap-to-build tools that fill obvious gaps in how the LLM authors paint:
procedural patterns the LLM cannot easily express as triangle lists, and rectangular
2D-bbox prompting which the LLM does far more reliably than authoring a polygon mask.

**Files added/touched:**
- `app/src/main/java/dev/orcaxr/app/AiProceduralPaint.kt` (new) — pure compute. Two
  generators that produce `IntArray` triangle sets per filament-slot stop.
  - `gradient(bvh, axis|direction, stops)` — for each triangle, evaluate
    `t = (centroid · dir - tMin) / (tMax - tMin)` clamped to [0,1], pick the stop
    whose `[t_lo, t_hi]` range contains it. Stops are an ordered list of
    `{t_lo, t_hi, tag}` so an LLM can paint "0.0–0.3 brown, 0.3–0.7 unchanged,
    0.7–1.0 white" with two emit calls (skipping the unchanged middle band).
  - `valueNoise(bvh, frequency_per_mm, seed, stops)` — 3D value noise sampled at
    each centroid in centered-preview frame; quantized to stops the same way.
    Implementation: 3-axis lattice hash + tri-linear interpolation (pure Kotlin,
    no perlin gradient table). Deterministic for `(seed, stops)`.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiProceduralPaintTools.kt` (new) —
  `paint_gradient` and `paint_noise` MCP tools. Each tool emits one
  `PaintTriangleSet` per stop (`emitAndRespond` is reused) so the result is N
  undo steps for N stops; sessions group them under one commit.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiPaintTools.kt` — promote
  `preflight`, `applyMergeFilter`, `emitAndRespond`, `parsePaintKind`,
  `parseMergeMode`, `maxTagFor`, `resolveTag`, and `TagResult` to `internal` so
  the new procedural tools live in their own file and reuse the shared plumbing
  without duplication.

**Frustum selection** (3b from the design review):
- `paint_frustum` MCP tool: `(camera_descriptor, bbox_px = {x1, y1, x2, y2})` →
  every triangle whose centroid projects inside the bbox AND whose outward
  normal points toward the camera ("front-facing"). Implementation reuses
  `AiMaskProjection`'s view-projection math and the BVH's `triangleCentroid` /
  `triangleNormal` accessors. Faster than `paint_projected_mask` for rectangular
  selections (no per-pixel raycast — one centroid-projection per triangle,
  O(triCount)), and far more reliable for the LLM than authoring polygons.
- Optional `connected_only: bool = false` — when true, take the connected
  components rooted at any matched triangle (filters out small floating
  matches in the bbox that aren't part of a larger feature).

**Test strategy:**
- `AiProceduralPaintTest` — unit cube + sphere fixture: gradient along Z with
  three stops, assert per-tag counts match analytical bands; value noise with
  fixed seed, assert stable triangle counts across runs.
- `AiFrustumSelectionTest` — known camera + cube: bbox covering the front face,
  assert exactly the front-facing triangles match.
- MCP transcript `m6_procedural.txt`: load Benchy, paint a Z-gradient, render,
  assert pixel counts roughly proportional to stop ranges.

**Capability:** LLM authors gradients and rectangular selections in one tool
call without composing multiple primitives.

---

### Milestone 7: Paint constraints + commit verification

Catches the highest-frequency LLM paint error — bleeding into a region the LLM
intended to leave alone — *before* it lands on the live model. Strict
declarative constraints fail the commit instead of requiring the LLM to
re-render and notice the bleed.

**Files added/touched:**
- `app/src/main/java/dev/orcaxr/app/mcp/AiPaintConstraints.kt` (new) — types:
  ```kotlin
  sealed interface AiPaintConstraint {
      val id: String
      val triangleIndices: IntArray
      data class MustRemainUnpainted(...) : AiPaintConstraint
      data class MustBePainted(...) : AiPaintConstraint
      data class MustBeTag(val tag: Int, ...) : AiPaintConstraint
      data class MustNotBeTag(val tag: Int, ...) : AiPaintConstraint
  }
  data class ConstraintViolation(
      val constraintId: String,
      val kind: String,        // "must_remain_unpainted" etc.
      val violatingTriangles: IntArray,
      val description: String,
  )
  ```
- `app/src/main/java/dev/orcaxr/app/mcp/AiPaintSessionStore.kt` — extend
  `AiPaintSession` with a synchronized `MutableList<AiPaintConstraint>`, plus
  `addConstraint`, `clearConstraints`, `listConstraints`, and `validate()` that
  walks each constraint against `paintFilamentIndex` and returns a list of
  violations. Constraints persist for the session's lifetime; cleared by
  `clearConstraints` or `discard`.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintConstraintTools.kt` (new) —
  three new MCP tools:
  - `add_paint_constraint(session_id, kind, triangle_ids|region_id|seed,
    [tag], [description])` — creates one constraint. Triangle set can come
    from any triangle-set source the LLM already uses (raw list, segmentation
    region id, surface region from a seed).
  - `list_paint_constraints(session_id)` — diagnostic.
  - `clear_paint_constraints(session_id, [constraint_id])` — drop one or all.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintSessionTools.kt` —
  `CommitPaintSession` runs `session.validate()` first. On any violation:
  - Reject the commit (no `LoadPaintState` emitted).
  - Return `ok=false`, `violations: [{constraint_id, kind, violating_triangle_count, sample: int[≤256], description}]`.
  - Leave the session intact (default) so the LLM can `paint_undo` in-session
    or apply a corrective `merge=only_unpainted` before re-trying. New flag
    `force=true` overrides the gate (for the LLM's "I know better" case);
    the response includes `forced_violations` for audit.

**Why one place to enforce, not per-tool:** every paint-tool dispatcher would
otherwise need to re-check constraints, and the LLM would pay re-validation
cost on every primitive. Validating once at commit matches the session model
("plan freely, gate at the boundary") and keeps the per-call path fast.

**Test strategy:**
- `AiPaintConstraintsTest` — unit cube fixture: declare
  `MustRemainUnpainted` over the top face, then `paint_normal_cone(z=+1)`,
  assert `validate()` returns exactly the 2 top-face triangles as violators.
- `CommitWithConstraintViolationTest` — full session round-trip: begin →
  add constraint → paint that violates → commit → assert commit rejected,
  live model untouched, session still open. Then `paint_undo` (or
  `discard_paint_session`), retry, assert success.

**Capability:** the LLM can declare invariants and trust the engine to
enforce them at commit time.

---

### Milestone 8: front_plus_thin depth mode + native SIMD BVH (later)

**M8a — `front_plus_thin` depth mode (cheap, ship now).** The current
`paint_projected_mask` has only `front_facing_only` and `all_hits`; the missing
mid-option is "front side of a thin shell, both sides if the shell is thinner
than N mm." This is the canonical Benchy hull case (the hull is ~2 mm thick;
`all_hits` would also catch the deck above; `front_facing_only` paints only
the visible side and leaves the inside un-painted for backlit slices).

- `app/src/main/java/dev/orcaxr/app/AiMaskProjection.kt` — convert `DepthMode`
  enum to a sealed class so the new mode can carry `thicknessMm: Float`.
  Existing `FrontFacingOnly`, `AllHits`, `AnyFacing` become `data object`s; the
  new mode is `data class FrontPlusThin(val thicknessMm: Float)`.
- For each ray: take the front-most hit (call it `t0`); take subsequent hits
  whose distance along the ray `< thicknessMm` from `t0` (only those, not all
  back-side hits). Existing back-face filter stays: it rejects normals facing
  away from the camera before the thickness gate, so the hull's outer
  back-face shows up but interior cabin walls do not.
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiPaintTools.kt::PaintProjectedMask`
  — accept new `depth_mode: "front_plus_thin"` plus optional
  `thickness_mm: float` (default = 2.0). Validates `thicknessMm > 0`.

**M8b — native SIMD BVH (later, gated on profiling).** Mask projection at
768² with `all_hits` is ~1.5 s today (G.5). When profiling shows this is the
binding latency for the LLM loop, port `MeshBvh.intersect` /
`MeshBvh.intersectAll` into C++ as `nativeBvhIntersect` /
`nativeBvhIntersectAll` using a header-only SIMD BVH (e.g. madmann91/bvh).
Embree is x86-only on Android arm64 — explicitly not viable. Out of scope for
this milestone; tracked here so the path is documented when the data demands
it.

**Test strategy:**
- `MaskProjectionFrontPlusThinTest` — known camera + a thin-walled hollow
  cube fixture (outer shell at z=10, inner shell at z=8): mask the front
  face, depth_mode=front_plus_thin, thickness=2.5. Assert front + back
  outer-shell tris match, inner-shell tris excluded.
- Sealed-class migration: `MaskProjectionTest` and `MaskProjectionAllHitsTest`
  retain their assertions (the data-object cases must compile and behave
  identically). No call-site changes outside this file since `DepthMode` was
  always referenced by case.

**Capability:** thin-shell models paint correctly in one pass without the LLM
juggling `all_hits` + back-face filtering tricks.

---

## G. Risks and decisions

### G.1 Coexistence with gesture paint

The XR brush mutates `paintFilamentIndex` in place during a stroke (gotcha #11f). MCP paint mutations replace the array reference. **Resolution** (already discussed in C.3): commit any in-progress XR stroke as its own undo step before applying an MCP paint mutation. Document; add a regression test `XrAndMcpPaintInteractionTest` that simulates DOWN, MOVE, MOVE, MCP paint, MOVE, UP and asserts both committed strokes appear in `PaintHistory`.

### G.2 Coordinate-frame footguns

Three frames in play (A.2). Mitigations:

- **Tool descriptions explicitly name the frame for every coordinate field.** No defaulting that the LLM has to guess.
- **`get_model_geometry` returns bbox in all three frames** so the LLM can sanity-check.
- **A canary integration test:** load a Benchy whose authored bbox is X∈[100,160], call `paint_sphere(center=(0,0,20), radius=10)`, assert it paints triangles near the bow region (because the centered_preview frame has the model at X∈[-30,30] not [100,160]).

### G.3 Image bandwidth and MCP message size

- 1 MB body cap is the binding constraint.
- Mitigation A: file-path resource URI (A.4).
- Mitigation B: `inline: true` opt-in only, with size guard. If the LLM requests inline and the result exceeds 200 KB, the tool downgrades to file-only and warns: `"Image was 412 KB; exceeded inline budget — see image_uri."`
- Mitigation C: MCP server raises `MAX_BODY_BYTES` to 4 MB to allow polygon-list + dense parameter inputs from the LLM, but does NOT raise it above 4 MB — beyond that the LLM should be using URIs.

### G.4 libslic3r upstream-merge friction

- The new C++ files (`ai_render.cpp`, `ai_segment.cpp`) live in `app/src/main/cpp/`, NOT inside `third_party/OrcaSlicer/`. They include libslic3r headers (Model.hpp, TriangleMesh.hpp) but don't modify them. **No new patches in `patches/`.**
- `nativeRenderViews` builds a `Slic3r::Model` from disk like every other JNI helper does. We don't fork the slicer.
- stb_image_write.h is vendored once; it has no dependencies on libslic3r and won't drift.

### G.5 Performance

- BVH path is fine: existing `radiusBfs` is hot-path optimized (gotcha #11f). New primitives reuse the same buffers.
- Worst case for `paint_projected_mask` at 768×768 with all_hits = ~1.5 s on a Benchy. We push it to Dispatchers.Default and use the JobRegistry.
- Render: `nativeRenderViews` at 512×512 single view = ~150 ms on Benchy, ~600 ms on a 1.4M-tri dragon. Acceptable.
- BVH build for paint already happens lazily on first paint mode change (M5 in MainActivity). New: rendering doesn't require BVH (it's a forward rasterizer), so the LLM can render without paying that 36-s build cost — important because the LLM may render before deciding to paint.

### G.6 Determinism

The user asked for: same prompt + same model + same filaments → same paint output. Threats:

- **Floating-point determinism in the rasterizer** — Pineda fill is deterministic on a single machine; tri-id encoding has no per-pixel rounding ambiguity. ✅
- **Region-growing segmentation order** — depends on triangle iteration order. We sort by `(triangle_area DESC, tri_id ASC)` for stability before the BFS. ✅
- **LLM determinism** — partly out of our hands (sampling temperature, model version drift). The system prompt is the only lever. We document `temperature: 0` as the recommended setting in the conductor docs.
- **`MeshBvh.smartFillBfs` BFS order** — depends on the adjacency CSR, which is built from a HashMap (adjacency builder uses `HashMap<Long, ArrayList<Int>>`). HashMap iteration order IS deterministic in Kotlin/JVM at insertion order but the per-vertex insertion order is `0..triCount`, which is stable. ✅
- **`HashSet` use in `buildAdjacency`** — `HashSet<Int>` iteration order is NOT guaranteed deterministic in general but for boxed Integer keys it is in practice on the JVM. We change this to `LinkedHashSet<Int>` to guarantee — small cost, big confidence win. (Tracked as a Phase-1 cleanup.)

---

## Summary of net new artifacts (file-level)

**New Kotlin:**
- `app/src/main/java/dev/orcaxr/app/AiPaintEngine.kt`
- `app/src/main/java/dev/orcaxr/app/AiRenderEngine.kt`
- `app/src/main/java/dev/orcaxr/app/AiIntrospection.kt`
- `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt`
- `app/src/main/java/dev/orcaxr/app/mcp/JobRegistry.kt`
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionTools.kt`
- `app/src/main/java/dev/orcaxr/app/mcp/tools/AiIntrospectionTools.kt`

**Modified Kotlin:**
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceAction.kt` (PaintTriangleSet, PaintProjectedMask, MergeMode, DepthMode, AiCameraDescriptor)
- `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceBinding.kt` (handlers + callbacks)
- `app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt` (six new spatial paint tools)
- `app/src/main/java/dev/orcaxr/app/mcp/Tool.kt` (image content parts)
- `app/src/main/java/dev/orcaxr/app/mcp/McpServer.kt` (resources GET route)
- `app/src/main/java/dev/orcaxr/app/MeshBvh.kt` (aabbOverlapTriangles, connectedComponent, intersectAll, LinkedHashSet)
- `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt` (nativeRenderViews, nativeBuildSemanticRegions)
- `app/src/main/java/dev/orcaxr/app/MainActivity.kt` (wire new callbacks into BindWorkspaceModel)

**New C++:**
- `app/src/main/cpp/ai_render.cpp`, `ai_render.hpp`
- `app/src/main/cpp/ai_segment.cpp`, `ai_segment.hpp`
- `app/src/main/cpp/third_party_stb_image_write.h` (vendored)

**Modified C++:**
- `app/src/main/cpp/slic3r_jni.cpp` (two new JNI exports, no libslic3r changes)
- `app/src/main/cpp/CMakeLists.txt` (add the new .cpp files)

**New tests:** ~12 new unit test files plus 4 MCP transcript fixtures.

**Docs:**
- `docs/AI_PAINT_PROTOCOL.md` (the protocol spec for the LLM, with the system prompt + worked example).
- Update `GEMINI.md` with the new architectural note: "AI paint pillar lives in `Ai{Paint,Render,Introspection}Engine.kt` parallel to existing XR paint; both go through `applyPaintMutation` so PaintHistory + paintContentVersion stay correct. Triangle IDs are stable for a session as long as no mesh-mutating action runs."

---

### Critical Files for Implementation

- /home/ignacio/OrcaXR/app/src/main/java/dev/orcaxr/app/mcp/WorkspaceAction.kt
- /home/ignacio/OrcaXR/app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt
- /home/ignacio/OrcaXR/app/src/main/java/dev/orcaxr/app/MeshBvh.kt
- /home/ignacio/OrcaXR/app/src/main/cpp/thumbnail_render.cpp
- /home/ignacio/OrcaXR/app/src/main/cpp/slic3r_jni.cpp