package dev.orcaxr.core

import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

/** Relational model rules shared with the browser packet decoder. Scalar shape
 * validation must run first so JSONObject getters cannot coerce invalid input. */
internal object GcodePacketChecks {
    data class IndexBounds(val entries: Int, val layers: Long, val records: Long, val points: Long, val sourceLength: Long)
    fun align(bytes: ByteBuffer, offset: Int): Int {
        val end = (offset + 3) and -4
        require(end <= bytes.capacity())
        for (i in offset until end) require(bytes.get(i).toInt() == 0)
        return end
    }

    private fun complete(value: JSONObject) {
        require(value.getBoolean("complete") == !value.has("terminationReason"))
    }

    private fun warnings(values: JSONArray, sourceLength: Long) {
        for (i in 0 until values.length()) {
            val warning = values.getJSONObject(i)
            require(warning.getLong("startOffset") <= warning.getLong("endOffset"))
            require(warning.getLong("endOffset") <= sourceLength)
        }
    }

    fun model(packet: GcodePacket, active: () -> Unit = {}) {
        active()
        val m = packet.checkedMetadata
        complete(m)
        val limits = m.getJSONObject("limits")
        val sourceLength = m.getLong("sourceLength")
        val lineOffset = m.optLong("sourceLineOffset", 0)
        val lastLine = lineOffset + m.getLong("parsedLines")
        val roles = m.getJSONArray("roles")
        val filaments = m.getJSONArray("filaments")
        require(m.optLong("recordOffset", 0) + packet.recordCount <= 0xffffffffL)
        require(packet.recordCount <= limits.getInt("records"))
        require(packet.pathPointCount <= limits.getInt("pathPoints"))
        require(m.getLong("parsedCharacters") <= sourceLength)
        require(m.getLong("parsedLines") <= limits.getLong("lines") && lastLine <= 16_000_000)
        require(roles.length() <= limits.getInt("roles") && filaments.length() <= limits.getInt("filaments"))
        warnings(m.getJSONArray("warnings"), sourceLength)
        for (i in 0 until filaments.length()) require(filaments.getJSONObject(i).getInt("id") == i)

        fun column(name: String) = packet.column("columns", name)
        val kind = column("kind")
        val layer = column("layer")
        val role = column("role")
        val tool = column("tool")
        val filament = column("filament")
        val line = column("sourceLine")
        val sourceStart = column("sourceStartOffset")
        val sourceEnd = column("sourceEndOffset")
        val coordinates = arrayOf("startX", "startY", "startZ", "endX", "endY", "endZ").map(::column)
        val pathKind = column("pathKind")
        val pathOffset = column("pathPointOffset")
        val pathCount = column("pathPointCount")
        val centerX = column("arcCenterX")
        val centerY = column("arcCenterY")
        val deltaE = column("deltaE")
        val layerCount = m.getLong("layerCount")
        var runningPoints = 0L
        for (i in 0 until packet.recordCount) {
            if (i and 4095 == 0) active()
            val k = kind.get(i).toInt() and 255
            require(k in 0..13 && k != 3 && unsigned(layer, i) <= layerCount)
            require((role.getShort(i * 2).toInt() and 65535) < roles.length())
            require((tool.getShort(i * 2).toInt() and 65535) < 256)
            require((filament.getShort(i * 2).toInt() and 65535) < filaments.length())
            require(unsigned(line, i) > lineOffset && unsigned(line, i) <= lastLine)
            require(unsigned(sourceStart, i) <= unsigned(sourceEnd, i) && unsigned(sourceEnd, i) <= sourceLength)
            for (coordinate in coordinates) require(coordinate.getFloat(i * 4).isFinite())
            val p = pathKind.get(i).toInt() and 255
            val count = unsigned(pathCount, i)
            require(p == 0 || p == 2 || p == 3)
            require(unsigned(pathOffset, i) == runningPoints && count <= packet.pathPointCount - runningPoints)
            val x = centerX.getFloat(i * 4)
            val y = centerY.getFloat(i * 4)
            require(x.isFinite() && y.isFinite())
            if (p == 0) require(count == 0L && x == 0f && y == 0f)
            else {
                val extrusion = deltaE.getFloat(i * 4)
                require((k == 8 || k == 10) && extrusion.isFinite())
                require(if (k == 8) extrusion == 0f else extrusion != 0f)
            }
            runningPoints += count
        }
        require(runningPoints == packet.pathPointCount.toLong())
        for (name in arrayOf("x", "y", "z")) {
            val values = packet.column("pathPoints", name)
            for (i in 0 until packet.pathPointCount) {
                if (i and 4095 == 0) active()
                require(values.getFloat(i * 4).isFinite())
            }
        }
        active()
    }

    fun index(value: JSONObject, sourceLength: Int, active: () -> Unit = {}): IndexBounds {
        GcodeMetadata.validate(GcodeMetadata.Kind.Index, value, active)
        require(value.getLong("sourceLength") == sourceLength.toLong())
        require(value.getLong("entryCount") <= sourceLength.toLong() + 1)
        complete(value)
        warnings(value.getJSONArray("warnings"), sourceLength.toLong())
        return IndexBounds(value.getInt("entryCount"), value.getLong("layerCount"),
            value.getLong("recordCount"), value.getLong("pathPointCount"), sourceLength.toLong())
    }

    fun page(values: JSONArray, index: IndexBounds, previous: JSONObject?) {
        GcodeMetadata.validate(GcodeMetadata.Kind.IndexPage, values)
        fun entryBounds(entry: JSONObject) {
            require(entry.getLong("startOffset") <= entry.getLong("endOffsetExclusive"))
            require(entry.getLong("endOffsetExclusive") <= index.sourceLength)
            require(entry.getLong("layer") <= index.layers && entry.getLong("recordsBefore") <= index.records)
            require(entry.getLong("pathPointsBefore") <= index.points)
        }
        if (previous != null) {
            GcodeMetadata.validate(GcodeMetadata.Kind.IndexEntry, previous)
            entryBounds(previous)
        }
        var before = previous
        for (i in 0 until values.length()) {
            val entry = values.getJSONObject(i)
            entryBounds(entry)
            val prior = before
            if (prior == null) {
                require(entry.getLong("startOffset") == 0L && entry.getLong("recordsBefore") == 0L && entry.getLong("pathPointsBefore") == 0L)
            } else {
                require(entry.getLong("layer") >= prior.getLong("layer"))
                require(entry.getLong("startOffset") == prior.getLong("endOffsetExclusive"))
                require(entry.getLong("recordsBefore") >= prior.getLong("recordsBefore"))
                require(entry.getLong("pathPointsBefore") >= prior.getLong("pathPointsBefore"))
            }
            before = entry
        }
    }

    fun unsigned(bytes: ByteBuffer, index: Int): Long = bytes.getInt(index * 4).toLong() and 0xffffffffL
}
