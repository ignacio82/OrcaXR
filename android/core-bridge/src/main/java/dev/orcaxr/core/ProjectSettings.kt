package dev.orcaxr.core

import java.util.concurrent.CompletableFuture

/**
 * One node the browser's scoped settings panel lists — the project, a plate,
 * an object, a part or a height range — with the panel's words for it: its
 * picker text (`Object: Plate 1 › Cube — 2 overrides`), what its values do and
 * its heading (`Object settings — Cube`).
 */
data class SettingsTarget(
    /** `object:<id>` and the like, as the browser's picker values. */
    val id: String,
    /** `project`, `plate`, `object`, `part` or `layerRange`. */
    val scope: String,
    val label: String,
    val path: String,
    val overrideCount: Long,
    val text: String,
    val summary: String,
    val heading: String,
    internal val wire: ProjectIntents.SettingsTarget,
)

/**
 * One node's settings panel, opened on a state of the project as the
 * browser's settings panel opens it (`mountSettingsEditors.ts`): the node's
 * inherited values and overrides decoded into the shared core's panel model,
 * whose view, rows and drafts are read here; Apply goes through
 * [ProjectSettings.apply]. Every node the picker lists is read with it. Not
 * thread-safe beyond its editor's own lock; close it when replaced.
 */
class SettingsPanel internal constructor(
    val target: SettingsTarget,
    val targets: List<SettingsTarget>,
    internal val editor: SettingsEditor,
    internal val guard: ProjectIntents.SessionGuard,
    /** The state the panel opened on. */
    val revision: Long,
    val semanticHash: String,
) : AutoCloseable {
    fun view(mode: SettingsPanelMode, search: String): SettingsPanelView = editor.panelView(mode, search)
    fun row(fieldId: String): SettingsPanelRow? = editor.panelRow(fieldId)
    fun set(fieldId: String, raw: String): SettingsPanelEdit = editor.panelSet(fieldId, raw)
    fun inherit(fieldId: String): SettingsPanelEdit = editor.panelInherit(fieldId)
    fun useDefault(fieldId: String): SettingsPanelEdit = editor.panelDefault(fieldId)
    fun state(): SettingsPanelState = editor.panelState()
    /** Cancel: every draft dropped. */
    fun cancel() = editor.panelCancel()
    override fun close() = editor.close()
}

/** One object's height ranges read on a state of the project, with that state's guard for the edits made from them. */
class LayerRangePanel internal constructor(val projection: LayerRangeProjection, internal val guard: ProjectIntents.SessionGuard)

/**
 * The inspector's settings panels on the project session, as the browser's
 * workspace runs them, through the shared core:
 *
 * - the scoped settings panel (`ScopedSettingsPanel` over the generated
 *   settings panel): every node it lists, a node's panel opened on the
 *   current state, and Apply — the drafts' one commit, the browser's
 *   `setScopedOverrides` (or `setProjectSettingsOverrides`) intent submitted
 *   under the guard of the state the panel opened on, one undoable step the
 *   core labels ("Update object settings", "Update part settings", "Update
 *   height range settings"); a project changed meanwhile refuses it in the
 *   browser's words;
 * - the semantic editor's height ranges: an object's ranges with the
 *   selection's range, and add, edit, split, merge and delete — each the
 *   browser's intent under the guard of the state the ranges were read on,
 *   one undoable step ("Add layer range", "Edit layer range", …).
 */
