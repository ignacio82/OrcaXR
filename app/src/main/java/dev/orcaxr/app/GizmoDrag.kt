package dev.orcaxr.app

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * Ray-based gizmo drag math, in the receiving entity's mesh-mm frame
 * (= printer axes: X left/right, Y depth, Z vertical). The frame comes
 * from `InputEvent.hitInfoList[0].transform` via
 * [PaintInputHooks.worldRayToMeshMm] — the same proven conversion the
 * paint pipeline uses on Galaxy XR.
 *
 * Design: OrcaSlicer-style DIRECT manipulation. Every mapping anchors a
 * drag plane at pinch-DOWN, intersects each subsequent MOVE's ray with
 * that plane, and derives the transform delta from the two intersection
 * points. The model therefore tracks the laser dot 1:1 — no sensitivity
 * constants, no accumulated velocity.
 *
 * Pure JVM (no SceneCore types) so unit tests can drive it directly.
 */

// -- tiny vector helpers (Vec3f is the shared mesh-frame float triple) --
internal operator fun Vec3f.plus(o: Vec3f) = Vec3f(x + o.x, y + o.y, z + o.z)
internal operator fun Vec3f.minus(o: Vec3f) = Vec3f(x - o.x, y - o.y, z - o.z)
internal operator fun Vec3f.times(s: Float) = Vec3f(x * s, y * s, z * s)
internal fun Vec3f.dot(o: Vec3f) = x * o.x + y * o.y + z * o.z
internal fun Vec3f.cross(o: Vec3f) =
    Vec3f(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x)
internal fun Vec3f.length() = sqrt(x * x + y * y + z * z)
internal fun Vec3f.normalizedOrNull(): Vec3f? {
    val l = length()
    return if (l < 1e-6f) null else Vec3f(x / l, y / l, z / l)
}

/** Intersect ray (origin, dir) with the plane through [planePoint] with
 *  normal [planeNormal]. Returns null when the ray is parallel to the
 *  plane or the hit is behind the origin. */
internal fun rayPlaneIntersect(
    origin: Vec3f,
    dir: Vec3f,
    planePoint: Vec3f,
    planeNormal: Vec3f,
): Vec3f? {
    val denom = dir.dot(planeNormal)
    if (abs(denom) < 1e-6f) return null
    val t = (planePoint - origin).dot(planeNormal) / denom
    if (t < 0f) return null
    return origin + dir * t
}

private fun axisUnit(axis: Int) = when (axis) {
    0 -> Vec3f(1f, 0f, 0f)
    1 -> Vec3f(0f, 1f, 0f)
    else -> Vec3f(0f, 0f, 1f)
}

/** Max translate delta (mm) a single drag can apply — clips the huge
 *  jumps a near-grazing ray/plane intersection can momentarily report. */
private const val MAX_TRANSLATE_MM = 600f

/** How a drag on a specific collider maps ray motion to a transform. */
sealed interface GizmoDragMapping {
    /** Slide on the bed plane at height [planeZmm]: free X/Y move.
     *  (The model-body grab in Move mode.) */
    data class MoveInPlane(val planeZmm: Float) : GizmoDragMapping

    /** Constrained move along printer axis [axis] (0=X 1=Y 2=Z).
     *  (The gizmo arrows in Move mode.) */
    data class MoveAlongAxis(val axis: Int, val anchorMm: Vec3f) : GizmoDragMapping

    /** Rotate about printer axis [axis] through [centerMm]: the drag
     *  point's angle around the axis is tracked 1:1, exactly like
     *  OrcaSlicer's rotation rings. */
    data class RotateAboutAxis(val axis: Int, val centerMm: Vec3f) : GizmoDragMapping

    /** Uniform scale about [centerMm]: ratio of distances from center.
     *  (The model-body grab in Scale mode.) */
    data class ScaleUniform(val centerMm: Vec3f) : GizmoDragMapping

    /** Per-axis scale via the corner cube on [axis]. */
    data class ScaleAlongAxis(val axis: Int, val centerMm: Vec3f) : GizmoDragMapping
}

/**
 * One pinch-drag: [start] on DOWN fixes the drag plane and reference
 * point; [update] on each MOVE returns the in-progress override (or null
 * when this event is degenerate — caller keeps the previous override).
 */
class GizmoDragSession(private val mapping: GizmoDragMapping) {

    private var planePoint = Vec3f(0f, 0f, 0f)
    private var planeNormal = Vec3f(0f, 0f, 1f)
    private var startPoint = Vec3f(0f, 0f, 0f)
    private var startAngleRad = 0f

    /** Bed-plane fallback for near-horizontal gaze (see [start]):
     *  when set, free-move decomposes hand motion into a lateral
     *  bed direction and an away-from-viewer bed direction. */
    private var lateralDir: Vec3f? = null
    private var awayDir: Vec3f? = null

