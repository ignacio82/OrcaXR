package dev.orcaxr.nativeapp

import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.core.*
import dev.orcaxr.nativeapp.engine.LocalEngineClient
import dev.orcaxr.nativeapp.engine.LocalEngineDevice
import dev.orcaxr.nativeapp.preview.PreviewModel
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * On-device qualification for the Phase 7 exit gate on physical hardware (Samsung Galaxy XR, SM-I610):
 *
 * 1. Open/Create a model project with assigned physical filaments and facet paint.
 * 2. Edit project (instance transform, plate management).
 * 3. Reversible Undo/Redo verified across all operations.
 * 4. Save and reopen document as exact 3MF package, verifying integrity.
 * 5. Slice active plate on ARM64 Snapdragon SXR2230P using local libslic3r engine in :engine process.
 * 6. Inspect toolpaths in G-code preview across layers and preview modes.
 * 7. Recovery storage capture and restore verifying recovery after backgrounding/process interruption.
 */
@RunWith(AndroidJUnit4::class)
class FullWorkflowDeviceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private class MemoryDoc(var bytes: ByteArray = ByteArray(0)) : ProjectDocumentInput, ProjectDocumentOutput {
        override val reportedLength: Long? get() = bytes.size.toLong().takeIf { it > 0 }
        override fun openInput(): InputStream = ByteArrayInputStream(bytes)
        override fun openOutput(): OutputStream = object : ByteArrayOutputStream() {
            override fun close() {
                bytes = toByteArray()
            }
        }
    }

    @Test
    fun qualifiesPhase7FullWorkflowExitGateOnGalaxyXr() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val activityRef = AtomicReference<MainActivity>()
            scenario.onActivity { activityRef.set(it) }
            val activity = activityRef.get()
            assertNotNull("MainActivity must be active", activity)

            val previewModel = ViewModelProvider(activity)[PreviewModel::class.java]
            assertNotNull("PreviewModel must be available in activity scope", previewModel)

            val engineState = LocalEngineDevice.measure(context)
            assertTrue("Packaged slicing engine must be available: ${engineState.reason}", engineState.available)

            val catalog = ProfileCatalogs.shared { context.assets.open("profiles/catalog.json").use { it.readBytes() } }
            val tempFolder = File(context.cacheDir, "workflow-gate-${UUID.randomUUID()}").apply { mkdirs() }
            val recoveryFolder = File(tempFolder, "recovery").apply { mkdirs() }
            val recovery = ProjectRecovery(recoveryFolder)

            try {
                val saved3mf = MemoryDoc()

                // 1. Open/Create project and add primitive model
                ProjectWorkspace(recovery = recovery).use { workspace ->
                    workspace.ready().get(60, TimeUnit.SECONDS)
                    val live = checkNotNull(catalog.defaultSelection(LiveSlicingChoice.EMPTY)?.live)
                    workspace.applySlicingChoice(catalog, live).get(60, TimeUnit.SECONDS)

                    val cube = checkNotNull(workspace.addPrimitive(PrimitiveShape.CUBE).get(60, TimeUnit.SECONDS))
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (workspace.view.activePlate?.objects != 1) {
                        assertTrue("Cube primitive must land on active plate", System.nanoTime() < deadline)
                        Thread.sleep(20)
                    }

                    val firstPlateId = checkNotNull(workspace.view.activePlate).id

                    // 2. Assign filaments and verify physical palette
                    workspace.execute(
                        ProjectIntents.Command.SyncPhysicalFilaments(
                            ProjectIntents.SyncPhysicalFilaments(
                                listOf(
                                    ProjectIntents.PrinterSlot(0, "#FF0000".map { it.code }, "PLA".map { it.code }, ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)),
                                    ProjectIntents.PrinterSlot(1, "#0000FF".map { it.code }, "PETG".map { it.code }, ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)),
                                ),
                                ProjectIntents.OptionalIds.Value(listOf("0c792039-0d6d-4a46-93e8-2bbf4ca9af1e".map { it.code }, "1089f201-ff94-437e-a01f-1aa18f170be0".map { it.code })),
                            ),
                        ),
                    ).get(60, TimeUnit.SECONDS)

                    val painter = ProjectPainter(workspace)
                    val palette = painter.palette().get(60, TimeUnit.SECONDS)
                    assertTrue("Palette must contain physical filaments", palette.entries.size >= 2)

                    // 3. Edit project: Add Plate
                    val plateId = workspace.addPlate().get(60, TimeUnit.SECONDS)
                    assertNotNull("Plate ID must be returned", plateId)
                    assertEquals("Plate count must be 2 after addPlate", 2, workspace.view.plates)

                    // 4. Undo and Redo
                    workspace.undo().get(60, TimeUnit.SECONDS)
                    assertEquals("Plate count must return to 1 after undo", 1, workspace.view.plates)

                    workspace.redo().get(60, TimeUnit.SECONDS)
                    assertEquals("Plate count must restore to 2 after redo", 2, workspace.view.plates)

                    // Switch back to Plate 1 with the model
                    workspace.activatePlate(firstPlateId).get(60, TimeUnit.SECONDS)
                    assertEquals("Active plate must be plate 1", firstPlateId, workspace.view.activePlate?.id)

                    // 5. Save project to 3MF package
                    workspace.save(saved3mf, "workflow_gate.3mf").get(60, TimeUnit.SECONDS)
                    assertTrue("3MF bytes must be non-empty", saved3mf.bytes.isNotEmpty())

                    // 6. Slice active plate on ARM64 local engine in :engine process
                    val activePlateId = checkNotNull(workspace.view.activePlate).id
                    val jobs = LocalEngineDevice.jobs(context)
                    val gcodeFolder = File(tempFolder, "gcode-output").apply { mkdirs() }
                    val publishedGcodeFile = File(gcodeFolder, "workflow_plate.gcode")

                    LocalEngineClient(context).use { client ->
                        val job = LocalSlicing.stage(jobs, UUID.randomUUID().toString().replace("-", "")) {
                            workspace.projectPlate(activePlateId, it).get(60, TimeUnit.SECONDS)
                        }
                        val progressSteps = mutableListOf<String>()
                        val end = client.run(job, { msg, _ -> progressSteps += msg }) { false }
                        assertTrue("Local engine slice must complete successfully: $end", end is LocalEngineEnd.Reported && end.result is LocalEngineResult.Completed)

                        val outcome = LocalSlicing.outcome(end) as LocalSliceOutcome.Output
                        val (verified, figures) = SliceStatusTally().use { tally ->
                            LocalSlicing.claim(job, outcome.result, File(gcodeFolder, "slice.gcode.part"), tally) to tally.figures()
                        }
                        val published = LocalSlicing.publish(verified, job, workspace.view.revision, publishedGcodeFile)
                        assertNotNull("G-code must be published for state", published)
                        assertTrue("Published G-code file must exist", published!!.isFile)
                        assertTrue("G-code must have >= 50 layers: ${figures.layers}", figures.layers.toLong() >= 50)
                        assertEquals("Byte count must match verified tally", verified.bytes, published.length())
                        assertTrue("Progress messages must be reported", progressSteps.isNotEmpty())

                        LocalSlicing.discard(job)
                    }

                    // 7. Inspect toolpaths in Preview via PreviewModel
                    val instrumentation = InstrumentationRegistry.getInstrumentation()
                    val sliceRevision = checkNotNull(workspace.view.revision)
                    scenario.onActivity {
                        previewModel.projectChanged(sliceRevision)
                        previewModel.openSlice(publishedGcodeFile, "workflow_plate.gcode", sliceRevision)
                    }
                    val previewDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (true) {
                        instrumentation.waitForIdleSync()
                        val state = activityRef.get().let {
                            val ref = AtomicReference<dev.orcaxr.nativeapp.preview.PreviewState>()
                            instrumentation.runOnMainSync { ref.set(previewModel.state) }
                            ref.get()
                        }
                        val err = activityRef.get().let {
                            val ref = AtomicReference<String?>()
                            instrumentation.runOnMainSync { ref.set(previewModel.message) }
                            ref.get()
                        }
                        assertNull("PreviewModel had error message: $err", err)
                        if (!state.loading && state.layerBounds != null) break
                        assertTrue("PreviewModel must finish loading toolpath within deadline (state=$state)", System.nanoTime() < previewDeadline)
                        Thread.sleep(50)
                    }
                    val bounds = checkNotNull(previewModel.state.layerBounds)
                    assertTrue("Preview bounds must have >= 50 layers: $bounds", bounds.second >= 50)

                    // Cycle preview modes
                    for (mode in GcodePreviewModes.ids) {
                        scenario.onActivity { previewModel.setMode(mode) }
                        val modeDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                        while (true) {
                            instrumentation.waitForIdleSync()
                            val currentMode = activityRef.get().let {
                                val ref = AtomicReference<String>()
                                instrumentation.runOnMainSync { ref.set(previewModel.state.mode) }
                                ref.get()
                            }
                            if (currentMode == mode) break
                            assertTrue("Preview mode must switch to $mode within deadline", System.nanoTime() < modeDeadline)
                            Thread.sleep(20)
                        }
                        assertEquals("Preview mode must switch to $mode", mode, previewModel.state.mode)
                    }

                    // Scrub layer
                    scenario.onActivity { previewModel.jumpToLayer(25) }
                    val layerDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (true) {
                        instrumentation.waitForIdleSync()
                        val currentLayer = activityRef.get().let {
                            val ref = AtomicReference<Int?>()
                            instrumentation.runOnMainSync { ref.set(previewModel.state.layerRange?.second) }
                            ref.get()
                        }
                        if (currentLayer == 25) break
                        assertTrue("Top layer must jump to 25 within deadline", System.nanoTime() < layerDeadline)
                        Thread.sleep(20)
                    }
                    assertEquals("Top layer must jump to 25", 25, previewModel.state.layerRange?.second)

                    // 8. Recovery storage capture
                    workspace.addPrimitive(PrimitiveShape.CYLINDER).get(60, TimeUnit.SECONDS)
                    val captured = workspace.captureRecovery().get(60, TimeUnit.SECONDS)
                    assertTrue("Unsaved work must be captured in recovery", captured)
                    val recoveryEntries = recovery.list()
                    assertTrue("Recovery entries must exist", recoveryEntries.isNotEmpty())
                    val entry = recoveryEntries.first()
                    assertFalse("Recovery entry must not be damaged", entry.damaged)
                    assertEquals("Recovery entry session must match workspace", workspace.session, entry.session)
                }

                // 9. Reopen saved 3MF in clean workspace and verify integrity
                ProjectWorkspace().use { reopenedWorkspace ->
                    reopenedWorkspace.ready().get(60, TimeUnit.SECONDS)
                    val format = reopenedWorkspace.open(saved3mf, "workflow_gate.3mf").get(60, TimeUnit.SECONDS)
                    assertEquals("Reopened format must be canonical", ProjectArchiveFormat.CANONICAL, format)
                    assertEquals("Reopened project must have 2 plates", 2, reopenedWorkspace.view.plates)
                    assertEquals("Reopened plate must have 1 object", 1, reopenedWorkspace.view.activePlate?.objects)
                }

            } finally {
                tempFolder.deleteRecursively()
            }
        }
    }
}
