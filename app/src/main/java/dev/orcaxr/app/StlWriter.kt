package dev.orcaxr.app

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Tiny binary-STL writer. We never emit STL on the user's behalf for
 * sharing — this is purely so we can hand a transformed mesh (rotated,
 * scaled, etc.) back to libslic3r's `mesh.ReadSTLFile` API instead of
 * rewriting the JNI shim to take in-memory triangles.
 *
 * Binary STL layout (matches StlReader):
 *   80 bytes header (zero-filled — libslic3r ignores it)
 *    4 bytes uint32 LE triangle count
 *   per triangle:
 *     12 bytes float32×3 normal (recomputed from vertices)
 *     12 bytes float32×3 vertex 0
 *     12 bytes float32×3 vertex 1
 *     12 bytes float32×3 vertex 2
 *      2 bytes uint16  attribute byte count (zero)
 */
object StlWriter {
    private const val HEADER_BYTES = 80
    private const val TRI_BYTES = 50

    fun write(mesh: StlMesh, out: File) {
        val n = mesh.triCount
        val total = HEADER_BYTES + 4 + n * TRI_BYTES
        val buf = ByteBuffer.allocate(total).order(ByteOrder.LITTLE_ENDIAN)
        // 80-byte zero-fill header. We also tag it so future humans
        // grepping the bytes can find OrcaXR's hand.
        val tag = "OrcaXR rotated mesh".toByteArray(Charsets.US_ASCII)
        buf.put(tag)
        repeat(HEADER_BYTES - tag.size) { buf.put(0) }
        buf.putInt(n)
        var src = 0
        for (i in 0 until n) {
            val ax = mesh.positions[src]; val ay = mesh.positions[src + 1]; val az = mesh.positions[src + 2]
            val bx = mesh.positions[src + 3]; val by = mesh.positions[src + 4]; val bz = mesh.positions[src + 5]
            val cx = mesh.positions[src + 6]; val cy = mesh.positions[src + 7]; val cz = mesh.positions[src + 8]
            // Recompute normal: (b-a) × (c-a), normalized.
            val ux = bx - ax; val uy = by - ay; val uz = bz - az
            val vx = cx - ax; val vy = cy - ay; val vz = cz - az
            var nx = uy * vz - uz * vy
            var ny = uz * vx - ux * vz
            var nz = ux * vy - uy * vx
            val len = kotlin.math.sqrt((nx * nx + ny * ny + nz * nz).toDouble()).toFloat()
            if (len > 0f) { nx /= len; ny /= len; nz /= len }
            buf.putFloat(nx); buf.putFloat(ny); buf.putFloat(nz)
            buf.putFloat(ax); buf.putFloat(ay); buf.putFloat(az)
            buf.putFloat(bx); buf.putFloat(by); buf.putFloat(bz)
            buf.putFloat(cx); buf.putFloat(cy); buf.putFloat(cz)
            buf.putShort(0)
            src += 9
        }
        out.writeBytes(buf.array())
    }
}
