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

    @Test fun writeRing_creates_correct_geometry_and_colors() {
        val out = tmp.newFile("ring.glb")
        val color = floatArrayOf(1f, 0f, 0f)
        GizmoGlb.writeRing(out, axis = 2, radius = 10f, thickness = 1f, color = color)

        val (jsonStr, bin) = parseGlb(out.readBytes())
        assertTrue(jsonStr.contains(""""POSITION":0"""))
        assertTrue(jsonStr.contains("COLOR_0"))

        // 36 segments * 12 tubeSegments = 432 vertices
        // 36 * 12 * 2 triangles = 864 triangles = 2592 indices
        val counts = Regex(""""count":(\d+)""").findAll(jsonStr).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(432, 432, 2592), counts)

        assertNotNull(bin)
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)

        // Positions
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 432) {
            val x = buf.float; val y = buf.float; val z = buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        val tol = 0.01f
        assertEquals(-11f, xmin, tol); assertEquals(11f, xmax, tol)
        assertEquals(-11f, ymin, tol); assertEquals(11f, ymax, tol)
        assertEquals(-1f, zmin, tol); assertEquals(1f, zmax, tol)

        // Colors
        for (i in 0 until 432) {
            val r = buf.float; val g = buf.float; val b = buf.float
            assertEquals(1f, r, tol)
            assertEquals(0f, g, tol)
            assertEquals(0f, b, tol)
        }
    }

    @Test fun writeArrow_creates_correct_geometry_and_colors() {
        val out = tmp.newFile("arrow.glb")
        val color = floatArrayOf(0f, 1f, 0f)
        GizmoGlb.writeArrow(out, axis = 1, length = 20f, radius = 0.5f, color = color)

        val (jsonStr, bin) = parseGlb(out.readBytes())
        assertTrue(jsonStr.contains(""""POSITION":0"""))
        assertTrue(jsonStr.contains("COLOR_0"))

        // Shaft: 16 segments * 2 = 32 vertices. Head: 1 tip + 16 base = 17 vertices. Total = 49 vertices.
        // Shaft: 16 * 2 triangles = 32. Head: 16 triangles. Total = 48 triangles = 144 indices.
        val counts = Regex(""""count":(\d+)""").findAll(jsonStr).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(49, 49, 144), counts)

        assertNotNull(bin)
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)

        // Positions
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 49) {
            val x = buf.float; val y = buf.float; val z = buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        val tol = 0.01f
        // Axis 1 means length is along Y axis (0 to 20). Circle is in X and Z.
        assertEquals(-1.25f, xmin, tol); assertEquals(1.25f, xmax, tol)
        assertEquals(0f, ymin, tol); assertEquals(20f, ymax, tol)
        assertEquals(-1.25f, zmin, tol); assertEquals(1.25f, zmax, tol)

        // Colors
        for (i in 0 until 49) {
            val r = buf.float; val g = buf.float; val b = buf.float
            assertEquals(0f, r, tol)
            assertEquals(1f, g, tol)
            assertEquals(0f, b, tol)
        }
    }

    @Test fun writeCube_creates_correct_geometry_and_colors() {
        val out = tmp.newFile("cube.glb")
        val color = floatArrayOf(0f, 0f, 1f)
        GizmoGlb.writeCube(out, size = 5f, offset = floatArrayOf(10f, 20f, 30f), color = color)

        val (jsonStr, bin) = parseGlb(out.readBytes())
        assertTrue(jsonStr.contains(""""POSITION":0"""))
        assertTrue(jsonStr.contains("COLOR_0"))

        // Cube: 8 vertices, 12 triangles = 36 indices
        val counts = Regex(""""count":(\d+)""").findAll(jsonStr).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(8, 8, 36), counts)

        assertNotNull(bin)
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)

        // Positions
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 8) {
            val x = buf.float; val y = buf.float; val z = buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        val tol = 0.01f
        // Offset (10, 20, 30), size 5
        assertEquals(7.5f, xmin, tol); assertEquals(12.5f, xmax, tol)
        assertEquals(17.5f, ymin, tol); assertEquals(22.5f, ymax, tol)
        assertEquals(27.5f, zmin, tol); assertEquals(32.5f, zmax, tol)

        // Colors
        for (i in 0 until 8) {
            val r = buf.float; val g = buf.float; val b = buf.float
            assertEquals(0f, r, tol)
            assertEquals(0f, g, tol)
            assertEquals(1f, b, tol)
        }
    }

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
