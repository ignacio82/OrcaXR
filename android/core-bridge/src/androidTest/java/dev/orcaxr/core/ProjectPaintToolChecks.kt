package dev.orcaxr.core

/** The painter's settings and paint colours through the Kotlin wrapper
 * (`paint-tool-vectors.json`): every sample request answers the browser's
 * reply through [PaintTools.sampleJson] and again through the typed
 * [PaintTools.sample] (hit and settings rebuilt from the request, so the
 * wrapper's own JSON is checked), every malformed request refuses, and
 * every colour request answers the browser's colours. */
object ProjectPaintToolChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun has(fields: ProjectJsonObject, key: String) = fields.keys().asSequence().any { it == key }
    private fun vector(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as Double } }

    private fun transform(value: Any) = (value as ProjectJsonObject).let { t ->
        val rotation = t.get("rotation") as ProjectJsonArray
        ProjectIntents.Transform(vector(t.get("translationMm")), List(rotation.length()) { rotation.get(it) as Double }, vector(t.get("scale")))
    }

    private fun hit(fields: ProjectJsonObject) = PaintHit(
        (fields.get("triangleIndex") as Double).toLong(),
        vector(fields.get("localPoint")),
        vector(fields.get("localCameraPosition")),
        if (has(fields, "previousLocalPoint")) vector(fields.get("previousLocalPoint")) else null,
        if (has(fields, "placement")) (fields.get("placement") as ProjectJsonObject).let {
            PaintPlacement(transform(it.get("instance")), transform(it.get("volume")))
        } else null,
    )

    private fun settings(fields: ProjectJsonObject): PaintToolSettings {
        fun number(key: String) = if (has(fields, key)) fields.get(key) as Double else null
        return PaintToolSettings(
            PaintToolKind.entries.single { it.wire == fields.get("tool") },
            number("radiusMm"), number("smartFillAngleDegrees"), number("heightRangeMm"), number("gapAreaMm2"),
            number("highlightByAngleDegrees"),
            if (has(fields, "triangleSplitting")) fields.get("triangleSplitting") as Boolean else null,
            if (has(fields, "clippingPlane")) (fields.get("clippingPlane") as ProjectJsonObject).let {
                ProjectIntents.FacetClippingPlane(vector(it.get("normal")), it.get("offset") as Double)
            } else null,
        )
    }

    /** [script] holds one case per line: `S\t<request>\t<reply>` (a sample or
     * the painter's refusal), `X\t<request>` (malformed), `C\t<request>\t<reply>`
     * (colours) or `Y\t<request>` (a malformed colour request). */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        for (line in script.split("\n")) {
            val entry = line.split("\t")
            when (entry[0]) {
                "S" -> {
                    check(PaintTools.sampleJson(entry[1]) == entry[2]) { "paint_tool_sample_$checks" }; checks++
                    val request = CanonicalJson.read(entry[1]) as ProjectJsonObject
                    val hitFields = request.get("hit") as ProjectJsonObject
                    val index = hitFields.get("triangleIndex") as Double
                    // A fractional facet has no typed form; its raw refusal is checked above.
                    if (index % 1.0 != 0.0) continue
                    val order = (request.get("stateOrder") as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
                    val typed = PaintTools.sample(
                        PaintChannel.entries.single { it.wire == request.get("channel") },
                        hit(hitFields), settings(request.get("settings") as ProjectJsonObject), order,
                    )
                    val reply = CanonicalJson.read(entry[2]) as ProjectJsonObject
                    val expected = if (has(reply, "error")) PaintToolSample.Refused(reply.get("error") as String, reply.get("message") as String)
                    else PaintToolSample.Sample(ProjectIntents.decodePaintStrokeSample(reply.get("sample") as String))
                    check(typed == expected) { "paint_tool_typed_$checks: $typed" }; checks++
                }
                "X" -> { check(failure { PaintTools.sampleJson(entry[1]) } == "invalid_request") { "paint_tool_malformed_$checks" }; checks++ }
                "C" -> { check(PaintTools.colorsJson(entry[1]) == entry[2]) { "paint_colors_$checks" }; checks++ }
                "Y" -> { check(failure { PaintTools.colorsJson(entry[1]) } == "invalid_request") { "paint_colors_malformed_$checks" }; checks++ }
                else -> error("unknown script entry ${entry[0]}")
            }
        }
        return checks
    }
}