class ProjectSettings(private val workspace: ProjectWorkspace) {
    companion object {
        /** The browser's words for an Apply whose draft began on another state (`mountSettingsEditors.ts`). */
        const val STALE_DRAFT = "The settings draft no longer matches the displayed canonical project snapshot."
        /** The browser's words for a height-range edit prepared for another state (`StaleCanonicalSemanticObjectMutationError`). */
        const val STALE_RANGE = "Semantic object edit was prepared for a stale canonical project revision"
        private const val PAGE = 64L
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun scope(target: ProjectIntents.SettingsTarget) = when (target) {
        is ProjectIntents.SettingsTarget.Project -> "project"
        is ProjectIntents.SettingsTarget.Plate -> "plate"
        is ProjectIntents.SettingsTarget.Object -> "object"
        is ProjectIntents.SettingsTarget.Part -> "part"
        is ProjectIntents.SettingsTarget.LayerRange -> "layerRange"
    }

    /** Every node [snapshot]'s panel lists, in the order a person scans the scene. */
    private fun targetsOf(snapshot: ProjectSnapshot): List<SettingsTarget> {
        val out = ArrayList<SettingsTarget>()
        var start = 0L
        while (true) {
            val page = snapshot.settingsTargets(ProjectIntents.SettingsTargetPageRequest(start, PAGE))
            for (option in page.targets) {
                val scope = scope(option.target)
                val label = text(option.label)
                val path = text(option.path)
                val words = SettingsPanels.targetText(scope, label, path, option.overrideCount)
                out += SettingsTarget(text(option.id), scope, label, path, option.overrideCount, words.text, words.summary, words.heading, option.target)
            }
            start += page.targets.size
            if (page.targets.isEmpty() || start >= page.total) return out
        }
    }

    /** Every node the scoped settings panel lists now. */
    fun targets(): CompletableFuture<List<SettingsTarget>> = workspace.inspect { session -> session.snapshot().use(::targetsOf) }

    /**
     * [targetId]'s settings panel on the project's current state, or the
     * browser's refusal for a node the project no longer has.
     */
    fun open(targetId: String): CompletableFuture<SettingsPanel> = workspace.inspect { session ->
        session.snapshot().use { snapshot ->
            val targets = targetsOf(snapshot)
            val target = targets.firstOrNull { it.id == targetId }
                ?: throw ProjectFailure("No settings target named $targetId is in the project.")
            val request = ProjectIntents.SettingsSessionRequest(target.wire, ProjectIntents.EditorMode.Simple, ProjectIntents.EditorTechnology.Fff)
            val editor = snapshot.settingsEditor(request, null, SearchFolding.PLATFORM)
            try {
                SettingsPanel(target, targets, editor, workspace.guardOf(session, snapshot), snapshot.revision(), snapshot.hash())
            } catch (failure: Throwable) {
                editor.close()
                throw failure
            }
        }
    }

    /**
     * Apply (the browser's `applyDrafts`): the panel's drafts become one
     * commit; one that changes something is submitted as one undoable step
     * under the guard of the state the panel opened on. Completes with what
     * the commit was — no changes and invalid drafts change nothing — or
     * fails with the reason, the browser's [STALE_DRAFT] when the project
     * changed meanwhile.
     */
    fun apply(panel: SettingsPanel): CompletableFuture<SettingsPanelApply> {
        val outcome = try {
            prepare(panel)
        } catch (failure: Throwable) {
            return CompletableFuture.failedFuture(failure)
        }
        if (outcome !is SettingsPanelApply.Committed) return CompletableFuture.completedFuture(outcome)
        return submit(panel).thenApply { outcome }
    }

    /** Apply's first half: the drafts' one commit, nothing submitted (a commit without changes drops the drafts). */
    fun prepare(panel: SettingsPanel): SettingsPanelApply = panel.editor.panelApply()

    /** Apply's second half: the commit [prepare] made, submitted under the guard of the state the panel opened on. */
    fun submit(panel: SettingsPanel): CompletableFuture<Unit> = try {
        submit(panel.guard, panel.editor.intent(), STALE_DRAFT)
    } catch (failure: Throwable) {
        CompletableFuture.failedFuture(failure)
    }

    /** One intent under [guard], one undoable step; a stale guard fails with [stale]. */
    private fun submit(guard: ProjectIntents.SessionGuard, intent: ProjectIntents.Intent, stale: String): CompletableFuture<Unit> =
        workspace.refreshed(
            workspace.outcome(workspace.actor.submit(ProjectIntents.SessionOperation.Execute(ProjectIntents.GuardedIntent(guard, intent))))
                .thenApply { result ->
                    val completed = result as? ProjectOutcome.Completed ?: throw workspace.failure(result, null)
                    when (val reply = completed.reply.result) {
                        is ProjectIntents.SessionResult.Acknowledged, is ProjectIntents.SessionResult.ReceiptUnavailable -> Unit
                        is ProjectIntents.SessionResult.Error ->
                            throw if (reply.value == ProjectIntents.SessionError.Stale) ProjectFailure(stale) else workspace.refusedBy(reply.value)
                        else -> throw workspace.failure(result, null)
                    }
                },
        )

    /**
     * [objectId]'s height ranges on the current state, the selection's
     * primary range selected when it is one of them (the browser's
     * `getSemanticObjectEditorSnapshot`); null for an object the project lacks.
     */
    fun layerRanges(objectId: String): CompletableFuture<LayerRangePanel?> = workspace.inspect { session ->
        val selected = (workspace.whole(session).primary as? ProjectIntents.SelectionEntity.LayerRange)?.let { text(it.value) }
        session.snapshot().use { snapshot ->
            // A read answers a value: none is an empty list.
            listOfNotNull(snapshot.layerRangeEditor(objectId, selected)?.let { LayerRangePanel(it, workspace.guardOf(session, snapshot)) })
        }
    }.thenApply { it.firstOrNull() }

    /** Selects height range [rangeId] alone, as a click on its tree row does. */
    fun selectLayerRange(rangeId: String): CompletableFuture<Unit> =
        workspace.outcome(workspace.actor.select { ProjectSelectionChoice(listOf(ProjectIntents.SelectionEntity.LayerRange(units(rangeId)))) })
            .thenApply { result -> if (result !is ProjectOutcome.Selected && result != ProjectOutcome.NothingToDo) throw workspace.failure(result, null) }

    private fun edit(panel: LayerRangePanel, command: ProjectIntents.Command): CompletableFuture<Unit> =
        submit(panel.guard, ProjectIntents.Intent(ProjectIntents.VERSION, command), STALE_RANGE)
    private val LayerRangePanel.objectId get() = units(projection.objectId)

    /** "Add range": a new range from [minZMm] to [maxZMm] under an ID drawn as the browser draws it; the core selects it. Completes with its ID. */
    fun addLayerRange(panel: LayerRangePanel, minZMm: Double, maxZMm: Double): CompletableFuture<String> {
        val id = workspace.ids.next()
        return edit(panel, ProjectIntents.Command.AddLayerRange(ProjectIntents.AddLayerRange(panel.objectId, units(id), minZMm, maxZMm))).thenApply { id }
    }

    /** "Apply boundaries": [rangeId]'s new bounds. */
    fun editLayerRange(panel: LayerRangePanel, rangeId: String, minZMm: Double, maxZMm: Double): CompletableFuture<Unit> =
        edit(
            panel,
            ProjectIntents.Command.EditLayerRangeBounds(
                ProjectIntents.EditLayerRangeBounds(
                    panel.objectId, units(rangeId), ProjectIntents.OptionalFinite.Value(minZMm), ProjectIntents.OptionalFinite.Value(maxZMm),
                ),
            ),
        )

    /** "Split range": [rangeId] split at [splitZMm], its upper part a new range the core selects. Completes with its ID. */
    fun splitLayerRange(panel: LayerRangePanel, rangeId: String, splitZMm: Double): CompletableFuture<String> {
        val upper = workspace.ids.next()
        return edit(panel, ProjectIntents.Command.SplitLayerRange(ProjectIntents.SplitLayerRange(panel.objectId, units(rangeId), splitZMm, units(upper))))
            .thenApply { upper }
    }

    /** "Merge with previous/next range": [rangeId] and the neighbour the panel's decision names. */
    fun mergeLayerRanges(panel: LayerRangePanel, rangeId: String, otherRangeId: String): CompletableFuture<Unit> =
        edit(panel, ProjectIntents.Command.MergeLayerRanges(ProjectIntents.MergeLayerRanges(panel.objectId, units(rangeId), units(otherRangeId))))

    /** "Delete selected range". */
    fun deleteLayerRange(panel: LayerRangePanel, rangeId: String): CompletableFuture<Unit> =
        edit(panel, ProjectIntents.Command.DeleteLayerRange(ProjectIntents.DeleteLayerRange(panel.objectId, units(rangeId))))
}
