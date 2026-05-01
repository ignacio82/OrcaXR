package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.nio.ByteOrder

class GizmoGlbTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun writeCube_glb_has_expected_geometry() {
        val out = tmp.newFile("cube.glb")
        GizmoGlb.writeCube(
            file = out,
            size = 10f,
            offset = floatArrayOf(1f, 2f, 3f),
            color = floatArrayOf(1f, 0.5f, 0.2f)
        )

        val (jsonStr, bin) = parseGlb(out.readBytes())
        assertTrue("JSON contains POSITION accessor", jsonStr.contains(""""POSITION":0"""))
        assertTrue("JSON contains COLOR_0 accessor", jsonStr.contains("COLOR_0"))
        assertTrue("doubleSided material is set", jsonStr.contains(""""doubleSided":true"""))

        // Positions: 24 vertices. Colors: 24 elements. Indices: 36.
        val counts = Regex(""""count":(\d+)""").findAll(jsonStr).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(24, 24, 36), counts)

        assertNotNull("BIN chunk present", bin)

        // Read positions to confirm bbox matches requested size and offset.
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 24) {
            val x = buf.float; val y = buf.float; val z = buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        val tol = 0.001f
        assertEquals(1f - 5f, xmin, tol)
        assertEquals(1f + 5f, xmax, tol)
        assertEquals(2f - 5f, ymin, tol)
        assertEquals(2f + 5f, ymax, tol)
        assertEquals(3f - 5f, zmin, tol)
        assertEquals(3f + 5f, zmax, tol)
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
