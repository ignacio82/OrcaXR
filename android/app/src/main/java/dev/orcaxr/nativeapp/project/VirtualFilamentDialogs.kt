package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.VirtualFilamentEdit
import dev.orcaxr.core.VirtualFilamentForm
import dev.orcaxr.core.VirtualFilamentLibrary
import dev.orcaxr.core.VirtualFilamentMode
import dev.orcaxr.core.VirtualFilamentOperation
import dev.orcaxr.core.VirtualFilamentRow
import dev.orcaxr.core.VirtualFilamentSearch
import dev.orcaxr.core.VirtualFilamentSearchRequest
import dev.orcaxr.core.VirtualFilamentValidation

/**
 * The virtual filament library's dialogs as the browser's library runs them
 * (web/src/ui/dom/VirtualFilamentLibrary.ts), kept free of Android so they
 * are checked on the JVM: the author dialog's fields and what the shared
 * core answers for them, its Match search (asked only for a strict target
 * and minimum, debounced, the newest one winning, cancelled when the fields
 * or mode change), its guard against a project that changed while it was
 * open, the edit it submits, and the delete dialog. What the core computes —
 * defaults, validation, previews, ranking, the search itself — comes through
 * [Exchange]; nothing here repeats it.
 */
object VirtualFilamentDialogs {
    /** The browser's `DEFAULT_MATCH_SEARCH_DEBOUNCE_MS`. */
    const val SEARCH_DEBOUNCE_MS = 160L

    /** The shared core's dialog exchanges (`VirtualFilaments` on a device). */
    interface Exchange {
        fun opening(library: VirtualFilamentLibrary, operation: VirtualFilamentOperation, filamentId: String?): VirtualFilamentForm
        fun validate(library: VirtualFilamentLibrary, form: VirtualFilamentForm, search: VirtualFilamentSearch?): VirtualFilamentValidation
    }

    /** The dialog's Match search: what it asked for, and what it knows. */
    data class Search(val request: VirtualFilamentSearchRequest, val token: Long, val state: VirtualFilamentSearch)

    /**
     * An open author dialog (`AuthorDialogState`): what it does to which row,
     * the library and revision it opened on, its fields, its search, what the
     * core answered for them, and an operation in flight or its failure.
     */
    data class Author(
        val operation: VirtualFilamentOperation,
        val target: VirtualFilamentRow?,
        val library: VirtualFilamentLibrary,
        val revision: Any?,
        val form: VirtualFilamentForm,
        val search: Search?,
        val validation: VirtualFilamentValidation,
        val busy: Boolean = false,
        val error: String? = null,
    )

    /** An open delete dialog (`DeleteDialogState`). */
    data class Delete(val row: VirtualFilamentRow, val revision: Any?, val busy: Boolean = false, val error: String? = null)

    /** The dialog for [operation] on [row] (none when adding), its fields as the browser opens them. */
    fun open(
        exchange: Exchange,
        library: VirtualFilamentLibrary,
        revision: Any?,
        operation: VirtualFilamentOperation,
        row: VirtualFilamentRow?,
    ): Author {
        val form = exchange.opening(library, operation, row?.id)
        return Author(operation, row, library, revision, form, null, exchange.validate(library, form, null))
    }

    /**
     * The dialog with [form] typed: a changed Match target or minimum drops
     * the selected candidate and cancels the search (the browser's inputs do
     * both), leaving Match cancels it too, and a search the fields no longer
     * ask for is cancelled; then validated again.
     */
    fun typed(exchange: Exchange, dialog: Author, form: VirtualFilamentForm): Author {
        val matchFieldsChanged = form.matchTarget != dialog.form.matchTarget || form.matchMinimum != dialog.form.matchMinimum
        val next = if (matchFieldsChanged) form.copy(matchSelected = null) else form
        val search = dialog.search?.takeIf { !matchFieldsChanged && next.mode == VirtualFilamentMode.MATCH }
        val provisional = exchange.validate(dialog.library, next, search?.state)
        val kept = search?.takeIf { it.request == provisional.matchSearch }
        val validation = if (kept === search) provisional else exchange.validate(dialog.library, next, null)
        return dialog.copy(form = next, search = kept, validation = validation)
    }

    /**
     * The search the dialog should start now: the one its fields ask for in
     * Match mode when none is running or known for it; null otherwise. The
     * caller waits [SEARCH_DEBOUNCE_MS], then runs it if still current.
     */
    fun searchToStart(dialog: Author): VirtualFilamentSearchRequest? {
        if (dialog.form.mode != VirtualFilamentMode.MATCH) return null
        val wanted = dialog.validation.matchSearch ?: return null
        return if (dialog.search?.request == wanted) null else wanted
    }

