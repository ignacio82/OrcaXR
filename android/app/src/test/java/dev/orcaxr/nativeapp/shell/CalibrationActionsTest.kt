package dev.orcaxr.nativeapp.shell

import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CalibrationActionsTest {
    @Test
    fun calibrationWorkflowsAreCompleteAndConfigured() {
        val expected = listOf(
            "calib_temperature", "calib_flow_pass1", "calib_flow_pass2", "calib_flow_yolo", "calib_flow_yolo_perfectionist",
            "calib_pressure_advance", "calib_retraction", "calib_max_flow", "calib_vfa", "calib_tolerance",
            "calib_junction_deviation", "calib_input_shaping_frequency", "calib_input_shaping_damping",
        )
        assertEquals(expected.sorted(), AppActions.CALIBRATION_WORKFLOWS.sorted())
        assertEquals(13, AppActions.CALIBRATION_WORKFLOWS.size)
        for (action in AppActions.CALIBRATION_WORKFLOWS) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
            assertFalse(action, AppActions.needsWorkspace(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }
    }

    @Test
    fun calibrationHistoryActionsAreCompleteAndConfigured() {
        val expected = listOf(
            "calib_view_history", "calib_record_result", "calib_compare_results", "calib_rerun_result",
            "calib_apply_result", "calib_delete_result", "calib_export_history",
        )
        assertEquals(expected.sorted(), AppActions.CALIBRATION_HISTORY.sorted())
        assertEquals(7, AppActions.CALIBRATION_HISTORY.size)
        for (action in AppActions.CALIBRATION_HISTORY) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
            assertFalse(action, AppActions.needsWorkspace(action))
            assertFalse(action, AppActions.needsPrepare(action))
            assertFalse(action, AppActions.needsExport(action))
        }
    }

    @Test
    fun calibrationSessionActionsAreCompleteAndConfigured() {
        val expected = listOf(
            "calib_choose", "calib_configure", "calib_reset_parameters",
            "calib_place_geometry", "calib_sweep_export", "calib_session_discard", "calib_session_keep",
        )
        assertEquals(expected.sorted(), AppActions.CALIBRATION_SESSION.sorted())
        assertEquals(7, AppActions.CALIBRATION_SESSION.size)
        for (action in AppActions.CALIBRATION_SESSION) {
            assertTrue(action, action in AppActions.PERFORMED)
            assertTrue(action, action in ActionTexts.LABELS)
            assertTrue(action, action in ActionTexts.HINTS)
            assertTrue(action, action in OrcaActionGlyphs.actions)
        }
        assertEquals(27, AppActions.CALIBRATION.size)
    }
}
