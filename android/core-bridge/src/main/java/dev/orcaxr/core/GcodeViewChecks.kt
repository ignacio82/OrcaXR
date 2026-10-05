package dev.orcaxr.core

import java.nio.ByteBuffer
import org.json.JSONObject
import kotlin.math.max

/** Bind view references to an already validated, immutable model. These checks
 * preserve local preview indices and original inspection/playback record IDs. */
internal object GcodeViewChecks {
    private val kindNames = arrayOf("noop", "retract", "unretract", "reserved-seam", "tool-change",
        "color-change", "pause", "custom", "travel", "wipe", "extrude", "layer-change", "wipe-start", "wipe-end")
    private fun inspectable(kind: Int) = kind == 1 || kind == 2 || kind in 4..10
    private fun poll(active: () -> Unit, index: Int) { if (index and 4095 == 0) active() }

    private class Columns(val values: Map<String, ByteBuffer>) {
        fun u32(name: String, index: Int) = GcodePacketChecks.unsigned(values.getValue(name), index)
        fun u16(name: String, index: Int) = values.getValue(name).getShort(index * 2).toInt() and 65535
        fun u8(name: String, index: Int) = values.getValue(name).get(index).toInt() and 255
        fun f32(name: String, index: Int) = values.getValue(name).getFloat(index * 4).toDouble()
    }
    private class Model(val packet: GcodePacket) {
        val metadata = packet.checkedMetadata
        val count = packet.recordCount
        val first = metadata.optLong("recordOffset", 0)
        val last = first + count - 1
        val layerCount = metadata.getLong("layerCount")
        val sourceLength = metadata.getLong("sourceLength")
        val columns = Columns(GcodeLayout.fields.filter { it.group == "columns" }
            .associate { it.name to packet.column(it.group, it.name) })
        fun local(record: Long): Int {
            val local = record - first
            require(local >= 0 && local < count)
            return local.toInt()
        }
    }
    private fun increasing(values: ByteBuffer, count: Int, maximum: Long, minimum: Long = 0, active: () -> Unit) {
        var previous = minimum - 1
        for (i in 0 until count) {
            poll(active, i)
            val value = GcodePacketChecks.unsigned(values, i)
            require(value > previous && value <= maximum)
            previous = value
        }
    }

    fun validate(view: GcodeViewPacket, packet: GcodePacket, active: () -> Unit = {}) {
        active()
        val model = Model(packet)
        val columns = Columns(requireNotNull(GcodeViewLayout.fields[view.kind]).associate { it.name to view.column(it.name) })
        if (view.kind != 3) {
            require(view.checkedMetadata.getInt("sourceRecordCount") == model.count)
            require(view.checkedMetadata.getJSONArray("limitations").length() == if (model.metadata.getBoolean("complete")) 0 else 1)
        }
        when (view.kind) {
            1 -> preview(view, model, columns, active)
            2 -> inspection(view, model, columns, active)
            3 -> {
                require(view.recordCount <= 100_000)
                for (i in 0 until view.recordCount) {
                    poll(active, i)
                    require(inspectable(model.columns.u8("kind", model.local(columns.u32("recordIndices", i)))))
                }
            }
        }
        active()
    }

