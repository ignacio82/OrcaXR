package dev.orcaxr.core

/** Ray picking through the Kotlin wrapper: each scene of the browser's script
 * captures, every ray round-trips and picks the browser's reply, the unknown
 * plate refuses, and a disposed session captures nothing. */
object ProjectPickChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] holds one entry per line: `S\t<scene request>` opens a scene,
     * `R\t<ray>\t<reply>` picks in it, `X\t<scene request>\t<refusal>` refuses. */
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
            var scene: ProjectPickScene? = null
            var first: ProjectIntents.PickSceneRequest? = null
            try {
                for (line in script.split("\n")) {
                    val entry = line.split("\t")
                    when (entry[0]) {
                        "S" -> {
                            val request = ProjectIntents.decodePickSceneRequest(entry[1])
                            check(ProjectIntents.encodePickSceneRequest(request) == entry[1]) { "pick_scene_$checks" }; checks++
                            scene?.close()
                            scene = session.pickScene(request)
                            if (first == null) first = request
                        }
                        "R" -> {
                            val ray = ProjectIntents.decodePickRay(entry[1])
                            // Rays carry doubles, so the round trip compares values.
                            check(ProjectIntents.decodePickRay(ProjectIntents.encodePickRay(ray)) == ray) { "pick_ray_$checks" }; checks++
                            check(scene!!.pick(ray) == ProjectIntents.decodePickReply(entry[2])) { "pick_reply_$checks" }; checks++
                        }
                        "X" -> {
                            val request = ProjectIntents.decodePickSceneRequest(entry[1])
                            check(failure { session.pickScene(request).close() } == entry[2]) { "pick_refusal_$checks" }; checks++
                        }
                        else -> error("unknown script entry ${entry[0]}")
                    }
                }
            } finally {
                scene?.close()
            }
            session.dispose()
            check(failure { session.pickScene(first!!).close() } == "disposed"); checks++
        }
        return checks
    }
}
