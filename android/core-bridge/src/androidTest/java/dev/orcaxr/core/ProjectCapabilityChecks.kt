package dev.orcaxr.core

/** Capabilities through the Kotlin wrapper: the browser's requests decode and
 * re-encode exactly, a live session answers each with the browser's page, an
 * oversized page refuses, and the answer follows the session's own selection. */
object ProjectCapabilityChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [expected] alternates request and reply lines for a freshly opened
     * session of [source], whose one asset is [mesh]. */
    @JvmStatic fun run(source: String, mesh: ByteArray, expected: String): Long {
        val lines = expected.split("\n")
        check(lines.size % 2 == 0 && lines.isNotEmpty())
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 1, 1_048_576, 1_048_576, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 1L)
            upload.beginAsset(0); upload.appendAsset(0, mesh); upload.finishAsset()
            val session = scope.own(upload.open())
            for (i in lines.indices step 2) {
                val request = ProjectIntents.decodeCapabilityRequest(lines[i])
                check(ProjectIntents.encodeCapabilityRequest(request) == lines[i]); checks++
                check(ProjectIntents.encodeCapabilityPage(session.capabilities(request)) == lines[i + 1]) { "capability_page_$i" }; checks++
            }
            val request = ProjectIntents.decodeCapabilityRequest(lines[0])
            val oversized = request.copy(query = ProjectIntents.CapabilityQuery.Page(ProjectIntents.SettingsTargetPageRequest(0, 65)))
            check(failure { session.capabilities(oversized) } == "invalid_request"); checks++

            // The session, not the host, decides the selection fact.
            val before = session.capabilities(request).facts
            check(!before.hasSelection); checks++
            val input = ProjectSelectionInput()
            input.add(ProjectHost.SELECT_PROJECT, charArrayOf())
            session.captureGuard().use { guard -> session.select(guard, input).close() }
            val after = session.capabilities(request).facts
            check(after == before.copy(hasSelection = true)); checks++
        }
        return checks
    }
}
