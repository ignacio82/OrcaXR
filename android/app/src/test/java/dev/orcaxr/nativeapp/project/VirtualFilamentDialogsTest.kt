package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.VirtualFilamentChoice
import dev.orcaxr.core.VirtualFilamentEdit
import dev.orcaxr.core.VirtualFilamentForm
import dev.orcaxr.core.VirtualFilamentLibrary
import dev.orcaxr.core.VirtualFilamentMode
import dev.orcaxr.core.VirtualFilamentOperation
import dev.orcaxr.core.VirtualFilamentRow
import dev.orcaxr.core.VirtualFilamentSearch
import dev.orcaxr.core.VirtualFilamentSearchRequest
import dev.orcaxr.core.VirtualFilamentValidation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The library's dialogs as the browser's library runs them, over a stand-in
 * for the shared core: the fields a dialog opens with, a Match search asked
 * only when the fields ask for it, kept while they still do, the newest one
 * winning, and cancelled when the target or minimum changes or the mode
 * leaves Match; the edit it submits, and when it may.
 */
class VirtualFilamentDialogsTest {
    private fun choice(id: String, tool: Int, enabled: Boolean = true, compatible: Boolean = true) =
        VirtualFilamentChoice(id, tool, "Head $tool", "PLA", "#FF0000", enabled, compatible, null)
    private val library = VirtualFilamentLibrary(
        "{}",
        listOf(choice("a", 1), choice("b", 2), choice("c", 3, enabled = false), choice("d", 4, compatible = false)),
        listOf(VirtualFilamentRow("m1", true, "Plum", "#800080", VirtualFilamentMode.MATCH, "Target #800080", emptyList())),
        "1 virtual filament; 2 of 4 physical heads selectable.",
    )
    private val form = VirtualFilamentForm(
        "Virtual filament", "#808080", "0", "0", VirtualFilamentMode.RATIO,
        2, listOf("a", "b", "a"), "50", listOf("34", "33", "33"),
        "", "#808080", "10", null, listOf("a", "b"), true, "2",
    )

    /** The core's answers: a draft once named "Done", a Match search for a six-digit target and an integer minimum. */
    private class Core : VirtualFilamentDialogs.Exchange {
        val validated = mutableListOf<Pair<VirtualFilamentForm, VirtualFilamentSearch?>>()
        var opened: Triple<VirtualFilamentLibrary, VirtualFilamentOperation, String?>? = null
        lateinit var form: VirtualFilamentForm
        override fun opening(library: VirtualFilamentLibrary, operation: VirtualFilamentOperation, filamentId: String?): VirtualFilamentForm {
            opened = Triple(library, operation, filamentId)
            return form
        }
        override fun validate(library: VirtualFilamentLibrary, form: VirtualFilamentForm, search: VirtualFilamentSearch?): VirtualFilamentValidation {
            validated += form to search
            val ask = form.matchMinimum.toIntOrNull()?.takeIf { form.matchTarget.length == 7 }?.let { VirtualFilamentSearchRequest(form.matchTarget.uppercase(), it) }
            return VirtualFilamentValidation(
                emptyList(), "preview", if (form.name == "Done") "{\"draft\":1}" else null, null,
                if (form.mode == VirtualFilamentMode.MATCH) ask else null, null, null, null,
            )
        }
    }

    private fun opened(core: Core, mode: VirtualFilamentMode = VirtualFilamentMode.MATCH): VirtualFilamentDialogs.Author {
        core.form = form.copy(mode = mode)
        return VirtualFilamentDialogs.open(core, library, "r1", VirtualFilamentOperation.ADD, null)
    }

    @Test
    fun aDialogOpensAsTheCoreOpensItAndValidatesWithoutASearch() {
        val core = Core()
        val dialog = VirtualFilamentDialogs.open(core.also { it.form = form }, library, "r1", VirtualFilamentOperation.EDIT, library.rows[0])
        assertEquals(Triple(library, VirtualFilamentOperation.EDIT, "m1"), core.opened)
        assertEquals(form to null, core.validated.single())
        assertNull(dialog.search)
        // Ratio asks for no search.
        assertNull(VirtualFilamentDialogs.searchToStart(dialog))
    }