    /** @return false when the mapping can't establish a stable drag
     *  plane from this ray (caller should ignore the gesture). */
    fun start(originMm: Vec3f, dirMm: Vec3f): Boolean {
        val d = dirMm.normalizedOrNull() ?: return false
        when (mapping) {
            is GizmoDragMapping.MoveInPlane -> {
                planePoint = Vec3f(0f, 0f, mapping.planeZmm)
                if (abs(d.z) >= 0.15f) {
                    // Gaze meets the bed at a usable angle: drag directly
                    // on the bed plane — model follows the laser dot.
                    planeNormal = Vec3f(0f, 0f, 1f)
                    lateralDir = null
                    awayDir = null
                } else {
                    // Near-horizontal gaze: the bed-plane intersection is
                    // unstable. Use a camera-facing vertical plane and map
                    // lateral hand motion → lateral bed move, vertical hand
                    // motion → depth (push up = away).
                    val horiz = Vec3f(d.x, d.y, 0f).normalizedOrNull() ?: return false
                    planeNormal = horiz * -1f
                    awayDir = horiz
                    lateralDir = Vec3f(0f, 0f, 1f).cross(horiz).normalizedOrNull()
                        ?: return false
                }
            }
            is GizmoDragMapping.MoveAlongAxis -> {
                val a = axisUnit(mapping.axis)
                // Plane containing the axis, facing the viewer as much as
                // possible: normal = view dir minus its along-axis part.
                val n = (d - a * d.dot(a)).normalizedOrNull() ?: return false
                planeNormal = n * -1f
                planePoint = mapping.anchorMm
            }
            is GizmoDragMapping.RotateAboutAxis -> {
                planeNormal = axisUnit(mapping.axis)
                planePoint = mapping.centerMm
                // Grazing guard: if the ring plane is nearly edge-on the
                // intersection runs off to infinity and the angle jumps.
                if (abs(d.dot(planeNormal)) < 0.08f) return false
            }
            is GizmoDragMapping.ScaleUniform -> {
                planeNormal = d * -1f
                planePoint = mapping.centerMm
            }
            is GizmoDragMapping.ScaleAlongAxis -> {
                val a = axisUnit(mapping.axis)
                val n = (d - a * d.dot(a)).normalizedOrNull() ?: return false
                planeNormal = n * -1f
                planePoint = mapping.centerMm
            }
        }
        val p = rayPlaneIntersect(originMm, d, planePoint, planeNormal) ?: return false
        startPoint = p
        if (mapping is GizmoDragMapping.RotateAboutAxis) {
            startAngleRad = angleAround(mapping.axis, mapping.centerMm, p) ?: return false
        }
        if (mapping is GizmoDragMapping.ScaleUniform &&
            (p - mapping.centerMm).length() < 5f
        ) return false
        if (mapping is GizmoDragMapping.ScaleAlongAxis &&
            abs((p - mapping.centerMm).dot(axisUnit(mapping.axis))) < 3f
        ) return false
        return true
    }

    fun update(originMm: Vec3f, dirMm: Vec3f): GizmoDragOverride? {
        val d = dirMm.normalizedOrNull() ?: return null
        val p = rayPlaneIntersect(originMm, d, planePoint, planeNormal) ?: return null
        val delta = p - startPoint
        return when (mapping) {
            is GizmoDragMapping.MoveInPlane -> {
                val lat = lateralDir
                val away = awayDir
                val (dx, dy) = if (lat == null || away == null) {
                    delta.x to delta.y
                } else {
                    val l = delta.dot(lat)
                    val v = delta.z
                    (l * lat.x + v * away.x) to (l * lat.y + v * away.y)
                }
                GizmoDragOverride(
                    deltaTxMm = dx.coerceIn(-MAX_TRANSLATE_MM, MAX_TRANSLATE_MM),
                    deltaTyMm = dy.coerceIn(-MAX_TRANSLATE_MM, MAX_TRANSLATE_MM),
                )
            }
            is GizmoDragMapping.MoveAlongAxis -> {
                val a = axisUnit(mapping.axis)
                val amt = delta.dot(a).coerceIn(-MAX_TRANSLATE_MM, MAX_TRANSLATE_MM)
                when (mapping.axis) {
                    0 -> GizmoDragOverride(deltaTxMm = amt)
                    1 -> GizmoDragOverride(deltaTyMm = amt)
                    else -> GizmoDragOverride(deltaTzMm = amt)
                }
            }
            is GizmoDragMapping.RotateAboutAxis -> {
                val ang = angleAround(mapping.axis, mapping.centerMm, p) ?: return null
                var deltaDeg = Math.toDegrees((ang - startAngleRad).toDouble()).toFloat()
                while (deltaDeg > 180f) deltaDeg -= 360f
                while (deltaDeg < -180f) deltaDeg += 360f
                when (mapping.axis) {
                    0 -> GizmoDragOverride(deltaRotXDeg = deltaDeg)
                    1 -> GizmoDragOverride(deltaRotYDeg = deltaDeg)
                    else -> GizmoDragOverride(deltaRotZDeg = deltaDeg)
                }
            }
            is GizmoDragMapping.ScaleUniform -> {
                val r0 = (startPoint - mapping.centerMm).length()
                if (r0 < 1e-3f) return null
                val r = ((p - mapping.centerMm).length() / r0).coerceIn(0.05f, 20f)
                GizmoDragOverride(scaleMultX = r, scaleMultY = r, scaleMultZ = r)
            }
            is GizmoDragMapping.ScaleAlongAxis -> {
                val a = axisUnit(mapping.axis)
                val s0 = (startPoint - mapping.centerMm).dot(a)
                if (abs(s0) < 1e-3f) return null
                val r = (abs((p - mapping.centerMm).dot(a)) / abs(s0)).coerceIn(0.05f, 20f)
                when (mapping.axis) {
                    0 -> GizmoDragOverride(scaleMultX = r)
                    1 -> GizmoDragOverride(scaleMultY = r)
                    else -> GizmoDragOverride(scaleMultZ = r)
                }
            }
        }
    }

