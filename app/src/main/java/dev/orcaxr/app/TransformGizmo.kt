package dev.orcaxr.app

import android.content.Context
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.xr.runtime.Session
import androidx.xr.scenecore.*
import androidx.xr.runtime.math.Pose
import androidx.xr.runtime.math.Vector3
import androidx.xr.runtime.math.Quaternion
import java.io.File

/**
 * Which gizmo tool is currently active. Mirrors OrcaSlicer desktop's
 * Move / Rotate / Scale toolbar: only one tool's affordance is visible
 * at a time. Select is the no-gizmo state — the top bar's
 * Move/Rotate/Scale buttons are toggles, tapping the active one drops
 * back to Select.
 */
enum class GizmoTool { Select, Move, Rotate, Scale }

/**
 * Live-drag override emitted by [TransformGizmo] during a drag, applied
 * by the renderer to the model's preview via offset/re-bake.
 *
 * On UP, the gizmo emits the final override via `onCommit`; the parent
 * folds it into [PlacedModel] (which then triggers a single re-bake).
 *
 * Translate fields are absolute deltas in mm in printer space (added to
 * `translateXmm/Y/Z` on commit). Rotate fields are extra Euler degrees
 * applied on top of the *baked* GLB orientation. Scale fields are
 * multipliers applied on top of the baked scale.
 */
data class GizmoDragOverride(
    val deltaTxMm: Float = 0f,
    val deltaTyMm: Float = 0f,
    val deltaTzMm: Float = 0f,
    val deltaRotXDeg: Float = 0f,
    val deltaRotYDeg: Float = 0f,
    val deltaRotZDeg: Float = 0f,
    val scaleMultX: Float = 1f,
    val scaleMultY: Float = 1f,
    val scaleMultZ: Float = 1f,
)

// WORKSPACE_ROTATION (-90° around X) maps printer -> world axes:
//   printer X = world X
//   printer Y = world -Z
//   printer Z = world Y
// A child entity parented to the workspace therefore lives in printer
// space: its local X/Y/Z are printer X/Y/Z and the workspace's own
// rotation maps them to world. The visible preview GLBs use the same
// local frame (translate*WORLD_SCALE), so a handle collider parented to
// the workspace and the visible model share one coordinate system, and
// `InputEvent.hitInfo.transform` converts world rays into that frame
// (see PaintInputHooks.worldRayToMeshMm).

// Every visible handle is paired with a FAT invisible input mesh on its own
// GltfModelEntity + InteractableComponent (GizmoHandleEntity below) — grab
// volumes are generous while the visuals stay slim. All dimensions derive
// from the model's largest extent in [GizmoVisuals] (with clamps) so they
// read consistently across a 20 mm trinket and a 200 mm bust.

/** Half the model's effective Z extent — used to anchor the gizmo at the
 *  model's geometric center (the preview is anchored at its base on the
 *  bed) so the affordance brackets the model instead of sitting under it. */
private fun modelHalfHeightMm(selected: PlacedModel): Float =
    selected.baseBboxZmm * selected.effectiveScaleZ / 2f


/** Gap (printer mm) from the model's top to the center of the vertical (Z)
 *  move grab knob, so the knob sits clearly ABOVE the model — not buried in it
 *  where it'd be ambiguous with the body free-grab. The blue Move arrow reaches
 *  this far so it visibly points at the knob. */
internal const val GIZMO_Z_KNOB_GAP_MM = 55f

/** Minimum side (printer mm) of the invisible inflated body-grab box. The
 *  model's exact mesh is the natural grab target, but a 20 mm trinket is a
 *  ~3 cm world-space target — too small to pinch reliably. The body box
 *  guarantees at least this much grab volume around the model center. */
internal const val GIZMO_BODY_GRAB_MIN_MM = 60f


