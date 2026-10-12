package dev.orcaxr.core

/** Where the transform gizmo stands through the Kotlin wrapper
 * (`transform-proxy-vectors.json`): the browser's scene opens as a session,
 * [TransformGizmo.proxy] places the proxy and captures the origins for every
 * selection as the browser does, malformed requests are refused, and a
 * disposed session places nothing. */
object ProjectTransformProxyChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as? Double ?: Double.NaN } }

    /** [script] lines (tab-separated): `P <request> <reply>` selections and `X <request>` refusals. */
    @JvmStatic fun run(source: String, assets: List<ByteArray>, script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectPreparation().use { scope ->
            val bytes = source.toByteArray(Charsets.UTF_8)
            val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
            for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
            upload.sealDocument()
            check(upload.assetCount() == assets.size.toLong(), "asset_count")
            for ((position, mesh) in assets.withIndex()) {
                check(upload.beginAsset(position.toLong()) == mesh.size.toLong(), "asset_$position")
                for (start in mesh.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendAsset(start.toLong(), mesh.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, mesh.size)))
                upload.finishAsset()
            }
            val session = scope.own(upload.open())
            var first: Pair<String?, List<String>>? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "P" -> {
                        val request = obj(entry[1])
                        val primary = request.get("primaryInstanceId") as? String
                        val selected = (request.get("selectedInstanceIds") as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
                        if (first == null) first = primary to selected
                        val reply = obj(entry[2])
                        val keys = reply.keys().asSequence().toSet()
                        val expected = when {
                            "error" in keys -> TransformProxy.Refused(reply.get("message") as String)
                            "origins" !in keys -> TransformProxy.None
                            else -> {
                                val origins = reply.get("origins") as ProjectJsonArray
                                val pose = reply.get("proxy") as ProjectJsonObject
                                TransformProxy.Placed(
                                    reply.get("primaryInstanceId") as String,
                                    List(origins.length()) {
                                        val origin = origins.get(it) as ProjectJsonObject
                                        val t = origin.get("transform") as ProjectJsonObject
                                        ProjectIntents.InstanceTransform(
                                            (origin.get("instanceId") as String).map { c -> c.code },
                                            ProjectIntents.Transform(doubles(t.get("translationMm")), doubles(t.get("rotation")), doubles(t.get("scale"))),
                                        )
                                    },
                                    GizmoPose(doubles(pose.get("position")), doubles(pose.get("quaternion")), doubles(pose.get("scale"))),
                                )
                            }
                        }
                        val placed = TransformGizmo.proxy(session, primary, selected)
                        check(placed == expected, "proxy_$checks $placed")
                        // A placed proxy attaches the gizmo at its pose.
                        if (placed is TransformProxy.Placed) check(TransformGizmo.attach(placed.pose).proxy == placed.pose, "attach_$checks")
                    }
                    "X" -> check(failure { session.planTransformProxy(entry[1]) } == "invalid_request", "refused_$checks ${entry[1]}")
                    else -> error("unknown line ${entry[0]}")
                }
            }
            session.dispose()
            val (primary, selected) = checkNotNull(first)
            check(failure { TransformGizmo.proxy(session, primary, selected) } == "disposed", "disposed")
        }
        return checks
    }
}
