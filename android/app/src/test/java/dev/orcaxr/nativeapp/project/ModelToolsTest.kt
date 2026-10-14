package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.JsText
import dev.orcaxr.core.MeasureAnnotation
import dev.orcaxr.core.MeasureHint
import dev.orcaxr.core.MeasurePick
import dev.orcaxr.core.MeasureRow
import dev.orcaxr.core.MeasureRowLabel
import dev.orcaxr.core.ModelToolStatus
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectMeasures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** The model tools' platform-free words and numbers, as the browser's workspace and panels write them. */
class ModelToolsTest {
    @Test
    fun simplifyFieldsHandOverNumbersAsANumberInputDoes() {
        // A valid floating-point number is its value.
        assertEquals(50.0, SimplifyFields.value("50"))
        assertEquals(0.05, SimplifyFields.value(".05"))
        assertEquals(-2.5, SimplifyFields.value("-2.5"))
        assertEquals(1500.0, SimplifyFields.value("1.5e3"))
        // What the input sanitizes to nothing reads as Number("") = 0.
        assertEquals(0.0, SimplifyFields.value(""))
        assertEquals(0.0, SimplifyFields.value("1."))
        assertEquals(0.0, SimplifyFields.value("abc"))
        assertEquals(0.0, SimplifyFields.value(" 5"))
        // A value that is not finite leaves the setting as it was.
        assertNull(SimplifyFields.value("1e400"))
        // The fields show the setting as JavaScript writes it.
        assertEquals("50", JsText.number(50.0))
        assertEquals("0.05", JsText.number(0.05))
        assertEquals("1", JsText.number(1.0))
    }

    @Test
    fun statusesAreTheBrowsersTemplates() {
        assertEquals("Split to Objects unavailable: Split to Objects requires a primary selected model instance",
            ModelToolStatus.splitUnavailable("Split to Objects requires a primary selected model instance"))
        assertEquals("Split Pair into 2 objects across all 2 instances in one undoable edit.", ModelToolStatus.splitDone("Pair", 2, 2))
        assertEquals("Split Duo into 2 objects across all 1 instance in one undoable edit.", ModelToolStatus.splitDone("Duo", 2, 1))
        assertEquals("Split to Objects failed: Unknown error. The project was not changed.", ModelToolStatus.splitFailed(" \n "))
        assertEquals("Split “Würfel” into separate objects?", ModelToolStatus.splitQuestion("Würfel"))
        assertEquals(
            "2 existing volumes will be promoted across all 1 instance.\n\nThe original object will be replaced in one undoable edit.",
            ModelToolStatus.splitDetail(true, 2, "24", 1),
        )
        assertEquals(
            "1,234 triangles will be separated by connected body across all 3 instances.\n\nThe original object will be replaced in one undoable edit.",
            ModelToolStatus.splitDetail(false, 1, "1,234", 3),
        )
        assertEquals("Simplify preview: 720 → 360 triangles. Apply keeps it; cancel restores the model.", ModelToolStatus.simplifyPreview(720, 360))
        assertEquals("Simplified 1 part(s): 720 → 360 triangles. Painting was reset; undo restores both.", ModelToolStatus.simplified(1, 720, 360))
        assertEquals("Simplify failed: Unknown volume v", ModelToolStatus.simplifyFailed("Unknown volume v"))
        assertEquals("Measure: picked plane facing (0, 0, 1).", ModelToolStatus.measurePicked("plane facing (0, 0, 1)"))
        assertEquals("Measure failed: Unknown face 99", ModelToolStatus.measureFailed("Unknown face 99"))
        assertEquals("Model repaired successfully. Painting was reset; undo restores both.", ModelToolStatus.REPAIR_COMPLETED)
        assertEquals("Repair failed: Non-manifold mesh", ModelToolStatus.repairFailed("Non-manifold mesh"))
        assertEquals("Boolean operation completed. Painting was reset; undo restores both.", ModelToolStatus.BOOLEAN_COMPLETED)
        assertEquals("Boolean operation failed: Empty result", ModelToolStatus.booleanFailed("Empty result"))
    }

    @Test
    fun thePreviewStatusRoundsTheShareAsMathRound() {
        assertEquals("Previewing 1 part(s): 720 → 360 triangles (50% removed).", ModelToolStatus.previewing(1, 720, 360, false))
        // 1/8 removed is 12.5 %: Math.round takes a half up.
        assertEquals("Previewing 1 part(s): 8 → 7 triangles (13% removed).", ModelToolStatus.previewing(1, 8, 7, false))
        assertEquals("Previewing 2 part(s): 0 → 0 triangles (0% removed). Stopped at the error limit before reaching the target.",
            ModelToolStatus.previewing(2, 0, 0, true))
        assertEquals(0.0, ModelToolStatus.jsRound(0.49999999999999994), 0.0)
        assertEquals(-2.0, ModelToolStatus.jsRound(-2.5), 0.0)
        assertEquals(3.0, ModelToolStatus.jsRound(2.5), 0.0)
    }

    @Test
    fun readoutsAreWrittenToThreeDecimalsAsTheBrowsersPanel() {
        assertEquals("30", ProjectMeasures.format(29.999999999999996))
        assertEquals("0", ProjectMeasures.format(-0.0004))
        assertEquals("1", ProjectMeasures.format(1.0005))
        assertEquals("0.063", ProjectMeasures.format(0.0625))
        assertEquals("-12.346", ProjectMeasures.format(-12.3456))
        assertEquals("1234567.25", ProjectMeasures.format(1234567.25))
        assertEquals("1e+21", ProjectMeasures.format(1e21))
    }

