package dev.orcaxr.core

import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** A user document behind a platform provider. Nothing assumes a path, seek,
 * fsync or atomic replacement; Android wraps a document URI, tests use streams. */
interface ProjectDocumentInput {
    /** Provider-reported size, or null when unknown. Only a hint: it may be stale. */
    val reportedLength: Long?
    /** A fresh stream from the start of the document; may be requested again. */
    fun openInput(): InputStream
}

interface ProjectDocumentOutput {
    /** A truncating write from the start. A successful close is the provider's
     * acknowledgement of the complete document, not a physical-durability promise. */
    fun openOutput(): OutputStream
}

/** Redacted provider failure for host UI. Codes: document_permission (revoked or
 * missing grant), document_unavailable, document_not_writable,
 * document_storage_full, document_read_failed, document_write_failed. */
class ProjectDocumentException(val code: String, cause: Throwable? = null) : IllegalStateException(code, cause)

/** Archive Open/Save over document providers, for the actor's owned tasks. */
object ProjectDocuments {
    /** Producer body for [ProjectActor.openDocument] or resetDocument: read the
     * returned import's format and warnings, then return its document. A plausible
     * reported size is staged exactly (reserved up front); a stale size re-reads
     * the document open-ended under the policy's archive budget. Refusals keep the
     * archive codes; provider failures become [ProjectDocumentException]. */
    fun prepare(
        scope: ProjectPreparation,
        document: ProjectDocumentInput,
        options: ProjectArchiveOptions,
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
    ): ProjectArchiveImport {
        val reported = provider("document_read_failed") { document.reportedLength }?.takeIf { it in 1..options.archiveBytes }
        if (reported != null) {
            try {
                return stage(scope, document, reported, options, resolver, profile)
            } catch (failure: IllegalStateException) {
                if (failure.message != "incomplete_archive" && failure.message != "archive_length_mismatch") throw failure
            }
        }
        return stage(scope, document, null, options, resolver, profile)
    }

    private fun stage(scope: ProjectPreparation, document: ProjectDocumentInput, length: Long?, options: ProjectArchiveOptions,
        resolver: LocalTimestampResolver, profile: ProjectIntegerProfile): ProjectArchiveImport {
        val input = provider("document_read_failed") { document.openInput() }
        return input.use { ProjectArchiveUpload.prepare(scope, ReadFailures(it), length, options, resolver, profile) }
    }

    /** Callback body for [ProjectActor.saveDocument] (or exportDocument). The
     * package is built completely before the destination opens, so a refused Save
     * (unsavable project, budget, cancellation) never truncates the user's file.
     * Returns the Save warnings only after the provider accepted close; the actor
     * then acknowledges the checkpoint. A failure after the destination opened can
     * leave a partial document: the actor reports it as uncertain and the project
     * stays dirty. */
    fun save(source: ProjectExportSource, document: ProjectDocumentOutput, options: ProjectArchiveOptions): List<CharArray> {
        val output = DeferredOutput(document)
        val warnings = try {
            source.writeArchive(options, output)
        } catch (failure: Throwable) {
            output.abandon(failure)
            if (output.opened) throw written(failure) else throw failure
        }
        try { output.close() } catch (failure: Throwable) { throw written(failure) }
        return warnings
    }

    private fun <T> provider(code: String, operation: () -> T): T = try { operation() } catch (failure: Throwable) {
        throw mapped(failure, code)
    }
    private fun written(failure: Throwable) = mapped(failure, "document_write_failed")
    private fun mapped(failure: Throwable, code: String): Throwable = when (failure) {
        is ProjectDocumentException -> failure
        is SecurityException -> ProjectDocumentException("document_permission", failure)
        is FileNotFoundException -> ProjectDocumentException("document_unavailable", failure)
        is IOException -> ProjectDocumentException(code, failure)
        else -> failure
    }

    /** Provider read errors surface as one redacted code; archive refusals pass. */
    private class ReadFailures(private val input: InputStream) : InputStream() {
        private fun <T> guard(operation: () -> T): T = try { operation() } catch (failure: IOException) { throw mapped(failure, "document_read_failed") }
        override fun read(): Int = guard { input.read() }
        override fun read(bytes: ByteArray, offset: Int, count: Int): Int = guard { input.read(bytes, offset, count) }
    }

    /** Opens the provider on the first byte, after packaging has succeeded. */
    private class DeferredOutput(private val document: ProjectDocumentOutput) : OutputStream() {
        private var stream: OutputStream? = null
        val opened get() = stream != null
        private fun target(): OutputStream = stream ?: provider("document_write_failed") { document.openOutput() }.also { stream = it }
        override fun write(value: Int) = target().write(value)
        override fun write(bytes: ByteArray, offset: Int, count: Int) = target().write(bytes, offset, count)
        override fun flush() { stream?.flush() }
        override fun close() { stream?.let { it.flush(); it.close() } }
        fun abandon(failure: Throwable) {
            try { stream?.close() } catch (closing: Throwable) { failure.addSuppressed(closing) }
        }
    }
}
