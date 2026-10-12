package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * The command palette, the model toolbar and the context menus over JNI.
 *
 * [run]'s script replays `action-presentation-vectors.json` through the
 * Kotlin wrapper: every palette search over every language's catalogue
 * ([ActionPresentation.paletteMatches]) and every menu's sections and
 * toolbar's runs ([ActionPresentation.sections]) as the browser answers them,
 * and the refusals the typed calls can make (actions the catalogue does not
 * have). Then a real session: the palette lists the whole catalogue in its
 * order with the core's enablement and reasons
 * ([ProjectWorkspace.surfaceActions]); a search finds the cube, which the Add
 * menu's call adds as "Add cube.stl"; the toolbar's runs, its Delete enabled
 * once a model is selected; the object and plate menus in the browser's
 * sections; Clone Selected from the object menu ("Create instance"), the
 * toolbar's Delete ("Delete instance"), Deselect All leaving Delete disabled
 * with the browser's reason, and undo.
 */
object ProjectCommandPaletteChecks {
    private const val WAIT_S = 60L
    /** The browser catalogue's size (`buildRegistry`), every action on `command-palette`. */
    private const val CATALOGUE = 226
    private const val NEEDS_INSTANCE = "Select a model instance for this action."

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)

    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view}" }
            Thread.sleep(5)
        }
        return workspace.view
    }

    private fun json(text: String) = CanonicalJson.read(text)
    private fun indices(value: Any): List<Int> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { (list.get(it) as Number).toInt() } }
    private fun strings(value: Any): List<String>? =
        (value as? ProjectJsonArray)?.let { list -> List(list.length()) { list.get(it) as? String ?: return null } }
    private fun searchable(value: Any): List<PaletteSearchable> = (value as ProjectJsonArray).let { list ->
        List(list.length()) {
            val action = list.get(it) as ProjectJsonObject
            val keys = action.keys().asSequence().toSet()
            PaletteSearchable(action.get("id") as String, action.get("label") as String, if ("hint" in keys) action.get("hint") as String else null)
        }
    }
    private fun arrangement(value: Any?) = ActionArrangement.entries.firstOrNull { it.wire == value }

    /** [script] lines (tab-separated): `C <actions>` catalogues in order, `P <catalogue> <query> <reply>`
     * palette searches, `G <request> <reply>` arrangements and `X <exchange> <request>` refusals. */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val catalogues = ArrayList<List<PaletteSearchable>>()
        for (line in script.split("\n")) {
            val entry = line.split("\t")
            when (entry[0]) {
                "C" -> catalogues += searchable(json(entry[1]))
                "P" -> {
                    val query = json(entry[2]) as String
                    val expected = indices((json(entry[3]) as ProjectJsonObject).get("matches"))
                    val found = ActionPresentation.paletteMatches(query, catalogues[entry[1].toInt()])
                    check(found == expected, "palette_$checks $found")
                }
                "G" -> {
                    val request = json(entry[1]) as ProjectJsonObject
                    val groups = (json(entry[2]) as ProjectJsonObject).get("groups") as ProjectJsonArray
                    val expected = List(groups.length()) {
                        val group = groups.get(it) as ProjectJsonObject
                        ActionSection(group.get("group") as String, group.get("label") as String, indices(group.get("actions")))
                    }
                    val sections = ActionPresentation.sections(strings(request.get("actions"))!!, arrangement(request.get("layout"))!!)
                    check(sections == expected, "sections_$checks $sections")
                }
                "X" -> {
                    // Only what a typed call can ask: a list of names under a known arrangement.
                    val request = runCatching { json(entry[2]) as ProjectJsonObject }.getOrNull() ?: continue
                    val keys = request.keys().asSequence().toSet()
                    if (entry[1] != "groups" || keys != setOf("actions", "layout")) continue
                    val ids = strings(request.get("actions")) ?: continue
                    val layout = arrangement(request.get("layout")) ?: continue
                    val refused = runCatching { ActionPresentation.sections(ids, layout) }.exceptionOrNull()
                    check(refused?.message?.contains("invalid_request") == true, "refused_$checks $ids $refused")
                }
            }
        }
        check(catalogues.size == 21, "catalogues ${catalogues.size}")
        return checks + session()
    }

    private fun session(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace().use { workspace ->
            done(workspace.ready())
            until(workspace, "fresh") { it.ready && it.activePlate != null }

            // The palette lists the whole catalogue, in its order, with the core's enablement and reasons.
            var palette = done(workspace.surfaceActions(ProjectIntents.ActionSurface.CommandPalette))
            check(palette.size == CATALOGUE, "catalogue ${palette.size}")
            check(palette.first().id == "file_recover_project" && palette.last().id == "help_about", "catalogue order")
            check(palette.map { it.id }.toSet().size == CATALOGUE, "each action once")
            palette.single { it.id == "delete_models" }.let { check(!it.enabled && it.reason == NEEDS_INSTANCE, "delete without a model $it") }
            palette.single { it.id == "tool_cut" }.let { check(!it.enabled && it.reason!!.startsWith("Plane cutting is disabled"), "unavailable $it") }
            check(palette.single { it.id == "add_primitive_cube" }.let { it.enabled && it.label == "Cube" }, "cube offered")

            // A search, trimmed and without case, in catalogue order; the cube is the Add menu's.
            val found = ActionPresentation.palette(" CUBE ", palette) { PaletteSearchable(it.id, it.label) }
            check(found.map { it.id } == listOf("add_primitive_cube", "add_calibration_cube"), "found ${found.map { it.id }}")
            check(ActionPresentation.palette("zzzz", palette) { PaletteSearchable(it.id, it.label) }.isEmpty(), "nothing found")
            check(ActionPresentation.palette("", palette) { PaletteSearchable(it.id, it.label) } == palette, "everything for nothing")
            check(done(workspace.addPrimitive(PrimitiveShape.CUBE)) != null, "cube run")
            var view = until(workspace, "cube") { it.undo == "Add cube.stl" && it.selection.instances.size == 1 }

            // The toolbar, in its runs; Delete enabled for the selected model.
            var toolbar = done(workspace.surfaceActions(ProjectIntents.ActionSurface.DomToolbar))
            val drawn = listOf("tool_lay_on_face", "tool_paint", "drop_to_bed", "delete_models", "tool_support_paint", "tool_seam_paint", "tool_fuzzy_skin", "tool_measure")
            check(toolbar.map { it.id }.filter { it in drawn } == drawn, "toolbar order ${toolbar.map { it.id }}")
            val runs = ActionPresentation.arrange(toolbar, ActionArrangement.TOOLBAR) { it.id }
            check(runs.flatMap { it.second } == toolbar, "runs cover the toolbar")
            check(runs.zipWithNext().all { (a, b) -> a.first.group != b.first.group }, "a run per change of group")
            check(runs.first().first.label == "Scene" && runs.any { it.first.label == "Paint" }, "runs ${runs.map { it.first.label }}")
            check(toolbar.single { it.id == "delete_models" }.enabled, "delete for a selection")
            palette = done(workspace.surfaceActions(ProjectIntents.ActionSurface.CommandPalette))
            check(palette.single { it.id == "delete_models" }.enabled, "palette follows the selection")

            // The scene's context menus, in the browser's sections.
            val objectMenu = ActionPresentation.arrange(view.objectMenu, ActionArrangement.CONTEXT) { it.id }
            check(objectMenu.map { it.first.label } == listOf("Edit", "Scene"), "object sections ${objectMenu.map { it.first.label }}")
            check(objectMenu[0].second.map { it.id } == listOf("edit_duplicate", "edit_delete_selected"), "object edits")
            check(objectMenu.flatMap { it.second }.all { it.enabled || it.reason != null }, "disabled entries say why")
            val plateMenu = ActionPresentation.arrange(view.plateMenu, ActionArrangement.CONTEXT) { it.id }
            check(plateMenu.map { it.first.label } == listOf("File", "Edit", "Scene", "Slice", "System"), "plate sections ${plateMenu.map { it.first.label }}")
            check(plateMenu.last().second.map { it.id } == listOf("add_plate", "delete_plate"), "plate system")
            check(view.objectMenu.single { it.id == "edit_duplicate" }.enabled, "clone offered")

            // Clone Selected from the object menu, then the toolbar's Delete: the menus' calls, each one step.
            check(done(workspace.cloneSelected()) != null, "cloned")
            view = until(workspace, "clone") { it.undo == "Create instance" }
            check(view.selection.instances.size == 1, "the copy is selected")
            done(workspace.deleteSelected())
            view = until(workspace, "deleted") { it.undo == "Delete instance" }

            // Nothing selected: the toolbar's Delete says why, in the browser's words.
            done(workspace.deselectAll())
            until(workspace, "deselected") { it.selection.instances.isEmpty() }
            toolbar = done(workspace.surfaceActions(ProjectIntents.ActionSurface.DomToolbar))
            toolbar.single { it.id == "delete_models" }.let { check(!it.enabled && it.reason == NEEDS_INSTANCE, "delete needs a model $it") }
            done(workspace.undo())
            view = until(workspace, "undone") { it.redo == "Delete instance" }
            check(view.undo == "Create instance", "undo ${view.undo}")
        }
        return checks
    }
}
