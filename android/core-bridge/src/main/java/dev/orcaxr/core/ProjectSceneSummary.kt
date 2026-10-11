package dev.orcaxr.core

/**
 * What the Workspace's 3D view shows, for an accessibility service to say of
 * it: the active plate's name and how many objects stand on it, and what is
 * selected, by name. Read from the session's own [ProjectView] — its plates
 * and its selection — never from the renderer, so it says what the project
 * holds.
 *
 * [selected] names the selection in its own order (at most
 * [ProjectSceneSummary.MAX_NAMES]): an object or a part by its name, an
 * instance by its object's (the tree shows an instance under its object, and
 * a collapsed object hides it), each name once; [selection] counts the
 * session's selected entities.
 */
data class ProjectSceneSummary(
    val plate: String?,
    val objects: Int,
    val selected: List<String>,
    val selection: Long,
) {
    companion object {
        /** The most selected entities a view names. */
        const val MAX_NAMES = 8
        private const val MAX_PLATES = 4096L
        /** Objects, parts and instances keep their own order: no sort budget. */
        private const val UNSORTED = 0L

        fun of(view: ProjectView): ProjectSceneSummary {
            val plate = view.activePlate
            return ProjectSceneSummary(plate?.name, plate?.objects ?: 0, view.selectionNames, view.selection.total)
        }

        /**
         * The names of the selection [refs] from a captured project ([root]),
         * in their order, each once, at most [MAX_NAMES]: the project is walked
         * (plates, objects, their parts and instances) only until every ref is
         * found, and not at all for an empty selection.
         */
        internal fun names(root: ProjectQueryNode, refs: List<ProjectIntents.SelectionEntity>): List<String> {
            val objects = HashSet<String>()
            val volumes = HashSet<String>()
            val instances = HashSet<String>()
            for (ref in refs.take(MAX_NAMES)) when (ref) {
                is ProjectIntents.SelectionEntity.Object -> objects += text(ref.value)
                is ProjectIntents.SelectionEntity.Volume -> volumes += text(ref.value)
                is ProjectIntents.SelectionEntity.Instance -> instances += text(ref.value)
                else -> Unit
            }
            val wanted = objects.size + volumes.size + instances.size
            if (wanted == 0) return emptyList()
            val found = HashMap<String, String>()
            root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
                ProjectFacts.rows(plates) { position, _ ->
                    plates.node(position).use { plate ->
                        plate.children(QueryRelation.OBJECTS, UNSORTED).use { list ->
                            ProjectFacts.rows(list) { at, _ ->
                                list.node(at).use { node -> visitObject(node, objects, volumes, instances, found) }
                                found.size < wanted
                            }
                        }
                    }
                    found.size < wanted
                }
            }
            return refs.take(MAX_NAMES).mapNotNull { ref ->
                when (ref) {
                    is ProjectIntents.SelectionEntity.Object -> found["o:" + text(ref.value)]
                    is ProjectIntents.SelectionEntity.Volume -> found["v:" + text(ref.value)]
                    is ProjectIntents.SelectionEntity.Instance -> found["i:" + text(ref.value)]
                    else -> null
                }
            }.distinct()
        }

        private fun visitObject(
            node: ProjectQueryNode,
            objects: Set<String>,
            volumes: Set<String>,
            instances: Set<String>,
            found: MutableMap<String, String>,
        ) {
            val id = checkNotNull(ProjectFacts.text(node, QueryText.ID)) { "invalid_projection" }
            val name = ProjectFacts.text(node, QueryText.NAME).orEmpty()
            if (id in objects) found["o:$id"] = name
            for ((relation, wanted, prefix) in listOf(
                Triple(QueryRelation.INSTANCES, instances, "i:"),
                Triple(QueryRelation.VOLUMES, volumes, "v:"),
            )) {
                if (wanted.isEmpty()) continue
                node.children(relation, UNSORTED).use { children ->
                    ProjectFacts.rows(children) { index, _ ->
                        children.node(index).use { child ->
                            val childId = checkNotNull(ProjectFacts.text(child, QueryText.ID)) { "invalid_projection" }
                            if (childId in wanted) {
                                // An instance is its object; a part is its own name.
                                found[prefix + childId] = if (prefix == "i:") name else ProjectFacts.text(child, QueryText.NAME).orEmpty()
                            }
                        }
                        true
                    }
                }
            }
        }

        private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    }
}
