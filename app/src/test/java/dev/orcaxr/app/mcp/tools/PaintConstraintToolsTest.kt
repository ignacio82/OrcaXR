package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.StlMesh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
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
 * M7 end-to-end: drives the full LLM workflow over the MCP tool layer
 * to confirm constraints actually gate commits and the live model
 * stays untouched on rejection.
 *
 * Each test follows: begin_paint_session → add_paint_constraint(s)
 * → paint that may or may not violate → commit_paint_session → check.
 *
 * Uses a 12-tri cube fixture so triangle ids are stable and the
 * "deck = top" / "hull = bottom" framing maps directly to face
 * indices: tris 0,1 = bottom (-Z); tris 2,3 = top (+Z); tris 4..11 =
 * side faces. See PaintSessionToolsTest for the same fixture.
 */
class PaintConstraintToolsTest {

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
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),    // 0,1 bottom
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),    // 2,3 top
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),    // 4,5 -Y side
            intArrayOf(2, 3, 7), intArrayOf(2, 7, 6),    // 6,7 +Y side
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),    // 8,9 -X side
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),    // 10,11 +X side
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
        modelId = "m_test_constraints"
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId,
            source = File("/dev/null"),
            label = "test cube",
        )))
        val bvh = MeshBvh.build(cube())
        ws.setBvhProvider(WorkspaceModel.BvhProvider { id ->
            if (id == modelId) bvh else null
        })
        AiPaintSessionStore.get().clearAll()
    }

    @After fun tearDown() {
        AiPaintSessionStore.get().clearAll()
    }

    // ---- helpers ----

    private suspend fun beginSession(): String {
        val res = PaintSessionTools.BeginPaintSession(ws)
            .call(JSONObject().put("model_id", modelId))
        assertFalse("begin session must succeed: ${res.text}", res.isError)
        return res.structured!!.getString("session_id")
    }

    private suspend fun addConstraint(
        sessionId: String,
        kind: String,
        triangleIds: IntArray,
        tag: Int? = null,
        description: String = "test",
    ): String {
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("kind", kind)
            put("triangle_ids", JSONArray().apply { for (t in triangleIds) put(t) })
            if (tag != null) put("tag", tag)
            put("description", description)
        }
        val res = PaintConstraintTools.AddPaintConstraint().call(args)
        assertFalse("add_paint_constraint must succeed: ${res.text}", res.isError)
        return res.structured!!.getString("constraint_id")
    }

    private suspend fun paintTriangleList(
        sessionId: String,
        triangleIds: IntArray,
        tag: Int,
        merge: String = "replace",
    ) {
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("triangle_ids", JSONArray().apply { for (t in triangleIds) put(t) })
            put("tag", tag)
            put("merge", merge)
            put("session_id", sessionId)
        }
        val res = AiPaintTools.PaintTriangleList(ws).call(args)
        assertFalse("paint_triangle_list must succeed: ${res.text}", res.isError)
    }

    private suspend fun commit(sessionId: String, force: Boolean = false): JSONObject {
        val args = JSONObject().apply {
            put("session_id", sessionId)
            if (force) put("force", true)
        }
        return PaintConstraintCommitResult(
            PaintSessionTools.CommitPaintSession(ws).call(args),
        ).body
    }

    private data class PaintConstraintCommitResult(val res: dev.orcaxr.app.mcp.ToolResult) {
        val body: JSONObject get() = res.structured ?: JSONObject()
    }

    // ---- M7 commit gate: must_remain_unpainted ----

    @Test fun mustRemainUnpaintedRejectsCommitOnBleed() = runTest {
        val sessionId = beginSession()
        // The deck (top face, tris 2 + 3) MUST stay unpainted.
        addConstraint(sessionId, "must_remain_unpainted", intArrayOf(2, 3))
        // Paint hull (bottom) — fine.
        paintTriangleList(sessionId, intArrayOf(0, 1), tag = 4)
        // Bleed onto deck.
        paintTriangleList(sessionId, intArrayOf(2), tag = 4)

        // Confirm the live model gets NO action emitted on the rejected commit.
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            withTimeoutOrNull(50) { ws.actions.first() }
        }
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        // Rejection: isError=true, no action emitted.
        assertTrue("commit must be rejected on violation", res.isError)
        assertNull("no LoadPaintState should land on rejection", collected.await())
        // Body shape: the LLM gets violation info.
        val body = res.structured!!
        assertEquals(true, body.getBoolean("rejected"))
        assertEquals(1, body.getInt("violation_count"))
        val v = body.getJSONArray("violations").getJSONObject(0)
        assertEquals("must_remain_unpainted", v.getString("kind"))
        assertEquals(1, v.getInt("violating_triangle_count"))
        assertEquals(2, v.getJSONArray("violating_triangle_sample").getInt(0))
        // Default discard_on_failure=true drops the session.
        assertNull(AiPaintSessionStore.get().get(sessionId))
    }

    @Test fun discardOnFailureFalseKeepsSessionIntact() = runTest {
        val sessionId = beginSession()
        addConstraint(sessionId, "must_remain_unpainted", intArrayOf(2, 3))
        paintTriangleList(sessionId, intArrayOf(2), tag = 4)
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("discard_on_failure", false)
        }
        val res = PaintSessionTools.CommitPaintSession(ws).call(args)
        assertTrue(res.isError)
        // Session still alive — caller can clear constraints / repaint and retry.
        assertNotNull(AiPaintSessionStore.get().get(sessionId))
        assertFalse(res.structured!!.getBoolean("session_kept").not())
    }

    // ---- corrective paint then commit succeeds ----

    @Test fun rejectedSessionRecoversWithCorrectivePaint() = runTest {
        val sessionId = beginSession()
        addConstraint(sessionId, "must_remain_unpainted", intArrayOf(2, 3),
            description = "deck stays raw")
        paintTriangleList(sessionId, intArrayOf(0, 1), tag = 4)
        paintTriangleList(sessionId, intArrayOf(2), tag = 4)   // bleed

        // First commit — rejected.
        val rejectArgs = JSONObject().apply {
            put("session_id", sessionId)
            put("discard_on_failure", false)   // keep so we can fix
        }
        val reject = PaintSessionTools.CommitPaintSession(ws).call(rejectArgs)
        assertTrue(reject.isError)

        // LLM corrective: scrub deck back to tag 0 with merge=only_tagged.
        val args = JSONObject().apply {
            put("model_id", modelId)
            put("triangle_ids", JSONArray().apply { put(2); put(3) })
            put("tag", 0)
            put("merge", "only_tagged")
            put("where_tag", 4)
            put("session_id", sessionId)
        }
        val fix = AiPaintTools.PaintTriangleList(ws).call(args)
        assertFalse("corrective paint must succeed: ${fix.text}", fix.isError)

        // Second commit — success. Capture the emitted action.
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        val ok = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertFalse("retry must succeed: ${ok.text}", ok.isError)
        val action = collected.await() as WorkspaceAction.LoadPaintState
        // Hull painted (tag 4); deck stayed at 0.
        val paint = action.paintFilamentIndex!!
        assertEquals(4, paint[0].toInt())
        assertEquals(4, paint[1].toInt())
        assertEquals(0, paint[2].toInt())
        assertEquals(0, paint[3].toInt())
        // Session auto-discarded on success.
        assertNull(AiPaintSessionStore.get().get(sessionId))
    }

    // ---- multiple kinds in one session ----

    @Test fun multipleConstraintKindsAllValidatedAtOnce() = runTest {
        val sessionId = beginSession()
        addConstraint(sessionId, "must_be_painted", intArrayOf(0, 1),
            description = "hull required")
        addConstraint(sessionId, "must_be_tag", intArrayOf(2, 3), tag = 3,
            description = "deck = slot 3")
        addConstraint(sessionId, "must_not_be_tag", intArrayOf(8, 9), tag = 5,
            description = "side never black")
        // Paint NOTHING — every constraint that requires presence fails.
        val res = PaintSessionTools.CommitPaintSession(ws)
            .call(JSONObject().put("session_id", sessionId))
        assertTrue(res.isError)
        val body = res.structured!!
        // must_be_painted on (0,1) and must_be_tag on (2,3) both fail;
        // must_not_be_tag on (8,9) passes (sides are tag 0, not 5).
        assertEquals(2, body.getInt("violation_count"))
        val kinds = mutableSetOf<String>()
        val arr = body.getJSONArray("violations")
        for (i in 0 until arr.length()) kinds.add(arr.getJSONObject(i).getString("kind"))
        assertTrue("must_be_painted in violations", "must_be_painted" in kinds)
        assertTrue("must_be_tag in violations", "must_be_tag" in kinds)
        assertFalse("must_not_be_tag should NOT violate", "must_not_be_tag" in kinds)
    }

    // ---- force commit ----

    @Test fun forceCommitsDespiteViolationsAndRecordsAudit() = runTest {
        val sessionId = beginSession()
        addConstraint(sessionId, "must_remain_unpainted", intArrayOf(2, 3))
        paintTriangleList(sessionId, intArrayOf(2, 3), tag = 7)   // intentional bleed

        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("force", true)
        }
        val res = PaintSessionTools.CommitPaintSession(ws).call(args)
        assertFalse("forced commit must succeed: ${res.text}", res.isError)
        // The action lands; live model gets the painted deck.
        val action = collected.await() as WorkspaceAction.LoadPaintState
        assertEquals(7, action.paintFilamentIndex!![2].toInt())
        // Audit recorded.
        val body = res.structured!!
        assertEquals(true, body.getBoolean("forced"))
        val audit = body.getJSONArray("forced_violations")
        assertEquals(1, audit.length())
        assertEquals("must_remain_unpainted", audit.getJSONObject(0).getString("kind"))
    }

    // ---- list / clear ----

    @Test fun listAndClearWorkAcrossMcpBoundary() = runTest {
        val sessionId = beginSession()
        val cId1 = addConstraint(sessionId, "must_be_painted", intArrayOf(0))
        val cId2 = addConstraint(sessionId, "must_remain_unpainted", intArrayOf(2))
        // List shows both.
        val list1 = PaintConstraintTools.ListPaintConstraints()
            .call(JSONObject().put("session_id", sessionId))
        assertEquals(2, list1.structured!!.getInt("count"))

        // Clear one.
        val clearOne = PaintConstraintTools.ClearPaintConstraints().call(JSONObject().apply {
            put("session_id", sessionId)
            put("constraint_id", cId1)
        })
        assertFalse(clearOne.isError)
        assertEquals(1, clearOne.structured!!.getInt("remaining"))

        // Clear all (omit constraint_id).
        val clearAll = PaintConstraintTools.ClearPaintConstraints()
            .call(JSONObject().put("session_id", sessionId))
        assertFalse(clearAll.isError)
        assertEquals(0, clearAll.structured!!.getInt("remaining"))
        // The unrelated id reference avoids "unused" warnings without
        // adding noise to the assertion list.
        assertNotNull(cId2)
    }

    @Test fun clearUnknownConstraintErrorsCleanly() = runTest {
        val sessionId = beginSession()
        val res = PaintConstraintTools.ClearPaintConstraints().call(JSONObject().apply {
            put("session_id", sessionId)
            put("constraint_id", "never-existed")
        })
        assertTrue(res.isError)
        assertEquals(0, res.structured!!.getInt("removed"))
    }

    // ---- input validation ----

    @Test fun addConstraintRejectsUnknownKind() = runTest {
        val sessionId = beginSession()
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("kind", "must_be_purple")
            put("triangle_ids", JSONArray().apply { put(0) })
        }
        val res = PaintConstraintTools.AddPaintConstraint().call(args)
        assertTrue(res.isError)
    }

    @Test fun addConstraintRequiresTagForTagKinds() = runTest {
        val sessionId = beginSession()
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("kind", "must_be_tag")
            put("triangle_ids", JSONArray().apply { put(0) })
            // tag intentionally omitted
        }
        val res = PaintConstraintTools.AddPaintConstraint().call(args)
        assertTrue(res.isError)
    }

    @Test fun addConstraintDropsOutOfRangeIds() = runTest {
        val sessionId = beginSession()
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("kind", "must_be_painted")
            put("triangle_ids", JSONArray().apply {
                put(0); put(99); put(1000); put(11)
            })
            put("description", "mixed valid + stale")
        }
        val res = PaintConstraintTools.AddPaintConstraint().call(args)
        assertFalse(res.isError)
        // 0, 11 valid; 99, 1000 dropped.
        assertEquals(2, res.structured!!.getInt("triangle_count"))
        assertEquals(2, res.structured!!.getInt("dropped_out_of_range"))
    }

    @Test fun addConstraintFailsWhenAllIdsOutOfRange() = runTest {
        val sessionId = beginSession()
        val args = JSONObject().apply {
            put("session_id", sessionId)
            put("kind", "must_be_painted")
            put("triangle_ids", JSONArray().apply { put(99); put(1000) })
        }
        val res = PaintConstraintTools.AddPaintConstraint().call(args)
        assertTrue(res.isError)
    }

    @Test fun unknownSessionIdErrors() = runTest {
        val args = JSONObject().apply {
            put("session_id", "nope")
            put("kind", "must_be_painted")
            put("triangle_ids", JSONArray().apply { put(0) })
        }
        assertTrue(PaintConstraintTools.AddPaintConstraint().call(args).isError)
        assertTrue(PaintConstraintTools.ListPaintConstraints()
            .call(JSONObject().put("session_id", "nope")).isError)
        assertTrue(PaintConstraintTools.ClearPaintConstraints()
            .call(JSONObject().put("session_id", "nope")).isError)
    }
}
