package dev.orcaxr.core

/**
 * The virtual filament library, as the browser's library shows and edits it
 * (`virtualFilamentLibraryModel.ts`, `CanonicalVirtualFilamentLibraryAdapter.ts`,
 * `VirtualFilamentMutation.ts`, through `VirtualFilamentExchange.ts`; in the
 * shared core as `orcaxr_project::filaments::library`): a captured project
 * answers its library and each edit's step ([ProjectSnapshot.virtualFilamentLibrary],
 * [ProjectSnapshot.virtualFilamentMutation]); the author dialog's opening
 * fields, validations, triangle picker and pinned Match search are answered
 * over a library's document ([VirtualFilaments]). This file holds the values
 * and their canonical JSON. A library's [VirtualFilamentLibrary.json] and a
 * validation's draft travel back to the core exactly as it wrote them.
 */

/** A recipe's mode: the browser's Ratio, Cycle, Match and Gradient. */
enum class VirtualFilamentMode(internal val wire: String) {
    RATIO("ratio"), CYCLE("cycle"), MATCH("match"), GRADIENT("gradient");

    companion object {
        internal fun of(wire: String) = entries.first { it.wire == wire }
    }
}

/** A physical head as the library lists it (`VirtualFilamentPhysicalChoice`). */
data class VirtualFilamentChoice(
    val id: String,
    val toolId: Int,
    val name: String,
    val material: String,
    val color: String,
    val enabled: Boolean,
    val compatible: Boolean,
    val incompatibilityReason: String?,
)

/** A live recipe (`VirtualFilamentLibraryRow`): its draft's name, badge and mode, its one-line summary and what references it. */
data class VirtualFilamentRow(
    val id: String,
    val enabled: Boolean,
    val name: String,
    val displayColor: String,
    val mode: VirtualFilamentMode,
    val summary: String,
    val dependencyLabels: List<String>,
)

/** The library a project shows; [json] is the core's document, which every dialog exchange reads. */
data class VirtualFilamentLibrary(
    val json: String,
    val physical: List<VirtualFilamentChoice>,
    val rows: List<VirtualFilamentRow>,
    val status: String,
) {
    /** The heads a recipe can newly select: enabled and compatible (`selectablePhysical`). */
    val selectable: List<VirtualFilamentChoice> get() = physical.filter { it.enabled && it.compatible }

    companion object {
        val EMPTY = VirtualFilamentLibrary(
            "{\"matchCandidates\":[],\"mixedRows\":[],\"physicalChoices\":[],\"status\":\"0 virtual filaments; 0 of 0 physical heads selectable.\"}",
            emptyList(),
            emptyList(),
            "0 virtual filaments; 0 of 0 physical heads selectable.",
        )
    }
}

/** A library, or why the browser's library would show none (its words, without the "unavailable" prefix). */
sealed interface VirtualFilamentLibraryResult {
    data class Shown(val library: VirtualFilamentLibrary) : VirtualFilamentLibraryResult
    data class Unavailable(val message: String) : VirtualFilamentLibraryResult
}

/** What the author dialog does (`AuthorOperation`). */
enum class VirtualFilamentOperation(internal val wire: String) { ADD("add"), EDIT("edit"), DUPLICATE("duplicate") }

/**
 * The author dialog's fields, exactly as typed (`VirtualFilamentAuthorForm`):
 * the name, badge colour, the two surface offsets, the mode and each mode's
 * own fields (kept when the mode changes, as the browser's dialog keeps them).
 */
