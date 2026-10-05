package dev.orcaxr.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.Collections
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GcodeRequestTest {
    @Test fun independentContractVectorsMatchHostGuardsAndActualJniResults() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val corpus = JSONObject(assets.open("request-vectors.json").bufferedReader().use { it.readText() })
        val source = corpus.getString("source")
        val vectors = corpus.getJSONArray("vectors")
        GcodeSession(source.length).use { owner ->
            owner.append(0, source.toCharArray()); owner.seal()
            val model = owner.whole()
            for (i in 0 until vectors.length()) {
                val vector = vectors.getJSONObject(i)
                val id = vector.getString("id")
                val encoded = vector.getString("json")
                val options = vector.getString("kind") == "Options"
                val shape = try {
                    val value = GcodeJson.objectValue(encoded)
                    if (options) GcodeRequests.validateOptions(value) else GcodeRequests.validateView(value)
                    true
                } catch (_: IllegalArgumentException) { false }
                assertEquals(id, vector.getBoolean("shapeValid"), shape)
                val actual = try {
                    if (options) GcodeSession(0, encoded).close() else owner.view(model, encoded)
                    "ok"
                } catch (error: IllegalStateException) { error.message }
                assertEquals(id, vector.getString("result"), actual)
            }
            assertTrue(owner.view(model, GcodeRequests.Inspection(GcodeRequests.Window.Whole,
                GcodeRequests.InspectionRequest())).belongsTo(model))
        }
        assertEquals(30, vectors.length())
    }

    @Test fun typedRequestsPreserveUnsignedBitsUtf16AndAllViewKinds() {
        val source = "M83\n;LAYER_CHANGE\nG1 Z0.2 F600\nG1 X1 E1\n"
        val units = listOf(0xd800, 0, 0xdc00, 0xffff)
        val options = GcodeRequests.Options(filamentColors = listOf(units))
        val encoded = GcodeJson.objectValue(options.encode())
        val color = encoded.getJSONArray("filamentColors").getJSONArray(0)
        assertEquals(units, List(color.length()) { color.getInt(it) })
        val query = GcodeRequests.Preview(GcodeRequests.Window.Whole,
            GcodeRequests.PreviewRequest("LayerTime", layerTimes = GcodeRequests.LayerTimesBits(
                listOf(0xffffffffL, 0x7f800000L), units)))
        val bits = GcodeJson.objectValue(query.encode()).getJSONObject("request")
            .getJSONObject("layerTimes").getJSONArray("secondsByLayerBits")
        assertEquals(0xffffffffL, bits.getLong(0))
        GcodeSession(source.length, options).use { owner ->
            owner.append(0, source.toCharArray()); owner.seal()
            val model = owner.whole()
            assertEquals("unsupported", owner.view(model, query).metadata.getString("status"))
            val inspection = GcodeRequests.InspectionRequest(showToolMarker = true)
            assertNotNull(owner.view(model, GcodeRequests.Inspection(GcodeRequests.Window.Whole,
                inspection, includeSource = true)).metadata.optJSONObject("sourceWindow"))
            assertTrue(owner.view(model, GcodeRequests.Playback(GcodeRequests.Window.Whole,
                inspection, GcodeRequests.PlaybackOptions(-1.0, wrap = true, maxFrames = 12.0))).recordCount > 0)
        }
        val boundary = GcodeRequests.Preview(GcodeRequests.Window.Entries(0, 0xffffffffL), GcodeRequests.PreviewRequest("Tool"))
        assertEquals(0xffffffffL, GcodeJson.objectValue(boundary.encode()).getJSONArray("window").getLong(1))
        assertThrows(IllegalArgumentException::class.java) { boundary.copy(window = GcodeRequests.Window.Entries(0, 0x100000000L)).encode() }
        assertThrows(IllegalArgumentException::class.java) { boundary.copy(window = GcodeRequests.Window.Entries(1, 0)).encode() }
        assertThrows(IllegalArgumentException::class.java) { query.copy(request = GcodeRequests.PreviewRequest("Tool", layerRange = listOf(0.0))).encode() }
        assertThrows(IllegalArgumentException::class.java) { query.copy(request = GcodeRequests.PreviewRequest("Tool", maxProjectedRecords = Double.NaN)).encode() }
    }

    @Test fun encodersAndRawValidationBoundWorkBeforeNativeAllocation() {
        val values = Collections.nCopies(GcodeRequests.MAX_VIEW_BYTES / 2 + 1, 0L)
        val query = GcodeRequests.Preview(GcodeRequests.Window.Whole, GcodeRequests.PreviewRequest("LayerTime",
            layerTimes = GcodeRequests.LayerTimesBits(values, emptyList())))
        assertThrows(IllegalArgumentException::class.java) { query.encode() }
        assertThrows(IllegalArgumentException::class.java) {
            GcodeRequests.Options(filamentColors = listOf(Collections.nCopies(40000, 65535))).encode()
        }
        val raw = JSONObject().put("version", 1).put("operation", "preview").put("window", JSONArray())
            .put("request", JSONObject().put("mode", "Tool").put("layerTimes", JSONObject()
                .put("secondsByLayerBits", JSONArray().apply { repeat(8192) { put(0) } })
                .put("provenance", JSONArray())))
        var polls = 0
        assertThrows(IllegalStateException::class.java) {
            GcodeRequests.validateView(raw) { if (++polls == 3) error("cancelled") }
        }
        assertEquals(3, polls)
        for (options in listOf("{\"limits\":{},\"limits\":{}}", "{\"limits\":{\"records\":null,\"records\":2}}")) {
            assertEquals("invalid_options", assertThrows(IllegalStateException::class.java) { GcodeSession(0, options) }.message)
        }
    }
}
