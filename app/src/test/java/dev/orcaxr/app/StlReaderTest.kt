package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class StlReaderTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private fun createSyntheticBinaryStl(triangles: List<FloatArray>): ByteArray {
        val headerSize = 80
        val countSize = 4
        val triangleSize = 50
        val totalSize = headerSize + countSize + triangles.size * triangleSize
        val bytes = ByteArray(totalSize)
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

        // 80 bytes header
        buf.position(headerSize)

        // 4 bytes triangle count
        buf.putInt(triangles.size)

        // Write each triangle
        for (tri in triangles) {
            // Normal (12 bytes)
            buf.putFloat(0f).putFloat(0f).putFloat(1f)
            // Vertex 0 (12 bytes)
            buf.putFloat(tri[0]).putFloat(tri[1]).putFloat(tri[2])
            // Vertex 1 (12 bytes)
            buf.putFloat(tri[3]).putFloat(tri[4]).putFloat(tri[5])
            // Vertex 2 (12 bytes)
            buf.putFloat(tri[6]).putFloat(tri[7]).putFloat(tri[8])
            // Attribute byte count (2 bytes)
            buf.putShort(0)
        }

        return bytes
    }

    @Test
    fun testParseValidBinaryStl() {
        // Synthetic 2-triangle STL (a simple quad on the XY plane)
        val triangle1 = floatArrayOf(
            0f, 0f, 0f,
            10f, 0f, 0f,
            0f, 10f, 0f
        )
        val triangle2 = floatArrayOf(
            10f, 0f, 0f,
            10f, 10f, 0f,
            0f, 10f, 0f
        )
        val stlBytes = createSyntheticBinaryStl(listOf(triangle1, triangle2))

        val file = tempFolder.newFile("quad.stl")
        file.writeBytes(stlBytes)

        // Test triangle count and validation
        assertTrue(StlReader.isBinary(file))
        assertEquals(2, StlReader.readTriangleCount(file))

        // Test full parsing
        val mesh = StlReader.read(file)
        assertEquals(2, mesh.triCount)
        assertEquals(18, mesh.positions.size)
        
        // Assert positions
        assertEquals(0f, mesh.positions[0], 1e-5f)
        assertEquals(10f, mesh.positions[3], 1e-5f)
        assertEquals(10f, mesh.positions[13], 1e-5f)

        // Assert bounding box
        assertEquals(0f, mesh.bboxMin.x, 1e-5f)
        assertEquals(0f, mesh.bboxMin.y, 1e-5f)
        assertEquals(0f, mesh.bboxMin.z, 1e-5f)
        assertEquals(10f, mesh.bboxMax.x, 1e-5f)
        assertEquals(10f, mesh.bboxMax.y, 1e-5f)
        assertEquals(0f, mesh.bboxMax.z, 1e-5f)
    }

    @Test
    fun testEmptyBinaryStl() {
        val stlBytes = createSyntheticBinaryStl(emptyList())
        val file = tempFolder.newFile("empty.stl")
        file.writeBytes(stlBytes)

        assertTrue(StlReader.isBinary(file))
        assertEquals(0, StlReader.readTriangleCount(file))

        val mesh = StlReader.read(file)
        assertEquals(0, mesh.triCount)
        assertEquals(0, mesh.positions.size)
        assertEquals(0f, mesh.bboxMin.x, 1e-5f)
        assertEquals(0f, mesh.bboxMax.z, 1e-5f)
    }

    @Test
    fun testCorruptTriangleCount() {
        val stlBytes = createSyntheticBinaryStl(listOf(floatArrayOf(0f,0f,0f, 0f,0f,0f, 0f,0f,0f)))
        // Corrupt the byte size to mismatch the triangle count
        val corruptedBytes = stlBytes.copyOfRange(0, stlBytes.size - 10)
        val file = tempFolder.newFile("corrupt.stl")
        file.writeBytes(corruptedBytes)

        assertFalse(StlReader.isBinary(file))
    }

    @Test
    fun testAsciiStlFailsValidation() {
        val file = tempFolder.newFile("ascii.stl")
        file.writeText(
            """
            solid ASCII_Triangle
              facet normal 0 0 1
                outer loop
                  vertex 0 0 0
                  vertex 10 0 0
                  vertex 0 10 0
                endloop
              endfacet
            endsolid ASCII_Triangle
            """.trimIndent()
        )

        assertFalse(StlReader.isBinary(file))
    }
}
