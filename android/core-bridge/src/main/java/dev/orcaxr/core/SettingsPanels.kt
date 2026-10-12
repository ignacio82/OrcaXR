package dev.orcaxr.core

/** The settings panel's detail level (`SettingsEditorMode`). */
enum class SettingsPanelMode(internal val wire: String) {
    SIMPLE("simple"),
    ADVANCED("advanced"),
    DEVELOP("develop"),
}

/** The control a settings row draws, holding what the field shows. */
sealed interface SettingsPanelControl {
    /** The Full Spectrum recipes: pointed at their structured editor ([value] in the browser's words). */
    data class Structured(val editorId: String, val value: String) : SettingsPanelControl
    /** A field the panel cannot edit, shown as disabled text. */
    data class Locked(val value: String) : SettingsPanelControl
    data class Checkbox(val checked: Boolean) : SettingsPanelControl
    /** [nil] is the leading "Not set" choice's value, for a nullable option. */
    data class Select(val value: String, val nil: String?, val choices: List<Choice>) : SettingsPanelControl
    data class Textarea(val value: String, val rows: Int) : SettingsPanelControl
    /** [inputMode] is `numeric` or `decimal` for numbers. */
    data class Text(val value: String, val inputMode: String?, val spellcheck: Boolean) : SettingsPanelControl
    data class Choice(val value: String, val label: String)
}

data class SettingsPanelIssue(val code: String, val message: String)

/**
 * One setting as the browser's generated settings panel draws it
 * (`SettingsPanelRow`): its label, key and unit, the control with the value
 * it holds, the origin badge ([originLabel], the browser's English), whether
 * the draft changed it, why it is unavailable or structured, "Use inherited"
 * and "Use default", and its issues in the browser's words.
 */
data class SettingsPanelRow(
    val fieldId: String,
    val key: String,
    val label: String,
    val unit: String?,
    val tooltip: String?,
    val support: String,
    val applicability: String,
    val editable: Boolean,
    val dependencyEnabled: Boolean,
    val control: SettingsPanelControl,
    val origin: String,
    val originLabel: String,
    val draftChanged: Boolean,
    /** `structured-editor` or `unavailable`. */
    val availability: String?,
    val inherit: Boolean,
    val useDefault: Boolean,
    val unavailableReason: String?,
    /** "Unavailable: …", the browser's sentence. */
    val unavailableMessage: String?,
    val structuredEditor: String?,
    val dependencyController: String?,
    val issues: List<SettingsPanelIssue>,
) {
    /** Typed, offered and turned on: the generic editor edits it. */
    val draftable: Boolean get() = editable && dependencyEnabled
}

/** A GUI group of the panel ("Process · Quality · Layer height"), or a category. */
data class SettingsPanelSection(
    val id: String,
    val label: String,
    val surface: String?,
    val page: String?,
    val group: String?,
    val rows: List<SettingsPanelRow>,
)

/** What the panel shows for a detail level and a search; [summary] is the browser's "n settings shown; m unavailable." */
data class SettingsPanelView(val shown: Int, val unavailable: Int, val summary: String, val sections: List<SettingsPanelSection>) {
    val rows: List<SettingsPanelRow> get() = sections.flatMap { it.rows }
}

/** A draft's outcome: drafted, a default the codec could not write, or the browser editor's refusal. */
sealed interface SettingsPanelEdit {
    data object Applied : SettingsPanelEdit
    data class Unserializable(val message: String) : SettingsPanelEdit
    data class Refused(val message: String) : SettingsPanelEdit
}

/** Whether Apply has something valid to apply, and how many fields hold a draft. */
data class SettingsPanelState(val changed: Boolean, val drafts: Int, val invalid: Boolean)

/** Apply's commit: so many changes; none (the drafts dropped); invalid drafts; or a failure, in the browser's words. */
sealed interface SettingsPanelApply {
    data class Committed(val changes: Int) : SettingsPanelApply
    data object Unchanged : SettingsPanelApply
    data class Invalid(val message: String) : SettingsPanelApply
    data class Failed(val message: String) : SettingsPanelApply
}

/** The scoped panel's words for a target: its picker text, what its values do, and its heading. */
data class SettingsTargetText(val text: String, val summary: String, val heading: String)

/**
 * The browser's generated and scoped settings panels in the shared core
 * (`settings::editor::panel_exchange`, from `settingsPanel.ts`), read into
 * Kotlin values.
 */
