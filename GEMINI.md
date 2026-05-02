# GEMINI.md

Canonical technical context for OrcaXR. Auto-loaded by Claude Code via
CLAUDE.md and by Codex via AGENTS.md at the start of every session in
this repo. Read this before any non-trivial work.

## Self-update mandate

**When any claim in this file becomes wrong or incomplete, fix it in the
same commit as the code change that caused the drift.** Do not append
errata sections. Do not let this file rot.

Update triggers (save it here, not as a throwaway comment):

- **Build quirks** — NDK flags, CMake workarounds, dependency version pins
  that matter, things that broke once and will break again.
- **Dependency gotchas** — versions of libs with known bugs, incompatibilities
  between Jetpack XR artifacts, upstream OrcaSlicer commits that must/must-not
  be picked up.
- **Architectural decisions** reached in conversation — module splits,
  threading model, JNI boundaries. Record the decision *and the reason*.
- **User preferences** expressed during work — how they want commits
  structured, code style calls, what they consider out-of-scope.
- **Non-obvious code behavior** — things that surprised you reading the
  code and will surprise the next session too.

Do **not** record things already derivable from reading the code (file
paths, function signatures, module names) unless they're load-bearing
*and* easy to get wrong. Keep this file under ~500 lines; split into a
separate doc if it grows past that.

## Mission

Build an XR-first 3D printing slicer for Android XR. Not a port of
OrcaSlicer's wxWidgets UI — a ground-up XR UX with OrcaSlicer's slicing
engine (`libslic3r`) as the computational core.

## Target platform

- **Primary:** Android XR (Samsung Galaxy XR, Google Android XR platform).
- **Target printers:** Snapmaker U1 (4-head toolchanger), Elegoo Centauri
  Carbon. Both are Klipper + Moonraker; this codebase has *no* serial,
  USB, or vendor-cloud printer support.
- **SDK versions:** compileSdk 37, targetSdk 35, minSdk 31, Java 21.
- **Not currently targeted:** phone, TV, Vision Pro, PCVR. Keep module
  layout open to adding form factors later but don't build for them until
  XR is solid.

## Stack

| Layer | Choice |
|---|---|
| UI | Jetpack Compose + `androidx.xr.compose:1.0.0-alpha12` |
| 3D | `androidx.xr.scenecore:1.0.0-alpha13` (`GltfModelEntity` for build plate / model preview / toolpath) |
| Session | `androidx.xr.runtime:1.0.0-alpha12` |
| Material | `androidx.xr.compose.material3:1.0.0-alpha16` |
| Theme | `dev.orcaxr.app.ui.OrcaXrTheme` — palette + typography + LocalContentColor wrapper. All MaterialTheme calls live there; the activity wraps `setContent { OrcaXrTheme { … } }`. Fonts (Instrument Sans, Space Grotesk, JetBrains Mono) are downloadable via `androidx.compose.ui:ui-text-google-fonts`; cert hashes in `res/values/font_certs.xml`. |
| DI | None yet (single-module Compose state). Hilt when we split modules. |
| Persistence | DataStore Preferences for profiles/printers/filaments. No Room yet. |
| Slicing core | OrcaSlicer `libslic3r` v2.3.2 cross-compiled to arm64-v8a `.so` via NDK r29.0.14206865, called over JNI |
| Async | Kotlin coroutines; native calls serialized on a single background dispatcher. |
| Network | OkHttp for Moonraker — Android's `HttpURLConnection` failed with `SocketException("closed")` against Mainsail's nginx, OkHttp doesn't. See `MoonrakerClient.kt` header. |

## Upstream slicer strategy

- **Base:** upstream `OrcaSlicer/OrcaSlicer` on GitHub. NOT Snapmaker's fork or FullSpectrum.
- **Vendored as git submodule** at `third_party/OrcaSlicer`, pinned to tag `v2.3.2`.
- **Patches** under `patches/` are reapplied to a clean v2.3.2 checkout by `scripts/build_native.sh` on every run. Submodule's working tree is expected to be dirty; that's the in-tree application of those patches. Don't commit submodule pointer changes.
- **FullSpectrum integration:** deferred to Phase 3+. Its libslic3r diffs (virtual mixed-color filaments, bias, dithering) get applied as additional patches *after* upstream compiles cleanly for arm64.

## Module layout

Currently single `:app` module. The split below is aspirational; do NOT create modules speculatively — add them when boundaries become painful.

```
:app                 single APK, all of it for now
                     ↓ when boundaries hurt:
:slicer:xr           XR presentation: SpatialPanels, gizmos, toolpath viewer
:slicer:core         platform-agnostic domain models, slicer-facing DTOs
:slicer:native       JNI bridge to libslic3r_jni.so
:data                printer connectivity (Klipper/Moonraker), profile sync
:settings            DataStore-backed slicer profiles and presets
```

## Jetpack XR rendering gotchas

1. **`SpatialPanel` does not render in Home Space.** A `Subspace { SpatialPanel { Compose UI } }` placed inside an Activity that's still in *Home Space* mode produces a panel frame with system chrome but a **solid black content surface**. Call `session.scene.requestFullSpaceMode()` from a `LaunchedEffect(session)` keyed on the Session before any Subspace work depends on the panel being visible.

2. **Modal plate-grab via a single `MovableComponent` on the workspace, gated by a `plateMovable` toggle in `PlateTabPanel`.** The earlier orbiter-cube design (two 5 cm cubes outside the bed corners) was replaced because (a) the cubes never reliably caught hand-pinches on Galaxy XR, (b) re-keying the orbiter `LaunchedEffect` on `bedW`/`bedH` synchronously disposed in-flight `GltfModelEntity`s when the saved profile loaded after defaults, tripping gotcha #13, and (c) two visible affordances next to each model gizmo invited mis-grabs. Current design:
   - **Workspace Grab:** One `MovableComponent.createCustomMovable` is attached to the `OrcaXR-workspace` `GroupEntity` only while `plateMovable == true`. Hit volume is `FloatSize3d(side, side, side)` where `side = max(bedW, bedH) * WORLD_SCALE` — a cube covering the bed footprint in world meters (NOT entity-local units; `mc.size = HIT / WORLD_SCALE` produces a ~50 m AABB the user is standing inside, see gotcha below). The listener clamps rotation back to `WORKSPACE_ROTATION` every `onMoveUpdate` so the bed stays upright, and writes the new translation to `workspaceTx`.
   - **Toggle UX:** `PlateTabPanel` shows a Switch + lock/move icon at the top. Default is **Locked** — pinches over the bed reach model gizmos and the model-grab box unobstructed. When the user flips it on, the bed turns into a single grab target; flipping it off detaches the component (`ws.removeComponent(mc)`) so model interactions resume.
   - **Model Grab:** A 25×12.5×25 cm grab box (`OrcaXR-modelGrab`) is parented to the workspace and centered on the model. It drives the `modelOffsetXmm/Ymm` state.
   - **`MovableComponent.size` is in world meters, not entity-local units.** Matches the `MovablePanelWrapper` pattern (`mc.size = widthMeters` directly). Dividing by `WORLD_SCALE` because the entity has `setScale(WORLD_SCALE)` is the trap — the `size` is *not* multiplied by the entity transform.

