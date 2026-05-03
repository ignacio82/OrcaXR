package dev.orcaxr.app

import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.imageio.ImageIO

class RenderAnnotationTest {

    private fun mesh(positions: FloatArray): StlMesh {
        val n = positions.size / 9
        var minX = Float.POSITIVE_INFINITY; var minY = Float.POSITIVE_INFINITY; var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY; var maxY = Float.NEGATIVE_INFINITY; var maxZ = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < positions.size) {
            val x = positions[i]; val y = positions[i + 1]; val z = positions[i + 2]
            if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z
            if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z
            i += 3
        }
        if (n == 0) {
            minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f
        }
        return StlMesh(positions, n, Vec3f(minX, minY, minZ), Vec3f(maxX, maxY, maxZ))
    }

    private val cube: StlMesh by lazy {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) {
            for (k in 0 until 3) {
                pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
            }
        }
        mesh(pos)
    }

    @Test fun annotatedRenderDiffersFromUnannotated() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 256, 256)
        val plain = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid, annotate = false)
        val annot = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid, annotate = true)
        assertNotEquals(
            "annotated PNG should differ from plain (overlays drawn)",
            plain.pngBytes.toList(),
            annot.pngBytes.toList(),
        )
    }

    @Test fun annotatedRenderHasRedGreenBlueTriadPixels() {
        // Burn-in axis triad is R/G/B; check that the bottom-left
        // corner of the rendered PNG contains pixels of those
        // colors.
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 256, 256)
        val annot = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid, annotate = true)
        val img = ImageIO.read(java.io.ByteArrayInputStream(annot.pngBytes))
        // Search the bottom-left 64x64 corner.
        var sawRed = false
        var sawGreen = false
        var sawBlue = false
        for (y in 256 - 64 until 256) {
            for (x in 0 until 64) {
                val argb = img.getRGB(x, y)
                val r = (argb shr 16) and 0xff
                val g = (argb shr 8) and 0xff
                val b = argb and 0xff
                if (r > 200 && g < 80 && b < 80) sawRed = true
                if (g > 200 && r < 80 && b < 80) sawGreen = true
                if (b > 200 && r < 80 && g < 120) sawBlue = true
            }
        }
        assertTrue("expected red pixels in axis triad", sawRed)
        assertTrue("expected green pixels in axis triad", sawGreen)
        assertTrue("expected blue pixels in axis triad", sawBlue)
    }

    @Test fun triangleIdRenderSkipsAnnotations() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("top", geom.bboxCenteredPreview, 64, 64)
        val plain = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.TriangleId, annotate = false)
        val withAnnot = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.TriangleId, annotate = true)
        // TriangleId mode skips annotations to preserve per-pixel ID
        // encoding. Both should produce identical output.
        assertTrue(
            "TriangleId mode must ignore annotate",
            plain.pngBytes.toList() == withAnnot.pngBytes.toList(),
        )
    }
}
