package dev.orcaxr.core

/** Render deltas through the Kotlin wrapper: a host follows the browser's
 * script — acknowledged edits, then pages of changes from what it shows —
 * every request re-encodes exactly, every page decodes to the browser's, and
 * every refusal carries the browser's code; a disposed session refuses. */
object ProjectRenderChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one entry per line: `R\t<session request>`,
     * `P\t<render request>\t<page>` or `X\t<render request>\t<refusal code>`,
     * for a freshly opened session of [source], whose one asset is [mesh]. */
    @JvmStatic fun run(source: String, mesh: ByteArray, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 1, 1_048_576, 1_048_576, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.CHROMIUM))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 1L)
            upload.beginAsset(0); upload.appendAsset(0, mesh); upload.finishAsset()
            // The script's requests carry the browser session's generation.
            val first = script.substringBefore("\n").split("\t")
            check(first[0] == "R")
            val session = scope.own(upload.open(ProjectIntents.decodeSessionRequest(first[1]).generation.toLongArray()))
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "R" -> {
                        (session.submit(entry[1]) ?: session.runNext())!!.use { reply ->
                            val wire = reply.wire()
                            check(wire.contains("\"welcome\"") || wire.contains("\"acknowledged\"")) { "render_request_$checks: ${wire.take(300)}" }
                            reply.effects().close()
                        }
                        checks++
                    }
                    "P" -> {
                        val request = ProjectIntents.decodeRenderRequest(entry[1])
                        check(ProjectIntents.encodeRenderRequest(request) == entry[1]); checks++
                        val page = session.render(request)
                        check(page.changes.size <= 64)
                        // Values, not text: Kotlin writes doubles its own way.
                        check(page == ProjectIntents.decodeRenderPage(entry[2])) { "render_page_$checks: ${ProjectIntents.encodeRenderPage(page).take(600)}" }; checks++
                    }
                    "X" -> {
                        check(failure { session.render(ProjectIntents.decodeRenderRequest(entry[1])) } == entry[2]) { "render_refusal_$checks" }
                        checks++
                    }
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
            session.dispose()
            val any = ProjectIntents.RenderRequest(ProjectIntents.OptionalRenderCursor.Absent(ProjectIntents.Empty), ProjectIntents.OptionalRenderCursor.Absent(ProjectIntents.Empty), 0, 1)
            check(failure { session.render(any) } == "disposed"); checks++
        }
        return checks
    }
}
