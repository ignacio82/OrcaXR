package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class AiIntrospectionToolsTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var modelId: String

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
        modelId = "m_test"
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
    }

    @Test fun getModelGeometryReturnsBboxAndArea() = runTest {
        val tool = AiIntrospectionTools.GetModelGeometry(ws)
        val res = tool.call(JSONObject().apply { put("model_id", modelId) })
        assertNotNull(res.structured)
        val s = res.structured!!
        assertEquals(true, s.getBoolean("ok"))
        assertEquals(12, s.getInt("total_triangle_count"))
        val bbox = s.getJSONObject("bbox_centered_preview")
        assertEquals(-5.0, bbox.getDouble("x_min"), 1e-4)
        assertEquals(5.0, bbox.getDouble("x_max"), 1e-4)
        assertEquals(600.0, s.getDouble("surface_area_mm2"), 1.0)
        assertTrue(s.has("z_histogram"))
    }

    @Test fun getModelComponentsReturnsOneForCube() = runTest {
        val tool = AiIntrospectionTools.GetModelComponents(ws)
        val res = tool.call(JSONObject().apply { put("model_id", modelId) })
        val s = res.structured!!
        assertEquals(1, s.getInt("component_count"))
        val components = s.getJSONArray("components")
        assertEquals(12, components.getJSONObject(0).getInt("triangle_count"))
    }

    @Test fun faceOrientationToolGroupsCubeFaces() = runTest {
        val tool = AiIntrospectionTools.GetModelFaceOrientationSummary(ws)
        val res = tool.call(JSONObject().apply { put("model_id", modelId) })
        val buckets = res.structured!!.getJSONArray("buckets")
        assertEquals(7, buckets.length())  // 6 cardinal + diagonal
        var foundUp = false
        for (i in 0 until buckets.length()) {
            val b = buckets.getJSONObject(i)
            if (b.getString("name") == "up") {
                foundUp = true
                assertEquals(2, b.getInt("triangle_count"))
            }
        }
        assertTrue(foundUp)
    }

    @Test fun semanticRegionsToolReturnsRegions() = runTest {
        val tool = AiIntrospectionTools.GetModelSemanticRegions(ws)
        val res = tool.call(JSONObject().apply { put("model_id", modelId) })
        val s = res.structured!!
        // Cube produces 6 face regions.
        assertEquals(6, s.getInt("region_count"))
    }

    @Test fun toolsReturnErrorForUnknownModel() = runTest {
        val tool = AiIntrospectionTools.GetModelGeometry(ws)
        val res = tool.call(JSONObject().apply { put("model_id", "nope") })
        assertTrue(res.isError)
    }
}
