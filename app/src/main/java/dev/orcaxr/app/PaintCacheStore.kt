package dev.orcaxr.app

import android.content.Context
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Roadmap D1 — persist in-XR paint state across app restarts.
 *
 * Without persistence the user paints a complex model, slices, kills
 * the app to free memory, comes back to find the paint gone — every
 * paint stroke has to be re-stamped from scratch. The store keys paint
 * by source-file SHA-256 so reloading the same STL/3MF file recovers
 * the prior paint immediately.
 *
 * Storage layout: `${filesDir}/paint_cache/<sha256>.bin`. Each file
 * holds a tiny header followed by four optional ByteArrays
 * (paintFilamentIndex, supportFlags, seamFlags, fuzzySkinFlags).
 * DataStore Preferences would force base64 + JSON for 1.4 MB arrays
 * which is both slower and more memory-thrashing — the raw-file path
 * here matches the GLB / STL cache pattern already in `ctx.cacheDir`.
 * We use `filesDir` (not `cacheDir`) so the OS doesn't GC the entries
 * under low-storage pressure.
 *
 * LRU: bounded at [MAX_ENTRIES] files. On every [save] the directory
 * is scanned and the oldest-mtime entries beyond the cap are deleted.
 *
 * File format (v2):
 * ```
 * u32  magic         ('OXPC' big-endian, "OrcaXR Paint Cache")
 * u32  version       (1 = pre-fuzzy, 2 = fuzzy added)
 * u32  triCount      (source mesh's triangle count at save time)
 * u32  paintLen      (0 if no paintFilamentIndex)
 * u32  supportLen    (0 if no supportFlags)
 * u32  seamLen       (0 if no seamFlags)
 * u32  fuzzyLen      (0 if no fuzzySkinFlags) — v2 only
 * bytes paintBytes
 * bytes supportBytes
 * bytes seamBytes
 * bytes fuzzyBytes  — v2 only
 * ```
 * v1 entries restore as fuzzySkinFlags=null (no fuzzy paint, the
 * default) and re-save as v2 on the next mutation.
 *
 * On read, [restore] returns null if any of: file missing, header
 * mismatch, magic/version mismatch, or [expectedTriCount] disagrees
 * with the stored triCount. The triCount mismatch case is the
 * forgive-and-discard guard for "user re-exported the STL with
 * different tessellation, hash matches but the paint indices no
 * longer line up."
 */
