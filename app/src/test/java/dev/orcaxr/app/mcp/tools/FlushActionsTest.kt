package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FlushActionsTest {

    @Test fun emitReturnsMonotonicIds() = runTest {
        val ws = WorkspaceModel()
        // Drain in a coroutine so emit doesn't block on the buffer.
        val drainJob = launch {
            ws.actions.collect { /* discard */ }
        }
        val a = ws.emit(WorkspaceAction.SetActivePlateId(1))
        val b = ws.emit(WorkspaceAction.SetActivePlateId(2))
        val c = ws.emit(WorkspaceAction.SetActivePlateId(3))
        assertEquals(1L, a)
        assertEquals(2L, b)
        assertEquals(3L, c)
        drainJob.cancel()
    }

    @Test fun markDrainedRatchetsForward() = runTest {
        val ws = WorkspaceModel()
        ws.markDrained(5)
        assertEquals(5L, ws.lastDrainedActionId.value)
        // Lower id is ignored.
        ws.markDrained(3)
        assertEquals(5L, ws.lastDrainedActionId.value)
        // Higher id advances.
        ws.markDrained(7)
        assertEquals(7L, ws.lastDrainedActionId.value)
    }

    @Test fun flushReturnsImmediatelyWhenAlreadyDrained() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        // Pre-set drained = emitted: nothing pending.
        ws.markDrained(10)
        // emit nothing additional; lastEmittedId is 0, lastDrainedId is 10 (>= 0).
        val tool = WorkspaceTools.FlushActions(ws)
        val res = tool.call(JSONObject())
        assertTrue("ok=true when already drained", res.structured!!.getBoolean("ok"))
        assertEquals(false, res.structured!!.getBoolean("timed_out"))
    }

    @Test fun flushBlocksUntilDrainCatchesUp() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        // Emit one action without draining.
        val drainJob = launch {
            ws.actions.collect { /* discard */ }
        }
        val emittedId = ws.emit(WorkspaceAction.SetActivePlateId(7))
        assertEquals(1L, emittedId)
        // Drained flag still 0; flush should wait. Use a short
        // timeout — we'll mark drained from another coroutine.
        val tool = WorkspaceTools.FlushActions(ws)
        val flushDeferred = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            tool.call(JSONObject().apply { put("timeout_ms", 2000) })
        }
        // Tick the runTest scheduler so the flush coroutine starts
        // collecting on lastDrainedActionId.
        yield()
        // Now mark drained — flush should resolve.
        ws.markDrained(emittedId)
        val res = flushDeferred.await()
        assertTrue("expected ok=true after drain caught up", res.structured!!.getBoolean("ok"))
        assertEquals(false, res.structured!!.getBoolean("timed_out"))
        assertEquals(emittedId, res.structured!!.getLong("drained_id"))
        drainJob.cancel()
    }

    @Test fun flushTimesOutWhenDrainStuck() = runTest {
        val ws = WorkspaceModel()
        ws.setAttached(true)
        val drainJob = launch {
            ws.actions.collect { /* discard */ }
        }
        ws.emit(WorkspaceAction.SetActivePlateId(3))
        // Don't markDrained — flush should time out.
        val tool = WorkspaceTools.FlushActions(ws)
        val res = tool.call(JSONObject().apply { put("timeout_ms", 100) })
        assertTrue("expected isError=true on timeout", res.isError)
        assertEquals(true, res.structured!!.getBoolean("timed_out"))
        drainJob.cancel()
    }

    /**
     * Audit H4 — when the host activity is detached (backgrounded /
     * torn down), `flush_actions` must fail FAST instead of waiting
     * the full timeout. Otherwise a misbehaving LLM client pins the
     * MCP coroutine for the full window with no chance of progress.
     */
    @Test fun flushFastFailsWhenHostDetached() = runTest {
        val ws = WorkspaceModel()
        // Drain so emit doesn't block, then DETACH before emitting
        // the action whose drain we'll wait for.
        val drainJob = launch {
            ws.actions.collect { /* discard */ }
        }
        ws.setAttached(true)
        ws.emit(WorkspaceAction.SetActivePlateId(11))
        ws.setAttached(false)
        val tool = WorkspaceTools.FlushActions(ws)
        // Pass a long timeout to prove we don't wait for it.
        val startMs = System.currentTimeMillis()
        val res = tool.call(JSONObject().apply { put("timeout_ms", 5_000) })
        val elapsedMs = System.currentTimeMillis() - startMs
        assertTrue("expected isError=true when host detached", res.isError)
        assertEquals(true, res.structured!!.getBoolean("host_detached"))
        // No exact upper bound — runTest uses virtual time but still
        // does some real wall clock — but a fast-fail should be well
        // under 1s (we passed 5_000 as the timeout).
        assertTrue(
            "expected fast-fail (<1s), got ${elapsedMs}ms",
            elapsedMs < 1_000,
        )
        drainJob.cancel()
    }
}
