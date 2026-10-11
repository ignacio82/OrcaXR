package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The project's filaments on a real session, as the browser's workspace
 * lists and assigns them.
 *
 * Assignment (`filament-assignment-vectors.json`): the browser's canonical
 * 3MF opens in a [ProjectWorkspace] with the browser's semantic hash; each
 * journey step selects as the browser's controller did, the view's
 * assignment snapshot is the browser's (scopes, unsupported refs, offered
 * filaments), and [ProjectWorkspace.assignFilament] leaves the project with
 * the browser's hash and undo label — "Assign filament", "Assign n scopes",
 * nothing for a choice already made or an unsupported selection, a disabled
 * destination refused in its words — with the tree's filament badges after;
 * undo passes back through every state to the one opened.
 *
 * The filament list: on a cube configured with the catalog's default
 * profile, [ProjectWorkspace.editFilamentSlots] adds a slot (the profile's
 * own filament, grey PLA, one undoable "Update slicing configuration"),
 * refuses to remove a head's slot, follows undo (an undone slot is not
 * brought back by the next colour edit), recolours a slot, changes a head's
 * nozzle, removes an extra slot, fills the palette to sixteen and refuses a
 * seventeenth in the browser's words; an assignment then reaches an added
 * slot and its tree row shows it.
 */
object ProjectFilamentChecks {
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
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun entity(ref: ProjectJsonObject): ProjectIntents.SelectionEntity {
        val id = units(ref.get("id") as String)
        return when (ref.get("kind") as String) {
            "plate" -> ProjectIntents.SelectionEntity.Plate(id)
            "object" -> ProjectIntents.SelectionEntity.Object(id)
            "volume" -> ProjectIntents.SelectionEntity.Volume(id)
            "instance" -> ProjectIntents.SelectionEntity.Instance(id)
            else -> ProjectIntents.SelectionEntity.LayerRange(id)
        }
    }
    /** The badge of the tree row of object [objectId]. */
    private fun badge(view: ProjectView, objectId: String): ProjectIntents.ObjectTreeFilament? =
        view.rows.firstOrNull { row ->
            val entity = (row.entity as? ProjectIntents.OptionalObjectTreeEntity.Value)?.value
            entity is ProjectIntents.ObjectTreeEntity.Object && text(entity.value) == objectId
        }?.indicators?.filament?.let { (it as? ProjectIntents.OptionalObjectTreeFilament.Value)?.value }

