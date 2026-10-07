package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/** Document-provider Open/Save through real JNI and the actor, with provider
 * behavior simulated by plain streams: stale and missing sizes, revoked grants,
 * read/write/close failures and deferred truncation. */
object ProjectDocumentChecks {
    private fun result(request: ProjectRequest) = request.completion.toCompletableFuture().get(30, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = result(request) as ProjectOutcome.Completed
    private fun state(value: ProjectOutcome.Completed) = (value.reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(owner: ProjectActor) = completed(owner.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)))
    private val options = ProjectActorArchiveChecks.browserEquivalent
    private val resolver = LocalTimestampResolver { it }
    private val limits = ProjectExportLimits(512L shl 20, 4096, 2L shl 30)

    /** In-memory provider; counts opens and can fail at chosen points. */
    private class Document(
        var bytes: ByteArray,
        override val reportedLength: Long?,
        val failOpen: Throwable? = null,
        val failReadAfter: Int = -1,
        val failWriteAfter: Int = -1,
        val failClose: Boolean = false,
    ) : ProjectDocumentInput, ProjectDocumentOutput {
        var inputs = 0
        var outputs = 0
        var closed = 0
        override fun openInput(): InputStream {
            inputs++
            failOpen?.let { throw it }
            if (failReadAfter < 0) return ByteArrayInputStream(bytes)
            return object : InputStream() {
                var position = 0
                override fun read(): Int = if (position >= failReadAfter) throw IOException("PRIVATE provider read") else bytes[position++].toInt() and 0xff
            }
        }
        override fun openOutput(): OutputStream {
            failOpen?.let { throw it }
            outputs++
            bytes = ByteArray(0) // Truncating open.
            val sink = ByteArrayOutputStream()
            return object : OutputStream() {
                override fun write(value: Int) = write(byteArrayOf(value.toByte()), 0, 1)
                override fun write(data: ByteArray, offset: Int, count: Int) {
                    if (failWriteAfter >= 0 && sink.size() + count > failWriteAfter) throw IOException("PRIVATE provider write")
                    sink.write(data, offset, count); bytes = sink.toByteArray()
                }
                override fun close() { closed++; if (failClose) throw IOException("PRIVATE provider close") }
            }
        }
    }
    private fun failure(work: () -> Unit) = runCatching(work).exceptionOrNull()?.message
    private fun open(document: ProjectDocumentInput, limit: ProjectArchiveOptions = options): Pair<ProjectArchiveFormat, Long> =
        ProjectPreparation().use { scope ->
            val imported = ProjectDocuments.prepare(scope, document, limit, resolver, ProjectIntegerProfile.CHROMIUM)
            imported.format() to imported.warningCount()
        }

    @JvmStatic fun run(source: String, archive: ByteArray, warnings: Long): Long {
        var checks = 0L
        // Exact, unknown, zero, stale-high, stale-low and over-budget sizes all
        // open identically; only a stale size costs a second read.
        for ((reported, reads) in listOf(archive.size.toLong() to 1, null to 1, 0L to 1, archive.size + 100L to 2, archive.size - 100L to 2, Long.MAX_VALUE to 1)) {
            val document = Document(archive, reported)
            check(open(document) == (ProjectArchiveFormat.FOREIGN to warnings)) { "open_$reported" }
            check(document.inputs == reads) { "reads_$reported" }
        }
        checks++
        // Open-ended staging refuses beyond the archive budget; malformed bytes
        // keep their archive code.
        check(failure { open(Document(archive, null), options.copy(archiveBytes = archive.size - 1L)) } == "input_limit")
        check(failure { open(Document(ByteArray(100) { 1 }, 100)) } == "invalid_archive")
        checks++
        // Provider failures are redacted to stable codes.
        check(failure { open(Document(archive, null, failOpen = SecurityException("PRIVATE grant"))) } == "document_permission")
        check(failure { open(Document(archive, null, failOpen = FileNotFoundException("PRIVATE path"))) } == "document_unavailable")
        check(failure { open(Document(archive, null, failReadAfter = 100)) } == "document_read_failed")
        checks++
        ProjectActor.open({ scope, nonce ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val input = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 16, 1 shl 20, 1 shl 20, 100, 33_554_432), resolver, ProjectIntegerProfile.CHROMIUM))
            input.appendDocument(0, bytes); input.sealDocument(); input.open(nonce)
        }, {}).use { owner ->
            completed(owner.ready)
            // Actor Open through the provider adapter, then an edit makes it dirty.
            var format: ProjectArchiveFormat? = null
            val opened = result(owner.openDocument { scope ->
                ProjectDocuments.prepare(scope, Document(archive, null), options, resolver, ProjectIntegerProfile.CHROMIUM).let { format = it.format(); it.document() }
            }) as ProjectOutcome.Opened
            check(format == ProjectArchiveFormat.FOREIGN && opened.history.dirtyCategories.isEmpty())
            fun edit(id: String) {
                val before = query(owner)
                val add = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate(id.map { it.code }, listOf(78), 9.0, false))
                val reply = completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(before).guard, ProjectIntents.Intent(1, add)))))
                check((reply.reply.result as ProjectIntents.SessionResult.Acknowledged).value.changed)
            }
            fun dirty() = state(query(owner)).history.dirtyCategories.isNotEmpty()
            fun save(document: Document, limit: ProjectArchiveOptions = options): Pair<ProjectOutcome, String?> {
                var error: String? = null
                val outcome = result(owner.saveDocument(checkNotNull(query(owner).authority), limits) { _, source ->
                    try { ProjectDocuments.save(source, document, limit) } catch (failure: Throwable) { error = failure.message; throw failure }
                })
                return outcome to error
            }
            edit("import:plate:document-edit")
            check(dirty())
            checks++
            // A refused package never opens (truncates) the destination.
            val original = byteArrayOf(1, 2, 3)
            val refused = Document(original, 3)
            val (budget, budgetError) = save(refused, options.copy(records = 1))
            check(budget == ProjectOutcome.Uncertain && budgetError == "resource_limit" && refused.outputs == 0 && refused.bytes.contentEquals(original))
            check(dirty())
            // Write, close and grant failures are uncertain and keep the project dirty.
            for ((document, code) in listOf(
                Document(original, 3, failWriteAfter = 1000) to "document_write_failed",
                Document(original, 3, failClose = true) to "document_write_failed",
                Document(original, 3, failOpen = SecurityException("PRIVATE grant")) to "document_permission",
            )) {
                val (outcome, error) = save(document)
                check(outcome == ProjectOutcome.Uncertain && error == code) { "save_$code" }
                check(document.closed == document.outputs) { "closed_$code" }
                check(dirty())
            }
            checks++
            // A successful handoff acknowledges the checkpoint; the saved document
            // reopens as the canonical envelope with the edit.
            val target = Document(original, 3)
            val (saved, error) = save(target)
            check(error == null && (saved as ProjectOutcome.Exported).checkpoint == ProjectCheckpoint.SAVED)
            check(target.outputs == 1 && target.closed == 1 && !dirty())
            val hash = state(query(owner)).guard.semanticHash
            val reopened = result(owner.openDocument { scope ->
                ProjectDocuments.prepare(scope, Document(target.bytes, target.bytes.size.toLong()), options, resolver, ProjectIntegerProfile.CHROMIUM).let { format = it.format(); it.document() }
            }) as ProjectOutcome.Opened
            check(format == ProjectArchiveFormat.CANONICAL && reopened.guard.semanticHash == hash)
            checks++
        }
        return checks
    }
}
