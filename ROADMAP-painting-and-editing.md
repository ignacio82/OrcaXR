# OrcaXR Roadmap — Painting & Object Editing

Sibling of [ROADMAP.md](ROADMAP.md) split out under the parent's "keep this file under ~600 lines" maintenance rule. Conventions, status legend, and how-to-use are identical to the parent — read [ROADMAP.md](ROADMAP.md) first if you haven't.

This file is the single source of truth for **section D** items only. Everything else (engine correctness, XR UI, connectivity, architecture, profiles, open questions) stays in [ROADMAP.md](ROADMAP.md). Cross-references that point at A/B/C/E/F/G items resolve in the parent file.

## D. Painting / object editing extensions

### D1. Paint persistence 🟢 Shipped — local cache + 3MF round-trip

> **Files:** `PaintCacheStore.kt`, `PaintCacheStoreTest.kt`, `MainActivity.kt::previewStl` restore + `LaunchedEffect(placedModels.map { … paintFilamentIndex/supportFlags/seamFlags })` save.

`PaintCacheStore` keys per-triangle paint by source-file SHA-256. Storage is `${filesDir}/paint_cache/<sha>.bin` (raw header + three optional ByteArrays for paintFilamentIndex / supportFlags / seamFlags) instead of DataStore Preferences — base64-encoding 1.4 MB arrays through Preferences would be slower and more memory-thrashing than a direct file-cache mirror of the existing GLB/STL cache pattern. Atomic writes via tmp+rename, mtime-based LRU at `MAX_ENTRIES = 50`.

Wired into `XrShell`:
- **Restore:** in `previewStl`, after `StlReader.read` returns `triCount`, hash the source and call `paintCache.restore(hash, triCount)`. On hit, copy the three arrays into the matching PlacedModel via a `placedModels.map { copy(...) }`. Restore only fires when the model has no paint yet so a cache hit can't clobber fresh in-session edits.
- **Save:** a debounced (300 ms) `LaunchedEffect` keyed on every model's `paintFilamentIndex / supportFlags / seamFlags` writes via `Dispatchers.IO`. A clear-paint round-trips because `PaintCacheStore.save` deletes the entry when every array is null/all-zero.

**Tests:** `PaintCacheStoreTest` covers round-trip, tri-count mismatch, missing-file, blank-array prune, null-array prune, LRU eviction at the cap boundary, hash stability, content-divergent hashes, corrupt-file fallback, `Entry.equals`, `sizeBytes` growth + clear, fuzzy-skin round-trip, fuzzy-only persistence, all-blank fuzzy survival.

**Shipped:** commit `c913e4e` — `PaintCacheStore` + on-load restore + on-mutate save + 10 tests. Follow-up commit `e8133db` — `PaintCacheStore.sizeBytes()`, "Storage" section in `ControllerHelpCard` showing cache size + entry count + Clear button (Toast on clear, helpVersion bump so the row refreshes immediately), `formatBytes` helper + 1 unit test, +1 PaintCacheStore unit test for the new `sizeBytes` method. Follow-up commit `cc75ead` — `PaintCacheStore` v2 adds `fuzzySkinFlags`, v1 entries still load (fuzzy null) and re-save as v2 on next mutation. Final commit `d2d30d2` — `nativeSaveAs3mf` writes all four facet annotations (color/support/seam/fuzzy) onto the source mesh's first volume before `store_3mf`, so a 3MF saved with painted regions reopens in desktop OrcaSlicer with identical paint.

### D2. Custom support point placement ⚪ Deferred — SLA-leaning, FDM-only stack today

Per-point support placement (vs paint-region enforcer/blocker). Upstream uses `GLGizmoSlaSupports`. Useful for FDM tree-supports tuning but defer until a user requests it; current Support Enforcer paint mode covers the common case.

### D3. Brim ear painting 🟢 Shipped

> **Files:** `BrimEarPoint` data class in `PlacedModel.kt`, `PaintMode.BrimEars` in `PaintBrush.kt`, `apply_orcaxr_brim_ears` JNI helper, `nativeSlice` + `nativeSaveAs3mf` jBrimEars parameter, `PlacedModel.brimEars` field, `MeshBvh.triangleCentroid`, `TopNavigationPill` "Place brim ears" toggle.

Mirrors upstream OrcaSlicer's `GLGizmoBrimEars`. PaintMode.BrimEars converts a click to a `BrimEarPoint` at the picked triangle's centroid (mesh-local mm). MOVE is ignored so a drag doesn't sprinkle dozens; 1 mm dedup gate prevents finger-tap jitter stacks. Each PlacedModel collects its ears, which flow into `ModelObject::brim_points` at slice + saveAs3mf time.

**Shipped:** commit `69b783b` — data + JNI write + click-to-add + UI toggle + count badge + clear-all. 3D visual marker spheres deferred (entity-lifecycle work for a later session).

### D4. Embossing / SVG inset / text-on-object 🟢 Shipped

> **Files:** `slic3r_jni.cpp::nativeBuildTextMesh / nativeBuildSvgMesh / nativeApplyEmboss`, `EmbossOp.kt`, `EmbossAssets.kt`, `EmbossPanel` in `UiPanels.kt`, `MainActivity::runEmboss` + `embossTargetModelId`, `app/src/main/assets/fonts/`, `app/src/main/assets/svg/heart.svg`, `EmbossOpTest.kt`.

