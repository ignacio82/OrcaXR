package dev.orcaxr.core

/** Mesh simplification through the Kotlin wrapper: every run of the
 * browser's script round-trips and answers the browser's reply, each result's
 * mesh hashes to the browser's, each stage under the host's asset ID
 * executes (or refuses) to the browser's outcome, revision, hash and undo
 * label, as do the undo and redo after them; a disposed session decimates
 * nothing. */
object ProjectSimplifyChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun sha256(bytes: ByteArray) =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private val codes = mapOf("stale" to "stale", "invalid_request" to "invalidRequest", "resource_limit" to "resourceLimit")

    /** [script] holds one step per line:
     * `P\t<run>\t<request>\t<reply>\t<mesh SHA-256>\t<window SHA-256>`,
     * `S\t<run>\t<stage>\t<outcome>\t<revision>\t<hash>\t<undo label>` or
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
            val runs = mutableMapOf<String, ProjectVolumeSimplify>()
            var first: ProjectIntents.VolumeSimplifyRequest? = null
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    val state = when (entry[0]) {
                        "P" -> {
                            val request = ProjectIntents.decodeVolumeSimplifyRequest(entry[2])
                            // Requests carry doubles, so the round trip compares values.
                            check(ProjectIntents.decodeVolumeSimplifyRequest(ProjectIntents.encodeVolumeSimplifyRequest(request)) == request) { "simplify_request_$checks" }; checks++
                            val run = session.captureGuard().use { guard -> session.volumeSimplify(guard, request) }
                            val reply = run.reply()
                            check(reply == ProjectIntents.decodeVolumeSimplifyReply(entry[3])) { "simplify_reply_$checks" }; checks++
                            if (reply is ProjectIntents.VolumeSimplifyReply.Prepared) {
                                val length = reply.value.byteLength
                                check(sha256(run.mesh(0, length)) == entry[4] && (entry[5].isEmpty() || sha256(run.mesh(16, 64)) == entry[5])) { "simplify_mesh_$checks" }
                                check(failure { run.mesh(length, 1) } == "invalid_request") { "simplify_mesh_end_$checks" }
                                checks++
                            } else {
                                check(failure { run.mesh(0, 0) } == "invalid_request") { "simplify_no_mesh_$checks" }
                            }
                            runs.put(entry[1], run)?.close()
                            if (first == null) first = request
                            null
                        }
                        "S" -> {
                            val request = ProjectIntents.decodeVolumeSimplifyStage(entry[2])
                            check(ProjectIntents.encodeVolumeSimplifyStage(request) == entry[2]) { "simplify_stage_$checks" }; checks++
                            val outcome = try {
                                session.stageVolumeSimplify(runs.getValue(entry[1]), request).use { input ->
                                    when (val result = submit(ProjectIntents.SessionOperation.ExecuteStaged(ProjectIntents.StagedReference(input.id)))) {
                                        is ProjectIntents.SessionResult.Acknowledged -> if (result.value.changed) "applied" else "unchanged"
                                        is ProjectIntents.SessionResult.Error -> result.value.name.replaceFirstChar { it.lowercase() }
                                        else -> error("simplify_execute_$checks: $result")
                                    }
                                }
                            } catch (refusal: IllegalStateException) {
                                codes[refusal.message] ?: throw refusal
                            }
                            check(outcome == entry[3]) { "simplify_outcome_$checks: $outcome" }; checks++
                            entry.drop(4)
                        }
                        "H" -> {
                            val operation = if (entry[1] == "undo") ProjectIntents.SessionOperation.Undo(guard()) else ProjectIntents.SessionOperation.Redo(guard())
                            check(submit(operation) is ProjectIntents.SessionResult.Acknowledged) { "simplify_history_$checks" }; checks++
                            entry.drop(2)
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                    if (state != null) {
                        session.snapshot().use { snapshot ->
                            check(snapshot.revision() == state[0].toLong() && snapshot.hash() == state[1]) { "simplify_state_$checks" }
                        }
                        session.history().use { history ->
                            val label = if (history.hasLabel(true)) String(history.label(true, 0, history.labelLength(true))) else ""
                            check(label == state[2]) { "simplify_label_$checks" }
                        }
                        checks++
                    }
                }
            } finally {
                runs.values.forEach { it.close() }
            }
            val guard = session.captureGuard()
            guard.use {
                session.dispose()
                check(failure { session.volumeSimplify(guard, first!!).close() } == "disposed"); checks++
            }
        }
        return checks
    }
}
