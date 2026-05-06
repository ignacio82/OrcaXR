package dev.orcaxr.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

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
 * mocks with stubs. The single entry point [resolveAll] maps an Intent
 * to a list of staged `File`s (or returns empty if the intent doesn't
 * carry a recognized payload).
 */
object SharedIntentHandler {

    /**
     * Extensions OrcaXR can actually load. Keep in sync with the file
     * picker's MIME filter and with [MainActivity.onFileSelected]'s
     * load dispatch (STL / 3MF / OBJ / AMF / STEP).
     */
    val ACCEPTED_EXTENSIONS: Set<String> = setOf("stl", "3mf", "obj", "amf", "step", "stp")

    /**
     * Run a full Intent → `List<File>` resolution. Returns an empty
     * list if the intent carries nothing we can ingest. Each result
     * file lives under `cacheDir/shared/` and is keyed by a
     * deterministic name so tapping the same MakerWorld URL twice
     * doesn't fan out to two cache entries.
     */
    fun resolveAll(ctx: Context, intent: Intent): List<File> {
        val uris = extractUris(intent)
        if (uris.isEmpty()) return emptyList()
        val sharedDir = File(ctx.cacheDir, "shared").apply { mkdirs() }
        val resolver = ctx.contentResolver
        return uris.mapNotNull { uri -> stageUri(resolver, uri, sharedDir) }
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
     * has no recognized extension, or (c) the input stream is empty.
     */
    fun stageUri(resolver: ContentResolver, uri: Uri, sharedDir: File): File? {
        val displayName = queryDisplayName(resolver, uri) ?: uri.lastPathSegment ?: return null
        val ext = displayName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        if (ext !in ACCEPTED_EXTENSIONS) return null

        val stream = try {
            resolver.openInputStream(uri) ?: return null
        } catch (_: Throwable) {
            return null
        }

        // Deterministic filename — `<sha256>.<ext>` — so the same
        // shared URI imported twice resolves to one cache entry. We
        // SHA the bytes as we copy, then rename the temp into place.
        val tmp = File(sharedDir, ".incoming-${System.nanoTime()}.$ext")
        val digest = MessageDigest.getInstance("SHA-256")
        var totalBytes = 0L
        try {
            tmp.outputStream().use { out ->
                stream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                        totalBytes += n
                    }
                }
            }
        } catch (_: Throwable) {
            tmp.delete()
            return null
        }

        if (totalBytes == 0L) {
            tmp.delete()
            return null
        }

        val sha = digest.digest().joinToString("") { "%02x".format(it) }.take(16)
        // Preserve the original basename so the user sees a recognizable
        // entry in the recents list — `MyDragon-<sha>.3mf` not just
        // `<sha>.3mf`. The sha guarantees uniqueness across distinct
        // sources that happen to share a basename.
        val safeBase = displayName.substringBeforeLast('.', missingDelimiterValue = displayName)
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .take(80)
        val final = File(sharedDir, "$safeBase-$sha.$ext")
        if (final.exists()) {
            tmp.delete()
            return final
        }
        if (!tmp.renameTo(final)) {
            // renameTo across filesystems can fail; copy explicitly.
            tmp.copyTo(final, overwrite = true)
            tmp.delete()
        }
        return final
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
        } catch (_: Throwable) {
            null
        }
    }

    /** Test seam — pure resolver wrapper exposing only what we need. */
    fun stageStream(stream: InputStream, displayName: String, sharedDir: File): File? {
        val ext = displayName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
        if (ext !in ACCEPTED_EXTENSIONS) return null
        val tmp = File(sharedDir, ".incoming-${System.nanoTime()}.$ext")
        val digest = MessageDigest.getInstance("SHA-256")
        var totalBytes = 0L
        tmp.outputStream().use { out ->
            stream.use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                    out.write(buf, 0, n)
                    totalBytes += n
                }
            }
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
