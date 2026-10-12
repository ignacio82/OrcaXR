package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.BrimEarPoint
import dev.orcaxr.core.BrimEarState
import dev.orcaxr.core.PaintPlacement
import dev.orcaxr.core.ProjectBrimEars
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.renderer.ModelTransform
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.ProjectScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** The Brim Ears tool's platform-free parts: its field, its words and its discs, as the browser's workspace and panel make them. */
class BrimEarsTest {
    @Test fun theRadiusFieldHandsItsNumberOverAsANumberInputDoes() {
        assertEquals(2.5, BrimEarFields.radius("2.5"), 0.0)
        assertEquals(0.5, BrimEarFields.radius(".5"), 0.0)
        assertEquals(1500.0, BrimEarFields.radius("1.5e3"), 0.0)
        // What the input sanitizes to nothing reads as Number("") = 0, which the workspace refuses.
        assertEquals(0.0, BrimEarFields.radius(""), 0.0)
        assertEquals(0.0, BrimEarFields.radius("5 mm"), 0.0)
        assertEquals(Double.POSITIVE_INFINITY, BrimEarFields.radius("1e400"), 0.0)
        assertFalse(ProjectBrimEars.radiusAllowed(0.0))
        assertFalse(ProjectBrimEars.radiusAllowed(0.09))
        assertFalse(ProjectBrimEars.radiusAllowed(20.5))
        assertFalse(ProjectBrimEars.radiusAllowed(Double.POSITIVE_INFINITY))
        assertFalse(ProjectBrimEars.radiusAllowed(Double.NaN))
        assertTrue(ProjectBrimEars.radiusAllowed(0.1))
        assertTrue(ProjectBrimEars.radiusAllowed(20.0))
    }

    @Test fun theWordsAreTheBrowsers() {
        assertEquals("A brim ear radius must be between 0.1 and 20 mm.", ProjectBrimEars.RADIUS_BOUNDS)
        assertEquals("Placed a 5 mm brim ear.", ProjectBrimEars.placed(5.0))
        assertEquals("Placed a 0.1 mm brim ear.", ProjectBrimEars.placed(0.1))
        assertEquals("Brim ear: The project changed meanwhile; try again.", ProjectBrimEars.failed("The project changed meanwhile; try again."))
        assertEquals("No ears placed.", ProjectBrimEars.noEars(null))
        assertEquals("No ears placed. The object is flat; there is no first layer to hold.", ProjectBrimEars.noEars("The object is flat; there is no first layer to hold."))
        assertEquals("Placed 1 brim ear on the corners that would lift; one undo removes them all.", ProjectBrimEars.autoPlaced(1))
        assertEquals("Placed 8 brim ears on the corners that would lift; one undo removes them all.", ProjectBrimEars.autoPlaced(8))
        assertEquals("Click the model to place an ear; each placement undoes on its own.", ProjectBrimEars.hint(true))
        assertEquals("Select one model part to place brim ears on it.", ProjectBrimEars.hint(false))
        assertNull(ProjectBrimEars.warning(0))
        assertEquals("One ear does not reach the part and will hold nothing down.", ProjectBrimEars.warning(1))
        assertEquals("3 ears do not reach the part and will hold nothing down.", ProjectBrimEars.warning(3))
        // `${positionMm.map(format).join(', ')} mm · ⌀${format(r * 2)} mm`, format being Number(value.toFixed(2)).
        assertEquals("23, 5, 0 mm · ⌀10 mm", ProjectBrimEars.row(BrimEarPoint(listOf(23.00000000000001, 5.000000000000001, 0.0), 5.0), false))
        assertEquals("-0.07, 4.73, 1.5 mm · ⌀5 mm · does not reach the part", ProjectBrimEars.row(BrimEarPoint(listOf(-0.07055236082016592, 4.7274066103125465, 1.5), 2.5), true))
        assertEquals("0", ProjectBrimEars.fixed(-0.004))
        assertEquals("1", ProjectBrimEars.fixed(1.005))
        assertEquals("0.13", ProjectBrimEars.fixed(0.125))
    }

    @Test fun aTapIsReadInTheObjectsFrameAsThreeReadsIt() {
        val turn = PI / 12
        val volume = ProjectIntents.Transform(listOf(2.0, -3.0, 1.5), listOf(0.0, 0.0, sin(turn / 2), cos(turn / 2)), listOf(1.0, 1.0, 1.0))
        val point = ProjectBrimEars.objectPoint(volume, listOf(4.0, 0.0, 8.0))
        assertEquals(2 + 4 * cos(turn), point[0], 1e-12)
        assertEquals(-3 + 4 * sin(turn), point[1], 1e-12)
        assertEquals(9.5, point[2], 1e-12)
    }

    private fun draw(instance: String, objectId: String, transform: ProjectIntents.Transform) = ProjectScene.Draw(
        "$instance/volume", "plate", instance, objectId, "volume", "asset", ProjectIntents.VolumeRoleName.Model,
        ModelTransform.fromCanonical(transform), PaintPlacement(transform, IDENTITY), 0, true,
    )

    @Test fun eachEarIsADiscOfItsPrintedSizeOnEveryInstance() {
        val scaled = ProjectIntents.Transform(listOf(100.0, 50.0, 0.0), listOf(0.0, 0.0, sin(PI / 12), cos(PI / 12)), listOf(1.5, 1.5, 2.0))
        val draws = listOf(draw("a", "object", IDENTITY), draw("b", "object", scaled), draw("c", "other", IDENTITY))
        val state = BrimEarState("object", listOf(BrimEarPoint(listOf(10.0, 0.0, 0.0), 4.0), BrimEarPoint(listOf(0.0, 0.0, 0.0), 2.0)), listOf(1), 0.0)
        val discs = BrimEarDiscs.markers(state, draws)
        // Two ears on each of the object's two instances, none on another object.
        assertEquals(4, discs.size)
        assertEquals(listOf(BrimEarDiscs.DEFAULT_ARGB, BrimEarDiscs.ERROR_ARGB, BrimEarDiscs.DEFAULT_ARGB, BrimEarDiscs.ERROR_ARGB), discs.map { it.argb })
        assertEquals(listOf(1f, .5f, 1f, .5f), discs.map { it.opacity })
        // On the scaled, turned instance the ear stands where the instance places it, its disc still 4 mm across in
        // radius and 0.2 mm thick: the instance's scale is undone.
        val disc = discs[2].transform
        val centre = disc.point(Point3(0.0, 0.0, 0.0))
        val placed = ModelTransform.fromCanonical(scaled).point(Point3(10.0, 0.0, 0.0))
        assertEquals(placed.x, centre.x, 1e-9)
        assertEquals(placed.y, centre.y, 1e-9)
        assertEquals(placed.z, centre.z, 1e-9)
        val rim = disc.point(Point3(1.0, 0.0, 0.0)) - centre
        assertEquals(4.0, hypot(rim.x, rim.y), 1e-9)
        val top = disc.point(Point3(0.0, 0.0, .1)) - centre
        assertEquals(.1, top.z, 1e-9)
        // Nothing without an object in scope or without ears.
        assertTrue(BrimEarDiscs.markers(BrimEarState(), draws).isEmpty())
        assertTrue(BrimEarDiscs.markers(state.copy(ears = emptyList(), stranded = emptyList()), draws).isEmpty())
    }

    private companion object {
        val IDENTITY = ProjectIntents.Transform(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))
    }
}
