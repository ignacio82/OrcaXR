package dev.orcaxr.core

/** What "Reset transform" clears on a selection (the browser's `reset:<target>` gestures). */
enum class TransformReset(internal val gesture: String) {
    ROTATION("reset:rotation"),
    SCALE("reset:scale"),
    BOTH("reset:both"),
}

/**
 * The browser workspace's history gestures for placement edits
 * (`CanonicalWorkspaceController`): each edit is one `setInstanceTransforms`
 * under its gesture, so a repeated edit of the same instances coalesces into
 * one undo entry as the browser's history coalesces it. Edits without a
 * gesture of their own (drop to bed) draw `batch:<n>` from the workspace's
 * transform sequence and never coalesce.
 */
internal object PlacementGestures {
    fun mirror(axis: ProjectIntents.PlacementAxis) = "mirror:" + axis.name.lowercase()
    const val CENTER = "center"
    const val SCALE_TO_FIT = "scale-to-fit"
    const val LAY_ON_FACE = "lay-on-face"
    fun arrange(plateId: String) = "arrange:$plateId"
    fun batch(sequence: Long) = "batch:$sequence"
    /** The browser's status when a project states no printable height (`scaleSelectionToFitPrintVolume`). */
    const val NO_PRINTABLE_HEIGHT = "This printer profile states no printable height, so a fitting scale cannot be computed."
}
