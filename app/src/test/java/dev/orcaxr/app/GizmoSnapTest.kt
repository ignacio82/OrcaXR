package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

class GizmoSnapTest {

    @Test
    fun `snapAndClampOffset rounds to nearest snap grid`() {
        // Banker's rounding on .5 boundaries can be surprising, 
        // so we test clear directional rounding.
        assertEquals(BedXY(0f, 0f), snapAndClampOffset(2.4f, -2.4f, snap = 5f))
        assertEquals(BedXY(5f, -5f), snapAndClampOffset(2.6f, -2.6f, snap = 5f))
        assertEquals(BedXY(10f, 15f), snapAndClampOffset(9.9f, 14.1f, snap = 5f))
        assertEquals(BedXY(0f, 0f), snapAndClampOffset(0f, 0f, snap = 5f))
    }

    @Test
    fun `snapAndClampOffset clamps to halfBed`() {
        val halfBed = 128f
        // Way out of bounds
        assertEquals(BedXY(128f, -128f), snapAndClampOffset(200f, -300f, snap = 5f, halfBed = halfBed))
        // Just over the edge
        assertEquals(BedXY(128f, 128f), snapAndClampOffset(128.1f, 129f, snap = 5f, halfBed = halfBed))
    }

    @Test
    fun `snapAndClampOffset applies clamp after snap`() {
        val halfBed = 128f
        // 127.4 snaps to 125
        assertEquals(BedXY(125f, 125f), snapAndClampOffset(127.4f, 127.4f, snap = 5f, halfBed = halfBed))
        // 127.6 snaps to 130, which then clamps to 128
        assertEquals(BedXY(128f, 128f), snapAndClampOffset(127.6f, 127.6f, snap = 5f, halfBed = halfBed))
    }
}
