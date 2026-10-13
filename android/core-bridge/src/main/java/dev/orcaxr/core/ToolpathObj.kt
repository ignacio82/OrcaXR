package dev.orcaxr.core

import java.io.OutputStream

/**
 * File → Export Toolpaths as OBJ… (`exportToolpathsToObj` in the browser's
 * `GcodeToolpath.ts`): a published G-code's extrusion paths as the browser's
 * Wavefront OBJ, byte for byte, written by the shared core. The source is
 * parsed as the browser parses it (no options) in a session of its own,
 * whose index is sealed but never read, and the file streams to the
 * destination in chunks of at most 64 KiB. Run it on a background executor.
 */
object ToolpathObj {
    /** The type the browser downloads it as. */
    const val MEDIA_TYPE = "model/obj"

    /** The OBJ of G-code file bytes [gcode], decoded as the browser decodes a file, written to [output]; its length. */
    fun write(gcode: ByteArray, output: OutputStream): Long = write(GcodeSession.decodeUtf8(gcode), output)

    /**
     * The OBJ of G-code text [units] (UTF-16, as the browser holds it),
     * written to [output]; its length. A failure of [output] is rethrown as
     * it was thrown; the core's own refusals are its codes.
     */
    fun write(units: CharArray, output: OutputStream): Long {
        val handle = NativeGcode.open(GcodeLayout.VERSION, units.size, "{}")
        try {
            var at = 0
            while (at < units.size) {
                val count = minOf(GcodeLayout.MAX_CHUNK_UNITS, units.size - at)
                NativeGcode.append(handle, at, units.copyOfRange(at, at + count))
                at += count
            }
            NativeGcode.seal(handle)
            var failure: Throwable? = null
            val sink = ProjectJsonSink { bytes ->
                try {
                    output.write(bytes)
                } catch (thrown: Throwable) {
                    failure = thrown
                    throw thrown
                }
            }
            return try {
                NativeGcode.toolpathObj(handle, sink)
            } catch (error: IllegalStateException) {
                throw failure ?: error
            }
        } finally {
            NativeGcode.close(handle)
        }
    }
}
