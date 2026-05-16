package dev.orcaxr.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests for [SemanticPaintPlanner] — pure plan → per-triangle paint. */
class SemanticPaintPlannerTest {

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

    private val palette = AutoPaintImageEngine.paletteFromHex(
        listOf("#FF0000", "#00FF00", "#0000FF"), // slots 1,2,3
    )

    private fun frontCam(bvh: MeshBvh) =
        AiRenderEngine.namedPreset("front", AutoPaintImageEngine.bboxOf(bvh), 64, 64)

    @Test fun baseColorFillsEverythingAndRegionOverwritesProjectedTriangles() {
        val bvh = cubeBvh()
        val cam = frontCam(bvh)
        // base = blue (slot 3); one region = red (slot 1) covering the
        // whole frame so it lands on the front-facing triangles.
        val plan = JSONObject(
            """{"base_color":"#0000FF","regions":[
                 {"name":"front","color":"#FF0000",
                  "polygons":[[0,0,63,0,63,63,0,63]]}]}""",
        )
        val r = SemanticPaintPlanner.resolve(bvh, cam, plan, palette)!!
        assertEquals(3, r.baseSlot)
        assertEquals(bvh.triCount, r.perTriangleSlot.size)
        assertTrue("full coverage", r.perTriangleSlot.none { it.toInt() == 0 })
        assertEquals(1, r.regions.size)
        val rs = r.regions[0]
        assertEquals("front", rs.name)
        assertEquals(1, rs.slot)
        assertTrue("region hit some triangles", rs.triangleCount > 0)
        // Every triangle is base (3) or the region slot (1); the region
        // count matches the number of slot-1 triangles.
        for (s in r.perTriangleSlot) assertTrue(s.toInt() == 3 || s.toInt() == 1)
        assertEquals(rs.triangleCount, r.perTriangleSlot.count { it.toInt() == 1 })
    }

    @Test fun missingOrBadBaseColorYieldsNull() {
        val bvh = cubeBvh()
        assertNull(SemanticPaintPlanner.resolve(bvh, frontCam(bvh), JSONObject("{}"), palette))
        assertNull(SemanticPaintPlanner.resolve(
            bvh, frontCam(bvh), JSONObject("""{"base_color":"nothex"}"""), palette,
        ))
    }

    @Test fun emptyPaletteYieldsNull() {
        val bvh = cubeBvh()
        assertNull(SemanticPaintPlanner.resolve(
            bvh, frontCam(bvh), JSONObject("""{"base_color":"#FFFFFF"}"""), emptyList(),
        ))
    }

    @Test fun unparseableRegionColorIsSkippedNotFatal() {
        val bvh = cubeBvh()
        val plan = JSONObject(
            """{"base_color":"#00FF00","regions":[
                 {"name":"bad","color":"xyz","polygons":[[0,0,10,0,10,10]]},
                 {"name":"good","color":"#FF0000","polygons":[[0,0,63,0,63,63,0,63]]}]}""",
        )
        val r = SemanticPaintPlanner.resolve(bvh, frontCam(bvh), plan, palette)!!
        assertEquals(2, r.regions.size)
        assertEquals(0, r.regions[0].triangleCount) // bad color → skipped
        assertTrue(r.regions[1].triangleCount > 0)
        assertTrue("full coverage", r.perTriangleSlot.none { it.toInt() == 0 })
    }

    @Test fun degeneratePolygonsLeaveRegionEmptyButPlanSucceeds() {
        val bvh = cubeBvh()
        val plan = JSONObject(
            """{"base_color":"#0000FF","regions":[
                 {"name":"degenerate","color":"#FF0000","polygons":[[1,2]]}]}""",
        )
        val r = SemanticPaintPlanner.resolve(bvh, frontCam(bvh), plan, palette)!!
        assertEquals(0, r.regions[0].triangleCount)
        assertTrue(r.perTriangleSlot.all { it.toInt() == 3 }) // all base
    }

    @Test fun noRegionsPaintsWholeModelBase() {
        val bvh = cubeBvh()
        val plan = JSONObject("""{"base_color":"#00FF00","regions":[]}""")
        val r = SemanticPaintPlanner.resolve(bvh, frontCam(bvh), plan, palette)!!
        assertEquals(2, r.baseSlot) // green = slot 2
        assertTrue(r.perTriangleSlot.all { it.toInt() == 2 })
    }
}
