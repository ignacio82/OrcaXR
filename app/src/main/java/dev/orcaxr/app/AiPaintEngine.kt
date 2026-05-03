package dev.orcaxr.app

import kotlin.math.cos
import kotlin.math.sqrt

/**
 * AI-driven paint pillar (C9 milestone 1). Pure-Kotlin spatial paint
 * primitives that compute a triangle index set from a 3D query
 * description (sphere / slab / normal-cone / surface-region /
 * connected-component / triangle-list). Every primitive eventually
 * compiles down to `WorkspaceAction.PaintTriangleSet` which routes
 * through `applyPaintMutation` so PaintHistory + paintCacheStore +
 * paintContentVersion stay correct (one MCP call ⇒ one undo step).
 *
 * Coordinate frame: every spatial input lives in **centered_preview_mm**
 * — the same frame the BVH is built in (see GEMINI.md gotcha #11d) and
 * the same frame the rendered GLB / `nativeWriteColoredGlb` uses, so
 * coordinates the LLM reads from a render line up with coordinates
 * passed back into a paint call.
 *
 * All primitives are stateless (every input is provided by the caller).
 * MeshBvh access is the caller's responsibility — the MCP tool layer
 * fetches it from `WorkspaceModel.getBvh(modelId)`.
 */
internal object AiPaintEngine {

    private const val EPS_COS = 1e-6f

