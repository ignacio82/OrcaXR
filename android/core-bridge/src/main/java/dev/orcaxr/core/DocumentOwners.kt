package dev.orcaxr.core

import java.io.FilterInputStream
import java.io.FilterOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.lang.ref.WeakReference
import java.security.MessageDigest

/**
 * Which window holds each document, so a document never has two writers that
 * do not know about each other. A window claims the document it opened or
 * saved to; another window asking for it is told who holds it — to bring
 * that window forward instead of opening a second copy — and a window
 * forgets its claims when it is gone. An owner is held weakly: a window the
 * system destroyed without releasing never blocks its document.
 */
class DocumentOwners {
    companion object {
        /** The app process's registry: every window of the app shares it. */
        val process = DocumentOwners()
    }

    /** A window that can hold documents and be brought forward. */
    fun interface Owner {
        fun focus()
    }

    private val held = HashMap<String, WeakReference<Owner>>()

    /** The live owner of [document], if any. */
    fun holder(document: String): Owner? = synchronized(held) {
        held[document]?.get() ?: run {
            held.remove(document)
            null
        }
    }

    /** Claims [document] for [owner]; answers the other window holding it instead, claiming nothing. */
    fun claim(document: String, owner: Owner): Owner? = synchronized(held) {
        val current = held[document]?.get()
        if (current != null && current !== owner) return current
        held[document] = WeakReference(owner)
        null
    }

    fun release(document: String, owner: Owner) = synchronized(held) {
        if (held[document]?.get() === owner) held.remove(document)
    }

    /** Releases everything [owner] holds: its window is closing. */
    fun releaseAll(owner: Owner) = synchronized(held) {
        held.entries.removeAll { (_, reference) -> reference.get().let { it == null || it === owner } }
    }
}

/**
 * A document seen through a SHA-256 of its bytes: what was last read from it
 * or written to it. Saving over a document compares its current bytes with
 * that first, so a change made outside OrcaXR — another app, another device
 * syncing the file — is not overwritten unnoticed.
 */
class DigestingDocument(private val input: ProjectDocumentInput?, private val output: ProjectDocumentOutput?) :
    ProjectDocumentInput, ProjectDocumentOutput {
    companion object {
        fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

        /** The SHA-256 of everything [document] holds now, read through once. */
        fun current(document: ProjectDocumentInput): String = document.openInput().use { stream ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
            hex(digest.digest())
        }
    }

    /** The digest of the last complete read or write through this document. */
    @Volatile var digest: String? = null
        private set

    override val reportedLength: Long? get() = input?.reportedLength

    override fun openInput(): InputStream {
        val digest = MessageDigest.getInstance("SHA-256")
        return object : FilterInputStream(checkNotNull(input).openInput()) {
            private var ended = false
            override fun read(): Int = super.read().also { if (it < 0) ended = true else digest.update(it.toByte()) }
            override fun read(bytes: ByteArray, offset: Int, count: Int): Int =
                super.read(bytes, offset, count).also { if (it < 0) ended = true else digest.update(bytes, offset, it) }
            override fun close() {
                super.close()
                if (ended) this@DigestingDocument.digest = hex(digest.digest())
            }
        }
    }

    override fun openOutput(): OutputStream {
        val digest = MessageDigest.getInstance("SHA-256")
        return object : FilterOutputStream(checkNotNull(output).openOutput()) {
            override fun write(value: Int) {
                out.write(value)
                digest.update(value.toByte())
            }
            override fun write(bytes: ByteArray, offset: Int, count: Int) {
                out.write(bytes, offset, count)
                digest.update(bytes, offset, count)
            }
            override fun close() {
                super.close()
                this@DigestingDocument.digest = hex(digest.digest())
            }
        }
    }
}
