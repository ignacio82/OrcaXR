package dev.orcaxr.core

/** Live preflight through the Kotlin wrapper: the browser's contract replies
 * decode and re-encode exactly, and host budgets and closed captures refuse. */
object ProjectPreflightChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun lines(group: String) = if (group.isEmpty()) emptyList() else group.split("\n")
    /** [expected] holds the summary, issues, omissions, printable instances and
     * used filaments, one JSON value per line, groups separated by `--`. */
    @JvmStatic fun run(source: String, mesh: ByteArray, request: String, expected: String): Long {
        val groups = expected.split("\n--\n")
        check(groups.size == 5)
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 1, 1_048_576, 1_048_576, 16, 1_048_576), LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 1L)
            upload.beginAsset(0); upload.appendAsset(0, mesh); upload.finishAsset()
            val session = scope.own(upload.open())
            val guard = scope.own(session.captureGuard())
            val capture = scope.own(session.captureExport(guard))
            val decoded = ProjectIntents.decodePreflightRequest(request)
            // Numbers are semantic on the wire (Kotlin writes 2 as 2.0), so the
            // request must survive its own round trip rather than match bytes.
            check(ProjectIntents.decodePreflightRequest(ProjectIntents.encodePreflightRequest(decoded)) == decoded); checks++
            val report = scope.own(capture.preflight(decoded))
            check(ProjectIntents.encodePreflightSummary(report.summary()) == groups[0]); checks++
            fun replies(group: String, read: (Long) -> String) {
                val all = lines(group)
                all.forEachIndexed { i, json -> check(read(i.toLong()) == json) { "preflight_reply_$i" }; checks++ }
                check(failure { read(all.size.toLong()) } == "invalid_range"); checks++
            }
            replies(groups[1]) { ProjectIntents.encodePreflightIssue(report.issue(it)) }
            replies(groups[2]) { ProjectIntents.encodePreflightOmission(report.omission(it)) }
            replies(groups[3]) { ProjectIntents.encodePreflightEntity(report.printableInstance(it)) }
            replies(groups[4]) { ProjectIntents.encodePreflightEntity(report.usedFilament(it)) }
            // A narrowed host budget refuses the run; it never becomes an issue.
            val tight = decoded.copy(budget = decoded.budget.copy(assets = 0))
            check(failure { capture.preflight(tight) } == "resource_limit"); checks++
            // The capture owns the run: once closed, nothing can start.
            capture.close()
            check(failure { capture.preflight(decoded) } == "closed"); checks++
        }
        return checks
    }
}
