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

    companion object {
        /** One press up or down, or why the setting cannot be stepped. */
        fun step(request: ProjectIntents.EditorStepRequest): ProjectIntents.EditorStep =
            ProjectIntents.decodeEditorStep(NativeProject.settingsStep(ProjectIntents.encodeEditorStepRequest(request)))
        /** The reviewed Full Spectrum rules for a transaction and a key. */
        fun rules(request: ProjectIntents.EditorRuleRequest): ProjectIntents.EditorRules =
            ProjectIntents.decodeEditorRules(NativeProject.settingsRules(ProjectIntents.encodeEditorRuleRequest(request)))
    }
}