@Composable
fun TransformGizmo(
    session: Session,
    parentEntity: Entity?,
    selectedModel: PlacedModel,
    @Suppress("UNUSED_PARAMETER") workspaceTx: Vector3,
    /** Active tool — only the matching affordance renders. Select hides
     *  the gizmo entirely. */
    tool: GizmoTool,
    /** Live-drag override, sourced from the same `liveDragOverride` slot
     *  the model preview reads, so the visible affordance follows the
     *  model during a Move drag. Null = no drag. */
    liveOverride: GizmoDragOverride? = null,
    /** Emitted continuously during a drag with the in-progress delta. The
     *  parent applies it as a live preview on the model (no re-bake).
     *  null = no drag in progress, drop the override. */
    onLivePreview: (GizmoDragOverride?) -> Unit,
    /** Emitted once at drag end with the final delta. Parent commits to
     *  PlacedModel (which triggers a single re-bake). */
    onCommit: (GizmoDragOverride) -> Unit,
) {
    if (tool == GizmoTool.Select) return
    android.util.Log.i("OrcaXR/gizmo", "TransformGizmo composing tool=$tool model=${selectedModel.id}")

    // Direct ray manipulation: every handle is a real GltfModelEntity
    // collider with an InteractableComponent, driven by ray/plane math
    // (GizmoRayDragDriver) — the same input mechanism the paint pipeline
    // proves streams pinch-drag events on Galaxy XR. Each visible handle
    // is paired with a FAT invisible input mesh (SceneCore entities
    // don't render on Galaxy XR here) so the grab volume is generous
    // while the visuals stay slim.
    GizmoVisuals(
        session = session,
        parentEntity = parentEntity,
        selectedModel = selectedModel,
        tool = tool,
        liveOverride = liveOverride,
        onLivePreview = onLivePreview,
        onCommit = onCommit,
    )
}


