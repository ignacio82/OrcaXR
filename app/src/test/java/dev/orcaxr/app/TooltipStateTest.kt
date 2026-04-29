package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap B6 — verify [TooltipState]'s open/close transitions and the
 * `openedAtMs` reset semantics that drive the auto-dismiss
 * LaunchedEffect's cancellation/replay.
 */
class TooltipStateTest {

    @Test fun starts_closed() {
        val s = TooltipState()
        assertFalse(s.isOpen)
        assertNull(s.openedAtMs)
    }

    @Test fun toggle_opens_then_closes() {
        val s = TooltipState()
        s.toggle(nowMs = 100L)
        assertTrue(s.isOpen)
        assertEquals(100L, s.openedAtMs)
        s.toggle(nowMs = 200L)
        assertFalse(s.isOpen)
        assertNull(s.openedAtMs)
    }

    @Test fun open_sets_timestamp() {
        val s = TooltipState()
        s.open(nowMs = 500L)
        assertTrue(s.isOpen)
        assertEquals(500L, s.openedAtMs)
    }

    @Test fun open_while_open_resets_timestamp() {
        // The auto-dismiss LaunchedEffect keys on openedAtMs, so a
        // re-open should bump the key and restart the grace window.
        val s = TooltipState()
        s.open(nowMs = 100L)
        s.open(nowMs = 350L)
        assertEquals(350L, s.openedAtMs)
        assertNotEquals(100L, s.openedAtMs)
    }

    @Test fun close_clears_timestamp() {
        val s = TooltipState()
        s.open(nowMs = 100L)
        s.close()
        assertFalse(s.isOpen)
        assertNull(s.openedAtMs)
    }

    @Test fun close_when_already_closed_is_a_noop() {
        val s = TooltipState()
        s.close()
        s.close()
        assertFalse(s.isOpen)
    }

    @Test fun toggle_after_explicit_open_closes() {
        // Mixed API: caller opened via open(), user-tap toggles to
        // close. Validates the toggle path treats open() and an
        // earlier toggle() identically.
        val s = TooltipState()
        s.open(nowMs = 100L)
        assertNotNull(s.openedAtMs)
        s.toggle(nowMs = 500L)
        assertFalse(s.isOpen)
    }
}
