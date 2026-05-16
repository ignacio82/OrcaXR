package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class AutoPaintLabelToolTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private lateinit var bvh: MeshBvh
    private val modelId = "m_lbl"

    private fun cube(): MeshBvh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2), intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4), intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3), intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return MeshBvh.build(StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f)))
    }

    private fun textResp(text: String): Result<JSONObject> = Result.success(JSONObject().apply {
        put("content", JSONArray().apply {
            put(JSONObject().apply { put("type", "text"); put("text", text) })
        })
    })

    /** Returns a generous segment list (covers any band count). */
    private val goodSegments = """
        {"segments":[
          {"id":0,"label":"Body","colour":"#0000FF"},
          {"id":1,"label":"Trim","colour":"#FF0000"},
          {"id":2,"label":"Top","colour":"#00FF00"},
          {"id":3,"label":"Base","colour":"#FFFF00"},
          {"id":4,"label":"Extra","colour":"#0000FF"},
          {"id":5,"label":"Extra2","colour":"#FF0000"}]}
    """.trimIndent()

    private inner class CapturingClient(val resp: Result<JSONObject>) : VisionApiClient {
        var sent = false
        override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
            sent = true
            return resp
        }
    }

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(id = modelId, source = File("/dev/null"), label = "lbl cube")))
        bvh = cube()
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        ws.publishPreviewPalette(listOf("#FF0000", "#00FF00", "#0000FF", "#FFFF00"))
        session = AiSessionState()
    }

    private fun tool(
        client: VisionApiClient = CapturingClient(textResp(goodSegments)),
        key: String? = "fake-key",
        captureProvider: ((VisionProvider) -> Unit)? = null,
    ) = AutoPaintLabelTool(ws, session, flowOf(key)) { p ->
        captureProvider?.invoke(p); client
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        @Suppress("OPT_IN_USAGE")
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun aiSuccessNamesRecolorsAndEmitsOneLoadPaintState() = runTest {
        val support = ByteArray(bvh.triCount) { 1 }
        ws.publishPlacedModels(listOf(ws.placedModels.value.first().copy(supportFlags = support)))
        val t = tool()
        val action = captureNextAction {
            t.call(JSONObject().apply { put("model_id", modelId) })
        }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(bvh.triCount, a.paintFilamentIndex!!.size)
        assertTrue("full coverage", a.paintFilamentIndex!!.none { it.toInt() == 0 })
        assertTrue(a.supportFlags!!.contentEquals(support))
    }

    @Test fun aiSuccessDryRunReportsBandsAndAiUsed() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("dry_run", true)
        })
        assertFalse(res.text, res.isError)
        val s = res.structured!!
        assertEquals(true, s.getBoolean("ai_used"))
        assertEquals(false, s.getBoolean("applied"))
        assertEquals("height_bands", s.getString("source"))
        assertTrue(s.getInt("band_count") >= 1)
        assertTrue(s.getJSONArray("bands").length() >= 1)
        // Body band → "#0000FF" → palette slot 3.
        val first = s.getJSONArray("bands").getJSONObject(0)
        assertEquals("Body", first.getString("label"))
        assertEquals(3, first.getInt("slot"))
    }

    @Test fun paintStateModelDrivesPaintStateSource() = runTest {
        val paint = ByteArray(bvh.triCount)
        for (i in 0 until 8) paint[i] = 1
        for (i in 8 until 12) paint[i] = 2
        ws.publishPlacedModels(listOf(ws.placedModels.value.first().copy(paintFilamentIndex = paint)))
        val res = tool().call(JSONObject().apply { put("model_id", modelId); put("dry_run", true) })
        assertEquals("paint_state", res.structured!!.getString("source"))
    }

    @Test fun aiParseFailureFallsBackToDeterministicButStillApplies() = runTest {
        val t = tool(client = CapturingClient(textResp("totally not json")))
        val action = captureNextAction { t.call(JSONObject().apply { put("model_id", modelId) }) }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        // Re-run as dry to inspect flags.
        val res = tool(client = CapturingClient(textResp("totally not json")))
            .call(JSONObject().apply { put("model_id", modelId); put("dry_run", true) })
        val s = res.structured!!
        assertEquals(false, s.getBoolean("ai_used"))
        assertEquals(true, s.getBoolean("ai_failed"))
    }

    @Test fun noKeyFallsBackToDeterministicWithoutError() = runTest {
        val client = CapturingClient(textResp(goodSegments))
        val t = AutoPaintLabelTool(ws, session, flowOf(null)) { client }
        val res = t.call(JSONObject().apply { put("model_id", modelId); put("dry_run", true) })
        assertFalse(res.isError)
        assertEquals(false, res.structured!!.getBoolean("ai_used"))
        assertFalse("AI client must not be called without a key", client.sent)
    }

    @Test fun providerArgRoutesToSelectedProvider() = runTest {
        var seen: VisionProvider? = null
        val t = tool(captureProvider = { seen = it })
        val res = t.call(JSONObject().apply {
            put("model_id", modelId); put("provider", "gemini")
            put("api_key", "g"); put("dry_run", true)
        })
        assertEquals(VisionProvider.GEMINI, seen)
        assertEquals("gemini", res.structured!!.getString("provider"))
    }

    @Test fun fullSpectrumRejected() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("use_full_spectrum", true)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("FullSpectrum") || res.text.contains("full"))
    }

    @Test fun capabilityGateBlocksApply() = runTest {
        ws.publishWiredTierBCapabilities(emptySet())
        val res = tool().call(JSONObject().apply { put("model_id", modelId) })
        assertTrue(res.isError)
        assertTrue(res.text.contains("LoadPaintState"))
    }

    @Test fun multipleModelsRequireExplicitId() = runTest {
        ws.publishPlacedModels(listOf(
            PlacedModel(id = "a", source = File("/dev/null"), label = "a"),
            PlacedModel(id = "b", source = File("/dev/null"), label = "b"),
        ))
        val res = tool().call(JSONObject())
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id is required"))
    }
}
