package dev.orcaxr.renderer

import org.junit.Assert.*
import org.junit.Test

class ScenePaintTest {
    /** A strip of [count] facets, every one its own shade. */
    private fun strip(count: Int): TriangleMesh {
        val xyz = FloatArray((count + 2) * 3) { if (it % 3 == 0) (it / 3).toFloat() else if (it % 3 == 1) ((it / 3) % 2).toFloat() else 0f }
        val indices = IntArray(count * 3) { n -> n / 3 + n % 3 }
        val colors = IntArray(count) { facet -> (0xff shl 24) or (0x40 + facet).let { (it shl 16) or (it shl 8) or it } }
        return TriangleMesh.copyOf("strip-$count", xyz, indices, colors)
    }
    private fun data(colors: List<String>, vararg runs: Int, leaves: FloatArray = FloatArray(0), leafStates: IntArray = IntArray(0)) =
        PaintFacetData(colors.map(PaintFacetData::rgb).toIntArray(), runs, leaves, leafStates)
    private fun shown(update: PaintUpdate?): Map<Int, Int> =
        update?.ranges.orEmpty().flatMap { range -> range.colors.indices.map { range.first + it to range.colors[it] } }.toMap()

    @Test fun ownColoursCarryTheShadeAndNoTint() {
        // Half grey shades half the colour; alpha 0 keeps the draw's tint off.
        assertEquals(0x001a334d, ScenePaint.own(0xff808080.toInt(), 0x336699))
        assertEquals(0x00336699, ScenePaint.own(0xffffffff.toInt(), 0x336699))
        // A tinted vertex lights the tint by its shade; an own colour is itself.
        assertEquals(0x00808080 and 0xffffff, ScenePaint.lit(0xff808080.toInt(), 0xffffffff.toInt()))
        assertEquals(0x123456, ScenePaint.lit(0x00123456, 0xffffffff.toInt()))
        // The browser's 55% preview over what is shown.
        assertEquals(0x008c0073, ScenePaint.preview(0xff0000, 0x0000ff))
        assertEquals(0xff3366, PaintFacetData.rgb("#f36"))
    }

    @Test fun canonicalPaintSendsOnlyTheFacetsWhoseColourChanged() {
        val mesh = strip(200)
        val paint = ScenePaint()
        // Nothing painted, before or now: nothing to send.
        assertNull(paint.canonical("v", "a", mesh, 0xffb8bec8.toInt(), null))
        val first = paint.canonical("v", "a", mesh, 0xffb8bec8.toInt(), data(listOf("#ff0000", "#0000ff"), 10, 3, 0, 100, 2, 1))!!
        assertEquals("a", first.assetId)
        assertEquals(200, first.facetCount)
        val colours = shown(first)
        assertEquals((10..12).associateWith { ScenePaint.own(mesh.facetColor(it), 0xff0000) } + (100..101).associateWith { ScenePaint.own(mesh.facetColor(it), 0x0000ff) }, colours)
        assertEquals(2, first.ranges.size)
        assertFalse(first.leavesChanged)
        // The same paint again changes nothing.
        assertNull(paint.canonical("v", "a", mesh, 0xffb8bec8.toInt(), data(listOf("#ff0000", "#0000ff"), 10, 3, 0, 100, 2, 1)))
        // Facet 12 erased and 13 painted: the two facets alone, 12 back to its shade.
        val second = paint.canonical("v", "a", mesh, 0xffb8bec8.toInt(), data(listOf("#ff0000", "#0000ff"), 10, 2, 0, 13, 1, 0, 100, 2, 1))!!
        assertEquals(mapOf(12 to mesh.facetColor(12), 13 to ScenePaint.own(mesh.facetColor(13), 0xff0000)), shown(second))
        // Unpainted again: the painted facets return to their shades (12, between them, rides along).
        val cleared = paint.canonical("v", "a", mesh, 0xffb8bec8.toInt(), PaintFacetData.NONE)!!
        assertEquals(listOf(10, 11, 12, 13, 100, 101).associateWith { mesh.facetColor(it) }, shown(cleared))
    }

