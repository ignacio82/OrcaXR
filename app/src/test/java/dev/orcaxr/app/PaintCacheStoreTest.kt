package dev.orcaxr.app

import android.content.Context
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.JUnit4
import java.io.File
import java.nio.file.Files

/**
 * Roadmap D1 — verify [PaintCacheStore] round-trips paint payloads,
 * forgives tri-count mismatches, and enforces LRU eviction. Pure-JVM
 * (no Robolectric) because every Context method we touch
 * (`filesDir`) is a thin getter we can satisfy by hand.
 */
@RunWith(JUnit4::class)
class PaintCacheStoreTest {

    /** Minimal Context shim: PaintCacheStore reads `filesDir` only. */
    private class FakeContext(private val files: File) : android.content.ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = files
    }

    private lateinit var tmp: File
    private lateinit var store: PaintCacheStore

    @Before fun setUp() {
        tmp = Files.createTempDirectory("paint_cache_test").toFile()
        store = PaintCacheStore(FakeContext(tmp))
    }

    @After fun tearDown() {
        tmp.deleteRecursively()
    }

    @Test fun save_then_restore_round_trips_arrays() {
        val paint = byteArrayOf(0, 1, 2, 0, 3)
        val support = byteArrayOf(0, 0, 1, 2, 0)
        val seam = byteArrayOf(1, 0, 0, 0, 0)
        store.save("hash1", triCount = 5, PaintCacheStore.Entry(paint, support, seam))
        val restored = store.restore("hash1", expectedTriCount = 5)
        assertNotNull(restored)
        assertArrayEquals(paint, restored!!.paintFilamentIndex)
        assertArrayEquals(support, restored.supportFlags)
        assertArrayEquals(seam, restored.seamFlags)
    }

    @Test fun restore_with_wrong_triCount_returns_null() {
        store.save("hash1", triCount = 5, PaintCacheStore.Entry(byteArrayOf(0, 1, 0, 0, 0), null, null))
        assertNull(store.restore("hash1", expectedTriCount = 6))
    }

    @Test fun restore_missing_returns_null() {
        assertNull(store.restore("does_not_exist", expectedTriCount = 5))
    }

    @Test fun save_with_all_arrays_blank_removes_entry() {
        store.save("hash1", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 1, 2, 0), null, null))
        assertEquals(1, store.size())
        // All-zero paint counts as "no paint" → entry deleted.
        store.save("hash1", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 0, 0, 0), null, null))
        assertEquals(0, store.size())
        assertNull(store.restore("hash1", expectedTriCount = 4))
    }

    @Test fun save_with_null_arrays_removes_entry() {
        store.save("hash1", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 1, 0, 0), null, null))
        assertEquals(1, store.size())
        store.save("hash1", triCount = 4, PaintCacheStore.Entry(null, null, null))
        assertEquals(0, store.size())
    }

    @Test fun lru_evicts_oldest_when_over_cap() {
        // Burn the cap: write MAX_ENTRIES + 5 entries with strictly
        // increasing mtime. The first 5 should be gone after the
        // last save's eviction pass. Use a non-zero paint byte so
        // the entries survive the all-blank pruning.
        val total = PaintCacheStore.MAX_ENTRIES + 5
        for (i in 0 until total) {
            store.save("hash$i", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 1, 0, 0), null, null))
            // Force the file's mtime forward so the LRU comparator has
            // a well-defined oldest. setLastModified takes ms — use
            // i*1000 to leave headroom for any clock-source rounding.
            File(tmp, "paint_cache/hash$i.bin").setLastModified(1_000_000L + i * 1000L)
        }
        assertEquals(PaintCacheStore.MAX_ENTRIES, store.size())
        for (i in 0 until 5) {
            assertNull("expected hash$i to be evicted", store.restore("hash$i", expectedTriCount = 4))
        }
        for (i in 5 until total) {
            assertNotNull("expected hash$i to survive", store.restore("hash$i", expectedTriCount = 4))
        }
    }

    @Test fun hash_of_same_file_is_stable() {
        val f1 = File(tmp, "model.stl")
        f1.writeBytes(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
        val h1 = store.hashOf(f1)
        val h2 = store.hashOf(f1)
        assertEquals(h1, h2)
        // SHA-256 hex is 64 chars.
        assertEquals(64, h1.length)
    }

    @Test fun hash_of_different_content_differs() {
        val a = File(tmp, "a.stl").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val b = File(tmp, "b.stl").apply { writeBytes(byteArrayOf(1, 2, 4)) }
        assertTrue(store.hashOf(a) != store.hashOf(b))
    }

    @Test fun corrupt_file_returns_null() {
        val target = File(tmp, "paint_cache/garbage.bin")
        target.parentFile?.mkdirs()
        target.writeBytes(byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0))  // wrong magic
        assertNull(store.restore("garbage", expectedTriCount = 5))
    }

    @Test fun entry_equals_compares_arrays() {
        val a = PaintCacheStore.Entry(byteArrayOf(0, 1, 2), null, byteArrayOf(3, 4))
        val b = PaintCacheStore.Entry(byteArrayOf(0, 1, 2), null, byteArrayOf(3, 4))
        val c = PaintCacheStore.Entry(byteArrayOf(0, 1, 3), null, byteArrayOf(3, 4))
        assertEquals(a, b)
        assertTrue(a != c)
    }

    @Test fun sizeBytes_grows_with_entries_and_clears_to_zero() {
        // Empty cache reports 0.
        assertEquals(0L, store.sizeBytes())

        // One small entry — header (24 bytes) + 4-byte paint array.
        store.save("h1", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 1, 0, 0), null, null))
        val oneEntryBytes = store.sizeBytes()
        assertTrue("expected non-zero after one save, got $oneEntryBytes", oneEntryBytes > 0)

        // Add a second, distinct entry — total should strictly grow.
        store.save("h2", triCount = 4, PaintCacheStore.Entry(byteArrayOf(0, 0, 1, 0), null, null))
        val twoEntryBytes = store.sizeBytes()
        assertTrue("expected size to grow after second save: $oneEntryBytes → $twoEntryBytes",
            twoEntryBytes > oneEntryBytes)

        // Clear drops to zero so the help-card "Clear" button can be
        // trusted.
        store.clear()
        assertEquals(0L, store.sizeBytes())
    }
}
