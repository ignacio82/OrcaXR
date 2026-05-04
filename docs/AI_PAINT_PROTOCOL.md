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

## Headless paint sessions (C9 M4)

Every live-path paint call triggers a colored-GLB rebake + scene
entity swap in OrcaXR. Fine for one brush stamp, prohibitive for a
30-step LLM refinement loop (each rebake interrupts the user's XR
view and fills its own undo step).

**A paint session is a private scratch buffer** owning a copy of
the model's paint arrays. Paint primitives with `session_id`
mutate the session in-place (no scene rebake, no undo emission);
render tools with `session_id` read paint from the session.
`commit_paint_session` atomically replaces live paint in ONE
rebake = ONE undo step regardless of how many primitives ran;
`discard_paint_session` drops the session, live model untouched.

Open a session whenever you expect more than ~3 paint primitives
on the same model. Live path is fine for one-shot edits.

**Tool surface:**

| Tool | Purpose |
|---|---|
| `begin_paint_session` | Open a session over a model; returns `session_id` |
| `commit_paint_session` | Replace live paint with session paint in one rebake / one undo |
| `discard_paint_session` | Drop a session without committing |
| `list_paint_sessions` | Enumerate open sessions (LRU cap = 8) |
| `get_paint_session_diff` | Per-kind tag histogram + base/current fingerprint |

**Routing the optional `session_id` arg:**

- All eight spatial paint tools (`paint_sphere`, `paint_slab`,
  `paint_normal_cone`, `paint_surface_region`,
  `paint_connected_component`, `paint_triangle_list`,
  `paint_projected_mask`, `paint_geodesic_disc`) accept
  `session_id`. With it set: in-process mutation, `painted_count`
  is reported but no `WorkspaceAction` is emitted.
- `paint_with_mirror` passes `session_id` through verbatim — pass
  it inside `inner.arguments` and both the original and the
  mirrored pass land in the same session.
- Render tools (`render_view`, `render_paint_overlay`,
  `render_views_grid`, `render_montage`) accept `session_id`. The
  render reads paint from the session's scratch buffer; the
  artifact cache key incorporates `(session_id, version)` so
  re-rendering after any session paint mutation always misses
  cache. (`render_triangle_id_map` doesn't depend on paint state
  so it ignores `session_id`.)
- `merge='only_unpainted'` and `merge='only_tagged'` evaluate
  against the **session's** current state — chained refinement
  inside one session composes correctly without `flush_actions`.

**Triangle ID stability inside a session:** sessions assume the
mesh is unchanged. Calling `repair_model` / `cut_model` /
`mesh_boolean` / `split_model` / `emboss_model` / `simplify_model`
/ `add_volume` / `remove_volume` mid-session invalidates triangle
indices; subsequent session paint and `commit_paint_session`
return `isError: true` reporting the tri-count drift. On error,
discard the session and start a new one.

**Memory budget:** each session owns a copy of all four paint
arrays (color / support / seam / fuzzy). On a 1.4 M-tri mesh that's
~5.6 MB per session; the LRU caps at 8 (≈ 45 MB total). Older
sessions evict silently if you exceed the cap; check with
`list_paint_sessions`.

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
| `render_montage` | 6-view ortho contact sheet (2×3, labelled) — D22 adds `mode` for solid/normals/depth |
| `render_diff` (D18f) | Pixel-XOR of two cached render tokens; highlights changes in red |
| `render_paint_session_diff` (D22) | 3-panel before/after/delta for a paint session in one PNG |
| `list_active_palette` | Live "as-will-print" palette (filament tag → hex) |
| `find_feature_anchors` (D18c) | Vision-LLM feature locator (Anthropic API call) |
| `generate_mask_from_point` (D19a) | Vision-LLM polygon outline from a click pixel |
| `get_mask_for_text` (D19d) | Vision-LLM zero-shot text-to-mask (e.g. "the cheeks") |
| `score_paint_against_reference` (D22) | Vision-LLM grader: 0..1 score + per-region notes vs a reference image |

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
| `paint_stroke` (D22) | Polyline brush: densify → union of geodesic discs → one undo step |
| `paint_semantic_region` (D22) | Paint by cached segmentation `region_id` instead of triangle list |
| `prime_region_cache` (D22) | Compute + cache a segmentation (semantic / curvature / components / recess) |
| `paint_with_mirror` (D18b, D22 axis="auto") | Wrap any inner paint tool; emit it + its bbox-axis mirror in one call. axis="auto" reads the cached `detect_symmetry` report |
| `detect_symmetry` (D22) | Score bilateral symmetry on X/Y/Z; cached for `paint_with_mirror axis="auto"` |
| `paint_decal` (D19c) | Project an RGBA image; per-pixel quantization to filament slot; one undo step |
| `paint_template` | Apply a bundled recipe; `auto=true` (D21b) fingerprints the model and resolves automatically |
| `list_paint_templates` | Enumerate bundled recipes |
| `find_similar_recipe` (D22) | Rank bundled recipes by geometric fingerprint similarity |
| `suggest_palette_for_recipe` (D22) | Auto-remap a recipe's named palette to the user's loaded filaments |
| `save_paint_recipe` / `load_paint_recipe` / `list_paint_recipes` / `delete_paint_recipe` (D18j) | Persistent paint sessions |
| `flush_actions` (D18g) | Wait for pending paint mutations to drain (fixes only_tagged race) |

