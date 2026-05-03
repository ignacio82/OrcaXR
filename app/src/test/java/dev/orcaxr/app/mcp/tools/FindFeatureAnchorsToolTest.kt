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

class FindFeatureAnchorsToolTest {

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
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f))
    }

    // The tool now takes a Flow<String?> for the API key directly,
    // so we don't need to subclass McpSettings.

    private fun setupWs(modelId: String): WorkspaceModel {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = java.io.File("/dev/null"), label = "test",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
        return ws
    }

    @Test fun missingApiKeyReturnsClearError() = runTest {
        val ws = setupWs("m_test")
        val session = AiSessionState()
        val tool = FindFeatureAnchorsTool(
            ws, session, flowOf(null),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("hint", "the eyes")
        })
        assertTrue(res.isError)
        assertTrue("error mentions API key", res.text.contains("API key"))
    }

    @Test fun fakeAnchorsFromApiResolveToTriIds() = runTest {
        val ws = setupWs("m_test")
        val session = AiSessionState()
        // Fake API client returns a Claude-shaped response with two
        // anchors at known image coords.
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
                return Result.success(JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", """{"anchors":[
                                {"name":"left_corner","x_px":100,"y_px":100,"confidence":0.92},
                                {"name":"right_corner","x_px":400,"y_px":400,"confidence":0.88}
                            ]}""")
                        })
                    })
                })
            }
        }
        val tool = FindFeatureAnchorsTool(
            ws, session, flowOf("fake-key"),
            client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("hint", "two corners of a cube")
            put("expected_count", 2)
        })
        assertFalse("expected ok=true: ${res.text}", res.isError)
        val s = res.structured!!
        assertEquals(2, s.getInt("returned_count"))
        val anchors = s.getJSONArray("anchors")
        assertEquals(2, anchors.length())
        // Both anchors should have at least pixel coords; tri_id may
        // be null if the pixel was background.
        for (i in 0 until anchors.length()) {
            val a = anchors.getJSONObject(i)
            assertTrue(a.has("x_px"))
            assertTrue(a.has("y_px"))
            assertTrue(a.has("hit"))
        }
    }

    @Test fun parsesAnchorsFromMarkdownFencedResponse() = runTest {
        val ws = setupWs("m_test")
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
                return Result.success(JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            // Some models wrap in markdown fences.
                            put("text", "```json\n{\"anchors\":[{\"name\":\"a\",\"x_px\":50,\"y_px\":50,\"confidence\":0.9}]}\n```")
                        })
                    })
                })
            }
        }
        val tool = FindFeatureAnchorsTool(
            ws, AiSessionState(), flowOf("fake-key"),
            client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("hint", "a corner")
        })
        assertFalse(res.isError)
        assertEquals(1, res.structured!!.getInt("returned_count"))
    }

    @Test fun apiFailureReturnsClearError() = runTest {
        val ws = setupWs("m_test")
        val tool = FindFeatureAnchorsTool(
            ws, AiSessionState(), flowOf("fake-key"),
            client = object : VisionApiClient {
                override suspend fun send(apiKey: String, requestBody: JSONObject) =
                    Result.failure<JSONObject>(IllegalStateException("HTTP 401: invalid key"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("hint", "anything")
        })
        assertTrue(res.isError)
        assertTrue("error message includes failure detail", res.text.contains("invalid key"))
    }

    @Test fun unknownViewNameReturnsClearError() = runTest {
        val ws = setupWs("m_test")
        val tool = FindFeatureAnchorsTool(
            ws, AiSessionState(), flowOf("fake-key"),
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", "m_test")
            put("hint", "anything")
            put("view_name", "nonexistent_preset")
        })
        assertTrue(res.isError)
        assertTrue("mentions view name", res.text.contains("view_name"))
    }
}
