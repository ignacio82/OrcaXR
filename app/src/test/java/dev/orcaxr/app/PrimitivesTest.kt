package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D12 — pure-Kotlin contract tests for the [PrimitiveKind] catalog.
 * The native build exercise (libslic3r `its_make_*` -> binary STL) is
 * covered separately by an instrumented test that runs on-device; this
 * suite locks down the metadata that flows into the JNI call so a
 * silent re-ordering of params can't slip through.
 */
class PrimitivesTest {

    @Test fun ordinalsMatchJniSwitchOrder() {
        // The JNI's switch in nativeBuildPrimitiveStl maps these
        // exactly. A stale ordinal would silently route a sphere
        // request to the cube branch — fail loud here instead.
        assertEquals(0, PrimitiveKind.CUBE.nativeOrdinal)
        assertEquals(1, PrimitiveKind.CYLINDER.nativeOrdinal)
        assertEquals(2, PrimitiveKind.SPHERE.nativeOrdinal)
        assertEquals(3, PrimitiveKind.CONE.nativeOrdinal)
        assertEquals(4, PrimitiveKind.TORUS.nativeOrdinal)
        assertEquals(5, PrimitiveKind.DISC.nativeOrdinal)
        assertEquals(6, PrimitiveKind.SLAB.nativeOrdinal)
    }

    @Test fun ordinalsAreUnique() {
        val ords = PrimitiveKind.values().map { it.nativeOrdinal }
        assertEquals(ords.size, ords.toSet().size)
    }

    @Test fun defaultsLengthMatchesParamNames() {
        for (k in PrimitiveKind.values()) {
            assertEquals(
                "param/default count must match for $k",
                k.paramNames.size,
                k.defaults.size,
            )
        }
    }

    @Test fun defaultsAreAllPositive() {
        for (k in PrimitiveKind.values()) {
            for ((i, name) in k.paramNames.withIndex()) {
                assertTrue("$k.$name default must be > 0", k.defaults[i] > 0f)
            }
        }
    }

    @Test fun fromNameIsCaseInsensitive() {
        assertEquals(PrimitiveKind.CYLINDER, PrimitiveKind.fromName("CYLINDER"))
        assertEquals(PrimitiveKind.CYLINDER, PrimitiveKind.fromName("cylinder"))
        assertEquals(PrimitiveKind.CYLINDER, PrimitiveKind.fromName("Cylinder"))
        assertNull(PrimitiveKind.fromName("not-a-shape"))
    }

    @Test fun paramsFromMapMergesWithDefaults() {
        val k = PrimitiveKind.CYLINDER
        val out = k.paramsFromMap(mapOf("radius_mm" to 7f))
        assertEquals(3, out.size)
        assertEquals(7f, out[0])
        assertEquals(k.defaults[1], out[1])
        assertEquals(k.defaults[2], out[2])
    }

    @Test fun paramsFromMapIgnoresUnknownKeys() {
        val k = PrimitiveKind.CUBE
        val out = k.paramsFromMap(mapOf("garbage" to 99f, "y_mm" to 33f))
        assertEquals(k.defaults[0], out[0])
        assertEquals(33f, out[1])
        assertEquals(k.defaults[2], out[2])
    }

    @Test fun cubeAndSlabUseSameParamLayout() {
        // SLAB is a cube alias so the LLM can use the more familiar
        // "slab" label for "wide flat brick"; the underlying params
        // must agree so a swap doesn't surprise downstream code.
        assertEquals(PrimitiveKind.CUBE.paramNames, PrimitiveKind.SLAB.paramNames)
    }

    @Test fun discIsShortCylinder() {
        // Disc reuses the cylinder helper at the JNI level. Keep
        // the param layout disc-friendly (radius, thickness, fa)
        // — same shape as cylinder so a regression in either
        // surfaces here.
        assertEquals(3, PrimitiveKind.DISC.paramNames.size)
        assertTrue(PrimitiveKind.DISC.paramNames[1].contains("thickness"))
    }
}
