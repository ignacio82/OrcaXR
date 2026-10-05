package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GcodeViewBindingTest {
    private val source = "M83\n;LAYER_CHANGE\nG1 Z0.2 F600\nG1 X1 E1\n; PAUSE_PRINTING\n;LAYER_CHANGE\nG1 Z0.4\nG1 X2 E1\nT1\nG1 X3 E1\n"
    private val inspection = """{"version":1,"window":[],"operation":"inspection","includeSource":true,"request":{"showToolMarker":true,"sourceContextLines":3}}"""
    private val preview = """{"version":1,"window":[],"operation":"preview","request":{"mode":"Feedrate"}}"""
    private val playback = """{"version":1,"window":[],"operation":"playback","request":{},"playback":{"direction":1,"wrap":true,"includeCurrent":true,"maxFrames":12}}"""

    private fun session() = GcodeSession(source.length).also {
        it.append(0, source.toCharArray()); it.seal()
    }
    private fun raw(request: String): ByteBuffer {
        val handle = NativeGcode.open(1, source.length, "{}")
        try {
            NativeGcode.append(handle, 0, source.toCharArray()); NativeGcode.seal(handle)
            return ByteBuffer.allocateDirect(NativeGcode.prepareView(handle, request))
                .order(ByteOrder.LITTLE_ENDIAN).also { NativeGcode.copy(handle, it) }
        } finally { NativeGcode.close(handle) }
    }
    private fun metadata(bytes: ByteBuffer, change: (JSONObject) -> Unit): ByteBuffer {
        val oldSize = bytes.getInt(12)
        val text = ByteArray(oldSize)
        bytes.duplicate().apply { position(32); get(text) }
        val value = JSONObject(text.toString(Charsets.UTF_8)).also(change).toString().toByteArray(Charsets.UTF_8)
        val oldStart = (32 + oldSize + 3) and -4
        val newStart = (32 + value.size + 3) and -4
        return ByteBuffer.allocateDirect(bytes.capacity() - oldStart + newStart).order(ByteOrder.LITTLE_ENDIAN).apply {
            put(bytes.duplicate().apply { limit(32) }); put(value)
            while (position() < newStart) put(0)
            put(bytes.duplicate().apply { position(oldStart) })
            putInt(12, value.size); putInt(28, capacity()); position(0)
        }
    }
    private fun column(bytes: ByteBuffer, name: String, change: (ByteBuffer) -> Unit): ByteBuffer {
        val copy = ByteBuffer.allocateDirect(bytes.capacity()).order(ByteOrder.LITTLE_ENDIAN)
        copy.put(bytes.duplicate()); copy.position(0)
        val counts = intArrayOf(copy.getInt(16), copy.getInt(20), copy.getInt(24))
        var offset = (32 + copy.getInt(12) + 3) and -4
        for (field in requireNotNull(GcodeViewLayout.fields[copy.getInt(8)])) {
            val end = offset + counts[field.counter] * field.factor * field.bytes
            if (field.name == name) {
                assertTrue("Fixture column is empty: $name", end > offset)
                change(copy.duplicate().apply { position(offset); limit(end) }.slice().order(ByteOrder.LITTLE_ENDIAN))
                return copy
            }
            offset = (end + 3) and -4
        }
        error("Unknown fixture column")
    }

    @Test fun sourceAndWindowBindingRejectsStaleOrForeignCapturesWithoutPoisoningSession() {
        session().use { owner -> session().use { other ->
            val model = owner.whole()
            val foreign = other.whole()
            val view = owner.view(model, inspection)
            assertTrue(view.belongsTo(model))
            assertFalse(view.belongsTo(owner.whole()))
            assertFalse(view.belongsTo(foreign))
            assertEquals("foreign_model", assertThrows(IllegalStateException::class.java) {
                owner.view(foreign, inspection)
            }.message)
            // The preamble and first printable entry can both start at record
            // zero. Use the final entry to exercise an actual nonzero offset.
            val entry = owner.page(0, 16).length() - 1
            val window = owner.window(entry, entry)
            assertTrue(window.metadata.getLong("recordOffset") > 0)
            assertEquals("model_window_mismatch", assertThrows(IllegalStateException::class.java) {
                owner.view(window, inspection)
            }.message)
            for (selector in listOf("[1]", "[1,0]", "[\"1\",1]", "[1.5,2]", "[0,4294967296]", "null")) {
                assertEquals("invalid_request", assertThrows(IllegalStateException::class.java) {
                    owner.view(model, inspection.replace("\"window\":[]", "\"window\":$selector"))
                }.message)
            }
            for (request in listOf(inspection, preview, playback)) {
                val query = request.replace("\"window\":[]", "\"window\":[$entry,$entry]")
                assertTrue(owner.view(window, query).belongsTo(window))
            }
            val recovered = owner.view(model, inspection)
            assertEquals(view.metadata.toString(), recovered.metadata.toString())
            owner.close()
            assertTrue(view.belongsTo(model))
            assertTrue(view.column("recordIndices").isReadOnly)
            assertEquals(recovered.metadata.toString(), view.metadata.toString())
            assertThrows(IllegalStateException::class.java) { owner.view(model, inspection) }
        } }
    }

    @Test fun actualInspectionRejectsCrossRecordAndSourceRelations() {
        session().use { owner ->
            val model = owner.whole()
            val bytes = raw(inspection)
            val valid = GcodeViewPacket(bytes, model, 2)
            assertTrue(valid.tickCount > 0 && valid.layerCount > 1)
            val mutations = listOf<(JSONObject) -> Unit>(
                { it.put("sourceRecordCount", model.recordCount - 1) },
                { it.getJSONObject("current").put("record", 0) },
                { it.getJSONObject("current").put("ordinal", valid.recordCount) },
                { it.getJSONObject("current").put("kindLabel", "wrong") },
                { it.getJSONObject("current").apply { put("sourceLine", getLong("sourceLine") + 1) } },
                { it.getJSONObject("current").getJSONArray("positionMm").apply { put(0, getDouble(0) + 1) } },
                { it.getJSONObject("moveSelection").apply { put("count", getInt("count") + 1) } },
                { it.getJSONObject("moveSelection").apply { put("firstRecord", getLong("firstRecord") + 1) } },
                { it.getJSONObject("layerSelection").apply { put("firstZMm", getDouble("firstZMm") + 1) } },
                { it.getJSONObject("toolMarker").getJSONArray("positionMm").apply { put(0, getDouble(0) + 1) } },
                { it.getJSONObject("sourceWindow").apply { put("currentLine", getInt("currentLine") + 1) } },
                { it.getJSONObject("sourceWindow").getJSONArray("lines").getJSONObject(0).apply { put("current", !getBoolean("current")) } },
                { it.getJSONObject("focusBounds").apply { getJSONArray("minMm").put(0, getJSONArray("maxMm").getDouble(0) + 1) } }
            )
            mutations.forEachIndexed { index, mutation ->
                assertThrows("Inspection metadata $index", IllegalArgumentException::class.java) {
                    GcodeViewPacket(metadata(bytes, mutation), model, 2)
                }
            }
            for (name in listOf("recordIndices", "layerFirstRecord", "tickRecord", "tickSourceLine", "tickLayer", "tickLabel")) {
                assertThrows(name, IllegalArgumentException::class.java) {
                    GcodeViewPacket(column(bytes, name) { it.putInt(0, -1) }, model, 2)
                }
            }
            assertThrows(IllegalArgumentException::class.java) { GcodeViewPacket(bytes, model, 1) }
            var visits = 0
            assertThrows(IllegalStateException::class.java) {
                GcodeViewChecks.validate(valid, model) { if (++visits == 3) error("cancelled") }
            }
            assertEquals(3, visits)
        }
    }

    @Test fun actualPreviewAndPlaybackRejectInvalidLocalAndOriginalIndices() {
        session().use { owner ->
            val model = owner.whole()
            val bytes = raw(preview)
            val valid = GcodeViewPacket(bytes, model, 1)
            assertTrue(valid.recordCount > 1)
            val mutations = listOf<(JSONObject) -> Unit>(
                { it.put("sourceRecordCount", model.recordCount + 1) },
                { it.getJSONObject("mode").put("label", "wrong") },
                { it.getJSONObject("range").apply { put("min", getDouble("max") + 1) } },
                { it.getJSONObject("range").put("sampleCount", valid.recordCount + 1) },
                { it.getJSONArray("legend").apply { put(getJSONObject(0)) } }
            )
            mutations.forEachIndexed { index, mutation ->
                assertThrows("Preview metadata $index", IllegalArgumentException::class.java) {
                    GcodeViewPacket(metadata(bytes, mutation), model, 1)
                }
            }
            val changes = listOf<Pair<String, (ByteBuffer) -> Unit>>(
                "recordIndices" to { it.putInt(0, model.recordCount) },
                "recordIndices" to { it.putInt(4, it.getInt(0)) },
                "values" to { it.putFloat(0, Float.NaN) },
                "valueValid" to { it.put(0, 2) },
                "colorsRgba" to { it.putFloat(0, 1.1f) }
            )
            for ((name, change) in changes) assertThrows(name, IllegalArgumentException::class.java) {
                GcodeViewPacket(column(bytes, name, change), model, 1)
            }
            val unsupported = raw(preview.replace("Feedrate", "ColorPrint"))
            assertEquals("unsupported", GcodeViewPacket(unsupported, model, 1).metadata.getString("status"))
            assertThrows(IllegalArgumentException::class.java) {
                GcodeViewPacket(metadata(unsupported) {
                    it.getJSONArray("missingMetadata").getJSONObject(0).put("indices", JSONArray().put(999))
                }, model, 1)
            }
            val frames = raw(playback)
            assertTrue(GcodeViewPacket(frames, model, 3).recordCount > 0)
            for (bad in listOf(0, model.recordCount, -1)) assertThrows(IllegalArgumentException::class.java) {
                GcodeViewPacket(column(frames, "recordIndices") { it.putInt(0, bad) }, model, 3)
            }
        }
    }
}
