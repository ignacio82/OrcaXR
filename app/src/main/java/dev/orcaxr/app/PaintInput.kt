package dev.orcaxr.app

import androidx.xr.runtime.math.Vector3
import androidx.xr.scenecore.InputEvent
import androidx.xr.scenecore.InputEvent.Action

/**
 * Phase J §4.1 — bridge between an `InteractableComponent.create`
 * listener firing on a `GltfModelEntity` and the per-model paint
 * state on `PlacedModel`. Holds enough context to:
 *
 *  1. Filter incoming events to controller-laser only (Galaxy XR's
 *     hand-tracking events are too jittery for triangle-precise
 *     painting, see `docs/PHASE_J_PAINTING_PLAN.md` §1).
 *  2. Convert the world-space ray that the runtime hands us
 *     (`InputEvent.origin` + `InputEvent.direction`) into the mesh's
 *     local frame using `HitInfo.transform`. The transform encodes
 *     parent chain (workspace → model entity), authored pose, and
 *     the user's plate transforms (translateXmm/Ymm rendered as
 *     `setPose`).
 *  3. Raycast against the [MeshBvh] to map the laser hit to a
 *     triangle index in the SAME numbering [stampTriangle] uses.
 *  4. Stamp the triangle (or a brush-radius BFS expansion) via the
 *     [onPaint] callback, which closes over the model id +
 *     `placedModels` setter in `XrShell`.
 *
 * Why hitInfoList[0].hitPosition isn't used directly: at alpha13 we
 * don't yet know whether the runtime resolves the hit to a triangle
 * surface or just to the entity's bounding region (per Phase J.0
 * hardware question 1). Doing our own ray-vs-mesh test against the
 * BVH gives us a guaranteed surface hit AND lets the brush radius
 * BFS expand from a known-good triangle index. If hardware shows
 * `hitPosition` IS surface-resolved, we can skip the BVH raycast and
 * use closest-triangle lookup instead — for now the BVH path is the
 * conservative default.
 *
 * The class is constructed in `XrShell` once per active paint
 * session; the InteractableComponent listener captures it via
 * `rememberUpdatedState` so brush radius / slot / on-paint callback
 * always see the latest values.
 */
class PaintInputHooks(
    private val brush: PaintBrush,
    private val bvh: MeshBvh,
    /** Stamp callback. The [hitTri] is in the source mesh's
     *  triangle-index frame. The action (DOWN/MOVE/UP) lets the
     *  caller distinguish a stroke start (`onPaint` may need to
     *  pre-allocate or clear a stroke buffer) from a continuation. */
    private val onPaint: (hitTri: Int, action: Action) -> Unit,
) {
    /**
     * Process one [InputEvent] from a `GltfModelEntity`'s
     * `InteractableComponent` listener. No-op when:
     *   - paint mode is off
     *   - source isn't `CONTROLLER` (filter out HANDS jitter)
     *   - action is HOVER_* (we don't paint on hover)
     *   - the ray misses every triangle in the mesh
     */
    fun handle(event: InputEvent) {
        if (brush.mode == PaintMode.Off) return
        if (event.source != InputEvent.Source.CONTROLLER) return
        when (event.action) {
            Action.DOWN, Action.MOVE -> { /* paint */ }
            else -> return
        }
        val hitTri = locateTriangle(event) ?: return
        onPaint(hitTri, event.action)
    }

    /**
     * Map a world-space ray onto a mesh-local triangle index. Public
     * so tests can drive the math without faking an Activity-scoped
     * InputEvent listener.
     */
    fun locateTriangle(event: InputEvent): Int? {
        // Need a HitInfo to know the entity's world transform. The
        // SDK populates hitInfoList for any InteractableComponent
        // event that intersects the entity (or its bounding region).
        val hit = event.hitInfoList.firstOrNull() ?: return null
        // Decompose the entity's world transform into pose (T, R) and
        // scale (S). `Matrix4.pose` drops the scale component, so we
        // have to apply S separately to land in the right coordinate
        // space. With `setScale(WORLD_SCALE = 0.0015f)` on the
        // GltfModelEntity the matrix's scale is 0.0015 — pose-only
        // inverse-transform leaves the result in WORLD METERS, but
        // the BVH was built from a mesh whose positions are in
        // PRINTER MILLIMETERS. Without the divide-by-scale here the
        // ray lands ~667× too far from origin and misses every
        // triangle.
        val transform = hit.transform
        val invPose = transform.pose.inverse
        val scale = transform.scale
        val sx = if (scale.x != 0f) scale.x else 1f
        val sy = if (scale.y != 0f) scale.y else 1f
        val sz = if (scale.z != 0f) scale.z else 1f
        val originPoseLocal = invPose.transformPoint(event.origin)
        val originLocal = Vec3f(
            originPoseLocal.x / sx,
            originPoseLocal.y / sy,
            originPoseLocal.z / sz,
        )
        // For directions, the magnitude doesn't matter to
        // Möller-Trumbore (only the line through origin), so we can
        // skip the per-axis divide. transformVector skips translation.
        val dirVec = invPose.transformVector(event.direction)
        val dirLocal = Vec3f(dirVec.x, dirVec.y, dirVec.z)
        val tri = bvh.intersect(origin = originLocal, direction = dirLocal)
        if (android.util.Log.isLoggable(LOG_TAG, android.util.Log.VERBOSE)) {
            android.util.Log.v(
                LOG_TAG,
                "locateTriangle: scale=($sx,$sy,$sz) " +
                    "originLocal=(${originLocal.x},${originLocal.y},${originLocal.z}) " +
                    "dirLocal=(${dirLocal.x},${dirLocal.y},${dirLocal.z}) " +
                    "→ tri=$tri",
            )
        }
        return tri
    }

    companion object {
        private const val LOG_TAG = "OrcaXR/paint"
    }
}

/**
 * Convenience: lazy `MeshBvh` cache keyed by `PlacedModel.id`. Built
 * the first time a paint session asks for it; survives transforms
 * (rotate / scale) because Phase J's stance is that paint is on the
 * SOURCE mesh's triangle indices and those don't reorder under
 * `StlMesh.{rotatedZ, scaled, translated}`. Invalidate explicitly
 * (via [invalidate]) when the source file is replaced.
 */
class MeshBvhCache {
    private val byId = mutableMapOf<String, MeshBvh>()

    @Synchronized
    fun get(id: String): MeshBvh? = byId[id]

    @Synchronized
    fun put(id: String, bvh: MeshBvh) {
        byId[id] = bvh
    }

    @Synchronized
    fun invalidate(id: String) {
        byId.remove(id)
    }

    @Synchronized
    fun clear() {
        byId.clear()
    }
}

/** Convert mesh-local Vector3 (Jetpack XR types) → Vec3f (our
 *  triangle-mesh frame). Trivial bridge so call sites don't have to
 *  re-import. */
internal fun Vector3.toVec3f(): Vec3f = Vec3f(x, y, z)
