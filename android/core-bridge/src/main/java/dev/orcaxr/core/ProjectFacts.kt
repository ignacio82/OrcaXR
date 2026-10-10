package dev.orcaxr.core

/** One plate as a captured project lists it, in the plates' own order. [name] is as authored (possibly empty). */
internal data class PlateFacts(
    val id: String,
    val name: String,
    val order: Double,
    val printable: Boolean,
    val active: Boolean,
    val objects: Int,
)

/** One instance of a captured project, with what an edit of it needs to know about its object. */
internal data class InstanceFacts(
    val id: String,
    val plateId: String,
    val objectId: String,
    val printable: Boolean,
    /** The owning object's instance, volume and layer-range counts. */
    val objectInstances: Int,
    val objectVolumes: Int,
    val objectRanges: Int,
)

/**
 * Facts the workspace's edits read from a captured project through the
 * query projection (`ProjectSnapshot.query`), as the browser's controller
 * reads its state before building an intent: the plates in order, and the
 * instances of the project or of one plate in project order (plates, their
 * objects, each object's instances). Reads run where the snapshot was
 * captured — on the actor's authority for an edit's plan — and close every
 * handle they open.
 */
internal object ProjectFacts {
    private const val MAX_PLATES = 4096L
    /** Objects and instances keep their own order: no sort budget. */
    private const val UNSORTED = 0L

    /** The whole of [field] of [node], read in bounded chunks; null when the node has none. */
    fun text(node: ProjectQueryNode, field: QueryText): String? {
        val length = node.textLength(field) ?: return null
        val out = StringBuilder(length.toInt())
        var start = 0L
        while (start < length) {
            val chunk = node.text(field, start, minOf(ProjectQuery.MAX_TEXT_CHUNK_UNITS.toLong(), length - start))
            check(chunk.isNotEmpty()) { "invalid_projection" }
            out.append(chunk)
            start += chunk.size
        }
        return out.toString()
    }

    /** Every row of [list] with its node, page by page; [visit] answers false to stop. */
    private fun rows(list: ProjectQueryList, visit: (Long, QueryMetadata) -> Boolean) {
        val total = list.count()
        var start = 0L
        while (start < total) {
            val page = list.page(start, minOf(ProjectQuery.MAX_PAGE_ROWS.toLong(), total - start)).rows
            check(page.isNotEmpty()) { "invalid_projection" }
            for ((offset, row) in page.withIndex()) if (!visit(start + offset, row)) return
            start += page.size
        }
    }

    private fun count(row: QueryMetadata, field: QueryNumber) = (row.values[field] ?: 0.0).toInt()

    fun plates(root: ProjectQueryNode): List<PlateFacts> = root.children(QueryRelation.PLATES, MAX_PLATES).use { list ->
        buildList {
            rows(list) { position, row ->
                list.node(position).use { plate ->
                    add(
                        PlateFacts(
                            checkNotNull(text(plate, QueryText.ID)) { "invalid_projection" },
                            text(plate, QueryText.NAME).orEmpty(),
                            row.values[QueryNumber.ORDER] ?: 0.0,
                            row.values[QueryNumber.PRINTABLE] == 1.0,
                            row.values[QueryNumber.ACTIVE] == 1.0,
                            count(row, QueryNumber.OBJECT_COUNT),
                        ),
                    )
                }
                true
            }
        }
    }

    /**
     * The instances of the project (or of plate [plateId] alone), in project
     * order; [stop] ends the walk early once it answers true for one found.
     */
    fun instances(root: ProjectQueryNode, plateId: String? = null, stop: (InstanceFacts) -> Boolean = { false }): List<InstanceFacts> {
        val found = ArrayList<InstanceFacts>()
        root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
            rows(plates) { position, _ ->
                plates.node(position).use { plate ->
                    val id = checkNotNull(text(plate, QueryText.ID)) { "invalid_projection" }
                    if (plateId != null && id != plateId) return@use true
                    plate.children(QueryRelation.OBJECTS, UNSORTED).use { objects ->
                        var going = true
                        rows(objects) { at, object_ ->
                            val instances = count(object_, QueryNumber.INSTANCE_COUNT)
                            if (instances > 0) objects.node(at).use { node ->
                                val objectId = checkNotNull(text(node, QueryText.ID)) { "invalid_projection" }
                                node.children(QueryRelation.INSTANCES, UNSORTED).use { list ->
                                    rows(list) { index, instance ->
                                        val facts = list.node(index).use { item ->
                                            InstanceFacts(
                                                checkNotNull(text(item, QueryText.ID)) { "invalid_projection" },
                                                id, objectId, instance.values[QueryNumber.PRINTABLE] == 1.0,
                                                instances, count(object_, QueryNumber.VOLUME_COUNT), count(object_, QueryNumber.RANGE_COUNT),
                                            )
                                        }
                                        found += facts
                                        going = !stop(facts)
                                        going
                                    }
                                }
                            }
                            going
                        }
                        going
                    }
                }
            }
        }
        return found
    }

    /** One instance by its ID, or null. */
    fun instance(root: ProjectQueryNode, id: String): InstanceFacts? = instances(root) { it.id == id }.lastOrNull()?.takeIf { it.id == id }
}
