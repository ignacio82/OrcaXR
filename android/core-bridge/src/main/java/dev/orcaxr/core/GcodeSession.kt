package dev.orcaxr.core

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/** One source and one native index. Run work on a background executor. Close
 * may run concurrently and cancels active work without waiting for its mutex. */
class GcodeSession(sourceUnits: Int, options: String = "{}") : AutoCloseable {
    private val handle = AtomicLong(NativeGcode.open(GcodeLayout.VERSION, sourceUnits, options))
    private val gate = Any()
    private fun <T> work(operation: (Long) -> T): T = synchronized(gate) {
        val current = handle.get()
        check(current != 0L) { "closed" }
        val result = operation(current)
        check(handle.get() == current) { "cancelled" }
        result
    }
    fun append(offset: Int, units: CharArray) = work { NativeGcode.append(it, offset, units) }
    fun seal(): JSONObject = work { JSONObject(NativeGcode.seal(it)) }
    fun page(start: Int, count: Int): JSONArray = work { JSONArray(NativeGcode.page(it, start, count)) }
    fun window(first: Int, last: Int): GcodePacket {
        require(first >= 0 && last >= first)
        return packet(first, last)
    }
    fun whole(): GcodePacket = packet(-1, -1)
    private fun packet(first: Int, last: Int): GcodePacket = work { current ->
        try {
            val size = NativeGcode.prepare(current, first, last)
            check(size in 24..GcodeLayout.MAX_PACKET_BYTES) { "invalid_buffer" }
            val buffer = ByteBuffer.allocateDirect(size)
            NativeGcode.copy(current, buffer)
            GcodePacket(buffer)
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    override fun close() {
        val current = handle.getAndSet(0)
        if (current != 0L) NativeGcode.close(current)
    }
}
