package dev.orcaxr.renderer

import dev.orcaxr.core.ProjectIntents

/**
 * The renderer's view of a project, kept by applying the session's render
 * deltas (`ProjectSession.render`, the browser's `renderProjection.ts`): the
 * plates, the instances and — once per object — the volumes, each record
 * replaced or removed by its id. A host pages toward a target snapshot with
 * [request] and [apply], then asks for the next delta from the snapshot it
 * applied ([cursor]). A page answered from empty (no base) tells the host to
 * rebuild: the scene clears and pages the target from empty.
 */
class ProjectScene {
    /** One volume placed by one instance of its object: what a renderer draws. */
    data class Draw(
        val key: String,
        val plateId: String,
        val instanceId: String,
        val objectId: String,
        val volumeId: String,
        val assetId: String,
        val role: ProjectIntents.VolumeRoleName,
        /** The instance's transform after the volume's: the volume placed inside its instance. */
        val transform: ModelTransform,
        val argb: Int,
        val printable: Boolean,
    )

    companion object {
        /** The browser surface's default material, for a volume no tool colours. */
        const val DEFAULT_ARGB = 0xffb8bec8.toInt()
        /** The most changes the session answers in one page. */
        const val PAGE = 64L
        private val HEX = Regex("#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})")

        /** A volume's resolved display colour (`#rgb` or `#rrggbb`, as the browser's three.js reads it) as opaque ARGB. */
        fun color(text: String?): Int {
            val hex = text?.let { HEX.matchEntire(it) }?.groupValues?.get(1) ?: return DEFAULT_ARGB
            val rgb = if (hex.length == 3) hex.map { "$it$it" }.joinToString("").toInt(16) else hex.toInt(16)
            return (0xff000000.toInt()) or rgb
        }

        private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    }

    private val plates = LinkedHashMap<String, ProjectIntents.RenderPlate>()
    private val instances = LinkedHashMap<String, ProjectIntents.RenderInstance>()
    private val volumes = LinkedHashMap<String, ProjectIntents.RenderVolume>()
    /** Set while a target is paged from empty: its pages apply to no base. */
    private var rebuilding = false

    /** The snapshot fully applied; null before the first one. */
    var cursor: ProjectIntents.RenderCursor? = null
        private set

    /**
     * The request for the page starting at [start] toward [target] (the
     * session's acknowledged snapshot when null). Later pages toward one
     * target must name the target the first page answered (`page.target`):
     * the session keeps paging that snapshot even after newer edits.
     */
    fun request(start: Long, target: ProjectIntents.RenderCursor?): ProjectIntents.RenderRequest {
        val base = cursor.takeUnless { rebuilding }
        return ProjectIntents.RenderRequest(
            base?.let { ProjectIntents.OptionalRenderCursor.Value(it) } ?: ProjectIntents.OptionalRenderCursor.Absent(ProjectIntents.Empty),
            target?.let { ProjectIntents.OptionalRenderCursor.Value(it) } ?: ProjectIntents.OptionalRenderCursor.Absent(ProjectIntents.Empty),
            start, PAGE,
        )
    }

    private fun clear() {
        plates.clear()
        instances.clear()
        volumes.clear()
    }

    /**
     * Applies one page whose changes begin at [start] of `page.total`.
     * Answers the next start to request toward `page.target`, or null once
     * the target is fully applied (it is then the [cursor]). A page with no
     * base — the session no longer holds this scene's — rebuilds from empty;
     * one whose base is another snapshot than this scene's answers 0, to page
     * the target again from empty.
     */
    fun apply(page: ProjectIntents.RenderPage, start: Long): Long? {
        require(start >= 0 && start <= page.total) { "Page start outside the delta" }
        when (val base = page.base) {
            is ProjectIntents.OptionalRenderCursor.Absent -> if (start == 0L) {
                clear()
                rebuilding = true
            } else if (!rebuilding && cursor != null) {
                // A later page answered from empty after earlier ones applied to a base: start over.
                clear()
                rebuilding = true
                return 0
            }
            is ProjectIntents.OptionalRenderCursor.Value -> if (rebuilding || base.value != cursor) {
                clear()
                rebuilding = true
                return 0
            }
        }
        for (change in page.changes) when (change) {
            is ProjectIntents.RenderChange.Plate -> plates[text(change.value.plateId)] = change.value
            is ProjectIntents.RenderChange.Instance -> instances[text(change.value.instanceId)] = change.value
            is ProjectIntents.RenderChange.Volume -> volumes[text(change.value.volumeId)] = change.value
            is ProjectIntents.RenderChange.RemovePlate -> plates.remove(text(change.value))
            is ProjectIntents.RenderChange.RemoveInstance -> instances.remove(text(change.value))
            is ProjectIntents.RenderChange.RemoveVolume -> volumes.remove(text(change.value))
        }
        val next = start + page.changes.size
        if (next < page.total) return next
        cursor = page.target
        rebuilding = false
        return null
    }

    /**
     * What the active plate shows: each of its instances (in the order they
     * arrived) placing each volume of its object (in the order they arrived).
     * Every volume role is drawn, as the browser draws them; none without an
     * active plate.
     */
    fun draws(): List<Draw> {
        val plate = plates.values.filter { it.active }.minByOrNull { it.order } ?: return emptyList()
        val plateId = text(plate.plateId)
        val byObject = volumes.values.groupBy { text(it.objectId) }
        return instances.values.filter { text(it.plateId) == plateId }.flatMap { instance ->
            val instanceId = text(instance.instanceId)
            val objectId = text(instance.objectId)
            val placed = ModelTransform.fromCanonical(instance.transform)
            byObject[objectId].orEmpty().map { volume ->
                val volumeId = text(volume.volumeId)
                Draw(
                    "$instanceId/$volumeId", plateId, instanceId, objectId, volumeId, text(volume.assetId), volume.role,
                    placed * ModelTransform.fromCanonical(volume.transform),
                    color((volume.color as? ProjectIntents.OptionalText.Value)?.let { text(it.value) }),
                    instance.printable,
                )
            }
        }
    }

    /** The mesh assets the current draws use. */
    fun assets(): Set<String> = draws().mapTo(LinkedHashSet()) { it.assetId }
}
