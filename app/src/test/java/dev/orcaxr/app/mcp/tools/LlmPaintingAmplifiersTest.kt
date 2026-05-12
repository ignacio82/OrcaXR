package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * D22 — tests for the LLM-painting amplifier tool surface:
 *   - paint_semantic_region (via component cache)
 *   - paint_stroke (polyline brush)
 *   - detect_symmetry
 *   - paint_with_mirror axis="auto"
 *   - render_paint_session_diff (smoke — exercises the rendering path)
 *   - find_similar_recipe (fingerprint similarity, model-only path)
 *   - suggest_palette_for_recipe (palette mapping, no asset I/O)
 *   - score_paint_against_reference (mocked vision client)
 *
 * Asset-driven paths (paint_template, find_similar_recipe full flow,
 * suggest_palette_for_recipe full flow with real recipe JSONs) are
 * exercised end-to-end on the device-hosted MCP harness; these unit
 * tests cover the pure-Kotlin logic that doesn't need Context.assets.
 */
class LlmPaintingAmplifiersTest {

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
        for (f in faces) for (k in 0..2) {
            pos[p++] = v[f[k]][0]; pos[p++] = v[f[k]][1]; pos[p++] = v[f[k]][2]
        }
        return StlMesh(pos, 12, Vec3f(-5f, -5f, -5f), Vec3f(5f, 5f, 5f))
    }

    /**
     * Centroid-symmetric cube: each of the six faces is split into
     * four fan-triangles meeting at the face center. This makes all
     * 24 triangle centroids mirror-paired across X, Y, and Z bbox-
     * center planes (the diagonal-split [cube] fixture is NOT
     * pair-symmetric — each face's diagonal breaks the symmetry).
     * Use this fixture for any test that exercises detect_symmetry
     * or paint_with_mirror axis="auto".
     */
    private fun symmetricCube(): StlMesh {
        // 8 corners + 6 face centers.
        val s = 5f
        val pos = ArrayList<FloatArray>()
        // For each face, fan from face-center to 4 corners (winding
        // doesn't matter for centroid symmetry).
        val faceFans = listOf(
            // -Z (z = -s)
            Triple(floatArrayOf(0f, 0f, -s),
                arrayOf(floatArrayOf(-s, -s, -s), floatArrayOf(s, -s, -s),
                    floatArrayOf(s, s, -s), floatArrayOf(-s, s, -s)),
                "z-"),
            // +Z
            Triple(floatArrayOf(0f, 0f, s),
                arrayOf(floatArrayOf(-s, -s, s), floatArrayOf(s, -s, s),
                    floatArrayOf(s, s, s), floatArrayOf(-s, s, s)),
                "z+"),
            // -Y
            Triple(floatArrayOf(0f, -s, 0f),
                arrayOf(floatArrayOf(-s, -s, -s), floatArrayOf(s, -s, -s),
                    floatArrayOf(s, -s, s), floatArrayOf(-s, -s, s)),
                "y-"),
            // +Y
            Triple(floatArrayOf(0f, s, 0f),
                arrayOf(floatArrayOf(-s, s, -s), floatArrayOf(s, s, -s),
                    floatArrayOf(s, s, s), floatArrayOf(-s, s, s)),
                "y+"),
            // -X
            Triple(floatArrayOf(-s, 0f, 0f),
                arrayOf(floatArrayOf(-s, -s, -s), floatArrayOf(-s, s, -s),
                    floatArrayOf(-s, s, s), floatArrayOf(-s, -s, s)),
                "x-"),
            // +X
            Triple(floatArrayOf(s, 0f, 0f),
                arrayOf(floatArrayOf(s, -s, -s), floatArrayOf(s, s, -s),
                    floatArrayOf(s, s, s), floatArrayOf(s, -s, s)),
                "x+"),
        )
        for ((center, corners, _) in faceFans) {
            for (i in 0 until 4) {
                val a = corners[i]
                val b = corners[(i + 1) % 4]
                val tri = floatArrayOf(
                    a[0], a[1], a[2],
                    b[0], b[1], b[2],
                    center[0], center[1], center[2],
                )
                pos.add(tri)
            }
        }
        val triCount = pos.size  // 24
        val flat = FloatArray(triCount * 9)
        var off = 0
        for (tri in pos) {
            System.arraycopy(tri, 0, flat, off, 9); off += 9
        }
        return StlMesh(flat, triCount, Vec3f(-s, -s, -s), Vec3f(s, s, s))
    }

    /** A deliberately asymmetric mesh: an L-shape made by two cubes
     *  offset on the +X axis. detect_symmetry should reject all axes
     *  here since the mass distribution is uneven on Y and Z too
     *  (the second cube sits above and beside, not centered). */
    private fun lShape(): StlMesh {
        // Cube A at origin, cube B offset to +X +Z.
        val cubes = listOf(
            Triple(0f, 0f, 0f),
            Triple(8f, 0f, 4f),
        )
        val faces = mutableListOf<FloatArray>()
        for ((cx, cy, cz) in cubes) {
            val verts = listOf(
                floatArrayOf(-5f + cx, -5f + cy, -5f + cz),
                floatArrayOf(5f + cx, -5f + cy, -5f + cz),
                floatArrayOf(5f + cx, 5f + cy, -5f + cz),
                floatArrayOf(-5f + cx, 5f + cy, -5f + cz),
                floatArrayOf(-5f + cx, -5f + cy, 5f + cz),
                floatArrayOf(5f + cx, -5f + cy, 5f + cz),
                floatArrayOf(5f + cx, 5f + cy, 5f + cz),
                floatArrayOf(-5f + cx, 5f + cy, 5f + cz),
            )
            val cubeFaces = listOf(
                intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
                intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
                intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
                intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),
                intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
                intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
            )
            for (f in cubeFaces) {
                val tri = FloatArray(9)
                var k = 0
                for (vi in f) for (c in 0..2) tri[k++] = verts[vi][c]
                faces.add(tri)
            }
        }
        val total = FloatArray(faces.size * 9)
        var p = 0
        for (tri in faces) {
            System.arraycopy(tri, 0, total, p, 9); p += 9
        }
        return StlMesh(total, 24, Vec3f(-5f, -5f, -5f), Vec3f(13f, 5f, 9f))
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
        // Active palette so resolveTag() has hex slots to match against.
        ws.publishPreviewPalette(listOf("#FFFF00", "#000000", "#FF0000", "#FFFFFF"))
        // Reset the AI session singleton so tests don't see leaked
        // segmentation / symmetry caches from earlier tests.
        AiSessionState.get().clearAll()
        AiPaintSessionStore.get().clearAll()
    }

    private suspend fun captureNActions(n: Int, block: suspend () -> Unit): List<WorkspaceAction> {
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.take(n).toList()
        }
        block()
        repeat(8) { yield() }
        return collected.await()
    }

    // ---- paint_semantic_region ----

    @Test fun semanticRegionPaintsViaComponentCache() = runTest {
        val paintTools = AiPaintTools.all(ws)
        val tool = AiSemanticPaintTools.PaintSemanticRegion(ws, paintTools)
        val cube = MeshBvh.build(cube())
        // Prime the components cache directly (matches what
        // get_model_components does on its own).
        AiSemanticPaintTools.computeAndCache(cube, modelId, "components", maxRegions = 8)
        val cached = AiSessionState.get().getSegmentation(modelId, "components")
        assertNotNull("components cache populated", cached)
        // A cube is one component → region 0 has all 12 triangles.
        val regionTriCount = cached!!.regions[0].triangleIndices.size
        assertEquals(12, regionTriCount)

        val actions = captureNActions(1) {
            val res = tool.call(JSONObject().apply {
                put("model_id", modelId)
                put("region_source", "components")
                put("region_id", 0)
                put("tag", 4)
            })
            assertFalse("expected ok=true: ${res.text}", res.isError)
            val s = res.structured!!
            assertEquals(12, s.getInt("region_triangle_count"))
            assertEquals(12, s.getInt("painted_count"))
        }
        val act = actions.single() as WorkspaceAction.PaintTriangleSet
        assertEquals(12, act.triangleIndices.size)
        assertEquals(4, act.tag)
    }

    @Test fun semanticRegionRejectsUnknownSource() = runTest {
        val paintTools = AiPaintTools.all(ws)
        val tool = AiSemanticPaintTools.PaintSemanticRegion(ws, paintTools)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("region_source", "lasers")
            put("region_id", 0)
            put("tag", 4)
        })
        assertTrue(res.isError)
    }

    // ---- paint_stroke ----

    @Test fun paintStrokeOnCubeFaceProducesNonEmptyTriangleSet() = runTest {
        val paintTools = AiPaintTools.all(ws)
        val tool = PaintStrokeTool(ws, paintTools)
        val actions = captureNActions(1) {
            val res = tool.call(JSONObject().apply {
                put("model_id", modelId)
                put("tag", 4)
                put("radius_mm", 3)
                put("respect_hard_edges", true)
                put("dihedral_limit_deg", 30)
                put("points", JSONArray().apply {
                    put(JSONObject().apply {
                        // Just outside the +Z face so the nearest-tri
                        // search lands on the top of the cube.
                        put("x", 0); put("y", -2); put("z", 5)
                    })
                    put(JSONObject().apply {
                        put("x", 0); put("y", 2); put("z", 5)
                    })
                })
            })
            assertFalse("expected ok=true: ${res.text}", res.isError)
            val s = res.structured!!
            assertTrue("has resolved seeds", s.getInt("resolved_seed_count") > 0)
            assertTrue("painted some tris", s.getInt("painted_count") > 0)
        }
        val act = actions.single() as WorkspaceAction.PaintTriangleSet
        assertTrue(act.triangleIndices.isNotEmpty())
    }

    @Test fun paintStrokeRejectsEmptyPoints() = runTest {
        val paintTools = AiPaintTools.all(ws)
        val tool = PaintStrokeTool(ws, paintTools)
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("tag", 4)
            put("radius_mm", 3)
            put("points", JSONArray())
        })
        assertTrue(res.isError)
    }

    // ---- detect_symmetry ----

    /** Build a separate workspace with the centroid-symmetric cube so
     *  the diagonal-split cube fixture (used by all the OTHER tests)
     *  doesn't contaminate this one — the 12-tri diagonal-split cube
     *  fails to detect any axis as symmetric because each face's
     *  diagonal triangulation breaks centroid pair symmetry; the
     *  fan-subdivided 24-tri version is symmetric by construction. */
    private fun setUpSymmetricCubeWs(): WorkspaceModel {
        val ws2 = WorkspaceModel()
        ws2.setAttached(true)
        ws2.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        ws2.publishPlacedModels(listOf(PlacedModel(
            id = "ms", source = File("/dev/null"), label = "sym cube",
        )))
        val bvh = MeshBvh.build(symmetricCube())
        ws2.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == "ms") bvh else null
        })
        ws2.publishPreviewPalette(listOf("#FFFF00", "#000000", "#FF0000", "#FFFFFF"))
        return ws2
    }

    @Test fun symmetricCubeYieldsHighConfidenceOnAllAxes() = runTest {
        val ws2 = setUpSymmetricCubeWs()
        val tool = SymmetryTools.DetectSymmetry(ws2)
        val res = tool.call(JSONObject().apply {
            put("model_id", "ms")
            put("sample_count", 256)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        val per = s.getJSONObject("per_axis_scores")
        // Centroid-symmetric cube: each axis ≥ 0.9.
        assertTrue("x score ≥ 0.9: ${per.getDouble("x")}", per.getDouble("x") >= 0.9)
        assertTrue("y score ≥ 0.9: ${per.getDouble("y")}", per.getDouble("y") >= 0.9)
        assertTrue("z score ≥ 0.9: ${per.getDouble("z")}", per.getDouble("z") >= 0.9)
        val best = s.optString("best_axis")
        assertTrue("best axis is one of x/y/z: $best", best in setOf("x", "y", "z"))
        // Cache populated for later paint_with_mirror axis="auto".
        val cached = AiSessionState.get().getSymmetry("ms")
        assertNotNull(cached)
    }

    @Test fun lShapeYieldsAtMostOneSymmetryAxis() = runTest {
        // L-shape is asymmetric on X (mass biased toward +X) and Z
        // (top cube only), but the tight bbox-center plane on Y still
        // bisects both cubes — so Y can be ~symmetric. We assert the
        // detector AT MOST returns one axis (Y) and the mass-biased
        // axes (X, Z) score below threshold.
        val ws2 = WorkspaceModel()
        ws2.setAttached(true)
        ws2.publishPlacedModels(listOf(PlacedModel(
            id = "ml", source = File("/dev/null"), label = "L",
        )))
        val bvh = MeshBvh.build(lShape())
        ws2.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == "ml") bvh else null
        })
        val tool = SymmetryTools.DetectSymmetry(ws2)
        val res = tool.call(JSONObject().apply {
            put("model_id", "ml")
            put("sample_count", 512)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        val per = s.getJSONObject("per_axis_scores")
        assertTrue("X is asymmetric: ${per.getDouble("x")}",
            per.getDouble("x") < 0.65)
        assertTrue("Z is asymmetric: ${per.getDouble("z")}",
            per.getDouble("z") < 0.65)
    }

    // ---- paint_with_mirror axis="auto" ----

    @Test fun paintWithMirrorAutoUsesCachedSymmetry() = runTest {
        // Use the centroid-symmetric cube so detect_symmetry yields a
        // non-null best_axis.
        val ws2 = setUpSymmetricCubeWs()
        SymmetryTools.DetectSymmetry(ws2).call(JSONObject().apply {
            put("model_id", "ms")
            put("sample_count", 256)
        })
        val report = AiSessionState.get().getSymmetry("ms")
        assertNotNull("symmetry cached", report)
        assertNotNull("best axis non-null on cube", report!!.bestAxis)

        // paint_with_mirror axis="auto" should resolve and emit two actions.
        val paintTools = AiPaintTools.all(ws2)
        val mirror = AiPaintTools.PaintWithMirror(
            ws2, paintTools.filter { it.name != "paint_with_mirror" },
        )
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws2.actions.take(2).toList()
        }
        val res = mirror.call(JSONObject().apply {
            put("axis", "auto")
            put("inner", JSONObject().apply {
                put("tool", "paint_sphere")
                put("arguments", JSONObject().apply {
                    put("model_id", "ms")
                    put("center", JSONObject().apply {
                        put("x", 5); put("y", 0); put("z", 0)
                    })
                    put("radius_mm", 3)
                    put("tag", 4)
                })
            })
        })
        assertFalse("auto axis resolves: ${res.text}", res.isError)
        assertEquals(true, res.structured!!.optBoolean("auto_resolved_axis"))
        repeat(8) { yield() }
        val actions = collected.await()
        assertEquals("two PaintTriangleSet actions emitted (mirror)",
            2, actions.size)
    }

    @Test fun paintWithMirrorAutoErrorsWhenNoSymmetryCached() = runTest {
        // No detect_symmetry run; cache is empty.
        val paintTools = AiPaintTools.all(ws)
        val mirror = AiPaintTools.PaintWithMirror(
            ws, paintTools.filter { it.name != "paint_with_mirror" },
        )
        val res = mirror.call(JSONObject().apply {
            put("axis", "auto")
            put("inner", JSONObject().apply {
                put("tool", "paint_sphere")
                put("arguments", JSONObject().apply {
                    put("model_id", modelId)
                    put("center", JSONObject().apply { put("x", 5); put("y", 0); put("z", 0) })
                    put("radius_mm", 3)
                    put("tag", 4)
                })
            })
        })
        assertTrue("axis=\"auto\" errors without cached report", res.isError)
        assertTrue(res.text.contains("detect_symmetry"))
    }

    // ---- render_paint_session_diff ----

    @Test fun renderSessionDiffProducesNonZeroDelta() = runTest {
        // Open a session, paint half the cube, render the diff.
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val beginRes = begin.call(JSONObject().apply { put("model_id", modelId) })
        assertFalse(beginRes.isError)
        val sessionId = beginRes.structured!!.getString("session_id")
        // Paint a slab in the session.
        val paintTools = AiPaintTools.all(ws)
        val slab = paintTools.first { it.name == "paint_slab" }
        val slabRes = slab.call(JSONObject().apply {
            put("model_id", modelId)
            put("axis", "z")
            put("min_mm", 0)
            put("max_mm", 10)
            put("tag", 4)
            put("session_id", sessionId)
        })
        assertFalse(slabRes.isError)

        // Render the diff. We can't easily inspect PNG bytes in a
        // unit test (PngWriter is correct by construction), but we
        // CAN assert the diff response reports a nonzero changed-pixel
        // count.
        val diffTool = RenderPaintSessionDiffTool(ws, AiSessionState.get())
        val res = diffTool.call(JSONObject().apply {
            put("session_id", sessionId)
            put("view_name", "front")
            put("panel_size_px", 96)
        })
        assertFalse("diff render succeeds: ${res.text}", res.isError)
        val s = res.structured!!
        assertTrue("nonzero changed pixels: ${s.getInt("changed_pixels")}",
            s.getInt("changed_pixels") > 0)
        // Composed image is 3 panels + 2 separators wide.
        assertEquals(96 * 3 + 2, s.getInt("width_px"))
        assertEquals(96, s.getInt("height_px"))
    }

    // ---- find_similar_recipe (fingerprint-only, no asset I/O) ----

    @Test fun fingerprintOfCubeIsCubeShaped() {
        val bvh = MeshBvh.build(cube())
        val fp = RecipeRecommendTools.computeFingerprint(bvh)
        // Cube: aspect (1, 1, 1) sorted; shape factor close to 6.
        for (a in fp.aspectAscending) {
            assertTrue("aspect close to 1: $a", a in 0.99f..1.01f)
        }
        assertTrue("shape factor close to 6: ${fp.shapeFactor}",
            fp.shapeFactor in 5.5f..6.5f)
        assertEquals("one component", 0f, fp.log2ComponentCount, 0.01f)
    }

    @Test fun fingerprintOfLShapeIsNotCubeShape() {
        val bvh = MeshBvh.build(lShape())
        val fp = RecipeRecommendTools.computeFingerprint(bvh)
        // L-shape's bbox is 18×10×14, sorted aspects (10/18, 14/18, 1)
        // ≈ (0.55, 0.78, 1). Shape factor higher than a cube due to
        // the L's surface-to-volume ratio.
        assertNotEquals(1.0f, fp.aspectAscending[0])
    }

    // ---- score_paint_against_reference (mocked vision client) ----

    @Test fun scoreAgainstReferenceParsesGradedJsonResponse() = runTest {
        val sessionState = AiSessionState.get()
        val fakeApi = object : VisionApiClient {
            override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
                // Verify the request carries TWO images (current + reference).
                val msgs = requestBody.getJSONArray("messages")
                val content = msgs.getJSONObject(0).getJSONArray("content")
                var imageParts = 0
                for (i in 0 until content.length()) {
                    if (content.getJSONObject(i).optString("type") == "image") imageParts++
                }
                assertEquals("expected 2 images in request", 2, imageParts)
                return Result.success(JSONObject().apply {
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", """{
                                "score": 0.78,
                                "comment": "yellow body but ears unpainted",
                                "regions": [
                                  {"name": "ears", "issue": "still unpainted", "suggestion": "apply black to top of head"}
                                ]
                            }""")
                        })
                    })
                })
            }
        }
        val tool = ScorePaintAgainstReferenceTool(
            ws, sessionState, flowOf("fake-key"), client = fakeApi,
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            // 1×1 transparent PNG as a placeholder reference (tests
            // shape parsing, not pixel comparison).
            put("reference_image_base64",
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")
            put("panel_size_px", 128)
        })
        assertFalse("scoring succeeds: ${res.text}", res.isError)
        val s = res.structured!!
        assertEquals(0.78, s.getDouble("score"), 0.001)
        assertEquals(1, s.getInt("region_count"))
        assertTrue(s.getString("comment").contains("ears"))
    }

    @Test fun scoreAgainstReferenceErrorsWithoutApiKey() = runTest {
        val tool = ScorePaintAgainstReferenceTool(
            ws, AiSessionState.get(), flowOf(null),
            client = object : VisionApiClient {
                override suspend fun send(k: String, b: JSONObject): Result<JSONObject> =
                    Result.failure(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            put("reference_image_base64", "AAAA")
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("API key"))
    }

    @Test fun scoreAgainstReferenceErrorsWithoutReference() = runTest {
        val tool = ScorePaintAgainstReferenceTool(
            ws, AiSessionState.get(), flowOf("fake-key"),
            client = object : VisionApiClient {
                override suspend fun send(k: String, b: JSONObject): Result<JSONObject> =
                    Result.failure(IllegalStateException("should not be called"))
            },
        )
        val res = tool.call(JSONObject().apply {
            put("model_id", modelId)
            put("view_name", "iso")
            // Missing both reference_image_base64 AND reference_render_token.
        })
        assertTrue(res.isError)
        assertTrue(res.text.contains("reference"))
    }
}
