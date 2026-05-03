package dev.orcaxr.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sqrt

/**
 * AI-driven paint pillar (C9 milestone 3) — geometry + topology
 * introspection. Pure Kotlin, runs against a [MeshBvh] (which carries
 * the centered_preview-frame mesh). Tools that the LLM uses to
 * understand a model BEFORE painting it: bbox, surface area, volume,
 * watertight check, per-axis Z histogram, connected components, face-
 * orientation buckets, region-growing semantic clusters.
 *
 * No JNI. Region-growing here is in pure Kotlin — slower than a
 * vendored C++ implementation on dragon-class meshes (~1.4 M tris)
 * but fast enough on Benchy-class (~40 K tris) which is the typical
 * AI-paint use case. Native acceleration is a follow-up if a slow
 * report shows up in profiling.
 */
internal object AiIntrospection {

    // ---- Geometry ----

    data class Bbox(
        val minX: Float, val minY: Float, val minZ: Float,
        val maxX: Float, val maxY: Float, val maxZ: Float,
    ) {
        val sizeX: Float get() = maxX - minX
        val sizeY: Float get() = maxY - minY
        val sizeZ: Float get() = maxZ - minZ
        val centerX: Float get() = (minX + maxX) * 0.5f
        val centerY: Float get() = (minY + maxY) * 0.5f
        val centerZ: Float get() = (minZ + maxZ) * 0.5f
        val diagonal: Float get() {
            val dx = sizeX; val dy = sizeY; val dz = sizeZ
            return sqrt(dx * dx + dy * dy + dz * dz)
        }
    }

