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
import kotlin.math.sqrt

@Composable
fun TransformGizmo(
    session: Session,
    parentEntity: Entity?,
    selectedModel: PlacedModel,
    workspaceTx: Vector3,
    onUpdateSelected: ((PlacedModel) -> PlacedModel) -> Unit
) {
    val ctx = LocalContext.current
    var rootEntity by remember { mutableStateOf<GroupEntity?>(null) }

    LaunchedEffect(session, parentEntity) {
        val root = GroupEntity.create(session, "OrcaXR-gizmoRoot")
        root.parent = parentEntity ?: session.scene.activitySpace
        rootEntity = root
    }

    DisposableEffect(rootEntity) {
        onDispose { rootEntity?.dispose() }
    }

    val root = rootEntity ?: return

    LaunchedEffect(root, selectedModel.translateXmm, selectedModel.translateYmm, selectedModel.translateZmm) {
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

    // Translation Arrows
    GizmoDragHandle(session, ctx, root, "arrow_x.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 0, 40f, 1.5f, floatArrayOf(1f, 0.2f, 0.2f)) },
        onDrag = { delta, _ -> onUpdateSelected { it.copy(translateXmm = it.translateXmm + (delta.x / WORLD_SCALE)) } }
    )
    GizmoDragHandle(session, ctx, root, "arrow_y.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 1, 40f, 1.5f, floatArrayOf(0.2f, 1f, 0.2f)) },
        onDrag = { delta, _ -> onUpdateSelected { it.copy(translateYmm = it.translateYmm + (delta.y / WORLD_SCALE)) } }
    )
    GizmoDragHandle(session, ctx, root, "arrow_z.glb",
        generate = { f -> GizmoGlb.writeArrow(f, 2, 40f, 1.5f, floatArrayOf(0.2f, 0.2f, 1f)) },
        onDrag = { delta, _ -> onUpdateSelected { it.copy(translateZmm = it.translateZmm + (delta.z / WORLD_SCALE)) } }
    )

    // Rotation Rings
    val ringRadius = 45f
    GizmoRotHandle(session, ctx, root, "ring_x.glb", 0, centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 0, ringRadius, 1.0f, floatArrayOf(1f, 0.2f, 0.2f)) },
        onRotate = { deg -> onUpdateSelected { it.copy(rotXDeg = (it.rotXDeg + deg) % 360f) } }
    )
    GizmoRotHandle(session, ctx, root, "ring_y.glb", 1, centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 1, ringRadius, 1.0f, floatArrayOf(0.2f, 1f, 0.2f)) },
        onRotate = { deg -> onUpdateSelected { it.copy(rotYDeg = (it.rotYDeg + deg) % 360f) } }
    )
    GizmoRotHandle(session, ctx, root, "ring_z.glb", 2, centerWorld,
        generate = { f -> GizmoGlb.writeRing(f, 2, ringRadius, 1.0f, floatArrayOf(0.2f, 0.2f, 1f)) },
        onRotate = { deg -> onUpdateSelected { it.copy(rotZDeg = (((it.rotZDeg + deg.toInt()) % 360) + 360) % 360) } }
    )

    // Scale Handles (placed slightly further out on axes)
    val scaleOffset = 50f
    GizmoScaleHandle(session, ctx, root, "scale_x.glb", centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(scaleOffset, 0f, 0f), floatArrayOf(1f, 0.5f, 0.5f)) },
        onScale = { ratio -> onUpdateSelected { it.copy(scaleXPct = (it.scaleXPct * ratio).coerceIn(10f, 1000f)) } }
    )
    GizmoScaleHandle(session, ctx, root, "scale_y.glb", centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(0f, scaleOffset, 0f), floatArrayOf(0.5f, 1f, 0.5f)) },
        onScale = { ratio -> onUpdateSelected { it.copy(scaleYPct = (it.scaleYPct * ratio).coerceIn(10f, 1000f)) } }
    )
    GizmoScaleHandle(session, ctx, root, "scale_z.glb", centerWorld,
        generate = { f -> GizmoGlb.writeCube(f, 4f, floatArrayOf(0f, 0f, scaleOffset), floatArrayOf(0.5f, 0.5f, 1f)) },
        onScale = { ratio -> onUpdateSelected { it.copy(scaleZPct = (it.scaleZPct * ratio).coerceIn(10f, 1000f)) } }
    )
}

@Composable
fun GizmoDragHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
    generate: (File) -> Unit,
    onDrag: (delta: Vector3, hit: Vector3) -> Unit
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val onDragLive = rememberUpdatedState(onDrag)

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
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            when (event.action) {
                InputEvent.Action.DOWN -> {
                    lastHit = hit
                }
                InputEvent.Action.MOVE -> {
                    val lh = lastHit
                    if (lh != null) {
                        val dx = hit.x - lh.x
                        val dy = hit.y - lh.y
                        val dz = hit.z - lh.z
                        onDragLive.value(Vector3(dx, dy, dz), hit)
                        lastHit = hit
                    }
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    lastHit = null
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            ent.removeComponent(ic)
            ent.dispose()
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
    onRotate: (deltaDeg: Float) -> Unit
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val onRotateLive = rememberUpdatedState(onRotate)
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
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            val c = centerLive.value
            
            val angle = when(axis) {
                0 -> atan2(hit.y - c.y, hit.z - c.z)
                1 -> atan2(hit.x - c.x, hit.z - c.z)
                else -> atan2(hit.y - c.y, hit.x - c.x)
            }
            
            when (event.action) {
                InputEvent.Action.DOWN -> {
                    lastAngle = angle
                }
                InputEvent.Action.MOVE -> {
                    val la = lastAngle
                    if (la != null) {
                        var delta = angle - la
                        // Handle wrap-around
                        if (delta > Math.PI) delta -= (2 * Math.PI).toFloat()
                        if (delta < -Math.PI) delta += (2 * Math.PI).toFloat()
                        
                        onRotateLive.value(Math.toDegrees(delta.toDouble()).toFloat())
                        lastAngle = angle
                    }
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    lastAngle = null
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            ent.removeComponent(ic)
            ent.dispose()
        }
    }
}

@Composable
fun GizmoScaleHandle(
    session: Session,
    ctx: Context,
    parentEntity: Entity,
    filename: String,
    centerWorld: Vector3,
    generate: (File) -> Unit,
    onScale: (ratio: Float) -> Unit
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val onScaleLive = rememberUpdatedState(onScale)
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
        var lastDist: Float? = null
        val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
        val listener = java.util.function.Consumer<InputEvent> { event ->
            if (event.source != InputEvent.Source.CONTROLLER) return@Consumer
            val hit = event.hitInfoList.firstOrNull()?.hitPosition ?: return@Consumer
            val c = centerLive.value
            
            val dx = hit.x - c.x
            val dy = hit.y - c.y
            val dz = hit.z - c.z
            val dist = sqrt(dx*dx + dy*dy + dz*dz)
            
            when (event.action) {
                InputEvent.Action.DOWN -> {
                    lastDist = dist
                }
                InputEvent.Action.MOVE -> {
                    val ld = lastDist
                    if (ld != null && ld > 0.001f) {
                        val ratio = dist / ld
                        onScaleLive.value(ratio)
                        lastDist = dist
                    }
                }
                InputEvent.Action.UP, InputEvent.Action.CANCEL -> {
                    lastDist = null
                }
                else -> {}
            }
        }
        val ic = InteractableComponent.create(session, executor, listener)
        ent.addComponent(ic)
        onDispose {
            ent.removeComponent(ic)
            ent.dispose()
        }
    }
}

