package dev.orcaxr.app.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MobilePrintOverrideMapperTest {

    @Test
    fun inheritSupportRemovesSupportOverridesAndKeepsUnrelatedKeys() {
        val out = MobilePrintOverrideMapper.apply(
            existing = mapOf(
                "enable_support" to "1",
                "support_type" to "tree(auto)",
                "support_threshold_angle" to "35",
                "sparse_infill_density" to "22%",
                "wall_loops" to "3",
            ),
            draft = MobilePrintOverrideDraft(
                supportMode = MobileSupportMode.Inherit,
                infillDensity = "22",
                wallLoops = "3",
            ),
        )

        assertFalse(out.containsKey("enable_support"))
        assertFalse(out.containsKey("support_type"))
        assertFalse(out.containsKey("support_threshold_angle"))
        assertEquals("22%", out["sparse_infill_density"])
        assertEquals("3", out["wall_loops"])
    }

    @Test
    fun generateSupportWritesEnableAndSelectedSupportKeys() {
        val out = MobilePrintOverrideMapper.apply(
            existing = emptyMap(),
            draft = MobilePrintOverrideDraft(
                supportMode = MobileSupportMode.Generate,
                supportStyle = MobileSupportStyle.TreeManual,
                supportThresholdAngle = "42",
                supportTopZDistance = "0.16",
                supportBottomZDistance = "0.20",
                supportXyDistance = "0.35",
                supportInterfaceTopLayers = "3",
                supportInterfaceBottomLayers = "1",
                supportSpeed = "80",
                supportInterfaceSpeed = "45.5",
            ),
        )

        assertEquals("1", out["enable_support"])
        assertEquals("tree(manual)", out["support_type"])
        assertEquals("42", out["support_threshold_angle"])
        assertEquals("0.16", out["support_top_z_distance"])
        assertEquals("0.2", out["support_bottom_z_distance"])
        assertEquals("0.35", out["support_object_xy_distance"])
        assertEquals("3", out["support_interface_top_layers"])
        assertEquals("1", out["support_interface_bottom_layers"])
        assertEquals("80", out["support_speed"])
        assertEquals("45.5", out["support_interface_speed"])
    }

    @Test
    fun disableSupportDropsStaleSupportDetailsButPreservesBasicOverrides() {
        val out = MobilePrintOverrideMapper.apply(
            existing = mapOf(
                "enable_support" to "1",
                "support_type" to "tree(auto)",
                "support_top_z_distance" to "0.2",
                "support_object_xy_distance" to "0.35",
                "support_speed" to "80",
                "sparse_infill_density" to "18%",
                "wall_loops" to "4",
            ),
            draft = MobilePrintOverrideDraft(
                supportMode = MobileSupportMode.Disable,
                infillDensity = "18",
                wallLoops = "4",
            ),
        )

        assertEquals("0", out["enable_support"])
        assertFalse(out.containsKey("support_type"))
        assertFalse(out.containsKey("support_top_z_distance"))
        assertFalse(out.containsKey("support_object_xy_distance"))
        assertFalse(out.containsKey("support_speed"))
        assertEquals("18%", out["sparse_infill_density"])
        assertEquals("4", out["wall_loops"])
    }

    @Test
    fun blankNumericFieldsRemoveOnlyThatOverride() {
        val out = MobilePrintOverrideMapper.apply(
            existing = mapOf(
                "enable_support" to "1",
                "support_type" to "normal(auto)",
                "support_threshold_angle" to "35",
                "support_speed" to "70",
                "wall_loops" to "3",
            ),
            draft = MobilePrintOverrideDraft(
                wallLoops = "",
                supportMode = MobileSupportMode.Generate,
                supportStyle = MobileSupportStyle.NormalAuto,
                supportThresholdAngle = "",
                supportSpeed = "90",
            ),
        )

        assertFalse(out.containsKey("support_threshold_angle"))
        assertFalse(out.containsKey("wall_loops"))
        assertEquals("90", out["support_speed"])
        assertEquals("1", out["enable_support"])
    }

    @Test
    fun invalidNumericTextIsNotCommitted() {
        val out = MobilePrintOverrideMapper.apply(
            existing = mapOf(
                "support_speed" to "70",
                "support_threshold_angle" to "35",
                "sparse_infill_density" to "20%",
            ),
            draft = MobilePrintOverrideDraft(
                infillDensity = "999",
                supportMode = MobileSupportMode.Generate,
                supportStyle = MobileSupportStyle.TreeAuto,
                supportThresholdAngle = "35.5",
                supportSpeed = "-1",
            ),
        )

        assertEquals("20%", out["sparse_infill_density"])
        assertEquals("35", out["support_threshold_angle"])
        assertEquals("70", out["support_speed"])
        assertEquals("tree(auto)", out["support_type"])
        assertEquals("1", out["enable_support"])
    }
}
