package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Drives the C9 milestone 1 AI paint MCP tools end-to-end through
 * their `call(args)` surface. Each tool is expected to:
 *  - Read the model + BVH from `WorkspaceModel`
 *  - Compute a triangle index set
 *  - Emit a [WorkspaceAction.PaintTriangleSet] on the singleton's
 *    actions flow
 *  - Return a structured tool result with painted_count + indices
 *
 * The harness installs a tiny in-memory model + BVH so the tests run
 * pure-JVM without MainActivity / Compose / disk.
 */
class AiPaintToolsTest {

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
        // Each test gets a fresh process-singleton via the public
        // constructor. The singleton's get() default still returns the
        // global instance, but tools accept a WorkspaceModel parameter
        // so we can hand them the local one.
        ws = WorkspaceModel()
        ws.setAttached(true)
        modelId = "m_test"
        val placed = PlacedModel(
            id = modelId,
            source = File("/dev/null"),  // never read — BvhProvider returns the precomputed BVH
            label = "test cube",
        )
        ws.publishPlacedModels(listOf(placed))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        val collected = kotlinx.coroutines.GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    // ---- paint_sphere ----

    @Test fun paintSphereEmitsTriangleSetAction() = runTest {
        val tool = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3)
            put("tag", 4)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(modelId, ts.modelId)
        assertEquals(WorkspaceAction.PaintKind.Color, ts.kind)
        assertEquals(4, ts.tag)
        assertEquals(WorkspaceAction.MergeMode.Replace, ts.mergeMode)
        assertEquals("expected the two +Z top tris", setOf(2, 3), ts.triangleIndices.toSet())
    }

    @Test fun paintSphereReportsTruncatedIndices() = runTest {
        val tool = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 0) })
            put("radius_mm", 100)
            put("tag", 4)
        }
        val res = tool.call(args)
        assertNotNull(res.structured)
        val s = res.structured!!
        assertEquals(12, s.getInt("triangle_count"))
        assertEquals(12, s.getInt("painted_count"))
        assertTrue(!s.getBoolean("truncated_indices"))
    }

    @Test fun paintSphereRejectsBadTag() = runTest {
        val tool = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3)
            put("tag", 99)  // > MAX_PAINT_SLOTS=32
        }
        val res = tool.call(args)
        assertTrue("expected isError=true for invalid tag", res.isError)
    }

    @Test fun paintSphereRejectsUnknownModel() = runTest {
        val tool = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", "nonexistent")
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 0) })
            put("radius_mm", 3)
            put("tag", 4)
        }
        val res = tool.call(args)
        assertTrue(res.isError)
    }

    // ---- paint_slab ----

    @Test fun paintSlabZAxisCentroidWorks() = runTest {
        val tool = AiPaintTools.PaintSlab(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("axis", "z")
            put("min_mm", 4)
            put("max_mm", 6)
            put("tag", 1)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals("expected +Z top tris", setOf(2, 3), ts.triangleIndices.toSet())
    }

    @Test fun paintSlabRejectsBadAxis() = runTest {
        val tool = AiPaintTools.PaintSlab(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("axis", "w")
            put("min_mm", 0)
            put("max_mm", 1)
            put("tag", 1)
        }
        assertTrue(tool.call(args).isError)
    }

    // ---- paint_normal_cone ----

    @Test fun paintNormalConePicksUnderside() = runTest {
        val tool = AiPaintTools.PaintNormalCone(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("direction", JSONObject().apply { put("x", 0); put("y", 0); put("z", -1) })
            put("half_angle_deg", 30)
            put("tag", 5)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(setOf(0, 1), ts.triangleIndices.toSet())
    }

    // ---- paint_surface_region ----

    @Test fun paintSurfaceRegionWorksFromExplicitTriId() = runTest {
        val tool = AiPaintTools.PaintSurfaceRegion(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("seed", JSONObject().apply { put("tri_id", 0) })
            put("max_dihedral_deg", 30)
            put("tag", 3)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals("co-planar -Z tris", setOf(0, 1), ts.triangleIndices.toSet())
    }

    @Test fun paintSurfaceRegionWorksFromCenterAndRayDir() = runTest {
        // Top-down ray from above the +Z face should hit a +Z tri.
        val tool = AiPaintTools.PaintSurfaceRegion(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("seed", JSONObject().apply {
                put("center_mm", JSONObject().apply { put("x", 0); put("y", 0); put("z", 50) })
                put("ray_dir", JSONObject().apply { put("x", 0); put("y", 0); put("z", -1) })
            })
            put("max_dihedral_deg", 30)
            put("tag", 3)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        // Co-planar top tris (faces 2, 3).
        assertEquals(setOf(2, 3), ts.triangleIndices.toSet())
    }

    // ---- paint_connected_component ----

    @Test fun paintConnectedComponentFillsCube() = runTest {
        val tool = AiPaintTools.PaintConnectedComponent(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("seed", JSONObject().apply { put("tri_id", 0) })
            put("tag", 7)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(12, ts.triangleIndices.size)
    }

    // ---- paint_triangle_list ----

    @Test fun paintTriangleListRoundTripsAndDedupes() = runTest {
        val tool = AiPaintTools.PaintTriangleList(ws)
        val ids = org.json.JSONArray().apply {
            put(0); put(1); put(2); put(2); put(99) // 99 is OOB
        }
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("triangle_ids", ids)
            put("tag", 4)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(setOf(0, 1, 2), ts.triangleIndices.toSet())
    }

    // ---- merge modes ----

    @Test fun mergeOnlyUnpaintedRequiresMergeArg() = runTest {
        val tool = AiPaintTools.PaintTriangleList(ws)
        val ids = org.json.JSONArray().apply { put(0); put(1) }
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("triangle_ids", ids)
            put("tag", 4)
            put("merge", "only_unpainted")
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(WorkspaceAction.MergeMode.OnlyUnpainted, ts.mergeMode)
    }

    @Test fun mergeOnlyTaggedReadsWhereTag() = runTest {
        val tool = AiPaintTools.PaintTriangleList(ws)
        val ids = org.json.JSONArray().apply { put(0); put(1) }
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("triangle_ids", ids)
            put("tag", 5)
            put("merge", "only_tagged")
            put("where_tag", 3)
        }
        val action = captureNextAction { tool.call(args) }
        val ts = action as WorkspaceAction.PaintTriangleSet
        assertEquals(WorkspaceAction.MergeMode.OnlyTagged, ts.mergeMode)
        assertEquals(3, ts.whereTag)
    }

    @Test fun toolsRefuseWhenNotAttached() = runTest {
        ws.setAttached(false)
        val tool = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 0) })
            put("radius_mm", 3)
            put("tag", 4)
        }
        val res = tool.call(args)
        assertTrue(res.isError)
    }
}
