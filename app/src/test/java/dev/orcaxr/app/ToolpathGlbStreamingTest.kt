package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Roadmap A7 — close-out tests for the streaming-tubes refactor:
 *   - mitered joins between connected segments produce a shared
 *     cross-section at the join (the two segments' v4..v7 ≈ the
 *     next segment's v0..v3).
 *   - chain breaks (start/end of chain, or two segments that don't
 *     share endpoints) keep the per-segment perpendicular cross-
 *     section behavior unchanged.
 *   - the bbox accessor in the GLB header includes the radius
 *     padding so a viewer's frustum culling sees the prism's full
 *     envelope, not just the centerline.
 *   - 1500-segment slice (well above the pre-streaming 250k cap
 *     boundary scaled down for unit-test speed) still produces a
 *     valid GLB without OOM. The streaming code path holds at most
 *     a 64 KB scratch + a per-segment frame cache regardless of N.
 */
class ToolpathGlbStreamingTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Two L-shaped segments — segment 0 runs +X for 10 mm, segment 1
     *  runs +Y for 10 mm starting where segment 0 ended. Both at the
     *  same Z. The shared endpoint at (10, 0, 0.2) is the miter join. */
    private fun lShapeToolpath(): ParsedToolpath {
        val z = 0.2f
        val a = ExtrusionSegment(Vec3f(0f, 0f, z), Vec3f(10f, 0f, z), z, ExtrusionRole.OuterWall, extruder = 0)
        val b = ExtrusionSegment(Vec3f(10f, 0f, z), Vec3f(10f, 10f, z), z, ExtrusionRole.OuterWall, extruder = 0)
        return ParsedToolpath(
            segments = listOf(a, b),
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = 2, extrusionSegments = 2, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z), bboxMax = Vec3f(10f, 10f, z),
                totalExtrusionLengthMm = 20.0,
            ),
            layerZs = listOf(z),
        )
    }

    @Test fun mitered_join_corners_align_at_shared_endpoint() {
        // Segment 0's end-corners (v4..v7) should land at the same
        // location as segment 1's start-corners (v0..v3) — that's the
        // load-bearing miter property.
        val out = tmp.newFile("miter.glb")
        ToolpathGlb.write(
            lShapeToolpath(), out, tubes = true, tubeRadiusMm = 0.5f,
            colorMode = ToolpathGlb.ColorMode.Auto,
        )
        val (json, binNullable) = parseGlb(out.readBytes())
        val bin = binNullable!!
        // Counts: 2 segs × 8 verts = 16, 2 × 12 tris × 3 = 72.
        assertTrue(json.contains(""""count":16"""))
        assertTrue(json.contains(""""count":72"""))

        val buf = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN)
        // Read all 16 vertex positions in order.
        val verts = Array(16) { Triple(buf.float, buf.float, buf.float) }

        // Segment 0 verts: [0..7]. End corners (v4..v7) live at
        // [4..7]. Segment 1 verts: [8..15]. Start corners (v0..v3)
        // at [8..11]. Mitered join means each pair of corresponding
        // corners (v4↔v0', v5↔v1', v6↔v2', v7↔v3') match.
        for (k in 0 until 4) {
            val seg0End = verts[4 + k]
            val seg1Start = verts[8 + k]
            assertCloseXYZ(seg0End, seg1Start, "corner $k")
        }
    }

    @Test fun chain_break_falls_back_to_per_segment_cross_section() {
        // Two segments that DON'T share endpoints. seg 0 runs +X from
        // (0,0,0.2) to (10,0,0.2); seg 1 runs +Y from (50,50,0.2) to
        // (50,60,0.2). No miter happens; each segment uses its own
        // perpendicular cross-section.
        val z = 0.2f
        val tp = ParsedToolpath(
            segments = listOf(
                ExtrusionSegment(Vec3f(0f, 0f, z), Vec3f(10f, 0f, z), z),
                ExtrusionSegment(Vec3f(50f, 50f, z), Vec3f(50f, 60f, z), z),
            ),
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = 2, extrusionSegments = 2, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z), bboxMax = Vec3f(50f, 60f, z),
                totalExtrusionLengthMm = 20.0,
            ),
            layerZs = listOf(z),
        )
        val out = tmp.newFile("nojoin.glb")
        ToolpathGlb.write(tp, out, tubes = true, tubeRadiusMm = 0.5f)
        val (_, binNullable) = parseGlb(out.readBytes())
        val bin = binNullable!!
        val buf = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN)
        val verts = Array(16) { Triple(buf.float, buf.float, buf.float) }
        // Segment 0's end corners (v4..v7) live near the segment-0 endpoint
        // (after recentering on bbox center). Segment 1's start corners
        // (v0..v3) live nowhere near them. Distance > 30 mm rules out
        // any accidental miter alignment.
        for (k in 0 until 4) {
            val seg0End = verts[4 + k]
            val seg1Start = verts[8 + k]
            val dx = seg0End.first - seg1Start.first
            val dy = seg0End.second - seg1Start.second
            val dz = seg0End.third - seg1Start.third
            val d = kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
            assertTrue(
                "expected disconnected segments to NOT miter (corner $k distance $d)",
                d > 30f,
            )
        }
    }

    @Test fun bbox_accessor_includes_radius_padding() {
        // GLB header's POSITION accessor min/max is consulted by viewers
        // for frustum culling. Pre-streaming the bbox came from the
        // pre-allocated FloatArray (which already had radius-padded
        // corners). Streaming computes the bbox from the centerline,
        // so we explicitly inflate by `radius` — verify the JSON's
        // min/max reflects that.
        val out = tmp.newFile("bbox.glb")
        ToolpathGlb.write(
            lShapeToolpath(), out, tubes = true, tubeRadiusMm = 0.5f,
        )
        val (json, _) = parseGlb(out.readBytes())
        // After recentering, the centerline x-min ≈ -5 (10mm extent
        // centered at 5). With radius padding 0.5, x-min in JSON ≈ -5.5.
        // Just check the json bbox extent is >= centerline + radius.
        val minMatch = Regex(""""min":\[(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\]""").find(json)
            ?: error("min not found in JSON")
        val maxMatch = Regex(""""max":\[(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\]""").find(json)
            ?: error("max not found in JSON")
        val xMin = minMatch.groupValues[1].toFloat()
        val xMax = maxMatch.groupValues[1].toFloat()
        // Centerline is 10 mm wide → recentered range is ≈ [-5, +5].
        // With radius padding 0.5, the accessor bbox should reach at
        // least [-5.5, +5.5].
        assertTrue("xMin=$xMin should be ≤ -5.4 with radius padding", xMin <= -5.4f)
        assertTrue("xMax=$xMax should be ≥ 5.4 with radius padding", xMax >= 5.4f)
    }

    @Test fun streams_1500_segments_without_oom_or_lines_fallback() {
        // Pre-streaming, anything above TUBES_SEGMENT_CAP fell back to
        // LINES. The new cap is 1.5M; here we confirm that even a 1500-
        // segment input (well within the cap, but enough to exercise
        // the streaming path several times over the 64 KB chunk
        // boundary) emits TRIANGLES with the expected counts.
        val n = 1500
        val z = 0.2f
        val segs = (0 until n).map { i ->
            // Long zigzag — alternating +X / +Y so consecutive segments
            // share endpoints (testing the miter path under load).
            val x0 = (i * 1f) % 100f
            val y0 = (i * 1f) / 100f
            val xN = if (i % 2 == 0) x0 + 1f else x0
            val yN = if (i % 2 == 0) y0 else y0 + 1f
            ExtrusionSegment(
                start = Vec3f(x0, y0, z),
                end = Vec3f(xN, yN, z),
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
                bboxMax = Vec3f(100f, 15f, z),
                totalExtrusionLengthMm = n.toDouble(),
            ),
            layerZs = listOf(z),
        )
        val out = tmp.newFile("big.glb")
        ToolpathGlb.write(tp, out, tubes = true, tubeRadiusMm = 0.18f)
        val (json, _) = parseGlb(out.readBytes())
        // mode=4 is TRIANGLES — confirms we did NOT fall back to LINES.
        assertTrue("expected TRIANGLES mode at 1500 segs", json.contains(""""mode":4"""))
        val counts = Regex(""""count":(\d+)""").findAll(json)
            .map { it.groupValues[1].toInt() }.toList()
        // Order: positions(N*8), colors(N*8), indices(N*36).
        assertEquals(n * 8, counts[0])
        assertEquals(n * 8, counts[1])
        assertEquals(n * 36, counts[2])
        assertTrue("output file should be non-empty", out.length() > 0)
    }

    @Test fun cap_above_segment_count_keeps_tubes_mode() {
        // Pin TUBES_SEGMENT_CAP at the new (post-streaming) value.
        // Removing this assert would silently regress the streaming
        // path back to the old 250k-LINES fallback.
        assertTrue(
            "TUBES_SEGMENT_CAP must be ≥ 1M to handle a 500k+ dragon",
            ToolpathGlb.TUBES_SEGMENT_CAP >= 1_000_000,
        )
    }

    private fun assertCloseXYZ(
        a: Triple<Float, Float, Float>,
        b: Triple<Float, Float, Float>,
        label: String,
        tol: Float = 0.05f,
    ) {
        val dx = a.first - b.first
        val dy = a.second - b.second
        val dz = a.third - b.third
        val d = kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
        assertTrue("$label: expected $a ≈ $b, distance $d", d < tol)
    }

    private fun parseGlb(bytes: ByteArray): Pair<String, ByteArray?> {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val magic = buf.int
        require(magic == 0x46546C67) { "not a GLB" }
        buf.int; buf.int
        val jsonLen = buf.int; buf.int
        val jsonBytes = ByteArray(jsonLen).also { buf.get(it) }
        val json = String(jsonBytes, Charsets.UTF_8).trimEnd(' ')
        val binBytes = if (buf.hasRemaining()) {
            val binLen = buf.int; buf.int
            ByteArray(binLen).also { buf.get(it) }
        } else null
        return json to binBytes
    }
}
