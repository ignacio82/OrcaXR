package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64

/**
 * File → Export Toolpaths as OBJ… over JNI: every case of the browser's
 * corpus (`toolpath-obj-vectors.json`, from `exportToolpathsToObj`) written by
 * [ToolpathObj] from its text and, but for a byte-order mark the file decoder
 * drops, from its UTF-8 bytes — the length and SHA-256 the browser's — then a
 * destination's own failure rethrown as it was thrown, and on the raw
 * exports a session closed while it streams and an unsealed one refused.
 */
object ToolpathObjChecks {
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun failure(block: () -> Unit): Throwable? = runCatching(block).exceptionOrNull()

    /** [script]: one case a line, its UTF-8 source in Base64, its file's length and SHA-256, tab-separated. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        var longest = CharArray(0)
        for (line in script.split("\n")) {
            val (encoded, length, digest) = line.split("\t")
            val bytes = Base64.getDecoder().decode(encoded)
            val units = String(bytes, Charsets.UTF_8).toCharArray()
            val text = ByteArrayOutputStream()
            check(ToolpathObj.write(units, text) == length.toLong()) { "length of $line" }
            check(text.size().toLong() == length.toLong() && sha256(text.toByteArray()) == digest) { "bytes of $line" }
            checks++
            if (units.isEmpty() || units[0] != '﻿') {
                val file = ByteArrayOutputStream()
                check(ToolpathObj.write(bytes, file) == length.toLong() && file.toByteArray().contentEquals(text.toByteArray()))
                checks++
            }
            if (units.size > longest.size) longest = units
        }
        // A destination that fails: its own exception, not the core's code.
        val full = IOException("no room")
        val failing = object : OutputStream() {
            override fun write(b: Int) = throw full
            override fun write(b: ByteArray, off: Int, len: Int) = throw full
        }
        check(failure { ToolpathObj.write(longest, failing) } === full); checks++
        // A session closed while it streams stops the export, cancelled; a closed one is gone.
        val handle = NativeGcode.open(GcodeLayout.VERSION, longest.size, "{}")
        try {
            var at = 0
            while (at < longest.size) {
                val count = minOf(GcodeLayout.MAX_CHUNK_UNITS, longest.size - at)
                NativeGcode.append(handle, at, longest.copyOfRange(at, at + count))
                at += count
            }
            NativeGcode.seal(handle)
            var chunks = 0
            val closing = ProjectJsonSink {
                chunks++
                NativeGcode.close(handle)
            }
            check(failure { NativeGcode.toolpathObj(handle, closing) }?.message == "cancelled" && chunks == 1); checks++
            check(failure { NativeGcode.toolpathObj(handle, closing) }?.message == "closed"); checks++
        } finally {
            NativeGcode.close(handle)
        }
        // Not sealed: nothing to export.
        val unsealed = NativeGcode.open(GcodeLayout.VERSION, 1, "{}")
        try {
            NativeGcode.append(unsealed, 0, charArrayOf('G'))
            check(failure { NativeGcode.toolpathObj(unsealed, ProjectJsonSink { }) }?.message == "invalid_state"); checks++
        } finally {
            NativeGcode.close(unsealed)
        }
        return checks
    }
}
