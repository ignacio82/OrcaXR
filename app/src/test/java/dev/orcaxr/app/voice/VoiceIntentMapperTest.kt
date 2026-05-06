package dev.orcaxr.app.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap C8 — pin the regex-based intent mapper against a corpus of
 * canonical phrasings.
 *
 * The corpus is hand-built from the kinds of utterances a Galaxy XR
 * user is most likely to say after they've seen a colleague drive
 * OrcaXR by voice once: terse imperatives ("slice it"), polite
 * variants ("please slice the active plate"), and the occasional
 * filler word ("now"). The mapper's intent is to be 90% correct on
 * recognized speech; the panel falls through to the LLM-assistant
 * path for anything off-grid.
 */
class VoiceIntentMapperTest {

    @Test fun `slice variants all map to SliceActivePlate`() {
        val variants = listOf(
            "slice",
            "slice it",
            "slice it now",
            "slice the active plate",
            "Slice the current plate.",
            "please slice",
            "please slice the active plate now",
            "start slice",
            "start slice the plate",
        )
        for (v in variants) {
            assertEquals(
                "expected SliceActivePlate for `$v`",
                VoiceIntent.SliceActivePlate,
                VoiceIntentMapper.map(v),
            )
        }
    }

    @Test fun `cancel slice carries requiresConfirmation = true`() {
        val intent = VoiceIntentMapper.map("cancel slice")
        assertTrue("expected CancelSlice, got $intent", intent is VoiceIntent.CancelSlice)
        assertTrue("must require confirmation", intent!!.requiresConfirmation)
        assertEquals(intent, VoiceIntentMapper.map("stop slice"))
        assertEquals(intent, VoiceIntentMapper.map("Cancel the slice."))
    }

    @Test fun `delete selected requires confirmation`() {
        val intent = VoiceIntentMapper.map("delete selected")
        assertTrue(intent is VoiceIntent.DeleteSelected)
        assertTrue(intent!!.requiresConfirmation)
        assertEquals(intent, VoiceIntentMapper.map("remove selected"))
        assertEquals(intent, VoiceIntentMapper.map("delete the selected models"))
    }

    @Test fun `workspace mode aliases all resolve`() {
        assertEquals(VoiceIntent.SetWorkspaceMode("prepare"), VoiceIntentMapper.map("prepare"))
        assertEquals(VoiceIntent.SetWorkspaceMode("prepare"), VoiceIntentMapper.map("switch to prepare"))
        assertEquals(VoiceIntent.SetWorkspaceMode("prepare"), VoiceIntentMapper.map("go to prepare mode"))
        assertEquals(VoiceIntent.SetWorkspaceMode("preview"), VoiceIntentMapper.map("preview"))
        assertEquals(VoiceIntent.SetWorkspaceMode("preview"), VoiceIntentMapper.map("switch to preview"))
        assertEquals(VoiceIntent.SetWorkspaceMode("devices"), VoiceIntentMapper.map("devices"))
        assertEquals(VoiceIntent.SetWorkspaceMode("devices"), VoiceIntentMapper.map("printers"))
        assertEquals(VoiceIntent.SetWorkspaceMode("devices"), VoiceIntentMapper.map("go to devices mode"))
    }

    @Test fun `plate switching parses the integer`() {
        assertEquals(VoiceIntent.SetActivePlate(1), VoiceIntentMapper.map("plate 1"))
        assertEquals(VoiceIntent.SetActivePlate(3), VoiceIntentMapper.map("switch to plate 3"))
        assertEquals(VoiceIntent.SetActivePlate(7), VoiceIntentMapper.map("go to plate 7"))
        // Bare "plate" with no number is NOT a match.
        assertNull(VoiceIntentMapper.map("plate"))
    }

