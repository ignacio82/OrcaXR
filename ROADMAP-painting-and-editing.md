# OrcaXR Roadmap — Painting & Object Editing

Sibling of [ROADMAP.md](ROADMAP.md) split out under the parent's "keep this file under ~600 lines" maintenance rule. Conventions, status legend, and how-to-use are identical to the parent — read [ROADMAP.md](ROADMAP.md) first if you haven't.

This file is the single source of truth for **section D** items only. Everything else (engine correctness, XR UI, connectivity, architecture, profiles, open questions, audit follow-ups) stays in [ROADMAP.md](ROADMAP.md). Cross-references that point at A/B/C/E/F/G/H items resolve in the parent file.

## D. Painting / object editing extensions

### D2. Custom support point placement ⚪ Deferred — SLA-leaning, FDM-only stack today

Per-point support placement (vs paint-region enforcer/blocker). Upstream uses `GLGizmoSlaSupports`. Useful for FDM tree-supports tuning but defer until a user requests it; current Support Enforcer paint mode covers the common case.

### D5. SLA hollow + drainage holes ⚪ Deferred — FDM stack only

Upstream's `GLGizmoHollow` is SLA-leaning. U1 + Centauri Carbon are FDM. Out of scope until a resin printer enters target hardware.

### D6. Measure tool ⚪ Deferred