    /**
     * Result of a primitive: the triangle indices that were matched
     * (post-merge filter) and the count before the [maxIndicesReturned]
     * cap. The MCP tool reports both so the LLM knows when its query
     * matched more than the API can return inline.
     */
    data class PrimitiveResult(
        val triangleIndices: IntArray,
        val matchedCount: Int,
        val truncated: Boolean,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is PrimitiveResult) return false
            return matchedCount == other.matchedCount
                && truncated == other.truncated
                && triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int =
            (matchedCount * 31 + truncated.hashCode()) * 31 +
                triangleIndices.contentHashCode()
    }

    /**
     * paint_sphere: triangles whose centroid is within [radiusMm] of
     * [center], with optional `back_face_filter` rejecting triangles
     * whose outward normal faces away from the sphere center (so the
     * inside walls of a hollow shell don't get painted by an exterior
     * brush).
     */
    fun sphere(
        bvh: MeshBvh,
        centerX: Float, centerY: Float, centerZ: Float,
        radiusMm: Float,
        backFaceFilter: Boolean = false,
    ): IntArray {
        if (bvh.triCount == 0 || radiusMm <= 0f) return IntArray(0)
        val r2 = radiusMm * radiusMm
        // Pre-filter via AABB descent.
        val candidates = bvh.aabbOverlapTriangles(
            centerX - radiusMm, centerY - radiusMm, centerZ - radiusMm,
            centerX + radiusMm, centerY + radiusMm, centerZ + radiusMm,
        )
        val out = ArrayList<Int>(candidates.size)
        for (ti in candidates) {
            val c = bvh.triangleCentroid(ti)
            val dx = c.x - centerX; val dy = c.y - centerY; val dz = c.z - centerZ
            if (dx * dx + dy * dy + dz * dz > r2) continue
            if (backFaceFilter) {
                val n = bvh.triangleNormal(ti)
                // The "outward direction relative to the sphere
                // center" is `centroid - center` (points from the
                // brush tip toward the painted surface). A triangle's
                // outward normal that points AWAY from the brush —
                // i.e. has positive dot with `centroid - center` —
                // belongs to the model's far side and shouldn't be
                // painted by an exterior brush. So reject when dot
                // is positive; keep front-facing (dot ≤ 0) only.
                val dot = n.x * dx + n.y * dy + n.z * dz
                if (dot > 0f) continue
            }
            out.add(ti)
        }
        return out.toIntArray()
    }

    /**
     * paint_slab: triangles whose centroid (or vertex, see [test])
     * lies between [minMm] and [maxMm] along the chosen axis. Plane
     * defaults are inclusive of both ends.
     */
    enum class Axis { X, Y, Z }
    enum class SlabTest {
        /** Centroid only (default — fastest, matches the brush stamp). */
        Centroid,
        /** Triangle accepted iff at least one vertex is in range. */
        AnyVertex,
        /** Triangle accepted iff all three vertices are in range. */
        AllVertices,
    }

    fun slab(
        bvh: MeshBvh,
        axis: Axis,
        minMm: Float, maxMm: Float,
        test: SlabTest = SlabTest.Centroid,
    ): IntArray {
        if (bvh.triCount == 0) return IntArray(0)
        val (lo, hi) = if (minMm <= maxMm) minMm to maxMm else maxMm to minMm
        val out = ArrayList<Int>(bvh.triCount / 4)
        when (test) {
            SlabTest.Centroid -> {
                for (i in 0 until bvh.triCount) {
                    val c = bvh.triangleCentroid(i)
                    val a = when (axis) { Axis.X -> c.x; Axis.Y -> c.y; Axis.Z -> c.z }
                    if (a in lo..hi) out.add(i)
                }
            }
            SlabTest.AnyVertex -> {
                for (i in 0 until bvh.triCount) {
                    if (vertexAxisInRange(bvh, i, axis, lo, hi, requireAll = false)) out.add(i)
                }
            }
            SlabTest.AllVertices -> {
                for (i in 0 until bvh.triCount) {
                    if (vertexAxisInRange(bvh, i, axis, lo, hi, requireAll = true)) out.add(i)
                }
            }
        }
        return out.toIntArray()
    }

    /**
     * paint_normal_cone: triangles whose outward normal makes an angle
     * ≤ [halfAngleDeg] with the supplied direction. [sign] = "outward"
     * accepts only triangles whose normal aligns with `direction`;
     * "inward" only triangles whose normal opposes it; "both" matches
     * either alignment within the cone.
     */
    enum class CooneSign { Outward, Inward, Both }

    fun normalCone(
        bvh: MeshBvh,
        dirX: Float, dirY: Float, dirZ: Float,
        halfAngleDeg: Float,
        sign: CooneSign = CooneSign.Outward,
    ): IntArray {
        if (bvh.triCount == 0) return IntArray(0)
        val len = sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ)
        if (len < 1e-7f) return IntArray(0)
        val nxRef = dirX / len; val nyRef = dirY / len; val nzRef = dirZ / len
        val theta = halfAngleDeg.coerceIn(0f, 90f)
        // `cos(π/2)` in IEEE float is ~6.12e-17 — the literal 90°
        // limit fails to accept perpendicular normals (dot=0) without
        // a tolerance. EPS_COS lets vertex-aligned cube faces match a
        // 90° wide cone without false positives outside the cone.
        val cosThreshold = cos(Math.toRadians(theta.toDouble())).toFloat() - EPS_COS
        val out = ArrayList<Int>(bvh.triCount / 8)
        for (i in 0 until bvh.triCount) {
            val n = bvh.triangleNormal(i)
            if (n.x == 0f && n.y == 0f && n.z == 0f) continue
            val dot = n.x * nxRef + n.y * nyRef + n.z * nzRef
            val match = when (sign) {
                CooneSign.Outward -> dot >= cosThreshold
                CooneSign.Inward -> dot <= -cosThreshold
                CooneSign.Both -> kotlin.math.abs(dot) >= cosThreshold
            }
            if (match) out.add(i)
        }
        return out.toIntArray()
    }

    /**
     * paint_surface_region: smart-fill from a seed using stepwise
     * dihedral-angle gating (delegates to MeshBvh.smartFillBfs).
     */
    fun surfaceRegion(
        bvh: MeshBvh,
        seedTri: Int,
        maxDihedralDeg: Float,
        maxTriangles: Int = 65_536,
    ): IntArray = bvh.smartFillBfs(seedTri, maxDihedralDeg, maxTriangles)

    /**
     * paint_geodesic_disc (D18a): Dijkstra-style surface walk from
     * a seed, bounded by geodesic distance + per-step dihedral
     * gate. Returns a connected disc that wraps around bulges
     * (Pikachu cheek bumps, eye sockets, etc.) — the gap that
     * paint_projected_mask + back_face_filter leaves open because
     * 2D rays can only hit the front-most patch of a bulge.
     */
    fun geodesicDisc(
        bvh: MeshBvh,
        seedTri: Int,
        radiusMm: Float,
        maxDihedralDeg: Float = 60f,
        maxTriangles: Int = 65_536,
    ): IntArray = bvh.geodesicDisc(seedTri, radiusMm, maxDihedralDeg, maxTriangles)

    /**
     * paint_connected_component: vertex-adjacency BFS from a seed
     * (no angle gate — paints the whole connected sub-mesh).
     */
    fun connectedComponent(
        bvh: MeshBvh,
        seedTri: Int,
        maxTriangles: Int = 1_500_000,
    ): IntArray = bvh.connectedComponent(seedTri, maxTriangles)

    /**
     * paint_triangle_list: pass-through with bounds + dedupe. The
     * caller-supplied indices may be unsorted / contain duplicates;
     * we filter to in-range, dedupe, and sort. Out-of-range indices
     * are silently dropped (the MCP tool surfaces a count of dropped
     * ids in the response).
     *
     * Returns sorted/deduped indices and the count of dropped (out of
     * range) entries.
     */
    data class TriangleListResult(val indices: IntArray, val droppedOutOfRange: Int)

    fun triangleList(triCount: Int, ids: IntArray): TriangleListResult {
        if (triCount <= 0 || ids.isEmpty()) return TriangleListResult(IntArray(0), ids.size)
        var dropped = 0
        val seen = HashSet<Int>(ids.size)
        for (id in ids) {
            if (id < 0 || id >= triCount) {
                dropped++
            } else {
                seen.add(id)
            }
        }
        val arr = seen.toIntArray()
        java.util.Arrays.sort(arr)
        return TriangleListResult(arr, dropped)
    }

    // ---- internal helpers ----

    private fun vertexAxisInRange(
        bvh: MeshBvh, tri: Int, axis: Axis, lo: Float, hi: Float, requireAll: Boolean,
    ): Boolean {
        var anyIn = false
        var allIn = true
        for (v in 0 until 3) {
            val p = bvh.triangleVertex(tri, v)
            val a = when (axis) { Axis.X -> p.x; Axis.Y -> p.y; Axis.Z -> p.z }
            val inRange = a in lo..hi
            anyIn = anyIn || inRange
            allIn = allIn && inRange
        }
        return if (requireAll) allIn else anyIn
    }
}
