package dev.orcaxr.core

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.OsConstants
import java.io.FileNotFoundException
import java.io.FilterOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** A Storage Access Framework document. The caller owns URI grants (including
 * persisted grants for recent files) and runs every call on an owned task, never
 * the UI thread. Providers may be remote, unsized or nonseekable; writes require
 * truncating mode, because a leftover tail would corrupt the ZIP directory. */
class ContentProjectDocument(private val resolver: ContentResolver, private val uri: Uri) : ProjectDocumentInput, ProjectDocumentOutput {
    override val reportedLength: Long?
        get() = try {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0).takeIf { it > 0 } else null
            }
        } catch (failure: SecurityException) {
            throw failure
        } catch (_: RuntimeException) {
            null // A provider without size metadata is staged open-ended.
        }

    override fun openInput(): InputStream = resolver.openInputStream(uri) ?: throw FileNotFoundException("document_unavailable")

    override fun openOutput(): OutputStream {
        val stream = try {
            resolver.openOutputStream(uri, "wt")
        } catch (failure: IllegalArgumentException) {
            throw ProjectDocumentException("document_not_writable", failure) // Truncation unsupported.
        } catch (failure: UnsupportedOperationException) {
            throw ProjectDocumentException("document_not_writable", failure)
        } ?: throw FileNotFoundException("document_unavailable")
        return StorageFull(stream)
    }

    /** Reports a full device distinctly so the host can offer another location. */
    private class StorageFull(output: OutputStream) : FilterOutputStream(output) {
        private fun <T> guard(operation: () -> T): T = try { operation() } catch (failure: IOException) {
            if (generateSequence<Throwable>(failure) { it.cause }.any { it is ErrnoException && it.errno == OsConstants.ENOSPC })
                throw ProjectDocumentException("document_storage_full", failure)
            throw failure
        }
        override fun write(value: Int) = guard { out.write(value) }
        override fun write(bytes: ByteArray, offset: Int, count: Int) = guard { out.write(bytes, offset, count) }
        override fun flush() = guard { out.flush() }
        override fun close() = guard { out.close() }
    }
}
