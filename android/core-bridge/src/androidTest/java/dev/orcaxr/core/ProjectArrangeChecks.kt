package dev.orcaxr.core

/** Arrangement and bed fill through the Kotlin wrapper: every request of the
 * browser's script round-trips and plans the browser's reply, and a disposed
 * session plans nothing. */
object ProjectArrangeChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one entry per line: `A\t<arrange request>\t<reply>` or
     * `F\t<bed-fill request>\t<reply>`. */
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
            var first: ProjectIntents.ArrangeRequest? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "A" -> {
                        val request = ProjectIntents.decodeArrangeRequest(entry[1])
                        if (first == null) first = request
                        // Requests carry doubles, so the round trip compares values.
                        check(ProjectIntents.decodeArrangeRequest(ProjectIntents.encodeArrangeRequest(request)) == request) { "arrange_request_$checks" }; checks++
                        check(session.planArrangement(request) == ProjectIntents.decodeArrangeReply(entry[2])) { "arrange_reply_$checks" }; checks++
                    }
                    "F" -> {
                        val request = ProjectIntents.decodeBedFillRequest(entry[1])
                        check(ProjectIntents.decodeBedFillRequest(ProjectIntents.encodeBedFillRequest(request)) == request) { "fill_request_$checks" }; checks++
                        check(session.planBedFill(request) == ProjectIntents.decodeBedFillReply(entry[2])) { "fill_reply_$checks" }; checks++
                    }
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
            session.dispose()
            check(failure { session.planArrangement(first!!) } == "disposed"); checks++
        }
        return checks
    }
}
