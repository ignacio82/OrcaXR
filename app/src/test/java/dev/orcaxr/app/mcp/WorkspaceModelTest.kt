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

    @Test fun tierBActionsRoundTripThroughChannel() = runTest {
        // Verify the new Tier-B sealed-class cases (slice / save /
        // arrange / drop) can be emitted + observed. The collector
        // dispatch is exercised at integration time on a real device;
        // here we only verify the action surface is wired.
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        ws.emit(WorkspaceAction.SliceActivePlate)
        ws.emit(WorkspaceAction.AutoArrangePlate)
        ws.emit(WorkspaceAction.DropToBed("model_42"))
        ws.emit(WorkspaceAction.SaveGcodeToDownloads)
        ws.emit(WorkspaceAction.SaveProject3mf)
        ws.emit(WorkspaceAction.SaveModelStl)
        ws.emit(WorkspaceAction.CancelSlice)
        repeat(8) { yield() }
        job.cancel()
        assertEquals(7, gathered.size)
        assertTrue(gathered[0] === WorkspaceAction.SliceActivePlate)
        assertTrue(gathered[1] === WorkspaceAction.AutoArrangePlate)
        assertTrue(gathered[2] is WorkspaceAction.DropToBed)
        assertEquals("model_42", (gathered[2] as WorkspaceAction.DropToBed).modelId)
        assertTrue(gathered[3] === WorkspaceAction.SaveGcodeToDownloads)
        assertTrue(gathered[4] === WorkspaceAction.SaveProject3mf)
        assertTrue(gathered[5] === WorkspaceAction.SaveModelStl)
        assertTrue(gathered[6] === WorkspaceAction.CancelSlice)
    }

    @Test fun loadAndPlateMovableActionsRoundTrip() = runTest {
        // Phase 2.2 additions — load_model_from_path + set_plate_movable.
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        ws.emit(WorkspaceAction.LoadModelFromPath("/sdcard/Download/dragon.3mf", WorkspaceAction.LoadMode.Replace))
        ws.emit(WorkspaceAction.LoadModelFromPath("/sdcard/Download/cube.stl", WorkspaceAction.LoadMode.Add))
        ws.emit(WorkspaceAction.SetPlateMovable(true))
        ws.emit(WorkspaceAction.SetPlateMovable(false))
        repeat(5) { yield() }
        job.cancel()
        assertEquals(4, gathered.size)
        val a0 = gathered[0] as WorkspaceAction.LoadModelFromPath
        assertEquals("/sdcard/Download/dragon.3mf", a0.path)
        assertEquals(WorkspaceAction.LoadMode.Replace, a0.mode)
        val a1 = gathered[1] as WorkspaceAction.LoadModelFromPath
        assertEquals(WorkspaceAction.LoadMode.Add, a1.mode)
        assertTrue((gathered[2] as WorkspaceAction.SetPlateMovable).movable)
        assertTrue(!(gathered[3] as WorkspaceAction.SetPlateMovable).movable)
    }

    @Test fun plateMovablePublisherRoundTrips() = runTest {
        val ws = WorkspaceModel()
        assertEquals(false, ws.plateMovable.value)
        ws.publishPlateMovable(true)
        assertEquals(true, ws.plateMovable.value)
    }

    @Test fun modelEditingActionsRoundTrip() = runTest {
        // Phase 2.3 — repair / cut / boolean / split.
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        ws.emit(WorkspaceAction.RepairModel("m1"))
        ws.emit(WorkspaceAction.CutModel("m1", planeZmm = 10.5f))
        ws.emit(WorkspaceAction.MeshBoolean("m1", "m2", op = 1))
        ws.emit(WorkspaceAction.SplitModel("m1"))
        repeat(5) { yield() }
        job.cancel()
        assertEquals(4, gathered.size)
        assertEquals("m1", (gathered[0] as WorkspaceAction.RepairModel).modelId)
        val cut = gathered[1] as WorkspaceAction.CutModel
        assertEquals("m1", cut.modelId)
        assertEquals(10.5f, cut.planeZmm)
        val bool = gathered[2] as WorkspaceAction.MeshBoolean
        assertEquals("m1", bool.modelAId)
        assertEquals("m2", bool.modelBId)
        assertEquals(1, bool.op)
        assertEquals("m1", (gathered[3] as WorkspaceAction.SplitModel).modelId)
    }

    @Test fun embossAndVolumeActionsRoundTrip() = runTest {
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        ws.emit(
            WorkspaceAction.EmbossModel(
                modelId = "m1",
                source = WorkspaceAction.EmbossSource.Text("OrcaXR", "dejavu_sans_bold"),
                sizeMm = 8f,
                depthMm = 1.5f,
                mode = WorkspaceAction.EmbossMode.Add,
            ),
        )
        ws.emit(
            WorkspaceAction.EmbossModel(
                modelId = "m1",
                source = WorkspaceAction.EmbossSource.Svg("/sdcard/heart.svg"),
                sizeMm = 20f,
                depthMm = 2f,
                mode = WorkspaceAction.EmbossMode.Sub,
                rotZDeg = 45f,
            ),
        )
        ws.emit(WorkspaceAction.AddVolumeToModel("m1", "/sdcard/modifier.stl", "PARAMETER_MODIFIER"))
        ws.emit(WorkspaceAction.RemoveVolume("m1", "vol_123"))
        repeat(5) { yield() }
        job.cancel()
        assertEquals(4, gathered.size)
        val emboss1 = gathered[0] as WorkspaceAction.EmbossModel
        assertTrue(emboss1.source is WorkspaceAction.EmbossSource.Text)
        assertEquals("OrcaXR", (emboss1.source as WorkspaceAction.EmbossSource.Text).text)
        assertEquals(WorkspaceAction.EmbossMode.Add, emboss1.mode)
        val emboss2 = gathered[1] as WorkspaceAction.EmbossModel
        assertTrue(emboss2.source is WorkspaceAction.EmbossSource.Svg)
        assertEquals(WorkspaceAction.EmbossMode.Sub, emboss2.mode)
        assertEquals(45f, emboss2.rotZDeg)
        val addVol = gathered[2] as WorkspaceAction.AddVolumeToModel
        assertEquals("PARAMETER_MODIFIER", addVol.type)
        val removeVol = gathered[3] as WorkspaceAction.RemoveVolume
        assertEquals("vol_123", removeVol.volumeId)
    }

    @Test fun paintActionsRoundTrip() = runTest {
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        // Canonical "replace blue (slot 2) with red (slot 3)" use case.
        ws.emit(WorkspaceAction.ReplacePaintTag("m1", WorkspaceAction.PaintKind.Color, fromTag = 2, toTag = 3))
        ws.emit(WorkspaceAction.ClearPaint("m1", WorkspaceAction.PaintKind.Color))
        ws.emit(WorkspaceAction.ClearPaint("m1", null)) // all kinds
        ws.emit(WorkspaceAction.PaintUndo("m1"))
        ws.emit(WorkspaceAction.PaintRedo("m1"))
        // Convert support enforcers to blockers (1 → 2).
        ws.emit(WorkspaceAction.ReplacePaintTag("m1", WorkspaceAction.PaintKind.Support, fromTag = 1, toTag = 2))
        repeat(7) { yield() }
        job.cancel()
        assertEquals(6, gathered.size)
        val swap = gathered[0] as WorkspaceAction.ReplacePaintTag
        assertEquals(WorkspaceAction.PaintKind.Color, swap.kind)
        assertEquals(2, swap.fromTag)
        assertEquals(3, swap.toTag)
        val clearColor = gathered[1] as WorkspaceAction.ClearPaint
        assertEquals(WorkspaceAction.PaintKind.Color, clearColor.kind)
        val clearAll = gathered[2] as WorkspaceAction.ClearPaint
        assertEquals(null, clearAll.kind)
        assertTrue(gathered[3] is WorkspaceAction.PaintUndo)
        assertTrue(gathered[4] is WorkspaceAction.PaintRedo)
        val swapSupport = gathered[5] as WorkspaceAction.ReplacePaintTag
        assertEquals(WorkspaceAction.PaintKind.Support, swapSupport.kind)
        assertEquals(1, swapSupport.fromTag)
        assertEquals(2, swapSupport.toTag)
    }

    @Test fun paintPlaneSplitActionRoundTrips() = runTest {
        val ws = WorkspaceModel()
        val gathered = mutableListOf<WorkspaceAction>()
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.collect { gathered += it }
        }
        // The canonical "left red, right blue" Benchy split: along bed-X,
        // through the bbox center, slot 1 negative side, slot 2 positive.
        ws.emit(
            WorkspaceAction.PaintPlaneSplit(
                modelId = "m1",
                kind = WorkspaceAction.PaintKind.Color,
                axis = WorkspaceAction.SplitAxis.X,
                planeMm = 0f,
                negativeTag = 1,
                positiveTag = 2,
            ),
        )
        repeat(3) { yield() }
        job.cancel()
        assertEquals(1, gathered.size)
        val split = gathered[0] as WorkspaceAction.PaintPlaneSplit
        assertEquals("m1", split.modelId)
        assertEquals(WorkspaceAction.PaintKind.Color, split.kind)
        assertEquals(WorkspaceAction.SplitAxis.X, split.axis)
        assertEquals(0f, split.planeMm)
        assertEquals(1, split.negativeTag)
        assertEquals(2, split.positiveTag)
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
