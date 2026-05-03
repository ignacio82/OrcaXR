package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D19a + D19d — vision-LLM driven 2D mask tools. Tests inject a fake
 * `VisionApiClient` so no network calls are made and the parser /
 * projection logic is exercised end-to-end.
 */
class AiVisionMaskToolsTest {

    private fun cube(): MeshBvh {
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

    private fun setupWs(modelId: String): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test cube",
        )))
        val bvh = cube()
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id -> if (id == modelId) bvh else null })
        return ws
    }

    private fun fakePolygons(vararg polys: FloatArray): JSONObject = JSONObject().apply {
        put("content", JSONArray().apply {
            put(JSONObject().apply {
                put("type", "text")
                val poly = JSONObject().apply {
                    put("polygons", JSONArray().apply {
                        for (p in polys) put(JSONArray().apply {
                            for (v in p) put(v.toDouble())
                        })
                    })
                }
                put("text", poly.toString())
            })
        })
    }

    // ---- generate_mask_from_point (D19a) ----

    @Test fun generateMaskFromPointFailsWithoutApiKey() = runTest {
        val ws = setupWs("m_test")
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf(null),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 100); put("y_px", 100)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("API key"))
    }

    @Test fun generateMaskFromPointReturnsParsedPolygons() = runTest {
        val ws = setupWs("m_test")
        val polygon = floatArrayOf(50f, 50f, 250f, 50f, 250f, 250f, 50f, 250f)
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(fakePolygons(polygon))
        }
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 150); put("y_px", 150)
            put("project_to_triangles", false)
        })
        assertFalse("expected ok, got: ${res.text}", res.isError)
        val s = res.structured!!
        assertEquals(1, s.getInt("polygon_count"))
        val polys = s.getJSONArray("polygons")
        assertEquals(1, polys.length())
        val first = polys.getJSONArray(0)
        assertEquals(8, first.length())
        // Camera descriptor is included so caller can chain into
        // paint_projected_mask.
        assertNotNull(s.getJSONObject("camera_descriptor"))
    }

    @Test fun generateMaskFromPointWithProjectionReturnsTriangleCount() = runTest {
        val ws = setupWs("m_test")
        // Polygon over the camera's central region — should hit the
        // cube and project some triangles.
        val polygon = floatArrayOf(100f, 100f, 400f, 100f, 400f, 400f, 100f, 400f)
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(fakePolygons(polygon))
        }
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 256); put("y_px", 256)
            put("project_to_triangles", true)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertTrue("triangle_indices_count present", s.has("triangle_indices_count"))
        val tc = s.getInt("triangle_indices_count")
        assertTrue("expected at least 1 triangle hit, got $tc", tc >= 1)
    }

    @Test fun generateMaskFromPointHandlesMarkdownFences() = runTest {
        val ws = setupWs("m_test")
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) = Result.success(
                JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", "```json\n{\"polygons\":[[10,10,40,10,40,40,10,40]]}\n```")
                        })
                    })
                }
            )
        }
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 25); put("y_px", 25)
            put("project_to_triangles", false)
        })
        assertFalse(res.isError)
        assertEquals(1, res.structured!!.getInt("polygon_count"))
    }

    @Test fun generateMaskFromPointApiFailureSurfacesError() = runTest {
        val ws = setupWs("m_test")
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf("fake-key"),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("HTTP 401: invalid key"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 100); put("y_px", 100)
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("invalid key"))
    }

    @Test fun generateMaskFromPointPixelOutOfRangeFails() = runTest {
        val ws = setupWs("m_test")
        val tool = AiVisionMaskTools.GenerateMaskFromPoint(
            ws, AiSessionState(), flowOf("fake-key"),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("x_px", 9999); put("y_px", 9999)
        })
        assertTrue(res.isError)
        assertTrue(res.text.lowercase().contains("outside"))
    }

    // ---- get_mask_for_text (D19d) ----

    @Test fun getMaskForTextRequiresQuery() = runTest {
        val ws = setupWs("m_test")
        val tool = AiVisionMaskTools.GetMaskForText(
            ws, AiSessionState(), flowOf("fake-key"),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply { put("model_id", "m_test") })
        assertTrue(res.isError)
        assertTrue(res.text.contains("query"))
    }

    @Test fun getMaskForTextReturnsParsedPolygons() = runTest {
        val ws = setupWs("m_test")
        val polygon = floatArrayOf(100f, 100f, 200f, 100f, 200f, 200f, 100f, 200f)
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(fakePolygons(polygon))
        }
        val tool = AiVisionMaskTools.GetMaskForText(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("query", "the front face")
            put("project_to_triangles", false)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertEquals("the front face", s.getString("query"))
        assertEquals(1, s.getInt("polygon_count"))
    }

    @Test fun getMaskForTextHandlesEmptyPolygonList() = runTest {
        val ws = setupWs("m_test")
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", """{"polygons": []}""")
                        })
                    })
                })
        }
        val tool = AiVisionMaskTools.GetMaskForText(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("query", "the unicorn horn")
            put("project_to_triangles", true)
        })
        // Empty polygons is a valid result (the LLM can't see the
        // queried feature) — must NOT be an error.
        assertFalse("empty polygons must be ok, got error: ${res.text}", res.isError)
        val s = res.structured!!
        assertEquals(0, s.getInt("polygon_count"))
        assertEquals(0, s.getInt("triangle_indices_count"))
    }

    @Test fun getMaskForTextWithProjectionReturnsTriangleCount() = runTest {
        val ws = setupWs("m_test")
        val polygon = floatArrayOf(100f, 100f, 400f, 100f, 400f, 400f, 100f, 400f)
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(fakePolygons(polygon))
        }
        val tool = AiVisionMaskTools.GetMaskForText(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("query", "the cube top")
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertTrue("triangle_indices_count present", s.has("triangle_indices_count"))
    }

    @Test fun getMaskForTextMalformedPolygonReturnsClearError() = runTest {
        val ws = setupWs("m_test")
        // Odd-length polygon — should fail validation.
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject) =
                Result.success(JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", """{"polygons":[[1,2,3]]}""")  // 3 floats — invalid
                        })
                    })
                })
        }
        val tool = AiVisionMaskTools.GetMaskForText(
            ws, AiSessionState(), flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test"); put("query", "anything")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("malformed"))
    }
}
