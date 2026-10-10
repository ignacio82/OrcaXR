package dev.orcaxr.core

/** The transform inspector's fields through the Kotlin wrapper
 * (`transform-field-vectors.json`): [TransformFields.values],
 * [TransformFields.edit], [TransformFields.eulerRadians] and
 * [TransformFields.rotation] answer every browser case as the browser's reply
 * reads, and malformed requests are refused by the exports. */
object ProjectTransformFieldChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as? Double ?: Double.NaN } }
    private fun strings(value: Any): List<String> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun transform(value: Any): ProjectIntents.Transform = (value as ProjectJsonObject).let {
        ProjectIntents.Transform(doubles(it.get("translationMm")), doubles(it.get("rotation")), doubles(it.get("scale")))
    }
    private fun tool(value: Any) = TransformTool.entries.first { it.wire == value }

    /** [script] lines (tab-separated): `F <request> <reply>` field reads, `E` edits,
     * `Q` rotation conversions, and `X <exchange> <request>` refusals. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        for (line in script.split("\n")) {
            val entry = line.split("\t")
            when (entry[0]) {
                "F" -> {
                    val request = obj(entry[1])
                    val reply = obj(entry[2])
                    val shown = TransformFields.values(tool(request.get("tool")), transform(request.get("transform")))
                    check(shown == TransformFieldValues(doubles(reply.get("values")), strings(reply.get("texts"))), "fields_$checks $shown")
                }
                "E" -> {
                    val request = obj(entry[1])
                    val reply = obj(entry[2])
                    val origins = (request.get("origins") as ProjectJsonArray).let { list ->
                        List(list.length()) {
                            val origin = list.get(it) as ProjectJsonObject
                            ProjectIntents.InstanceTransform((origin.get("instanceId") as String).map { c -> c.code }, transform(origin.get("transform")))
                        }
                    }
                    val edit = TransformFields.edit(tool(request.get("tool")), strings(request.get("texts")), origins, request.get("primaryInstanceId") as String)
                    val expected = if (reply.keys().asSequence().any { it == "error" }) {
                        TransformFieldEdit.Refused(reply.get("message") as String)
                    } else {
                        val changes = reply.get("changes") as ProjectJsonArray
                        TransformFieldEdit.Changes(
                            List(changes.length()) {
                                val change = changes.get(it) as ProjectJsonObject
                                ProjectIntents.InstanceTransform((change.get("instanceId") as String).map { c -> c.code }, transform(change.get("transform")))
                            },
                        )
                    }
                    check(edit == expected, "edit_$checks $edit")
                }
                "Q" -> {
                    val request = obj(entry[1])
                    val reply = obj(entry[2])
                    val converted = if (request.keys().asSequence().any { it == "rotation" }) {
                        TransformFields.eulerRadians(doubles(request.get("rotation"))) == doubles(reply.get("eulerRadians"))
                    } else {
                        TransformFields.rotation(doubles(request.get("eulerRadians"))) == doubles(reply.get("rotation"))
                    }
                    check(converted, "rotation_$checks ${entry[1]}")
                }
                "X" -> {
                    val refused = failure {
                        when (entry[1]) {
                            "fields" -> NativeProject.transformFields(entry[2])
                            "edit" -> NativeProject.transformFieldEdit(entry[2])
                            else -> NativeProject.transformRotation(entry[2])
                        }
                    }
                    check(refused == "invalid_request", "refused_$checks ${entry[2]}")
                }
                else -> error("unknown line ${entry[0]}")
            }
        }
        // The panel titles, and a value JSON cannot carry refused before it is sent.
        check(TransformTool.entries.map { it.title } == listOf("Move (mm)", "Rotate (deg)", "Scale (%)"), "titles")
        check(failure { TransformFields.rotation(listOf(Double.NaN, 0.0, 0.0)) } == "invalid_request", "non_finite_refused")
        return checks
    }
}
