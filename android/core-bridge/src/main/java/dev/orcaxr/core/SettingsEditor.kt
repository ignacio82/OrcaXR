package dev.orcaxr.core

/** One settings draft over inherited values, generated defaults and a node's
 * overrides: the field list a surface renders, field states, drafts, atomic
 * commits and keyboard-free rows. Sorting uses [collator] and search uses
 * [folder]; without them the exact ASCII policies apply and refuse other text. */
class SettingsEditor internal constructor(handle: Long) : ProjectHandle(handle) {
    constructor(
        create: ProjectIntents.EditorCreate,
        collator: PresetCollator? = null,
        folder: SearchFolding? = SearchFolding.PLATFORM,
    ) : this(NativeProject.editorNew(ProjectIntents.encodeEditorCreate(create), collator, folder))

    /** The fields a surface shows for [query]; read them with [field]. */
    fun query(query: ProjectIntents.EditorQuery): Long = read {
        NativeProject.editorQuery(it, ProjectIntents.encodeEditorQuery(query))
    }
    fun field(position: Long): ProjectIntents.EditorField = read {
        ProjectIntents.decodeEditorField(NativeProject.editorField(it, position))
    }
    fun state(field: ProjectIntents.EditorFieldRef): ProjectIntents.EditorFieldState = read {
        ProjectIntents.decodeEditorFieldState(NativeProject.editorState(it, ProjectIntents.encodeEditorFieldRef(field)))
    }
    fun compare(field: ProjectIntents.EditorFieldRef): ProjectIntents.EditorComparison = read {
        ProjectIntents.decodeEditorComparison(NativeProject.editorCompare(it, ProjectIntents.encodeEditorFieldRef(field)))
    }
    /** Set, clear, inherit or reset one draft; a refusal says why. */
    fun edit(edit: ProjectIntents.EditorEdit): ProjectIntents.EditorEditResult = read {
        ProjectIntents.decodeEditorEditResult(NativeProject.editorEdit(it, ProjectIntents.encodeEditorEdit(edit)))
    }
    /** Commit every draft at once, or refuse with every issue. */
    fun commit(): ProjectIntents.EditorCommitResult = read {
        ProjectIntents.decodeEditorCommitResult(NativeProject.editorCommit(it))
    }
    fun revision(): Long = read { NativeProject.editorRevision(it) }
    /** This node's overrides as canonical JSON. */
    fun overrides(): String = read { NativeProject.editorOverrides(it) }
    /** The keyboard-free rows for a scope; read them with [row]. */
    fun rows(request: ProjectIntents.EditorRowsRequest): Long = read {
        NativeProject.editorRows(it, ProjectIntents.encodeEditorRowsRequest(request))
    }
    /** Fields the latest rows counted rather than listed. */
    fun unavailable(): Long = read { NativeProject.editorUnavailable(it) }
    fun row(position: Long): ProjectIntents.EditorRow = read {
        ProjectIntents.decodeEditorRow(NativeProject.editorRow(it, position))
    }
    /** For an editor opened on a project node: the intent that applies its
     * latest commit, guarded by the captured snapshot. Submit it to the
     * session, then reopen the editor on the new snapshot. */
    fun intent(): ProjectIntents.Intent = read { ProjectIntents.decodeIntent(NativeProject.editorIntent(it)) }

    // The browser's generated settings panel over this editor (`settingsPanel.ts`):
    // its view, rows and drafts, and Apply's one commit.

    /** What the panel shows for [mode] and [search]. */
    fun panelView(mode: SettingsPanelMode, search: String): SettingsPanelView = read {
        SettingsPanels.view(NativeProject.editorPanelView(it, SettingsPanels.request("mode" to mode.wire, "search" to search)))
    }
    /** One field's row as it stands now, or null for a field the schema lacks. */
    fun panelRow(fieldId: String): SettingsPanelRow? = read {
        SettingsPanels.row(NativeProject.editorPanelRow(it, SettingsPanels.request("fieldId" to fieldId)))
    }
    /** A typed value drafted, with the Full Spectrum values it implies. */
    fun panelSet(fieldId: String, raw: String): SettingsPanelEdit = read {
        SettingsPanels.edit(NativeProject.editorPanelEdit(it, SettingsPanels.request("fieldId" to fieldId, "op" to "set", "raw" to raw)))
    }
    /** "Use inherited": the node stops holding the field. */
    fun panelInherit(fieldId: String): SettingsPanelEdit = read {
        SettingsPanels.edit(NativeProject.editorPanelEdit(it, SettingsPanels.request("fieldId" to fieldId, "op" to "inherit")))
    }
    /** "Use default": the generated default drafted. */
    fun panelDefault(fieldId: String): SettingsPanelEdit = read {
        SettingsPanels.edit(NativeProject.editorPanelEdit(it, SettingsPanels.request("fieldId" to fieldId, "op" to "default")))
    }
    fun panelState(): SettingsPanelState = read { SettingsPanels.state(NativeProject.editorPanelState(it)) }
    /** Apply: the drafts' one commit; one that changes something becomes [intent]. */
    fun panelApply(): SettingsPanelApply = read { SettingsPanels.apply(NativeProject.editorPanelApply(it)) }
    /** Cancel: every draft dropped. */
    fun panelCancel() = read { NativeProject.editorPanelCancel(it) }

    companion object {
        /** One press up or down, or why the setting cannot be stepped. */
        fun step(request: ProjectIntents.EditorStepRequest): ProjectIntents.EditorStep =
            ProjectIntents.decodeEditorStep(NativeProject.settingsStep(ProjectIntents.encodeEditorStepRequest(request)))
        /** The reviewed Full Spectrum rules for a transaction and a key. */
        fun rules(request: ProjectIntents.EditorRuleRequest): ProjectIntents.EditorRules =
            ProjectIntents.decodeEditorRules(NativeProject.settingsRules(ProjectIntents.encodeEditorRuleRequest(request)))
    }
}
