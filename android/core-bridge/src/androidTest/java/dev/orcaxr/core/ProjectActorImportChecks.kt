package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** Model import through real JNI and the actor: provider staging, preview on a
 * preparation worker, acknowledgement-gated commit as one undoable entry, undo,
 * stale and closed candidates, unsupported sources, and foreign candidates. */
object ProjectActorImportChecks {
    private fun result(request: ProjectRequest) = request.completion.toCompletableFuture().get(30, TimeUnit.SECONDS)
    private fun completed(request: ProjectRequest) = result(request) as ProjectOutcome.Completed
    private fun state(value: ProjectOutcome.Completed) = (value.reply.result as ProjectIntents.SessionResult.Acknowledged).value
    private fun query(owner: ProjectActor) = completed(owner.submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)))
    private val resolver = LocalTimestampResolver { it }
    private const val IMPORTED_AT = "2026-10-07T12:00:00.000Z"

    private class Bytes(val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long? = null
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }
    private fun actor(source: String): ProjectActor = ProjectActor.open({ scope, nonce ->
        val bytes = source.toByteArray(Charsets.UTF_8)
        val input = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 16, 1 shl 20, 1 shl 20, 100, 33_554_432), resolver, ProjectIntegerProfile.CHROMIUM))
        input.appendDocument(0, bytes); input.sealDocument(); input.open(nonce)
    }, {}).also { check(completed(it.ready).reply.result is ProjectIntents.SessionResult.Welcome) }
    private fun prepare(owner: ProjectActor, bytes: ByteArray, filename: String, namespace: String): ProjectOutcome =
        result(owner.prepareImport(checkNotNull(query(owner).authority)) { scope, base ->
            check(Thread.currentThread().name == "orcaxr-prepare")
            val upload = ProjectDocuments.stageModel(scope, Bytes(bytes), ProjectModelImportOptions(), resolver, ProjectIntegerProfile.CHROMIUM)
            base.prepareModel(upload, filename, IMPORTED_AT, ProjectModelPlacement(220.0, 220.0, true), ProjectImportIds.Counter(namespace))
        })
    private fun required(preview: String): List<String> =
        Regex("\"requiredAcknowledgementIds\":\\[([^\\]]*)]").find(preview)!!.groupValues[1]
            .split(',').filter { it.isNotEmpty() }.map { it.trim('"') }
    private fun dirty(owner: ProjectActor) = state(query(owner)).history.dirtyCategories.isNotEmpty()

    @JvmStatic fun run(source: String, cube: ByteArray, lossy: ByteArray, step: ByteArray): Long {
        var checks = 0L
        actor(source).use { owner ->
            val before = state(query(owner)).guard.semanticHash
            // A lossless import needs no acknowledgement and commits as one entry.
            val prepared = prepare(owner, cube, "cube.stl", "kt-cube") as ProjectOutcome.ImportPrepared
            val candidate = prepared.candidate
            check(!candidate.blocked && required(candidate.preview).isEmpty() && candidate.preview.contains("\"filename\":\"cube.stl\""))
            check(!dirty(owner)) // Preparation never changes the project.
            val imported = result(owner.commitImport(candidate, emptyList())) as ProjectOutcome.Imported
            check(imported.projection == ProjectProjection.DELIVERED && imported.authority != null)
            val history = state(query(owner)).history
            check(history.undoCount == 1L && history.undoLabel.text == "Import cube.stl".map { it.code } && dirty(owner))
            // The committed candidate is consumed.
            check(result(owner.commitImport(candidate, emptyList())) == ProjectOutcome.NotStarted(ProjectRefusal.CANCELLED))
            checks++
            // Undo restores the base exactly.
            val guard = state(query(owner)).guard
            completed(owner.submit(ProjectIntents.SessionOperation.Undo(guard)))
            check(state(query(owner)).guard.semanticHash == before)
            checks++
            // A lossy import requires acknowledging every dropped field.
            val lossyPrepared = (prepare(owner, lossy, "lossy.obj", "kt-lossy") as ProjectOutcome.ImportPrepared).candidate
            val ids = required(lossyPrepared.preview)
            check(ids.isNotEmpty())
            check(result(owner.commitImport(lossyPrepared, emptyList())) == ProjectOutcome.NotStarted(ProjectRefusal.UNCONFIRMED))
            check(result(owner.commitImport(lossyPrepared, ids)) is ProjectOutcome.Imported)
            checks++
            // An edit after preparation makes the candidate stale; it stays usable.
            val stale = (prepare(owner, cube, "cube.stl", "kt-stale") as ProjectOutcome.ImportPrepared).candidate
            val add = ProjectIntents.Command.AddPlate(ProjectIntents.AddPlate("import:plate:kt-edit".map { it.code }, listOf(69), 5.0, false))
            completed(owner.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(state(query(owner)).guard, ProjectIntents.Intent(1, add)))))
            check(result(owner.commitImport(stale, emptyList())) == ProjectOutcome.NotStarted(ProjectRefusal.STALE))
            stale.close()
            check(result(owner.commitImport(stale, emptyList())) == ProjectOutcome.NotStarted(ProjectRefusal.CANCELLED))
            checks++
            // Unsupported sources refuse during preparation; the actor stays usable.
            check(prepare(owner, step, "part.step", "kt-step") == ProjectOutcome.NotStarted(ProjectRefusal.PREPARATION_FAILED))
            check(prepare(owner, ByteArray(0), "empty.stl", "kt-empty") == ProjectOutcome.NotStarted(ProjectRefusal.PREPARATION_FAILED))
            query(owner)
            checks++
            // A candidate belongs to the actor that prepared it.
            actor(source).use { other ->
                val foreign = (prepare(other, cube, "cube.stl", "kt-foreign") as ProjectOutcome.ImportPrepared).candidate
                foreign.use { check(result(owner.commitImport(it, emptyList())) == ProjectOutcome.NotStarted(ProjectRefusal.STALE)) }
            }
            checks++
            // Direct session use: a blocked or unacknowledged preview keeps the
            // candidate; the native refusal codes are stable.
            ProjectPreparation().use { scope ->
                val bytes = source.toByteArray(Charsets.UTF_8)
                val session = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 16, 1 shl 20, 1 shl 20, 100, 33_554_432), resolver, ProjectIntegerProfile.CHROMIUM).also { it.appendDocument(0, bytes); it.sealDocument() }.open())
                val base = scope.own(session.importBase())
                val upload = scope.own(ProjectModelUpload(lossy.size.toLong(), ProjectModelImportOptions(), resolver, ProjectIntegerProfile.CHROMIUM))
                upload.append(0, lossy)
                val preview = scope.own(base.prepareModel(upload, "lossy.obj", IMPORTED_AT))
                check(runCatching { upload.append(0, lossy) }.exceptionOrNull()?.message == "closed")
                check(runCatching { session.commitImport(preview, emptyList()) }.exceptionOrNull()?.message == "missing_acknowledgements")
                scope.own(session.commitImport(preview, required(preview.json())))
                check(runCatching { session.commitImport(preview, emptyList()) }.exceptionOrNull()?.message == "invalid_state")
                check(runCatching { ProjectModelUpload(10, ProjectModelImportOptions(maxBytes = 4), resolver, ProjectIntegerProfile.CHROMIUM) }.exceptionOrNull()?.message == "input_limit")
                check(runCatching { ProjectModelImportOptions(maxTriangles = 0).encode() }.exceptionOrNull() is IllegalArgumentException)
            }
            checks++
        }
        return checks
    }
}
