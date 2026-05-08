package dev.orcaxr.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M8b: native BVH path falls back gracefully on the JVM unit-test
 * environment (where libslic3r_jni.so isn't loaded), and the
 * Kotlin reference path stays correct under the toggle.
 *
 * The native parity + speedup tests live on-device behind the
 * `benchmark_native_bvh` MCP tool; these tests cover the
 * fallback-and-stays-correct invariants for the JVM build.
 */
class NativeBvhFallbackTest {

    @After fun resetToggle() {
        NativeBvh.setEnabled(false)
    }

    private fun cube(): StlMesh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) {
            for (k in 0 until 3) {
                pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
            }
        }
        return StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f))
    }

    @Test fun toggleDefaultsToOff() {
        // The runtime default must stay OFF — we only flip after
        // benchmark_native_bvh confirms parity + speedup on-device.
        // This test is the invariant.
        assertFalse(NativeBvh.isEnabled())
        assertFalse(NativeBvh.isEnabledAndAvailable)
    }

    @Test fun setEnabledFlipsTheFlag() {
        NativeBvh.setEnabled(true)
        assertTrue(NativeBvh.isEnabled())
        NativeBvh.setEnabled(false)
        assertFalse(NativeBvh.isEnabled())
    }

    @Test fun projectMaskFallsBackToKotlinWhenNativeUnavailable() {
        // JVM unit tests don't loadLibrary, so the JNI symbol is
        // absent. With the toggle ON, project() must still produce
        // the correct Kotlin output via the fallback.
        NativeBvh.setEnabled(true)
        val bvh = MeshBvh.build(cube())
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("top", geom.bboxCenteredPreview, 16, 16)
        val mask = BooleanArray(16 * 16) { false }
        mask[8 * 16 + 8] = true

        // Should not throw and should match the Kotlin reference.
        val viaProject = AiMaskProjection.project(
            bvh, cam, mask,
            depthMode = AiMaskProjection.DepthMode.FrontFacingOnly,
        )
        val viaReference = AiMaskProjection.projectKotlin(
            bvh, cam, mask,
            depthMode = AiMaskProjection.DepthMode.FrontFacingOnly,
        )
        assertEquals(
            "fallback path must match Kotlin reference triangle-for-triangle",
            viaReference.toList(),
            viaProject.toList(),
        )
        // Probed and unavailable now — pinned for subsequent calls.
        assertEquals(false, NativeBvh.probedAvailableOrNull())
    }

    @Test fun projectMaskFollowsKotlinPathWhenToggleOff() {
        // With the toggle OFF (the default), the Kotlin path runs
        // unconditionally — no native call, no probe.
        assertFalse(NativeBvh.isEnabled())
        val before = NativeBvh.probedAvailableOrNull()
        val bvh = MeshBvh.build(cube())
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 8, 8)
        val mask = BooleanArray(8 * 8) { false }
        mask[4 * 8 + 4] = true
        AiMaskProjection.project(bvh, cam, mask)
        // Probed state unchanged when toggle is OFF (we never called).
        assertEquals(before, NativeBvh.probedAvailableOrNull())
    }

    @Test fun nativeBvhArraysViewExposesSameReferences() {
        // The arrays handed to the native call must be the BVH's
        // own; otherwise we're paying a copy on every call. Identity
        // check ensures no defensive copy snuck in.
        val bvh = MeshBvh.build(cube())
        val view = bvh.nativeBvhArraysView()
        val view2 = bvh.nativeBvhArraysView()
        assertNotNull(view.positions)
        // The underlying arrays should be the same references across
        // calls (no copy in the accessor).
        assertTrue(view.positions === view2.positions)
        assertTrue(view.triIdx === view2.triIdx)
        assertTrue(view.nodeAabb === view2.nodeAabb)
    }

    @Test fun nativeProjectMaskReturnsNullOnJvmEnvironment() {
        // Direct call on the JVM: no .so loaded → returns null,
        // pins probedAvailable=false.
        val bvh = MeshBvh.build(cube())
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = AiRenderEngine.namedPreset("front", geom.bboxCenteredPreview, 8, 8)
        val mask = BooleanArray(8 * 8) { false }
        mask[4 * 8 + 4] = true
        val result = NativeBvh.projectMask(
            bvh.nativeBvhArraysView(), cam, mask,
            AiMaskProjection.DepthMode.FrontFacingOnly,
            backFaceFilter = true,
        )
        assertNull("native should be unavailable on JVM", result)
        assertEquals(false, NativeBvh.probedAvailableOrNull())
    }
}
