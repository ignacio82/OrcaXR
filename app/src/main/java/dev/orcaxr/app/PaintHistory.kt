package dev.orcaxr.app

/**
 * Paint full-feature-parity (Undo/Redo) — per-model multi-step history
 * of paint mutations.
 *
 * Each [Stroke] is a diff over a single paint pass (one stroke =
 * sequence of brush stamps from DOWN to UP). On the input side that's
 * not always perfectly bracketed (the user can drag-paint without ever
 * seeing UP because of pinch-release jitter on Galaxy XR), so the
 * dispatch records "before" snapshots at the first stamp of a stroke
 * and finalizes the stroke when either the brush mode changes, the
 * selected model changes, or an explicit `endStroke()` call lands.
 *
 * Storage is **per-model**, keyed by `PlacedModel.id`. The history
 * lives in `MainActivity` (in-session only — disk persistence stays
 * with PaintCacheStore which is the "current state" cache, not a
 * history log). Cap at [MAX_DEPTH] strokes so a marathon session
 * doesn't grow unbounded; the oldest stroke gets dropped on overflow.
 *
 * Implementation note: each stroke captures **full-array snapshots**
 * (paint / support / seam / fuzzy ByteArrays) at stroke entry instead
 * of a triangle-index-based diff. Memory cost is `4 * triCount` bytes
 * per stroke per model — for a 1.4M-tri dragon at MAX_DEPTH=50 that's
 * ~280 MB which is too much. So we cap MAX_DEPTH=20 (the upstream
 * default) AND we only snapshot the array(s) the stroke actually
 * touches — a Color-paint stroke captures `paintFilamentIndex` only,
 * not all four. Realistic cost: ~28 MB on the dragon at 20 strokes.
 *
 * The Stroke is intentionally **before-state**: undo restores the
 * snapshot. Redo re-applies the after-state by symmetric snapshots
 * captured at stroke close. Both directions are O(triCount) array
 * copies — same cost as one paint stamp's flood-fill.
 */
class PaintHistory {

    /** A single committed mutation. [before] is the array(s) state
     *  prior to the stroke; [after] is the post-stroke state. Either
     *  side may have null entries for arrays the stroke didn't touch
     *  (so undo/redo on a Color stroke leaves Support state alone). */
    data class Stroke(
        val before: Snapshot,
        val after: Snapshot,
    )

