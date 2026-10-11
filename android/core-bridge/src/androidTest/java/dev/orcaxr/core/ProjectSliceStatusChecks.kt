package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * What the status line says of a finished slice, through JNI and the Kotlin
 * owner, against the production browser's corpus (`slice-status-vectors.json`):
 * each artifact streamed through [SliceStatusTally] in several chunkings
 * (passed through unchanged, its figures exactly the browser's), and its line
 * worded by [SliceStatus.describe] exactly as `describeSliceStatus` words it.
 * Script lines: name, bytes (base64), size, KB, lines, layers, stated layers
 * (`-` when none), markers, elapsed ms, warnings, status text (base64).
 */
object ProjectSliceStatusChecks {
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val decoder = Base64.getDecoder()
        for (line in script.split('\n')) {
            val field = line.split('\t')
            check(field.size == 11, "script_shape")
            val name = field[0]
            val bytes = decoder.decode(field[1])
            val want = SliceFigures(
                field[2].toLong(), field[3], field[4].toLong(), field[5], field[6].takeIf { it != "-" }, field[7].toLong(),
            )
            val sizes = if (bytes.size <= 8192) listOf(bytes.size.coerceAtLeast(1), 1, 3, 4093) else listOf(bytes.size, 7, 65_536, 300_001)
            for (size in sizes) {
                val sink = ByteArrayOutputStream()
                val tally = SliceStatusTally(sink)
                val figures = tally.use {
                    var at = 0
                    while (at < bytes.size) {
                        val count = minOf(size, bytes.size - at)
                        if (count == 1) it.write(bytes[at].toInt()) else it.write(bytes, at, count)
                        at += count
                    }
                    it.figures()
                }
                check(figures == want, "figures $name in chunks of $size: $figures")
                check(sink.toByteArray().contentEquals(bytes), "passed_through $name")
                check(tally.figures() == want, "figures_kept_after_close $name")
            }
            val text = String(decoder.decode(field[10]), Charsets.UTF_8)
            check(SliceStatus.describe(field[8].toLong(), want, field[9].toInt()) == text, "status_text $name")
        }
        // A tally refuses work once closed, and the core admits only a few at once.
        val closed = SliceStatusTally().also { it.close() }
        val refused = try {
            closed.write(byteArrayOf(1), 0, 1)
            false
        } catch (_: IllegalStateException) {
            true
        }
        check(refused && closed.figures() == SliceFigures(0, "0", 1, "0", null, 0), "closed_tally")
        val open = List(8) { SliceStatusTally() }
        val limited = try {
            SliceStatusTally().close()
            false
        } catch (_: IllegalStateException) {
            true
        }
        open.forEach(SliceStatusTally::close)
        check(limited, "tallies_bounded")
        SliceStatusTally().close()
        check(true, "tally_admitted_after_release")
        return checks
    }
}
