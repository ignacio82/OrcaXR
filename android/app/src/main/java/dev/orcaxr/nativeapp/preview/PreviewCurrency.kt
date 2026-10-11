package dev.orcaxr.nativeapp.preview

import dev.orcaxr.core.ProjectRevision

/**
 * Whether the viewer may show a slice and when it withdraws one: the
 * browser's rule at its viewer (`OrcaWorkspace.revalidatePublishedGcode`
 * over `StoreProjectSliceSource.isCurrent`). A slice is shown only while the
 * project is the state it was sliced from — the same revision, semantic hash
 * and asset fingerprint ([ProjectRevision]) — and is withdrawn once the
 * project reports another; a file the operator opened belongs to no project
 * state and is never withdrawn.
 *
 * The notice that a slice was withdrawn ([withdrawn]) describes what the
 * viewer shows, so the next source the viewer reads replaces it, as the
 * browser clears its preview before showing each new one: a fresh slice of
 * the edited project never appears under the notice of the slice the edit
 * withdrew. Platform-free; the viewer calls it on its worker, in order.
 */
class PreviewCurrency {
    /** The latest state the project reported; none before its first. */
    var latest: ProjectRevision? = null
        private set

    /** The project state of the slice shown; none for an opened file, or with nothing shown. */
    var origin: ProjectRevision? = null
        private set

    /** Whether the slice the viewer showed was withdrawn and nothing has been read since. */
    var withdrawn: Boolean = false
        private set

    /** The project now stands at [revision]: answers whether the slice shown is withdrawn. */
    fun projectChanged(revision: ProjectRevision?): Boolean {
        latest = revision
        val shown = origin ?: return false
        if (shown == revision) return false
        origin = null
        withdrawn = true
        return true
    }

    /** Whether a slice of the project at [slice] may be shown: not once the project reported another state. */
    fun admits(slice: ProjectRevision): Boolean = latest == null || latest == slice

    /** The viewer lets its source go to read another: nothing is shown, and nothing is withdrawn any more. */
    fun released() {
        origin = null
        withdrawn = false
    }

    /** The viewer now shows a slice of the project at [slice], or (null) a file the operator opened. */
    fun shown(slice: ProjectRevision?) {
        origin = slice
        withdrawn = false
    }

    /** The operator dismissed the notice. */
    fun dismissed() {
        withdrawn = false
    }
}