3. **`SpatialPanel` should be wrapped in `SceneCoreEntity(factory = { GroupEntity })`** when you need to add components (movable, anchor, etc).

4. **`MaterialTheme {}` with no `colorScheme` arg + missing `LocalContentColor` provider** can produce a content area that paints with `Color.Unspecified` against the SpatialPanel's transparent surface. Always pass an explicit `colorScheme` and provide `LocalContentColor` via `contentColorFor(MaterialTheme.colorScheme.background)`.

5. **`enableEdgeToEdge()` is required.** Skipping it leaves the panel content surface in a half-initialized state on some builds. Call before `setContent`.

6. **`GltfModel.create(Session, Path)` rejects absolute filesystem paths.** Use the `create(Session, ByteArray, String)` overload instead for runtime-generated GLBs.

7. **GLB axis convention vs SceneCore world axes.** glTF/GLB uses Y-up by spec. We author printer-frame GLBs with X=bed-X, Y=bed-Y (front-back), Z=print-height. Apply a +90° rotation around X on the entity (`Quaternion(sin45°, 0, 0, cos45°)`) to map printer-Z → world-Y (up).

8. **`SubspaceModifier.movable()` is `internal` in alpha12.** Individual SpatialPanels can't be drag-repositioned via the modifier; the workspace MovableComponent (#2) is currently the only drag affordance.

9. **Compose coroutine cancellation on `AndroidUiDispatcher` is cooperative — non-suspending bodies still run after cancel.** A `LaunchedEffect { entity.setPose(...) }` whose Job has been cancelled (key changed, composition leaving) will still execute its body to completion if there's no suspension point, and `setPose` on an already-disposed `Entity` throws `Entity.DisposedException`. Guard with `if (ent.isDisposed) return@LaunchedEffect` before any SceneCore call inside a `LaunchedEffect`.

10. **SceneCore parent dispose cascades to children before Compose `DisposableEffect.onDispose` runs.** When the activity tears down, disposing a `GroupEntity` synchronously disposes its child `GltfModelEntity`s, so each child's `onDispose { ent.removeComponent(ic); ent.dispose() }` then throws `Entity.DisposedException` and aborts `Activity.performDestroy()` — the next process bootstraps with empty state and looks like the user's work vanished. Wrap teardown in `if (!ent.isDisposed) runCatching { ... }`. Same applies to setPose racing with Filament's material binding on freshly-created entities: re-issuing `setScale(Vector3, Space.PARENT)` on every recomposition (vs once at create with the scalar overload) aborts the render thread with `split_engine_bridge: unknown material instance id`.

11. **`InputEvent.Source` filters that hard-code `CONTROLLER` silently break on Galaxy XR.** Hand-pinch interactions arrive as `HANDS` (and may also be reported as `GAZE_AND_GESTURE` depending on gesture path); the device has no controller at all. Guards like `if (event.source != InputEvent.Source.CONTROLLER) return` will swallow every event and the user sees a perfectly-rendered gizmo / interactable that does nothing. Filter on `source != InputEvent.Source.UNKNOWN` (or just gate on `event.action`) instead. Bit any code path that takes `InputEvent` from `InteractableComponent`: gizmos, paint, selection. **Caveat (2026-05-02):** on the actual Galaxy XR retail device with hand-tracking active, hand pinches arrive labeled `Source.CONTROLLER ptr=RIGHT` rather than `HANDS` — the OpenXR runtime maps the hand-pinch action profile to the controller binding because no physical controller is paired. So the `!= CONTROLLER` filter is wrong on this device too, just for a different reason. The `!= UNKNOWN` filter is the right answer regardless of which source the runtime decides to label hand events with.

11b. **InteractableComponent on `GltfModelEntity` cannot be safely swapped on a mode change — bind it once and route at dispatch.** A `DisposableEffect(entity, paintHooksActive, selectionActive)` that recreates the IC when the user toggles paint mode is racy on alpha13: events queued before `removeComponent(oldIc)` lands keep dispatching to the OLD listener with its stale `paintHooksActive=false` capture, so pinches arriving right after the user taps Paint silently flow through the selection branch instead of the paint hooks. Symptom that triggered the rewrite (2026-05-02): `InteractableComponent attached … (mode=paint)` followed 18 ms later by InputEvents from the same entity logging `route=select`, with no `PaintInputHooks.handle()` call ever firing — paint mode genuinely did nothing for the user. Fix: key the DisposableEffect on `entity` only, attach one IC per entity for its full lifetime, and have the listener read `hooksLive.value` / `onTapLive.value` / `onHoverLive.value` (each a `rememberUpdatedState`) at each event to decide whether to route to paint or selection. Mode toggles then change which `*Live.value` the next event reads — no IC swap, no race. Same caveat applies to gizmo/select interactables: prefer dispatch-time routing over keyed restarts.

11c. **`HitInfo.transform` on alpha13 is the FORWARD world→mesh-mm matrix, not pose-only.** The naïve interpretation — `transform.pose` is the entity's world pose and `transform.scale` is its setScale value (≈ 0.0015 = WORLD_SCALE) — is wrong. Empirically, on the retail Galaxy XR running the alpha13 SDK, `transform.pose.translation` is reported in **mesh-mm** (i.e., the world translation pre-multiplied by `1/WORLD_SCALE` ≈ 666.67), `transform.pose.rotation` is the **inverse** of the entity's world rotation (e.g., `+90° X` when the workspace authored `-90° X`), and `transform.scale` is `1/WORLD_SCALE` not WORLD_SCALE. Effectively `M = T(mesh-mm) × R(world→mesh) × S(mesh-mm/m)` — a forward transform that maps world meters to mesh-mm directly. Bug that triggered the rewrite (2026-05-02): the Phase J code did `pose.inverse.transformPoint(worldOrigin) / scale.x` assuming pose-only-then-divide-by-scale, which collapsed the origin to sub-millimeter values for a 60 mm mesh on the dragon test, then later — when the matrix's translation was interpreted as world meters — shifted Y by ~65 m phantom. Correct math: `meshPoint = pose.transformPoint(worldPoint ⊙ scale)` (component-wise pre-scale, then rotate-and-translate via the Pose). `Matrix4` has no `transformPoint`, so apply manually. See `PaintInputHooks.worldRayToMeshMm` and `PaintInputMathTest` for the canonical reference rays.

