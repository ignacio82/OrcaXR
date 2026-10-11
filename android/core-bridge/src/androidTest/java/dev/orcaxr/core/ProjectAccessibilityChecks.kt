package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * What the Workspace's 3D view says to an accessibility service
 * ([ProjectSceneSummary]) on a real session, over JNI, as the project
 * changes: a new project's empty first plate; a cube and then a cylinder
 * from the Add menu, each landing selected and named as the object tree
 * names it; Select All naming both in tree order and Deselect All none; a
 * new plate (active, empty) and its undo, back to the first plate's two
 * objects. Each state is the session's own, read from [ProjectWorkspace.view].
 */
object ProjectAccessibilityChecks {
    private const val WAIT_S = 60L

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view}" }
            Thread.sleep(5)
        }
        return workspace.view
    }

    /** The tree's object rows' names, in tree order. */
    private fun objectNames(view: ProjectView): List<String> =
        view.rows.filter { (it.entity as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value is ProjectIntents.ObjectTreeEntity.Object }
            .map { text(it.label) }

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace().use { workspace ->
            done(workspace.ready())
            val fresh = until(workspace, "fresh") { it.ready && it.activePlate != null }
            val first = fresh.activePlate!!.name
            var summary = ProjectSceneSummary.of(fresh)
            check(summary.plate == first && first.isNotEmpty(), "fresh plate $summary")
            check(summary.objects == 0 && summary.selected.isEmpty() && summary.selection == 0L, "fresh empty $summary")

            // A cube from the Add menu lands selected: the view names it as the tree does.
            check(done(workspace.addPrimitive(PrimitiveShape.CUBE)) != null, "cube added")
            var view = until(workspace, "cube") { ProjectSceneSummary.of(it).let { s -> s.objects == 1 && s.selected.isNotEmpty() } }
            val cube = objectNames(view).single()
            summary = ProjectSceneSummary.of(view)
            check(summary.plate == first, "cube plate $summary")
            check(summary.selected == listOf(cube), "cube selected $summary")
            check(summary.selection >= 1L, "cube selection $summary")

            // A cylinder: two objects, the new one alone selected.
            check(done(workspace.addPrimitive(PrimitiveShape.CYLINDER)) != null, "cylinder added")
            view = until(workspace, "cylinder") { ProjectSceneSummary.of(it).let { s -> s.objects == 2 && s.selected.isNotEmpty() && s.selected != listOf(cube) } }
            val names = objectNames(view)
            check(names.size == 2 && names[0] == cube && names[1] != cube, "tree order $names")
            summary = ProjectSceneSummary.of(view)
            check(summary.selected == listOf(names[1]), "cylinder selected $summary")

            // Select All names both, in tree order, each once; Deselect All none.
            check(done(workspace.selectAll()), "select all")
            view = until(workspace, "select all") { ProjectSceneSummary.of(it).selected.size == 2 }
            summary = ProjectSceneSummary.of(view)
            check(summary.selected == names, "all selected $summary")
            check(summary.selection >= 2L, "all selection $summary")
            check(done(workspace.deselectAll()), "deselect all")
            view = until(workspace, "deselect all") { ProjectSceneSummary.of(it).selection == 0L }
            summary = ProjectSceneSummary.of(view)
            check(summary.selected.isEmpty() && summary.objects == 2, "none selected $summary")

            // A new plate is the active one, and empty; undo returns to the first and its objects.
            val added = done(workspace.addPlate())
            check(added != null, "plate added")
            view = until(workspace, "new plate") { it.activePlate?.id == added }
            summary = ProjectSceneSummary.of(view)
            check(summary.plate != null && summary.plate != first && summary.objects == 0, "new plate $summary")
            check(summary.plate == view.plateList.single { it.id == added }.name, "new plate name $summary")
            done(workspace.undo())
            view = until(workspace, "undone") { it.activePlate?.name == first && it.plateList.size == 1 }
            summary = ProjectSceneSummary.of(view)
            check(summary.plate == first && summary.objects == 2, "undone $summary")
        }
        return checks
    }
}
