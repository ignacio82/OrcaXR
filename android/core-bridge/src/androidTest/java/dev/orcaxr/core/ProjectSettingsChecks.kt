package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The inspector's settings panels on a real session, over JNI.
 *
 * The Kotlin readers first take every reply of the browser's panel corpus
 * (`settings-panel-vectors.json`): views, rows, drafts, states and applies,
 * the scoped panel's target texts, and the height-range projections, checks
 * and messages, each read back into the values the app draws.
 *
 * Then [ProjectSettings] on an imported cube: the scoped panel lists the
 * project, plate, object and part with the browser's words; the object's
 * panel shows the browser's Simple view; a wall count and an infill density
 * are drafted and applied, each one undoable "Update object settings" that
 * leaves the node holding exactly the value; a value already held applies
 * nothing, an unreadable one is refused before anything is submitted, and a
 * draft begun before another edit is refused in the browser's words; "Use
 * inherited" applies the removal, and undo restores it. The part's panel
 * applies "Update part settings". The object's height ranges: typed bounds
 * checked as the browser checks them, a range added ("Add layer range", the
 * core selecting it), its own wall count ("Update height range settings"),
 * its bounds edited, split (the upper range selected), merged back and
 * deleted, each with the browser's label and words; a stale edit refused in
 * the browser's words; and undo walks every step back to the imported cube.
 */
object ProjectSettingsChecks {
    private const val WAIT_S = 60L

