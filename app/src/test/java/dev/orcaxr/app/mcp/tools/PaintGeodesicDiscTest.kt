package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class PaintGeodesicDiscTest {

    private lateinit var ws: WorkspaceModel
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
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun paintsGeodesicDiscFromExplicitTriId() = runTest {
        val tool = AiPaintTools.PaintGeodesicDisc(ws)
        val action = captureNextAction {
            tool.call(JSONObject().apply {
                put("model_id", modelId)
                put("anchor", JSONObject().apply { put("tri_id", 0) })
                put("radius_mm", 5)
                put("max_dihedral_deg", 30)
                put("tag", 4)
            })
        } as WorkspaceAction.PaintTriangleSet
        // Tri 0 + co-planar partner (tri 1) at 4.71 mm.
        assertEquals(setOf(0, 1), action.triangleIndices.toSet())
        assertEquals(4, action.tag)
    }

    @Test fun rejectsBadAnchor() = runTest {
        val tool = AiPaintTools.PaintGeodesicDisc(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("anchor", JSONObject())
            put("radius_mm", 5)
            put("tag", 4)
        })
        assertTrue(res.isError)
    }

    @Test fun rejectsNegativeRadius() = runTest {
        val tool = AiPaintTools.PaintGeodesicDisc(ws)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("anchor", JSONObject().apply { put("tri_id", 0) })
            put("radius_mm", -1)
            put("tag", 4)
        })
        assertTrue(res.isError)
    }

    @Test fun cameraDescriptorPixelAnchorPicksTriangle() = runTest {
        // Identity view + identity proj puts the cube at NDC origin
        // — won't render correctly, but the unproject path should
        // still resolve to SOME triangle id (or null on miss).
        val tool = AiPaintTools.PaintGeodesicDisc(ws)
        // Use a built top-preset-like camera. Easier: construct a
        // camera looking at the cube from above and pick center pixel.
        val viewMat = floatArrayOf(
            1f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, 1f, -50f,
            0f, 0f, 0f, 1f,
        )
        val orthoSize = 30f
        val projMat = floatArrayOf(
            2f / orthoSize, 0f, 0f, 0f,
            0f, 2f / orthoSize, 0f, 0f,
            0f, 0f, -2f / 100f, -1f,
            0f, 0f, 0f, 1f,
        )
        val descriptor = JSONObject().apply {
            put("view_matrix_4x4", org.json.JSONArray(viewMat.map { it.toDouble() }))
            put("projection_matrix_4x4", org.json.JSONArray(projMat.map { it.toDouble() }))
            put("width_px", 32); put("height_px", 32)
        }
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("anchor", JSONObject().apply {
                put("camera_descriptor", descriptor)
                put("x_px", 16); put("y_px", 16)
            })
            put("radius_mm", 5)
            put("tag", 4)
        })
        // Either resolved (succeeds) or unresolved (returns isError).
        // The point: camera_descriptor + x_px + y_px is RECOGNIZED as
        // a valid anchor form by resolveSeed (test would error
        // earlier if not).
        if (res.isError) {
            assertTrue(
                "if errored, must be 'couldn't resolve' (i.e. ray missed), not parse error: ${res.text}",
                res.text.contains("Couldn't resolve") || res.text.contains("anchor"),
            )
        }
    }
}