11d. **The BVH for paint must live in the SAME coordinate frame as the rendered GLB — match `nativeWriteColoredGlb`'s centering shift.** The JNI's `row_layout` (single-object STL) and `centered_existing_layout` (3MF) both apply `(-cx, -cy, -minZ)` to every vertex so the rendered GLB sits centered at the workspace origin with its Z-min on the bed. The BVH builder reads from `dragon_derived.stl` (output of `nativeConvertToStl`) which preserves the **original** printer-bed coords, so without the matching shift, BVH coords (e.g. X≈109..161) and GLB coords (X≈-26..+26) differ by ~135 mm and every raycast misses. Fix (2026-05-02): apply `mesh.translatedXyz(-cx, -cy, -minZ)` after `StlReader.read` and before `MeshBvh.build`. Symptom: `handle: HIT` never fires; `locateTriangle` returns null even though the ray clearly enters the entity bbox. See `PaintInputMathTest` (`BVH centering shift puts an off-center mesh under the world origin`).

11e. **`addComponent` queues an op against the entity's material instance — give Filament a few frames to bind it before triggering the IC attach.** Synchronous `entity = ent` immediately after `GltfModelEntity.create` + `applyWorkspacePose` lands the IC's collider attach on the render queue before the entity's material is bound, racing `split_engine_bridge.cc:100 NOT_FOUND: unknown material instance id: N`. Two `awaitFrame()` (gotcha #13's deferred dispose) is enough for the dispose direction but not for the create direction on heavy 3MF loads. Fix (2026-05-02): three `awaitFrame()` between create+pose and the Compose state assignment that triggers the DisposableEffect's IC attach. Applies to both `GlbSceneEntity` and `SelectionBboxEntity`.

11f. **Paint stamp pipeline must mutate `paintFilamentIndex` in place during a stroke, not clone per event.** Each `stampTriangles` call clones the previous ByteArray (1.4 MB on a 1.4M-tri dragon) and `radiusBfs` allocates a 1.4 MB visited BooleanArray. At a 30 Hz throttle that's still ~85 MB/sec of allocation; the JVM's 512 MB heap fills in ~30 seconds of dragging and OOMs. Fix (2026-05-02): a stroke-buffer pattern. On DOWN, clone `paintFilamentIndex` once into the stroke buffer and hand `PaintHistory.beginStroke` a SEPARATE clone (so undo isn't corrupted by in-place mutation); on every MOVE, call `stampTrianglesInPlace(target, triIndices, slot)` which mutates the buffer directly. Bump a `paintContentVersion: Int` Compose state so the rebake LE re-keys without needing a fresh ByteArray reference. Also reuse `MeshBvh`'s BFS buffers (visited, queue, out) across calls — cuts another 1.4 MB per stamp. Two extra throttles: skip MOVEs to the same triangle as the last stamp (`lastStampedTri`); cap MOVE stamp rate at ~30 Hz (`lastStampMs`). See `PaintStampAllocationTest` for the contract.

11i. **Manual paint raycast on Galaxy XR misses when the workspace isn't at world origin — and the SDK's `hit.transform` does a partial correction we don't fully understand yet.** Symptom (2026-05-02 diag captures): InputEvent ray reaches `PaintInputHooks.handle()` with valid `hitInfoList`, but `bvh.intersect()` returns null on every event. Two strokes captured with different workspace positions:
 - Stroke A: workspace at world ~origin; tf.poseT = (0, 0, 66.67) mesh-mm = just `WORKSPACE_Y_OFFSET`. event.origin Z = +1.327.
 - Stroke B: workspace at world (0.216, -0.240, -1.422); tf.poseT = (-28.66, 109.18, 230.76) mesh-mm. event.origin Z = +1.188.
   In both cases the resolved meshOrigin lands far outside the BVH bbox (Y ≈ -885 / -1631 vs bbox Y=±15.5). Naïvely subtracting the entity's world position from event.origin (the obvious fix attempt) doesn't help — `tf.poseT` already encodes some kind of partial world-position correction whose exact formula doesn't match `-R(S·c)+offset`. Compounding: the InputEvent ray itself appears to miss the boat by ~30 cm in world space (the IC's bbox is loose enough that events fire even when the true ray-vs-mesh intersection would miss). Open questions: (a) is `event.origin` actually in world meters, or in some camera/head-relative frame? (b) what's the closed-form relation between `tf.poseT`, `tf.scale`, and `entity.getPose(REAL_WORLD)`? Answering (a) and (b) needs DOWN diag captures across at least three distinct workspace world positions plus a synthetic test ray that hits a known triangle. Until that's resolved, MCP-driven paint (`paint_split_plane`, `replace_paint_tag`) works end-to-end; manual brush is degraded on workspaces that aren't at world origin.

11h. **Any code path that mutates `paintFilamentIndex` (or the support / seam / fuzzy-skin parallel arrays) MUST bump `paintContentVersion`.** The colored-GLB rebake `LaunchedEffect(paintContentVersion)` keys on a counter, NOT on `placedModels.map { it.paintFilamentIndex }` — gotcha #11f's in-place stamp pipeline doesn't change ByteArray identity per event, so a reference-equality key would never re-key and the rebake would never fire. The MCP-driven paint surface (`paint_split_plane`, `replace_paint_tag`, `clear_paint`, `paint_undo`, `paint_redo`) writes a fresh ByteArray, but the LE doesn't observe ByteArray identity either — it observes the counter. Symptom that triggered the fix (2026-05-02): user runs `paint_split_plane` over MCP, `get_paint_summary` confirms the in-memory split (113083@1 / 112623@4), but the on-bed colored preview keeps showing the old paint until the app restarts. Fix: bump `paintContentVersion++` inside `applyPaintMutation` (covers split / replace / clear) and inside `onPaintUndo` / `onPaintRedo` (which bypass the helper). The 200ms debounce inside LE_3076 still coalesces continuous strokes into one re-bake.

