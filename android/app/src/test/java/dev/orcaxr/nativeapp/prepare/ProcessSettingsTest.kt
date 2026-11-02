package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectSettingsOverrideSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProcessSettingsTest {

    @Test
    fun defaultResolutionWhenEmpty() {
        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = "{}",
            effectiveConfigJson = "{}",
            sourceRevision = 1L,
            sourceHash = "abc",
        )

        val settings = ProcessSettings.resolve(snapshot)
        assertEquals(ProcessSettings.BRIM_TYPE_AUTO, settings.brimType)
        assertFalse(settings.isBrimDisabled)
        assertEquals(ProcessSettings.DEFAULT_BRIM_WIDTH_MM, settings.brimWidthMm, 0.001)
        assertFalse(settings.enableSupport)
        assertEquals(ProcessSettings.SUPPORT_TYPE_NORMAL_AUTO, settings.supportType)
        assertEquals(ProcessSettings.SUPPORT_STYLE_DEFAULT, settings.supportStyle)
        assertFalse(settings.supportOnBuildPlateOnly)
        assertFalse(settings.hasOverrides)
    }

    @Test
    fun resolvesInheritedConfig() {
        val inheritedJson = """
            {
                "brim_type": "outer_only",
                "brim_width": "8.0",
                "enable_support": "1",
                "support_type": "tree(auto)",
                "support_style": "snug",
                "support_on_build_plate_only": "1",
                "sparse_infill_density": "20%",
                "wall_loops": "3"
            }
        """.trimIndent()

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = inheritedJson,
            overridesJson = "{}",
            effectiveConfigJson = inheritedJson,
            sourceRevision = 1L,
            sourceHash = "abc",
        )

        val settings = ProcessSettings.resolve(snapshot)
        assertEquals("outer_only", settings.brimType)
        assertFalse(settings.isBrimDisabled)
        assertEquals(8.0, settings.brimWidthMm, 0.001)
        assertTrue(settings.enableSupport)
        assertEquals("tree(auto)", settings.supportType)
        assertEquals("snug", settings.supportStyle)
        assertTrue(settings.supportOnBuildPlateOnly)
        assertEquals("20%", settings.sparseInfillDensity)
        assertEquals(3, settings.wallLoops)
        assertFalse(settings.brimOverridden)
        assertFalse(settings.supportOverridden)
    }

    @Test
    fun disableBrimOverridesPreset() {
        val inheritedJson = """{"brim_type": "auto_brim"}"""
        val overridesJson = ProcessSettings.withValue("{}", ProcessSettings.KEY_BRIM_TYPE, ProcessSettings.BRIM_TYPE_NO_BRIM)

        val effectiveJson = """{"brim_type": "no_brim"}"""

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = inheritedJson,
            overridesJson = overridesJson,
            effectiveConfigJson = effectiveJson,
            sourceRevision = 2L,
            sourceHash = "def",
        )

        val settings = ProcessSettings.resolve(snapshot)
        assertEquals(ProcessSettings.BRIM_TYPE_NO_BRIM, settings.brimType)
        assertTrue(settings.isBrimDisabled)
        assertTrue(settings.brimOverridden)
        assertTrue(settings.hasOverrides)
    }

    @Test
    fun enableAndChangeSupportSettings() {
        var overrides = "{}"
        overrides = ProcessSettings.withValue(overrides, ProcessSettings.KEY_ENABLE_SUPPORT, true)
        overrides = ProcessSettings.withValue(overrides, ProcessSettings.KEY_SUPPORT_TYPE, ProcessSettings.SUPPORT_TYPE_TREE_AUTO)
        overrides = ProcessSettings.withValue(overrides, ProcessSettings.KEY_SUPPORT_STYLE, ProcessSettings.SUPPORT_STYLE_TREE_SLIM)
        overrides = ProcessSettings.withValue(overrides, ProcessSettings.KEY_SUPPORT_ON_BUILD_PLATE_ONLY, true)

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = overrides,
            effectiveConfigJson = overrides,
            sourceRevision = 3L,
            sourceHash = "ghi",
        )

        val settings = ProcessSettings.resolve(snapshot)
        assertTrue(settings.enableSupport)
        assertEquals(ProcessSettings.SUPPORT_TYPE_TREE_AUTO, settings.supportType)
        assertEquals(ProcessSettings.SUPPORT_STYLE_TREE_SLIM, settings.supportStyle)
        assertTrue(settings.supportOnBuildPlateOnly)
        assertTrue(settings.supportOverridden)
    }

    @Test
    fun clearSettingRevertsToInherited() {
        val initialOverrides = """{"brim_type": "no_brim", "enable_support": "1"}"""
        val withoutBrim = ProcessSettings.withoutValue(initialOverrides, ProcessSettings.KEY_BRIM_TYPE)

        val map = MiniJson.parseMap(withoutBrim)
        assertFalse(map.containsKey(ProcessSettings.KEY_BRIM_TYPE))
        assertEquals("1", map[ProcessSettings.KEY_ENABLE_SUPPORT])
    }

    @Test
    fun withoutOverridesRemovesProcessKeys() {
        val initialOverrides = """
            {
                "brim_type": "no_brim",
                "enable_support": "1",
                "custom_other_key": "some_value"
            }
        """.trimIndent()

        val stripped = ProcessSettings.withoutOverrides(initialOverrides)
        val map = MiniJson.parseMap(stripped)
        assertFalse(map.containsKey(ProcessSettings.KEY_BRIM_TYPE))
        assertFalse(map.containsKey(ProcessSettings.KEY_ENABLE_SUPPORT))
        assertEquals("some_value", map["custom_other_key"])
    }
}
