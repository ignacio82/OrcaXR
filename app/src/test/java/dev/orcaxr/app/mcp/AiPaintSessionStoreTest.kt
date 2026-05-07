package dev.orcaxr.app.mcp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AiPaintSessionStore + AiPaintSession unit tests. Pure JVM — no
 * Compose, no Android, no MainActivity. Each test exercises a
 * single contract: open / mutate / fingerprint / discard / LRU.
 */
class AiPaintSessionStoreTest {

    @Test fun beginCopiesPaintSoLiveModelIsNotMutated() {
        val store = AiPaintSessionStore()
        val live = ByteArray(10) { (it + 1).toByte() }
        val s = store.begin(
            modelId = "m1", triCount = 10,
            basePaintFilamentIndex = live,
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        // Mutating session must not touch live array.
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 1, 2),
            tag = 7,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(1, live[0].toInt())
        assertEquals(2, live[1].toInt())
        assertEquals(3, live[2].toInt())
        // Session has the new state.
        val sessionPaint = s.paintFilamentIndex
        assertNotNull(sessionPaint)
        assertEquals(7, sessionPaint!![0].toInt())
        assertEquals(7, sessionPaint[1].toInt())
        assertEquals(7, sessionPaint[2].toInt())
        // And the rest is untouched.
        assertEquals(4, sessionPaint[3].toInt())
    }

    @Test fun applyTriangleSetReturnsActuallyPaintedCount() {
        val store = AiPaintSessionStore()
        val s = store.begin(
            modelId = "m1", triCount = 8,
            basePaintFilamentIndex = ByteArray(8) { 0 },
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        val n1 = s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 2, 4),
            tag = 3,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(3, n1)
        // Re-painting same indices with the same tag should report 0
        // (no change).
        val n2 = s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 2, 4),
            tag = 3,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(0, n2)
        assertEquals(2, s.totalActions)
        assertEquals(3L, s.totalTrianglesPainted)
    }

    @Test fun mergeModeOnlyUnpaintedSkipsAlreadyPainted() {
        val store = AiPaintSessionStore()
        val seed = ByteArray(6).apply { this[2] = 5 }  // index 2 is tag=5
        val s = store.begin(
            modelId = "m1", triCount = 6,
            basePaintFilamentIndex = seed,
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        val painted = s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 1, 2, 3),
            tag = 9,
            mergeMode = WorkspaceAction.MergeMode.OnlyUnpainted,
            whereTag = 0,
        )
        // Index 2 was already 5, so OnlyUnpainted skips it.
        assertEquals(3, painted)
        val arr = s.paintFilamentIndex!!
        assertEquals(9, arr[0].toInt())
        assertEquals(9, arr[1].toInt())
        assertEquals(5, arr[2].toInt())
        assertEquals(9, arr[3].toInt())
    }

    @Test fun mergeModeOnlyTaggedReplacesOnlyMatchingTag() {
        val store = AiPaintSessionStore()
        val seed = byteArrayOf(2, 3, 2, 3, 2, 3)
        val s = store.begin(
            modelId = "m1", triCount = 6,
            basePaintFilamentIndex = seed,
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        val painted = s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 1, 2, 3, 4, 5),
            tag = 8,
            mergeMode = WorkspaceAction.MergeMode.OnlyTagged,
            whereTag = 3,
        )
        assertEquals(3, painted)
        val arr = s.paintFilamentIndex!!
        assertArrayEquals(byteArrayOf(2, 8, 2, 8, 2, 8), arr)
    }

    @Test fun fingerprintChangesAfterMutationButOnlyContent() {
        val store = AiPaintSessionStore()
        val s = store.begin(
            modelId = "m1", triCount = 4,
            basePaintFilamentIndex = ByteArray(4) { 0 },
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        val before = s.currentFingerprint()
        assertEquals(s.baseFingerprint, before)
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0),
            tag = 1,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        val after = s.currentFingerprint()
        assertNotEquals(before, after)
        // Re-applying the same tag is a no-op for the fingerprint.
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0),
            tag = 1,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(after, s.currentFingerprint())
    }

    @Test fun discardRemovesSession() {
        val store = AiPaintSessionStore()
        val s = store.begin("m", 2, null, null, null, null)
        assertNotNull(store.get(s.id))
        assertTrue(store.discard(s.id))
        assertNull(store.get(s.id))
        // Second discard is false.
        assertFalse(store.discard(s.id))
    }

    @Test fun lruEvictsOldestWhenAtCap() {
        val store = AiPaintSessionStore()
        val ids = ArrayList<String>()
        // Audit H21 — instead of Thread.sleep(2) per insert (flaky on
        // overloaded CI when two iterations land in the same ms),
        // stamp `lastTouchedAtMs` explicitly so eviction order is
        // deterministic and the test runs in <1 ms.
        for (i in 0 until AiPaintSessionStore.MAX_SESSIONS + 2) {
            val s = store.begin("m$i", 1, null, null, null, null)
            s.setLastTouchedAtMsForTest(1000L + i)
            ids.add(s.id)
        }
        assertEquals(AiPaintSessionStore.MAX_SESSIONS, store.all().size)
        // Oldest two should be evicted.
        assertNull(store.get(ids[0]))
        assertNull(store.get(ids[1]))
        assertNotNull(store.get(ids.last()))
    }

    @Test fun fingerprintDistinguishesNullFromEmptyArray() {
        val nullFp = AiPaintSessionStore.fingerprint(null, null, null, null)
        val emptyFp = AiPaintSessionStore.fingerprint(ByteArray(0), null, null, null)
        assertNotEquals(nullFp, emptyFp)
    }

    @Test fun fingerprintIsDeterministicAcrossInstances() {
        val a = AiPaintSessionStore.fingerprint(byteArrayOf(1, 2, 3), null, null, null)
        val b = AiPaintSessionStore.fingerprint(byteArrayOf(1, 2, 3), null, null, null)
        assertEquals(a, b)
    }

    @Test fun diffSummaryReturnsTagHistogramPerKind() {
        val store = AiPaintSessionStore()
        val s = store.begin(
            modelId = "m1", triCount = 6,
            basePaintFilamentIndex = ByteArray(6) { 0 },
            baseSupportFlags = null, baseSeamFlags = null, baseFuzzySkinFlags = null,
        )
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0, 1, 2),
            tag = 4,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(3, 4),
            tag = 7,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        val diff = s.diffSummary()
        val hist = diff[WorkspaceAction.PaintKind.Color]!!
        assertEquals(1, hist[0])  // index 5 still untagged
        assertEquals(3, hist[4])
        assertEquals(2, hist[7])
        // Kinds we never touched aren't in the map.
        assertNull(diff[WorkspaceAction.PaintKind.Support])
    }

    @Test fun versionIncrementsPerMutation() {
        val store = AiPaintSessionStore()
        val s = store.begin("m", 4, null, null, null, null)
        assertEquals(0L, s.version)
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(0),
            tag = 1,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(1L, s.version)
        s.applyTriangleSet(
            kind = WorkspaceAction.PaintKind.Color,
            indices = intArrayOf(1),
            tag = 2,
            mergeMode = WorkspaceAction.MergeMode.Replace,
            whereTag = 0,
        )
        assertEquals(2L, s.version)
    }
}
