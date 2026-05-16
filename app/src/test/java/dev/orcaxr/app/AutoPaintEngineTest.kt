package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for [AutoPaintEngine] — the M1 deterministic geometric
 * auto-paint strategies. Fixtures are axis-aligned 10 mm cubes (12
 * triangles each); a multi-cube fixture exercises connected-component
 * segmentation (the cubes share no vertices so each is its own shell).
 */
class AutoPaintEngineTest {

    private fun meshOf(positions: FloatArray): StlMesh {
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
        if (n == 0) { minX = 0f; minY = 0f; minZ = 0f; maxX = 0f; maxY = 0f; maxZ = 0f }
        return StlMesh(positions, n, Vec3f(minX, minY, minZ), Vec3f(maxX, maxY, maxZ))
    }

    /** 12-triangle cube centred at (cx,cy,cz), half-extent 5 mm. */
    private fun cubeAt(cx: Float, cy: Float, cz: Float): FloatArray {
        val v = arrayOf(
            floatArrayOf(cx - 5, cy - 5, cz - 5), floatArrayOf(cx + 5, cy - 5, cz - 5),
            floatArrayOf(cx + 5, cy + 5, cz - 5), floatArrayOf(cx - 5, cy + 5, cz - 5),
            floatArrayOf(cx - 5, cy - 5, cz + 5), floatArrayOf(cx + 5, cy - 5, cz + 5),
            floatArrayOf(cx + 5, cy + 5, cz + 5), floatArrayOf(cx - 5, cy + 5, cz + 5),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),   // 0,1 bottom z=cz-5
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),   // 2,3 top z=cz+5
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),   // 4,5 -Y
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),   // 6,7 +Y
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),   // 8,9 -X
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),   // 10,11 +X
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0 until 3) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return pos
    }

    private fun concat(vararg arrs: FloatArray): FloatArray {
        val out = FloatArray(arrs.sumOf { it.size })
        var o = 0
        for (a in arrs) { a.copyInto(out, o); o += a.size }
        return out
    }

    private val cube by lazy { MeshBvh.build(meshOf(cubeAt(0f, 0f, 0f))) }

    @Test fun heightBandsIsFullCoverageMonotonicAndBounded() {
        val r = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, paletteSize = 4)
        assertTrue("every triangle painted", AutoPaintEngine.isFullCoverage(r.perTriangleSlot))
        for (s in r.perTriangleSlot) assertTrue("slot in 1..4", s.toInt() in 1..4)
        // Bottom faces (centroid z=-5) → band 0 → slot 1.
        assertEquals(1, r.perTriangleSlot[0].toInt())
        assertEquals(1, r.perTriangleSlot[1].toInt())
        // Top faces (centroid z=+5, t==1) → last band → slot 4.
        assertEquals(4, r.perTriangleSlot[2].toInt())
        assertEquals(4, r.perTriangleSlot[3].toInt())
        // The two -Y side triangles split the square diagonally, so
        // their centroids sit at z≈-1.667 (t=0.333 → band 1 → slot 2)
        // and z≈+1.667 (t=0.667 → band 2 → slot 3) — monotonic in z.
        assertEquals(2, r.perTriangleSlot[4].toInt())
        assertEquals(3, r.perTriangleSlot[5].toInt())
        assertEquals("Z is the default axis recorded", "height_bands", r.strategy)
    }

    @Test fun heightBandsIsDeterministic() {
        val a = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, 5)
        val b = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, 5)
        assertTrue(a.perTriangleSlot.contentEquals(b.perTriangleSlot))
        assertTrue(a.perSlotHistogram.contentEquals(b.perSlotHistogram))
    }

    @Test fun paletteOnePaintsEverythingSlotOne() {
        val r = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, paletteSize = 1)
        assertEquals(1, r.slotsUsed)
        for (s in r.perTriangleSlot) assertEquals(1, s.toInt())
    }

    @Test fun maxColorsCapIsRespected() {
        val r = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, paletteSize = 2)
        for (s in r.perTriangleSlot) assertTrue(s.toInt() in 1..2)
        assertTrue("uses at most 2 slots", r.slotsUsed in 1..2)
    }

    @Test fun axisXBandsAlongX() {
        val r = AutoPaintEngine.run(
            cube, AutoPaintEngine.Strategy.HeightBands, 2, AutoPaintEngine.Axis.X,
        )
        // -X faces (8,9) at x=-5 → slot 1; +X faces (10,11) at x=+5 → slot 2.
        assertEquals(1, r.perTriangleSlot[8].toInt())
        assertEquals(2, r.perTriangleSlot[10].toInt())
    }

    @Test fun componentsAssignsOneSlotPerDisconnectedShell() {
        val twoCubes = MeshBvh.build(meshOf(concat(cubeAt(0f, 0f, 0f), cubeAt(100f, 0f, 0f))))
        val r = AutoPaintEngine.run(twoCubes, AutoPaintEngine.Strategy.Components, paletteSize = 4)
        assertTrue(AutoPaintEngine.isFullCoverage(r.perTriangleSlot))
        assertEquals("two shells → two slots", 2, r.slotsUsed)
        // First cube = triangles 0..11, second = 12..23. Equal size →
        // tie-break by component id → first shell slot 1, second slot 2.
        val firstShell = (0 until 12).map { r.perTriangleSlot[it].toInt() }.toSet()
        val secondShell = (12 until 24).map { r.perTriangleSlot[it].toInt() }.toSet()
        assertEquals(setOf(1), firstShell)
        assertEquals(setOf(2), secondShell)
    }

    @Test fun componentsWrapWhenMoreShellsThanColors() {
        val threeCubes = MeshBvh.build(
            meshOf(concat(cubeAt(0f, 0f, 0f), cubeAt(100f, 0f, 0f), cubeAt(200f, 0f, 0f))),
        )
        val r = AutoPaintEngine.run(threeCubes, AutoPaintEngine.Strategy.Components, paletteSize = 2)
        // rank 0,1,2 → slots (0%2)+1, (1%2)+1, (2%2)+1 = 1,2,1.
        assertEquals(1, r.perTriangleSlot[0].toInt())
        assertEquals(2, r.perTriangleSlot[12].toInt())
        assertEquals(1, r.perTriangleSlot[24].toInt())
        assertTrue(AutoPaintEngine.isFullCoverage(r.perTriangleSlot))
    }

    @Test fun cavityIsFullCoverageDeterministicAndBounded() {
        val a = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.Cavity, paletteSize = 3)
        val b = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.Cavity, paletteSize = 3)
        assertTrue(AutoPaintEngine.isFullCoverage(a.perTriangleSlot))
        assertTrue(a.perTriangleSlot.contentEquals(b.perTriangleSlot))
        for (s in a.perTriangleSlot) assertTrue(s.toInt() in 1..3)
    }

    @Test fun emptyMeshYieldsEmptyFullCoverageResult() {
        val empty = MeshBvh.build(meshOf(FloatArray(0)))
        val r = AutoPaintEngine.run(empty, AutoPaintEngine.Strategy.HeightBands, 4)
        assertEquals(0, r.perTriangleSlot.size)
        assertEquals(0, r.slotsUsed)
        assertFalse("empty mesh is not 'full coverage'", AutoPaintEngine.isFullCoverage(r.perTriangleSlot))
    }

    @Test fun diffuseFillPropagatesIntoZeroedTrianglesAndIsNoOpWhenFull() {
        // Start from a full-coverage assignment, punch holes, refill.
        val full = AutoPaintEngine.run(cube, AutoPaintEngine.Strategy.HeightBands, 3).perTriangleSlot
        assertTrue(AutoPaintEngine.isFullCoverage(full))
        val holed = full.copyOf()
        for (i in holed.indices step 3) holed[i] = 0   // zero ~1/3 of tris
        assertFalse(AutoPaintEngine.isFullCoverage(holed))
        AutoPaintEngine.diffuseFill(cube, holed)
        assertTrue("holes inherit a neighbour slot", AutoPaintEngine.isFullCoverage(holed))
        // No-op on an already-full array (and on an all-zero array — no
        // assigned source to diffuse from).
        val fullCopy = full.copyOf()
        AutoPaintEngine.diffuseFill(cube, fullCopy)
        assertTrue(fullCopy.contentEquals(full))
        val allZero = ByteArray(cube.triCount)
        AutoPaintEngine.diffuseFill(cube, allZero)
        for (s in allZero) assertEquals(0, s.toInt())
    }

    @Test fun fromKeyParsesStrategyAndAxis() {
        assertEquals(AutoPaintEngine.Strategy.Components, AutoPaintEngine.Strategy.fromKey("components"))
        assertEquals(null, AutoPaintEngine.Strategy.fromKey("nope"))
        assertEquals(AutoPaintEngine.Axis.Y, AutoPaintEngine.Axis.fromKey("y"))
        assertEquals(null, AutoPaintEngine.Axis.fromKey("w"))
    }
}
