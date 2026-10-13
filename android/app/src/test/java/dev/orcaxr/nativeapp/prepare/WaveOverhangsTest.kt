package dev.orcaxr.nativeapp.prepare

import dev.orcaxr.core.ProjectSettingsOverrideSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WaveOverhangsTest {
    @Test
    fun catalogContainsAll38Options() {
        assertEquals(38, WaveOverhangs.OPTIONS.size)
        val keys = WaveOverhangs.OPTIONS.map { it.key }.toSet()
        assertEquals(38, keys.size)
        assertTrue(keys.contains(WaveOverhangs.MASTER_KEY))
        assertTrue(keys.contains("support_remaining_areas_after_wave_overhangs"))
        assertTrue(keys.contains("wave_overhangs_instead_of_bridges"))
        assertTrue(keys.contains("wave_overhang_pattern"))
        assertTrue(keys.contains("wave_overhang_flow_mm3_per_mm"))
        assertTrue(keys.contains("wave_overhang_floor_layers"))
        assertTrue(keys.contains("wave_overhang_debug_gcode"))
    }

    @Test
    fun resolveWithDefaults() {
        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = "{}",
            effectiveConfigJson = "{}",
            sourceRevision = 1L,
            sourceHash = "abc",
        )
        val state = WaveOverhangs.resolve(snapshot)
        assertFalse(state.enabled)
        assertFalse(state.hasOverrides)
        assertEquals(38, state.options.size)
        val master = state.options.first { it.option.key == WaveOverhangs.MASTER_KEY }
        assertEquals(false, master.value)
        assertEquals(WaveValueSource.DEFAULT, master.source)
        assertTrue(master.applies)

        // Sub-options do not apply when master switch is off
        val bridges = state.options.first { it.option.key == "wave_overhangs_instead_of_bridges" }
        assertFalse(bridges.applies)
    }

    @Test
    fun resolveWithMasterEnabledAndOverrides() {
        val overrides = """{"${WaveOverhangs.MASTER_KEY}":"1","wave_overhang_pattern":"monotonic","wave_overhang_print_speed":"3.5","layer_height":"0.2"}"""

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = overrides,
            effectiveConfigJson = overrides,
            sourceRevision = 2L,
            sourceHash = "def",
        )
        val state = WaveOverhangs.resolve(snapshot)
        assertTrue(state.enabled)
        assertTrue(state.hasOverrides)

        val master = state.options.first { it.option.key == WaveOverhangs.MASTER_KEY }
        assertEquals(true, master.value)
        assertEquals(WaveValueSource.OVERRIDE, master.source)

        val pattern = state.options.first { it.option.key == "wave_overhang_pattern" }
        assertEquals("monotonic", pattern.value)
        assertEquals(WaveValueSource.OVERRIDE, pattern.source)
        assertTrue(pattern.applies)

        val speed = state.options.first { it.option.key == "wave_overhang_print_speed" }
        assertEquals(3.5, speed.value)
        assertEquals(WaveValueSource.OVERRIDE, speed.source)
        assertTrue(speed.applies)

        // Sub-option without override falls back to default
        val flow = state.options.first { it.option.key == "wave_overhang_flow_mm3_per_mm" }
        assertEquals(0.15, flow.value)
        assertEquals(WaveValueSource.DEFAULT, flow.source)
        assertTrue(flow.applies)
    }

    @Test
    fun conditionalRequirementsEnforced() {
        val overrides = """{"${WaveOverhangs.MASTER_KEY}":"1","wave_overhang_corner_taper_enable":"0","wave_overhang_floor_use_hilbert":"1"}"""

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = overrides,
            effectiveConfigJson = overrides,
            sourceRevision = 3L,
            sourceHash = "ghi",
        )
        val state = WaveOverhangs.resolve(snapshot)
        assertTrue(state.enabled)

        // Corner taper is disabled, so corner sub-options do not apply
        val cornerSpacing = state.options.first { it.option.key == "wave_overhang_line_spacing_corner" }
        assertFalse(cornerSpacing.applies)

        // Hilbert floor is enabled, so hilbert density applies
        val hilbertDensity = state.options.first { it.option.key == "wave_overhang_floor_hilbert_density" }
        assertTrue(hilbertDensity.applies)
    }

    @Test
    fun noticeDetection() {
        val effective = """{"detect_overhang_wall":"0","wall_loops":0,"spiral_mode":"1"}"""

        val snapshot = ProjectSettingsOverrideSnapshot(
            inheritedConfigJson = "{}",
            overridesJson = "{}",
            effectiveConfigJson = effective,
            sourceRevision = 4L,
            sourceHash = "jkl",
        )
        val state = WaveOverhangs.resolve(snapshot)
        val noticeIds = state.notices.map { it.id }.toSet()
        assertTrue(noticeIds.contains("detect-overhang-wall-off"))
        assertTrue(noticeIds.contains("no-walls"))
        assertTrue(noticeIds.contains("spiral-vase"))
    }

    @Test
    fun valueMutationAndReset() {
        var json = """{"other_setting":"foo"}"""
        json = WaveOverhangs.withValue(json, WaveOverhangs.MASTER_KEY, true)
        json = WaveOverhangs.withValue(json, "wave_overhang_print_speed", 2.5)

        val obj1 = MiniJson.parseMap(json)
        assertEquals("1", obj1[WaveOverhangs.MASTER_KEY])
        assertEquals("2.5", obj1["wave_overhang_print_speed"])
        assertEquals("foo", obj1["other_setting"])

        // Single key removal
        json = WaveOverhangs.withoutValue(json, "wave_overhang_print_speed")
        val obj2 = MiniJson.parseMap(json)
        assertFalse(obj2.containsKey("wave_overhang_print_speed"))
        assertTrue(obj2.containsKey(WaveOverhangs.MASTER_KEY))
        assertTrue(obj2.containsKey("other_setting"))

        // Reset all wave overrides preserves other settings
        json = WaveOverhangs.withoutOverrides(json)
        val obj3 = MiniJson.parseMap(json)
        assertFalse(obj3.containsKey(WaveOverhangs.MASTER_KEY))
        assertEquals("foo", obj3["other_setting"])
    }

    @Test
    fun fixNotice() {
        val json = WaveOverhangs.withNoticeFix("{}", "enable-overhang-detection")
        val obj = MiniJson.parseMap(json)
        assertEquals("1", obj["detect_overhang_wall"])
    }
}
