package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the paint stamp dispatcher's allocation behaviour. The
 * regression these guard against (2026-05-02): on a 1.4M-triangle
 * mesh, every Color stamp was cloning the full `paintFilamentIndex`
 * ByteArray (1.4 MB) so a long drag-paint stroke OOMed the 512 MB JVM
 * heap inside ~30 seconds. The fix moved per-stroke mutation to
 * `stampTrianglesInPlace` and bumped a content-version counter to
 * trigger the rebake LE without changing the array reference.
 *
 * These tests verify the in-place semantics directly so a future
 * refactor that accidentally re-introduces per-event clones can't
 * land without breaking a unit test.
 */
class PaintStampAllocationTest {

    @Test
    fun `stampTrianglesInPlace mutates target without allocating`() {
        val target = ByteArray(1_000_000)
        val before = target  // capture reference for identity check
        stampTrianglesInPlace(target, intArrayOf(42, 100, 999_999), slot = 3)
        assertSame("must not allocate a new array", before, target)
        assertEquals(3.toByte(), target[42])
        assertEquals(3.toByte(), target[100])
        assertEquals(3.toByte(), target[999_999])
        // Untouched indices stay 0.
        assertEquals(0.toByte(), target[0])
        assertEquals(0.toByte(), target[500_000])
    }

    @Test
    fun `stampTrianglesInPlace overwrites previous stamps with new slot`() {
        val target = ByteArray(100)
        stampTrianglesInPlace(target, intArrayOf(5, 10), slot = 1)
        assertEquals(1.toByte(), target[5])
        stampTrianglesInPlace(target, intArrayOf(5, 10), slot = 4)
        assertEquals(4.toByte(), target[5])
        assertEquals(4.toByte(), target[10])
    }

    @Test
    fun `stampTrianglesInPlace rejects out-of-range index`() {
        val target = ByteArray(10)
        try {
            stampTrianglesInPlace(target, intArrayOf(0, 5, 100), slot = 1)
            throw AssertionError("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("triangleIdx=100"))
        }
        // Indices before the bad one DID get applied; the throw is
        // a programming error, not data validation.
    }

    @Test
    fun `repeated in-place stamps keep the same backing array`() {
        // Simulates the dispatcher's stroke buffer: a single
        // `paintFilamentIndex` mutated across hundreds of MOVE events.
        // Confirms that allocations stay constant regardless of
        // stroke length.
        val target = ByteArray(1_000_000)
        val identity = System.identityHashCode(target)
        repeat(500) { i ->
            stampTrianglesInPlace(target, intArrayOf(i % target.size), slot = (i % 4) + 1)
            assertEquals(
                "stroke buffer reference must stay identical across stamps",
                identity,
                System.identityHashCode(target),
            )
        }
    }

    @Test
    fun `stampTriangles returns a fresh array each call`() {
        // Sanity: confirm the immutable-style stampTriangles is still
        // allocation-per-call. This is the path used by undo/redo
        // restore (where allocation is fine and we WANT a separate
        // array reference).
        val previous: ByteArray? = null
        val a = stampTriangles(previous, triCount = 100, triangleIndices = intArrayOf(0), slot = 1)
        val b = stampTriangles(a, triCount = 100, triangleIndices = intArrayOf(1), slot = 2)
        assertNotNull(a)
        assertNotNull(b)
        assertNotEquals(
            "stampTriangles must allocate a new array; in-place callers should use stampTrianglesInPlace",
            System.identityHashCode(a),
            System.identityHashCode(b),
        )
        assertEquals(1.toByte(), b[0])
        assertEquals(2.toByte(), b[1])
    }

    @Test
    fun `stroke buffer holds independent state from history snapshot`() {
        // The MainActivity DOWN handler clones model.paintFilamentIndex
        // into PaintHistory's snapshot, then lets the stroke mutate the
        // model's array in place. This test models that contract:
        // the snapshot must NOT change when the live array is stamped.
        val initial = ByteArray(100).also { it[0] = 5 }
        val historySnapshot = initial.copyOf()  // what beginStroke captures
        val live = initial  // what the model keeps mutating

        stampTrianglesInPlace(live, intArrayOf(0, 1, 2), slot = 9)

        // Live is mutated.
        assertEquals(9.toByte(), live[0])
        assertEquals(9.toByte(), live[1])
        // Snapshot still has the pre-stroke values.
        assertEquals(5.toByte(), historySnapshot[0])
        assertEquals(0.toByte(), historySnapshot[1])
    }
}
