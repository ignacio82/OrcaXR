package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests for [AutoPaintImageEngine] — the M2 image-projection core. */
class AutoPaintImageEngineTest {

    private fun cubeBvh(): MeshBvh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2), intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4), intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3), intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return MeshBvh.build(StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f)))
    }

    private fun solidRgba(w: Int, h: Int, r: Int, g: Int, b: Int, a: Int = 255): ByteArray {
        val rgba = ByteArray(w * h * 4)
        for (i in 0 until w * h) {
            val o = i * 4
            rgba[o] = r.toByte(); rgba[o + 1] = g.toByte(); rgba[o + 2] = b.toByte(); rgba[o + 3] = a.toByte()
        }
        return rgba
    }

    private fun palette() = AutoPaintImageEngine.paletteFromHex(
        listOf("#FF0000", "#00FF00", "#0000FF", "#FFFF00"),
    )

    @Test fun paletteFromHexSkipsBlanksAndIsOneBased() {
        val p = AutoPaintImageEngine.paletteFromHex(listOf("#FF0000", "", "bad", "#0000FF"))
        assertEquals(2, p.size)
        assertEquals(1, p[0].slot)   // index 0 → slot 1
        assertEquals(4, p[1].slot)   // index 3 → slot 4
    }

    @Test fun bboxOfMapsBvhExtents() {
        val b = AutoPaintImageEngine.bboxOf(cubeBvh())
        assertEquals(-5f, b.minX, 1e-4f)
        assertEquals(5f, b.maxZ, 1e-4f)
    }

    @Test fun projectColorsVisibleTrianglesAndQuantizesPerceptually() {
        val bvh = cubeBvh()
        val cam = AiRenderEngine.namedPreset(
            "front", AutoPaintImageEngine.bboxOf(bvh), 128, 128,
        )
        // Red image; background keyed to a color not present so the
        // whole frame is foreground.
        val img = solidRgba(64, 64, 255, 0, 0)
        val res = AutoPaintImageEngine.project(
            bvh, cam, img, 64, 64, palette(), backgroundRgb = intArrayOf(0, 255, 0),
        )
        assertTrue("some triangles covered", res.coveredTriangles > 0)
        assertTrue("pixels sampled", res.sampledPixels > 0)
        // Every covered triangle quantized to slot 1 (#FF0000).
        var sawSlot1 = false
        for (s in res.perTriangleSlot) {
            val v = s.toInt()
            assertTrue("slot is 0 or 1", v == 0 || v == 1)
            if (v == 1) sawSlot1 = true
        }
        assertTrue(sawSlot1)
    }

    @Test fun finalizeCoverageFillsEverythingAfterProjection() {
        val bvh = cubeBvh()
        val cam = AiRenderEngine.namedPreset("front", AutoPaintImageEngine.bboxOf(bvh), 128, 128)
        val img = solidRgba(64, 64, 0, 0, 255) // blue
        val res = AutoPaintImageEngine.project(
            bvh, cam, img, 64, 64, palette(), backgroundRgb = intArrayOf(255, 0, 0),
        )
        val slots = res.perTriangleSlot
        assertTrue(AutoPaintImageEngine.finalizeCoverage(bvh, slots))
        assertTrue("full coverage", slots.none { it.toInt() == 0 })
        // Blue → slot 3 (#0000FF) should dominate.
        assertTrue(slots.count { it.toInt() == 3 } > 0)
        // No-op contract: all-zero array → false, untouched.
        val empty = ByteArray(bvh.triCount)
        assertFalse(AutoPaintImageEngine.finalizeCoverage(bvh, empty))
        assertTrue(empty.all { it.toInt() == 0 })
    }

    @Test fun emptyInputsAreSafe() {
        val bvh = cubeBvh()
        val cam = AiRenderEngine.namedPreset("front", AutoPaintImageEngine.bboxOf(bvh), 64, 64)
        // Empty palette → no work, no crash.
        val r = AutoPaintImageEngine.project(bvh, cam, solidRgba(8, 8, 1, 2, 3), 8, 8, emptyList())
        assertEquals(0, r.coveredTriangles)
        assertEquals(bvh.triCount, r.perTriangleSlot.size)
    }

    @Test fun bestPresetBySilhouetteReturnsHighIouForMatchingShape() {
        val bvh = cubeBvh()
        // A cube's face-on silhouette is a filled square; a full
        // opaque frame normalizes to an all-true mask, so at least one
        // face preset must score near-perfect IoU.
        val img = solidRgba(80, 80, 200, 100, 50)
        val (name, cam, iou) = AutoPaintImageEngine.bestPresetBySilhouette(
            bvh, img, 80, 80, widthPx = 200, heightPx = 150,
            backgroundRgb = intArrayOf(0, 0, 0),
        )
        assertTrue("preset is a known preset", name in AiRenderEngine.NAMED_PRESETS)
        assertTrue("camera carries requested dims", cam.widthPx == 200 && cam.heightPx == 150)
        assertTrue("high silhouette IoU, was $iou", iou > 0.9)
    }
}
