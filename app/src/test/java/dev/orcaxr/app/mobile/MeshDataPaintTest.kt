package dev.orcaxr.app.mobile

import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mobile.viewer.MeshData
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the per-paint-slot recolor pipeline that drives the mobile GL
 * viewer's per-triangle coloring. Three things have to all hold:
 *  1. recolorByPaint flips hasPerVertexColor true.
 *  2. resetToUniformColor flips it back and rewrites every vertex to
 *     white so the next draw uses the uniform u_Color.
 *  3. Out-of-range / 0 slot indices fall back to the unpaintedRgba.
 */
class MeshDataPaintTest {

    private fun simpleMesh(): MeshData {
        // Two triangles: tri 0 at z=0, tri 1 at z=10 — small enough for
        // the test, real enough that face-normal generation runs.
        val positions =
            floatArrayOf(
                0f, 0f, 0f, 10f, 0f, 0f, 0f, 10f, 0f,
                0f, 0f, 10f, 10f, 0f, 10f, 0f, 10f, 10f,
            )
        val mesh =
            StlMesh(
                positions = positions,
                triCount = 2,
                bboxMin = Vec3f(0f, 0f, 0f),
                bboxMax = Vec3f(10f, 10f, 10f),
            )
        return MeshData.fromStlMesh(mesh)
    }

    @Test
    fun recolorByPaintFlipsHasPerVertexColor() {
        val md = simpleMesh()
        assertFalse("starts uniform", md.hasPerVertexColor)
        md.recolorByPaint(
            palette = listOf(floatArrayOf(1f, 0f, 0f, 1f)),
            paintFilamentIndex = byteArrayOf(1, 1),
        )
        assertTrue("flips after paint", md.hasPerVertexColor)
    }

    @Test
    fun recolorByPaintWritesPerTriangleColor() {
        val md = simpleMesh()
        md.recolorByPaint(
            palette =
                listOf(
                    floatArrayOf(1f, 0f, 0f, 1f), // slot 1 = red
                    floatArrayOf(0f, 1f, 0f, 1f), // slot 2 = green
                ),
            paintFilamentIndex = byteArrayOf(1, 2),
        )
        // Vertex 0 of tri 0 starts at offset 0; color floats live at
        // offset 6..9 within each vertex.
        val tri0Color = floatArrayOf(
            md.vertices.get(6),
            md.vertices.get(7),
            md.vertices.get(8),
            md.vertices.get(9),
        )
        assertArrayEquals("tri 0 = red", floatArrayOf(1f, 0f, 0f, 1f), tri0Color, 1e-6f)
        // Tri 1 starts at vertex 3 → byte offset 3 * 10 = 30.
        val tri1Color = floatArrayOf(
            md.vertices.get(30 + 6),
            md.vertices.get(30 + 7),
            md.vertices.get(30 + 8),
            md.vertices.get(30 + 9),
        )
        assertArrayEquals("tri 1 = green", floatArrayOf(0f, 1f, 0f, 1f), tri1Color, 1e-6f)
    }

    @Test
    fun unpaintedTrianglesGetUnpaintedRgba() {
        val md = simpleMesh()
        md.recolorByPaint(
            palette = listOf(floatArrayOf(1f, 0f, 0f, 1f)),
            paintFilamentIndex = byteArrayOf(0, 1), // tri 0 unpainted
            unpaintedRgba = floatArrayOf(0.5f, 0.5f, 0.5f, 1f),
        )
        assertEquals("unpainted R", 0.5f, md.vertices.get(6), 1e-6f)
        assertEquals("painted R", 1.0f, md.vertices.get(30 + 6), 1e-6f)
    }

    @Test
    fun outOfRangeSlotFallsBackToUnpainted() {
        val md = simpleMesh()
        md.recolorByPaint(
            palette = listOf(floatArrayOf(1f, 0f, 0f, 1f)),
            paintFilamentIndex = byteArrayOf(99, 1), // slot 99 doesn't exist
            unpaintedRgba = floatArrayOf(0.2f, 0.3f, 0.4f, 1f),
        )
        assertEquals("oo-range R", 0.2f, md.vertices.get(6), 1e-6f)
        assertEquals("oo-range G", 0.3f, md.vertices.get(7), 1e-6f)
        assertEquals("oo-range B", 0.4f, md.vertices.get(8), 1e-6f)
    }

    @Test
    fun resetToUniformColorClearsFlag() {
        val md = simpleMesh()
        md.recolorByPaint(
            palette = listOf(floatArrayOf(1f, 0f, 0f, 1f)),
            paintFilamentIndex = byteArrayOf(1, 1),
        )
        assertTrue(md.hasPerVertexColor)
        md.resetToUniformColor()
        assertFalse("clears flag", md.hasPerVertexColor)
        // Every vertex's color should now be (1,1,1,1).
        for (v in 0 until md.vertexCount) {
            val base = v * MeshData.FLOATS_PER_VERTEX + 6
            assertEquals("R", 1f, md.vertices.get(base), 1e-6f)
            assertEquals("G", 1f, md.vertices.get(base + 1), 1e-6f)
            assertEquals("B", 1f, md.vertices.get(base + 2), 1e-6f)
            assertEquals("A", 1f, md.vertices.get(base + 3), 1e-6f)
        }
    }
}
