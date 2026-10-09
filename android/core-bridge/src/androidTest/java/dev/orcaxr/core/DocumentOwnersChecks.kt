package dev.orcaxr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Document ownership and change detection: a document is claimed by one
 * window, another is told who holds it, releases and closed windows free it;
 * a document's digest is what was last read from or written to it — through
 * the real archive Open and Save over JNI — and a change made outside shows
 * as a different current digest. */
object DocumentOwnersChecks {
    private class Memory(var bytes: ByteArray = ByteArray(0)) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong().takeIf { it > 0 }
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = object : ByteArrayOutputStream() {
            override fun close() { bytes = toByteArray() }
        }
    }

    private fun sha(bytes: ByteArray) = DigestingDocument.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    @JvmStatic fun run(cube: ByteArray): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        // Ownership.
        val owners = DocumentOwners()
        var focused = ""
        val first = DocumentOwners.Owner { focused = "first" }
        val second = DocumentOwners.Owner { focused = "second" }
        check(owners.claim("content://doc/a", first) == null, "first_claims")
        check(owners.claim("content://doc/a", first) == null, "claim_again_is_kept")
        check(owners.claim("content://doc/a", second) === first, "second_told_the_holder")
        owners.holder("content://doc/a")?.focus()
        check(focused == "first", "holder_brought_forward")
        check(owners.claim("content://doc/b", second) == null, "other_documents_coexist")
        owners.release("content://doc/a", second)
        check(owners.holder("content://doc/a") === first, "only_the_holder_releases")
        owners.release("content://doc/a", first)
        check(owners.claim("content://doc/a", second) == null, "released_document_claimable")
        owners.releaseAll(second)
        check(owners.holder("content://doc/a") == null && owners.holder("content://doc/b") == null, "closed_window_frees_all")
        // A window the system destroyed without releasing never blocks its document.
        fun claimAndDrop() {
            // A fresh object: a lambda capturing nothing would be one shared instance, never collected.
            check(owners.claim("content://doc/c", object : DocumentOwners.Owner { override fun focus() = Unit }) == null, "dropped_window_claims")
        }
        claimAndDrop()
        var collected = false
        for (attempt in 1..20) {
            System.gc()
            Thread.sleep(20)
            if (owners.holder("content://doc/c") == null) {
                collected = true
                break
            }
        }
        check(collected && owners.claim("content://doc/c", first) == null, "dropped_window_frees_document")

        // Digests through the real archive Save and Open.
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            workspace.ready().get(30, TimeUnit.SECONDS)
            val candidate = workspace.prepareImport(Memory(cube), "cube.stl").get(30, TimeUnit.SECONDS)
            workspace.commitImport(candidate, emptyList()).get(30, TimeUnit.SECONDS)
            val target = Memory()
            val saving = DigestingDocument(target, target)
            workspace.save(saving, "parts.3mf").get(30, TimeUnit.SECONDS)
            check(saving.digest == sha(target.bytes), "save_digest_is_written_bytes")
            val opening = DigestingDocument(target, target)
            workspace.open(opening, "parts.3mf").get(30, TimeUnit.SECONDS)
            check(opening.digest == sha(target.bytes), "open_reads_to_the_end")
            check(DigestingDocument.current(target) == opening.digest, "unchanged_document_matches")
            target.bytes = target.bytes + byteArrayOf(0)
            check(DigestingDocument.current(target) != opening.digest, "outside_change_detected")
        }
        return checks
    }
}