    @Test fun `auto arrange + drop to bed`() {
        assertEquals(VoiceIntent.AutoArrangePlate, VoiceIntentMapper.map("arrange"))
        assertEquals(VoiceIntent.AutoArrangePlate, VoiceIntentMapper.map("auto arrange"))
        assertEquals(VoiceIntent.AutoArrangePlate, VoiceIntentMapper.map("auto-arrange"))
        assertEquals(VoiceIntent.AutoArrangePlate, VoiceIntentMapper.map("auto arrange the active plate"))
        assertEquals(VoiceIntent.DropToBed, VoiceIntentMapper.map("drop to bed"))
        assertEquals(VoiceIntent.DropToBed, VoiceIntentMapper.map("drop on bed"))
    }

    @Test fun `wipe tower auto position`() {
        assertEquals(VoiceIntent.AutoPositionWipeTower, VoiceIntentMapper.map("auto position the wipe tower"))
        assertEquals(VoiceIntent.AutoPositionWipeTower, VoiceIntentMapper.map("position the tower"))
        assertEquals(VoiceIntent.AutoPositionWipeTower, VoiceIntentMapper.map("place the tower"))
    }

    @Test fun `set preference toggles`() {
        assertEquals(
            VoiceIntent.SetPreference("show_travels", true),
            VoiceIntentMapper.map("show travels"),
        )
        assertEquals(
            VoiceIntent.SetPreference("show_travels", false),
            VoiceIntentMapper.map("hide travels"),
        )
        assertEquals(
            VoiceIntent.SetPreference("toolpath_tubes", true),
            VoiceIntentMapper.map("enable tubes"),
        )
        assertEquals(
            VoiceIntent.SetPreference("toolpath_tubes", false),
            VoiceIntentMapper.map("disable tubes"),
        )
    }

    @Test fun `save shortcuts`() {
        assertEquals(VoiceIntent.SaveGcode, VoiceIntentMapper.map("save gcode"))
        assertEquals(VoiceIntent.SaveGcode, VoiceIntentMapper.map("save the g-code"))
        assertEquals(VoiceIntent.SaveGcode, VoiceIntentMapper.map("save the gcode to downloads"))
        assertEquals(VoiceIntent.SaveProjectAs3mf, VoiceIntentMapper.map("save as 3mf"))
        assertEquals(VoiceIntent.SaveProjectAs3mf, VoiceIntentMapper.map("save the project as 3mf"))
        assertEquals(VoiceIntent.SaveModelAsStl, VoiceIntentMapper.map("save as stl"))
        assertEquals(VoiceIntent.SaveModelAsStl, VoiceIntentMapper.map("save the model as stl"))
    }

    @Test fun `handy model load with normalized id`() {
        assertEquals(
            VoiceIntent.AddHandyModel("benchy"),
            VoiceIntentMapper.map("load benchy"),
        )
        assertEquals(
            VoiceIntent.AddHandyModel("orca_cube"),
            VoiceIntentMapper.map("load the orca cube"),
        )
        assertEquals(
            VoiceIntent.AddHandyModel("calib_temperature_tower"),
            VoiceIntentMapper.map("load the temperature tower"),
        )
    }

    @Test fun `unrecognized utterance returns null`() {
        assertNull(VoiceIntentMapper.map(""))
        assertNull(VoiceIntentMapper.map("   "))
        assertNull(VoiceIntentMapper.map("paint the dragon green"))
        assertNull(VoiceIntentMapper.map("what is my filament temperature"))
    }

    @Test fun `case-insensitive + trailing-period tolerance`() {
        assertEquals(VoiceIntent.SliceActivePlate, VoiceIntentMapper.map("SLICE."))
        assertEquals(VoiceIntent.AutoArrangePlate, VoiceIntentMapper.map("Auto Arrange."))
    }

    @Test fun `undo redo helpers`() {
        assertEquals(VoiceIntent.Undo, VoiceIntentMapper.map("undo"))
        assertEquals(VoiceIntent.Undo, VoiceIntentMapper.map("undo that"))
        assertEquals(VoiceIntent.Redo, VoiceIntentMapper.map("redo"))
        assertEquals(VoiceIntent.Redo, VoiceIntentMapper.map("redo that"))
    }
}
