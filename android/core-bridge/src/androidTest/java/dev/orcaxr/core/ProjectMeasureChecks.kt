package dev.orcaxr.core

/** Surface measurement through the Kotlin wrapper: every capture, pick (in
 * every frame, with its refusals) and measured pair of the browser's script
 * round-trips and answers the browser's reply; a disposed session captures
 * nothing. */
object ProjectMeasureChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one step per line: `C\t<volume>\t<request>\t<reply>`,
     * `F\t<volume>\t<request>\t<reply>` or `M\t<request>\t<reply>`. */
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
            val volumes = mutableMapOf<String, ProjectMeasureVolume>()
            var first: ProjectIntents.MeasureVolumeRequest? = null
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    when (entry[0]) {
                        "C" -> {
                            val request = ProjectIntents.decodeMeasureVolumeRequest(entry[2])
                            check(ProjectIntents.encodeMeasureVolumeRequest(request) == entry[2]) { "measure_capture_request_$checks" }; checks++
                            val volume = session.measureVolume(request)
                            check(volume.reply() == ProjectIntents.decodeMeasureVolumeReply(entry[3])) { "measure_capture_$checks" }; checks++
                            volumes.put(entry[1], volume)?.close()
                            if (first == null) first = request
                        }
                        "F" -> {
                            val request = ProjectIntents.decodeMeasureFeatureRequest(entry[2])
                            // Requests carry doubles, so the round trip compares values.
                            check(ProjectIntents.decodeMeasureFeatureRequest(ProjectIntents.encodeMeasureFeatureRequest(request)) == request) { "measure_pick_request_$checks" }; checks++
                            check(volumes.getValue(entry[1]).feature(request) == ProjectIntents.decodeMeasureFeatureReply(entry[3])) { "measure_pick_$checks" }; checks++
                        }
                        "M" -> {
                            val request = ProjectIntents.decodeMeasureRequest(entry[1])
                            check(ProjectIntents.decodeMeasureRequest(ProjectIntents.encodeMeasureRequest(request)) == request) { "measure_pair_request_$checks" }; checks++
                            check(ProjectMeasureVolume.measure(request) == ProjectIntents.decodeMeasureReply(entry[2])) { "measure_pair_$checks" }; checks++
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                }
            } finally {
                volumes.values.forEach { it.close() }
            }
            session.dispose()
            check(failure { session.measureVolume(first!!).close() } == "disposed"); checks++
        }
        return checks
    }
}
