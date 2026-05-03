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

### Vision (M2)

| Tool | Purpose |
|---|---|
| `list_camera_presets` | Built-in presets + user-saved cameras |
| `render_view` | Render a single view; modes: `paint`/`solid`/`triangle_id`/`normals`/`depth` |
| `render_paint_overlay` | Convenience wrapper for `render_view` with mode=paint |
| `render_triangle_id_map` | RGB-encoded triangle map for chained pixel→tri lookups |
| `resolve_image_pixel` | Decode one pixel of a triangle-id map back to a tri ID |
| `name_view` | Save a custom camera under a session name |
| `render_views_grid` | Compose N preset views into one side-by-side PNG |

Built-in presets: `iso`, `iso_back`, `front`, `back`, `left`,
`right`, `top`, `bottom`. Render dimensions clamped to 1024 × 1024.

Render results include:
- `image_uri`: `mcp://resources/<token>.png` — fetch via HTTP `GET
  /resources/<token>.png` against the MCP server (auth: same bearer
  token).
- `render_token`: pass to `resolve_image_pixel` or
  `paint_projected_mask` so the tool knows which camera you used.
- `camera_descriptor`: full view+projection matrix metadata.
- Optional inline base64 image part when `inline=true` and PNG ≤
  200 KB.

### Spatial paint (M1 + M4)

| Tool | Purpose |
|---|---|
| `paint_sphere` | Paint by 3D ball; optional back-face filter |
| `paint_slab` | Paint axis-aligned span (centroid / any-vertex / all-vertex) |
| `paint_normal_cone` | Paint faces matching a direction within half-angle |
| `paint_surface_region` | Smart-fill from a seed (dihedral-angle gated BFS) |
| `paint_connected_component` | Paint whole connected sub-mesh from a seed |
| `paint_triangle_list` | Raw escape hatch: a list of triangle IDs |
| `paint_projected_mask` | Reverse-project a 2D polygon mask through a camera |

Every spatial paint tool accepts the same paint plumbing args:

- `kind`: `"color"` (default) | `"support"` | `"seam"` | `"fuzzy_skin"`
- `tag`: integer (0..32 for color slots, 0..2 for support/seam,
  0..1 for fuzzy skin)
- `merge`: `"replace"` (default) | `"only_unpainted"` |
  `"only_tagged"` (with `where_tag`)

Each call emits a single `WorkspaceAction.PaintTriangleSet` ⇒ one
`paint_undo` step regardless of how many triangles got painted (an
80 K-tri projected-mask paint is one undo).

### Introspection (M3)

| Tool | Purpose |
|---|---|
| `get_model_geometry` | bbox, surface area, volume, watertight, Z-histogram |
| `get_model_components` | Connected-components partition |
| `get_model_face_orientation_summary` | Six cardinal-cone buckets (up/down/front/back/left/right) + diagonal |
| `get_model_semantic_regions` | Region-growing clusters with heuristic labels |

`get_model_semantic_regions` is the **most important tool for the
canonical workflow.** It produces ≤ 12 regions (configurable) with
labels like `vertical_side_large`, `horizontal_top_medium`, plus a
sample of triangle IDs the LLM can hand to `paint_triangle_list`
or `paint_surface_region`.

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
