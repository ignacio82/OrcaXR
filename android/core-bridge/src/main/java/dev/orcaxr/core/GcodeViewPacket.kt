package dev.orcaxr.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/** Owns Java storage, with read-only columns that survive session disposal.
 * Metadata is bounded JSON; source-derived text contains UTF-16 code units. */
class GcodeViewPacket internal constructor(source: ByteBuffer) {
    private val bytes = source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
    val kind: Int
    val recordCount: Int
    val layerCount: Int
    val tickCount: Int
    val metadata: JSONObject
    private val columns = mutableMapOf<String, ByteBuffer>()
    init {
        require(bytes.capacity() in 32..GcodeViewLayout.MAX_PACKET_BYTES)
        require(bytes.getInt(0) == 0x5647584f && bytes.getInt(4) == GcodeViewLayout.VERSION)
        kind = bytes.getInt(8)
        val fields = requireNotNull(GcodeViewLayout.fields[kind])
        val metadataBytes = bytes.getInt(12)
        recordCount = bytes.getInt(16)
        layerCount = bytes.getInt(20)
        tickCount = bytes.getInt(24)
        val counts = intArrayOf(recordCount, layerCount, tickCount)
        require(recordCount in 0..GcodeViewLayout.MAX_RECORDS && layerCount in 0..GcodeViewLayout.MAX_LAYERS && tickCount in 0..GcodeViewLayout.MAX_TICKS)
        require(kind == 2 || (layerCount == 0 && tickCount == 0))
        require(metadataBytes in 2..GcodeViewLayout.MAX_METADATA_BYTES && metadataBytes <= bytes.capacity() - 32)
        require(bytes.getInt(28) == bytes.capacity())
        var offset = (32 + metadataBytes + 3) and -4
        for (field in fields) {
            val end = offset.toLong() + counts[field.counter].toLong() * field.factor * field.bytes
            require(end <= bytes.capacity())
            columns[field.name] = bytes.duplicate().apply {
                position(offset); limit(end.toInt())
            }.slice().asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
            offset = (end.toInt() + 3) and -4
        }
        require(offset == bytes.capacity())
        val text = bytes.duplicate().apply { position(32); limit(32 + metadataBytes) }
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        metadata = JSONObject(decoder.decode(text).toString())
        if (kind == 2) {
            val labels = metadata.getJSONArray("tickLabels")
            require(labels.length() <= tickCount)
            for (i in 0 until labels.length()) require(labels.get(i) is String)
            val indices = column("tickLabel").asIntBuffer()
            val kinds = column("tickKind")
            repeat(tickCount) {
                require(indices[it] in 0 until labels.length())
                require((kinds[it].toInt() and 255) in GcodeViewLayout.tickKinds)
            }
        }
    }
    fun column(name: String): ByteBuffer = requireNotNull(columns[name]).duplicate().order(ByteOrder.LITTLE_ENDIAN)
}