Every spatial paint tool accepts the same paint plumbing args:

- `kind`: `"color"` (default) | `"support"` | `"seam"` | `"fuzzy_skin"`
- `tag`: integer (0..32 for color slots, 0..2 for support/seam,
  0..1 for fuzzy skin)
- `merge`: `"replace"` (default) | `"only_unpainted"` |
  `"only_tagged"` (with `where_tag`)
- `session_id` (optional): route the paint into a headless session
  instead of the live model. See "Headless paint sessions" above.

Each live-path call emits a single
`WorkspaceAction.PaintTriangleSet` ⇒ one `paint_undo` step
regardless of how many triangles got painted (an 80 K-tri
projected-mask paint is one undo). Session-routed calls don't
emit `paint_undo` events at all — `commit_paint_session` produces
exactly one undo step covering the whole session.

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

## D22 — LLM-painting amplifiers

A late-2026 add bundle of eight tools that compress the typical
"plan → paint → verify" loop:

- **`render_montage`** (now mode-configurable): one PNG with all six
  ortho views, labelled. Use BEFORE picking anchors so the LLM has
  spatial context without enumerating views.
- **`paint_semantic_region`** + **`prime_region_cache`**: paint by
  segmentation region id rather than triangle list. The
  introspection tools (`get_model_semantic_regions`,
  `get_curvature_segmentation`, `get_model_components`,
  `find_recessed_features`) auto-publish into the cache, so the
  typical flow is "introspect → paint_semantic_region(region_id, …)".
  Triangle index lists never cross the wire — important for huge
  meshes where one region can hold 50K+ tris.
