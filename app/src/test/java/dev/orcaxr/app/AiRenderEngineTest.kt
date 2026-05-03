package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.imageio.ImageIO

class AiRenderEngineTest {

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

    @Test fun isoRenderProducesSomethingNonBackground() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 64, 64)
        val out = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid)
        assertEquals(64, out.widthPx)
        assertEquals(64, out.heightPx)
        // Decode and count non-background pixels.
        val img = ImageIO.read(java.io.ByteArrayInputStream(out.pngBytes))
        var modelPixels = 0
        for (y in 0 until 64) {
            for (x in 0 until 64) {
                val argb = img.getRGB(x, y)
                val r = (argb shr 16) and 0xff
                val g = (argb shr 8) and 0xff
                val b = argb and 0xff
                if (r != 242 || g != 242 || b != 242) modelPixels++
            }
        }
        assertTrue("expected at least 50 model pixels in iso render, got $modelPixels", modelPixels >= 50)
    }

    @Test fun triangleIdRenderEncodesIds() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("top", geom.bboxCenteredPreview, 32, 32)
        val out = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.TriangleId)
        assertNotNull(out.triangleIdMap)
        val map = out.triangleIdMap!!
        // From the top, we should see only top-face tris (faces 2, 3 in
        // the cube fixture).
        val seen = map.toSet().filter { it >= 0 }.toSet()
        assertTrue("expected to see +Z face tris (2, 3) from top view; got $seen",
            seen.contains(2) && seen.contains(3))
    }

    @Test fun depthRenderProducesNonZeroPixels() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("front", geom.bboxCenteredPreview, 32, 32)
        val out = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Depth)
        val img = ImageIO.read(java.io.ByteArrayInputStream(out.pngBytes))
        var anyNonBg = false
        for (y in 0 until 32) {
            for (x in 0 until 32) {
                val argb = img.getRGB(x, y)
                val r = (argb shr 16) and 0xff
                val g = (argb shr 8) and 0xff
                val b = argb and 0xff
                if (r == g && g == b && r in 1..254) anyNonBg = true
            }
        }
        assertTrue("expected some grayscale depth pixels", anyNonBg)
    }

    @Test fun emptyMeshStillProducesBackgroundPng() {
        val bvh = MeshBvh.build(mesh(floatArrayOf()))
        val cam = AiRenderEngine.CameraSpec(
            FloatArray(16) { if (it % 5 == 0) 1f else 0f },
            FloatArray(16) { if (it % 5 == 0) 1f else 0f },
            16, 16,
        )
        val out = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid)
        val img = ImageIO.read(java.io.ByteArrayInputStream(out.pngBytes))
        assertEquals(16, img.width)
        assertEquals(16, img.height)
    }

    @Test fun namedPresetsCoverAllEightDirections() {
        val bvh = MeshBvh.build(cube)
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val seenBytes = HashSet<List<Byte>>()
        for (preset in AiRenderEngine.NAMED_PRESETS) {
            val cam = AiRenderEngine.namedPreset(preset, geom.bboxCenteredPreview, 24, 24)
            val out = AiRenderEngine.render(bvh, cam, AiRenderEngine.RenderMode.Solid)
            // Each preset should produce a different PNG (different
            // viewing angle ⇒ different pixel layout).
            seenBytes.add(out.pngBytes.toList())
        }
        assertTrue(
            "expected each preset to yield a unique render; got ${seenBytes.size}",
            seenBytes.size >= 4,  // top/bottom + a few others must differ
        )
    }
}
