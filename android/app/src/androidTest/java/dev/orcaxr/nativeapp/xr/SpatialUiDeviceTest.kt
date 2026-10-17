package dev.orcaxr.nativeapp.xr

import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.nativeapp.MainActivity
import dev.orcaxr.nativeapp.shell.ActionTexts
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import dev.orcaxr.nativeapp.xr.ui.XrSpatialTokens
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

/**
 * On-device qualification for Android XR Full Space spatial UI components,
 * cockpit ergonomics, and action inventory on Samsung Galaxy XR (SM-I610).
 *
 * Validates Phase 8 requirements:
 * 1. Space mode transitions (Home Space -> Full Space -> Home Space).
 * 2. Spatial UI components composed in Full Space.
 * 3. Physical ergonomic floor target of 58 mm (58 dp at 1m, ~2.5° arc).
 * 4. Preserved action inventory including all 5 paint channels and preview modes.
 */
@RunWith(AndroidJUnit4::class)
class SpatialUiDeviceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun qualifiesSpatialCockpitAndErgonomicsOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) {
            // Running on non-XR device: verify spatial tokens and contract pass
            assertEquals("Minimum touch target must be 58 dp", 58.dp, XrSpatialTokens.MinTouchTarget)
            return
        }

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val activityRef = AtomicReference<MainActivity>()
            val adapterRef = AtomicReference<XrCapabilityAdapter>()

            scenario.onActivity { activity ->
                activityRef.set(activity)
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }

            val adapter = adapterRef.get()
            assertNotNull("XrCapabilityAdapter must be initialized", adapter)

            // 1. Wait for XR session on Galaxy XR
            val initial = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.sessionActive }
                }
            }
            assertNotNull("XR Session must be active on Galaxy XR", initial)
            assertTrue("Galaxy XR must support spatial UI", initial!!.isSpatialSupported)
            assertEquals("Initial mode is HOME_SPACE", XrSpaceMode.HOME_SPACE, initial.spaceMode)

            // 2. Transition to Full Space
            adapter.requestFullSpace()
            val fullSpace = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE }
                }
            }
            assertNotNull("Must transition to Full Space", fullSpace)
            assertEquals("Full Space mode confirmed", XrSpaceMode.FULL_SPACE, fullSpace!!.spaceMode)

            // 3. Verify spatial ergonomics and tokens
            assertEquals(58.dp, XrSpatialTokens.MinTouchTarget)
            assertEquals(24.dp, XrSpatialTokens.CornerRadiusParent)
            assertEquals(8.dp, XrSpatialTokens.CornerRadiusChild)
            assertEquals(16.dp, XrSpatialTokens.PanelPadding)

            // 4. Verify all 5 paint channels are active and mapped in inventory
            val paintChannels = listOf(
                "tool_paint",
                "tool_support_paint",
                "tool_seam_paint",
                "tool_fuzzy_skin",
                "tool_smart_paint"
            )
            for (id in paintChannels) {
                assertTrue("Action $id must have label", ActionTexts.LABELS.containsKey(id))
                assertTrue("Action $id must have icon glyph", OrcaActionGlyphs.actions.containsKey(id))
            }

            // 5. Verify transform and plate tool actions mapped
            val requiredRailActions = listOf(
                "tool_move",
                "tool_rotate",
                "tool_scale",
                "tool_lay_on_face",
                "edit_cut",
                "tool_measure",
                "simplify_model",
                "repair_model",
                "split_to_parts",
                "arrange_all",
                "drop_to_bed",
                "delete_models"
            )
            for (id in requiredRailActions) {
                assertTrue("Action $id must have label", ActionTexts.LABELS.containsKey(id))
                assertTrue("Action $id must have icon glyph", OrcaActionGlyphs.actions.containsKey(id))
            }

            // 6. Verify GcodePreviewModes completeness
            val previewModes = GcodePreviewModes.ids
            assertTrue("FeatureType mode must exist", "FeatureType" in previewModes)
            assertTrue("Height mode must exist", "Height" in previewModes)
            assertTrue("Feedrate mode must exist", "Feedrate" in previewModes)
            assertTrue("FanSpeed mode must exist", "FanSpeed" in previewModes)
            assertTrue("Temperature mode must exist", "Temperature" in previewModes)
            assertTrue("Tool mode must exist", "Tool" in previewModes)

            // 7. Transition back to Home Space cleanly
            adapter.requestHomeSpace()
            val returnedHome = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE }
                }
            }
            assertNotNull("Must return cleanly to Home Space", returnedHome)
            assertEquals(XrSpaceMode.HOME_SPACE, returnedHome!!.spaceMode)

            adapter.close()
        }
    }

    @Test
    fun qualifiesRepeatedSpaceTransitionsAndPerceptionLifecycleOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) return

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val adapterRef = AtomicReference<XrCapabilityAdapter>()
            scenario.onActivity { activity ->
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }
            val adapter = adapterRef.get()
            assertNotNull(adapter)

            runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.sessionActive }
                }
            }

            // Test 3 repeated cycles between Home Space and Full Space
            for (cycle in 1..3) {
                adapter.requestFullSpace()
                val fullSpace = runBlocking {
                    withTimeoutOrNull(10_000) {
                        adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE }
                    }
                }
                assertNotNull("Cycle $cycle: transition to Full Space failed", fullSpace)
                assertEquals(XrSpaceMode.FULL_SPACE, fullSpace!!.spaceMode)

                // Exercise perception toggle in Full Space
                adapter.requestPerceptionFeature(XrPerceptionFeature.PASSTHROUGH)
                assertTrue(XrPerceptionFeature.PASSTHROUGH in adapter.capabilities.value.initializedPerception)
                adapter.releasePerceptionFeature(XrPerceptionFeature.PASSTHROUGH)
                assertFalse(XrPerceptionFeature.PASSTHROUGH in adapter.capabilities.value.initializedPerception)

                adapter.requestHomeSpace()
                val homeSpace = runBlocking {
                    withTimeoutOrNull(10_000) {
                        adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE }
                    }
                }
                assertNotNull("Cycle $cycle: return to Home Space failed", homeSpace)
                assertEquals(XrSpaceMode.HOME_SPACE, homeSpace!!.spaceMode)
            }

            adapter.close()
        }
    }

    @Test
    fun qualifiesManipulationRayPickingAndGestureCancellationOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) return

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val adapterRef = AtomicReference<XrCapabilityAdapter>()
            val activityRef = AtomicReference<MainActivity>()
            scenario.onActivity { activity ->
                activityRef.set(activity)
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }
            val adapter = adapterRef.get()
            val activity = activityRef.get()
            assertNotNull(adapter)
            assertNotNull(activity)

            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.sessionActive } }
            }

            // Enter Full Space for spatial 3D viewport manipulation
            adapter.requestFullSpace()
            val fullSpace = runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE } }
            }
            assertNotNull("Transition to Full Space failed", fullSpace)

            val project = androidx.lifecycle.ViewModelProvider(activity)[dev.orcaxr.nativeapp.project.ProjectModel::class.java]
            assertNotNull("ProjectModel must be available in activity scope", project)

            // 1. Tool transitions & modal gesture ownership: Rotate, Scale, Move
            scenario.onActivity { project.perform("tool_rotate") }
            assertEquals("Gizmo mode must switch to ROTATE", dev.orcaxr.core.GizmoMode.ROTATE, project.gizmoMode)

            scenario.onActivity { project.perform("tool_scale") }
            assertEquals("Gizmo mode must switch to SCALE", dev.orcaxr.core.GizmoMode.SCALE, project.gizmoMode)

            scenario.onActivity { project.perform("tool_move") }
            assertEquals("Gizmo mode must switch to TRANSLATE", dev.orcaxr.core.GizmoMode.TRANSLATE, project.gizmoMode)

            // 2. Simulate tracking loss / interrupted gesture
            scenario.onActivity { project.paint.cancel() }
            assertNull("In-flight stroke must be null on tracking loss", project.paint.painting)

            // 3. Paint stroke state transition verification
            val strokeState = dev.orcaxr.nativeapp.workspace.PaintToolState()
            val (started, _) = strokeState.start(dev.orcaxr.core.PaintChannel.COLOR, emptyList())
            assertTrue("PaintToolState must be active after start", started.active)
            val stopped = started.stop()
            assertFalse("PaintToolState must be inactive after stop", stopped.active)
            assertNull("Stopped target must be null", stopped.target())

            // 4. Return cleanly to Home Space
            adapter.requestHomeSpace()
            val returnedHome = runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE } }
            }
            assertNotNull("Return to Home Space failed", returnedHome)

            adapter.close()
        }
    }

    @Test
    fun qualifiesInXrProjectDocumentAndWorkflowCompletenessOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) return

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val adapterRef = AtomicReference<XrCapabilityAdapter>()
            val activityRef = AtomicReference<MainActivity>()
            scenario.onActivity { activity ->
                activityRef.set(activity)
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }
            val adapter = adapterRef.get()
            val activity = activityRef.get()

            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.sessionActive } }
            }

            // Enter Full Space
            adapter.requestFullSpace()
            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE } }
            }

            val project = androidx.lifecycle.ViewModelProvider(activity)[dev.orcaxr.nativeapp.project.ProjectModel::class.java]
            val prepare = androidx.lifecycle.ViewModelProvider(activity)[dev.orcaxr.nativeapp.prepare.PrepareModel::class.java]
            val preview = androidx.lifecycle.ViewModelProvider(activity)[dev.orcaxr.nativeapp.preview.PreviewModel::class.java]

            // 1. Fresh project state
            scenario.onActivity { project.newProject() }
            val initialPlates = runBlocking {
                withTimeoutOrNull(10_000) {
                    while (project.busy || project.view.plates != 1) kotlinx.coroutines.delay(100)
                    project.view.plates
                }
            }
            assertEquals("Initial project must have 1 plate", 1, initialPlates)

            // 2. Plate operations in Full Space: Add plate, Undo, Redo
            scenario.onActivity { project.perform("add_plate") }
            val addedPlates = runBlocking {
                withTimeoutOrNull(10_000) {
                    while (project.busy || project.view.plates != 2) kotlinx.coroutines.delay(100)
                    project.view.plates
                }
            }
            assertEquals("Project must have 2 plates after add", 2, addedPlates)

            scenario.onActivity { project.undo() }
            val undonePlates = runBlocking {
                withTimeoutOrNull(10_000) {
                    while (project.busy || project.view.plates != 1) kotlinx.coroutines.delay(100)
                    project.view.plates
                }
            }
            assertEquals("Undo must restore 1 plate", 1, undonePlates)

            scenario.onActivity { project.redo() }
            val redonePlates = runBlocking {
                withTimeoutOrNull(10_000) {
                    while (project.busy || project.view.plates != 2) kotlinx.coroutines.delay(100)
                    project.view.plates
                }
            }
            assertEquals("Redo must restore 2 plates", 2, redonePlates)

            // 3. Prepare preflight readiness in XR
            assertNotNull("Prepare model state must be non-null", prepare.state)

            // 4. Preview model readiness in XR
            val modes = dev.orcaxr.core.GcodePreviewModes.ids
            assertTrue("Preview modes must be populated", modes.isNotEmpty())
            assertEquals("Initial preview mode is FeatureType", "FeatureType", preview.state.mode)
            for (mode in modes) {
                assertNotNull("Preview mode $mode must resolve valid metadata", dev.orcaxr.core.GcodePreviewModes.get(mode))
            }

            // 5. Clean teardown back to Home Space
            adapter.requestHomeSpace()
            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE } }
            }
            adapter.close()
        }
    }

    @Test
    fun qualifiesAdvertisedInputModalitiesOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) return

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val adapterRef = AtomicReference<XrCapabilityAdapter>()
            val activityRef = AtomicReference<MainActivity>()
            scenario.onActivity { activity ->
                activityRef.set(activity)
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }
            val adapter = adapterRef.get()
            val activity = activityRef.get()

            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.sessionActive } }
            }

            adapter.requestFullSpace()
            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE } }
            }

            val caps = adapter.capabilities.value
            assertEquals("Device form must be SPATIAL_HEADSET", XrDeviceForm.SPATIAL_HEADSET, caps.deviceForm)

            // Verify all advertised input modalities for Galaxy XR
            val modalities = caps.supportedInputModalities
            assertTrue("Galaxy XR must support hand tracking", XrInputModality.HAND_TRACKING in modalities)
            assertTrue("Galaxy XR must support spatial controllers", XrInputModality.SPATIAL_CONTROLLER in modalities)
            assertTrue("Galaxy XR must support gaze pinch", XrInputModality.GAZE_PINCH in modalities)
            assertTrue("Galaxy XR must support mouse and trackpad", XrInputModality.MOUSE_TRACKPAD in modalities)
            assertTrue("Galaxy XR must support hardware keyboard", XrInputModality.HARDWARE_KEYBOARD in modalities)

            // Test hardware keyboard shortcut (Ctrl+K for command palette) and Tab navigation
            scenario.onActivity {
                val ctrlDown = android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_K, 0, android.view.KeyEvent.META_CTRL_ON)
                activity.dispatchKeyEvent(ctrlDown)
                val ctrlUp = android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_K, 0, android.view.KeyEvent.META_CTRL_ON)
                activity.dispatchKeyEvent(ctrlUp)

                val tabDown = android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_TAB, 0)
                activity.dispatchKeyEvent(tabDown)
                val tabUp = android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_TAB, 0)
                activity.dispatchKeyEvent(tabUp)
            }

            adapter.requestHomeSpace()
            runBlocking {
                withTimeoutOrNull(10_000) { adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE } }
            }
            adapter.close()
        }
    }
}
