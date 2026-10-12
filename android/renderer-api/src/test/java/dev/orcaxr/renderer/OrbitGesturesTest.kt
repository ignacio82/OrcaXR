package dev.orcaxr.renderer

import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.tan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class OrbitGesturesTest {
    private val camera = OrbitCamera(yaw = .3, pitch = .6, distance = .5, target = Point3(.01, .03, -.02))

    @Test fun aDragTurnsTwoPiOverTheViewsHeight() {
        // OrbitControls: rotateLeft(2π·dx/clientHeight), rotateUp(2π·dy/clientHeight) — "yes, height".
        val turned = OrbitGestures.rotate(camera, dx = 100.0, dy = -50.0, height = 1000)
        assertEquals(.3 - 2 * PI * .1, turned.yaw, 1e-12)
        assertEquals(.6 - 2 * PI * .05, turned.pitch, 1e-12)
        assertEquals(camera.distance, turned.distance, 0.0)
        // Short of the poles, as the camera requires.
        assertEquals(1.5, OrbitGestures.rotate(camera, 0.0, 10_000.0, 1000).pitch, 0.0)
        assertEquals(.05, OrbitGestures.rotate(camera, 0.0, -10_000.0, 1000).pitch, 0.0)
        assertSame(camera, OrbitGestures.rotate(camera, 1.0, 1.0, 0))
    }

    @Test fun aWheelZoomsByOrbitControlsScale() {
        // One Chrome notch on Android: 64 CSS px (the platform's scroll factor), in when scrolled up.
        val closer = OrbitGestures.wheel(camera, -64.0)
        assertEquals(.5 * .95.pow(.64), closer.distance, 1e-12)
        val farther = OrbitGestures.wheel(camera, 64.0)
        assertEquals(.5 / .95.pow(.64), farther.distance, 1e-12)
        assertSame(camera, OrbitGestures.wheel(camera, 0.0))
        // Line and page deltas, and a pinch arriving as Ctrl + wheel.
        assertEquals(48.0, OrbitGestures.wheelDelta(3.0, OrbitGestures.WheelMode.LINE), 0.0)
        assertEquals(-100.0, OrbitGestures.wheelDelta(-1.0, OrbitGestures.WheelMode.PAGE), 0.0)
        assertEquals(-50.0, OrbitGestures.wheelDelta(-5.0, ctrl = true), 0.0)
        // Bounded as the view bounds its camera.
        assertEquals(4.5, OrbitGestures.wheel(camera, 1e9).distance, 0.0)
        assertEquals(.05, OrbitGestures.wheel(camera, -1e9).distance, 0.0)
        val tight = OrbitGestures.Limits(minDistance = .2, maxDistance = .6)
        assertEquals(.6, OrbitGestures.wheel(camera, 500.0, tight).distance, 0.0)
    }

    @Test fun aMiddleDragDolliesAndTwoFingersPinch() {
        assertEquals(.5 / .95.pow(.2), OrbitGestures.dolly(camera, 20.0).distance, 1e-12)
        assertEquals(.5 * .95.pow(.2), OrbitGestures.dolly(camera, -20.0).distance, 1e-12)
        assertEquals(.25, OrbitGestures.pinch(camera, 2.0).distance, 1e-12)
        assertEquals(1.0, OrbitGestures.pinch(camera, .5).distance, 1e-12)
        assertSame(camera, OrbitGestures.pinch(camera, 0.0))
    }

    @Test fun aPanSlidesTheTargetWithThePointer() {
        val height = 800
        val moved = OrbitGestures.pan(camera, dx = 80.0, dy = 0.0, height = height)
        // The target moves left by 2·dx·distance·tan(fov/2)/height, the eye with it.
        val forward = (camera.target - camera.eye).normalized()
        val right = forward.cross(Point3(0.0, 1.0, 0.0)).normalized()
        val span = 2 * 80.0 * .5 * tan(PI / 8) / height
        val expected = camera.target + right * -span
        assertEquals(expected.x, moved.target.x, 1e-12)
        assertEquals(expected.y, moved.target.y, 1e-12)
        assertEquals(expected.z, moved.target.z, 1e-12)
        assertEquals(camera.yaw, moved.yaw, 0.0)
        assertEquals(camera.distance, moved.distance, 0.0)
        // Dragging down moves the target up the screen's vertical.
        val up = right.cross(forward)
        val raised = OrbitGestures.pan(camera, 0.0, 40.0, height)
        val lift = 2 * 40.0 * .5 * tan(PI / 8) / height
        assertEquals((camera.target + up * lift).y, raised.target.y, 1e-12)
    }
}
