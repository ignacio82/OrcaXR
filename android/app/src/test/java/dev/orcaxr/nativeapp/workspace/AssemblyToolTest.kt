package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.core.AssemblyKind
import dev.orcaxr.core.AssemblyPairing
import dev.orcaxr.core.BrimEarPoint
import dev.orcaxr.core.BrimEarState
import dev.orcaxr.core.MeasureAnnotation
import dev.orcaxr.core.MeasurePick
import dev.orcaxr.core.PaintPlacement
import dev.orcaxr.core.ProjectAssemblies
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.renderer.ModelTransform
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.ProjectScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Assembly tool's platform-free parts: its words, its pairing rule and the exploded view's line and discs. */
class AssemblyToolTest {
    private val identity = ProjectIntents.Transform(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0))
    private val plane = ProjectIntents.SurfaceFeature.Plane(ProjectIntents.MeasurePlane(0, listOf(0.0, 0.0, 1.0), listOf(0.0, 0.0, 0.0)))

    @Test fun theStatusesAreTheBrowsers() {
        assertEquals("Applied center coincidence. Undo restores the previous placement.", ProjectAssemblies.applied(AssemblyKind.CENTER_COINCIDENCE))
        assertEquals("Applied around face center. Undo restores the previous placement.", ProjectAssemblies.applied(AssemblyKind.AROUND_FACE_CENTER))
        assertEquals("Alignment failed: These planes are already parallel", ProjectAssemblies.failed("These planes are already parallel"))
        assertEquals(AssemblyKind.PARALLEL_DISTANCE, AssemblyKind.of("parallel-distance"))
        assertEquals(ProjectIntents.AssemblyAlignmentKind.ReverseRotation, AssemblyKind.REVERSE_ROTATION.wire)
    }

    @Test fun twoPicksOnTwoModelsAreAPair() {
        val a = MeasurePick(plane, "plane", "a")
        val b = MeasurePick(plane, "plane", "b")
        assertEquals(AssemblyPairing.TWO_PICKS, ProjectAssemblies.refusal(emptyList()))
        assertEquals(AssemblyPairing.TWO_PICKS, ProjectAssemblies.refusal(listOf(a)))
        assertEquals(AssemblyPairing.DIFFERENT_MODELS, ProjectAssemblies.refusal(listOf(a, a.copy(summary = "another face"))))
        assertNull(ProjectAssemblies.refusal(listOf(a, b)))
    }

    @Test fun theExplosionIsAFactorOfAtLeastOne() {
        assertTrue(ProjectAssemblies.explosionAllowed(1.0))
        assertTrue(ProjectAssemblies.explosionAllowed(2.75))
        assertFalse(ProjectAssemblies.explosionAllowed(0.99))
        assertFalse(ProjectAssemblies.explosionAllowed(Double.NaN))
        assertFalse(ProjectAssemblies.explosionAllowed(Double.POSITIVE_INFINITY))
    }

    @Test fun theMeasuredLineFollowsItsPartsApart() {
        val line = MeasureAnnotation(listOf(10.0, 0.0, 5.0), listOf(40.0, 0.0, 5.0), "30 mm")
        val offsets = mapOf("a" to Point3(-15.0, 0.0, 0.0), "b" to Point3(15.0, 0.0, 2.0))
        assertEquals(MeasureAnnotation(listOf(-5.0, 0.0, 5.0), listOf(55.0, 0.0, 7.0), "30 mm"), explodedAnnotation(line, "a", "b", offsets))
        // Assembled, or on a part the view does not move, an end stays.
        assertEquals(line, explodedAnnotation(line, "a", "b", emptyMap()))
        assertEquals(line.copy(to = listOf(55.0, 0.0, 7.0)), explodedAnnotation(line, "c", "b", offsets))
    }

    @Test fun anEarsDiscRidesOnItsInstanceApart() {
        fun draw(instance: String) = ProjectScene.Draw(
            "$instance/volume", "plate", instance, "object", "volume", "asset", ProjectIntents.VolumeRoleName.Model,
            ModelTransform.fromCanonical(identity), PaintPlacement(identity, identity), 0, true,
        )
        val state = BrimEarState("object", listOf(BrimEarPoint(listOf(10.0, 0.0, 0.0), 4.0)), emptyList(), 0.0)
        val draws = listOf(draw("a"), draw("b"))
        val assembled = BrimEarDiscs.markers(state, draws)
        val apart = BrimEarDiscs.markers(state, draws, mapOf("b" to Point3(20.0, -5.0, 0.0)))
        assertEquals(assembled[0].transform.point(Point3(0.0, 0.0, 0.0)), apart[0].transform.point(Point3(0.0, 0.0, 0.0)))
        assertEquals(Point3(30.0, -5.0, 0.0), apart[1].transform.point(Point3(0.0, 0.0, 0.0)))
    }
}
