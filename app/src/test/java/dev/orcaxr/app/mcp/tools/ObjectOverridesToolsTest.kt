package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PlacedModel
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
 * D9 — `get_object_overrides` / `set_object_overrides`. Pins the
 * JSON ⇄ WorkspaceAction contract for per-object configOverrides.
 * The actual JNI thread to `ModelObject::config` is exercised by the
 * device-side slice path that emits `mo->config.opt_serialize(...)`
 * onto `Metadata/model_settings.config` inside the saved 3MF.
 */
class ObjectOverridesToolsTest {

    private fun ws(overrides: Map<String, String> = emptyMap()): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(
            PlacedModel(
                id = "m_test",
                source = File("/dev/null"),
                label = "test",
                configOverrides = overrides,
            ),
        ))
        return ws
    }

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

    // ---- set_object_overrides ----

    @Test fun setEmitsActionWithOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetObjectOverrides(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("overrides", JSONObject().apply {
                    put("layer_height", "0.16")
                    put("wall_loops", 4)
                })
            })
        }
        assertTrue(action is WorkspaceAction.SetObjectOverrides)
        action as WorkspaceAction.SetObjectOverrides
        assertEquals("m_test", action.modelId)
        assertEquals("0.16", action.overrides["layer_height"])
        // Numeric values get coerced to libslic3r's string wire format.
        assertEquals("4", action.overrides["wall_loops"])
    }

    @Test fun setEmptyClears() = runTest {
        val w = ws(mapOf("layer_height" to "0.16"))
        val tool = WorkspaceTools.SetObjectOverrides(w)
        val action = captureNextAction(w) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("overrides", JSONObject())
            })
        }
        action as WorkspaceAction.SetObjectOverrides
        assertTrue(action.overrides.isEmpty())
    }

    @Test fun setRejectsMissingOverrides() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetObjectOverrides(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertTrue(res.isError)
        assertTrue(res.text.contains("overrides"))
    }

    @Test fun setUnknownModelReturnsError() = runTest {
        val w = ws()
        val tool = WorkspaceTools.SetObjectOverrides(w)
        val res = tool.call(JSONObject().apply {
            put("model_id", "ghost")
            put("overrides", JSONObject())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("ghost"))
    }

    // ---- get_object_overrides ----

    @Test fun getReturnsCurrentOverrides() = runTest {
        val w = ws(mapOf("layer_height" to "0.16", "wall_loops" to "4"))
        val tool = WorkspaceTools.GetObjectOverrides(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        val body = res.structured
        assertNotNull(body)
        assertEquals(2, body!!.optInt("override_count"))
        val ov = body.optJSONObject("overrides")
        assertEquals("0.16", ov!!.optString("layer_height"))
        assertEquals("4", ov.optString("wall_loops"))
    }

    @Test fun getReturnsEmptyMap() = runTest {
        val w = ws()
        val tool = WorkspaceTools.GetObjectOverrides(w)
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertFalse(res.isError)
        assertEquals(0, res.structured!!.optInt("override_count"))
    }
}
