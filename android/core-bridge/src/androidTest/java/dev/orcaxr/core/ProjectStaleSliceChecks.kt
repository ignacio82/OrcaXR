package dev.orcaxr.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * A fresh slice after an edit stays current, on a real session: the
 * emulator's sequence (the catalog's default profile made a new project's
 * baseline, a cube from the Add menu, sliced; Fill Bed with Instances,
 * sliced again) and the other creation and placement edits (add instance,
 * copy and paste, arrange, undo). After each edit the state the view reports
 * is the one the preflight judges and both routes' captures stage — the
 * external route's one-plate archive and the local route's job — and it
 * holds while the recovery capture the edit scheduled runs between staging
 * and completion (as it did on the emulator, five seconds after the fill),
 * with preflights read meanwhile; so the local route publishes the engine's
 * output and the result compares current, as the browser's
 * `StoreProjectSliceSource.isCurrent` does (revision, semantic hash and asset
 * fingerprint). An edit after staging still withdraws it. The defect the
 * emulator showed was the Preview area's withdrawal notice outliving the
 * fresh slice (`PreviewCurrency`), not the project's state.
 */
object ProjectStaleSliceChecks {
    private const val WAIT_S = 120L

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** [catalogJson] is the bundled profile catalog; [gcode] stands for the engine's output. */
    @JvmStatic fun run(catalogJson: ByteArray, gcode: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
        val scratch = Files.createTempDirectory("orcaxr-stale-slice-").toFile()
        val readers = Executors.newFixedThreadPool(2)
        try {
            val recovery = ProjectRecovery(File(scratch, "recovery"))
            // The recovery captures the workspace schedules, run when the check says: between staging and completion.
            val scheduled = java.util.Collections.synchronizedList(ArrayList<() -> Unit>())
            val schedule = { _: Long, task: () -> Unit ->
                scheduled += task
                AutoCloseable { scheduled -= task }
            }
            val jobs = File(scratch, "engine-jobs")
            ProfileCatalogs.build(catalogJson, collator = null).use { catalog ->
                val live = checkNotNull(catalog.defaultSelection(LiveSlicingChoice.EMPTY)?.live) { "no_default" }
                val target = { tools: Int -> checkNotNull(ProfileCatalogs.preflightTarget(catalog, live, tools)) }
                ProjectWorkspace(resolver = LocalTimestampResolver { it }, recovery = recovery, schedule = schedule).use { workspace ->
                    done(workspace.ready())
                    // As the app starts: the default profile applied, then made a new project's baseline.
                    check(done(workspace.applySlicingChoice(catalog, live)), "profile_applied")
                    done(workspace.newProject())
                    check(workspace.view.undo == null && !workspace.view.dirty, "pristine")

                    var sliced = 0
                    /** One slice on both routes of the project as it stands; answers the state it was staged from. */
                    fun slice(edit: String): ProjectRevision {
                        val stands = checkNotNull(workspace.view.revision) { "no_revision" }
                        val plate = checkNotNull(workspace.view.activePlate) { "no_plate" }.id
                        val preflight = done(workspace.preflight(plate, target))
                        check(preflight.summary.canSlice && preflight.revision == stands, "${edit}_preflight")
                        // The external route's capture: the archive it uploads.
                        val archive = done(workspace.projectPlate(plate, object : ProjectDocumentOutput {
                            override fun openOutput(): OutputStream = ByteArrayOutputStream()
                        }))
                        check(archive.revision == stands, "${edit}_external_capture")
                        // The local route's capture: the same archive staged as a private job.
                        val job = LocalSlicing.stage(jobs, "%032x".format(++sliced)) { output -> done(workspace.projectPlate(plate, output)) }
                        try {
                            check(job.revision == stands, "${edit}_local_capture")
                            // Meanwhile the capture the edit scheduled runs (what its timer runs, awaited), and Prepare reads preflights.
                            check(synchronized(scheduled) { scheduled.isNotEmpty().also { scheduled.clear() } }, "${edit}_capture_due")
                            val reads = List(3) { readers.submit<ProjectRevision> { done(workspace.preflight(plate, target)).revision } }
                            check(done(workspace.captureRecovery()), "${edit}_captured")
                            check(reads.all { it.get(WAIT_S, TimeUnit.SECONDS) == stands }, "${edit}_preflights_unchanged")
                            check(recovery.list().any { it.session == workspace.session && it.identity.semanticHash == stands.semanticHash }, "${edit}_recovery_copy")
                            // Over time, the view still reports the staged state.
                            var steady = true
                            repeat(10) {
                                Thread.sleep(20)
                                steady = steady && workspace.view.revision == stands
                            }
                            check(steady, "${edit}_view_steady ${workspace.view.revision} $stands")
                            // The engine's output, claimed and published for the state it was staged from.
                            job.output.writeBytes(gcode)
                            val verified = LocalSlicing.claim(job, LocalEngineResult.Completed(1, gcode.size.toLong(), sha(gcode), 0), File(scratch, "slice.gcode.part"))
                            val published = File(scratch, "gcode/plate.gcode")
                            check(LocalSlicing.publish(verified, job, workspace.view.revision, published) == published, "${edit}_local_published")
                            // As Prepare's card, Preview and Send compare it: current.
                            check(workspace.view.revision == job.revision && workspace.view.revision == archive.revision, "${edit}_current")
                        } finally {
                            LocalSlicing.discard(job)
                        }
                        return stands
                    }

                    // The emulator's sequence: a cube, sliced; the bed filled, sliced again.
                    val cube = checkNotNull(done(workspace.addPrimitive(PrimitiveShape.CUBE))) { "no_cube" }
                    check(workspace.view.undo == "Add cube.stl" && workspace.view.selection.instances == setOf(cube.instanceId), "cube_selected")
                    var last = slice("cube")
                    fun edited(label: String, undo: (String?) -> Boolean) {
                        val now = workspace.view.revision
                        check(now != null && now != last, "${label}_withdraws_last_slice")
                        check(undo(workspace.view.undo), "${label}_undo_label ${workspace.view.undo}")
                        last = slice(label)
                    }
                    val fill = checkNotNull(done(workspace.fillBed())) { "no_fill" }
                    check(fill.created > 1, "fill_created ${fill.created}")
                    edited("fill") { it == "Fill ${fill.created} instances" }

                    // The other creation and placement edits: each one undoable step, and the next slice current.
                    done(workspace.selectInstance(cube.instanceId))
                    check(done(workspace.cloneSelected()) != null, "instance_added")
                    edited("add_instance") { it == "Create instance" }
                    check(done(workspace.copySelected()) == cube.objectId, "copied")
                    check(done(workspace.paste()) != null, "pasted")
                    edited("paste") { it == "Paste model" }
                    done(workspace.arrangeActivePlate())
                    edited("arrange") { it != null && Regex("Transform \\d+ instances").matches(it) }
                    done(workspace.addPrimitive(PrimitiveShape.SPHERE))
                    edited("primitive") { it == "Add sphere.stl" }
                    done(workspace.undo())
                    edited("undo") { it != null && Regex("Transform \\d+ instances").matches(it) && workspace.view.redo == "Add sphere.stl" }

                    // An edit after staging still withdraws the slice: both captures are left behind.
                    val plate = checkNotNull(workspace.view.activePlate).id
                    val job = LocalSlicing.stage(jobs, "%032x".format(++sliced)) { output -> done(workspace.projectPlate(plate, output)) }
                    try {
                        done(workspace.addPrimitive(PrimitiveShape.CONE))
                        check(workspace.view.revision != job.revision, "edit_after_staging_withdraws")
                        job.output.writeBytes(gcode)
                        val verified = LocalSlicing.claim(job, LocalEngineResult.Completed(1, gcode.size.toLong(), sha(gcode), 0), File(scratch, "slice.gcode.part"))
                        val stale = File(scratch, "gcode/stale.gcode")
                        check(LocalSlicing.publish(verified, job, workspace.view.revision, stale) == null && !stale.exists(), "stale_output_discarded")
                    } finally {
                        LocalSlicing.discard(job)
                    }
                }
            }
        } finally {
            readers.shutdownNow()
            LocalSlicing.discard(scratch)
        }
        return checks
    }
}
