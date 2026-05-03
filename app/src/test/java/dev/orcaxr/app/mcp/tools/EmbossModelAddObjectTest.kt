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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D15 — `emboss_model` with `mode='add_object'` emits an
 * AddTextOrSvgObject action (host-less standalone primitive) instead
 * of an EmbossModel boolean. Validates the dispatch split + the
 * relaxed model_id requirement.
 */
class EmbossModelAddObjectTest {

    private fun ws(): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(PlacedModel(
            id = "m_host", source = File("/dev/null"), label = "host",
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

    @Test fun addObjectModeWithoutModelIdEmitsAddTextOrSvgObject() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            val res = tool.call(JSONObject().apply {
                put("kind", "text")
                put("text", "HELLO")
                put("size_mm", 5.0)
                put("depth_mm", 2.0)
                put("mode", "add_object")
            })
            assertTrue("expected ok, got: ${res.text}", !res.isError)
        }
        assertTrue(action is WorkspaceAction.AddTextOrSvgObject)
        action as WorkspaceAction.AddTextOrSvgObject
        assertEquals(5f, action.sizeMm, 1e-6f)
        assertEquals(2f, action.depthMm, 1e-6f)
        assertEquals(WorkspaceAction.LoadMode.Add, action.loadMode)
        val src = action.source
        assertTrue(src is WorkspaceAction.EmbossSource.Text)
        assertEquals("HELLO", (src as WorkspaceAction.EmbossSource.Text).text)
    }

    @Test fun addObjectModeReplaceLoadMode() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("kind", "text"); put("text", "X")
                put("size_mm", 5.0); put("depth_mm", 2.0)
                put("mode", "add_object"); put("load_mode", "replace")
            })
        }
        action as WorkspaceAction.AddTextOrSvgObject
        assertEquals(WorkspaceAction.LoadMode.Replace, action.loadMode)
    }

    @Test fun emossModeStillRequiresModelId() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val res = tool.call(JSONObject().apply {
            put("kind", "text"); put("text", "X")
            put("size_mm", 5.0); put("depth_mm", 2.0)
            put("mode", "emboss")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id"))
    }

    @Test fun emossModeRoutesToOldEmbossModelAction() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("model_id", "m_host")
                put("kind", "text"); put("text", "X")
                put("size_mm", 5.0); put("depth_mm", 2.0)
                put("mode", "emboss")
            })
        }
        assertTrue(action is WorkspaceAction.EmbossModel)
    }

    @Test fun addObjectIgnoresModelId() = runTest {
        // Even with model_id present, mode=add_object skips the boolean
        // and emits AddTextOrSvgObject.
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("model_id", "m_host")  // ignored when mode=add_object
                put("kind", "text"); put("text", "X")
                put("size_mm", 5.0); put("depth_mm", 2.0)
                put("mode", "add_object")
            })
        }
        assertTrue(action is WorkspaceAction.AddTextOrSvgObject)
    }

    @Test fun addObjectWithSvgKind() = runTest {
        // SVG file must exist for the path validation; create a temp.
        val svg = File.createTempFile("test_d15", ".svg")
        svg.deleteOnExit()
        svg.writeText("""<svg xmlns="http://www.w3.org/2000/svg"></svg>""")
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            tool.call(JSONObject().apply {
                put("kind", "svg"); put("svg_path", svg.absolutePath)
                put("size_mm", 20.0); put("depth_mm", 1.0)
                put("mode", "add_object")
            })
        }
        action as WorkspaceAction.AddTextOrSvgObject
        assertTrue(action.source is WorkspaceAction.EmbossSource.Svg)
    }
}
