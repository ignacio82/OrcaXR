package dev.orcaxr.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.coroutineScope

/**
 * Roadmap B14 — turn an Android share / view Intent into a stable
 * cache file path that the existing [MainActivity.onFileSelected]
 * pipeline can ingest.
 *
 * Two flavors of intent land here in practice:
 *  - `ACTION_VIEW`  — a tap on a `.3mf` from a file manager / browser /
 *    Bambu Handy. URI is in `intent.data`.
 *  - `ACTION_SEND`  — an explicit "share to OrcaXR" from MakerWorld /
 *    Bambu Handy. URI is in `intent.extras[EXTRA_STREAM]`.
 *  - `ACTION_SEND_MULTIPLE` — same shape but `EXTRA_STREAM` is a
 *    `Parcelable[]` of URIs. We ingest each one in order; non-3D
 *    siblings (e.g. a thumbnail PNG) are dropped at the extension
 *    filter.
 *
 * Pure JVM (no Android private APIs) for unit-testability — every
 * Android-side dependency is taken via small interfaces that the test
 * mocks with stubs. The single Activity entry point [resolveAllBounded]
 * maps an Intent to a list of staged `File`s (or returns empty if the
 * intent doesn't carry a recognized payload), enforcing both
 * [MAX_FILE_SIZE_BYTES] and [STREAM_TIMEOUT_MS] per URI.
 */
object SharedIntentHandler {

    private const val TAG = "SharedIntentHandler"

    /**
     * Hard cap on a single staged file. Audit H1 (2026-05-07): a share
     * intent pointing at a multi-GB file otherwise streams into the
     * disk cache unchecked, trivial DoS via Android's share sheet. The
     * cap is enforced inside the read loop and the temp file is
     * deleted on overrun, so a 5 GB share never produces a 5 GB cache
     * artifact.
     */
    const val MAX_FILE_SIZE_BYTES: Long = 500L * 1024L * 1024L

    /**
     * Per-URI deadline for [resolveAllBounded]. A pathological
     * `content://` provider whose `read()` blocks forever otherwise
     * pins the importer indefinitely. The watchdog closes the stream
     * on expiry so the read loop's catch returns null.
     */
    const val STREAM_TIMEOUT_MS: Long = 30_000L

    /**
     * Extensions OrcaXR can actually load. Keep in sync with the file
     * picker's MIME filter and with [MainActivity.onFileSelected]'s
     * load dispatch (STL / 3MF / OBJ / AMF / STEP).
     */
    val ACCEPTED_EXTENSIONS: Set<String> = setOf("stl", "3mf", "obj", "amf", "step", "stp")

    /**
     * Synchronous Intent → list-of-staged-files resolution. Enforces
     * the size cap but NOT the timeout — callers should prefer
     * [resolveAllBounded] which adds a per-URI watchdog so a
     * misbehaving content provider can't hang the importer.
     */
    fun resolveAll(ctx: Context, intent: Intent): List<File> {
        val uris = extractUris(intent)
        if (uris.isEmpty()) return emptyList()
        val sharedDir = File(ctx.cacheDir, "shared").apply { mkdirs() }
        val resolver = ctx.contentResolver
        return uris.mapNotNull { uri -> stageUri(resolver, uri, sharedDir) }
    }

    /**
     * Activity-side entry point. Wraps each URI in a
     * [withTimeoutOrNull] plus a watchdog that closes the input
     * stream on timeout, so a blocking `read()` is forced to throw
     * instead of hanging the coroutine.
     */
    suspend fun resolveAllBounded(
        ctx: Context,
        intent: Intent,
        timeoutMs: Long = STREAM_TIMEOUT_MS,
    ): List<File> = withContext(Dispatchers.IO) {
        val uris = extractUris(intent)
        if (uris.isEmpty()) return@withContext emptyList<File>()
        val sharedDir = File(ctx.cacheDir, "shared").apply { mkdirs() }
        val resolver = ctx.contentResolver
        uris.mapNotNull { uri -> stageUriBounded(resolver, uri, sharedDir, timeoutMs) }
    }

