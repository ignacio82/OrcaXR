package dev.orcaxr.renderer.scenecore

import androidx.xr.scenecore.*
import dev.orcaxr.renderer.MeshPacking
import dev.orcaxr.renderer.TriangleMesh
import org.junit.Assert.*
import org.junit.Test

/** Executes the pinned SDK's validators, not a copied model of its API. */
class SceneCoreContractTest {
    @Test fun packedFixtureFitsTheActualSdkLayoutAndRegions() {
        val layout = SceneCoreViewport.layout()
        assertEquals(2, layout.buffers.size)
        assertEquals(VertexAttributeType.FLOAT3, layout.buffers[0].attributes.single().type)
        assertEquals(VertexAttributeType.UBYTE4_NORM, layout.buffers[1].attributes.single().type)
        val mesh = TriangleMesh.grid(128)
        val chunk = MeshPacking.chunk(mesh, 0)
        assertEquals(983_040L, chunk.bytes)
        for (buffer in listOf(chunk.positions, chunk.colors, chunk.indices)) {
            assertTrue(buffer.isDirect)
            assertEquals(buffer.capacity(), ByteBufferRegion(buffer, 0, buffer.remaining()).size)
        }
        assertEquals(16_384 * 3 * 12, chunk.positions.remaining())
        assertEquals(16_384 * 3 * 4, chunk.colors.remaining())
        assertEquals(16_384 * 3 * 4, chunk.indices.remaining())
    }
    @Test fun floatColorInputIsRejectedByPinnedSdk() {
        assertThrows(IllegalArgumentException::class.java) {
            VertexAttributeDescriptor(VertexAttribute.COLOR, VertexAttributeType.FLOAT4)
        }
        assertThrows(IllegalArgumentException::class.java) {
            VertexAttributeDescriptor(VertexAttribute.COLOR, VertexAttributeType.FLOAT3)
        }
    }
    @Test fun paintReplacementChangesOnlyTheProjectedRangeAcrossChunks() {
        val mesh = TriangleMesh.grid(128)
        var changedFacets = 0
        var replacementBytes = 0L
        for (first in listOf(0, 16_384)) {
            val original = MeshPacking.chunk(mesh, first)
            val painted = SceneCoreViewport.samplePaintChunk(mesh, first)
            assertEquals(original.positions, painted.positions)
            assertEquals(original.indices, painted.indices)
            assertEquals(original.colors, MeshPacking.chunk(mesh, first).colors)
            assertEquals(0, painted.colors.position())
            replacementBytes += painted.bytes
            repeat(painted.facetCount) { facet ->
                val inStroke = first + facet in 14_336 until 18_432
                if (inStroke) changedFacets++
                repeat(3) { corner ->
                    val at = facet * 12 + corner * 4
                    repeat(4) { component ->
                        val expected = if (inStroke) intArrayOf(0xe7, 0x4f, 0x98, 0xff)[component].toByte()
                            else original.colors.get(at + component)
                        assertEquals(expected, painted.colors.get(at + component))
                    }
                }
            }
        }
        assertEquals(4096, changedFacets)
        assertEquals(1_966_080L, replacementBytes)
    }
    @Test fun malformedRegionsAndLayoutsAreRejectedByPinnedSdk() {
        val buffer = MeshPacking.direct(16)
        assertThrows(IllegalArgumentException::class.java) { ByteBufferRegion(buffer, 4, Int.MAX_VALUE) }
        assertThrows(IllegalArgumentException::class.java) { ByteBufferRegion(buffer, -1, 4) }
        assertThrows(IllegalArgumentException::class.java) {
            VertexLayout.Builder().addAttribute(VertexAttribute.COLOR, VertexAttributeType.UBYTE4_NORM).build()
        }
    }
}
