package dev.orcaxr.app

import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Result of parsing an STL file. Triangles are stored as a flat float
 * array of length `triCount * 9` (three xyz per triangle, no shared
 * vertices) — STL has no vertex sharing on disk, so we don't pay the
 * cost of welding here. SceneCore copes fine with unshared verts; if a
 * future feature needs welded normals we can add a pass.
 */
data class StlMesh(
    /** xyz triplets, length = triCount * 9. */
    val positions: FloatArray,
    val triCount: Int,
    val bboxMin: Vec3f,
    val bboxMax: Vec3f,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is StlMesh) return false
        return triCount == other.triCount && positions.contentEquals(other.positions)
    }
    override fun hashCode(): Int = positions.contentHashCode() * 31 + triCount

    /**
     * Uniformly scale every vertex by [factor] (1.0 = no-op). Bounding
     * box scales with the mesh. Triangle winding is preserved since
     * positive scaling doesn't flip orientation.
     */
    fun scaled(factor: Float): StlMesh {
        if (factor == 1.0f) return this
        val out = FloatArray(positions.size)
        for (i in positions.indices) out[i] = positions[i] * factor
        return StlMesh(
            positions = out,
            triCount = triCount,
            bboxMin = Vec3f(bboxMin.x * factor, bboxMin.y * factor, bboxMin.z * factor),
            bboxMax = Vec3f(bboxMax.x * factor, bboxMax.y * factor, bboxMax.z * factor),
        )
    }

    /**
     * Rotate every vertex around the Z axis by [degrees]. Only multiples
     * of 90° are exact (sin/cos resolve to ±1 / 0), but the function
     * accepts any angle. We re-derive the bbox from the rotated points
     * since axis-aligned bounds change after a non-trivial rotation.
     */
    fun rotatedZ(degrees: Int): StlMesh {
        if (degrees % 360 == 0) return this
        val rad = Math.toRadians(degrees.toDouble())
        val c = kotlin.math.cos(rad).toFloat()
        val s = kotlin.math.sin(rad).toFloat()
        val out = FloatArray(positions.size)
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < positions.size) {
            val x = positions[i]; val y = positions[i + 1]; val z = positions[i + 2]
            val nx = c * x - s * y
            val ny = s * x + c * y
            out[i] = nx; out[i + 1] = ny; out[i + 2] = z
            if (nx < minX) minX = nx; if (ny < minY) minY = ny; if (z < minZ) minZ = z
            if (nx > maxX) maxX = nx; if (ny > maxY) maxY = ny; if (z > maxZ) maxZ = z
            i += 3
        }
        if (triCount == 0) {
            minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f
        }
        return StlMesh(
            positions = out,
            triCount = triCount,
            bboxMin = Vec3f(minX, minY, minZ),
            bboxMax = Vec3f(maxX, maxY, maxZ),
        )
    }

    /**
     * Translate every vertex by [dx] and [dy] on the XY plane.
     */
    fun translated(dx: Float, dy: Float): StlMesh {
        if (dx == 0f && dy == 0f) return this
        val out = FloatArray(positions.size)
        for (i in positions.indices step 3) {
            out[i] = positions[i] + dx
            out[i + 1] = positions[i + 1] + dy
            out[i + 2] = positions[i + 2]
        }
        return StlMesh(
            positions = out,
            triCount = triCount,
            bboxMin = Vec3f(bboxMin.x + dx, bboxMin.y + dy, bboxMin.z),
            bboxMax = Vec3f(bboxMax.x + dx, bboxMax.y + dy, bboxMax.z),
        )
    }

    /**
     * Translate every vertex by [dx], [dy], [dz]. Three-axis variant of
     * [translated]; used by the paint BVH builder to mirror the
     * `nativeWriteColoredGlb` centering shift (XY-center + Z-ground)
     * so BVH-coords match the rendered GLB-coords.
     */
    fun translatedXyz(dx: Float, dy: Float, dz: Float): StlMesh {
        if (dx == 0f && dy == 0f && dz == 0f) return this
        val out = FloatArray(positions.size)
        for (i in positions.indices step 3) {
            out[i] = positions[i] + dx
            out[i + 1] = positions[i + 1] + dy
            out[i + 2] = positions[i + 2] + dz
        }
        return StlMesh(
            positions = out,
            triCount = triCount,
            bboxMin = Vec3f(bboxMin.x + dx, bboxMin.y + dy, bboxMin.z + dz),
            bboxMax = Vec3f(bboxMax.x + dx, bboxMax.y + dy, bboxMax.z + dz),
        )
    }

    /**
     * Phase XR_OBJ_2 — composite affine transform in a single pass.
     *
     * Applies in fixed order: scale → mirror (sign flip) → rotate
     * (around X then Y then Z; intrinsic Tait–Bryan) → translate.
     * Mirror flags are folded into the scale at multiplication time:
     * a true [mirrorX] reads as `scale.x * -1`. Negative scale flips
     * triangle winding in screen space, but our renderer is unlit
     * (`KHR_materials_unlit`) and the GLB material is `doubleSided`
     * for SelectionBboxEntity; the model preview GLB uses solid
     * KHR_materials_unlit triangles whose perceived shape is winding-
     * agnostic at viewing distance.
     *
     * No-op short-circuit: when every input is identity (scale 1,
     * mirror off, rotation 0, translate 0) the receiver is returned
     * unchanged. The cheap path matters because the preview pipeline
     * runs this on every selection / brush-cycle / paddedSlots change.
     *
     * Bbox is recomputed from the transformed vertices since rotation
     * and mirror change the axis-aligned bounds.
     */
    @Suppress("LongParameterList")
    fun transformedFull(
        rotXDeg: Float = 0f,
        rotYDeg: Float = 0f,
        rotZDeg: Float = 0f,
        scaleX: Float = 1f,
        scaleY: Float = 1f,
        scaleZ: Float = 1f,
        mirrorX: Boolean = false,
        mirrorY: Boolean = false,
        mirrorZ: Boolean = false,
        tx: Float = 0f,
        ty: Float = 0f,
        tz: Float = 0f,
    ): StlMesh {
        val sx = if (mirrorX) -scaleX else scaleX
        val sy = if (mirrorY) -scaleY else scaleY
        val sz = if (mirrorZ) -scaleZ else scaleZ
        val rxRad = Math.toRadians(rotXDeg.toDouble())
        val ryRad = Math.toRadians(rotYDeg.toDouble())
        val rzRad = Math.toRadians(rotZDeg.toDouble())
        val cx = kotlin.math.cos(rxRad).toFloat()
        val sxr = kotlin.math.sin(rxRad).toFloat()
        val cy = kotlin.math.cos(ryRad).toFloat()
        val syr = kotlin.math.sin(ryRad).toFloat()
        val cz = kotlin.math.cos(rzRad).toFloat()
        val szr = kotlin.math.sin(rzRad).toFloat()

        // Identity short-circuit.
        if (sx == 1f && sy == 1f && sz == 1f &&
            rotXDeg == 0f && rotYDeg == 0f && rotZDeg == 0f &&
            tx == 0f && ty == 0f && tz == 0f) return this

        // Compose R = Rz * Ry * Rx so the Euler order matches Selection
        // Manipulation in upstream OrcaSlicer (rotate-X-first feels
        // natural for "tip the model forward then yaw").
        // Resulting 3x3:
        //   r00 = cz*cy
        //   r01 = cz*sy*sxr - szr*cx
        //   r02 = cz*sy*cx + szr*sxr
        //   r10 = szr*cy
        //   r11 = szr*sy*sxr + cz*cx
        //   r12 = szr*sy*cx - cz*sxr
        //   r20 = -sy
        //   r21 = cy*sxr
        //   r22 = cy*cx
        val r00 = cz * cy
        val r01 = cz * syr * sxr - szr * cx
        val r02 = cz * syr * cx + szr * sxr
        val r10 = szr * cy
        val r11 = szr * syr * sxr + cz * cx
        val r12 = szr * syr * cx - cz * sxr
        val r20 = -syr
        val r21 = cy * sxr
        val r22 = cy * cx

        val out = FloatArray(positions.size)
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < positions.size) {
            val x = positions[i] * sx
            val y = positions[i + 1] * sy
            val z = positions[i + 2] * sz
            val nx = r00 * x + r01 * y + r02 * z + tx
            val ny = r10 * x + r11 * y + r12 * z + ty
            val nz = r20 * x + r21 * y + r22 * z + tz
            out[i] = nx; out[i + 1] = ny; out[i + 2] = nz
            if (nx < minX) minX = nx; if (ny < minY) minY = ny; if (nz < minZ) minZ = nz
            if (nx > maxX) maxX = nx; if (ny > maxY) maxY = ny; if (nz > maxZ) maxZ = nz
            i += 3
        }
        if (triCount == 0) {
            minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f
        }
        return StlMesh(
            positions = out,
            triCount = triCount,
            bboxMin = Vec3f(minX, minY, minZ),
            bboxMax = Vec3f(maxX, maxY, maxZ),
        )
    }
}

