package dev.orcaxr.core

/** A role a part can hold, in upstream Orca's order (`ORCA_VOLUME_ROLE_ORDER`), with its canonical name. */
enum class VolumeRole(val wire: String, internal val intent: ProjectIntents.VolumeRoleName) {
    MODEL("model", ProjectIntents.VolumeRoleName.Model),
    NEGATIVE_VOLUME("negative-volume", ProjectIntents.VolumeRoleName.NegativeVolume),
    PARAMETER_MODIFIER("parameter-modifier", ProjectIntents.VolumeRoleName.ParameterModifier),
    SUPPORT_BLOCKER("support-blocker", ProjectIntents.VolumeRoleName.SupportBlocker),
    SUPPORT_ENFORCER("support-enforcer", ProjectIntents.VolumeRoleName.SupportEnforcer),
    ;

    companion object {
        fun of(wire: String): VolumeRole = entries.firstOrNull { it.wire == wire } ?: throw IllegalArgumentException("invalid_projection")
    }
}

/** What the conversion command decides for a part and a role (`VolumeRoleConversionDecision`). */
sealed interface VolumeRoleDecision {
    /** Accepted; a [noop] when the part already has the role. */
    data class Allowed(val noop: Boolean) : VolumeRoleDecision
    /** Refused, with the browser's code (`last-model-volume`, `facet-annotations`, …) and words. */
    data class Blocked(val code: String, val reason: String) : VolumeRoleDecision
}

/** One role the editor offers a part, in Orca's order: its name, whether it is the part's, and why not when it is not offered. */
data class VolumeRoleChoice(
    val role: VolumeRole,
    val label: String,
    val current: Boolean,
    val decision: VolumeRoleDecision,
    /** The editor's words for a choice it does not offer (the current role, or the command's refusal); null when it does. */
    val blockedReason: String?,
) {
    val offered: Boolean get() = blockedReason == null
}

/** One part's role and every role it could become, as the semantic editor shows them (`volumeRoleEditorProjection`). */
data class VolumeRoleProjection(
    val objectId: String,
    val objectName: String,
    val volumeId: String,
    val volumeName: String,
    val role: VolumeRole,
    /** `name — Role`, the section's summary line. */
    val summary: String,
    val choices: List<VolumeRoleChoice>,
)

/** A conversion's words: [pending] while it runs, [success] once the project took it. */
data class VolumeRoleMessages(val pending: String, val success: String)

/**
 * The browser's semantic editor's volume roles in the shared core
 * (`orcaxr_project::volume_role_editor`, from `volumeRoleEditor.ts`): a
 * part's role choices with the conversion command's decisions, and each
 * conversion's words.
 */
object VolumeRoleEditors {
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }

    internal fun decision(obj: ProjectJsonObject): VolumeRoleDecision =
        if (obj.get("allowed") as Boolean) VolumeRoleDecision.Allowed(obj.get("noop") as Boolean)
        else VolumeRoleDecision.Blocked(obj.get("code") as String, obj.get("reason") as String)

    /** A decision reply (`{"allowed",…}`). */
    internal fun decision(json: String): VolumeRoleDecision = decision(CanonicalJson.read(json) as ProjectJsonObject)

    /** A projection reply (`{"projection"}`); null for a part the project lacks. */
    internal fun projection(json: String): VolumeRoleProjection? {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        val obj = reply.get("projection") as? ProjectJsonObject ?: return null
        val choices = obj.get("choices") as ProjectJsonArray
        return VolumeRoleProjection(
            obj.get("objectId") as String,
            obj.get("objectName") as String,
            obj.get("volumeId") as String,
            obj.get("volumeName") as String,
            VolumeRole.of(obj.get("role") as String),
            obj.get("summary") as String,
            List(choices.length()) { index ->
                val choice = choices.get(index) as ProjectJsonObject
                VolumeRoleChoice(
                    VolumeRole.of(choice.get("role") as String),
                    choice.get("label") as String,
                    choice.get("current") as Boolean,
                    decision(choice.get("decision") as ProjectJsonObject),
                    if (has(choice, "blockedReason")) choice.get("blockedReason") as String else null,
                )
            },
        )
    }

    internal fun projectionRequest(volumeId: String) = "{\"volumeId\":${CanonicalJson.quote(volumeId)}}"
    internal fun decisionRequest(volumeId: String, role: String) =
        "{\"role\":${CanonicalJson.quote(role)},\"volumeId\":${CanonicalJson.quote(volumeId)}}"

    /** What converting the part named [volumeName] to [role] says while it runs and once it is done. */
    fun messages(volumeName: String, role: VolumeRole): VolumeRoleMessages {
        val request = "{\"role\":\"${role.wire}\",\"volumeName\":${CanonicalJson.quote(volumeName)}}"
        val obj = CanonicalJson.read(NativeProject.volumeRoleMessages(request)) as ProjectJsonObject
        return VolumeRoleMessages(obj.get("pending") as String, obj.get("success") as String)
    }
}
