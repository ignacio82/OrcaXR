package dev.orcaxr.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GcodePreviewPlanTest {
    /** Ten layers of 100 records and 10 path points each; layer 5 split into two index entries of 50. */
    private fun index(complete: Boolean = true, recordBudget: Long = 1_000, pathPointBudget: Long = 1_000): GcodePreviewIndex {
        val entries = ArrayList<GcodeIndexEntry>()
        var records = 0L
        var points = 0L
        for (layer in 0 until 10) {
            val parts = if (layer == 5) 2 else 1
            repeat(parts) {
                entries += GcodeIndexEntry(layer, records, points)
                records += 100L / parts
                points += 10L / parts
            }
        }
        return GcodePreviewIndex(entries, records, points, complete, if (complete) null else "record-cap", recordBudget, pathPointBudget)
    }

    @Test fun aPrintThatFitsIsOneModelShowingEveryLayer() {
        val plan = GcodePreviewPlan(index())
        assertTrue(plan.index.whole)
        assertNull(plan.window)
        assertEquals(0 to 9, plan.view.layerRange)
        assertNull(plan.windowNotice())
        assertFalse(plan.hasPrevious || plan.hasNext)
    }

    @Test fun aLargerPrintLoadsBoundedWindowsAndSaysSo() {
        val plan = GcodePreviewPlan(index(recordBudget = 300))
        assertFalse(plan.index.whole)
        assertEquals(GcodeWindow(0, 2), plan.window)
        assertEquals(0 to 2, plan.view.layerRange)
        assertTrue(plan.hasNext && !plan.hasPrevious)
        assertEquals(
            "Showing layers 0–2 of 9, records 1–300 of 1000. Use the layer range or Previous/Next moves to inspect " +
                "another bounded window. The supplied G-code was fully indexed.",
            plan.windowNotice(),
        )
    }

    @Test fun anIncompleteIndexIsNeverTreatedAsWhole() {
        val plan = GcodePreviewPlan(index(complete = false))
        assertFalse(plan.index.whole)
        assertTrue(plan.windowNotice()!!.endsWith("Only a prefix was indexed (record-cap); later input has not been inspected."))
    }

    @Test fun movingTheTopLayerLoadsTheWindowEndingThere() {
        val plan = GcodePreviewPlan(index(recordBudget = 300))
        val view = plan.update(layerRange = 0 to 8)
        // Ending at layer 8 within 300 records: layers 6..8.
        assertEquals(6 to 8, view.layerRange)
        assertEquals(GcodeWindow(plan.index.entryForLayer(6, false), plan.index.entryForLayer(8, true)), plan.window)
    }

    @Test fun anOversizedLayerSplitsByEntryAndStepsWalkTheWindows() {
        val plan = GcodePreviewPlan(index(recordBudget = 250))
        assertEquals(0 to 1, plan.view.layerRange)
        plan.step(1)
        assertEquals(2 to 3, plan.view.layerRange)
        plan.step(1)
        // Layer 4 (100) and both halves of layer 5 (100) fit 250.
        assertEquals(4 to 5, plan.view.layerRange)
        plan.step(-1)
        assertEquals(2 to 3, plan.view.layerRange)
        assertTrue(plan.hasPrevious && plan.hasNext)
    }

    @Test fun rangesClampToThePrintAndSwapWhenReversed() {
        val plan = GcodePreviewPlan(index())
        assertEquals(0 to 9, plan.update(layerRange = -5 to 40).layerRange)
        assertEquals(3 to 7, plan.update(layerRange = 7 to 3).layerRange)
        assertEquals("Feedrate", plan.update(mode = "Feedrate").mode)
        assertEquals(3 to 7, plan.view.layerRange)
    }

    @Test fun aSingleLayerShowsTheTopLayerAndStepsOneLayerAtATime() {
        val plan = GcodePreviewPlan(index(recordBudget = 300))
        assertEquals(2 to 2, plan.update(singleLayer = true).layerRange)
        assertTrue(plan.view.singleLayer)
        assertEquals(7 to 7, plan.update(layerRange = 3 to 7).layerRange)
        plan.step(1)
        assertEquals(8 to 8, plan.view.layerRange)
        plan.step(-1)
        assertEquals(7 to 7, plan.view.layerRange)
        // Leaving single layer with the bottom moved keeps the bottom and fits the window above it: layers 4..6.
        assertEquals(4 to 6, plan.update(layerRange = 4 to 7, singleLayer = false).layerRange)
        assertFalse(plan.view.singleLayer)
    }

    @Test fun aWholePrintSpansItsModelsLayers() {
        val plan = GcodePreviewPlan(index(), wholeBounds = 1 to 9)
        assertEquals(1 to 9, plan.layerBounds)
        assertEquals(1 to 9, plan.view.layerRange)
        assertEquals(1 to 4, plan.update(layerRange = 0 to 4).layerRange)
        // A windowed print's bounds stay its index's.
        assertEquals(0 to 9, GcodePreviewPlan(index(recordBudget = 300), wholeBounds = 1 to 9).layerBounds)
    }

    @Test fun entriesForALayerAreFoundAtEitherEdge() {
        val index = index()
        assertEquals(5, index.entryForLayer(5, last = false))
        assertEquals(6, index.entryForLayer(5, last = true))
        assertEquals(0, index.entryForLayer(-3, last = false))
        assertEquals(index.entries.size - 1, index.entryForLayer(99, last = true))
    }

    @Test fun theEventMaskHidesOnlyTheChosenMoveClasses() {
        val defaults = GcodeMoveFilter.eventMask(GcodeMoveFilter.defaults)
        assertEquals(GcodeMoveFilter.EVENT_COUNT, defaults.size)
        assertEquals(listOf(1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1), defaults)
        val travel = GcodeMoveFilter.eventMask(setOf(GcodeMoveFilter.Extrude, GcodeMoveFilter.Travel))
        assertEquals(1, travel[8])
        assertEquals(0, travel[9])
    }
}
