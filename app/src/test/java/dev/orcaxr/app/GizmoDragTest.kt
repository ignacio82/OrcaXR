package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the ray-based gizmo drag math ([GizmoDragSession]).
 * Frame is mesh-mm = printer axes: X left/right, Y depth (away from the
 * viewer is +Y), Z vertical. A "viewer" ray typically starts up/behind
 * the model and points down+forward.
 */
class GizmoDragTest {

    private val eps = 1e-2f

    @Test
    fun rayPlaneIntersect_hitsBedPlane() {
        val p = rayPlaneIntersect(
            origin = Vec3f(0f, -200f, 200f),
            dir = Vec3f(0f, 1f, -1f),
            planePoint = Vec3f(0f, 0f, 0f),
            planeNormal = Vec3f(0f, 0f, 1f),
        )
        assertNotNull(p)
        assertEquals(0f, p!!.x, eps)
        assertEquals(0f, p.y, eps)
        assertEquals(0f, p.z, eps)
    }

    @Test
    fun rayPlaneIntersect_parallelReturnsNull() {
        assertNull(
            rayPlaneIntersect(
                origin = Vec3f(0f, 0f, 10f),
                dir = Vec3f(1f, 0f, 0f),
                planePoint = Vec3f(0f, 0f, 0f),
                planeNormal = Vec3f(0f, 0f, 1f),
            ),
        )
    }

    @Test
    fun moveInPlane_tracksLaserDotOnBed() {
        val s = GizmoDragSession(GizmoDragMapping.MoveInPlane(planeZmm = 10f))
        // Looking down at 45° from behind the bed.
        assertTrue(s.start(Vec3f(0f, -100f, 110f), Vec3f(0f, 1f, -1f)))
        // Shift the ray 30mm right and 20mm deeper: dot lands 30 right, 20 deep.
        val ov = s.update(Vec3f(30f, -80f, 110f), Vec3f(0f, 1f, -1f))
        assertNotNull(ov)
        assertEquals(30f, ov!!.deltaTxMm, eps)
        assertEquals(20f, ov.deltaTyMm, eps)
        assertEquals(0f, ov.deltaTzMm, eps)
    }

    @Test
    fun moveInPlane_horizontalGazeFallsBackToCameraPlane() {
        // Gaze along +Y (level with the model): bed plane is edge-on, the
        // fallback maps lateral hand motion → X and vertical → depth (+Y).
        val s = GizmoDragSession(GizmoDragMapping.MoveInPlane(planeZmm = 10f))
        assertTrue(s.start(Vec3f(0f, -100f, 10f), Vec3f(0f, 1f, 0f)))
        // Ray pans 25mm left (-X) and 15mm up (+Z).
        val ov = s.update(Vec3f(-25f, -100f, 25f), Vec3f(0f, 1f, 0f))
        assertNotNull(ov)
        assertEquals(-25f, ov!!.deltaTxMm, 0.5f)
        assertEquals(15f, ov.deltaTyMm, 0.5f)
    }

    @Test
    fun moveAlongAxis_zOnlyRespondsToVertical() {
        val s = GizmoDragSession(
            GizmoDragMapping.MoveAlongAxis(axis = 2, anchorMm = Vec3f(0f, 0f, 60f)),
        )
        // Viewer in front (-Y), ray pointing at the Z handle.
        assertTrue(s.start(Vec3f(0f, -200f, 60f), Vec3f(0f, 1f, 0f)))
        // Hand raises 40mm.
        val ov = s.update(Vec3f(0f, -200f, 100f), Vec3f(0f, 1f, 0f))
        assertNotNull(ov)
        assertEquals(0f, ov!!.deltaTxMm, eps)
        assertEquals(0f, ov.deltaTyMm, eps)
        assertEquals(40f, ov.deltaTzMm, eps)
    }

    @Test
    fun moveAlongAxis_xIgnoresPerpendicularMotion() {
        val s = GizmoDragSession(
            GizmoDragMapping.MoveAlongAxis(axis = 0, anchorMm = Vec3f(80f, 0f, 20f)),
        )
        assertTrue(s.start(Vec3f(80f, -200f, 20f), Vec3f(0f, 1f, 0f)))
        // Move 50mm along X and 30mm up: only X passes through.
        val ov = s.update(Vec3f(130f, -200f, 50f), Vec3f(0f, 1f, 0f))
        assertNotNull(ov)
        assertEquals(50f, ov!!.deltaTxMm, eps)
        assertEquals(0f, ov.deltaTyMm, eps)
        assertEquals(0f, ov.deltaTzMm, eps)
    }