    private fun preview(view: GcodeViewPacket, model: Model, c: Columns, active: () -> Unit) {
        val p = view.checkedMetadata
        val mode = p.getJSONObject("mode")
        val definition = GcodePreviewModes.get(mode.getString("id"))
        require(mode.getString("label") == definition.label && mode.getString("valueKind") == definition.valueKind)
        require(mode.getString("scale") == definition.scale)
        require((if (mode.isNull("unit")) null else mode.getString("unit")) == definition.unit)
        if (p.getString("status") == "unsupported") {
            require(view.recordCount == 0)
            val missing = p.getJSONArray("missingMetadata")
            val keys = HashSet<String>()
            for (i in 0 until missing.length()) {
                poll(active, i)
                val item = missing.getJSONObject(i)
                val key = item.getString("key")
                require(keys.add(key))
                val maximum = when (key) {
                    "filament-colors" -> model.metadata.getJSONArray("filaments").length() - 1L
                    "role-color" -> 19L
                    else -> model.layerCount
                }
                val indices = item.getJSONArray("indices")
                var previous = -1L
                for (j in 0 until indices.length()) {
                    poll(active, j)
                    val value = indices.getLong(j)
                    require(value > previous && value <= maximum)
                    previous = value
                }
            }
            return
        }
        require(view.recordCount <= model.count)
        increasing(c.values.getValue("recordIndices"), view.recordCount, model.count - 1L, active = active)
        for (i in 0 until view.recordCount) {
            poll(active, i)
            val valid = c.u8("valueValid", i)
            val value = c.f32("values", i)
            require(valid <= 1 && value.isFinite() && (valid != 0 || value == 0.0))
            for (component in 0..3) require(c.f32("colorsRgba", i * 4 + component) in 0.0..1.0)
        }
        p.optJSONObject("range")?.let { range ->
            require(range.getDouble("min") <= range.getDouble("max"))
            require(range.getInt("sampleCount") <= view.recordCount)
            require(range.getString("scale") == definition.scale && range.getString("unit") == definition.unit)
        }
        val legend = p.getJSONArray("legend")
        val ids = HashSet<String>()
        for (i in 0 until legend.length()) {
            poll(active, i)
            require(ids.add(legend.getJSONObject(i).getString("id")))
        }
    }

