package dev.orcaxr.core

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.MessageDigest

/**
 * A sliced G-code file as a send's artifact, as the browser's shell hands its
 * workflow one (`OrcaWorkspace.sendToPrinter`): the bytes' SHA-256 identity and
 * the tools they select and declare — the shared [ToolUsageScanner], the
 * browser's `summarizeGcodeToolUsage` — read once while the file is held open.
 * The upload reads that same open file, never the path again, so a file a new
 * slice deletes or replaces meanwhile cannot change what is sent; nothing is
 * held in memory. Closing the artifact lets the file go.
 */
object PrintJobArtifacts {
    fun open(file: File, filename: String, plateName: String, isCurrent: () -> Boolean): PrintJobArtifact {
        val channel = FileInputStream(file).channel
        try {
            val length = channel.size()
            val digest = MessageDigest.getInstance("SHA-256")
            val usage = ToolUsageScanner().use { scanner ->
                val buffer = ByteArray(ProjectHost.MAX_CHUNK_BYTES)
                var at = 0L
                while (at < length) {
                    val read = channel.read(ByteBuffer.wrap(buffer, 0, minOf(buffer.size.toLong(), length - at).toInt()), at)
                    if (read < 0) throw IOException("The sliced G-code changed while it was read.")
                    digest.update(buffer, 0, read)
                    scanner.append(if (read == buffer.size) buffer else buffer.copyOf(read))
                    at += read
                }
                scanner.finish()
            }
            val hash = "sha256:" + digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            return PrintJobArtifact(filename, length, { HeldFile(channel, length) }, plateName, usage, hash, isCurrent, channel::close)
        } catch (failure: Throwable) {
            channel.close()
            throw failure
        }
    }

    /** The held file's first [length] bytes, read by position, so no other reader moves it. */
    private class HeldFile(private val channel: FileChannel, private val length: Long) : InputStream() {
        private var at = 0L

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
            if (count == 0) return 0
            if (at >= length) return -1
            // A file cut short ends early, and the upload refuses its length.
            val read = channel.read(ByteBuffer.wrap(bytes, offset, minOf(count.toLong(), length - at).toInt()), at)
            if (read > 0) at += read
            return read
        }
    }
}