/**
 * Minimal STL parser: binary STL only. ASCII STLs are rare in 3D-printer
 * pipelines (slicers emit binary; OnShape, Fusion, Cura all default to
 * binary), and we never write STLs ourselves — libslic3r reads from disk
 * for slicing, this parser is only for the *preview* mesh shown in
 * SceneCore. ASCII support can land if a user reports a real-world need.
 *
 * Binary STL layout:
 *   80 bytes header (typically padding/comments — must NOT start with
 *                    "solid " when binary; some tools violate this so
 *                    we use the size heuristic below)
 *    4 bytes uint32 little-endian triangle count
 *   per triangle:
 *     12 bytes float32×3 normal (we ignore — recompute if needed)
 *     12 bytes float32×3 vertex 0
 *     12 bytes float32×3 vertex 1
 *     12 bytes float32×3 vertex 2
 *      2 bytes uint16 attribute byte count (usually 0)
 *
 * Total binary file size for n triangles: 84 + n * 50.
 */
object StlReader {
    private const val BINARY_HEADER_BYTES = 80
    private const val BINARY_TRIANGLE_BYTES = 50  // 12*4 + 2

    fun read(file: File): StlMesh = file.inputStream().use { read(it, file.length()) }

    fun read(input: InputStream, totalBytes: Long): StlMesh {
        val all = input.readBytes()
        require(all.size.toLong() == totalBytes || totalBytes < 0) {
            "STL: expected $totalBytes bytes, got ${all.size}"
        }
        return parseBinary(all)
    }

