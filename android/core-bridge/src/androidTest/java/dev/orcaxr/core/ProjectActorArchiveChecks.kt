package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/** Archive Open/Save through real JNI and the actor: guarded adoption of a
 * privately completed import, Save from an immutable capture with checkpoint
 * acknowledgement, reopening the saved package, and redacted budget refusals. */
object ProjectActorArchiveChecks {
    private fun result(request: ProjectRequest) = request.completion.toCompletableFuture().get(30, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = result(request) as ProjectOutcome.Completed
    private fun state(value: ProjectOutcome.Completed) = (value.reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(owner: ProjectActor) = completed(owner.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)))
    private fun failure(work: () -> Unit) = runCatching(work).exceptionOrNull()?.message
    /** Browser-equivalent budgets: the safe-ZIP defaults and multi-million facets. */
    val browserEquivalent = ProjectArchiveOptions(1L shl 30, 4096, 512L shl 20, 2L shl 30, 16_000_000, 16_000_000,
        2_000_000, 64L shl 20, 256_000_000, 4096, 512L shl 20, 2L shl 30, 1_000_000)
    private val resolver = LocalTimestampResolver { it }
    private val limits = ProjectExportLimits(512L shl 20, 4096, 2L shl 30)
    private fun actor(source: String): ProjectActor = ProjectActor.open({ scope, nonce ->
        val bytes = source.toByteArray(Charsets.UTF_8)
        val input = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 16, 1 shl 20, 1 shl 20, 100, 33_554_432), resolver, ProjectIntegerProfile.CHROMIUM))
        input.appendDocument(0, bytes); input.sealDocument(); input.open(nonce)
    }, {}).also { check(completed(it.ready).reply.result is ProjectIntents.SessionResult.Welcome) }
    private fun prepare(scope: ProjectPreparation, bytes: ByteArray, options: ProjectArchiveOptions = browserEquivalent) =
        ProjectArchiveUpload.prepare(scope, ByteArrayInputStream(bytes), bytes.size.toLong(), options, resolver, ProjectIntegerProfile.CHROMIUM)

    @JvmStatic fun run(source: String, archive: ByteArray, warnings: Long): Long {
        var checks = 0L
        actor(source).use { owner ->
            // Open: staging and import run on the preparation worker; the actor's
            // own ticket adopts the document. Warnings and format are read first.
            var format: ProjectArchiveFormat? = null
            var texts = emptyList<CharArray>()
            val opened = result(owner.openDocument { scope ->
                check(Thread.currentThread().name == "orcaxr-prepare")
                val imported = prepare(scope, archive)
                format = imported.format(); texts = imported.warnings()
                check(texts.size.toLong() == imported.warningCount())
                imported.document().also { check(failure { imported.warningCount() } == "closed") }
            }) as ProjectOutcome.Opened
            check(format == ProjectArchiveFormat.FOREIGN && texts.size.toLong() == warnings && texts.all { it.isNotEmpty() })
            check(opened.history.dirtyCategories.isEmpty() && opened.projection == ProjectProjection.DELIVERED)
            checks++
            // Save: package the immutable capture, then acknowledge the checkpoint
            // only after the callback returned with every byte handed off.
            val output = ByteArrayOutputStream()
            var saveWarnings: List<CharArray>? = null
            val saved = result(owner.saveDocument(checkNotNull(opened.authority), limits) { _, source ->
                check(Thread.currentThread().name == "orcaxr-prepare")
                saveWarnings = source.writeArchive(browserEquivalent, output)
                check(failure { source.writeJson(ByteArrayOutputStream()) } == "already_written")
                check(failure { source.writeArchive(browserEquivalent, ByteArrayOutputStream()) } == "already_written")
            }) as ProjectOutcome.Exported
            val bytes = output.toByteArray()
            check(saved.checkpoint == ProjectCheckpoint.SAVED && saveWarnings != null)
            check(bytes.size > 4 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte())
            check(state(query(owner)).history.dirtyCategories.isEmpty())
            checks++
            // A bundle stream that already started cannot switch to a package.
            val mixed = result(owner.exportDocument(checkNotNull(query(owner).authority), limits) { _, source ->
                source.writeJson(ByteArrayOutputStream())
                check(failure { source.writeArchive(browserEquivalent, ByteArrayOutputStream()) } == "already_written")
                for (index in 0 until source.assetCount) source.writeAsset(index, ByteArrayOutputStream())
            }) as ProjectOutcome.Exported
            check(mixed.checkpoint == ProjectCheckpoint.NOT_REQUESTED)
            checks++
            // Reopen the saved package: Save writes the canonical envelope and the
            // project is the same document the host saved.
            val before = state(query(owner)).guard.semanticHash
            val reopened = result(owner.openDocument { scope ->
                val imported = prepare(scope, bytes)
                format = imported.format()
                imported.document()
            }) as ProjectOutcome.Opened
            check(format == ProjectArchiveFormat.CANONICAL && reopened.guard.semanticHash == before)
            checks++
            // Budget refusals are redacted and distinct from invalid input; the
            // live session is untouched and the actor stays usable.
            ProjectPreparation().use { scope ->
                check(failure { prepare(scope, archive, browserEquivalent.copy(triangles = 1)) } == "resource_limit")
                check(failure { prepare(scope, ByteArray(64) { 7 }) } == "invalid_archive")
                check(failure { prepare(scope, archive, browserEquivalent.copy(archiveBytes = archive.size - 1L)) } == "input_limit")
                check(failure { browserEquivalent.copy(entryBytes = browserEquivalent.totalBytes + 1).encode() } == "Invalid project archive options")
            }
            check(result(owner.openDocument { scope -> prepare(scope, archive, browserEquivalent.copy(records = 1)).document() }) ==
                ProjectOutcome.NotStarted(ProjectRefusal.PREPARATION_FAILED))
            check(state(query(owner)).guard.semanticHash == before)
            checks++
            // Chunk offsets are explicit; refused chunks are not consumed, and an
            // incomplete or trailing stream is refused before import.
            ProjectPreparation().use { scope ->
                val upload = scope.own(ProjectArchiveUpload(archive.size.toLong(), browserEquivalent, resolver, ProjectIntegerProfile.CHROMIUM))
                check(failure { upload.append(1, archive.copyOfRange(0, 1)) } == "invalid_archive_input")
                upload.append(0, archive.copyOfRange(0, 10))
                check(failure { upload.append(10, ByteArray(archive.size)) } == "invalid_archive_input")
                check(failure { upload.append(10, ByteArray(ProjectArchive.MAX_CHUNK_BYTES + 1)) } == "input_limit")
                check(failure { upload.prepare() } == "incomplete_archive")
                check(failure { upload.append(10, archive.copyOfRange(10, 11)) } == "closed")
                check(failure { ProjectArchiveUpload.prepare(scope, ByteArrayInputStream(archive + 0.toByte()), archive.size.toLong(), browserEquivalent, resolver, ProjectIntegerProfile.CHROMIUM) } == "archive_length_mismatch")
                check(failure { ProjectArchiveUpload.prepare(scope, ByteArrayInputStream(archive, 0, 10), archive.size.toLong(), browserEquivalent, resolver, ProjectIntegerProfile.CHROMIUM) } == "incomplete_archive")
            }
            checks++
            // Closing the import before adoption releases it; a closed upload
            // cannot be prepared.
            ProjectPreparation().use { scope ->
                val imported = prepare(scope, archive)
                imported.close()
                check(failure { imported.document() } == "closed")
                val upload = ProjectArchiveUpload(archive.size.toLong(), browserEquivalent, resolver, ProjectIntegerProfile.CHROMIUM)
                upload.close()
                check(failure { upload.prepare() } == "closed")
            }
            checks++
        }
        return checks
    }
}
