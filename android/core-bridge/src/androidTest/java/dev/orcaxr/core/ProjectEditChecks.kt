package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * Selection and object edits through the Project area's session, over real
 * JNI: the selection the browser's SelectionStore keeps (a click, Shift/Ctrl
 * toggling, tree rows resolved by the core, Select All, Deselect All), the
 * tree reporting it, the core's capabilities enabling the edits; every edit
 * one undoable step with the browser's history label — delete selected and
 * delete all, printability (each instance its own step), renames, instance
 * to object, the browser's clone (a staged "Create instance" keeping the
 * record) — and every plate operation with IDs minted by the browser's UUID
 * rule. Refusals answer with the browser's words and change nothing.
 */
object ProjectEditChecks {
    private const val WAIT_S = 30L

    private class Memory(val bytes: ByteArray) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = error("read only")
    }

    /** The browser's `seededRandom` (web/src/project/domain/ids.ts): xorshift32 words over 2³². */
    private fun seeded(seed: Int): () -> Double {
        var state = if (seed != 0) seed else 0x9e3779b9.toInt()
        return {
            state = state xor (state shl 13)
            state = state xor (state ushr 17)
            state = state xor (state shl 5)
            (state.toLong() and 0xffffffffL) / 4294967296.0
        }
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(future: CompletableFuture<*>): String? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? ProjectFailure)?.message ?: thrown.cause?.toString()
    }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun units(text: String) = text.map { it.code }
    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun ids(view: ProjectView) = view.selection.refs.map { ref ->
        when (ref) {
            is ProjectIntents.SelectionEntity.Instance -> "instance:" + text(ref.value)
            is ProjectIntents.SelectionEntity.Object -> "object:" + text(ref.value)
            is ProjectIntents.SelectionEntity.Plate -> "plate:" + text(ref.value)
            else -> ref.toString()
        }
    }
    private fun row(view: ProjectView, key: String) = view.rows.firstOrNull { text(it.key) == key }
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    /** The project's instances in order, read on the authority: (instance, object, plate, printable). */
    private fun instances(workspace: ProjectWorkspace): List<InstanceFacts> = done(
        workspace.actor.inspect { session -> session.snapshot().use { s -> s.query().use { ProjectFacts.instances(it) } } }
            .completion.toCompletableFuture(),
    ).let { (it as ProjectOutcome.Inspected).result.getOrThrow() as List<InstanceFacts> }

    @JvmStatic fun run(cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }

        // The browser's UUID rule, word for word (UuidIdSource over seededRandom(20261010)).
        val browser = ProjectIds(seeded(20261010))
        check(browser.next(3) == listOf("209fc285-1b94-48cc-b5ea-4ea93ca3120d", "6dcc646f-c64a-4fd6-bdc1-22d74480337d", "e6d5e533-3221-4aaa-a2ea-6d2c1ae85e9e"), "uuid_vectors")
        check(ProjectIds().next(64).all { UUID.matches(it) }, "uuid_secure_v4")
        check(ProjectNames.nextAvailable("Plate", listOf("Plate 1", "Plate 3")) == "Plate 2" && ProjectNames.trim("  Bolt　") == "Bolt", "names")

        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }, ids = ProjectIds(seeded(7))).use { workspace ->
            done(workspace.ready())
            for (n in 1..2) done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            var view = until(workspace, "two_objects") { it.activePlate?.objects == 2 && it.actions.isNotEmpty() }
            val (first, second) = instances(workspace).also { check(it.size == 2, "two_instances") }
            val plate = checkNotNull(view.activePlate).id
            // Nothing selected: the core disables the edits of a selection and enables those of the plate.
            check(!view.actions.getValue("edit_delete_selected").enabled && view.actions.getValue("edit_select_all").enabled, "capabilities_unselected ${view.actions}")
            check(!view.actions.getValue("delete_plate").enabled && view.actions.getValue("add_plate").enabled, "one_plate_capabilities")
            check(view.plateMenu.map { it.id }.containsAll(listOf("edit_select_all", "add_plate", "delete_plate", "duplicate_plate")), "plate_menu ${view.plateMenu}")
            check(view.objectMenu.map { it.id }.containsAll(listOf("edit_duplicate", "edit_delete_selected", "toggle_printable", "instance_to_object")), "object_menu")

            // Select All, Deselect All: the active plate's instances, the last primary.
            check(done(workspace.selectAll()), "select_all_changed")
            view = until(workspace, "selected_all") { it.selection.total == 2L }
            check(ids(view) == listOf("instance:${first.id}", "instance:${second.id}") && view.selection.primary == ProjectIntents.SelectionEntity.Instance(units(second.id)), "select_all ${ids(view)}")
            check(until(workspace, "instance_capabilities") { it.actions["edit_delete_selected"]?.enabled == true }.selection.hasInstance, "instance_selection_enables")
            check(!done(workspace.selectAll()), "select_all_again_unchanged")
            check(done(workspace.deselectAll()) && until(workspace, "deselected") { it.selection.total == 0L }.selection.instances.isEmpty(), "deselect_all")

            // A click selects one instance and reveals its row; Shift/Ctrl toggles among instances.
            check(done(workspace.selectInstance(first.id)), "click_selects")
            view = until(workspace, "revealed") { row(it, "instance:${first.id}")?.selected == true }
            check(view.selection.instances == setOf(first.id) && row(view, "object:${first.objectId}")?.selected == false, "click_row_selected")
            done(workspace.selectInstance(second.id, extend = true))
            view = until(workspace, "extended") { it.selection.total == 2L }
            check(view.selection.primary == ProjectIntents.SelectionEntity.Instance(units(second.id)), "extend_primary_last")
            done(workspace.selectInstance(second.id, extend = true))
            check(until(workspace, "toggled_off") { it.selection.total == 1L }.selection.instances == setOf(first.id), "toggle_off")
            check(!done(workspace.selectInstance("00000000-0000-4000-8000-000000000000")), "gone_instance_selects_nothing")

            // Tree rows, resolved by the core: replace, toggle (the primary kept unless removed), groups select nothing.
            done(workspace.selectRow("object:${second.objectId}"))
            view = until(workspace, "row_replaced") { ids(it) == listOf("object:${second.objectId}") }
            check(row(view, "object:${second.objectId}")?.selected == true, "row_reports_selected")
            done(workspace.selectRow("plate:$plate", ProjectRowSelection.Toggle))
            view = until(workspace, "row_toggled") { it.selection.total == 2L }
            check(view.selection.primary == ProjectIntents.SelectionEntity.Plate(units(plate)), "toggle_adds_primary")
            done(workspace.selectRow("plate:$plate", ProjectRowSelection.Toggle))
            check(ids(until(workspace, "row_untoggled") { it.selection.total == 1L }) == listOf("object:${second.objectId}"), "toggle_removes")
            check(!done(workspace.selectRow("instance-group:${first.objectId}")), "group_selects_nothing")
            done(workspace.selectRow("object:${first.objectId}"))
            done(workspace.selectRow("object:${second.objectId}", ProjectRowSelection.Range))
            view = until(workspace, "range") { it.selection.total >= 2L }
            check(ids(view).first() == "object:${first.objectId}" && ids(view).last() == "object:${second.objectId}", "range ${ids(view)}")

            // A selection the session refuses changes nothing and keeps the session.
            val refused = done(workspace.actor.select {
                ProjectSelectionChoice(listOf(ProjectIntents.SelectionEntity.Plate(units(plate))), ProjectIntents.SelectionEntity.Instance(units(first.id)))
            }.completion.toCompletableFuture())
            check(refused == ProjectOutcome.NotStarted(ProjectRefusal.INVALID_REQUEST), "invalid_primary_refused $refused")
            check(workspace.view.selection.total >= 2L, "refusal_keeps_selection")

            // Edits of nothing selected do nothing.
            done(workspace.deselectAll())
            check(done(workspace.cloneSelected()) == null && done(workspace.deleteSelected()) == null && done(workspace.togglePrintable()) == null, "nothing_selected_no_edit")
            check(workspace.view.undo == "Import cube.stl", "no_history_entry ${workspace.view.undo}")

            // Clone Selected: the browser's staged copy of the primary instance, which the core then selects.
            done(workspace.selectInstance(first.id))
            val copy = checkNotNull(done(workspace.cloneSelected()))
            view = until(workspace, "cloned") { it.undo == "Create instance" && it.selection.instances == setOf(copy) }
            check(UUID.matches(copy) && instances(workspace).count { it.objectId == first.objectId } == 2, "clone_same_object")
            val source = instances(workspace).first { it.id == first.id }
            check(instances(workspace).first { it.id == copy }.printable == source.printable, "clone_keeps_printability")
            // Delete Selected: an instance of a several-instance object, then an object with its last instance.
            check(done(workspace.deleteSelected()) == ProjectDeletion.INSTANCE, "delete_instance")
            // The core moves a deleted primary's selection to its neighbour, as the browser's command does.
            check(until(workspace, "instance_deleted") { it.undo == "Delete instance" }.selection.instances == setOf(first.id), "deleted_falls_back")
            done(workspace.undo())
            check(until(workspace, "delete_undone") { it.redo == "Delete instance" }.undo == "Create instance", "undo_delete_instance")
            done(workspace.redo())
            done(workspace.selectInstance(second.id))
            check(done(workspace.deleteSelected()) == ProjectDeletion.OBJECT, "delete_object")
            check(until(workspace, "object_deleted") { it.undo == "Delete object" }.activePlate?.objects == 1, "object_gone")
            done(workspace.undo())
            check(until(workspace, "object_back") { it.activePlate?.objects == 2 }.redo == "Delete object", "undo_delete_object")

            // Printable: one step per instance changed, unprintable unless all already are.
            done(workspace.selectInstance(first.id))
            check(done(workspace.togglePrintable()) == ProjectPrintableChange(false, 1), "printable_off")
            check(until(workspace, "unprintable") { it.undo == "Mark instance unprintable" }.rows.isNotEmpty(), "label_unprintable")
            // Not all printable: the selection becomes printable (only the one that was not changes).
            done(workspace.selectAll())
            check(done(workspace.togglePrintable()) == ProjectPrintableChange(true, 1), "printable_on_rest")
            check(done(workspace.togglePrintable()) == ProjectPrintableChange(false, 2), "printable_off_all")
            until(workspace, "printable_off") { it.undo == "Mark instance unprintable" }
            done(workspace.undo())
            check(until(workspace, "one_step_each") { it.redo == "Mark instance unprintable" }.undo == "Mark instance unprintable", "separate_steps")
            check(instances(workspace).count { it.printable } == 1, "one_undone")
            done(workspace.redo())
            check(done(workspace.togglePrintable()) == ProjectPrintableChange(true, 2), "printable_on_all")
            check(instances(workspace).all { it.printable }, "all_printable")

            // Renames, trimmed and bounded with the browser's words.
            done(workspace.renameObject(first.objectId, "  Bolt "))
            check(until(workspace, "renamed") { it.undo == "Rename object to Bolt" }.rows.any { text(it.label) == "Bolt" }, "rename_object")
            check(failure(workspace.renameObject(first.objectId, "  ")) == "Object name cannot be empty", "rename_empty")
            check(failure(workspace.renameObject(first.objectId, "x".repeat(161))) == "Object name cannot exceed 160 characters", "rename_long")
            check(failure(workspace.renameObject(first.objectId, "a\u0007b")) == "Object name cannot contain control characters", "rename_control")
            check(workspace.view.undo == "Rename object to Bolt", "refused_renames_record_nothing")

            // Set as an individual object: refused for an only instance, then a clone made independent.
            done(workspace.selectInstance(second.id))
            check(failure(workspace.instanceToObject()) == "Cannot convert sole instance to individual object", "sole_instance_refused")
            done(workspace.selectInstance(first.id))
            val clone = checkNotNull(done(workspace.cloneSelected()))
            until(workspace, "clone_selected") { it.selection.instances == setOf(clone) }
            val made = checkNotNull(done(workspace.instanceToObject()))
            view = until(workspace, "independent") { it.undo == "Set as individual object" }
            check(view.activePlate?.objects == 3 && instances(workspace).any { it.objectId == made }, "instance_to_object")

            // Generic intents and batches: one step each, labelled by the core or the batch.
            done(workspace.execute(ProjectIntents.Command.SetPlatePrintable(ProjectIntents.SetPlatePrintable(units(plate), false))))
            check(until(workspace, "executed") { it.undo == "Exclude plate from printing" }.activePlate?.printable == false, "execute")
            done(workspace.transaction("Rename both", listOf(
                ProjectIntents.Command.RenameObject(ProjectIntents.RenameObject(units(first.objectId), units("Left"))),
                ProjectIntents.Command.RenameObject(ProjectIntents.RenameObject(units(second.objectId), units("Right"))),
            )))
            check(until(workspace, "batched") { it.undo == "Rename both" }.rows.count { text(it.label) in setOf("Left", "Right") } == 2, "transaction")

            // Delete All: every model on the active plate as one step.
            check(done(workspace.deleteAll()) == 3, "delete_all")
            check(until(workspace, "all_deleted") { it.undo == "Delete all models" }.activePlate?.objects == 0, "plate_empty")
            check(done(workspace.deleteAll()) == null, "delete_all_empty")
            done(workspace.undo())
            until(workspace, "models_back") { it.activePlate?.objects == 3 }

            // Plates: add (the next free "Plate n", active), rename, activate, reorder, include, duplicate, delete.
            val added = checkNotNull(done(workspace.addPlate()))
            view = until(workspace, "plate_added") { it.undo == "Add Plate 2" }
            check(UUID.matches(added) && view.plateList.map { it.id } == listOf(plate, added) && view.activePlate?.id == added, "add_plate ${view.plateList}")
            check(until(workspace, "two_plates_capability") { it.actions["delete_plate"]?.enabled == true }.plates == 2, "delete_plate_enabled")
            done(workspace.renamePlate(added, " Second "))
            check(until(workspace, "plate_renamed") { it.undo == "Rename plate to Second" }.plateList.last().name == "Second", "rename_plate")
            check(failure(workspace.renamePlate(added, "\t")) == "Plate name cannot be empty", "plate_name_empty")
            check(ProjectNames.plateNameProblem(" ") == "Plate name cannot be empty." && ProjectNames.plateNameProblem("a\u0085") == "Plate name cannot contain control characters.", "plate_bar_validation")
            done(workspace.activatePlate(plate))
            check(until(workspace, "activated") { it.undo == "Change active plate" }.activePlate?.id == plate, "activate_plate")
            check(done(workspace.activatePlate(plate)) == null, "active_plate_unchanged")
            done(workspace.movePlate(added, -1))
            check(until(workspace, "reordered") { it.undo == "Reorder plates" }.plateList.map { it.id } == listOf(added, plate), "move_plate")
            check(done(workspace.movePlate(added, -1)) == null, "first_plate_stays")
            done(workspace.reorderPlates(listOf(plate, added)))
            until(workspace, "reordered_back") { it.plateList.map { p -> p.id } == listOf(plate, added) }
            done(workspace.setPlatePrintable(added, false))
            check(until(workspace, "excluded") { it.undo == "Exclude plate from printing" && it.plateList.last().printable == false }.plates == 2, "plate_printable")
            // The duplicate's ID plan: every object's volumes, instances and ranges, then the plate's rows.
            val shape = done(workspace.actor.inspect { s -> s.snapshot().use { it.plateShape(plate) } }.completion.toCompletableFuture())
                .let { (it as ProjectOutcome.Inspected).result.getOrThrow() as ProjectPlateShape }
            check(shape.objects.size == 3 && shape.objects.all { it.volumes == 1 && it.instances == 1 && it.layerRanges == 0 } && shape.customGcode == 0 && shape.thumbnails == 0, "plate_shape $shape")
            check(done(workspace.actor.inspect { s -> s.snapshot().use { it.plateShape("import:plate:absent") } }.completion.toCompletableFuture())
                .let { (it as ProjectOutcome.Inspected).result.getOrThrow() } == null, "unknown_plate_shape")
            val twin = checkNotNull(done(workspace.duplicatePlate(plate)))
            view = until(workspace, "duplicated") { it.undo == "Duplicate plate" }
            check(view.plates == 3 && instances(workspace).count { it.plateId == twin } == 3, "duplicate_plate ${view.plateList}")
            check(failure(workspace.duplicatePlate("import:plate:absent")) == "Unknown plate import:plate:absent", "duplicate_unknown")
            done(workspace.deletePlate(twin))
            check(until(workspace, "plate_deleted") { it.undo == "Delete plate" }.plates == 2, "delete_plate")
            done(workspace.deletePlate(added))
            check(failure(workspace.deletePlate(plate)) == "Cannot delete the last plate", "last_plate_refused")
            // The browser's plate limit, before the core is asked.
            while (workspace.view.plates < ProjectWorkspace.MAX_PROJECT_PLATES) done(workspace.addPlate())
            check(failure(workspace.addPlate()) == "A project cannot contain more than 36 plates", "plate_limit")
            check(failure(workspace.duplicatePlate(plate)) == "A project cannot contain more than 36 plates", "duplicate_limit")
        }
        return checks
    }
}
