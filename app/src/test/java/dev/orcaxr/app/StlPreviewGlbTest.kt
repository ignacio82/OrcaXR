package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Roadmap A6 follow-up — verify [StlPreviewGlb.write] paints the
 * triangles named by `offBedTriIndices` in the off-bed red instead of
 * the default off-white or the supplied paint color, so the user gets
 * a visual cue ("which faces poke off the bed?") to complement the
 * existing red banner ("which axes overflow?").
 *
 * Geometry-level rather than pixel-level: read the GLB's COLOR_0
 * accessor and assert the per-vertex RGB matches the expected color
 * for each triangle. The native renderer's job is to honor those
 * colors — we just lock the file format so a regression can't sneak
 * in.
 */
class StlPreviewGlbTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Two-triangle slab spanning x∈[-50,50], y∈[-5,5], z=0. The
     *  first triangle covers the −X side, the second the +X side, so
     *  passing `intArrayOf(0)` highlights only the left half. */
    private fun twoTriSlab(): StlMesh = StlMesh(
        positions = floatArrayOf(
            -50f, -5f, 0f,  50f, -5f, 0f,  50f,  5f, 0f,
            -50f, -5f, 0f,  50f,  5f, 0f, -50f,  5f, 0f,
        ),
        triCount = 2,
        bboxMin = Vec3f(-50f, -5f, 0f),
        bboxMax = Vec3f(50f, 5f, 0f),
    )

    @Test fun no_off_bed_indices_uses_default_color() {
        val out = tmp.newFile("ok.glb")
        StlPreviewGlb.write(twoTriSlab(), out)
        val colors = readVertexColors(out.readBytes(), expectedVertexCount = 6)
        // Every vertex should match the unpainted DEFAULT_RGB
        // (0.78, 0.82, 0.86). Avoid hard-coding the constant — assert
        // the color is non-red instead so the test stays robust to
        // future tuning of the default.
        for (i in 0 until 6) {
            val r = colors[i * 3 + 0]; val g = colors[i * 3 + 1]; val b = colors[i * 3 + 2]
            assertTrue("vertex $i expected non-red default, got ($r, $g, $b)", g > 0.5f && b > 0.5f)
        }
    }

    @Test fun off_bed_indices_are_red_others_default() {
        // Mark only triangle 0 as off-bed → vertices 0..2 should be
        // red; vertices 3..5 should keep the default off-white.
        val out = tmp.newFile("highlight.glb")
        StlPreviewGlb.write(twoTriSlab(), out, offBedTriIndices = intArrayOf(0))
        val colors = readVertexColors(out.readBytes(), expectedVertexCount = 6)
        // Triangle 0 → red.
        for (v in 0..2) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue(
                "tri-0 vertex $v expected red, got ($r, $g, $b)",
                r > 0.7f && g < 0.3f && b < 0.3f,
            )
        }
        // Triangle 1 → default.
        for (v in 3..5) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue(
                "tri-1 vertex $v expected default, got ($r, $g, $b)",
                g > 0.5f && b > 0.5f,
            )
        }
    }

    @Test fun off_bed_overrides_paint_color() {
        // Paint both triangles green (slot 1). Mark triangle 0 as
        // off-bed. Expectation: tri-0 wins the off-bed red; tri-1
        // keeps the green paint. Off-bed must beat paint so the
        // collision warning is never hidden by user paint.
        val out = tmp.newFile("paint_vs_offbed.glb")
        StlPreviewGlb.write(
            twoTriSlab(),
            out,
            paintFilamentIndex = byteArrayOf(1, 1),
            paletteRgb = floatArrayOf(0.1f, 0.9f, 0.1f),  // green slot 1
            offBedTriIndices = intArrayOf(0),
        )
        val colors = readVertexColors(out.readBytes(), expectedVertexCount = 6)
        // Tri-0 → red (off-bed beats paint).
        for (v in 0..2) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue("tri-0 vertex $v expected red, got ($r, $g, $b)", r > 0.7f && g < 0.3f)
        }
        // Tri-1 → green (paint).
        for (v in 3..5) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue(
                "tri-1 vertex $v expected green paint, got ($r, $g, $b)",
                r < 0.3f && g > 0.7f && b < 0.3f,
            )
        }
    }

    @Test fun out_of_range_off_bed_index_is_dropped() {
        // A stale offBedTriIndices array with an index past the mesh
        // shouldn't crash the writer or leak past the array end. Just
        // skip the bad entry and color the in-range triangle as
        // off-bed.
        val out = tmp.newFile("oor.glb")
        StlPreviewGlb.write(
            twoTriSlab(),
            out,
            offBedTriIndices = intArrayOf(0, 99, -1),
        )
        val colors = readVertexColors(out.readBytes(), expectedVertexCount = 6)
        // Triangle 0 still red.
        for (v in 0..2) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue("tri-0 vertex $v expected red, got ($r, $g, $b)", r > 0.7f && g < 0.3f)
        }
        // Triangle 1 untouched.
        for (v in 3..5) {
            val r = colors[v * 3 + 0]; val g = colors[v * 3 + 1]; val b = colors[v * 3 + 2]
            assertTrue("tri-1 vertex $v expected default, got ($r, $g, $b)", g > 0.5f && b > 0.5f)
        }
    }

    @Test fun empty_off_bed_indices_is_a_noop() {
        // An empty off-bed array means "no overflow" — every triangle
        // keeps its default color. Same as passing null.
        val out = tmp.newFile("empty.glb")
        StlPreviewGlb.write(twoTriSlab(), out, offBedTriIndices = IntArray(0))
        val colors = readVertexColors(out.readBytes(), expectedVertexCount = 6)
        for (i in 0 until 6) {
            val r = colors[i * 3 + 0]; val g = colors[i * 3 + 1]; val b = colors[i * 3 + 2]
            assertTrue("vertex $i expected default, got ($r, $g, $b)", g > 0.5f && b > 0.5f)
        }
    }

    /** Crack a GLB and extract the per-vertex COLOR_0 floats. */
    private fun readVertexColors(bytes: ByteArray, expectedVertexCount: Int): FloatArray {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(buf.int == 0x46546C67) { "not a GLB" }
        buf.int  // version
        buf.int  // total length
        val jsonLen = buf.int
        buf.int  // 'JSON'
        val jsonBytes = ByteArray(jsonLen).also { buf.get(it) }
        val json = String(jsonBytes, Charsets.UTF_8).trimEnd(' ')
        // Bin chunk header.
        buf.int  // bin length
        buf.int  // 'BIN '
        // Layout from GlbBuilder: positions (v*3 floats), then COLOR_0
        // (v*3 floats), then indices. Skip positions.
        val pos = expectedVertexCount * 3 * 4
        repeat(pos) { buf.get() }
        // Pull v*4 bytes and convert RGB to floats.
        val colors = FloatArray(expectedVertexCount * 3)
        for (i in 0 until expectedVertexCount) {
            colors[i * 3] = (buf.get().toInt() and 0xFF) / 255f
            colors[i * 3 + 1] = (buf.get().toInt() and 0xFF) / 255f
            colors[i * 3 + 2] = (buf.get().toInt() and 0xFF) / 255f
            buf.get() // skip alpha
        }
        // Sanity: COLOR_0 in the JSON ensures the writer actually
        // emitted a color attribute.
        assertEquals(true, json.contains("COLOR_0"))
        return colors
    }
}
