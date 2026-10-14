package dev.orcaxr.nativeapp.preview

import dev.orcaxr.renderer.GcodeIndexEntry
import dev.orcaxr.renderer.GcodePreviewIndex
import dev.orcaxr.renderer.GcodePreviewPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewTicksTest {
    @Test
    fun previewTickHoldsIdentificationAndHeight() {
        val tick = PreviewTick(
            id = "pause:1234",
            kind = "pause",
            label = "Pause at layer 15",
            layer = 15,
            zMm = 3.20,
        )
        assertEquals("pause:1234", tick.id)
        assertEquals("pause", tick.kind)
        assertEquals("Pause at layer 15", tick.label)
        assertEquals(15, tick.layer)
        assertEquals(3.20, tick.zMm, 0.001)
    }

    @Test
    fun previewStateRetainsTicksList() {
        val empty = PreviewState()
        assertTrue(empty.ticks.isEmpty())

        val tick1 = PreviewTick("pause:10", "pause", "Pause", 5, 1.0)
        val tick2 = PreviewTick("tool-change:20", "tool-change", "T0 -> T1", 10, 2.0)
        val state = empty.copy(ticks = listOf(tick1, tick2))

        assertEquals(2, state.ticks.size)
        assertEquals("pause", state.ticks[0].kind)
        assertEquals("tool-change", state.ticks[1].kind)
    }

    @Test
    fun jumpingToLayerSetsExactSingleLayerRangeOnPlan() {
        val entries = listOf(
            GcodeIndexEntry(1, 0, 0),
            GcodeIndexEntry(5, 100, 100),
            GcodeIndexEntry(10, 200, 200),
        )
        val index = GcodePreviewIndex(entries, 300, 300, true, null, 1000, 1000)
        val plan = GcodePreviewPlan(index, 1 to 10)

        // Initial view spans the bounds
        assertEquals(1 to 10, plan.view.layerRange)
        assertFalse(plan.view.singleLayer)

        // When jumping to a tick layer, plan isolates to that layer in single layer mode
        val targetLayer = 5
        plan.update(layerRange = targetLayer to targetLayer, singleLayer = true)
        assertEquals(targetLayer to targetLayer, plan.view.layerRange)
        assertTrue(plan.view.singleLayer)
    }
}
