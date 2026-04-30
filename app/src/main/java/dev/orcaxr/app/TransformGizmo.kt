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
// So a delta vector in WORLD coords projects onto the printer axes as:
private fun worldDeltaToPrinterX(delta: Vector3) = delta.x
private fun worldDeltaToPrinterY(delta: Vector3) = -delta.z
private fun worldDeltaToPrinterZ(delta: Vector3) = delta.y

@Composable
fun TransformGizmo(
    session: Session,
    parentEntity: Entity?,
    selectedModel: PlacedModel,
    workspaceTx: Vector3,
    /** Emitted continuously during drag with the in-progress delta. The
     *  parent should apply it as a live setPose/setScale on the model
     *  entity (no re-bake). null = no drag in progress, drop the override. */
    onLivePreview: (GizmoDragOverride?) -> Unit,
    /** Emitted once at drag end with the final delta. Parent commits
     *  to PlacedModel (which triggers a single re-bake). */
    onCommit: (GizmoDragOverride) -> Unit,
) {
    val ctx = LocalContext.current
    var rootEntity by remember { mutableStateOf<GroupEntity?>(null) }

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

    LaunchedEffect(root, selectedModel.translateXmm, selectedModel.translateYmm, selectedModel.translateZmm) {
        if (root.isDisposed) return@LaunchedEffect
        root.setPose(Pose(
            Vector3(selectedModel.translateXmm * WORLD_SCALE, selectedModel.translateYmm * WORLD_SCALE, selectedModel.translateZmm * WORLD_SCALE),
            Quaternion.Identity
        ))
    }

    val centerWorld = Vector3(
        workspaceTx.x + selectedModel.translateXmm * WORLD_SCALE,
        workspaceTx.y + selectedModel.translateYmm * WORLD_SCALE,
        workspaceTx.z + selectedModel.translateZmm * WORLD_SCALE
    )

    // Translation Arrows — drag projected onto printer axis (which after
    // WORKSPACE_ROTATION shows up as world X, -world Z, world Y). The X
    // arrow already used delta.x; Y and Z were reading the wrong world
    // components and translated the model in nonsensical directions.
    GizmoDragHandle(session, ctx, root, "arrow_x.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 0, 40f, 1.5f, floatArrayOf(1f, 0.2f, 0.2f)) },
        projectDelta = ::worldDeltaToPrinterX,
        buildOverride = { dxMm -> GizmoDragOverride(deltaTxMm = dxMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoDragHandle(session, ctx, root, "arrow_y.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 1, 40f, 1.5f, floatArrayOf(0.2f, 1f, 0.2f)) },
        projectDelta = ::worldDeltaToPrinterY,
        buildOverride = { dyMm -> GizmoDragOverride(deltaTyMm = dyMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoDragHandle(session, ctx, root, "arrow_z.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 2, 40f, 1.5f, floatArrayOf(0.2f, 0.2f, 1f)) },
        projectDelta = ::worldDeltaToPrinterZ,
        buildOverride = { dzMm -> GizmoDragOverride(deltaTzMm = dzMm) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )

    // Rotation Rings — angle measured in the plane perpendicular to the
    // ring's printer-space normal. Hits arrive in world coords, so we
    // pick atan2 args that match the world plane the ring physically
    // lies in (X ring -> world YZ; Y ring -> world XY; Z ring -> world XZ).
    val ringRadius = 45f
    GizmoRotHandle(session, ctx, root, "ring_x.glb", axis = 0, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 0, ringRadius, 1.0f, floatArrayOf(1f, 0.2f, 0.2f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotXDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoRotHandle(session, ctx, root, "ring_y.glb", axis = 1, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 1, ringRadius, 1.0f, floatArrayOf(0.2f, 1f, 0.2f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotYDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoRotHandle(session, ctx, root, "ring_z.glb", axis = 2, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 2, ringRadius, 1.0f, floatArrayOf(0.2f, 0.2f, 1f)) },
        buildOverride = { deg -> GizmoDragOverride(deltaRotZDeg = deg) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )

    // Scale Handles — drag projected onto the cube's printer-space axis
    // direction. Ratio = currentProjection / startProjection, clamped to
    // a sane range so a single drag doesn't blow up by 100x.
    val scaleOffset = 50f
    GizmoScaleHandle(session, ctx, root, "scale_x.glb", axis = 0, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(scaleOffset, 0f, 0f), floatArrayOf(1f, 0.5f, 0.5f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultX = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoScaleHandle(session, ctx, root, "scale_y.glb", axis = 1, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(0f, scaleOffset, 0f), floatArrayOf(0.5f, 1f, 0.5f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultY = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
    GizmoScaleHandle(session, ctx, root, "scale_z.glb", axis = 2, centerWorld = centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(0f, 0f, scaleOffset), floatArrayOf(0.5f, 0.5f, 1f)) },
        buildOverride = { ratio -> GizmoDragOverride(scaleMultZ = ratio) },
        onLivePreview = onLivePreview, onCommit = onCommit,
    )
}

@Composable
fun GizmoDragHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
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

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(WORLD_SCALE)
        entity = ent
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var lastHit: Vector3? = null
        var cumulativeMm = 0f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
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

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(WORLD_SCALE)
        entity = ent
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var lastAngle: Float? = null
        var cumulativeDeg = 0f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
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

    LaunchedEffect(session, filename) {
        val file = File(ctx.cacheDir, filename)
        if (!file.exists()) generate(file)
        val bytes = file.readBytes()
        val model = GltfModel.create(session, bytes, filename)
        val ent = GltfModelEntity.create(session, model)
        ent.parent = parentEntity
        ent.setScale(WORLD_SCALE)
        entity = ent
    }

    DisposableEffect(entity) {
        val ent = entity ?: return@DisposableEffect onDispose {}
        var startProj: Float? = null
        var lastRatio = 1f
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
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
