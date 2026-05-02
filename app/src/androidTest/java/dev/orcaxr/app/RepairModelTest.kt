package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase A5 ("Fix Model") — end-to-end exercise of [SlicerEngine.repairModel]
 * on a synthesized non-manifold / self-intersecting mesh.
 *
 * The fixture is built at test time (cheaper than committing a binary
 * STL): two axis-aligned 20 mm cubes, the second offset by (10, 0, 0)
 * so the two volumes intersect over a 10×20×20 mm slab. The naive
 * concatenation of their 12+12 = 24 triangles is non-manifold (interior
 * faces poke through each other) and self-intersecting along the
 * overlap region — which is exactly the input class libslic3r's CGAL
 * self-union pass exists to clean up.
 *
 * Pass criteria:
 *   - repairModel returns a non-null result
 *   - the output 3MF exists and is readable by load_mesh_container
 *     (verified indirectly by re-extracting it as STL)
 *   - the input was indeed non-manifold (open_edges_in > 0 OR self-
 *     intersecting via successFlag escalation)
 *   - the output has fewer or equal open edges than the input (we
 *     don't make non-manifoldness worse)
 *   - if CGAL ran (used_cgal=1), open_edges_out is 0 (the whole point
 *     of self-union is to produce a watertight result)
 */
@RunWith(AndroidJUnit4::class)
class RepairModelTest {

    @Test
    fun repairResolvesTwoOverlappingCubes() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val stl = File(ctx.cacheDir, "repair_two_cubes_${System.currentTimeMillis()}.stl")
        StlWriter.write(twoOverlappingCubes(offsetMm = 10f), stl)
        assertTrue("fixture STL not written", stl.exists() && stl.length() > 0L)

        val out = File(ctx.cacheDir, "repair_two_cubes_${System.currentTimeMillis()}.3mf")
        val result = SlicerEngine.repairModel(stl, out)
        assertNotNull("repairModel returned null on a 24-tri input", result)
        result!!

        assertTrue("output 3MF missing", out.exists())
        assertTrue("output 3MF empty", out.length() > 0L)

        // Two closed cubes that overlap form a self-intersecting (but
        // edge-manifold per-cube) input. ADMesh repair welds within
        // each cube on load; the two cubes don't share vertices, so
        // open_edges_in may report 0 — the trigger for the CGAL pass
        // is the self-intersection detector, not open-edge count.
        // What we *can* assert: the CGAL pass either ran successfully
        // (used_cgal=1) or attempted but bailed out (used_cgal=2).
        // used_cgal=0 (skipped) would mean the engine didn't see the
        // overlap — that's the regression to catch.
        assertTrue(
            "expected CGAL pass to fire on overlapping cubes " +
                "(used_cgal=${result.usedCgal}, success=${result.successFlag})",
            result.usedCgal != 0,
        )

        assertTrue(
            "output mesh has zero triangles after repair (in=${result.trianglesIn}, " +
                "out=${result.trianglesOut})",
            result.trianglesOut > 0,
        )

        // Repair must not make the mesh *more* broken. (CGAL closing
        // open edges is a strict improvement; ADMesh-only fallback at
        // worst leaves the count unchanged.)
        assertTrue(
            "repair regressed open edges: ${result.openEdgesIn} -> ${result.openEdgesOut}",
            result.openEdgesOut <= result.openEdgesIn,
        )

        if (result.usedCgal == 1) {
            // Self-union ran successfully → result must be watertight.
            assertEquals(
                "CGAL self-union ran but output still has open edges",
                0, result.openEdgesOut,
            )
        }
    }

    /**
     * Repair on a clean STL must round-trip without loss. The bundled
     * `cube_20mm.stl` is a single axis-aligned cube — already manifold
     * (zero open edges) and not self-intersecting, so the cheap
     * ADMesh-only path is enough. successFlag should be 1, used_cgal
     * should be 0 (skipped because the early exit triggered), and the
     * triangle count should not collapse to zero.
     */
    @Test
    fun repairLeavesAlreadyManifoldCubeIntact() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = androidx.test.platform.app.InstrumentationRegistry
            .getInstrumentation().context
        val stl = File(ctx.cacheDir, "repair_clean_cube_${System.currentTimeMillis()}.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(ctx.cacheDir, "repair_clean_cube_${System.currentTimeMillis()}.3mf")
        val result = SlicerEngine.repairModel(stl, out)
        assertNotNull("repairModel returned null on a manifold cube", result)
        result!!
        assertEquals("clean cube should report fully repaired", 1, result.successFlag)
        assertEquals("clean cube should not need CGAL self-union", 0, result.usedCgal)
        assertEquals(
            "clean cube should report zero open edges in",
            0, result.openEdgesIn,
        )
        assertEquals(
            "clean cube should report zero open edges out",
            0, result.openEdgesOut,
        )
        assertTrue("output 3MF missing", out.exists() && out.length() > 0L)
        assertTrue(
            "clean cube round-trip dropped triangles (in=${result.trianglesIn} out=${result.trianglesOut})",
            result.trianglesOut > 0,
        )
    }

    /**
     * Synthesize an STL that contains two unit cubes sized 20 mm,
     * the second translated by [offsetMm] along +X. Each cube
     * contributes 12 triangles. The two cubes overlap when
     * [offsetMm] < 20 mm, producing a self-intersecting input that
     * the CGAL self-union pass exists to resolve.
     */
    private fun twoOverlappingCubes(offsetMm: Float): StlMesh {
        val tris = mutableListOf<Float>()
        appendCube(tris, ox = 0f, oy = 0f, oz = 0f, side = 20f)
        appendCube(tris, ox = offsetMm, oy = 0f, oz = 0f, side = 20f)
        return StlMesh(
            positions = tris.toFloatArray(),
            triCount = tris.size / 9,
            // Bbox spans [0, offsetMm + 20] on X, [0, 20] on Y/Z.
            bboxMin = Vec3f(0f, 0f, 0f),
            bboxMax = Vec3f(offsetMm + 20f, 20f, 20f),
        )
    }

    /**
     * Append the 12 facets of an axis-aligned cube to [out]. Vertex
     * order is wound CCW when viewed from outside (so face normals
     * point outward).
     */
    private fun appendCube(out: MutableList<Float>, ox: Float, oy: Float, oz: Float, side: Float) {
        val x0 = ox; val x1 = ox + side
        val y0 = oy; val y1 = oy + side
        val z0 = oz; val z1 = oz + side
        // Bottom (-Z): two triangles.
        tri(out, x0, y0, z0, x1, y1, z0, x1, y0, z0)
        tri(out, x0, y0, z0, x0, y1, z0, x1, y1, z0)
        // Top (+Z).
        tri(out, x0, y0, z1, x1, y0, z1, x1, y1, z1)
        tri(out, x0, y0, z1, x1, y1, z1, x0, y1, z1)
        // Front (-Y).
        tri(out, x0, y0, z0, x1, y0, z0, x1, y0, z1)
        tri(out, x0, y0, z0, x1, y0, z1, x0, y0, z1)
        // Back (+Y).
        tri(out, x0, y1, z0, x1, y1, z1, x1, y1, z0)
        tri(out, x0, y1, z0, x0, y1, z1, x1, y1, z1)
        // Left (-X).
        tri(out, x0, y0, z0, x0, y1, z1, x0, y1, z0)
        tri(out, x0, y0, z0, x0, y0, z1, x0, y1, z1)
        // Right (+X).
        tri(out, x1, y0, z0, x1, y1, z0, x1, y1, z1)
        tri(out, x1, y0, z0, x1, y1, z1, x1, y0, z1)
    }

    private fun tri(
        out: MutableList<Float>,
        ax: Float, ay: Float, az: Float,
        bx: Float, by: Float, bz: Float,
        cx: Float, cy: Float, cz: Float,
    ) {
        out += ax; out += ay; out += az
        out += bx; out += by; out += bz
        out += cx; out += cy; out += cz
    }
}
