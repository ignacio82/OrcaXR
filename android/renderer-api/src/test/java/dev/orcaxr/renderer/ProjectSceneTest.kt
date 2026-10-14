package dev.orcaxr.renderer

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectMeshPacket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt
import org.junit.Assert.*
import org.junit.Test

class ProjectSceneTest {
    private fun near(expected: Point3, actual: Point3) {
        assertEquals(expected.x, actual.x, 1e-9); assertEquals(expected.y, actual.y, 1e-9); assertEquals(expected.z, actual.z, 1e-9)
    }
    private fun units(text: String) = text.map { it.code }
    private fun transform(t: List<Double> = listOf(0.0, 0.0, 0.0), r: List<Double> = listOf(0.0, 0.0, 0.0, 1.0), s: List<Double> = listOf(1.0, 1.0, 1.0)) =
        ProjectIntents.Transform(t, r, s)
    private val absentText = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
    private fun cursor(revision: Long) = ProjectIntents.RenderCursor(revision, units("fnv1a64:$revision"))
    private fun plate(id: String, active: Boolean, order: Double = 0.0) =
        ProjectIntents.RenderChange.Plate(ProjectIntents.RenderPlate(units(id), order, true, active))
    private fun instance(id: String, objectId: String, plateId: String, t: ProjectIntents.Transform = transform()) =
        ProjectIntents.RenderChange.Instance(ProjectIntents.RenderInstance(units(id), units(objectId), units(plateId), t, true))
    private fun volume(id: String, objectId: String, asset: String, t: ProjectIntents.Transform = transform(), color: String? = null) =
        ProjectIntents.RenderChange.Volume(ProjectIntents.RenderVolume(units(id), units(objectId), ProjectIntents.VolumeRoleName.Model,
            units(asset), 12, t, color?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: absentText))
    private fun page(base: ProjectIntents.RenderCursor?, target: ProjectIntents.RenderCursor, total: Long, vararg changes: ProjectIntents.RenderChange) =
        ProjectIntents.RenderPage(
            base?.let { ProjectIntents.OptionalRenderCursor.Value(it) } ?: ProjectIntents.OptionalRenderCursor.Absent(ProjectIntents.Empty),
            target, total, changes.toList(),
        )

    @Test fun canonicalTransformsComposeAsTheBrowserPlacesVolumes() {
        val p = Point3(1.0, 2.0, 3.0)
        near(p, ModelTransform.fromCanonical(transform()).point(p))
        near(Point3(11.0, 22.0, 33.0), ModelTransform.fromCanonical(transform(t = listOf(10.0, 20.0, 30.0))).point(p))
        val half = sqrt(.5)
        val quarterTurn = ModelTransform.fromCanonical(transform(r = listOf(0.0, 0.0, half, half)))
        near(Point3(0.0, 1.0, 0.0), quarterTurn.point(Point3(1.0, 0.0, 0.0)))
        // An unnormalized quaternion is normalized, as three.js does; a zero one is the identity.
        near(Point3(0.0, 1.0, 0.0), ModelTransform.fromCanonical(transform(r = listOf(0.0, 0.0, 3.0, 3.0))).point(Point3(1.0, 0.0, 0.0)))
        near(p, ModelTransform.fromCanonical(transform(r = listOf(0.0, 0.0, 0.0, 0.0))).point(p))
        near(Point3(2.0, 6.0, 12.0), ModelTransform.fromCanonical(transform(s = listOf(2.0, 3.0, 4.0))).point(p))
        // T * R * S: scaled, then rotated, then moved.
        val placed = ModelTransform.fromCanonical(transform(t = listOf(100.0, 0.0, 0.0), r = listOf(0.0, 0.0, half, half), s = listOf(2.0, 1.0, 1.0)))
        near(Point3(100.0, 2.0, 0.0), placed.point(Point3(1.0, 0.0, 0.0)))
        // (a * b).point(p) == a.point(b.point(p)), and the product is not commutative.
        val move = ModelTransform.scaledTranslated(tx = 5.0)
        near(quarterTurn.point(move.point(p)), (quarterTurn * move).point(p))
        near(move.point(quarterTurn.point(p)), (move * quarterTurn).point(p))
        assertNotEquals((quarterTurn * move).point(p), (move * quarterTurn).point(p))
        assertThrows(IllegalArgumentException::class.java) { ModelTransform.fromCanonical(transform(r = listOf(Double.NaN, 0.0, 0.0, 1.0))) }
        assertThrows(IllegalArgumentException::class.java) { ModelTransform.fromCanonical(transform(s = listOf(0.0, 1.0, 1.0))) }
        assertThrows(IllegalArgumentException::class.java) { ModelTransform.fromCanonical(ProjectIntents.Transform(listOf(0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))) }
    }