- **`paint_stroke`**: polyline brush. Densifies the polyline at
  `radius/2` spacing, finds the nearest mesh triangle to each
  sample, then unions per-sample geodesic discs. Respects dihedral
  hard edges (so a cheek stroke doesn't bleed onto the nose).
- **`detect_symmetry`** + **`paint_with_mirror axis="auto"`**: score
  X/Y/Z symmetry by random-sampled mirror partner search; cache the
  best axis on the model. `paint_with_mirror axis="auto"` reads
  that cache so the LLM never has to guess. Errors closed if no
  axis crosses the threshold.
- **`render_paint_session_diff`**: one PNG with three panels —
  `before` (session start), `after` (current), `delta` (red over
  faded grayscale). The session's initial paint is frozen at
  `begin_paint_session` so this works without remembering a token.
- **`find_similar_recipe`**: rank bundled recipes by geometric
  fingerprint similarity (sorted bbox aspect, area/volume^(2/3)
  shape factor, log component count, log recess count). Use BEFORE
  `paint_template` when the model name doesn't match an alias.
- **`suggest_palette_for_recipe`**: read a recipe's named
  `default_palette` (e.g. `{"yellow": 2}`), map each tag name to
  RGB, find the closest user filament by Lab distance. Returns a
  `palette_remap` you can pass straight to `paint_template`.
- **`score_paint_against_reference`**: send the current rendered
  paint + a reference image to Claude's vision API; receive
  `{score, comment, regions[]}`. Pair with the session loop —
  iterate while `score < 0.85`.

The bundle is designed so a small vision LLM can drive a Pikachu-
class paint to convergence with these tools alone:

1. `render_montage(mode="solid")` → orient.
2. `find_similar_recipe` → "funko_pop_pikachu, sim=0.91".
3. `suggest_palette_for_recipe` → palette_remap.
4. `detect_symmetry` → "best=x".
5. `begin_paint_session`.
6. `paint_template(model_kind=..., palette_remap=...)`.
7. `render_paint_session_diff(view_name="iso")` → check work.
8. `score_paint_against_reference(reference=…)` → grade 0.78,
   notes "ears unpainted".
9. Targeted `paint_semantic_region` / `paint_with_mirror axis=auto`
   + `paint_stroke` corrections. Loop steps 7-9 until score ≥ 0.85.
10. `commit_paint_session`.

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

## Workflow: iterative refinement with sessions

For multi-step LLM work (5+ paint primitives per model), wrap the
loop in a session so the user's spatial scene only updates once:

1. `begin_paint_session { model_id }` → grab `session_id`.
2. Plan + execute paint primitives, **all passing `session_id`**.
   Renders also pass `session_id` so verification reflects the
   in-progress session state, not the live model.
3. After each step: `render_view { session_id, view_name }` (or
   `render_views_grid`) to verify. If wrong, paint again with
   different args — there's no `paint_undo` inside a session, but
   `merge='replace'` over the same triangles is the equivalent.
4. Optional sanity check: `get_paint_session_diff { session_id }`
   for a coverage histogram (how many tris on each tag, broken
   down by kind).
5. When happy: `commit_paint_session { session_id }` →
   atomically replaces live paint, fires one rebake, one undo
   step. The session is auto-discarded on success.
6. If the iteration went off the rails:
   `discard_paint_session { session_id }` → live model untouched.

Triangle IDs from `get_model_geometry` are stable for the
session's lifetime as long as no mesh-mutating action runs (see
the stability section above). If you need to repair / cut /
boolean / split / emboss / simplify / edit volumes mid-session,
discard first.

## Hard rules for the LLM

- Do not call `slice_active_plate` or `save_*` unless the user
  asks.
- Do not use more than 6 distinct filament slots in one model
  unless `list_slot_colors` reports more.
- Re-fetch `get_model_geometry` after any mesh-mutating action;
  triangle IDs are invalidated.
- Tools return `isError: true` for "the tool ran and failed"
  cases; respect that and re-plan.
- When you expect to paint more than ~3 primitives on the same
  model, open a `begin_paint_session` first. Always close
  sessions with `commit_paint_session` or
  `discard_paint_session` — leaving them open wastes the LRU
  slot (cap = 8). Don't run mesh-mutating actions while a session
  is open against the same model.

## Recovery patterns

| Symptom | Cause | Recovery |
|---|---|---|
| `painted_count: 0` | Seed missed geometry | Re-render in `triangle_id` mode, pick interior pixel, `resolve_image_pixel`, retry |
| `paint_*` returns isError "Couldn't build a paint BVH" | Source mesh missing or unreadable | `get_model_geometry` should also fail — check `list_placed_models` |
| `tri_id` invalid after a mesh edit | Mesh-mutating action ran | Re-fetch `get_model_geometry`, re-issue `get_model_semantic_regions` |
| `paint_projected_mask` paints both sides of a thin wall | `depth_mode: "all_hits"` was used | Re-do with `front_facing_only` |
| `paint_*` (with `session_id`) errors "Session ... tri_count=N" | Mesh-mutating action ran mid-session | `discard_paint_session`, `get_model_geometry`, `begin_paint_session` again |
| `commit_paint_session` reports `noop: true` | Session never mutated | Expected when you discard before painting; otherwise something silently rejected the mutations — re-check args |
| `begin_paint_session` returns "Couldn't build a paint BVH" | Same as live path; BVH not ready | Wait one tool call, retry — the LLM rarely hits this on a model that's been on the bed |

## Reference

For implementation details and the full design rationale: see
[`AI_PAINT_DESIGN.md`](AI_PAINT_DESIGN.md). For session-level state
see `dev.orcaxr.app.mcp.AiSessionState` (camera presets + render
artifact LRU). Tools are registered in
`dev.orcaxr.app.mcp.McpController.registerAllTools`.
