package dev.orcaxr.core

/** Facet region selection through the Kotlin wrapper: every request of the
 * browser's script round-trips, every reply decodes to the browser's
 * and every refusal carries its code; a page's guard names the volume and
 * topology a `facetStroke` commits under, and a disposed session refuses. */
object ProjectFacetRegionChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [assets] hold each mesh's bytes in declaration order; [script] holds one
     * entry per line, `P\t<request>\t<reply>` or `X\t<request>\t<refusal>`. */
    @JvmStatic fun run(source: String, sphere: ByteArray, terrain: ByteArray, script: String): Long {
        var checks = 0L
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 2, 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument(); check(upload.assetCount() == 2L)
            for ((position, mesh) in listOf(sphere, terrain).withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong())
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open())
            var first: ProjectIntents.FacetRegionRequest? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                val request = ProjectIntents.decodeFacetRegionRequest(entry[1])
                if (first == null) first = request
                // Requests carry doubles, so the round trip compares values.
                check(ProjectIntents.decodeFacetRegionRequest(ProjectIntents.encodeFacetRegionRequest(request)) == request) { "facet_region_request_$checks" }; checks++
                when (entry[0]) {
                    "P" -> {
                        val reply = session.facetRegion(request)
                        // Values, not text: Kotlin writes doubles its own way.
                        check(reply == ProjectIntents.decodeFacetRegionReply(entry[2])) { "facet_region_$checks" }; checks++
                        if (reply is ProjectIntents.FacetRegionReply.Page) {
                            check(reply.value.guard.volumeId == request.volumeId && reply.value.ranges.size.toLong() <= request.count); checks++
                        }
                    }
                    "X" -> { check(failure { session.facetRegion(request) } == entry[2]) { "facet_region_refusal_$checks" }; checks++ }
                    else -> error("unknown script entry ${entry[0]}")
                }
            }
            session.dispose()
            check(failure { session.facetRegion(first!!) } == "disposed"); checks++
        }
        return checks
    }
}