11g. **`StlReader` is binary-only — route ASCII STL through `deriveStlFor` to force a libslic3r round-trip.** `StlReader.parseBinary` reads bytes 80–84 as a triangle count; for ASCII STL these bytes are mid-`facet` text and the count comes out absurd (e.g. `1702130277`). The bundled `cube_20mm.stl` test asset is ASCII, and previously `deriveStlFor` short-circuited STL inputs by returning the file directly — so every consumer (paint BVH, `previewStl`, etc.) hit the parse error. Fix (2026-05-02): `deriveStlFor` probe-reads with `StlReader` first; on failure it forces `SlicerEngine.convertToStl` (libslic3r round-trip), which always emits binary STL. Saves the round-trip on the common case (already-binary).

12. **`Font(googleFont = ..., fontProvider = ..., weight = ...)` doesn't resolve to the googlefonts factory unless aliased.** The `androidx.compose.ui.text.font.Font` type and the `androidx.compose.ui.text.googlefonts.Font` *factory* share the symbol name; an unqualified `Font(googleFont = ...)` call resolves to the foundation overload set (file/asset/resId only) and the compiler reports "no Font(googleFont = ...) overload." Theme.kt aliases the factory as `import androidx.compose.ui.text.googlefonts.Font as GoogleFontFactory` and calls that instead. Don't drop the alias.

13. **Synchronous dispose of a `GltfModelEntity` mid-swap aborts the render thread with `split_engine_bridge.cc:100` `NOT_FOUND`.** Two flavors observed: `"unknown material instance id: <N>"` and `"unknown node: <N>"`. Both come from queued render-thread ops (setPose, addComponent for an Interactable/Movable collider) that reference a node id whose entity was just freed. Three patterns produce this:
   - **`key(modelId, glbPath) { GlbSceneEntity(...) }`** — when `glbPath` changes, Compose unmounts the entire composable, so any `DisposableEffect` onDispose fires synchronously, freeing the entity before the render queue drains. Use `key(modelId)` only — let `GlbSceneEntity`'s internal `LaunchedEffect(glbPath, parentEntity)` handle the swap and dispose with `disposeEntityDeferred(oldEntity)` (defined in `MainActivity.kt`) which awaits two frames before disposing.
   - **`DisposableEffect(glbPath) { onDispose { entity.dispose() } }`** — same problem, fires synchronously on path change. Key it on `Unit` so it only runs on real composition leave; the LaunchedEffect handles path-change swaps with deferred dispose.
   - **`key(selectedModelIds.hashCode(), fw, fd, fh) { SelectionBboxEntity(...) }`** — keying any wrapper composable on the model's bbox dims is the same trap. A change to `baseBboxXmm/Y/Z` (e.g. when a re-bake refines per-object dims) flips the key, the wrapper unmounts, and its `DisposableEffect(Unit)` synchronously frees the bbox entity. Drop the dim args from the key; the inner LaunchedEffect on `(modelId, sizeXmm, sizeYmm, sizeZmm)` handles dim changes via `disposeEntityDeferred`.
   This is acutely triggered by gotcha #22's two-bake load: v1→v2 within ms means the v1 dispose can race v2's still-loading addComponent.

14. **`nativeWriteColoredGlb` keeps `KHR_materials_unlit` and bakes Lambert shading into `COLOR_0`; do NOT switch to a PBR material.** Two prior attempts at "make the preview look 3D" tried different approaches that both failed:
    - **Drop unlit, leave only POSITION + COLOR_0** → Filament rendered black because PBR has no normals, so lighting was undefined.
    - **Drop unlit, add NORMAL + a `pbrMetallicRoughness` material** → still rendered dark because Jetpack XR SceneCore (alpha13) does NOT install a default IBL skybox or directional light when a `GltfModel` attaches; PBR's diffuse term has nothing to sample, so the result drops to near-black even with correct normals.

    Current approach: keep `KHR_materials_unlit`, compute smooth per-vertex normals from world-space positions (area-weighted face-normal accumulation), and pre-multiply each vertex color by `ambient + key * max(0, dot(n, key_dir)) + fill * max(0, dot(n, fill_dir))` before writing the GLB. The unlit material renders `baseColor * vertexColor` straight to the screen with no scene-light dependency, so the baked shading IS what the user sees. Light directions are mesh-local (printer-frame: +Z = up). Output GLB is positions + colors + indices only — no NORMAL accessor (unlit ignores it).

## libslic3r gotchas (load-bearing)

1. **Uninitialized POD members in `Print.hpp` / `WipeTower.hpp` silently corrupt slices on Android arm64 Release.** Patches `0011-skip-gcode-append-full-config.patch` and `0012-print-init-uninitialized-members.patch` cover this.

2. **A config key set via `set_deserialize_nothrow` only takes effect if libslic3r recognizes it as a known PrintConfig option, AND the key is whitelisted in `OrcaProfileLoader.SAFE_KEYS`.** Unknown keys are silently dropped.

3. **JNI `ScopedUtf` releases must happen before `DeleteLocalRef`, not after.**

4. **`ConfigOptionEnumsGeneric` instances need their `keys_map` re-attached after `FullPrintConfig::defaults()`.**

5. **Don't override the U1 profile's `machine_start_gcode`.**

6. **Real multi-tool slicing requires `single_extruder_multi_material=false`.**

7. **`update_values_to_printer_extruders_for_multiple_filaments` null-derefs on filament-prefixed nullable options.** Patch `0013-toolchanger-handle-nullable-cast.patch` fixes this.

8. **3MF loader dispatch is BBS-leaning and breaks on Prusa / MakerWorld files.** Use `Model::read_from_archive` which sniffs Prusa-vs-BBS.

9. **`load_bbs_3mf` requires `LoadStrategy::LoadModel | LoadConfig | AddDefaultInstances`.** DO NOT add `LoadAuxiliary` (=16) as it fails on Android's read-only filesystem.

10. **`load_bbs_3mf` segfaults if you pass `nullptr` for `file_version`.**

10b. **3MF preview colors live in the embedded `filament_colour` array.** Read it directly from the zip to avoid filesystem issues.

11. **GLB writer OOMs on large meshes if using one big ByteBuffer.** Stream to a `BufferedOutputStream` instead.

12. **Multi-object 3MFs need an explicit row layout.** Use the `row_layout` helper in `slic3r_jni.cpp`.

13. **Per-plate temperature keys must all be in `SAFE_KEYS`.**

14. **`Print::set_status_callback` fires from TBB worker threads.** The JNI shim must attach/detach the JVM.

