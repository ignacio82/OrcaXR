package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Roadmap A14 — verify [ToolpathGlb.write]'s `colorMode` parameter
 * routes through the three valid strategies (Auto / Extruder /
 * Feature) and that each one produces the correct per-segment vertex
 * color in the output GLB.
 *
 * Fixture: 2 segments with distinct extruders AND distinct roles, so
 * a single segment's color reveals which palette won.
 *   - segment 0: extruder=0, role=OuterWall
 *     → Auto/Extruder (palette[0] = blue) vs Feature (RoleColors.OuterWall = saturated red).
 *   - segment 1: extruder=1, role=SparseInfill
 *     → Auto/Extruder (palette[1] = green) vs Feature (RoleColors.SparseInfill = yellow).
 */
class ToolpathGlbColorModeTest {
    @get:Rule val tmp = TemporaryFolder()

    private val palette = listOf("#0000FF", "#00FF00")

    private fun fixture(): ParsedToolpath {
        val z = 0.2f
        return ParsedToolpath(
            segments = listOf(
                ExtrusionSegment(Vec3f(0f, 0f, z), Vec3f(10f, 0f, z), z, ExtrusionRole.OuterWall, extruder = 0),
                ExtrusionSegment(Vec3f(10f, 0f, z), Vec3f(10f, 10f, z), z, ExtrusionRole.SparseInfill, extruder = 1),
            ),
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

    @Test fun parse_resolves_known_aliases() {
        assertEquals(ToolpathGlb.ColorMode.Auto, ToolpathGlb.ColorMode.parse(null))
        assertEquals(ToolpathGlb.ColorMode.Auto, ToolpathGlb.ColorMode.parse("auto"))
        assertEquals(ToolpathGlb.ColorMode.Auto, ToolpathGlb.ColorMode.parse("UnknownGarbage"))
        assertEquals(ToolpathGlb.ColorMode.Extruder, ToolpathGlb.ColorMode.parse("extruder"))
        assertEquals(ToolpathGlb.ColorMode.Extruder, ToolpathGlb.ColorMode.parse("TOOL"))
        assertEquals(ToolpathGlb.ColorMode.Extruder, ToolpathGlb.ColorMode.parse("filament"))
        assertEquals(ToolpathGlb.ColorMode.Feature, ToolpathGlb.ColorMode.parse("feature"))
        assertEquals(ToolpathGlb.ColorMode.Feature, ToolpathGlb.ColorMode.parse("ROLE"))
        assertEquals(ToolpathGlb.ColorMode.Feature, ToolpathGlb.ColorMode.parse("type"))
    }

    @Test fun auto_mode_with_two_tools_uses_extruder_palette() {
        // 2 distinct extruders + non-empty palette → byExtruder=true.
        val out = tmp.newFile("auto.glb")
        ToolpathGlb.write(
            fixture(), out,
            extruderPalette = palette,
            colorMode = ToolpathGlb.ColorMode.Auto,
        )
        val seg0 = readSegmentColor(out, segmentIndex = 0)
        val seg1 = readSegmentColor(out, segmentIndex = 1)
        // palette[0] = #0000FF → blue, palette[1] = #00FF00 → green.
        assertVeryClose(Triple(0f, 0f, 1f), seg0)
        assertVeryClose(Triple(0f, 1f, 0f), seg1)
    }

    @Test fun feature_mode_overrides_extruder_palette() {
        // Feature mode forces per-role coloring even though the slice
        // has 2 distinct extruders + a palette. seg 0 = OuterWall (red),
        // seg 1 = SparseInfill (yellow).
        val out = tmp.newFile("feature.glb")
        ToolpathGlb.write(
            fixture(), out,
            extruderPalette = palette,
            colorMode = ToolpathGlb.ColorMode.Feature,
        )
        val seg0 = readSegmentColor(out, segmentIndex = 0)
        val seg1 = readSegmentColor(out, segmentIndex = 1)
        val ow = RoleColors.colorFor(ExtrusionRole.OuterWall)
        val si = RoleColors.colorFor(ExtrusionRole.SparseInfill)
        assertVeryClose(Triple(ow.r, ow.g, ow.b), seg0)
        assertVeryClose(Triple(si.r, si.g, si.b), seg1)
        // And — sanity — seg0's role color must NOT equal palette[0].
        // (If the byExtruder path leaked in, seg0 would be pure blue.)
        assertNotEquals(Triple(0f, 0f, 1f), seg0)
    }

    @Test fun extruder_mode_forces_palette_even_on_single_tool() {
        // Single-tool slice + Extruder mode + palette → palette[0] wins.
        // Auto mode would fall back to per-role here (distinctExtruders == 1).
        val z = 0.2f
        val singleTool = ParsedToolpath(
            segments = listOf(
                ExtrusionSegment(Vec3f(0f, 0f, z), Vec3f(10f, 0f, z), z, ExtrusionRole.OuterWall, extruder = 0),
            ),
            travels = emptyList(),
            stats = GcodeStats(
                totalLines = 1, extrusionSegments = 1, travelSegments = 0,
                distinctZLayers = 1,
                bboxMin = Vec3f(0f, 0f, z),
                bboxMax = Vec3f(10f, 0f, z),
                totalExtrusionLengthMm = 10.0,
            ),
            layerZs = listOf(z),
        )
        val outAuto = tmp.newFile("single_auto.glb")
        ToolpathGlb.write(
            singleTool, outAuto,
            extruderPalette = palette,
            colorMode = ToolpathGlb.ColorMode.Auto,
        )
        val outExt = tmp.newFile("single_ext.glb")
        ToolpathGlb.write(
            singleTool, outExt,
            extruderPalette = palette,
            colorMode = ToolpathGlb.ColorMode.Extruder,
        )
        val sa = readSegmentColor(outAuto, 0, totalSegs = 1)
        val se = readSegmentColor(outExt, 0, totalSegs = 1)
        // Auto fell back to per-role → red(ish).
        val ow = RoleColors.colorFor(ExtrusionRole.OuterWall)
        assertVeryClose(Triple(ow.r, ow.g, ow.b), sa)
        // Extruder forced palette[0] → pure blue.
        assertVeryClose(Triple(0f, 0f, 1f), se)
    }

    /** Reads back the first vertex's RGB color for the given LINES-mode segment. */
    private fun readSegmentColor(
        file: java.io.File,
        segmentIndex: Int,
        totalSegs: Int = 2, // default matches fixture()
    ): Triple<Float, Float, Float> {
        val (_, binNullable) = parseGlb(file.readBytes())
        val bin = binNullable
        assertNotNull(bin); requireNotNull(bin)
        // Layout: positions[2*N*3] floats, then colors[2*N*3] floats, then indices[2*N] ints.
        // Each segment has 2 vertices → 6 floats positions, 6 floats colors per segment.
        val buf = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN)
        // Skip positions block. Position floats are 4 bytes each.
        val posFloats = totalSegs * 6
        for (i in 0 until posFloats) buf.float
        // Now at colors. Skip to segment 0's first vertex (index = segmentIndex * 2).
        val verticesToSkip = segmentIndex * 2
        for (i in 0 until verticesToSkip * 4) buf.get()
        val r = (buf.get().toInt() and 0xFF) / 255f
        val g = (buf.get().toInt() and 0xFF) / 255f
        val b = (buf.get().toInt() and 0xFF) / 255f
        buf.get() // skip alpha
        return Triple(r, g, b)
    }

    private fun assertVeryClose(
        expected: Triple<Float, Float, Float>,
        got: Triple<Float, Float, Float>,
        tol: Float = 0.05f,
    ) {
        val (er, eg, eb) = expected
        val (gr, gg, gb) = got
        assertTrue(
            "expected $expected got $got (tol=$tol)",
            kotlin.math.abs(er - gr) < tol &&
                kotlin.math.abs(eg - gg) < tol &&
                kotlin.math.abs(eb - gb) < tol,
        )
    }

    /** Crack a GLB into its JSON chunk text + raw BIN chunk bytes. */
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
