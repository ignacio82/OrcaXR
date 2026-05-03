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
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class PaintWithMirrorTest {

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
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
    }

    private suspend fun captureNActions(n: Int, block: suspend () -> Unit): List<WorkspaceAction> {
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.take(n).toList()
        }
        block()
        repeat(8) { yield() }
        return collected.await()
    }

    @Test fun paintSphereMirrorEmitsTwoActions() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val actions = captureNActions(2) {
            tool.call(JSONObject().apply {
                put("axis", "x")
                put("inner", JSONObject().apply {
                    put("tool", "paint_sphere")
                    put("arguments", JSONObject().apply {
                        put("model_id", modelId)
                        // Sphere centered at +X face, radius small
                        // enough that mirror pass paints the -X face only.
                        put("center", JSONObject().apply {
                            put("x", 5); put("y", 0); put("z", 0)
                        })
                        put("radius_mm", 4)
                        put("tag", 4)
                    })
                })
            })
        }
        assertEquals(2, actions.size)
        val a = actions[0] as WorkspaceAction.PaintTriangleSet
        val b = actions[1] as WorkspaceAction.PaintTriangleSet
        // Pass A hits +X face tris; pass B hits -X face tris. The two
        // sets should be disjoint (cube +X and -X faces are
        // structurally symmetric across X axis).
        val setA = a.triangleIndices.toSet()
        val setB = b.triangleIndices.toSet()
        assertNotEquals("a and b should differ", setA, setB)
        // Both should be non-empty.
        assertTrue(setA.isNotEmpty())
        assertTrue(setB.isNotEmpty())
        // Same tag.
        assertEquals(4, a.tag)
        assertEquals(4, b.tag)
    }

    @Test fun paintNormalConeMirrorFlipsDirection() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val actions = captureNActions(2) {
            tool.call(JSONObject().apply {
                put("axis", "z")
                put("inner", JSONObject().apply {
                    put("tool", "paint_normal_cone")
                    put("arguments", JSONObject().apply {
                        put("model_id", modelId)
                        // Direction +Z, narrow cone — pass A paints
                        // top tris (face 2, 3); mirror flips Z so
                        // pass B paints bottom (face 0, 1).
                        put("direction", JSONObject().apply {
                            put("x", 0); put("y", 0); put("z", 1)
                        })
                        put("half_angle_deg", 20)
                        put("tag", 1)
                    })
                })
            })
        }
        assertEquals(2, actions.size)
        val a = (actions[0] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        val b = (actions[1] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        // Pass A: +Z face = tris 2, 3. Pass B: -Z face = tris 0, 1.
        assertEquals(setOf(2, 3), a)
        assertEquals(setOf(0, 1), b)
    }

    @Test fun paintSlabMirrorOnMatchingAxisFlipsRange() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val actions = captureNActions(2) {
            tool.call(JSONObject().apply {
                put("axis", "z")
                put("inner", JSONObject().apply {
                    put("tool", "paint_slab")
                    put("arguments", JSONObject().apply {
                        put("model_id", modelId)
                        put("axis", "z")
                        // Top half of cube (z 1..10).
                        put("min_mm", 1)
                        put("max_mm", 10)
                        put("tag", 1)
                    })
                })
            })
        }
        assertEquals(2, actions.size)
        val a = (actions[0] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        val b = (actions[1] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        // Pass A: tris with centroid z ∈ [1, 10]. Pass B mirrors
        // around z=0 (cube bbox center) → z ∈ [-10, -1].
        assertTrue("pass A non-empty", a.isNotEmpty())
        assertTrue("pass B non-empty", b.isNotEmpty())
        assertNotEquals(a, b)
    }

    @Test fun paintGeodesicDiscMirrorWorksWithTriIdAnchor() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val actions = captureNActions(2) {
            tool.call(JSONObject().apply {
                put("axis", "z")
                put("inner", JSONObject().apply {
                    put("tool", "paint_geodesic_disc")
                    put("arguments", JSONObject().apply {
                        put("model_id", modelId)
                        // Tri 0 is on the -Z face. Mirror across z=0 →
                        // a tri on the +Z face.
                        put("anchor", JSONObject().apply { put("tri_id", 0) })
                        put("radius_mm", 4)
                        put("max_dihedral_deg", 30)
                        put("tag", 1)
                    })
                })
            })
        }
        assertEquals(2, actions.size)
        val a = (actions[0] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        val b = (actions[1] as WorkspaceAction.PaintTriangleSet).triangleIndices.toSet()
        // Pass A: -Z face (around tri 0). Pass B: +Z face — paints
        // tris 2 or 3 (the +Z face).
        assertTrue("a contains tri 0", a.contains(0))
        assertTrue("b contains a +Z face tri", b.contains(2) || b.contains(3))
    }

    @Test fun rejectsBadAxis() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val res = tool.call(JSONObject().apply {
            put("axis", "w")
            put("inner", JSONObject().apply {
                put("tool", "paint_sphere")
                put("arguments", JSONObject())
            })
        })
        assertTrue(res.isError)
    }

    @Test fun rejectsUnknownInnerTool() = runTest {
        val tool = AiPaintTools.PaintWithMirror(ws, AiPaintTools.all(ws).filter { it.name != "paint_with_mirror" })
        val res = tool.call(JSONObject().apply {
            put("axis", "x")
            put("inner", JSONObject().apply {
                put("tool", "nonexistent_paint")
                put("arguments", JSONObject().apply { put("model_id", modelId) })
            })
        })
        assertTrue(res.isError)
    }
}
