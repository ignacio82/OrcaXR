package dev.orcaxr.app.mobile

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.MixedFilamentEntry
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mcp.tools.FsPaintSupport
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Tests for [SmartPaintRunner.runWith] — the Context-free core both the
 * phone screen and the XR dialog call. Verifies the UI ⇄ MCP parity
 * dispatch (right tool, right args) without standing up Compose.
 */
class SmartPaintRunnerTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private lateinit var bvh: MeshBvh
    private val modelId = "mobile_loaded"

    private class FakeStore : FsPaintSupport.MixedRowStore {
        val rows = HashMap<String, List<MixedFilamentEntry>>()
        override suspend fun get(printerId: String) = rows[printerId].orEmpty()
        override suspend fun set(printerId: String, r: List<MixedFilamentEntry>) {
            rows[printerId] = r
        }
    }

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

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(id = modelId, source = File("/dev/null"), label = "m")))
        bvh = cube()
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        ws.publishPreviewPalette(listOf("#FF0000", "#00FF00", "#0000FF"))
        session = AiSessionState()
    }

    private suspend fun run(p: SmartPaintRunner.Params) = SmartPaintRunner.runWith(
        ws, session, FakeStore(), flowOf(null), p,
    )

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        @Suppress("OPT_IN_USAGE")
        val c = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return c.await()
    }

    @Test fun autoModeDryRunIsOkAndReportsSource() = runTest {
        val r = run(SmartPaintRunner.Params(mode = SmartPaintRunner.Mode.Auto, dryRun = true))
        assertTrue(r.message, r.ok)
        assertEquals(false, r.structured!!.getBoolean("applied"))
        assertTrue(r.structured!!.getString("source").isNotEmpty())
    }

    @Test fun heightBandsApplyEmitsOneLoadPaintState() = runTest {
        val action = captureNextAction {
            run(SmartPaintRunner.Params(mode = SmartPaintRunner.Mode.HeightBands, axis = "z"))
        }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(modelId, a.modelId)
        assertTrue("full coverage", a.paintFilamentIndex!!.none { it.toInt() == 0 })
    }

    @Test fun imageModeWithoutImageFailsClearly() = runTest {
        val r = run(SmartPaintRunner.Params(mode = SmartPaintRunner.Mode.Image))
        assertFalse(r.ok)
        assertTrue(r.message.contains("image"))
    }

    @Test fun referenceModeWithoutImageFailsClearly() = runTest {
        val r = run(SmartPaintRunner.Params(mode = SmartPaintRunner.Mode.Reference))
        assertFalse(r.ok)
        assertTrue(r.message.contains("reference image"))
    }

    // (Label / Reference network paths are covered hermetically by
    // AutoPaintLabelToolTest / AutoPaintReferenceToolTest with a fake
    // VisionApiClient; the runner only injects the production client,
    // so exercising them here would do real network I/O.)

    @Test fun modeEnumExposesImageAndKeyFlags() {
        assertTrue(SmartPaintRunner.Mode.Reference.needsImage)
        assertTrue(SmartPaintRunner.Mode.Reference.needsKey)
        assertFalse(SmartPaintRunner.Mode.Auto.needsImage)
        assertFalse(SmartPaintRunner.Mode.Auto.needsKey)
    }
}
