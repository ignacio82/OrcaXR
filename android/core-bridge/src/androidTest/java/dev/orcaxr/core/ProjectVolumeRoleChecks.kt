package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * The semantic editor's volume roles and Set as Negative Part on a real
 * session, over JNI.
 *
 * The Kotlin readers first take every reply of the browser's corpus
 * (`volume-role-vectors.json`): each part's role choices — every role in
 * Orca's order, one current, a choice offered exactly when the command
 * accepts a real change, the summary line — every decision with its code and
 * words, and every conversion's words, read back through the core.
 *
 * Then on an imported cube: Set as Negative Part with nothing selected is
 * refused in the browser's words; the only part offers no other role (the
 * last model part, in the command's words) and a conversion is refused before
 * anything is submitted; with the instance selected, Set as Negative Part
 * adds a negative volume ("Add negative part to object", the new part
 * selected), and with that part selected adds another; the semantic editor
 * converts the negative volume to a modifier and then to a part, each one
 * undoable step with the core's label and the browser's words; a stale panel
 * is refused in the browser's words; with a second model part, Set as
 * Negative Part converts the selected part, and the object's last model part
 * is refused; and undo walks every step back to the imported cube. Facet
 * paint and local filaments block conversions in the corpus's decisions.
 */
object ProjectVolumeRoleChecks {
    private const val WAIT_S = 60L
    private const val LAST_MODEL = "The last model part on an object cannot be converted to a non-model role"
    private const val CURRENT = "This is the current role; no conversion is needed."

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
            kotlin.check(System.nanoTime() < deadline) { "$label never settled: ${workspace.view.undo} ${workspace.view.selection}" }
            Thread.sleep(10)
        }
        return workspace.view
    }
    private fun objects(value: Any): List<ProjectJsonObject> = (value as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as ProjectJsonObject } }
    private fun has(obj: ProjectJsonObject, key: String) = obj.keys().asSequence().any { it == key }
    private fun units(text: String) = text.map { it.code }

    @Suppress("UNCHECKED_CAST")
    private fun instances(workspace: ProjectWorkspace): List<InstanceFacts> = done(
        workspace.actor.inspect { session -> session.snapshot().use { s -> s.query().use { ProjectFacts.instances(it) } } }
            .completion.toCompletableFuture(),
    ).let { (it as ProjectOutcome.Inspected).result.getOrThrow() as List<InstanceFacts> }

    /** [corpus] is `volume-role-vectors.json`; [cube] a binary STL. */
    @JvmStatic fun run(corpus: String, cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }

        // The corpus's replies through the Kotlin readers.
        val reference = CanonicalJson.read(corpus) as ProjectJsonObject
        for (case in objects(reference.get("projections"))) {
            val request = case.get("requestJson") as String
            val projection = VolumeRoleEditors.projection(case.get("replyJson") as String)
            if (projection == null) {
                check((CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject).get("projection") !is ProjectJsonObject, "projection_null $request")
                continue
            }
            check(projection.choices.map { it.role } == VolumeRole.entries.toList(), "order $request")
            val current = projection.choices.single { it.current }
            check(current.role == projection.role && current.blockedReason == CURRENT, "current $request")
            check(projection.summary == "${projection.volumeName} — ${current.label}", "summary $request")
            for (choice in projection.choices) {
                check(choice.offered == (choice.decision == VolumeRoleDecision.Allowed(false) && !choice.current), "offered $request ${choice.role}")
                check(choice.offered || choice.blockedReason == CURRENT || choice.blockedReason == (choice.decision as VolumeRoleDecision.Blocked).reason, "reason $request ${choice.role}")
            }
        }
        for (case in objects(reference.get("decisions"))) {
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            val decision = VolumeRoleEditors.decision(case.get("replyJson") as String)
            check(
                if (reply.get("allowed") as Boolean) decision == VolumeRoleDecision.Allowed(reply.get("noop") as Boolean)
                else decision == VolumeRoleDecision.Blocked(reply.get("code") as String, reply.get("reason") as String),
                "decision ${case.get("requestJson")}",
            )
        }
        for (case in objects(reference.get("messages"))) {
            val request = CanonicalJson.read(case.get("requestJson") as String) as ProjectJsonObject
            val reply = CanonicalJson.read(case.get("replyJson") as String) as ProjectJsonObject
            val words = VolumeRoleEditors.messages(request.get("volumeName") as String, VolumeRole.of(request.get("role") as String))
            check(words == VolumeRoleMessages(reply.get("pending") as String, reply.get("success") as String), "messages ${case.get("requestJson")}")
        }
        check(objects(reference.get("refusals")).all { has(it, "exchange") }, "refusals")

        // The workflows on a real session.
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            done(workspace.ready())
            check(failure(workspace.setNegativePart()) == ProjectWorkspace.NEGATIVE_PART_UNSELECTED && workspace.view.undo == null, "unselected")
            done(workspace.prepareImport(Memory(cube), "cube.stl").thenCompose { workspace.commitImport(it, emptyList()) })
            val imported = until(workspace, "import") { it.undo != null }.undo
            val instance = instances(workspace).single()
            val settings = ProjectSettings(workspace)
            val targets = done(settings.targets())
            val body = checkNotNull(targets.singleOrNull { it.scope == "part" }) { "part target ${targets.map { it.id }}" }.id.removePrefix("part:")

            // The only part: every other role is the object's last model part's; converting is refused before anything is submitted.
            var roles = done(settings.volumeRoles(body))!!
            check(roles.projection.objectId == instance.objectId && roles.projection.role == VolumeRole.MODEL, "body ${roles.projection}")
            check(roles.projection.summary == "${roles.projection.volumeName} — Part", "body_summary ${roles.projection.summary}")
            check(roles.projection.choices.map { it.label } == listOf("Part", "Negative volume", "Parameter modifier", "Support blocker", "Support enforcer"), "labels")
            check(roles.projection.choices.drop(1).all { it.blockedReason == LAST_MODEL && (it.decision as VolumeRoleDecision.Blocked).code == "last-model-volume" }, "last_model")
            check(failure(settings.convertVolumeRole(roles, VolumeRole.NEGATIVE_VOLUME)) == LAST_MODEL && workspace.view.undo == imported, "last_model_refused")
            check(done(settings.convertVolumeRole(roles, VolumeRole.MODEL)) == Unit && workspace.view.undo == imported, "current_role_nothing")

            // Set as Negative Part on the selected instance adds a negative volume and selects it.
            done(workspace.selectInstance(instance.id))
            check(until(workspace, "enabled") { it.actions["set_negative_part"]?.enabled == true }.actions.getValue("set_negative_part").enabled, "set_negative_enabled")
            val added = done(workspace.setNegativePart()) as NegativePartResult.Added
            val cutter = added.added.volumeId
            var view = until(workspace, "added") { it.undo == "Add negative part to object" }
            check(added.added.objectId == instance.objectId && view.selection.primary == ProjectIntents.SelectionEntity.Volume(units(cutter)), "added_selected")
            // A selected part: the core does not offer the action (an instance selection), and the browser's
            // workspace adds another negative volume beside one already negative.
            check(until(workspace, "part_disabled") { it.actions["set_negative_part"]?.enabled == false }.actions.getValue("set_negative_part").reason != null, "set_negative_disabled")
            val another = done(workspace.setNegativePart())
            check(another is NegativePartResult.Added && another.added.volumeId != cutter, "another_added")
            until(workspace, "another") { it.selection.primary == ProjectIntents.SelectionEntity.Volume(units((another as NegativePartResult.Added).added.volumeId)) }
            done(workspace.undo())
            view = until(workspace, "another_undone") { it.undo == "Add negative part to object" && it.redo == "Add negative part to object" }
            done(workspace.selectRow("volume:$cutter"))
            until(workspace, "cutter_selected") { it.selection.primary == ProjectIntents.SelectionEntity.Volume(units(cutter)) }

            // The negative volume's choices, and conversions through the semantic editor.
            roles = done(settings.volumeRoles(cutter))!!
            check(roles.projection.role == VolumeRole.NEGATIVE_VOLUME && roles.projection.summary.endsWith(" — Negative volume"), "cutter ${roles.projection.summary}")
            check(roles.projection.choices.map { it.offered } == listOf(true, false, true, true, true), "cutter_offered")
            check(roles.projection.choices[1].blockedReason == CURRENT, "cutter_current")
            val name = roles.projection.volumeName
            check(
                VolumeRoleEditors.messages(name, VolumeRole.PARAMETER_MODIFIER) ==
                    VolumeRoleMessages("Converting $name to Parameter modifier…", "Converted $name to Parameter modifier."),
                "modifier_words",
            )
            done(settings.convertVolumeRole(roles, VolumeRole.PARAMETER_MODIFIER))
            check(until(workspace, "modifier") { it.undo == "Convert volume to modifier" }.selection.primary == ProjectIntents.SelectionEntity.Volume(units(cutter)), "modifier_label")
            roles = done(settings.volumeRoles(cutter))!!
            check(roles.projection.role == VolumeRole.PARAMETER_MODIFIER && roles.projection.choices[2].current, "modifier")
            // A panel read before another edit is refused in the browser's words, and changes nothing.
            val stale = roles
            done(workspace.undo())
            until(workspace, "undo_modifier") { it.undo == "Add negative part to object" }
            check(failure(settings.convertVolumeRole(stale, VolumeRole.SUPPORT_BLOCKER)) == ProjectSettings.STALE_RANGE, "stale")
            check(workspace.view.undo == "Add negative part to object", "stale_nothing")
            done(workspace.redo())
            until(workspace, "redo_modifier") { it.undo == "Convert volume to modifier" }
            roles = done(settings.volumeRoles(cutter))!!
            done(settings.convertVolumeRole(roles, VolumeRole.MODEL))
            until(workspace, "part") { it.undo == "Convert volume to part" }

            // Two model parts: the body may leave the model role now.
            roles = done(settings.volumeRoles(body))!!
            check(roles.projection.choices.map { it.offered } == listOf(false, true, true, true, true), "body_free")
            done(workspace.selectRow("volume:$body"))
            until(workspace, "body_selected") { it.selection.primary == ProjectIntents.SelectionEntity.Volume(units(body)) }

            // Set as Negative Part on a selected part converts it; the object's last model part is refused.
            val converted = done(workspace.setNegativePart())
            check(converted == NegativePartResult.Converted(body), "converted $converted")
            check(until(workspace, "converted") { it.undo == "Convert volume to negative part" }.selection.primary == ProjectIntents.SelectionEntity.Volume(units(body)), "converted_label")
            check(done(settings.volumeRoles(body))!!.projection.role == VolumeRole.NEGATIVE_VOLUME, "body_negative")
            done(workspace.selectRow("volume:$cutter"))
            until(workspace, "last_selected") { it.selection.primary == ProjectIntents.SelectionEntity.Volume(units(cutter)) }
            check(failure(workspace.setNegativePart()) == LAST_MODEL && workspace.view.undo == "Convert volume to negative part", "last_refused")
            check(done(settings.volumeRoles("00000000-0000-4000-8000-000000000000")) == null, "unknown_part")

            // Undo walks every step back to the imported cube.
            for (label in listOf("Convert volume to negative part", "Convert volume to part", "Convert volume to modifier", "Add negative part to object")) {
                check(workspace.view.undo == label, "undo_label $label ${workspace.view.undo}")
                done(workspace.undo())
            }
            check(until(workspace, "undone") { it.undo == imported }.undo == imported, "undone")
            roles = done(settings.volumeRoles(body))!!
            check(roles.projection.role == VolumeRole.MODEL && roles.projection.choices.drop(1).all { it.blockedReason == LAST_MODEL }, "body_restored")
            check(done(settings.volumeRoles(cutter)) == null, "cutter_gone")
        }
        return checks
    }
}
