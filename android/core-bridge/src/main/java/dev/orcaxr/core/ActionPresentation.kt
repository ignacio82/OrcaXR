package dev.orcaxr.core

/** One action as a shell shows it, which the command palette searches: its catalogue [id] and, in the shell's language, its [label] and [hint]. */
data class PaletteSearchable(val id: String, val label: String, val hint: String? = null)

/** One section of a grouped menu, or one run of the toolbar: the catalogue group's [group] id and the browser's [label] for it, and its [members]' positions. */
data class ActionSection(val group: String, val label: String, val members: List<Int>)

/** How a shell arranges a list of catalogue actions. */
enum class ActionArrangement(internal val wire: String) {
    /** A context menu: one section per catalogue group, in the groups' declared order. */
    CONTEXT("context"),
    /** The model toolbar: a run wherever the group changes. */
    TOOLBAR("toolbar"),
}

/**
 * How the browser's shells arrange catalogue actions (`ActionPresentation.ts`,
 * in the shared core as `orcaxr_project::action_presentation`): the command
 * palette's search — label, id or hint containing the trimmed query, every
 * text lowercased as `toLowerCase` does, in the order given — and a context
 * menu's sections or the model toolbar's runs, with the browser's group
 * labels. Refusals (an action the catalogue does not have) throw.
 */
object ActionPresentation {
    private fun indices(value: Any): List<Int> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { (list.get(it) as Number).toInt() } }

    /** The positions of [actions] the palette's [query] matches, in their order. */
    fun paletteMatches(query: String, actions: List<PaletteSearchable>): List<Int> {
        val request = buildString {
            append("{\"actions\":[")
            actions.forEachIndexed { index, action ->
                if (index > 0) append(',')
                append('{')
                action.hint?.let { append("\"hint\":").append(CanonicalJson.quote(it)).append(',') }
                append("\"id\":").append(CanonicalJson.quote(action.id))
                append(",\"label\":").append(CanonicalJson.quote(action.label))
                append('}')
            }
            append("],\"query\":").append(CanonicalJson.quote(query)).append('}')
        }
        val reply = CanonicalJson.read(NativeProject.commandPalette(request)) as ProjectJsonObject
        return indices(reply.get("matches"))
    }

    /** The [items] the palette's [query] matches, each searched as [searchable] shows it. */
    fun <T> palette(query: String, items: List<T>, searchable: (T) -> PaletteSearchable): List<T> =
        paletteMatches(query, items.map(searchable)).map(items::get)

    /** The sections (or runs) [ids] fall into under [arrangement]. */
    fun sections(ids: List<String>, arrangement: ActionArrangement): List<ActionSection> {
        val request = ids.joinToString(",", "{\"actions\":[", "],\"layout\":\"${arrangement.wire}\"}", transform = CanonicalJson::quote)
        val reply = CanonicalJson.read(NativeProject.actionGroups(request)) as ProjectJsonObject
        val groups = reply.get("groups") as ProjectJsonArray
        return List(groups.length()) {
            val group = groups.get(it) as ProjectJsonObject
            ActionSection(group.get("group") as String, group.get("label") as String, indices(group.get("actions")))
        }
    }

    /** [items] arranged under [arrangement], each named by its catalogue [id]: every section with its members. */
    fun <T> arrange(items: List<T>, arrangement: ActionArrangement, id: (T) -> String): List<Pair<ActionSection, List<T>>> =
        sections(items.map(id), arrangement).map { section -> section to section.members.map(items::get) }
}
