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
import kotlin.math.atan2
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Which gizmo tool is currently active. Mirrors OrcaSlicer desktop's
 * Move / Rotate / Scale toolbar: only one tool's handles are visible at
 * a time so the user isn't fighting nine concentric arrows/rings/cubes.
 * Select is the no-gizmo state — the top bar's Move/Rotate/Scale buttons
 * are toggles, tapping the active one drops back to Select.
 */
enum class GizmoTool { Select, Move, Rotate, Scale }

/**
 * Live-drag override emitted by [TransformGizmo] during a drag, applied
 * by the renderer to the model's [GltfModelEntity] via setPose+setScale.
 * Avoids re-baking the colored preview GLB on every drag delta (which
 * caused the model to flicker/disappear during rotation/scale interaction).
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

// Geometry constants for the GLB primitives generated below. The handle
// entity's setScale() then linearly resizes them so the visible / hittable
// size grows with the selected model's bounding box.
private const val GIZMO_ARROW_LEN_MM = 50f
private const val GIZMO_ARROW_SHAFT_MM = 10f // Chunky but reasonable
private const val GIZMO_RING_RADIUS_MM = 55f
private const val GIZMO_RING_THICK_MM = 4f
private const val GIZMO_SCALE_CUBE_MM = 12f
private const val GIZMO_SCALE_OFFSET_MM = 60f

/**
 * Base scale for gizmo handles (thickness/rings). Grows with the model
 * but slower than length to keep the visual weight balanced.
 */
private fun computeGizmoBaseScale(selected: PlacedModel): Float {
    val effX = selected.baseBboxXmm * selected.effectiveScaleX
    val effY = selected.baseBboxYmm * selected.effectiveScaleY
    val effZ = selected.baseBboxZmm * selected.effectiveScaleZ
    val maxDim = maxOf(effX, effY, effZ)
    // Sized so that at WORLD_SCALE (1mm), the handle has a reasonable thickness.
    // Scales up with the model to remain grabable.
    val targetThickMm = (maxDim * 0.15f + 40f).coerceIn(40f, 150f)
    return WORLD_SCALE * (targetThickMm / GIZMO_ARROW_LEN_MM)
}

/**
 * Axis-specific length scale. Ensures the arrow tip sits 80mm
 * beyond the model's bounding box face on that axis.
 */
private fun computeAxisLengthScale(dimMm: Float): Float {
    val halfDim = dimMm / 2f
    // Arrow tip (GIZMO_ARROW_LEN_MM) should be at halfDim + 80mm
    val targetLenMm = halfDim + 80f
    return WORLD_SCALE * (targetLenMm / GIZMO_ARROW_LEN_MM)
}

/** Half the model's effective Z extent — used to lift the gizmo root from
 *  the bed (where the model's translateZmm is anchored after the bed-snap
 *  pass) to the model's geometric center, so the +Z arrow has room to poke
 *  out the top instead of disappearing inside the mesh. */
private fun modelHalfHeightMm(selected: PlacedModel): Float =
    selected.baseBboxZmm * selected.effectiveScaleZ / 2f

// XR input filter: SceneCore delivers DOWN/MOVE/UP/CANCEL from any of
// CONTROLLER, HANDS, MOUSE, GAZE_AND_GESTURE depending on the device. The
// previous "CONTROLLER only" filter dropped every event on Galaxy XR
// (hand pinch only) and made the gizmos look broken. UNKNOWN events have
// no actionable origin, so we still drop those.
private fun isInteractiveSource(source: InputEvent.Source): Boolean =
    source != InputEvent.Source.UNKNOWN

