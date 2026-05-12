package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A10 — MCP-tool surface for the adaptive / variable layer-height
 * pipeline (`compute_adaptive_layer_heights`,
 * `set_layer_height_profile`, `get_layer_height_profile`,
 * `clear_layer_height_profile`). The native compute path is exercised
 * separately by an instrumented test against a real model; this suite
 * pins the JSON ⇄ WorkspaceAction wire shape so a typo in the
 * dispatcher surfaces here.
 */
class AdaptiveLayerHeightToolsTest {

    private fun ws(model: PlacedModel = sampleModel()): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(model))
        return ws
    }

    private fun sampleModel(profile: FloatArray? = null) = PlacedModel(
        id = "m_test",
        source = File("/dev/null"),
        label = "test",
        layerHeightProfile = profile,
    )

    private suspend fun captureNextAction(
        ws: WorkspaceModel,
        block: suspend () -> Unit,
    ): WorkspaceAction {
        val collected = kotlinx.coroutines.GlobalScope.async(
            start = CoroutineStart.UNDISPATCHED,
        ) { ws.actions.first() }
        block()
        return collected.await()
    }

    // ---- compute_adaptive_layer_heights ----

    @Test fun computeEmitsActionWithDefaults() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ComputeAdaptiveLayerHeights(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply { put("model_id", "m_test") })
        }
        assertTrue(action is WorkspaceAction.ComputeAdaptiveLayerHeights)
        action as WorkspaceAction.ComputeAdaptiveLayerHeights
        assertEquals("m_test", action.modelId)
        assertEquals(0.5f, action.quality, 1e-6f)
        assertEquals(0, action.smoothingRadius)
        assertFalse(action.smoothingKeepMin)
    }

    @Test fun computeRespectsExplicitArgs() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ComputeAdaptiveLayerHeights(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("quality", 0.8)
                put("smoothing_radius", 5)
                put("smoothing_keep_min", true)
            })
        }
        action as WorkspaceAction.ComputeAdaptiveLayerHeights
        assertEquals(0.8f, action.quality, 1e-6f)
        assertEquals(5, action.smoothingRadius)
        assertTrue(action.smoothingKeepMin)
    }

    @Test fun computeRejectsOutOfRangeQuality() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ComputeAdaptiveLayerHeights(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("quality", 2.0)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("quality"))
    }

    @Test fun computeRejectsBadSmoothingRadius() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ComputeAdaptiveLayerHeights(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("smoothing_radius", 99)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("smoothing_radius"))
    }

    @Test fun computeUnknownModelReturnsError() = runTest {
        val w = ws()
        val tool = WorkspaceTools.ComputeAdaptiveLayerHeights(w)
        val res = tool.call(JSONObject().apply { put("model_id", "ghost") })
        assertTrue(res.isError)
        assertTrue(res.text.contains("ghost"))
    }

    // ---- set_layer_height_profile ----

    @Test fun setEmitsActionWithProfile() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetLayerHeightProfile(w)
        val pairs = JSONArray()
            .put(JSONObject().apply { put("z_mm", 0.0); put("h_mm", 0.20) })
            .put(JSONObject().apply { put("z_mm", 5.0); put("h_mm", 0.20) })
            .put(JSONObject().apply { put("z_mm", 5.0); put("h_mm", 0.12) })
            .put(JSONObject().apply { put("z_mm", 20.0); put("h_mm", 0.12) })
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("profile", pairs)
            })
        }
        assertTrue(action is WorkspaceAction.SetLayerHeightProfile)
        action as WorkspaceAction.SetLayerHeightProfile
        assertNotNull(action.profile)
        assertEquals(8, action.profile!!.size)
        // First and last (z, h) pair survives the round-trip.
        assertEquals(0f, action.profile[0])
        assertEquals(0.20f, action.profile[1])
        assertEquals(20f, action.profile[6])
        assertEquals(0.12f, action.profile[7])
    }

    @Test fun setEmptyProfileClears() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetLayerHeightProfile(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("profile", JSONArray())
            })
        }
        action as WorkspaceAction.SetLayerHeightProfile
        assertNull(action.profile)
    }

    @Test fun setRejectsTooFewEntries() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetLayerHeightProfile(w)
        // One entry isn't enough — the profile contract requires
        // at least two (z, h) pairs.
        val pairs = JSONArray().put(
            JSONObject().apply { put("z_mm", 0.0); put("h_mm", 0.20) },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("profile", pairs)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("≥ 2"))
    }

    @Test fun setRejectsNonMonotonicZ() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetLayerHeightProfile(w)
        val pairs = JSONArray()
            .put(JSONObject().apply { put("z_mm", 5.0); put("h_mm", 0.20) })
            .put(JSONObject().apply { put("z_mm", 1.0); put("h_mm", 0.20) }) // backward
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("profile", pairs)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("monotonically"))
    }

    @Test fun setRejectsNonPositiveH() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetLayerHeightProfile(w)
        val pairs = JSONArray()
            .put(JSONObject().apply { put("z_mm", 0.0); put("h_mm", 0.20) })
            .put(JSONObject().apply { put("z_mm", 5.0); put("h_mm", -0.05) })
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("profile", pairs)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("> 0"))
    }

    // ---- clear_layer_height_profile ----

    @Test fun clearEmitsNullProfileAction() = runTest {
        val w = ws(sampleModel(profile = floatArrayOf(0f, 0.2f, 5f, 0.2f)))
        val tool = WorkspaceTools.ClearLayerHeightProfile(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply { put("model_id", "m_test") })
        }
        assertTrue(action is WorkspaceAction.SetLayerHeightProfile)
        action as WorkspaceAction.SetLayerHeightProfile
        assertNull(action.profile)
        assertEquals("m_test", action.modelId)
    }

    // ---- get_layer_height_profile ----

    @Test fun getReturnsEmptyForNoProfile() = runTest {
        val w = ws()
        val tool = WorkspaceTools.GetLayerHeightProfile(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals(0, body!!.optInt("entry_count"))
        assertEquals(0, body.optJSONArray("profile")!!.length())
    }

    @Test fun getEncodesPairs() = runTest {
        val w = ws(sampleModel(profile = floatArrayOf(
            0f, 0.20f, 5f, 0.20f, 5f, 0.12f, 20f, 0.12f,
        )))
        val tool = WorkspaceTools.GetLayerHeightProfile(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        val body = res.structured
        assertNotNull(body)
        assertEquals(4, body!!.optInt("entry_count"))
        val arr = body.optJSONArray("profile")
        assertNotNull(arr)
        assertEquals(4, arr!!.length())
        val first = arr.getJSONObject(0)
        assertEquals(0.0, first.getDouble("z_mm"), 1e-6)
        assertEquals(0.20, first.getDouble("h_mm"), 1e-6)
        val last = arr.getJSONObject(3)
        assertEquals(20.0, last.getDouble("z_mm"), 1e-6)
        assertEquals(0.12, last.getDouble("h_mm"), 1e-6)
    }
}
