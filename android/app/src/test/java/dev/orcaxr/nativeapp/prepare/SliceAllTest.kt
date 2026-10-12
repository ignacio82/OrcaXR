package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.SliceFigures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Slice All Plates as the browser's `sliceAllPlates` words and picks it. */
class SliceAllTest {
    private fun units(text: String) = text.map { it.code }
    private val absent = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)

    private fun issue(severity: ProjectIntents.PreflightSeverity, message: String) = ProjectIntents.PreflightIssue(
        units("issue-$message"), ProjectIntents.PreflightCode.InstanceOutsideBuildVolume, absent, severity, units(message), units("help"),
        absent, emptyList(), emptyList(),
    )

    @Test
    fun theStatusIsTheBrowsersWithTheTotalInWholeKilobytes() {
        assertEquals("SLICED 2 plate(s) in 1500 ms\n3 KB total", SliceAll.describe(2, 1500, 3 * 1024, 0))
        assertEquals("SLICED 3 plate(s) in 9 ms\n12 KB total, 2 warning(s)", SliceAll.describe(3, 9, 12 * 1024 + 100, 2))
        // `toFixed(0)` of an exact quotient: a half rounds up, just under a half down.
        assertEquals(1L, SliceAll.kilobytes(512))
        assertEquals(0L, SliceAll.kilobytes(511))
        assertEquals(2L, SliceAll.kilobytes(1536))
        assertEquals(1L, SliceAll.kilobytes(1535))
        assertEquals(0L, SliceAll.kilobytes(0))
    }

    @Test
    fun progressIsTheRoutesPercentElseTheShareOfPlatesDone() {
        assertEquals(37.0, SliceAll.percent(0, 2, 37.0)!!, 0.0)
        assertEquals(0.0, SliceAll.percent(0, 2, null)!!, 0.0)
        assertEquals(50.0, SliceAll.percent(1, 2, null)!!, 0.0)
        // `Math.round`: a third is 33, two thirds 67.
        assertEquals(33.0, SliceAll.percent(1, 3, null)!!, 0.0)
        assertEquals(67.0, SliceAll.percent(2, 3, null)!!, 0.0)
        assertNull(SliceAll.percent(0, 0, null))
    }

    @Test
    fun previewAndSendTakeTheActivePlatesResultElseTheFirst() {
        val results = listOf("plate-a" to "A", "plate-b" to "B")
        assertEquals("B", SliceAll.published(results, { it.first }, "plate-b")?.second)
        assertEquals("A", SliceAll.published(results, { it.first }, "plate-c")?.second)
        assertEquals("A", SliceAll.published(results, { it.first }, null)?.second)
        assertNull(SliceAll.published(emptyList<Pair<String, String>>(), { it.first }, "plate-a"))
    }

    @Test
    fun warningsAreCountedOnceEach() {
        val first = SliceAll.plateWarnings(
            listOf("Archive note"),
            listOf(
                issue(ProjectIntents.PreflightSeverity.Warning, "Near the edge"),
                issue(ProjectIntents.PreflightSeverity.Error, "Outside"),
                issue(ProjectIntents.PreflightSeverity.Warning, "Near the edge"),
            ),
        )
        assertEquals(setOf("Archive note", "Near the edge"), first)
        val second = SliceAll.plateWarnings(listOf("Archive note"), emptyList())
        assertEquals(2, SliceAll.warnings(listOf(first, second)))
        assertEquals(0, SliceAll.warnings(listOf(emptySet(), emptySet())))
    }

    @Test
    fun aPlatesRowSaysWhatTheStatusLineSaysOfItsFile() {
        val figures = SliceFigures(2048, "2", 120, "10", "10", 10)
        assertEquals("Plate 1: 2 KB, 120 lines, 10 layers", SliceAll.row("Plate 1", figures, 0))
        assertEquals("Plate 2: 2 KB, 120 lines, 10 layers, 1 warning(s)", SliceAll.row("Plate 2", figures, 1))
    }

    @Test
    fun aChangeDiscardsEveryPlateInTheBrowsersWords() {
        assertEquals("The project changed while slicing; the stale results were discarded. Slice again.", SliceAll.STALE)
    }
}