@Composable
fun GizmoVisuals(
    session: Session,
    parentEntity: Entity?,
    selectedModel: PlacedModel,
    tool: GizmoTool,
    liveOverride: GizmoDragOverride?,
    onLivePreview: (GizmoDragOverride?) -> Unit,
    onCommit: (GizmoDragOverride) -> Unit,
) {
    if (tool == GizmoTool.Select) return

    val ctx = LocalContext.current
    val ovTx = liveOverride?.deltaTxMm ?: 0f
    val ovTy = liveOverride?.deltaTyMm ?: 0f
    val ovTz = liveOverride?.deltaTzMm ?: 0f

    // Center the affordance on the model (preview is anchored at its base).
    // Visuals follow the live drag; the INPUT colliders stay at the
    // drag-start pose (bcx/bcy/bcz) so the frame captured at pinch-DOWN
    // remains valid for the whole drag, then jump on commit.
    val bcx = selectedModel.translateXmm
    val bcy = selectedModel.translateYmm
    val bcz = selectedModel.translateZmm + modelHalfHeightMm(selectedModel)
    val cx = bcx + ovTx
    val cy = bcy + ovTy
    val cz = bcz + ovTz

    val effX = selectedModel.baseBboxXmm * selectedModel.effectiveScaleX
    val effY = selectedModel.baseBboxYmm * selectedModel.effectiveScaleY
    val effZ = selectedModel.baseBboxZmm * selectedModel.effectiveScaleZ

    // Scale the affordance geometry to the model so it reads the same on a
    // 20 mm trinket and a 200 mm bust: a fixed 2 mm shaft is a fat tube on a
    // tiny model and a thread on a big one, and a fixed 22 mm clearance dwarfs
    // a small model. Tie the shaft radius, ring thickness, scale cube and the
    // clearances to the model's largest dimension, clamped so extremes stay
    // sane. The fixed GIZMO_* constants are kept as the clamp floors/ceilings.
    val maxDim = maxOf(effX, effY, effZ).coerceAtLeast(1f)
    val shaftR = (maxDim * 0.012f).coerceIn(0.8f, 4.0f)
    val ringThick = (maxDim * 0.015f).coerceIn(1.2f, 4.0f)
    val ringClear = (maxDim * 0.07f).coerceIn(6f, 20f)
    val cubeSize = (maxDim * 0.05f).coerceIn(5f, 14f)
    val cubeClear = (maxDim * 0.09f).coerceIn(8f, 26f)

    // Fat input-collider dimensions: generous enough to pinch without
    // hunting, clamped so a small model's handles don't merge into one blob.
    val fatArrowR = (maxDim * 0.09f).coerceIn(10f, 30f)

    // Fat invisible BODY collider: the model's exact-mesh IC is a tiny target
    // on a small model, so every tool also mounts an inflated box around the
    // body (≥ GIZMO_BODY_GRAB_MIN_MM per side) carrying the same body mapping.
    // Its mesh frame is centered at the model center (the box GLB is authored
    // around the origin), so body mappings anchor at Vec3f(0,0,0).
    val bodyX = (effX * 1.25f).coerceAtLeast(GIZMO_BODY_GRAB_MIN_MM)
    val bodyY = (effY * 1.25f).coerceAtLeast(GIZMO_BODY_GRAB_MIN_MM)
    val bodyZ = (effZ * 1.25f).coerceAtLeast(GIZMO_BODY_GRAB_MIN_MM)
    val bodyMapping = when (tool) {
        GizmoTool.Move -> GizmoDragMapping.MoveInPlane(planeZmm = 0f)
        GizmoTool.Rotate -> GizmoDragMapping.RotateAboutAxis(2, Vec3f(0f, 0f, 0f))
        GizmoTool.Scale -> GizmoDragMapping.ScaleUniform(Vec3f(0f, 0f, 0f))
        GizmoTool.Select -> null
    }
    if (bodyMapping != null) {
        GizmoHandleEntity(
            session = session,
            parentEntity = parentEntity,
            filename = "gzi_body_${tool}_${bodyX.toInt()}_${bodyY.toInt()}_${bodyZ.toInt()}.glb",
            centerXmm = bcx, centerYmm = bcy, centerZmm = bcz,
            mapping = bodyMapping,
            onPreview = onLivePreview,
            onCommit = onCommit,
        ) { f -> GizmoGlb.writeBox(f, bodyX, bodyY, bodyZ, floatArrayOf(1f, 1f, 1f)) }
    }

    when (tool) {
        GizmoTool.Move -> {
            // Functional arrows: grab an arrow anywhere along its length for an
            // axis-constrained move; grab the model body for a free move on the
            // bed. Lengths are proportional to the model (no fixed floor — a
            // 75 mm minimum dwarfed small models).
            val arrowClear = (maxDim * 0.30f).coerceIn(12f, 45f)
            val lenX = effX / 2f + arrowClear
            val lenY = effY / 2f + arrowClear
            val lenZ = effZ / 2f + arrowClear
            val r = shaftR
            val axes = listOf(
                Triple(0, lenX, floatArrayOf(0.95f, 0.26f, 0.21f)),
                Triple(1, lenY, floatArrayOf(0.30f, 0.69f, 0.31f)),
                Triple(2, lenZ, floatArrayOf(0.26f, 0.54f, 0.96f)),
            )
            for ((axis, len, color) in axes) {
                val axisName = "xyz"[axis]
                GizmoVisualModel(
                    session, ctx, "arrow_${axisName}_${len.toInt()}_${(r * 10).toInt()}.glb", cx, cy, cz,
                ) { f -> GizmoGlb.writeArrow(f, axis, len, r, color) }
                // Fat collider starting past the body-box surface so it never
                // shadows the body free-grab; runs past the visual tip so the
                // arrowhead region is easy to pinch.
                val bodyHalf = when (axis) { 0 -> bodyX; 1 -> bodyY; else -> bodyZ } / 2f
                val startMm = bodyHalf * 1.02f
                val inputLen = maxOf(len + 25f, startMm + 40f)
                GizmoHandleEntity(
                    session = session,
                    parentEntity = parentEntity,
                    filename = "gzi_arrow_${axisName}_${inputLen.toInt()}_${fatArrowR.toInt()}_${startMm.toInt()}.glb",
                    centerXmm = bcx, centerYmm = bcy, centerZmm = bcz,
                    mapping = GizmoDragMapping.MoveAlongAxis(axis, Vec3f(0f, 0f, 0f)),
                    onPreview = onLivePreview,
                    onCommit = onCommit,
                ) { f -> GizmoGlb.writeArrow(f, axis, inputLen, fatArrowR, color, start = startMm) }
            }
        }

        GizmoTool.Rotate -> {
            // OrcaSlicer-style rotation rings: grab a ring and sweep it — the
            // model rotates about that axis by the swept angle, 1:1.
            val radius = maxOf(effX, effY, effZ) / 2f + ringClear
            val fatRingT = (radius * 0.18f).coerceIn(10f, 30f)
            val axes = listOf(
                Triple(0, floatArrayOf(0.95f, 0.26f, 0.21f), "x"),
                Triple(1, floatArrayOf(0.30f, 0.69f, 0.31f), "y"),
                Triple(2, floatArrayOf(0.26f, 0.54f, 0.96f), "z"),
            )
            for ((axis, color, axisName) in axes) {
                GizmoVisualModel(
                    session, ctx, "ring_${axisName}_${radius.toInt()}_${(ringThick * 10).toInt()}.glb", cx, cy, cz,
                ) { f -> GizmoGlb.writeRing(f, axis, radius, ringThick, color) }
                GizmoHandleEntity(
                    session = session,
                    parentEntity = parentEntity,
                    filename = "gzi_ring_${axisName}_${radius.toInt()}_${fatRingT.toInt()}.glb",
                    centerXmm = bcx, centerYmm = bcy, centerZmm = bcz,
                    mapping = GizmoDragMapping.RotateAboutAxis(axis, Vec3f(0f, 0f, 0f)),
                    onPreview = onLivePreview,
                    onCommit = onCommit,
                ) { f -> GizmoGlb.writeRing(f, axis, radius, fatRingT, color) }
            }
        }

        GizmoTool.Scale -> {
            // Per-axis cubes; the model body (own IC) scales uniformly.
            val size = cubeSize
            val fatCube = (size * 2.5f).coerceIn(18f, 40f)
            val axes = listOf(
                Triple(0, effX, floatArrayOf(0.95f, 0.26f, 0.21f)),
                Triple(1, effY, floatArrayOf(0.30f, 0.69f, 0.31f)),
                Triple(2, effZ, floatArrayOf(0.26f, 0.54f, 0.96f)),
            )
            for ((axis, eff, color) in axes) {
                val axisName = "xyz"[axis]
                val off = eff / 2f + cubeClear
                val offVec = FloatArray(3).also { it[axis] = off }
                GizmoVisualModel(
                    session, ctx, "scale_${axisName}_${size.toInt()}_${off.toInt()}.glb", cx, cy, cz,
                ) { f -> GizmoGlb.writeCube(f, size, offVec, color) }
                GizmoHandleEntity(
                    session = session,
                    parentEntity = parentEntity,
                    filename = "gzi_scale_${axisName}_${fatCube.toInt()}_${off.toInt()}.glb",
                    centerXmm = bcx, centerYmm = bcy, centerZmm = bcz,
                    mapping = GizmoDragMapping.ScaleAlongAxis(axis, Vec3f(0f, 0f, 0f)),
                    onPreview = onLivePreview,
                    onCommit = onCommit,
                ) { f -> GizmoGlb.writeCube(f, fatCube, offVec, color) }
            }
        }

        GizmoTool.Select -> {}
    }
}

