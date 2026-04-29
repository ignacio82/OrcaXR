package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Phase XR_OBJ_1 — verify the wireframe-bbox GLB writer produces a
 * structurally valid glTF binary with the expected vertex / triangle
 * counts and a position bbox that matches the requested dimensions.
 *
 * Geometry sanity check rather than visual: the device-side render is
 * what the user actually sees; here we lock the file format so future
 * GlbBuilder changes don't silently break the selection feedback.
 */
class SelectionBboxGlbTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun bbox_glb_has_expected_geometry() {
        val out = tmp.newFile("sel_bbox.glb")
        writeBboxOutlineGlb(
            file = out,
            sizeXmm = 100f,
            sizeYmm = 80f,
            sizeZmm = 60f,
        )
        // 12 edges × 8 vertices = 96 vertices.
        // 12 edges × 12 triangles = 144 triangles → 432 indices.
        val (jsonStr, bin) = parseGlb(out.readBytes())
        assertTrue("JSON contains POSITION accessor", jsonStr.contains(""""POSITION":0"""))
        assertTrue("JSON contains COLOR_0 accessor", jsonStr.contains("COLOR_0"))
        assertTrue("doubleSided material is set", jsonStr.contains(""""doubleSided":true"""))
        // Pull "count" from every accessor — 96 / 96 / 432.
        val counts = Regex(""""count":(\d+)""").findAll(jsonStr).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(96, 96, 432), counts)
        assertNotNull("BIN chunk present", bin)
        // Positions occupy the first 96 * 3 * 4 bytes. Walk them and
        // confirm the overall bbox spans at least the requested size.
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 96) {
            val x = buf.float; val y = buf.float; val z = buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        // Edge-cuboid expansion adds a half-thickness past the
        // requested size — the actual extent is size + thickness.
        val tol = 0.01f
        assertEquals(-50f - 1.5f, xmin, tol); assertEquals(50f + 1.5f, xmax, tol)
        assertEquals(-40f - 1.5f, ymin, tol); assertEquals(40f + 1.5f, ymax, tol)
        assertEquals(0f - 1.5f, zmin, tol); assertEquals(60f + 1.5f, zmax, tol)
    }

    /** Crack a GLB into its JSON chunk text + raw BIN chunk bytes. */
    private fun parseGlb(bytes: ByteArray): Pair<String, ByteArray?> {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = buf.int
        require(magic == 0x46546C67) { "not a GLB" }
        buf.int // version
        buf.int // total length
        val jsonLen = buf.int
        buf.int // chunk type 'JSON'
        val jsonBytes = ByteArray(jsonLen)
        buf.get(jsonBytes)
        val json = String(jsonBytes, Charsets.UTF_8).trimEnd(' ')
        val binBytes = if (buf.hasRemaining()) {
            val binLen = buf.int
            buf.int // chunk type 'BIN '
            ByteArray(binLen).also { buf.get(it) }
        } else null
        return json to binBytes
    }
}
