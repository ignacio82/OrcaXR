package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import javax.imageio.ImageIO

class AiVisionToolsTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var session: AiSessionState
    private val modelId = "m_test"

    private fun cube(): StlMesh {
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
        for (f in faces) {
            for (k in 0 until 3) {
                pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
            }
        }
        return StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f))
    }

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        session = AiSessionState()
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
    }

    @Test fun listCameraPresetsReturnsBuiltinNames() = runTest {
        val tool = AiVisionTools.ListCameraPresets(ws)
        val res = tool.call(JSONObject().apply { put("model_id", modelId) })
        val s = res.structured!!
        val builtin = s.getJSONArray("builtin_presets")
        // 8 named presets in NAMED_PRESETS.
        assertEquals(8, builtin.length())
    }

    @Test fun renderViewProducesValidPng() = runTest {
        val tool = AiVisionTools.RenderView(ws, session)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            put("width_px", 64)
            put("height_px", 64)
            put("mode", "solid")
        })
        assertFalse("expected isError=false", res.isError)
        val s = res.structured!!
        assertTrue(s.has("render_token"))
        assertTrue(s.has("image_uri"))
        assertEquals(64, s.getInt("width_px"))
        // Token should now be retrievable from the session.
        val token = s.getString("render_token")
        val art = session.getArtifact(token)
        assertNotNull(art)
        // PNG bytes should decode.
        val img = ImageIO.read(java.io.ByteArrayInputStream(art!!.pngBytes))
        assertEquals(64, img.width)
    }

    @Test fun renderViewInlineEmitsImagePart() = runTest {
        val tool = AiVisionTools.RenderView(ws, session)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "front")
            put("width_px", 64)
            put("height_px", 64)
            put("mode", "solid")
            put("inline", true)
        })
        assertEquals(1, res.imageParts.size)
        assertEquals("image/png", res.imageParts[0].mediaType)
        // Base64 should be non-empty.
        assertTrue(res.imageParts[0].base64Data.length > 100)
    }

    @Test fun renderTriangleIdMapAndResolvePixelChain() = runTest {
        val renderTool = AiVisionTools.RenderTriangleIdMap(ws, session)
        val res = renderTool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "top")
            put("width_px", 32)
            put("height_px", 32)
        })
        assertFalse(res.isError)
        val token = res.structured!!.getString("render_token")
        // Find a pixel that's NOT background by inspecting the artifact.
        val art = session.getArtifact(token)!!
        val map = art.triangleIdMap!!
        val nonBgIdx = map.indexOfFirst { it >= 0 }
        assertTrue("expected at least one non-background pixel", nonBgIdx >= 0)
        val px = nonBgIdx % 32
        val py = nonBgIdx / 32

        val resolveTool = AiVisionTools.ResolveImagePixel(session)
        val resolved = resolveTool.call(JSONObject().apply {
            put("render_token", token)
            put("x_px", px); put("y_px", py)
        })
        val s = resolved.structured!!
        assertTrue(s.getBoolean("hit"))
        assertEquals(map[nonBgIdx], s.getInt("tri_id"))
    }

    @Test fun resolvePixelWithRadiusReturnsNearbyTris() = runTest {
        val renderTool = AiVisionTools.RenderTriangleIdMap(ws, session)
        val res = renderTool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "top")
            put("width_px", 32); put("height_px", 32)
        })
        val token = res.structured!!.getString("render_token")
        val art = session.getArtifact(token)!!
        // Find a non-background pixel.
        val nonBgIdx = art.triangleIdMap!!.indexOfFirst { it >= 0 }
        val px = nonBgIdx % 32
        val py = nonBgIdx / 32
        val resolved = AiVisionTools.ResolveImagePixel(session).call(JSONObject().apply {
            put("render_token", token)
            put("x_px", px); put("y_px", py)
            put("radius_px", 4)
        })
        assertFalse(resolved.isError)
        val s = resolved.structured!!
        assertTrue(s.has("nearby_tri_ids"))
        val arr = s.getJSONArray("nearby_tri_ids")
        assertTrue("expected at least 1 nearby tri", arr.length() >= 1)
        // Each entry has tri_id + pixel_count.
        val first = arr.getJSONObject(0)
        assertTrue(first.has("tri_id"))
        assertTrue(first.has("pixel_count"))
    }

    @Test fun resolvePixelOnBackgroundReturnsHitFalse() = runTest {
        val renderTool = AiVisionTools.RenderTriangleIdMap(ws, session)
        val res = renderTool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            put("width_px", 32)
            put("height_px", 32)
        })
        val token = res.structured!!.getString("render_token")
        // Pixel (0, 0) — far corner, should be background for a small
        // model.
        val resolved = AiVisionTools.ResolveImagePixel(session).call(JSONObject().apply {
            put("render_token", token)
            put("x_px", 0); put("y_px", 0)
        })
        val s = resolved.structured!!
        assertFalse(s.getBoolean("hit"))
    }

    @Test fun nameViewSavesAndIsRetrievable() = runTest {
        val view = (0 until 16).map { 0.0 }.toMutableList()
        for (i in 0 until 4) view[i * 4 + i] = 1.0
        val proj = view.toMutableList()
        val nameTool = AiVisionTools.NameView(ws, session)
        val descriptor = JSONObject().apply {
            put("view_matrix_4x4", org.json.JSONArray(view))
            put("projection_matrix_4x4", org.json.JSONArray(proj))
            put("width_px", 64); put("height_px", 64)
        }
        val res = nameTool.call(JSONObject().apply {
            put("name", "bow")
            put("camera_descriptor", descriptor)
        })
        assertFalse(res.isError)
        // Saved camera should now be retrievable in the session.
        assertNotNull(session.getCameraPreset("bow"))
        // Try to use the saved camera via render_view.
        val renderTool = AiVisionTools.RenderView(ws, session)
        val rendered = renderTool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "bow")
            put("width_px", 32); put("height_px", 32)
            put("mode", "solid")
        })
        assertFalse("rendered using saved view", rendered.isError)
    }

    @Test fun nameViewRejectsReservedNames() = runTest {
        val view = (0 until 16).map { 0.0 }.toMutableList()
        for (i in 0 until 4) view[i * 4 + i] = 1.0
        val descriptor = JSONObject().apply {
            put("view_matrix_4x4", org.json.JSONArray(view))
            put("projection_matrix_4x4", org.json.JSONArray(view))
            put("width_px", 64); put("height_px", 64)
        }
        val res = AiVisionTools.NameView(ws, session).call(JSONObject().apply {
            put("name", "iso")
            put("camera_descriptor", descriptor)
        })
        assertTrue(res.isError)
    }

    @Test fun renderCacheReturnsCacheHit() = runTest {
        val tool = AiVisionTools.RenderView(ws, session)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            put("width_px", 32); put("height_px", 32)
            put("mode", "solid")
        }
        val first = tool.call(args)
        val second = tool.call(args)
        assertEquals(false, first.structured!!.getBoolean("cache_hit"))
        assertEquals(true, second.structured!!.getBoolean("cache_hit"))
        assertEquals(
            first.structured!!.getString("render_token"),
            second.structured!!.getString("render_token"),
        )
    }
}
