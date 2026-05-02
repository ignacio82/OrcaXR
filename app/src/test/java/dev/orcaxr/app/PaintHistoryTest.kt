package dev.orcaxr.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Paint full-feature-parity (Undo/Redo) — verifies [PaintHistory]'s
 * stroke begin/end semantics, undo/redo stack ordering, and edge
 * cases (no-op stroke dropped, redo cleared on new edit, bounded
 * depth, per-model isolation).
 */
class PaintHistoryTest {

    private fun snap(paint: ByteArray? = null, support: ByteArray? = null,
                     seam: ByteArray? = null, fuzzy: ByteArray? = null) =
        PaintHistory.Snapshot(paint, support, seam, fuzzy)

    @Test fun beginAndEndCommitsStroke() {
        val h = PaintHistory()
        h.beginStroke("m1", snap(paint = byteArrayOf(0, 0, 0)))
        h.endStroke("m1", snap(paint = byteArrayOf(0, 1, 0)))
        assertTrue(h.canUndo("m1"))
        assertFalse(h.canRedo("m1"))
        assertEquals(1, h.undoDepth("m1"))
    }

    @Test fun noOpStrokeDoesNotCommit() {
        val h = PaintHistory()
        val before = snap(paint = byteArrayOf(0, 1, 0))
        h.beginStroke("m1", before)
        // End with the same state — empty stroke (e.g. user pinched
        // off the model and released without a single stamp landing).
        h.endStroke("m1", before)
        assertFalse(h.canUndo("m1"))
        assertEquals(0, h.undoDepth("m1"))
    }

    @Test fun undoRestoresBeforeAndPushesToRedo() {
        val h = PaintHistory()
        h.beginStroke("m1", snap(paint = byteArrayOf(0, 0, 0)))
        h.endStroke("m1", snap(paint = byteArrayOf(0, 1, 0)))
        val undone = h.undo("m1")
        assertArrayEquals(byteArrayOf(0, 0, 0), undone!!.paintFilamentIndex)
        assertFalse(h.canUndo("m1"))
        assertTrue(h.canRedo("m1"))
    }

    @Test fun redoRestoresAfterAndPushesBackToUndo() {
        val h = PaintHistory()
        h.beginStroke("m1", snap(paint = byteArrayOf(0, 0, 0)))
        h.endStroke("m1", snap(paint = byteArrayOf(0, 1, 0)))
        h.undo("m1")
        val redone = h.redo("m1")
        assertArrayEquals(byteArrayOf(0, 1, 0), redone!!.paintFilamentIndex)
        assertTrue(h.canUndo("m1"))
        assertFalse(h.canRedo("m1"))
    }

    @Test fun newStrokeClearsRedoStack() {
        val h = PaintHistory()
        h.beginStroke("m1", snap(paint = byteArrayOf(0, 0)))
        h.endStroke("m1", snap(paint = byteArrayOf(1, 0)))
        h.undo("m1")
        assertTrue(h.canRedo("m1"))
        // Begin a new edit — redo should be obliterated.
        h.beginStroke("m1", snap(paint = byteArrayOf(0, 0)))
        assertFalse(h.canRedo("m1"))
    }

    @Test fun multipleStrokesUndoLifoOrder() {
        val h = PaintHistory()
        h.beginStroke("m", snap(paint = byteArrayOf(0)))
        h.endStroke("m", snap(paint = byteArrayOf(1)))
        h.beginStroke("m", snap(paint = byteArrayOf(1)))
        h.endStroke("m", snap(paint = byteArrayOf(2)))
        h.beginStroke("m", snap(paint = byteArrayOf(2)))
        h.endStroke("m", snap(paint = byteArrayOf(3)))
        assertEquals(3, h.undoDepth("m"))
        // Undo three times — each step rolls back to that stroke's
        // before-state.
        assertArrayEquals(byteArrayOf(2), h.undo("m")!!.paintFilamentIndex)
        assertArrayEquals(byteArrayOf(1), h.undo("m")!!.paintFilamentIndex)
        assertArrayEquals(byteArrayOf(0), h.undo("m")!!.paintFilamentIndex)
        assertNull(h.undo("m"))
    }

    @Test fun maxDepthEvictsOldest() {
        val h = PaintHistory()
        val total = PaintHistory.MAX_DEPTH + 5
        for (i in 0 until total) {
            h.beginStroke("m", snap(paint = byteArrayOf(i.toByte())))
            h.endStroke("m", snap(paint = byteArrayOf((i + 1).toByte())))
        }
        assertEquals(PaintHistory.MAX_DEPTH, h.undoDepth("m"))
        // The first 5 strokes should have been evicted; the
        // remaining-oldest's "before" should be byte=5.
        // To verify: undo MAX_DEPTH-1 times to drain to the oldest.
        repeat(PaintHistory.MAX_DEPTH - 1) { h.undo("m") }
        // Now the only undo left is the oldest surviving.
        val oldestUndone = h.undo("m")
        assertArrayEquals(byteArrayOf(5), oldestUndone!!.paintFilamentIndex)
    }

    @Test fun perModelIsolated() {
        val h = PaintHistory()
        h.beginStroke("a", snap(paint = byteArrayOf(0)))
        h.endStroke("a", snap(paint = byteArrayOf(1)))
        assertTrue(h.canUndo("a"))
        assertFalse(h.canUndo("b"))
        h.clear("a")
        assertFalse(h.canUndo("a"))
    }

    @Test fun cancelStrokeDiscardsPending() {
        val h = PaintHistory()
        h.beginStroke("m", snap(paint = byteArrayOf(0)))
        h.cancelStroke("m")
        // No commit should have occurred.
        assertFalse(h.canUndo("m"))
    }

    @Test fun pendingStrokeUndoneInPlace() {
        // Per the doc: "Ctrl-Z while typing mid-word" — if a stroke is
        // open when undo is called, the open stroke is rolled back
        // without consuming an undo slot.
        val h = PaintHistory()
        h.beginStroke("m", snap(paint = byteArrayOf(1)))
        h.endStroke("m", snap(paint = byteArrayOf(2)))
        // Now simulate beginning another stroke without ending it.
        h.beginStroke("m", snap(paint = byteArrayOf(2)))
        val undone = h.undo("m")
        // Should restore the open stroke's `before` (which is the
        // post-state of the first stroke = byteArrayOf(2)).
        assertArrayEquals(byteArrayOf(2), undone!!.paintFilamentIndex)
        // The first stroke must still be undoable.
        assertTrue(h.canUndo("m"))
        assertEquals(1, h.undoDepth("m"))
    }

    @Test fun doubleBeginStrokeIsIdempotent() {
        val h = PaintHistory()
        val before = snap(paint = byteArrayOf(0))
        h.beginStroke("m", before)
        h.beginStroke("m", snap(paint = byteArrayOf(99)))  // ignored
        h.endStroke("m", snap(paint = byteArrayOf(1)))
        // Undo should restore the FIRST beginStroke's before.
        assertArrayEquals(byteArrayOf(0), h.undo("m")!!.paintFilamentIndex)
    }
}
