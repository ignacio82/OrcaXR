package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap B5 — verify the help card's data layer covers every binding
 * the input pump actually consumes. A drift here means the user opens
 * the help panel and finds a missing or stale entry.
 */
class ControllerHelpTest {

    @Test fun every_face_button_has_an_entry() {
        val face = listOf("A button", "B button", "X button", "Y button")
        for (b in face) {
            assertNotNull(
                "missing controller help entry for $b",
                ControllerHelp.entries.firstOrNull { it.input == b },
            )
        }
    }

    @Test fun preview_and_prepare_stick_are_documented() {
        // Both modes need their own entry so a user reading the card
        // knows the sticks behave differently per mode.
        assertTrue(
            ControllerHelp.entries.any { it.input.contains("Preview", ignoreCase = true) }
        )
        assertTrue(
            ControllerHelp.entries.any { it.input.contains("Prepare", ignoreCase = true) }
        )
    }

    @Test fun every_entry_has_non_blank_action() {
        for (e in ControllerHelp.entries) {
            assertTrue("action blank for ${e.input}", e.action.isNotBlank())
            assertTrue("input blank in entry $e", e.input.isNotBlank())
        }
    }

    @Test fun x_button_carries_the_no_slice_note() {
        val x = ControllerHelp.entries.first { it.input == "X button" }
        assertNotNull("X button needs a note about the slice-required gate", x.note)
        assertTrue(x.note!!.contains("slice", ignoreCase = true))
    }

    @Test fun help_entries_list_matches_known_count() {
        // Tripwire: any future binding addition or removal needs to
        // touch the test, ControllerHelp.entries, and the actual
        // collector in the same commit. If you're staring at a failing
        // assertion here, update all three.
        assertEquals(7, ControllerHelp.entries.size)
    }

    @Test fun formatBytes_handles_size_ranges() {
        // Roadmap D1 — make sure the storage row reads cleanly across
        // every band the user could reasonably hit (an empty cache
        // through a multi-GB worst case).
        assertEquals("0 B", formatBytes(0))
        assertEquals("0 B", formatBytes(-1))  // negative is treated as empty
        assertEquals("512 B", formatBytes(512))
        assertEquals("1 KB", formatBytes(1024))
        assertEquals("1023 KB", formatBytes(1023L * 1024L))
        assertEquals("1.0 MB", formatBytes(1024L * 1024L))
        assertEquals("12.4 MB", formatBytes((12.4 * 1024 * 1024).toLong()))
        assertEquals("1.50 GB", formatBytes((1.5 * 1024 * 1024 * 1024).toLong()))
    }
}
