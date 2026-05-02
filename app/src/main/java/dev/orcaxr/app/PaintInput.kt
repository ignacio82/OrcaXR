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
     *   - source is `UNKNOWN` (no actionable origin — gotcha #11:
     *     a `Source.CONTROLLER`-only filter swallowed every Galaxy XR
     *     hand-pinch event because the device has no controller; HANDS
     *     and GAZE_AND_GESTURE are the actual sources we get there)
     *   - action is HOVER_* (we don't paint on hover)
     *   - the ray misses every triangle in the mesh
     */
    /** Reset on UP so the next stroke starts a fresh diagnostic dump. */
    private var diagLoggedThisStroke: Boolean = false

    /**
     * @param originOverride if non-null, replaces `event.origin` for the
     *   purposes of BVH raycasting. Used by the IC listener site to
     *   pre-subtract the entity's world position when that's needed to
     *   align with `hit.transform` (gotcha #11i — see comment in
     *   [locateTriangle]).
     */
    fun handle(event: InputEvent, originOverride: androidx.xr.runtime.math.Vector3? = null) {
        if (brush.mode == PaintMode.Off) {
            android.util.Log.i(LOG_TAG, "handle: drop — paint mode is Off")
            return
        }
        if (event.source == InputEvent.Source.UNKNOWN) {
            android.util.Log.i(LOG_TAG, "handle: drop — source=UNKNOWN action=${event.action}")
            return
        }
        // One-shot per stroke: the FIRST DOWN/MOVE event dumps the
        // world ray, the SDK-reported entity transform, the resolved
        // mesh-mm ray, and the BVH bbox in a single Log line. Lets us
        // see at a glance whether the ray ever enters the bbox; if not,
        // gotcha #11c-style transform corrections still need work.
        if (!diagLoggedThisStroke && (event.action == Action.DOWN || event.action == Action.MOVE)) {
            val hit = event.hitInfoList.firstOrNull()
            if (hit != null) {
                val effectiveOrigin = originOverride ?: event.origin
                val (mO, mD) = worldRayToMeshMm(effectiveOrigin, event.direction, hit.transform)
                val s = hit.transform.scale
                val pT = hit.transform.pose.translation
                val pR = hit.transform.pose.rotation
                android.util.Log.i(
                    LOG_TAG,
                    "diag stroke: action=${event.action} " +
                        "worldOrigin=(${event.origin.x},${event.origin.y},${event.origin.z}) " +
                        "effOrigin=(${effectiveOrigin.x},${effectiveOrigin.y},${effectiveOrigin.z}) " +
                        "worldDir=(${event.direction.x},${event.direction.y},${event.direction.z}) " +
                        "tf.scale=(${s.x},${s.y},${s.z}) " +
                        "tf.poseT=(${pT.x},${pT.y},${pT.z}) " +
                        "tf.poseR=(${pR.x},${pR.y},${pR.z},${pR.w}) " +
                        "meshOrigin=(${mO.x},${mO.y},${mO.z}) " +
                        "meshDir=(${mD.x},${mD.y},${mD.z}) " +
                        "bvhBbox=(${bvh.bboxMin.x}..${bvh.bboxMax.x}, " +
                        "${bvh.bboxMin.y}..${bvh.bboxMax.y}, " +
                        "${bvh.bboxMin.z}..${bvh.bboxMax.z})",
                )
            } else {
                android.util.Log.i(LOG_TAG, "diag stroke: action=${event.action} no hitInfo")
            }
            diagLoggedThisStroke = true
        }
        if (event.action == Action.UP) diagLoggedThisStroke = false
        when (event.action) {
            Action.DOWN, Action.MOVE -> { /* paint */ }
            // Paint full-feature-parity (Undo/Redo) — UP closes the
            // current stroke. Forward to onPaint with a sentinel
            // hitTri = -1 so the dispatcher can finalize history
            // without requiring a successful raycast (the user may
            // release while pointing off the mesh).
            Action.UP -> {
                android.util.Log.i(LOG_TAG, "handle: UP src=${event.source} → close stroke")
                onPaint(-1, Action.UP)
                return
            }
            else -> return
        }
        val hitTri = locateTriangle(event, originOverride)
        if (hitTri == null) {
            android.util.Log.i(
                LOG_TAG,
                "handle: ray miss src=${event.source} action=${event.action} " +
                    "ptr=${event.pointerType} mode=${brush.mode} slot=${brush.activeSlot}",
            )
            return
        }
        android.util.Log.i(
            LOG_TAG,
            "handle: HIT tri=$hitTri src=${event.source} action=${event.action} " +
                "ptr=${event.pointerType} mode=${brush.mode} slot=${brush.activeSlot}",
        )
        onPaint(hitTri, event.action)
    }

    /**
     * Map a world-space ray onto a mesh-local triangle index. Public
     * so tests can drive the math without faking an Activity-scoped
     * InputEvent listener.
     */
    fun locateTriangle(event: InputEvent, originOverride: androidx.xr.runtime.math.Vector3? = null): Int? {
        // Need a HitInfo to know the entity's world transform. The
        // SDK populates hitInfoList for any InteractableComponent
        // event that intersects the entity (or its bounding region).
        val hit = event.hitInfoList.firstOrNull() ?: return null
        return locateTriangleByRay(originOverride ?: event.origin, event.direction, hit.transform)
    }

    /**
     * Test-friendly entry point: locate the front-most triangle hit by
     * the world-space ray (origin + direction) under the given
     * world→mesh-mm matrix [transform]. Bypasses the SDK's InputEvent
     * so JVM unit tests can drive the math without device hardware.
     *
     * `hit.transform` on alpha13 is the FORWARD world→mesh-mm matrix:
     * `M·p = T_pose + R · (S·p)` where
     *   - `S` is the mesh-mm-per-world-meter scale (≈ 1 / WORLD_SCALE
     *     = 666.67 for entities authored at WORLD_SCALE = 0.0015),
     *   - `R` is the inverse of WORKSPACE_ROTATION (+90° around X
     *     given the workspace's -90° X authoring rotation),
     *   - `T_pose` is the entity origin's location IN MESH-MM (i.e.
     *     the SDK pre-multiplies the world translation by `S`).
     *
     * Matrix4 has no `transformPoint`, so we apply it manually:
     *   meshPoint = pose.transformPoint(p ⊙ scale)
     * i.e. component-wise pre-scale, then rotate-and-translate via the
     * Pose. (`transformVector` is the rotation-only counterpart used
     * for direction vectors.)
     *
     * This replaced an earlier `pose.inverse.transformPoint` form that
     * assumed the SDK reported a pose-only matrix with scale = 0.0015.
     * Symptoms (2026-05-02): every raycast missed because `localOrigin`
     * collapsed to sub-millimeter values for a 60 mm mesh, then later
     * the pose translation alone (interpreted as world meters) shifted
     * Y by ~65 m phantom. Empirical DOWN frame dump proved
     * `transform.scale ≈ 666.67` AND `transform.pose.translation` is in
     * mesh-mm, not meters. See unit tests in `PaintInputMathTest` for
     * the canonical reference rays.
     */
    fun locateTriangleByRay(
        worldOrigin: androidx.xr.runtime.math.Vector3,
        worldDirection: androidx.xr.runtime.math.Vector3,
        transform: androidx.xr.runtime.math.Matrix4,
    ): Int? {
        val (originLocal, dirLocal) = worldRayToMeshMm(worldOrigin, worldDirection, transform)
        return bvh.intersect(origin = originLocal, direction = dirLocal)
    }

    companion object {
        private const val LOG_TAG = "OrcaXR/paint"

        /**
         * Pure-function math used by [locateTriangleByRay]. Exposed
         * for unit tests to verify the world→mesh-mm transform
         * independently of the BVH intersect step.
         *
         * Returns `(meshOrigin, meshDirection)` in printer-mm.
         */
        fun worldRayToMeshMm(
            worldOrigin: androidx.xr.runtime.math.Vector3,
            worldDirection: androidx.xr.runtime.math.Vector3,
            transform: androidx.xr.runtime.math.Matrix4,
        ): Pair<Vec3f, Vec3f> {
            val s = transform.scale
            val scaledOrigin = androidx.xr.runtime.math.Vector3(
                worldOrigin.x * s.x,
                worldOrigin.y * s.y,
                worldOrigin.z * s.z,
            )
            val meshOrigin = transform.pose.transformPoint(scaledOrigin)
            val scaledDir = androidx.xr.runtime.math.Vector3(
                worldDirection.x * s.x,
                worldDirection.y * s.y,
                worldDirection.z * s.z,
            )
            val rotatedDir = transform.pose.transformVector(scaledDir)
            return Vec3f(meshOrigin.x, meshOrigin.y, meshOrigin.z) to
                Vec3f(rotatedDir.x, rotatedDir.y, rotatedDir.z)
        }
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
