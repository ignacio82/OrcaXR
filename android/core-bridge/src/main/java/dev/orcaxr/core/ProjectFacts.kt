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

/** One volume of a captured project as the model tools read it: whether it is a model part, its mesh's identity and its transform inside its object. */
internal data class VolumeFacts(
    val id: String,
    val model: Boolean,
    val assetId: String,
    val triangleCount: Long,
    val topologyRevision: Double,
    val transform: ProjectIntents.Transform,
)

/** One object of a captured project with its instances' transforms and its volumes, each in the object's order. */
internal data class ObjectFacts(
    val id: String,
    val plateId: String,
    val instances: List<Pair<String, ProjectIntents.Transform>>,
    val volumes: List<VolumeFacts>,
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
    /** `VolumeRole::Model`'s index in the query projection's role. */
    private const val MODEL_ROLE = 0.0

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
    internal fun rows(list: ProjectQueryList, visit: (Long, QueryMetadata) -> Boolean) {
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

    /**
     * Every object of the project (or of plate [plateId] alone) in project
     * order — plates in their list's order, then each plate's objects — with
     * its instances' IDs and transforms and its volumes.
     */
    fun objects(root: ProjectQueryNode, plateId: String? = null): List<ObjectFacts> {
        val found = ArrayList<ObjectFacts>()
        root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
            rows(plates) { position, _ ->
                plates.node(position).use { plate ->
                    val id = checkNotNull(text(plate, QueryText.ID)) { "invalid_projection" }
                    if (plateId == null || id == plateId) plate.children(QueryRelation.OBJECTS, UNSORTED).use { objects ->
                        rows(objects) { at, _ ->
                            objects.node(at).use { node ->
                                val objectId = checkNotNull(text(node, QueryText.ID)) { "invalid_projection" }
                                val instances = node.children(QueryRelation.INSTANCES, UNSORTED).use { list ->
                                    buildList {
                                        rows(list) { index, row ->
                                            val instanceId = list.node(index).use { checkNotNull(text(it, QueryText.ID)) { "invalid_projection" } }
                                            add(instanceId to ProjectInspection.transform(row))
                                            true
                                        }
                                    }
                                }
                                val volumes = node.children(QueryRelation.VOLUMES, UNSORTED).use { list ->
                                    buildList {
                                        rows(list) { index, row ->
                                            add(
                                                list.node(index).use { volume ->
                                                    VolumeFacts(
                                                        checkNotNull(text(volume, QueryText.ID)) { "invalid_projection" },
                                                        row.values[QueryNumber.ROLE] == MODEL_ROLE,
                                                        checkNotNull(text(volume, QueryText.ASSET_ID)) { "invalid_projection" },
                                                        (row.values[QueryNumber.TRIANGLE_COUNT] ?: 0.0).toLong(),
                                                        row.values[QueryNumber.TOPOLOGY_REVISION] ?: 0.0,
                                                        ProjectInspection.transform(row),
                                                    )
                                                },
                                            )
                                            true
                                        }
                                    }
                                }
                                found += ObjectFacts(objectId, id, instances, volumes)
                            }
                            true
                        }
                    }
                }
                true
            }
        }
        return found
    }

    /**
     * The model parts the selection [refs] takes on the active plate — the
     * browser's `paintableSelectedVolumes`, what it paints, erases, simplifies
     * and repairs: the selected parts, the parts of selected objects and of
     * selected instances' objects, or every model part on the plate when no
     * part or object is selected and no instance stands for one. Each once,
     * in the plate's order (its instances, each one's object's parts); helper
     * volumes are never taken.
     */
    fun selectedModelParts(root: ProjectQueryNode, refs: List<ProjectIntents.SelectionEntity>): List<VolumeFacts> {
        fun id(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
        val parts = refs.mapNotNullTo(HashSet()) { (it as? ProjectIntents.SelectionEntity.Volume)?.value?.let(::id) }
        val objects = refs.mapNotNullTo(HashSet()) { (it as? ProjectIntents.SelectionEntity.Object)?.value?.let(::id) }
        val instances = refs.mapNotNullTo(HashSet()) { (it as? ProjectIntents.SelectionEntity.Instance)?.value?.let(::id) }
        val plate = plates(root).firstOrNull { it.active } ?: return emptyList()
        val placed = objects(root, plate.id).filter { object_ -> object_.instances.isNotEmpty() && object_.volumes.any { it.model } }
        // An instance shares its object's parts.
        for (object_ in placed) if (object_.instances.any { (instanceId, _) -> instanceId in instances }) objects += object_.id
        val everything = parts.isEmpty() && objects.isEmpty()
        val found = LinkedHashMap<String, VolumeFacts>()
        for (object_ in placed) for (volume in object_.volumes) {
            if (volume.model && (everything || volume.id in parts || object_.id in objects)) found.putIfAbsent(volume.id, volume)
        }
        return found.values.toList()
    }

    /** One instance by its ID, or null. */
    fun instance(root: ProjectQueryNode, id: String): InstanceFacts? = instances(root) { it.id == id }.lastOrNull()?.takeIf { it.id == id }

    /**
     * Object [objectId]'s query node (the caller's to close; it outlives
     * [root]), or null: what a copy captures for the clipboard.
     */
    fun objectNode(root: ProjectQueryNode, objectId: String): ProjectQueryNode? = root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
        var found: ProjectQueryNode? = null
        rows(plates) { position, _ ->
            plates.node(position).use { plate ->
                plate.children(QueryRelation.OBJECTS, UNSORTED).use { objects ->
                    rows(objects) { at, _ ->
                        val node = objects.node(at)
                        if (text(node, QueryText.ID) == objectId) found = node else node.close()
                        found == null
                    }
                }
            }
            found == null
        }
        found
    }

    /** Instance [instanceId]'s own name (none when it has none or is not in the project). */
    fun instanceName(root: ProjectQueryNode, instanceId: String): String? = root.children(QueryRelation.PLATES, MAX_PLATES).use { plates ->
        var name: String? = null
        var found = false
        rows(plates) { position, _ ->
            plates.node(position).use { plate ->
                plate.children(QueryRelation.OBJECTS, UNSORTED).use { objects ->
                    rows(objects) { at, row ->
                        if (count(row, QueryNumber.INSTANCE_COUNT) > 0) objects.node(at).use { node ->
                            node.children(QueryRelation.INSTANCES, UNSORTED).use { list ->
                                rows(list) { index, _ ->
                                    list.node(index).use { item ->
                                        if (text(item, QueryText.ID) == instanceId) {
                                            found = true
                                            name = text(item, QueryText.NAME)
                                        }
                                    }
                                    !found
                                }
                            }
                        }
                        !found
                    }
                }
            }
            !found
        }
        name
    }
}
