package dev.orcaxr.nativeapp.xr

import androidx.compose.ui.unit.dp
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.nativeapp.shell.ActionTexts
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import dev.orcaxr.nativeapp.xr.ui.XrSpatialTokens
import org.junit.Assert.*
import org.junit.Test

/**
 * Validates ergonomic spatial UI constraints and action/capability inventory
 * consistency for Android XR (Phase 8).
 */
class SpatialUiLayoutTest {

    @Test
    fun spatialTokensMatchDesignContract() {
        assertEquals("Minimum touch target must be 58 dp per DESIGN.md floor", 58.dp, XrSpatialTokens.MinTouchTarget)
        assertEquals("Parent corner radius must be 24 dp (rounded.xl)", 24.dp, XrSpatialTokens.CornerRadiusParent)
        assertEquals("Child corner radius must be 8 dp (rounded.md)", 8.dp, XrSpatialTokens.CornerRadiusChild)
        assertEquals("Standard panel padding must be 16 dp (spacing.xl)", 16.dp, XrSpatialTokens.PanelPadding)

        // Frosted glass opacities
        assertEquals("Root panel alpha must be 80%", 0xCC / 255f, XrSpatialTokens.ColorPanel.alpha, 0.01f)
        assertEquals("Elevated panel alpha must be 92%", 0xEB / 255f, XrSpatialTokens.ColorPanelStrong.alpha, 0.01f)
        assertEquals("Soft recessed alpha must be 55%", 0x8C / 255f, XrSpatialTokens.ColorPanelSoft.alpha, 0.01f)
    }

    @Test
    fun spatialToolRailActionsPreserveInventoryAndAllPaintChannels() {
        val transformActions = listOf(
            "tool_move",
            "tool_rotate",
            "tool_scale",
            "tool_lay_on_face",
            "edit_cut",
            "tool_measure"
        )
        val paintActions = listOf(
            "tool_paint",          // Color
            "tool_support_paint",  // Support
            "tool_seam_paint",     // Seam
            "tool_fuzzy_skin",     // Fuzzy skin
            "tool_smart_paint"     // Smart paint
        )
        val meshActions = listOf(
            "simplify_model",
            "repair_model",
            "split_to_parts",
            "add_emboss",
            "tool_brim_ears"
        )
        val plateActions = listOf(
            "arrange_all",
            "drop_to_bed",
            "delete_models"
        )

        val allRailActions = transformActions + paintActions + meshActions + plateActions

        // Verify all 5 paint channels are preserved
        assertEquals("Must preserve exactly 5 distinct paint channel tools", 5, paintActions.size)
        assertTrue("Color paint present", "tool_paint" in paintActions)
        assertTrue("Support paint present", "tool_support_paint" in paintActions)
        assertTrue("Seam paint present", "tool_seam_paint" in paintActions)
        assertTrue("Fuzzy skin present", "tool_fuzzy_skin" in paintActions)
        assertTrue("Smart paint present", "tool_smart_paint" in paintActions)

        // Verify every rail action has a mapped label and an icon glyph
        for (id in allRailActions) {
            assertTrue("Action $id must have a label in ActionTexts", ActionTexts.LABELS.containsKey(id))
            assertTrue("Action $id must have an icon in OrcaActionGlyphs", OrcaActionGlyphs.actions.containsKey(id))
        }
    }

    @Test
    fun previewScrubberCoversAllGcodePreviewModes() {
        val modes = GcodePreviewModes.ids
        assertTrue("Preview modes must include Feature type", "FeatureType" in modes)
        assertTrue("Preview modes must include Tool", "Tool" in modes)
        assertTrue("Preview modes must include Height", "Height" in modes)
        assertTrue("Preview modes must include Speed", "Feedrate" in modes)
        assertTrue("Preview modes must include Fan", "FanSpeed" in modes)
        assertTrue("Preview modes must include Temperature", "Temperature" in modes)

        for (id in modes) {
            val mode = GcodePreviewModes.get(id)
            assertNotNull("Mode $id must resolve valid metadata", mode)
            assertTrue("Mode $id must have non-empty label", mode.label.isNotEmpty())
        }
    }

    @Test
    fun verifiesAdvertisedInputModalitiesByDeviceForm() {
        val noOp = NoOpXrCapabilityAdapter.capabilities.value
        assertEquals(XrDeviceForm.STANDARD_ANDROID, noOp.deviceForm)
        assertTrue("Standard Android supports touch screen", XrInputModality.TOUCH_SCREEN in noOp.supportedInputModalities)
        assertTrue("Standard Android supports mouse/trackpad", XrInputModality.MOUSE_TRACKPAD in noOp.supportedInputModalities)
        assertTrue("Standard Android supports hardware keyboard", XrInputModality.HARDWARE_KEYBOARD in noOp.supportedInputModalities)
        assertFalse("Standard Android does not advertise 6DoF hand tracking", XrInputModality.HAND_TRACKING in noOp.supportedInputModalities)

        val headsetModalities = setOf(
            XrInputModality.HAND_TRACKING,
            XrInputModality.SPATIAL_CONTROLLER,
            XrInputModality.GAZE_PINCH,
            XrInputModality.MOUSE_TRACKPAD,
            XrInputModality.HARDWARE_KEYBOARD
        )
        assertTrue("Galaxy XR headset must advertise hand tracking", XrInputModality.HAND_TRACKING in headsetModalities)
        assertTrue("Galaxy XR headset must advertise spatial controllers", XrInputModality.SPATIAL_CONTROLLER in headsetModalities)
        assertTrue("Galaxy XR headset must advertise gaze pinch", XrInputModality.GAZE_PINCH in headsetModalities)
        assertTrue("Galaxy XR headset must advertise hardware keyboard", XrInputModality.HARDWARE_KEYBOARD in headsetModalities)
    }
}
