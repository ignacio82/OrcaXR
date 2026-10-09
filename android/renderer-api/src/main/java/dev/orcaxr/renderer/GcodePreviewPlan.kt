package dev.orcaxr.renderer

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** One entry of a sealed G-code source's layer index, as `GcodeSession.page` lists it. */
data class GcodeIndexEntry(val layer: Int, val recordsBefore: Long, val pathPointsBefore: Long)

/** Inclusive index entries `first..last` parsed into one loaded model. */
data class GcodeWindow(val first: Int, val last: Int)

/**
 * A sealed source's layer index and what one loaded model may hold, read as
 * the browser's `GcodePreviewController` reads it: the whole print when it
 * is fully indexed and fits the record and path-point budgets, otherwise
 * bounded windows of index entries (an oversized layer has several entries,
 * each within the budget).
 */
class GcodePreviewIndex(
    val entries: List<GcodeIndexEntry>,
    val recordCount: Long,
    val pathPointCount: Long,
    val complete: Boolean,
    val terminationReason: String?,
    val recordBudget: Long,
    val pathPointBudget: Long,
) {
    init {
        require(entries.isNotEmpty() && recordCount >= 0 && pathPointCount >= 0 && recordBudget > 0 && pathPointBudget > 0)
    }

    /** Whether one model holds the whole print. */
    val whole: Boolean get() = complete && recordCount <= recordBudget && pathPointCount <= pathPointBudget

    /** Inclusive layer bounds of the whole print, not of what is loaded. */
    val layerBounds: Pair<Int, Int> get() = entries.first().layer to entries.last().layer

    fun recordsIn(entry: Int): Long = (entries.getOrNull(entry + 1)?.recordsBefore ?: recordCount) - entries[entry].recordsBefore

    private fun pathPointsThrough(first: Int, last: Int): Long =
        (entries.getOrNull(last + 1)?.pathPointsBefore ?: pathPointCount) - entries[first].pathPointsBefore

    /** The last entry that fits the budgets starting at [first]. */
    fun windowEnd(first: Int): Int {
        val startRecords = entries[first].recordsBefore
        var last = first
        for (candidate in first + 1 until entries.size) {
            val through = entries[candidate].recordsBefore + recordsIn(candidate) - startRecords
            if (through > recordBudget || pathPointsThrough(first, candidate) > pathPointBudget) break
            last = candidate
        }
        return last
    }

    /** The earliest entry that fits the budgets ending at [last]. */
    fun windowStart(last: Int): Int {
        val endRecords = entries[last].recordsBefore + recordsIn(last)
        var first = last
        for (candidate in last - 1 downTo 0) {
            val through = endRecords - entries[candidate].recordsBefore
            if (through > recordBudget || pathPointsThrough(candidate, last) > pathPointBudget) break
            first = candidate
        }
        return first
    }

    /** The entry holding [layer] — its first or [last] one — clamped into range. */
    fun entryForLayer(layer: Int, last: Boolean): Int {
        var low = 0
        var high = entries.size
        while (low < high) {
            val middle = (low + high) / 2
            if (entries[middle].layer < layer || (last && entries[middle].layer == layer)) low = middle + 1 else high = middle
        }
        return (if (last) low - 1 else low).coerceIn(0, entries.size - 1)
    }

    /** The layers of the loaded [window]. */
    fun layers(window: GcodeWindow): Pair<Int, Int> = entries[window.first].layer to entries[window.last].layer
}

/** Move classes a viewer can hide, in the order the browser's panel lists them (`GCODE_PREVIEW_MOVE_FILTERS`). */
enum class GcodeMoveFilter(val label: String, val kind: Int, val defaultVisible: Boolean) {
    Extrude("Extrusions", 10, true),
    Travel("Travel", 8, false),
    Wipe("Wipe", 9, false),
    Retract("Retractions", 1, false),
    Unretract("Unretractions", 2, false),
    ;

    companion object {
        /** Record kinds the shared preview's event mask covers (`GCODE_RECORD_KIND_NAMES`). */
        const val EVENT_COUNT = 14

        val defaults: Set<GcodeMoveFilter> get() = entries.filter { it.defaultVisible }.toSet()

        /** The preview request's event mask: markers stay visible so ticks, tool changes and pauses remain locatable. */
        fun eventMask(visible: Set<GcodeMoveFilter>): List<Int> {
            val mask = MutableList(EVENT_COUNT) { 1 }
            for (filter in entries) mask[filter.kind] = if (filter in visible) 1 else 0
            return mask
        }
    }
}

/**
 * What a viewer shows of one source: the official mode, the inclusive layer
 * range, whether only its top layer is shown, and the visible move classes.
 */
data class GcodePreviewView(
    val mode: String = "FeatureType",
    val layerRange: Pair<Int, Int>,
    val singleLayer: Boolean = false,
    val moves: Set<GcodeMoveFilter> = GcodeMoveFilter.defaults,
)

