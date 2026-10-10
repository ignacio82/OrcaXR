package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The transform inspector and the Edit menu's placement actions on a real
 * session, over JNI: three imported cubes stand in for the instances of the
 * browser's field-edit cases (`transform-field-vectors.json`); each case's
 * origins are set, its selection made (its primary last, so primary), and
 * the inspector ([ProjectView.inspector]) shows the primary's fields as
 * [TransformFields.values] reads them. [ProjectWorkspace.editTransform] then
 * leaves every instance as the browser computed (the case's changes), as
 * one undo entry with the browser's label — none when nothing changed — or
 * refuses in the browser's words leaving history alone, and undo restores
 * the origins. Cases a session cannot stage (a duplicate selection, an
 * origin the session refuses to hold) are counted and checked to be exactly
 * those. Repeated edits of one field stay separate entries, as the browser's
 * `single:<n>` gestures keep them; the selection-based placement actions
 * act on what the browser's workspace reads (the selection, the active
 * plate's models for centre and scale to fit, the primary's plate for drop
 * to bed, the active plate for arrange) and the core enables the inspector's
 * tools and the placement actions with an instance selected.
 */
object ProjectTransformEditChecks {
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
    private fun until(workspace: ProjectWorkspace, label: String, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view}" }
            Thread.sleep(5)
        }
        return workspace.view
    }
    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })
    private fun obj(json: String) = CanonicalJson.read(json) as ProjectJsonObject
    private fun doubles(value: Any): List<Double> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as Double } }
    private fun strings(value: Any): List<String> =
        (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
    private fun transform(value: Any): ProjectIntents.Transform = (value as ProjectJsonObject).let {
        ProjectIntents.Transform(doubles(it.get("translationMm")), doubles(it.get("rotation")), doubles(it.get("scale")))
    }
    private fun tool(value: Any) = TransformTool.entries.first { it.name.lowercase() == value }

    /** Equal numbers, component by component (the session keeps the doubles it is sent). */
    private fun same(a: ProjectIntents.Transform, b: ProjectIntents.Transform): Boolean {
        fun equal(x: List<Double>, y: List<Double>) = x.size == y.size && x.indices.all { x[it] == y[it] }
        return equal(a.translationMm, b.translationMm) && equal(a.rotation, b.rotation) && equal(a.scale, b.scale)
    }

    /** What the session can hold: the browser's `cloneAndValidateTransform`. */
    private fun holdable(t: ProjectIntents.Transform): Boolean {
        val values = t.translationMm + t.rotation + t.scale
        return values.all(Double::isFinite) && t.scale.none { kotlin.math.abs(it) < 1e-12 } && t.rotation.sumOf { it * it } >= 1e-12
    }

    /** The project's instances in project order, read on the authority. */
    @Suppress("UNCHECKED_CAST")
    private fun instances(workspace: ProjectWorkspace): List<InstanceFacts> = (done(
        workspace.actor.inspect { session -> session.snapshot().use { s -> s.query().use { ProjectFacts.instances(it) } } }.completion.toCompletableFuture(),
    ) as ProjectOutcome.Inspected).result.getOrThrow() as List<InstanceFacts>

    /** The transforms of [ids] the session holds now. */
    @Suppress("UNCHECKED_CAST")
    private fun transforms(workspace: ProjectWorkspace, ids: Collection<String>): Map<String, ProjectIntents.Transform> = (done(
        workspace.actor.inspect { session ->
            session.snapshot().use { s -> s.query().use { root -> ProjectInspection.placed(root, ids.toSet()).mapValues { it.value.second } } }
        }.completion.toCompletableFuture(),
    ) as ProjectOutcome.Inspected).result.getOrThrow() as Map<String, ProjectIntents.Transform>

    /** [script] is the corpus's field edits, one `E <request> <reply>` per line; [cube] the binary STL imported three times. */
    @JvmStatic fun run(cube: ByteArray, script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            // Nothing selected: no inspector, and an edit has nothing to act on.
            check(workspace.view.inspector == null, "no_inspector")
            check(done(workspace.editTransform(TransformTool.MOVE, listOf("1", "2", "3"))) == null && workspace.view.undo == null, "edit_without_selection")
            for (n in 1..3) done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            val placed = instances(workspace).map { it.id }
            check(placed.size == 3, "three_instances")
            var view = until(workspace, "unselected_actions") { it.activePlate?.objects == 3 && it.actions.isNotEmpty() }
            // The core gates the inspector's tools and the placement actions as the browser's registry does.
            val selectionActions = ProjectWorkspace.TRANSFORM_ACTIONS + listOf("tool_lay_on_face", "drop_to_bed", "mirror_x", "mirror_y", "mirror_z", "reset_rotation", "reset_scale")
            val modelActions = listOf("center_on_plate", "scale_to_fit_volume", "arrange_all")
            check(selectionActions.none { view.actions.getValue(it).enabled } && modelActions.all { view.actions.getValue(it).enabled }, "unselected_capabilities ${view.actions}")

            // Every field edit the browser computed, on the session.
            var applied = 0
            var unstaged = 0
            for ((index, line) in script.split("\n").withIndex()) {
                val entry = line.split("\t")
                kotlin.check(entry[0] == "E") { "unknown line ${entry[0]}" }
                val request = obj(entry[1])
                val reply = obj(entry[2])
                val origins = (request.get("origins") as ProjectJsonArray).let { list ->
                    List(list.length()) { (list.get(it) as ProjectJsonObject).let { o -> (o.get("instanceId") as String) to transform(o.get("transform")) } }
                }
                val distinct = origins.map { it.first }.distinct()
                if (distinct.size != origins.size || !origins.all { holdable(it.second) }) {
                    // A selection holds each instance once, and a session holds no transform the workspace would refuse.
                    unstaged++
                    check(reply.keys().asSequence().any { it == "error" }, "unstaged_${index}_is_refused")
                    continue
                }
                val ids = distinct.withIndex().associate { (at, id) -> id to placed[at] }
                val primary = ids.getValue(request.get("primaryInstanceId") as String)
                val before = origins.associate { ids.getValue(it.first) to it.second }
                done(workspace.execute(ProjectIntents.Command.SetInstanceTransforms(ProjectIntents.SetInstanceTransforms(
                    before.map { (id, t) -> ProjectIntents.InstanceTransform(units(id), t) }, units("setup:$index"),
                ))))
                done(workspace.deselectAll())
                val order = before.keys.filter { it != primary } + primary
                order.forEachIndexed { at, id -> done(workspace.selectInstance(id, extend = at > 0)) }
                val origin = before.getValue(primary)
                view = until(workspace, "inspector_$index") { v ->
                    v.inspector?.let { it.instanceId == primary && it.instances == order.size && same(it.transform, origin) } == true
                }
                val shown = checkNotNull(view.inspector)
                check(same(shown.transform, origin) && TransformTool.entries.all { shown.fields(it) == TransformFields.values(it, origin) }, "inspector_shows_$index")
                val label = view.undo
                val revision = view.revision
                val tool = tool(request.get("tool"))
                val outcome = attempt(workspace.editTransform(tool, strings(request.get("texts"))))
                if (reply.keys().asSequence().any { it == "error" }) {
                    check(outcome.exceptionOrNull()?.message == reply.get("message"), "refused_$index ${outcome.exceptionOrNull()}")
                    check(workspace.view.undo == label && workspace.view.revision == revision, "refusal_keeps_history_$index")
                    continue
                }
                applied++
                val changes = (reply.get("changes") as ProjectJsonArray).let { list ->
                    List(list.length()) { (list.get(it) as ProjectJsonObject).let { c -> ids.getValue(c.get("instanceId") as String) to transform(c.get("transform")) } }
                }.toMap()
                check(outcome.getOrNull() == changes.size, "edit_count_$index ${outcome.getOrNull()}")
                val after = transforms(workspace, before.keys)
                check(before.keys.all { id -> same(after.getValue(id), changes[id] ?: before.getValue(id)) }, "edit_lands_$index $after")
                val changed = changes.any { (id, t) -> !same(t, before.getValue(id)) }
                val expected = if (!changed) label else if (changes.size == 1) "Transform instance" else "Transform ${changes.size} instances"
                check(until(workspace, "label_$index") { it.undo == expected }.undo == expected, "edit_label_$index ${workspace.view.undo}")
                val primaryAfter = changes[primary] ?: origin
                view = until(workspace, "inspector_after_$index") { v -> v.inspector?.let { same(it.transform, primaryAfter) } == true }
                check(checkNotNull(view.inspector).fields(tool) == TransformFields.values(tool, primaryAfter), "inspector_follows_$index")
                if (changed) {
                    done(workspace.undo())
                    val undone = transforms(workspace, before.keys)
                    check(before.all { (id, t) -> same(undone.getValue(id), t) } && workspace.view.undo == label, "undo_restores_$index")
                }
            }
            check(applied == 69 && unstaged == 5, "corpus_cases applied=$applied unstaged=$unstaged")

            // One instance selected, at the import's own pose.
            val first = placed[0]
            done(workspace.execute(ProjectIntents.Command.SetInstanceTransforms(ProjectIntents.SetInstanceTransforms(
                listOf(ProjectIntents.InstanceTransform(units(first), ProjectIntents.Transform(listOf(100.0, 100.0, 0.0), listOf(0.0, 0.0, 0.0, 1.0), listOf(1.0, 1.0, 1.0)))),
                units("setup:home"),
            ))))
            done(workspace.selectInstance(first))
            view = until(workspace, "selected_actions") { it.inspector?.instanceId == first && it.actions["tool_move"]?.enabled == true }
            check(selectionActions.all { view.actions.getValue(it).enabled } && modelActions.all { view.actions.getValue(it).enabled }, "selected_capabilities")

            // Repeated edits of one field are separate entries: the browser's field edits draw `single:<n>`.
            done(workspace.editTransform(TransformTool.MOVE, listOf("110", "100", "0")))
            done(workspace.editTransform(TransformTool.MOVE, listOf("120", "100", "0")))
            check(until(workspace, "moved") { it.inspector?.move?.texts?.first() == "120.00" }.undo == "Transform instance", "second_move")
            done(workspace.undo())
            check(until(workspace, "one_undone") { it.inspector?.move?.texts?.first() == "110.00" }.undo == "Transform instance", "edits_do_not_coalesce")
            done(workspace.undo())
            check(until(workspace, "both_undone") { it.inspector?.move?.texts?.first() == "100.00" }.inspector != null, "undo_to_home")

            // The smoke's journey: rotate 90° about Z, scale 200 %, undo.
            done(workspace.editTransform(TransformTool.ROTATE, listOf("0", "0", "90")))
            check(until(workspace, "rotated") { it.inspector?.rotate?.texts == listOf("0.00", "0.00", "90.00") }.undo == "Transform instance", "rotate_z")
            done(workspace.editTransform(TransformTool.SCALE, listOf("200", "100", "100")))
            check(until(workspace, "scaled") { it.inspector?.scale?.texts?.first() == "200.00" }.undo == "Transform instance", "scale_x")
            done(workspace.undo())
            check(until(workspace, "unscaled") { it.inspector?.scale?.texts?.first() == "100.00" }.inspector?.rotate?.texts?.last() == "90.00", "scale_undone")
            // A refused edit leaves the fields and history as they were.
            val held = workspace.view.revision
            check(attempt(workspace.editTransform(TransformTool.SCALE, listOf("0", "100", "100"))).exceptionOrNull()?.message == "Instance transform scale cannot contain zero", "zero_scale_refused")
            check(workspace.view.revision == held && workspace.view.inspector?.scale?.texts?.first() == "100.00", "refusal_changes_nothing")

            // The Edit menu's placement actions on the selection.
            check(done(workspace.resetSelected(TransformReset.ROTATION)) == 1, "reset_rotation_selected")
            check(until(workspace, "reset_rotation") { it.inspector?.rotate?.texts == listOf("0.00", "0.00", "0.00") }.undo == "Transform instance", "reset_rotation")
            check(done(workspace.mirrorSelected(ProjectIntents.PlacementAxis.X)) == 1, "mirror_selected")
            check(until(workspace, "mirrored") { it.inspector?.scale?.texts?.first() == "-100.00" }.undo == "Transform instance", "mirror_label")
            check(done(workspace.resetSelected(TransformReset.SCALE)) == 1, "reset_scale_selected")
            check(until(workspace, "reset_scale") { it.inspector?.scale?.texts?.first() == "100.00" }.inspector != null, "reset_scale")
            done(workspace.editTransform(TransformTool.MOVE, listOf("100", "100", "20")))
            val drops = done(workspace.dropSelectedToBed())
            check(drops?.size == 1 && text(drops.single().instanceId) == first && drops.single().deltaZMm == -20.0, "drop_selected $drops")
            check(until(workspace, "dropped") { it.inspector?.move?.texts?.last() == "0.00" }.undo == "Transform instance", "drop_label")
            check(done(workspace.dropSelectedToBed())?.single()?.deltaZMm == 0.0, "already_on_bed")
            done(workspace.editTransform(TransformTool.MOVE, listOf("40", "100", "0")))
            check(done(workspace.centerSelectedOnPlate()) == 1, "center_selected")
            check(until(workspace, "centred") { it.inspector?.move?.texts?.first() == "95.00" }.undo == "Transform instance", "center_label ${workspace.view.inspector?.move}")
            // The empty project states no printable height: scale to fit refuses in the browser's words.
            check(attempt(workspace.scaleSelectedToFit()).exceptionOrNull()?.message == PlacementGestures.NO_PRINTABLE_HEIGHT, "scale_to_fit_refused")
            // Arrange the active plate: the three cubes laid out apart on the bed, one entry.
            val arranged = done(workspace.arrangeActivePlate())
            check(arranged != null && arranged.placements.size == 3 && arranged.unplacedInstanceIds.isEmpty(), "arranged $arranged")
            check(until(workspace, "arranged_label") { it.undo == "Transform 3 instances" }.undo == "Transform 3 instances", "arrange_label")

            // Nothing selected: the selection's actions have nothing to act on; centre takes the plate's models.
            done(workspace.deselectAll())
            until(workspace, "deselected") { it.inspector == null }
            check(done(workspace.mirrorSelected(ProjectIntents.PlacementAxis.Y)) == null && done(workspace.resetSelected(TransformReset.ROTATION)) == null, "nothing_to_mirror_or_reset")
            check(done(workspace.dropSelectedToBed()) == null, "nothing_to_drop")
            check(done(workspace.centerSelectedOnPlate()) == 3, "center_plate_models")
        }
        return checks
    }
}