    data class GeometrySummary(
        val totalTriangleCount: Int,
        val bboxCenteredPreview: Bbox,
        val surfaceAreaMm2: Float,
        val volumeMm3: Float,
        val centroidCenteredPreview: FloatArray,
        val zHistogram: List<ZBucket>,
        val openEdgeCount: Int,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is GeometrySummary) return false
            return totalTriangleCount == other.totalTriangleCount
                && bboxCenteredPreview == other.bboxCenteredPreview
                && surfaceAreaMm2 == other.surfaceAreaMm2
                && volumeMm3 == other.volumeMm3
                && centroidCenteredPreview.contentEquals(other.centroidCenteredPreview)
                && zHistogram == other.zHistogram
                && openEdgeCount == other.openEdgeCount
        }
        override fun hashCode(): Int = totalTriangleCount * 31 + bboxCenteredPreview.hashCode()
    }

    data class ZBucket(val zMin: Float, val zMax: Float, val areaMm2: Float, val triangleCount: Int)

    /**
     * Compute the geometry summary for a [bvh]. Surface area is the
     * sum of triangle areas; volume uses the divergence-theorem trick
     * (Σ dot(v0, cross(v1, v2)) / 6 over all triangles). [bins] is
     * the number of Z-slabs in the per-axis histogram.
     */
    fun geometry(
        bvh: MeshBvh,
        bins: Int = 32,
        openEdgeCount: Int = 0,
    ): GeometrySummary {
        val n = bvh.triCount
        if (n == 0) {
            val zero = Bbox(0f, 0f, 0f, 0f, 0f, 0f)
            return GeometrySummary(
                totalTriangleCount = 0,
                bboxCenteredPreview = zero,
                surfaceAreaMm2 = 0f,
                volumeMm3 = 0f,
                centroidCenteredPreview = floatArrayOf(0f, 0f, 0f),
                zHistogram = emptyList(),
                openEdgeCount = openEdgeCount,
            )
        }
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var areaTotal = 0.0
        var volTotal = 0.0
        var cx = 0.0; var cy = 0.0; var cz = 0.0
        for (i in 0 until n) {
            val v0 = bvh.triangleVertex(i, 0)
            val v1 = bvh.triangleVertex(i, 1)
            val v2 = bvh.triangleVertex(i, 2)
            for (v in arrayOf(v0, v1, v2)) {
                if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z
                if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z
            }
            // Surface area = 0.5 * |cross(e1, e2)|.
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val nxv = e1y * e2z - e1z * e2y
            val nyv = e1z * e2x - e1x * e2z
            val nzv = e1x * e2y - e1y * e2x
            val triArea = 0.5 * sqrt(nxv.toDouble() * nxv + nyv.toDouble() * nyv + nzv.toDouble() * nzv)
            areaTotal += triArea
            // Centroid contribution.
            val tcx = (v0.x + v1.x + v2.x) / 3f
            val tcy = (v0.y + v1.y + v2.y) / 3f
            val tcz = (v0.z + v1.z + v2.z) / 3f
            cx += tcx * triArea; cy += tcy * triArea; cz += tcz * triArea
            // Volume contribution: dot(v0, cross(v1, v2)) / 6
            val crossX = v1.y * v2.z - v1.z * v2.y
            val crossY = v1.z * v2.x - v1.x * v2.z
            val crossZ = v1.x * v2.y - v1.y * v2.x
            volTotal += (v0.x * crossX + v0.y * crossY + v0.z * crossZ) / 6.0
        }
        val centroid = if (areaTotal > 0) {
            floatArrayOf((cx / areaTotal).toFloat(), (cy / areaTotal).toFloat(), (cz / areaTotal).toFloat())
        } else floatArrayOf(0f, 0f, 0f)

        // Per-Z histogram. Each triangle contributes its area to the
        // bucket containing its Z-centroid.
        val safeBins = bins.coerceAtLeast(1)
        val histArea = DoubleArray(safeBins)
        val histCount = IntArray(safeBins)
        val zRange = maxZ - minZ
        if (zRange > 0f) {
            for (i in 0 until n) {
                val v0 = bvh.triangleVertex(i, 0)
                val v1 = bvh.triangleVertex(i, 1)
                val v2 = bvh.triangleVertex(i, 2)
                val zc = (v0.z + v1.z + v2.z) / 3f
                val bin = (((zc - minZ) / zRange) * safeBins).toInt().coerceIn(0, safeBins - 1)
                val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
                val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
                val nxv = e1y * e2z - e1z * e2y
                val nyv = e1z * e2x - e1x * e2z
                val nzv = e1x * e2y - e1y * e2x
                val triArea = 0.5 * sqrt(nxv.toDouble() * nxv + nyv.toDouble() * nyv + nzv.toDouble() * nzv)
                histArea[bin] += triArea
                histCount[bin]++
            }
        }
        val histogram = ArrayList<ZBucket>(safeBins)
        for (b in 0 until safeBins) {
            val zLo = minZ + zRange * b / safeBins
            val zHi = minZ + zRange * (b + 1) / safeBins
            histogram.add(ZBucket(zLo, zHi, histArea[b].toFloat(), histCount[b]))
        }
        return GeometrySummary(
            totalTriangleCount = n,
            bboxCenteredPreview = Bbox(minX, minY, minZ, maxX, maxY, maxZ),
            surfaceAreaMm2 = areaTotal.toFloat(),
            // Absolute value because winding might be inverted; physical
            // volume is signed-volume's magnitude.
            volumeMm3 = abs(volTotal).toFloat(),
            centroidCenteredPreview = centroid,
            zHistogram = histogram,
            openEdgeCount = openEdgeCount,
        )
    }

    // ---- Connected components ----

    data class Component(
        val componentId: Int,
        val triangleIndices: IntArray,
        val bbox: Bbox,
        val centroid: FloatArray,
        val surfaceAreaMm2: Float,
        val volumeMm3: Float,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Component) return false
            return componentId == other.componentId
                && triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int = componentId * 31 + triangleIndices.contentHashCode()
    }

    /**
     * Partition the mesh into connected components via vertex
     * adjacency (no angle gate). Each triangle gets exactly one
     * component_id; output is a list of components sorted by
     * decreasing triangle count (so component 0 is always the
     * largest).
     */
    fun components(bvh: MeshBvh): List<Component> {
        val n = bvh.triCount
        if (n == 0) return emptyList()
        val assigned = IntArray(n) { -1 }
        val out = ArrayList<Component>()
        var nextId = 0
        
        val regionBuf = IntArray(n)
        val queue = IntArray(n)

        for (i in 0 until n) {
            if (assigned[i] != -1) continue

            var regionSize = 0
            var qHead = 0
            var qTail = 0

            queue[qTail++] = i
            assigned[i] = nextId

            while (qHead < qTail) {
                val cur = queue[qHead++]
                regionBuf[regionSize++] = cur

                for (nbr in neighborsOf(bvh, cur)) {
                    if (assigned[nbr] != -1) continue
                    assigned[nbr] = nextId
                    queue[qTail++] = nbr
                }
            }
            val members = regionBuf.copyOf(regionSize)

            // Compute bbox + centroid + area + volume for this set.
            var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
            var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
            var areaTotal = 0.0
            var volTotal = 0.0
            var cx = 0.0; var cy = 0.0; var cz = 0.0
            for (t in members) {
                assigned[t] = nextId
                val v0 = bvh.triangleVertex(t, 0)
                val v1 = bvh.triangleVertex(t, 1)
                val v2 = bvh.triangleVertex(t, 2)
                for (v in arrayOf(v0, v1, v2)) {
                    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z
                    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z
                }
                val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
                val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
                val nxv = e1y * e2z - e1z * e2y
                val nyv = e1z * e2x - e1x * e2z
                val nzv = e1x * e2y - e1y * e2x
                val triArea = 0.5 * sqrt(nxv.toDouble() * nxv + nyv.toDouble() * nyv + nzv.toDouble() * nzv)
                areaTotal += triArea
                val tcx = (v0.x + v1.x + v2.x) / 3f
                val tcy = (v0.y + v1.y + v2.y) / 3f
                val tcz = (v0.z + v1.z + v2.z) / 3f
                cx += tcx * triArea; cy += tcy * triArea; cz += tcz * triArea
                val crossX = v1.y * v2.z - v1.z * v2.y
                val crossY = v1.z * v2.x - v1.x * v2.z
                val crossZ = v1.x * v2.y - v1.y * v2.x
                volTotal += (v0.x * crossX + v0.y * crossY + v0.z * crossZ) / 6.0
            }
            val centroid = if (areaTotal > 0) floatArrayOf(
                (cx / areaTotal).toFloat(),
                (cy / areaTotal).toFloat(),
                (cz / areaTotal).toFloat(),
            ) else floatArrayOf(0f, 0f, 0f)
            out.add(Component(
                componentId = nextId,
                triangleIndices = members,
                bbox = Bbox(minX, minY, minZ, maxX, maxY, maxZ),
                centroid = centroid,
                surfaceAreaMm2 = areaTotal.toFloat(),
                volumeMm3 = abs(volTotal).toFloat(),
            ))
            nextId++
        }
        return out.sortedByDescending { it.triangleIndices.size }
            .mapIndexed { newIdx, c -> c.copy(componentId = newIdx) }
    }

    // ---- Face-orientation buckets ----

    data class OrientationBucket(
        val name: String,
        val normalX: Float, val normalY: Float, val normalZ: Float,
        val coneHalfAngleDeg: Float,
        val triangleCount: Int,
        val areaMm2: Float,
    )

    /**
     * Bucket every triangle into one of: "up" (+Z), "down" (-Z),
     * "front" (-Y), "back" (+Y), "left" (-X), "right" (+X), "diagonal"
     * (everything else). Each cardinal bucket is a 30°-half-angle
     * cone.
     */
    fun faceOrientationSummary(bvh: MeshBvh): List<OrientationBucket> {
        val n = bvh.triCount
        val cardinals = listOf(
            Triple("up", floatArrayOf(0f, 0f, 1f), 30f),
            Triple("down", floatArrayOf(0f, 0f, -1f), 30f),
            Triple("front", floatArrayOf(0f, -1f, 0f), 30f),
            Triple("back", floatArrayOf(0f, 1f, 0f), 30f),
            Triple("left", floatArrayOf(-1f, 0f, 0f), 30f),
            Triple("right", floatArrayOf(1f, 0f, 0f), 30f),
        )
        val counts = IntArray(cardinals.size + 1)  // +1 for diagonal
        val areas = DoubleArray(cardinals.size + 1)
        val cosThresholds = FloatArray(cardinals.size) {
            (cos(Math.toRadians(cardinals[it].third.toDouble())).toFloat() - 1e-6f)
        }
        for (i in 0 until n) {
            val nrm = bvh.triangleNormal(i)
            if (nrm.x == 0f && nrm.y == 0f && nrm.z == 0f) continue
            // Triangle area
            val v0 = bvh.triangleVertex(i, 0)
            val v1 = bvh.triangleVertex(i, 1)
            val v2 = bvh.triangleVertex(i, 2)
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val cnx = e1y * e2z - e1z * e2y
            val cny = e1z * e2x - e1x * e2z
            val cnz = e1x * e2y - e1y * e2x
            val triArea = 0.5 * sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)

            // Find best matching cardinal (highest dot product within
            // its cone).
            var bestIdx = -1
            var bestDot = -2f
            for ((idx, card) in cardinals.withIndex()) {
                val (_, refN, _) = card
                val dot = nrm.x * refN[0] + nrm.y * refN[1] + nrm.z * refN[2]
                if (dot >= cosThresholds[idx] && dot > bestDot) {
                    bestDot = dot
                    bestIdx = idx
                }
            }
            val target = if (bestIdx >= 0) bestIdx else cardinals.size  // diagonal
            counts[target]++
            areas[target] += triArea
        }
        val out = ArrayList<OrientationBucket>()
        for ((idx, c) in cardinals.withIndex()) {
            val (name, refN, halfAngle) = c
            out.add(OrientationBucket(name, refN[0], refN[1], refN[2], halfAngle, counts[idx], areas[idx].toFloat()))
        }
        out.add(OrientationBucket(
            "diagonal", 0f, 0f, 0f, 0f, counts[cardinals.size], areas[cardinals.size].toFloat(),
        ))
        return out
    }

    // ---- Semantic regions ----

    data class SemanticRegion(
        val regionId: Int,
        val label: String,
        val triangleIndices: IntArray,
        val bbox: Bbox,
        val centroid: FloatArray,
        val meanNormal: FloatArray,
        val areaMm2: Float,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is SemanticRegion) return false
            return regionId == other.regionId && triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int = regionId * 31 + triangleIndices.contentHashCode()
    }

    /**
     * Region-grow segmentation. For each unassigned triangle (sorted
     * by descending area, ties by ascending tri_id for determinism),
     * BFS outward via vertex adjacency, accepting neighbors whose
     * normal is within [normalToleranceDeg] of the seed's mean normal
     * AND whose centroid is within [distanceCapMm] of the seed
     * centroid.
     *
     * Result is sorted by descending area; tiny clusters below
     * [minRegionAreaPct]% of total area are folded into a single
     * "trim_*" residual region (or dropped).
     *
     * Heuristic label = `<orientation>_<size>` ("vertical_side_large",
     * "horizontal_top_medium", "diagonal_small", etc.) computed from
     * the region's mean normal + size relative to the model bbox.
     */
    fun semanticRegions(
        bvh: MeshBvh,
        maxRegions: Int = 12,
        normalToleranceDeg: Float = 35f,
        distanceCapFraction: Float = 0.3f,  // fraction of bbox diagonal
        minRegionAreaPct: Float = 1.5f,
    ): List<SemanticRegion> {
        val n = bvh.triCount
        if (n == 0) return emptyList()
        val geom = geometry(bvh, bins = 1)
        val totalArea = geom.surfaceAreaMm2
        val distanceCap = geom.bboxCenteredPreview.diagonal * distanceCapFraction
        val cosTolerance = cos(Math.toRadians(normalToleranceDeg.toDouble())).toFloat() - 1e-6f

        // Pre-compute per-triangle area + normal (cached so the seed
        // sort and the BFS both have access).
        val areas = FloatArray(n)
        val normals = FloatArray(n * 3)
        for (i in 0 until n) {
            val v0 = bvh.triangleVertex(i, 0)
            val v1 = bvh.triangleVertex(i, 1)
            val v2 = bvh.triangleVertex(i, 2)
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val cnx = e1y * e2z - e1z * e2y
            val cny = e1z * e2x - e1x * e2z
            val cnz = e1x * e2y - e1y * e2x
            val len = sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)
            areas[i] = (0.5 * len).toFloat()
            if (len > 0) {
                normals[i * 3] = (cnx / len).toFloat()
                normals[i * 3 + 1] = (cny / len).toFloat()
                normals[i * 3 + 2] = (cnz / len).toFloat()
            }
        }

        // Pack area and reversed tri_id into a Long to sort primitives without boxing.
        // float-bits are monotonic for positive floats.
        val sortKeys = LongArray(n)
        for (i in 0 until n) {
            val areaBits = areas[i].toRawBits().toLong()
            // Invert the tri_id so that sorting ascending by key gives descending tri_id in the lower bits,
            // which when we iterate backwards gives ascending tri_id for ties.
            val invId = (0xFFFFFFFFL - i.toLong()) and 0xFFFFFFFFL
            sortKeys[i] = (areaBits shl 32) or invId
        }
        sortKeys.sort()

        val assigned = IntArray(n) { -1 }
        val rawRegions = ArrayList<SemanticRegion>()
        var nextId = 0

        // Flat buffers for the BFS to avoid boxing overhead.
        val regionBuf = IntArray(n)
        val queue = IntArray(n)

        // Iterate backwards for descending area
        for (k in n - 1 downTo 0) {
            val key = sortKeys[k]
            val invId = (key and 0xFFFFFFFFL).toInt()
            val seed = 0.inv() - invId

            if (assigned[seed] != -1) continue
            val seedNormal = floatArrayOf(
                normals[seed * 3], normals[seed * 3 + 1], normals[seed * 3 + 2],
            )
            val seedV0 = bvh.triangleVertex(seed, 0)
            val seedV1 = bvh.triangleVertex(seed, 1)
            val seedV2 = bvh.triangleVertex(seed, 2)
            val seedCx = (seedV0.x + seedV1.x + seedV2.x) / 3f
            val seedCy = (seedV0.y + seedV1.y + seedV2.y) / 3f
            val seedCz = (seedV0.z + seedV1.z + seedV2.z) / 3f

            var regionSize = 0
            var qHead = 0
            var qTail = 0

            queue[qTail++] = seed
            assigned[seed] = nextId

            while (qHead < qTail) {
                val cur = queue[qHead++]
                regionBuf[regionSize++] = cur

                for (nbr in neighborsOf(bvh, cur)) {
                    if (assigned[nbr] != -1) continue
                    val nx = normals[nbr * 3]; val ny = normals[nbr * 3 + 1]; val nz = normals[nbr * 3 + 2]
                    val dot = seedNormal[0] * nx + seedNormal[1] * ny + seedNormal[2] * nz
                    if (dot < cosTolerance) continue
                    val nv0 = bvh.triangleVertex(nbr, 0)
                    val nv1 = bvh.triangleVertex(nbr, 1)
                    val nv2 = bvh.triangleVertex(nbr, 2)
                    val ncx = (nv0.x + nv1.x + nv2.x) / 3f
                    val ncy = (nv0.y + nv1.y + nv2.y) / 3f
                    val ncz = (nv0.z + nv1.z + nv2.z) / 3f
                    val dxs = ncx - seedCx; val dys = ncy - seedCy; val dzs = ncz - seedCz
                    if (dxs * dxs + dys * dys + dzs * dzs > distanceCap * distanceCap) continue
                    assigned[nbr] = nextId
                    queue[qTail++] = nbr
                }
            }
            val members = regionBuf.copyOf(regionSize)
            // Compute region stats.
            var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
            var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
            var aTotal = 0.0
            var ncxAcc = 0.0; var ncyAcc = 0.0; var nczAcc = 0.0
            var rcxAcc = 0.0; var rcyAcc = 0.0; var rczAcc = 0.0
            for (t in members) {
                val v0 = bvh.triangleVertex(t, 0)
                val v1 = bvh.triangleVertex(t, 1)
                val v2 = bvh.triangleVertex(t, 2)
                for (v in arrayOf(v0, v1, v2)) {
                    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z
                    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z
                }
                val a = areas[t]
                aTotal += a
                ncxAcc += normals[t * 3] * a
                ncyAcc += normals[t * 3 + 1] * a
                nczAcc += normals[t * 3 + 2] * a
                val tcx = (v0.x + v1.x + v2.x) / 3f
                val tcy = (v0.y + v1.y + v2.y) / 3f
                val tcz = (v0.z + v1.z + v2.z) / 3f
                rcxAcc += tcx * a; rcyAcc += tcy * a; rczAcc += tcz * a
            }
            val meanNormal = if (aTotal > 0) {
                val nLen = sqrt(ncxAcc * ncxAcc + ncyAcc * ncyAcc + nczAcc * nczAcc)
                if (nLen > 0) floatArrayOf(
                    (ncxAcc / nLen).toFloat(),
                    (ncyAcc / nLen).toFloat(),
                    (nczAcc / nLen).toFloat(),
                ) else floatArrayOf(0f, 0f, 0f)
            } else floatArrayOf(0f, 0f, 0f)
            val centroid = if (aTotal > 0) floatArrayOf(
                (rcxAcc / aTotal).toFloat(),
                (rcyAcc / aTotal).toFloat(),
                (rczAcc / aTotal).toFloat(),
            ) else floatArrayOf(0f, 0f, 0f)
            rawRegions.add(SemanticRegion(
                regionId = nextId,
                label = "",  // populated after sorting/sizing below
                triangleIndices = members,
                bbox = Bbox(minX, minY, minZ, maxX, maxY, maxZ),
                centroid = centroid,
                meanNormal = meanNormal,
                areaMm2 = aTotal.toFloat(),
            ))
            nextId++
        }
        // Sort by area desc, drop tiny ones.
        val areaCutoff = totalArea * minRegionAreaPct / 100f
        val kept = rawRegions
            .filter { it.areaMm2 >= areaCutoff }
            .sortedByDescending { it.areaMm2 }
            .take(maxRegions)
        // Re-id + label.
        val sizeBigCutoff = (kept.maxOfOrNull { it.areaMm2 } ?: 0f) * 0.6f
        val sizeMedCutoff = (kept.maxOfOrNull { it.areaMm2 } ?: 0f) * 0.25f
        return kept.mapIndexed { idx, r ->
            val orientation = orientationLabel(r.meanNormal)
            val size = when {
                r.areaMm2 >= sizeBigCutoff -> "large"
                r.areaMm2 >= sizeMedCutoff -> "medium"
                else -> "small"
            }
            r.copy(regionId = idx, label = "${orientation}_${size}")
        }
    }

    private fun orientationLabel(n: FloatArray): String {
        if (n[0] == 0f && n[1] == 0f && n[2] == 0f) return "diagonal"
        val ax = abs(n[0]); val ay = abs(n[1]); val az = abs(n[2])
        // 30° cone tolerance: cos(30°) ≈ 0.866.
        val flatThreshold = 0.866f
        return when {
            n[2] >= flatThreshold -> "horizontal_top"
            n[2] <= -flatThreshold -> "horizontal_bottom"
            az < 0.5f && (ax >= flatThreshold || ay >= flatThreshold) -> "vertical_side"
            else -> "diagonal"
        }
    }

    /** Cached neighbor lookup. The MeshBvh exposes adjacency via
     *  smartFillBfs / connectedComponent but doesn't surface the raw
     *  neighbor list. We approximate by calling smartFillBfs with a
     *  tight cap (8 — neighbors only). To get only DIRECT neighbors
     *  we'd want a true `neighbors(tri)` accessor; we add it inline
     *  below by stamping a private extension. */
    private fun neighborsOf(bvh: MeshBvh, tri: Int): IntArray =
        bvh.directNeighbors(tri)

    // ---- Multi-scale curvature segmentation (D19b) ----

    data class CurvatureSegment(
        val segmentId: Int,
        val triangleIndices: IntArray,
        val bbox: Bbox,
        val centroid: FloatArray,
        val meanNormal: FloatArray,
        val areaMm2: Float,
        /** Mean per-triangle curvature score (dihedral-sum across the
         *  k-ring) for triangles in this segment. Low = flat /
         *  feature-interior; high = creased. */
        val meanCurvatureScore: Float,
        /** Heuristic label combining orientation + size + curvature
         *  level ("smooth_top_large", "creased_diagonal_small", ...). */
        val label: String,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is CurvatureSegment) return false
            return segmentId == other.segmentId && triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int = segmentId * 31 + triangleIndices.contentHashCode()
    }

    /**
     * Per-triangle "curvature score" = average per-edge dihedral angle
     * (in degrees) over a k-ring of shared-vertex neighbors. Multi-
     * scale: the returned score is `max(score@k=1, score@k=2)` so
     * features with sharp boundaries at one scale but smooth at the
     * other (a long shallow crease vs a short sharp pinch) both
     * register.
     *
     * This is the building block for [curvatureSegmentation]. Pure
     * function: same input → same output.
     */
    fun perTriangleCurvature(bvh: MeshBvh): FloatArray {
        val n = bvh.triCount
        val out = FloatArray(n)
        if (n == 0) return out

        // Scale 1: per-triangle, average abs(dihedral) over direct neighbors.
        val s1 = FloatArray(n)
        for (i in 0 until n) {
            val nrm = bvh.triangleNormal(i)
            if (nrm.x == 0f && nrm.y == 0f && nrm.z == 0f) continue
            val nbrs = bvh.directNeighbors(i)
            if (nbrs.isEmpty()) continue
            var sum = 0f
            var count = 0
            for (nb in nbrs) {
                val nN = bvh.triangleNormal(nb)
                if (nN.x == 0f && nN.y == 0f && nN.z == 0f) continue
                val dot = (nrm.x * nN.x + nrm.y * nN.y + nrm.z * nN.z).coerceIn(-1f, 1f)
                val ang = Math.toDegrees(kotlin.math.acos(dot.toDouble())).toFloat()
                sum += ang
                count++
            }
            if (count > 0) s1[i] = sum / count
        }

        // Scale 2: per-triangle, average s1 over its 1-ring neighbors —
        // smooths out single-triangle noise, surfaces broader feature
        // boundaries.
        val s2 = FloatArray(n)
        for (i in 0 until n) {
            val nbrs = bvh.directNeighbors(i)
            if (nbrs.isEmpty()) { s2[i] = s1[i]; continue }
            var sum = s1[i]
            var count = 1
            for (nb in nbrs) {
                sum += s1[nb]; count++
            }
            s2[i] = sum / count
        }

        for (i in 0 until n) out[i] = max(s1[i], s2[i])
        return out
    }

    /**
     * Multi-scale curvature segmentation. Region-grows from low-
     * curvature seeds (smooth feature interiors), stopping at
     * triangles whose curvature score crosses [creaseThresholdDeg].
     * Designed for organic models (Pikachu cheeks, Funko Pop ears,
     * Stanford Bunny limbs) where the upstream `semanticRegions`
     * heuristic produces over-fragmented patches because every
     * curved surface registers as "diagonal" with no obvious
     * cardinal alignment.
     *
     * Algorithm:
     *  1. Compute per-triangle curvature score [perTriangleCurvature].
     *  2. Sort seed candidates by ascending curvature score (smoothest
     *     first), ties broken by ascending tri_id for determinism.
     *  3. For each unassigned candidate, BFS along shared-vertex
     *     adjacency. Accept neighbor iff:
     *       - neighbor's curvature score < creaseThresholdDeg
     *       - dihedral(seed, neighbor) < seedDihedralCapDeg
     *  4. Drop segments under [minSegmentTriCount].
     *  5. The unassigned residue (high-curvature triangles between
     *     features) gets one final pass — each unassigned triangle
     *     joins the segment of its lowest-curvature neighbor (if any).
     *     This stops sharp creases from being lost as noise.
     */
    fun curvatureSegmentation(
        bvh: MeshBvh,
        creaseThresholdDeg: Float = 22f,
        seedDihedralCapDeg: Float = 35f,
        maxSegments: Int = 24,
        minSegmentTriCount: Int = 8,
    ): List<CurvatureSegment> {
        val n = bvh.triCount
        if (n == 0) return emptyList()
        val curvature = perTriangleCurvature(bvh)
        val crease = creaseThresholdDeg.coerceAtLeast(0f)
        val seedCap = seedDihedralCapDeg.coerceAtLeast(0f)

        // Sort triangles by ascending curvature score for seed order.
        val order = IntArray(n) { it }
        // Simple insertion-sort key: stable + bounded — but for n>1k
        // use a Long-pack sort for perf.
        val packed = LongArray(n)
        for (i in 0 until n) {
            val cBits = curvature[i].toRawBits().toLong() and 0xFFFFFFFFL
            packed[i] = (cBits shl 32) or i.toLong()
        }
        packed.sort()
        for (i in 0 until n) order[i] = (packed[i] and 0xFFFFFFFFL).toInt()

        val assigned = IntArray(n) { -1 }
        val regionBuf = IntArray(n)
        val queue = IntArray(n)
        var nextId = 0
        val rawSegments = ArrayList<CurvatureSegment>()

        for (idx in 0 until n) {
            val seed = order[idx]
            if (assigned[seed] != -1) continue
            // Skip seeds that are themselves on a crease — they get
            // joined to a neighbor in the residual pass.
            if (curvature[seed] >= crease) continue

            val seedNormal = bvh.triangleNormal(seed)
            var size = 0
            var qHead = 0; var qTail = 0
            queue[qTail++] = seed
            assigned[seed] = nextId
            while (qHead < qTail) {
                val cur = queue[qHead++]
                regionBuf[size++] = cur
                for (nb in bvh.directNeighbors(cur)) {
                    if (assigned[nb] != -1) continue
                    if (curvature[nb] >= crease) continue
                    val nN = bvh.triangleNormal(nb)
                    if (nN.x == 0f && nN.y == 0f && nN.z == 0f) continue
                    val dot = (seedNormal.x * nN.x + seedNormal.y * nN.y + seedNormal.z * nN.z)
                        .coerceIn(-1f, 1f)
                    val ang = Math.toDegrees(kotlin.math.acos(dot.toDouble())).toFloat()
                    if (ang > seedCap) continue
                    assigned[nb] = nextId
                    queue[qTail++] = nb
                }
            }
            if (size < minSegmentTriCount) {
                // Reset; let the residual pass pick these up.
                for (k in 0 until size) assigned[regionBuf[k]] = -1
                continue
            }
            val members = regionBuf.copyOf(size)
            rawSegments.add(buildSegment(bvh, nextId, members, curvature))
            nextId++
        }

        // Residual pass: unassigned triangles join the nearest
        // assigned neighbor (chosen by lowest curvature). Two passes
        // so neighbor-of-neighbor inheritance works.
        for (pass in 0 until 2) {
            for (i in 0 until n) {
                if (assigned[i] != -1) continue
                var bestSeg = -1
                var bestScore = Float.POSITIVE_INFINITY
                for (nb in bvh.directNeighbors(i)) {
                    val seg = assigned[nb]
                    if (seg < 0) continue
                    val s = curvature[nb]
                    if (s < bestScore) { bestScore = s; bestSeg = seg }
                }
                if (bestSeg >= 0) assigned[i] = bestSeg
            }
        }

        // Re-collect membership now that residuals are joined.
        val membership = HashMap<Int, ArrayList<Int>>(rawSegments.size)
        for (i in 0 until n) {
            val seg = assigned[i]
            if (seg < 0) continue
            membership.getOrPut(seg) { ArrayList() }.add(i)
        }
        val merged = ArrayList<CurvatureSegment>()
        for (seg in rawSegments) {
            val members = membership[seg.segmentId]?.toIntArray() ?: continue
            if (members.size < minSegmentTriCount) continue
            merged.add(buildSegment(bvh, seg.segmentId, members, curvature))
        }
        return merged.sortedByDescending { it.areaMm2 }
            .take(maxSegments)
            .mapIndexed { i, s -> s.copy(segmentId = i) }
    }

    private fun buildSegment(
        bvh: MeshBvh,
        segmentId: Int,
        members: IntArray,
        curvature: FloatArray,
    ): CurvatureSegment {
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var aTotal = 0.0
        var nx = 0.0; var ny = 0.0; var nz = 0.0
        var cx = 0.0; var cy = 0.0; var cz = 0.0
        var curveSum = 0.0
        for (t in members) {
            val v0 = bvh.triangleVertex(t, 0)
            val v1 = bvh.triangleVertex(t, 1)
            val v2 = bvh.triangleVertex(t, 2)
            for (v in arrayOf(v0, v1, v2)) {
                if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z
                if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z
            }
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val cnx = e1y * e2z - e1z * e2y
            val cny = e1z * e2x - e1x * e2z
            val cnz = e1x * e2y - e1y * e2x
            val len = sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)
            val a = (0.5 * len)
            aTotal += a
            if (len > 0) {
                nx += (cnx / len) * a; ny += (cny / len) * a; nz += (cnz / len) * a
            }
            val tcx = (v0.x + v1.x + v2.x) / 3f
            val tcy = (v0.y + v1.y + v2.y) / 3f
            val tcz = (v0.z + v1.z + v2.z) / 3f
            cx += tcx * a; cy += tcy * a; cz += tcz * a
            curveSum += curvature[t]
        }
        val meanN = if (aTotal > 0) {
            val nLen = sqrt(nx * nx + ny * ny + nz * nz)
            if (nLen > 0) floatArrayOf((nx / nLen).toFloat(), (ny / nLen).toFloat(), (nz / nLen).toFloat())
            else floatArrayOf(0f, 0f, 0f)
        } else floatArrayOf(0f, 0f, 0f)
        val centroid = if (aTotal > 0)
            floatArrayOf((cx / aTotal).toFloat(), (cy / aTotal).toFloat(), (cz / aTotal).toFloat())
        else floatArrayOf(0f, 0f, 0f)
        val meanCurve = if (members.isNotEmpty()) (curveSum / members.size).toFloat() else 0f
        val orientation = orientationLabel(meanN)
        val curveBucket = when {
            meanCurve < 5f -> "smooth"
            meanCurve < 15f -> "gentle"
            else -> "creased"
        }
        val label = "${curveBucket}_${orientation}"
        return CurvatureSegment(
            segmentId = segmentId,
            triangleIndices = members,
            bbox = Bbox(minX, minY, minZ, maxX, maxY, maxZ),
            centroid = centroid,
            meanNormal = meanN,
            areaMm2 = aTotal.toFloat(),
            meanCurvatureScore = meanCurve,
            label = label,
        )
    }

    // ---- Recessed-feature detection (D19c) ----

    data class RecessedFeature(
        val featureId: Int,
        /** Triangle indices belonging to the recess interior. */
        val triangleIndices: IntArray,
        /** A representative seed triangle near the deepest point (the
         *  one with the most-negative signed curvature). Use this with
         *  paint_geodesic_disc.anchor.tri_id. */
        val seedTriangleId: Int,
        /** Approximate "depth" of the recess in mm — distance from the
         *  feature's centroid to the convex hull approximated by its
         *  bounding box face along the seed triangle's outward normal.
         *  Helpful for sorting features by prominence. */
        val depthMm: Float,
        /** Centroid of the recess (mesh-local mm). */
        val centroid: FloatArray,
        /** Mean outward normal of the recess interior (points "out of
         *  the hole" — useful as a paint-projection direction). */
        val meanNormal: FloatArray,
        /** Total surface area of the recess in mm². */
        val areaMm2: Float,
        /** Mean signed curvature score (negative; more negative =
         *  deeper / sharper recess). */
        val meanSignedCurvature: Float,
        /** Heuristic label: "recess_top" / "recess_front_pair" / etc.,
         *  built from the centroid's bbox-relative position +
         *  orientation of meanNormal. */
        val label: String,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is RecessedFeature) return false
            return featureId == other.featureId &&
                triangleIndices.contentEquals(other.triangleIndices)
        }
        override fun hashCode(): Int = featureId * 31 + triangleIndices.contentHashCode()
    }

    /**
     * Per-triangle **signed** dihedral score. Positive = convex edge
     * (outward bulge — sphere surface, knuckle); negative = concave
     * edge (inward groove — eye socket, mouth recess); near zero =
     * locally flat.
     *
     * Sign test: take the cross product of the two outward normals
     * (`nA × nB`) and dot it against the shared edge's directed
     * vector (oriented in A's CCW winding). Positive dot ⇒ rotation
     * from nA to nB is in the same direction as the edge ⇒ the
     * surfaces "fold outward" away from each other ⇒ convex.
     * Negative ⇒ concave. This is the textbook signed-dihedral
     * formula and works regardless of where the centroids land.
     *
     * Magnitude is the unsigned dihedral angle in degrees, so the
     * output is comparable to [perTriangleCurvature].
     *
     * Cost: O(triCount × averageNeighborCount × 3) for the shared-
     * edge identification. On typical 150 K-tri meshes this is a few
     * hundred ms — same order as [perTriangleCurvature].
     */
    fun perTriangleSignedCurvature(bvh: MeshBvh): FloatArray {
        val n = bvh.triCount
        val out = FloatArray(n)
        if (n == 0) return out
        // Quantization tolerance for vertex matching — same precision
        // (1 µm) as MeshBvh.buildAdjacency, so two triangles flagged
        // as neighbors will reliably share quantized vertices.
        val q = 1e-3f
        for (i in 0 until n) {
            val nrm = bvh.triangleNormal(i)
            if (nrm.x == 0f && nrm.y == 0f && nrm.z == 0f) continue
            val v0 = bvh.triangleVertex(i, 0)
            val v1 = bvh.triangleVertex(i, 1)
            val v2 = bvh.triangleVertex(i, 2)
            val nbrs = bvh.directNeighbors(i)
            if (nbrs.isEmpty()) continue
            var sum = 0f
            var count = 0
            for (nb in nbrs) {
                val nN = bvh.triangleNormal(nb)
                if (nN.x == 0f && nN.y == 0f && nN.z == 0f) continue
                // Find which two of A's vertices appear in B (the
                // shared edge). Use quantized comparison to absorb
                // float noise.
                val w0 = bvh.triangleVertex(nb, 0)
                val w1 = bvh.triangleVertex(nb, 1)
                val w2 = bvh.triangleVertex(nb, 2)
                val a0In = vIn(v0, w0, w1, w2, q)
                val a1In = vIn(v1, w0, w1, w2, q)
                val a2In = vIn(v2, w0, w1, w2, q)
                val sharedCount = (if (a0In) 1 else 0) + (if (a1In) 1 else 0) + (if (a2In) 1 else 0)
                if (sharedCount < 2) continue  // adjacent via single vertex only — can't form an edge
                // Determine the directed edge in A's winding. Edges of
                // A are (v0,v1), (v1,v2), (v2,v0). Pick the one whose
                // both endpoints are shared with B.
                val edgeFrom: Vec3f
                val edgeTo: Vec3f
                when {
                    a0In && a1In -> { edgeFrom = v0; edgeTo = v1 }
                    a1In && a2In -> { edgeFrom = v1; edgeTo = v2 }
                    a2In && a0In -> { edgeFrom = v2; edgeTo = v0 }
                    else -> continue
                }
                val ex = edgeTo.x - edgeFrom.x
                val ey = edgeTo.y - edgeFrom.y
                val ez = edgeTo.z - edgeFrom.z
                // Cross product of normals.
                val cx = nrm.y * nN.z - nrm.z * nN.y
                val cy = nrm.z * nN.x - nrm.x * nN.z
                val cz = nrm.x * nN.y - nrm.y * nN.x
                // Dot with edge direction.
                val cross = cx * ex + cy * ey + cz * ez
                // Magnitude: unsigned dihedral angle.
                val dot = (nrm.x * nN.x + nrm.y * nN.y + nrm.z * nN.z).coerceIn(-1f, 1f)
                val ang = Math.toDegrees(kotlin.math.acos(dot.toDouble())).toFloat()
                val sign = if (cross > 0f) 1f else -1f
                sum += sign * ang
                count++
            }
            if (count > 0) out[i] = sum / count
        }
        return out
    }

    private fun vIn(v: Vec3f, w0: Vec3f, w1: Vec3f, w2: Vec3f, tol: Float): Boolean {
        return vEq(v, w0, tol) || vEq(v, w1, tol) || vEq(v, w2, tol)
    }
    private fun vEq(a: Vec3f, b: Vec3f, tol: Float): Boolean {
        return kotlin.math.abs(a.x - b.x) < tol &&
            kotlin.math.abs(a.y - b.y) < tol &&
            kotlin.math.abs(a.z - b.z) < tol
    }

    /**
     * Find the top recessed features on a mesh — eye sockets, mouth
     * grooves, ear cavities, between-finger gaps. Designed to be the
     * deterministic alternative to vision-API anchor finding for the
     * "where do I paint the eyes?" workflow.
     *
     * Algorithm:
     *  1. Compute signed curvature [perTriangleSignedCurvature].
     *  2. Find triangles with score < `concaveThresholdDeg` (negative
     *     side, sufficiently sharp).
     *  3. BFS from each unassigned concave seed (most-negative first)
     *     along shared-vertex adjacency, accepting neighbors that
     *     are also concave (within `growConcaveThresholdDeg`).
     *  4. Drop segments under `minSegmentTriCount`.
     *  5. Return the top `maxFeatures` by area, each with a seed
     *     triangle (the most-concave member) and a label.
     */
    fun findRecessedFeatures(
        bvh: MeshBvh,
        concaveThresholdDeg: Float = -18f,
        growConcaveThresholdDeg: Float = -8f,
        maxFeatures: Int = 12,
        minSegmentTriCount: Int = 6,
    ): List<RecessedFeature> {
        val n = bvh.triCount
        if (n == 0) return emptyList()
        val signed = perTriangleSignedCurvature(bvh)
        // Sort by ascending (most negative first).
        val order = IntArray(n) { it }
        run {
            val packed = LongArray(n)
            for (i in 0 until n) {
                // Encode signed float as comparable bits: shift to
                // positive range so Long sort gives us ascending
                // score. 1<<31 added to handle negatives correctly.
                val biased = (signed[i] * 1000f + 1_000_000f).toInt()
                packed[i] = (biased.toLong() shl 32) or (i.toLong() and 0xFFFFFFFFL)
            }
            packed.sort()
            for (i in 0 until n) order[i] = (packed[i] and 0xFFFFFFFFL).toInt()
        }
        val assigned = IntArray(n) { -1 }
        val regionBuf = IntArray(n)
        val queue = IntArray(n)
        val rawSegments = ArrayList<RecessedFeature>()
        var nextId = 0
        val growThr = growConcaveThresholdDeg
        for (idx in 0 until n) {
            val seed = order[idx]
            if (assigned[seed] != -1) continue
            if (signed[seed] >= concaveThresholdDeg) break  // sorted ascending; rest are not concave enough
            var size = 0
            var qHead = 0; var qTail = 0
            queue[qTail++] = seed
            assigned[seed] = nextId
            while (qHead < qTail) {
                val cur = queue[qHead++]
                regionBuf[size++] = cur
                for (nb in bvh.directNeighbors(cur)) {
                    if (assigned[nb] != -1) continue
                    if (signed[nb] >= growThr) continue
                    assigned[nb] = nextId
                    queue[qTail++] = nb
                }
            }
            if (size < minSegmentTriCount) {
                // Roll back and skip.
                for (k in 0 until size) assigned[regionBuf[k]] = -1
                continue
            }
            val members = regionBuf.copyOf(size)
            rawSegments.add(buildRecess(bvh, nextId, members, signed))
            nextId++
        }
        return rawSegments.sortedByDescending { it.areaMm2 }.take(maxFeatures)
            .mapIndexed { i, f -> f.copy(featureId = i) }
    }

    private fun buildRecess(
        bvh: MeshBvh,
        featureId: Int,
        members: IntArray,
        signed: FloatArray,
    ): RecessedFeature {
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var aTotal = 0.0
        var nx = 0.0; var ny = 0.0; var nz = 0.0
        var cx = 0.0; var cy = 0.0; var cz = 0.0
        var curveSum = 0.0
        var seedTri = members[0]
        var seedScore = signed[seedTri]
        for (t in members) {
            val s = signed[t]
            if (s < seedScore) { seedScore = s; seedTri = t }
            val v0 = bvh.triangleVertex(t, 0)
            val v1 = bvh.triangleVertex(t, 1)
            val v2 = bvh.triangleVertex(t, 2)
            for (v in arrayOf(v0, v1, v2)) {
                if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z
                if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z
            }
            val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
            val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
            val cnx = e1y * e2z - e1z * e2y
            val cny = e1z * e2x - e1x * e2z
            val cnz = e1x * e2y - e1y * e2x
            val len = sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)
            val a = 0.5 * len
            aTotal += a
            if (len > 0) {
                nx += (cnx / len) * a; ny += (cny / len) * a; nz += (cnz / len) * a
            }
            val tcx = (v0.x + v1.x + v2.x) / 3f
            val tcy = (v0.y + v1.y + v2.y) / 3f
            val tcz = (v0.z + v1.z + v2.z) / 3f
            cx += tcx * a; cy += tcy * a; cz += tcz * a
            curveSum += signed[t]
        }
        val meanN = if (aTotal > 0) {
            val nLen = sqrt(nx * nx + ny * ny + nz * nz)
            if (nLen > 0) floatArrayOf((nx / nLen).toFloat(), (ny / nLen).toFloat(), (nz / nLen).toFloat())
            else floatArrayOf(0f, 0f, 0f)
        } else floatArrayOf(0f, 0f, 0f)
        val centroid = if (aTotal > 0)
            floatArrayOf((cx / aTotal).toFloat(), (cy / aTotal).toFloat(), (cz / aTotal).toFloat())
        else floatArrayOf(0f, 0f, 0f)
        val meanCurve = if (members.isNotEmpty()) (curveSum / members.size).toFloat() else 0f
        // Depth: how far the centroid sits along -meanNormal from the
        // bbox surface in that direction. Coarse but useful for
        // ordering.
        val depthMm = run {
            val bboxExtent = maxOf(maxX - minX, maxY - minY, maxZ - minZ)
            (kotlin.math.abs(meanCurve) / 90f * bboxExtent).coerceAtMost(bboxExtent)
        }
        val orientation = orientationLabel(meanN)
        val label = "recess_$orientation"
        return RecessedFeature(
            featureId = featureId,
            triangleIndices = members,
            seedTriangleId = seedTri,
            depthMm = depthMm,
            centroid = centroid,
            meanNormal = meanN,
            areaMm2 = aTotal.toFloat(),
            meanSignedCurvature = meanCurve,
            label = label,
        )
    }
}
