package dev.orcaxr.core

import java.util.Base64

/** Primitives and helper volumes through the Kotlin wrapper (`primitive-vectors.json`):
 * every mesh payload [Primitives.payload] builds is the browser's (byte for byte, or
 * by length and digest), malformed requests are refused, and each recorded state,
 * opened as a real session with its assets, plans every primitive object and helper
 * volume — from the request [Primitives.primitiveRequest] or [Primitives.helperRequest]
 * composes, and from the browser's own — as the browser built it. */
object ProjectPrimitiveChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun bytes(text: String) = Base64.getDecoder().decode(text)
    private fun fnv(bytes: ByteArray): String {
        var hash = 0xcbf29ce484222325uL
        for (b in bytes) hash = (hash xor b.toUByte().toULong()) * 0x100000001b3uL
        return "fnv1a64:" + hash.toString(16).padStart(16, '0')
    }
    private fun units(text: String) = text.map { it.code }
    private fun list(value: Any): List<Any> = (value as ProjectJsonArray).let { array -> List(array.length()) { array.get(it) } }

    /** [script] lines (tab-separated): `M <request> <byteLength> <digest> <payload|->`, `X <request>`,
     * `S <name> <stateJson>`, its assets `A <descriptorJson> <bytes>` in declared order, its plans
     * `P <kind> <request> <reply>` and the malformed plans it refuses, `R <kind> <request>`. One
     * session is open at a time. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectPreparation().use { scope ->
            var pending: Triple<String, String, MutableList<Pair<String, ByteArray>>>? = null
            fun open(): ProjectSession? {
                val (name, state, assets) = pending ?: return null
                pending = null
                val document = state.toByteArray(Charsets.UTF_8)
                val options = ProjectHostOptions(document.size.toLong(), 1_000_000, 8_000_000, 1024, 128, assets.size.toLong(), 16_777_216, 33_554_432, 100, 33_554_432)
                val upload = scope.own(ProjectUpload(document.size.toLong(), options, LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
                for (start in document.indices step ProjectHost.MAX_CHUNK_BYTES)
                    upload.appendDocument(start.toLong(), document.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, document.size)))
                upload.sealDocument()
                check(upload.assetCount() == assets.size.toLong(), "asset_count_$name")
                for ((index, asset) in assets.withIndex()) {
                    check(upload.beginAsset(index.toLong()) == asset.second.size.toLong(), "asset_length_$name")
                    for (start in asset.second.indices step ProjectHost.MAX_CHUNK_BYTES)
                        upload.appendAsset(start.toLong(), asset.second.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, asset.second.size)))
                    upload.finishAsset()
                }
                return scope.own(upload.open())
            }
            var session: ProjectSession? = null
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                if (entry[0] != "A") open()?.let { opened ->
                    session?.close()
                    session = opened
                }
                when (entry[0]) {
                    "M" -> {
                        val request = CanonicalJson.read(entry[1]) as ProjectJsonObject
                        val payload = NativeProject.primitivePayload(entry[1])
                        check(payload.size.toLong() == entry[2].toLong() && fnv(payload) == entry[3], "mesh_${entry[1]}")
                        if (entry[4] != "-") check(payload.contentEquals(bytes(entry[4])), "mesh_bytes_${entry[1]}")
                        val shape = PrimitiveShape.entries.first { it.wire == request.get("kind") }
                        check(Primitives.payload(shape, request.get("sizeMm") as Double).contentEquals(payload), "mesh_typed_${entry[1]}")
                    }
                    "X" -> check(failure { NativeProject.primitivePayload(entry[1]) } == "invalid_request", "mesh_refused_${entry[1]}")
                    "S" -> pending = Triple(entry[1], entry[2], mutableListOf())
                    "A" -> checkNotNull(pending).third += entry[1] to bytes(entry[2])
                    "P" -> {
                        val live = checkNotNull(session)
                        val request = CanonicalJson.read(entry[2]) as ProjectJsonObject
                        val ids = list(request.get("ids")).map { it as String }
                        if (entry[1] == "primitive") {
                            val expected = Primitives.primitiveReply(entry[3])
                            check(live.planPrimitiveObject(entry[2]) == expected, "primitive_${entry[2]}")
                            val corners = request.get("areaMm") as ProjectJsonObject
                            val area = PrintableArea(
                                corners.get("xMin") as Double, corners.get("yMin") as Double,
                                corners.get("xMax") as Double, corners.get("yMax") as Double,
                            )
                            val shape = PrimitiveShape.entries.first { it.wire == request.get("kind") }
                            val typed = Primitives.primitiveRequest(
                                shape, area, ids, request.get("importedAt") as String,
                                request.get("plateId") as? String, request.get("sizeMm") as Double,
                            )
                            check(live.planPrimitiveObject(typed) == expected, "primitive_typed_${entry[2]} $typed")
                        } else {
                            val expected = Primitives.helperReply(entry[3])
                            check(live.planHelperVolume(entry[2]) == expected, "helper_${entry[2]}")
                            val primary = request.get("primary") as? ProjectJsonObject
                            val ref = primary?.let {
                                val id = units(it.get("id") as String)
                                when (it.get("kind")) {
                                    "plate" -> ProjectIntents.SelectionEntity.Plate(id)
                                    "object" -> ProjectIntents.SelectionEntity.Object(id)
                                    "volume" -> ProjectIntents.SelectionEntity.Volume(id)
                                    "instance" -> ProjectIntents.SelectionEntity.Instance(id)
                                    "layer-range" -> ProjectIntents.SelectionEntity.LayerRange(id)
                                    else -> error("kind ${it.get("kind")}")
                                }
                            }
                            val role = HelperVolumeRole.entries.first { it.wire == request.get("role") }
                            val typed = Primitives.helperRequest(role, ref, ids, request.get("sizeMm") as Double)
                            check(live.planHelperVolume(typed) == expected, "helper_typed_${entry[2]} $typed")
                        }
                    }
                    "R" -> {
                        val target = checkNotNull(session)
                        val refused = failure {
                            if (entry[1] == "primitive") target.planPrimitiveObject(entry[2]) else target.planHelperVolume(entry[2])
                        }
                        check(refused == "invalid_request", "plan_refused_${entry[2]} $refused")
                    }
                    else -> error("unknown line ${entry[0]}")
                }
            }
            session?.close()
        }
        // The shapes the Add menu offers and the roles a selection's object takes, by action.
        check(PrimitiveShape.PRIMITIVES.mapNotNull { it.actionId } == listOf(
            "add_primitive_cube", "add_primitive_cylinder", "add_primitive_sphere", "add_primitive_cone", "add_primitive_disc", "add_primitive_torus",
        ), "primitive_actions")
        check(HelperVolumeRole.forAction("add_support_blocker") == HelperVolumeRole.SUPPORT_BLOCKER && PrimitiveShape.forAction("add_modifier") == null, "actions")
        check(failure { Primitives.payload(PrimitiveShape.CUBE, Double.NaN) } == "invalid_request", "payload_nan")
        return checks
    }
}
