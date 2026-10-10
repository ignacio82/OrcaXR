package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** A catalog choice on a real session, as the browser's workspace commits it:
 * a bare model is blocked by the authored preflight; the catalog's default
 * profile becomes the project's own configuration as one undoable "Update
 * slicing configuration" that undo and redo move across, applying it again
 * changes nothing, the catalog preflight of the chosen profile passes, and
 * a new project keeps the configuration with nothing to undo. */
object ProjectSlicingChoiceChecks {
    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    @JvmStatic fun run(cube: ByteArray, catalogJson: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(60, TimeUnit.SECONDS)
        // The view follows the session's answers; wait for it rather than read it once.
        fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (!condition(workspace.view)) {
                kotlin.check(System.nanoTime() < deadline) { "view_timeout ${workspace.view}" }
                Thread.sleep(20)
            }
            return workspace.view
        }
        // The host has no ICU; the bundled catalog's preset names are ASCII.
        ProfileCatalogs.build(catalogJson, collator = null).use { catalog ->
            val chosen = checkNotNull(catalog.defaultSelection(LiveSlicingChoice.EMPTY)) { "no_default" }
            check(chosen.feedback.applied && chosen.live?.profile != null, "default_selected")
            val live = checkNotNull(chosen.live)
            ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
                done(workspace.ready())
                done(workspace.commitImport(done(workspace.prepareImport(Memory(cube), "cube.stl")), emptyList()))
                val plate = checkNotNull(until(workspace) { it.activePlate?.objects == 1 }.activePlate).id
                // A bare model carries no printer or filaments: the authored preflight blocks it.
                check(!done(workspace.preflight(plate)).summary.canSlice, "authored_blocks_bare_model")

                check(done(workspace.applySlicingChoice(catalog, live)), "choice_applied")
                check(until(workspace) { it.undo == "Update slicing configuration" }.undo != null, "one_undoable_step")
                check(!done(workspace.applySlicingChoice(catalog, live)), "same_choice_unchanged")
                val target = { tools: Int -> checkNotNull(ProfileCatalogs.preflightTarget(catalog, live, tools)) }
                val passed = done(workspace.preflight(plate, target))
                check(passed.summary.canSlice, "catalog_preflight_passes ${passed.issues.map { it.code }}")

                done(workspace.undo())
                check(until(workspace) { it.redo == "Update slicing configuration" }.redo != null, "undo_removes_configuration")
                check(!done(workspace.preflight(plate, target)).summary.canSlice, "undone_configuration_blocks")
                done(workspace.redo())
                check(done(workspace.preflight(plate, target)).summary.canSlice, "redo_restores_configuration")

                // A new project keeps the printer and filaments, as the browser's does, with nothing to undo.
                done(workspace.newProject())
                check(until(workspace) { it.undo == null && it.activePlate?.objects == 0 }.redo == null, "new_project_clean")
                done(workspace.commitImport(done(workspace.prepareImport(Memory(cube), "cube.stl")), emptyList()))
                val fresh = checkNotNull(until(workspace) { it.activePlate?.objects == 1 }.activePlate).id
                check(done(workspace.preflight(fresh, target)).summary.canSlice, "new_project_keeps_configuration")
            }
        }
        return checks
    }
}
