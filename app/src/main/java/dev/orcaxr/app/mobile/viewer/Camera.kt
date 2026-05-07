/*
 * Ported from u1-slicer-for-android
 * https://github.com/taylormadearmy/u1-slicer-for-android
 * (AGPL-3.0 — see NOTICE.md). Z-up orbit camera for 3D printer beds.
 */
package dev.orcaxr.app.mobile.viewer

import android.opengl.Matrix
import kotlin.math.cos
import kotlin.math.sin

data class CameraViewState(
    val azimuth: Double,
    val elevation: Double,
    val distance: Double,
    val panX: Double,
    val panY: Double,
    val targetX: Double,
    val targetY: Double,
    val targetZ: Double,
)

/**
 * Orbit camera. Z-up convention (XY = bed plane, Z = print height).
 * Scalars stored as Double; downcast to Float at shader upload time.
 */
class Camera {
    @Volatile var azimuth = -45.0
    @Volatile var elevation = 45.0
    @Volatile var distance = 300.0
    @Volatile var panX = 0.0
    @Volatile var panY = 0.0
    @Volatile var targetX = 0.0
    @Volatile var targetY = 0.0
    @Volatile var targetZ = 0.0

    // Initialize matrices to identity, NOT all-zeros (the FloatArray
    // default). Bug fixed 2026-05-08: when the very first onDrawFrame
    // ran before onSurfaceChanged populated viewportWidth/Height, the
    // projection matrix stayed at all-zeros, MVP = projection * view
    // collapsed to zero, and the model + bed rendered to gl_Position
    // (0,0,0,0) — invisible. Tapping any camera preset would force a
    // later re-render after the viewport was valid, which is why the
    // user saw "Iso doesn't work until I click Front first."
    val viewMatrix = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    val projectionMatrix = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    val mvpMatrix = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    val normalMatrix = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    private val tempMatrix = FloatArray(16)

    fun setTarget(x: Double, y: Double, z: Double) {
        targetX = x
        targetY = y
        targetZ = z
    }

    fun snapshot() =
        CameraViewState(azimuth, elevation, distance, panX, panY, targetX, targetY, targetZ)

    fun restore(state: CameraViewState) {
        azimuth = state.azimuth
        elevation = state.elevation
        distance = state.distance
        panX = state.panX
        panY = state.panY
        targetX = state.targetX
        targetY = state.targetY
        targetZ = state.targetZ
    }

    fun rotate(dAzimuth: Double, dElevation: Double) {
        azimuth += dAzimuth
        elevation = (elevation + dElevation).coerceIn(5.0, 89.0)
    }

    fun zoom(factor: Double) {
        distance = (distance * factor).coerceIn(10.0, 2000.0)
    }

    fun pan(dx: Double, dy: Double) {
        val radAz = Math.toRadians(azimuth)
        val rightX = -sin(radAz)
        val rightY = cos(radAz)
        val upX = -cos(radAz)
        val upY = -sin(radAz)
        panX += rightX * dx + upX * dy
        panY += rightY * dx + upY * dy
    }

    fun updateViewMatrix() {
        val radAz = Math.toRadians(azimuth)
        val radEl = Math.toRadians(elevation)
        val eyeX = (targetX + panX + distance * cos(radEl) * cos(radAz)).toFloat()
        val eyeY = (targetY + panY + distance * cos(radEl) * sin(radAz)).toFloat()
        val eyeZ = (targetZ + distance * sin(radEl)).toFloat()
        Matrix.setLookAtM(
            viewMatrix,
            0,
            eyeX,
            eyeY,
            eyeZ,
            (targetX + panX).toFloat(),
            (targetY + panY).toFloat(),
            targetZ.toFloat(),
            0f,
            0f,
            1f,
        )
    }

    fun updateProjectionMatrix(width: Int, height: Int) {
        val aspect = width.toFloat() / height.toFloat()
        val near = (distance * 0.05).coerceAtLeast(1.0).toFloat()
        val far = (distance * 5.0).toFloat()
        Matrix.perspectiveM(projectionMatrix, 0, 45f, aspect, near, far)
    }

    fun computeMVP(modelMatrix: FloatArray = IDENTITY) {
        Matrix.multiplyMM(tempMatrix, 0, viewMatrix, 0, modelMatrix, 0)
        Matrix.multiplyMM(mvpMatrix, 0, projectionMatrix, 0, tempMatrix, 0)
        Matrix.invertM(normalMatrix, 0, tempMatrix, 0)
        transposeInPlace(normalMatrix)
    }

    private fun transposeInPlace(m: FloatArray) {
        fun swap(i: Int, j: Int) {
            val t = m[i]
            m[i] = m[j]
            m[j] = t
        }
        swap(1, 4); swap(2, 8); swap(3, 12)
        swap(6, 9); swap(7, 13); swap(11, 14)
    }

    companion object {
        val IDENTITY = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    }
}