15. **Headless slice tests must inject `before_layer_change_gcode = "G92 E0\n"`.**

16. **Patch `0011-skip-gcode-append-full-config` is permanent.**

17. **Multi-color slicing on arm64 needs the TBB serial shim opted into four specific TUs.** Patch `0014-android-tbb-serial-shim-activation.patch` handles this to prevent race conditions on ARM64.

18. **`tbb::scalable_malloc` is broken on Android arm64.** We wrap it to libc malloc/free at link-time.

19. **Multi-color config keys MUST use `;` as separator, not `,`.**

20. **FullSpectrum mixed-filament integration is currently scaffolding.** Porting integration is ongoing.

21. **All multi-object 3MFs are decomposed into separate STLs on import.** To allow per-object selection and transform (Phase B9), generic multi-object 3MFs extract each `ModelObject::mesh()` to a temporary STL in `cacheDir/extracted/<hash>/`. Each `PlacedModel` points to one of these STLs, sharing a `groupId` (the source 3MF's hash). `originalSource` tracks the original 3MF container path so `nativeWriteColoredGlb` can re-load the per-triangle `paint_color` metadata during re-bakes. STL has no material metadata, so carry the source object's one-based default extruder in `PlacedModel.previewFilamentIndex` as a fallback. **`runSliceMulti` MUST re-route to `originalSource` and pass `groupOrdinal` in the `objectOrdinals` parameter for any PlacedModel that has an `originalSource`** — the JNI then clones `Model::objects[ordinal]` from the original 3MF, preserving every painted volume's `mmu_segmentation_facets` / `supported_facets` / `seam_facets`. Going through the per-object STL strips all of those (STL ⇒ no facet annotations), and the resulting slice prints single-color with no supports, no purge tower, and no seam control even when each object was authored multicolor. Symptom that triggered the patch: 4 painted unicorns plated together yielded `postprocess_remap_tool_commands: 10 rewrites across 1.6M lines` — i.e. effectively no toolchanges. Pre-fix code path (`m.source` for everything) is the trap; the fix sends `(originalSource ?: source, groupOrdinal)` per input.

21b. **`nativeSliceMulti` MUST capture the source `ModelInstance`'s scale + rotation BEFORE `clear_instances()`** and compose them with the user's per-input transform. BBS / Bambu 3MFs encode per-instance scale + rotation in their `<build><item transform=...>` matrix — the knitted-unicorn 3MF authors `transform="1.5697 0 0 0 0 1.5697 0 -1.5697 0 ..."` (a 1.5697× uniform scale plus -90° X rotation that stands a Y-up authored mesh up onto the printer's Z-up bed). Discarding those by replacing the cloned object's instances drops the print to its raw mesh extents — symptom is the unicorn arriving at ~63 % of the desktop slicer's size (27 mm tall instead of the authored 40 mm) and the toolpath looking visually blob-y / squat. Compose: `final_scale = user_scale * src_scale`, `final_rotation = user_rotation + src_rotation` (Eulers — works for the X+Z-only axes the typical UI exposes), `final_offset = user_offset` (replace; the user's plate placement was authored against the scaled extents shown in Prepare). `nativeSlice` (single-model path) escapes this trap by leaving `mo->instances` alone entirely.

22. **`SlicerEngine.PROJECT_OVERRIDE_KEYS` MUST NOT include `layer_height` / `initial_layer_print_height` / `first_layer_height`.** `mergedConfig`'s precedence ladder applies `projectOverrides` (= the 3MF-authored process tunings extracted by `read3mfProjectOverrides`) ABOVE the active profile's config — so if a 3MF authored `layer_height=0.20` and the user then picks `0.12 Fine @Snapmaker U1 (0.4 nozzle)` from the profile picker, the 3MF override silently wins and the slice comes out at 0.20 mm. Symptom: the user reported "estimated time 5 h 07 m vs desktop's 11 h 20 m" on the same model (200 layers vs 332). There's no in-XR way to see the 3MF was overriding the picker, so "I picked 0.12 → I get 0.12" is the only mental model that makes the picker mean anything. Layer-height keys flow exclusively from the user's profile pick + the layer-height-override TextField; other 3MF authored process keys (`sparse_infill_density`, `seam_position`, `support_*`, `wall_loops`, etc.) keep their `read3mfProjectOverrides` flow because those don't have a dedicated picker.

22. **Loading a 3MF fires *two* `previewStl` calls — sweep must not unlink in-flight bakes.** `LE_2162` fires on the selection change for the new model (call A); inside that bake, the embedded-color sync writes to `filamentEntriesStore`, which propagates to `previewPalette`, which fires the palette `LaunchedEffect` and runs a second bake (call B). `SlicerEngine.writeColoredGlb` opens its output GLB for writing early in the JNI; if call A's `sweepOldPreviews(keep=v1)` runs while B's JNI has `v2.glb` open, the file gets unlinked, JNI keeps writing to the orphan FD, and the bytes vanish at FD close. Symptom: model invisible after a successful 3MF load, `FileNotFoundException` on `_v2.glb`. `sweepOldPreviews` must only delete versions strictly older than `keep`'s version number.

23. **`ModelObject::raw_bounding_box()` already includes the instance's rotation+scale (via `get_matrix_no_offset()`).** Pairing it with `world_bbox_of(b, instance->get_matrix())` re-applies rotation+scale and inflates the result. Symptoms when this happens to the per-object `world_bbox` used to compute the GLB grounding shift: the model floats above the bed (12+ mm of phantom Z), and the over-large derived AABB also propagates into `oz` for downstream `translateZmm`. Always pair `world_bbox_of(...)` with `mo->raw_mesh_bounding_box()` (per-volume transforms only, no instance xform) so the full instance matrix can be applied exactly once. The header for `world_bbox_of` in `slic3r_jni.cpp` carries the same warning — don't backslide.

24. **`previewStl` bakes one PER-OBJECT GLB per `PlacedModel` for multi-object 3MFs (gotcha #21), but `deriveStlFor(bakeSource)` returns the FULL 3MF derived STL.** Using its bbox to set `baseBboxX/Y/Z` on each per-object PlacedModel (`bakeIndex >= 0`) gives every object the *whole-3MF layout footprint* (e.g. 134×108 for a 5-unicorn print), which the selection bbox / gizmo / `footprintMm()` then read as if each unicorn were a 134×108 monster. Skip the `baseBbox` override when `bakeIndex >= 0`; per-object dims set by `nativeRead3mfObjectMetadata` at load time are accurate.

25. **G-code thumbnails are rendered headless via a software rasterizer in `app/src/main/cpp/thumbnail_render.cpp`, NOT via libslic3r's GUI offscreen-GL path.** OrcaXR has no GL context inside the JNI shim and we don't want to set one up just for thumbnails. Instead, `nativeSlice` / `nativeSliceMulti` install a `ThumbnailsGeneratorCallback` that runs an in-process triangle rasterizer over the loaded `Slic3r::Model` and returns RGBA pixels for libslic3r to PNG-compress and embed. Three load-bearing pieces have to all be there for `; thumbnail begin` blocks to actually appear in the gcode: (a) the active machine profile authors `thumbnails` (e.g. Snapmaker U1's `"48x48/PNG, 300x300/PNG"`); (b) `OrcaProfileLoader.SAFE_KEYS` whitelists `thumbnails` and `thumbnails_format` so the key doesn't get silently dropped; (c) `make_thumbnail_callback(model, cfg)` is the third arg to `print.export_gcode(...)` — passing `nullptr` (the pre-A8 default) skips thumbnail emission silently. The rasterizer reads `filament_colour` out of `cfg` so multi-color models render with their per-extruder palette; missing/unparseable entries fall back to neutral gray.

26. **Snapmaker profile leaves under `app/src/main/assets/profiles/Snapmaker/` are vendored from Snapmaker's downstream OrcaSlicer fork (https://github.com/Snapmaker/OrcaSlicer), pinned to v2.3.1 — NOT from upstream OrcaSlicer.** Process and machine leaves were already byte-identical to fork v2.3.1. The filament leaves had drifted in a few load-bearing places that affect the U1 print-time estimate (Phase 1 of A9): `Snapmaker PLA Matte @U1.json` had `filament_max_volumetric_speed=20` (fork: 22), `enable_pressure_advance=1` (fork: 0), `nozzle_temperature=215`/220 (fork: 215), `hot_plate_temp=55` (fork: 65); `fdm_filament_pla.json` had `temperature_vitrification=154` (fork: 65 — orcaxr's value was outright wrong for PLA, whose Tg is ~60°C), `nozzle_temperature=210` (fork: 215), `filament_retraction_length=1.2` (fork: 2). When re-vendoring an additional Snapmaker leaf, diff against `git show v2.3.1:resources/profiles/Snapmaker/<path>` in a Snapmaker/OrcaSlicer checkout, NOT against upstream OrcaSlicer's bundled Snapmaker profiles — those carry Bambu-leaning defaults that produce different slice timing. The instrumented `unicornEstimateMatchesDesktopWithinFivePercent` test pins the SHAPE (332 layers, 385 toolchanges) AND the time estimate (within ±5 % of 11h 20m) against the user's reference Einhorn slice; a regression in either surfaces there. Note that some Snapmaker-fork-only keys (`filament_retract_length_toolchange`, `graphic_effect_plate_temp`, `is_custom_defined`) aren't in upstream PrintConfig and stay unsynced — Phase 2 of A9 (engine-behavior parity) is where those land. **A9 Phase 2 finding (2026-05-02):** the Phase 1 sync target (fork v2.3.1 raw bundled defaults) was wrong for the U1 print-quality test. The user's reference desktop gcode at `~/Downloads/Einhorn Knitted_PLA_11h20m_orca.gcode` was sliced with CUSTOMIZED values that drift from fork raw defaults — `filament_max_volumetric_speed=20` (fork:22), `filament_flow_ratio=0.966` (fork:1), `nozzle_temperature=220` (fork:215). Two of the three Phase 1 changes moved OrcaXR FURTHER from the desktop reference, not closer. **When syncing for the time-estimate test, diff against the user's reference gcode CONFIG_BLOCK** (lines `; CONFIG_BLOCK_START` … `; CONFIG_BLOCK_END` near the file's end), NOT against fork raw defaults. The drift-detector script lives at `/tmp/profile_drift.py` for ad-hoc reuse: it loads the gcode header, walks OrcaXR's profile inheritance chain, and prints every key where the resolved profile value differs from the gcode CONFIG_BLOCK value. The structural fix (extending `SlicerEngine.PROJECT_OVERRIDE_KEYS` from 11 → 56 keys so 3MF-embedded `project_settings.config` overrides can flow through) ships separately — see [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §7. **A9 Phase 2 closing finding (2026-05-02):** the residual 22.7 % gap (after enable_support=1 closes the first 10 %) is **upstream's planner refactor between v2.3.1 → v2.3.2 in `GCode/GCodeProcessor.cpp::TimeMachine::calculate_time`** — pass order swapped from forward-then-reverse to the Marlin-canonical reverse-then-forward, `planner_reverse_pass_kernel` rewritten with cascade-on-`next.flags.recalculate`, and `recalculate_trapezoids` mutation switched from copy-back-only-`trapezoid` to in-place `feedrate_profile.exit` propagation. Upstream's planner produces systematically lower (more optimistic) time estimates for the same emitted G-code, especially in late layers where short ramp-dominated blocks are sensitive to pass-order convergence. The §6 audit's claim that `GCodeProcessor.cpp` is "byte-identical" was wrong (file gained 41 KB / 19 % between v2.3.1 and v2.3.2). The right call is to ACCEPT this divergence — Klipper hardware realizes the more aggressive cruise velocities upstream's planner predicts; reverting would intentionally regress the time estimator. `UnicornFineProfileTest.unicornEstimateMatchesDesktopWithinFivePercent` stays `@Ignore`d permanently as a "did the gap widen further?" regression guard; A9 Phase 2 is closed. See [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §9 for the source citations.

28. **Embossing / SVG / text-on-object (D4) reuses libslic3r `Emboss` + `NSVGUtils` — do NOT roll a custom glyph-to-mesh path.** D4's natural-looking instinct is to write a FreeType outline walker in the JNI shim and triangulate by hand; libslic3r already ships every step we need (and they're already linked into `liblibslic3r.a`): `Emboss::create_font_file(const char*)` for stb_truetype loading, `Emboss::text2shapes(FontFileWithCache&, const char*, FontProp)` for glyph-soup → ExPolygons (with healing pass), `to_polygons(NSVGimage&, NSVGLineParams)` for SVG path → polygons, `union_ex(Polygons)` for hole resolution, and `Emboss::polygons2model(ExPolygons, IProjection)` + `ProjectScale(make_unique<ProjectZ>(depth/scale), scale)` for the extrude. The shape→mm scale for text is `Emboss::get_text_shape_scale(fp, *font_file)`; for SVG it's the libslic3r global `SCALING_FACTOR`. **Three non-obvious things the implementation has to honor**: (a) `MeshBoolean::mcut::make_boolean(host, emboss, results, "UNION" | "A_NOT_B")` is the right boolean for emboss/engrave, NOT `MeshBoolean::cgal::plus/minus` — gotcha #27 still applies (`triangle_mesh_to_cgal` throws "Mesh not watertight" on the freshly-extruded emboss block, which has open bottom faces along the glyph perimeter where polygons2model joins front+back fans). mcut's tolerant boolean handles the imperfect emboss surface; CGAL doesn't. (b) The text/SVG mesh built by `polygons2model` is in printer-mm coords with Z = 0..depthMm, but its XY origin is wherever `text2shapes`/`to_polygons` happened to lay glyphs out (often shifted relative to the user's mental model of "centered text"). The JNI shim re-translates the mesh post-extrusion so bbox-center sits on (0,0) — without that, `EmbossOp.transformForTopOfBbox` puts the text in the wrong spot on the host. (c) Same paint-state sweep as gotcha #27 applies on `PlacedModel.source` swap: drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` because the boolean re-meshes the host. See `nativeBuildTextMesh` / `nativeBuildSvgMesh` / `nativeApplyEmboss` in `slic3r_jni.cpp`, `EmbossOp.kt`, `EmbossAssets.kt`, and `MainActivity::runEmboss`. Bundled fonts ship in `app/src/main/assets/fonts/` (DejaVu Sans Bold + DejaVu Serif); a sample SVG ships in `app/src/main/assets/svg/heart.svg`.