/**
 * The browser controller's view state over one source: bounds-clamped layer
 * ranges, the loaded window (null when the whole print is one model), and
 * window loading when a range or a step reaches beyond what is loaded — a
 * request wider than one window is narrowed, never partly served. A whole
 * print's bounds are its model's layers ([wholeBounds]); a windowed print's
 * are its index's.
 */
class GcodePreviewPlan(val index: GcodePreviewIndex, wholeBounds: Pair<Int, Int>? = null) {
    /** Inclusive layer bounds of the whole print, not of what is loaded. */
    val layerBounds: Pair<Int, Int> = if (index.whole) wholeBounds ?: index.layerBounds else index.layerBounds

    /** The loaded entries; null when the whole print is loaded. */
    var window: GcodeWindow? = if (index.whole) null else GcodeWindow(0, index.windowEnd(0))
        private set

    /** What is shown starts as what is loaded; the slider still spans the whole print. */
    var view = GcodePreviewView(layerRange = window?.let(index::layers) ?: layerBounds)
        private set

    /** Applies a view change, loading the window it needs; answers the view now shown. */
    fun update(
        mode: String = view.mode,
        layerRange: Pair<Int, Int>? = null,
        moves: Set<GcodeMoveFilter> = view.moves,
        singleLayer: Boolean? = null,
    ): GcodePreviewView {
        val (minLayer, maxLayer) = layerBounds
        var (low, high) = layerRange ?: view.layerRange
        low = low.coerceIn(minLayer, maxLayer)
        high = high.coerceIn(minLayer, maxLayer)
        if (low > high) low = high.also { high = low }
        val single = singleLayer ?: view.singleLayer
        if (single) low = high
        if (layerRange != null || singleLayer != null) ensure(low, high).let { (a, b) -> low = a; high = b }
        view = GcodePreviewView(mode, low to high, single, moves)
        return view
    }

    /** Loads the adjacent bounded window ([direction] -1 or 1); answers the view now shown. */
    fun step(direction: Int): GcodePreviewView {
        require(direction == -1 || direction == 1)
        val loaded = window ?: return view
        val next = if (direction == 1) {
            if (loaded.last >= index.entries.size - 1) return view
            val first = loaded.last + 1
            var last = index.windowEnd(first)
            if (view.singleLayer) last = min(last, index.entryForLayer(index.entries[first].layer, last = true))
            GcodeWindow(first, last)
        } else {
            if (loaded.first == 0) return view
            val last = loaded.first - 1
            var first = index.windowStart(last)
            if (view.singleLayer) first = max(first, index.entryForLayer(index.entries[last].layer, last = false))
            GcodeWindow(first, last)
        }
        window = next
        view = view.copy(layerRange = index.layers(next))
        return view
    }

    private fun ensure(low: Int, high: Int): Pair<Int, Int> {
        val loaded = window ?: return low to high
        val targetFirst = index.entryForLayer(low, last = false)
        val targetLast = index.entryForLayer(high, last = true)
        val (previousLow, previousHigh) = view.layerRange
        val highMoved = high != previousHigh
        val lowMoved = low != previousLow
        val next = when {
            highMoved && !lowMoved -> GcodeWindow(max(targetFirst, index.windowStart(targetLast)), targetLast)
            lowMoved && !highMoved -> GcodeWindow(targetFirst, min(targetLast, index.windowEnd(targetFirst)))
            index.windowEnd(targetFirst) >= targetLast -> GcodeWindow(targetFirst, targetLast)
            else -> GcodeWindow(max(targetFirst, index.windowStart(targetLast)), targetLast)
        }
        if (next != loaded) window = next
        return index.layers(next)
    }

    /** Whether earlier or later records exist beyond the loaded window. */
    val hasPrevious: Boolean get() = (window?.first ?: 0) > 0
    val hasNext: Boolean get() = window?.let { it.last < index.entries.size - 1 } ?: false

    /**
     * What the browser tells the viewer when only part of the print is loaded,
     * or null for a whole print: a window is a deliberate choice, and leaving
     * it unsaid would let someone take a fraction for the whole slice.
     */
    fun windowNotice(): String? {
        val loaded = window ?: return null
        val (low, high) = index.layers(loaded)
        val top = layerBounds.second
        val firstRecord = index.entries[loaded.first].recordsBefore
        val lastRecord = max(0L, index.entries[loaded.last].recordsBefore + index.recordsIn(loaded.last) - 1)
        val coverage = if (index.complete) "The supplied G-code was fully indexed." else
            "Only a prefix was indexed (${index.terminationReason ?: "unknown termination"}); later input has not been inspected."
        return "Showing layers $low–$high of $top, records ${firstRecord + 1}–${lastRecord + 1} of ${index.recordCount}. " +
            "Use the layer range or Previous/Next moves to inspect another bounded window. $coverage"
    }

    companion object {
        /** A slider position as the browser reads it: rounded to a whole layer. */
        fun layerOf(value: Float): Int = value.roundToInt()
    }
}
