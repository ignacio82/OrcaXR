package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/** The Project area's session through real JNI: it starts with the
 * browser's empty project; a model import is previewed without changing the
 * project, committed as one undoable entry (a lossy one only with its
 * acknowledgements), undone and redone; Save writes a 3MF through a provider
 * and acknowledges the checkpoint, a provider that fails leaves the project
 * dirty with the provider's code; Open reads it back with the same objects;
 * "New project" starts clean; recent documents stay newest first, one per
 * document, bounded. */
object ProjectWorkspaceChecks {
    private const val WAIT_S = 30L

    private class Memory(var bytes: ByteArray = ByteArray(0), val failWrite: Boolean = false) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong().takeIf { it > 0 }
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = object : ByteArrayOutputStream() {
            override fun write(data: ByteArray, offset: Int, count: Int) {
                if (failWrite) throw IOException("PRIVATE provider write")
                super.write(data, offset, count)
            }
            override fun close() {
                bytes = toByteArray()
            }
        }
    }
    private class MemoryText : DeviceTextStore {
        var text: String? = null
        override fun read() = text
        override fun write(text: String) { this.text = text }
    }

    private fun <T> done(future: java.util.concurrent.CompletableFuture<T>): T = future.get(WAIT_S, TimeUnit.SECONDS)
    private fun failure(future: java.util.concurrent.CompletableFuture<*>): String? = try {
        future.get(WAIT_S, TimeUnit.SECONDS)
        null
    } catch (thrown: ExecutionException) {
        (thrown.cause as? ProjectFailure)?.message ?: thrown.cause?.toString()
    }
    private fun labels(view: ProjectView) = view.rows.map { String(CharArray(it.label.size) { index -> it.label[index].toChar() }) }
    private fun required(preview: String): List<String> =
        Regex("\"requiredAcknowledgementIds\":\\[([^\\]]*)]").find(preview)!!.groupValues[1]
            .split(',').filter { it.isNotEmpty() }.map { it.trim('"') }

    /** Waits for the effects to bring [condition] about: they arrive on the actor's delivery thread. */
    private fun until(workspace: ProjectWorkspace, condition: (ProjectView) -> Boolean): ProjectView {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (!condition(workspace.view)) {
            kotlin.check(System.nanoTime() < deadline) { "view never settled: ${workspace.view}" }
            Thread.sleep(10)
        }
        return workspace.view
    }

    @JvmStatic fun run(cube: ByteArray, lossy: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        ProjectWorkspace(clock = { 1_791_550_609_936 }, resolver = LocalTimestampResolver { it }).use { workspace ->
            val first = done(workspace.ready())
            check(first.ready && first.name == "Untitled project" && first.plates == 1 && !first.dirty && first.undo == null, "starts_empty $first")
            check(labels(first) == listOf("Plate 1"), "one_plate ${labels(first)}")

            // Import: previewed without changing anything, then one undoable entry.
            val candidate = done(workspace.prepareImport(Memory(cube), "cube.stl"))
            check(!candidate.blocked && candidate.preview.contains("\"filename\":\"cube.stl\""), "previewed")
            check(!workspace.view.dirty && workspace.view.undo == null, "preview_changes_nothing")
            done(workspace.commitImport(candidate, emptyList()))
            val imported = until(workspace) { labels(it).size == 2 }
            check(imported.dirty && imported.undo != null && labels(imported)[1].startsWith("cube"), "imported $imported")
            done(workspace.undo())
            check(until(workspace) { labels(it).size == 1 }.redo != null, "undone")
            done(workspace.redo())
            check(until(workspace) { labels(it).size == 2 }.undo != null, "redone")

            // A lossy import is refused until every listed change is acknowledged.
            val lossyCandidate = done(workspace.prepareImport(Memory(lossy), "lossy.obj"))
            val ids = required(lossyCandidate.preview)
            check(ids.isNotEmpty(), "lossy_lists_changes")
            check(failure(workspace.commitImport(lossyCandidate, emptyList())) == "Confirm every listed change before importing.", "unacknowledged_refused")
            done(workspace.commitImport(lossyCandidate, ids))
            val both = until(workspace) { labels(it).size == 3 }
            check(both.totalRows == 3L, "two_objects")

            // Save through a provider: a failing one leaves the project dirty with its code.
            val broken = Memory(failWrite = true)
            check(failure(workspace.save(broken, "broken.3mf"))?.contains("document_write_failed") == true, "write_failure_reported")
            check(workspace.view.dirty && workspace.view.document == null, "still_dirty")
            val saved = Memory()
            done(workspace.save(saved, "parts.3mf"))
            check(!workspace.view.dirty && workspace.view.document == "parts.3mf" && saved.bytes.size > 100, "saved ${workspace.view}")
            check(saved.bytes[0] == 'P'.code.toByte() && saved.bytes[1] == 'K'.code.toByte(), "saved_a_zip")

            // "New project" starts clean; Open brings the saved objects back.
            done(workspace.newProject())
            val fresh = until(workspace) { labels(it).size == 1 }
            check(!fresh.dirty && fresh.undo == null && fresh.document == null && fresh.name == "Untitled project", "new_project $fresh")
            done(workspace.open(saved, "parts.3mf"))
            val reopened = until(workspace) { labels(it).size == 3 }
            check(labels(reopened) == labels(both) && !reopened.dirty && reopened.document == "parts.3mf", "reopened ${labels(reopened)}")
            check(failure(workspace.open(Memory("not a zip".toByteArray()), "bad.3mf"))?.startsWith("OrcaXR could not read it") == true, "bad_document_refused")
            check(labels(workspace.view).size == 3, "refused_open_keeps_project")
        }

        // Recent documents: newest first, one per document, at most eight.
        val store = MemoryText()
        val recent = RecentDocuments(store)
        check(recent.entries.isEmpty(), "recent_empty")
        for (n in 1..9) recent.used("content://doc/$n", "Doc $n.3mf")
        check(recent.entries.map { it.name }.first() == "Doc 9.3mf" && recent.entries.size == RecentDocuments.MAX, "recent_bounded")
        val dropped = recent.used("content://doc/5", "Doc 5\u0000\n.3mf")
        check(recent.entries.first() == RecentDocuments.Entry("content://doc/5", "Doc 5.3mf") && recent.entries.size == RecentDocuments.MAX, "recent_moved_up")
        check(dropped.isEmpty(), "nothing_dropped_when_moved")
        recent.forget("content://doc/5")
        check(recent.entries.none { it.uri == "content://doc/5" }, "recent_forgotten")
        check(RecentDocuments(MemoryText().apply { text = "garbage\n\u0000x\nok\u0000Name" }).entries == listOf(RecentDocuments.Entry("ok", "Name")), "corrupt_store_read")
        return checks
    }
}
