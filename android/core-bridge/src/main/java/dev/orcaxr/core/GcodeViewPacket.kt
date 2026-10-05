package dev.orcaxr.core

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/** Owns Java storage, with read-only columns that survive session disposal.
 * Metadata is bounded JSON; source-derived text contains UTF-16 code units. */
class GcodeViewPacket internal constructor(source: ByteBuffer, model: GcodePacket, expectedKind: Int,
                                           active: () -> Unit = {}) {
    private val modelIdentity = model.identity
    private val bytes = source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
    val kind: Int
    val recordCount: Int
    val layerCount: Int
    val tickCount: Int
    internal val checkedMetadata: JSONObject
    val metadata: JSONObject get() = JSONObject(checkedMetadata.toString())
    private val columns = mutableMapOf<String, ByteBuffer>()
    init {
        require(source.position() == 0 && source.limit() == source.capacity())
        require(bytes.capacity() in 32..GcodeViewLayout.MAX_PACKET_BYTES)
        require(bytes.getInt(0) == 0x5647584f && bytes.getInt(4) == GcodeViewLayout.VERSION)
        kind = bytes.getInt(8)
        require(kind == expectedKind)
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
        var offset = GcodePacketChecks.align(bytes, 32 + metadataBytes)
        for (field in fields) {
            val end = offset.toLong() + counts[field.counter].toLong() * field.factor * field.bytes
            require(end <= bytes.capacity())
            columns[field.name] = bytes.duplicate().apply {
                position(offset); limit(end.toInt())
            }.slice().asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
            offset = GcodePacketChecks.align(bytes, end.toInt())
        }
        require(offset == bytes.capacity())
        val text = bytes.duplicate().apply { position(32); limit(32 + metadataBytes) }
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        active()
        checkedMetadata = GcodeJson.objectValue(decoder.decode(text).toString(), active)
        val shape = when (kind) {
            1 -> if (checkedMetadata.opt("status") == "unsupported") GcodeMetadata.Kind.PreviewUnsupported else GcodeMetadata.Kind.PreviewReady
            2 -> GcodeMetadata.Kind.Inspection
            else -> GcodeMetadata.Kind.Playback
        }
        GcodeMetadata.validate(shape, checkedMetadata, active)
        GcodeViewChecks.validate(this, model, active)
        active()
    }
    /** An opaque identity retains no model columns or native session. */
    fun belongsTo(model: GcodePacket): Boolean = modelIdentity === model.identity
    fun column(name: String): ByteBuffer = requireNotNull(columns[name]).duplicate().order(ByteOrder.LITTLE_ENDIAN)
}
