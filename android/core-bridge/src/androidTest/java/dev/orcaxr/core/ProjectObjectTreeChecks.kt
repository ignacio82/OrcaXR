package dev.orcaxr.core

/** The Objects tree through the Kotlin wrapper: every request of the
 * browser's script round-trips and answers the browser's reply with the
 * platform folder, an oversized page is refused, a non-ASCII filter without a
 * folder is refused rather than guessed, a failing folder refuses without its
 * text, and a capture still answers after its session is disposed. */
object ProjectObjectTreeChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one request per line: `T\t<request>\t<reply>` or
     * `R\t<request>\t<refusal code>`. */
    @JvmStatic fun run(source: String, mesh: ByteArray, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 2_000_000, 1024, 128, 1, 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 1L) { "tree_asset_count" }
            check(upload.beginAsset(0) == mesh.size.toLong()) { "tree_asset_length" }
            upload.appendAsset(0, mesh)
            upload.finishAsset()
            val session = scope.own(upload.open(longArrayOf(1, 2, 3, 4)))
            val snapshot = scope.own(session.snapshot())
            var nonAscii: ProjectIntents.ObjectTreeRequest? = null
            var answered: Pair<ProjectIntents.ObjectTreeRequest, ProjectIntents.ObjectTreeReply>? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                val request = ProjectIntents.decodeObjectTreeRequest(entry[1])
                check(ProjectIntents.encodeObjectTreeRequest(request) == entry[1]) { "tree_request_$checks" }; checks++
                when (entry[0]) {
                    "T" -> {
                        val reply = ProjectIntents.decodeObjectTreeReply(entry[2])
                        check(snapshot.objectTree(request) == reply) { "tree_reply_$checks" }; checks++
                        if (answered == null) answered = request to reply
                        if (nonAscii == null && request.filterQuery.any { it > 127 }) nonAscii = request
                    }
                    "R" -> { check(failure { snapshot.objectTree(request) } == entry[2]) { "tree_refusal_$checks" }; checks++ }
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
            val filtered = checkNotNull(nonAscii) { "no non-ASCII filter in the script" }
            val unfolded = failure { snapshot.objectTree(filtered, folder = null) }
            check(unfolded == "non_ascii_search") { "tree_unfolded $unfolded" }; checks++
            val throwing = SearchFolding { throw IllegalStateException("PRIVATE folding detail") }
            val thrown = failure { snapshot.objectTree(filtered, throwing) }
            check(thrown == "folding_failed") { "tree_throwing $thrown" }; checks++
            session.dispose()
            // A capture is immutable: it answers after its session is disposed.
            val (first, reply) = checkNotNull(answered) { "no answered request in the script" }
            check(snapshot.objectTree(first) == reply) { "tree_after_dispose" }; checks++
        }
        return checks
    }
}