    @Test
    fun rotateAboutZ_quarterTurn() {
        val c = Vec3f(0f, 0f, 30f)
        val s = GizmoDragSession(GizmoDragMapping.RotateAboutAxis(axis = 2, centerMm = c))
        // Looking straight down at the Z ring.
        assertTrue(s.start(Vec3f(60f, 0f, 200f), Vec3f(0f, 0f, -1f)))
        // Sweep the ray from (60,0) to (0,60): +90° right-handed around Z.
        val ov = s.update(Vec3f(0f, 60f, 200f), Vec3f(0f, 0f, -1f))
        assertNotNull(ov)
        assertEquals(90f, ov!!.deltaRotZDeg, 0.1f)
        assertEquals(0f, ov.deltaRotXDeg, eps)
    }

    @Test
    fun rotateAboutX_tracksAngleOnYZPlane() {
        val c = Vec3f(0f, 0f, 30f)
        val s = GizmoDragSession(GizmoDragMapping.RotateAboutAxis(axis = 0, centerMm = c))
        // Looking along -X at the X ring (YZ plane).
        assertTrue(s.start(Vec3f(200f, 50f, 30f), Vec3f(-1f, 0f, 0f)))
        // Sweep from (y=50,z=0 rel) to (y=0,z=50 rel): +90° around X.
        val ov = s.update(Vec3f(200f, 0f, 80f), Vec3f(-1f, 0f, 0f))
        assertNotNull(ov)
        assertEquals(90f, ov!!.deltaRotXDeg, 0.1f)
    }

    @Test
    fun rotate_grazingRayRefusesToStart() {
        val s = GizmoDragSession(
            GizmoDragMapping.RotateAboutAxis(axis = 2, centerMm = Vec3f(0f, 0f, 30f)),
        )
        // Gaze level with the Z ring plane: refuse rather than glitch.
        assertTrue(!s.start(Vec3f(0f, -200f, 30f), Vec3f(0f, 1f, 0f)))
    }

    @Test
    fun scaleUniform_doubleDistanceDoublesScale() {
        val c = Vec3f(0f, 0f, 30f)
        val s = GizmoDragSession(GizmoDragMapping.ScaleUniform(centerMm = c))
        // Viewer in front: camera-facing plane through the center.
        assertTrue(s.start(Vec3f(30f, -200f, 30f), Vec3f(0f, 1f, 0f)))
        val ov = s.update(Vec3f(60f, -200f, 30f), Vec3f(0f, 1f, 0f))
        assertNotNull(ov)
        assertEquals(2f, ov!!.scaleMultX, eps)
        assertEquals(2f, ov.scaleMultY, eps)
        assertEquals(2f, ov.scaleMultZ, eps)
    }

    @Test
    fun scaleAlongAxis_onlyScalesThatAxis() {
        val c = Vec3f(0f, 0f, 30f)
        val s = GizmoDragSession(GizmoDragMapping.ScaleAlongAxis(axis = 0, centerMm = c))
        assertTrue(s.start(Vec3f(40f, -200f, 30f), Vec3f(0f, 1f, 0f)))
        val ov = s.update(Vec3f(20f, -200f, 30f), Vec3f(0f, 1f, 0f))
        assertNotNull(ov)
        assertEquals(0.5f, ov!!.scaleMultX, eps)
        assertEquals(1f, ov.scaleMultY, eps)
        assertEquals(1f, ov.scaleMultZ, eps)
    }

    @Test
    fun applyOverride_foldsRotationAndScale() {
        val m = PlacedModel(
            id = "t", source = java.io.File("/tmp/x.stl"), label = "t",
            rotZDeg = 350, scaleXPct = 100f, scaleYPct = 100f, scaleZPct = 100f,
        )
        val out = applyOverride(
            m,
            GizmoDragOverride(deltaRotZDeg = 20f, scaleMultX = 2f, scaleMultY = 2f, scaleMultZ = 2f),
        )
        assertEquals(10, out.rotZDeg)
        assertEquals(200f, out.scaleXPct, eps)
    }
}