@Composable
fun TransformGizmo(
    session: Session,
    parentEntity: Entity?,
    selectedModel: PlacedModel,
    workspaceTx: Vector3,
    /** Active tool — only the matching handles render. Select hides the
     *  gizmo entirely (the call site can also avoid composing
     *  TransformGizmo at all in Select mode; the guard here lets a single
     *  composition survive tool switches without re-creating the
     *  GroupEntity root). */
    tool: GizmoTool,
    /** Live-drag override, sourced from the same `liveDragOverride` slot
     *  the model preview reads. Applied to the gizmo's root pose so the
     *  arrows / rings / cubes follow the model in real time during a
     *  drag (rather than staying anchored at the pre-drag position
     *  while the model translates away from them). Null = no drag. */
    liveOverride: GizmoDragOverride? = null,
    /** Emitted continuously during drag with the in-progress delta. The
     *  parent should apply it as a live setPose/setScale on the model
     *  entity (no re-bake). null = no drag in progress, drop the override. */
    onLivePreview: (GizmoDragOverride?) -> Unit,
    /** Emitted once at drag end with the final delta. Parent commits
     *  to PlacedModel (which triggers a single re-bake). */
    onCommit: (GizmoDragOverride) -> Unit,
) {
    if (tool == GizmoTool.Select) return
    val ctx = LocalContext.current
    var rootEntity by remember { mutableStateOf<GroupEntity?>(null) }

    LaunchedEffect(selectedModel.id, selectedModel.baseBboxXmm, selectedModel.baseBboxYmm, selectedModel.baseBboxZmm) {
        android.util.Log.i("OrcaXR", "TransformGizmo for model ${selectedModel.id}: dims=[${selectedModel.baseBboxXmm}, ${selectedModel.baseBboxYmm}, ${selectedModel.baseBboxZmm}] scales=[${selectedModel.effectiveScaleX}, ${selectedModel.effectiveScaleY}, ${selectedModel.effectiveScaleZ}]")
    }

    // Single DisposableEffect for the root's lifecycle — see commit history
    // for why splitting create/dispose across two effects was racy.
    DisposableEffect(session, parentEntity) {
        val root = GroupEntity.create(session, "OrcaXR-gizmoRoot")
        root.parent = parentEntity ?: session.scene.activitySpace
        rootEntity = root
        onDispose {
            rootEntity = null
            if (!root.isDisposed) runCatching { root.dispose() }
        }
    }

    val root = rootEntity ?: return

    val baseScale = computeGizmoBaseScale(selectedModel)
    val lenX = computeAxisLengthScale(selectedModel.baseBboxXmm * selectedModel.effectiveScaleX)
    val lenY = computeAxisLengthScale(selectedModel.baseBboxYmm * selectedModel.effectiveScaleY)
    val lenZ = computeAxisLengthScale(selectedModel.baseBboxZmm * selectedModel.effectiveScaleZ)
    val halfHeightMm = modelHalfHeightMm(selectedModel)
    val ovTx = liveOverride?.deltaTxMm ?: 0f
    val ovTy = liveOverride?.deltaTyMm ?: 0f
    val ovTz = liveOverride?.deltaTzMm ?: 0f

    LaunchedEffect(
        root,
        selectedModel.translateXmm, selectedModel.translateYmm, selectedModel.translateZmm,
        halfHeightMm, ovTx, ovTy, ovTz,
    ) {
        if (root.isDisposed) return@LaunchedEffect
        // Anchor at the model's geometric center (not the bed) so each
        // axis arrow has room to extend past the corresponding bbox face.
        // During a drag, the live override slides the root with the model.
        val cx = (selectedModel.translateXmm + ovTx) * WORLD_SCALE
        val cy = (selectedModel.translateYmm + ovTy) * WORLD_SCALE
        val cz = (selectedModel.translateZmm + halfHeightMm + ovTz) * WORLD_SCALE
        root.setPose(Pose(Vector3(cx, cy, cz), Quaternion.Identity))
    }

    val centerWorld = Vector3(
        workspaceTx.x + (selectedModel.translateXmm + ovTx) * WORLD_SCALE,
        workspaceTx.y + (selectedModel.translateYmm + ovTy) * WORLD_SCALE,
        workspaceTx.z + (selectedModel.translateZmm + halfHeightMm + ovTz) * WORLD_SCALE,
    )

    // Translation Arrows — drag projected onto printer axis (which after
    // WORKSPACE_ROTATION shows up as world X, -world Z, world Y).
    // Arrows scale their length per-axis to stay outside the model.
    if (tool == GizmoTool.Move) {
    GizmoDragHandle(session, ctx, root, "arrow_x_v3.glb", Vector3(lenX, baseScale, baseScale),
        generate = { f -> GizmoGlb.writeArrow(f, 0, GIZMO_ARROW_LEN_MM, GIZMO_ARROW_SHAFT_MM, floatArrayOf(1f, 0.2f, 0.2f)) },
        projectDelta = { delta -> delta.x },
        buildOverride = { dxMm -> GizmoDragOverride(deltaTxMm = dxMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoDragHandle(session, ctx, root, "arrow_y_v3.glb", Vector3(baseScale, lenY, baseScale),
        generate = { f -> GizmoGlb.writeArrow(f, 1, GIZMO_ARROW_LEN_MM, GIZMO_ARROW_SHAFT_MM, floatArrayOf(0.2f, 1f, 0.2f)) },
        projectDelta = { delta -> -delta.z },
        buildOverride = { dyMm -> GizmoDragOverride(deltaTyMm = dyMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoDragHandle(session, ctx, root, "arrow_z_v3.glb", Vector3(baseScale, baseScale, lenZ),
        generate = { f -> GizmoGlb.writeArrow(f, 2, GIZMO_ARROW_LEN_MM, GIZMO_ARROW_SHAFT_MM, floatArrayOf(0.2f, 0.2f, 1f)) },
        projectDelta = { delta -> delta.y },
        buildOverride = { dzMm -> GizmoDragOverride(deltaTzMm = dzMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    }

    // Rotation Rings — angle measured in the plane perpendicular to the
    // ring's printer-space normal. Hits arrive in world coords, so we
    // pick atan2 args that match the world plane the ring physically
    // lies in (X ring -> world YZ; Y ring -> world XY; Z ring -> world XZ).
    // Rotation Rings — printer X/Y/Z map to world X / -Z / Y.
    if (tool == GizmoTool.Rotate) {
    val uniScale = Vector3(baseScale, baseScale, baseScale)
    GizmoRotHandle(session, ctx, root, "ring_x_v2.glb", axis = 0, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeRing(f, 0, GIZMO_RING_RADIUS_MM, GIZMO_RING_THICK_MM, floatArrayOf(1f, 0.2f, 0.2f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotXDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoRotHandle(session, ctx, root, "ring_y_v2.glb", axis = 1, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeRing(f, 1, GIZMO_RING_RADIUS_MM, GIZMO_RING_THICK_MM, floatArrayOf(0.2f, 1f, 0.2f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotYDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoRotHandle(session, ctx, root, "ring_z_v2.glb", axis = 2, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeRing(f, 2, GIZMO_RING_RADIUS_MM, GIZMO_RING_THICK_MM, floatArrayOf(0.2f, 0.2f, 1f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotZDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    }

    // Scale Handles — printer X/Y/Z map to world X / -Z / Y.
    if (tool == GizmoTool.Scale) {
    val uniScale = Vector3(baseScale, baseScale, baseScale)
    GizmoScaleHandle(session, ctx, root, "scale_x_v2.glb", axis = 0, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeCube(f, GIZMO_SCALE_CUBE_MM, floatArrayOf(GIZMO_SCALE_OFFSET_MM, 0f, 0f), floatArrayOf(1f, 0.5f, 0.5f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultX = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoScaleHandle(session, ctx, root, "scale_y_v2.glb", axis = 1, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeCube(f, GIZMO_SCALE_CUBE_MM, floatArrayOf(0f, GIZMO_SCALE_OFFSET_MM, 0f), floatArrayOf(0.5f, 1f, 0.5f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultY = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoScaleHandle(session, ctx, root, "scale_z_v2.glb", axis = 2, centerWorld = centerWorld, gizmoScale = uniScale,
        generate = { f -> GizmoGlb.writeCube(f, GIZMO_SCALE_CUBE_MM, floatArrayOf(0f, 0f, GIZMO_SCALE_OFFSET_MM), floatArrayOf(0.5f, 0.5f, 1f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultZ = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    }
}

@Composable
fun GizmoDragHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
    gizmoScale: Vector3,
    generate: (File) -> Unit,
    projectDelta: (Vector3) -> Float,
    buildOverride: (Float) -> GizmoDragOverride,
    onLivePreview: (GizmoDragOverride?) -> Unit,
    onCommit: (GizmoDragOverride) -> Unit,
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val projectDeltaLive = rememberUpdatedState(projectDelta)
    val buildOverrideLive = rememberUpdatedState(buildOverride)
    val onLivePreviewLive = rememberUpdatedState(onLivePreview)
    val onCommitLive = rememberUpdatedState(onCommit)
    val gizmoScaleLive = rememberUpdatedState(gizmoScale)

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(gizmoScaleLive.value)
        entity = ent
    }

    LaunchedEffect(entity, gizmoScale) {
        val ent = entity ?: return@LaunchedEffect
        if (!ent.isDisposed) runCatching { ent.setScale(gizmoScale) }
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var lastHit: Vector3? = null
        var cumulativeMm = 0f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (!isInteractiveSource(event.source)) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            when (event.action) {
                InputEvent.Action.DOWN -> {
                    lastHit = hit
                    cumulativeMm = 0f
                    onLivePreviewLive.value(GizmoDragOverride())
                }
                InputEvent.Action.MOVE -> {
                    val lh = lastHit ?: return@Consumer
                    val worldDelta = Vector3(hit.x - lh.x, hit.y - lh.y, hit.z - lh.z)
                    val mmDelta = projectDeltaLive.value(worldDelta) / WORLD_SCALE
                    cumulativeMm += mmDelta
                    lastHit = hit
                    onLivePreviewLive.value(buildOverrideLive.value(cumulativeMm))
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    if (lastHit != null) {
                        lastHit = null
                        val finalOverride = buildOverrideLive.value(cumulativeMm)
                        onLivePreviewLive.value(null)
                        onCommitLive.value(finalOverride)
                    }
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            // The handle's GltfModelEntity is parented to the gizmo's
            // GroupEntity; on activity destroy SceneCore cascade-disposes
            // children before the handle composables' onDispose runs.
            // Without these guards removeComponent / dispose throw
            // Entity$DisposedException, which aborts the activity teardown
            // and led to a process restart with empty placedModels.
            if (!ent.isDisposed) {
                runCatching { ent.removeComponent(ic) }
                runCatching { ent.dispose() }
            }
        }
    }
}

@Composable
fun GizmoRotHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
    axis: Int,
    centerWorld: Vector3,
    gizmoScale: Vector3,
    generate: (File) -> Unit,
    buildOverride: (Float) -> GizmoDragOverride,
    onLivePreview: (GizmoDragOverride?) -> Unit,
    onCommit: (GizmoDragOverride) -> Unit,
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val buildOverrideLive = rememberUpdatedState(buildOverride)
    val onLivePreviewLive = rememberUpdatedState(onLivePreview)
    val onCommitLive = rememberUpdatedState(onCommit)
    val centerLive = rememberUpdatedState(centerWorld)
    val gizmoScaleLive = rememberUpdatedState(gizmoScale)

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(gizmoScaleLive.value)
        entity = ent
    }

    LaunchedEffect(entity, gizmoScale) {
        val ent = entity ?: return@LaunchedEffect
        if (!ent.isDisposed) runCatching { ent.setScale(gizmoScale) }
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var lastAngle: Float? = null
        var cumulativeDeg = 0f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (!isInteractiveSource(event.source)) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            val c = centerLive.value
            val dx = hit.x - c.x
            val dy = hit.y - c.y
            val dz = hit.z - c.z

            // Ring planes in WORLD coordinates after WORKSPACE_ROTATION:
            //   axis=0 (printer X / world X) -> ring lies in world YZ
            //   axis=1 (printer Y / world -Z) -> ring lies in world XY
            //   axis=2 (printer Z / world Y) -> ring lies in world XZ
            // Pick atan2 args from the appropriate plane.
            val angle = when (axis) {
                0 -> atan2(dy, dz)
                1 -> atan2(dy, dx)
                else -> atan2(dz, dx)
            }

            when (event.action) {
                InputEvent.Action.DOWN -> {
                    lastAngle = angle
                    cumulativeDeg = 0f
                    onLivePreviewLive.value(GizmoDragOverride())
                }
                InputEvent.Action.MOVE -> {
                    val la = lastAngle ?: return@Consumer
                    var delta = angle - la
                    if (delta > Math.PI) delta -= (2 * Math.PI).toFloat()
                    if (delta < -Math.PI) delta += (2 * Math.PI).toFloat()
                    cumulativeDeg += Math.toDegrees(delta.toDouble()).toFloat()
                    lastAngle = angle
                    onLivePreviewLive.value(buildOverrideLive.value(cumulativeDeg))
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    if (lastAngle != null) {
                        lastAngle = null
                        val finalOverride = buildOverrideLive.value(cumulativeDeg)
                        onLivePreviewLive.value(null)
                        onCommitLive.value(finalOverride)
                    }
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            // The handle's GltfModelEntity is parented to the gizmo's
            // GroupEntity; on activity destroy SceneCore cascade-disposes
            // children before the handle composables' onDispose runs.
            // Without these guards removeComponent / dispose throw
            // Entity$DisposedException, which aborts the activity teardown
            // and led to a process restart with empty placedModels.
            if (!ent.isDisposed) {
                runCatching { ent.removeComponent(ic) }
                runCatching { ent.dispose() }
            }
        }
    }
}

@Composable
fun GizmoScaleHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
    axis: Int,
    centerWorld: Vector3,
    gizmoScale: Vector3,
    generate: (File) -> Unit,
    buildOverride: (Float) -> GizmoDragOverride,
    onLivePreview: (GizmoDragOverride?) -> Unit,
    onCommit: (GizmoDragOverride) -> Unit,
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val buildOverrideLive = rememberUpdatedState(buildOverride)
    val onLivePreviewLive = rememberUpdatedState(onLivePreview)
    val onCommitLive = rememberUpdatedState(onCommit)
    val centerLive = rememberUpdatedState(centerWorld)
    val gizmoScaleLive = rememberUpdatedState(gizmoScale)

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(gizmoScaleLive.value)
        entity = ent
    }

    LaunchedEffect(entity, gizmoScale) {
        val ent = entity ?: return@LaunchedEffect
        if (!ent.isDisposed) runCatching { ent.setScale(gizmoScale) }
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var startProj: Float? = null
        var lastRatio = 1f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (!isInteractiveSource(event.source)) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            val c = centerLive.value
            val dx = hit.x - c.x
            val dy = hit.y - c.y
            val dz = hit.z - c.z
            // Project drag offset onto the cube's printer-space axis (in
            // WORLD coords): printer X = +X, printer Y = -Z, printer Z = +Y.
            val proj = when (axis) {
                0 -> dx
                1 -> -dz
                else -> dy
            }
            when (event.action) {
                InputEvent.Action.DOWN -> {
                    startProj = proj
                    lastRatio = 1f
                    onLivePreviewLive.value(GizmoDragOverride())
                }
                InputEvent.Action.MOVE -> {
                    val sp = startProj ?: return@Consumer
                    if (abs(sp) < 0.001f) return@Consumer
                    val ratio = (proj / sp).coerceIn(0.1f, 10f)
                    lastRatio = ratio
                    onLivePreviewLive.value(buildOverrideLive.value(ratio))
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    if (startProj != null) {
                        startProj = null
                        val finalOverride = buildOverrideLive.value(lastRatio)
                        onLivePreviewLive.value(null)
                        onCommitLive.value(finalOverride)
                    }
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            // The handle's GltfModelEntity is parented to the gizmo's
            // GroupEntity; on activity destroy SceneCore cascade-disposes
            // children before the handle composables' onDispose runs.
            // Without these guards removeComponent / dispose throw
            // Entity$DisposedException, which aborts the activity teardown
            // and led to a process restart with empty placedModels.
            if (!ent.isDisposed) {
                runCatching { ent.removeComponent(ic) }
                runCatching { ent.dispose() }
            }
        }
    }
}
