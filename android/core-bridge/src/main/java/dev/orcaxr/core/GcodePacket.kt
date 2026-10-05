package dev.orcaxr.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import org.json.JSONArray
import org.json.JSONObject

/** Java owns the transfer buffer. Read-only views remain valid after native
 * close and can be retained until the renderer has completed its upload. */
class GcodePacket internal constructor(source: ByteBuffer, active: () -> Unit = {}) {
    private val bytes = source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
    val recordCount: Int
    val pathPointCount: Int
    internal val checkedMetadata: JSONObject
    /** A caller may annotate its snapshot without changing the validated packet. */
    val metadata: JSONObject get() = JSONObject(checkedMetadata.toString())
    private val columns = mutableMapOf<Pair<String, String>, ByteBuffer>()
    init {
        require(source.position() == 0 && source.limit() == source.capacity())
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
        active()
        checkedMetadata = GcodeJson.objectValue(decoder.decode(text).toString(), active)
        GcodeMetadata.validate(GcodeMetadata.Kind.Model, checkedMetadata, active)
        var offset = GcodePacketChecks.align(bytes, 24 + metadataBytes)
        for (field in GcodeLayout.fields) {
            val count = if (field.group == "columns") recordCount else pathPointCount
            val end = offset.toLong() + count.toLong() * field.bytes
            require(end <= bytes.capacity())
            columns[field.group to field.name] = bytes.duplicate().apply {
                position(offset); limit(end.toInt())
            }.slice().asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
            offset = GcodePacketChecks.align(bytes, end.toInt())
        }
        require(offset == bytes.capacity())
        GcodePacketChecks.model(this, active)
    }
    fun column(group: String, name: String): ByteBuffer = requireNotNull(columns[group to name])
        .duplicate().order(ByteOrder.LITTLE_ENDIAN)
    companion object {
        fun text(units: JSONArray): String {
            GcodeMetadata.validate(GcodeMetadata.Kind.Text, units)
            return CharArray(units.length()) { units.getInt(it).toChar() }.concatToString()
        }
    }
}