data class VirtualFilamentForm(
    val name: String,
    val displayColor: String,
    val offsetA: String,
    val offsetB: String,
    val mode: VirtualFilamentMode,
    val ratioCount: Int,
    val ratioIds: List<String>,
    val ratioMixB: String,
    val ratioTriangle: List<String>,
    val cyclePattern: String,
    val matchTarget: String,
    val matchMinimum: String,
    val matchSelected: String?,
    val gradientIds: List<String>,
    val gradientAToB: Boolean,
    val gradientSublayers: String,
) {
    /** The ratio component at [index] (the browser's select shows none past the list). */
    fun ratioId(index: Int): String? = ratioIds.getOrNull(index)

    /** The fields with ratio component [index] chosen ([ratioIds] grows to reach it, as the browser's array does). */
    fun withRatioId(index: Int, id: String): VirtualFilamentForm {
        val ids = ratioIds.toMutableList()
        while (ids.size <= index) ids += ""
        ids[index] = id
        return copy(ratioIds = ids)
    }

    internal fun json(): String = buildString {
        val q = CanonicalJson::quote
        append("{\"componentASurfaceOffsetMm\":").append(q(offsetA))
        append(",\"componentBSurfaceOffsetMm\":").append(q(offsetB))
        append(",\"cycle\":{\"manualPattern\":").append(q(cyclePattern)).append('}')
        append(",\"displayColor\":").append(q(displayColor))
        append(",\"gradient\":{\"componentIds\":").append(gradientIds.joinToString(",", "[", "]", transform = q))
        append(",\"direction\":").append(q(if (gradientAToB) "a-to-b" else "b-to-a"))
        append(",\"localZMaxSublayers\":").append(q(gradientSublayers)).append('}')
        append(",\"match\":{\"minComponentPercent\":").append(q(matchMinimum))
        if (matchSelected != null) append(",\"selectedCandidateId\":").append(q(matchSelected))
        append(",\"targetColor\":").append(q(matchTarget)).append('}')
        append(",\"mode\":").append(q(mode.wire))
        append(",\"name\":").append(q(name))
        append(",\"ratio\":{\"componentCount\":").append(ratioCount)
        append(",\"componentIds\":").append(ratioIds.joinToString(",", "[", "]", transform = q))
        append(",\"mixBPercent\":").append(q(ratioMixB))
        append(",\"triangleWeights\":").append(ratioTriangle.joinToString(",", "[", "]", transform = q)).append("}}")
    }
}

/** A located issue (`VirtualFilamentIssue`): its message, the field it concerns, and a Cycle pattern's characters. */
data class VirtualFilamentIssue(val message: String, val field: String?, val startOffset: Int?, val endOffset: Int?)

/** A ranked Match candidate as the dialog lists it. */
data class VirtualFilamentRankedCandidate(
    val candidateId: String,
    val title: String,
    val detail: String,
    val previewColor: String,
    val deltaE2000: Double,
)

/** The Match ranking: the normalized target, the candidates in rank order, and its issues. */
data class VirtualFilamentRanking(
    val normalizedTargetColor: String?,
    val ranked: List<VirtualFilamentRankedCandidate>,
    val issues: List<VirtualFilamentIssue>,
)

/** The search a Match dialog's fields ask for (`ensureMatchSearch`). */
data class VirtualFilamentSearchRequest(val targetColor: String, val minComponentPercent: Int)

/** What a dialog knows of its search: running, its candidates (the core's JSON array), or why it failed. */
sealed interface VirtualFilamentSearch {
    data object Pending : VirtualFilamentSearch
    data class Ready(val candidatesJson: String) : VirtualFilamentSearch
    data class Failed(val error: String?) : VirtualFilamentSearch
}

/** A preview colour (or a gradient's two) and its words. */
data class VirtualFilamentPreview(val color: String, val bottom: String?, val text: String)

/** The triangle picker's marker: where it sits in the 240 × 216 view box, its proportions and what it reads. */
data class VirtualFilamentTriangle(val x: Double, val y: Double, val weights: List<Double>, val valueText: String)

/**
 * What the dialog shows for its fields (`VirtualFilamentDraftValidation`
 * and the mode views): the issues, the preview line, the validated draft's
 * JSON once complete, the Match ranking and the search the fields ask for,
 * the Ratio pigment preview and triangle marker, the Gradient preview (a
 * preview is null while its recipe is incomplete).
 */
