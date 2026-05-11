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

## User preferences

**Always ship the best version, never the easiest.** When asked for
improvements or fixes, do not present an "easy vs. best" tradeoff and
do not ask the user to pick. List the improvements and execute all of
them in priority order. Only stop to confirm if there's a genuinely
irreversible action or a specification ambiguity the code cannot
resolve. The user wants OrcaXR to be the best it can be, period —
asking for permission to do less work wastes their time.

**For overnight / async work:** ship verified end-to-end commits, not
plans. Build, run the relevant tests, and iterate until green before
calling it done. A failing test left for the user to find is a
half-finished task.

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

## Phone/tablet shell — diagnostics and crash visibility

The XR `MainActivity` and the phone/tablet `MobileActivity` share `OrcaXRApplication`, `CrashReporter`, and the libslic3r JNI bridge, but their crash-surfacing surfaces are NOT shared. `MainActivity` shows past-crash JSON via a Toast inside `setContent`; on phones, `MainActivity.onCreate` forwards to `MobileActivity` and `finish()`s before reaching `setContent`, so that Toast never fires. **Anything user-visible that has to survive a crash → restart cycle on the phone path must live inside `MobileShell` (or earlier in `OrcaXRApplication`), not in `MainActivity`.** As of 2026-05-07, `MobileShell` renders `PastCrashDialog` once per process when `CrashReporter.scanPastCrashes` is non-empty; the dialog includes a Copy-to-clipboard action because phone users can't `adb pull` `filesDir/crashes/` without USB debugging (and even then only with a debug-built APK via `run-as`).

Coroutine failures in `rememberCoroutineScope().launch` blocks (e.g. the file-import path in `FilesScreen`) propagate to the dispatcher's default handler, which on Android is `Thread.UncaughtExceptionHandler` → `CrashReporter` → OS kill. The user just sees "OrcaXR has stopped." Two defensive layers: (1) `OrcaXRApplication.appCoroutineExceptionHandler` is a process-singleton `CoroutineExceptionHandler` that records via `CrashReporter.recordCrash` then rethrows, so coroutine crashes look identical to thread crashes in the on-disk JSON; (2) every `scope.launch { ... }` body that does IO / DataStore / JNI work must wrap in `runCatching { ... }.onFailure { Toast … }` so a single bad file doesn't crash the process. The FilesScreen import flow is the canonical pattern.

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

11e. **`addComponent` queues an op against the entity's material instance — give Filament a few frames to bind it before triggering the IC attach.** Synchronous `entity = ent` immediately after `GltfModelEntity.create` + `applyWorkspacePose` lands the IC's collider attach on the render queue before the entity's material is bound, racing `split_engine_bridge.cc:100 NOT_FOUND: unknown material instance id: N`. Two `awaitFrame()` (gotcha #13's deferred dispose) is enough for the dispose direction but not for the create direction on heavy 3MF loads. Fix (2026-05-02): three `awaitFrame()` between create+pose and the Compose state assignment that triggers the DisposableEffect's IC attach. Applies to `GlbSceneEntity` and `SelectionBboxEntity`. **TransformGizmo handles (Translate/Rotate/Scale, three call sites) need MORE than three awaitFrame** — when a 3MF first lands, gotcha #22's twin `writeColoredGlb` calls + the SelectionBbox attach already saturate Filament's bind queue; three more handles racing in saturate it past the breaking point. Fix (2026-05-04): (a) gate the TransformGizmo composable on `selectedModel.previewPath != null` at the call site so the gizmo doesn't compose at all until the model preview GLB has hit disk, and (b) inside each handle's `LaunchedEffect(session, filename)`, prefix a `delay(250)` BEFORE the `GltfModelEntity.create` so even a re-composition during a heavy load gives Filament a clear runway. The original 3-awaitFrame post-create gate stays. The first 3MF load post-fix on 2026-05-04 stopped crashing at `material instance id: 25` / `27`.

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