/**
 * Invisible input collider for one gizmo handle: a GltfModelEntity
 * (SceneCore entities produce no visible geometry on Galaxy XR here — the
 * visuals render via the Compose [SpatialGlbVisual] path) parented to the
 * workspace at the gizmo center, with an InteractableComponent feeding a
 * [GizmoRayDragDriver]. The handle GLB is authored around the gizmo
 * center in printer axes, so the drag mapping's mesh-mm frame has the
 * gizmo center at the origin.
 */
@Composable
private fun GizmoHandleEntity(
    session: Session,
    parentEntity: Entity?,
    filename: String,
    centerXmm: Float,
    centerYmm: Float,
    centerZmm: Float,
    mapping: GizmoDragMapping,
    onPreview: (GizmoDragOverride?) -> Unit,
    onCommit: (GizmoDragOverride) -> Unit,
    generate: (File) -> Unit,
) {
    val ctx = LocalContext.current
    var entity by remember(filename) { mutableStateOf<GltfModelEntity?>(null) }
    val mappingLive = rememberUpdatedState(mapping)
    val onPreviewLive = rememberUpdatedState(onPreview)
    val onCommitLive = rememberUpdatedState(onCommit)

    LaunchedEffect(filename, parentEntity) {
        val parent = parentEntity ?: return@LaunchedEffect
        val bytes = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching {
                val f = File(ctx.cacheDir, filename)
                if (!f.exists()) generate(f)
                f.readBytes()
            }.onFailure {
                android.util.Log.e("OrcaXR/gizmo", "handle GLB write failed $filename", it)
            }.getOrNull()
        } ?: return@LaunchedEffect
        val model = runCatching {
            GltfModel.create(session, bytes, "gz_${filename.hashCode().toString(36)}.glb")
        }.onFailure {
            android.util.Log.e("OrcaXR/gizmo", "handle GltfModel.create failed $filename", it)
        }.getOrNull() ?: return@LaunchedEffect
        val ent = runCatching { GltfModelEntity.create(session, model) }
            .onFailure { android.util.Log.e("OrcaXR/gizmo", "handle entity create failed $filename", it) }
            .getOrNull() ?: return@LaunchedEffect
        ent.parent = parent
        ent.setScale(WORLD_SCALE)
        // Let the render thread bind the entity before the IC attach below
        // queues collider ops on it (gotcha #13 family).
        kotlinx.coroutines.android.awaitFrame()
        kotlinx.coroutines.android.awaitFrame()
        if (ent.isDisposed) return@LaunchedEffect
        entity = ent
        android.util.Log.i("OrcaXR/gizmo", "handle entity attached $filename")
    }

    LaunchedEffect(entity, centerXmm, centerYmm, centerZmm) {
        val ent = entity ?: return@LaunchedEffect
        if (ent.isDisposed) return@LaunchedEffect
        ent.setPose(
            Pose(
                Vector3(centerXmm * WORLD_SCALE, centerYmm * WORLD_SCALE, centerZmm * WORLD_SCALE),
                Quaternion.Identity,
            ),
        )
    }

    DisposableEffect(entity) {
        val ent = entity
        if (ent == null) {
            onDispose { }
        } else {
            val driver = GizmoRayDragDriver(
                tag = filename.removeSuffix(".glb"),
                mappingProvider = { mappingLive.value },
                onPreview = { onPreviewLive.value(it) },
                onCommit = { onCommitLive.value(it) },
            )
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val ic = runCatching {
                InteractableComponent.create(session, executor) { event -> driver.handle(event) }
            }.onFailure {
                android.util.Log.e("OrcaXR/gizmo", "handle IC create failed $filename", it)
            }.getOrNull()
            val attached = ic != null && !ent.isDisposed &&
                runCatching { ent.addComponent(ic) }.getOrDefault(false)
            if (!attached) {
                android.util.Log.w("OrcaXR/gizmo", "handle IC NOT attached $filename")
            }
            onDispose {
                if (attached && !ent.isDisposed) runCatching { ent.removeComponent(ic!!) }
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            entity?.let { if (!it.isDisposed) runCatching { it.parent = null } }
            entity = null
        }
    }
}

@Composable
private fun GizmoVisualModel(
    session: Session,
    ctx: Context,
    filename: String,
    offsetXmm: Float,
    offsetYmm: Float,
    offsetZmm: Float,
    generate: (File) -> Unit,
) {
    val glbPathState = remember(filename) { mutableStateOf<String?>(null) }

    LaunchedEffect(filename) {
        glbPathState.value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching {
                val file = File(ctx.cacheDir, filename)
                if (!file.exists()) generate(file)
                file.absolutePath
            }.getOrNull()
        }
    }

    val path = glbPathState.value ?: return
    SpatialGlbVisual(path, offsetXmm, offsetYmm, offsetZmm)
}
