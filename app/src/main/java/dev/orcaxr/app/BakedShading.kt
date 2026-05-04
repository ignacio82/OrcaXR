package dev.orcaxr.app

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// Lambert + voxel-AO bake into per-vertex colors. Shared between the
// Kotlin STL preview path (StlPreviewGlb) and — eventually — the
// JNI 3MF preview path (nativeWriteColoredGlb has the same algorithm
// in C++ for now).
//
// We keep `KHR_materials_unlit` on the rendered GLB and bake all
// shading + AO into COLOR_0. Why bake instead of running runtime
// PBR + IBL: gotcha #14 — `pbrMetallicRoughness` materials widen
// Filament's per-bind window enough on Galaxy XR alpha13 to lose
// the material-instance-id race against the InteractableComponent
// attach, crashing with `split_engine_bridge.cc:100 NOT_FOUND`.
// Unlit + baked shading sidesteps that crash window entirely.
//
// Recipe (verified visually against the Pikachu STL with the
// host-side `tools/voxel_ao.py` verifier — eye sockets, mouth,
// finger gaps all pop):
//   1. Vertex deduplication via quantized-position hash so smooth
//      normals can blend across face boundaries.
//   2. Smooth normals: area-weighted face-normal accumulation.
//   3. Voxel ambient occlusion: 96-cell binary occupancy grid +
//      12 cosine-weighted hemisphere rays per vertex, marched up
//      to 14 voxels each. Cheap O(vertex × rays × march_steps),
//      orders of magnitude smaller than the per-triangle ray-cast
//      AO that crashed gotcha #14.
//   4. Full Lambert (`max(0, dot(n, L))`) with a 3-light kit:
//      key from front-top-right, fill from back-left, weak
//      underlight kicker. Half-Lambert wrap was tried and
//      flattened contrast.
internal object BakedShading {
    private const val VOXEL_GRID = 96
    private const val AO_RAYS = 12
    private const val AO_MARCH_STEPS = 14
    private const val AO_STRENGTH = 0.85f
    private const val AMBIENT = 0.16f
    private const val START_BIAS_FACTOR = 0.6f

    private val KEY_DIR  = floatArrayOf( 0.40f,  0.30f,  0.866f); private const val KEY_I  = 0.62f
    private val FILL_DIR = floatArrayOf(-0.50f, -0.30f,  0.812f); private const val FILL_I = 0.22f
    private val KICK_DIR = floatArrayOf( 0.00f,  0.20f, -0.980f); private const val KICK_I = 0.12f

    // Pre-baked cosine-weighted hemisphere directions in tangent
    // space (z = up). Same constants as `slic3r_jni.cpp` so the
    // Kotlin and C++ bakes produce visually identical results.
    private val AO_DIRS = arrayOf(
        floatArrayOf( 0.5739f,  0.4232f,  0.7016f),
        floatArrayOf(-0.4192f,  0.6421f,  0.6418f),
        floatArrayOf(-0.7521f, -0.0617f,  0.6562f),
        floatArrayOf( 0.1937f, -0.9116f,  0.3621f),
        floatArrayOf( 0.7853f, -0.1842f,  0.5908f),
        floatArrayOf(-0.0432f,  0.7642f,  0.6435f),
        floatArrayOf( 0.3216f,  0.1271f,  0.9382f),
        floatArrayOf(-0.5126f, -0.4731f,  0.7166f),
        floatArrayOf( 0.8623f,  0.3914f,  0.3214f),
        floatArrayOf(-0.2241f,  0.2014f,  0.9536f),
        floatArrayOf( 0.6421f, -0.6837f,  0.3469f),
        floatArrayOf(-0.7036f,  0.4218f,  0.5728f),
    )

    // Quantize positions to 0.001 mm so near-duplicate float values
    // hash to the same bucket. STLs emit each vertex per-triangle so
    // the dedup map is what makes smooth shading possible.
    private const val QUANT = 1000.0f

