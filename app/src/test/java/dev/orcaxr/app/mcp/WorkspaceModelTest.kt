package dev.orcaxr.app.mcp

import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.PaintMode
import dev.orcaxr.app.WorkspaceMode
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for [WorkspaceModel]. The model itself is just
 * StateFlow + SharedFlow — no Android plumbing — so the unit harness
 * can verify state-flow plumbing and action dispatch without
 * MainActivity.
 *
 * These tests don't go through MCP / JSON-RPC; they're a sanity gate
 * on the singleton's contract. The end-to-end story
 * (tool → action → setter → state flow) requires MainActivity, so
 * that's covered by the manual smoke test in the verify section of
 * the commit message.
 */
class WorkspaceModelTest {

    @Test fun publishersUpdateStateFlows() = runTest {
        val ws = WorkspaceModel()
        ws.publishGizmoTool(GizmoTool.Rotate)
        assertEquals(GizmoTool.Rotate, ws.gizmoTool.value)
        ws.publishWorkspaceMode(WorkspaceMode.Preview)
        assertEquals(WorkspaceMode.Preview, ws.workspaceMode.value)
        ws.publishActivePlateId(7)
        assertEquals(7, ws.activePlateId.value)
        ws.publishSelectedModelIds(setOf("a", "b"))
        assertEquals(setOf("a", "b"), ws.selectedModelIds.value)
    }

    @Test fun emittedActionReachesCollector() = runTest {
        val ws = WorkspaceModel()
        // SharedFlow has replay=0, so collect-then-emit is the right
        // order. Spawn a child coroutine to `first()` the flow before
        // emitting.
        val collected = async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        ws.emit(WorkspaceAction.SetGizmoTool(GizmoTool.Scale))
        val action = collected.await()
        assertTrue(action is WorkspaceAction.SetGizmoTool)
        assertEquals(GizmoTool.Scale, (action as WorkspaceAction.SetGizmoTool).tool)
    }

    @Test fun attachedFlagDefaultsFalse() = runTest {
        val ws = WorkspaceModel()
        assertEquals(false, ws.attached.value)
        ws.setAttached(true)
        assertEquals(true, ws.attached.value)
    }

    @Test fun multipleEmissionsAreOrdered() = runTest {
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            // Buffer 64 + the test only emits 4 — no risk of drop.
            ws.actions.collect { gathered += it }
        }
        ws.emit(WorkspaceAction.SetGizmoTool(GizmoTool.Move))
        ws.emit(WorkspaceAction.SetWorkspaceMode(WorkspaceMode.Preview))
        ws.emit(WorkspaceAction.SetActivePlateId(2))
        ws.emit(WorkspaceAction.SetPaintMode(PaintMode.Color))
        // give the collector a chance — runTest's default dispatcher
        // serializes coroutines by yields.
        yield()
        yield()
        yield()
        yield()
        job.cancel()
        assertEquals(4, gathered.size)
        assertTrue(gathered[0] is WorkspaceAction.SetGizmoTool)
        assertTrue(gathered[1] is WorkspaceAction.SetWorkspaceMode)
        assertTrue(gathered[2] is WorkspaceAction.SetActivePlateId)
        assertTrue(gathered[3] is WorkspaceAction.SetPaintMode)
    }
}
