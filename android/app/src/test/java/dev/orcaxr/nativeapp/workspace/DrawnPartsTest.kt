package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.DrawnPartTarget
import dev.orcaxr.core.ProjectEmbossing
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectSvgParts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Emboss Text and SVG Part tools' platform-free parts: their recipes and
 * words, as the browser's workspace and panels keep and write them.
 */
class DrawnPartsTest {
    private fun units(text: String) = text.map { it.code }
    private val preview = ProjectIntents.EmbossPreview(904, 460, emptyList(), 0, 0, units("fnv1a64:0"), 1)

    @Test fun aNumberFieldHandsItsNumberOverAsANumberInputDoes() {
        assertEquals(1.5, HtmlNumberInput.value("1.5"), 0.0)
        assertEquals(-1.25, HtmlNumberInput.value("-1.25"), 0.0)
        assertEquals(0.0, HtmlNumberInput.value(""), 0.0)
        assertEquals(0.0, HtmlNumberInput.value("1."), 0.0)
        assertEquals(0.0, HtmlNumberInput.value("2 mm"), 0.0)
    }

    @Test fun theRecipeIsTheBrowsers() {
        val start = ProjectEmbossing.DEFAULT_CONFIGURATION
        assertEquals("Text", ProjectEmbossing.text(start))
        assertEquals(10.0, ProjectEmbossing.number(start, ProjectEmbossing.Field.SIZE), 0.0)
        assertEquals(1.0, ProjectEmbossing.number(start, ProjectEmbossing.Field.DEPTH), 0.0)
        // A font names the recipe; a later one keeps the first style name, as `loadEmbossFont` does.
        val named = ProjectEmbossing.named(start, "a.ttf")
        assertEquals(units("a.ttf"), named.styleName)
        assertEquals(units("a.ttf"), named.fontDescriptor)
        val renamed = ProjectEmbossing.named(named, "b.ttf")
        assertEquals(units("a.ttf"), renamed.styleName)
        assertEquals(units("b.ttf"), renamed.fontDescriptor)
        // Numbers are taken as handed over, a cut refusing what it cannot use.
        val edited = ProjectEmbossing.withNumber(start, ProjectEmbossing.Field.LINE_GAP, -3.0)
        assertEquals(-3.0, edited.font.lineGapMm, 0.0)
        assertEquals(ProjectIntents.EmbossVerticalAlign.Top, ProjectEmbossing.withAlign(start, ProjectIntents.EmbossVerticalAlign.Top).font.vertical)
        assertNull(ProjectSvgParts.width(0.0))
        assertNull(ProjectSvgParts.width(-2.0))
        assertEquals(25.0, ProjectSvgParts.width(25.0))
        val request = ProjectSvgParts.request("logo.svg", 2.0, null)
        assertEquals(ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty), request.widthMm)
        assertEquals(false, request.useSurface)
    }

    @Test fun theWordsAreTheBrowsers() {
        assertEquals("Emboss: type the text, then add it to the selected part.", ProjectEmbossing.start(true))
        assertEquals("Loaded sample.ttf for embossing.", ProjectEmbossing.loaded("sample.ttf"))
        assertEquals("Could not read that font: That file is not a TrueType font", ProjectEmbossing.unreadable("That file is not a TrueType font"))
        assertEquals("Emboss failed: Embossed text cannot be empty", ProjectEmbossing.failed("Embossed text cannot be empty"))
        assertEquals("Embossed the text as 904 triangles.", ProjectEmbossing.embossed("sample.ttf", preview))
        assertEquals(
            "Embossed the text — sample.ttf has no glyph for z 😀; 3 edges did not close.",
            ProjectEmbossing.embossed("sample.ttf", preview.copy(missingCodePoints = listOf(0x7aL, 0x1f600L), openEdgeCount = 3)),
        )
        assertEquals("Editing the selected text re-cuts its mesh; undo restores the previous cut.", ProjectEmbossing.hint(true, DrawnPartTarget("o", "v")))
        assertEquals("Adds the text as a new part of the selected model.", ProjectEmbossing.hint(true, DrawnPartTarget("o")))
        assertEquals("Select one model part to add the text to.", ProjectEmbossing.hint(true, DrawnPartTarget()))
        assertEquals("SVG part: choose an .svg file to cut.", ProjectSvgParts.start(false))
        val drawing = ProjectIntents.SvgDrawingSummary(listOf(40.0, 0.05), emptyList(), 2)
        // `toFixed(1)`: the exact binary value rounded half up, trailing zeros kept.
        assertEquals("Loaded a.svg at 40.0 x 0.1 mm. 2 part(s) of it cannot be cut.", ProjectSvgParts.loaded("a.svg", drawing))
        assertEquals("Loaded a.svg at 1.1 x 0.0 mm.", ProjectSvgParts.loaded("a.svg", drawing.copy(sizeMm = listOf(1.05, 0.0), unsupportedCount = 0)))
        assertEquals("Loaded a.svg at 1.1 x 1e+21 mm.", ProjectSvgParts.loaded("a.svg", drawing.copy(sizeMm = listOf(1.15, 1e21), unsupportedCount = 0)))
        val cut = ProjectIntents.SvgPartPreview(
            284, 150, 2, 0, listOf(25.0, 12.5),
            listOf(ProjectIntents.SvgUnsupportedFeature(units("text"), ProjectIntents.SvgUnsupportedReason.NeedsFont, units("<text> needs a font"))),
            1, units("d"), 1, units("d"), 1,
        )
        assertEquals("Cut badge.svg at 25.0 x 12.5 mm. Not cut: <text> needs a font 2 edges did not close.", ProjectSvgParts.cut("badge.svg", cut))
        assertEquals("SVG part failed: That drawing produced no geometry to cut", ProjectSvgParts.failed("That drawing produced no geometry to cut"))
        assertEquals("Changing the size re-cuts the selected part; undo restores it.", ProjectSvgParts.hint(true, DrawnPartTarget("o", svgVolumeId = "v")))
        assertNull(ProjectSvgParts.hint(true, DrawnPartTarget()))
    }
}
