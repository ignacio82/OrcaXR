package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.renderer.Point3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The wipe tower's ghost as the Workspace draws it: the browser's box, edges and footprint over the core's plan. */
class WipeTowerGhostTest {
    private fun ghost(x: Double, y: Double, width: Double, height: Double, margin: Double) =
        ProjectIntents.WipeTowerGhost(listOf(x, y), width, height, standIn = false, marginMm = margin)

    @Test fun theBodyStandsFromTheTowersCornerAndTheFootprintRingsIt() {
        val markers = WipeTowerGhosts.markers(ghost(20.0, 30.0, 25.0, 40.0, 2.0))
        assertEquals(3, markers.size)
        val (body, edges, footprint) = markers
        assertEquals(WipeTowerGhosts.BODY, body.shape)
        assertEquals(WipeTowerGhosts.BODY_ARGB, body.argb)
        assertEquals(.35f, body.opacity)
        assertTrue("a translucent box one layer deep", body.frontOnly)
        // The unit box's corners land on the tower's.
        assertEquals(Point3(20.0, 30.0, 0.0), body.transform.point(Point3(0.0, 0.0, 0.0)))
        assertEquals(Point3(45.0, 55.0, 40.0), body.transform.point(Point3(1.0, 1.0, 1.0)))
        assertEquals(body.transform.point(Point3(1.0, 1.0, 1.0)), edges.transform.point(Point3(1.0, 1.0, 1.0)))
        assertEquals(WipeTowerGhosts.EDGE_ARGB, edges.argb)
        assertEquals(.8f, edges.opacity)
        // The brim's footprint, just above the bed.
        assertEquals(WipeTowerGhosts.FOOTPRINT_ARGB, footprint.argb)
        assertEquals(.65f, footprint.opacity)
        val lift = 0.0005 / 0.00175
        assertEquals(Point3(18.0, 28.0, lift), footprint.transform.point(Point3(0.0, 0.0, 0.0)))
        assertEquals(Point3(47.0, 57.0, lift), footprint.transform.point(Point3(1.0, 1.0, 0.0)))
    }

    @Test fun noMarginNoGhostAndNoUsableBoxDrawNoFootprintOrNothing() {
        assertEquals(2, WipeTowerGhosts.markers(ghost(0.0, 0.0, 60.0, 30.0, 0.0)).size)
        assertEquals(emptyList<Any>(), WipeTowerGhosts.markers(null))
        // Beyond what the scene's transforms place, nothing rather than a failure.
        assertEquals(emptyList<Any>(), WipeTowerGhosts.markers(ghost(0.0, 0.0, 1e300, 30.0, 0.0)))
    }
}
