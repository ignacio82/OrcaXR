package dev.orcaxr.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Tests for [PaintBrush] / [stampTriangle] / [stampTriangles] /
 * [hasAnyPaint]. The data layer is the foundation of Phase J — every
 * paint event from the controller laser turns into one of these
 * stamps, so the slot-encoding rules and lazy-allocation behavior
 * need to be locked down before the JNI authoring path can trust
 * them.
 */
class PaintBrushTest {

    @Test fun brushDefaultsAreOff() {
        val b = PaintBrush()
        assertEquals(PaintMode.Off, b.mode)
        assertEquals(1, b.activeSlot)
        assertEquals(6f, b.radiusMm)
    }

    @Test fun brushRejectsNegativeSlot() {
        runCatching { PaintBrush(activeSlot = -1) }.also {
            assertTrue("should reject negative slot", it.isFailure)
        }
    }

    @Test fun brushRejectsSlotPastMax() {
        runCatching { PaintBrush(activeSlot = MAX_PAINT_SLOTS + 1) }.also {
            assertTrue("should reject over-max slot", it.isFailure)
        }
    }

    @Test fun brushAcceptsZeroSlotForClearPaint() {
        // 0 = "clear paint" / unpainted. Brush UI exposes this as a
        // dedicated "eraser" affordance, but the data model is
        // identical to a normal stamp.
        val b = PaintBrush(activeSlot = 0)
        assertEquals(0, b.activeSlot)
    }

    @Test fun brushRejectsNegativeRadius() {
        runCatching { PaintBrush(radiusMm = -1f) }.also {
            assertTrue(it.isFailure)
        }
    }

    @Test fun stampOnNullAllocatesFreshArray() {
        val out = stampTriangle(previous = null, triCount = 100, triangleIdx = 5, slot = 2)
        assertEquals(100, out.size)
        assertEquals(2.toByte(), out[5])
        // every other slot still 0
        for (i in 0 until 100) {
            if (i != 5) assertEquals("[$i] should be 0", 0.toByte(), out[i])
        }
    }

    @Test fun stampOnExistingArrayPreservesOtherEntries() {
        val previous = ByteArray(10).also { it[3] = 1 }
        val out = stampTriangle(previous, triCount = 10, triangleIdx = 7, slot = 2)
        assertEquals(1.toByte(), out[3])
        assertEquals(2.toByte(), out[7])
        // returns a copy, not the same instance — caller should always
        // use the return value
        assertNotSame(previous, out)
    }

    @Test fun stampWithSlotZeroErasesPaint() {
        val previous = ByteArray(5).also { it[2] = 3 }
        val out = stampTriangle(previous, triCount = 5, triangleIdx = 2, slot = 0)
        assertEquals(0.toByte(), out[2])
    }

    @Test fun stampRejectsOutOfRangeTriangleIdx() {
        runCatching { stampTriangle(null, 10, triangleIdx = 10, slot = 1) }.also {
            assertTrue(it.isFailure)
        }
        runCatching { stampTriangle(null, 10, triangleIdx = -1, slot = 1) }.also {
            assertTrue(it.isFailure)
        }
    }

    @Test fun stampRejectsSlotPastMax() {
        runCatching { stampTriangle(null, 10, 0, slot = MAX_PAINT_SLOTS + 1) }.also {
            assertTrue(it.isFailure)
        }
    }

    @Test fun stampManyTrianglesAtOnce() {
        val out = stampTriangles(null, triCount = 10, triangleIndices = intArrayOf(2, 5, 7), slot = 4)
        assertEquals(4.toByte(), out[2])
        assertEquals(4.toByte(), out[5])
        assertEquals(4.toByte(), out[7])
        for (i in listOf(0, 1, 3, 4, 6, 8, 9)) {
            assertEquals(0.toByte(), out[i])
        }
    }

    @Test fun stampManyTrianglesPreservesPreviousPaint() {
        val previous = ByteArray(10).also { it[1] = 3 }
        val out = stampTriangles(previous, triCount = 10, triangleIndices = intArrayOf(2, 5), slot = 4)
        assertEquals(3.toByte(), out[1])
        assertEquals(4.toByte(), out[2])
        assertEquals(4.toByte(), out[5])
    }

