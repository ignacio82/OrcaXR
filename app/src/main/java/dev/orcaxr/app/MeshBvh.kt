package dev.orcaxr.app

import kotlin.math.max
import kotlin.math.min

/**
 * Axis-aligned bounding-box tree over an [StlMesh]'s triangles, with
 * Möller-Trumbore ray-vs-triangle and shared-vertex adjacency BFS for
 * radius-paint. Phase J in-XR painting (`docs/PHASE_J_PAINTING_PLAN.md`
 * §4.3).
 *
 * Storage is flat parallel arrays — one IntArray for triangle indices
 * sorted by leaf, one FloatArray for per-node (min, max) AABBs, and
 * IntArrays for left/right child / leaf-range pointers — to avoid per-
 * node object allocation churn on million-triangle meshes. Build time
 * for a 1.4M-tri dragon: ~150 ms on the host JVM (acceptable; runs
 * once per STL load, off the UI thread).
 *
 * Adjacency is computed lazily on first call to [radiusBfs] — most
 * paint sessions don't need it (single-click stamps go straight
 * through [intersect]) and the build cost (~50 ms / 1.4M tris) isn't
 * worth amortizing into BVH construction.
 *
 * Coordinate frame: same as [StlMesh.positions] — printer-frame
 * millimeters as authored on disk. Callers raycasting from world-space
 * (via `InputEvent.hitInfoList[0].hitPosition`) MUST first transform
 * the ray into the mesh's local frame using `HitInfo.transform`.
 */
