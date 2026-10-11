package dev.orcaxr.nativeapp.preview

import dev.orcaxr.core.ProjectRevision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewCurrencyTest {
    private val cube = ProjectRevision(4, "fnv1a64:cube", "fnv1a64:assets")
    private val filled = ProjectRevision(68, "fnv1a64:filled", "fnv1a64:assets")

    /** The viewer reads a slice as PreviewModel does: released, admitted, shown. */
    private fun PreviewCurrency.read(slice: ProjectRevision): Boolean {
        released()
        if (!admits(slice)) return false
        shown(slice)
        return true
    }

    @Test
    fun aFreshSliceAfterAnEditIsCurrentAndShowsNoWithdrawalNotice() {
        // The emulator's sequence: a cube sliced, the bed filled, the plate sliced again.
        val currency = PreviewCurrency()
        currency.projectChanged(cube)
        assertTrue(currency.read(cube))
        assertFalse(currency.withdrawn)
        // The project's own acknowledgements of the same state withdraw nothing.
        assertFalse(currency.projectChanged(cube))

        // The fill withdraws the cube's slice, and the viewer says so.
        assertTrue(currency.projectChanged(filled))
        assertTrue(currency.withdrawn)
        assertNull(currency.origin)
        assertFalse(currency.projectChanged(filled))
        assertTrue(currency.withdrawn)

        // The fresh slice of the filled bed is current: shown, and the notice of the old one is gone.
        assertTrue(currency.read(filled))
        assertEquals(filled, currency.origin)
        assertFalse(currency.withdrawn)
        assertFalse(currency.projectChanged(filled))
        assertFalse(currency.withdrawn)
    }

    @Test
    fun aSliceOfAStateTheProjectLeftIsRefusedAndAnyChangeWithdrawsTheShownOne() {
        val currency = PreviewCurrency()
        // Before the project reported anything, a slice is taken as it comes.
        assertTrue(currency.read(cube))
        currency.projectChanged(filled)
        assertFalse(currency.admits(cube))
        assertTrue(currency.admits(filled))

        // The browser's guard is all three: revision, semantic hash and asset fingerprint.
        for (other in listOf(filled.copy(revision = 69), filled.copy(semanticHash = "fnv1a64:other"), filled.copy(assetFingerprint = "fnv1a64:other"))) {
            assertTrue(currency.read(filled))
            assertTrue(currency.projectChanged(other))
            assertTrue(currency.withdrawn)
            currency.projectChanged(filled)
        }
        // A project with no state (closed) withdraws a slice too.
        assertTrue(currency.read(filled))
        assertTrue(currency.projectChanged(null))
    }

    @Test
    fun anOpenedFileIsNeverWithdrawnAndReplacesTheNotice() {
        val currency = PreviewCurrency()
        currency.projectChanged(cube)
        assertTrue(currency.read(cube))
        assertTrue(currency.projectChanged(filled))
        assertTrue(currency.withdrawn)
        // A file the operator opens belongs to no project state.
        currency.released()
        assertFalse(currency.withdrawn)
        currency.shown(null)
        assertFalse(currency.projectChanged(cube))
        assertFalse(currency.withdrawn)
        assertNull(currency.origin)
    }

    @Test
    fun aReadThatFailsOrIsDismissedLeavesNoNotice() {
        val currency = PreviewCurrency()
        currency.projectChanged(cube)
        assertTrue(currency.read(cube))
        assertTrue(currency.projectChanged(filled))
        currency.dismissed()
        assertFalse(currency.withdrawn)

        assertTrue(currency.read(filled))
        assertTrue(currency.projectChanged(cube.copy(revision = 70)))
        // Opening the stale slice again is refused; what the viewer says is the refusal, not the notice.
        assertFalse(currency.read(filled))
        assertFalse(currency.withdrawn)
        assertNull(currency.origin)
    }
}