    private fun inspection(view: GcodeViewPacket, model: Model, c: Columns, active: () -> Unit) {
        val p = view.checkedMetadata
        val records = view.recordCount
        val layers = view.layerCount
        val ticks = view.tickCount
        val m = model.columns
        val labels = p.getJSONArray("tickLabels")
        require(records <= model.count && layers <= model.count && ticks <= records && labels.length() <= ticks)
        increasing(c.values.getValue("recordIndices"), records, model.last, model.first, active)
        increasing(c.values.getValue("layerIds"), layers, model.layerCount, active = active)
        increasing(c.values.getValue("tickRecord"), ticks, model.last, model.first, active)
        for (i in 0 until records) {
            poll(active, i)
            require(inspectable(m.u8("kind", model.local(c.u32("recordIndices", i)))))
        }
        for (i in 0 until layers) {
            poll(active, i)
            val first = model.local(c.u32("layerFirstRecord", i))
            val last = model.local(c.u32("layerLastRecord", i))
            val layer = c.u32("layerIds", i)
            require(first <= last && m.u32("layer", first) == layer && m.u32("layer", last) == layer)
            require(c.f32("layerZMm", i).isFinite())
            require(inspectable(m.u8("kind", first)) && inspectable(m.u8("kind", last)))
        }
        val selection = p.optJSONObject("moveSelection")
        val current = p.optJSONObject("current")
        require((current != null) == (selection != null))
        if (selection != null) {
            val first = selection.getInt("firstOrdinal")
            val last = selection.getInt("lastOrdinal")
            require(first <= last && last < records && selection.getInt("count") == last - first + 1)
            require(c.u32("recordIndices", first) == selection.getLong("firstRecord"))
            require(c.u32("recordIndices", last) == selection.getLong("lastRecord"))
        } else require(records == 0)
        if (current != null) {
            requireNotNull(selection)
            val record = current.getLong("record")
            val local = model.local(record)
            val ordinal = current.getInt("ordinal")
            require(ordinal in selection.getInt("firstOrdinal")..selection.getInt("lastOrdinal"))
            require(c.u32("recordIndices", ordinal) == record)
            val kind = m.u8("kind", local)
            require(current.getInt("kind") == kind && current.getString("kindLabel") == kindNames[kind])
            require(current.getLong("layer") == m.u32("layer", local))
            require(current.getInt("tool") == m.u16("tool", local) && current.getInt("filament") == m.u16("filament", local))
            require(current.getLong("sourceLine") == m.u32("sourceLine", local))
            require(current.getLong("sourceStartOffset") == m.u32("sourceStartOffset", local))
            require(current.getLong("sourceEndOffset") == m.u32("sourceEndOffset", local))
            val position = current.getJSONArray("positionMm")
            require(position.getDouble(0) == m.f32("endX", local) && position.getDouble(1) == m.f32("endY", local)
                && position.getDouble(2) == m.f32("endZ", local))
        }
        val layerSelection = p.optJSONObject("layerSelection")
        if (layerSelection != null) {
            val firstLayer = layerSelection.getLong("firstLayer")
            val lastLayer = layerSelection.getLong("lastLayer")
            var first = -1
            var last = -1
            for (i in 0 until layers) {
                poll(active, i)
                if (c.u32("layerIds", i) == firstLayer) first = i
                if (c.u32("layerIds", i) == lastLayer) last = i
            }
            require(first >= 0 && last >= first)
            require(c.f32("layerZMm", first) == layerSelection.getDouble("firstZMm"))
            require(c.f32("layerZMm", last) == layerSelection.getDouble("lastZMm"))
            require(!layerSelection.getBoolean("singleLayer") || first == last)
            for (i in 0 until records) {
                poll(active, i)
                require(m.u32("layer", model.local(c.u32("recordIndices", i))) in firstLayer..lastLayer)
            }
        } else require(records == 0 && ticks == 0)
        p.optJSONObject("toolMarker")?.let { marker ->
            requireNotNull(current)
            require(marker.getBoolean("visible") && marker.getLong("record") == current.getLong("record"))
            require(marker.getInt("tool") == current.getInt("tool"))
            for (axis in 0..2) require(marker.getJSONArray("positionMm").getDouble(axis) == current.getJSONArray("positionMm").getDouble(axis))
        }
        p.optJSONObject("focusBounds")?.let { bounds ->
            for (axis in 0..2) {
                val min = bounds.getJSONArray("minMm").getDouble(axis)
                val max = bounds.getJSONArray("maxMm").getDouble(axis)
                require(min <= max && min.toFloat().isFinite() && max.toFloat().isFinite())
            }
        }
        var selected = 0
        for (t in 0 until ticks) {
            poll(active, t)
            val kind = c.u8("tickKind", t)
            require(kind in 4..7)
            val record = c.u32("tickRecord", t)
            val local = model.local(record)
            while (selected < records && c.u32("recordIndices", selected) < record) {
                poll(active, selected)
                selected++
            }
            require(selected < records && c.u32("recordIndices", selected) == record)
            require(c.u32("tickLabel", t) < labels.length())
            require(kind == m.u8("kind", local) && c.u32("tickLayer", t) == m.u32("layer", local))
            require(c.f32("tickZMm", t) == max(m.f32("startZ", local), m.f32("endZ", local)))
            require(c.u32("tickSourceLine", t) == m.u32("sourceLine", local))
            require(c.u32("tickStartOffset", t) == m.u32("sourceStartOffset", local))
            require(c.u32("tickEndOffset", t) == m.u32("sourceEndOffset", local))
        }
        p.optJSONObject("sourceWindow")?.let { source ->
            requireNotNull(current)
            val line = source.getInt("currentLine")
            val first = source.getInt("firstLine")
            val last = source.getInt("lastLine")
            val lines = source.getJSONArray("lines")
            require(line.toLong() == current.getLong("sourceLine") && first <= line && last >= line)
            require(line - first <= 50 && last - line <= 50 && lines.length() == last - first + 1)
            var before = -1L
            var marked = 0
            for (i in 0 until lines.length()) {
                poll(active, i)
                val item = lines.getJSONObject(i)
                val start = item.getLong("startOffset")
                val end = item.getLong("endOffset")
                val text = item.getJSONArray("text")
                require(item.getInt("number") == first + i && start > before && start <= end && end <= model.sourceLength)
                val span = end - start
                if (item.getBoolean("truncated")) require(span > 4096 && text.length() == 4096 && text.getInt(4095) == 0x2026)
                else require(span - text.length() in 0L..1L)
                require(item.getBoolean("current") == (item.getInt("number") == line))
                if (item.getBoolean("current")) marked++
                before = end
            }
            require(marked == 1)
        }
    }
}