    private class Memory(val bytes: ByteArray) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong()
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = error("read only")
    }

    private fun <T> done(future: CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(future: CompletableFuture<*>): String? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        thrown.cause?.message ?: thrown.cause.toString()
    }
    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view.undo}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun objects(value: Any): List<ProjectJsonObject> = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as ProjectJsonObject } }
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }

    /** [corpus] is `settings-panel-vectors.json`; [cube] a binary STL. */
    @JvmStatic fun run(corpus: String, cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }

        // The corpus's replies through the Kotlin readers.
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        for (session in objects(reference.get("sessions"))) {
            for (step in objects(session.get("steps"))) {
                val reply = if (has(step, "replyJson")) step.get("replyJson") as String else continue
                when (step.get("kind") as String) {
                    "view" -> {
                        val view = SettingsPanels.view(reply)
                        check(view.rows.size == view.shown && view.summary.endsWith("${view.unavailable} unavailable."), "view ${view.summary}")
                        check(view.rows.count { it.availability != null } == view.unavailable, "view_unavailable ${view.summary}")
                    }
                    "row" -> {
                        val row = SettingsPanels.row(reply)
                        val refused = (CanonicalJson.read(reply) as ProjectJsonObject).keys().next() == "refused"
                        check((row == null) == refused && (row == null || row.issues.all { it.message.isNotEmpty() }), "row $reply")
                    }
                    "edit" -> check(SettingsPanels.edit(reply).let { it is SettingsPanelEdit.Applied || it.toString().contains("message=") }, "edit $reply")
                    "state" -> check(SettingsPanels.state(reply).drafts >= 0, "state $reply")
                    "apply" -> {
                        val apply = SettingsPanels.apply(reply)
                        check((apply is SettingsPanelApply.Committed) == has(step, "intentJson"), "apply $reply")
                    }
                }
            }
        }
        for (case in objects(reference.get("targetTexts"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val words = SettingsPanels.targetText(
                request.get("scope") as String, request.get("label") as String, request.get("path") as String,
                (request.get("overrideCount") as Double).toLong(),
            )
            val expected = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            check(words == SettingsTargetText(expected.get("text") as String, expected.get("summary") as String, expected.get("heading") as String), "target_text $words")
        }
        val layer = reference.get("layerRanges") as ProjectJsonObject
        for (case in objects(layer.get("projections"))) {
            val projection = LayerRangeEditors.projection(case.get("replyJson") as String)
            check(projection == null || projection.ranges.all { it.label.endsWith(" mm") }, "projection ${case.get("requestJson")}")
        }
        for (case in objects(layer.get("bounds"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val ranges = objects(request.get("ranges")).map { LayerRangeEntry(it.get("id") as String, it.get("minZMm") as Double, it.get("maxZMm") as Double, "") }
            val excluded = request.get("excludedId") as? String
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            val answer = LayerRangeEditors.bounds(request.get("rawMin") as String, request.get("rawMax") as String, ranges, excluded)
            check(
                if (reply.get("valid") as Boolean) answer == LayerRangeCheck.Valid(listOf(reply.get("minZMm") as Double, reply.get("maxZMm") as Double))
                else answer == LayerRangeCheck.Invalid(reply.get("message") as String),
                "bounds ${case.get("requestJson")} $answer",
            )
        }
        for (case in objects(layer.get("splits"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val range = LayerRangeEntry("", request.get("minZMm") as Double, request.get("maxZMm") as Double, "")
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            val answer = LayerRangeEditors.split(request.get("raw") as String, range)
            check(
                if (reply.get("valid") as Boolean) answer == LayerRangeCheck.Valid(listOf(reply.get("splitZMm") as Double))
                else answer == LayerRangeCheck.Invalid(reply.get("message") as String),
                "split ${case.get("requestJson")} $answer",
            )
        }
        for (case in objects(layer.get("messages"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val n = { key: String -> request.get(key) as Double }
            val operation = when (request.get("kind") as String) {
                "add" -> LayerRangeOperation.Add(n("minZMm"), n("maxZMm"))
                "edit" -> LayerRangeOperation.Edit(n("fromMinZMm"), n("fromMaxZMm"), n("minZMm"), n("maxZMm"))
                "split" -> LayerRangeOperation.Split(n("splitZMm"))
                "merge" -> LayerRangeOperation.Merge(request.get("direction") == "previous")
                else -> LayerRangeOperation.Delete
            }
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            check(LayerRangeEditors.messages(operation) == LayerRangeMessages(reply.get("pending") as String, reply.get("success") as String), "messages ${case.get("requestJson")}")
        }

        // The workflows on a real session.
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            val imported = until(workspace, "import") { it.undo != null }.revision
            val settings = ProjectSettings(workspace)
            val targets = done(settings.targets())
            check(targets.map { it.scope } == listOf("project", "plate", "object", "part"), "targets ${targets.map { it.id }}")
            val objectTarget = targets[2]
            val partTarget = targets[3]
            val objectId = objectTarget.id.removePrefix("object:")
            check(objectTarget.text == "Object: Plate 1 › cube" && objectTarget.heading == "Object settings — cube", "object_words ${objectTarget.text}")
            check(objectTarget.summary == "Overrides the object's inherited values. Only settings the engine reads at this scope are listed.", "object_summary")
            check(partTarget.summary.startsWith("Overrides the part's inherited values. A height range crossing this part"), "part_summary")

            // The object's panel: the browser's Simple view, a wall count and an infill density applied one at a time.
            fun field(panel: SettingsPanel, key: String): SettingsPanelRow =
                panel.view(SettingsPanelMode.DEVELOP, key).rows.first { it.key == key }
            fun apply(panel: SettingsPanel) = done(settings.apply(panel))
            var panel = done(settings.open(objectTarget.id))
            val simple = panel.view(SettingsPanelMode.SIMPLE, "")
            check(simple.summary == "40 settings shown; 4 unavailable." && simple.sections.first().label.startsWith("Process · "), "simple ${simple.summary}")
            val walls = field(panel, "wall_loops")
            check(walls.control == SettingsPanelControl.Text("2", "numeric", false) && walls.originLabel == "Default" && walls.inherit && walls.useDefault, "walls $walls")
            val infill = field(panel, "sparse_infill_density")
            check(infill.unit == "%" && (infill.control as SettingsPanelControl.Text).inputMode == "decimal", "infill $infill")
            check(panel.set(walls.fieldId, "3") == SettingsPanelEdit.Applied && panel.state() == SettingsPanelState(changed = true, drafts = 1, invalid = false), "walls_drafted")
            check(field(panel, "wall_loops").let { it.draftChanged && it.control == SettingsPanelControl.Text("3", "numeric", false) }, "walls_draft_row")
            check(apply(panel) == SettingsPanelApply.Committed(1), "walls_applied")
            check(until(workspace, "walls") { it.undo == "Update object settings" }.undo == "Update object settings", "walls_label")
            panel.close()
            panel = done(settings.open(objectTarget.id))
            check(field(panel, "wall_loops").let { it.originLabel == "Changed" && it.control == SettingsPanelControl.Text("3", "numeric", false) }, "walls_held")
            check(panel.target.text == "Object: Plate 1 › cube — 1 override", "one_override ${panel.target.text}")
            check(panel.set(infill.fieldId, "25%") == SettingsPanelEdit.Applied && apply(panel) == SettingsPanelApply.Committed(1), "infill_applied")
            val afterInfill = until(workspace, "infill") { it.revision != null && it.undo == "Update object settings" && done(settings.targets())[2].overrideCount == 2L }
            check(afterInfill.undo == "Update object settings", "infill_label")
            // The draft was begun on the state before the infill: refused in the browser's words, nothing changed.
            check(panel.set(walls.fieldId, "5") == SettingsPanelEdit.Applied && failure(settings.apply(panel)) == ProjectSettings.STALE_DRAFT, "stale_draft")
            panel.close()
            panel = done(settings.open(objectTarget.id))
            check(field(panel, "sparse_infill_density").control == SettingsPanelControl.Text("25%", "decimal", false), "infill_held")
            // A value the node already holds applies nothing; an unreadable one is refused before anything is submitted.
            check(panel.set(walls.fieldId, "3") == SettingsPanelEdit.Applied && apply(panel) == SettingsPanelApply.Unchanged && panel.state().drafts == 0, "unchanged")
            check(panel.set(walls.fieldId, "abc") == SettingsPanelEdit.Applied && panel.state().invalid, "unreadable_drafted")
            check(field(panel, "wall_loops").issues.isNotEmpty(), "unreadable_issue")
            check(apply(panel) == SettingsPanelApply.Invalid("Settings draft contains 1 validation issue"), "unreadable_refused")
            panel.cancel()
            check(panel.state() == SettingsPanelState(changed = false, drafts = 0, invalid = false), "cancelled")
            val unknown = panel.set("no-such-field", "1")
            check(unknown == SettingsPanelEdit.Refused("Unknown settings field \"no-such-field\""), "unknown_field $unknown")
            // "Use inherited": the node stops holding the wall count; undo puts it back.
            check(panel.inherit(walls.fieldId) == SettingsPanelEdit.Applied && apply(panel) == SettingsPanelApply.Committed(1), "inherited")
            until(workspace, "inherited") { done(settings.targets())[2].overrideCount == 1L }
            done(workspace.undo())
            check(until(workspace, "undo_inherit") { done(settings.targets())[2].overrideCount == 2L }.undo == "Update object settings", "undo_inherited")
            panel.close()

            // The part's own wall count.
            panel = done(settings.open(partTarget.id))
            check(panel.set(walls.fieldId, "5") == SettingsPanelEdit.Applied && apply(panel) == SettingsPanelApply.Committed(1), "part_applied")
            check(until(workspace, "part") { it.undo == "Update part settings" }.undo == "Update part settings", "part_label")
            panel.close()
            check(failure(settings.open("object:00000000-0000-4000-8000-000000000000")) == "No settings target named object:00000000-0000-4000-8000-000000000000 is in the project.", "unknown_target")

            // The object's height ranges.
            var ranges = done(settings.layerRanges(objectId))!!
            check(ranges.projection.ranges.isEmpty() && ranges.projection.selected == null && ranges.projection.objectName == "cube", "no_ranges")
            check(LayerRangeEditors.bounds("", "5", ranges.projection.ranges) == LayerRangeCheck.Invalid("Enter finite minimum and maximum Z values."), "bounds_blank")
            check(LayerRangeEditors.bounds("5", "2", ranges.projection.ranges) == LayerRangeCheck.Invalid("Bounds must satisfy 0 ≤ minimum Z < maximum Z."), "bounds_order")
            check(LayerRangeEditors.bounds("0", "5", ranges.projection.ranges) == LayerRangeCheck.Valid(listOf(0.0, 5.0)), "bounds_valid")
            check(LayerRangeEditors.messages(LayerRangeOperation.Add(0.0, 5.0)) == LayerRangeMessages("Adding 0 mm–5 mm…", "Added 0 mm–5 mm."), "add_words")
            val first = done(settings.addLayerRange(ranges, 0.0, 5.0))
            check(until(workspace, "add") { it.undo == "Add layer range" }.selection.primary == ProjectIntents.SelectionEntity.LayerRange(first.map { it.code }), "added_selected")
            ranges = done(settings.layerRanges(objectId))!!
            check(ranges.projection.ranges == listOf(LayerRangeEntry(first, 0.0, 5.0, "0 mm–5 mm")), "added ${ranges.projection.ranges}")
            check(ranges.projection.selected == LayerRangeSelection(first, LayerRangeMerge(false, null, "There is no previous height range."), LayerRangeMerge(false, null, "There is no next height range.")), "added_merges")
            check(LayerRangeEditors.bounds("4", "8", ranges.projection.ranges) == LayerRangeCheck.Invalid("4 mm–8 mm overlaps existing 0 mm–5 mm."), "overlap")
            // The range's own wall count.
            val rangeTarget = done(settings.targets()).first { it.scope == "layerRange" }
            check(rangeTarget.text == "Height range: Plate 1 › cube › 0–5 mm" && rangeTarget.heading == "Height range settings — 0–5 mm", "range_words ${rangeTarget.text}")
            panel = done(settings.open(rangeTarget.id))
            check(panel.set(walls.fieldId, "4") == SettingsPanelEdit.Applied && apply(panel) == SettingsPanelApply.Committed(1), "range_applied")
            check(until(workspace, "range") { it.undo == "Update height range settings" }.undo == "Update height range settings", "range_label")
            panel.close()
            // Bounds, split, merge and delete.
            ranges = done(settings.layerRanges(objectId))!!
            done(settings.editLayerRange(ranges, first, 0.0, 6.0))
            check(until(workspace, "edit") { it.undo == "Edit layer range" }.undo == "Edit layer range", "edited")
            ranges = done(settings.layerRanges(objectId))!!
            check(LayerRangeEditors.split("6", ranges.projection.ranges.single()) == LayerRangeCheck.Invalid("Split height must be strictly inside 0 mm–6 mm."), "split_edge")
            val upper = done(settings.splitLayerRange(ranges, first, 2.5))
            check(until(workspace, "split") { it.undo == "Split layer range" }.selection.primary == ProjectIntents.SelectionEntity.LayerRange(upper.map { it.code }), "split_selected")
            ranges = done(settings.layerRanges(objectId))!!
            check(ranges.projection.ranges.map { it.label } == listOf("0 mm–2.5 mm", "2.5 mm–6 mm"), "split ${ranges.projection.ranges}")
            check(ranges.projection.selected?.mergePrevious == LayerRangeMerge(true, first, null) && ranges.projection.selected.mergeNext.allowed == false, "split_merges")
            // A stale panel is refused in the browser's words, and changes nothing.
            done(settings.selectLayerRange(first))
            check(until(workspace, "reselect") { it.selection.primary == ProjectIntents.SelectionEntity.LayerRange(first.map { c -> c.code }) }.undo == "Split layer range", "reselected")
            val stale = ranges
            done(workspace.undo())
            until(workspace, "undo_split") { it.undo == "Edit layer range" }
            check(failure(settings.deleteLayerRange(stale, upper)) == ProjectSettings.STALE_RANGE, "stale_range")
            done(workspace.redo())
            until(workspace, "redo_split") { it.undo == "Split layer range" }
            done(settings.selectLayerRange(first))
            until(workspace, "reselect_first") { it.selection.primary == ProjectIntents.SelectionEntity.LayerRange(first.map { c -> c.code }) }
            ranges = done(settings.layerRanges(objectId))!!
            check(ranges.projection.selected?.id == first && ranges.projection.selected.mergeNext == LayerRangeMerge(true, upper, null), "merge_next")
            done(settings.mergeLayerRanges(ranges, first, upper))
            check(until(workspace, "merge") { it.undo == "Merge layer ranges" }.undo == "Merge layer ranges", "merged")
            ranges = done(settings.layerRanges(objectId))!!
            check(ranges.projection.ranges.map { it.label } == listOf("0 mm–6 mm"), "merged_ranges")
            done(settings.deleteLayerRange(ranges, first))
            check(until(workspace, "delete") { it.undo == "Delete layer range" }.selection.primary == ProjectIntents.SelectionEntity.Object(objectId.map { it.code }), "deleted_selects_object")
            check(done(settings.layerRanges(objectId))!!.projection.ranges.isEmpty(), "deleted")
            check(done(settings.layerRanges("00000000-0000-4000-8000-000000000000")) == null, "unknown_object")

            // Undo walks every step back to the imported cube.
            val labels = listOf(
                "Delete layer range", "Merge layer ranges", "Split layer range", "Edit layer range", "Update height range settings",
                "Add layer range", "Update part settings", "Update object settings", "Update object settings",
            )
            for (label in labels) {
                check(workspace.view.undo == label, "undo_label $label ${workspace.view.undo}")
                done(workspace.undo())
            }
            check(until(workspace, "imported") { it.revision?.semanticHash == imported?.semanticHash }.revision?.semanticHash == imported?.semanticHash, "back_to_import")
            check(done(settings.targets()).all { it.overrideCount == 0L }, "no_overrides_left")
        }
        return checks
    }
}
