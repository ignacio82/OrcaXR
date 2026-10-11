package dev.orcaxr.core

import java.io.FilterOutputStream
import java.io.OutputStream

/**
 * What the browser's status line says of a finished slice (`SliceStatus.ts`),
 * computed by the shared core (`orcaxr_gcode::artifact::SliceTally`): the
 * artifact's size in whole KB as `toFixed(0)` rounds it, its lines
 * (`split('\n').length`) and its layers — the engine's own stated total, else
 * its layer-change markers — with numbers spelled as JavaScript spells them.
 */
data class SliceFigures(
    val bytes: Long,
    val kilobytes: String,
    val lines: Long,
    val layers: String,
    /** The total the artifact's trailer states, when it states one. */
    val statedLayers: String?,
    val layerMarkers: Long,
)

/** The browser's status line for a finished slice (`describeSliceStatus`). */
object SliceStatus {
    fun describe(elapsedMs: Long, figures: SliceFigures, warnings: Int): String {
        val suffix = if (warnings > 0) ", $warnings warning(s)" else ""
        return "SLICED in $elapsedMs ms\n${figures.kilobytes} KB, ${figures.lines} lines, ${figures.layers} layers$suffix"
    }

    private val LIMITS = ProjectIntentLimits(1024, 16, 2)
    private val DIGITS = Regex("[0-9]+|[0-9]+(\\.[0-9]+)?e\\+[0-9]+")

    /** The core's figures document, read strictly. */
    internal fun figures(json: String): SliceFigures = try {
        val obj = ProjectIntentJson.parse(json, LIMITS) as? ProjectJsonObject ?: throw InvalidProjectIntent()
        val keys = obj.keys().asSequence().toSet()
        val stated = "statedLayers" in keys
        if (keys != setOfNotNull("bytes", "kilobytes", "lines", "layers", "layerMarkers", if (stated) "statedLayers" else null)) {
            throw InvalidProjectIntent()
        }
        fun digits(key: String) = (obj.get(key) as? String)?.takeIf(DIGITS::matches) ?: throw InvalidProjectIntent()
        val max = 9007199254740991L
        SliceFigures(
            ProjectIntentJson.integer(obj.get("bytes"), 0, max),
            digits("kilobytes"),
            ProjectIntentJson.integer(obj.get("lines"), 1, max),
            digits("layers"),
            if (stated) digits("statedLayers") else null,
            ProjectIntentJson.integer(obj.get("layerMarkers"), 0, max),
        )
    } catch (_: InvalidProjectIntent) {
        throw IllegalStateException("Invalid shared slice figures")
    }
}

/**
 * Counts what a G-code artifact tells the status line as it passes through to
 * [out] (a download being written, or a file being verified) — in the shared
 * core, a chunk at a time, so a file of any size is never held. [figures]
 * reads them at any point; closing releases the core's tally (the figures it
 * had then stay readable).
 */
class SliceStatusTally(out: OutputStream? = null) : FilterOutputStream(out ?: Discard) {
    private val handle = NativeGcode.tallyOpen()
    private val buffer = ByteArray(CHUNK)
    private var used = 0
    private var closed: SliceFigures? = null
    private var released = false

    override fun write(b: Int) {
        check(!released) { "closed" }
        out.write(b)
        buffer[used++] = b.toByte()
        if (used == CHUNK) drain()
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        check(!released) { "closed" }
        out.write(b, off, len)
        var start = off
        while (start < off + len) {
            val count = minOf(CHUNK - used, off + len - start)
            System.arraycopy(b, start, buffer, used, count)
            used += count
            start += count
            if (used == CHUNK) drain()
        }
    }

    private fun drain() {
        check(!released) { "closed" }
        if (used > 0) NativeGcode.tallyPush(handle, buffer, used)
        used = 0
    }

    fun figures(): SliceFigures = closed ?: run {
        drain()
        SliceStatus.figures(NativeGcode.tallyFigures(handle))
    }

    override fun close() {
        if (released) return
        try {
            closed = figures()
            super.close()
        } finally {
            released = true
            NativeGcode.tallyClose(handle)
        }
    }

    private object Discard : OutputStream() {
        override fun write(b: Int) = Unit
        override fun write(b: ByteArray, off: Int, len: Int) = Unit
    }

    private companion object {
        const val CHUNK = 64 * 1024
    }
}
