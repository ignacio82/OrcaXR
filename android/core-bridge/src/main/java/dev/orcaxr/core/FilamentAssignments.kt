package dev.orcaxr.core

/**
 * Which filament each selected scope prints with and which filaments the
 * project offers, as the browser's assignment selector and selection
 * filament bar read them (`FilamentAssignment.ts`, in the shared core as
 * `orcaxr_project::filaments::assignment`): a captured project answers
 * ([ProjectSnapshot.filamentAssignment], [ProjectSnapshot.filamentAssignmentChanges]);
 * this file holds the values and their canonical JSON.
 */

/** An Objects-tree ref as the assignment reads it: a plate, object, part, instance or height range. */
data class FilamentRef(val kind: Kind, val id: String) {
    enum class Kind(internal val wire: String) { PLATE("plate"), OBJECT("object"), VOLUME("volume"), INSTANCE("instance"), LAYER_RANGE("layer-range") }

    companion object {
        /** The ref of a selection entity; none for the project or a filament, which the tree never selects. */
        fun of(entity: ProjectIntents.SelectionEntity): FilamentRef? {
            fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
            return when (entity) {
                is ProjectIntents.SelectionEntity.Plate -> FilamentRef(Kind.PLATE, text(entity.value))
                is ProjectIntents.SelectionEntity.Object -> FilamentRef(Kind.OBJECT, text(entity.value))
                is ProjectIntents.SelectionEntity.Volume -> FilamentRef(Kind.VOLUME, text(entity.value))
                is ProjectIntents.SelectionEntity.Instance -> FilamentRef(Kind.INSTANCE, text(entity.value))
                is ProjectIntents.SelectionEntity.LayerRange -> FilamentRef(Kind.LAYER_RANGE, text(entity.value))
                is ProjectIntents.SelectionEntity.Project, is ProjectIntents.SelectionEntity.Filament -> null
            }
        }
    }
}

/** One component of a mixed filament's recipe: a physical head and its weight. */
data class FilamentRecipeComponent(val filamentId: String, val name: String, val color: String, val weight: Double)

/**
 * A filament the project offers (`CanonicalFilamentOption`): a physical head
 * with its tool, preset and material, or a mixed recipe with its
 * distribution mode and components; disabled ones are listed, not offered.
 */
data class FilamentOption(
    val id: String,
    val mixed: Boolean,
    val name: String,
    val color: String,
    val enabled: Boolean,
    val material: String?,
    val presetId: String?,
    val toolId: Int?,
    val distributionMode: String?,
    val recipe: List<FilamentRecipeComponent>,
    val warnings: List<String>,
)

/**
 * A scope that can take a filament (`CanonicalFilamentAssignmentScope`): an
 * object, part or height range, labelled as the browser labels it, with its
 * own filament ([local]), its object's ([inherited]) and the one it prints
 * with ([effective]).
 */
data class FilamentScope(
    val entity: FilamentRef,
    val objectId: String,
    val label: String,
    val local: String?,
    val inherited: String?,
    val effective: String?,
)

/** What a selection can assign, what it cannot, and every filament offered. */
data class FilamentAssignment(
    val scopes: List<FilamentScope> = emptyList(),
    val unsupported: List<FilamentRef> = emptyList(),
    val options: List<FilamentOption> = emptyList(),
) {
    /** Whether a filament can be assigned now: scopes, and nothing selected that cannot take one (the bar's own rule). */
    val assignable: Boolean get() = scopes.isNotEmpty() && unsupported.isEmpty()
}

/** A resolution's answer: the assignment, or the browser's refusal of an entity the project lacks. */
sealed interface FilamentAssignmentResult {
    data class Resolved(val assignment: FilamentAssignment) : FilamentAssignmentResult
    data class Refused(val message: String) : FilamentAssignmentResult
}

/** The assignments a choice makes, or the controller's refusal in the browser's words. */
sealed interface FilamentAssignmentChanges {
    data class Changes(val assignments: List<ProjectIntents.FilamentAssignment>) : FilamentAssignmentChanges
    data class Refused(val message: String) : FilamentAssignmentChanges
}

