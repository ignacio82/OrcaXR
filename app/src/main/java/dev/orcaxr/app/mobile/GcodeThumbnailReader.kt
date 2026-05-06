package dev.orcaxr.app.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.io.File

/**
 * Extract the embedded preview thumbnail libslic3r writes into the
 * G-code header. The format (lifted from PrusaSlicer / OrcaSlicer) is:
 *
 * ```
 * ; thumbnail begin 300x300 12345
 * ; <base64 chunk 1>
 * ; <base64 chunk 2>
 * ; ...
 * ; thumbnail end
 * ```
 *
 * Width × height precedes a byte count; subsequent comment lines hold
 * the base64 of a PNG. We pick the largest available block (typically
 * the 300×300 PNG when the U1 / Centauri profiles request both 48×48
 * and 300×300) so the Preview screen renders a recognizable image.
 *
 * Cheap to call — only reads the first ~256 KB of the file (libslic3r
 * writes thumbnails in the header). Falls back to null if no
 * thumbnail block is present.
 */
internal object GcodeThumbnailReader {

    fun extractLargest(file: File): Bitmap? {
        val text = runCatching {
            file.inputStream().use { it.readNBytes(256 * 1024).toString(Charsets.US_ASCII) }
        }.getOrDefault("")
        if (text.isEmpty()) return null

        var best: Bitmap? = null
        var bestArea = 0
        var idx = 0
        while (true) {
            val begin = text.indexOf("; thumbnail begin ", idx)
            if (begin < 0) break
            val end = text.indexOf("; thumbnail end", begin)
            if (end < 0) break
            // Header line: `; thumbnail begin WxH bytes`
            val newlineAfterHeader = text.indexOf('\n', begin)
            if (newlineAfterHeader < 0 || newlineAfterHeader > end) {
                idx = end + 1
                continue
            }
            val header = text.substring(begin, newlineAfterHeader).trim()
            val body = text.substring(newlineAfterHeader + 1, end)
            val sizeRegex = Regex("(\\d+)x(\\d+)")
            val match = sizeRegex.find(header)
            val w = match?.groupValues?.get(1)?.toIntOrNull() ?: 0
            val h = match?.groupValues?.get(2)?.toIntOrNull() ?: 0
            val area = w * h

            // Concatenate body lines, stripping `;` prefix + whitespace.
            val sb = StringBuilder()
            for (rawLine in body.lineSequence()) {
                val l = rawLine.trim()
                if (l.startsWith(";")) sb.append(l.removePrefix(";").trim())
            }
            val pngBytes = runCatching { Base64.decode(sb.toString(), Base64.DEFAULT) }.getOrNull()
            if (pngBytes != null && pngBytes.size > 64) {
                val bmp = runCatching { BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.size) }.getOrNull()
                if (bmp != null && (best == null || area > bestArea)) {
                    best?.recycle()
                    best = bmp
                    bestArea = area
                }
            }
            idx = end + 1
        }
        return best
    }
}
