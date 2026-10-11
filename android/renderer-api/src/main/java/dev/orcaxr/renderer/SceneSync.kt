package dev.orcaxr.renderer

import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectPainter
import dev.orcaxr.core.ProjectWorkspace
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keeps a renderer's [ProjectScene] in step with a project session: on each
 * [request] it pages the session's render deltas from the snapshot it shows
 * to the current one, fetches and decodes the mesh packet of every asset the
 * draws newly need, drops meshes no draw uses, and reads every drawn volume's
 * paint facets of the [channel] shown into [ScenePaint], handing on only the
 * facets whose colour changed. Requests made while a sync runs collapse into
 * one more sync. A stroke's live preview ([preview]) changes paint alone.
 * Everything happens on one thread of its own; [deliver] hears each change
 * there.
 */
class SceneSync(
    private val workspace: ProjectWorkspace,
    private val deliver: (Update) -> Unit,
) : AutoCloseable {
    /**
     * What changed: meshes to upload (new or replaced), meshes no longer
     * used, every draw now, and the volumes whose paint changed.
     */
    data class Update(
        val meshes: Map<String, TriangleMesh>,
        val removed: Set<String>,
        val draws: List<ProjectScene.Draw>,
        val paint: List<PaintUpdate> = emptyList(),
    )

    companion object {
        private const val WAIT_S = 60L
    }

    private val thread = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "project-scene").also { it.isDaemon = true }
    }
    private val scene = ProjectScene()
    private val painter = ProjectPainter(workspace)
    private val paint = ScenePaint()
    private val meshes = LinkedHashMap<String, TriangleMesh>()
    private val queued = AtomicBoolean(false)
    @Volatile private var closed = false
    @Volatile private var shown = PaintChannel.COLOR

    /** The paint channel drawn: colour, or the channel the active paint tool authors. */
    var channel: PaintChannel
        get() = shown
        set(value) {
            if (value == shown) return
            shown = value
            request()
        }

    /** Syncs to the session's current snapshot soon; a sync already queued covers this one. */
    fun request() {
        if (closed || !queued.compareAndSet(false, true)) return
        runCatching {
            thread.execute {
                queued.set(false)
                if (!closed) runCatching(::sync)
            }
        }
    }

    /**
     * A stroke's live preview on [volumeId] ([data] null ends it); a refined
     * one ([hideCanonical]) hides the canonical paint while it shows. Applied
     * in order with syncs, so a preview never outlives the commit that ends it.
     */
    fun preview(volumeId: String, data: PaintFacetData?, hideCanonical: Boolean = false) {
        runCatching {
            thread.execute {
                if (closed) return@execute
                val update = paint.preview(volumeId, data, hideCanonical) ?: return@execute
                deliver(Update(emptyMap(), emptySet(), scene.draws(), listOf(update)))
            }
        }
    }

    /** Hands [to] everything known now — every mesh, draw and painted volume — on the sync thread, for a renderer made afresh. */
    fun snapshot(to: (Update) -> Unit) {
        runCatching { thread.execute { if (!closed) to(Update(LinkedHashMap(meshes), emptySet(), scene.draws(), paint.everything())) } }
    }

    private fun sync() {
        var start = 0L
        var target: ProjectIntents.RenderCursor? = null
        while (!closed) {
            val page = try {
                workspace.render(scene.request(start, target)).get(WAIT_S, TimeUnit.SECONDS)
            } catch (failure: Exception) {
                // A target the session no longer holds: page toward its current snapshot instead.
                if (target == null) throw failure
                target = null
                start = 0
                continue
            }
            target = page.target
            start = scene.apply(page, start) ?: break
        }
        if (closed) return
        val draws = scene.draws()
        val wanted = scene.assets()
        val added = LinkedHashMap<String, TriangleMesh>()
        for (asset in wanted) {
            if (closed) return
            if (asset in meshes) continue
            val packet = workspace.meshPacket(asset).get(WAIT_S, TimeUnit.SECONDS)
            packet.use { source -> source.asSource()?.let { added[asset] = PacketMeshes.mesh(asset, it) { closed } } }
        }
        meshes.putAll(added)
        val removed = meshes.keys.filter { it !in wanted }.toSet()
        removed.forEach(meshes::remove)
        deliver(Update(added, removed, draws, paintOf(draws)))
    }

    /** Every drawn volume's paint of the channel shown, as the changes it makes. */
    private fun paintOf(draws: List<ProjectScene.Draw>): List<PaintUpdate> {
        // One per volume: its instances share its paint, mesh and colour.
        val volumes = draws.filter { it.assetId in meshes }.associateBy { it.volumeId }
        paint.retain(volumes.keys)
        if (volumes.isEmpty()) return emptyList()
        val ids = volumes.keys.toList()
        val captures = painter.facets(ids, shown).get(WAIT_S, TimeUnit.SECONDS)
        val updates = ArrayList<PaintUpdate>()
        ids.zip(captures).forEach { (volumeId, capture) ->
            val data = capture.getOrNull()?.use(PaintFacetData::read)
            val draw = volumes.getValue(volumeId)
            paint.canonical(volumeId, draw.assetId, meshes.getValue(draw.assetId), draw.argb, data)?.let(updates::add)
        }
        return updates
    }

    override fun close() {
        closed = true
        thread.shutdownNow()
    }
}
