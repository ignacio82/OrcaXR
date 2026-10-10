package dev.orcaxr.core

/**
 * The six stock primitives (the browser's `add_primitive_*` actions, at
 * upstream's 20 mm `side`) and the helper-volume cube, as the shared core
 * builds them (`orcaxr_project::primitives`, three's generators exactly).
 */
enum class PrimitiveShape(internal val wire: String, val actionId: String?) {
    CUBE("cube", "add_primitive_cube"),
    CYLINDER("cylinder", "add_primitive_cylinder"),
    SPHERE("sphere", "add_primitive_sphere"),
    CONE("cone", "add_primitive_cone"),
    DISC("disc", "add_primitive_disc"),
    TORUS("torus", "add_primitive_torus"),
    HELPER_CUBE("helper-cube", null),
    ;

    companion object {
        /** The primitives the Add menu offers, in the browser's order. */
        val PRIMITIVES = listOf(CUBE, CYLINDER, SPHERE, CONE, DISC, TORUS)
        fun forAction(actionId: String): PrimitiveShape? = entries.firstOrNull { it.actionId == actionId }
    }
}

/** A helper volume's role and the action that adds it to the selected object (a negative volume has a flow of its own). */
enum class HelperVolumeRole(internal val wire: String, val actionId: String?) {
    MODIFIER("parameter-modifier", "add_modifier"),
    SUPPORT_ENFORCER("support-enforcer", "add_support_enforcer"),
    SUPPORT_BLOCKER("support-blocker", "add_support_blocker"),
    NEGATIVE_VOLUME("negative-volume", null),
    ;

    companion object {
        fun forAction(actionId: String): HelperVolumeRole? = entries.firstOrNull { it.actionId == actionId }
    }
}

/** What a primitive becomes on a plate: the object record and its mesh's asset, both as canonical JSON. */
data class PrimitiveObjectPlan(
    val plateId: String,
    val objectJson: String,
    val assetJson: String,
    /** The project already held this mesh: the object shares that asset, and no payload travels. */
    val reusedAsset: Boolean,
    /** How many of the request's IDs the object took, in order (3 when the asset is shared). */
    val idsUsed: Int,
)

/** What a helper volume becomes: a part of [objectId], its record and asset as canonical JSON. */
data class HelperVolumePlan(val objectId: String, val volumeJson: String, val assetJson: String, val idsUsed: Int)

/** A plan, or the browser's refusal in its words (an unknown plate, nothing selected, a shared digest that is not this mesh). */
sealed interface PrimitivePlan<out T> {
    data class Planned<T>(val plan: T) : PrimitivePlan<T>
    data class Refused(val message: String) : PrimitivePlan<Nothing>
}

/**
 * New geometry as the browser creates it (`orcaxr_project::primitives`):
 * a shape's canonical mesh payload, and the requests a session plans — a
 * primitive centred on the bed and resting on it as an object of a plate (its
 * mesh shared with an asset the project holds when one matches), or a helper
 * volume as a part of the object the selection names. IDs are given in the
 * order the browser draws them; a plan answers how many it took.
 */
object Primitives {
    /** Upstream's `side`: a primitive's size (mm). */
    const val SIDE_MM = 20.0
    /** The helper-volume cube's edge (mm). */
    const val HELPER_SIZE_MM = 10.0
    /** The most IDs a plan takes: a primitive's asset, object, part and instance. */
    const val PRIMITIVE_IDS = 4
    const val HELPER_IDS = 2

    private fun number(value: Double): String {
        require(value.isFinite()) { "invalid_request" }
        return value.toString()
    }
    private fun ids(values: List<String>) = values.joinToString(",", "[", "]", transform = CanonicalJson::quote)

    /** The canonical mesh payload of [shape] at [sizeMm], as the browser stores it. */
    fun payload(shape: PrimitiveShape, sizeMm: Double = if (shape == PrimitiveShape.HELPER_CUBE) HELPER_SIZE_MM else SIDE_MM): ByteArray =
        NativeProject.primitivePayload("{\"kind\":\"${shape.wire}\",\"sizeMm\":${number(sizeMm)}}")

    /** The request a [ProjectSession.planPrimitiveObject] answers. */
    fun primitiveRequest(
        shape: PrimitiveShape,
        bedWidthMm: Double,
        bedDepthMm: Double,
        ids: List<String>,
        importedAt: String,
        plateId: String? = null,
        sizeMm: Double = SIDE_MM,
    ): String = "{\"bedMm\":[${number(bedWidthMm)},${number(bedDepthMm)}],\"ids\":${ids(ids)}" +
        ",\"importedAt\":${CanonicalJson.quote(importedAt)},\"kind\":\"${shape.wire}\"" +
        ",\"plateId\":${plateId?.let(CanonicalJson::quote) ?: "null"},\"sizeMm\":${number(sizeMm)}}"

    /** The request a [ProjectSession.planHelperVolume] answers: [primary] is the selection's primary ref. */
    fun helperRequest(
        role: HelperVolumeRole,
        primary: ProjectIntents.SelectionEntity?,
        ids: List<String>,
        sizeMm: Double = HELPER_SIZE_MM,
    ): String {
        fun ref(kind: String, units: List<Int>) = "{\"id\":${CanonicalJson.quote(String(CharArray(units.size) { units[it].toChar() }))},\"kind\":\"$kind\"}"
        val selected = when (primary) {
            null -> "null"
            is ProjectIntents.SelectionEntity.Project -> "{\"id\":\"\",\"kind\":\"project\"}"
            is ProjectIntents.SelectionEntity.Plate -> ref("plate", primary.value)
            is ProjectIntents.SelectionEntity.Object -> ref("object", primary.value)
            is ProjectIntents.SelectionEntity.Volume -> ref("volume", primary.value)
            is ProjectIntents.SelectionEntity.Instance -> ref("instance", primary.value)
            is ProjectIntents.SelectionEntity.LayerRange -> ref("layer-range", primary.value)
            is ProjectIntents.SelectionEntity.Filament -> ref("filament", primary.value)
        }
        return "{\"ids\":${ids(ids)},\"primary\":$selected,\"role\":\"${role.wire}\",\"sizeMm\":${number(sizeMm)}}"
    }

    private fun refusal(reply: ProjectJsonObject): String? =
        if (reply.keys().asSequence().any { it == "refusal" }) reply.get("refusal") as String else null

    /** A [ProjectSession.planPrimitiveObject] reply. */
    fun primitiveReply(json: String): PrimitivePlan<PrimitiveObjectPlan> {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        refusal(reply)?.let { return PrimitivePlan.Refused(it) }
        return PrimitivePlan.Planned(
            PrimitiveObjectPlan(
                reply.get("plateId") as String,
                reply.get("objectJson") as String,
                reply.get("assetJson") as String,
                reply.get("reusedAsset") as Boolean,
                (reply.get("idsUsed") as Double).toInt(),
            ),
        )
    }

    /** A [ProjectSession.planHelperVolume] reply. */
    fun helperReply(json: String): PrimitivePlan<HelperVolumePlan> {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        refusal(reply)?.let { return PrimitivePlan.Refused(it) }
        return PrimitivePlan.Planned(
            HelperVolumePlan(
                reply.get("objectId") as String,
                reply.get("volumeJson") as String,
                reply.get("assetJson") as String,
                (reply.get("idsUsed") as Double).toInt(),
            ),
        )
    }
}
