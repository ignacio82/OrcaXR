package dev.orcaxr.core

/** One height range as the semantic editor lists it: its bounds and their text (`0 mm–2.5 mm`). */
data class LayerRangeEntry(val id: String, val minZMm: Double, val maxZMm: Double, val label: String)

/** Merging the selected range with a neighbour: allowed, or why not in the browser's words. */
data class LayerRangeMerge(val allowed: Boolean, val otherRangeId: String?, val reason: String?)

/** The selected range and what merging it with the range below or above would do. */
data class LayerRangeSelection(val id: String, val mergePrevious: LayerRangeMerge, val mergeNext: LayerRangeMerge)

/** One object's height ranges by height, as the semantic editor shows them (`layerRangeEditorProjection`). */
data class LayerRangeProjection(
    val objectId: String,
    val objectName: String,
    val ranges: List<LayerRangeEntry>,
    val selected: LayerRangeSelection?,
) {
    val selectedRange: LayerRangeEntry? get() = selected?.let { s -> ranges.firstOrNull { it.id == s.id } }
}

/** Typed bounds or a split height: valid (with the numbers read), or why not. */
sealed interface LayerRangeCheck {
    data class Valid(val values: List<Double>) : LayerRangeCheck
    data class Invalid(val message: String) : LayerRangeCheck
}

/** A height-range operation, for what it says while it runs and once it is done. */
sealed interface LayerRangeOperation {
    data class Add(val minZMm: Double, val maxZMm: Double) : LayerRangeOperation
    data class Edit(val fromMinZMm: Double, val fromMaxZMm: Double, val minZMm: Double, val maxZMm: Double) : LayerRangeOperation
    data class Split(val splitZMm: Double) : LayerRangeOperation
    /** With the range below ([previous]) or above. */
    data class Merge(val previous: Boolean) : LayerRangeOperation
    data object Delete : LayerRangeOperation
}

/** An operation's words: [pending] while it runs, [success] once the project took it. */
data class LayerRangeMessages(val pending: String, val success: String)

/**
 * The browser's semantic editor's height ranges in the shared core
 * (`orcaxr_project::layer_range_editor`, from `layerRangeEditor.ts`): typed
 * bounds and split heights checked as the browser checks them, heights written
 * as `Intl.NumberFormat` rounds them, and each operation's words.
 */
object LayerRangeEditors {
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }
    private fun number(value: Double): String {
        require(value.isFinite()) { "invalid_request" }
        return value.toString()
    }
    private fun merge(obj: ProjectJsonObject) = LayerRangeMerge(
        obj.get("allowed") as Boolean,
        if (has(obj, "otherRangeId")) obj.get("otherRangeId") as String else null,
        if (has(obj, "reason")) obj.get("reason") as String else null,
    )

    internal fun projection(json: String): LayerRangeProjection? {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        val obj = reply.get("projection") as? ProjectJsonObject ?: return null
        val ranges = obj.get("layerRanges") as ProjectJsonArray
        val selected = if (has(obj, "selectedLayerRange")) obj.get("selectedLayerRange") as ProjectJsonObject else null
        return LayerRangeProjection(
            obj.get("objectId") as String,
            obj.get("objectName") as String,
            List(ranges.length()) { index ->
                val range = ranges.get(index) as ProjectJsonObject
                LayerRangeEntry(range.get("id") as String, range.get("minZMm") as Double, range.get("maxZMm") as Double, range.get("label") as String)
            },
            selected?.let {
                LayerRangeSelection(it.get("id") as String, merge(it.get("mergePrevious") as ProjectJsonObject), merge(it.get("mergeNext") as ProjectJsonObject))
            },
        )
    }

    private fun check(json: String, keys: List<String>): LayerRangeCheck {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return if (obj.get("valid") as Boolean) LayerRangeCheck.Valid(keys.map { obj.get(it) as Double })
        else LayerRangeCheck.Invalid(obj.get("message") as String)
    }

    /** Typed bounds for a new range, or [excludedId]'s new bounds, among [ranges]: valid as `[minZMm, maxZMm]`, or why not. */
    fun bounds(rawMin: String, rawMax: String, ranges: List<LayerRangeEntry>, excludedId: String? = null): LayerRangeCheck {
        val list = ranges.joinToString(",", "[", "]") {
            "{\"id\":${CanonicalJson.quote(it.id)},\"maxZMm\":${number(it.maxZMm)},\"minZMm\":${number(it.minZMm)}}"
        }
        val request = "{\"excludedId\":${excludedId?.let(CanonicalJson::quote) ?: "null"},\"ranges\":$list," +
            "\"rawMax\":${CanonicalJson.quote(rawMax)},\"rawMin\":${CanonicalJson.quote(rawMin)}}"
        return check(NativeProject.layerRangeBounds(request), listOf("minZMm", "maxZMm"))
    }

    /** A typed split height strictly inside [range]: valid as `[splitZMm]`, or why not. */
    fun split(raw: String, range: LayerRangeEntry): LayerRangeCheck {
        val request = "{\"maxZMm\":${number(range.maxZMm)},\"minZMm\":${number(range.minZMm)},\"raw\":${CanonicalJson.quote(raw)}}"
        return check(NativeProject.layerRangeSplit(request), listOf("splitZMm"))
    }

    /** What [operation] says while it runs and once it is done. */
    fun messages(operation: LayerRangeOperation): LayerRangeMessages {
        val request = when (operation) {
            is LayerRangeOperation.Add -> "{\"kind\":\"add\",\"maxZMm\":${number(operation.maxZMm)},\"minZMm\":${number(operation.minZMm)}}"
            is LayerRangeOperation.Edit -> "{\"fromMaxZMm\":${number(operation.fromMaxZMm)},\"fromMinZMm\":${number(operation.fromMinZMm)}," +
                "\"kind\":\"edit\",\"maxZMm\":${number(operation.maxZMm)},\"minZMm\":${number(operation.minZMm)}}"
            is LayerRangeOperation.Split -> "{\"kind\":\"split\",\"splitZMm\":${number(operation.splitZMm)}}"
            is LayerRangeOperation.Merge -> "{\"direction\":\"${if (operation.previous) "previous" else "next"}\",\"kind\":\"merge\"}"
            LayerRangeOperation.Delete -> "{\"kind\":\"delete\"}"
        }
        val obj = CanonicalJson.read(NativeProject.layerRangeMessages(request)) as ProjectJsonObject
        return LayerRangeMessages(obj.get("pending") as String, obj.get("success") as String)
    }
}