    @Test fun stampManyEmptyArrayIsNoOpButReturnsAllocatedArray() {
        // Edge case: a brush radius BFS that hits no triangles (e.g.
        // the laser missed the mesh) still allocates the full-size
        // array. We choose this over returning null so the caller
        // never has to special-case a "first-event-but-painted-nothing"
        // state — the next event mutates the same array.
        val out = stampTriangles(null, triCount = 5, triangleIndices = intArrayOf(), slot = 1)
        assertEquals(5, out.size)
        for (b in out) assertEquals(0.toByte(), b)
    }

    @Test fun hasAnyPaintTrueWhenAtLeastOneSlotSet() {
        val paint = ByteArray(10).also { it[4] = 2 }
        assertTrue(hasAnyPaint(paint))
    }

    @Test fun hasAnyPaintFalseOnNullOrAllZeros() {
        assertFalse(hasAnyPaint(null))
        assertFalse(hasAnyPaint(ByteArray(10)))
    }

    @Test fun hasAnyPaintFalseOnZeroLength() {
        // A 0-triangle mesh that happens to allocate is still
        // unpainted.
        assertFalse(hasAnyPaint(ByteArray(0)))
    }

    @Test fun radiusPresetsAreSensibleProgression() {
        // Sentinel: presets exist and progress monotonically. UI
        // pickers cycle through these; the test catches accidental
        // re-ordering or duplicate-entry edits.
        assertEquals(3, BRUSH_RADIUS_PRESETS_MM.size)
        for (i in 1 until BRUSH_RADIUS_PRESETS_MM.size) {
            assertTrue(BRUSH_RADIUS_PRESETS_MM[i] > BRUSH_RADIUS_PRESETS_MM[i - 1])
        }
    }

    // ---------------- PlacedModel.paintFilamentIndex equality ----------------
    //
    // Data-class default would compare ByteArray by identity, breaking
    // structural comparison. Verify the override actually works.

    private fun blank(id: String, paint: ByteArray? = null) = PlacedModel(
        id = id,
        source = File("/tmp/$id.stl"),
        label = id,
        paintFilamentIndex = paint,
    )

    @Test fun placedModelEqualsTreatsEqualPaintArraysAsEqual() {
        val a = blank("m", paint = byteArrayOf(0, 1, 0, 2))
        val b = blank("m", paint = byteArrayOf(0, 1, 0, 2))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test fun placedModelEqualsDistinguishesDifferentPaintArrays() {
        val a = blank("m", paint = byteArrayOf(0, 1, 0, 2))
        val b = blank("m", paint = byteArrayOf(0, 1, 0, 3))
        assertFalse(a == b)
    }

    @Test fun placedModelEqualsHandlesNullPaintConsistently() {
        val a = blank("m", paint = null)
        val b = blank("m", paint = null)
        assertEquals(a, b)

        val c = blank("m", paint = ByteArray(0))
        // empty array != null. Probably doesn't matter in practice
        // (you only carry an array once the user has touched the
        // model), but keeping the distinction explicit means the
        // re-bake LaunchedEffect can reliably detect "first paint"
        // by going from null → non-null.
        assertFalse(a == c)
    }

    @Test fun placedModelDataCopyPreservesPaint() {
        // Phase G's per-model edit path is `placedModels.map { if (it.id ==
        // sel) it.copy(rotZDeg = …) }`. That copy must carry the paint
        // forward — losing it on a rotate would lose user work.
        val orig = blank("m", paint = byteArrayOf(0, 1, 2, 3))
        val rotated = orig.copy(rotZDeg = 90)
        assertArrayEquals(orig.paintFilamentIndex, rotated.paintFilamentIndex)
    }

    @Test fun placedModelHashStableUnderEqualPaintArrays() {
        // Same structural paint should hash identically — hashmaps /
        // SnapshotStateMap cache lookups would degrade otherwise.
        val a = blank("m", paint = byteArrayOf(1, 1, 1))
        val b = blank("m", paint = byteArrayOf(1, 1, 1))
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test fun placedModelDefaultPaintIsNull() {
        val m = blank("m")
        assertNull(m.paintFilamentIndex)
    }
}