Compose-SpatialPanel-native text-on-mesh + SVG inset, wired through libslic3r `Emboss::text2shapes` (TTF via stb_truetype), `NSVGUtils::to_polygons`, `Emboss::polygons2model` + `ProjectZ`, and `MeshBoolean::mcut::make_boolean` for the boolean. The per-row 𝐀 icon opens an `EmbossPanel` SpatialPanel; user picks Text/SVG, font (DejaVu Sans Bold or DejaVu Serif bundled), depth/size/offset/rotation/mode (ADD-raise / SUB-engrave); Apply runs the build + boolean on the libslic3r dispatcher and replaces `PlacedModel.source` with the result. Top-of-bbox auto-placement; rotation around Z; ±60mm XY translate. Paint state is dropped on apply (gotcha #28).

**Shipped:** native build + boolean (3 JNI entries), `EmbossOp` data classes + transform helpers, `EmbossAssets` font/SVG staging, `EmbossPanel` Compose UI, `EmbossOpTest` instrumented coverage (text bbox, SVG bbox, ADD grows +Z, SUB preserves bbox + carves volume).

### D5. SLA hollow + drainage holes ⚪ Deferred — FDM stack only

Upstream's `GLGizmoHollow` is SLA-leaning. U1 + Centauri Carbon are FDM. Out of scope until a resin printer enters target hardware.

### D6. Measure tool ⚪ Deferred

Hand-track distance/angle between picked points/edges/faces (upstream's `GLGizmoMeasure`). Useful but additive; user hasn't requested it.

### D7. Multi-step undo for paint 🟢 Shipped

> **Files:** `PaintHistory.kt`, `PaintHistoryTest.kt`, `PaintInput.kt` (UP forwarding), `MainActivity.kt` (begin/end stroke wiring + Undo/Redo callbacks), `UiPanels.kt::TopNavigationPill` (Undo/Redo chips).

Per-PlacedModel ring buffer of paint strokes, each capturing snapshots of the four paint kinds (color/support/seam/fuzzy) at stroke entry and exit. UP action sentinel (hitTri = -1) closes the stroke. Open-stroke undo rolls back without consuming a slot ("Ctrl-Z mid-word"). Cap MAX_DEPTH=20.

**Shipped:** commit `5cf152e` — `PaintHistory` + 11 tests + UI bindings.

### D8. Smart fill / connected-region paint 🟢 Shipped

> **Files:** `MeshBvh.smartFillBfs`, `PaintBrush` (`smartFill` + `smartFillAngleDeg` fields), `MainActivity.kt::pickTriangles` dispatcher, `UiPanels.kt::TopNavigationPill` Smart toggle + Fill chip.

Upstream's `GLGizmoPainterBase::ToolType::BUCKET_FILL` equivalent. BFS along shared-vertex adjacency (already cached); each edge step accepted iff `dot(curN, nN) >= cos(angle)`. Stepwise comparison lets the fill traverse curved surfaces within angle budget per step. Default 30°, presets 15/30/45/60/90°. Bounded at 65 536 triangles per fill.

**Shipped:** commit `7534f25` — `smartFillBfs` + 6 BVH tests + UI toggle + angle cycle.

### D10. Fuzzy Skin paint 🟢 Shipped

> **Files:** `PaintMode.FuzzySkin` in `PaintBrush.kt`, `PlacedModel.fuzzySkinFlags`, `apply_orcaxr_fuzzy_skin` JNI helper, `nativeSlice` jFuzzySkinFlags parameter, `nativeSaveAs3mf` round-trip, `UiPanels.kt::ModelDetailsPanel` "Apply fuzzy skin" button, `PaintCacheStore` v2 forward-compat loader.

Mirrors upstream OrcaSlicer's `GLGizmoFuzzySkin`. Per-triangle ByteArray on PlacedModel; state 1 = FUZZY_SKIN. Flows into `ModelVolume::fuzzy_skin_facets` at slice and save time so libslic3r's fuzzy-skin texture pass roughens only the painted region. Brush radius / smart fill / undo / 3MF round-trip all apply uniformly.

**Shipped:** commit `cc75ead` — JNI helper + dispatch + UI + cache + 3 PaintCacheStore tests.

### D11. Brush radius / smart-fill stick adjust 🟢 Shipped

> **Files:** `MainActivity.kt` Prepare-mode pump, `ControllerHelpCard.kt` entry list.

When paint mode is active the left stick's Y axis nudges brush radius (0..50 mm at ~10 mm/s) or smart-fill angle (1..90° at ~1.5°/tick), instead of moving the model. X still cycles model rotation.

**Shipped:** commit `f85380c`.

### D9. 3MF round-trip for per-object Object Settings 🔴 Not started

> **Files:** `nativeSaveAs3mf` (already preserves `ModelVolume::config` via libslic3r `store_3mf`); the gap is whether OrcaXR-authored `PlacedModel.configOverrides` is written to and read from `Metadata/model_settings.config`.

📌 **Open question:** confirm we want per-object `configOverrides` (e.g., `layer_height=0.4` on a single object) to persist into 3MFs. Currently in-memory only.

**Implementation outline (post-decision):**
1. Native: extend `nativeSaveAs3mf` to also write per-object overrides into the 3MF (libslic3r already serializes `ModelObject::config` if it's set; OrcaXR's overrides must be transferred from `PlacedModel.configOverrides` onto `ModelObject::config` before save).
2. Native: extend the load path so loaded 3MFs populate `PlacedModel.configOverrides` from `ModelObject::config`.
3. Round-trip test: load a fixture with overrides, save through `nativeSaveAs3mf`, reload, assert overrides match.

### D12. Add primitive shapes (cube / cylinder / sphere / cone / disc / torus / slab) 🟡 Shipped — MCP + JNI; SpatialPanel UI deferred

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::nativeBuildPrimitiveStl`, `app/src/main/java/dev/orcaxr/app/Primitives.kt`, `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt::buildPrimitiveStl`, `app/src/main/java/dev/orcaxr/app/mcp/tools/PrimitiveTools.kt`, `PrimitivesTest.kt`.

JNI calls libslic3r's `its_make_cube/cylinder/sphere/cone/torus` (TriangleMesh.hpp:336) and writes a binary STL via `TriangleMesh::write_binary`. Output is XY-centered with Z-min == 0 so callers paste it straight onto the bed. Disc = short cylinder; slab = cube alias kept distinct for ergonomic naming. The MCP tool `add_primitive(kind, params, mode, target_model_id?)` routes through the existing `LoadModelFromPath` (mode=object, default) or `AddVolumeToModel` (mode=part/negative/modifier/enforcer/blocker) — every D14 volume kind is reachable in one call. `list_primitives` enumerates the catalog so the LLM can discover param names. Defaults: 20 mm cube, Ø10×20 mm cylinder, Ø10 sphere, Ø10×20 cone, Ø10/3 torus, Ø15×1 disc, 40×40×2 slab; facet angle defaults to 2° (6° for torus).

**Shipped pieces:** native builder + Kotlin engine wrapper + 2 MCP tools + 8 unit tests pinning the param contract. The dedicated `AddPrimitivePanel` SpatialPanel is deferred to a follow-up — current MCP surface is enough to use every kind and every mode end-to-end.

Upstream OrcaSlicer's "Add primitive" menu seeds a stock mesh into the workspace either as a new object or as a sub-volume of the selected object. libslic3r already exports every helper we need (`its_make_cube` / `its_make_cylinder` / `its_make_sphere` / `its_make_cone` / `its_make_torus` — see `TriangleMesh.hpp:336-358`); slab is a cube alias kept distinct for ergonomic naming. So this is a JNI shim that invokes the helper, writes a binary STL, and routes through the existing `onFileSelected` / volume-attach paths.

**Exit criteria:** From XR or from MCP, a user can drop a 20 mm cube, a Ø10×20 mm cylinder, and a Ø10 sphere onto the bed and slice them as one project. From MCP, attach a Ø6×3 mm cylinder as a negative volume on the selected model and slice — the gcode shows a Ø6 hole at the placement. ✅ Met via MCP (`add_primitive` + `add_volume_to_model`).

### D13. Handy model library (Benchy, Orca Cube, Voron Cube, Stanford Bunny, …) 🟡 Shipped — assets + MCP; in-XR picker UI deferred

> **Files:** `app/src/main/assets/handy_models/` (8 vendored meshes, 1.5 MB total), `app/src/main/java/dev/orcaxr/app/HandyModelCatalog.kt`, `app/src/main/java/dev/orcaxr/app/mcp/tools/HandyModelTools.kt`, `HandyModelCatalogTest.kt`, `NOTICE.md` AGPL attribution. Draco is already linked into the native build (`CMakeLists.txt:167`) so the `.drc` files load directly via libslic3r; OrcaCube is a bundled `.3mf`.

`list_handy_models` enumerates the catalog (id / display name / 1-line hint). `add_handy_model(id, mode?)` stages the asset to `cacheDir/handy/<filename>` (idempotent) and routes through the same `LoadModelFromPath` action a file-picker pick uses, so paint restore / GLB bake / bed fit / bed collision all run identically. `mode='replace'` (default) clears the bed; `mode='add'` appends.

**Shipped pieces:** asset vendoring + catalog + 2 MCP tools + 8 unit tests + NOTICE entry. The `HandyModelPanel` SpatialPanel + Empty State CTA are deferred to a follow-up — the MCP surface already covers the exit criteria and the in-XR catalog browser is layout work, not a slicing milestone.

Upstream's "Add handy model" submenu seeds well-known calibration / tuning models with one tap: 3DBenchy, Orca Cube v2, Voron Design Cube v7, Stanford Bunny, Cali Cat, Orca Tolerance Test, Autodesk FDM Test (`ksr_fdmtest_v4.drc`), Orca String Hell. They're the canonical reference prints — handy when a user wants to dial in a new filament without hunting for an STL on the web.

**Exit criteria:** A user can tap "3DBenchy" from a fresh Empty State and end up with the boat sliced + previewable + sendable to a printer in three taps. From MCP: `add_handy_model(id="benchy")` then `slice_active_plate` works from cold install. ✅ MCP path met; in-XR Empty State CTA is the remaining UI follow-up.

### D14. Modifier volume types (negative / parameter modifier / support enforcer / support blocker) 🟢 Shipped

> **Files:** `PlacedModel.kt::ModelVolumeType` (enum mirrors `Slic3r::ModelVolumeType` ordinals), `PlacedModel.kt::PlacedVolume.type`, `slic3r_jni.cpp::nativeSlice` extra-volumes path (jExtraVolumePaths/jExtraVolumeTypes/jExtraVolumeTransforms), `SlicerEngine.slice` `extraVolumes` parameter, `MainActivity.kt::PickerMode.AddVolume(type)` + `launchPickerForVolume`, `UiPanels.kt::ModelDetailsPanel` 5 chips (Part / Modifier / Negative / Sup. enf. / Sup. blk.), `mcp/tools/WorkspaceTools.AddVolumeToModel` (`type` arg), `ModelVolumeTypeTest`.

`add_volume_to_model` attaches a mesh of any of the five `ModelVolumeType` values (`GUI_Factories.cpp:289-296`). The runtime difference is purely how libslic3r treats the volume during slicing: NEGATIVE_VOLUME subtracts geometry (the magnet-pocket use case — paired with **D12** + **A11**); PARAMETER_MODIFIER applies a `ModelConfig` overlay only inside its bbox-intersection with the parent (per-volume settings UI is **D16**); SUPPORT_ENFORCER / SUPPORT_BLOCKER override the `enforcers` / `blockers` field on `ModelObject::supported_facets` for that region.

**Shipped pieces:** Kotlin `ModelVolumeType` ordinals match libslic3r's `Model.hpp:341-348` exactly so the int passes straight through the JNI without translation; the `PickerMode.AddVolume(type)` flow + 5 UI chips + the MCP `type` arg all drive the same per-volume `nativeSlice` path. Multi-volume preview rendering (semi-transparent enforcer/blocker overlays, wireframe modifier, NEGATIVE-volume cutaway in `nativeWriteColoredGlb`) is the remaining polish — out-of-scope here because the slice path already honors every kind correctly; the user just doesn't see a visual cue per kind in the in-XR preview yet.

**Exit criteria:** Drop a Ø6×3 mm cylinder (D12) as a NEGATIVE volume on a 20 mm cube, slice → gcode shows a Ø6 hole. Same with a SUPPORT_ENFORCER on the underside of a Benchy chimney → gcode adds supports inside the enforcer bbox where the default heuristic skipped them. Round-trips through `save_project_as_3mf`. ✅ Met.

### D15. Standalone text & SVG primitives (vs D4's boolean emboss) 🟡 Shipped — add_object via MCP; NEGATIVE/MODIFIER volume variants deferred

> **Files:** `WorkspaceAction.AddTextOrSvgObject`, `onAddTextOrSvgObject` binding callback, MainActivity-side handler that builds the extruded mesh via the existing `SlicerEngine.buildTextMesh / buildSvgMesh` and feeds the result through `onFileSelected` (so paint cache restore + bedFit + bedCollision run identically). `emboss_model` MCP tool extended with `mode='add_object'` (and the corresponding `model_id` requirement relaxed for that mode).

D4 ships text/SVG as a boolean op against an existing host model; D15's add_object mode is the complementary path that drops a fresh PlacedModel on the bed without a host. Same backend as D4 — `Emboss::text2shapes` for text, `NSVGUtils::to_polygons` for SVG, `polygons2model` for the extrusion — minus the `MeshBoolean::mcut::make_boolean` step. The result is a normal PlacedModel that can be sliced, painted, scaled, transformed, or used as a host for further emboss / volumes / etc.

NEGATIVE / MODIFIER volume variants (drop "TEXT" as a `NEGATIVE_VOLUME` on a 20 mm cube to deboss letters) are deferred — they need a per-volume add path different from `add_volume_to_model`'s file-picker route, and the standalone-object case covers most of the asked-for functionality (nameplates, signage, labels, SVG silhouette parts). Follow-up scoped separately.

**Exit criteria:** Author "HELLO" as a 5 mm-tall, 2 mm-deep PlacedModel on the bed and slice it. ✅ Met via `emboss_model(kind='text', text='HELLO', size_mm=5, depth_mm=2, mode='add_object')`. NEGATIVE/MODIFIER volume variants ⏳ deferred.

### D16. Per-volume Object Settings panel 🔴 Not started

> **Files (planned):** new `VolumeSettingsPanel.kt`, extend `PlacedVolume.config: ModelConfig` (already exists per Phase 3 "per-object Object Settings"), JNI thread for `ModelVolume::config` already wired. The gap is a UI surface to author per-volume overrides.

Once **D14** lands, a PARAMETER_MODIFIER volume needs an editor — the whole point is to apply different settings inside its bbox-intersection with the parent. Upstream surfaces this through its right-hand "Object" panel with a curated key picker (`GUI_Factories.cpp::create_settings_popupmenu` + `FREQ_SETTINGS_BUNDLE_FFF`). For OrcaXR the natural surface is to extend the existing per-row `ModelDetailsPanel` with a per-volume sub-panel.

**Implementation outline:**
1. Per-volume settings UI mirrors the project-level Quality / Strength / Speed tabs, but scoped to a curated subset of keys per `ModelVolumeType` (modifier: layer_height / sparse_infill_density / wall_loops / sparse_infill_pattern / top_shell_layers / bottom_shell_layers; enforcer/blocker: support_threshold_angle / support_filament; negative: no settings).
2. Validation reuses **B8**'s `NumericValidation.printSettingRanges`.
3. 3MF round-trip already works via libslic3r `store_3mf` which serializes `ModelVolume::config`; **D9** captures the gap on the load direction.
4. MCP: `set_volume_overrides(model_id, volume_id, overrides: Map<String, String>)` + `get_volume_overrides`.

**Exit criteria:** Attach a PARAMETER_MODIFIER cube spanning the bottom 5 mm of a 20 mm cube, set its `sparse_infill_density=100`. Sliced gcode shows 100 % infill in the lower 5 mm and the project default everywhere else. Same overrides land via MCP and round-trip through 3MF.

### D17. Mesh simplify (quadric edge collapse) 🟡 Shipped — JNI + MCP; SimplifyPanel SpatialPanel deferred

> **Files:** `app/src/main/cpp/slic3r_jni.cpp::nativeSimplifyMesh` (wraps libslic3r `its_quadric_edge_collapse`), `SlicerEngine.kt::simplifyMesh` Kotlin wrapper + `SimplifyResult` data class, `WorkspaceAction.SimplifyModel`, `WorkspaceBinding` `onSimplifyModel` callback, `MainActivity::runSimplify` (paint-state sweep mirroring `runRepair`), `WorkspaceTools.SimplifyModel` MCP tool. `SimplifyModelToolTest` covers the MCP tool's arg-parsing + action-emission contract.

JNI calls libslic3r's Garland-Heckbert quadric edge collapse from `QuadricEdgeCollapse.hpp` (already linked into our `liblibslic3r.a` via the existing CMake). The Kotlin caller passes `(input, output, targetTriangleCount, maxError)`; the native side aggregates the first object's MODEL_PART volumes into a single TriangleMesh, runs the in-place collapse, and writes a fresh single-object 3MF. Like repair, simplify mutates topology — `runSimplify` drops paint / supports / seam / fuzzy / brim ears / per-volume metadata when it replaces `PlacedModel.source`. `simplify_model(model_id, target_triangle_count, max_error?)` MCP tool emits the action and routes through the same `applyPaintMutation` sweep + preview re-bake path repair / cut / boolean already use. The dedicated `SimplifyPanel` SpatialPanel (slider + before/after stats) is the remaining UI follow-up — current MCP surface is enough to use the feature end-to-end.

Heavy STLs (1M+ triangles — anything from Thingiverse + a typical artistic scan) thrash both BVH paint (gotcha #11f's allocation budget) and toolpath-rebake debounce. Upstream's `GLGizmoSimplify` invokes `its_quadric_edge_collapse` from `libslic3r/QuadricEdgeCollapse.hpp` — already in our linked libslic3r, no new patches.

**Exit criteria:** A 1.4M-tri dragon simplifies to 200 K tris in <5 s on Galaxy XR with visible silhouette preservation; paint mode stays under the 256 MB JVM cap on the simplified mesh; round-trip via `save_model_as_stl` produces a valid binary STL. ✅ MCP path met (`simplify_model`); on-device 1.4M-tri benchmark is the remaining instrumented-test follow-up.

### D18. AI-paint authoring upgrades (post-C9) 🟢 Shipped — all 10 sub-items live

Surfaced during the live "paint Pikachu Funko Pop" session against C9 (commits `4df6bf2`..`e44622d`). Painting rounded organic features (cheeks, eyes, ear interiors) via `paint_projected_mask` exposed three architectural gaps: 2D mask projection misses curvature wraparound, paired features need duplicate authoring, and feature anchoring from a render is eyeball-and-guess. Each fix below is an MCP-tool addition on top of the existing C9 surface — pure Kotlin unless noted, no JNI rebuild.

**All 10 sub-items shipped** in 8 commits (`8d586fc` `819924a` `5b5e7d5` `3a7d823` `ee79545` `c96a9b9` `7e01a31` `25d34a5`). Tool surface grew from 18 to 29:
- D18a `paint_geodesic_disc` — Dijkstra surface walk with geodesic-radius + dihedral gates
- D18b `paint_with_mirror` — bilateral wrapper for any inner paint tool
- D18c `find_feature_anchors` — Claude vision API anchor finder (NormalSphere render → JSON anchors → tri ids)
- D18d `paint_projected_mask depth_mode='any_facing'` — keeps the lit hemisphere
- D18e `render_view(annotate=true)` — axis triad + bbox dim text + 10 mm scale bar
- D18f `render_diff(token_a, token_b)` — XOR cached renders, highlight changes
- D18g `flush_actions` — fixes the only_tagged race
- D18h hi-res tri-ID maps (1024 → 2048) + `resolve_image_pixel(radius_px)` neighbor sampling
- D18i `paint_template` + `list_paint_templates` — bundled recipes with named-tag palette resolution
- D18j `save_paint_recipe` / `list_paint_recipes` / `load_paint_recipe` / `delete_paint_recipe`

#### D18a. Geodesic surface paint primitive 🟢 Shipped (commit `8d586fc`) — biggest single quality win

> **Files (planned):** new `paint_geodesic_disc` in `AiPaintTools.kt` + helper in `AiPaintEngine.kt`. ~80 lines on top of `MeshBvh.smartFillBfs` (vertex-adjacency BFS already exists; add a per-step accumulating geodesic-distance gate + a cumulative-dihedral gate).

`paint_projected_mask` is the wrong tool for "paint the cheek bump" — rays only hit the front-facing patch of the bump, the curvature wraparound gets back-face-filtered out (Pikachu cheeks landed at 179 tris instead of the ~800 a true round disc on the surface would be). Need a primitive that walks the SURFACE outward from a seed, bounded by geodesic distance + a curvature gate, returning a connected disc that wraps around bulges naturally.

**Algorithm:** seed at `anchor_tri`. BFS via `MeshBvh.directNeighbors`. Per-step add `triangle_centroid → triangle_centroid` distance to running geodesic distance for that branch (Dijkstra-style: keep minimum distance per visited triangle). Stop a branch when `geodesic_dist > radius_mm` OR `cumulative_dihedral > max_dihedral_deg`. Returns a `PaintTriangleSet` like every other primitive.

**Tool:**
```
paint_geodesic_disc {
  model_id, kind, tag, merge,
  anchor: { tri_id } | { center_mm, ray_dir } | { camera_descriptor, x_px, y_px },
  radius_mm: float,                   // geodesic radius, NOT euclidean
  max_dihedral_deg?: float = 60,      // 60° lets it wrap a hemisphere; 30° stays near-planar
  max_triangles?: int = 65536
}
```

**Exit criteria:** Pikachu cheek paint with `radius_mm=8, max_dihedral_deg=60` lands ≥ 600 triangles wrapping smoothly around the cheek bulge (vs M4 projected-mask's 179 front-only). Test fixture: a sphere — geodesic disc with `radius_mm=R, max_dihedral=180°` paints a polar cap of expected area `2πR(1-cos(θ))`.

#### D18b. Symmetry-mirrored paint 🟢 Shipped (commit `8d586fc`)

> **Files (planned):** new `paint_with_mirror` wrapper tool in `AiPaintTools.kt`. ~40 lines. Takes any other `paint_*` action's args, mirrors the seed/center/anchor/polygon coordinates across the chosen axis, and emits two `PaintTriangleSet` actions (or one merged set).

Pikachu has paired features (eyes, cheeks, ears). I duplicated every polygon — error-prone, wastes tokens. One `paint_with_mirror` call replaces N×2 calls.

**Tool:**
```
paint_with_mirror {
  axis: "x" | "y" | "z",              // bbox-center axis to mirror across
  inner_action: { ... }                // any paint_* tool's args (verbatim)
}
```

For `paint_geodesic_disc`: mirror the anchor point's mesh-mm coordinates. For `paint_sphere`: mirror the center. For `paint_projected_mask`: mirror polygon X coords (in pixel space) — works because preset cameras face an axis.

**Exit criteria:** `paint_with_mirror(axis=x, inner=paint_geodesic_disc(anchor=left_cheek, ...))` paints both cheeks symmetrically in one call; tri counts match within 5 % on a near-symmetric mesh.

#### D18c. Vision-LLM feature anchors 🟢 Shipped — highest leverage, introduces outbound dep

> **Files (planned):** new `find_feature_anchors` tool in `AiVisionTools.kt`. Internally renders a view, makes a Claude vision-API call (cheapest model — `claude-haiku-4-5`) with the PNG + a hint text, parses the returned bbox/anchor JSON, resolves each pixel to a `tri_id` via the existing `resolve_image_pixel` path. Adds an outbound HTTPS dep (Anthropic API) + an API key in `McpSettings`.

For `find Pikachu's cheek` I eyeballed pixel coords from a normals render. A vision-LLM sub-call would do this faster + more reliably. Once anchors come back as triangle ids, `paint_geodesic_disc` paints by name.

**Tool:**
```
find_feature_anchors {
  model_id,
  view_name?: "iso",
  hint: "the cheeks of a Pikachu Funko Pop",       // free-form English
  expected_count?: int = 2
}
→ {
  anchors: [
    { name: "left_cheek",  tri_id: 12345, pixel: [x,y], confidence: 0.92 },
    { name: "right_cheek", tri_id: 67890, pixel: [x,y], confidence: 0.91 },
  ]
}
```

**Risk:** outbound dep (network + API key). Cost gate: bill the user's Anthropic key, not OrcaXR's. Privacy gate: render is anonymized geometry (no scene context, no user ID).

**Exit criteria:** Hit-rate ≥ 80 % on a 10-figure benchmark (Pikachu, Bulbasaur, Mario, Sonic, Stitch, Totoro, Mickey, …) for canonical anchors (eyes, cheeks, mouth, ear-tips).

#### D18d. `paint_projected_mask depth_mode="any_facing"` 🟢 Shipped (commit `819924a`)

Current `front_facing_only` keeps just the front-most ray hit; `all_hits` keeps every triangle along the ray. Add a third mode: `any_facing` — keep any triangle whose normal is within 90° of `-camera_dir` (the lit hemisphere), regardless of ray-hit ordering. Catches curvature wraparound like the cheek bulge without painting the model's back side.

**File:** `AiMaskProjection.kt` adds one enum value + one branch. ~10 lines.

**Exit criteria:** Cheek paint via `any_facing` mode lands within 20 % of the geodesic-disc result (D18a), validating the 2D-driven path remains useful for shapes that aren't rotationally symmetric.

#### D18e. Annotated render (axis triad + bbox dims + scale bar) 🟢 Shipped

`render_view(annotate=true)` burns a small RGB axis triad in one corner, the bbox extents on the opposite corner, and a "10 mm" scale bar at the bottom. Lets the LLM read coordinates directly off the render instead of computing them from the camera descriptor.

**File:** `AiRenderEngine.kt` — post-rasterize draw step. ~120 lines (axis lines, font glyphs from a tiny bundled bitmap font; alternative: pre-rendered axis-triad PNGs blitted in).

**Exit criteria:** Render with `annotate=true` shows a clearly-readable axis triad + bbox-mm labels visible at 256 × 256.

#### D18f. Render diff tool 🟢 Shipped (commit `5b5e7d5`)

`render_diff(token_a, token_b) → PNG` returns the pixel-XOR of two cached render artifacts (already keyed by content hash in `AiSessionState`), with changed pixels in red. Lets the LLM verify a paint action did what it expected in one call instead of comparing two PNGs visually.

**File:** new `AiVisionTools.RenderDiff`. ~40 lines (loop over both pixel buffers, write the delta into a fresh PNG, push to `AiSessionState`).

**Exit criteria:** Paint a cheek → `render_diff` between before/after tokens highlights only the cheek region; total red pixel count correlates with painted_count in the prior tool result.

#### D18g. Action queue flush 🟢 Shipped (commit `819924a`) — fixes the only_tagged race

> **Files (planned):** new `flush_actions` tool. Tracks the action queue's drain via a `WorkspaceModel.lastDrainedActionId: StateFlow<Long>` + per-emit ID counter; tool blocks until `lastDrainedActionId >= my_emit_id`.

I hit `replace_paint_tag(3→1)` then `paint_slab(only_tagged where_tag=1)` and got `painted=0` because the `applyMergeFilter` saw the pre-replace state (documented in the Pikachu session transcript). A single `flush_actions` call between mutating + read-after-write paints fixes it deterministically.

**Exit criteria:** scripted MCP transcript with `replace_paint_tag(A→B); flush_actions; paint_slab(only_tagged where_tag=B)` paints the expected count; without `flush_actions` it races; regression test under `app/src/test/resources/mcp_transcripts/`.

#### D18h. Higher-resolution + multi-sample triangle-ID maps 🟢 Shipped

`render_triangle_id_map` at 512 × 512 covers a 144 K-tri Pikachu at ~1.8 pixels per tri — many tris occupy <1 pixel and lose to z-fighting. Two upgrades:
1. Bump the cap from 1024² to 2048² (the rasterizer's already linear in pixel count; 4× cost is fine for one-shot ID maps).
2. Add `multi_sample_per_pixel` mode that returns the top-3 closest triangle IDs per pixel as separate channels in the response, so `resolve_image_pixel` can return a list when the LLM clicks near a tri boundary.

**Exit criteria:** 1.4 M-tri dragon at 2048² triangle-ID map covers ≥ 90 % of unique tris in ≥ 1 pixel each.

#### D18i. Painted-mesh feature templates 🟢 Shipped

> **Files (planned):** `assets/paint_templates/*.json` recipes. New tool `paint_template(model_kind, palette_remap)`.

Bundle named recipes for common models. `paint_template("funko_pop_pikachu", palette={"yellow":2, "black":1, "red":4, "white":3})` runs the canonical 8-call sequence (yellow base → ear tips → eyes → cheeks → mouth → ear interiors → back zigzag → tail tip → base disc). Version-controlled, regression-tested, "good enough by default" without LLM intervention.

Recipes are JSON: a list of paint primitive calls with bound named anchors that resolve via D18c.

**Exit criteria:** A bundled `funko_pop_pikachu.json` recipe paints the canonical Pikachu in <2 s with no LLM round-trips; produces ≥ 8 distinct painted regions; the same recipe scales correctly to a 0.5x or 2x variant of the model (Funko Pop sizes).

#### D18j. Persistent paint sessions 🟢 Shipped

`save_paint_recipe(name, model_id) → recipe_path` records the sequence of paint actions applied to a model since session start. `load_paint_recipe(path, model_id)` replays them. Combined with D18i, lets users (and the LLM) iterate on a paint design and snapshot the result for reuse.

**Storage:** `${filesDir}/paint_recipes/<name>.json`. Same LRU + atomic-write pattern as `PaintCacheStore`.

**Exit criteria:** Replay a saved recipe on a fresh load of the same source file; final paint state byte-identical to original.

#### D18k. Bigger-picture authoring direction

The cumulative effect of D18a–D18j is that the LLM authors paint by **named anchors** + **geodesic discs** + **mirroring**, instead of by **pixel polygons** + **2D projection**. The pixel-polygon path (M4 `paint_projected_mask`) stays as the escape hatch for irregular regions an LLM authors visually. The new path is for everything else, which is most things — Pokemon, Funko Pops, anything with paired bilateral features.

For the in-XR brush UI, D18a is also a quality win: a "paint a circle on the surface from where I touched" gesture is more controllable than radius-BFS on shared-vertex adjacency (which mixes geodesic + Euclidean in confusing ways). Hooking the XR brush to the same primitive closes the loop.

**Suggested ship order:** D18a (geodesic disc) → D18b (mirror) → D18d (any_facing mode) → D18g (flush) → D18f (render diff) → D18e (annotated render) → D18h (hi-res tri-ID) → D18c (vision anchors — biggest impact but biggest external dep) → D18i + D18j (templates + recipes — once the lower-level primitives are stable).

### D19. Advanced AI Paint Authoring (Organic Models) 🟢 Shipped — all 4 sub-items live

Painting highly organic characters (like Pikachu) perfectly pushes the limits of geometric primitives. The four sub-items below land the advanced segmentation + vision techniques needed to make organic painting hands-free. Three of the four (D19a, D19c, D19d) ride on the existing FindFeatureAnchors HTTP plumbing — vision-LLM API calls (matching D18c's pattern) replace the originally-planned on-device ONNX models, trading ~1¢/call for skipping a 60+ MB asset bundle and an ONNX runtime dependency. D19b is pure Kotlin (no outbound dep). Total tool surface grows from 29 (D18) to 33.

- D19a `generate_mask_from_point` — Claude Vision API outline-from-pixel + automatic polygon → triangle projection
- D19b `get_curvature_segmentation` — multi-scale dihedral-curvature 3D segmentation; complement to `get_model_semantic_regions` for organic / continuously-curved meshes
- D19c `paint_decal` — RGBA image → camera projection → per-pixel filament-slot quantization → single-step LoadPaintState
- D19d `get_mask_for_text` — Claude Vision API zero-shot text-to-mask + automatic projection

#### D19a. Vision-LLM 2D Segmentation From Point 🟢 Shipped

> **Files:** `AiVisionMaskTools.GenerateMaskFromPoint` in `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionMaskTools.kt`.

For organic shapes where curvature doesn't cleanly separate features (Pikachu's back stripes), the LLM struggles to author polygons by eyeballing tri-ID renders. `generate_mask_from_point(x_px, y_px, view_name?)` renders a normal-sphere view, asks Claude to outline the SAME feature the click landed on, and returns `{polygons, camera_descriptor, triangle_indices}` so the caller chains straight into `paint_projected_mask`. Mirrors the upstream "Segment Anything from a point" pattern using the existing FindFeatureAnchors HTTP plumbing — no on-device ONNX runtime, no MobileSAM bundle. Costs ~1¢/call at claude-haiku-4-5 vision rates; charged to the user's Anthropic key via `McpSettings`.

#### D19b. Multi-Scale Curvature 3D Segmentation 🟢 Shipped

> **Files:** `AiIntrospection.perTriangleCurvature` + `AiIntrospection.curvatureSegmentation` in `app/src/main/java/dev/orcaxr/app/AiIntrospection.kt`; `AiIntrospectionTools.GetCurvatureSegmentation` in `app/src/main/java/dev/orcaxr/app/mcp/tools/AiIntrospectionTools.kt`.

The legacy region-growing segmentation (`get_model_semantic_regions`) over-fragments organic models because it depends on cardinal-axis alignment of triangle normals — a continuously curved body always reads as "diagonal." `get_curvature_segmentation` computes per-triangle dihedral-curvature scores at two scales (direct neighbors + 1-ring neighborhood, max over both), region-grows from low-curvature seeds, and stops at curvature ridges via a `crease_threshold_deg` parameter. Output segments carry labels like `smooth_horizontal_top` / `gentle_diagonal` / `creased_vertical_side`. Pure Kotlin, no outbound dep — the right tool for "what segments make sense to paint individually" reasoning before the LLM commits to a sequence of `paint_geodesic_disc` / `paint_triangle_list` calls.

#### D19c. Decal / Texture Projection 🟢 Shipped

> **Files:** `app/src/main/java/dev/orcaxr/app/AiDecalEngine.kt`, `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintDecalTool.kt`.

Detailed features (eyes-with-pupils, mouths, small logos) take too many geometric primitives to author one-at-a-time. `paint_decal(image_base64, camera_descriptor, palette?)` reverse-projects an RGBA image through a camera onto the model and quantizes each touched triangle's sampled pixel to the closest filament-slot color (Euclidean RGB distance). One call paints an entire multi-color decal and emits ONE `LoadPaintState` action, so it's one undo step regardless of how many slots got involved. Per-triangle "majority vote" tally for triangles that catch multiple decal pixels avoids the "first hit wins" jitter that single-tag tools would produce. Optional `target_rect` lets the LLM stamp a small decal inside a sub-rectangle of the camera frame; optional `replace_existing` wipes prior color paint instead of overlaying.

#### D19d. Vision-LLM Text-to-Mask 🟢 Shipped

> **Files:** `AiVisionMaskTools.GetMaskForText` in `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionMaskTools.kt`.

`get_mask_for_text(query, view_name?)` is the zero-shot text-to-image-mask companion to D19a. The LLM is shown a normal-sphere render and asked to outline the queried feature ("the cheeks of a Pikachu", "the smokestack", "both ears") as one or more pixel polygons. Same response shape as D19a — `{polygons, camera_descriptor, triangle_indices}` — so the caller chains into `paint_projected_mask`, OR uses `triangle_indices` directly with `paint_triangle_list`. Empty-polygon-list is a valid result ("query didn't match any visible feature"); the tool surfaces ok=true with an empty array instead of erroring. Eliminates the need for manual coordinate hunting in tri-ID maps for the common "name the feature, paint it" workflow.

**Tests:** `AiDecalEngineTest` (10 cases), `CurvatureSegmentationTest` (5 cases), `PaintDecalToolTest` (7 cases), `AiVisionMaskToolsTest` (10 cases) — covers per-engine algorithm, MCP tool surface, fake-vision-API plumbing, and error paths. All pass on host JVM via `runTest`.

### D20. Full-Color & High-Fidelity Painting (Primed3D Parity) 🔴 Not started

To match dedicated full-color painting tools (like Primed3D) and fully support CMYKW 3D printing workflows, OrcaXR needs advanced color blending, decal mapping, and mesh resolution adjustments.

#### D20a. CMYKW Color Dithering (FullSpectrum Integration)

> **Files (planned):** Pending `libslic3r` port in `slic3r_jni.cpp`.

Completing the FullSpectrum mixed-color filament scaffolding. This allows OrcaXR to blend Cyan, Magenta, Yellow, Black, and White filament strands via toolpath dithering to produce a full spectrum of colors, overcoming the physical 4- or 8-toolchanger spool limit.

#### D20b. Mesh Sub-division for High-Res Painting

> **Files (planned):** New JNI helper `nativeSubdivideMesh` wrapping CGAL or libigl subdivision algorithms.

Paint state is currently bound to the source mesh's triangle resolution. Low-poly meshes cannot hold high-resolution paint details or photo decals. A subdivision tool allows users (or the LLM via MCP) to dynamically increase the mesh density in specific areas or globally prior to painting, ensuring crisp edges for projected graphics.

#### D20c. UV-to-Vertex-Color Baking

> **Files (planned):** New texture map reader in C++ and UV baking pipeline.

While `libslic3r` operates on vertex/face colors rather than UV maps, many 3D models come with existing UV maps and 2D textures. A baking pipeline would read a 3D model's UV map and associated image texture, and automatically bake those pixel colors down into the per-triangle `paint_color` metadata, allowing imported game assets or Primed3D-authored models to be sliced effortlessly.

### D21. Vision-API-free AI Paint authoring 🟢 Shipped — D21a + D21b live; D21c deferred

Surfaced during the 2026-05-03 "Sleeping Pikachu on pillow" (MakerWorld `US286aabafd2b978`) session. The driving LLM had to abandon the paint job after the disc-base + pillow pass because (a) `find_feature_anchors` (D18c) needed an Anthropic API key the device didn't have, and (b) the LLM couldn't see any `render_view` output to author anchors manually. D21a (LAN-fetchable render URLs) + D21b (auto-resolved bundled recipes) shipped together and make most AI-paint requests work with no paid vision call and no API key. D21c stays deferred per the original analysis — D21a + D21b cover the load-bearing cases, and an on-device ONNX landmark model only earns its keep on the long tail.

#### D21a. LAN-fetchable render URLs 🟢 Shipped

> **Files:** `AiVisionTools.buildResourceUri` in `app/src/main/java/dev/orcaxr/app/mcp/tools/AiVisionTools.kt`; `McpController.boundPortStatic()` in `app/src/main/java/dev/orcaxr/app/mcp/McpController.kt`; auth gate dropped on `/resources/<token>.png` in `McpServer.handleResourceGet`.

The 2026-05-03 session showed inline base64 image content parts didn't survive the Claude Code MCP transport — every render returned text + `image_uri`/`render_token` only, and `mcp://resources/<token>.png` is a custom scheme the LLM's `WebFetch` can't pull. Fix: when OrcaXR's MCP server has a LAN address bound, every render result's `image_uri` is now an absolute `http://<lan-ip>:<port>/resources/<token>.png` URL the driving LLM can fetch directly via `WebFetch`. The `/resources/` route drops the bearer-token check because the 64-bit SHA-256 token is itself the capability — it's not guessable without already having called a render tool, and the rendered geometry isn't sensitive in the way an API key is. Inline image parts stay as a best-effort secondary path; the http URL is the load-bearing channel. Falls back to the legacy `mcp://` scheme when no LAN address is bound (boot before Wi-Fi associates, unit tests).

#### D21b. MakerWorld-keyed bundled paint_template library 🟢 Shipped — auto-resolution + index scaffold

> **Files:** `app/src/main/java/dev/orcaxr/app/PaintTemplateResolver.kt`; `app/src/main/assets/paint_templates/index.json`; `paint_template` tool extended with `auto: bool` in `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintTemplateTools.kt`.

`paint_template(auto=true, model_id)` fingerprints the loaded model's source file (or `originalSource` for extracted multi-object 3MFs) and resolves a bundled recipe in priority order: (1) MakerWorld design id parsed from filename (`pikachu+US286aabafd2b978.3mf`) or from `Metadata/model_settings.config` inside the 3MF zip; (2) SHA-256 of the source bytes; (3) lowercased basename-with-non-alnum-collapsed against the filename-alias map. When no match is found the tool returns a structured `hint=no_recipe` body with `available` recipe names + `next_steps` suggestions instead of erroring, so the LLM can decide whether to fall back to manual `model_kind=` or to `find_feature_anchors` / `get_curvature_segmentation` / `get_mask_for_text`. The response surfaces `auto_resolved=true` + `matched_by` + `matched_key` so the caller knows whether the hit was strong (sha/MakerWorld id) or heuristic (filename alias). Library still ships the original two recipes (`funko_pop_pikachu`, `benchy_pirate_ship`) plus filename aliases for both — reaching ≥ 20 entries is incremental work tracked separately.

**Tests:** `PaintTemplateResolverTest` (12 cases — match-order priority, MakerWorld id from filename + zip metadata, SHA-256 stability/divergence, filename-alias normalization), `AiVisionResourceUriTest` (2 cases — fallback URI shape). All pass on host JVM.

#### D21c. On-device 2D landmark detector ⚪ Deferred — distant third option

A small bundled ONNX face/feature landmark model could substitute for D21a in the no-LLM-driver case (e.g. UI button "auto-paint a face"). Concretely lower priority than D21a + D21b: D21a removes the vision-API cost entirely for the LLM-driven path, and D21b removes the vision-API cost entirely for the catalogued-model path. A landmark model only earns its keep for uncatalogued models authored by a non-LLM caller, which is the long tail of the long tail. Mention here so it doesn't get re-proposed; defer indefinitely unless a concrete user request lands.