    /** Right-handed angle of [p] around printer axis [axis] through
     *  [center]: X→(Y,Z), Y→(Z,X), Z→(X,Y) basis pairs. */
    private fun angleAround(axis: Int, center: Vec3f, p: Vec3f): Float? {
        val q = p - center
        val (u, v) = when (axis) {
            0 -> q.y to q.z
            1 -> q.z to q.x
            else -> q.x to q.y
        }
        if (abs(u) < 1e-4f && abs(v) < 1e-4f) return null
        return atan2(v, u)
    }
}

/**
 * Routes a collider's `InteractableComponent` InputEvents into a
 * [GizmoDragSession]. One driver per collider; the mapping is resolved
 * fresh at each pinch-DOWN via [mappingProvider] (returning null = this
 * collider is inert right now, e.g. gizmo tool not armed).
 *
 * The world→mesh-mm transform is captured from the DOWN event's HitInfo
 * and reused for every MOVE in the drag — MOVE events keep streaming on
 * Galaxy XR even when the ray leaves the collider (proven by the paint
 * pipeline), but their hitInfoList may then be empty.
 */
class GizmoRayDragDriver(
    private val tag: String,
    private val mappingProvider: () -> GizmoDragMapping?,
    private val onPreview: (GizmoDragOverride?) -> Unit,
    private val onCommit: (GizmoDragOverride) -> Unit,
) {
    private var transform: androidx.xr.runtime.math.Matrix4? = null
    private var drag: GizmoDragSession? = null
    private var last: GizmoDragOverride? = null

    /** True while a pinch-drag is in progress on this collider. */
    val isDragging: Boolean get() = drag != null

    fun handle(event: androidx.xr.scenecore.InputEvent) {
        when (event.action) {
            androidx.xr.scenecore.InputEvent.Action.DOWN -> {
                val mapping = mappingProvider() ?: return
                val hit = event.hitInfoList.firstOrNull()
                if (hit == null) {
                    android.util.Log.i("OrcaXR/gizmo", "$tag DOWN without hitInfo — ignored")
                    return
                }
                val tf = hit.transform
                val (o, d) = PaintInputHooks.worldRayToMeshMm(event.origin, event.direction, tf)
                val s = GizmoDragSession(mapping)
                if (s.start(o, d)) {
                    transform = tf
                    drag = s
                    last = GizmoDragOverride()
                    onPreview(GizmoDragOverride())
                    android.util.Log.i(
                        "OrcaXR/gizmo",
                        "$tag drag start $mapping meshRay o=(${o.x},${o.y},${o.z}) d=(${d.x},${d.y},${d.z})",
                    )
                } else {
                    drag = null
                    android.util.Log.i("OrcaXR/gizmo", "$tag drag refused (degenerate ray) $mapping")
                }
            }
            androidx.xr.scenecore.InputEvent.Action.MOVE -> {
                val s = drag ?: return
                val tf = transform ?: return
                val (o, d) = PaintInputHooks.worldRayToMeshMm(event.origin, event.direction, tf)
                s.update(o, d)?.let {
                    last = it
                    onPreview(it)
                }
            }
            androidx.xr.scenecore.InputEvent.Action.UP -> {
                if (drag != null) {
                    onPreview(null)
                    last?.let {
                        android.util.Log.i("OrcaXR/gizmo", "$tag drag commit $it")
                        onCommit(it)
                    }
                }
                drag = null
                transform = null
                last = null
            }
            androidx.xr.scenecore.InputEvent.Action.CANCEL -> {
                if (drag != null) onPreview(null)
                drag = null
                transform = null
                last = null
            }
            else -> { /* HOVER_* — no-op */ }
        }
    }
}