    @Test fun displayColoursParseAsThreeJsReadsHex() {
        assertEquals(0xff12ab9f.toInt(), ProjectScene.color("#12AB9f"))
        assertEquals(0xffff0033.toInt(), ProjectScene.color("#f03"))
        assertEquals(ProjectScene.DEFAULT_ARGB, ProjectScene.color(null))
        for (bad in listOf("", "12ab9f", "#12ab9", "#12ab9fcc", "red", "#ggg")) assertEquals(bad, ProjectScene.DEFAULT_ARGB, ProjectScene.color(bad))
    }

    @Test fun deltasBuildTheActivePlatesDrawsPagedRemovedAndRebuilt() {
        val scene = ProjectScene()
        assertNull(scene.cursor)
        val first = scene.request(0, null)
        assertTrue(first.base is ProjectIntents.OptionalRenderCursor.Absent && first.target is ProjectIntents.OptionalRenderCursor.Absent)
        assertEquals(ProjectScene.PAGE, first.count)
        // A full sync paged in two: the second page names the first's target.
        val one = cursor(1)
        assertEquals(3L, scene.apply(page(null, one, 5, plate("p1", true), plate("p2", false, 1.0),
            instance("i1", "o1", "p1", transform(t = listOf(10.0, 0.0, 0.0)))), 0))
        assertNull(scene.cursor)
        val second = scene.request(3, one)
        assertEquals(one, (second.target as ProjectIntents.OptionalRenderCursor.Value).value)
        assertTrue(second.base is ProjectIntents.OptionalRenderCursor.Absent)
        assertNull(scene.apply(page(null, one, 5,
            volume("v1", "o1", "a1", transform(t = listOf(0.0, 5.0, 0.0)), "#ff0000"), volume("v2", "o1", "a2")), 3))
        assertEquals(one, scene.cursor)
        val draws = scene.draws()
        assertEquals(listOf("i1/v1", "i1/v2"), draws.map { it.key })
        assertEquals(0xffff0000.toInt(), draws[0].argb)
        assertEquals(ProjectScene.DEFAULT_ARGB, draws[1].argb)
        assertEquals(setOf("a1", "a2"), scene.assets())
        // The instance's transform after the volume's.
        near(Point3(11.0, 5.0, 0.0), draws[0].transform.point(Point3(1.0, 0.0, 0.0)))
        // A delta from the applied snapshot: another instance, then the first object's volume removed.
        val two = cursor(2)
        val next = scene.request(0, null)
        assertEquals(one, (next.base as ProjectIntents.OptionalRenderCursor.Value).value)
        assertNull(scene.apply(page(one, two, 2, ProjectIntents.RenderChange.RemoveVolume(units("v2")), instance("i2", "o1", "p1")), 0))
        assertEquals(listOf("i1/v1", "i2/v1"), scene.draws().map { it.key })
        // Switching plates: the other plate is empty.
        val three = cursor(3)
        assertNull(scene.apply(page(two, three, 2, plate("p1", false), plate("p2", true, 1.0)), 0))
        assertEquals(emptyList<ProjectScene.Draw>(), scene.draws())
        assertNull(scene.apply(page(three, cursor(4), 1, instance("i3", "o1", "p2")), 0))
        assertEquals(listOf("i3/v1"), scene.draws().map { it.key })
        // Without an active plate nothing is drawn.
        assertNull(scene.apply(page(cursor(4), cursor(5), 1, ProjectIntents.RenderChange.RemovePlate(units("p2"))), 0))
        assertEquals(emptyList<ProjectScene.Draw>(), scene.draws())
        // The session no longer holds the base: answered from empty, the scene rebuilds.
        val rebuilt = cursor(9)
        assertNull(scene.apply(page(null, rebuilt, 3, plate("p9", true), instance("i9", "o9", "p9"), volume("v9", "o9", "a9")), 0))
        assertEquals(listOf("i9/v9"), scene.draws().map { it.key })
        assertEquals(rebuilt, scene.cursor)
    }

