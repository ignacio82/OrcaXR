package dev.orcaxr.nativeapp.project

import dev.orcaxr.core.JsText
import dev.orcaxr.core.LayerRangeCheck
import dev.orcaxr.core.LayerRangeEntry
import dev.orcaxr.core.LayerRangeMerge
import dev.orcaxr.core.LayerRangeProjection
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.SettingsPanelApply
import dev.orcaxr.core.SettingsPanelMode
import dev.orcaxr.core.SettingsPanelState
import dev.orcaxr.core.SettingsPanelView
import dev.orcaxr.core.SettingsTarget

/**
 * The inspector's other panels, as the tree's rows lead to them: a node's
 * settings (the browser's scoped settings panel, its Process card) and an
 * object's height ranges (the browser's semantic object editor). One shows
 * at a time under the tree, beside the Workspace on a wide window.
 */
sealed interface InspectorPanel {
    /** The scoped settings panel on [targetId] (`object:<id>`, `part:<id>`, `layerRange:<id>`, …). */
    data class Settings(val targetId: String) : InspectorPanel
    /** The height ranges of object [objectId]. */
    data class HeightRanges(val objectId: String) : InspectorPanel
}

object InspectorRows {
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /**
     * The panel a tree row opens: an object's or part's "Settings" row opens
     * that node's settings, an object's "Layer ranges" row its height ranges.
     * Rows of entities select instead, and open nothing.
     */
    fun opens(row: ProjectIntents.ObjectTreeRow): InspectorPanel? {
        val owner = (row.owner as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value ?: return null
        return when (row.kind) {
            ProjectIntents.ObjectTreeRowKind.Settings -> when (owner) {
                is ProjectIntents.ObjectTreeEntity.Object -> InspectorPanel.Settings("object:" + text(owner.value))
                is ProjectIntents.ObjectTreeEntity.Volume -> InspectorPanel.Settings("part:" + text(owner.value))
                else -> null
            }
            ProjectIntents.ObjectTreeRowKind.LayerGroup ->
                (owner as? ProjectIntents.ObjectTreeEntity.Object)?.let { InspectorPanel.HeightRanges(text(it.value)) }
            else -> null
        }
    }
}

/** What the settings panel says about its last operation (the browser panel's operation status). */
sealed interface SettingsNote {
    /** "Draft changes are not applied yet." */
    data object DraftPending : SettingsNote
    /** "Applying n setting change(s)…" */
    data class Applying(val changes: Int) : SettingsNote
    /** "Applied n setting change(s) atomically." */
    data class Applied(val changes: Int) : SettingsNote
    /** "No effective settings changes to apply." */
    data object NothingToApply : SettingsNote
    /** "Draft settings changes cancelled." */
    data object Cancelled : SettingsNote
    /** The project changed under a draft, which is kept but cannot be applied. */
    data object ConflictKept : SettingsNote
    /** "Project settings refreshed from the current canonical revision." */
    data object Refreshed : SettingsNote
    /** "Discarded the stale draft and reloaded current project settings." */
    data object Reloaded : SettingsNote
    /** "Draft changes are still available for review." */
    data object KeptForReview : SettingsNote
}

/** Which of the browser panel's error lines a failure shows, before its message. */
enum class SettingsErrorKind {
    /** "Fix the highlighted validation errors before applying" */
    FixHighlighted,
    /** "Settings could not be validated" */
    NotValidated,
    /** "No settings were applied" */
    NotApplied,
    /** "Default reset failed" */
    DefaultResetFailed,
    /** "Loading settings failed" */
    LoadFailed,
}

data class SettingsError(val kind: SettingsErrorKind, val message: String)

/**
 * The scoped settings panel as the operator sees it: the node, every node the
 * picker lists, the detail level and search, the shared core's view of the
 * node's fields, the drafts' state, and the browser panel's busy, conflict and
 * status rules. The fields, drafts and commit are the core's; this holds only
 * what the browser's DOM panel holds around them.
 */
data class SettingsShell(
    val targetId: String,
    val target: SettingsTarget? = null,
    val targets: List<SettingsTarget> = emptyList(),
    val mode: SettingsPanelMode = SettingsPanelMode.SIMPLE,
    val search: String = "",
    val view: SettingsPanelView? = null,
    val draft: SettingsPanelState = SettingsPanelState(changed = false, drafts = 0, invalid = false),
    /** The project state the panel opened on. */
    val revision: Long? = null,
    val loading: Boolean = true,
    val busy: Boolean = false,
    /** The project changed under a draft: Apply waits for "Discard draft and reload". */
    val conflict: Boolean = false,
    val note: SettingsNote? = null,
    val error: SettingsError? = null,
) {
    /** Controls take input: loaded and not applying. */
    val interactive: Boolean get() = view != null && !loading && !busy
    /** Apply: a draft that changes something, valid, on the state it began on (`syncControlState`). */
    val canApply: Boolean get() = interactive && draft.changed && !draft.invalid && !conflict
    val canCancel: Boolean get() = interactive

    /** What the panel does when the project moved to [revision] (`handleAuthorityChanged`). */
    fun projectChanged(revision: Long?): SettingsRefresh = when {
        revision == null || revision == this.revision -> SettingsRefresh.None
        loading || busy -> SettingsRefresh.Later
        draft.drafts > 0 -> SettingsRefresh.Conflict
        else -> SettingsRefresh.Reload
    }

    /** The browser's answer to Apply's commit before anything is submitted; null for a commit to submit. */
    fun prepared(outcome: SettingsPanelApply): SettingsShell? = when (outcome) {
        is SettingsPanelApply.Committed -> null
        SettingsPanelApply.Unchanged -> copy(note = SettingsNote.NothingToApply)
        is SettingsPanelApply.Invalid -> copy(error = SettingsError(SettingsErrorKind.FixHighlighted, outcome.message))
        is SettingsPanelApply.Failed -> copy(error = SettingsError(SettingsErrorKind.NotValidated, outcome.message))
    }
}

/** What a project change does to an open settings panel. */
enum class SettingsRefresh {
    /** The panel's own state: nothing to do. */
    None,
    /** Loading or applying: look again once that settles. */
    Later,
    /** Drafts are kept, flagged as begun on an earlier state. */
    Conflict,
    /** No drafts: read the node again on the new state. */
    Reload,
}

/** A bounds or split form of the height-range editor: what is typed, and whether it has been touched. */
data class RangeForm(val first: String = "", val second: String = "", val touched: Boolean = false)

/**
 * The height-range editor around the shared core's checks
 * (`SemanticObjectEditor`): which forms show, when a check's words show, and
 * which merges are offered.
 */
object RangeForms {
    /**
     * A bounds form's words: once it was typed in, or — for the selected
     * range's form, which opens holding its bounds — whenever its bounds are
     * invalid.
     */
    fun boundsMessage(check: LayerRangeCheck, form: RangeForm, editing: Boolean): String? =
        (check as? LayerRangeCheck.Invalid)?.message?.takeIf { form.touched || editing }

    /** A split form's words: once it was typed in and is invalid. */
    fun splitMessage(check: LayerRangeCheck, form: RangeForm): String? =
        (check as? LayerRangeCheck.Invalid)?.message?.takeIf { form.touched }

    /** The selected range's bounds as its edit form opens with them (`String(number)`, the browser's input value). */
    fun editForm(range: LayerRangeEntry): RangeForm = RangeForm(JsText.number(range.minZMm), JsText.number(range.maxZMm))

    /** A merge offered with the neighbour it names, or the reason it is not. */
    fun merge(decision: LayerRangeMerge): Pair<String?, String?> =
        if (decision.allowed) decision.otherRangeId to null else null to decision.reason

    /** The selected range of [projection], for the forms that act on it. */
    fun selected(projection: LayerRangeProjection?): LayerRangeEntry? = projection?.selectedRange
}
