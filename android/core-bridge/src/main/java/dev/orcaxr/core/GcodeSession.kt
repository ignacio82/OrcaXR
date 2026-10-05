package dev.orcaxr.core

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** One source and one native index. Run work on a background executor. Close
 * may run concurrently and cancels active work without waiting for its mutex. */
class GcodeSession(private val sourceUnits: Int, options: String = "{}") : AutoCloseable {
    private val handle = AtomicLong(NativeGcode.open(GcodeLayout.VERSION, sourceUnits, options))
    private val gate = Any()
    private val index = AtomicReference<GcodePacketChecks.IndexBounds?>()
    private fun active(current: Long) { check(handle.get() == current) { "cancelled" } }
    private fun <T> work(operation: (Long) -> T): T = synchronized(gate) {
        val current = handle.get()
        check(current != 0L) { "closed" }
        val result = operation(current)
        check(handle.get() == current) { "cancelled" }
        result
    }
    fun append(offset: Int, units: CharArray) = work { NativeGcode.append(it, offset, units) }
    fun seal(): JSONObject = work { current ->
        val encoded = NativeGcode.seal(current)
        try {
            GcodeJson.objectValue(encoded) { active(current) }.also { value ->
                val bounds = GcodePacketChecks.index(value, sourceUnits) { active(current) }
                index.set(bounds)
                if (handle.get() != current) {
                    index.compareAndSet(bounds, null)
                    error("cancelled")
                }
            }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    fun page(start: Int, count: Int): JSONArray = work { current ->
        val encoded = NativeGcode.page(current, start, count)
        try {
            val bounds = checkNotNull(index.get()) { "invalid_state" }
            val value = GcodeJson.arrayValue(encoded) { active(current) }
            require(value.length() == minOf(count, bounds.entries - start))
            val previous = if (start > 0 && value.length() > 0) {
                val preceding = GcodeJson.arrayValue(NativeGcode.page(current, start - 1, 1)) { active(current) }
                GcodeMetadata.validate(GcodeMetadata.Kind.IndexPage, preceding)
                require(preceding.length() == 1)
                preceding.getJSONObject(0)
            } else null
            GcodePacketChecks.page(value, bounds, previous)
            value
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    fun window(first: Int, last: Int): GcodePacket {
        require(first >= 0 && last >= first)
        return packet(first, last)
    }
    fun whole(): GcodePacket = packet(-1, -1)
    /** Versioned development leaf request; see native-core.md. Computation is
     * serialized with parser work; close can cancel without acquiring gate. */
    fun view(request: String): GcodeViewPacket = work { current ->
        require(request.length <= GcodeViewLayout.MAX_REQUEST_BYTES) { "resource_limit" }
        val size = NativeGcode.prepareView(current, request)
        try {
            check(size in 32..GcodeViewLayout.MAX_PACKET_BYTES) { "invalid_buffer" }
            val buffer = ByteBuffer.allocateDirect(size)
            NativeGcode.copy(current, buffer)
            GcodeViewPacket(buffer) { active(current) }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    private fun packet(first: Int, last: Int): GcodePacket = work { current ->
        try {
            val size = NativeGcode.prepare(current, first, last)
            check(size in 24..GcodeLayout.MAX_PACKET_BYTES) { "invalid_buffer" }
            val buffer = ByteBuffer.allocateDirect(size)
            NativeGcode.copy(current, buffer)
            GcodePacket(buffer) { active(current) }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    override fun close() {
        val current = handle.getAndSet(0)
        index.set(null)
        if (current != 0L) NativeGcode.close(current)
    }
}
