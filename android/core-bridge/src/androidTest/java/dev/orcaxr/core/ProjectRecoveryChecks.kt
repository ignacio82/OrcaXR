package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Recovery of unsaved work through real JNI: copies replace one another only
 * once complete, a damaged copy is never offered, a session cannot exceed the
 * budget; the workspace captures on the browser's timing (5 s after the latest
 * change, at most 30 s after the first), restores a copy into a later session
 * only when it is the project its record names, and forgets its own copy once
 * the work is saved or discarded. */
object ProjectRecoveryChecks {
    private const val WAIT_S = 30L

    private class Bytes(var bytes: ByteArray = ByteArray(0)) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong().takeIf { it > 0 }
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = object : ByteArrayOutputStream() {
            override fun close() { bytes = toByteArray() }
        }
    }

    private fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(work: () -> Unit): String? = try {
        work()
        null
    } catch (thrown: ExecutionException) {
        thrown.cause?.message
    } catch (thrown: RuntimeException) {
        thrown.message
    }
    private fun rows(workspace: ProjectWorkspace) = workspace.view.rows.size

    @JvmStatic fun run(cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        val folder = Files.createTempDirectory("orcaxr-recovery").toFile()
        try {
            // The store.
            val identity = ProjectIdentity("project-a", "fnv1a64:0", "fnv1a64:1")
            val store = ProjectRecovery(folder, budgetBytes = 64)
            store.capture("session-1", "First", "first.3mf", 1_000, identity) { it.write(ByteArray(20) { 7 }) }
            val first = store.list().single()
            check(first == ProjectRecovery.Entry("session-1", "First", "first.3mf", 1_000, 20, identity, false), "captured $first")
            check(failure { store.capture("session-1", "First", null, 2_000, identity) { out -> out.write(ByteArray(5)); error("killed") } } == "killed", "interrupted")
            check(store.list().single().byteLength == 20L && folder.listFiles()!!.none { it.name.endsWith(".partial") }, "interrupted_copy_keeps_previous")
            check(failure { store.capture("session-2", "Second", null, 3_000, identity) { it.write(ByteArray(50)) } } == "recovery_budget", "budget_refused")
            check(store.list().map { it.session } == listOf("session-1"), "budget_keeps_other_sessions")
            File(folder, "session-1.3mf").writeBytes(ByteArray(20) { 8 })
            check(store.list().single().damaged, "damaged_detected")
            check(failure { store.capture("../escape", "x", null, 0, identity) {} } == "invalid_session", "session_names_checked")
            store.discard("session-1")
            check(store.list().isEmpty() && folder.listFiles()!!.isEmpty(), "discarded")

            // The workspace: the browser's capture timing.
            val recovery = ProjectRecovery(folder)
            val now = AtomicLong(1_791_550_000_000)
            val delays = ArrayList<Long>()
            var cancelled = 0
            val schedule = { delay: Long, _: () -> Unit -> delays += delay; AutoCloseable { cancelled++ } }
            val saved = Bytes()
            var captured: ProjectRecovery.Entry
            ProjectWorkspace(clock = now::get, resolver = LocalTimestampResolver { it }, recovery = recovery, schedule = schedule).use { workspace ->
                done(workspace.ready())
                check(delays.isEmpty(), "clean_schedules_nothing")
                check(!done(workspace.captureRecovery()), "clean_captures_nothing")
                done(workspace.commitImport(done(workspace.prepareImport(Bytes(cube), "cube.stl")), emptyList()))
                check(delays == listOf(ProjectWorkspace.CAPTURE_DELAY_MS), "first_change_waits_5s $delays")
                now.addAndGet(27_000)
                done(workspace.commitImport(done(workspace.prepareImport(Bytes(cube), "cube.stl")), emptyList()))
                check(delays.last() == 3_000L && cancelled == 1, "capture_by_30s_after_first_change $delays")
                // Undoing back to the saved state leaves nothing to capture.
                done(workspace.undo())
                done(workspace.undo())
                check(cancelled == 3 && delays.size == 3 && !done(workspace.captureRecovery()), "clean_again_cancels $cancelled $delays")
                done(workspace.redo())
                check(done(workspace.captureRecovery()), "captured_when_unsaved")
                captured = recovery.list().single()
                check(captured.session == workspace.session && !captured.damaged && captured.projectName == "Untitled project", "copy_recorded $captured")
                // Saving the work forgets the copy.
                done(workspace.save(saved, "kept.3mf"))
                check(recovery.list().isEmpty(), "saved_work_forgets_copy")
                done(workspace.newProject())
                done(workspace.commitImport(done(workspace.prepareImport(Bytes(cube), "cube.stl")), emptyList()))
                check(done(workspace.captureRecovery()), "captured_again")
                captured = recovery.list().single()
            }
            // A later session restores the copy, only when it is the recorded project.
            ProjectWorkspace(clock = now::get, resolver = LocalTimestampResolver { it }, recovery = recovery, schedule = schedule).use { later ->
                done(later.ready())
                check(later.session != captured.session && rows(later) == 1, "later_session_starts_empty")
                val forged = captured.copy(identity = captured.identity.copy(semanticHash = "fnv1a64:0000000000000000"))
                check(failure { done(later.restore(forged)) }?.contains("recovery_mismatch") == true, "mismatched_copy_refused")
                check(rows(later) == 1, "refused_restore_changes_nothing")
                done(later.restore(captured))
                check(rows(later) == 2 && later.view.document == null, "restored ${later.view}")
                check(recovery.list().map { it.session } == listOf(captured.session), "restored_copy_kept_until_discarded")
                recovery.discard(captured.session)
                done(later.commitImport(done(later.prepareImport(Bytes(cube), "cube.stl")), emptyList()))
                check(done(later.captureRecovery()), "later_session_captures")
                later.discardRecovery()
                check(recovery.list().isEmpty(), "discarded_changes_forget_copy")
            }
        } finally {
            folder.deleteRecursively()
        }
        return checks
    }
}
