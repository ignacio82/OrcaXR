package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Phase XR_OBJ_3 — pin the geometry of [rotationToLayOnFace].
 *
 * The contract: applying the returned Euler XYZ rotation (in
 * `R = R_z · R_y · R_x` convention, matching [StlMesh.transformedFull])
 * to the input normal lands it within float tolerance of `(0, 0, -1)`.
 * The numeric Euler triple itself is impl-detail (any equivalent
 * Euler triple is correct), so we verify by composing the rotation
 * matrix and applying it to the normal — not by spot-checking the
 * triple against a hand-derived value.
 */
class LayOnFaceMathTest {

    @Test fun aligned_normal_returns_identity() {
        // Already pointing -Z — no rotation needed.
        val (rx, ry, rz) = rotationToLayOnFace(Vec3f(0f, 0f, -1f))
        assertEquals(0f, rx, 1e-3f)
        assertEquals(0f, ry, 1e-3f)
        assertEquals(0f, rz, 1e-3f)
    }

    @Test fun anti_aligned_normal_uses_180_deg_x_flip() {
        // Pointing +Z — flip 180° around X.
        val (rx, ry, rz) = rotationToLayOnFace(Vec3f(0f, 0f, 1f))
        assertEquals(180f, rx, 1e-3f)
        assertEquals(0f, ry, 1e-3f)
        assertEquals(0f, rz, 1e-3f)
        verifyAlignment(Vec3f(0f, 0f, 1f), rx, ry, rz)
    }

    @Test fun plus_x_normal_rotates_to_minus_z() {
        verifyAlignment(Vec3f(1f, 0f, 0f))
    }

    @Test fun plus_y_normal_rotates_to_minus_z() {
        verifyAlignment(Vec3f(0f, 1f, 0f))
    }

    @Test fun arbitrary_diagonal_normal_lands_on_minus_z() {
        // 45° between +X and +Y, lifted slightly into +Z.
        val n = normalize(Vec3f(0.7071f, 0.7071f, 0.5f))
        verifyAlignment(n)
    }

    @Test fun degenerate_zero_normal_returns_identity() {
        val (rx, ry, rz) = rotationToLayOnFace(Vec3f(0f, 0f, 0f))
        assertEquals(0f, rx, 1e-3f)
        assertEquals(0f, ry, 1e-3f)
        assertEquals(0f, rz, 1e-3f)
    }

    /** Apply Euler XYZ (R_z · R_y · R_x) to [n] and assert the result
     *  is `(0, 0, -1)`. Defaults to extracting the angles from
     *  [rotationToLayOnFace]; pass explicit angles to test a specific
     *  triple. */
    private fun verifyAlignment(
        n: Vec3f,
        rxDeg: Float = Float.NaN,
        ryDeg: Float = Float.NaN,
        rzDeg: Float = Float.NaN,
    ) {
        val (rx, ry, rz) = if (rxDeg.isNaN()) rotationToLayOnFace(n)
            else Triple(rxDeg, ryDeg, rzDeg)
        val rotated = applyEulerXYZ(n, rx, ry, rz)
        assertEquals("rotated.x", 0f, rotated.x, 1e-3f)
        assertEquals("rotated.y", 0f, rotated.y, 1e-3f)
        assertEquals("rotated.z", -1f, rotated.z, 1e-3f)
        // Sanity: rotation preserves magnitude.
        val len = kotlin.math.sqrt(rotated.x * rotated.x + rotated.y * rotated.y + rotated.z * rotated.z)
        assertTrue("rotation preserved magnitude (len=$len)", abs(len - 1f) < 1e-3f)
    }

    private fun normalize(v: Vec3f): Vec3f {
        val len = kotlin.math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
        return Vec3f(v.x / len, v.y / len, v.z / len)
    }

    /** Apply Euler XYZ (R_z · R_y · R_x) to [v], in degrees. Mirrors
     *  the rotation composition in [StlMesh.transformedFull]. */
    private fun applyEulerXYZ(v: Vec3f, rxDeg: Float, ryDeg: Float, rzDeg: Float): Vec3f {
        val rxR = Math.toRadians(rxDeg.toDouble())
        val ryR = Math.toRadians(ryDeg.toDouble())
        val rzR = Math.toRadians(rzDeg.toDouble())
        val cx = kotlin.math.cos(rxR).toFloat(); val sx = kotlin.math.sin(rxR).toFloat()
        val cy = kotlin.math.cos(ryR).toFloat(); val sy = kotlin.math.sin(ryR).toFloat()
        val cz = kotlin.math.cos(rzR).toFloat(); val sz = kotlin.math.sin(rzR).toFloat()
        val r00 = cz * cy
        val r01 = cz * sy * sx - sz * cx
        val r02 = cz * sy * cx + sz * sx
        val r10 = sz * cy
        val r11 = sz * sy * sx + cz * cx
        val r12 = sz * sy * cx - cz * sx
        val r20 = -sy
        val r21 = cy * sx
        val r22 = cy * cx
        return Vec3f(
            r00 * v.x + r01 * v.y + r02 * v.z,
            r10 * v.x + r11 * v.y + r12 * v.z,
            r20 * v.x + r21 * v.y + r22 * v.z,
        )
    }
}
