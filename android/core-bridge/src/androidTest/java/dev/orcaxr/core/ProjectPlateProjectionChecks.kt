package dev.orcaxr.core

import java.time.ZoneId

/** One plate for an external slicer through the Kotlin wrapper: every case of
 * the browser's corpus projects to the browser's state text, hash and kept
 * assets or is refused with its message, overrides its print configuration,
 * and those overrides survive the submission's JSON. */
object ProjectPlateProjectionChecks {
    /** [script] lines: `<state>\t<plate ID JSON>\t<omitted IDs JSON>\t<expected>\t<overrides JSON>`,
     * the expected answer as `{"stateJson","sourceHash","assetIds"}` or `{"error","message"}`. */
    @JvmStatic fun run(script: String): Long {
        val utc = ProjectTimeZone(ZoneId.of("UTC"))
        var checks = 0L
        for ((index, line) in script.split("\n").withIndex()) {
            val (state, plateJson, omittedJson, expectedJson, overridesJson) = line.split("\t")
            val label = "plate_projection_$index"
            val plateId = CanonicalJson.read(plateJson) as String
            val omitted = (CanonicalJson.read(omittedJson) as ProjectJsonArray).let { ids -> List(ids.length()) { ids.get(it) as String } }
            val expected = CanonicalJson.read(expectedJson) as ProjectJsonObject
            val keys = expected.keys().asSequence().toSet()
            val answer = PlateProjections.project(state, plateId, omitted, utc, ProjectIntegerProfile.NODE)
            if ("error" in keys) {
                check(answer == PlateProjections.Result.Refused(expected.get("error") as String, expected.get("message") as String)) { "$label $answer" }
            } else {
                val ids = expected.get("assetIds") as ProjectJsonArray
                check(
                    answer == PlateProjections.Result.Projected(
                        expected.get("stateJson") as String,
                        expected.get("sourceHash") as String,
                        List(ids.length()) { ids.get(it) as String },
                    ),
                ) { label }
            }
            val overrides = PlateProjections.printOverrides(state, plateId)
            check(overrides == CanonicalJson.stringMap(overridesJson)) { "$label overrides" }
            // What a submission's overrides field carries reads back the same.
            check(CanonicalJson.stringMap(CanonicalJson.write(overrides)) == overrides) { "$label overrides JSON" }
            checks += 3
        }
        return checks
    }
}