27. **Mesh repair / "Fix Model" composes already-exported libslic3r symbols — do NOT add a new `MeshBoolean::cgal::repair()` inside the v2.3.2 submodule.** A5's natural-looking instinct is to write a CGAL-PMP-based repair function in `MeshBoolean.cpp` (the upstream-style approach: `repair_polygon_soup` → `orient_polygon_soup` → `corefine_and_compute_union(self, self)`). That triggers a multi-hour libslic3r rebuild on every dev machine for zero functional gain, because libslic3r already exports the moving parts: `MeshBoolean::self_union(TriangleMesh&)` is exactly that pipeline (igl→CGAL `mesh_boolean(union, A, ∅)`), and the ADMesh family (`its_merge_vertices`, `its_remove_degenerate_faces`, `its_compactify_vertices`, `its_num_open_edges`, `MeshBoolean::cgal::does_self_intersect`) handles everything ADMesh-class. Compose them from the JNI shim. **Two non-obvious things the implementation has to honor**: (a) `MeshBoolean::self_union(TriangleMesh)` (igl path) ACCEPTS polygon soup, but `MeshBoolean::cgal::triangle_mesh_to_cgal(mesh, surface_mesh)` (used by `MeshBoolean::cgal::plus/minus/intersect`) throws `Slic3r::RuntimeError("Mesh not watertight")` when `CGAL::is_closed(out)` is false — for repair we want the igl flavor. (b) The Kotlin caller MUST drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` when replacing `PlacedModel.source` with the repaired output — those are per-original-triangle indices and won't survive a CGAL re-mesh (44 tris from the test fixture's 24-tri input means the index space is gone). Skipping that sweep is the trap that produces a repaired mesh with paint bleeding into the wrong faces. See `nativeRepairModel` and `MainActivity::runRepair`.

1. **Pre-Bundle Requirement:** Before building a bundle for the Play Store, you MUST run `./gradlew versionCatalogUpdate` to check for library updates. If any updates are found, notify the user, commit the changes to `gradle/libs.versions.toml`, and advise the user to perform regression testing before final bundle generation.

2. **Dependency Update Review:** `./gradlew versionCatalogUpdate` updates `gradle/libs.versions.toml`. Always review `git diff gradle/libs.versions.toml` before committing — XR / Compose / Media3 patch bumps occasionally break the build.

## MCP server (C6) — architecture

OrcaXR ships an in-process MCP (Model Context Protocol) server so an LLM
agent (Claude Desktop, the Anthropic SDK's tool router, etc.) can drive
every action a human can take in the UI. This is the foundation for a
natural-language interface to the slicer — the plan is "every
human-facing action gets an MCP tool."

**Lives in:** `app/src/main/java/dev/orcaxr/app/mcp/`. Self-contained
package — no external server framework, no extra deps. Tools split by
domain under `mcp/tools/`.

**Transport:** plain HTTP/1.1 + JSON-RPC 2.0, hand-rolled on
`ServerSocket`. Single endpoint at `POST /mcp`; `GET /` returns a
human-readable status blurb. The MCP "Streamable HTTP" SSE half is
**not** implemented yet — request/response is enough for the current
tool surface and Claude Desktop's HTTP transport speaks it. Add SSE
when a tool needs to stream progress (e.g. `slice_active_plate` once
that ships).

**Lifecycle:** `McpController.get(ctx).start()` is called from
`OrcaXRApplication.onCreate`. It watches `McpSettings`'s `enabled` +
`port` flows and starts/stops the underlying `McpServer`
accordingly. Disabled by default — the user opts in from the Devices
panel (`McpServerCard`).

**Auth:** randomly-generated bearer token, persisted to DataStore on
first enable. `initialize` / `tools/list` / `ping` are auth-free for
client discovery; everything that mutates state requires
`Authorization: Bearer <token>`. UI offers show / copy / rotate.

**State hoisting:** two layers.
- *Stores* (`PrintersStore`/`UserProfilesStore`/`FilamentEntriesStore`/etc.) are
already process-singletons and tools read/write them directly via
`ToolContext`.
- *In-session shell state* (`placedModels`, `selectedModelIds`,
`gizmoTool`, `paintBrush`, `sliceState`, `workspaceMode`,
`activePlateId`, `selectedProfile.value`, `selectedPrinterId.value`,
`layerHeightOverride.value`, `bedFit`, `bedCollision`,
`maxLayer.value`, `showTravels.value`, `toolpathTubes.value`,
`printSettingsOverrides.value`) is mirrored into the
process-scoped `WorkspaceModel` singleton (`mcp/WorkspaceModel.kt`)
via the `BindWorkspaceModel` Composable that XrShell calls once near
its top. Each tracked piece of state has its own
`LaunchedEffect(value) { workspace.publishX(value) }`. MCP tools READ
straight from the model's `StateFlow`s. Mutations are posted as
`WorkspaceAction` values into a `SharedFlow`; `BindWorkspaceModel`
collects them and routes back through the same setters the UI uses,
so every observer (re-bake, validation, save) fires identically
whether the change came from a pinch or a tool call.

**Adding a new piece of in-session state:** (1) add a
`MutableStateFlow` + `publishX` setter to `WorkspaceModel`, (2) add
the corresponding parameter + `LaunchedEffect(value)` to
`BindWorkspaceModel`, (3) pass it from XrShell's call site, (4) add
the read tool that snapshots it. Don't reach into the singleton from
MainActivity directly — go through the publisher API so the
write-back path stays unidirectional.

**Adding a new mutator action:** (1) declare the case in
`WorkspaceAction`, (2) handle it in `WorkspaceBinding.handleAction`,
(3) add the tool that emits it. For mutators that need access to a
MainActivity-local function (slice, save, auto-arrange), add a
nullable callback parameter to `BindWorkspaceModel` and route through
it — XrShell's call site (placed *after* the local funs are declared)
provides the lambda. Don't try to reach into private functions from
the binding file.

**Where the `BindWorkspaceModel` call lives:** XrShell calls it once,
after `runSliceMulti` is declared (just before the re-preview
LaunchedEffect block at the start of the rendering section). All
state vars are still in scope at that point, AND the local
`runSlice`/`runSliceMulti`/`runAutoArrange`/`saveGcodeToDownloads`/
`runRepair`/`runCut`/`runBoolean`/`runSplit` family is now visible so
the Tier-B callbacks can close over them. Don't move it back up
before those funs are declared — the closures won't compile.

**Stale-closure trap inside `BindWorkspaceModel`:** the action
collector lives in a `LaunchedEffect(workspace) { ... }` whose
coroutine survives recomposition. Every callback / setter / state
read used inside the collector MUST go through `rememberUpdatedState`
before being passed to the dispatcher. Without it, the very first
composition's lambdas freeze in the collector's closure and any
later UI-driven state change becomes invisible to MCP-triggered
actions. The "what does the LLM see when it slices right after the
user added a model" bug fixed in Phase 2.3 was exactly this — keep
the `rememberUpdatedState` wrappers around every callback when you
add a new one.

**Function-with-`selectedModel`-closure trap:** local funs in XrShell
that read `selectedModel` (e.g. `runCut`) capture the value at
composition time. MCP tools that target a specific model id can't
just `selectedModelIds = setOf(id); runX()` — `runX` would still see
the OLD `selectedModel`. Either (a) extend the local fun with a
`sourceOverride: PlacedModel? = null` param (preferred — minimal
diff, the XR-button path keeps working) and have the MCP callback
look the model up in `placedModels` and pass it explicitly, or (b)
write the logic inline in the MCP callback. `runCut` uses (a) as the
canonical example.

**Tool naming convention:** `<verb>_<object>` snake_case
(`list_printers`, `add_plate`, `start_print`,
`get_user_preferences`). The verb is canonical: `list_*`/`get_*` for
reads, `add_*`/`update_*`/`delete_*` for store mutations,
`<action>_*` for verbs (`start_print`, `pause_print`).

**Tool result shape:** `text` content for human readability +
`structuredContent` JSON for machine parsing. Both should be present
on every tool result. Errors set `isError: true` in the tool result
(not a JSON-RPC error envelope) for "the tool ran and returned a
failure" cases; throw exceptions only for unexpected bugs (those get
promoted to `-32002 TOOL_FAILED`).

**Don't do:** roll your own JSON serializer (use `org.json`), pull in
Ktor / Netty / NanoHTTPD (we already speak ServerSocket), expose
transient UI state (hover, animation phase, modal-open booleans —
they're not actions, they're optical artifacts), or make any tool
that *isn't* reachable without going through MainActivity-only state
without first hoisting that state into `WorkspaceModel`. The tool's
job is not to know how OrcaXR's Compose tree is wired.

**Tests:** unit tests under
`app/src/test/java/dev/orcaxr/app/mcp/` cover the JSON-RPC parser,
auth gate, and a real-socket end-to-end round-trip with an in-process
server. Tests rely on
`testOptions.unitTests.isReturnDefaultValues = true` so
`android.util.Log` calls in production code don't blow up the unit
harness.

## C7 — digital-twin monitoring

`WorkspaceMode.Devices` is the third workspace mode (Prepare /
Preview / Devices). When entered, the four slicing panels
(`LeftProjectPanel`, `RightSettingsPanel`, `BottomLayerPreviewPanel`,
`BottomRightSummaryPanel`) hide via `if (workspaceMode !=
WorkspaceMode.Devices)` guards at their MovablePanelWrapper call
sites; `PrinterPanel` (the existing `devicesShown` overlay) and
`PrintMonitorPanel` (the existing active-print pause/resume/cancel +
webcam panel) become the dominant chrome. Workspace rendering uses
the Preview branch of the `when (workspaceMode)` block in XrShell —
the toolpath GLB is what the user sees.

**Live-Z auto-follow.** `MoonrakerClient.PrintSnapshot` carries
`liveZmm` (parsed from `toolhead.position[2]`) plus
`gcodeFilePosition` / `gcodeFileSize` (from `virtual_sdcard`). A
`LaunchedEffect(workspaceMode, selectedPrinterId)` watches the
selected printer's snapshot at 500ms cadence and binary-searches
`liveZmm` against `parsedToolpath.layerZs`, writing the result into
`maxLayer.value`. The existing toolpath-rebake observer
(`LaunchedEffect(sliceState, maxLayer, ...)`) picks up the change and
the GLB grows in lockstep with the physical print head. **Don't add
a separate "twin" entity** — the existing toolpath rendering with
the layer scrubber driven from telemetry IS the digital twin. A
duplicate entity would double the GLB bake cost for no UX win.

**Don't add a new ToolpathGlb.write parameter.** The existing
`maxLayerInclusive: Int?` is the natural progress filter. Telemetry
maps Z → layer index and reuses it. If you ever do need more
granularity than per-layer (e.g. live byte-position into the *current*
layer), that's a follow-up that adds a `maxByteOffset` filter — but
do it only when the layer-granularity twin proves to be too coarse on
real hardware. So far it isn't.

## Related docs

- [`ROADMAP.md`](ROADMAP.md) — forward-looking feature roadmap (single source of truth).
- [`DESIGN.md`](DESIGN.md) — XR UX spec and baselines.
- [`patches/README.md`](patches/README.md) — rules for patches against the OrcaSlicer submodule.
