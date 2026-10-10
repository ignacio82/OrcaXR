package dev.orcaxr.nativeapp.preview

import android.app.Application
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.GcodeLayout
import dev.orcaxr.core.GcodePacket
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.core.GcodeRequests
import dev.orcaxr.core.GcodeSession
import dev.orcaxr.core.GcodeViewPacket
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.nativeapp.prepare.PrepareWords
import dev.orcaxr.renderer.GcodeIndexEntry
import dev.orcaxr.renderer.GcodeMoveFilter
import dev.orcaxr.renderer.GcodePreviewIndex
import dev.orcaxr.renderer.GcodePreviewPlan
import dev.orcaxr.renderer.GcodeWindow
import dev.orcaxr.renderer.ToolpathGeometry
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * One projection's toolpath for one opened file ([generation]). Compared by
 * identity: state changes never compare its buffers' contents.
 */
class PreviewToolpath(val geometry: ToolpathGeometry, val generation: Long)

/** One legend entry as the browser's panel lists it (`code · label`), with its colour. */
data class PreviewLegend(val code: String, val label: String, val accessibleLabel: String, val argb: Int)

/** What the Preview area shows: a projection of the shared G-code preview, never a parse of its own. */
data class PreviewState(
    val loading: Boolean = false,
    /** The file shown, by its display name. */
    val source: String? = null,
    val mode: String = "FeatureType",
    /** Inclusive layer bounds of the whole print, once a file is open. */
    val layerBounds: Pair<Int, Int>? = null,
    val layerRange: Pair<Int, Int>? = null,
    val singleLayer: Boolean = false,
    /** The shared inspection's selection: its label and the Z of its bottom and top layers. */
    val layerLabel: String? = null,
    val bottomZMm: Double? = null,
    val topZMm: Double? = null,
    val moves: Set<GcodeMoveFilter> = GcodeMoveFilter.defaults,
    val legend: List<PreviewLegend> = emptyList(),
    /** A numeric mode's value range, as the browser's panel writes it. */
    val range: String? = null,
    /** Why the chosen mode cannot be drawn for this file (the shared preview's missing metadata). */
    val unsupportedReason: String? = null,
    /** The source's layer count, from the shared index. */
    val layerCount: Int? = null,
    /** The browser's notices: the bounded-window notice first, then the shared views' limitations. */
    val limitations: List<String> = emptyList(),
    /** Whether only a bounded window is loaded, and whether earlier or later windows exist. */
    val windowed: Boolean = false,
    val hasPrevious: Boolean = false,
    val hasNext: Boolean = false,
    /** The toolpath to draw (none when the mode is unavailable), and which opened file is shown (a new one reframes the view). */
    val toolpath: PreviewToolpath? = null,
    val generation: Long = 0,
    /** For a plate Prepare sliced, the state of the project it came from; none for a file the operator opened. */
    val slice: ProjectRevision? = null,
)

/**
 * The Preview area's host adapter, as the browser's "Open G-code Viewer…":
 * it reads one G-code document (bounded) — one the operator picked, or a
 * plate Prepare sliced into the app's cache — hands it to the shared core's
 * `GcodeSession`, and publishes [PreviewState] projections of the shared
 * preview — every parse, projection and colour is the core's. A sliced plate
 * keeps the state of the project it came from and is withdrawn once the
 * project changes, as the browser withdraws stale output. All native work
 * runs on one worker thread; a new file closes the previous session.
 */
class PreviewModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "gcode-preview") }
    private val resolver = application.contentResolver
    /** View changes queued on the worker; only the last one is projected. */
    private val pending = AtomicInteger()

    var state by mutableStateOf(PreviewState())
        private set
    var message by mutableStateOf<String?>(null)
        private set

    // Worker-thread state: the session, its captured model and window, and the browser controller's view plan.
    private var session: GcodeSession? = null
    private var model: GcodePacket? = null
    private var loaded: GcodeWindow? = null
    private var plan: GcodePreviewPlan? = null
    private var layerCount = 0
    private var name: String? = null
    private var generation = 0L
    /** The shown slice's project state, and the latest one the project reported. */
    private var origin: ProjectRevision? = null
    private var latest: ProjectRevision? = null

    private fun work(task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (failure: Throwable) {
                val reason = if (failure is Refusal) failure.message else describe(failure.message ?: failure.javaClass.simpleName)
                main.post {
                    state = state.copy(loading = pending.get() > 0)
                    message = reason
                }
            }
        }
    }

    /** A refusal already worded for the viewer. */
    private class Refusal(override val message: String) : Exception(message)

    private fun describe(reason: String): String = when (reason) {
        "too_large" -> "That G-code file is larger than the ${MAX_BYTES / (1024 * 1024)} MB a preview on this device can read."
        "source_length" -> "That G-code file is too large to preview."
        "resource_limit" -> "That G-code needs more than the preview allows."
        "document_unavailable" -> "OrcaXR could not read that document."
        SEGMENT_BUDGET -> "These layers have more moves than the preview draws at once. Show fewer layers or hide some moves."
        // The browser's wording for a G-code it could not read.
        else -> "Could not read the G-code: $reason"
    }

    fun dismissMessage() {
        message = null
    }

    /** The document's display name and the size its provider declares, if any. */
    private fun document(uri: Uri): Pair<String, Long?> {
        val columns = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val (name, size) = try {
            resolver.query(uri, columns, null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) null
                else (if (cursor.isNull(0)) null else cursor.getString(0)) to (if (cursor.isNull(1)) null else cursor.getLong(1))
            }
        } catch (_: RuntimeException) {
            null
        } ?: (null to null)
        return (name ?: uri.lastPathSegment ?: "G-code") to size?.takeIf { it >= 0 }
    }

    /**
     * The document's bytes, refused past [MAX_BYTES] while reading. A declared
     * size only sizes the buffer (one copy when it is right); the stream decides.
     */
    private fun read(open: () -> InputStream, declared: Long?): ByteArray {
        if (declared != null && declared > MAX_BYTES) error("too_large")
        return open().use { stream ->
            var bytes = ByteArray(declared?.toInt() ?: READ_CHUNK)
            var size = 0
            while (true) {
                if (size == bytes.size) {
                    val next = stream.read()
                    if (next < 0) break
                    if (size >= MAX_BYTES) error("too_large")
                    bytes = bytes.copyOf(minOf(MAX_BYTES, maxOf(bytes.size * 2L, READ_CHUNK.toLong())).toInt())
                    bytes[size++] = next.toByte()
                }
                val count = stream.read(bytes, size, bytes.size - size)
                if (count < 0) break
                size += count
            }
            if (size == bytes.size) bytes else bytes.copyOf(size)
        }
    }

    /** A session holding the document's text, decoded as the browser decodes it; the text itself is not kept. */
    private fun feed(open: () -> InputStream, name: String, declared: Long?): GcodeSession {
        val units = GcodeSession.decodeUtf8(read(open, declared))
        if (units.all(Char::isWhitespace)) throw Refusal("$name is empty.")
        val opened = GcodeSession(units.size)
        try {
            var at = 0
            while (at < units.size) {
                val count = minOf(GcodeLayout.MAX_CHUNK_UNITS, units.size - at)
                opened.append(at, units.copyOfRange(at, at + count))
                at += count
            }
        } catch (failure: Throwable) {
            opened.close()
            throw failure
        }
        return opened
    }

    private fun text(units: Any?): String = (units as? JSONArray)?.let(GcodePacket::text) ?: ""

    /** Opens a G-code document in the viewer, replacing the one shown ("Open G-code file…"). */
    fun open(uri: Uri) = load(null) {
        val (shown, declared) = document(uri)
        Source(shown, declared) { resolver.openInputStream(uri) ?: throw FileNotFoundException("document_unavailable") }
    }

    /**
     * Opens the G-code Prepare sliced from the project at [revision] into
     * [file] (the app's cache), shown as [name]. Refused when the project
     * has changed since: stale output is never shown.
     */
    fun openSlice(file: File, name: String, revision: ProjectRevision) = load(revision) {
        if (latest != null && latest != revision) throw Refusal(PrepareWords.OUT_OF_DATE)
        Source(name, file.length()) { file.inputStream() }
    }

    /** The project is now at [revision]: a slice of any other state is withdrawn. */
    fun projectChanged(revision: ProjectRevision?) = worker.execute {
        latest = revision
        if (origin == null || origin == revision) return@execute
        session?.close()
        session = null; model = null; loaded = null; plan = null; origin = null
        main.post {
            state = PreviewState(loading = pending.get() > 0)
            message = PrepareWords.OUT_OF_DATE
        }
    }

    /** A document to read: its display name, the size it declares, and how to open it. */
    private class Source(val name: String, val declared: Long?, val open: () -> InputStream)

    /** Replaces the source shown with the one [source] names and opens, from the project at [slice] if a slice. */
    private fun load(slice: ProjectRevision?, source: () -> Source) {
        state = state.copy(loading = true)
        pending.incrementAndGet()
        work {
            try {
                // One source at a time: the previous one is released before the next is read.
                session?.close()
                session = null; model = null; loaded = null; plan = null; origin = null
                val document = source()
                val shown = document.name
                val opened = feed(document.open, shown, document.declared)
                try {
                    index(opened)
                } catch (failure: Throwable) {
                    opened.close()
                    throw failure
                }
                session = opened
                name = shown
                origin = slice
                generation++
            } catch (failure: Throwable) {
                pending.decrementAndGet()
                // Nothing of the previous file is left to show, and the new one never opened.
                main.post { state = PreviewState() }
                throw failure
            }
            pending.decrementAndGet()
            try {
                project()
            } catch (failure: Throwable) {
                main.post { state = PreviewState() }
                throw failure
            }
        }
    }

    /** Seals [opened], reads its index, and captures the first model when it is the whole print. */
    private fun index(opened: GcodeSession) {
        val sealed = opened.seal()
        val count = sealed.getInt("entryCount")
        if (count > MAX_INDEX_ENTRIES) error("resource_limit")
        val entries = ArrayList<GcodeIndexEntry>(count)
        while (entries.size < count) {
            val page = opened.page(entries.size, minOf(GcodeLayout.MAX_INDEX_PAGE_ENTRIES, count - entries.size))
            check(page.length() > 0) { "invalid_state" }
            for (n in 0 until page.length()) page.getJSONObject(n).let {
                entries += GcodeIndexEntry(it.getInt("layer"), it.getLong("recordsBefore"), it.getLong("pathPointsBefore"))
            }
        }
        val limits = sealed.getJSONObject("limits")
        val index = GcodePreviewIndex(
            entries, sealed.getLong("recordCount"), sealed.getLong("pathPointCount"), sealed.getBoolean("complete"),
            sealed.optString("terminationReason").ifEmpty { null }, limits.getLong("records"), limits.getLong("pathPoints"),
        )
        layerCount = sealed.getInt("layerCount")
        if (index.whole) {
            // A whole print's slider spans its model's layers, as the browser reads them.
            val whole = opened.whole()
            val layers = whole.column("columns", "layer").asIntBuffer()
            var low = Int.MAX_VALUE
            var high = Int.MIN_VALUE
            for (n in 0 until whole.recordCount) {
                low = minOf(low, layers[n])
                high = maxOf(high, layers[n])
            }
            plan = GcodePreviewPlan(index, if (whole.recordCount > 0) low to high else 0 to 0)
            model = whole
        } else {
            plan = GcodePreviewPlan(index)
        }
    }

    private fun windowOf(window: GcodeWindow?): GcodeRequests.Window =
        window?.let { GcodeRequests.Window.Entries(it.first.toLong(), it.last.toLong()) } ?: GcodeRequests.Window.Whole

    /** Asks the shared preview and inspection for the plan's view and publishes them with the toolpath. */
    private fun project() {
        val current = session ?: return
        val shown = plan ?: return
        if (model == null || shown.window != loaded) {
            val window = shown.window
            model = null
            model = if (window == null) current.whole() else current.window(window.first, window.last)
            loaded = window
        }
        val captured = checkNotNull(model)
        val view = shown.view
        val range = listOf(view.layerRange.first.toDouble(), view.layerRange.second.toDouble())
        val window = windowOf(loaded)
        val preview = current.view(captured, GcodeRequests.Preview(window, GcodeRequests.PreviewRequest(
            mode = view.mode, eventVisibility = GcodeMoveFilter.eventMask(view.moves), layerRange = range,
        )))
        val inspection = current.view(captured, GcodeRequests.Inspection(window, GcodeRequests.InspectionRequest(
            clampLayerRange = true, layerRange = range, singleLayer = view.singleLayer,
        )))
        val metadata = preview.metadata
        val ready = metadata.getString("status") == "ready"
        // A view with more moves than the renderer draws keeps its controls, so the viewer can narrow it.
        var undrawn: String? = null
        val toolpath = if (!ready) null else try {
            PreviewToolpath(ToolpathGeometry.from(captured, preview), generation)
        } catch (failure: IllegalArgumentException) {
            if (failure.message != SEGMENT_BUDGET) throw failure
            undrawn = describe(SEGMENT_BUDGET)
            null
        }
        val unsupportedReason = if (ready) null else metadata.getJSONArray("missingMetadata").let { missing ->
            (0 until missing.length()).joinToString(" ") { text(missing.getJSONObject(it).get("message")) }
        }
        val legend = if (!ready) emptyList() else metadata.getJSONArray("legend").let { entries ->
            (0 until minOf(entries.length(), MAX_LEGEND_SHOWN)).map { legendEntry(entries.getJSONObject(it)) }
        }
        val numeric = if (!ready) null else metadata.optJSONObject("range")?.let { value ->
            "${format(value.getDouble("min"))}–${format(value.getDouble("max"))} ${value.getString("unit")} (${value.getString("scale")})"
        }
        val selection = inspection.metadata.optJSONObject("layerSelection")
        val limitations = listOfNotNull(shown.windowNotice()) + messages(preview) + messages(inspection)
        val next = PreviewState(
            source = name, mode = view.mode, layerBounds = shown.layerBounds, layerRange = view.layerRange,
            singleLayer = view.singleLayer, layerLabel = selection?.getString("accessibleLabel"),
            bottomZMm = selection?.getDouble("firstZMm"), topZMm = selection?.getDouble("lastZMm"), moves = view.moves,
            legend = legend, range = numeric, unsupportedReason = unsupportedReason, layerCount = layerCount,
            limitations = limitations, windowed = shown.window != null, hasPrevious = shown.hasPrevious,
            hasNext = shown.hasNext, toolpath = toolpath, generation = generation, slice = origin,
        )
        main.post {
            state = next.copy(loading = pending.get() > 0)
            undrawn?.let { message = it }
        }
    }

    private fun messages(view: GcodeViewPacket): List<String> {
        val limitations = view.metadata.optJSONArray("limitations") ?: return emptyList()
        return (0 until limitations.length()).map { text(limitations.getJSONObject(it).get("message")) }
    }

    private fun legendEntry(value: JSONObject): PreviewLegend {
        val color = value.getJSONArray("color")
        fun channel(n: Int) = (color.getDouble(n).coerceIn(0.0, 1.0) * 255 + 0.5).toInt()
        val argb = (channel(3) shl 24) or (channel(0) shl 16) or (channel(1) shl 8) or channel(2)
        return PreviewLegend(value.getString("code"), value.getString("label"), value.getString("accessibleLabel"), argb)
    }

    /**
     * Applies a view change on the worker. Every change reaches the plan in
     * order (a window it needs is chosen there), but only the last queued one
     * loads a window and asks the core for a projection.
     */
    private fun change(update: (GcodePreviewPlan) -> Unit) {
        if (state.layerBounds == null) return
        state = state.copy(loading = true)
        pending.incrementAndGet()
        work {
            val queued = try {
                plan?.let(update)
                pending.decrementAndGet()
            } catch (failure: Throwable) {
                pending.decrementAndGet()
                throw failure
            }
            if (queued == 0) project()
        }
    }

    /** The colour mode ("View"), by its official id. */
    fun setMode(mode: String) {
        require(mode in GcodePreviewModes.ids)
        change { it.update(mode = mode) }
    }

    /** The top visible layer; the bottom one follows it down, as the browser's slider does. */
    fun setTopLayer(layer: Int) = change { plan ->
        val low = plan.view.layerRange.first
        plan.update(layerRange = minOf(low, layer) to layer)
    }

    /** The bottom visible layer; the top one follows it up. */
    fun setBottomLayer(layer: Int) = change { plan ->
        val high = plan.view.layerRange.second
        plan.update(layerRange = layer to maxOf(high, layer))
    }

    fun setSingleLayer(single: Boolean) = change { it.update(singleLayer = single) }

    fun setMoveVisible(filter: GcodeMoveFilter, visible: Boolean) = change { plan ->
        plan.update(moves = if (visible) plan.view.moves + filter else plan.view.moves - filter)
    }

    /** "Previous moves" (-1) or "Next moves" (1): the adjacent bounded window of a print too large to load at once. */
    fun step(direction: Int) = change { it.step(direction) }

    override fun onCleared() {
        worker.execute {
            session?.close()
            session = null
            model = null
        }
        worker.shutdown()
    }

    companion object {
        /**
         * The largest G-code file this device previews: the whole text is held
         * while the shared core indexes it (the core itself accepts 256 MB).
         */
        const val MAX_BYTES = 64L * 1024 * 1024
        private const val READ_CHUNK = 64 * 1024
        private const val MAX_INDEX_ENTRIES = 1_000_000
        private const val MAX_LEGEND_SHOWN = 64
        /** `ToolpathGeometry.from`'s refusal of a view past its segment budget. */
        private const val SEGMENT_BUDGET = "Toolpath exceeds the renderer segment budget"

        /** A range bound as the browser's panel formats it (`GcodePreviewPanel.format`). */
        fun format(value: Double): String = when {
            !value.isFinite() -> "—"
            Math.abs(value) >= 100 -> String.format(Locale.ROOT, "%.0f", value)
            else -> String.format(Locale.ROOT, "%.2f", value)
        }
    }
}
