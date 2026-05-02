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
 * D4 — end-to-end exercise of [SlicerEngine.buildTextMesh],
 * [SlicerEngine.buildSvgMesh] and [SlicerEngine.applyEmboss] against
 * the bundled fonts + sample SVG.
 *
 * The tests cover three load-bearing properties:
 *
 * 1. **Builders produce non-empty meshes whose bbox roughly matches
 *    the requested sizes.** A 10mm "AB" should land in a 5..30mm wide
 *    × 6..18mm tall × 1.5mm deep window (font-dependent — DejaVu Sans
 *    Bold is wider than its line height, so we pick a generous lower
 *    bound on width).
 * 2. **applyEmboss in ADD mode grows the host bbox in +Z** by ≈
 *    depthMm (the letters sit on top, so the union's max-Z exceeds
 *    the host's max-Z). XY bbox stays within the host XY ± a small
 *    margin (the emboss is centered on the host top face).
 * 3. **applyEmboss in SUB mode preserves the host bbox** (cuts only
 *    take material away, no surface extends past the host) but
 *    increases the open-edge / surface area of the result vs. a
 *    flat-top cube — i.e. SOMETHING got carved out.
 *
 * Each test runs against a fresh 20mm-cube STL fixture (re-using
 * RepairModelTest's appendCube generator pattern, kept inline here to
 * avoid coupling the test files).
 */
@RunWith(AndroidJUnit4::class)
class EmbossOpTest {

    @Test
    fun buildTextMesh_dejavuSansBold_AB_yieldsExtrudedMeshWithExpectedBbox() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val font = EmbossAssets.stageBundledFont(ctx, EmbossAssets.DEFAULT_FONT)
        assertTrue("staged font missing", font.exists() && font.length() > 0L)
        val out = File(ctx.cacheDir, "emboss_text_AB_${System.currentTimeMillis()}.3mf")
        val sizeMm = 10f
        val depthMm = 1.5f
        val result = SlicerEngine.buildTextMesh(
            fontFile = font,
            text = "AB",
            sizeMm = sizeMm,
            depthMm = depthMm,
            output = out,
        )
        assertNotNull("buildTextMesh returned null", result)
        assertTrue("output 3MF missing", out.exists() && out.length() > 0L)

        // Re-extract as STL so we can read the bbox back.
        val verify = File(ctx.cacheDir, "emboss_text_AB_verify_${System.currentTimeMillis()}.stl")
        assertTrue(
            "extractObjectAsStl failed for emboss text 3MF",
            SlicerEngine.extractObjectAsStl(out, 0, verify),
        )
        val mesh = StlReader.read(verify)
        assertTrue(
            "text mesh has zero triangles",
            mesh.triCount > 0,
        )
        val w = mesh.bboxMax.x - mesh.bboxMin.x
        val h = mesh.bboxMax.y - mesh.bboxMin.y
        val d = mesh.bboxMax.z - mesh.bboxMin.z
        // DejaVu Sans Bold "AB" at 10mm line height. Cap height is
        // ≈ 7mm; "AB" advance width is roughly 13–18 mm; depth = 1.5mm.
        assertTrue("text width=$w mm out of range", w in 8f..30f)
        assertTrue("text height=$h mm out of range", h in 4f..14f)
        assertTrue(
            "text depth=$d mm differs from request $depthMm",
            kotlin.math.abs(d - depthMm) < 0.1f,
        )
    }

    @Test
    fun buildSvgMesh_bundledHeart_yieldsExtrudedMeshAtTargetSize() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val svg = EmbossAssets.stageBundledSampleSvg(ctx)
        assertTrue("staged SVG missing", svg.exists() && svg.length() > 0L)
        val out = File(ctx.cacheDir, "emboss_svg_heart_${System.currentTimeMillis()}.3mf")
        val targetSizeMm = 20f
        val depthMm = 2f
        val result = SlicerEngine.buildSvgMesh(
            svgFile = svg,
            targetSizeMm = targetSizeMm,
            depthMm = depthMm,
            output = out,
        )
        assertNotNull("buildSvgMesh returned null", result)
        assertTrue("output 3MF missing", out.exists() && out.length() > 0L)

        val verify = File(ctx.cacheDir, "emboss_svg_heart_verify_${System.currentTimeMillis()}.stl")
        assertTrue(
            "extractObjectAsStl failed for emboss SVG 3MF",
            SlicerEngine.extractObjectAsStl(out, 0, verify),
        )
        val mesh = StlReader.read(verify)
        assertTrue("svg mesh has zero triangles", mesh.triCount > 0)
        val w = mesh.bboxMax.x - mesh.bboxMin.x
        val h = mesh.bboxMax.y - mesh.bboxMin.y
        val d = mesh.bboxMax.z - mesh.bboxMin.z
        // Heart SVG is roughly square; targetSizeMm=20 maps the larger
        // axis to 20mm. Allow ±5% tolerance for the bezier flattening.
        val maxXY = maxOf(w, h)
        assertTrue(
            "svg max-XY=$maxXY mm not within 5% of target $targetSizeMm",
            kotlin.math.abs(maxXY - targetSizeMm) < targetSizeMm * 0.05f,
        )
        assertTrue(
            "svg depth=$d mm differs from request $depthMm",
            kotlin.math.abs(d - depthMm) < 0.1f,
        )
    }

    @Test
    fun applyEmboss_ADD_grows_host_in_plusZ_by_depthMm() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Host: synthesized 20mm cube. The bundled cube_20mm.stl ships
        // ASCII (libslic3r tolerates it; StlReader.kt is binary-only),
        // so we build a binary STL fixture in code — same trick
        // RepairModelTest uses for its overlapping-cubes case.
        val cube = File(ctx.cacheDir, "emboss_add_host_${System.currentTimeMillis()}.stl")
        StlWriter.write(synthesizedCube20mm(), cube)
        val cubeMesh = StlReader.read(cube)
        val cubeMaxZ = cubeMesh.bboxMax.z
        val cubeMinZ = cubeMesh.bboxMin.z

        // Build a small text mesh.
        val font = EmbossAssets.stageBundledFont(ctx, EmbossAssets.DEFAULT_FONT)
        val embossOut = File(ctx.cacheDir, "emboss_add_text_${System.currentTimeMillis()}.3mf")
        val embossDepthMm = 1.5f
        SlicerEngine.buildTextMesh(
            fontFile = font, text = "X", sizeMm = 8f,
            depthMm = embossDepthMm, output = embossOut,
        ) ?: error("text emboss build failed")

        // Place on top of cube (top-of-bbox, no sink, centered).
        val xform = EmbossOp.transformForTopOfBbox(
            hostBboxMaxZmm = cubeMaxZ,
            embossDepthMm = embossDepthMm,
            sinkDepthMm = 0f,
        )
        val out = File(ctx.cacheDir, "emboss_add_result_${System.currentTimeMillis()}.3mf")
        val ok = SlicerEngine.applyEmboss(
            host = cube,
            emboss = embossOut,
            mode = EmbossMode.ADD,
            transform4x4 = xform,
            output = out,
        )
        assertTrue("applyEmboss(ADD) returned false", ok)

        // Verify result bbox.
        val verify = File(ctx.cacheDir, "emboss_add_verify_${System.currentTimeMillis()}.stl")
        assertTrue(
            "extractObjectAsStl failed for embossed 3MF",
            SlicerEngine.extractObjectAsStl(out, 0, verify),
        )
        val resultMesh = StlReader.read(verify)
        // Z grows by ≈ depthMm. Min Z stays put.
        assertTrue(
            "ADD min-Z drifted: ${resultMesh.bboxMin.z} vs $cubeMinZ",
            kotlin.math.abs(resultMesh.bboxMin.z - cubeMinZ) < 0.5f,
        )
        val zGrowth = resultMesh.bboxMax.z - cubeMaxZ
        assertTrue(
            "ADD did not grow +Z (zGrowth=$zGrowth, expected ≈ $embossDepthMm)",
            zGrowth in (embossDepthMm * 0.5f)..(embossDepthMm * 1.5f + 0.5f),
        )
        // XY shouldn't shrink — the union covers at least the host
        // footprint. Allow a tiny epsilon for mcut's vertex stitching.
        assertTrue(
            "ADD shrank X bbox: ${resultMesh.bboxMin.x}..${resultMesh.bboxMax.x} " +
                "vs ${cubeMesh.bboxMin.x}..${cubeMesh.bboxMax.x}",
            resultMesh.bboxMin.x <= cubeMesh.bboxMin.x + 0.5f &&
                resultMesh.bboxMax.x >= cubeMesh.bboxMax.x - 0.5f,
        )
    }

    @Test
    fun applyEmboss_SUB_preserves_host_bbox_and_carves_some_volume() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        // Synthesize binary-STL cube fixture (see ADD test for the why).
        val cube = File(ctx.cacheDir, "emboss_sub_host_${System.currentTimeMillis()}.stl")
        StlWriter.write(synthesizedCube20mm(), cube)
        val cubeMesh = StlReader.read(cube)
        val cubeMaxZ = cubeMesh.bboxMax.z

        // Build SVG heart for engrave.
        val svg = EmbossAssets.stageBundledSampleSvg(ctx)
        val embossOut = File(ctx.cacheDir, "emboss_sub_svg_${System.currentTimeMillis()}.3mf")
        val embossDepthMm = 1.5f
        SlicerEngine.buildSvgMesh(
            svgFile = svg, targetSizeMm = 12f,
            depthMm = embossDepthMm, output = embossOut,
        ) ?: error("svg emboss build failed")

        // Sink the emboss down by its full depth so SUB carves a
        // 1.5mm-deep recess into the cube's top face.
        val xform = EmbossOp.transformForTopOfBbox(
            hostBboxMaxZmm = cubeMaxZ,
            embossDepthMm = embossDepthMm,
            sinkDepthMm = embossDepthMm,
        )
        val out = File(ctx.cacheDir, "emboss_sub_result_${System.currentTimeMillis()}.3mf")
        val ok = SlicerEngine.applyEmboss(
            host = cube,
            emboss = embossOut,
            mode = EmbossMode.SUB,
            transform4x4 = xform,
            output = out,
        )
        assertTrue("applyEmboss(SUB) returned false", ok)

        val verify = File(ctx.cacheDir, "emboss_sub_verify_${System.currentTimeMillis()}.stl")
        assertTrue(
            "extractObjectAsStl failed for engraved 3MF",
            SlicerEngine.extractObjectAsStl(out, 0, verify),
        )
        val resultMesh = StlReader.read(verify)
        // SUB does not extend past the host bbox.
        assertTrue(
            "SUB extended X bbox: ${resultMesh.bboxMin.x}..${resultMesh.bboxMax.x} " +
                "vs ${cubeMesh.bboxMin.x}..${cubeMesh.bboxMax.x}",
            resultMesh.bboxMin.x >= cubeMesh.bboxMin.x - 0.1f &&
                resultMesh.bboxMax.x <= cubeMesh.bboxMax.x + 0.1f,
        )
        assertTrue(
            "SUB extended Y bbox",
            resultMesh.bboxMin.y >= cubeMesh.bboxMin.y - 0.1f &&
                resultMesh.bboxMax.y <= cubeMesh.bboxMax.y + 0.1f,
        )
        assertTrue(
            "SUB grew Z bbox: ${resultMesh.bboxMax.z} vs $cubeMaxZ",
            resultMesh.bboxMax.z <= cubeMaxZ + 0.1f,
        )
        // Carving the heart adds new triangles where there was a flat
        // face. A pristine 12-tri cube post-mcut usually re-meshes
        // anyway, but engraving must produce strictly more facets than
        // the original cube alone.
        assertTrue(
            "SUB result has fewer triangles (${resultMesh.triCount}) than host (${cubeMesh.triCount}) " +
                "— engrave carved nothing",
            resultMesh.triCount > cubeMesh.triCount,
        )
    }

    /**
     * Synthesize a 20mm axis-aligned cube as a binary StlMesh. Twelve
     * facets, CCW outward winding. RepairModelTest uses the same
     * pattern for its overlapping-cubes fixture; we keep the helper
     * inline rather than sharing across files because the two tests
     * have different cube needs (single vs offset pair) and the math
     * is small enough that DRY would outweigh readability.
     */
    private fun synthesizedCube20mm(): StlMesh {
        val tris = mutableListOf<Float>()
        val side = 20f
        val x0 = 0f; val x1 = side
        val y0 = 0f; val y1 = side
        val z0 = 0f; val z1 = side
        // Bottom (-Z).
        appendTri(tris, x0, y0, z0, x1, y1, z0, x1, y0, z0)
        appendTri(tris, x0, y0, z0, x0, y1, z0, x1, y1, z0)
        // Top (+Z).
        appendTri(tris, x0, y0, z1, x1, y0, z1, x1, y1, z1)
        appendTri(tris, x0, y0, z1, x1, y1, z1, x0, y1, z1)
        // Front (-Y).
        appendTri(tris, x0, y0, z0, x1, y0, z0, x1, y0, z1)
        appendTri(tris, x0, y0, z0, x1, y0, z1, x0, y0, z1)
        // Back (+Y).
        appendTri(tris, x0, y1, z0, x1, y1, z1, x1, y1, z0)
        appendTri(tris, x0, y1, z0, x0, y1, z1, x1, y1, z1)
        // Left (-X).
        appendTri(tris, x0, y0, z0, x0, y1, z1, x0, y1, z0)
        appendTri(tris, x0, y0, z0, x0, y0, z1, x0, y1, z1)
        // Right (+X).
        appendTri(tris, x1, y0, z0, x1, y1, z0, x1, y1, z1)
        appendTri(tris, x1, y0, z0, x1, y1, z1, x1, y0, z1)
        return StlMesh(
            positions = tris.toFloatArray(),
            triCount = tris.size / 9,
            bboxMin = Vec3f(0f, 0f, 0f),
            bboxMax = Vec3f(side, side, side),
        )
    }

    private fun appendTri(
        out: MutableList<Float>,
        ax: Float, ay: Float, az: Float,
        bx: Float, by: Float, bz: Float,
        cx: Float, cy: Float, cz: Float,
    ) {
        out += ax; out += ay; out += az
        out += bx; out += by; out += bz
        out += cx; out += cy; out += cz
    }

    @Test
    fun embossOp_compose_identityThenIdentity_isIdentity() {
        val a = EmbossOp.identityTransform()
        val b = EmbossOp.identityTransform()
        val c = EmbossOp.compose(a, b)
        assertEquals(16, c.size)
        for (i in 0..3) {
            for (j in 0..3) {
                val expected = if (i == j) 1f else 0f
                assertEquals(
                    "identity*identity[$i,$j]",
                    expected, c[i * 4 + j], 1e-6f,
                )
            }
        }
    }

    @Test
    fun embossOp_rotationZ_90deg_swapsXY() {
        val r = EmbossOp.rotationZ(90f)
        // After rot90Z, a point on +X (x=1) moves to +Y (y=1).
        // Apply to (1,0,0,1) row-major: out_y = r[1*4+0]*1 + r[1*4+3]
        // = sin(90°) + 0 ≈ 1.
        val sinHere = r[1 * 4 + 0]
        val cosHere = r[0 * 4 + 0]
        assertEquals("rot90 sin component", 1f, sinHere, 1e-3f)
        assertEquals("rot90 cos component", 0f, cosHere, 1e-3f)
    }
}
