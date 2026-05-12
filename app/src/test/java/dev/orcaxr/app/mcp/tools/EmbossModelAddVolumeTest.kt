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
 * Roadmap D15 (deferred-piece) — `emboss_model` with
 * `mode='add_volume'` emits an [WorkspaceAction.AddTextOrSvgVolume]
 * action, validates `volume_kind` and `model_id`, and routes the
 * volume through the same AddVolume codepath the file picker uses.
 */
class EmbossModelAddVolumeTest {

    private fun ws(): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPlacedModels(
            listOf(
                PlacedModel(
                    id = "m_host", source = File("/dev/null"), label = "host",
                ),
            ),
        )
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

    @Test fun addVolumeModeEmitsAddTextOrSvgVolume() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val action = captureNextAction(ws) {
            val res = tool.call(JSONObject().apply {
                put("model_id", "m_host")
                put("kind", "text")
                put("text", "EAT ME")
                put("size_mm", 5.0)
                put("depth_mm", 1.5)
                put("mode", "add_volume")
                put("volume_kind", "NEGATIVE_VOLUME")
            })
            assertTrue("expected ok, got: ${res.text}", !res.isError)
        }
        assertTrue(action is WorkspaceAction.AddTextOrSvgVolume)
        action as WorkspaceAction.AddTextOrSvgVolume
        assertEquals("m_host", action.modelId)
        assertEquals(5f, action.sizeMm, 1e-6f)
        assertEquals(1.5f, action.depthMm, 1e-6f)
        assertEquals("NEGATIVE_VOLUME", action.volumeType)
        val src = action.source
        assertTrue(src is WorkspaceAction.EmbossSource.Text)
        assertEquals("EAT ME", (src as WorkspaceAction.EmbossSource.Text).text)
    }

    @Test fun addVolumeWithoutModelIdErrors() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val res = tool.call(JSONObject().apply {
            put("kind", "text"); put("text", "X")
            put("size_mm", 5.0); put("depth_mm", 2.0)
            put("mode", "add_volume")
            put("volume_kind", "NEGATIVE_VOLUME")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id"))
    }

    @Test fun addVolumeWithoutVolumeKindErrors() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_host")
            put("kind", "text"); put("text", "X")
            put("size_mm", 5.0); put("depth_mm", 2.0)
            put("mode", "add_volume")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("volume_kind"))
    }

    @Test fun addVolumeRejectsUnknownVolumeKind() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_host")
            put("kind", "text"); put("text", "X")
            put("size_mm", 5.0); put("depth_mm", 2.0)
            put("mode", "add_volume")
            put("volume_kind", "GARBAGE")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("Unknown volume_kind"))
    }

    @Test fun addVolumeRejectsMissingHostModel() = runTest {
        val ws = ws()
        val tool = WorkspaceTools.EmbossModel(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_does_not_exist")
            put("kind", "text"); put("text", "X")
            put("size_mm", 5.0); put("depth_mm", 2.0)
            put("mode", "add_volume")
            put("volume_kind", "NEGATIVE_VOLUME")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("No model with id"))
    }

    @Test fun addVolumeAcceptsAllValidKinds() = runTest {
        val validKinds = listOf(
            "MODEL_PART",
            "NEGATIVE_VOLUME",
            "PARAMETER_MODIFIER",
            "SUPPORT_ENFORCER",
            "SUPPORT_BLOCKER",
        )
        for (kind in validKinds) {
            val ws = ws()
            val tool = WorkspaceTools.EmbossModel(ws)
            val action = captureNextAction(ws) {
                tool.call(JSONObject().apply {
                    put("model_id", "m_host")
                    put("kind", "text"); put("text", "X")
                    put("size_mm", 5.0); put("depth_mm", 2.0)
                    put("mode", "add_volume")
                    put("volume_kind", kind)
                })
            }
            assertTrue("expected AddTextOrSvgVolume for $kind, got $action",
                action is WorkspaceAction.AddTextOrSvgVolume)
            assertEquals(kind, (action as WorkspaceAction.AddTextOrSvgVolume).volumeType)
        }
    }
}
