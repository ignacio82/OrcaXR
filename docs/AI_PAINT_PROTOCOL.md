# OrcaXR AI Paint Protocol

This document is what an external LLM (Claude / GPT) reads to drive
OrcaXR's paint surface end-to-end via the in-process MCP server. It
covers coordinate frames, the tool surface, and the canonical
"paint Benchy as a pirate ship" workflow.

For design rationale (why each tool exists, performance budgets,
trade-offs) see [`AI_PAINT_DESIGN.md`](AI_PAINT_DESIGN.md). This
file is the runtime contract — keep it under 300 lines.

## Coordinate frames

OrcaXR has three named coordinate frames; tools consume / emit
**centered_preview_mm** unless otherwise stated.

- `mesh_local_mm` — the original disk STL/3MF triangle vertices.
  Used by the slicer pipeline. The LLM never touches this directly.
- `centered_preview_mm` — bbox XY-center at origin, Z-min at 0.
  The frame the BVH is built in (see GEMINI.md gotcha #11d) and the
  frame the rendered GLB / `nativeWriteColoredGlb` / every spatial
  paint primitive uses. **All tool inputs and outputs are in this
  frame unless documented otherwise.**
- `printer_frame_mm` — bed-relative; `PlacedModel.translateXmm`,
  `translateYmm`, etc., apply on top of mesh_local. Surfaced via
  `get_model_geometry.bbox_printer_frame` for sanity checks; not
  used by paint primitives directly.

## Triangle ID stability

A triangle ID is an integer in `[0, total_triangle_count)` from
`get_model_geometry`. IDs are stable across a session **as long as
no mesh-mutating action runs**. The mutating actions are:
`repair_model`, `cut_model`, `mesh_boolean`, `split_model`,
`emboss_model`. Any of those invalidates triangle IDs and resets
all paint state (see GEMINI.md gotchas #21, #27, #28). Re-fetch
`get_model_geometry` after any of them.

## Tool surface

### Vision (M2 + D18 + D19 + D21)

| Tool | Purpose |
|---|---|
| `list_camera_presets` | Built-in presets + user-saved cameras |
| `render_view` | Render a single view; modes: `paint`/`solid`/`triangle_id`/`normals`/`depth` |
| `render_paint_overlay` | Convenience wrapper for `render_view` with mode=paint |
| `render_triangle_id_map` | RGB-encoded triangle map for chained pixel→tri lookups |
| `resolve_image_pixel` | Decode one pixel of a triangle-id map back to a tri ID |
| `name_view` | Save a custom camera under a session name |
| `render_views_grid` | Compose N preset views into one side-by-side PNG |
| `render_diff` (D18f) | Pixel-XOR of two cached render tokens; highlights changes in red |
| `list_active_palette` | Live "as-will-print" palette (filament tag → hex) |
| `find_feature_anchors` (D18c) | Vision-LLM feature locator (Anthropic API call) |
| `generate_mask_from_point` (D19a) | Vision-LLM polygon outline from a click pixel |
| `get_mask_for_text` (D19d) | Vision-LLM zero-shot text-to-mask (e.g. "the cheeks") |

Built-in presets: `iso`, `iso_back`, `front`, `back`, `left`,
`right`, `top`, `bottom`. Render dimensions clamped to 2048 × 2048
(D18h bumped from 1024).

Render results include:
- `image_uri`: when the MCP server has a LAN address bound, an
  absolute `http://<lan-ip>:<port>/resources/<token>.png` URL
  the driving LLM can `WebFetch` directly — no Authorization
  header required (the 64-bit token is the capability; D21a).
  Falls back to `mcp://resources/<token>.png` when no LAN
  address is available (boot before Wi-Fi associates).
- `render_token`: pass to `resolve_image_pixel` or
  `paint_projected_mask` so the tool knows which camera you used.
- `camera_descriptor`: full view+projection matrix metadata.
- Optional inline base64 image part when `inline=true` and PNG ≤
  200 KB. Best-effort; not every MCP transport surfaces inline
  images back to the model — the http URL is the load-bearing
  channel.

### Spatial paint (M1 + M4 + D18 + D19)

| Tool | Purpose |
|---|---|
| `paint_sphere` | Paint by 3D ball; optional back-face filter |
| `paint_slab` | Paint axis-aligned span (centroid / any-vertex / all-vertex) |
| `paint_normal_cone` | Paint faces matching a direction within half-angle |
| `paint_surface_region` | Smart-fill from a seed (dihedral-angle gated BFS) |
| `paint_connected_component` | Paint whole connected sub-mesh from a seed |
| `paint_triangle_list` | Raw escape hatch: a list of triangle IDs |
| `paint_projected_mask` | Reverse-project a 2D polygon mask through a camera (D18d adds `depth_mode='any_facing'`) |
| `paint_geodesic_disc` (D18a) | Surface-bounded disc; right tool for organic bulges |
| `paint_with_mirror` (D18b) | Wrap any inner paint tool; emit it + its bbox-axis mirror in one call |
| `paint_decal` (D19c) | Project an RGBA image; per-pixel quantization to filament slot; one undo step |
| `paint_template` | Apply a bundled recipe; `auto=true` (D21b) fingerprints the model and resolves automatically |
| `list_paint_templates` | Enumerate bundled recipes |
| `save_paint_recipe` / `load_paint_recipe` / `list_paint_recipes` / `delete_paint_recipe` (D18j) | Persistent paint sessions |
| `flush_actions` (D18g) | Wait for pending paint mutations to drain (fixes only_tagged race) |

Every spatial paint tool accepts the same paint plumbing args:

- `kind`: `"color"` (default) | `"support"` | `"seam"` | `"fuzzy_skin"`
- `tag`: integer (0..32 for color slots, 0..2 for support/seam,
  0..1 for fuzzy skin)
- `merge`: `"replace"` (default) | `"only_unpainted"` |
  `"only_tagged"` (with `where_tag`)

Each call emits a single `WorkspaceAction.PaintTriangleSet` ⇒ one
`paint_undo` step regardless of how many triangles got painted (an
80 K-tri projected-mask paint is one undo).

### Introspection (M3 + D19)

| Tool | Purpose |
|---|---|
| `get_model_geometry` | bbox, surface area, volume, watertight, Z-histogram |
| `get_model_components` | Connected-components partition |
| `get_model_face_orientation_summary` | Six cardinal-cone buckets (up/down/front/back/left/right) + diagonal |
| `get_model_semantic_regions` | Region-growing clusters with heuristic labels |
| `get_curvature_segmentation` (D19b) | Multi-scale dihedral curvature; complementary to semantic_regions for organic / continuously-curved meshes |

`get_model_semantic_regions` is the canonical "what regions can I
paint" tool for prismatic models (cubes, Benchy, anything with
clear cardinal-axis surfaces). For organic / continuously-curved
models (Pikachu, Stanford Bunny, Funko Pops) the legacy heuristic
over-fragments because every curved surface registers as
`diagonal` — `get_curvature_segmentation` is the right call there;
it region-grows from low-curvature seeds and stops at curvature
ridges so an entire cheek bulge or ear surface comes back as one
segment.

### Mesh editing

| Tool | Purpose |
|---|---|
| `repair_model` | libslic3r mesh repair (self_union + ADMesh cleanup) |
| `simplify_model` (D17) | Quadric edge collapse to target tri count; drops paint state |
| `cut_model` | Z-plane cut |
| `mesh_boolean` | Union / Difference / Intersection between two PlacedModels |
| `split_model` | Split into connected components |
| `emboss_model` | Text/SVG → boolean against host (`mode='emboss'`/`'engrave'`) OR drop as fresh PlacedModel (`mode='add_object'`, D15) |

## Workflow: paint Benchy as a pirate ship

1. `list_placed_models` → pick a model_id (or `load_model_from_path`
   if the bed is empty).
2. `list_filaments` + `list_slot_colors { printer_id }` → see
   what colors are available. Map intended colors → slots 1..N.
3. `get_model_geometry { model_id }` → bbox, watertight check.
4. `get_model_semantic_regions { model_id, max_regions: 10 }` →
   structural map + `preview_image_uri` (a colored region render).
5. `render_view { view_name: "iso", mode: "paint", inline: true }`
   → see the unpainted model.
6. **Plan in chain-of-thought**: `{region_id_or_descr → slot_n →
   reason}`.
7. Execute: for each region, prefer (in order):
   - `paint_surface_region` with `seed.tri_id =
     region.triangle_indices_sample[0]`, `max_dihedral_deg: 25`
     for smart-fill of one curved face.
   - `paint_triangle_list` with `region.triangle_indices_sample`
     when the region's natural extent is exactly the sample set.
   - `paint_projected_mask` when the region is best authored as a
     2D shape on a rendered view.
   - `paint_normal_cone`, `paint_slab`, `paint_sphere` for
     orientation- or position-driven paints (e.g. waterline).
8. After each region: `render_paint_overlay { view_name: "iso" }`
   to verify. Use `paint_undo` if it went wrong.
9. `render_views_grid { view_names: ["front","back","left","right"] }`
   → confirm symmetry.

## Hard rules for the LLM

- Do not call `slice_active_plate` or `save_*` unless the user
  asks.
- Do not use more than 6 distinct filament slots in one model
  unless `list_slot_colors` reports more.
- Re-fetch `get_model_geometry` after any mesh-mutating action;
  triangle IDs are invalidated.
- Tools return `isError: true` for "the tool ran and failed"
  cases; respect that and re-plan.

## Recovery patterns

| Symptom | Cause | Recovery |
|---|---|---|
| `painted_count: 0` | Seed missed geometry | Re-render in `triangle_id` mode, pick interior pixel, `resolve_image_pixel`, retry |
| `paint_*` returns isError "Couldn't build a paint BVH" | Source mesh missing or unreadable | `get_model_geometry` should also fail — check `list_placed_models` |
| `tri_id` invalid after a mesh edit | Mesh-mutating action ran | Re-fetch `get_model_geometry`, re-issue `get_model_semantic_regions` |
| `paint_projected_mask` paints both sides of a thin wall | `depth_mode: "all_hits"` was used | Re-do with `front_facing_only` |

## Reference

For implementation details and the full design rationale: see
[`AI_PAINT_DESIGN.md`](AI_PAINT_DESIGN.md). For session-level state
see `dev.orcaxr.app.mcp.AiSessionState` (camera presets + render
artifact LRU). Tools are registered in
`dev.orcaxr.app.mcp.McpController.registerAllTools`.
