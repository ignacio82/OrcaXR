package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.PngWriter
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.Base64

class PaintDecalToolTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private lateinit var bvh: MeshBvh
    private val modelId = "m_decal"

    private fun bigCube(): MeshBvh {
        val v = arrayOf(
            floatArrayOf(-5f, -5f, -5f), floatArrayOf(5f, -5f, -5f),
            floatArrayOf(5f, 5f, -5f), floatArrayOf(-5f, 5f, -5f),
            floatArrayOf(-5f, -5f, 5f), floatArrayOf(5f, -5f, 5f),
            floatArrayOf(5f, 5f, 5f), floatArrayOf(-5f, 5f, 5f),
        )
        val faces = listOf(
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val pos = FloatArray(faces.size * 9)
        var p = 0
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return MeshBvh.build(StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f)))
    }

    private fun topCamera(): AiRenderEngine.CameraSpec {
        val bbox = AiIntrospection.Bbox(-5f, -5f, -5f, 5f, 5f, 5f)
        return AiRenderEngine.namedPreset("top", bbox, 32, 32)
    }

    private fun solidPng(w: Int, h: Int, r: Int, g: Int, b: Int, a: Int = 255): ByteArray {
        val rgba = ByteArray(w * h * 4)
        for (i in 0 until w * h) {
            val o = i * 4
            rgba[o] = r.toByte(); rgba[o + 1] = g.toByte(); rgba[o + 2] = b.toByte(); rgba[o + 3] = a.toByte()
        }
        return PngWriter.encodeRgba(rgba, w, h)
    }

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "decal cube",
        )))
        bvh = bigCube()
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        // Provide a workspace palette so tests can omit the explicit
        // palette arg if they want.
        ws.publishPreviewPalette(listOf("#FF0000", "#00FF00", "#0000FF"))
        session = AiSessionState()
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    private fun camDescriptor(): JSONObject {
        val cam = topCamera()
        return JSONObject().apply {
            put("view_matrix_4x4", JSONArray().apply {
                for (v in cam.viewMatrixRowMajor) put(v.toDouble())
            })
            put("projection_matrix_4x4", JSONArray().apply {
                for (v in cam.projMatrixRowMajor) put(v.toDouble())
            })
            put("width_px", cam.widthPx); put("height_px", cam.heightPx)
        }
    }

    @Test fun missingImageReturnsClearError() = runTest {
        val tool = PaintDecalTool(ws, session)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("image"))
    }

    @Test fun decalProjectionEmitsLoadPaintState() = runTest {
        val tool = PaintDecalTool(ws, session)
        val pngBytes = solidPng(32, 32, 255, 0, 0)
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
            put("palette", JSONArray().apply {
                put(JSONObject().apply { put("hex", "#FF0000"); put("slot", 1) })
                put(JSONObject().apply { put("hex", "#00FF00"); put("slot", 2) })
            })
        }
        val action = captureNextAction { tool.call(args) }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(modelId, a.modelId)
        assertNotNull(a.paintFilamentIndex)
        // Some triangle should be painted slot 1 (red).
        val slot1Count = a.paintFilamentIndex!!.count { it.toInt() == 1 }
        assertTrue("slot1=$slot1Count, expected > 0", slot1Count > 0)
    }

    @Test fun explicitPaletteOverridesWorkspacePalette() = runTest {
        val tool = PaintDecalTool(ws, session)
        val pngBytes = solidPng(32, 32, 0, 0, 255)  // pure blue
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
            put("palette", JSONArray().apply {
                put(JSONObject().apply { put("hex", "#0000FF"); put("slot", 7) })
            })
        }
        val res = tool.call(args)
        assertFalse(res.isError)
        val s = res.structured!!
        // Slot 7 should appear in the histogram (workspace palette
        // didn't even have slot 7 — verifies the explicit palette
        // arg is what drove the result).
        val hist = s.getJSONArray("per_slot_histogram")
        var found7 = false
        for (i in 0 until hist.length()) {
            if (hist.getJSONObject(i).getInt("slot") == 7) found7 = true
        }
        assertTrue("expected slot 7 in histogram", found7)
    }

    @Test fun noActivePixelsReturnsClearError() = runTest {
        val tool = PaintDecalTool(ws, session)
        // alpha=0 → all transparent.
        val pngBytes = solidPng(32, 32, 255, 0, 0, a = 0)
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("active pixels"))
    }

    @Test fun replaceExistingClearsBaseline() = runTest {
        // Set an existing paint state.
        val baseline = ByteArray(bvh.triCount) { 9 }
        ws.publishPlacedModels(listOf(
            ws.placedModels.value.first().copy(paintFilamentIndex = baseline),
        ))
        val tool = PaintDecalTool(ws, session)
        val pngBytes = solidPng(32, 32, 255, 0, 0)
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
            put("palette", JSONArray().apply {
                put(JSONObject().apply { put("hex", "#FF0000"); put("slot", 1) })
            })
            put("replace_existing", true)
        }
        val action = captureNextAction { tool.call(args) }
        val a = action as WorkspaceAction.LoadPaintState
        // After replace_existing, only triangles touched by the
        // decal should be slot 1; the rest should be 0 (NOT 9 from
        // the baseline).
        val anyNine = a.paintFilamentIndex!!.any { it.toInt() == 9 }
        assertFalse("replace_existing should wipe the slot=9 baseline", anyNine)
    }

    @Test fun missingPaletteWithoutWorkspacePaletteFails() = runTest {
        ws.publishPreviewPalette(emptyList())  // simulate a fresh workspace
        val tool = PaintDecalTool(ws, session)
        val pngBytes = solidPng(8, 8, 255, 0, 0)
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
        })
        assertTrue(res.isError)
        assertTrue(res.text.lowercase().contains("palette"))
    }

    @Test fun targetRectOutsideFrameFails() = runTest {
        val tool = PaintDecalTool(ws, session)
        val pngBytes = solidPng(8, 8, 255, 0, 0)
        val b64 = Base64.getEncoder().encodeToString(pngBytes)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("camera_descriptor", camDescriptor())
            put("image_base64", b64)
            put("target_rect", JSONObject().apply {
                put("x0", 0); put("y0", 0); put("x1", 1000); put("y1", 1000)
            })
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("outside camera frame"))
    }
}
