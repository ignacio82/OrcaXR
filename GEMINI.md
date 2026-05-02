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

11. **`InputEvent.Source` filters that hard-code `CONTROLLER` silently break on Galaxy XR.** Hand-pinch interactions arrive as `HANDS` (and may also be reported as `GAZE_AND_GESTURE` depending on gesture path); the device has no controller at all. Guards like `if (event.source != InputEvent.Source.CONTROLLER) return` will swallow every event and the user sees a perfectly-rendered gizmo / interactable that does nothing. Filter on `source != InputEvent.Source.UNKNOWN` (or just gate on `event.action`) instead. Bit any code path that takes `InputEvent` from `InteractableComponent`: gizmos, paint, selection.

12. **`Font(googleFont = ..., fontProvider = ..., weight = ...)` doesn't resolve to the googlefonts factory unless aliased.** The `androidx.compose.ui.text.font.Font` type and the `androidx.compose.ui.text.googlefonts.Font` *factory* share the symbol name; an unqualified `Font(googleFont = ...)` call resolves to the foundation overload set (file/asset/resId only) and the compiler reports "no Font(googleFont = ...) overload." Theme.kt aliases the factory as `import androidx.compose.ui.text.googlefonts.Font as GoogleFontFactory` and calls that instead. Don't drop the alias.

13. **Synchronous dispose of a `GltfModelEntity` mid-swap aborts the render thread with `split_engine_bridge.cc:100` `NOT_FOUND`.** Two flavors observed: `"unknown material instance id: <N>"` and `"unknown node: <N>"`. Both come from queued render-thread ops (setPose, addComponent for an Interactable/Movable collider) that reference a node id whose entity was just freed. Three patterns produce this:
   - **`key(modelId, glbPath) { GlbSceneEntity(...) }`** — when `glbPath` changes, Compose unmounts the entire composable, so any `DisposableEffect` onDispose fires synchronously, freeing the entity before the render queue drains. Use `key(modelId)` only — let `GlbSceneEntity`'s internal `LaunchedEffect(glbPath, parentEntity)` handle the swap and dispose with `disposeEntityDeferred(oldEntity)` (defined in `MainActivity.kt`) which awaits two frames before disposing.
   - **`DisposableEffect(glbPath) { onDispose { entity.dispose() } }`** — same problem, fires synchronously on path change. Key it on `Unit` so it only runs on real composition leave; the LaunchedEffect handles path-change swaps with deferred dispose.
   - **`key(selectedModelIds.hashCode(), fw, fd, fh) { SelectionBboxEntity(...) }`** — keying any wrapper composable on the model's bbox dims is the same trap. A change to `baseBboxXmm/Y/Z` (e.g. when a re-bake refines per-object dims) flips the key, the wrapper unmounts, and its `DisposableEffect(Unit)` synchronously frees the bbox entity. Drop the dim args from the key; the inner LaunchedEffect on `(modelId, sizeXmm, sizeYmm, sizeZmm)` handles dim changes via `disposeEntityDeferred`.
   This is acutely triggered by gotcha #22's two-bake load: v1→v2 within ms means the v1 dispose can race v2's still-loading addComponent.

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

21. **All multi-object 3MFs are decomposed into separate STLs on import.** To allow per-object selection and transform (Phase B9), generic multi-object 3MFs extract each `ModelObject::mesh()` to a temporary STL in `cacheDir/extracted/<hash>/`. Each `PlacedModel` points to one of these STLs, sharing a `groupId` (the source 3MF's hash). `originalSource` tracks the original 3MF container path so `nativeWriteColoredGlb` can re-load the per-triangle `paint_color` metadata during re-bakes. STL has no material metadata, so carry the source object's one-based default extruder in `PlacedModel.previewFilamentIndex` as a fallback. `nativeSliceMulti` slices decomposed STL sets.

22. **Loading a 3MF fires *two* `previewStl` calls — sweep must not unlink in-flight bakes.** `LE_2162` fires on the selection change for the new model (call A); inside that bake, the embedded-color sync writes to `filamentEntriesStore`, which propagates to `previewPalette`, which fires the palette `LaunchedEffect` and runs a second bake (call B). `SlicerEngine.writeColoredGlb` opens its output GLB for writing early in the JNI; if call A's `sweepOldPreviews(keep=v1)` runs while B's JNI has `v2.glb` open, the file gets unlinked, JNI keeps writing to the orphan FD, and the bytes vanish at FD close. Symptom: model invisible after a successful 3MF load, `FileNotFoundException` on `_v2.glb`. `sweepOldPreviews` must only delete versions strictly older than `keep`'s version number.

23. **`ModelObject::raw_bounding_box()` already includes the instance's rotation+scale (via `get_matrix_no_offset()`).** Pairing it with `world_bbox_of(b, instance->get_matrix())` re-applies rotation+scale and inflates the result. Symptoms when this happens to the per-object `world_bbox` used to compute the GLB grounding shift: the model floats above the bed (12+ mm of phantom Z), and the over-large derived AABB also propagates into `oz` for downstream `translateZmm`. Always pair `world_bbox_of(...)` with `mo->raw_mesh_bounding_box()` (per-volume transforms only, no instance xform) so the full instance matrix can be applied exactly once. The header for `world_bbox_of` in `slic3r_jni.cpp` carries the same warning — don't backslide.

24. **`previewStl` bakes one PER-OBJECT GLB per `PlacedModel` for multi-object 3MFs (gotcha #21), but `deriveStlFor(bakeSource)` returns the FULL 3MF derived STL.** Using its bbox to set `baseBboxX/Y/Z` on each per-object PlacedModel (`bakeIndex >= 0`) gives every object the *whole-3MF layout footprint* (e.g. 134×108 for a 5-unicorn print), which the selection bbox / gizmo / `footprintMm()` then read as if each unicorn were a 134×108 monster. Skip the `baseBbox` override when `bakeIndex >= 0`; per-object dims set by `nativeRead3mfObjectMetadata` at load time are accurate.

## Build & Play Store

1. **Pre-Bundle Requirement:** Before building a bundle for the Play Store, you MUST run `./gradlew versionCatalogUpdate` to check for library updates. If any updates are found, notify the user, commit the changes to `gradle/libs.versions.toml`, and advise the user to perform regression testing before final bundle generation.

2. **Dependency Update Review:** `./gradlew versionCatalogUpdate` updates `gradle/libs.versions.toml`. Always review `git diff gradle/libs.versions.toml` before committing — XR / Compose / Media3 patch bumps occasionally break the build.

## Related docs

- [`ROADMAP.md`](ROADMAP.md) — forward-looking feature roadmap (single source of truth).
- [`DESIGN.md`](DESIGN.md) — XR UX spec and baselines.
- [`patches/README.md`](patches/README.md) — rules for patches against the OrcaSlicer submodule.