    private fun plane(normal: List<Double>, origin: List<Double>) =
        ProjectIntents.SurfaceFeature.Plane(ProjectIntents.MeasurePlane(0, normal, origin))
    private fun circle(radius: Double) =
        ProjectIntents.SurfaceFeature.Circle(ProjectIntents.MeasureCircle(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 1.0), radius))
    private val absent = ProjectIntents.Empty

    @Test
    fun theReadoutListsDistanceItsPartsTheAngleAndDiameters() {
        val top = MeasurePick(plane(listOf(0.0, 0.0, 1.0), listOf(5.0, 5.0, 30.0)), "plane facing (0, 0, 1)", "a")
        val hole = MeasurePick(circle(2.5), "circle ⌀5 mm", "a")
        // One pick: what to do next, and a circle's diameter already.
        val one = ProjectMeasures.readout(true, listOf(hole), null)
        assertEquals(MeasureHint.SECOND, one.hint)
        assertEquals(listOf(MeasureRow(MeasureRowLabel.DIAMETER, "5 mm")), one.rows)
        assertNull(one.annotation)
        assertEquals(MeasureHint.FIRST, ProjectMeasures.readout(true, emptyList(), null).hint)
        assertEquals(MeasureHint.CHOOSE_TOOL, ProjectMeasures.readout(false, listOf(top), null).hint)
        // Two: the strict distance first, its parts, the angle in degrees, then each diameter.
        val result = ProjectIntents.MeasureResult(
            ProjectIntents.OptionalMeasureAngle.Value(ProjectIntents.MeasureAngle(PI / 3, listOf(0.0, 0.0, 0.0), 1.0, false)),
            ProjectIntents.OptionalMeasureDistance.Value(ProjectIntents.MeasureDistance(9.0, listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 9.0))),
            ProjectIntents.OptionalMeasureDistance.Value(ProjectIntents.MeasureDistance(29.9999999, listOf(1.0, 2.0, 3.0), listOf(1.0, 2.0, 33.0))),
            ProjectIntents.OptionalVector.Value(listOf(0.0, -0.0001, 30.0)),
            false,
        )
        val two = ProjectMeasures.readout(true, listOf(top, hole), result)
        assertEquals(MeasureHint.NEXT, two.hint)
        assertEquals(
            listOf(
                MeasureRow(MeasureRowLabel.DISTANCE, "30 mm"),
                MeasureRow(MeasureRowLabel.XYZ, "0 mm / 0 mm / 30 mm"),
                MeasureRow(MeasureRowLabel.ANGLE, "60°"),
                MeasureRow(MeasureRowLabel.DIAMETER, "5 mm"),
            ),
            two.rows,
        )
        assertEquals(MeasureAnnotation(listOf(1.0, 2.0, 3.0), listOf(1.0, 2.0, 33.0), "30 mm"), two.annotation)
        assertFalse(two.unsupported)
        // Without a bounded distance the line's or plane's is shown, and so labelled.
        val infinite = ProjectMeasures.readout(
            true, listOf(top, top),
            result.copy(distanceStrict = ProjectIntents.OptionalMeasureDistance.Absent(absent), angle = ProjectIntents.OptionalMeasureAngle.Absent(absent),
                distanceXyz = ProjectIntents.OptionalVector.Absent(absent), unsupported = true),
        )
        assertEquals(listOf(MeasureRow(MeasureRowLabel.DISTANCE_INFINITE, "9 mm")), infinite.rows)
        assertTrue(infinite.unsupported)
    }

    @Test
    fun aVolumeIsPlacedByItsInstanceAfterItsOwnTransform() {
        // Instance: turned 90° about Z, scaled 2, moved to (10, 20, 0); volume: moved 5 along its X.
        val half = PI / 4
        val instance = ProjectIntents.Transform(listOf(10.0, 20.0, 0.0), listOf(0.0, 0.0, sin(half), cos(half)), listOf(2.0, 2.0, 2.0))
        val volume = ProjectIntents.Transform(listOf(5.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 2.0), listOf(1.0, 1.0, 1.0))
        val m = ProjectMeasures.placedTransform(instance, volume)
        fun apply(x: Double, y: Double, z: Double) = listOf(
            m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11],
        )
        // The volume's origin lands at the instance's origin plus its offset turned and scaled: (10, 30, 0).
        val origin = apply(0.0, 0.0, 0.0)
        assertTrue(abs(origin[0] - 10.0) < 1e-12 && abs(origin[1] - 30.0) < 1e-12 && abs(origin[2]) < 1e-12)
        val x = apply(1.0, 0.0, 0.0)
        assertTrue(abs(x[0] - 10.0) < 1e-12 && abs(x[1] - 32.0) < 1e-12)
        assertEquals(listOf(0.0, 0.0, 0.0, 1.0), m.subList(12, 16))
        // A zero quaternion is the identity, as three normalizes it.
        val still = ProjectIntents.Transform(listOf(0.0, 0.0, 0.0), listOf(0.0, 0.0, 0.0, 0.0), listOf(1.0, 1.0, 1.0))
        assertEquals(listOf(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0), ProjectMeasures.placedTransform(still, still))
    }
}
