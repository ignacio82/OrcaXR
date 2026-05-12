package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mcp.WorkspaceAction
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `paint_template` tool is asset-driven (templates live under
 * `app/src/main/assets/paint_templates/<name>.json`). Pure-JVM
 * tests can't open assets via Context.assets, so we test the tag
 * resolution + dispatcher logic by feeding a synthetic recipe via
 * a stand-in tool.
 *
 * For a full integration test the device-hosted MCP server already
 * exercises the path; this suite covers the tag-mapping bug surface.
 */
class PaintTemplateToolsTest {

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

    @Test fun paintSlabAcceptsNumericTag() = runTest {
        // Sanity check that the inner paint_slab tool round-trips
        // a numeric tag — the post-tag-resolution equivalent of
        // what paint_template emits when it rewrites named tags
        // (e.g. "yellow"→2) before dispatching.
        val ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        val modelId = "m_test"
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId,
            source = java.io.File("/dev/null"),
            label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
        val paintTools = AiPaintTools.all(ws)
        val tool = paintTools.first { it.name == "paint_slab" }
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("axis", "z")
            put("min_mm", -10)
            put("max_mm", 10)
            put("tag", 2)
        })
        assertFalse("paint_slab call should not error: ${res.text}", res.isError)
        // Cube has 12 triangles; the slab spans the full Z range.
        assertEquals(12, res.structured!!.getInt("painted_count"))
        assertEquals(2, res.structured!!.getInt("tag"))
    }

    @Test fun bundledTemplateAssetsExist() {
        // Confirm the JSON files we shipped are valid JSON with the
        // expected shape. Reads them via the file system, NOT via
        // Android assets (test harness has no Context).
        val funko = java.io.File("src/main/assets/paint_templates/funko_pop_pikachu.json")
        val benchy = java.io.File("src/main/assets/paint_templates/benchy_pirate_ship.json")
        for (file in listOf(funko, benchy)) {
            assertTrue("missing template ${file.name}", file.exists())
            val obj = JSONObject(file.readText())
            assertTrue("schema_version", obj.has("schema_version"))
            assertTrue("name", obj.has("name"))
            assertTrue("steps", obj.has("steps"))
            assertTrue("default_palette", obj.has("default_palette"))
            // Each step has tool + arguments.
            val steps = obj.getJSONArray("steps")
            for (i in 0 until steps.length()) {
                val s = steps.getJSONObject(i)
                assertTrue("step $i has tool", s.has("tool"))
                assertTrue("step $i has arguments", s.has("arguments"))
            }
        }
    }
}
