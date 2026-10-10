package dev.orcaxr.core

/** One plate of a project for an external slicer that always loads plate
 * zero (`orcaxr_project::slicing::plate`, the browser's
 * `projectPlateArchiveForSlice` and `platePrintOverrides`). A session's
 * project is projected through its export capture
 * ([ProjectExportCapture.plate], [ProjectExportSource.writePlateArchive]);
 * these read a state document, for hosts and checks without a session. */
object PlateProjections {
    /** A state document's plate projected, or why it could not be. */
    sealed interface Result {
        /** The one-plate project as its canonical text, its fingerprint (the
         * archive's `sourceHash`) and the source assets it keeps, in order. */
        data class Projected(val stateJson: String, val sourceHash: String, val assetIds: List<String>) : Result
        /** A `plate_projection_*` code and the browser's message. */
        data class Refused(val code: String, val message: String) : Result
    }

    /** [plateId] of [stateJson] projected; [omitted] names source assets whose
     * payloads the host does not hold. Admitted under [resolver] and [profile]. */
    fun project(
        stateJson: String,
        plateId: String,
        omitted: List<String> = emptyList(),
        resolver: LocalTimestampResolver,
        profile: ProjectIntegerProfile,
    ): Result {
        val answer = CanonicalJson.read(
            NativeProject.plateProjection(
                stateJson, CanonicalJson.quote(plateId), omitted.joinToString(",", "[", "]") { CanonicalJson.quote(it) },
                resolver, profile.bits,
            ),
        ) as ProjectJsonObject
        val keys = answer.keys().asSequence().toSet()
        return if ("error" in keys) {
            Result.Refused(answer.get("error") as String, answer.get("message") as String)
        } else {
            val ids = answer.get("assetIds") as ProjectJsonArray
            Result.Projected(
                answer.get("stateJson") as String,
                answer.get("sourceHash") as String,
                List(ids.length()) { ids.get(it) as String },
            )
        }
    }

    /** The print configuration [plateId] of [stateJson] overrides, as engine
     * wire strings; an unknown plate overrides nothing. */
    fun printOverrides(stateJson: String, plateId: String): Map<String, String> =
        CanonicalJson.stringMap(NativeProject.platePrintOverridesJson(stateJson, CanonicalJson.quote(plateId)))
}

/** The core's canonical JSON as Kotlin reads and writes it, every UTF-16
 * unit (lone surrogates included) kept. */
internal object CanonicalJson {
    /** [text] as a JSON string of ASCII alone. */
    fun quote(text: String): String = buildString(text.length + 2) {
        append('"')
        for (unit in text) {
            when {
                unit == '"' -> append("\\\"")
                unit == '\\' -> append("\\\\")
                unit.code in 0x20..0x7e -> append(unit)
                else -> append("\\u").append(unit.code.toString(16).padStart(4, '0'))
            }
        }
        append('"')
    }

    /** Canonical JSON read by the strict ASCII reader: a canonical document
     * carries non-ASCII text only inside strings, where an escape means the same. */
    fun read(json: String): Any = ProjectIntentJson.parse(
        buildString(json.length) {
            for (unit in json) if (unit.code < 0x80) append(unit) else append("\\u").append(unit.code.toString(16).padStart(4, '0'))
        },
        ProjectIntents.BULK,
    )

    /** A canonical JSON object of strings. */
    fun stringMap(json: String): Map<String, String> {
        val value = read(json) as ProjectJsonObject
        val map = LinkedHashMap<String, String>()
        for (key in value.keys()) map[key] = value.get(key) as String
        return map
    }

    /** [map] as a JSON object, keys in UTF-16 order as the core writes them. */
    fun write(map: Map<String, String>): String =
        map.entries.sortedWith { a, b -> a.key.compareTo(b.key) }
            .joinToString(",", "{", "}") { quote(it.key) + ":" + quote(it.value) }
}
