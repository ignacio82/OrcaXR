package dev.orcaxr.core

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** One source and one native index. Run work on a background executor. Close
 * may run concurrently and cancels active work without waiting for its mutex. */
class GcodeSession(private val sourceUnits: Int, options: String = "{}") : AutoCloseable {
    private val handle = AtomicLong(open(sourceUnits, options))
    constructor(sourceUnits: Int, options: GcodeRequests.Options) : this(sourceUnits, options.encode())
    private val gate = Any()
    private val index = AtomicReference<GcodePacketChecks.IndexBounds?>()
    private val lineCount = AtomicInteger(0)
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
    /** Readable lines `[from, from + count)` from the sealed source, clamped like
     * the browser viewer. A native refusal such as `resource_limit` leaves the
     * session open; a response no correct core can produce closes it. */
    fun textWindow(from: Double, count: Double): GcodeTextWindow = work { current ->
        val encoded = NativeGcode.textWindow(current, from, count)
        try {
            val value = GcodeJson.objectValue(encoded) { active(current) }
            GcodeMetadata.validate(GcodeMetadata.Kind.TextWindow, value) { active(current) }
            GcodeText.window(value, from, count, sourceUnits, lineCount.get()) { active(current) }
                .also { lineCount.compareAndSet(0, it.lineCount) }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }
    /** Lines containing [query] case-insensitively (ECMAScript trim and
     * toLowerCase), in order, at most [limit]. */
    fun search(query: String, limit: Int = GcodeLayout.MAX_SEARCH_RESULTS): GcodeTextSearch = work { current ->
        require(query.length <= GcodeLayout.MAX_QUERY_UNITS && limit in 0..GcodeLayout.MAX_SEARCH_LIMIT) {
            "resource_limit"
        }
        val encoded = NativeGcode.textSearch(current, query.toCharArray(), limit)
        try {
            val value = GcodeJson.objectValue(encoded) { active(current) }
            GcodeMetadata.validate(GcodeMetadata.Kind.TextSearch, value) { active(current) }
            GcodeText.search(value, limit, sourceUnits, lineCount.get())
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
    fun view(model: GcodePacket, request: GcodeRequests.ViewRequest): GcodeViewPacket = view(model, request.encode())
    /** Bind output to an already captured model from this immutable source and
     * the request's exact window. The host never loads an implicit extra model. */
    fun view(model: GcodePacket, request: String): GcodeViewPacket = work { current ->
        require(request.length <= GcodeRequests.MAX_VIEW_BYTES) { "resource_limit" }
        val captured = model.sourceWindow
        check(captured != null && captured.owner == current) { "foreign_model" }
        // Shared generated shapes precede model binding. Native computation
        // remains the authority for semantic/model-dependent request limits.
        val envelope: JSONObject
        val expectedKind: Int
        try {
            envelope = GcodeJson.objectValue(request) { active(current) }
            expectedKind = GcodeRequests.validateView(envelope) { active(current) }
        } catch (_: IllegalArgumentException) { error("invalid_request") }
        val window = envelope.getJSONArray("window")
        val first = if (window.length() == 0) -1L else window.getLong(0)
        val last = if (window.length() == 0) -1L else window.getLong(1)
        check(first == captured.first.toLong() && last == captured.last.toLong()) { "model_window_mismatch" }
        val size = NativeGcode.prepareView(current, request)
        try {
            check(size in 32..GcodeViewLayout.MAX_PACKET_BYTES) { "invalid_buffer" }
            val buffer = ByteBuffer.allocateDirect(size)
            NativeGcode.copy(current, buffer)
            GcodeViewPacket(buffer, model, expectedKind) { active(current) }
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
            GcodePacket(buffer, GcodeSourceWindow(current, first, last)) { active(current) }
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
    companion object {
        /** The largest file [decodeUtf8] reads, the parser's whole input budget. */
        const val MAX_DECODE_BYTES = 256 * 1024 * 1024
        /** G-code file bytes as the UTF-16 a session reads, decoded exactly as
         * the browser decodes a G-code file (`TextDecoder('utf-8')`): each
         * malformed sequence becomes U+FFFD and one leading byte-order mark
         * is dropped. */
        fun decodeUtf8(bytes: ByteArray): CharArray {
            check(bytes.size <= MAX_DECODE_BYTES) { "source_length" }
            return NativeGcode.decodeUtf8(bytes)
        }
        private fun open(units: Int, options: String): Long {
            check(options.length <= GcodeRequests.MAX_OPTIONS_BYTES) { "resource_limit" }
            try { GcodeRequests.validateOptions(GcodeJson.objectValue(options)) }
            catch (_: IllegalArgumentException) { error("invalid_options") }
            return NativeGcode.open(GcodeLayout.VERSION, units, options)
        }
    }
}