    @Test fun aMismatchedOrLateEmptyBaseRestartsTheTargetFromEmpty() {
        val scene = ProjectScene()
        assertNull(scene.apply(page(null, cursor(1), 2, plate("p1", true), instance("i1", "o1", "p1")), 0))
        // A page for some other base: page the target again, from empty.
        assertEquals(0L, scene.apply(page(cursor(7), cursor(8), 1, volume("v1", "o1", "a1")), 0))
        assertTrue(scene.request(0, cursor(8)).base is ProjectIntents.OptionalRenderCursor.Absent)
        assertEquals(1L, scene.apply(page(null, cursor(8), 3, plate("p1", true)), 0))
        assertTrue(scene.request(1, cursor(8)).base is ProjectIntents.OptionalRenderCursor.Absent)
        assertNull(scene.apply(page(null, cursor(8), 3, instance("i1", "o1", "p1"), volume("v1", "o1", "a1")), 1))
        assertEquals(listOf("i1/v1"), scene.draws().map { it.key })
        // Paging a delta, a later page answered from empty: start over from empty.
        assertEquals(1L, scene.apply(page(cursor(8), cursor(9), 2, instance("i2", "o1", "p1")), 0))
        assertEquals(0L, scene.apply(page(null, cursor(9), 2, volume("v2", "o1", "a2")), 1))
        assertTrue(scene.draws().isEmpty())
    }

    /** A packet assembled as `mesh_packet.rs` packs one. */
    private class Packet(val indexBytes: Int, val chunks: List<Pair<FloatArray, IntArray>>) : MeshPacketSource {
        val data: ByteArray
        override val packet: ProjectIntents.MeshPacket
        private val table = mutableListOf<ProjectMeshPacket.Chunk>()
        init {
            var offset = chunks.size * 16L
            var first = 0L
            for ((positions, indices) in chunks) {
                val vertices = positions.size / 3L
                table += ProjectMeshPacket.Chunk(first, indices.size / 3L, vertices, offset)
                offset += (vertices * 24 + indices.size * indexBytes.toLong() + 3) / 4 * 4
                first += indices.size / 3
            }
            val buffer = ByteBuffer.allocate(offset.toInt()).order(ByteOrder.LITTLE_ENDIAN)
            table.forEachIndexed { n, chunk ->
                buffer.putInt(n * 16, chunk.firstTriangle.toInt()).putInt(n * 16 + 4, chunk.triangleCount.toInt())
                    .putInt(n * 16 + 8, chunk.vertexCount.toInt()).putInt(n * 16 + 12, chunk.byteOffset.toInt())
            }
            for ((index, chunk) in table.withIndex()) {
                val (positions, indices) = chunks[index]
                var at = chunk.byteOffset.toInt()
                for (value in positions) { buffer.putFloat(at, value); at += 4 }
                for (value in positions) { buffer.putFloat(at, 0f); at += 4 } // Normals: unused by the shading.
                for (value in indices) {
                    if (indexBytes == 2) buffer.putShort(at, value.toShort()) else buffer.putInt(at, value)
                    at += indexBytes
                }
            }
            data = buffer.array()
            packet = ProjectIntents.MeshPacket(listOf(97), listOf(), chunks.sumOf { it.first.size / 3L }, first,
                ProjectIntents.OptionalMeshPacketBounds.Absent(ProjectIntents.Empty), indexBytes.toLong(), table.size.toLong(), offset)
        }
        override fun chunks() = table.toList()
        override fun bytes(start: Long, count: Long) = data.copyOfRange(start.toInt(), (start + count).toInt())
    }