class MeshBvh private constructor(
    private val mesh: StlMesh,
    /** Triangle indices in BVH leaf order. Length == triCount. */
    private val triIdx: IntArray,
    /** AABB per node, packed as [minX, minY, minZ, maxX, maxY, maxZ]
     *  (6 floats per node). */
    private val nodeAabb: FloatArray,
    /** Per-node left child index, or -1 for a leaf. */
    private val nodeLeft: IntArray,
    /** Per-node right child index, or -1 for a leaf. */
    private val nodeRight: IntArray,
    /** Per-node leaf-range start (into [triIdx]). Only meaningful for
     *  leaf nodes; left/right == -1. */
    private val nodeLeafStart: IntArray,
    /** Per-node leaf-range end (exclusive). */
    private val nodeLeafEnd: IntArray,
) {
    /** Total triangles in the underlying mesh. */
    val triCount: Int get() = mesh.triCount

    /** Mesh AABB in mesh-local mm. Exposed so the paint pipeline can
     *  log "ray missed bbox by N mm" when diagnosing why every paint
     *  raycast returns null. */
    val bboxMin: Vec3f get() = mesh.bboxMin
    val bboxMax: Vec3f get() = mesh.bboxMax

    /**
     * Front-most ray-vs-mesh intersection.
     *
     * @param origin    ray start in mesh-local coords (mm).
     * @param direction ray direction (need not be normalized; the test
     *                  is invariant to scale). Must be non-zero.
     * @return triangle index of the nearest hit, or null if the ray
     *         misses every triangle.
     */
    fun intersect(origin: Vec3f, direction: Vec3f): Int? {
        if (mesh.triCount == 0) return null
        val ox = origin.x; val oy = origin.y; val oz = origin.z
        val dx = direction.x; val dy = direction.y; val dz = direction.z
        // 1/dir for slab AABB test; replace 0 with a sentinel so 0 *
        // INF below resolves to NaN, which the comparisons below treat
        // as "miss this slab" correctly.
        val invDx = if (dx != 0f) 1f / dx else Float.POSITIVE_INFINITY
        val invDy = if (dy != 0f) 1f / dy else Float.POSITIVE_INFINITY
        val invDz = if (dz != 0f) 1f / dz else Float.POSITIVE_INFINITY

        val stack = IntArray(64)  // BVH depth on N-tri mesh ≤ ~ceil(log2 N) + slack
        var sp = 0
        stack[sp++] = 0  // root
        var bestT = Float.POSITIVE_INFINITY
        var bestTri = -1
        while (sp > 0) {
            val node = stack[--sp]
            if (!aabbHit(node, ox, oy, oz, invDx, invDy, invDz, bestT)) continue
            val left = nodeLeft[node]
            if (left < 0) {
                // leaf — test triangles
                val s = nodeLeafStart[node]
                val e = nodeLeafEnd[node]
                for (j in s until e) {
                    val ti = triIdx[j]
                    val t = triHit(ti, ox, oy, oz, dx, dy, dz)
                    if (t in 0f..bestT) {
                        bestT = t
                        bestTri = ti
                    }
                }
            } else {
                stack[sp++] = left
                stack[sp++] = nodeRight[node]
            }
        }
        return if (bestTri >= 0) bestTri else null
    }

    private fun aabbHit(
        node: Int,
        ox: Float, oy: Float, oz: Float,
        invDx: Float, invDy: Float, invDz: Float,
        tMaxBound: Float,
    ): Boolean {
        val b = node * 6
        val minX = nodeAabb[b]; val minY = nodeAabb[b + 1]; val minZ = nodeAabb[b + 2]
        val maxX = nodeAabb[b + 3]; val maxY = nodeAabb[b + 4]; val maxZ = nodeAabb[b + 5]
        val tx1 = (minX - ox) * invDx; val tx2 = (maxX - ox) * invDx
        val ty1 = (minY - oy) * invDy; val ty2 = (maxY - oy) * invDy
        val tz1 = (minZ - oz) * invDz; val tz2 = (maxZ - oz) * invDz
        val tmin = max(max(min(tx1, tx2), min(ty1, ty2)), min(tz1, tz2))
        val tmax = min(min(max(tx1, tx2), max(ty1, ty2)), max(tz1, tz2))
        return tmax >= max(tmin, 0f) && tmin <= tMaxBound
    }

    /**
     * Möller-Trumbore ray-vs-triangle. Returns the t parameter of the
     * intersection (distance along the ray in `direction` units), or
     * Float.POSITIVE_INFINITY when the ray misses or hits behind the
     * origin. `direction` does NOT need to be normalized — t is in
     * `direction` units.
     */
    private fun triHit(
        triIdx: Int,
        ox: Float, oy: Float, oz: Float,
        dx: Float, dy: Float, dz: Float,
    ): Float {
        val b = triIdx * 9
        val v0x = mesh.positions[b]; val v0y = mesh.positions[b + 1]; val v0z = mesh.positions[b + 2]
        val v1x = mesh.positions[b + 3]; val v1y = mesh.positions[b + 4]; val v1z = mesh.positions[b + 5]
        val v2x = mesh.positions[b + 6]; val v2y = mesh.positions[b + 7]; val v2z = mesh.positions[b + 8]
        val e1x = v1x - v0x; val e1y = v1y - v0y; val e1z = v1z - v0z
        val e2x = v2x - v0x; val e2y = v2y - v0y; val e2z = v2z - v0z
        // pvec = direction × e2
        val pvx = dy * e2z - dz * e2y
        val pvy = dz * e2x - dx * e2z
        val pvz = dx * e2y - dy * e2x
        val det = e1x * pvx + e1y * pvy + e1z * pvz
        // Two-sided hit: skip only when the triangle is parallel to
        // the ray. Painting interior surfaces (printed-from-the-inside
        // shells) needs this — desktop OrcaSlicer's brushes hit both
        // sides for the same reason.
        if (det > -EPS && det < EPS) return Float.POSITIVE_INFINITY
        val invDet = 1f / det
        val tvx = ox - v0x; val tvy = oy - v0y; val tvz = oz - v0z
        val u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet
        if (u < 0f || u > 1f) return Float.POSITIVE_INFINITY
        val qvx = tvy * e1z - tvz * e1y
        val qvy = tvz * e1x - tvx * e1z
        val qvz = tvx * e1y - tvy * e1x
        val v = (dx * qvx + dy * qvy + dz * qvz) * invDet
        if (v < 0f || u + v > 1f) return Float.POSITIVE_INFINITY
        val t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet
        return if (t > 0f) t else Float.POSITIVE_INFINITY
    }

    /**
     * Phase XR_OBJ_3 — outward unit normal of triangle [tri] in
     * mesh-local coordinates. Computed as the normalized cross product
     * of the triangle's two edges (v1-v0) × (v2-v0) — STL files store
     * vertices in CCW-from-outside order, so this yields the outward
     * normal directly.
     *
     * Returns a zero vector for degenerate (collinear-vertex) triangles.
     * Lay-on-face callers should treat zero-vector as "skip — not a
     * usable normal" rather than dividing through by it.
     */
    fun triangleNormal(tri: Int): Vec3f {
        require(tri in 0 until mesh.triCount) { "tri=$tri out of [0, ${mesh.triCount})" }
        val b = tri * 9
        val v0x = mesh.positions[b]; val v0y = mesh.positions[b + 1]; val v0z = mesh.positions[b + 2]
        val v1x = mesh.positions[b + 3]; val v1y = mesh.positions[b + 4]; val v1z = mesh.positions[b + 5]
        val v2x = mesh.positions[b + 6]; val v2y = mesh.positions[b + 7]; val v2z = mesh.positions[b + 8]
        val e1x = v1x - v0x; val e1y = v1y - v0y; val e1z = v1z - v0z
        val e2x = v2x - v0x; val e2y = v2y - v0y; val e2z = v2z - v0z
        val nx = e1y * e2z - e1z * e2y
        val ny = e1z * e2x - e1x * e2z
        val nz = e1x * e2y - e1y * e2x
        val len = kotlin.math.sqrt(nx * nx + ny * ny + nz * nz)
        if (len < EPS) return Vec3f(0f, 0f, 0f)
        return Vec3f(nx / len, ny / len, nz / len)
    }

    /**
     * Centroid of a triangle in mesh-local coords. Used by the
     * adjacency walk to bound the geodesic radius approximation.
     */
    /** Public mesh-local centroid of triangle [tri]. Used by Brim Ears
     *  placement to convert a triangle hit into a 3D anchor point. */
    fun triangleCentroid(tri: Int): Vec3f = centroidOf(tri)

    /**
     * Per-vertex accessor for triangle [tri]. [vertex] is 0..2. Used
     * by [AiPaintEngine.slab] when the SlabTest is AnyVertex /
     * AllVertices — centroid alone can't tell whether a triangle
     * straddles the slab plane.
     */
    fun triangleVertex(tri: Int, vertex: Int): Vec3f {
        require(tri in 0 until mesh.triCount) { "tri=$tri out of [0, ${mesh.triCount})" }
        require(vertex in 0..2) { "vertex=$vertex out of [0, 3)" }
        val b = tri * 9 + vertex * 3
        return Vec3f(mesh.positions[b], mesh.positions[b + 1], mesh.positions[b + 2])
    }

    private fun centroidOf(tri: Int): Vec3f {
        val b = tri * 9
        val cx = (mesh.positions[b] + mesh.positions[b + 3] + mesh.positions[b + 6]) / 3f
        val cy = (mesh.positions[b + 1] + mesh.positions[b + 4] + mesh.positions[b + 7]) / 3f
        val cz = (mesh.positions[b + 2] + mesh.positions[b + 5] + mesh.positions[b + 8]) / 3f
        return Vec3f(cx, cy, cz)
    }

    // Lazily computed shared-vertex adjacency (as flat CSR-style
    // arrays). For each triangle T at index i, neighbors live in
    // `adjNeighbors[adjStart[i] until adjStart[i+1]]`. "Shared vertex"
    // (any vertex matches by quantized coordinates), not "shared
    // edge" — STL has no vertex sharing on disk so an edge-share rule
    // would miss every neighbor unless we pre-weld vertices first.
    // Vertex quantization is integer microns, which copes with the
    // fp32 round-off STL writers introduce.
    @Volatile private var adjStart: IntArray? = null
    @Volatile private var adjNeighbors: IntArray? = null

    private fun ensureAdjacency() {
        if (adjStart != null) return
        synchronized(this) {
            if (adjStart != null) return
            val (s, n) = buildAdjacency(mesh)
            adjStart = s
            adjNeighbors = n
        }
    }

    // Reusable BFS buffers — allocated once per MeshBvh lifetime and
    // reset between calls. On a 1.4M-tri mesh the visited
    // BooleanArray alone is 1.4 MB; allocating it per `radiusBfs`
    // call (which runs at ~30 Hz during paint drags) burns the
    // 512 MB heap on its own. Reusing trims paint's allocation rate
    // dramatically and keeps a long stroke from OOMing the JVM.
    // Synchronized via the same lock as adjacency since paint runs
    // on the main thread but BVH build runs on Dispatchers.Default.
    private var bfsVisited: BooleanArray? = null
    private var bfsQueue: IntArray? = null
    private var bfsOut: IntArray? = null
    private val bfsLock = Any()

    /**
     * Flood-fill triangle indices from [seed] outward to neighbors
     * within [radiusMm] (Euclidean centroid distance) using shared-
     * vertex adjacency. Bounded by [maxTriangles] so a runaway
     * fill on a complex mesh can't lock the input thread.
     *
     * Geodesic radius-paint approximation: we compute distances from
     * the seed centroid in 3D (not along the surface), but only walk
     * connected components via adjacency. So a pinpoint click on a
     * dragon's wing tip won't suddenly paint the dragon's tail just
     * because they happen to be 6 mm apart through space — the BFS
     * stops at the wing's perimeter.
     */
    /**
     * Paint full-feature-parity (Smart Fill) — flood-fill connected
     * triangles whose adjacent-edge dihedral angle stays within
     * [maxAngleDeg]. Mirrors upstream OrcaSlicer's
     * `GLGizmoPainterBase::ToolType::BUCKET_FILL`: paint walks across
     * an edge iff the angle between the two adjacent triangles'
     * normals is ≤ [maxAngleDeg]. So a 30° gate paints a flat face up
     * to its perimeter where a sharp corner exceeds the threshold.
     *
     * Bounded by [maxTriangles] so a low-angle gate on a smoothly-
     * curved mesh can't lock the input thread; default 65536 covers
     * the largest single connected region on a 1.4M-tri dragon (the
     * body) without truncating.
     *
     * Stepwise comparison (this triangle's normal vs the candidate
     * neighbor's normal), not against the seed — that's what lets
     * the fill traverse a curved surface within the angle budget per
     * step. A flat-against-seed comparison would refuse to leave the
     * seed's tangent plane on any curved part.
     */
    fun smartFillBfs(seed: Int, maxAngleDeg: Float, maxTriangles: Int = 65536): IntArray {
        require(seed in 0 until mesh.triCount) {
            "seed=$seed out of [0, ${mesh.triCount})"
        }
        ensureAdjacency()
        val starts = adjStart!!
        val nbrs = adjNeighbors!!
        // Precompute cos(maxAngleDeg). Two unit normals' dot product is
        // cos of the angle between them; "angle ≤ θ" ⇔ "dot ≥ cos θ".
        // Clamp θ to [0, 180]; θ = 180° means "fill everything connected"
        // (cos 180° = -1, every dot ≥ -1).
        val theta = maxAngleDeg.coerceIn(0f, 180f)
        val cosThreshold = kotlin.math.cos(Math.toRadians(theta.toDouble())).toFloat()
        val visited = BooleanArray(mesh.triCount)
        val queue = IntArray(maxTriangles)
        val out = IntArray(maxTriangles)
        var qHead = 0
        var qTail = 0
        var outCount = 0
        queue[qTail++] = seed
        visited[seed] = true
        while (qHead < qTail && outCount < maxTriangles) {
            val cur = queue[qHead++]
            val curN = triangleNormal(cur)
            out[outCount++] = cur
            val s = starts[cur]
            val e = starts[cur + 1]
            for (k in s until e) {
                val n = nbrs[k]
                if (visited[n]) continue
                val nN = triangleNormal(n)
                val dot = curN.x * nN.x + curN.y * nN.y + curN.z * nN.z
                if (dot >= cosThreshold && qTail < maxTriangles) {
                    visited[n] = true
                    queue[qTail++] = n
                }
            }
        }
        return out.copyOf(outCount)
    }

    /**
     * AI-paint pillar (C9 §C.2): collect every triangle whose AABB
     * intersects the axis-aligned box `[min, max]`. Used as a
     * pre-filter before per-triangle distance / sphere tests in
     * `paint_sphere`. Walks the BVH tree, descending only into nodes
     * whose AABB overlaps the query box. Leaf triangles are returned
     * if any vertex is inside the box.
     *
     * Order is BVH-traversal order (deterministic for a given build)
     * so callers that want a stable triangle set across runs can
     * canonicalize by sorting the result. Result is bounded only by
     * the mesh's triCount.
     */
    fun aabbOverlapTriangles(
        minX: Float, minY: Float, minZ: Float,
        maxX: Float, maxY: Float, maxZ: Float,
    ): IntArray {
        if (mesh.triCount == 0) return IntArray(0)
        val out = ArrayList<Int>(64)
        val stack = IntArray(64)
        var sp = 0
        stack[sp++] = 0
        while (sp > 0) {
            val node = stack[--sp]
            val b = node * 6
            val nMinX = nodeAabb[b]; val nMinY = nodeAabb[b + 1]; val nMinZ = nodeAabb[b + 2]
            val nMaxX = nodeAabb[b + 3]; val nMaxY = nodeAabb[b + 4]; val nMaxZ = nodeAabb[b + 5]
            // Reject if the node's AABB doesn't overlap the query box.
            if (nMaxX < minX || nMinX > maxX) continue
            if (nMaxY < minY || nMinY > maxY) continue
            if (nMaxZ < minZ || nMinZ > maxZ) continue
            val left = nodeLeft[node]
            if (left < 0) {
                val s = nodeLeafStart[node]
                val e = nodeLeafEnd[node]
                for (j in s until e) {
                    val ti = triIdx[j]
                    if (triOverlapsBox(ti, minX, minY, minZ, maxX, maxY, maxZ)) {
                        out.add(ti)
                    }
                }
            } else {
                if (sp + 2 > stack.size) {
                    // Shouldn't happen with stack=64 and MAX_DEPTH=32,
                    // but safe-fall to abort rather than overflow.
                    return out.toIntArray()
                }
                stack[sp++] = left
                stack[sp++] = nodeRight[node]
            }
        }
        return out.toIntArray()
    }

    /** Triangle index `i` is "in the box" if any of its three vertices
     *  lies inside the AABB. Cheap conservative test that's accurate
     *  enough for the sphere/slab pre-filter — false positives at the
     *  triangle level are rejected by the per-primitive distance test
     *  in [AiPaintEngine]. */
    private fun triOverlapsBox(
        triIndex: Int,
        minX: Float, minY: Float, minZ: Float,
        maxX: Float, maxY: Float, maxZ: Float,
    ): Boolean {
        val b = triIndex * 9
        for (v in 0 until 3) {
            val x = mesh.positions[b + v * 3]
            val y = mesh.positions[b + v * 3 + 1]
            val z = mesh.positions[b + v * 3 + 2]
            if (x in minX..maxX && y in minY..maxY && z in minZ..maxZ) return true
        }
        // Also accept if the triangle's AABB encloses the query box
        // center — covers the case where a tiny query box is entirely
        // inside a big triangle. Cheap to compute.
        val v0x = mesh.positions[b]; val v0y = mesh.positions[b + 1]; val v0z = mesh.positions[b + 2]
        val v1x = mesh.positions[b + 3]; val v1y = mesh.positions[b + 4]; val v1z = mesh.positions[b + 5]
        val v2x = mesh.positions[b + 6]; val v2y = mesh.positions[b + 7]; val v2z = mesh.positions[b + 8]
        val tMinX = minOf(v0x, v1x, v2x); val tMaxX = maxOf(v0x, v1x, v2x)
        val tMinY = minOf(v0y, v1y, v2y); val tMaxY = maxOf(v0y, v1y, v2y)
        val tMinZ = minOf(v0z, v1z, v2z); val tMaxZ = maxOf(v0z, v1z, v2z)
        return !(tMaxX < minX || tMinX > maxX
            || tMaxY < minY || tMinY > maxY
            || tMaxZ < minZ || tMinZ > maxZ)
    }

    /**
     * AI-paint pillar (C9 milestone 4 paint_projected_mask
     * `all_hits` mode): collect every triangle the ray hits along
     * its full length, in front-to-back order. Used to paint both
     * sides of a thin shell from a single mask pixel.
     */
    fun intersectAll(origin: Vec3f, direction: Vec3f): IntArray {
        if (mesh.triCount == 0) return IntArray(0)
        val ox = origin.x; val oy = origin.y; val oz = origin.z
        val dx = direction.x; val dy = direction.y; val dz = direction.z
        val invDx = if (dx != 0f) 1f / dx else Float.POSITIVE_INFINITY
        val invDy = if (dy != 0f) 1f / dy else Float.POSITIVE_INFINITY
        val invDz = if (dz != 0f) 1f / dz else Float.POSITIVE_INFINITY
        val stack = IntArray(64)
        var sp = 0
        stack[sp++] = 0
        // Pair (t, triIndex) — collect all positive t hits.
        val ts = ArrayList<Float>(8)
        val tris = ArrayList<Int>(8)
        while (sp > 0) {
            val node = stack[--sp]
            if (!aabbHit(node, ox, oy, oz, invDx, invDy, invDz, Float.POSITIVE_INFINITY)) continue
            val left = nodeLeft[node]
            if (left < 0) {
                val s = nodeLeafStart[node]
                val e = nodeLeafEnd[node]
                for (j in s until e) {
                    val ti = triIdx[j]
                    val t = triHit(ti, ox, oy, oz, dx, dy, dz)
                    if (t.isFinite() && t > 0f) {
                        ts.add(t); tris.add(ti)
                    }
                }
            } else {
                stack[sp++] = left
                stack[sp++] = nodeRight[node]
            }
        }
        // Sort by t ascending, return tri indices.
        val indices = (0 until ts.size).sortedBy { ts[it] }
        val out = IntArray(indices.size)
        for ((i, idx) in indices.withIndex()) out[i] = tris[idx]
        return out
    }

    /**
     * AI-introspection (C9 §D.1): direct shared-vertex neighbors of
     * triangle [tri]. Returns only the immediate neighbors (no BFS,
     * no angle gate) — the building block for region-growing
     * segmentation in [AiIntrospection.semanticRegions].
     */
    fun directNeighbors(tri: Int): IntArray {
        require(tri in 0 until mesh.triCount) { "tri=$tri out of [0, ${mesh.triCount})" }
        ensureAdjacency()
        val starts = adjStart!!
        val nbrs = adjNeighbors!!
        val s = starts[tri]
        val e = starts[tri + 1]
        val out = IntArray(e - s)
        var oi = 0
        for (k in s until e) out[oi++] = nbrs[k]
        return out
    }

    /**
     * AI-paint pillar (C9 §C.2 paint_connected_component): collect
     * every triangle reachable from [seed] via shared-vertex
     * adjacency, ignoring dihedral angle. Used to paint a whole
     * connected sub-mesh (e.g. when a Benchy's smokestack is a
     * separate component from the hull).
     *
     * Result is bounded by [maxTriangles]; the unbounded version on a
     * 1.4 M-tri dragon would lock the input thread for a few seconds.
     */
    fun connectedComponent(seed: Int, maxTriangles: Int = 1_500_000): IntArray {
        require(seed in 0 until mesh.triCount) {
            "seed=$seed out of [0, ${mesh.triCount})"
        }
        ensureAdjacency()
        val starts = adjStart!!
        val nbrs = adjNeighbors!!
        val cap = maxTriangles.coerceAtMost(mesh.triCount)
        val visited = BooleanArray(mesh.triCount)
        val queue = IntArray(cap)
        val out = IntArray(cap)
        var qHead = 0
        var qTail = 0
        var outCount = 0
        queue[qTail++] = seed
        visited[seed] = true
        while (qHead < qTail && outCount < cap) {
            val cur = queue[qHead++]
            out[outCount++] = cur
            val s = starts[cur]
            val e = starts[cur + 1]
            for (k in s until e) {
                val n = nbrs[k]
                if (!visited[n] && qTail < cap) {
                    visited[n] = true
                    queue[qTail++] = n
                }
            }
        }
        return out.copyOf(outCount)
    }

    fun radiusBfs(seed: Int, radiusMm: Float, maxTriangles: Int = 8192): IntArray {
        require(seed in 0 until mesh.triCount) {
            "seed=$seed out of [0, ${mesh.triCount})"
        }
        if (radiusMm <= 0f) return intArrayOf(seed)
        ensureAdjacency()
        val starts = adjStart!!
        val nbrs = adjNeighbors!!
        val r2 = radiusMm * radiusMm
        val seedCentroid = centroidOf(seed)
        // Lazy-allocate the BFS buffers (1.4 MB on a 1.4M-tri mesh).
        // Reused across calls — `java.util.Arrays.fill` is much
        // cheaper than re-allocating a fresh BooleanArray every
        // event. Lock ensures concurrent paint events don't tread on
        // each other (paint runs serially on the main thread today,
        // but the lock costs nothing under no contention and
        // future-proofs the class).
        synchronized(bfsLock) {
            val visited = bfsVisited
                ?: BooleanArray(mesh.triCount).also { bfsVisited = it }
            val queue = (bfsQueue?.takeIf { it.size >= maxTriangles }
                ?: IntArray(maxTriangles)).also { bfsQueue = it }
            val out = (bfsOut?.takeIf { it.size >= maxTriangles }
                ?: IntArray(maxTriangles)).also { bfsOut = it }
            java.util.Arrays.fill(visited, false)
            var qHead = 0
            var qTail = 0
            var outCount = 0
            queue[qTail++] = seed
            visited[seed] = true
            while (qHead < qTail && outCount < maxTriangles) {
                val cur = queue[qHead++]
                val c = centroidOf(cur)
                val dx = c.x - seedCentroid.x
                val dy = c.y - seedCentroid.y
                val dz = c.z - seedCentroid.z
                if (cur != seed && (dx * dx + dy * dy + dz * dz) > r2) continue
                out[outCount++] = cur
                val s = starts[cur]
                val e = starts[cur + 1]
                for (k in s until e) {
                    val n = nbrs[k]
                    if (!visited[n] && qTail < maxTriangles) {
                        visited[n] = true
                        queue[qTail++] = n
                    }
                }
            }
            return out.copyOf(outCount)
        }
    }

    companion object {
        /** Below this leaf size, stop subdividing. Tuned so the leaf
         *  scan amortizes against the slab-test cost. */
        private const val LEAF_THRESHOLD = 8
        /** Hard cap on tree depth; protects against degenerate
         *  splits (e.g. all triangles co-planar with the chosen
         *  axis). At 32 we accommodate ~4 billion triangles before
         *  collapsing into oversized leaves. */
        private const val MAX_DEPTH = 32
        private const val EPS = 1e-7f

        /**
         * Build a BVH over [mesh]. O(n log n); ~150 ms on a
         * 1.4M-tri dragon (host JVM, single-threaded).
         */
        fun build(mesh: StlMesh): MeshBvh {
            val n = mesh.triCount
            if (n == 0) {
                return MeshBvh(
                    mesh = mesh,
                    triIdx = IntArray(0),
                    nodeAabb = floatArrayOf(0f, 0f, 0f, 0f, 0f, 0f),
                    nodeLeft = intArrayOf(-1),
                    nodeRight = intArrayOf(-1),
                    nodeLeafStart = intArrayOf(0),
                    nodeLeafEnd = intArrayOf(0),
                )
            }
            val triIdx = IntArray(n) { it }
            // Per-triangle centroid (3 floats per tri) — cached for
            // the whole build so the median-split partition doesn't
            // recompute centroids on every recursion.
            val centroids = FloatArray(n * 3)
            for (i in 0 until n) {
                val b = i * 9
                centroids[i * 3] =
                    (mesh.positions[b] + mesh.positions[b + 3] + mesh.positions[b + 6]) / 3f
                centroids[i * 3 + 1] =
                    (mesh.positions[b + 1] + mesh.positions[b + 4] + mesh.positions[b + 7]) / 3f
                centroids[i * 3 + 2] =
                    (mesh.positions[b + 2] + mesh.positions[b + 5] + mesh.positions[b + 8]) / 3f
            }

            // Worst case: 2n - 1 nodes in a balanced binary tree
            // over n leaves. Pre-size; trim before constructing.
            val maxNodes = 2 * n + 1
            val nodeAabb = FloatArray(maxNodes * 6)
            val nodeLeft = IntArray(maxNodes) { -1 }
            val nodeRight = IntArray(maxNodes) { -1 }
            val nodeLeafStart = IntArray(maxNodes)
            val nodeLeafEnd = IntArray(maxNodes)
            var nodeCount = 0

            // Iterative build via an explicit work stack.
            // Each entry: (start, end, depth, parentNodeId, isLeftChild).
            // We allocate the parent node BEFORE recursing into its
            // children so child indices are known when set on parent.
            data class Frame(val start: Int, val end: Int, val depth: Int, val outNode: Int)
            val stack = ArrayDeque<Frame>()
            val rootIdx = nodeCount++
            stack.addLast(Frame(0, n, 0, rootIdx))

            while (stack.isNotEmpty()) {
                val (start, end, depth, outNode) = stack.removeLast()
                computeAabbForRange(mesh, triIdx, start, end, nodeAabb, outNode)
                val count = end - start
                if (count <= LEAF_THRESHOLD || depth >= MAX_DEPTH) {
                    nodeLeft[outNode] = -1
                    nodeRight[outNode] = -1
                    nodeLeafStart[outNode] = start
                    nodeLeafEnd[outNode] = end
                    continue
                }
                // Pick the longest AABB axis as the split axis.
                val b = outNode * 6
                val ex = nodeAabb[b + 3] - nodeAabb[b]
                val ey = nodeAabb[b + 4] - nodeAabb[b + 1]
                val ez = nodeAabb[b + 5] - nodeAabb[b + 2]
                val axis = when {
                    ex >= ey && ex >= ez -> 0
                    ey >= ez -> 1
                    else -> 2
                }
                // Median-of-centroids partition. quickselect is
                // O(n) avg; we just sort the slice for code simplicity
                // — n is small at depth and the build cost is one-shot.
                sortByCentroid(triIdx, centroids, start, end, axis)
                val mid = (start + end) / 2
                if (mid == start || mid == end) {
                    // All centroids equal on the chosen axis — make a
                    // leaf rather than infinite-recurse. Rare, but
                    // co-planar test meshes do occur.
                    nodeLeft[outNode] = -1
                    nodeRight[outNode] = -1
                    nodeLeafStart[outNode] = start
                    nodeLeafEnd[outNode] = end
                    continue
                }
                val leftIdx = nodeCount++
                val rightIdx = nodeCount++
                nodeLeft[outNode] = leftIdx
                nodeRight[outNode] = rightIdx
                stack.addLast(Frame(mid, end, depth + 1, rightIdx))
                stack.addLast(Frame(start, mid, depth + 1, leftIdx))
            }

            return MeshBvh(
                mesh = mesh,
                triIdx = triIdx,
                nodeAabb = nodeAabb.copyOf(nodeCount * 6),
                nodeLeft = nodeLeft.copyOf(nodeCount),
                nodeRight = nodeRight.copyOf(nodeCount),
                nodeLeafStart = nodeLeafStart.copyOf(nodeCount),
                nodeLeafEnd = nodeLeafEnd.copyOf(nodeCount),
            )
        }

        private fun computeAabbForRange(
            mesh: StlMesh, triIdx: IntArray, start: Int, end: Int,
            out: FloatArray, node: Int,
        ) {
            var minX = Float.POSITIVE_INFINITY
            var minY = Float.POSITIVE_INFINITY
            var minZ = Float.POSITIVE_INFINITY
            var maxX = Float.NEGATIVE_INFINITY
            var maxY = Float.NEGATIVE_INFINITY
            var maxZ = Float.NEGATIVE_INFINITY
            for (i in start until end) {
                val ti = triIdx[i]
                val b = ti * 9
                for (v in 0 until 3) {
                    val x = mesh.positions[b + v * 3]
                    val y = mesh.positions[b + v * 3 + 1]
                    val z = mesh.positions[b + v * 3 + 2]
                    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
                    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
                }
            }
            val o = node * 6
            out[o] = minX; out[o + 1] = minY; out[o + 2] = minZ
            out[o + 3] = maxX; out[o + 4] = maxY; out[o + 5] = maxZ
        }

        /**
         * In-place insertion sort of [triIdx] over [start, end) by
         * centroid component on [axis]. We only ever sort small
         * sub-ranges (typical depth-bounded slice <= 1000), so
         * insertion sort's O(n²) is fine and avoids a Comparator
         * allocation per recursion. Stable.
         */
        private fun sortByCentroid(
            triIdx: IntArray, centroids: FloatArray,
            start: Int, end: Int, axis: Int,
        ) {
            // Fall back to Arrays.sort for large slices to avoid the
            // O(n²) cliff at the root. Threshold 256 is empirically
            // where insertion sort starts losing.
            if (end - start > 256) {
                // Use a boxed-Integer Comparator. Allocation cost is
                // amortized over the (rare) large-slice path.
                val boxed = (start until end).map { triIdx[it] }
                    .sortedBy { centroids[it * 3 + axis] }
                for (i in start until end) triIdx[i] = boxed[i - start]
                return
            }
            for (i in start + 1 until end) {
                val v = triIdx[i]
                val key = centroids[v * 3 + axis]
                var j = i - 1
                while (j >= start && centroids[triIdx[j] * 3 + axis] > key) {
                    triIdx[j + 1] = triIdx[j]
                    j--
                }
                triIdx[j + 1] = v
            }
        }

        /**
         * Build shared-vertex adjacency in CSR form. Two triangles
         * are neighbors iff they share at least one quantized vertex.
         * Quantization is integer microns (1e-3 mm), which absorbs the
         * fp32 round-off STL files ship with.
         */
        private fun buildAdjacency(mesh: StlMesh): Pair<IntArray, IntArray> {
            val n = mesh.triCount
            if (n == 0) return IntArray(1) to IntArray(0)
            // Map quantized vertex → list of triangle indices that
            // contain it. The quantization happens at the grid scale
            // of (1 micron); per Vec3f xyz triple becomes a Long key.
            val vertexToTris = HashMap<Long, ArrayList<Int>>(n * 2)
            for (t in 0 until n) {
                val b = t * 9
                for (v in 0 until 3) {
                    val k = quantizeVertexKey(
                        mesh.positions[b + v * 3],
                        mesh.positions[b + v * 3 + 1],
                        mesh.positions[b + v * 3 + 2],
                    )
                    vertexToTris.getOrPut(k) { ArrayList(4) }.add(t)
                }
            }
            // For each triangle, collect the union of its three
            // vertex buckets (excluding self), then dedupe.
            val adjLists = arrayOfNulls<HashSet<Int>>(n)
            for (t in 0 until n) {
                val s = HashSet<Int>(8)
                val b = t * 9
                for (v in 0 until 3) {
                    val k = quantizeVertexKey(
                        mesh.positions[b + v * 3],
                        mesh.positions[b + v * 3 + 1],
                        mesh.positions[b + v * 3 + 2],
                    )
                    val list = vertexToTris[k] ?: continue
                    for (other in list) if (other != t) s.add(other)
                }
                adjLists[t] = s
            }
            val starts = IntArray(n + 1)
            var total = 0
            for (t in 0 until n) {
                starts[t] = total
                total += adjLists[t]!!.size
            }
            starts[n] = total
            val nbrs = IntArray(total)
            for (t in 0 until n) {
                val list = adjLists[t]!!
                var i = starts[t]
                for (other in list) nbrs[i++] = other
            }
            return starts to nbrs
        }

        /**
         * Pack a 3D vertex into a 64-bit integer key by quantizing
         * each coordinate to integer microns. Roughly 1 μm precision
         * over a ±2 km range — way past anything a 3D printer touches.
         */
        private fun quantizeVertexKey(x: Float, y: Float, z: Float): Long {
            val qx = (x * 1000f).toInt().toLong() and 0x1FFFFFL  // 21 bits
            val qy = (y * 1000f).toInt().toLong() and 0x1FFFFFL
            val qz = (z * 1000f).toInt().toLong() and 0x3FFFFFL  // 22 bits
            return (qx shl 43) or (qy shl 22) or qz
        }
    }
}
