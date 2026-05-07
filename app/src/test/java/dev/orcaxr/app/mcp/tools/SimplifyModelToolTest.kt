package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D17 — `simplify_model` MCP tool. Native simplification is exercised
 * by an on-device instrumented test; this suite validates the tool's
 * arg parsing + WorkspaceAction emission so a typo in the dispatcher
 * surfaces here instead of as a silent no-op on a real headset.
 */
class SimplifyModelToolTest {

    private fun emptyWs(): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        // Audit H10 — the SimplifyModel tool gates on the matching
        // TierBCapability. Publish it here so the requireCapability
        // pre-flight passes and the action emits as expected. A real
        // host activity would publish via BindWorkspaceModel.
        ws.publishWiredTierBCapabilities(setOf(TierBCapability.SimplifyModel))
        ws.publishPlacedModels(listOf(PlacedModel(
            id = "m_test", source = File("/dev/null"), label = "test",
        )))
        return ws
    }

    private suspend fun captureNextAction(
        ws: WorkspaceModel,
        block: suspend () -> Unit,
    ): WorkspaceAction {
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun emitsSimplifyModelAction() = runTest {
        val ws = emptyWs()
        val tool = WorkspaceTools.SimplifyModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("target_triangle_count", 200)
                put("max_error", 0.05)
            })
        }
        assertTrue(action is WorkspaceAction.SimplifyModel)
        action as WorkspaceAction.SimplifyModel
        assertEquals("m_test", action.modelId)
        assertEquals(200, action.targetTriangleCount)
        assertEquals(0.05f, action.maxError, 1e-6f)
    }

    @Test fun missingModelIdReturnsError() = runTest {
        val ws = emptyWs()
        val tool = WorkspaceTools.SimplifyModel(ws)
        val res = tool.call(JSONObject().apply {
            put("target_triangle_count", 100)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id"))
    }

    @Test fun unknownModelIdReturnsError() = runTest {
        val ws = emptyWs()
        val tool = WorkspaceTools.SimplifyModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "doesnt_exist")
            put("target_triangle_count", 100)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("doesnt_exist"))
    }

    @Test fun targetTriangleCountTooSmallReturnsError() = runTest {
        val ws = emptyWs()
        val tool = WorkspaceTools.SimplifyModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("target_triangle_count", 4)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("> 4"))
    }

    @Test fun missingMaxErrorDefaultsToZero() = runTest {
        val ws = emptyWs()
        val tool = WorkspaceTools.SimplifyModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("model_id", "m_test")
                put("target_triangle_count", 50)
            })
        }
        assertTrue(action is WorkspaceAction.SimplifyModel)
        assertEquals(0f, (action as WorkspaceAction.SimplifyModel).maxError, 1e-6f)
    }

    @Test fun unattachedWorkspaceReturnsError() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(false)
        val tool = WorkspaceTools.SimplifyModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("target_triangle_count", 100)
        })
        assertTrue(res.isError)
    }
}
