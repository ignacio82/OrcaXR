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
class GcodeBoundaryTest {
    private val source = "M83\n;LAYER_CHANGE\nG1 Z0.2\nG1 X1 E1\nG2 X3 Y0 I1 J0 E1\n; PAUSE_PRINTING\n"
    private val view = """{"version":1,"window":[],"operation":"inspection","includeSource":true,"request":{"showToolMarker":true}}"""

    private fun packet(view: Boolean = false): ByteBuffer {
        val handle = NativeGcode.open(1, source.length, "{}")
        try {
            NativeGcode.append(handle, 0, source.toCharArray())
            NativeGcode.seal(handle)
            val size = if (view) NativeGcode.prepareView(handle, this.view) else NativeGcode.prepare(handle, -1, -1)
            return ByteBuffer.allocateDirect(size).order(ByteOrder.LITTLE_ENDIAN).also { NativeGcode.copy(handle, it) }
        } finally { NativeGcode.close(handle) }
    }

    private fun replaceMetadata(bytes: ByteBuffer, view: Boolean = false, change: (JSONObject) -> Unit): ByteBuffer {
        val header = if (view) 32 else 24
        val lengthOffset = if (view) 12 else 8
        val oldSize = bytes.getInt(lengthOffset)
        val text = ByteArray(oldSize)
        bytes.duplicate().apply { position(header); get(text) }
        val value = JSONObject(text.toString(Charsets.UTF_8)).also(change).toString().toByteArray(Charsets.UTF_8)
        val oldStart = (header + oldSize + 3) and -4
        val newStart = (header + value.size + 3) and -4
        val copy = ByteBuffer.allocateDirect(bytes.capacity() - oldStart + newStart).order(ByteOrder.LITTLE_ENDIAN)
        copy.put(bytes.duplicate().apply { limit(header) })
        copy.put(value)
        while (copy.position() < newStart) copy.put(0)
        copy.put(bytes.duplicate().apply { position(oldStart) })
        copy.putInt(lengthOffset, value.size)
        copy.putInt(header - 4, copy.capacity())
        copy.position(0)
        return copy
    }

    @Test fun strictJsonAndRawTypesRejectCoercionAndUnboundedNesting() {
        for (bad in listOf("{'a':1}", "{a:1}", "{\"a\":1,}", "[1,]", "[01]", "[NaN]", "[1e999]", "[1.]", "[+1]", "[.1]", "[1e]", "[TRUE]", "[False]", "[NULL]", "[\"bad\\q\"]",
            "{}{}", "{\"a\":1,\"a\":2}", "[\"raw\nline\"]", "[\"raw\tline\"]", "\uFEFF{}",
            "[".repeat(18) + "0" + "]".repeat(18))) {
            assertThrows("Unexpected JSON accepted", IllegalArgumentException::class.java) { GcodeJson.parse(bad) }
        }
        val exact = GcodeJson.arrayValue("[1.0,1e0,-0,\"Unicode 雪 \\ud800\\u0000\"]")
        assertEquals(1.0, exact.getDouble(0), 0.0)
        assertEquals(1.0, exact.getDouble(1), 0.0)
        assertEquals("Unicode 雪 \ud800\u0000", exact.getString(3))
        val valid = GcodeJson.arrayValue("[0,65535,55296,56320]")
        assertEquals(charArrayOf(0.toChar(), 65535.toChar(), 55296.toChar(), 56320.toChar()).concatToString(), GcodePacket.text(valid))
        for (bad in listOf(JSONArray().put("65"), JSONArray().put(true), JSONArray().put(1.5),
            JSONArray().put(-1), JSONArray().put(65536), JSONArray().put(JSONObject.NULL))) {
            assertThrows(IllegalArgumentException::class.java) { GcodePacket.text(bad) }
        }
        val optional = GcodeJson.objectValue("""{"id":0,"tool":0,"source":"tool"}""")
        GcodeMetadata.validate(GcodeMetadata.Kind.Filament, optional)
        optional.put("color", JSONObject.NULL)
        assertThrows(IllegalArgumentException::class.java) { GcodeMetadata.validate(GcodeMetadata.Kind.Filament, optional) }
    }

