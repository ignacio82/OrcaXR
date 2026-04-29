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
 * Roadmap A7 — verify [ToolpathGlb.write] in `tubes = true` mode
 * emits the expected per-segment geometry shape (8 verts × 12 tris ×
 * 36 indices), and that the segment-cap fallback to LINES kicks in
 * above [ToolpathGlb.TUBES_SEGMENT_CAP].
 *
 * Geometry-level rather than pixel-level: we read the GLB headers
 * back and assert vertex / index counts, primitive mode, and bbox
 * ranges so any future regression in the prism math gets caught at
 * unit-test time. The 60-fps device-side test is out of scope here.
 */
class ToolpathGlbTest {
    @get:Rule val tmp = TemporaryFolder()

    /** A two-segment toolpath: one straight along +X at z=0.2, one
     *  straight along +Y at the same Z. Two distinct layers would
     *  add 2 segments × 2 = 4 — keeping it flat avoids confusion
     *  with the layer-clip path while still exercising direction
     *  math. */
    private fun twoSegmentToolpath(): ParsedToolpath {
        val z = 0.2f
        val segs = listOf(
            ExtrusionSegment(
                start = Vec3f(0f, 0f, z),
                end = Vec3f(10f, 0f, z),
                z = z,
                role = ExtrusionRole.OuterWall,
                extruder = 0,
            ),
            ExtrusionSegment(
                start = Vec3f(10f, 0f, z),
                end = Vec3f(10f, 10f, z),
                z = z,
                role = ExtrusionRole.OuterWall,
                extruder = 0,
            ),
        )
        return ParsedToolpath(
            segments = segs,
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = 2, extrusionSegments = 2, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z),
                bboxMax = Vec3f(10f, 10f, z),
                totalExtrusionLengthMm = 20.0,
            ),
            layerZs = listOf(z),
        )
    }

    @Test fun lines_mode_emits_expected_counts() {
        // Sanity baseline: 2 segments → 4 verts, 4 indices (LINES).
        val out = tmp.newFile("lines.glb")
        ToolpathGlb.write(twoSegmentToolpath(), out)
        val (json, _) = parseGlb(out.readBytes())
        // Mode 1 = LINES.
        assertTrue("mode=1 (LINES)", json.contains(""""mode":1"""))
        val counts = Regex(""""count":(\d+)""").findAll(json).map { it.groupValues[1].toInt() }.toList()
        // Order: positions(4), colors(4), indices(4).
        assertEquals(listOf(4, 4, 4), counts)
    }

    @Test fun tubes_mode_emits_expected_counts() {
        // 2 segments × 8 verts = 16 verts; × 12 tris = 24 tris × 3 = 72 indices.
        val out = tmp.newFile("tubes.glb")
        ToolpathGlb.write(twoSegmentToolpath(), out, tubes = true)
        val (json, _) = parseGlb(out.readBytes())
        // Mode 4 = TRIANGLES.
        assertTrue("mode=4 (TRIANGLES)", json.contains(""""mode":4"""))
        // doubleSided so the inside of the tube renders even at
        // sharp viewing angles — same trick as writeBboxOutlineGlb.
        assertTrue("doubleSided is set", json.contains(""""doubleSided":true"""))
        val counts = Regex(""""count":(\d+)""").findAll(json).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(16, 16, 72), counts)
    }

    @Test fun tubes_bbox_includes_tube_radius() {
        // The bbox of the tube prism should extend the segment's
        // axis-aligned envelope by at least one radius on the
        // perpendicular axes. Segment 1 runs +X; its tube should
        // bulge in Y and Z by ≥ DEFAULT_TUBE_RADIUS_MM.
        val out = tmp.newFile("tubes_bbox.glb")
        ToolpathGlb.write(twoSegmentToolpath(), out, tubes = true, tubeRadiusMm = 0.5f)
        val (_, bin) = parseGlb(out.readBytes())
        assertNotNull(bin)
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)
        // 16 vertices × 3 floats positions, then colors, then indices.
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        var zmin = Float.POSITIVE_INFINITY; var zmax = Float.NEGATIVE_INFINITY
        for (i in 0 until 16) {
            buf.float  // x — recentered, varies per segment
            val y = buf.float; val z = buf.float
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
            if (z < zmin) zmin = z; if (z > zmax) zmax = z
        }
        // Y span: segment 1 runs +X — its tube cross-section adds
        // ±radius in Y. Segment 2 runs +Y for 10 mm — its tube does
        // not extend past start/end (no end caps push past the
        // endpoints), so the segment-2 contribution is exactly 10 mm
        // in Y. Total Y span ≈ 10 mm + 1 radius (the tube-1 Y bulge
        // extends past segment 2's start by `radius`).
        assertTrue("Y span ≥ 10 mm + radius, got $ymin..$ymax", (ymax - ymin) >= 10.49f)
        // Z span: both segments are flat at the same Z; tube radius
        // adds ±radius on Z → span ≈ 2 * radius (~1 mm at radius=0.5).
        assertTrue("Z span ≥ 2*radius, got $zmin..$zmax", (zmax - zmin) >= 0.99f)
    }

    @Test fun tubes_above_cap_falls_back_to_lines() {
        // Synthesize TUBES_SEGMENT_CAP + 1 segments — the writer must
        // fall back to LINES rather than try to materialize the full
        // tube geometry (would need ~170 MB of arrays at 500k segs).
        val n = ToolpathGlb.TUBES_SEGMENT_CAP + 1
        val z = 0.2f
        val segs = (0 until n).map { i ->
            val x0 = (i % 100).toFloat()
            val y0 = (i / 100).toFloat()
            ExtrusionSegment(
                start = Vec3f(x0, y0, z),
                end = Vec3f(x0 + 0.1f, y0, z),
                z = z,
            )
        }
        val tp = ParsedToolpath(
            segments = segs,
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = n, extrusionSegments = n, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z),
                bboxMax = Vec3f(100f, (n / 100).toFloat(), z),
                totalExtrusionLengthMm = (n * 0.1).toDouble(),
            ),
            layerZs = listOf(z),
        )
        val out = tmp.newFile("cap_fallback.glb")
        ToolpathGlb.write(tp, out, tubes = true)
        val (json, _) = parseGlb(out.readBytes())
        assertTrue("expected LINES fallback above cap, got $json", json.contains(""""mode":1"""))
    }

    @Test fun tubes_with_travels_emits_hairlines_in_triangle_mode() {
        // Travels stay aux geometry — they're emitted as degenerate
        // triangles inside the same TRIANGLES primitive so we don't
        // pay for a second draw call.
        val z = 0.2f
        val tp = ParsedToolpath(
            segments = listOf(
                ExtrusionSegment(Vec3f(0f, 0f, z), Vec3f(10f, 0f, z), z),
            ),
            travels = listOf(
                TravelSegment(Vec3f(10f, 0f, z), Vec3f(0f, 0f, z), z),
            ),
            stats = GcodeStats(
                totalLines = 2, extrusionSegments = 1, travelSegments = 1,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z),
                bboxMax = Vec3f(10f, 0f, z),
                totalExtrusionLengthMm = 10.0,
            ),
            layerZs = listOf(z),
        )
        val out = tmp.newFile("tubes_travels.glb")
        ToolpathGlb.write(tp, out, tubes = true, includeTravels = true)
        val (json, _) = parseGlb(out.readBytes())
        // 1 seg × 8 verts + 1 travel × 2 verts = 10.
        // 1 seg × 36 indices + 1 travel × 3 indices = 39.
        val counts = Regex(""""count":(\d+)""").findAll(json).map { it.groupValues[1].toInt() }.toList()
        assertEquals(listOf(10, 10, 39), counts)
    }

    @Test fun vertical_segment_uses_y_reference_axis() {
        // Tangent ≈ +Z would produce a degenerate side = cross(t, Z)
        // if the writer naively used Z as the world-up reference. The
        // useY-when-|tnz|>0.95 guard switches to Y so the cross stays
        // well-conditioned. Verify the resulting prism actually has
        // 8 distinct vertices (not 8 collapsed into a line).
        val z0 = 0f; val z1 = 5f
        val tp = ParsedToolpath(
            segments = listOf(
                ExtrusionSegment(Vec3f(0f, 0f, z0), Vec3f(0f, 0f, z1), z = z1),
            ),
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = 1, extrusionSegments = 1, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z0),
                bboxMax = Vec3f(0f, 0f, z1),
                totalExtrusionLengthMm = 5.0,
            ),
            layerZs = listOf(z1),
        )
        val out = tmp.newFile("vertical.glb")
        ToolpathGlb.write(tp, out, tubes = true, tubeRadiusMm = 0.3f)
        val (_, bin) = parseGlb(out.readBytes())
        val buf = ByteBuffer.wrap(bin!!).order(ByteOrder.LITTLE_ENDIAN)
        // Span the 8 vertices' XY — the tube radius should produce a
        // non-zero footprint in BOTH X and Y, proving the side/up
        // axes are well-conditioned.
        var xmin = Float.POSITIVE_INFINITY; var xmax = Float.NEGATIVE_INFINITY
        var ymin = Float.POSITIVE_INFINITY; var ymax = Float.NEGATIVE_INFINITY
        for (i in 0 until 8) {
            val x = buf.float; val y = buf.float; buf.float
            if (x < xmin) xmin = x; if (x > xmax) xmax = x
            if (y < ymin) ymin = y; if (y > ymax) ymax = y
        }
        assertTrue("X footprint must be non-zero, got $xmin..$xmax", (xmax - xmin) > 0.1f)
        assertTrue("Y footprint must be non-zero, got $ymin..$ymax", (ymax - ymin) > 0.1f)
    }

    /** Crack a GLB into its JSON chunk text + raw BIN chunk bytes. */
    private fun parseGlb(bytes: ByteArray): Pair<String, ByteArray?> {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = buf.int
        require(magic == 0x46546C67) { "not a GLB" }
        buf.int  // version
        buf.int  // total length
        val jsonLen = buf.int
        buf.int  // 'JSON'
        val jsonBytes = ByteArray(jsonLen).also { buf.get(it) }
        val json = String(jsonBytes, Charsets.UTF_8).trimEnd(' ')
        val binBytes = if (buf.hasRemaining()) {
            val binLen = buf.int
            buf.int  // 'BIN '
            ByteArray(binLen).also { buf.get(it) }
        } else null
        return json to binBytes
    }
}
