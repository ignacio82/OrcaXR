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
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * End-to-end tests for the C9 milestone-4 headless paint session
 * surface: begin, paint inside a session, render the session,
 * commit (one LoadPaintState emission), discard, list, diff.
 */
class PaintSessionToolsTest {

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
        modelId = "m_test"
        val placed = PlacedModel(
            id = modelId,
            source = File("/dev/null"),
            label = "test cube",
        )
        ws.publishPlacedModels(listOf(placed))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
        // Reset the session store between tests — it's a process
        // singleton.
        AiPaintSessionStore.get().clearAll()
    }

    @After fun tearDown() {
        AiPaintSessionStore.get().clearAll()
    }

    // ---- begin ----

    @Test fun beginPaintSessionReturnsSessionId() = runTest {
        val tool = PaintSessionTools.BeginPaintSession(ws)
        val res = tool.call(JSONObject().put("model_id", modelId))
        assertFalse(res.isError)
        val s = res.structured!!
        val sessionId = s.optString("session_id")
        assertTrue("session_id non-empty", sessionId.isNotEmpty())
        assertEquals(modelId, s.optString("model_id"))
        assertEquals(12, s.optInt("tri_count"))
        assertNotNull(AiPaintSessionStore.get().get(sessionId))
    }

    @Test fun beginRefusesUnknownModel() = runTest {
        val tool = PaintSessionTools.BeginPaintSession(ws)
        val res = tool.call(JSONObject().put("model_id", "nope"))
        assertTrue(res.isError)
    }

    // ---- session-aware paint ----

    @Test fun sessionAwarePaintDoesNotEmitWorkspaceAction() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val openRes = begin.call(JSONObject().put("model_id", modelId))
        val sessionId = openRes.structured!!.getString("session_id")
        // Start a collector that times out — we EXPECT no emission.
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            withTimeoutOrNull(50) { ws.actions.first() }
        }
        val sphere = AiPaintTools.PaintSphere(ws)
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3)
            put("tag", 4)
            put("session_id", sessionId)
        }
        val res = sphere.call(args)
        assertFalse(res.isError)
        assertEquals(sessionId, res.structured!!.optString("session_id"))
        assertEquals(2, res.structured!!.getInt("painted_count"))  // top two tris
        // Live path emission MUST be absent.
        val maybeAction = collected.await()
        assertNull("no WorkspaceAction emitted on session paint", maybeAction)
        // Session paint reflects the change.
        val session = AiPaintSessionStore.get().get(sessionId)!!
        val arr = session.paintFilamentIndex!!
        assertEquals(4, arr[2].toInt())
        assertEquals(4, arr[3].toInt())
    }

    @Test fun chainedSessionPaintAccumulates() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val openRes = begin.call(JSONObject().put("model_id", modelId))
        val sessionId = openRes.structured!!.getString("session_id")
        val sphere = AiPaintTools.PaintSphere(ws)
        // Paint top with tag 4.
        sphere.call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3); put("tag", 4); put("session_id", sessionId)
        })
        // Paint bottom with tag 7.
        sphere.call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", -5) })
            put("radius_mm", 3); put("tag", 7); put("session_id", sessionId)
        })
        val session = AiPaintSessionStore.get().get(sessionId)!!
        // Cube's tris 0..1 are bottom (-Z), 2..3 are top (+Z) per fixture.
        val arr = session.paintFilamentIndex!!
        assertEquals(7, arr[0].toInt())
        assertEquals(7, arr[1].toInt())
        assertEquals(4, arr[2].toInt())
        assertEquals(4, arr[3].toInt())
        assertEquals(2, session.totalActions)
    }

    @Test fun sessionPaintRespectsOnlyUnpainted() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val openRes = begin.call(JSONObject().put("model_id", modelId))
        val sessionId = openRes.structured!!.getString("session_id")
        val sphere = AiPaintTools.PaintSphere(ws)
        // First flood top with tag=4.
        sphere.call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 100); put("tag", 4); put("session_id", sessionId)
        })
        // Now try to paint everything with tag=2 only_unpainted —
        // already-painted tris should be skipped.
        val res = sphere.call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 0) })
            put("radius_mm", 100); put("tag", 2); put("session_id", sessionId)
            put("merge", "only_unpainted")
        })
        // Cube has 12 tris; first call painted them all (radius 100
        // covers the whole cube), so only_unpainted now matches 0.
        assertEquals(0, res.structured!!.getInt("painted_count"))
    }

    // ---- session diff + list ----

    @Test fun diffShowsCoverageHistogram() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        AiPaintTools.PaintSphere(ws).call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3); put("tag", 4); put("session_id", sessionId)
        })
        val diff = PaintSessionTools.GetPaintSessionDiff(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertFalse(diff.isError)
        val cov = diff.structured!!.getJSONObject("coverage_by_kind").getJSONObject("color")
        assertTrue(cov.getBoolean("present"))
        assertEquals(2, cov.getInt("painted_triangles"))
        assertTrue(diff.structured!!.getBoolean("changed"))
    }

    @Test fun listSessionsReturnsAllOpen() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val a = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        val b = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        val res = PaintSessionTools.ListPaintSessions(ws).call(JSONObject())
        assertFalse(res.isError)
        assertEquals(2, res.structured!!.getInt("count"))
        val ids = res.structured!!.getJSONArray("sessions").let { arr ->
            (0 until arr.length()).map { arr.getJSONObject(it).getString("session_id") }
        }
        assertTrue(a in ids); assertTrue(b in ids)
    }

    // ---- discard ----

    @Test fun discardRemovesSession() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        val res = PaintSessionTools.DiscardPaintSession()
            .call(JSONObject().put("session_id", sessionId))
        assertFalse(res.isError)
        assertNull(AiPaintSessionStore.get().get(sessionId))
    }

    // ---- commit emits LoadPaintState ----

    @Test fun commitEmitsLoadPaintStateAction() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        // Paint something inside the session.
        AiPaintTools.PaintSphere(ws).call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 5) })
            put("radius_mm", 3); put("tag", 4); put("session_id", sessionId)
        })
        // Now commit and capture the action.
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertFalse(res.isError)
        val action = collected.await() as WorkspaceAction.LoadPaintState
        assertEquals(modelId, action.modelId)
        // Painted tris reflected in the action.
        val arr = action.paintFilamentIndex!!
        assertEquals(4, arr[2].toInt())
        assertEquals(4, arr[3].toInt())
        // Session is auto-discarded after a successful commit.
        assertNull(AiPaintSessionStore.get().get(sessionId))
        assertFalse(res.structured!!.getBoolean("noop"))
    }

    @Test fun commitNoopWhenSessionUnchanged() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertFalse(res.isError)
        assertTrue(res.structured!!.getBoolean("noop"))
        // Session still discarded.
        assertNull(AiPaintSessionStore.get().get(sessionId))
    }

    @Test fun commitRefusesUnknownSession() = runTest {
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", "nope"))
        assertTrue(res.isError)
    }

    // ---- session-aware render ----

    @Test fun sessionAwareRenderUsesSessionPaint() = runTest {
        // Live model has paint flooded with tag 1; session paints just
        // the top two tris with tag 9. The render output should reflect
        // the session paint, not the live paint.
        val livePaint = ByteArray(12) { 1 }
        ws.publishPlacedModels(listOf(
            PlacedModel(
                id = modelId,
                source = File("/dev/null"),
                label = "test cube",
                paintFilamentIndex = livePaint,
            ),
        ))
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        // Paint top tris (2, 3) with tag 9 in session.
        AiPaintTools.PaintTriangleList(ws).call(JSONObject().apply {
            put("model_id", modelId)
            val arr = org.json.JSONArray()
            arr.put(2); arr.put(3)
            put("triangle_ids", arr)
            put("tag", 9); put("session_id", sessionId)
        })
        // Confirm session paint differs from live model paint.
        val session = AiPaintSessionStore.get().get(sessionId)!!
        assertEquals(9, session.paintFilamentIndex!![2].toInt())
        assertEquals(1, livePaint[2].toInt())  // live is unchanged

        // Now render with session_id and verify the cache key + body
        // reflect the session — the live render and session render
        // should produce DIFFERENT cache tokens (since paint differs).
        val rv = AiVisionTools.RenderView(ws, AiSessionState())
        val liveRes = rv.call(JSONObject().apply {
            put("model_id", modelId)
            put("width_px", 64); put("height_px", 64)
        })
        val sessionRes = rv.call(JSONObject().apply {
            put("model_id", modelId)
            put("width_px", 64); put("height_px", 64)
            put("session_id", sessionId)
        })
        assertFalse(liveRes.isError); assertFalse(sessionRes.isError)
        val liveTok = liveRes.structured!!.getString("render_token")
        val sessionTok = sessionRes.structured!!.getString("render_token")
        assertTrue("session render must produce a distinct token from live",
            liveTok != sessionTok)
        assertEquals(sessionId, sessionRes.structured!!.optString("session_id"))
    }

    // ---- safety: tri-count change rejection ----

    @Test fun paintRejectedWhenTriCountChanges() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        // Swap the BVH with a different mesh (different tri count) to
        // simulate a mid-session repair / boolean.
        val biggerMesh = StlMesh(FloatArray(99), 11,  // 11 triangles, not 12
            Vec3f(-1f, -1f, -1f), Vec3f(1f, 1f, 1f))
        val newBvh = MeshBvh.build(biggerMesh)
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) newBvh else null
        })
        val res = AiPaintTools.PaintSphere(ws).call(JSONObject().apply {
            put("model_id", modelId)
            put("center", JSONObject().apply { put("x", 0); put("y", 0); put("z", 0) })
            put("radius_mm", 3); put("tag", 4); put("session_id", sessionId)
        })
        assertTrue("paint must refuse when triCount drifted", res.isError)
        assertTrue("error explains tri count drift",
            res.text.contains("tri_count", ignoreCase = true))
    }

    @Test fun commitRejectedWhenTriCountChanges() = runTest {
        val begin = PaintSessionTools.BeginPaintSession(ws)
        val sessionId = begin.call(JSONObject().put("model_id", modelId))
            .structured!!.getString("session_id")
        val biggerMesh = StlMesh(FloatArray(99), 11,
            Vec3f(-1f, -1f, -1f), Vec3f(1f, 1f, 1f))
        val newBvh = MeshBvh.build(biggerMesh)
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) newBvh else null
        })
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertTrue(res.isError)
        // Default discard_on_failure = true → session gone.
        assertNull(AiPaintSessionStore.get().get(sessionId))
    }
}
