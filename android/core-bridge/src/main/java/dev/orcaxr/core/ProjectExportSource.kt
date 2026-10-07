package dev.orcaxr.core

import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

data class ProjectExportLimits(val jsonBytes: Long, val assets: Long, val assetBytes: Long) {
    internal fun validate() { require(listOf(jsonBytes, assets, assetBytes).all { it in 0..ProjectHost.MAX_BUDGET }) { "invalid_options" } }
}

/** Borrowed on one export worker. Streams canonical JSON and assets in declaration
 * order through bounded owned chunks. The host owns its destination, archive
 * format, flushing, durable-write policy and handoff; return only after success.
 * A complete bundle must be consumed before a save can acknowledge its checkpoint.
 * Retained source calls refuse after the callback returns or the actor closes. */
class ProjectExportSource internal constructor(
    private val scope: ProjectPreparation,
    private val capture: ProjectExportCapture,
    private val project: ProjectSnapshot,
    private val limits: ProjectExportLimits,
) {
    private val workerId = Thread.currentThread().id
    private val active = AtomicBoolean(true)
    val assetCount: Long = capture.assetCount()
    private var nextAsset = 0L
    private var jsonWritten = false
    init {
        check(assetCount <= limits.assets) { "resource_limit" }
        var total = 0L
        for (index in 0 until assetCount) {
            scope.checkActive()
            capture.asset(index).use { asset ->
                val bytes = asset.length()
                check(bytes <= limits.assetBytes - total) { "resource_limit" }
                total += bytes
            }
        }
    }
    private fun checkActive() {
        check(active.get()) { "closed_export" }
        check(Thread.currentThread().id == workerId) { "wrong_export_thread" }
        scope.checkActive()
    }
    fun assetLength(index: Long): Long { checkActive(); return capture.asset(index).use { it.length() } }
    fun assetIdLength(index: Long): Long { checkActive(); return capture.asset(index).use { it.idLength() } }
    fun assetId(index: Long, start: Long, count: Long): CharArray { checkActive(); return capture.asset(index).use { it.id(start, count) } }
    fun writeJson(destination: OutputStream): Long {
        checkActive(); check(!jsonWritten) { "already_written" }
        val bytes = project.writeJson(limits.jsonBytes) { chunk -> checkActive(); destination.write(chunk) }
        checkActive(); jsonWritten = true
        return bytes
    }
    fun writeAsset(index: Long, destination: OutputStream): Long {
        checkActive(); check(index == nextAsset) { "invalid_export_order" }
        return capture.asset(index).use { asset ->
            val length = asset.length()
            var offset = 0L
            while (offset < length) {
                checkActive()
                val bytes = asset.read(offset, minOf(ProjectHost.MAX_CHUNK_BYTES.toLong(), length - offset))
                destination.write(bytes); offset += bytes.size
            }
            checkActive(); nextAsset++
            length
        }
    }
    internal fun requireComplete() { checkActive(); check(jsonWritten && nextAsset == assetCount) { "incomplete_export" } }
    internal fun invalidate() { active.set(false) }
}
