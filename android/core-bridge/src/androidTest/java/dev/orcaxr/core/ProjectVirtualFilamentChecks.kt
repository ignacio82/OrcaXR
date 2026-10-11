package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The virtual filament library on a real session, as the browser's library
 * shows and edits it (`virtual-filament-vectors.json`): the browser's
 * canonical 3MF opens in a [ProjectWorkspace] with the browser's semantic
 * hash and its library in the view; each journey step reads the view's
 * library (the browser's, byte for byte), opens the author dialog's fields
 * as the browser opens them ([VirtualFilaments.opening]), runs the pinned
 * Match search where the browser ran it ([VirtualFilaments.search]),
 * validates the browser's fields to the browser's draft
 * ([VirtualFilaments.validate]) and submits the edit
 * ([ProjectWorkspace.changeVirtualFilament]) — a recipe added in each mode,
 * edited into another mode, duplicated, disabled, enabled, deleted
 * unreferenced (removed) and referenced or automatic (tombstoned), and an
 * incompatible pair refused in the browser's words — leaving the browser's
 * hash and undo label; undo then passes back through every state to the one
 * opened. The dialog's triangle picker answers as the browser's.
 */
object ProjectVirtualFilamentChecks {
    private const val WAIT_S = 60L

    private class Memory(private val bytes: ByteArray) : ProjectDocumentInput {
        override val reportedLength: Long get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun <T> attempt(future: CompletableFuture<T>): Result<T> = try {
        Result.success(future.get(WAIT_S, TimeUnit.SECONDS))
    } catch (thrown: ExecutionException) {
        Result.failure(thrown.cause ?: thrown)
    }
    private fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view.virtualFilaments}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun shown(view: ProjectView): VirtualFilamentLibrary? =
        (view.virtualFilaments as? VirtualFilamentLibraryResult.Shown)?.library

    /** [journey] is the corpus's `{"opened","steps","undo"}`, [archive] its 3MF. */
    @JvmStatic fun run(journey: String, archive: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(journey) as ProjectJsonObject
        val ids = ProjectIds()
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }, ids = ids).use { workspace ->
            done(workspace.ready())
            check(done(workspace.open(Memory(archive), "virtual-filaments.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(until(workspace) { it.revision?.semanticHash == opened }.undo == null, "opened_hash")

            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val keys = step.keys().asSequence().toSet()
                val expected = step.get("libraryJson") as String
                val library = checkNotNull(shown(until(workspace) { shown(it)?.json == expected })) { "step_${index}_library" }
                check(library.json == expected, "step_${index}_library_json")
                val operation = step.get("operation") as String
                val filamentId = step.get("filamentId") as? String
                if (filamentId != null) check(library.rows.any { it.id == filamentId }, "step_${index}_row_listed")
                val change: VirtualFilamentEdit = when (operation) {
                    "add", "edit", "duplicate" -> {
                        val kind = VirtualFilamentOperation.entries.first { it.wire == operation }
                        // The dialog opens as the browser's opened.
                        val opening = VirtualFilaments.opening(library, kind, filamentId)
                        check(opening.json() == step.get("openedJson") as String, "step_${index}_opening ${opening.json()}")
                        val form = VirtualFilaments.form(step.get("formJson") as String)
                        check(form.json() == step.get("formJson") as String, "step_${index}_form_round_trip")
                        val searchJson = step.get("searchJson") as String
                        val search = if (searchJson == "null") {
                            null
                        } else {
                            val ask = checkNotNull(VirtualFilaments.validate(library, form.copy(matchSelected = null), null).matchSearch) {
                                "step_${index}_search_asked"
                            }
                            val candidates = VirtualFilaments.search(library, ask)
                            check("{\"candidates\":$candidates,\"status\":\"ready\"}" == searchJson, "step_${index}_search")
                            VirtualFilamentSearch.Ready(candidates)
                        }
                        val validation = VirtualFilaments.validate(library, form, search)
                        check(validation.issues.isEmpty() && validation.draftJson == step.get("draftJson") as String, "step_${index}_draft ${validation.issues}")
                        val draft = checkNotNull(validation.draftJson)
                        when (operation) {
                            "add" -> VirtualFilamentEdit.Add(draft)
                            "edit" -> VirtualFilamentEdit.Edit(checkNotNull(filamentId), draft)
                            else -> VirtualFilamentEdit.Duplicate(checkNotNull(filamentId), draft)
                        }
                    }
                    "set-enabled" -> VirtualFilamentEdit.SetEnabled(checkNotNull(filamentId), step.get("enabled") as Boolean)
                    else -> VirtualFilamentEdit.Delete(checkNotNull(filamentId))
                }
                // The new recipe takes the ID the browser's controller drew.
                (step.get("newId") as? String)?.let { ids.giveBack(listOf(it)) }
                val outcome = attempt(workspace.changeVirtualFilament(change))
                val refusal = if ("refusal" in keys) step.get("refusal") as? String else null
                if (refusal != null) {
                    check(outcome.exceptionOrNull()?.message == refusal, "step_${index}_refused ${outcome.exceptionOrNull()}")
                } else {
                    val planned = outcome.getOrNull()
                    check(planned != null && planned.label == step.get("undoLabel") as String, "step_${index}_planned ${outcome.exceptionOrNull()}")
                    if (step.get("newId") is String) check(planned?.filamentId == step.get("newId"), "step_${index}_new_id")
                }
                val after = until(workspace) { it.revision?.semanticHash == step.get("semanticHash") }
                check(after.undo == step.get("undoLabel") as? String, "step_${index}_label ${after.undo}")
            }

            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(until(workspace) { it.revision?.semanticHash == entry.get("semanticHash") }.undo == entry.get("undoLabel") as? String, "undo_${index}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
            // The library follows history: the opened project's recipes again.
            val first = (steps.get(0) as ProjectJsonObject).get("libraryJson") as String
            check(shown(until(workspace) { shown(it)?.json == first })?.rows?.isNotEmpty() == true, "library_follows_undo")
        }

        // The triangle picker: its corners, its centre and a point too far to place.
        check(VirtualFilaments.triangleWeights(120.0, 18.0) == listOf("80.01", "9.99", "9.99"), "triangle_corner_a")
        check(VirtualFilaments.triangleWeights(120.0, 138.0) == listOf("33.33", "33.33", "33.33"), "triangle_centre")
        check(VirtualFilaments.triangleWeights(1e308, -1e308) == null, "triangle_far")
        return checks
    }
}
