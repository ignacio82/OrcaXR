package dev.orcaxr.core

/** Borrowed, ordered input for one preparation callback. The actor seals and
 * consumes the upload; a retained writer cannot append after the callback returns.
 * Native input and finished-pool budgets apply independently of these chunk checks.
 */
class ProjectCommandWriter internal constructor(
    private val scope: ProjectPreparation,
    private val upload: ProjectCommandUpload,
    private val expectedBytes: Long,
) {
    private val gate = Any()
    private var active = true
    private var offset = 0L

    fun append(bytes: ByteArray) = synchronized(gate) {
        check(active) { "closed_writer" }
        scope.checkActive()
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES && bytes.size.toLong() <= expectedBytes - offset) { "input_limit" }
        upload.append(offset, bytes)
        offset += bytes.size
    }

    internal fun finish() = synchronized(gate) {
        check(active) { "closed_writer" }
        scope.checkActive()
        active = false
        require(offset == expectedBytes) { "incomplete_input" }
        upload.seal()
    }

    internal fun invalidate() = synchronized(gate) { active = false }
}