14. **`nativeWriteColoredGlb` keeps `KHR_materials_unlit` and bakes shading into `COLOR_0`; do NOT switch to a PBR material.** Three prior approaches all failed:
    - **Drop unlit, leave only POSITION + COLOR_0** → Filament rendered black (PBR needs normals).
    - **Drop unlit, add NORMAL + a `pbrMetallicRoughness` material with no IBL** → still rendered near-black because Jetpack XR SceneCore (alpha13) does NOT install a default IBL when a `GltfModel` attaches.
    - **Drop unlit, add NORMAL + PBR + a bundled studio EXR via `SpatialEnvironment.preferredSpatialEnvironment.skybox`** (May 2026) → tripped gotcha #13. The PBR material widened Filament's per-bind window enough that the InteractableComponent attach lost the material-instance-id race: `split_engine_bridge.cc:100 NOT_FOUND: Attempt to use unknown material instance id: N`. Reproduces every launch with 2-3 placed models. Even keeping IBL + reverting the material widened the bind window slightly because Filament has more probes to resolve at material instantiation time.

    Current approach: keep `KHR_materials_unlit` (cheap material bind, safe against gotcha #13) AND bake an 8-direction half-Lambert hemisphere PLUS a curvature/cavity term into `COLOR_0` before writing the GLB. The 8 lights cover a soft-box studio rig (zenith key, NESW fills, two diagonals, one weak underlight); each contributes `intensity * (0.5 + 0.5 * dot(n, L))` so back-facing triangles aren't pitch black. The cavity term reads `dot(smooth_normal, mean(unit_face_normals))` — that dot product approaches 1.0 on flat regions and collapses on creases, which we use as an O(vertex_count) proxy for AO. `CAVITY_STRENGTH=0.55` picks out eye sockets / mouth grooves / finger gaps without crushing back-facing triangles. Output GLB is positions + colors + indices only — no NORMAL accessor (unlit ignores it). The full bake is O(vertex_count + 8 * vertex_count) — well under the dispose-safe window. Don't try to add a real ray-cast AO pass, that's the O(vertex × triangle) trap that was originally reverted.

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

20. **FullSpectrum mixed-filament integration: data-model + wire format are at FS v0.9.9 parity, engine emission is NOT ported.** As of 2026-05-10 the patches 0015-0024 land all data structures (`MixedFilament.{cpp,hpp}`, `filament_mixer*`, `LocalZOrderOptimizer.hpp`), register the 17 PrintConfig keys (`mixed_filament_*`, `dithering_*`, `local_z_wipe_tower_purge_lines`), and add the `MixedFilamentManager` member on `Print`. The Kotlin side (`MixedFilamentEntry`, `MixedFilamentStore.toMixedFilamentDefinitions`, `parseMixedDefinitionsForKotlin` in MainActivity, `OrcaProfileLoader.SAFE_KEYS`, `SlicerEngine.PROJECT_OVERRIDE_KEYS`, `MixedAdvancedEditor` UX, MCP `set_mixed_filament_row` / `delete_mixed_filament_row` / `list_mixed_filaments`) all speak the v0.9.9 wire format and round-trip cleanly. **Patches 0027-0063 landed + verified compile-clean 2026-05-11.** Every FS file delta NOT entangled with the Local-Z planner has been ported:
  - 0027 `PrintConfig.hpp` typed fields for the 20 FS dithering + mixed-filament keys
  - 0028 `ToolOrdering.hpp::LayerTools::object_layer_count`
  - 0029 `ExtrusionEntity.hpp` inset_idx propagation through MultiPath/Loop copy/move/assignment
  - 0030 `PerimeterGenerator.cpp` inset_idx population on emitted Loops/MultiPaths
  - 0031 `VariableWidth.cpp` gap-fill loop dedup + closed-loop single-extrusion shortcut (FS print-quality improvement)
  - 0032 `LayerRegion.cpp` + `Layer.hpp` + `Fill/Fill.cpp` virtual filament resolution at the per-layer flow / extruder level
  - 0033 `Layer.cpp` surface metadata preservation across merged-region perimeter generation
  - 0034 `Preset.cpp` + `PrintRegion.cpp` infill-filament-override at preset / extruder-collection time
  - 0035 `PrintApply.cpp` mixed-component expansion for painted virtual filament IDs
  - 0036 `ToolOrdering.cpp` infill resolution (FS override + boundary-layer + grouped manual_pattern)
  - 0037 `PrintObject.cpp` config-key invalidation for the FS keys
  - 0038 `PrintConfig.cpp` registers the three FS region-level override keys (defaults + GUI metadata)
  - 0039 `ToolOrdering.cpp::collect_extruders` populates object_layer_count + routes 100%-density solid infill via sparse path + emits through LayerTools FS-aware methods
  - 0040 `PrintObject.cpp` apply_to_print_region_config / slicing_parameters / combine_infill respect the FS override toggle
  - 0041 `PrintApply.cpp` painted-region creation gated on mm_paint_applies_to_parent_region + unique-region instances per painted extruder
  - 0042 `PrintObject.cpp` separate invalidation block for the 8 FS mixed-filament gradient + region-collapse keys (without it `mixed_filament_definitions` changes silently reuse old slice state)
  - 0043 `PresetBundle.cpp::s_project_options` adds the 15 FS keys so `mixed_filament_definitions` persists into the saved .3mf's `Metadata/project_settings.config` (without this, virtual rows are lost on save+reopen)
  - 0044 `Print.hpp` Local-Z type scaffolding: `LocalZInterval` struct + `SubLayerPlan` struct + `PrintObject::local_z_intervals()` / `local_z_sublayer_plan()` / `set_local_z_plan()` / `clear_local_z_plan()` accessors + `m_local_z_intervals` / `m_local_z_sublayer_plan` private members + `WipeTowerData::local_z_tool_changes` field. **Dead code** — nothing populates or reads these yet.
  - 0045 `PrintObjectSlice.cpp` Local-Z helper batch 1: `bool_from_full_config`, `float_from_full_config`, `segmentation_channel_filament_id`, `mixed_filament_reference_nozzle_mm`, `clamped_mixed_component_surface_offset` + `#include <numeric>`. All static helpers, dead-code until `build_local_z_plan` (future patch) consumes them.
  - 0046 `PrintObjectSlice.cpp` Local-Z helper batch 2 (pass-height math, ~390 LoC): `fit_pass_heights_to_interval`, `sanitize_local_z_pass_heights`, `build_uniform_local_z_pass_heights`, `build_uniform_local_z_pass_heights_exact`, `compute_local_z_gradient_component_heights`, `choose_local_z_start_with_component_a`, `build_local_z_alternating_pass_heights`, `build_local_z_two_pass_heights`, `build_local_z_shared_pass_heights`, `build_local_z_pass_heights` (dispatcher). All static, redistribute a nominal layer's vertical budget across N sub-passes while honoring [lo, hi] envelopes.
  - 0047 `PrintObjectSlice.cpp` Local-Z helper batch 3 (row-sequence decoders, ~375 LoC + LocalZActivePair struct): `decode_manual_pattern_sequence`, `decode_gradient_component_ids`, `decode_gradient_component_weights`, `reduce_weight_counts_to_cycle_limit`, `build_weighted_gradient_sequence`, `pointillism_sequence_for_row` (`#if 0`-gated mirror of FS), `local_z_eligible_mixed_row`, `local_z_direct_multicolor_row`, `unique_extruder_count` + `struct LocalZActivePair { component_a, component_b, mix_b_percent, uses_layer_cycle_sequence, valid_pair() }`. Turns MixedFilament row config strings into per-extruder cycles.
  - 0048 `PrintObjectSlice.cpp` Local-Z helper batch 4 (pair-cycle planner, ~250 LoC): `append_local_z_pair_option`, `build_local_z_pair_cycle_for_row`, `build_local_z_direct_multicolor_pass_heights`, `build_local_z_direct_multicolor_sequence`, `derive_local_z_active_pair`. Maps a row's gradient ID list into a per-cadence sequence of LocalZActivePair options + multi-component pass height/sequence pairs.
  - 0049 `PrintObjectSlice.cpp` Local-Z helper batch 5 (mask stripes, ~150 LoC): `split_masks_pointillism_stripes` (XY stripe splitter, alternates vertical/horizontal each layer), `non_empty_mask_count`, `collect_layer_region_slices`. Pure geometric helpers.
  - 0050 `PrintObjectSlice.cpp` `apply_mixed_region_surface_offsets` (~145 LoC): walks every LayerRegion of every Layer and, for mixed-filament regions with non-zero per-component surface offsets, contracts (offset > 0) or expands (< 0) the region's slice geometry, subtracting stolen geometry from neighbours when expanding. Gated off when `dithering_local_z_mode` is on or `mixed_filament_component_bias_enabled` is off.
  - 0051 `PrintObjectSlice.cpp` Local-Z helper batch 7 (planner input-prep, ~278 LoC): `export_local_z_plan_debug` (no-op stub — FS body needs <fstream>+SVG.hpp), `whole_object_local_z_segmentation_by_mixed_wall`, `local_z_planner_segmentation_with_whole_object_mixed_wall`, `collect_local_z_fixed_state_masks_by_extruder`, `build_local_z_transition_fixed_masks_for_pass`. Prepares the (layer × channel × ExPolygons) segmentation grid + per-sublayer fixed-region mask emission that `build_local_z_plan` consumes.
  - 0052 `PrintObjectSlice.cpp` **build_local_z_plan** template (~990 LoC) — the central Local-Z planner. Walks every layer, reads the FS dithering config keys, builds per-mixed-row state (pair cycles + direct-multicolor solver + pointillism eligibility), and emits LocalZInterval + SubLayerPlan records into `PrintObject::set_local_z_plan` with painted_masks_by_extruder + fixed_painted_masks_by_extruder routed per sublayer Z pass. Honors per-row cadence + layer-cycle indices so A/B sequences don't restart at painted boundaries. Consumes every helper landed in 0044-0051. Compile-clean on first try via bottom-up ordering.
  - 0053 `WipeTower2.hpp/cpp` Local-Z scaffold (LZ4a, ~466 LoC): adds WipeTowerInfo::local_z_tool_changes + local_z_reserve_slot_depth/_count members + planned_depth() accessor; m_local_z_wipe_tower_purge_lines ctor-time field; plan_local_z_toolchange(z, h, old, new, wipe_vol) + plan_local_z_reserve(z, h, count, wipe_vol) method bodies.
  - 0054 `WipeTower2.hpp/cpp` soluble + depth helpers (LZ4b, ~521 LoC): layer_has_soluble_toolchange(layer) + cumulative_toolchange_depth_before(tool_change*) — both UNION layer.local_z_tool_changes with layer.tool_changes so callers can treat a wipe-tower layer as a single sequence.
  - 0055 `WipeTower2.hpp/cpp` Local-Z emission (LZ4c, ~677 LoC): local_z_tool_change(new_tool, cleaning_box, wipe_volume) emits one per-sub-Z purge as gcode (unload+change+load+wipe); get_local_z_reserve_boxes() returns per-layer pre-reserved purge boxes sized from local_z_reserve_slot_depth/_count; static rotate_local_z_reserve_point() helper. Adapts FS to our v2.3.2 baseline (5-arg WipeTowerWriter2 ctor, no m_change_pressure, toolchange_Wipe takes interface_layer bool).
  - 0056 `PrintObjectSlice.cpp` Local-Z planner wired into slice_volumes (LZ5a, 52 LoC): `dithering_local_z_mode` gate, whole_object_local_z_segmentation_by_mixed_wall → build_local_z_plan → set_local_z_plan; also actually CALLS apply_mixed_region_surface_offsets (was dead code prior). First patch in series where Local-Z code runs end-to-end at slice time. Painted-Local-Z path (FS line 5005, merged via local_z_planner_segmentation_with_whole_object_mixed_wall) deferred to LZ5c — needs apply_mm_segmentation refactored to expose the intermediate segmentation grid.
  - 0057 `Print.hpp/GCode.hpp/GCode.cpp` Local-Z purges plumbed into WipeTowerIntegration (LZ5b, 339 LoC): WipeTowerData::local_z_reserve_boxes vector + clear(); WipeTowerIntegration ctor + 4 new members (m_local_z_tool_changes, m_local_z_reserve_boxes refs + m_local_z_tool_change_idx, m_local_z_reserve_slot_idx per-layer cursors); next_layer() resets the cursors; call site at GCode.cpp:3290 forwards the new WipeTowerData fields.
  - 0058 `GCode.hpp/GCode.cpp` WipeTowerIntegration::tool_change Local-Z dispatch (LZ5c, 225 LoC): signature gains two optional params (`local_z_unplanned=false`, `local_z_nominal_layer_z=-1.`); early-return branch when `local_z_unplanned` is true that tries to consume the next preplanned tcr from `m_local_z_tool_changes[m_layer_idx]` matching (initial_tool, new_tool), else falls back to `gcodegen.set_extruder()` at `toolchange_print_z`. OrcaXR adapts FS's `writer().extruder()` to our `writer().filament()` (same accessor, different name). The reserve-box ad-hoc emission path (FS lines 1003-1188 — ephemeral WipeTower2 on a reserve box) is deferred — needs Print& threading.
  - 0059 `Print.cpp/WipeTower2.hpp` Local-Z reserve-box hook (LZ5d, 203 LoC): captures `wipe_tower.get_local_z_reserve_boxes()` into `m_wipe_tower_data.local_z_reserve_boxes` after the legacy `WipeTower2::generate(...)` call; promotes `local_z_tool_change` / `get_local_z_reserve_boxes` from private to public in `WipeTower2.hpp`.
  - 0060 `Print.cpp` `collect_local_z_wipe_tower_toolchanges` + wipe-tower planning hook (LZ5e, 530 LoC): anonymous-namespace block with `LocalZWipeTowerToolchange` + `LocalZWipeTowerPassRef` structs, perimeter intersection probes, small extruder-ordering helpers, and the ~325-LoC `collect_local_z_wipe_tower_toolchanges` itself (legacy print_z-group mode + dependency-chain topological scheduler). Wires `collect_layers_to_print` → `collect_local_z_wipe_tower_toolchanges` → `WipeTower2::plan_local_z_toolchange` into the wipe-tower planning loop. **With patch 0060, Local-Z purges are actually PLANNED through the wipe tower.**
  - 0061 `GCode.cpp` `process_layer` Local-Z context setup (LZ5f scaffold, 255 LoC): `LocalZPassBucket` / `LocalZLayerContext` struct defs + per-LayerToPrint setup loop that walks `PrintObject::local_z_sublayer_plan()` and accumulates one bucket per `split_interval` plan with perimeter-expanded per-extruder masks (compensation = 0.10 mm). Gated off when `is_anything_overridden` is true.
  - 0062 `GCode.cpp` `process_layer` Local-Z pass-ref prep (LZ5g-prep, 352 LoC): `local_z_perimeter_phase_b_enabled` flag + `LocalZPassRef` struct + `local_z_pass_refs` sort + three accessor lambdas. Diagnostic log on prep.
  - 0063 `GCode.cpp` Local-Z extrusion-clipping helpers (LZ5g helpers, 539 LoC): file-scope static helpers used by the future LZ5g-emit population branch — `apply_local_z_flow_height_override`, `append_clipped_path`, `local_z_compensate_masks`, `struct LocalZPathHeightStats` + 3 `collect_local_z_path_height_stats` overloads + `finalize_local_z_path_height_stats`, `clip_extrusion_collection_for_local_z`. All static, dead code until LZ5g-emit consumes them. **What remains:** LZ5g-emit — (a) the per-region clipping branch (FS lines 5336-5400, ~70 LoC) that populates `LocalZPassBucket::by_extruder` via `clip_extrusion_collection_for_local_z`, (b) `mixed_masks_union` + base-mask exclude setup (~200 LoC), (c) the actual emit branch (FS 5665-6036, ~370 LoC) that walks pass_refs, calls `tool_change(.../*local_z_unplanned=*/true, sub_z)` per Local-Z toolchange, and emits perimeters at the sub-Z print_z via `travel_to_z` + `extrude_perimeters`.

Each patch verified by incremental `cmake --build` (0 FAILED objects) + `./gradlew :app:assembleDebug` (full APK assembled). The build also fixed three pre-existing latent compile errors in `app/src/main/cpp/slic3r_jni.cpp` from commit 6942a12 (most-vexing-parse + namespace-qualified alias under NDK 29 Clang 19) — mechanical `static_cast<size_t>(n_t)` + bare `double` cast.

**LayerCycle mode is wired end-to-end via the existing patch stack + the new patch 0027-0041 series (2026-05-11 audit):** patches 0015 + 0017 + 0018 + 0019 + 0024 already provide every piece the per-layer alternating-extruder path needs — (1) `MixedFilament.cpp::resolve()` lines 1980-1988 implement the `((layer_index % cycle) + cycle) % cycle` LayerCycle algorithm directly; (2) `PrintApply.cpp::1361-1364` calls `m_mixed_filament_mgr.clear_custom_entries()` + `auto_generate()` + `load_custom_entries(serialized_defs, physical_filament_colors)` during config application; (3) `ToolOrdering.cpp::693-710` defines a `resolve_filament_for_layer` lambda that wraps `MixedFilamentManager::resolve(...)`; (4) `ToolOrdering.cpp::749 + 780 + 782 + 784` calls that lambda for `wall_filament` / `solid_infill_filament` / `sparse_infill_filament` / `extruder_override` per region, populating `layer_tools.extruders` with the resolved physical extruder; (5) `MultiMaterialSegmentation.cpp::2208-2213` already sizes `num_facets_states` via `MixedFilamentManager::total_filaments(num_physical)` so painted virtual-slot triangles flow into proper per-extruder regions; (6) `GCode.cpp` iterates `layer_tools.extruders` for emission. So a 2-physical + 1-virtual project authored via `mixed_filament_definitions=A,B,1,1,50,0,g,w,m0,z0,xa0,xb0,d0,o0,u1` with `wall_filament=3` (or painted facets with slot=3) SHOULD already emit alternating T0/T1 layers — no patches 0029-0033 needed for LayerCycle. **Pointillisme is `#if 0`'d upstream as of FS v0.9.9.** Audit 2026-05-11: `pointillism_sequence_for_row_for_gcode` in `src/libslic3r/GCode.cpp:3884-3951` is wrapped in `#if 0 ... #endif` and unconditionally returns `{}`. The downstream integration site (`GCode.cpp:5423-5462`) treats an empty sequence as "skip Pointillisme branch," so even with every other piece of the FS port (helpers `split_polyline_by_length_for_pointillism`, `trim_polyline_for_pointillism_gap`, `split_extrusion_collection_for_pointillism_paths`, `PointillismPathSplitStats`, the `k_pointillism_path_inset_marker` sentinel) in place, Pointillisme prints fall back to LayerCycle behavior. **Implication for OrcaXR:** we should NOT enable broken upstream code. Pointillisme is deferred until FS un-disables it (likely v0.9.10+ per the iteration trajectory in `ratdoux/OrcaSlicer-FullSpectrum` commit history). Mechanical prerequisite patches landed 2026-05-11: 0029 (`ExtrusionEntity.hpp` inset_idx propagation through ExtrusionMultiPath/Loop copy/move/assignment), 0030 (`PerimeterGenerator.cpp` populates inset_idx on emitted Loops/MultiPaths), 0031 (`VariableWidth.cpp` gap-fill loop dedup + closed-loop single-extrusion shortcut — a FS print-quality improvement unrelated to Pointillisme, ships standalone). **What's still required for Local-Z** (the second-most-impactful remaining mode): the engine-level sublayer planner in `PrintObjectSlice.cpp` (+3750 LoC — FS goes from 1641 to 5391 LoC, mostly Local-Z planner introducing `SubLayerPlan` struct + `LocalZWipeTowerToolchange` types), `Print.cpp`/`PrintObject.cpp`/`PrintApply.cpp` +636 LoC for planner lifecycle, `WipeTower2.cpp` +229 LoC for purge sequencing, `GCode.cpp` +818 LoC for Z-walk emission + infill base-layer override, `LayerRegion.cpp` +121 LoC adding `extruder(FlowRole)` method that `Fill/Fill.cpp` +11 LoC now calls. Local-Z is genuinely active in FS v0.9.9 (not `#if 0`'d), so this port would deliver working sub-layered painted-zone Z slicing. Verification is gated on a connected arm64-v8a Android device — `FullSpectrumLayerCycleTest` is now @Ignore-free and lives at `app/src/androidTest/.../FullSpectrumLayerCycleTest.kt`; running `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=dev.orcaxr.app.FullSpectrumLayerCycleTest` against a Galaxy XR (or the Snapmaker U1's Android-based control panel) is the hardware-side test that confirms or refutes this analysis. **What's still missing (engine emission)**: the FS port of `PrintObjectSlice.cpp` (+2414 LoC sublayer planner — single biggest patch), `GCode/ToolOrdering.cpp` callers of `resolve_mixed_1based` (+311 LoC; patch 0019 already wires four call sites — `wall_filament`, `sparse_infill_filament`, `solid_infill_filament`, generic `extruder()` — but the planner that populates `LayerTools::layer_index/print_z/layer_height_for_mixed` is missing), `GCode.cpp` (+818 LoC toolchange-aware emission, Local-Z Z-walk, infill base-layer override), `WipeTower2.cpp` (+229 LoC Local-Z purge), `Print.cpp`/`PrintObject.cpp`/`PrintApply.cpp` (combined +636 LoC for `MixedFilamentManager` lifecycle + `WipeTowerData::local_z_tool_changes` plumbing), and segmentation routing (`MultiMaterialSegmentation.cpp` +13, `LayerRegion.cpp` +121, `Layer.cpp` +49, `VariableWidth.cpp` +139, `TriangleSelector.cpp` +52, `PerimeterGenerator.cpp` +8, `Fill.cpp` +11). Until those patches land, the slicer ACCEPTS `mixed_filament_definitions` (loaded into the `MixedFilamentManager` and round-tripped via 3MF) but EMITS single-filament-per-slot G-code — no alternating layers, no XY pointillism stripes, no Local-Z sub-layering. Source-of-truth for the port is FS tag `v0.9.9` (`ratdoux/OrcaSlicer-FullSpectrum`, commit b3c41fda), accessed semantically not via `git apply` because the fork sits on Snapmaker/OrcaSlicer 2.3 while OrcaXR pins upstream OrcaSlicer-Org v2.3.2. Headless instrumented tests (`FullSpectrumLayerCycleTest`, `FullSpectrumPointillismeTest`, `FullSpectrumLocalZTest`, `FullSpectrumRoundtripTest`) are scaffolded under `app/src/androidTest/` with `@Ignore` annotations referencing this gotcha — remove them once the engine patches land. **Auto-overrides:** when at least one enabled `MixedFilamentEntry` exists, `MainActivity.fullSpectrumExtraOverrides()` sets `mixed_filament_advanced_dithering=1` + `dithering_step_painted_zones_only=1` on every slice call (parallel to `wipeTowerExtraOverrides`); the rest of the dithering knobs use libslic3r defaults from patch 0016 until a dedicated per-printer Settings card surfaces them.

21. **All multi-object 3MFs are decomposed into separate STLs on import.** To allow per-object selection and transform (Phase B9), generic multi-object 3MFs extract each `ModelObject::mesh()` to a temporary STL in `cacheDir/extracted/<hash>/`. Each `PlacedModel` points to one of these STLs, sharing a `groupId` (the source 3MF's hash). `originalSource` tracks the original 3MF container path so `nativeWriteColoredGlb` can re-load the per-triangle `paint_color` metadata during re-bakes. STL has no material metadata, so carry the source object's one-based default extruder in `PlacedModel.previewFilamentIndex` as a fallback. **`runSliceMulti` MUST re-route to `originalSource` and pass `groupOrdinal` in the `objectOrdinals` parameter for any PlacedModel that has an `originalSource`** — the JNI then clones `Model::objects[ordinal]` from the original 3MF, preserving every painted volume's `mmu_segmentation_facets` / `supported_facets` / `seam_facets`. Going through the per-object STL strips all of those (STL ⇒ no facet annotations), and the resulting slice prints single-color with no supports, no purge tower, and no seam control even when each object was authored multicolor. Symptom that triggered the patch: 4 painted unicorns plated together yielded `postprocess_remap_tool_commands: 10 rewrites across 1.6M lines` — i.e. effectively no toolchanges. Pre-fix code path (`m.source` for everything) is the trap; the fix sends `(originalSource ?: source, groupOrdinal)` per input.

21b. **`nativeSliceMulti` MUST capture the source `ModelInstance`'s scale + rotation BEFORE `clear_instances()`** and compose them with the user's per-input transform. BBS / Bambu 3MFs encode per-instance scale + rotation in their `<build><item transform=...>` matrix — the knitted-unicorn 3MF authors `transform="1.5697 0 0 0 0 1.5697 0 -1.5697 0 ..."` (a 1.5697× uniform scale plus -90° X rotation that stands a Y-up authored mesh up onto the printer's Z-up bed). Discarding those by replacing the cloned object's instances drops the print to its raw mesh extents — symptom is the unicorn arriving at ~63 % of the desktop slicer's size (27 mm tall instead of the authored 40 mm) and the toolpath looking visually blob-y / squat. Compose: `final_scale = user_scale * src_scale`, `final_rotation = user_rotation + src_rotation` (Eulers — works for the X+Z-only axes the typical UI exposes), `final_offset = user_offset` (replace; the user's plate placement was authored against the scaled extents shown in Prepare). `nativeSlice` (single-model path) escapes this trap by leaving `mo->instances` alone entirely.

22. **`SlicerEngine.PROJECT_OVERRIDE_KEYS` MUST NOT include `layer_height` / `initial_layer_print_height` / `first_layer_height`.** `mergedConfig`'s precedence ladder applies `projectOverrides` (= the 3MF-authored process tunings extracted by `read3mfProjectOverrides`) ABOVE the active profile's config — so if a 3MF authored `layer_height=0.20` and the user then picks `0.12 Fine @Snapmaker U1 (0.4 nozzle)` from the profile picker, the 3MF override silently wins and the slice comes out at 0.20 mm. Symptom: the user reported "estimated time 5 h 07 m vs desktop's 11 h 20 m" on the same model (200 layers vs 332). There's no in-XR way to see the 3MF was overriding the picker, so "I picked 0.12 → I get 0.12" is the only mental model that makes the picker mean anything. Layer-height keys flow exclusively from the user's profile pick + the layer-height-override TextField; other 3MF authored process keys (`sparse_infill_density`, `seam_position`, `support_*`, `wall_loops`, etc.) keep their `read3mfProjectOverrides` flow because those don't have a dedicated picker.

22. **Loading a 3MF fires *two* `previewStl` calls — sweep must not unlink in-flight bakes.** `LE_2162` fires on the selection change for the new model (call A); inside that bake, the embedded-color sync writes to `filamentEntriesStore`, which propagates to `previewPalette`, which fires the palette `LaunchedEffect` and runs a second bake (call B). `SlicerEngine.writeColoredGlb` opens its output GLB for writing early in the JNI; if call A's `sweepOldPreviews(keep=v1)` runs while B's JNI has `v2.glb` open, the file gets unlinked, JNI keeps writing to the orphan FD, and the bytes vanish at FD close. Symptom: model invisible after a successful 3MF load, `FileNotFoundException` on `_v2.glb`. `sweepOldPreviews` must only delete versions strictly older than `keep`'s version number.

23. **`ModelObject::raw_bounding_box()` already includes the instance's rotation+scale (via `get_matrix_no_offset()`).** Pairing it with `world_bbox_of(b, instance->get_matrix())` re-applies rotation+scale and inflates the result. Symptoms when this happens to the per-object `world_bbox` used to compute the GLB grounding shift: the model floats above the bed (12+ mm of phantom Z), and the over-large derived AABB also propagates into `oz` for downstream `translateZmm`. Always pair `world_bbox_of(...)` with `mo->raw_mesh_bounding_box()` (per-volume transforms only, no instance xform) so the full instance matrix can be applied exactly once. The header for `world_bbox_of` in `slic3r_jni.cpp` carries the same warning — don't backslide.

24. **`previewStl` bakes one PER-OBJECT GLB per `PlacedModel` for multi-object 3MFs (gotcha #21), but `deriveStlFor(bakeSource)` returns the FULL 3MF derived STL.** Using its bbox to set `baseBboxX/Y/Z` on each per-object PlacedModel (`bakeIndex >= 0`) gives every object the *whole-3MF layout footprint* (e.g. 134×108 for a 5-unicorn print), which the selection bbox / gizmo / `footprintMm()` then read as if each unicorn were a 134×108 monster. Skip the `baseBbox` override when `bakeIndex >= 0`; per-object dims set by `nativeRead3mfObjectMetadata` at load time are accurate.

25. **G-code thumbnails are rendered headless via a software rasterizer in `app/src/main/cpp/thumbnail_render.cpp`, NOT via libslic3r's GUI offscreen-GL path.** OrcaXR has no GL context inside the JNI shim and we don't want to set one up just for thumbnails. Instead, `nativeSlice` / `nativeSliceMulti` install a `ThumbnailsGeneratorCallback` that runs an in-process triangle rasterizer over the loaded `Slic3r::Model` and returns RGBA pixels for libslic3r to PNG-compress and embed. Three load-bearing pieces have to all be there for `; thumbnail begin` blocks to actually appear in the gcode: (a) the active machine profile authors `thumbnails` (e.g. Snapmaker U1's `"48x48/PNG, 300x300/PNG"`); (b) `OrcaProfileLoader.SAFE_KEYS` whitelists `thumbnails` and `thumbnails_format` so the key doesn't get silently dropped; (c) `make_thumbnail_callback(model, cfg)` is the third arg to `print.export_gcode(...)` — passing `nullptr` (the pre-A8 default) skips thumbnail emission silently. The rasterizer reads `filament_colour` out of `cfg` so multi-color models render with their per-extruder palette; missing/unparseable entries fall back to neutral gray.

26. **Vendor profile leaves under `app/src/main/assets/profiles/<Vendor>/` come from each vendor's downstream OrcaSlicer fork, NOT upstream OrcaSlicer.** Sources:
- **Snapmaker** (`profiles/Snapmaker/`): https://github.com/Snapmaker/OrcaSlicer pinned to **v2.3.1**.
- **Elegoo** (`profiles/Elegoo/`): https://github.com/ELEGOO-3D/ElegooSlicer pinned to **release/v1.5.0**. The ECC machine bundle (Elegoo Centauri Carbon, four nozzle variants) lives upstream under `resources/profiles/Elegoo/{machine,filament,process}/{ECC,BASE,ELEGOO_02_NOZZLE,Generic,fdm_*}`. `host_type=elegoolink` is a sentinel — libslic3r doesn't recognize the value and silently drops it on deserialize, but the Kotlin-side PrinterRepository can read it directly from the JSON to dispatch a Centauri-aware Moonraker driver when one ships. Two upstream keys (`auto_toolchange_command`, `bed_texture_area`) are kept in the JSON for diff-friendliness with future upstream releases but aren't whitelisted in `OrcaProfileLoader.SAFE_KEYS` because libslic3r doesn't define them. The CC-current-firmware change_filament_gcode uses Elegoo's CCB protocol with `M6211` — **not** a CC2-only macro, current CC firmware also expects it. CC2 (Elegoo Centauri Carbon 2, IDEX) is **not** vendored — adding it requires the closed-source ElegooLink cloud SDK (Agora RTC + Paho MQTT) plus a `M6211` parsing patch in `GCodeProcessor.cpp`; defer until a CC2 device is on hand.

**Snapmaker fork v2.3.1 sync history (A9):** Process and machine leaves were already byte-identical to fork v2.3.1. The filament leaves had drifted in a few load-bearing places that affect the U1 print-time estimate (Phase 1 of A9): `Snapmaker PLA Matte @U1.json` had `filament_max_volumetric_speed=20` (fork: 22), `enable_pressure_advance=1` (fork: 0), `nozzle_temperature=215`/220 (fork: 215), `hot_plate_temp=55` (fork: 65); `fdm_filament_pla.json` had `temperature_vitrification=154` (fork: 65 — orcaxr's value was outright wrong for PLA, whose Tg is ~60°C), `nozzle_temperature=210` (fork: 215), `filament_retraction_length=1.2` (fork: 2). When re-vendoring an additional Snapmaker leaf, diff against `git show v2.3.1:resources/profiles/Snapmaker/<path>` in a Snapmaker/OrcaSlicer checkout, NOT against upstream OrcaSlicer's bundled Snapmaker profiles — those carry Bambu-leaning defaults that produce different slice timing. The instrumented `unicornEstimateMatchesDesktopWithinFivePercent` test pins the SHAPE (332 layers, 385 toolchanges) AND the time estimate (within ±5 % of 11h 20m) against the user's reference Einhorn slice; a regression in either surfaces there. Note that some Snapmaker-fork-only keys (`filament_retract_length_toolchange`, `graphic_effect_plate_temp`, `is_custom_defined`) aren't in upstream PrintConfig and stay unsynced — Phase 2 of A9 (engine-behavior parity) is where those land. **A9 Phase 2 finding (2026-05-02):** the Phase 1 sync target (fork v2.3.1 raw bundled defaults) was wrong for the U1 print-quality test. The user's reference desktop gcode at `~/Downloads/Einhorn Knitted_PLA_11h20m_orca.gcode` was sliced with CUSTOMIZED values that drift from fork raw defaults — `filament_max_volumetric_speed=20` (fork:22), `filament_flow_ratio=0.966` (fork:1), `nozzle_temperature=220` (fork:215). Two of the three Phase 1 changes moved OrcaXR FURTHER from the desktop reference, not closer. **When syncing for the time-estimate test, diff against the user's reference gcode CONFIG_BLOCK** (lines `; CONFIG_BLOCK_START` … `; CONFIG_BLOCK_END` near the file's end), NOT against fork raw defaults. The drift-detector script lives at `/tmp/profile_drift.py` for ad-hoc reuse: it loads the gcode header, walks OrcaXR's profile inheritance chain, and prints every key where the resolved profile value differs from the gcode CONFIG_BLOCK value. The structural fix (extending `SlicerEngine.PROJECT_OVERRIDE_KEYS` from 11 → 56 keys so 3MF-embedded `project_settings.config` overrides can flow through) ships separately — see [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §7. **A9 Phase 2 closing finding (2026-05-02):** the residual 22.7 % gap (after enable_support=1 closes the first 10 %) is **upstream's planner refactor between v2.3.1 → v2.3.2 in `GCode/GCodeProcessor.cpp::TimeMachine::calculate_time`** — pass order swapped from forward-then-reverse to the Marlin-canonical reverse-then-forward, `planner_reverse_pass_kernel` rewritten with cascade-on-`next.flags.recalculate`, and `recalculate_trapezoids` mutation switched from copy-back-only-`trapezoid` to in-place `feedrate_profile.exit` propagation. Upstream's planner produces systematically lower (more optimistic) time estimates for the same emitted G-code, especially in late layers where short ramp-dominated blocks are sensitive to pass-order convergence. The §6 audit's claim that `GCodeProcessor.cpp` is "byte-identical" was wrong (file gained 41 KB / 19 % between v2.3.1 and v2.3.2). The right call is to ACCEPT this divergence — Klipper hardware realizes the more aggressive cruise velocities upstream's planner predicts; reverting would intentionally regress the time estimator. `UnicornFineProfileTest.unicornEstimateMatchesDesktopWithinFivePercent` stays `@Ignore`d permanently as a "did the gap widen further?" regression guard; A9 Phase 2 is closed. See [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §9 for the source citations.

28. **Embossing / SVG / text-on-object (D4) reuses libslic3r `Emboss` + `NSVGUtils` — do NOT roll a custom glyph-to-mesh path.** D4's natural-looking instinct is to write a FreeType outline walker in the JNI shim and triangulate by hand; libslic3r already ships every step we need (and they're already linked into `liblibslic3r.a`): `Emboss::create_font_file(const char*)` for stb_truetype loading, `Emboss::text2shapes(FontFileWithCache&, const char*, FontProp)` for glyph-soup → ExPolygons (with healing pass), `to_polygons(NSVGimage&, NSVGLineParams)` for SVG path → polygons, `union_ex(Polygons)` for hole resolution, and `Emboss::polygons2model(ExPolygons, IProjection)` + `ProjectScale(make_unique<ProjectZ>(depth/scale), scale)` for the extrude. The shape→mm scale for text is `Emboss::get_text_shape_scale(fp, *font_file)`; for SVG it's the libslic3r global `SCALING_FACTOR`. **Three non-obvious things the implementation has to honor**: (a) `MeshBoolean::mcut::make_boolean(host, emboss, results, "UNION" | "A_NOT_B")` is the right boolean for emboss/engrave, NOT `MeshBoolean::cgal::plus/minus` — gotcha #27 still applies (`triangle_mesh_to_cgal` throws "Mesh not watertight" on the freshly-extruded emboss block, which has open bottom faces along the glyph perimeter where polygons2model joins front+back fans). mcut's tolerant boolean handles the imperfect emboss surface; CGAL doesn't. (b) The text/SVG mesh built by `polygons2model` is in printer-mm coords with Z = 0..depthMm, but its XY origin is wherever `text2shapes`/`to_polygons` happened to lay glyphs out (often shifted relative to the user's mental model of "centered text"). The JNI shim re-translates the mesh post-extrusion so bbox-center sits on (0,0) — without that, `EmbossOp.transformForTopOfBbox` puts the text in the wrong spot on the host. (c) Same paint-state sweep as gotcha #27 applies on `PlacedModel.source` swap: drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` because the boolean re-meshes the host. See `nativeBuildTextMesh` / `nativeBuildSvgMesh` / `nativeApplyEmboss` in `slic3r_jni.cpp`, `EmbossOp.kt`, `EmbossAssets.kt`, and `MainActivity::runEmboss`. Bundled fonts ship in `app/src/main/assets/fonts/` (DejaVu Sans Bold + DejaVu Serif); a sample SVG ships in `app/src/main/assets/svg/heart.svg`.

27. **Mesh repair / "Fix Model" composes already-exported libslic3r symbols — do NOT add a new `MeshBoolean::cgal::repair()` inside the v2.3.2 submodule.** A5's natural-looking instinct is to write a CGAL-PMP-based repair function in `MeshBoolean.cpp` (the upstream-style approach: `repair_polygon_soup` → `orient_polygon_soup` → `corefine_and_compute_union(self, self)`). That triggers a multi-hour libslic3r rebuild on every dev machine for zero functional gain, because libslic3r already exports the moving parts: `MeshBoolean::self_union(TriangleMesh&)` is exactly that pipeline (igl→CGAL `mesh_boolean(union, A, ∅)`), and the ADMesh family (`its_merge_vertices`, `its_remove_degenerate_faces`, `its_compactify_vertices`, `its_num_open_edges`, `MeshBoolean::cgal::does_self_intersect`) handles everything ADMesh-class. Compose them from the JNI shim. **Two non-obvious things the implementation has to honor**: (a) `MeshBoolean::self_union(TriangleMesh)` (igl path) ACCEPTS polygon soup, but `MeshBoolean::cgal::triangle_mesh_to_cgal(mesh, surface_mesh)` (used by `MeshBoolean::cgal::plus/minus/intersect`) throws `Slic3r::RuntimeError("Mesh not watertight")` when `CGAL::is_closed(out)` is false — for repair we want the igl flavor. (b) The Kotlin caller MUST drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` when replacing `PlacedModel.source` with the repaired output — those are per-original-triangle indices and won't survive a CGAL re-mesh (44 tris from the test fixture's 24-tri input means the index space is gone). Skipping that sweep is the trap that produces a repaired mesh with paint bleeding into the wrong faces. See `nativeRepairModel` and `MainActivity::runRepair`.

29. **NDK ≥ 26 / Clang ≥ 17 is mandatory for libslic3r builds — older toolchains miscompile paint segmentation.** `app/build.gradle.kts:46` pins `ndkVersion = "29.0.14206865"` (Clang 19) for the in-tree JNI shim, and `scripts/build_native.sh` now refuses to build libslic3r against an NDK whose `clang --version` is below 17. The pin exists because **u1-slicer-for-android's B62 incident** showed NDK 25 / Clang 14 silently miscompiles SEMM (multi-color paint segmentation) — the generated G-code looks plausible but multi-color boundaries are degraded in printed output. OrcaXR's AI-paint pillar (C9) and the painted-extruder pipeline (gotcha #21) depend on this code path, so a regression here is invisible to slice-time tests but visible on the printer. **Do not** lower `ndkVersion` to satisfy a faster CI build. Verify a shipped `.so` with `llvm-readelf -p .comment app/build/intermediates/cxx/Debug/*/obj/arm64-v8a/libslic3r_jni.so` — the `.comment` section must report `clang version 17` or higher. Roadmap E9 records the rationale; the pin is intentionally redundant (gradle pin + bash assert + this gotcha) so removing any one layer fails loudly.

31. **Persisted secrets ride a Keystore-backed AES-256-GCM box; legacy plaintext values migrate on first write.** Audit H3 (2026-05-07) flagged the Anthropic API key as plaintext in DataStore — a stolen device or filesystem dump compromised it instantly. Fix: `dev.orcaxr.app.mcp.SecretBox` (AES/GCM/NoPadding, key alias `orcaxr_secret_v1` in `AndroidKeyStore`, key never extractable). On-disk format is `base64(IV || ciphertext+tag)`. Migration is silent and one-shot: `decrypt(value)` returns `null` for non-format inputs, so legacy plaintext values keep reading correctly until the next `setAnthropicApiKey` rewrites them encrypted. Threat model uplift: an attacker who copies the DataStore file off a rooted device can no longer read the key without also extracting the Keystore-bound AES key (TEE/StrongBox). The MCP bearer token is **not** encrypted — it's generated on-device and is functionally a capability rather than an account credential, so its loss is contained to "regenerate the bearer." If you add another at-rest secret (OAuth refresh token, MoonrakerAlt API key, etc.), route it through the same SecretBox; don't add a second cipher path. Don't log decrypted values — the `anthropicApiKey` Flow is the read seam and must never reach logcat.

30. **Instrumented (`androidTest`) tests run under Android Test Orchestrator, one process per test method.** `app/build.gradle.kts` declares `testInstrumentationRunnerArguments["clearPackageData"] = "true"` and `execution = "ANDROIDX_TEST_ORCHESTRATOR"` plus the `androidTestUtil("androidx.test:orchestrator")` artifact. Without orchestration, libslic3r's `Print` / `Model` / `Layer` C++ allocations leak from one test method into the next (the JNI shim doesn't reset state at method boundaries — it's a per-process lifecycle), and after 3-5 slicing tests the test process OOMs at the typical 256 MB Android cap. Roadmap E10 records the fix. Symptom that pins this: `RepairModelTest` passes alone, then `SliceMultiInstrumentedTest` immediately after dies with `std::bad_alloc` from inside `parallel_for` even though it succeeds in isolation. Don't disable Orchestrator to "speed up CI" — the per-test process model is load-bearing.

1. **Pre-Bundle Requirement:** Before building a bundle for the Play Store, you MUST run `./gradlew versionCatalogUpdate` to check for library updates. If any updates are found, notify the user, commit the changes to `gradle/libs.versions.toml`, and advise the user to perform regression testing before final bundle generation.

2. **Dependency Update Review:** `./gradlew versionCatalogUpdate` updates `gradle/libs.versions.toml`. Always review `git diff gradle/libs.versions.toml` before committing — XR / Compose / Media3 patch bumps occasionally break the build.

## Differential diagnostics — `dumpModelJson`

`SlicerEngine.dumpModelJson(file)` returns a deterministic JSON snapshot of `Slic3r::Model` immediately after the parser runs (`load_3mf` / `load_bbs_3mf` / `Model::read_from_file`, dispatched via `load_mesh_container`). Goldens for representative fixtures live under `app/src/androidTest/assets/diagnostics_goldens/<case>/expected.json`; `ModelJsonGoldenTest` diffs them on every instrumented run. The point is to catch upstream-pick regressions (Bambu paint-attribute drops, BBS-vs-Prusa misroute, per-object config decode, custom-gcode tick parse) at parser time, before they amplify into a bad slice.

Stability rules baked into the JNI: object/volume config keys sorted lexicographically; floats formatted as `%.6f` after rounding so byte-equality holds across NDK / libc; paths reduced to basenames; object/volume/instance order preserved (re-ordering IS a regression to flag); painted-facet annotations summarized as `{empty, painted_records, bitstream_size}` rather than rebuilding per-state meshes.

Regenerating goldens (only when the dump format intentionally changes or you add a new fixture):
```
adb shell am instrument -w \
  -e class dev.orcaxr.app.diagnostics.ModelJsonGoldenTest \
  -e orcaxr.regenerateGoldens true \
  dev.orcaxr.app.test/androidx.test.runner.AndroidJUnitRunner
adb pull /sdcard/Android/data/dev.orcaxr.app/files/diagnostics_goldens_actual/
```
Then copy each `expected.json` into `app/src/androidTest/assets/diagnostics_goldens/<case>/` and review the diff — a regenerated golden is only legitimate when the format change was deliberate. Initial goldens are captured on first device run after this lands.

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

## Webcam — Snapmaker U1 needs a WebSocket wake pulse

`MoonrakerClient.fetchWebcamSnapshot` historically GET'd
`/webcam/?action=snapshot` (the mjpg-streamer / crowsnest URL). That's
correct for vanilla MainsailOS / FluiddPi but **wrong for Snapmaker
U1** — U1's firmware doesn't run mjpg-streamer. It publishes the
camera as a Moonraker plugin: discovery via `/server/webcams/list`,
frames at `/server/files/camera/monitor.jpg`. Crucially, U1 puts the
camera to sleep after a few seconds; monitor.jpg returns either 404
or a stale frame from minutes ago unless something pings
`{"jsonrpc":"2.0","method":"camera.start_monitor",
"params":{"domain":"lan","interval":0}}` over the Moonraker
WebSocket every ~2 s. Without that pulse the live view looks frozen.

`WebcamSession` (`app/src/main/java/dev/orcaxr/app/WebcamSession.kt`)
encapsulates this:

- Discovery: query `/server/webcams/list`, resolve relative URLs
  against base both with-port and stripped-port (third-party
  crowsnest installs serve the camera on a different port from
  Moonraker), append the U1 monitor.jpg + legacy mjpg URLs as
  fallback. Cached for the session's lifetime.
- Wake: `startWakePulse(scope)` runs `wakeOnce()` every 2 s. Safe
  on non-Snapmaker firmware — the WebSocket message is silently
  ignored.
- Polling: `fetchFrame()` walks the cached candidate list with a
  per-call cache buster. Tolerant of multipart/x-mixed-replace
  bodies (extracts the first SOI..EOI pair). After
  FAIL_THRESHOLD * candidates strikes, surfaces NotFound so the
  caller can hide the panel.

**Both XR and phone surfaces must use the session, not the
one-shot `fetchWebcamSnapshot`** if they want continuous live view.
The XR `MainActivity` polling loop caches one session per printer
in a remembered map; the phone `MonitorScreen` constructs a session
in `remember(cfg.id)` and starts the wake job in a
`DisposableEffect`. The XR `PrintMonitorPanel` (always-visible
during a print) also takes the latest frame so the user sees video
without opening the Devices overlay. The one-shot
`fetchWebcamSnapshot` retries with a wake pulse + 300 ms delay
so non-session callers (LLM render pipeline, low-rate overviews)
also work on U1, just at higher latency.

## Profile picker — narrow by brand × model × material

`OrcaProfileLoader.filterForContext` is the seam that hides
profiles that don't match the active printer + project filaments:

- Brand: matches `printer.name` to `PRINTER_BRANDS` (Snapmaker /
  Elegoo / Bambu / Prusa). Profile rows whose `machineName`
  contains that brand pass.
- Model: `modelOfPrinter(name)` returns a recognized model token
  ("U1", "Centauri Carbon", "X1C", …) via `PRINTER_MODELS`
  regexes. Profile rows whose `machineName` contains the model
  pass. Without this layer, picking "Snapmaker U1" still
  surfaced A350 / J1 / Artisan profiles.
- Material: `sharedMaterialFamily(filaments)` reduces project
  filament types to a single family ("PLA"). Profile rows whose
  `filamentName` contains it pass. Mixed families = null = no
  material filter (we don't strand the user when they're running
  a multi-material print).

Both the XR `RightSettingsPanel` and the phone `SlicerScreen`
call `filterForContext` with all three args. User-saved profiles
(`machineName == filamentName == null`) always pass — we don't
second-guess the user's own picks. If filtering would empty the
list, the helper returns the input unchanged so the dropdown
never goes empty.

When bundling a new vendor's machine profile leaves, add a row
to `PRINTER_MODELS` so the picker stays narrow. Pattern order
matters when patterns can overlap (`MK3.5` must win over `MK3`).

## Mobile export — STL + 3MF via SAF

The phone `SlicerScreen.ToolsCard` exposes "Save .stl" / "Save
.3mf" buttons that route through Android's
`ActivityResultContracts.CreateDocument` so the user picks the
destination via the system file picker (no `WRITE_EXTERNAL_STORAGE`
required, scoped-storage compliant). STL exports go through
`SlicerEngine.convertToStl` (reads any libslic3r format), 3MF
exports go through `SlicerEngine.saveAs3mf` with the active
profile config so the saved 3MF re-opens with the same slice
settings. Mirrors the XR `BottomRightSummaryPanel.onSaveModelStl`
/ `onSaveProject3mf` paths but writes to the user-chosen Uri
instead of the public Downloads/ directory.

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

## C9 — AI-driven paint pillar

`Ai{Paint,Render,Introspection,MaskProjection}.kt` parallel to the
existing XR paint surface; both go through `applyPaintMutation` so
PaintHistory + paintContentVersion stay correct (one MCP call ⇒
one undo step). Triangle IDs are stable for a session as long as
no mesh-mutating action runs (`repair_model` / `cut_model` /
`mesh_boolean` / `split_model` / `emboss_model` invalidate). MCP
tools share the XR brush's `bvhCache` via
`WorkspaceModel.BvhProvider` registered from MainActivity, with
on-demand cold-start build off Dispatchers.Default — an LLM that
calls `paint_sphere` before the user has touched the brush
triggers a synchronous build, no separate "warm up" tool needed.

**Pure-Kotlin rasterizer (not JNI).** The shipping pressure was
"the LLM can SEE the model end-to-end" — `AiRenderEngine` Pineda-
fills triangles to a row-major RGBA buffer; `PngWriter` is a
~120-line PNG encoder using `java.util.zip.Deflater`. 768×768
Benchy renders in ~250 ms host JVM, expected ~600 ms-1 s on
Galaxy XR arm64. JNI migration is mechanical if profiling shows
it's a bottleneck. The native files (`ai_render.cpp`,
`ai_segment.cpp`, vendored `stb_image_write.h`) listed in the
original `docs/AI_PAINT_DESIGN.md` were NOT shipped — Kotlin
replaces them.

**Render artifact transport.** `AiSessionState` (process-singleton)
holds a 50-entry LRU of render artifacts keyed by content hash,
plus user-named cameras. The MCP server gained a `GET
/resources/<token>.png` route (auth: same bearer token) that
streams PNG bytes via `HttpFraming.writeBinaryResponse`. Inline
base64 image content parts on `ToolResult.imageParts` are also
shipped for renders ≤ 200 KB.

**Coordinate frame:** every spatial paint primitive consumes
`centered_preview_mm` (the BVH frame, gotcha #11d). Don't
mistakenly accept `mesh_local_mm` from an LLM — the doc tool
description names the frame explicitly so the LLM passes the
right thing. `get_model_geometry` returns bbox in centered_preview
so the LLM has a coordinate-frame anchor.

**Tool surface:** see [`docs/AI_PAINT_PROTOCOL.md`](docs/AI_PAINT_PROTOCOL.md)
for the runtime contract; [`docs/AI_PAINT_DESIGN.md`](docs/AI_PAINT_DESIGN.md)
for the design rationale. New tools register in
`McpController.registerAllTools` via `AiPaintTools.all`,
`AiVisionTools.all`, `AiIntrospectionTools.all`.

**D22 — LLM-painting amplifier bundle.** Eight tools that compress
the typical "plan → paint → verify" loop. They're glue over the
existing surface — see `docs/AI_PAINT_PROTOCOL.md` for full shapes;
load-bearing notes only here:

- `paint_semantic_region` resolves `region_id` against a
  per-(model_id, source) segmentation cache on `AiSessionState`.
  The four introspection tools auto-publish into the cache as a
  side effect, so the LLM rarely has to call `prime_region_cache`.
  Triangle index lists never cross the wire — important for huge
  meshes where one region holds 50 K+ tris.
- `detect_symmetry` is centroid-pair-based: O(S²) per axis with
  S ≤ 1024. **Sensitive to triangulation:** a diagonal-split cube
  fails because each face's diagonal breaks centroid mirror
  pairing — unit-test fixture is a face-center fan-subdivided
  cube. Real STL imports (10 K+ tris) are fine because centroid
  density swamps the triangulation artifact. `paint_with_mirror
  axis="auto"` reads the cached report and fails closed if no
  axis crosses 0.65 confidence.
- `render_paint_session_diff` requires the session's initial
  paint state. `AiPaintSession` now has separate `initial*`
  ByteArray fields frozen at begin so they survive
  `applyTriangleSet` reassigning the working buffer.
- `find_similar_recipe` ranks bundled recipes (Pikachu, Benchy)
  by a 6-dim fingerprint (sorted bbox aspect, area/volume^(2/3),
  log component / recess counts) — recipes carry the fingerprint
  in their JSON. `suggest_palette_for_recipe` maps recipe tag
  names → user filament slots by RGB distance.
- `score_paint_against_reference` reuses `VisionApiClient` from
  `FindFeatureAnchorsTool` (same Anthropic key flow). Two-image
  request — current paint + reference. Returns `{score, comment,
  regions[]}`.

Convergence loop: `render_montage` → `find_similar_recipe` →
`suggest_palette_for_recipe` → `detect_symmetry` →
`begin_paint_session` → `paint_template` →
`render_paint_session_diff` → `score_paint_against_reference` →
targeted corrections → `commit_paint_session`.

**Headless paint sessions (C9 milestone 4).** Every paint MCP tool
that emits a `WorkspaceAction.PaintTriangleSet` triggers a full
colored-GLB rebake + GltfModelEntity swap, which is fine for one
brush stamp but prohibitive when an LLM iterates 30+ small
refinements (each rebake interrupts the user's XR view *and* fills
its own undo step). Sessions decouple iteration from the scene:

```
begin_paint_session(model_id) → session_id
  paint_sphere(session_id=…)        ← scratch buffer, no rebake
  render_view(session_id=…)         ← reads session paint
  paint_geodesic_disc(session_id=…) ← scratch buffer
  render_view(session_id=…)
  commit_paint_session(session_id)  ← ONE LoadPaintState ⇒ ONE rebake
```

Implementation:

- `mcp/AiPaintSessionStore.kt` — process-singleton, LRU bounded at
  8 sessions (each holds 4 ByteArrays sized to tri count; ~5.6 MB
  per 1.4 M-tri dragon = ~45 MB worst case).
- `mcp/tools/PaintSessionTools.kt` — begin / commit / discard /
  list / get_diff. `commit_paint_session` emits exactly one
  `WorkspaceAction.LoadPaintState` (which already exists for D18j
  paint-recipe replay), so the on-host handler at
  `MainActivity.onLoadPaintState` calls `applyPaintMutation` once,
  bumping `paintContentVersion` once and creating exactly one
  `PaintHistory` step that undoes the entire session.
- All eight `AiPaintTools` (sphere / slab / normal_cone /
  surface_region / connected_component / triangle_list /
  projected_mask / geodesic_disc) plus the five render tools
  (`render_view` / `render_paint_overlay` / `render_views_grid` /
  `render_montage`; `render_triangle_id_map` doesn't depend on
  paint state so it skips the session) accept an optional
  `session_id`. When present, paint primitives mutate the session
  in-process (no `WorkspaceAction` emit) and renders read paint
  from the session.
- Triangle-id stability: sessions assume mesh topology is stable.
  `paint_*` and `commit_paint_session` reject when the live BVH's
  tri count diverges from the session's recorded `triCount` (i.e.
  the user / another tool ran repair / cut / boolean / split /
  emboss / simplify / volume edit between begin and commit). The
  session is auto-discarded on commit failure unless the caller
  passes `discard_on_failure=false`.
- Why the renderer is unchanged: `AiRenderEngine` is already pure
  Kotlin with no XR-runtime coupling — sessions don't change render
  fidelity, they just stop the *commit-time* rebake from firing on
  every paint primitive. The render quality knobs already exposed
  via `lighting` + `annotate` flags work identically inside a
  session.

## Related docs

- [`ROADMAP.md`](ROADMAP.md) — forward-looking feature roadmap (single source of truth for sections A, B, C, E, F, G).
- [`ROADMAP-painting-and-editing.md`](ROADMAP-painting-and-editing.md) — sibling roadmap for section D (painting & object editing). Split out under the parent's "<600 lines" rule.
- [`DESIGN.md`](DESIGN.md) — XR UX spec and baselines.
- [`patches/README.md`](patches/README.md) — rules for patches against the OrcaSlicer submodule.
