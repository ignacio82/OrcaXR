package dev.orcaxr.core

/** Text embossing through the Kotlin wrapper: every cut of the browser's
 * script round-trips and answers the browser's reply, each cut's mesh hashes
 * to the browser's, each stage as a text part or re-cut executes (or
 * refuses) to the browser's outcome, revision, hash and undo label, as do
 * the undo and redo after them; a disposed session stages nothing. */
object ProjectEmbossChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun sha256(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private val codes = mapOf("stale" to "stale", "invalid_request" to "invalidRequest", "resource_limit" to "resourceLimit")

    /** [script] holds one step per line:
     * `P\t<cut>\t<request>\t<reply>\t<mesh SHA-256>\t<window SHA-256>`,
     * `S\t<cut>\t<stage>\t<outcome>\t<revision>\t<hash>\t<undo label>` or
     * `H\t<undo|redo>\t<revision>\t<hash>\t<undo label>`; an empty field
     * is absent. */
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
            val cuts = mutableMapOf<String, ProjectEmboss>()
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    val state = when (entry[0]) {
                        "P" -> {
                            val request = ProjectIntents.decodeEmbossRequest(entry[2])
                            // Requests carry doubles, so the round trip compares values.
                            check(ProjectIntents.decodeEmbossRequest(ProjectIntents.encodeEmbossRequest(request)) == request) { "emboss_request_$checks" }; checks++
                            val cut = ProjectEmboss.prepare(request)
                            val reply = cut.reply()
                            check(reply == ProjectIntents.decodeEmbossReply(entry[3])) { "emboss_reply_$checks" }; checks++
                            if (reply is ProjectIntents.EmbossReply.Prepared) {
                                val length = reply.value.byteLength
                                check(sha256(cut.mesh(0, length)) == entry[4] && (entry[5].isEmpty() || sha256(cut.mesh(16, 64)) == entry[5])) { "emboss_mesh_$checks" }
                                check(failure { cut.mesh(length, 1) } == "invalid_request") { "emboss_mesh_end_$checks" }
                                checks++
                            }
                            cuts.put(entry[1], cut)?.close()
                            null
                        }
                        "S" -> {
                            val request = ProjectIntents.decodeEmbossStage(entry[2])
                            // Stages carry a transform's doubles, so the round trip compares values.
                            check(ProjectIntents.decodeEmbossStage(ProjectIntents.encodeEmbossStage(request)) == request) { "emboss_stage_$checks" }; checks++
                            val outcome = try {
                                session.stageEmboss(cuts.getValue(entry[1]), request).use { input ->
                                    when (val result = submit(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(input.id)))) {
                                        is ProjectIntents.SessionResult.Acknowledged -> if (result.value.changed) "applied" else "unchanged"
                                        is ProjectIntents.SessionResult.Error -> result.value.name.replaceFirstChar { it.lowercase() }
                                        else -> error("emboss_execute_$checks: $result")
                                    }
                                }
                            } catch (refusal: IllegalStateException) {
                                codes[refusal.message] ?: throw refusal
                            }
                            check(outcome == entry[3]) { "emboss_outcome_$checks: $outcome" }; checks++
                            entry.drop(4)
                        }
                        "H" -> {
                            val operation = if (entry[1] == "undo") ProjectIntents.SessionOperation.Undo(guard()) else ProjectIntents.SessionOperation.Redo(guard())
                            check(submit(operation) is ProjectIntents.SessionResult.Acknowledged) { "emboss_history_$checks" }; checks++
                            entry.drop(2)
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                    if (state != null) {
                        session.snapshot().use { snapshot ->
                            check(snapshot.revision() == state[0].toLong() && snapshot.hash() == state[1]) { "emboss_state_$checks" }
                        }
                        session.history().use { history ->
                            val label = if (history.hasLabel(true)) String(history.label(true, 0, history.labelLength(true))) else ""
                            check(label == state[2]) { "emboss_label_$checks" }
                        }
                        checks++
                    }
                }
                session.dispose()
                check(failure { session.stageEmboss(cuts.values.first(), ProjectIntents.decodeEmbossStage("""{"edit":{"volumeId":[120],"assetId":[120]}}""")).close() } == "disposed"); checks++
            } finally {
                cuts.values.forEach { it.close() }
            }
        }
        return checks
    }
}