    /** Per-array snapshot. Each ByteArray is either:
     *  - null = "this stroke didn't touch this array; leave the model's
     *    current state alone on undo/redo"
     *  - non-null = a full-size copy that overwrites the model's array.
     *  An "all zeros" array is materially equivalent to clearing — the
     *  caller (PlacedModel) treats both null and all-zero as
     *  "unpainted" via [hasAnyPaint].
     */
    data class Snapshot(
        val paintFilamentIndex: ByteArray? = null,
        val supportFlags: ByteArray? = null,
        val seamFlags: ByteArray? = null,
        val fuzzySkinFlags: ByteArray? = null,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Snapshot) return false
            return arrEq(paintFilamentIndex, other.paintFilamentIndex) &&
                arrEq(supportFlags, other.supportFlags) &&
                arrEq(seamFlags, other.seamFlags) &&
                arrEq(fuzzySkinFlags, other.fuzzySkinFlags)
        }
        override fun hashCode(): Int {
            var r = paintFilamentIndex?.contentHashCode() ?: 0
            r = 31 * r + (supportFlags?.contentHashCode() ?: 0)
            r = 31 * r + (seamFlags?.contentHashCode() ?: 0)
            r = 31 * r + (fuzzySkinFlags?.contentHashCode() ?: 0)
            return r
        }
        companion object {
            private fun arrEq(a: ByteArray?, b: ByteArray?): Boolean {
                if (a === b) return true
                if (a == null || b == null) return false
                return a.contentEquals(b)
            }
        }
    }

    /** Per-model state machine. Holds an undo stack, a redo stack, and
     *  optionally an open-stroke `before` snapshot. */
    private data class ModelState(
        val undoStack: ArrayDeque<Stroke> = ArrayDeque(),
        val redoStack: ArrayDeque<Stroke> = ArrayDeque(),
        var pending: Snapshot? = null,
    )

    private val byModel = mutableMapOf<String, ModelState>()

    /**
     * Begin a stroke on [modelId] with the [currentState] of its paint
     * arrays. No-op if a stroke is already open on this model (the
     * stamp dispatcher fires DOWN once per pinch-down and many MOVE
     * events afterward — only the DOWN should snapshot). Calling
     * [beginStroke] also CLEARS the redo stack: a new edit invalidates
     * any future-direction history (matches every text editor's undo
     * behavior).
     */
    fun beginStroke(modelId: String, currentState: Snapshot) {
        val s = byModel.getOrPut(modelId) { ModelState() }
        if (s.pending != null) return
        s.pending = currentState
        s.redoStack.clear()
    }

    /**
     * Close the open stroke on [modelId] with [endState]. If no stroke
     * is open (DOWN never fired, or already closed), the call is a
     * no-op. If the before/after snapshots are equal — meaning the
     * stroke didn't actually mutate state — the stroke is dropped
     * instead of pushed (no point cluttering undo with no-ops).
     */
    fun endStroke(modelId: String, endState: Snapshot) {
        val s = byModel[modelId] ?: return
        val before = s.pending ?: return
        s.pending = null
        if (before == endState) return
        s.undoStack.addLast(Stroke(before, endState))
        while (s.undoStack.size > MAX_DEPTH) s.undoStack.removeFirst()
    }

    /**
     * If a stroke is currently open on [modelId], drop the pending
     * "before" snapshot without committing. Used when the stroke is
     * abandoned by a mode/model change before UP — discards what would
     * be a phantom undo entry.
     */
    fun cancelStroke(modelId: String) {
        byModel[modelId]?.pending = null
    }

    /** True iff there's at least one undo entry on this model. */
    fun canUndo(modelId: String): Boolean =
        byModel[modelId]?.undoStack?.isNotEmpty() == true

    /** True iff there's at least one redo entry on this model. */
    fun canRedo(modelId: String): Boolean =
        byModel[modelId]?.redoStack?.isNotEmpty() == true

    /**
     * Pop the most recent stroke from undo and push it onto redo.
     * Returns the [Snapshot] to apply to the model's paint arrays
     * (== `stroke.before`), or null if the undo stack is empty.
     */
    fun undo(modelId: String): Snapshot? {
        val s = byModel[modelId] ?: return null
        if (s.undoStack.isEmpty()) return null
        // If a stroke is open when undo is requested, treat it as the
        // most-recent edit and roll it back without consuming an undo
        // slot. Mirrors how a text editor handles "Ctrl-Z while typing
        // mid-word": the open word is rolled back atomically.
        if (s.pending != null) {
            val pending = s.pending!!
            s.pending = null
            return pending
        }
        val stroke = s.undoStack.removeLast()
        s.redoStack.addLast(stroke)
        return stroke.before
    }

    /**
     * Pop the most recent undone stroke and push it back onto undo.
     * Returns the [Snapshot] to apply (== `stroke.after`), or null
     * if the redo stack is empty.
     */
    fun redo(modelId: String): Snapshot? {
        val s = byModel[modelId] ?: return null
        if (s.redoStack.isEmpty()) return null
        val stroke = s.redoStack.removeLast()
        s.undoStack.addLast(stroke)
        return stroke.after
    }

    /** Drop all history for [modelId]. Called when the model is
     *  removed from the workspace. */
    fun clear(modelId: String) {
        byModel.remove(modelId)
    }

    /** Size of the undo stack on [modelId]. Tests-only. */
    fun undoDepth(modelId: String): Int =
        byModel[modelId]?.undoStack?.size ?: 0

    /** Size of the redo stack on [modelId]. Tests-only. */
    fun redoDepth(modelId: String): Int =
        byModel[modelId]?.redoStack?.size ?: 0

    companion object {
        /** Cap on per-model undo stack depth. 20 strokes × ~1.4 MB per
         *  array × up-to-4 arrays ≈ 112 MB worst-case on a 1.4M-tri
         *  dragon — but realistic prints are 50-200k tris and the
         *  stroke captures only the array(s) it touches, so typical
         *  history ≈ 5-10 MB. */
        const val MAX_DEPTH = 20
    }
}