    @Test fun actualNativeModelRejectsMetadataAndColumnCorruption() {
        val bytes = packet()
        val model = GcodePacket(bytes)
        assertTrue(model.pathPointCount > 0)
        val mutations = listOf<(JSONObject) -> Unit>(
            { it.put("complete", "true") }, { it.put("complete", !it.getBoolean("complete")) },
            { it.put("parsedCharacters", source.length + 1) }, { it.put("unexpected", 1) },
            { it.remove("roles") }, { it.put("roles", JSONObject.NULL) },
            { it.getJSONArray("filaments").getJSONObject(0).put("id", 1) },
            { it.getJSONArray("roles").getJSONArray(0).put("65") },
            { it.getJSONObject("limits").put("records", 0) },
            { it.put("recordOffset", 0xffffffffL) }
        )
        for (mutation in mutations) assertThrows(IllegalArgumentException::class.java) {
            GcodePacket(replaceMetadata(bytes, change = mutation))
        }
        var offset = (24 + bytes.getInt(8) + 3) and -4
        for (field in GcodeLayout.fields) {
            val count = if (field.group == "columns") model.recordCount else model.pathPointCount
            val saved = ByteArray(minOf(4, count * field.bytes))
            if (field.name in setOf("kind", "startX", "role", "tool", "filament", "pathPointOffset", "x")) {
                bytes.duplicate().apply { position(offset); get(saved) }
                when (field.type) {
                    "u8" -> bytes.put(offset, 3)
                    "u16" -> bytes.putShort(offset, 65535.toShort())
                    "f32" -> bytes.putFloat(offset, Float.NaN)
                    else -> bytes.putInt(offset, 1)
                }
                assertThrows(field.name, IllegalArgumentException::class.java) { GcodePacket(bytes) }
                bytes.duplicate().apply { position(offset); put(saved) }
            }
            val end = offset + count * field.bytes
            offset = (end + 3) and -4
            if (offset != end) {
                bytes.put(end, 1)
                assertThrows("padding", IllegalArgumentException::class.java) { GcodePacket(bytes) }
                bytes.put(end, 0)
            }
        }
        val snapshot = model.metadata
        snapshot.getJSONObject("limits").put("records", 0)
        assertTrue(model.metadata.getJSONObject("limits").getInt("records") > 0)
        assertThrows(IllegalArgumentException::class.java) { GcodePacket(bytes.duplicate().apply { position(1) }) }
        GcodePacket(bytes)
    }

    @Test fun actualNativeViewRejectsUnknownMissingAndCoercedFields() {
        val bytes = packet(view = true)
        val model = GcodePacket(packet())
        val original = GcodeViewPacket(bytes, model, 2)
        val mutations = listOf<(JSONObject) -> Unit>(
            { it.put("sourceRecordCount", "7") }, { it.put("unknown", false) },
            { it.remove("current") }, { it.put("tickLabels", JSONObject.NULL) },
            { it.getJSONObject("current").put("record", 0.5) },
            { it.getJSONObject("sourceWindow").getJSONArray("lines").getJSONObject(0).put("current", "false") }
        )
        for (mutation in mutations) assertThrows(IllegalArgumentException::class.java) {
            GcodeViewPacket(replaceMetadata(bytes, view = true, change = mutation), model, 2)
        }
        original.metadata.getJSONArray("tickLabels").put("changed")
        assertEquals(original.tickCount, original.metadata.getJSONArray("tickLabels").length())
        assertThrows(IllegalArgumentException::class.java) { GcodeViewPacket(bytes.duplicate().apply { limit(capacity() - 1) }, model, 2) }
    }

    @Test fun indexPagesAndValidationWorkRemainBounded() {
        GcodeSession(source.length).use { owner ->
            owner.append(0, source.toCharArray())
            val info = owner.seal()
            val index = GcodePacketChecks.index(info, source.length)
            for (i in 0 until index.entries) assertEquals(1, owner.page(i, 1).length())
            assertEquals(0, owner.page(index.entries, 1).length())
            val first = owner.page(0, 1)
            first.getJSONObject(0).put("recordsBefore", 1)
            assertThrows(IllegalArgumentException::class.java) { GcodePacketChecks.page(first, index, null) }
            info.put("sourceLength", source.length + 1)
            assertThrows(IllegalArgumentException::class.java) { GcodePacketChecks.index(info, source.length) }
            // Caller mutation of returned index metadata cannot alter bounds.
            assertEquals(1, owner.page(0, 1).length())
        }
        val model = GcodePacket(packet()).metadata
        val units = JSONArray()
        repeat(8192) { units.put(65) }
        val roles = JSONArray()
        repeat(512) { roles.put(units) }
        model.put("roles", roles)
        // Shared test objects keep allocation small, but require over four
        // million validation steps if the traversal budget is missing.
        assertThrows(IllegalArgumentException::class.java) { GcodeMetadata.validate(GcodeMetadata.Kind.Model, model) }
        var visits = 0
        val failure = assertThrows(IllegalStateException::class.java) {
            GcodeMetadata.validate(GcodeMetadata.Kind.Model, model) {
                if (++visits == 3) error("cancelled")
            }
        }
        assertEquals("cancelled", failure.message)
        assertEquals(3, visits)
        val large = "[" + "0,".repeat(10000) + "0]"
        visits = 0
        assertThrows(IllegalStateException::class.java) {
            GcodeJson.parse(large) { if (++visits == 3) error("cancelled") }
        }
        assertEquals(3, visits)
        val packet = GcodePacket(packet())
        visits = 0
        assertThrows(IllegalStateException::class.java) {
            GcodePacketChecks.model(packet) { if (++visits == 3) error("cancelled") }
        }
        assertEquals(3, visits)
    }
}
