package dev.orcaxr.core

/** A transform tool with numeric fields, titled as the browser's Tool Settings panel titles it. */
enum class TransformTool(internal val wire: String, val title: String) {
    MOVE("move", "Move (mm)"),
    ROTATE("rotate", "Rotate (deg)"),
    SCALE("scale", "Scale (%)"),
}

/** What a tool's three fields show: the values (NaN where JSON cannot carry one) and their texts. */
data class TransformFieldValues(val values: List<Double>, val texts: List<String>)

/** What an edit of a tool's three fields submits. */
sealed interface TransformFieldEdit {
    /** One `setInstanceTransform(s)` intent's changes: the primary alone, or the selection carried around it. */
    data class Changes(val changes: List<ProjectIntents.InstanceTransform>) : TransformFieldEdit
    /** The workspace's refusal, in its words (a zero scale, a non-finite value, a zero rotation). */
    data class Refused(val message: String) : TransformFieldEdit
}

/**
 * The transform inspector's fields as the browser's Tool Settings panel has
 * them (`TransformFields.ts`, in the shared core as
 * `orcaxr_project::placement::fields`): Move shows millimetres, Rotate the
 * degrees of three.js's XYZ Euler angles, Scale percent, each with two
 * decimals; an edit reads each field with `parseFloat` (unreadable text as 0)
 * and sets the primary instance's translation, rotation or scale, carrying the
 * rest of the selection around it. Transforms are canonical
 * `ProjectIntents.Transform`s, rotations quaternions `[x, y, z, w]`.
 */
object TransformFields {
    private fun units(text: List<Int>) = String(CharArray(text.size) { text[it].toChar() })
    private fun number(value: Double): String {
        require(value.isFinite()) { "invalid_request" }
        return value.toString()
    }
    private fun numbers(values: List<Double>) = values.joinToString(",", "[", "]", transform = ::number)
    private fun transform(t: ProjectIntents.Transform) =
        "{\"rotation\":${numbers(t.rotation)},\"scale\":${numbers(t.scale)},\"translationMm\":${numbers(t.translationMm)}}"
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as? Double ?: Double.NaN } }
    private fun transformOf(value: ProjectJsonObject) =
        ProjectIntents.Transform(doubles(value.get("translationMm")), doubles(value.get("rotation")), doubles(value.get("scale")))

    /** What [tool]'s three fields show for [transform]. */
    fun values(tool: TransformTool, transform: ProjectIntents.Transform): TransformFieldValues {
        val reply = CanonicalJson.read(NativeProject.transformFields("{\"tool\":\"${tool.wire}\",\"transform\":${transform(transform)}}")) as ProjectJsonObject
        val texts = reply.get("texts") as ProjectJsonArray
        return TransformFieldValues(doubles(reply.get("values")), List(texts.length()) { texts.get(it) as String })
    }

    /**
     * What an edit of [tool]'s three field [texts] submits for the selection
     * [origins] (each instance with its transform before the edit), whose
     * primary is [primaryInstanceId].
     */
    fun edit(
        tool: TransformTool,
        texts: List<String>,
        origins: List<ProjectIntents.InstanceTransform>,
        primaryInstanceId: String,
    ): TransformFieldEdit {
        val request = "{\"origins\":" +
            origins.joinToString(",", "[", "]") { "{\"instanceId\":${CanonicalJson.quote(units(it.instanceId))},\"transform\":${transform(it.transform)}}" } +
            ",\"primaryInstanceId\":${CanonicalJson.quote(primaryInstanceId)}" +
            ",\"texts\":${texts.joinToString(",", "[", "]", transform = CanonicalJson::quote)}" +
            ",\"tool\":\"${tool.wire}\"}"
        val reply = CanonicalJson.read(NativeProject.transformFieldEdit(request)) as ProjectJsonObject
        if (reply.keys().asSequence().any { it == "error" }) return TransformFieldEdit.Refused(reply.get("message") as String)
        val changes = reply.get("changes") as ProjectJsonArray
        return TransformFieldEdit.Changes(
            List(changes.length()) { index ->
                val change = changes.get(index) as ProjectJsonObject
                ProjectIntents.InstanceTransform((change.get("instanceId") as String).map { it.code }, transformOf(change.get("transform") as ProjectJsonObject))
            },
        )
    }

    /** three's `Euler().setFromQuaternion`: the XYZ angles (radians) of [rotation] `[x, y, z, w]`, as given. */
    fun eulerRadians(rotation: List<Double>): List<Double> =
        doubles((CanonicalJson.read(NativeProject.transformRotation("{\"rotation\":${numbers(rotation)}}")) as ProjectJsonObject).get("eulerRadians"))

    /** three's `Quaternion().setFromEuler(...).normalize()`: the rotation `[x, y, z, w]` of XYZ angles in radians. */
    fun rotation(eulerRadians: List<Double>): List<Double> =
        doubles((CanonicalJson.read(NativeProject.transformRotation("{\"eulerRadians\":${numbers(eulerRadians)}}")) as ProjectJsonObject).get("rotation"))
}
