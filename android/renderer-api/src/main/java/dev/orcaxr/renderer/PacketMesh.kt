package dev.orcaxr.renderer

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectMeshPacket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** A prepared mesh packet: its shape, chunk table and bytes. */
interface MeshPacketSource {
    val packet: ProjectIntents.MeshPacket
    fun chunks(): List<ProjectMeshPacket.Chunk>
    /** Bytes [start] until [start] + [count], at most [ProjectMeshPacket.MAX_PAGE]. */
    fun bytes(start: Long, count: Long): ByteArray
}

/** This packet as a source, or null when the session refused it. */
fun ProjectMeshPacket.asSource(): MeshPacketSource? {
    val prepared = (reply() as? ProjectIntents.MeshPacketReply.Prepared)?.value ?: return null
    val owner = this
    return object : MeshPacketSource {
        override val packet = prepared
        override fun chunks() = owner.chunks(prepared.chunkCount)
        override fun bytes(start: Long, count: Long) = owner.bytes(start, count)
    }
}

/**
 * Meshes from the session's renderer packets (`ProjectSession.meshPacket`):
 * every chunk's positions and local indices merged into one [TriangleMesh] in
 * the asset's millimetres. The packet carries no colour — the render tint
 * does — so each facet gets a white base with flat shading baked in, lit from
 * a fixed direction above the front of the plate: `0.35 + 0.65 * max(0, n·L)`.
 */
object PacketMeshes {
    /** The light, in the project's Z-up millimetre space, from the front right (matching browser's DirectionalLight). */
    private val LIGHT = Point3(.4, -.55, .75).normalized()
    private const val AMBIENT = .35
    private const val DIFFUSE = .65

    /** The baked grey of a facet with unit normal [normal]; a degenerate facet (null) gets the ambient shade. */
    fun shade(normal: Point3?): Int {
        val light = if (normal == null) AMBIENT else AMBIENT + DIFFUSE * max(0.0, normal.dot(LIGHT))
        val grey = (light * 255).roundToInt().coerceIn(0, 255)
        return (0xff shl 24) or (grey shl 16) or (grey shl 8) or grey
    }

    private fun read(source: MeshPacketSource, start: Long, count: Long): ByteBuffer {
        require(count in 0..Int.MAX_VALUE.toLong()) { "Mesh packet region too large" }
        val bytes = ByteArray(count.toInt())
        var done = 0L
        while (done < count) {
            val page = minOf(ProjectMeshPacket.MAX_PAGE, count - done)
            val part = source.bytes(start + done, page)
            require(part.size.toLong() == page) { "Mesh packet page is short" }
            part.copyInto(bytes, done.toInt())
            done += page
        }
        return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    }

    /**
     * A canonical indexed-mesh payload as one [TriangleMesh]: [vertexCount]
     * float32 xyz positions, then [triangleCount] triangles of uint32
     * indices, little-endian (the bytes a simplify preview pages, which Apply
     * installs as the volume's mesh), shaded as packets are.
     */
    fun indexed(id: String, bytes: ByteArray, vertexCount: Long, triangleCount: Long): TriangleMesh {
        require(vertexCount in 3..TriangleMesh.MAX_FACETS * 3L && triangleCount in 1..TriangleMesh.MAX_FACETS.toLong()) { "Indexed mesh counts out of range" }
        require(bytes.size.toLong() == vertexCount * 12 + triangleCount * 12) { "Indexed mesh length differs from its counts" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val xyz = FloatArray((vertexCount * 3).toInt()) { buffer.getFloat(it * 4) }
        val base = xyz.size * 4
        val indices = IntArray((triangleCount * 3).toInt()) { index ->
            buffer.getInt(base + index * 4).also { require(it >= 0 && it < vertexCount) { "Indexed mesh index outside its vertices" } }
        }
        return TriangleMesh.owning(id, xyz, indices, shaded(xyz, indices))
    }

    /** Each facet's baked shade from its unit normal (`(b − a) × (c − a)`). */
    private fun shaded(xyz: FloatArray, indices: IntArray): IntArray {
        fun point(vertex: Int) = Point3(xyz[vertex * 3].toDouble(), xyz[vertex * 3 + 1].toDouble(), xyz[vertex * 3 + 2].toDouble())
        return IntArray(indices.size / 3) { facet ->
            val a = point(indices[facet * 3])
            val normal = (point(indices[facet * 3 + 1]) - a).cross(point(indices[facet * 3 + 2]) - a)
            val length = sqrt(normal.dot(normal))
            shade(if (length > 1e-12 && length.isFinite()) normal * (1 / length) else null)
        }
    }

    fun mesh(id: String, source: MeshPacketSource, cancelled: () -> Boolean = { false }): TriangleMesh {
        val packet = source.packet
        require(packet.indexBytes == 2L || packet.indexBytes == 4L) { "Unsupported index width" }
        require(packet.triangleCount in 1..TriangleMesh.MAX_FACETS.toLong()) { "Mesh packet triangle count out of range" }
        val chunks = source.chunks()
        require(chunks.size.toLong() == packet.chunkCount && chunks.isNotEmpty()) { "Mesh packet chunk table mismatch" }
        val table = packet.chunkCount * ProjectMeshPacket.TABLE_ENTRY_BYTES
        var triangles = 0L
        var vertices = 0L
        for (chunk in chunks) {
            require(chunk.firstTriangle == triangles && chunk.triangleCount > 0) { "Mesh packet chunks are not contiguous" }
            require(chunk.vertexCount in 1..chunk.triangleCount * 3) { "Mesh packet chunk vertex count out of range" }
            val end = chunk.byteOffset + chunk.vertexCount * 24 + chunk.triangleCount * 3 * packet.indexBytes
            require(chunk.byteOffset >= table && chunk.byteOffset % 4 == 0L && end <= packet.byteLength) { "Mesh packet chunk outside its bytes" }
            triangles += chunk.triangleCount
            vertices += chunk.vertexCount
        }
        require(triangles == packet.triangleCount) { "Mesh packet triangle count mismatch" }
        require(vertices <= TriangleMesh.MAX_FACETS * 3L) { "Mesh packet vertex count out of range" }
        val xyz = FloatArray((vertices * 3).toInt())
        val indices = IntArray((triangles * 3).toInt())
        var firstVertex = 0
        for (chunk in chunks) {
            check(!cancelled()) { "Cancelled mesh decoding" }
            val count = chunk.vertexCount.toInt()
            val positions = read(source, chunk.byteOffset, chunk.vertexCount * 12)
            for (n in 0 until count * 3) xyz[firstVertex * 3 + n] = positions.getFloat(n * 4)
            val local = read(source, chunk.byteOffset + chunk.vertexCount * 24, chunk.triangleCount * 3 * packet.indexBytes)
            val first = chunk.firstTriangle.toInt() * 3
            for (n in 0 until chunk.triangleCount.toInt() * 3) {
                val index = if (packet.indexBytes == 2L) local.getShort(n * 2).toInt() and 0xffff else local.getInt(n * 4)
                require(index in 0 until count) { "Mesh packet index outside its chunk" }
                indices[first + n] = firstVertex + index
            }
            firstVertex += count
        }
        return TriangleMesh.owning(id, xyz, indices, shaded(xyz, indices))
    }
}
