package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.PngWriter
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
import java.util.Base64

class AutoPaintReferenceToolTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private lateinit var bvh: MeshBvh
    private val modelId = "m_ref"

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

    private fun refB64(): String =
        Base64.getEncoder().encodeToString(PngWriter.encodeRgba(ByteArray(8 * 8 * 4) { -1 }, 8, 8))

    private fun textResponse(text: String): JSONObject = JSONObject().apply {
        put("content", JSONArray().apply {
            put(JSONObject().apply { put("type", "text"); put("text", text) })
        })
    }

    private val planJson =
        """{"base_color":"#0000FF","regions":[
             {"name":"accent","color":"#FF0000",
              "polygons":[[0,0,511,0,511,511,0,511]]}]}"""

    /** Branches on the system prompt: 'grader' → score, else → plan. */
    private inner class FakeVision(val scores: List<Double>) : VisionApiClient {
        var gradeCalls = 0
        var planCalls = 0
        override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
            val system = requestBody.optString("system")
            return if (system.contains("grader")) {
                val s = scores.getOrElse(gradeCalls) { scores.last() }
                gradeCalls++
                Result.success(textResponse(
                    """{"score":$s,"comment":"grade $gradeCalls","regions":[]}""",
                ))
            } else {
                planCalls++
                Result.success(textResponse(planJson))
            }
        }
    }

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(id = modelId, source = File("/dev/null"), label = "ref cube")))
        bvh = cube()
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        ws.publishPreviewPalette(listOf("#FF0000", "#00FF00", "#0000FF"))
        session = AiSessionState()
    }

    private fun tool(fake: VisionApiClient, key: String? = "fake-key") =
        AutoPaintReferenceTool(ws, session, flowOf(key), fake)

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        @Suppress("OPT_IN_USAGE")
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun missingApiKeyRejected() = runTest {
        val res = tool(FakeVision(listOf(0.9)), key = null).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("API key"))
    }

    @Test fun fullSpectrumRejected() = runTest {
        val res = tool(FakeVision(listOf(0.9))).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
            put("use_full_spectrum", true)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("FullSpectrum"))
    }

    @Test fun referenceRequired() = runTest {
        val res = tool(FakeVision(listOf(0.9))).call(JSONObject().apply { put("model_id", modelId) })
        assertTrue(res.isError)
        assertTrue(res.text.contains("reference_image_base64"))
    }

    @Test fun dryRunStopsAtThresholdAndDoesNotApply() = runTest {
        val fake = FakeVision(listOf(0.9)) // ≥0.85 → stop after iter 1
        val res = tool(fake).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
            put("dry_run", true)
        })
        assertFalse(res.text, res.isError)
        val s = res.structured!!
        assertEquals(false, s.getBoolean("applied"))
        assertEquals(1, s.getJSONArray("iterations").length())
        assertEquals(0.9, s.getDouble("final_score"), 1e-6)
        assertEquals(1, fake.planCalls)
        assertEquals(1, fake.gradeCalls)
    }

    @Test fun appliedEmitsOneLoadPaintStateAndKeepsBestAcrossIterations() = runTest {
        // iter1 0.5 (<0.85 → refine), iter2 0.9 (≥0.85 → stop). Best = 0.9.
        val fake = FakeVision(listOf(0.5, 0.9))
        val support = ByteArray(bvh.triCount) { 2 }
        val seam = ByteArray(bvh.triCount) { 1 }
        ws.publishPlacedModels(listOf(
            ws.placedModels.value.first().copy(supportFlags = support, seamFlags = seam),
        ))
        val t = tool(fake)
        val action = captureNextAction {
            t.call(JSONObject().apply {
                put("model_id", modelId); put("reference_image_base64", refB64())
                put("max_iterations", 2)
            })
        }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(bvh.triCount, a.paintFilamentIndex!!.size)
        assertTrue("full coverage", a.paintFilamentIndex!!.none { it.toInt() == 0 })
        assertTrue(a.supportFlags!!.contentEquals(support))
        assertTrue(a.seamFlags!!.contentEquals(seam))
        assertEquals(2, fake.gradeCalls)
    }

    @Test fun monotonicKeepsBestWhenLaterIterationIsWorse() = runTest {
        // Never reaches threshold (0.99) → runs both iters; iter1=0.8
        // beats iter2=0.3, so the reported best is 0.8.
        val fake = FakeVision(listOf(0.8, 0.3))
        val res = tool(fake).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
            put("max_iterations", 2); put("score_threshold", 0.99); put("dry_run", true)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertEquals(2, s.getJSONArray("iterations").length())
        assertEquals(0.8, s.getDouble("final_score"), 1e-6)
    }

    @Test fun capabilityGateBlocksApply() = runTest {
        ws.publishWiredTierBCapabilities(emptySet())
        val res = tool(FakeVision(listOf(0.9))).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("LoadPaintState"))
    }

    @Test fun multipleModelsRequireExplicitId() = runTest {
        ws.publishPlacedModels(listOf(
            PlacedModel(id = "a", source = File("/dev/null"), label = "a"),
            PlacedModel(id = "b", source = File("/dev/null"), label = "b"),
        ))
        val res = tool(FakeVision(listOf(0.9))).call(JSONObject().apply {
            put("reference_image_base64", refB64())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id is required"))
    }

    @Test fun unusablePlanResponseErrorsClearly() = runTest {
        val fake = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> =
                Result.success(textResponse("not json at all"))
        }
        val res = tool(fake).call(JSONObject().apply {
            put("model_id", modelId); put("reference_image_base64", refB64())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("no usable paint plan"))
    }
}
