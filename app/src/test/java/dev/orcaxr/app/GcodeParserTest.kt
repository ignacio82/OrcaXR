package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GcodeParserTest {

    /** A few lines of synthesized G-code covering the modal-state cases. */
    private val sample = """
        ;HEADER comment, ignored
        G28 X Y Z          ; ignored — not G0/G1
        M104 S210
        G1 X10 Y20 Z0.3 F1500   ; travel (no E)
        G1 X30 Y20 E1.5         ; extrude
        G1 X30 Y40 E3.0         ; extrude
        G1 Z0.6                 ; layer change, also travel
        G1 X10 Y40 E4.5         ; extrude on layer 2
        G1 X10 Y20 E6.0         ; extrude
        ; trailing comment
    """.trimIndent()

    @Test
    fun parsesExtrusionsAndIgnoresTravels() {
        val parsed = GcodeParser.parse(sample.lineSequence())
        // Extrusions: 4 (the four G1 lines that grow E).
        assertEquals(4, parsed.segments.size)
        // Travels: G28 isn't a G0/G1; only the two pure-XY/Z moves count
        // (X10Y20Z0.3 from origin, then Z0.6).
        assertEquals(2, parsed.stats.travelSegments)
    }

    @Test
    fun bboxAndLayerCount() {
        val parsed = GcodeParser.parse(sample.lineSequence())
        assertEquals(2, parsed.stats.distinctZLayers)
        assertEquals(10f, parsed.stats.bboxMin.x)
        assertEquals(30f, parsed.stats.bboxMax.x)
        assertEquals(20f, parsed.stats.bboxMin.y)
        assertEquals(40f, parsed.stats.bboxMax.y)
        assertEquals(0.3f, parsed.stats.bboxMin.z)
        assertEquals(0.6f, parsed.stats.bboxMax.z)
    }

    @Test
    fun extrusionLengthMatchesEuclidean() {
        val parsed = GcodeParser.parse(sample.lineSequence())
        // Four extrusion segments, summed:
        //   (10,20,0.3) → (30,20,0.3)  = 20
        //   (30,20,0.3) → (30,40,0.3)  = 20
        //   (30,40,0.6) → (10,40,0.6)  = 20  (after Z change)
        //   (10,40,0.6) → (10,20,0.6)  = 20
        // = 80
        assertEquals(80.0, parsed.stats.totalExtrusionLengthMm, 0.01)
    }

    @Test
    fun parsesRoleTagsFromTypeComments() {
        val tagged = """
            G1 X0 Y0 Z0.3
            ;TYPE:Outer wall
            G1 X10 Y0 E1.0
            G1 X10 Y10 E2.0
            ;TYPE:Sparse infill
            G1 X5 Y5 E3.0
            ; an unrelated comment
            G1 X8 Y8 E4.0
        """.trimIndent()
        val parsed = GcodeParser.parse(tagged.lineSequence())
        assertEquals(4, parsed.segments.size)
        assertEquals(ExtrusionRole.OuterWall, parsed.segments[0].role)
        assertEquals(ExtrusionRole.OuterWall, parsed.segments[1].role)
        assertEquals(ExtrusionRole.SparseInfill, parsed.segments[2].role)
        assertEquals(ExtrusionRole.SparseInfill, parsed.segments[3].role)
    }

    @Test
    fun unknownRoleTagFallsBackToUnknownEnum() {
        val tagged = """
            ;TYPE:Some made up role
            G1 X1 Y1 Z0.3 E0.5
        """.trimIndent()
        val parsed = GcodeParser.parse(tagged.lineSequence())
        assertEquals(ExtrusionRole.Unknown, parsed.segments.first().role)
    }

    @Test
    fun parsesLibslic3rSummaryComments() {
        val withSummary = """
            G1 X10 Y10 Z0.3 E0.5
            ; total filament used [g] = 8.32
            ; total layers count = 47
            ; estimated printing time (normal mode) = 1h 23m 45s
        """.trimIndent()
        val parsed = GcodeParser.parse(withSummary.lineSequence())
        assertEquals(8.32, parsed.stats.filamentWeightG!!, 1e-6)
        assertEquals(47, parsed.stats.reportedLayerCount)
        assertEquals("1h 23m 45s", parsed.stats.estimatedPrintTime)
    }

    @Test
    fun missingSummaryFieldsAreNull() {
        val noSummary = """
            G1 X1 Y1 Z0.3 E0.5
        """.trimIndent()
        val parsed = GcodeParser.parse(noSummary.lineSequence())
        assertEquals(null, parsed.stats.filamentWeightG)
        assertEquals(null, parsed.stats.estimatedPrintTime)
        assertEquals(null, parsed.stats.reportedLayerCount)
    }

    @Test
    fun emptyInputReturnsZeroBbox() {
        val parsed = GcodeParser.parse(sequenceOf())
        assertEquals(0, parsed.segments.size)
        assertTrue(parsed.stats.bboxMin == Vec3f(0f, 0f, 0f))
        assertTrue(parsed.stats.bboxMax == Vec3f(0f, 0f, 0f))
    }
}
