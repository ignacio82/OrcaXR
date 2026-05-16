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
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class AutoPaintToolTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private lateinit var bvh: MeshBvh
    private val modelId = "m_auto"

    private fun cubeAt(cx: Float, cy: Float, cz: Float): FloatArray {
        val v = arrayOf(
            floatArrayOf(cx - 5, cy - 5, cz - 5), floatArrayOf(cx + 5, cy - 5, cz - 5),
            floatArrayOf(cx + 5, cy + 5, cz - 5), floatArrayOf(cx - 5, cy + 5, cz - 5),
            floatArrayOf(cx - 5, cy - 5, cz + 5), floatArrayOf(cx + 5, cy - 5, cz + 5),
            floatArrayOf(cx + 5, cy + 5, cz + 5), floatArrayOf(cx - 5, cy + 5, cz + 5),
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
        return pos
    }

    private fun bvhOf(pos: FloatArray): MeshBvh {
        val n = pos.size / 9
        var mnx = Float.POSITIVE_INFINITY; var mny = Float.POSITIVE_INFINITY; var mnz = Float.POSITIVE_INFINITY
        var mxx = Float.NEGATIVE_INFINITY; var mxy = Float.NEGATIVE_INFINITY; var mxz = Float.NEGATIVE_INFINITY
        var i = 0
        while (i < pos.size) {
            if (pos[i] < mnx) mnx = pos[i]; if (pos[i] > mxx) mxx = pos[i]
            if (pos[i + 1] < mny) mny = pos[i + 1]; if (pos[i + 1] > mxy) mxy = pos[i + 1]
            if (pos[i + 2] < mnz) mnz = pos[i + 2]; if (pos[i + 2] > mxz) mxz = pos[i + 2]
            i += 3
        }
        return MeshBvh.build(StlMesh(pos, n, Vec3f(mnx, mny, mnz), Vec3f(mxx, mxy, mxz)))
    }

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(id = modelId, source = File("/dev/null"), label = "auto cube")))
        bvh = bvhOf(cubeAt(0f, 0f, 0f))
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        ws.publishPreviewPalette(listOf("#FF0000", "#00FF00", "#0000FF", "#FFFF00"))
        session = AiSessionState()
    }

    private fun tool() = AutoPaintTool(ws, session)

    /** Opaque RGBA PNG (no alpha background). */
    private fun solidPng(w: Int, h: Int, r: Int, g: Int, b: Int): ByteArray {
        val rgba = ByteArray(w * h * 4)
        for (i in 0 until w * h) {
            val o = i * 4
            rgba[o] = r.toByte(); rgba[o + 1] = g.toByte(); rgba[o + 2] = b.toByte(); rgba[o + 3] = 255.toByte()
        }
        return PngWriter.encodeRgba(rgba, w, h)
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        @Suppress("OPT_IN_USAGE")
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun dryRunReturnsHistogramWithoutApplying() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("strategy", "height_bands"); put("dry_run", true)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertEquals(true, s.getBoolean("dry_run"))
        assertEquals(false, s.getBoolean("applied"))
        assertTrue(s.getJSONArray("per_slot_histogram").length() > 0)
        assertEquals("height_bands", s.getString("strategy"))
    }

    @Test fun appliedPathEmitsOneLoadPaintStateCarryingOtherChannels() = runTest {
        val support = ByteArray(bvh.triCount) { 1 }
        val seam = ByteArray(bvh.triCount) { 2 }
        val fuzzy = ByteArray(bvh.triCount) { 1 }
        ws.publishPlacedModels(listOf(
            ws.placedModels.value.first().copy(
                supportFlags = support, seamFlags = seam, fuzzySkinFlags = fuzzy,
            ),
        ))
        val t = tool()
        val action = captureNextAction {
            t.call(JSONObject().apply { put("model_id", modelId); put("strategy", "height_bands") })
        }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(modelId, a.modelId)
        assertEquals(bvh.triCount, a.paintFilamentIndex!!.size)
        assertTrue("full coverage", a.paintFilamentIndex!!.none { it.toInt() == 0 })
        // Other paint channels carried through untouched.
        assertTrue(a.supportFlags!!.contentEquals(support))
        assertTrue(a.seamFlags!!.contentEquals(seam))
        assertTrue(a.fuzzySkinFlags!!.contentEquals(fuzzy))
    }

    @Test fun capabilityGateBlocksWhenLoadPaintStateNotWired() = runTest {
        ws.publishWiredTierBCapabilities(emptySet())
        val res = tool().call(JSONObject().apply { put("model_id", modelId) })
        assertTrue(res.isError)
        assertTrue(res.text.contains("LoadPaintState"))
    }

    @Test fun recipeStrategyPointsToFindSimilarRecipe() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("strategy", "recipe")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("find_similar_recipe"))
        assertTrue(res.text.contains("paint_template"))
    }

    @Test fun fullSpectrumIsRejectedUntilGreen() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("use_full_spectrum", true)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("FullSpectrum"))
    }

    @Test fun unknownStrategyRejected() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("strategy", "nonsense")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("Unknown strategy"))
    }

    @Test fun modelIdOptionalWhenSingleModel() = runTest {
        val res = tool().call(JSONObject().apply {
            put("strategy", "height_bands"); put("dry_run", true)
        })
        assertFalse(res.isError)
        assertEquals(modelId, res.structured!!.getString("model_id"))
    }

    @Test fun multipleModelsRequireExplicitId() = runTest {
        ws.publishPlacedModels(listOf(
            PlacedModel(id = "a", source = File("/dev/null"), label = "a"),
            PlacedModel(id = "b", source = File("/dev/null"), label = "b"),
        ))
        val res = tool().call(JSONObject().apply { put("strategy", "height_bands") })
        assertTrue(res.isError)
        assertTrue(res.text.contains("model_id is required"))
    }

    @Test fun maxColorsCapsSlotsUsed() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("strategy", "height_bands")
            put("max_colors", 2); put("dry_run", true)
        })
        assertFalse(res.isError)
        val hist = res.structured!!.getJSONArray("per_slot_histogram")
        for (i in 0 until hist.length()) {
            assertTrue(hist.getJSONObject(i).getInt("slot") in 1..2)
        }
    }

    @Test fun componentsStrategyReportsTwoShells() = runTest {
        val two = bvhOf(cubeAt(0f, 0f, 0f) + cubeAt(100f, 0f, 0f))
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) two else null })
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("strategy", "components"); put("dry_run", true)
        })
        assertFalse(res.isError)
        assertEquals(2, res.structured!!.getInt("slots_used"))
    }

    // ---- M2 image mode ----

    @Test fun imageModeAutoCameraEmitsFullCoverageLoadPaintState() = runTest {
        // Pure-red opaque image; background_color set to a color the
        // image doesn't contain so the whole frame is foreground.
        val png = solidPng(48, 48, 255, 0, 0)
        val b64 = java.util.Base64.getEncoder().encodeToString(png)
        val t = tool()
        val action = captureNextAction {
            t.call(JSONObject().apply {
                put("model_id", modelId)
                put("image_base64", b64)
                put("background_color", "#00FF00")
            })
        }
        assertTrue(action is WorkspaceAction.LoadPaintState)
        val a = action as WorkspaceAction.LoadPaintState
        assertEquals(bvh.triCount, a.paintFilamentIndex!!.size)
        assertTrue("full coverage", a.paintFilamentIndex!!.none { it.toInt() == 0 })
        // Red → palette slot 1 (#FF0000). Whole model should be slot 1.
        assertTrue(a.paintFilamentIndex!!.all { it.toInt() == 1 })
    }

    @Test fun imageModeDryRunReportsImageModeAndCamera() = runTest {
        val png = solidPng(32, 32, 0, 0, 255) // blue
        val b64 = java.util.Base64.getEncoder().encodeToString(png)
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId)
            put("image_base64", b64)
            put("background_color", "#FF00FF")
            put("dry_run", true)
        })
        assertFalse(res.text, res.isError)
        val s = res.structured!!
        assertEquals("image", s.getString("mode"))
        assertEquals(false, s.getBoolean("applied"))
        assertTrue(s.getString("camera").startsWith("auto:"))
        assertTrue(s.getInt("covered_triangles") > 0)
    }

    @Test fun imageModeFullyTransparentImageErrorsClearly() = runTest {
        // Alpha 0 everywhere → no foreground at all.
        val rgba = ByteArray(16 * 16 * 4) // all zero incl. alpha
        val png = PngWriter.encodeRgba(rgba, 16, 16)
        val b64 = java.util.Base64.getEncoder().encodeToString(png)
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("image_base64", b64)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("didn't cover") || res.text.contains("background"))
    }

    @Test fun imageModeBadBackgroundColorRejected() = runTest {
        val b64 = java.util.Base64.getEncoder().encodeToString(solidPng(8, 8, 1, 2, 3))
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("image_base64", b64); put("background_color", "nothex")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("background_color"))
    }

    @Test fun imageModeInvalidBase64Rejected() = runTest {
        val res = tool().call(JSONObject().apply {
            put("model_id", modelId); put("image_base64", "!!!not base64!!!")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("base64"))
    }
}