object FilamentAssignments {
    private fun units(text: String) = text.map { it.code }
    private fun keys(value: ProjectJsonObject) = value.keys().asSequence().toSet()
    private fun optional(value: ProjectJsonObject, key: String) = if (key in keys(value)) value.get(key) as String else null
    private fun strings(value: Any) = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun <T> objects(value: Any, read: (ProjectJsonObject) -> T) =
        (value as ProjectJsonArray).let { list -> List(list.length()) { read(list.get(it) as ProjectJsonObject) } }

    private fun ref(value: ProjectJsonObject): FilamentRef {
        val kind = value.get("kind") as String
        return FilamentRef(FilamentRef.Kind.entries.first { it.wire == kind }, value.get("id") as String)
    }
    private fun refJson(ref: FilamentRef) = "{\"id\":${CanonicalJson.quote(ref.id)},\"kind\":${CanonicalJson.quote(ref.kind.wire)}}"

    /** `{"refs"}` for [refs]. */
    internal fun refsRequest(refs: List<FilamentRef>): String = refs.joinToString(",", "{\"refs\":[", "]}", transform = ::refJson)

    /** `{"entities","filamentId"}`: [entities] given [filamentId], null inheriting. */
    internal fun changesRequest(entities: List<FilamentRef>, filamentId: String?): String =
        entities.joinToString(",", "{\"entities\":[", "],\"filamentId\":${filamentId?.let(CanonicalJson::quote) ?: "null"}}", transform = ::refJson)

    /** A resolution reply. */
    internal fun resolution(json: String): FilamentAssignmentResult {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        if ("error" in keys(reply)) return FilamentAssignmentResult.Refused(reply.get("error") as String)
        return FilamentAssignmentResult.Resolved(
            FilamentAssignment(
                objects(reply.get("scopes")) { scope ->
                    FilamentScope(
                        ref(scope.get("entity") as ProjectJsonObject),
                        scope.get("objectId") as String,
                        scope.get("label") as String,
                        optional(scope, "localFilamentId"),
                        optional(scope, "inheritedFilamentId"),
                        optional(scope, "effectiveFilamentId"),
                    )
                },
                objects(reply.get("unsupportedSelection"), ::ref),
                objects(reply.get("options")) { option ->
                    FilamentOption(
                        option.get("id") as String,
                        option.get("kind") == "mixed",
                        option.get("name") as String,
                        option.get("color") as String,
                        option.get("enabled") as Boolean,
                        optional(option, "material"),
                        optional(option, "presetId"),
                        if ("toolId" in keys(option)) (option.get("toolId") as Double).toInt() else null,
                        optional(option, "distributionMode"),
                        objects(option.get("recipe")) { component ->
                            FilamentRecipeComponent(
                                component.get("filamentId") as String,
                                component.get("name") as String,
                                component.get("color") as String,
                                component.get("weight") as Double,
                            )
                        },
                        strings(option.get("warnings")),
                    )
                },
            ),
        )
    }

    /** A changes reply, as the intent's assignments. */
    internal fun changes(json: String): FilamentAssignmentChanges {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        if ("error" in keys(reply)) return FilamentAssignmentChanges.Refused(reply.get("error") as String)
        return FilamentAssignmentChanges.Changes(
            objects(reply.get("assignments")) { assignment ->
                val target = assignment.get("target") as ProjectJsonObject
                val objectId = units(target.get("objectId") as String)
                ProjectIntents.FilamentAssignment(
                    when (target.get("kind") as String) {
                        "object" -> ProjectIntents.AssignmentTarget.Object(ProjectIntents.ObjectTarget(objectId))
                        "volume" -> ProjectIntents.AssignmentTarget.Volume(ProjectIntents.VolumeTarget(objectId, units(target.get("volumeId") as String)))
                        else -> ProjectIntents.AssignmentTarget.LayerRange(ProjectIntents.LayerRangeTarget(objectId, units(target.get("layerRangeId") as String)))
                    },
                    (assignment.get("filamentId") as? String)?.let { ProjectIntents.OptionalId.Value(units(it)) }
                        ?: ProjectIntents.OptionalId.Absent(ProjectIntents.Empty),
                )
            },
        )
    }
}
