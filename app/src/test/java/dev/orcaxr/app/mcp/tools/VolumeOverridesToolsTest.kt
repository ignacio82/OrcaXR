package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.ModelVolumeType
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.PlacedVolume
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D16 — `set_volume_overrides` / `get_volume_overrides` MCP tools.
 * Pins the JSON ⇄ WorkspaceAction contract so a typo in the dispatcher
 * surfaces here. The actual JNI thread to `ModelVolume::config` is
 * exercised by the device-side test that slices a PARAMETER_MODIFIER
 * volume with a sparse_infill_density override.
 */
class VolumeOverridesToolsTest {

    private fun ws(volumes: List<PlacedVolume> = sampleVolumes()): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(
            PlacedModel(
                id = "m_test",
                source = File("/dev/null"),
                label = "test",
                volumes = volumes,
            ),
        ))
        return ws
    }

    private fun sampleVolumes(): List<PlacedVolume> = listOf(
        PlacedVolume(
            id = "v_modifier",
            source = File("/dev/null"),
            type = ModelVolumeType.PARAMETER_MODIFIER,
        ),
        PlacedVolume(
            id = "v_negative",
            source = File("/dev/null"),
            type = ModelVolumeType.NEGATIVE_VOLUME,
            configOverrides = mapOf("wall_loops" to "1"),
        ),
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

    // ---- set_volume_overrides ----

    @Test fun setEmitsActionWithOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetVolumeOverrides(w)
        val payload = JSONObject().apply {
            put("sparse_infill_density", "100")
            put("wall_loops", 4)
            put("enable_pressure_advance", true)
        }
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("volume_id", "v_modifier")
                put("overrides", payload)
            })
        }
        assertTrue(action is WorkspaceAction.SetVolumeOverrides)
        action as WorkspaceAction.SetVolumeOverrides
        assertEquals("m_test", action.modelId)
        assertEquals("v_modifier", action.volumeId)
        // Numeric / boolean values get coerced to libslic3r's string
        // wire format.
        assertEquals("100", action.overrides["sparse_infill_density"])
        assertEquals("4", action.overrides["wall_loops"])
        assertEquals("1", action.overrides["enable_pressure_advance"])
    }

    @Test fun setEmptyMapClears() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetVolumeOverrides(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("volume_id", "v_negative")
                put("overrides", JSONObject())
            })
        }
        action as WorkspaceAction.SetVolumeOverrides
        assertTrue(action.overrides.isEmpty())
    }

    @Test fun setRequiresOverridesObject() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("volume_id", "v_modifier")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("overrides"))
    }

    @Test fun setUnknownVolumeReturnsError() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("volume_id", "v_does_not_exist")
            put("overrides", JSONObject())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("v_does_not_exist"))
    }

    @Test fun setUnknownModelReturnsError() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "ghost")
            put("volume_id", "v_modifier")
            put("overrides", JSONObject())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("ghost"))
    }

    // ---- get_volume_overrides ----

    @Test fun getReturnsExistingOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.GetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("volume_id", "v_negative")
        })
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals("v_negative", body!!.optString("volume_id"))
        assertEquals("NEGATIVE_VOLUME", body.optString("type"))
        assertEquals(1, body.optInt("override_count"))
        val overrides = body.optJSONObject("overrides")
        assertNotNull(overrides)
        assertEquals("1", overrides!!.optString("wall_loops"))
    }

    @Test fun getReturnsEmptyMapForNoOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.GetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("volume_id", "v_modifier")
        })
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals(0, body!!.optInt("override_count"))
    }

    @Test fun getRejectsMissingArgs() = runTest {
        val w = ws()
        val tool = WorkspaceTools.GetVolumeOverrides(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertTrue(res.isError)
        assertTrue(res.text.contains("volume_id"))
    }
}