    @Test fun shortUnchangedGapsRideAlongAndRangesAreBounded() {
        val mesh = strip(40_000)
        val paint = ScenePaint()
        val update = paint.canonical("v", "a", mesh, -1, data(listOf("#00ff00"), 0, 1, 0, 20, 1, 0, 1000, 1, 0, 2000, 34_000, 0))!!
        // 0 and 20 ride in one range; 1000 is its own; 34,000 facets split at the bound.
        assertEquals(listOf(0, 1000, 2000, 2000 + ScenePaint.MAX_RANGE, 2000 + 2 * ScenePaint.MAX_RANGE), update.ranges.map { it.first })
        assertEquals(21, update.ranges[0].colors.size)
        assertEquals(mesh.facetColor(5), update.ranges[0].colors[5])
        assertTrue(update.ranges.all { it.colors.size <= ScenePaint.MAX_RANGE })
    }

    @Test fun aPreviewBlendsOverWhatIsShownAndEndsBackAtTheCanonicalPaint() {
        val mesh = strip(50)
        val paint = ScenePaint()
        val tint = 0xff336699.toInt()
        assertNull(paint.preview("v", data(listOf("#ff0000"), 0, 1, 0)))
        paint.canonical("v", "a", mesh, tint, data(listOf("#0000ff"), 5, 1, 0))
        val preview = paint.preview("v", data(listOf("#ff0000"), 4, 2, 0))!!
        assertEquals(
            mapOf(
                4 to ScenePaint.preview(0xff0000, ScenePaint.lit(mesh.facetColor(4), tint)),
                5 to ScenePaint.preview(0xff0000, ScenePaint.own(mesh.facetColor(5), 0x0000ff)),
            ),
            shown(preview),
        )
        // A refined preview hides the canonical paint, as the browser hides its overlay.
        val refined = paint.preview("v", data(listOf("#ff0000"), 4, 1, 0), hideCanonical = true)!!
        assertEquals(mapOf(5 to mesh.facetColor(5)), shown(refined))
        val ended = paint.preview("v", null)!!
        assertEquals(mapOf(4 to mesh.facetColor(4), 5 to ScenePaint.own(mesh.facetColor(5), 0x0000ff)), shown(ended))
    }

    @Test fun leavesDrawOverTheirFacetsAndChangeAlone() {
        val mesh = strip(10)
        val paint = ScenePaint()
        val corners = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f)
        val first = paint.canonical("v", "a", mesh, -1, data(listOf("#ff0000"), leaves = corners, leafStates = intArrayOf(0)))!!
        assertTrue(first.ranges.isEmpty() && first.leavesChanged)
        val leaves = first.leaves!!
        assertEquals(1, leaves.count)
        // An upward facet under the fixed light: its own shade, alpha 0.
        assertEquals(ScenePaint.own(PacketMeshes.shade(Point3(0.0, 0.0, 1.0)), 0xff0000), leaves.colors.single())
        assertNull(paint.canonical("v", "a", mesh, -1, data(listOf("#ff0000"), leaves = corners, leafStates = intArrayOf(0))))
        val gone = paint.canonical("v", "a", mesh, -1, null)!!
        assertTrue(gone.leavesChanged && gone.leaves == null)
    }

    @Test fun aNewMeshStartsAfreshAndARendererMadeAfreshGetsEverything() {
        val paint = ScenePaint()
        val mesh = strip(30)
        paint.canonical("v", "a", mesh, -1, data(listOf("#ff0000"), 3, 2, 0))
        paint.canonical("w", "b", strip(5), -1, null)
        val everything = paint.everything()
        assertEquals(listOf("v"), everything.map { it.volumeId })
        assertEquals(mapOf(3 to ScenePaint.own(mesh.facetColor(3), 0xff0000), 4 to ScenePaint.own(mesh.facetColor(4), 0xff0000)), shown(everything.single()))
        // The volume's mesh changed: its paint is sent whole against the new mesh's shades.
        val other = strip(30)
        val fresh = paint.canonical("v", "c", other, -1, data(listOf("#ff0000"), 3, 2, 0))!!
        assertEquals("c", fresh.assetId)
        assertEquals(setOf(3, 4), shown(fresh).keys)
        paint.retain(setOf("w"))
        assertEquals(setOf("w"), paint.volumeIds)
    }

    @Test fun malformedFacetsRefuse() {
        assertThrows(IllegalArgumentException::class.java) { PaintFacetData(intArrayOf(0), intArrayOf(0, 1, 1), FloatArray(0), IntArray(0)) }
        assertThrows(IllegalArgumentException::class.java) { PaintFacetData.rgb("red") }
        assertThrows(IllegalArgumentException::class.java) { ScenePaint().canonical("v", "a", strip(3), -1, data(listOf("#ff0000"), 2, 5, 0)) }
    }
}
