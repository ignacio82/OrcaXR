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
}