    @Test
    fun matchSearchesStartForTheFieldsAndTheNewestWins() {
        val core = Core()
        var dialog = opened(core)
        val request = VirtualFilamentDialogs.searchToStart(dialog)
        assertEquals(VirtualFilamentSearchRequest("#808080", 10), request)
        dialog = VirtualFilamentDialogs.searching(core, dialog, request!!, token = 1)
        assertEquals(VirtualFilamentSearch.Pending, core.validated.last().second)
        // Running for these fields: nothing more to start; a name typed keeps it.
        assertNull(VirtualFilamentDialogs.searchToStart(dialog))
        dialog = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(name = "Plum"))
        assertEquals(1L, dialog.search?.token)
        // A stale answer is ignored; the current one is shown and validated.
        assertSame(dialog, VirtualFilamentDialogs.searched(core, dialog, token = 0, outcome = Result.success("[]")))
        dialog = VirtualFilamentDialogs.searched(core, dialog, token = 1, outcome = Result.success("[{\"id\":\"x\"}]"))
        assertEquals(VirtualFilamentSearch.Ready("[{\"id\":\"x\"}]"), dialog.search?.state)
        assertEquals(VirtualFilamentSearch.Ready("[{\"id\":\"x\"}]"), core.validated.last().second)
        // A failure is reported in its words.
        val failed = VirtualFilamentDialogs.searched(
            core, VirtualFilamentDialogs.searching(core, dialog, request, token = 2), token = 2,
            outcome = Result.failure(IllegalStateException("worker crashed")),
        )
        assertEquals(VirtualFilamentSearch.Failed("worker crashed"), failed.search?.state)
    }

    @Test
    fun aNewTargetOrMinimumDropsTheChoiceAndTheSearchAndLeavingMatchCancelsIt() {
        val core = Core()
        var dialog = opened(core)
        dialog = VirtualFilamentDialogs.searching(core, dialog, VirtualFilamentDialogs.searchToStart(dialog)!!, token = 1)
        dialog = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(matchSelected = "persisted:m1"))
        assertEquals("persisted:m1", dialog.form.matchSelected)
        assertEquals(1L, dialog.search?.token)
        // The target typed (even to one that asks for the same search): selection and search dropped.
        val retyped = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(matchTarget = "#808080 "))
        assertNull(retyped.form.matchSelected)
        assertNull(retyped.search)
        val lower = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(matchTarget = "#80808A".lowercase()))
        assertNull(lower.form.matchSelected)
        assertNull(lower.search)
        assertEquals(VirtualFilamentSearchRequest("#80808A", 10), VirtualFilamentDialogs.searchToStart(lower))
        val changed = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(matchMinimum = "20"))
        assertNull(changed.search)
        assertNull(changed.form.matchSelected)
        assertEquals(VirtualFilamentSearchRequest("#808080", 20), VirtualFilamentDialogs.searchToStart(changed))
        // An incomplete minimum asks for none.
        assertNull(VirtualFilamentDialogs.searchToStart(VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(matchMinimum = ""))))
        // Leaving Match cancels the search; coming back asks again.
        val ratio = VirtualFilamentDialogs.typed(core, dialog, dialog.form.copy(mode = VirtualFilamentMode.RATIO))
        assertNull(ratio.search)
        val back = VirtualFilamentDialogs.typed(core, ratio, ratio.form.copy(mode = VirtualFilamentMode.MATCH))
        assertEquals(VirtualFilamentSearchRequest("#808080", 10), VirtualFilamentDialogs.searchToStart(back))
    }

    @Test
    fun submittingNeedsACompleteDraftNothingPendingAndAnUnchangedProject() {
        val core = Core()
        val incomplete = opened(core, VirtualFilamentMode.RATIO)
        assertFalse(VirtualFilamentDialogs.canSubmit(incomplete, "r1"))
        assertNull(VirtualFilamentDialogs.edit(incomplete))
        val done = VirtualFilamentDialogs.typed(core, incomplete, incomplete.form.copy(name = "Done"))
        assertTrue(VirtualFilamentDialogs.canSubmit(done, "r1"))
        assertEquals(VirtualFilamentEdit.Add("{\"draft\":1}"), VirtualFilamentDialogs.edit(done))
        // The project changed while it was open: reopen first.
        assertTrue(VirtualFilamentDialogs.stale(done.revision, "r2"))
        assertFalse(VirtualFilamentDialogs.canSubmit(done, "r2"))
        assertFalse(VirtualFilamentDialogs.canSubmit(done.copy(busy = true), "r1"))
        // A search still running holds it back.
        val match = VirtualFilamentDialogs.typed(core, done, done.form.copy(mode = VirtualFilamentMode.MATCH))
        val searching = VirtualFilamentDialogs.searching(core, match, VirtualFilamentDialogs.searchToStart(match)!!, token = 3)
        assertFalse(VirtualFilamentDialogs.canSubmit(searching, "r1"))
        // Edit and duplicate name their row.
        val row = library.rows[0]
        assertEquals(VirtualFilamentEdit.Edit("m1", "{\"draft\":1}"), VirtualFilamentDialogs.edit(done.copy(operation = VirtualFilamentOperation.EDIT, target = row)))
        assertEquals(VirtualFilamentEdit.Duplicate("m1", "{\"draft\":1}"), VirtualFilamentDialogs.edit(done.copy(operation = VirtualFilamentOperation.DUPLICATE, target = row)))
    }

    @Test
    fun theLibraryOffersAddWithTwoSelectableHeadsAndPickersListEveryHead() {
        assertTrue(VirtualFilamentDialogs.canAdd(library, busy = false))
        assertFalse(VirtualFilamentDialogs.canAdd(library, busy = true))
        assertFalse(VirtualFilamentDialogs.canAdd(library.copy(physical = library.physical.take(1)), busy = false))
        assertTrue(VirtualFilamentDialogs.selectableChoice(enabled = true, compatible = true, chosen = false))
        assertFalse(VirtualFilamentDialogs.selectableChoice(enabled = false, compatible = true, chosen = false))
        assertFalse(VirtualFilamentDialogs.selectableChoice(enabled = true, compatible = false, chosen = false))
        // A head already chosen stays choosable, as the browser's select keeps it.
        assertTrue(VirtualFilamentDialogs.selectableChoice(enabled = false, compatible = false, chosen = true))
    }

    @Test
    fun theDialogsSmallEditsAreTheBrowsers() {
        assertEquals("12", VirtualFilamentDialogs.withToken("1", 2))
        assertEquals("1[10]", VirtualFilamentDialogs.withToken("1", 10))
        assertEquals("12,", VirtualFilamentDialogs.withGroup("12"))
        assertEquals(3, VirtualFilamentDialogs.withCount(form, 3).ratioCount)
        assertEquals(3, VirtualFilamentDialogs.withCount(form, 7).ratioCount)
        assertEquals(2, VirtualFilamentDialogs.withCount(form, 1).ratioCount)
        assertEquals(listOf("a", "b", "", "z"), form.copy(ratioIds = listOf("a", "b")).withRatioId(3, "z").ratioIds)
        assertNull(form.ratioId(5))
        // The picker's view box is 240 × 216, whatever size it is drawn.
        assertEquals(120.0 to 108.0, VirtualFilamentDialogs.trianglePoint(50f, 50f, 100f, 100f))
        assertNull(VirtualFilamentDialogs.trianglePoint(1f, 1f, 0f, 100f))
        assertEquals(115.0 to 23.0, VirtualFilamentDialogs.nudged(120.0, 18.0, -1, 1))
    }
}
