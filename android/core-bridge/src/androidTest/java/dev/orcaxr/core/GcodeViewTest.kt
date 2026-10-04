package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GcodeViewTest {
    private fun equal(actual: Any?, expected: Any?, path: String) {
        when {
            actual is JSONObject && expected is JSONObject -> {
                val keys = actual.keys().asSequence().toSet()
                assertEquals(path, expected.keys().asSequence().toSet(), keys)
                for (key in keys) equal(actual.get(key), expected.get(key), "$path.$key")
            }
            actual is JSONArray && expected is JSONArray -> {
                assertEquals(path, expected.length(), actual.length())
                for (i in 0 until actual.length()) equal(actual.get(i), expected.get(i), "$path[$i]")
            }
            actual is Number && expected is Number -> assertEquals(path, expected.toDouble(), actual.toDouble(), 0.0)
            else -> assertEquals(path, expected, actual)
        }
    }
    private fun snapshot(packet: GcodeViewPacket): Any {
        val value = JSONObject(packet.metadata.toString())
        val fields = JSONObject()
        val counts = intArrayOf(packet.recordCount, packet.layerCount, packet.tickCount)
        for (field in requireNotNull(GcodeViewLayout.fields[packet.kind])) {
            val bytes = packet.column(field.name)
            val values = JSONArray()
            repeat(counts[field.counter] * field.factor) {
                values.put(if (field.type == "u8") bytes.get().toInt() and 255 else bytes.int.toLong() and 0xffffffffL)
            }
            fields.put(field.name, if (field.type == "f32") JSONObject().put("\$f32", values) else values)
        }
        if (packet.kind == 3) return fields.getJSONArray("recordIndices")
        if (packet.kind == 1) {
            if (value.getString("status") == "ready") {
                value.put("count", packet.recordCount)
                fields.keys().forEach { value.put(it, fields.get(it)) }
            } else assertEquals(0, packet.recordCount)
            return value
        }
        value.put("recordIndices", fields.getJSONArray("recordIndices"))
        value.put("layers", JSONObject().put("count", packet.layerCount)
            .put("layerIds", fields.get("layerIds")).put("zMm", fields.get("layerZMm"))
            .put("firstRecord", fields.get("layerFirstRecord")).put("lastRecord", fields.get("layerLastRecord")))
        val labels = value.remove("tickLabels") as JSONArray
        val ticks = JSONArray()
        for (i in 0 until packet.tickCount) {
            val kind = requireNotNull(GcodeViewLayout.tickKinds[fields.getJSONArray("tickKind").getInt(i)])
            val record = fields.getJSONArray("tickRecord").getLong(i)
            ticks.put(JSONObject().put("id", "$kind:$record").put("kind", kind)
                .put("label", labels.getString(fields.getJSONArray("tickLabel").getInt(i)))
                .put("record", record).put("layer", fields.getJSONArray("tickLayer").getLong(i))
                .put("zMm", Float.fromBits(fields.getJSONObject("tickZMm").getJSONArray("\$f32").getLong(i).toInt()).toDouble())
                .put("sourceLine", fields.getJSONArray("tickSourceLine").getLong(i))
                .put("sourceStartOffset", fields.getJSONArray("tickStartOffset").getLong(i))
                .put("sourceEndOffset", fields.getJSONArray("tickEndOffset").getLong(i)))
        }
        value.put("ticks", ticks)
        return value
    }
    @Test fun sourceOwnedViewsMatchIndependentTypeScriptAcrossJni() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val vectors = JSONObject(context.assets.open("view-vectors.json").bufferedReader().use { it.readText() }).getJSONArray("vectors")
        var tested = 0
        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val units = vector.getJSONArray("sourceUnits")
            GcodeSession(units.length(), vector.getJSONObject("options").toString()).use { session ->
                var offset = 0
                while (offset < units.length()) {
                    val length = minOf(4093, units.length() - offset)
                    session.append(offset, CharArray(length) { units.getInt(offset + it).toChar() })
                    offset += length
                }
                session.seal()
                val views = vector.getJSONArray("views")
                for (j in 0 until views.length()) {
                    val view = views.getJSONObject(j)
                    val id = "${vector.getString("id")}:$j"
                    val request = view.getJSONObject("request").toString()
                    if (view.has("error")) {
                        val failure = assertThrows(id, IllegalStateException::class.java) { session.view(request) }
                        assertEquals(id, view.getString("error"), failure.message)
                    } else equal(snapshot(session.view(request)), view.get("expected"), id)
                    tested++
                }
            }
        }
        assertEquals(4554, tested)
    }
    @Test fun viewOwnershipAndMalformedPacketsFailClosed() {
        val source = "M83\nG1 X1 E1\n; PAUSE_PRINTING\n"
        val request = """{"version":1,"window":[],"operation":"inspection","includeSource":true,"request":{"showToolMarker":true}}"""
        val session = GcodeSession(source.length)
        session.append(0, source.toCharArray()); session.seal()
        val packet = session.view(request)
        val expected = snapshot(packet)
        for (invalid in listOf("null", request.replace("\"version\":1", "\"version\":99"), request.replace("\"window\":[]", "\"window\":[1,0]"))) {
            assertThrows(IllegalStateException::class.java) { session.view(invalid) }
        }
        equal(snapshot(session.view(request)), expected, "after rejection")
        session.close(); session.close()
        equal(snapshot(packet), expected, "after close")
        assertTrue(packet.column("recordIndices").isReadOnly)
        assertThrows(IllegalStateException::class.java) { session.view(request) }
        val handle = NativeGcode.open(1, source.length, "{}")
        try {
            NativeGcode.append(handle, 0, source.toCharArray()); NativeGcode.seal(handle)
            val size = NativeGcode.prepareView(handle, request)
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, ByteBuffer.allocateDirect(size).asReadOnlyBuffer()) }
            val bytes = ByteBuffer.allocateDirect(size).order(ByteOrder.LITTLE_ENDIAN)
            NativeGcode.copy(handle, bytes)
            equal(snapshot(GcodeViewPacket(bytes)), expected, "raw transfer")
            for ((offset, bad) in listOf(0 to 0, 4 to 99, 8 to 99, 12 to -1, 16 to -1, 20 to Int.MAX_VALUE, 24 to 100001, 28 to size-1)) {
                val saved = bytes.getInt(offset); bytes.putInt(offset, bad)
                assertThrows(IllegalArgumentException::class.java) { GcodeViewPacket(bytes) }
                bytes.putInt(offset, saved)
            }
            val saved = bytes.get(32); bytes.put(32, 0xff.toByte())
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { GcodeViewPacket(bytes) }
            bytes.put(32, saved)
            // Failed prepare must clear the old pending packet, not let copy
            // accidentally publish a previous operation's result.
            NativeGcode.prepareView(handle, request)
            assertThrows(IllegalStateException::class.java) { NativeGcode.prepareView(handle, "null") }
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, bytes) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.prepareView(handle, " ".repeat(GcodeViewLayout.MAX_REQUEST_BYTES + 1)) }
        } finally { NativeGcode.close(handle) }
    }
}
