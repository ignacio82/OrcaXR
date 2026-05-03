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

### D15. Standalone text & SVG primitives (vs D4's boolean emboss) 🔴 Not started

> **Files (planned):** new JNI entry `nativeBuildTextStl(font, text, height, depth, outPath)` — same libslic3r call chain as D4's `nativeBuildTextMesh` minus the `MeshBoolean::mcut::make_boolean` step. UI: `EmbossPanel` grows a third mode "Add as object" alongside "Emboss" / "Engrave".

D4 ships text/SVG as a boolean op against an existing host model. The complementary path — author standalone text or an SVG inset as a fresh PlacedModel sitting on the bed — has the same backend (`Emboss::text2shapes` + `polygons2model`) but skips the boolean. Useful for nameplates, labels, signage, or generating a part from an SVG silhouette without a host. Each of the three modes (Add part / Add negative / Add modifier) maps to a `ModelVolumeType` so a user can drop "TEXT" as a NEGATIVE volume to deboss letters into a host (subtle UX difference from D4's engrave mode: standalone NEGATIVE composes differently with multiple host volumes).

**Implementation outline:** Reuse `EmbossOp` data classes; add `EmbossOp.Mode.AddObject`. For NEGATIVE/MODIFIER variants, route through D14's `add_volume_to_model` instead of through `runEmboss`. MCP: `emboss_model` already has a `mode` arg — add `add_object` / `add_negative_volume` / `add_modifier_volume` cases.

**Exit criteria:** Author "HELLO" as a 5 mm-tall, 2 mm-deep PlacedModel on the bed and slice it. Author the same text as a NEGATIVE volume on a 20 mm cube → gcode shows a 2 mm-deep recessed text on the cube top.

### D16. Per-volume Object Settings panel 🔴 Not started

> **Files (planned):** new `VolumeSettingsPanel.kt`, extend `PlacedVolume.config: ModelConfig` (already exists per Phase 3 "per-object Object Settings"), JNI thread for `ModelVolume::config` already wired. The gap is a UI surface to author per-volume overrides.

Once **D14** lands, a PARAMETER_MODIFIER volume needs an editor — the whole point is to apply different settings inside its bbox-intersection with the parent. Upstream surfaces this through its right-hand "Object" panel with a curated key picker (`GUI_Factories.cpp::create_settings_popupmenu` + `FREQ_SETTINGS_BUNDLE_FFF`). For OrcaXR the natural surface is to extend the existing per-row `ModelDetailsPanel` with a per-volume sub-panel.

**Implementation outline:**
1. Per-volume settings UI mirrors the project-level Quality / Strength / Speed tabs, but scoped to a curated subset of keys per `ModelVolumeType` (modifier: layer_height / sparse_infill_density / wall_loops / sparse_infill_pattern / top_shell_layers / bottom_shell_layers; enforcer/blocker: support_threshold_angle / support_filament; negative: no settings).
2. Validation reuses **B8**'s `NumericValidation.printSettingRanges`.
3. 3MF round-trip already works via libslic3r `store_3mf` which serializes `ModelVolume::config`; **D9** captures the gap on the load direction.
4. MCP: `set_volume_overrides(model_id, volume_id, overrides: Map<String, String>)` + `get_volume_overrides`.

**Exit criteria:** Attach a PARAMETER_MODIFIER cube spanning the bottom 5 mm of a 20 mm cube, set its `sparse_infill_density=100`. Sliced gcode shows 100 % infill in the lower 5 mm and the project default everywhere else. Same overrides land via MCP and round-trip through 3MF.

### D17. Mesh simplify (quadric edge collapse) 🔴 Not started

> **Files (planned):** `app/src/main/cpp/slic3r_jni.cpp` (new `nativeSimplifyMesh(stlPath, targetTriCount, maxError, outPath) -> SimplifyResult` wrapping libslic3r `its_quadric_edge_collapse` from `QuadricEdgeCollapse.hpp`), `SlicerEngine.kt` (Kotlin wrapper), per-row hammer icon in `ModelRow` next to the existing wrench (D4 / A5), new `SimplifyPanel.kt` with a Target Tri Count slider + Max Error slider + before/after stats.

Heavy STLs (1M+ triangles — anything from Thingiverse + a typical artistic scan) thrash both BVH paint (gotcha #11f's allocation budget) and toolpath-rebake debounce. Upstream's `GLGizmoSimplify` invokes `its_quadric_edge_collapse` from `libslic3r/QuadricEdgeCollapse.hpp` — already in our linked libslic3r, no new patches.

**Implementation outline:**
1. JNI pipeline: load STL → compute current tri count → run `its_quadric_edge_collapse(triangle_count_target, max_error)` → write binary STL via libslic3r STL writer.
2. UI: hammer icon per row → opens `SimplifyPanel` showing current triangle count, target slider (10 % to 100 % of current), max-error slider (0.0 to 1.0 scale matching upstream defaults), "Preview" button (debounced 500 ms — re-compute and update tri-count label without committing), "Apply" button.
3. Apply replaces `PlacedModel.source` with the simplified path AND clears all topology-dependent state (paint, supports, seams, fuzzy skin, brim ears, volumes, originalSource, groupId — same sweep as A5 mesh repair, see `MainActivity::runRepair`).
4. MCP: `simplify_model(model_id, target_tri_count, max_error)`.

**Exit criteria:** A 1.4M-tri dragon simplifies to 200 K tris in <5 s on Galaxy XR with visible silhouette preservation; paint mode stays under the 256 MB JVM cap on the simplified mesh; round-trip via `save_model_as_stl` produces a valid binary STL.
