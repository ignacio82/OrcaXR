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

/** Borrowed payload input once the records are sealed: one declared payload at a
 * time, in the order the upload reports, each streamed in bounded chunks and then
 * validated. Finishing the last payload prepares the work's commands, so this runs
 * on the preparation worker; a retained writer cannot append after the callback.
 */
class ProjectAssetWriter internal constructor(
    private val scope: ProjectPreparation,
    private val upload: ProjectCommandUpload,
) {
    private val gate = Any()
    private var active = true
    private var length = -1L
    private var offset = 0L

    /** Declared payloads, in first-declaration order. */
    fun count(): Long = synchronized(gate) {
        check(active) { "closed_writer" }
        upload.assetCount()
    }

    /** Start payload [position]; returns its exact byte length. */
    fun begin(position: Long): Long = synchronized(gate) {
        check(active && length < 0) { "closed_writer" }
        scope.checkActive()
        upload.beginAsset(position).also {
            length = it
            offset = 0
        }
    }

    fun append(bytes: ByteArray) = synchronized(gate) {
        check(active && length >= 0) { "closed_writer" }
        scope.checkActive()
        require(bytes.size <= ProjectHost.MAX_CHUNK_BYTES && bytes.size.toLong() <= length - offset) { "input_limit" }
        upload.appendAsset(offset, bytes)
        offset += bytes.size
    }

    fun finish() = synchronized(gate) {
        check(active && length >= 0) { "closed_writer" }
        scope.checkActive()
        require(offset == length) { "incomplete_input" }
        upload.finishAsset()
        length = -1
    }

    internal fun invalidate() = synchronized(gate) { active = false }
}