    /** Pull a list of URIs out of every action shape we care about. */
    fun extractUris(intent: Intent): List<Uri> {
        return when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val u = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                listOfNotNull(u)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val list = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                list?.toList().orEmpty()
            }
            else -> emptyList()
        }
    }

    /**
     * Copy the bytes behind [uri] to a stable cache-file path. Returns
     * null when (a) we can't open the URI, (b) the resolved filename
     * has no recognized extension, (c) the input stream is empty, or
     * (d) the payload exceeds [MAX_FILE_SIZE_BYTES].
     */
    fun stageUri(resolver: ContentResolver, uri: Uri, sharedDir: File): File? {
        val displayName = queryDisplayName(resolver, uri) ?: uri.lastPathSegment ?: return null
        val ext = displayName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        if (ext !in ACCEPTED_EXTENSIONS) return null

        val stream = try {
            resolver.openInputStream(uri) ?: return null
        } catch (t: Throwable) {
            Log.w(TAG, "openInputStream failed for $uri: ${t.javaClass.simpleName}: ${t.message}")
            return null
        }
        return stageStream(stream, displayName, sharedDir)
    }

    /**
     * Suspend variant of [stageUri] with a watchdog that closes the
     * input stream after [timeoutMs]. The read loop's catch then
     * returns null instead of hanging on a misbehaving provider.
     */
    suspend fun stageUriBounded(
        resolver: ContentResolver,
        uri: Uri,
        sharedDir: File,
        timeoutMs: Long = STREAM_TIMEOUT_MS,
    ): File? = withContext(Dispatchers.IO) {
        val displayName = queryDisplayName(resolver, uri) ?: uri.lastPathSegment
            ?: return@withContext null
        val ext = displayName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        if (ext !in ACCEPTED_EXTENSIONS) return@withContext null

        val stream = try {
            resolver.openInputStream(uri) ?: return@withContext null
        } catch (t: Throwable) {
            Log.w(TAG, "openInputStream failed for $uri: ${t.javaClass.simpleName}: ${t.message}")
            return@withContext null
        }

        coroutineScope {
            val watchdog = launch {
                delay(timeoutMs)
                runCatching { stream.close() }
                    .onSuccess { Log.w(TAG, "stream-read timeout (${timeoutMs}ms) for $uri — stream closed") }
            }
            try {
                withTimeoutOrNull(timeoutMs + 1_000L) {
                    stageStream(stream, displayName, sharedDir)
                }
            } finally {
                watchdog.cancel()
            }
        }
    }

    /**
     * Best-effort filename pull. `OpenableColumns.DISPLAY_NAME` works
     * for most `content://` URIs; some senders skip it and we fall
     * back to the URI's last path segment. Pure for the test stub.
     */
    fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? {
        // file:// URIs carry the basename in lastPathSegment directly.
        if (uri.scheme == "file") return uri.lastPathSegment
        return try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { c ->
                    if (!c.moveToFirst()) return@use null
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx < 0) null else c.getString(idx)
                }
        } catch (t: Throwable) {
            Log.w(TAG, "queryDisplayName failed for $uri: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
    }

    /**
     * Workhorse — copies bytes from [stream] into `sharedDir/<base>-<sha>.<ext>`,
     * enforcing [MAX_FILE_SIZE_BYTES] mid-stream and dropping the temp
     * file on overrun / IO failure / empty payload. Pure for tests.
     */
    fun stageStream(stream: InputStream, displayName: String, sharedDir: File): File? {
        val ext = displayName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        if (ext !in ACCEPTED_EXTENSIONS) return null
        val tmp = File(sharedDir, ".incoming-${System.nanoTime()}.$ext")
        val digest = MessageDigest.getInstance("SHA-256")
        var totalBytes = 0L
        var overflow = false
        try {
            tmp.outputStream().use { out ->
                stream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        if (totalBytes + n > MAX_FILE_SIZE_BYTES) {
                            overflow = true
                            break
                        }
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                        totalBytes += n
                    }
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "stream-read failed for $displayName after ${totalBytes}B: ${t.javaClass.simpleName}: ${t.message}")
            tmp.delete()
            return null
        }
        if (overflow) {
            Log.w(TAG, "rejecting $displayName — exceeds MAX_FILE_SIZE_BYTES (${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB)")
            tmp.delete()
            return null
        }
        if (totalBytes == 0L) {
            tmp.delete(); return null
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }.take(16)
        val safeBase = displayName.substringBeforeLast('.', missingDelimiterValue = displayName)
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .take(80)
        val final = File(sharedDir, "$safeBase-$sha.$ext")
        if (final.exists()) {
            tmp.delete(); return final
        }
        if (!tmp.renameTo(final)) {
            tmp.copyTo(final, overwrite = true); tmp.delete()
        }
        return final
    }
}
