package dev.orcaxr.nativeapp.workspace

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintHit
import dev.orcaxr.core.PaintPlacement
import dev.orcaxr.core.PaintStrokeOutcome
import dev.orcaxr.core.PaintStrokeStep
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectPaintStroke
import dev.orcaxr.core.ProjectPainter
import dev.orcaxr.core.ProjectView
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.renderer.PaintFacetData
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.SceneSync
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * The Workspace's paint tool, as the browser's workspace paints: entered
 * through the core's `tool_paint` (or a channel's tool), its panel choices
 * ([PaintToolState]), and each gesture — opened where the finger first met a
 * model part, sampled on every move of the finger off the UI thread (moves
 * that arrive while one runs collapse into the latest, its dragged capsule
 * sweeping from the last sample), its preview drawn on the part, then
 * committed on release as one undoable step with the browser's label, or
 * cancelled. UI thread, except where noted.
 */
class PaintModel(private val host: Host) : AutoCloseable {
    /** What the painter needs from the project area. */
    interface Host {
        /** The project's workspace once started; null before. */
        fun workspace(): ProjectWorkspace?
        /** The renderer's scene sync once started; null before. */
        fun scene(): SceneSync?
        /** The project view now (its enabled actions). */
        fun view(): ProjectView
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "paint-stroke").also { it.isDaemon = true } }

    var state by mutableStateOf(PaintToolState())
        private set
    var palette by mutableStateOf<List<PaintRow>>(emptyList())
        private set
    var status by mutableStateOf<PaintStatus?>(null)
        private set

    /** Whether [action] (a catalogue ID) is enabled now, as the browser's registry gate allows it. */
    fun enabled(action: String) = host.view().actions[action]?.enabled == true

    /** Enters [channel]'s paint tool (`tool_paint`, `tool_support_paint`, …), when the core enables it. */
    fun start(channel: PaintChannel = PaintChannel.COLOR) {
        if (!enabled(channel.toolAction)) return
        val (next, said) = state.start(channel, palette)
        state = next
        status = said
        host.scene()?.channel = channel
        refreshPalette { rows ->
            // The first filament, once the palette is known, for a tool entered before it was.
            if (state.active && state.channel == PaintChannel.COLOR && state.filamentId == null && state.mode == PaintMode.PAINT) state = state.start(PaintChannel.COLOR, rows).first
        }
    }

    /** Leaves the paint tool: the Workspace draws colour paint again. */
    fun stop() {
        cancel()
        state = state.stop()
        status = null
        host.scene()?.channel = PaintChannel.COLOR
    }

    /** The panel's channel: painting switches to that channel's tool, as `configurePaint` does. */
    fun chooseChannel(channel: PaintChannel) {
        if (channel == state.channel) return
        start(channel)
    }

    fun chooseFilament(filamentId: String?) {
        val (next, said) = state.chooseFilament(filamentId, palette)
        state = next
        status = said
    }

    /** A hardware key `1`–`9` (`paint_select_filament_N`); answers whether a row took it. */
    fun chooseNumber(number: Int): Boolean {
        if (!enabled("paint_select_filament_$number")) return false
        val (next, said) = state.chooseNumber(number, palette) ?: return false
        state = next
        status = said
        return true
    }

    fun chooseTool(tool: PaintToolKind) {
        val (next, said) = state.chooseTool(tool)
        state = next
        status = said
    }

    fun chooseParameter(parameter: PaintParameter, value: Double) {
        state = state.chooseParameter(parameter, value)
    }

    fun chooseChannelState(value: ProjectIntents.PaintValueInput) {
        val (next, said) = state.chooseChannelState(value) ?: return
        state = next
        status = said
    }

    fun eraseChannel() {
        state = state.chooseMode(PaintMode.ERASE)
    }

    /** Erase all painting (`paint_erase_all`) of the channel on the selection's model parts (or the plate's). */
    fun eraseAll() {
        val workspace = host.workspace() ?: return
        if (!enabled("paint_erase_all")) return
        val channel = state.channel
        worker.execute {
            val said = try {
                when (val erased = ProjectPainter(workspace).eraseAll(channel).get()) {
                    null -> PaintStatus.EraseAllNeedsModel(channel)
                    else -> if (erased.cleared > 0) PaintStatus.ErasedAll(channel, erased.cleared) else PaintStatus.NothingPainted
                }
            } catch (failure: Exception) {
                PaintStatus.Failed(cause(failure).message ?: cause(failure).javaClass.simpleName)
            }
            main.post { status = said }
        }
    }

    /** Reads the palette off the UI thread and shows it; [then] runs with it on the UI thread. */
    fun refreshPalette(then: (List<PaintRow>) -> Unit = {}) {
        val workspace = host.workspace() ?: return
        worker.execute {
            val rows = runCatching { PaintRow.of(ProjectPainter(workspace).palette().get()) }.getOrNull() ?: return@execute
            main.post {
                palette = rows
                then(rows)
            }
        }
    }

    // ---- Gestures: opened, sampled and committed on the worker, in order ----

    /**
     * Where the finger met a draw: its key, part (and role), facet, the hit and
     * eye in the part's own millimetres, and where the part sits on the bed.
     */
    data class Touch(
        val key: String, val volumeId: String, val role: ProjectIntents.VolumeRoleName?,
        val facet: Int, val local: Point3, val eye: Point3, val placement: PaintPlacement? = null,
    )

    /** One gesture, owned by the worker once begun. */
    private class Gesture(val touch: Touch, val channel: PaintChannel, val target: ProjectIntents.PaintValueInput?, val state: PaintToolState) {
        var stroke: ProjectPaintStroke? = null
        var previous: Point3? = null
        var over = false
    }

    @Volatile private var gesture: Gesture? = null
    /** The latest move not yet sampled: moves arriving while one samples collapse into it. */
    private val latest = AtomicReference<Touch?>(null)

    /** The key of the draw the gesture in flight paints, so moves pick that part alone; null between gestures. */
    val painting: String? get() = gesture?.touch?.key

    /** A finger down on [touch] while the paint tool is active: opens a stroke there and samples it. False when not painting. */
    fun begin(touch: Touch): Boolean {
        if (!state.active || gesture != null) return false
        val workspace = host.workspace() ?: return false
        val started = Gesture(touch, state.channel, state.target(), state)
        gesture = started
        latest.set(null)
        val rows = palette
        worker.execute {
            val stroke = try {
                ProjectPainter(workspace).open(touch.volumeId, started.channel, started.target).get()
            } catch (failure: Exception) {
                val message = PaintFailures.open(cause(failure).message, touch.volumeId, touch.role, started.channel, started.target, rows)
                fail(started, message)
                return@execute
            }
            if (started.over && gesture !== started) {
                stroke.close()
                return@execute
            }
            started.stroke = stroke
            sample(started, touch)
        }
        return true
    }

    /** The finger moved over the gesture's part at [touch]. */
    fun move(touch: Touch) {
        val current = gesture ?: return
        if (latest.getAndSet(touch) != null) return
        worker.execute {
            val next = latest.getAndSet(null) ?: return@execute
            if (current.stroke != null && !current.over) sample(current, next)
        }
    }

    /** The finger lifted: the gesture commits as one step. */
    fun end() {
        val current = gesture ?: return
        gesture = null
        val workspace = host.workspace() ?: return
        worker.execute {
            current.over = true
            val stroke = current.stroke ?: return@execute
            val said = try {
                when (ProjectPainter(workspace).commit(stroke).get()) {
                    PaintStrokeOutcome.APPLIED ->
                        if (current.target == null) PaintStatus.Erased(current.channel) else PaintStatus.Painted(current.channel)
                    PaintStrokeOutcome.STALE -> PaintStatus.Failed("Facet annotation result is stale (project)")
                    else -> null
                }
            } catch (failure: Exception) {
                PaintStatus.Failed(cause(failure).message ?: cause(failure).javaClass.simpleName)
            } finally {
                stroke.close()
                current.stroke = null
                host.scene()?.preview(current.touch.volumeId, null)
                host.scene()?.request()
            }
            if (said != null) main.post { status = said }
        }
    }

    /** Escape: drops the gesture in flight; answers whether there was one. */
    fun escape(): Boolean = (gesture != null).also { if (it) cancel() }

    /** The gesture is dropped (Escape, a cancelled touch): nothing reaches the project. */
    fun cancel() {
        val current = gesture ?: return
        gesture = null
        worker.execute {
            current.over = true
            current.stroke?.close()
            current.stroke = null
            host.scene()?.preview(current.touch.volumeId, null)
        }
    }

    /** Worker: one sample at [touch] and its preview; a refusal ends the gesture with the browser's words. */
    private fun sample(current: Gesture, touch: Touch) {
        val stroke = current.stroke ?: return
        val hit = PaintHit(
            touch.facet.toLong(),
            listOf(touch.local.x, touch.local.y, touch.local.z),
            listOf(touch.eye.x, touch.eye.y, touch.eye.z),
            current.previous?.let { listOf(it.x, it.y, it.z) },
            // The core measures the brush and the band on the bed from the part's placement.
            touch.placement,
        )
        val step = try {
            stroke.sampleWith(hit, current.state.settings)
        } catch (failure: Exception) {
            fail(current, cause(failure).message ?: cause(failure).javaClass.simpleName)
            return
        }
        when (step) {
            is PaintStrokeStep.Refused -> fail(current, step.message)
            is PaintStrokeStep.Sampled -> {
                PaintFailures.sample(step.reply)?.let { message ->
                    fail(current, message)
                    return
                }
                current.previous = touch.local
                val refined = (step.reply as ProjectIntents.PaintStrokeSampleReply.Sampled).value.refined
                val preview = runCatching { stroke.previewFacets().use(PaintFacetData::read) }.getOrNull()
                host.scene()?.preview(touch.volumeId, preview, refined)
            }
        }
    }

    /** Worker: the browser's `Paint failed: …` and `cancelPaintStroke`. */
    private fun fail(current: Gesture, message: String) {
        current.over = true
        current.stroke?.close()
        current.stroke = null
        host.scene()?.preview(current.touch.volumeId, null)
        main.post {
            if (gesture === current) gesture = null
            status = PaintStatus.Failed(message)
        }
    }

    private fun cause(failure: Throwable): Throwable = if (failure is ExecutionException && failure.cause != null) cause(failure.cause!!) else failure

    override fun close() {
        gesture?.stroke?.close()
        worker.shutdownNow()
    }
}
