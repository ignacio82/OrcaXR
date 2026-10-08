package dev.orcaxr.core

/** Brim-ear detection through the Kotlin wrapper: every detection and
 * stranded check of the browser's script round-trips and answers the
 * browser's reply; a disposed session detects nothing. */
object ProjectBrimEarChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one step per line: `D\t<detect request>\t<reply>` or
     * `S\t<stranded request>\t<reply>`. */
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
            var first: ProjectIntents.BrimEarDetectRequest? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "D" -> {
                        val request = ProjectIntents.decodeBrimEarDetectRequest(entry[1])
                        // Requests carry doubles, so the round trip compares values.
                        check(ProjectIntents.decodeBrimEarDetectRequest(ProjectIntents.encodeBrimEarDetectRequest(request)) == request) { "brim_detect_request_$checks" }; checks++
                        check(session.detectBrimEars(request) == ProjectIntents.decodeBrimEarDetectReply(entry[2])) { "brim_detect_$checks" }; checks++
                        if (first == null) first = request
                    }
                    "S" -> {
                        val request = ProjectIntents.decodeBrimEarStrandedRequest(entry[1])
                        check(ProjectIntents.encodeBrimEarStrandedRequest(request) == entry[1]) { "brim_stranded_request_$checks" }; checks++
                        check(session.strandedBrimEars(request) == ProjectIntents.decodeBrimEarStrandedReply(entry[2])) { "brim_stranded_$checks" }; checks++
                    }
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
            session.dispose()
            check(failure { session.detectBrimEars(first!!) } == "disposed"); checks++
        }
        return checks
    }
}