    /**
     * Multiplies [colors] in place by a per-corner shade ∈ [0,1] that
     * combines a 3-light Lambert kit with voxel ambient occlusion.
     *
     * @param positions Flat per-corner positions, length = `9 * triCount`.
     * @param colors Per-corner RGB, length = `9 * triCount`. Modified in place.
     * @return triple `(aoMin, aoMax, aoMean)` for logging.
     */
    fun bakeStlPreview(
        positions: FloatArray,
        colors: FloatArray,
    ): Triple<Float, Float, Float> {
        val cornerCount = positions.size / 3
        val triCount = cornerCount / 3
        if (triCount == 0) return Triple(0f, 0f, 0f)

        // ---- Vertex dedup.
        // Hash quantized (x,y,z) -> dedup index. We look up each
        // corner once and either reuse an existing dedup or push a
        // new unique vertex. ~72 k uniques on the 144 k-tri Pikachu.
        val cornerToDedup = IntArray(cornerCount)
        val dedupX = ArrayList<Float>(cornerCount / 2)
        val dedupY = ArrayList<Float>(cornerCount / 2)
        val dedupZ = ArrayList<Float>(cornerCount / 2)
        val map = HashMap<Long, Int>(cornerCount)
        for (c in 0 until cornerCount) {
            val x = positions[c * 3 + 0]
            val y = positions[c * 3 + 1]
            val z = positions[c * 3 + 2]
            val qx = (x * QUANT).toLong()
            val qy = (y * QUANT).toLong()
            val qz = (z * QUANT).toLong()
            // Pack (qx, qy, qz) into a single Long key. 21 bits per
            // axis covers ±1 m of mesh at 1 µm precision.
            val key = (qx and 0x1FFFFF) or
                      ((qy and 0x1FFFFF) shl 21) or
                      ((qz and 0x1FFFFF) shl 42)
            val existing = map[key]
            if (existing != null) {
                cornerToDedup[c] = existing
            } else {
                val idx = dedupX.size
                dedupX.add(x); dedupY.add(y); dedupZ.add(z)
                map[key] = idx
                cornerToDedup[c] = idx
            }
        }
        val vCount = dedupX.size

        // ---- Smooth normals via area-weighted face accumulation.
        val nx = FloatArray(vCount)
        val ny = FloatArray(vCount)
        val nz = FloatArray(vCount)
        for (t in 0 until triCount) {
            val i0 = cornerToDedup[t * 3 + 0]
            val i1 = cornerToDedup[t * 3 + 1]
            val i2 = cornerToDedup[t * 3 + 2]
            val ax = dedupX[i0]; val ay = dedupY[i0]; val az = dedupZ[i0]
            val bx = dedupX[i1]; val by = dedupY[i1]; val bz = dedupZ[i1]
            val ccx = dedupX[i2]; val ccy = dedupY[i2]; val ccz = dedupZ[i2]
            val ex = bx - ax; val ey = by - ay; val ez = bz - az
            val fx = ccx - ax; val fy = ccy - ay; val fz = ccz - az
            // Cross product = 2 * area * unit_normal.
            val fnx = ey * fz - ez * fy
            val fny = ez * fx - ex * fz
            val fnz = ex * fy - ey * fx
            nx[i0] += fnx; ny[i0] += fny; nz[i0] += fnz
            nx[i1] += fnx; ny[i1] += fny; nz[i1] += fnz
            nx[i2] += fnx; ny[i2] += fny; nz[i2] += fnz
        }
        for (v in 0 until vCount) {
            val l2 = nx[v] * nx[v] + ny[v] * ny[v] + nz[v] * nz[v]
            if (l2 > 1e-24f) {
                val inv = 1.0f / sqrt(l2)
                nx[v] *= inv; ny[v] *= inv; nz[v] *= inv
            } else {
                nx[v] = 0f; ny[v] = 0f; nz[v] = 1f
            }
        }

        // ---- Voxelize the mesh.
        var vminx = Float.POSITIVE_INFINITY; var vminy = Float.POSITIVE_INFINITY; var vminz = Float.POSITIVE_INFINITY
        var vmaxx = Float.NEGATIVE_INFINITY; var vmaxy = Float.NEGATIVE_INFINITY; var vmaxz = Float.NEGATIVE_INFINITY
        for (v in 0 until vCount) {
            val x = dedupX[v]; val y = dedupY[v]; val z = dedupZ[v]
            if (x < vminx) vminx = x; if (x > vmaxx) vmaxx = x
            if (y < vminy) vminy = y; if (y > vmaxy) vmaxy = y
            if (z < vminz) vminz = z; if (z > vmaxz) vmaxz = z
        }
        val rawExt = maxOf(vmaxx - vminx, vmaxy - vminy, vmaxz - vminz)
        if (rawExt <= 0f) return Triple(0f, 0f, 0f)
        val pad = 0.02f * rawExt
        vminx -= pad; vminy -= pad; vminz -= pad
        vmaxx += pad; vmaxy += pad; vmaxz += pad
        val gext = maxOf(vmaxx - vminx, vmaxy - vminy, vmaxz - vminz)
        val voxelSize = gext / VOXEL_GRID
        val invVoxel = 1f / voxelSize
        val gx = min(VOXEL_GRID, max(1, ceil((vmaxx - vminx) / voxelSize).toInt()))
        val gy = min(VOXEL_GRID, max(1, ceil((vmaxy - vminy) / voxelSize).toInt()))
        val gz = min(VOXEL_GRID, max(1, ceil((vmaxz - vminz) / voxelSize).toInt()))
        val occ = ByteArray(gx * gy * gz)
        for (t in 0 until triCount) {
            val i0 = cornerToDedup[t * 3 + 0]
            val i1 = cornerToDedup[t * 3 + 1]
            val i2 = cornerToDedup[t * 3 + 2]
            val tminx = minOf(dedupX[i0], dedupX[i1], dedupX[i2])
            val tminy = minOf(dedupY[i0], dedupY[i1], dedupY[i2])
            val tminz = minOf(dedupZ[i0], dedupZ[i1], dedupZ[i2])
            val tmaxx = maxOf(dedupX[i0], dedupX[i1], dedupX[i2])
            val tmaxy = maxOf(dedupY[i0], dedupY[i1], dedupY[i2])
            val tmaxz = maxOf(dedupZ[i0], dedupZ[i1], dedupZ[i2])
            val lox = max(0, min(gx - 1, ((tminx - vminx) * invVoxel).toInt()))
            val loy = max(0, min(gy - 1, ((tminy - vminy) * invVoxel).toInt()))
            val loz = max(0, min(gz - 1, ((tminz - vminz) * invVoxel).toInt()))
            val hix = max(0, min(gx - 1, ((tmaxx - vminx) * invVoxel).toInt()))
            val hiy = max(0, min(gy - 1, ((tmaxy - vminy) * invVoxel).toInt()))
            val hiz = max(0, min(gz - 1, ((tmaxz - vminz) * invVoxel).toInt()))
            for (xi in lox..hix) {
                for (yi in loy..hiy) {
                    val rowBase = (xi * gy + yi) * gz
                    for (zi in loz..hiz) occ[rowBase + zi] = 1
                }
            }
        }

        // ---- Per-vertex AO bake.
        val ao = FloatArray(vCount)
        val startBias = voxelSize * START_BIAS_FACTOR
        var aoMin = 1f; var aoMax = 0f; var aoSum = 0.0
        for (v in 0 until vCount) {
            val nxv = nx[v]; val nyv = ny[v]; val nzv = nz[v]
            // Tangent-bitangent frame: pick least-aligned axis as helper.
            val ax = abs(nxv); val ay = abs(nyv); val az = abs(nzv)
            var hxv = 1f; var hyv = 0f; var hzv = 0f
            if (ay < ax && ay < az) { hxv = 0f; hyv = 1f; hzv = 0f }
            else if (az < ax && az < ay) { hxv = 0f; hyv = 0f; hzv = 1f }
            var tx = hyv * nzv - hzv * nyv
            var ty = hzv * nxv - hxv * nzv
            var tz = hxv * nyv - hyv * nxv
            val tlen = sqrt(tx * tx + ty * ty + tz * tz)
            if (tlen > 1e-12f) { tx /= tlen; ty /= tlen; tz /= tlen }
            val bx = nyv * tz - nzv * ty
            val by = nzv * tx - nxv * tz
            val bz = nxv * ty - nyv * tx
            val startx = dedupX[v] + nxv * startBias
            val starty = dedupY[v] + nyv * startBias
            val startz = dedupZ[v] + nzv * startBias
            var hits = 0
            for (r in 0 until AO_RAYS) {
                val dxl = AO_DIRS[r][0]
                val dyl = AO_DIRS[r][1]
                val dzl = AO_DIRS[r][2]
                val wdx = tx * dxl + bx * dyl + nxv * dzl
                val wdy = ty * dxl + by * dyl + nyv * dzl
                val wdz = tz * dxl + bz * dyl + nzv * dzl
                var hit = false
                var s = 1
                while (s <= AO_MARCH_STEPS) {
                    val tStep = s * voxelSize
                    val px = startx + wdx * tStep
                    val py = starty + wdy * tStep
                    val pz = startz + wdz * tStep
                    val ix = ((px - vminx) * invVoxel).toInt()
                    val iy = ((py - vminy) * invVoxel).toInt()
                    val iz = ((pz - vminz) * invVoxel).toInt()
                    if (ix < 0 || ix >= gx || iy < 0 || iy >= gy || iz < 0 || iz >= gz) break
                    if (occ[(ix * gy + iy) * gz + iz].toInt() != 0) { hit = true; break }
                    s++
                }
                if (hit) hits++
            }
            val a = hits.toFloat() / AO_RAYS
            ao[v] = a
            if (a < aoMin) aoMin = a
            if (a > aoMax) aoMax = a
            aoSum += a
        }

        // ---- Compute per-vertex shade and apply to per-corner colors.
        val shade = FloatArray(vCount)
        for (v in 0 until vCount) {
            val nxv = nx[v]; val nyv = ny[v]; val nzv = nz[v]
            val keyTerm  = max(0f, nxv * KEY_DIR[0]  + nyv * KEY_DIR[1]  + nzv * KEY_DIR[2])
            val fillTerm = max(0f, nxv * FILL_DIR[0] + nyv * FILL_DIR[1] + nzv * FILL_DIR[2])
            val kickTerm = max(0f, nxv * KICK_DIR[0] + nyv * KICK_DIR[1] + nzv * KICK_DIR[2])
            var s = AMBIENT + KEY_I * keyTerm + FILL_I * fillTerm + KICK_I * kickTerm
            s *= (1f - AO_STRENGTH * ao[v])
            shade[v] = s.coerceIn(0f, 1f)
        }
        for (c in 0 until cornerCount) {
            val s = shade[cornerToDedup[c]]
            colors[c * 3 + 0] *= s
            colors[c * 3 + 1] *= s
            colors[c * 3 + 2] *= s
        }
        val aoMean = (aoSum / vCount).toFloat()
        return Triple(aoMin, aoMax, aoMean)
    }
}
