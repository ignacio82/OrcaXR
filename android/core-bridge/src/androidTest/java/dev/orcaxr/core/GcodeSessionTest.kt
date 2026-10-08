package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class GcodeSessionTest {
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
    private fun snapshot(packet: GcodePacket): JSONObject {
        val value = JSONObject(packet.metadata.toString())
        value.put("columns", JSONObject().put("count", packet.recordCount))
        value.put("pathPoints", JSONObject().put("count", packet.pathPointCount))
        for (field in GcodeLayout.fields) {
            val bytes = packet.column(field.group, field.name)
            val count = if (field.group == "columns") packet.recordCount else packet.pathPointCount
            val values = JSONArray()
            repeat(count) { values.put(when (field.type) {
                "u8" -> bytes.get().toInt() and 255
                "u16" -> bytes.short.toInt() and 65535
                "i32" -> bytes.int
                else -> bytes.int.toLong() and 0xffffffffL // f32 compared by bits
            }) }
            value.getJSONObject(field.group).put(field.name, if (field.type == "f32") JSONObject().put("\$f32", values) else values)
        }
        return value
    }
    @Test fun independentParserVectorsCrossTheRealJniBoundary() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val corpus = JSONObject(context.assets.open("gcode-vectors.json").bufferedReader().use { it.readText() }).getJSONArray("vectors")
        for (i in 0 until corpus.length()) {
            val vector = corpus.getJSONObject(i)
            val expected = vector.getJSONObject("binding")
            val units = vector.getJSONArray("sourceUnits")
            val id = vector.getString("id")
            GcodeSession(units.length(), vector.getJSONObject("options").toString()).use { session ->
                var offset = 0
                while (offset < units.length()) {
                    val length = minOf(4093, units.length() - offset)
                    session.append(offset, CharArray(length) { units.getInt(offset + it).toChar() })
                    offset += length
                }
                val index = JSONObject(expected.getJSONObject("index").toString())
                val entries = index.remove("entries") as JSONArray
                index.put("entryCount", entries.length()).put("version", GcodeLayout.VERSION)
                equal(session.seal(), index, "$id.info")
                for (entry in 0 until entries.length()) entries.getJSONObject(entry).remove("checkpoint")
                equal(session.page(0, GcodeLayout.MAX_INDEX_PAGE_ENTRIES), entries, "$id.page")
                equal(snapshot(session.whole()), expected.getJSONObject("model"), "$id.whole")
                val windows = expected.getJSONArray("windows")
                for (entry in 0 until windows.length()) equal(snapshot(session.window(entry, entry)), windows.getJSONObject(entry), "$id.window[$entry]")
            }
        }
    }
    @Test fun fileBytesDecodeAsTheBrowserDecodesThem() {
        // Node's WHATWG decoder recorded these; malformed sequences, split
        // characters and byte-order marks included.
        val context = InstrumentationRegistry.getInstrumentation().context
        val decodes = JSONObject(context.assets.open("gcode-oracle-vectors.json").bufferedReader().use { it.readText() }).getJSONArray("utf8")
        for (i in 0 until decodes.length()) {
            val case = decodes.getJSONObject(i)
            val bytes = case.getJSONArray("bytes").let { a -> ByteArray(a.length()) { a.getInt(it).toByte() } }
            val expected = case.getJSONArray("units").let { a -> CharArray(a.length()) { a.getInt(it).toChar() } }
            assertArrayEquals("case $i", expected, GcodeSession.decodeUtf8(bytes))
        }
        assertEquals(319, decodes.length())
    }

    @Test fun uploadLifecycleAndStaleHandlesFailClosed() {
        assertThrows(IllegalStateException::class.java) { NativeGcode.open(99, 0, "{}") }
        val handle = NativeGcode.open(1, 3, "{}")
        try {
            assertThrows(IllegalStateException::class.java) { NativeGcode.seal(handle) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.append(handle, 1, charArrayOf('X')) }
            NativeGcode.append(handle, 0, "G1\n".toCharArray())
            NativeGcode.seal(handle)
            assertThrows(IllegalStateException::class.java) { NativeGcode.append(handle, 3, charArrayOf()) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.page(handle, 0, 257) }
            val size = NativeGcode.prepare(handle, -1, -1)
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, ByteBuffer.allocate(size)) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, ByteBuffer.allocateDirect(size).asReadOnlyBuffer()) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, ByteBuffer.allocateDirect(size - 1)) }
            val bytes = ByteBuffer.allocateDirect(size).order(ByteOrder.LITTLE_ENDIAN)
            NativeGcode.copy(handle, bytes)
            assertThrows(IllegalStateException::class.java) { NativeGcode.copy(handle, bytes) }
            NativeGcode.close(handle)
            assertEquals(0, GcodePacket(bytes).recordCount)
            assertThrows(IllegalStateException::class.java) { NativeGcode.prepare(handle, -1, -1) }
            bytes.putInt(4, 99)
            assertThrows(IllegalArgumentException::class.java) { GcodePacket(bytes) }
            bytes.putInt(4, 1)
            bytes.put(24, 0xff.toByte())
            assertThrows(java.nio.charset.CharacterCodingException::class.java) { GcodePacket(bytes) }
        } finally { NativeGcode.close(handle) }
        val handles = mutableListOf<Long>()
        try {
            repeat(4) { handles.add(NativeGcode.open(1, 0, "{}")) }
            assertThrows(IllegalStateException::class.java) { NativeGcode.open(1, 0, "{}") }
            assertEquals(4, handles.toSet().size)
        } finally { handles.forEach { NativeGcode.close(it) } }
    }
    @Test fun nativeCloseCancelsAnInFlightIndexAndSettlesItsOwner() {
        val text = "G2 X0 Y0 I10000 J0\n".repeat(100_000)
        val handle = NativeGcode.open(1, text.length, "{}")
        var offset = 0
        while (offset < text.length) {
            val end = minOf(offset + GcodeLayout.MAX_CHUNK_UNITS, text.length)
            NativeGcode.append(handle, offset, text.substring(offset, end).toCharArray())
            offset = end
        }
        val entered = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val outcome = AtomicReference<String>()
        val worker = Thread {
            entered.countDown()
            try { NativeGcode.seal(handle); outcome.set("published") }
            catch (error: IllegalStateException) { outcome.set(error.message) }
            finally { finished.countDown() }
        }
        worker.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            Thread.sleep(20)
            NativeGcode.close(handle)
            assertTrue("Cancellation failed to settle", finished.await(10, TimeUnit.SECONDS))
            assertTrue(outcome.get() in listOf("cancelled", "closed"))
        } finally { NativeGcode.close(handle); worker.join(10_000) }
    }
    @Test fun returnedBufferAndUtf16TextSurviveOwnerClose() {
        val session = GcodeSession(6)
        session.append(0, "G1 X1\n".toCharArray())
        session.seal()
        val packet = session.whole()
        session.close(); session.close()
        assertEquals(1f, packet.column("columns", "endX").float, 0f)
        assertTrue(packet.column("columns", "endX").isReadOnly)
        assertThrows(IllegalStateException::class.java) { session.page(0, 1) }
        assertEquals("\ud800\udfff\ud800", GcodePacket.text(JSONArray().put(0xd800).put(0xdfff).put(0xd800)))
    }
}