    private val up = Packet(2, listOf(
        // A facet facing up (+Z) and one facing down.
        floatArrayOf(0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f) to intArrayOf(0, 1, 2, 0, 2, 1),
        // A second chunk: a facet facing away from the light (-X, +Y).
        floatArrayOf(5f, 5f, 5f, 5f, 15f, 5f, 5f, 5f, 15f) to intArrayOf(0, 1, 2),
    ))

    @Test fun packetsDecodeIntoOneShadedMeshAcrossChunks() {
        for (width in listOf(2, 4)) {
            val source = Packet(width, up.chunks)
            val mesh = PacketMeshes.mesh("asset", source)
            assertEquals(3, mesh.facetCount)
            near(Point3(10.0, 0.0, 0.0), mesh.vertex(0, 1))
            // The second chunk's local indices land on its own vertices.
            near(Point3(5.0, 15.0, 5.0), mesh.vertex(2, 1))
            val light = Point3(.4, -.55, .75).normalized()
            assertEquals(PacketMeshes.shade(Point3(0.0, 0.0, 1.0)), mesh.colors[0])
            assertEquals(0xff000000.toInt() or (Math.round((.35 + .65 * light.z) * 255).toInt() * 0x010101), mesh.colors[0])
            // Facing down, away from the light: the ambient shade only.
            assertEquals(0xff595959.toInt(), mesh.colors[1])
            assertEquals(PacketMeshes.shade(Point3(1.0, 0.0, 0.0)), mesh.colors[2])
            assertEquals(0xff595959.toInt(), PacketMeshes.shade(null))
        }
    }

    @Test fun indexedPayloadsDecodeIntoOneShadedMesh() {
        // Two triangles of a unit square in z = 0, then one facing +x: float32 positions, then uint32 indices.
        val positions = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 1f, 1f, 0f, 0f, 1f, 0f, 1f, 0f, 1f)
        val indices = intArrayOf(0, 1, 2, 0, 2, 3, 1, 2, 4)
        val bytes = ByteBuffer.allocate(positions.size * 4 + indices.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        positions.forEach { bytes.putFloat(it) }
        indices.forEach { bytes.putInt(it) }
        val mesh = PacketMeshes.indexed("preview", bytes.array(), 5, 3)
        assertEquals(3, mesh.facetCount)
        near(Point3(1.0, 1.0, 0.0), mesh.vertex(0, 2))
        assertEquals(PacketMeshes.shade(Point3(0.0, 0.0, 1.0)), mesh.colors[0])
        assertEquals(PacketMeshes.shade(Point3(1.0, 0.0, 0.0)), mesh.colors[2])
        assertThrows(IllegalArgumentException::class.java) { PacketMeshes.indexed("short", bytes.array().copyOf(50), 5, 3) }
        val outside = bytes.array().copyOf().also { ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(60, 9) }
        assertThrows(IllegalArgumentException::class.java) { PacketMeshes.indexed("outside", outside, 5, 3) }
    }
    @Test fun malformedPacketsAreRefused() {
        fun refused(source: MeshPacketSource) = assertThrows(IllegalArgumentException::class.java) { PacketMeshes.mesh("bad", source) }
        // An index past its chunk's vertices.
        refused(Packet(2, listOf(floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f) to intArrayOf(0, 1, 3))))
        // A chunk table that claims more bytes than the packet has.
        val short = Packet(4, up.chunks)
        refused(object : MeshPacketSource by short {
            override val packet = short.packet.copy(byteLength = short.packet.byteLength - 4)
        })
        // A triangle count the chunks do not add up to.
        refused(object : MeshPacketSource by short {
            override val packet = short.packet.copy(triangleCount = 4)
        })
        // An index width the session never writes.
        refused(object : MeshPacketSource by short {
            override val packet = short.packet.copy(indexBytes = 3)
        })
    }
}