    /** [journey] is the corpus's `{"opened","steps","undo"}`, [archive] its 3MF; [cube] an STL; [catalog] the bundled catalog. */
    @JvmStatic fun run(journey: String, archive: ByteArray, cube: ByteArray, catalog: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val reference = CanonicalJson.read(journey) as ProjectJsonObject
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            check(done(workspace.open(Memory(archive), "filaments.3mf")) == ProjectArchiveFormat.CANONICAL, "opened")
            val opened = (reference.get("opened") as ProjectJsonObject).get("semanticHash") as String
            check(until(workspace) { it.revision?.semanticHash == opened }.undo == null, "opened_hash")
            // Nothing selected: nothing to assign, every filament listed as the browser lists it.
            val idle = until(workspace) { it.filaments.options.isNotEmpty() }.filaments
            check(!idle.assignable && idle.scopes.isEmpty() && idle.options.size == 12, "nothing_selected ${idle.options.size}")
            check(idle.options.map { it.mixed } == List(4) { false } + List(8) { true }, "physical_then_mixed")
            check(workspace.view.filamentSlots.palette.size == 4 && workspace.view.filamentSlots.palette[0].color == "#ff0000", "project_slots ${workspace.view.filamentSlots}")
            check(done(workspace.assignFilament(null)) == null, "nothing_assigned")

            val steps = reference.get("steps") as ProjectJsonArray
            for (index in 0 until steps.length()) {
                val step = steps.get(index) as ProjectJsonObject
                val refs = (step.get("refs") as ProjectJsonArray).let { list -> List(list.length()) { entity(list.get(it) as ProjectJsonObject) } }
                done(workspace.actor.select { ProjectSelectionChoice(refs) }.completion.toCompletableFuture())
                val expected = (FilamentAssignments.resolution(step.get("resolutionJson") as String) as FilamentAssignmentResult.Resolved).assignment
                val view = until(workspace) { it.selection.refs == refs && it.filaments == expected }
                check(view.filaments == expected, "step_${index}_snapshot")
                if (step.get("assign") as Boolean) {
                    val filament = step.get("filamentId") as? String
                    val outcome = attempt(workspace.assignFilament(filament))
                    val refusal = step.get("refusal") as? String
                    if (refusal != null) {
                        check(outcome.exceptionOrNull()?.message == refusal, "step_${index}_refused ${outcome.exceptionOrNull()}")
                    } else {
                        check(outcome.getOrNull() == expected.scopes.size, "step_${index}_assigned ${outcome.exceptionOrNull()}")
                    }
                } else {
                    // An unsupported selection: the bar is not shown, and a press assigns nothing.
                    check(!expected.assignable && done(workspace.assignFilament(null)) == null, "step_${index}_unsupported")
                }
                val after = until(workspace) { it.revision?.semanticHash == step.get("semanticHash") }
                check(after.undo == step.get("undoLabel") as? String, "step_${index}_label ${after.undo}")
            }
            // The tree's badges as the last state shows them: object A prints with its own PETG head,
            // object B with its own Twin recipe, and object C — its assignment removed — with none.
            val badges = workspace.view.rows.filter { it.kind == ProjectIntents.ObjectTreeRowKind.Object }
                .map { (it.indicators.filament as? ProjectIntents.OptionalObjectTreeFilament.Value)?.value }
            check(badges.size == 3 && badges.count { it == null } == 1, "badges_shown $badges")
            check(badges.any { it != null && text(it.name) == "Tool 4 PETG" && !it.mixed && !it.inherited }, "physical_badge")
            check(badges.any { it != null && text(it.name) == "Twin" && it.mixed && !it.inherited }, "mixed_badge")

            val undo = reference.get("undo") as ProjectJsonArray
            for (index in 0 until undo.length()) {
                val entry = undo.get(index) as ProjectJsonObject
                done(workspace.undo())
                check(workspace.view.revision?.semanticHash == entry.get("semanticHash"), "undo_${index}_hash")
                check(workspace.view.undo == entry.get("undoLabel") as? String, "undo_${index}_label ${workspace.view.undo}")
            }
            check(workspace.view.undo == null && workspace.view.revision?.semanticHash == opened, "undone_to_opened")
        }