    private fun parseBinary(bytes: ByteArray): StlMesh {
        require(bytes.size >= BINARY_HEADER_BYTES + 4) { "STL too short: ${bytes.size} bytes" }
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        buf.position(BINARY_HEADER_BYTES)
        val triCount = buf.int
        require(triCount in 0..50_000_000) { "STL triangle count looks corrupt: $triCount" }

        val expectedSize = BINARY_HEADER_BYTES + 4 + triCount.toLong() * BINARY_TRIANGLE_BYTES
        require(bytes.size.toLong() == expectedSize) {
            "STL size mismatch: got ${bytes.size}, expected $expectedSize for $triCount tris " +
                "(file may be ASCII STL; only binary is supported)"
        }

        val positions = FloatArray(triCount * 9)
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var p = 0
        for (i in 0 until triCount) {
            buf.position(BINARY_HEADER_BYTES + 4 + i * BINARY_TRIANGLE_BYTES + 12)  // skip normal
            for (v in 0 until 3) {
                val x = buf.float; val y = buf.float; val z = buf.float
                positions[p++] = x; positions[p++] = y; positions[p++] = z
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
            }
        }
        if (triCount == 0) {
            minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f
        }
        return StlMesh(
            positions = positions,
            triCount = triCount,
            bboxMin = Vec3f(minX, minY, minZ),
            bboxMax = Vec3f(maxX, maxY, maxZ),
        )
    }
}
