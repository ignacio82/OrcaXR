package dev.orcaxr.core

/** Volume splits through the Kotlin wrapper: every preparation of the
 * browser's script round-trips and answers the browser's reply, each stage
 * under the host's IDs executes (or refuses) to the browser's outcome,
 * revision, hash and undo label, as do the edit and the undo and redo
 * between them; a disposed session prepares nothing. */
object ProjectVolumeSplitChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private val codes = mapOf("stale" to "stale", "invalid_request" to "invalidRequest", "resource_limit" to "resourceLimit")

    /** [script] holds one step per line: `P\t<split>\t<request>\t<reply>`,
     * `S\t<split>\t<stage>\t<outcome>\t<revision>\t<hash>\t<undo label>`,
     * `E\t<intent>\t<revision>\t<hash>\t<undo label>` or
     * `H\t<undo|redo>\t<revision>\t<hash>\t<undo label>`; an empty label is
     * absent. */
    @JvmStatic fun run(source: String, assets: List<ByteArray>, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 2_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == assets.size.toLong())
            for ((position, mesh) in assets.withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            var sequence = 0L
            fun submit(operation: ProjectIntents.SessionOperation): ProjectIntents.SessionResult {
                sequence++
                val request = ProjectIntents.encodeSessionRequest(ProjectIntents.SessionRequest(1, listOf(1, 2, 3, 4), sequence, operation))
                return (session.submit(request) ?: session.runNext())!!.use { reply ->
                    ProjectIntents.decodeSessionReply(reply.wire().also { reply.effects().close() }).result
                }
            }
            fun guard() = (submit(ProjectIntents.SessionOperation.Query(ProjectIntents.Empty)) as ProjectIntents.SessionResult.Acknowledged).value.guard
            check(submit(ProjectIntents.SessionOperation.Hello(ProjectIntents.Hello(1, 1, 1, 1))) is ProjectIntents.SessionResult.Welcome); checks++
            session.configureStaging(ProjectStagingPoolOptions(4, 16, 64_000_000, 16_000_000))
            val splits = mutableMapOf<String, ProjectVolumeSplit>()
            var first: ProjectIntents.VolumeSplitRequest? = null
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    val state = when (entry[0]) {
                        "P" -> {
                            val request = ProjectIntents.decodeVolumeSplitRequest(entry[2])
                            check(ProjectIntents.encodeVolumeSplitRequest(request) == entry[2]) { "split_request_$checks" }; checks++
                            val split = session.captureGuard().use { guard -> session.volumeSplit(guard, request) }
                            val reply = split.reply()
                            check(reply == ProjectIntents.decodeVolumeSplitReply(entry[3])) { "split_reply_$checks" }; checks++
                            // A refused preparation leaves the host's earlier split in place.
                            if (reply is ProjectIntents.VolumeSplitReply.Refused) split.close()
                            else {
                                splits.put(entry[1], split)?.close()
                                if (first == null) first = request
                            }
                            null
                        }
                        "S" -> {
                            val request = ProjectIntents.decodeVolumeSplitStage(entry[2])
                            check(ProjectIntents.encodeVolumeSplitStage(request) == entry[2]) { "split_stage_$checks" }; checks++
                            val outcome = try {
                                session.stageVolumeSplit(splits.getValue(entry[1]), request).use { input ->
                                    when (val result = submit(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(input.id)))) {
                                        is ProjectIntents.SessionResult.Acknowledged -> if (result.value.changed) "applied" else "unchanged"
                                        is ProjectIntents.SessionResult.Error -> result.value.name.replaceFirstChar { it.lowercase() }
                                        else -> error("split_execute_$checks: $result")
                                    }
                                }
                            } catch (refusal: IllegalStateException) {
                                codes[refusal.message] ?: throw refusal
                            }
                            check(outcome == entry[3]) { "split_outcome_$checks: $outcome" }; checks++
                            entry.drop(4)
                        }
                        "E" -> {
                            val intent = ProjectIntents.decodeIntent(entry[1])
                            check(submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(guard(), intent))) is ProjectIntents.SessionResult.Acknowledged) { "split_edit_$checks" }; checks++
                            entry.drop(2)
                        }
                        "H" -> {
                            val operation = if (entry[1] == "undo") ProjectIntents.SessionOperation.Undo(guard()) else ProjectIntents.SessionOperation.Redo(guard())
                            check(submit(operation) is ProjectIntents.SessionResult.Acknowledged) { "split_history_$checks" }; checks++
                            entry.drop(2)
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                    if (state != null) {
                        session.snapshot().use { snapshot ->
                            check(snapshot.revision() == state[0].toLong() && snapshot.hash() == state[1]) { "split_state_$checks" }
                        }
                        session.history().use { history ->
                            val label = if (history.hasLabel(true)) String(history.label(true, 0, history.labelLength(true))) else ""
                            check(label == state[2]) { "split_label_$checks" }
                        }
                        checks++
                    }
                }
            } finally {
                splits.values.forEach { it.close() }
            }
            val guard = session.captureGuard()
            guard.use {
                session.dispose()
                check(failure { session.volumeSplit(guard, first!!).close() } == "disposed"); checks++
            }
        }
        return checks
    }
}