object SettingsPanels {
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }
    private fun string(obj: ProjectJsonObject, key: String) = obj.get(key) as String
    private fun optional(obj: ProjectJsonObject, key: String) = if (has(obj, key)) obj.get(key) as String else null
    private fun flag(obj: ProjectJsonObject, key: String) = obj.get(key) as Boolean
    private fun count(obj: ProjectJsonObject, key: String) = (obj.get(key) as Double).toInt()
    private fun objects(value: Any): List<ProjectJsonObject> = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as ProjectJsonObject } }

    internal fun request(vararg members: Pair<String, String>): String =
        members.sortedBy { it.first }.joinToString(",", "{", "}") { CanonicalJson.quote(it.first) + ":" + CanonicalJson.quote(it.second) }

    private fun control(obj: ProjectJsonObject): SettingsPanelControl = when (string(obj, "kind")) {
        "structured" -> SettingsPanelControl.Structured(string(obj, "editorId"), string(obj, "value"))
        "locked" -> SettingsPanelControl.Locked(string(obj, "value"))
        "checkbox" -> SettingsPanelControl.Checkbox(flag(obj, "checked"))
        "select" -> SettingsPanelControl.Select(
            string(obj, "value"),
            optional(obj, "nil"),
            objects(obj.get("choices")).map { SettingsPanelControl.Choice(string(it, "value"), string(it, "label")) },
        )
        "textarea" -> SettingsPanelControl.Textarea(string(obj, "value"), count(obj, "rows"))
        "text" -> SettingsPanelControl.Text(string(obj, "value"), optional(obj, "inputMode"), flag(obj, "spellcheck"))
        else -> throw InvalidProjectIntent()
    }

    internal fun row(obj: ProjectJsonObject): SettingsPanelRow {
        val unavailable = if (has(obj, "unavailable")) obj.get("unavailable") as ProjectJsonObject else null
        return SettingsPanelRow(
            fieldId = string(obj, "fieldId"),
            key = string(obj, "key"),
            label = string(obj, "label"),
            unit = optional(obj, "unit"),
            tooltip = optional(obj, "tooltip"),
            support = string(obj, "support"),
            applicability = string(obj, "applicability"),
            editable = flag(obj, "editable"),
            dependencyEnabled = flag(obj, "dependencyEnabled"),
            control = control(obj.get("control") as ProjectJsonObject),
            origin = string(obj, "origin"),
            originLabel = string(obj, "originLabel"),
            draftChanged = flag(obj, "draftChanged"),
            availability = optional(obj, "availability"),
            inherit = flag(obj, "inherit"),
            useDefault = flag(obj, "useDefault"),
            unavailableReason = unavailable?.let { string(it, "reason") },
            unavailableMessage = unavailable?.let { string(it, "message") },
            structuredEditor = optional(obj, "structuredEditor"),
            dependencyController = optional(obj, "dependencyController"),
            issues = objects(obj.get("issues")).map { SettingsPanelIssue(string(it, "code"), string(it, "message")) },
        )
    }

    /** A `view` reply. */
    fun view(json: String): SettingsPanelView {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return SettingsPanelView(
            count(obj, "shown"),
            count(obj, "unavailable"),
            string(obj, "summary"),
            objects(obj.get("sections")).map { s ->
                SettingsPanelSection(
                    string(s, "id"), string(s, "label"), optional(s, "surface"), optional(s, "page"), optional(s, "group"),
                    objects(s.get("rows")).map(::row),
                )
            },
        )
    }

    /** A `row` reply: the row, or null with the editor's refusal ignored (an unknown field). */
    fun row(json: String): SettingsPanelRow? {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return if (has(obj, "row")) row(obj.get("row") as ProjectJsonObject) else null
    }

    fun edit(json: String): SettingsPanelEdit {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return when (string(obj, "outcome")) {
            "applied" -> SettingsPanelEdit.Applied
            "unserializable" -> SettingsPanelEdit.Unserializable(string(obj, "message"))
            "refused" -> SettingsPanelEdit.Refused(string(obj, "message"))
            else -> throw InvalidProjectIntent()
        }
    }

    fun state(json: String): SettingsPanelState {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return SettingsPanelState(flag(obj, "changed"), count(obj, "drafts"), flag(obj, "invalid"))
    }

    fun apply(json: String): SettingsPanelApply {
        val obj = CanonicalJson.read(json) as ProjectJsonObject
        return when (string(obj, "outcome")) {
            "committed" -> SettingsPanelApply.Committed(count(obj, "changes"))
            "unchanged" -> SettingsPanelApply.Unchanged
            "invalid" -> SettingsPanelApply.Invalid(string(obj, "message"))
            "failed" -> SettingsPanelApply.Failed(string(obj, "message"))
            else -> throw InvalidProjectIntent()
        }
    }

    /**
     * The scoped panel's words for a target of [scope] (`project`, `plate`,
     * `object`, `part` or `layerRange`): `Object: Plate 1 › Cube — 2 overrides`,
     * its summary and its heading.
     */
    fun targetText(scope: String, label: String, path: String, overrideCount: Long): SettingsTargetText {
        val request = "{\"label\":${CanonicalJson.quote(label)},\"overrideCount\":$overrideCount," +
            "\"path\":${CanonicalJson.quote(path)},\"scope\":${CanonicalJson.quote(scope)}}"
        val obj = CanonicalJson.read(NativeProject.settingsTargetText(request)) as ProjectJsonObject
        return SettingsTargetText(string(obj, "text"), string(obj, "summary"), string(obj, "heading"))
    }
}
