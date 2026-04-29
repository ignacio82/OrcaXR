package dev.orcaxr.app

/**
 * Roadmap A6 — full mesh-vs-bed collision check.
 *
 * The legacy `computeBedFit` only compares the transformed mesh's
 * axis-aligned bbox extent against the bed dimensions. That misses two
 * real cases that landed once arbitrary X/Y rotation reached
 * TransformPanel:
 *
 *   1. The bbox extent fits but the mesh is positioned past the bed
 *      polygon (e.g. user-typed translateXmm = 200 mm on a 270 mm bed
 *      whose printable area is centered on origin → vertices at x≈225
 *      live well past the bed edge even though `(maxX − minX) ≤ bedXmm`).
 *
 *   2. After a non-axis-aligned X/Y rotation, the bbox grows (rotation
 *      always makes AABB ≥ rotated silhouette) so size-only checks now
 *      flag a model as "doesn't fit" when in fact most of the projected
 *      footprint is well inside the bed — the user's only off-bed parts
 *      are a few corner vertices that the bed-polygon check can pin
 *      down precisely.
 *
 * `detect` walks the transformed positions and returns the per-vertex /
 * per-triangle off-bed set. Pure Kotlin so the math can regression-test
 * without spinning up SceneCore.
 *
 * Z is intentionally NOT checked here. libslic3r auto-drops the model
 * to z=0 at slice time (the JNI's bed-drop pass), so any sub-bed Z is
 * compensated before G-code emission.
 */
object BedCollision {
    /** Result of a [detect] call against a single transformed mesh. */
    sealed interface Result {
        /** No vertex off-bed. */
        data object Ok : Result

        /** [offendingTriCount] triangles have at least one vertex past
         *  the printable polygon. The set is exact for highlighting in
         *  the preview GLB; size kept separate so the UI can show a
         *  "N of M tris off-bed" badge without iterating the set. */
        data class Off(
            val offendingTriCount: Int,
            val totalTriCount: Int,
            val offendingTriIndices: IntArray,
            /** True when the off-bed extends past `±bedXmm/2`. */
            val overflowX: Boolean,
            /** True when the off-bed extends past `±bedYmm/2`. */
            val overflowY: Boolean,
            /** Worst signed overflow on X, in mm (sign matches the
             *  vertex's relation to the bed center: negative = past
             *  the −X edge). 0 when [overflowX] is false. */
            val worstOverflowXmm: Float,
            val worstOverflowYmm: Float,
        ) : Result {
            override fun equals(other: Any?): Boolean {
                if (this === other) return true
                if (other !is Off) return false
                return offendingTriCount == other.offendingTriCount &&
                    totalTriCount == other.totalTriCount &&
                    offendingTriIndices.contentEquals(other.offendingTriIndices) &&
                    overflowX == other.overflowX &&
                    overflowY == other.overflowY &&
                    worstOverflowXmm == other.worstOverflowXmm &&
                    worstOverflowYmm == other.worstOverflowYmm
            }
            override fun hashCode(): Int {
                var r = offendingTriCount
                r = 31 * r + totalTriCount
                r = 31 * r + offendingTriIndices.contentHashCode()
                r = 31 * r + overflowX.hashCode()
                r = 31 * r + overflowY.hashCode()
                r = 31 * r + worstOverflowXmm.hashCode()
                r = 31 * r + worstOverflowYmm.hashCode()
                return r
            }
        }
    }

    /**
     * Walk [mesh]'s positions and report any triangle with a vertex
     * outside the printable polygon `[-bedXmm/2, bedXmm/2] × [-bedYmm/2, bedYmm/2]`.
     *
     * If [recenterToBed] is true (default) the mesh's XY bbox center is
     * subtracted before the polygon check. This matches the JNI's
     * "auto-center the group on the printable area" pre-slice pass,
     * which means a model's *absolute* XY translate is irrelevant for
     * the single-model case — only the rotated silhouette's extent
     * vs the bed matters. Pass false for multi-model scenes where the
     * caller already centered the *group* and wants to detect a
     * single model whose relative translate puts it past the bed
     * edge.
     */
    fun detect(
        mesh: StlMesh,
        bedXmm: Float,
        bedYmm: Float,
        recenterToBed: Boolean = true,
    ): Result {
        if (mesh.triCount == 0) return Result.Ok
        val halfX = bedXmm / 2f
        val halfY = bedYmm / 2f
        val (cx, cy) = if (recenterToBed) {
            ((mesh.bboxMin.x + mesh.bboxMax.x) / 2f) to ((mesh.bboxMin.y + mesh.bboxMax.y) / 2f)
        } else 0f to 0f

        // Quick reject: the recentered AABB sits entirely inside the
        // bed polygon. A FloatArray walk over a large mesh is cheap on
        // ART (~10 ns per vertex), but for the steady state where
        // nothing is off-bed we'd rather skip the offending-tri buffer
        // allocation entirely.
        val recMinX = mesh.bboxMin.x - cx
        val recMaxX = mesh.bboxMax.x - cx
        val recMinY = mesh.bboxMin.y - cy
        val recMaxY = mesh.bboxMax.y - cy
        if (recMinX >= -halfX && recMaxX <= halfX && recMinY >= -halfY && recMaxY <= halfY) {
            return Result.Ok
        }

        val offending = ArrayList<Int>()
        var overflowX = false
        var overflowY = false
        var worstX = 0f
        var worstY = 0f
        val pos = mesh.positions
        var triIdx = 0
        var i = 0
        while (i < pos.size) {
            // Each tri spans 9 floats (3 verts × xyz).
            var triHit = false
            for (v in 0 until 3) {
                val x = pos[i + v * 3] - cx
                val y = pos[i + v * 3 + 1] - cy
                // Signed worst-overflow: track the vertex whose
                // off-bed magnitude is largest, with sign preserved
                // so callers can distinguish "off the −X edge" from
                // "off the +X edge". Order-independent.
                if (x < -halfX) {
                    triHit = true; overflowX = true
                    val over = x + halfX  // negative
                    if (kotlin.math.abs(over) > kotlin.math.abs(worstX)) worstX = over
                } else if (x > halfX) {
                    triHit = true; overflowX = true
                    val over = x - halfX  // positive
                    if (kotlin.math.abs(over) > kotlin.math.abs(worstX)) worstX = over
                }
                if (y < -halfY) {
                    triHit = true; overflowY = true
                    val over = y + halfY
                    if (kotlin.math.abs(over) > kotlin.math.abs(worstY)) worstY = over
                } else if (y > halfY) {
                    triHit = true; overflowY = true
                    val over = y - halfY
                    if (kotlin.math.abs(over) > kotlin.math.abs(worstY)) worstY = over
                }
            }
            if (triHit) offending.add(triIdx)
            triIdx++
            i += 9
        }
        if (offending.isEmpty()) return Result.Ok
        return Result.Off(
            offendingTriCount = offending.size,
            totalTriCount = mesh.triCount,
            offendingTriIndices = offending.toIntArray(),
            overflowX = overflowX,
            overflowY = overflowY,
            worstOverflowXmm = worstX,
            worstOverflowYmm = worstY,
        )
    }
}