class PaintCacheStore(
    private val ctx: Context,
    /** D18j — directory name under filesDir. Default "paint_cache"
     *  (the SHA-keyed local cache); pass "paint_recipes" for the
     *  named-recipe store sibling. Both share the same on-disk
     *  binary format + LRU semantics. */
    dirName: String = DIR_NAME,
    /** D18j — LRU cap. Default matches the cache budget; recipe
     *  store can pass a higher value if user-curated recipes
     *  shouldn't evict each other. */
    private val maxEntries: Int = MAX_ENTRIES,
) {

    /** Tri-keyed paint payload restored from the store. Each ByteArray
     *  matches the source mesh's triangle count exactly; null means
     *  "this paint kind was never stamped on this model." */
    data class Entry(
        val paintFilamentIndex: ByteArray?,
        val supportFlags: ByteArray?,
        val seamFlags: ByteArray?,
        val fuzzySkinFlags: ByteArray? = null,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Entry) return false
            return byteArrayEq(paintFilamentIndex, other.paintFilamentIndex) &&
                byteArrayEq(supportFlags, other.supportFlags) &&
                byteArrayEq(seamFlags, other.seamFlags) &&
                byteArrayEq(fuzzySkinFlags, other.fuzzySkinFlags)
        }
        override fun hashCode(): Int {
            var r = paintFilamentIndex?.contentHashCode() ?: 0
            r = 31 * r + (supportFlags?.contentHashCode() ?: 0)
            r = 31 * r + (seamFlags?.contentHashCode() ?: 0)
            r = 31 * r + (fuzzySkinFlags?.contentHashCode() ?: 0)
            return r
        }
    }

    private val cacheDir: File = File(ctx.filesDir, dirName).also { it.mkdirs() }

    /** SHA-256 of [source]'s bytes, hex-encoded. Streamed so a large
     *  3MF doesn't pull the whole file into memory. */
    fun hashOf(source: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        source.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Persist [entry]'s arrays for [sourceHash] / [triCount]. If every
     *  array is null OR every array is empty / not-painted, the entry
     *  is removed instead so a "clear paint" round-trips cleanly. LRU
     *  eviction runs after the write. */
    fun save(sourceHash: String, triCount: Int, entry: Entry) {
        val anyPaint = hasAnyPaint(entry.paintFilamentIndex) ||
            hasAnyPaint(entry.supportFlags) ||
            hasAnyPaint(entry.seamFlags) ||
            hasAnyPaint(entry.fuzzySkinFlags)
        val target = fileFor(sourceHash)
        if (!anyPaint) {
            target.delete()
            return
        }
        val tmp = File(target.parentFile, "${target.name}.tmp")
        try {
            DataOutputStream(tmp.outputStream().buffered()).use { out ->
                out.writeInt(MAGIC)
                out.writeInt(VERSION)
                out.writeInt(triCount)
                val paint = entry.paintFilamentIndex ?: ByteArray(0)
                val support = entry.supportFlags ?: ByteArray(0)
                val seam = entry.seamFlags ?: ByteArray(0)
                val fuzzy = entry.fuzzySkinFlags ?: ByteArray(0)
                out.writeInt(paint.size)
                out.writeInt(support.size)
                out.writeInt(seam.size)
                out.writeInt(fuzzy.size)
                out.write(paint)
                out.write(support)
                out.write(seam)
                out.write(fuzzy)
            }
            // Atomic move so a partial write doesn't leave a corrupt
            // entry the next restore would have to repeatedly skip.
            if (target.exists()) target.delete()
            tmp.renameTo(target)
        } catch (e: IOException) {
            android.util.Log.w(TAG, "save($sourceHash) failed: ${e.message}", e)
            tmp.delete()
            return
        }
        evictIfFull()
    }

    /** Read the entry for [sourceHash]. Returns null when there is no
     *  cache hit, the header is corrupt, or [expectedTriCount] doesn't
     *  match the stored triCount. The triCount guard is the silent
     *  forgive-and-discard for "user re-exported the STL with
     *  different tessellation". */
    fun restore(sourceHash: String, expectedTriCount: Int): Entry? {
        val src = fileFor(sourceHash)
        if (!src.isFile || src.length() < HEADER_BYTES_V1) return null
        return try {
            DataInputStream(src.inputStream().buffered()).use { input ->
                val magic = input.readInt()
                if (magic != MAGIC) return@use null
                val version = input.readInt()
                if (version != VERSION_V1 && version != VERSION) return@use null
                val savedTriCount = input.readInt()
                if (savedTriCount != expectedTriCount) return@use null
                val paintLen = input.readInt()
                val supportLen = input.readInt()
                val seamLen = input.readInt()
                val fuzzyLen = if (version >= VERSION) input.readInt() else 0
                if (paintLen < 0 || supportLen < 0 || seamLen < 0 || fuzzyLen < 0) return@use null
                if (paintLen > MAX_ARRAY_BYTES || supportLen > MAX_ARRAY_BYTES ||
                    seamLen > MAX_ARRAY_BYTES || fuzzyLen > MAX_ARRAY_BYTES) return@use null
                val paint = if (paintLen > 0) ByteArray(paintLen).also { input.readFully(it) } else null
                val support = if (supportLen > 0) ByteArray(supportLen).also { input.readFully(it) } else null
                val seam = if (seamLen > 0) ByteArray(seamLen).also { input.readFully(it) } else null
                val fuzzy = if (fuzzyLen > 0) ByteArray(fuzzyLen).also { input.readFully(it) } else null
                // Touch the file's lastModified so LRU sees this as
                // most-recently-accessed — a cache hit is a "use" too.
                src.setLastModified(System.currentTimeMillis())
                Entry(paint, support, seam, fuzzy)
            }
        } catch (e: IOException) {
            android.util.Log.w(TAG, "restore($sourceHash) failed: ${e.message}", e)
            null
        }
    }

    /** Drop every cached entry. Used by tests; no UI surface yet. */
    fun clear() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    /** Number of entries currently on disk. Useful for tests + the
     *  future "Clear paint cache" Settings affordance. */
    fun size(): Int = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(EXT) }?.size ?: 0

    /**
     * Total bytes currently held by this cache on disk. Sums every
     * `.bin` entry's size; ignores temp files. Used by the help-card
     * Storage section so the user can see "Paint Cache: 12.4 MB"
     * without poking around `${filesDir}` on the command line.
     */
    fun sizeBytes(): Long {
        val files = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(EXT) } ?: return 0L
        var total = 0L
        for (f in files) total += f.length()
        return total
    }

    private fun fileFor(sourceHash: String): File =
        File(cacheDir, "$sourceHash$EXT")

    private fun evictIfFull() {
        val files = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(EXT) }
            ?: return
        if (files.size <= maxEntries) return
        // Oldest mtime first → drop until we're under the cap.
        val sorted = files.sortedBy { it.lastModified() }
        val toDrop = files.size - maxEntries
        for (i in 0 until toDrop) sorted[i].delete()
    }

    /** D18j — list available recipe / cache entry keys (filenames
     *  without the .bin extension), oldest-mtime first. */
    fun list(): List<String> {
        val files = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(EXT) }
            ?: return emptyList()
        return files.sortedBy { it.lastModified() }
            .map { it.nameWithoutExtension }
    }

    /** D18j — delete a recipe by name. No-op if it doesn't exist. */
    fun delete(name: String): Boolean {
        return fileFor(name).delete()
    }

    companion object {
        private const val TAG = "OrcaXR/paintcache"
        private const val DIR_NAME = "paint_cache"
        private const val EXT = ".bin"
        // 'O' 'X' 'P' 'C' as a big-endian int.
        private const val MAGIC = 0x4F58_5043
        private const val VERSION_V1 = 1
        private const val VERSION = 2  // adds fuzzySkinFlags
        private const val HEADER_BYTES_V1 = 24  // 6 ints — pre-fuzzy entries
        // Sanity cap — refuse to allocate more than 16 MB per array.
        // Even a 5M-tri mesh's paint array is 5 MB, well within.
        private const val MAX_ARRAY_BYTES = 16 * 1024 * 1024
        // Roadmap D1 cap. ~50 entries × ~1.5 MB ≈ 75 MB on filesDir,
        // matches the order-of-magnitude budget called out in
        // ROADMAP.md without making it a hard guarantee. UserPreferences
        // can override this in a future surface.
        const val MAX_ENTRIES = 50

        /** True iff [arr] has at least one non-zero byte. Mirrors the
         *  helper of the same shape in MainActivity — duplicated here
         *  so the cache module has no implicit dep on it. */
        private fun hasAnyPaint(arr: ByteArray?): Boolean {
            if (arr == null || arr.isEmpty()) return false
            for (b in arr) if (b != 0.toByte()) return true
            return false
        }

        private fun byteArrayEq(a: ByteArray?, b: ByteArray?): Boolean {
            if (a === b) return true
            if (a == null || b == null) return false
            return a.contentEquals(b)
        }
    }
}
