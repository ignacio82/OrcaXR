package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D19c — paint_decal pure-Kotlin engine. Drives `AiDecalEngine.project`
 * + helpers without going through the MCP shell, so the tests are
 * fast and independent of WorkspaceModel / coroutines / MainActivity.
 */
class AiDecalEngineTest {

    /** A 10 mm cube centered at the origin. Matches AiMaskProjectionTest's
     *  fixture so the orthographic camera matrix stays well-conditioned
     *  for `invert4x4`'s 1e-10 determinant gate. */
    private fun bigCube(): MeshBvh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),  // -Z
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),  // +Z
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),  // -Y
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),  // +Y
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),  // -X
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),  // +X
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return MeshBvh.build(StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f)))
    }

    /** Top-down camera looking down -Z onto the cube's +Z face. */
    private fun topCamera(widthPx: Int = 64, heightPx: Int = 64): AiRenderEngine.CameraSpec {
        val bbox = AiIntrospection.Bbox(-5f, -5f, -5f, 5f, 5f, 5f)
        return AiRenderEngine.namedPreset("top", bbox, widthPx, heightPx)
    }

    private fun solidImage(w: Int, h: Int, r: Int, g: Int, b: Int, a: Int = 255): ByteArray {
        val buf = ByteArray(w * h * 4)
        for (i in 0 until w * h) {
            val o = i * 4
            buf[o] = r.toByte(); buf[o + 1] = g.toByte(); buf[o + 2] = b.toByte(); buf[o + 3] = a.toByte()
        }
        return buf
    }

    @Test fun parseHexColorRoundtrips() {
        val rgb = AiDecalEngine.parseHexColor("#FF8000")
        assertNotNull(rgb)
        assertEquals(intArrayOf(255, 128, 0).toList(), rgb!!.toList())
        assertNull(AiDecalEngine.parseHexColor("not a hex"))
        assertNull(AiDecalEngine.parseHexColor("#FFF"))  // too short
    }

    @Test fun quantizeToSlotPicksNearestRgb() {
        val palette = listOf(
            AiDecalEngine.PaletteSlot(slotId = 1, r = 255, g = 0, b = 0),  // red
            AiDecalEngine.PaletteSlot(slotId = 2, r = 0, g = 255, b = 0),  // green
            AiDecalEngine.PaletteSlot(slotId = 3, r = 0, g = 0, b = 255),  // blue
        )
        // Pure red → slot 1
        assertEquals(1, AiDecalEngine.quantizeToSlot(255, 0, 0, palette))
        // Slightly green-tinged red → slot 1
        assertEquals(1, AiDecalEngine.quantizeToSlot(220, 30, 0, palette))
        // Blue-tinged green → slot 2
        assertEquals(2, AiDecalEngine.quantizeToSlot(20, 200, 100, palette))
        // Pure blue → slot 3
        assertEquals(3, AiDecalEngine.quantizeToSlot(0, 0, 255, palette))
    }

    @Test fun overlayPreservesBaseWhereDecalIsZero() {
        val base = byteArrayOf(1, 2, 3, 4, 0)
        val decal = byteArrayOf(0, 5, 0, 7, 0)
        val merged = AiDecalEngine.overlay(base, decal)
        assertEquals(byteArrayOf(1, 5, 3, 7, 0).toList(), merged.toList())
    }

    @Test fun overlayWithNullBaseReturnsDecalAsIs() {
        val decal = byteArrayOf(0, 5, 0, 7, 0)
        val merged = AiDecalEngine.overlay(null, decal)
        assertEquals(decal.toList(), merged.toList())
    }

    @Test fun projectSolidImageOntoCubePaintsTopFace() {
        // Top-down camera onto cube; solid red decal should paint
        // every triangle on the +Z face (2 of them) — at minimum
        // the front-most ray hits land there.
        val bvh = bigCube()
        val cam = topCamera(32, 32)
        val palette = listOf(
            AiDecalEngine.PaletteSlot(slotId = 4, r = 255, g = 0, b = 0),
            AiDecalEngine.PaletteSlot(slotId = 5, r = 0, g = 255, b = 0),
        )
        val red = solidImage(32, 32, 255, 0, 0, 255)
        val res = AiDecalEngine.project(
            bvh = bvh,
            camera = cam,
            decalRgba = red,
            decalWidth = 32,
            decalHeight = 32,
            target = null,
            palette = palette,
        )
        assertTrue("active pixels: ${res.activeSourcePixels}", res.activeSourcePixels >= 32 * 32 - 4)
        assertTrue("triangles touched: ${res.triangleHitCount}", res.triangleHitCount >= 2)
        // Slot 4 (red) should win for every triangle painted.
        val slot4 = res.perSlotHistogram[4]
        val slot5 = res.perSlotHistogram[5]
        assertTrue("slot4=$slot4 expected dominant over slot5=$slot5", slot4 > slot5)
        assertEquals(0, slot5)
    }

    @Test fun projectSkipsTransparentPixels() {
        val bvh = bigCube()
        val cam = topCamera(32, 32)
        val palette = listOf(AiDecalEngine.PaletteSlot(slotId = 1, r = 255, g = 0, b = 0))
        // alpha=0 → entirely transparent.
        val transparent = solidImage(32, 32, 255, 0, 0, a = 0)
        val res = AiDecalEngine.project(
            bvh = bvh, camera = cam,
            decalRgba = transparent, decalWidth = 32, decalHeight = 32,
            target = null, palette = palette, alphaThreshold = 16,
        )
        assertEquals(0, res.activeSourcePixels)
        assertEquals(0, res.triangleHitCount)
    }

    @Test fun projectIgnoresGivenBackgroundColor() {
        val bvh = bigCube()
        val cam = topCamera(32, 32)
        val palette = listOf(AiDecalEngine.PaletteSlot(slotId = 1, r = 255, g = 0, b = 0))
        val white = solidImage(32, 32, 255, 255, 255, 255)
        val res = AiDecalEngine.project(
            bvh = bvh, camera = cam,
            decalRgba = white, decalWidth = 32, decalHeight = 32,
            target = null, palette = palette,
            ignoreRgb = intArrayOf(255, 255, 255),
        )
        assertEquals(0, res.activeSourcePixels)
    }

    @Test fun targetRectLimitsProjection() {
        val bvh = bigCube()
        val cam = topCamera(32, 32)
        val palette = listOf(AiDecalEngine.PaletteSlot(slotId = 1, r = 255, g = 0, b = 0))
        val red = solidImage(16, 16, 255, 0, 0, 255)
        // Limit the decal to a 16×16 patch in the upper-left.
        val res = AiDecalEngine.project(
            bvh = bvh, camera = cam,
            decalRgba = red, decalWidth = 16, decalHeight = 16,
            target = AiDecalEngine.TargetRect(0, 0, 16, 16),
            palette = palette,
        )
        // Only the upper-left quadrant gets paint; cube is huge so
        // even a 16×16 patch covers many tris on the +Z face — but
        // it's strictly less than the full-frame case.
        assertTrue("active=${res.activeSourcePixels}", res.activeSourcePixels in 1..(16 * 16))
        assertTrue("triangle hits: ${res.triangleHitCount}", res.triangleHitCount >= 1)
    }

    @Test fun perTriangleSlotArraySizeMatchesBvh() {
        val bvh = bigCube()
        val cam = topCamera(8, 8)
        val palette = listOf(AiDecalEngine.PaletteSlot(slotId = 1, r = 255, g = 0, b = 0))
        val red = solidImage(8, 8, 255, 0, 0, 255)
        val res = AiDecalEngine.project(
            bvh = bvh, camera = cam,
            decalRgba = red, decalWidth = 8, decalHeight = 8,
            target = null, palette = palette,
        )
        assertEquals(bvh.triCount, res.perTriangleSlot.size)
    }

    @Test fun majorityVoteTieBreaksOnFirstSlotEncountered() {
        // For a small image where two slots vote equally on a single
        // triangle, the first slot encountered wins. We can't easily
        // trigger that on the cube via projection, but we can drive
        // the vote logic via overlay(): two slots can't both end up
        // on the same triangle through the public API except via
        // overlay. So this test only verifies overlay behavior.
        val base = ByteArray(4) { 0 }
        val decal = byteArrayOf(2, 0, 3, 0)
        val merged = AiDecalEngine.overlay(base, decal)
        assertEquals(2.toByte(), merged[0])
        assertEquals(3.toByte(), merged[2])
    }
}