data class VirtualFilamentValidation(
    val issues: List<VirtualFilamentIssue>,
    val preview: String,
    val draftJson: String?,
    val ranking: VirtualFilamentRanking?,
    val matchSearch: VirtualFilamentSearchRequest?,
    val ratioPreview: VirtualFilamentPreview?,
    val triangle: VirtualFilamentTriangle?,
    val gradientPreview: VirtualFilamentPreview?,
)

/** One library edit (`VirtualFilamentMutation`); a draft is a validation's [VirtualFilamentValidation.draftJson]. */
sealed interface VirtualFilamentEdit {
    data class Add(val draftJson: String) : VirtualFilamentEdit
    data class Edit(val filamentId: String, val draftJson: String) : VirtualFilamentEdit
    data class Duplicate(val sourceId: String, val draftJson: String) : VirtualFilamentEdit
    data class SetEnabled(val filamentId: String, val enabled: Boolean) : VirtualFilamentEdit
    data class Delete(val filamentId: String) : VirtualFilamentEdit
}

/** An edit's step as the core planned it: its batch, label, whether it is one intent, and its outcome. */
data class VirtualFilamentStep(
    val batch: ProjectIntents.Batch,
    val label: String,
    val intent: Boolean,
    val operation: String,
    val filamentId: String?,
    /** `removed` or `tombstoned` for a deletion. */
    val outcome: String?,
    val dependencyPaths: List<String>,
)

/** An edit's plan, or the refusal in the browser's words. */
sealed interface VirtualFilamentPlan {
    data class Planned(val step: VirtualFilamentStep) : VirtualFilamentPlan
    data class Refused(val message: String) : VirtualFilamentPlan
}

/** The author dialog's exchanges over a library document, and the library's JSON. */
object VirtualFilaments {
    private fun keys(value: ProjectJsonObject) = value.keys().asSequence().toSet()
    private fun string(value: ProjectJsonObject, key: String) = value.get(key) as String
    private fun optional(value: ProjectJsonObject, key: String) = if (key in keys(value)) value.get(key) as? String else null
    private fun strings(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun doubles(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as Double } }
    private fun <T> objects(value: Any, read: (ProjectJsonObject) -> T) =
        (value as ProjectJsonArray).let { list -> List(list.length()) { read(list.get(it) as ProjectJsonObject) } }

    /** A library exchange's reply. */
    internal fun library(json: String): VirtualFilamentLibraryResult {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        if ("error" in keys(reply)) return VirtualFilamentLibraryResult.Unavailable(string(reply, "error"))
        return VirtualFilamentLibraryResult.Shown(
            VirtualFilamentLibrary(
                json,
                objects(reply.get("physicalChoices")) { choice ->
                    VirtualFilamentChoice(
                        string(choice, "id"),
                        (choice.get("toolId") as Double).toInt(),
                        string(choice, "name"),
                        string(choice, "material"),
                        string(choice, "color"),
                        choice.get("enabled") as Boolean,
                        choice.get("compatible") as Boolean,
                        optional(choice, "incompatibilityReason"),
                    )
                },
                objects(reply.get("mixedRows")) { row ->
                    val draft = row.get("draft") as ProjectJsonObject
                    VirtualFilamentRow(
                        string(row, "id"),
                        row.get("enabled") as Boolean,
                        string(draft, "name"),
                        string(draft, "displayColor"),
                        VirtualFilamentMode.of(string(draft, "mode")),
                        string(row, "summary"),
                        if ("dependencyLabels" in keys(row)) strings(row.get("dependencyLabels")) else emptyList(),
                    )
                },
                string(reply, "status"),
            ),
        )
    }

