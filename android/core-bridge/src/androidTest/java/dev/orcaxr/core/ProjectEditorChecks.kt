package dev.orcaxr.core

/** The settings editor through the Kotlin wrapper: the browser's contract
 * replies decode and re-encode exactly, edits and commits take the browser's
 * path, the platform folder finds what only NFKD matches, and failing host
 * callbacks refuse without exposing their text. */
object ProjectEditorChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message
    private fun text(value: String) = value.map { it.code }
    private fun string(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    /** [expected] lines: an editor, a state request and reply, a search query
     * with its count and first field, a step and its reply, a rule request and
     * its reply, and a rows editor with its request and count. */
    @JvmStatic fun run(expected: String): Long {
        val lines = expected.split("\n")
        check(lines.size == 13)
        var checks = 0L
        val create = ProjectIntents.decodeEditorCreate(lines[0])
        SettingsEditor(create).use { editor ->
            val state = editor.state(ProjectIntents.decodeEditorFieldRef(lines[1]))
            check(ProjectIntents.encodeEditorFieldState(state) == lines[2]); checks++
            check(editor.query(ProjectIntents.decodeEditorQuery(lines[3])) == lines[4].toLong()); checks++
            check(ProjectIntents.encodeEditorField(editor.field(0)) == lines[5]); checks++
            check(failure { editor.field(lines[4].toLong()) } == "invalid_range"); checks++

            // Edits take the browser's path: a bad draft refuses the commit.
            val id = state.field.id
            fun edit(raw: String) = editor.edit(ProjectIntents.EditorEdit.Set(ProjectIntents.EditorFieldEdit(id, text(raw))))
            check(edit("0.16") is ProjectIntents.EditorEditResult.Applied); checks++
            check(edit("abc") is ProjectIntents.EditorEditResult.Applied); checks++
            val refused = editor.commit() as ProjectIntents.EditorCommitResult.Refused
            check(string(refused.value.message) == "Settings draft contains 1 validation issue"); checks++
            check(edit("0.16") is ProjectIntents.EditorEditResult.Applied); checks++
            val committed = editor.commit() as ProjectIntents.EditorCommitResult.Committed
            check(committed.value.revision == committed.value.baseRevision + 1); checks++
            check(editor.overrides().contains("\"layer_height\":0.16")); checks++
            val unknown = editor.edit(ProjectIntents.EditorEdit.Clear(ProjectIntents.EditorFieldRef(text("nope"))))
            check(string((unknown as ProjectIntents.EditorEditResult.Refused).value.message) == "Unknown settings field \"nope\""); checks++
            check(failure { editor.state(ProjectIntents.EditorFieldRef(text("nope"))) } == "unknown_field"); checks++
        }
        check(ProjectIntents.encodeEditorStep(SettingsEditor.step(ProjectIntents.decodeEditorStepRequest(lines[6]))) == lines[7]); checks++
        check(ProjectIntents.encodeEditorRules(SettingsEditor.rules(ProjectIntents.decodeEditorRuleRequest(lines[8]))) == lines[9]); checks++
        SettingsEditor(ProjectIntents.decodeEditorCreate(lines[10])).use { editor ->
            check(editor.rows(ProjectIntents.decodeEditorRowsRequest(lines[11])) == lines[12].toLong()); checks++
            check(failure { editor.row(lines[12].toLong()) } == "invalid_range"); checks++
        }

        // Search folding: the platform folds `mm3` onto `mm³`. The ASCII
        // built-in cannot search this schema, whose tooltips are not ASCII,
        // but lists without searching. Failing callbacks refuse.
        val search = { term: String -> ProjectIntents.decodeEditorQuery(lines[3]).copy(search = text(term)) }
        SettingsEditor(create).use { editor ->
            check(editor.query(search("mm3/s2")) == 1L); checks++
            check(string(editor.field(0).key) == "max_volumetric_extrusion_rate_slope"); checks++
        }
        SettingsEditor(create, folder = null).use { editor ->
            check(failure { editor.query(search("mm³")) } == "non_ascii_search"); checks++
            check(failure { editor.query(search("layer")) } == "non_ascii_search"); checks++
            check(editor.query(search("")) > lines[4].toLong()); checks++
        }
        SettingsEditor(create, folder = SearchFolding { error("PRIVATE folding detail") }).use { editor ->
            check(failure { editor.query(search("layer")) } == "folding_failed"); checks++
        }
        SettingsEditor(create, collator = PresetCollator { _, _ -> error("PRIVATE collator detail") }).use { editor ->
            check(failure { editor.query(search("")) } == "collation_failed"); checks++
        }
        val stray = create.copy(overridesJson = text("{\"not_a_setting\":1}"))
        check(failure { SettingsEditor(stray) } == "invalid_editor"); checks++
        return checks
    }
}
