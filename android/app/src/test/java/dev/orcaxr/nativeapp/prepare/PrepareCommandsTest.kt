package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.nativeapp.engine.LocalEngineState
import dev.orcaxr.nativeapp.engine.LocalEngineWords
import dev.orcaxr.nativeapp.send.SendWords
import dev.orcaxr.nativeapp.shell.AppActions
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PrepareCommandsTest {
    private val gib = 1024L * 1024 * 1024
    private val engine = LocalEngineState("commit", "x86_64", totalMemory = 4 * gib, availableMemory = 2 * gib)
    private val revision = ProjectRevision(7, "semantic", "assets")
    private val slice = ProjectActionState(PrepareCommands.SLICE, "Slice", true)
    private val all = ProjectActionState(PrepareCommands.SLICE_ALL, "Slice All Plates", true)
    private val cancel = ProjectActionState(PrepareCommands.CANCEL, "Cancel Slice", false, "Not available in the current workspace state.")
    private val send = ProjectActionState(PrepareCommands.SEND, "Send to Printer", false, "Slice successfully first.")

    /** The core's gate as `sliceActions` answers it with nothing running and nothing blocking. */
    private val gate = mapOf(PrepareCommands.SLICE to slice, PrepareCommands.SLICE_ALL to all, PrepareCommands.CANCEL to cancel)
    private val ready = PrepareCommands.Facts(SliceRouteKind.Local, plateObjects = 1, core = gate)

    private fun state(action: ProjectActionState, facts: PrepareCommands.Facts) = PrepareCommands.state(action, facts)

    @Test fun theFourAreThePreparesAndRunThere() {
        assertEquals(listOf("slice_active_plate", "slice_all_plates", "slice_cancel", "send_to_printer"), PrepareCommands.IDS)
        PrepareCommands.IDS.forEach {
            assertTrue(it, it in AppActions.PERFORMED)
            assertTrue(it, AppActions.needsPrepare(it))
            assertFalse(it, AppActions.needsProject(it) || AppActions.needsWorkspace(it))
        }
        assertFalse(AppActions.needsPrepare("edit_undo"))
        // What the Prepare area checks again when it carries one out: the same rule, and the same reason when it no longer holds.
        val running = ready.copy(job = SliceJob("slicing"))
        PrepareCommands.IDS.forEach { id ->
            val shown = state(ProjectActionState(id, id, true), running)
            assertEquals(id, shown.enabled, PrepareCommands.enabled(id, running))
            assertEquals(id, shown.reason, if (shown.enabled) null else PrepareCommands.reason(id, running))
        }
    }

    @Test fun sliceIsEnabledAsPreparesSliceButton() {
        // A route, a plate with a model, no job, no blocking preflight, and the core's gate: the core's own enablement is replaced.
        assertTrue(state(slice.copy(enabled = false, reason = "Slice successfully first."), ready).enabled)
        assertNull(state(slice, ready).reason)
        // Not read yet, the core's gate does not hold Slice back (Prepare's button does not wait for it either).
        assertTrue(PrepareCommands.canSlice(ready.copy(core = emptyMap())))

        // No route: this device's engine says why.
        val none = state(slice, ready.copy(route = SliceRouteKind.None, routeReason = LocalEngineWords.NOT_PACKAGED))
        assertFalse(none.enabled)
        assertEquals(LocalEngineWords.NOT_PACKAGED, none.reason)
        // No plate, or an empty one.
        assertEquals(PrepareWords.NO_MODELS, state(slice, ready.copy(plateObjects = null)).reason)
        assertEquals(PrepareWords.NO_MODELS, state(slice, ready.copy(plateObjects = 0)).reason)
        // A slice running, then a blocking preflight: the browser's prerequisites' words.
        assertEquals(PrepareCommands.WAIT, state(slice, ready.copy(job = SliceJob("slicing"))).reason)
        assertEquals(PrepareCommands.RESOLVE, state(slice, ready.copy(blocked = true)).reason)
        // The core's gate refusing it: its reason.
        val refused = ready.copy(core = gate + (PrepareCommands.SLICE to slice.copy(enabled = false, reason = "Load or create a model first.")))
        assertEquals(ProjectActionState(PrepareCommands.SLICE, "Slice", false, "Load or create a model first."), state(slice, refused))
    }

    @Test fun sliceAllIsEnabledAsPreparesButton() {
        assertTrue(state(all.copy(enabled = false), ready).enabled)
        // Until the core's gate is read it stays off, as Prepare's button does; then it judges every plate.
        assertFalse(state(all, ready.copy(core = emptyMap())).enabled)
        val noPlate = ready.copy(core = gate + (PrepareCommands.SLICE_ALL to all.copy(enabled = false, reason = "Load or create a model first.")))
        assertEquals("Load or create a model first.", state(all, noPlate).reason)
        // The active plate does not matter to it: an empty one with others printable still slices them all.
        assertTrue(state(all, ready.copy(plateObjects = 0)).enabled)
        assertEquals(PrepareCommands.WAIT, state(all, ready.copy(job = SliceJob("slicing"))).reason)
        assertEquals(LocalEngineWords.LOW_MEMORY, state(all, ready.copy(route = SliceRouteKind.None, routeReason = LocalEngineWords.LOW_MEMORY)).reason)
    }

    @Test fun cancelSliceWhileOneRuns() {
        assertFalse(state(cancel, ready).enabled)
        assertEquals("Not available in the current workspace state.", state(cancel, ready).reason)
        val running = ready.copy(job = SliceJob("slicing", 40.0))
        assertEquals(ProjectActionState(PrepareCommands.CANCEL, "Cancel Slice", true), state(cancel, running))
        // Being cancelled already: Prepare's Cancel is off too.
        assertFalse(state(cancel, ready.copy(job = SliceJob("cancelling", cancelling = true))).enabled)
        assertEquals(PrepareCommands.NOT_NOW, state(cancel, ready.copy(core = emptyMap())).reason)
    }

    @Test fun sendIsEnabledAsPreparesSendButton() {
        val sendable = ready.copy(sendable = true, connected = true)
        assertEquals(ProjectActionState(PrepareCommands.SEND, "Send to Printer", true), state(send, sendable))
        assertEquals(SendWords.SLICE_FIRST, state(send, sendable.copy(sendable = false)).reason)
        assertEquals(SendWords.BUSY, state(send, sendable.copy(sending = true)).reason)
        assertEquals(SendWords.CONNECT_FIRST, state(send, sendable.copy(connected = false)).reason)
    }

    @Test fun theFactsAreTheAreasState() {
        val plate = SlicedPlate(File("cube_Plate_1.gcode"), "cube_Plate_1.gcode", "plate-1", "Plate 1", revision, "", "SLICED", local = true)
        val preflight = PreflightView("plate-1", revision, canSlice = false, cards = emptyList(), total = 1)
        val prepare = PrepareState(local = engine, preflight = preflight, result = plate, actions = gate)
        val facts = PrepareCommands.Facts.of(prepare, "plate-1", 2, revision, connected = true, sending = false)
        assertEquals(SliceRouteKind.Local, facts.route)
        assertNull(facts.routeReason)
        assertTrue(facts.blocked)
        assertTrue(facts.sendable)
        assertSame(gate, facts.core)
        // Another plate's preflight does not block this one; a slice of another plate, or of an older project, is not sent.
        assertFalse(PrepareCommands.Facts.of(prepare, "plate-2", 2, revision, true, false).blocked)
        assertFalse(PrepareCommands.Facts.of(prepare, "plate-2", 2, revision, true, false).sendable)
        assertFalse(PrepareCommands.Facts.of(prepare, "plate-1", 2, revision.copy(revision = 8), true, false).sendable)
        // The external slicer the operator turned on is the route, as Prepare's rule has it.
        val external = prepare.copy(connection = SlicerConnection("http://10.0.2.2:3000", enabled = true), local = LocalEngineState.NONE)
        assertEquals(SliceRouteKind.External, PrepareCommands.Facts.of(external, "plate-1", 2, revision, true, false).route)
        val nothing = PrepareCommands.Facts.of(prepare.copy(local = LocalEngineState.NONE), "plate-1", 2, revision, true, false)
        assertEquals(SliceRouteKind.None, nothing.route)
        assertEquals(LocalEngineWords.NOT_PACKAGED, nothing.routeReason)
    }

    @Test fun anyOtherActionIsTheCores() {
        val undo = ProjectActionState("edit_undo", "Undo", false, "Nothing to undo.")
        assertSame(undo, state(undo, ready))
    }
}