    /** A form document as the core writes it. */
    internal fun form(json: String): VirtualFilamentForm {
        val form = CanonicalJson.read(json) as ProjectJsonObject
        val ratio = form.get("ratio") as ProjectJsonObject
        val match = form.get("match") as ProjectJsonObject
        val gradient = form.get("gradient") as ProjectJsonObject
        return VirtualFilamentForm(
            string(form, "name"),
            string(form, "displayColor"),
            string(form, "componentASurfaceOffsetMm"),
            string(form, "componentBSurfaceOffsetMm"),
            VirtualFilamentMode.of(string(form, "mode")),
            (ratio.get("componentCount") as Double).toInt(),
            strings(ratio.get("componentIds")),
            string(ratio, "mixBPercent"),
            strings(ratio.get("triangleWeights")),
            string(form.get("cycle") as ProjectJsonObject, "manualPattern"),
            string(match, "targetColor"),
            string(match, "minComponentPercent"),
            optional(match, "selectedCandidateId"),
            strings(gradient.get("componentIds")),
            string(gradient, "direction") == "a-to-b",
            string(gradient, "localZMaxSublayers"),
        )
    }

    /** The fields the author dialog opens with for [operation] on row [filamentId] (none when adding). */
    fun opening(library: VirtualFilamentLibrary, operation: VirtualFilamentOperation, filamentId: String?): VirtualFilamentForm =
        form(
            NativeProject.virtualFilamentFormDefaults(
                "{\"filamentId\":${filamentId?.let(CanonicalJson::quote) ?: "null"},\"library\":${library.json},\"operation\":${CanonicalJson.quote(operation.wire)}}",
            ),
        )

    private fun issue(value: ProjectJsonObject) = VirtualFilamentIssue(
        string(value, "message"),
        optional(value, "field"),
        if ("startOffset" in keys(value)) (value.get("startOffset") as Double).toInt() else null,
        if ("endOffset" in keys(value)) (value.get("endOffset") as Double).toInt() else null,
    )

