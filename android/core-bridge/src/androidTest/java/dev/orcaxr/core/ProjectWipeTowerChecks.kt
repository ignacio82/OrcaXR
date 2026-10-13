package dev.orcaxr.core

/** Wipe-tower auto-placement through the Kotlin wrapper: every request of the
 * browser's script round-trips and plans the browser's reply, every plate's
 * ghost is the box the browser's workspace draws, and a disposed session
 * plans and draws nothing. */
object ProjectWipeTowerChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one `<request>\t<reply>` per line, a ghost's as `G\t<request>\t<reply>`. */
    @JvmStatic fun run(source: String, assets: List<ByteArray>, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == assets.size.toLong())
            for ((position, mesh) in assets.withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open())
            var first: ProjectIntents.WipeTowerRequest? = null
            var ghost: ProjectIntents.WipeTowerGhostRequest? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                if (entry[0] == "G") {
                    val request = ProjectIntents.decodeWipeTowerGhostRequest(entry[1])
                    if (ghost == null) ghost = request
                    check(ProjectIntents.decodeWipeTowerGhostRequest(ProjectIntents.encodeWipeTowerGhostRequest(request)) == request) { "ghost_request_$checks" }; checks++
                    check(session.wipeTowerGhost(request) == ProjectIntents.decodeWipeTowerGhostReply(entry[2])) { "ghost_reply_$checks" }; checks++
                    continue
                }
                val request = ProjectIntents.decodeWipeTowerRequest(entry[0])
                if (first == null) first = request
                // Requests carry doubles, so the round trip compares values.
                check(ProjectIntents.decodeWipeTowerRequest(ProjectIntents.encodeWipeTowerRequest(request)) == request) { "wipe_tower_request_$checks" }; checks++
                check(session.planWipeTower(request) == ProjectIntents.decodeWipeTowerReply(entry[1])) { "wipe_tower_reply_$checks" }; checks++
            }
            session.dispose()
            check(failure { session.planWipeTower(first!!) } == "disposed"); checks++
            check(failure { session.wipeTowerGhost(ghost!!) } == "disposed"); checks++
        }
        return checks
    }
}