    /** The dialog once search [token] for [request] started (pending). */
    fun searching(exchange: Exchange, dialog: Author, request: VirtualFilamentSearchRequest, token: Long): Author {
        val search = Search(request, token, VirtualFilamentSearch.Pending)
        return dialog.copy(search = search, validation = exchange.validate(dialog.library, dialog.form, search.state))
    }

    /** The dialog once search [token] answered — ignored unless it is the dialog's current search. */
    fun searched(exchange: Exchange, dialog: Author, token: Long, outcome: Result<String>): Author {
        val current = dialog.search?.takeIf { it.token == token && it.state == VirtualFilamentSearch.Pending } ?: return dialog
        val state = outcome.fold(
            { VirtualFilamentSearch.Ready(it) },
            { VirtualFilamentSearch.Failed(it.message ?: it.javaClass.simpleName) },
        )
        val search = current.copy(state = state)
        return dialog.copy(search = search, validation = exchange.validate(dialog.library, dialog.form, state))
    }

    /** Whether the project changed since the dialog opened (`dialogIsStale`): it must be reopened before applying. */
    fun stale(openedOn: Any?, now: Any?): Boolean = openedOn != now

    /** Whether the dialog's submit is enabled: a complete draft, nothing in flight, nothing stale, no search pending. */
    fun canSubmit(dialog: Author, revision: Any?): Boolean =
        !dialog.busy && !stale(dialog.revision, revision) && dialog.search?.state != VirtualFilamentSearch.Pending &&
            dialog.validation.draftJson != null

    /** The edit the dialog submits, from its validated draft (none while incomplete). */
    fun edit(dialog: Author): VirtualFilamentEdit? {
        val draft = dialog.validation.draftJson ?: return null
        return when (dialog.operation) {
            VirtualFilamentOperation.ADD -> VirtualFilamentEdit.Add(draft)
            VirtualFilamentOperation.EDIT -> VirtualFilamentEdit.Edit(dialog.target?.id ?: return null, draft)
            VirtualFilamentOperation.DUPLICATE -> VirtualFilamentEdit.Duplicate(dialog.target?.id ?: return null, draft)
        }
    }

    /** The name the draft carries, for the status that follows the edit. */
    fun draftName(dialog: Author): String = dialog.form.name

    /** Whether "Add virtual filament" is offered: two heads a recipe can select, nothing in flight. */
    fun canAdd(library: VirtualFilamentLibrary, busy: Boolean): Boolean = library.selectable.size >= 2 && !busy

    /** The library's own status, unless an operation reports one (`renderLibrary`). */
    sealed interface Status {
        data class Accepted(val operation: VirtualFilamentOperation, val name: String) : Status
        data class Toggling(val enabling: Boolean, val name: String) : Status
        data class Toggled(val enabled: Boolean, val name: String) : Status
        data class Deleted(val name: String) : Status
    }

    /** Why an operation left the library unchanged (`operationError`), with the browser's prefix. */
    sealed interface Failure {
        val message: String
        data class Recipe(override val message: String) : Failure
        data class Toggle(val name: String, override val message: String) : Failure
        data class Deletion(val name: String, override val message: String) : Failure
    }

    /** The choices a component picker lists: every head, the ones a recipe cannot newly take only while already chosen. */
    fun selectableChoice(enabled: Boolean, compatible: Boolean, chosen: Boolean): Boolean = (enabled && compatible) || chosen

    /** The triangle picker's view-box point for a touch at ([x], [y]) on a picker [width] × [height] (the browser's pointer mapping). */
    fun trianglePoint(x: Float, y: Float, width: Float, height: Float): Pair<Double, Double>? {
        if (width <= 0f || height <= 0f) return null
        return (x / width * 240.0) to (y / height * 216.0)
    }

    /** The marker's point after an arrow key (`ArrowLeft` -5 x … `ArrowDown` +5 y). */
    fun nudged(x: Double, y: Double, dx: Int, dy: Int): Pair<Double, Double> = (x + dx * 5) to (y + dy * 5)

    /** The pattern with one quick token appended (`appendManualCycleQuickToken`): `n`, or `[n]` past 9. */
    fun withToken(pattern: String, toolId: Int): String = pattern + if (toolId <= 9) toolId.toString() else "[$toolId]"

    /** The pattern with a new perimeter group started. */
    fun withGroup(pattern: String): String = "$pattern,"

    /** A Ratio count of heads: the browser's two or three. */
    fun withCount(form: VirtualFilamentForm, count: Int): VirtualFilamentForm = form.copy(ratioCount = count.coerceIn(2, 3))
}