Hand-track distance/angle between picked points/edges/faces (upstream's `GLGizmoMeasure`). Useful but additive; user hasn't requested it.

### D9. 3MF round-trip for per-object Object Settings 🟡 Partial — JNI save+load + MCP shipped; volume-tree round-trip pending

> **Files:** `slic3r_jni.cpp::nativeSaveAs3mf` + `nativeRead3mfObjectConfigs`, `SlicerEngine.read3mfObjectConfigs`, `MainActivity::onFileSelected`, `WorkspaceTools.{GetObjectOverrides, SetObjectOverrides}`.

Per-object `configOverrides` round-trip through 3MF via libslic3r's `model_settings.config` (`bbs_3mf.cpp:7691-7693` for write, line 2121 for load). Per-volume `configOverrides` round-trip on the SAVE side too via the sparse-encoded volume triples shipped for D16. The remaining gap is the LOAD side for user-added VOLUMES — OrcaXR's load path currently extracts each ModelObject as a per-object STL and discards the volume tree (gotcha #21), so a 3MF authored in desktop OrcaSlicer with a PARAMETER_MODIFIER volume + override won't restore the volume on import. Fixing that requires materializing `PlacedVolume` entries from the source 3MF — a bigger scope follow-up tied to gotcha #21's decomposition pipeline.

**Exit criteria (remaining piece):** A 3MF authored in desktop OrcaSlicer with a PARAMETER_MODIFIER volume + `sparse_infill_density=100` reopens in OrcaXR with the volume restored and `get_volume_overrides` returning the override.

### D20. Full-Color & High-Fidelity Painting (Primed3D Parity) 🟡 Partial — Smart Auto-Paint M1 shipped

To match dedicated full-color painting tools (like Primed3D) and fully support CMYKW 3D printing workflows, OrcaXR needs advanced color blending, decal mapping, and mesh resolution adjustments.

> **Smart Auto-Paint** (one action → whole-model paint, optional target image, optional FullSpectrum): design + milestone plan in [`docs/proposals/smart-auto-paint.md`](docs/proposals/smart-auto-paint.md). M1 (geometric strategies, `auto_paint`) + M2 (target-image projection core: `ColorScience`, `AutoPaintImageEngine`, silhouette camera auto-pick) + M4 (vision-LLM semantic transfer with automated grade/refine loop: `SemanticPaintPlanner`, `auto_paint_from_reference`) shipped, physical-only. M3 (FullSpectrum gamut) gated on green PeggyPalette.

#### D20a. CMYKW Color Dithering (FullSpectrum Integration)

> **Files (planned):** Pending `libslic3r` port in `slic3r_jni.cpp`. Blocked on **A2**.

Completing the FullSpectrum mixed-color filament scaffolding. This allows OrcaXR to blend Cyan, Magenta, Yellow, Black, and White filament strands via toolpath dithering to produce a full spectrum of colors, overcoming the physical 4- or 8-toolchanger spool limit.

#### D20b. Mesh Sub-division for High-Res Painting

> **Files (planned):** New JNI helper `nativeSubdivideMesh` wrapping CGAL or libigl subdivision algorithms.

Paint state is currently bound to the source mesh's triangle resolution. Low-poly meshes cannot hold high-resolution paint details or photo decals. A subdivision tool allows users (or the LLM via MCP) to dynamically increase the mesh density in specific areas or globally prior to painting, ensuring crisp edges for projected graphics.

#### D20c. UV-to-Vertex-Color Baking

> **Files (planned):** New texture map reader in C++ and UV baking pipeline.

While `libslic3r` operates on vertex/face colors rather than UV maps, many 3D models come with existing UV maps and 2D textures. A baking pipeline would read a 3D model's UV map and associated image texture, and automatically bake those pixel colors down into the per-triangle `paint_color` metadata, allowing imported game assets or Primed3D-authored models to be sliced effortlessly.

### D21c. On-device 2D landmark detector ⚪ Deferred — distant third option

A small bundled ONNX face/feature landmark model could substitute for D21a in the no-LLM-driver case (e.g. UI button "auto-paint a face"). Concretely lower priority than D21a + D21b: D21a removes the vision-API cost entirely for the LLM-driven path, and D21b removes the vision-API cost entirely for the catalogued-model path. A landmark model only earns its keep for uncatalogued models authored by a non-LLM caller, which is the long tail of the long tail. Defer indefinitely unless a concrete user request lands.

---

## Appendix: Already-shipped D items (do not re-implement)

Reference index. The full design rationale lives in `GEMINI.md` (gotcha numbers cross-referenced) or in the commit message — re-expand here only if a follow-up requires it.

| # | Feature | Commits / notes |
|---|---|---|
| D1 | Paint persistence | `c913e4e` (cache + save/restore + 10 tests), `e8133db` (sizeBytes + Storage card + Clear), `cc75ead` (v2 fuzzy skin), `d2d30d2` (3MF round-trip — 4 facet annotations) |
| D3 | Brim ear painting | `69b783b` — `BrimEarPoint` + JNI write + click-to-add + UI toggle + 1 mm dedup |
| D4 | Embossing / SVG inset / text-on-object | Native `nativeBuildTextMesh` / `nativeBuildSvgMesh` / `nativeApplyEmboss` + `EmbossPanel` + bundled DejaVu fonts + heart.svg + `EmbossOpTest` |
| D7 | Multi-step undo for paint | `5cf152e` — `PaintHistory` ring buffer (MAX_DEPTH=20) + UI bindings + 11 tests |
| D8 | Smart fill / connected-region paint | `7534f25` — `MeshBvh.smartFillBfs` + Smart toggle + 15/30/45/60/90° angle cycle |
| D10 | Fuzzy Skin paint | `cc75ead` — `PaintMode.FuzzySkin` + JNI helper + slice + 3MF round-trip + cache v2 |
| D11 | Brush radius / smart-fill stick adjust | `f85380c` — Prepare-mode left-stick Y axis nudges radius/angle in paint mode |
| D12 | Add primitive shapes (cube/cylinder/sphere/cone/disc/torus/slab) | `nativeBuildPrimitiveStl` + `Primitives.kt` + 2 MCP tools (`add_primitive`, `list_primitives`) + `AddPrimitivePanel` |
| D13 | Handy model library (partial — assets + MCP shipped, in-XR picker UI deferred) | 8 vendored meshes (Benchy, Orca Cube, Voron Cube, Stanford Bunny, Cali Cat, Orca Tolerance Test, FDM Test, Orca String Hell) + `HandyModelCatalog` + 2 MCP tools |
| D14 | Modifier volume types (negative / parameter modifier / support enforcer / support blocker) | `ModelVolumeType` enum + extra-volumes JNI path + 5 UI chips + `add_volume_to_model(type=…)` |
| D15 | Standalone text & SVG primitives | `WorkspaceAction.AddTextOrSvgObject` + `emboss_model(mode='add_object'|'add_volume')` + `EmbossModelAddVolumeTest` |
| D16 | Per-volume Object Settings (partial — JNI + MCP shipped, dedicated SpatialPanel deferred) | Sparse `(volIdx, key, value)` triples through `nativeSlice::mv->config.set_deserialize` + 2 MCP tools + 7 unit tests |
| D17 | Mesh simplify (quadric edge collapse) | `nativeSimplifyMesh` (libslic3r `its_quadric_edge_collapse`) + `SimplifyPanel` + `simplify_model` MCP tool |
| D18 | AI-paint authoring upgrades (post-C9) — all 10 sub-items live | `8d586fc` `819924a` `5b5e7d5` `3a7d823` `ee79545` `c96a9b9` `7e01a31` `25d34a5`. Surface: `paint_geodesic_disc`, `paint_with_mirror`, `find_feature_anchors`, `paint_projected_mask depth_mode='any_facing'`, `render_view(annotate=true)`, `render_diff`, `flush_actions`, hi-res tri-ID + `resolve_image_pixel(radius_px)`, `paint_template` + `list_paint_templates`, `save_paint_recipe` / `list_paint_recipes` / `load_paint_recipe` / `delete_paint_recipe` |
| D19 | Advanced AI Paint Authoring (Organic Models) — all 4 sub-items live | `generate_mask_from_point`, `get_curvature_segmentation`, `paint_decal`, `get_mask_for_text`. Pure-Kotlin curvature segmentation + Anthropic Vision API for the others |
| D21a | LAN-fetchable render URLs | `AiVisionTools.buildResourceUri` + `McpController.boundPortStatic()` + auth gate dropped on `/resources/<token>.png` (see audit item H2 for follow-up hardening) |
| D21b | MakerWorld-keyed bundled paint_template library | `PaintTemplateResolver` + `paint_template(auto=true)` resolves MakerWorld id / SHA-256 / filename alias |