        ProfileCatalogs.build(catalog, collator = null).use { profiles ->
            val live = checkNotNull(checkNotNull(profiles.defaultSelection(LiveSlicingChoice.EMPTY)).live)
            ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
                done(workspace.ready())
                done(workspace.commitImport(done(workspace.prepareImport(Memory(cube), "cube.stl")), emptyList()))
                check(done(workspace.applySlicingChoice(profiles, live)), "configured")
                val configured = until(workspace) { it.filamentSlots.palette.size == 4 }
                val label = "Update slicing configuration"
                check(configured.filaments.options.count { !it.mixed } == 4, "four_heads")

                // Add: the profile's own filament in grey PLA, one undoable step.
                val added = done(workspace.editFilamentSlots(profiles, live, SlotEdit.Add))
                check(added is SlotEditResult.Edited && added.live.palette.size == 5 && added.live.palette[4] == SlicingSlot("#cccccc", "PLA"), "added $added")
                val five = until(workspace) { it.filamentSlots.palette.size == 5 }
                check(five.undo == label && five.filaments.options.count { !it.mixed } == 5, "added_step ${five.undo}")
                val extra = five.filaments.options.first { it.toolId == 4 }
                check(extra.color == "#cccccc" && extra.material == "PLA" && extra.name == live.heads[0].name, "added_filament $extra")

                // A head's slot is not removable; undo takes the slot back, and the next edit does not restore it.
                check(done(workspace.editFilamentSlots(profiles, (added as SlotEditResult.Edited).live, SlotEdit.Remove(0))) == SlotEditResult.Unchanged, "head_kept")
                done(workspace.undo())
                check(until(workspace) { it.filamentSlots.palette.size == 4 }.redo == label, "undone")
                val recoloured = done(workspace.editFilamentSlots(profiles, added.live, SlotEdit.Color(1, "#123abc")))
                check(recoloured is SlotEditResult.Edited && recoloured.live.palette.size == 4, "recolour_follows_undo $recoloured")
                val blue = until(workspace) { it.filamentSlots.palette.getOrNull(1)?.color == "#123abc" }
                check(blue.undo == label && blue.redo == null && blue.filamentSlots.palette.size == 4, "recoloured")
                check(blue.filaments.options.first { it.toolId == 1 }.color == "#123abc", "recoloured_option")

                // A head's nozzle; then an extra slot added and removed.
                val nozzled = done(workspace.editFilamentSlots(profiles, live, SlotEdit.Nozzle(0, "0.6")))
                check(nozzled is SlotEditResult.Edited && until(workspace) { it.filamentSlots.nozzles.firstOrNull() == "0.6" }.undo == label, "nozzle")
                check(done(workspace.editFilamentSlots(profiles, live, SlotEdit.Nozzle(0, "0.6"))) == SlotEditResult.Unchanged, "nozzle_unchanged")
                done(workspace.editFilamentSlots(profiles, live, SlotEdit.Add))
                until(workspace) { it.filamentSlots.palette.size == 5 }
                val removed = done(workspace.editFilamentSlots(profiles, live, SlotEdit.Remove(4)))
                check(removed is SlotEditResult.Edited && until(workspace) { it.filamentSlots.palette.size == 4 }.filamentSlots.palette[1].color == "#123abc", "removed $removed")

                // Sixteen slots at most.
                repeat(12) { done(workspace.editFilamentSlots(profiles, live, SlotEdit.Add)) }
                check(until(workspace) { it.filamentSlots.palette.size == 16 }.filaments.options.count { !it.mixed } == 16, "sixteen")
                val refused = done(workspace.editFilamentSlots(profiles, live, SlotEdit.Add))
                check(refused == SlotEditResult.Refused("slot-limit", "The 16-slot filament limit has been reached."), "limit $refused")
                check(workspace.view.filamentSlots.palette.size == 16, "limit_unchanged")

                // The cube assigned to the last slot: its tree row shows it, one undoable step.
                done(workspace.selectAll())
                val selected = until(workspace) { it.filaments.assignable }
                check(selected.filaments.scopes.size == 1 && selected.filaments.scopes[0].entity.kind == FilamentRef.Kind.OBJECT, "cube_scope")
                val last = selected.filaments.options.last { !it.mixed }
                check(done(workspace.assignFilament(last.id)) == 1, "cube_assigned")
                val assigned = until(workspace) { it.undo == "Assign filament" }
                val cube = selected.filaments.scopes[0].objectId
                check(badge(assigned, cube)?.let { text(it.id) == last.id && !it.inherited && !it.mixed } == true, "cube_badge")
                check(assigned.filaments.scopes[0].local == last.id && assigned.filaments.scopes[0].effective == last.id, "cube_scope_local")
                done(workspace.undo())
                check(badge(until(workspace) { it.undo == label }, cube) == null, "cube_badge_undone")
                // A disabled or unknown destination is refused in the browser's words.
                check(attempt(workspace.assignFilament("import:filament:none")).exceptionOrNull()?.message == "Unknown filament import:filament:none", "unknown_refused")
            }
        }
        return checks
    }
}
