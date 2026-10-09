package dev.orcaxr.core

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * Copies of unsaved projects kept so a session the system ended can be
 * restored, as the browser's recovery store keeps them: one complete 3MF per
 * editing session, with its project name, document, capture time, length and
 * SHA-256, inside a byte budget. A copy is written to a temporary file and
 * renamed over the last one only once complete, so a session killed while
 * writing keeps its previous copy; a copy whose bytes no longer match its
 * record is listed as damaged, never restored. Nothing here leaves the app's
 * private storage.
 */
class ProjectRecovery(private val folder: File, private val budgetBytes: Long = BUDGET_BYTES) {
    companion object {
        /** The browser's recovery budget. */
        const val BUDGET_BYTES = 512L * 1024 * 1024
        private const val ARCHIVE = ".3mf"
        private const val RECORD = ".record"
        private const val PARTIAL = ".partial"
        private val SESSION = Regex("[A-Za-z0-9-]{1,64}")
    }

    /** One recoverable session; [damaged] when its archive no longer matches its record. */
    data class Entry(
        val session: String,
        val projectName: String,
        val document: String?,
        val capturedAtMs: Long,
        val byteLength: Long,
        /** What the restored project must be: its id, semantic hash and asset fingerprint when captured. */
        val identity: ProjectIdentity,
        val damaged: Boolean,
    )

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun archive(session: String) = File(folder, session + ARCHIVE)
    private fun record(session: String) = File(folder, session + RECORD)

    private fun checked(session: String): String = session.also { require(SESSION.matches(it)) { "invalid_session" } }

    /**
     * Captures [session]'s copy: [write] streams the complete archive. The
     * previous copy stays until this one is complete and fits the budget.
     */
    fun capture(
        session: String,
        projectName: String,
        document: String?,
        capturedAtMs: Long,
        identity: ProjectIdentity,
        write: (OutputStream) -> Unit,
    ) {
        checked(session)
        folder.mkdirs()
        val partial = File(folder, session + PARTIAL)
        val digest = MessageDigest.getInstance("SHA-256")
        var length = 0L
        val held = others(session)
        try {
            FileOutputStream(partial).use { file ->
                write(object : OutputStream() {
                    override fun write(value: Int) = write(byteArrayOf(value.toByte()), 0, 1)
                    override fun write(bytes: ByteArray, offset: Int, count: Int) {
                        length += count
                        check(length + held <= budgetBytes) { "recovery_budget" }
                        digest.update(bytes, offset, count)
                        file.write(bytes, offset, count)
                    }
                })
                file.fd.sync()
            }
            val text = listOf(
                projectName, document.orEmpty(), capturedAtMs.toString(), length.toString(), hex(digest.digest()),
                identity.projectId, identity.semanticHash, identity.assetFingerprint,
            )
                .joinToString("\n") { line -> line.replace('\n', ' ') }
            val recordPartial = File(folder, session + RECORD + PARTIAL)
            recordPartial.writeText(text)
            check(partial.renameTo(archive(session)) && recordPartial.renameTo(record(session))) { "recovery_write_failed" }
        } finally {
            partial.delete()
        }
    }

    /** Bytes other sessions' copies hold. */
    private fun others(session: String): Long =
        folder.listFiles().orEmpty().filter { it.name.endsWith(ARCHIVE) && it.name != session + ARCHIVE }.sumOf { it.length() }

    /** Every recoverable session, newest first. */
    fun list(): List<Entry> = folder.listFiles().orEmpty().filter { it.name.endsWith(RECORD) }.mapNotNull { file ->
        val session = file.name.removeSuffix(RECORD).takeIf(SESSION::matches) ?: return@mapNotNull null
        val lines = runCatching { file.readText().split('\n') }.getOrNull()?.takeIf { it.size == 8 } ?: return@mapNotNull null
        val length = lines[3].toLongOrNull() ?: return@mapNotNull null
        val bytes = runCatching { archive(session).readBytes() }.getOrNull()
        val damaged = bytes == null || bytes.size.toLong() != length || hex(MessageDigest.getInstance("SHA-256").digest(bytes)) != lines[4]
        Entry(
            session, lines[0], lines[1].ifEmpty { null }, lines[2].toLongOrNull() ?: 0, length,
            ProjectIdentity(lines[5], lines[6], lines[7]), damaged,
        )
    }.sortedByDescending { it.capturedAtMs }

    /** The copy to restore, as a document; only an undamaged one is offered. */
    fun document(session: String): ProjectDocumentInput {
        val file = archive(checked(session))
        return object : ProjectDocumentInput {
            override val reportedLength: Long? get() = file.length().takeIf { it > 0 }
            override fun openInput() = file.inputStream()
        }
    }

    /** Forgets [session]'s copy (restored, discarded, or saved properly). */
    fun discard(session: String) {
        checked(session)
        archive(session).delete()
        record(session).delete()
    }
}