    internal fun searchJson(search: VirtualFilamentSearch?): String = when (search) {
        null -> "null"
        VirtualFilamentSearch.Pending -> "{\"candidates\":[],\"status\":\"pending\"}"
        is VirtualFilamentSearch.Ready -> "{\"candidates\":${search.candidatesJson},\"status\":\"ready\"}"
        is VirtualFilamentSearch.Failed ->
            "{\"candidates\":[]${search.error?.let { ",\"error\":${CanonicalJson.quote(it)}" } ?: ""},\"status\":\"error\"}"
    }

    /** Everything the dialog shows for [form] over [library], given its Match [search]. */
    fun validate(library: VirtualFilamentLibrary, form: VirtualFilamentForm, search: VirtualFilamentSearch?): VirtualFilamentValidation {
        val json = NativeProject.virtualFilamentForm("{\"form\":${form.json()},\"library\":${library.json},\"search\":${searchJson(search)}}")
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        val present = keys(reply)
        val ranking = (if ("ranking" in present) reply.get("ranking") else null) as? ProjectJsonObject
        val ask = (if ("matchSearch" in present) reply.get("matchSearch") else null) as? ProjectJsonObject
        val ratio = (if ("ratioPreview" in present) reply.get("ratioPreview") else null) as? ProjectJsonObject
        val triangle = (if ("triangle" in present) reply.get("triangle") else null) as? ProjectJsonObject
        val gradient = (if ("gradientPreview" in present) reply.get("gradientPreview") else null) as? ProjectJsonObject
        return VirtualFilamentValidation(
            objects(reply.get("issues"), ::issue),
            string(reply, "preview"),
            if ("draft" in present) draftOf(json) else null,
            ranking?.let { value ->
                VirtualFilamentRanking(
                    optional(value, "normalizedTargetColor"),
                    objects(value.get("ranked")) { entry ->
                        VirtualFilamentRankedCandidate(
                            string(entry, "candidateId"),
                            string(entry, "title"),
                            string(entry, "detail"),
                            string(entry, "previewColor"),
                            entry.get("deltaE2000") as Double,
                        )
                    },
                    objects(value.get("issues"), ::issue),
                )
            },
            ask?.let { VirtualFilamentSearchRequest(string(it, "targetColor"), (it.get("minComponentPercent") as Double).toInt()) },
            ratio?.let { VirtualFilamentPreview(string(it, "color"), null, string(it, "text")) },
            triangle?.let { VirtualFilamentTriangle(it.get("x") as Double, it.get("y") as Double, doubles(it.get("weights")), string(it, "valueText")) },
            gradient?.let { VirtualFilamentPreview(string(it, "top"), string(it, "bottom"), string(it, "text")) },
        )
    }

    /**
     * The validated draft inside a form reply, exactly as the core wrote it:
     * the reply is canonical, so its `"draft":` member is the object that
     * follows, up to its matching brace (strings may hold braces).
     */
    private fun draftOf(json: String): String {
        val start = json.indexOf("{", json.indexOf("\"draft\":"))
        var depth = 0
        var inString = false
        var index = start
        while (index < json.length) {
            val char = json[index]
            if (inString) {
                if (char == '\\') index++ else if (char == '"') inString = false
            } else when (char) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> if (--depth == 0) return json.substring(start, index + 1)
            }
            index++
        }
        error("invalid_reply")
    }

    /** The proportions the triangle picker writes for a point of its view box; null far outside it. */
    fun triangleWeights(x: Double, y: Double): List<String>? {
        val reply = CanonicalJson.read(NativeProject.virtualFilamentTriangle("{\"x\":${number(x)},\"y\":${number(y)}}")) as ProjectJsonObject
        return if ("weights" in keys(reply)) strings(reply.get("weights")) else null
    }

    /** The pinned search's candidates for [request] over [library] (the browser's worker search), as their JSON array. */
    fun search(library: VirtualFilamentLibrary, request: VirtualFilamentSearchRequest): String {
        val json = NativeProject.virtualFilamentMatchSearch(
            "{\"library\":${library.json},\"minComponentPercent\":${request.minComponentPercent},\"targetColor\":${CanonicalJson.quote(request.targetColor)}}",
        )
        val prefix = "{\"candidates\":"
        check(json.startsWith(prefix) && json.endsWith("}")) { "invalid_reply" }
        return json.substring(prefix.length, json.length - 1)
    }

    /** A finite number as JSON (`String(n)` for the integral ones the picker sends). */
    private fun number(value: Double): String {
        require(value.isFinite()) { "a finite point" }
        return if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
    }

    internal fun mutationRequest(edit: VirtualFilamentEdit, newId: () -> String): String = when (edit) {
        is VirtualFilamentEdit.Add ->
            "{\"draft\":${edit.draftJson},\"newId\":${CanonicalJson.quote(newId())},\"operation\":\"add\"}"
        is VirtualFilamentEdit.Edit ->
            "{\"draft\":${edit.draftJson},\"filamentId\":${CanonicalJson.quote(edit.filamentId)},\"operation\":\"edit\"}"
        is VirtualFilamentEdit.Duplicate ->
            "{\"draft\":${edit.draftJson},\"newId\":${CanonicalJson.quote(newId())},\"operation\":\"duplicate\",\"sourceFilamentId\":${CanonicalJson.quote(edit.sourceId)}}"
        is VirtualFilamentEdit.SetEnabled ->
            "{\"enabled\":${edit.enabled},\"filamentId\":${CanonicalJson.quote(edit.filamentId)},\"operation\":\"set-enabled\"}"
        is VirtualFilamentEdit.Delete -> "{\"filamentId\":${CanonicalJson.quote(edit.filamentId)},\"operation\":\"delete\"}"
    }

    /** A mutation exchange's reply. */
    internal fun plan(json: String): VirtualFilamentPlan {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        if ("error" in keys(reply)) return VirtualFilamentPlan.Refused(string(reply, "error"))
        return VirtualFilamentPlan.Planned(
            VirtualFilamentStep(
                ProjectIntents.decodeBatch(string(reply, "batchJson")),
                string(reply, "label"),
                string(reply, "step") == "intent",
                string(reply, "operation"),
                optional(reply, "filamentId"),
                optional(reply, "outcome"),
                if ("dependencyPaths" in keys(reply)) strings(reply.get("dependencyPaths")) else emptyList(),
            ),
        )
    }
}
