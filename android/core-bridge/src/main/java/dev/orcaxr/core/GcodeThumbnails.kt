package dev.orcaxr.core

import java.io.File
import java.io.OutputStream

/** One picture a sliced file carries: its size and format, the block that
 * carries it in the engine's wire format, and how many of its pixels show a model. */
class GcodeThumbnail(val width: Int, val height: Int, val format: String, val block: String, val coverage: Long)

/** An entry of a printer's `thumbnails` value that cannot be honoured, and why
 * (`invalid`, `out-of-range` or `unsupported-format`). */
data class ThumbnailProblem(val entry: String, val reason: String)

/**
 * A plate's pictures, drawn by the shared core (`orcaxr_archive::thumbnail`)
 * from the very capture its slice archive was written from, at the sizes its
 * printer's `thumbnails` value asks for — the browser's
 * `PlateThumbnailRenderer` and `parseThumbnailList` — and the entries it
 * could not honour. A plate that draws nothing has none, as the browser's has none.
 */
class PlateThumbnails(val thumbnails: List<GcodeThumbnail>, val problems: List<ThumbnailProblem>) {
    /** The blocks a slice's G-code takes, in the printer's order. */
    val blocks: List<String> get() = thumbnails.map { it.block }

    companion object {
        val NONE = PlateThumbnails(emptyList(), emptyList())
    }
}

/**
 * The pictures a slice's G-code carries, put where the browser puts them
 * (`injectGcodeThumbnails`, in the shared core as
 * `orcaxr_project::slicing::thumbnails`): after the engine's header block and
 * its blank line, at the top of a file without one, and nowhere in a file
 * that already carries a thumbnail.
 */
object GcodeThumbnails {
    private const val CHUNK = 1 shl 16

    /** The core's reply for a capture's pictures, read strictly. */
    internal fun read(json: String): PlateThumbnails = try {
        val answer = CanonicalJson.read(json) as? ProjectJsonObject ?: throw InvalidProjectIntent()
        if (answer.keys().asSequence().toSet() != setOf("problems", "thumbnails")) throw InvalidProjectIntent()
        val pictures = answer.get("thumbnails") as? ProjectJsonArray ?: throw InvalidProjectIntent()
        val problems = answer.get("problems") as? ProjectJsonArray ?: throw InvalidProjectIntent()
        PlateThumbnails(
            List(pictures.length()) { index ->
                val entry = pictures.get(index) as? ProjectJsonObject ?: throw InvalidProjectIntent()
                if (entry.keys().asSequence().toSet() != setOf("block", "coverage", "format", "height", "width")) throw InvalidProjectIntent()
                GcodeThumbnail(
                    ProjectIntentJson.integer(entry.get("width"), 1, 999).toInt(),
                    ProjectIntentJson.integer(entry.get("height"), 1, 999).toInt(),
                    (entry.get("format") as? String)?.takeIf { it == "PNG" || it == "JPG" } ?: throw InvalidProjectIntent(),
                    entry.get("block") as? String ?: throw InvalidProjectIntent(),
                    ProjectIntentJson.integer(entry.get("coverage"), 1, 999L * 999),
                )
            },
            List(problems.length()) { index ->
                val entry = problems.get(index) as? ProjectJsonObject ?: throw InvalidProjectIntent()
                ThumbnailProblem(entry.get("entry") as? String ?: throw InvalidProjectIntent(), entry.get("reason") as? String ?: throw InvalidProjectIntent())
            },
        )
    } catch (_: InvalidProjectIntent) {
        throw IllegalStateException("Invalid shared thumbnails")
    }

    /**
     * Where [blocks] go in [source]: the byte offset they are written before,
     * or null when the file stays as it is — found by the shared core as the
     * file streams through once.
     */
    fun anchor(source: File, blocks: Int): Long? {
        val handle = NativeGcode.anchorOpen()
        try {
            source.inputStream().use { input ->
                val buffer = ByteArray(CHUNK)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) NativeGcode.anchorPush(handle, buffer, count)
                }
            }
            return NativeGcode.anchorFinish(handle, blocks).takeIf { it >= 0 }
        } finally {
            NativeGcode.anchorClose(handle)
        }
    }

    /**
     * Writes [source] to [destination] with [blocks] where the engine puts
     * them, and answers whether they went in. Blocks are ASCII, so the file
     * stays the UTF-8 text it was.
     */
    fun embed(source: File, blocks: List<String>, destination: OutputStream): Boolean {
        val at = if (blocks.isEmpty()) null else anchor(source, blocks.size)
        source.inputStream().use { input ->
            val buffer = ByteArray(CHUNK)
            var copied = 0L
            if (at != null) {
                while (copied < at) {
                    val count = input.read(buffer, 0, minOf(buffer.size.toLong(), at - copied).toInt())
                    check(count > 0) { "The G-code changed while its thumbnails were added." }
                    destination.write(buffer, 0, count)
                    copied += count
                }
                for (block in blocks) destination.write(block.toByteArray(Charsets.US_ASCII))
            }
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                destination.write(buffer, 0, count)
            }
        }
        destination.flush()
        return at != null
    }
}
