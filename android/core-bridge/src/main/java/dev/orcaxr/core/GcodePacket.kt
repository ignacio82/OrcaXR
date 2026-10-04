package dev.orcaxr.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import org.json.JSONArray
import org.json.JSONObject

/** Java owns the transfer buffer. Read-only views remain valid after native
 * close and can be retained until the renderer has completed its upload. */
class GcodePacket internal constructor(source: ByteBuffer) {
    private val bytes = source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
    val recordCount: Int
    val pathPointCount: Int
    val metadata: JSONObject
    private val columns = mutableMapOf<Pair<String, String>, ByteBuffer>()
    init {
        require(bytes.capacity() in 24..GcodeLayout.MAX_PACKET_BYTES)
        require(bytes.getInt(0) == 0x5047584f && bytes.getInt(4) == GcodeLayout.VERSION)
        val metadataBytes = bytes.getInt(8)
        recordCount = bytes.getInt(12)
        pathPointCount = bytes.getInt(16)
        require(metadataBytes in 2..GcodeLayout.MAX_METADATA_BYTES && metadataBytes <= bytes.capacity() - 24)
        require(recordCount in 0..GcodeLayout.MAX_WINDOW_RECORDS && pathPointCount in 0..GcodeLayout.MAX_PATH_POINTS)
        require(bytes.getInt(20) == bytes.capacity())
        val text = bytes.duplicate().apply { position(24); limit(24 + metadataBytes) }
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        metadata = JSONObject(decoder.decode(text).toString())
        var offset = (24 + metadataBytes + 3) and -4
        for (field in GcodeLayout.fields) {
            val count = if (field.group == "columns") recordCount else pathPointCount
            val end = offset.toLong() + count.toLong() * field.bytes
            require(end <= bytes.capacity())
            columns[field.group to field.name] = bytes.duplicate().apply {
                position(offset); limit(end.toInt())
            }.slice().asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
            offset = (end.toInt() + 3) and -4
        }
        require(offset == bytes.capacity())
    }
    fun column(group: String, name: String): ByteBuffer = requireNotNull(columns[group to name])
        .duplicate().order(ByteOrder.LITTLE_ENDIAN)
    companion object {
        fun text(units: JSONArray): String = CharArray(units.length()) { index ->
            val value = units.getDouble(index)
            require(value.isFinite() && value % 1.0 == 0.0 && value in 0.0..65535.0)
            value.toInt().toChar()
        }.concatToString()
    }
}
