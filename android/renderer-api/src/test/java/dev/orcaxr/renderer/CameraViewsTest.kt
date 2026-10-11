package dev.orcaxr.renderer

import kotlin.math.PI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraViewsTest {
    private fun near(expected: Point3, actual: Point3, label: String) {
        assertEquals("$label x", expected.x, actual.x, 1e-12)
        assertEquals("$label y", expected.y, actual.y, 1e-12)
        assertEquals("$label z", expected.z, actual.z, 1e-12)
    }

    @Test fun theViewsAreTheBrowsersViewMenuInItsOrder() {
        assertEquals(listOf("default", "top", "front", "left", "right", "rear", "bottom"), CameraView.entries.map { it.id })
    }

    @Test fun eachViewPutsTheEyeWhereTheBrowserDoes() {
        // The U1's 270 x 271 mm bed: the browser's span is its larger side.
        val span = .271
        val far = span * 2.15
        val target = Point3(.135, CameraViews.FOCUS_LIFT, -.1355)
        val expected = mapOf(
            CameraView.DEFAULT to Point3(0.0, span, span * 1.7),
            CameraView.TOP to Point3(0.0, far, CameraViews.POLE),
            CameraView.BOTTOM to Point3(0.0, -far, CameraViews.POLE),
            CameraView.FRONT to Point3(0.0, span * .17, far),
            CameraView.REAR to Point3(0.0, span * .17, -far),
            CameraView.LEFT to Point3(-far, span * .17, 0.0),
            CameraView.RIGHT to Point3(far, span * .17, 0.0),
        )
        for ((view, offset) in expected) {
            val camera = CameraViews.of(view, 270.0, 271.0)
            near(target, camera.target, "$view target")
            near(target + offset, camera.eye, "$view eye")
        }
        // The browser's lift and pole are its world's 0.03 and 0.0015 units at its 1.75 scale.
        assertEquals(.03 / 1.75, CameraViews.FOCUS_LIFT, 0.0)
        assertEquals(.0015 / 1.75, CameraViews.POLE, 0.0)
    }

    @Test fun topAndBottomLookStraightDownAndUpWithoutLeavingTheOrbit() {
        val top = CameraViews.of(CameraView.TOP, 200.0, 200.0)
        val bottom = CameraViews.of(CameraView.BOTTOM, 200.0, 200.0)
        // A hair off the pole: a few thousandths of a radian.
        assertTrue(top.pitch > PI / 2 - .01 && top.pitch < PI / 2)
        assertTrue(bottom.pitch < -PI / 2 + .01 && bottom.pitch > -PI / 2)
        // A camera looking up still picks along its ray.
        val ray = bottom.ray(400.0, 300.0, 800, 600)
        assertTrue(ray.direction.y > .99)
    }

    @Test fun theViewScalesWithTheBed() {
        val small = CameraViews.of(CameraView.FRONT, 180.0, 180.0)
        val large = CameraViews.of(CameraView.FRONT, 360.0, 300.0)
        assertEquals(small.distance * 2, large.distance, 1e-12)
        assertEquals(small.pitch, large.pitch, 1e-12)
        // A bed past the renderer's reach is seen from its farthest orbit.
        assertEquals(5.0, CameraViews.of(CameraView.DEFAULT, 5000.0, 5000.0).distance, 0.0)
    }
}
