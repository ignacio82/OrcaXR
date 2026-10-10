package dev.orcaxr.core

/**
 * The transform inspector of the selection, as the browser's Tool Settings
 * panel shows it for the Move, Rotate and Scale tools (`main.ts`
 * `updateToolSettings` over `OrcaWorkspace.getSelectedModelTransform`): the
 * primary selected instance's transform and what each tool's three fields
 * show for it ([TransformFields.values]). An edit of the fields
 * ([ProjectWorkspace.editTransform]) changes the [instances] the browser's
 * `captureSelectedInstanceOrigins` carries: the primary, and the rest of the
 * selection on its plate around it.
 */
data class ProjectInspector(
    val instanceId: String,
    val transform: ProjectIntents.Transform,
    /** How many instances an edit of the fields changes. */
    val instances: Int,
    val move: TransformFieldValues,
    val rotate: TransformFieldValues,
    val scale: TransformFieldValues,
) {
    /** What [tool]'s three fields show. */
    fun fields(tool: TransformTool): TransformFieldValues = when (tool) {
        TransformTool.MOVE -> move
        TransformTool.ROTATE -> rotate
        TransformTool.SCALE -> scale
    }
}

/**
 * What the inspector and its edits read from a captured project through the
 * query projection: instances' plates and transforms (`TX`…`SZ` of their
 * rows), and the browser's `captureSelectedInstanceOrigins` over a
 * selection. Reads run where the snapshot was captured and close every
 * handle they open.
 */
internal object ProjectInspection {
    private const val MAX_PLATES = 4096L
    /** Objects and instances keep their own order: no sort budget. */
    private const val UNSORTED = 0L

    /** The primary instance an edit acts on and the selection carried with it, each with its transform before the edit. */
    class Origins(val primary: String, val origins: List<ProjectIntents.InstanceTransform>)

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun units(text: String) = text.map { it.code }

    /** An instance's transform as its query row carries it: translation, quaternion `[x, y, z, w]`, scale. */
    fun transform(row: QueryMetadata): ProjectIntents.Transform {
        fun value(field: QueryNumber) = checkNotNull(row.values[field]) { "invalid_projection" }
        return ProjectIntents.Transform(
            listOf(value(QueryNumber.TX), value(QueryNumber.TY), value(QueryNumber.TZ)),
            listOf(value(QueryNumber.QX), value(QueryNumber.QY), value(QueryNumber.QZ), value(QueryNumber.QW)),
            listOf(value(QueryNumber.SX), value(QueryNumber.SY), value(QueryNumber.SZ)),
        )
    }

    /** The plate and transform of each of the [wanted] instances the project has, walking it in project order until all are found. */
    fun placed(root: ProjectQueryNode, wanted: Set<String>): Map<String, Pair<String, ProjectIntents.Transform>> {
        val found = HashMap<String, Pair<String, ProjectIntents.Transform>>()
        if (wanted.isEmpty()) return found
        fun going() = found.size < wanted.size
        root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
            ProjectFacts.rows(plates) { position, _ ->
                plates.node(position).use { plate ->
                    val plateId = checkNotNull(ProjectFacts.text(plate, QueryText.ID)) { "invalid_projection" }
                    plate.children(QueryRelation.OBJECTS, UNSORTED).use { objects ->
                        ProjectFacts.rows(objects) { at, object_ ->
                            if ((object_.values[QueryNumber.INSTANCE_COUNT] ?: 0.0) > 0) objects.node(at).use { node ->
                                node.children(QueryRelation.INSTANCES, UNSORTED).use { list ->
                                    ProjectFacts.rows(list) { index, instance ->
                                        val id = list.node(index).use { checkNotNull(ProjectFacts.text(it, QueryText.ID)) { "invalid_projection" } }
                                        if (id in wanted) found[id] = plateId to transform(instance)
                                        going()
                                    }
                                }
                            }
                            going()
                        }
                    }
                }
                going()
            }
        }
        return found
    }

    /**
     * The browser's `captureSelectedInstanceOrigins`: the primary instance and
     * the selected instances on its plate, in selection order (the primary
     * alone when it is not among [refs]), each with its transform; null when
     * the primary is not an instance the project has.
     */
    fun origins(root: ProjectQueryNode, refs: List<ProjectIntents.SelectionEntity>, primary: ProjectIntents.SelectionEntity?): Origins? {
        val primaryId = (primary as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text) ?: return null
        val selected = refs.mapNotNull { (it as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::text) }.distinct()
        val placed = placed(root, (selected + primaryId).toSet())
        val (plateId, _) = placed[primaryId] ?: return null
        val ids = if (primaryId in selected) selected else listOf(primaryId)
        val origins = ids.mapNotNull { id ->
            placed[id]?.takeIf { it.first == plateId }?.let { ProjectIntents.InstanceTransform(units(id), it.second) }
        }
        return Origins(primaryId, origins)
    }

    /** The inspector of [selection] in the project [root] describes; none without a primary instance. */
    fun inspector(root: ProjectQueryNode, selection: ProjectSelectionView): ProjectInspector? {
        val origins = origins(root, selection.refs, selection.primary) ?: return null
        val transform = origins.origins.first { text(it.instanceId) == origins.primary }.transform
        return ProjectInspector(
            origins.primary, transform, origins.origins.size,
            TransformFields.values(TransformTool.MOVE, transform),
            TransformFields.values(TransformTool.ROTATE, transform),
            TransformFields.values(TransformTool.SCALE, transform),
        )
    }
}
