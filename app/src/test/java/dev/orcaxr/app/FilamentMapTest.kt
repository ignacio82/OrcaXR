package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Tests for [computeFilamentMap]. Captures the Phase C minimal port of
 * Snapmaker fork PR #160 — when a project has more filament slots than
 * the printer has physical extruders, the filament_map config key must
 * cycle by modulo so every filament routes to a real T-command.
 *
 * Pre-Phase-C, OrcaXR built filament_map as identity (filament N → T_N),
 * so a 5-color project on the U1's 4 hot-ends emitted "T4" — which the
 * U1 doesn't have, and Klipper shut down on the unknown tool.
 */
class FilamentMapTest {

    @Test fun identityWhenFilamentCountEqualsExtruders() {
        // 4-filament dragon on U1's 4 hot-ends: identity, no cycling.
        assertEquals("1,2,3,4", computeFilamentMap(n = 4, numPhysical = 4))
    }

    @Test fun fewerFilamentsThanExtrudersLeavesUnusedExtruders() {
        // 2-filament project on U1: only T0 and T1 used.
        assertEquals("1,2", computeFilamentMap(n = 2, numPhysical = 4))
    }

    @Test fun fivthFilamentRoutesToFirstExtruder() {
        // The U1 use case PR #160 fixes: 5 filaments × 4 hot-ends.
        // Slot 4 (zero-based) should land on physical T0 (1-based "1").
        assertEquals("1,2,3,4,1", computeFilamentMap(n = 5, numPhysical = 4))
    }

    @Test fun eightFilamentsCycleTwiceThroughExtruders() {
        // Two full cycles of the 4-extruder mapping.
        assertEquals(
            "1,2,3,4,1,2,3,4",
            computeFilamentMap(n = 8, numPhysical = 4),
        )
    }

    @Test fun singleExtruderCollapsesToAllT0() {
        // Klipper printers without a toolchanger: every filament prints
        // on the only physical extruder. T_1 in 1-based libslic3r terms.
        assertEquals("1,1,1,1,1", computeFilamentMap(n = 5, numPhysical = 1))
    }

    @Test fun zeroNumPhysicalDefendsAgainstBadProfileData() {
        // A profile with no nozzle_diameter would land here. We coerce
        // to ≥1 so we never modulo-by-zero.
        assertEquals("1,1,1", computeFilamentMap(n = 3, numPhysical = 0))
    }

    @Test fun slotRemapOverridesIdentityThenCycles() {
        // User picked the "Loaded in printer" row for filament 4 and
        // asked for physical slot 7 (out-of-range — gets coerced to
        // n-1=4 first, then 4 % 4 = 0 → T1).
        assertEquals(
            "1,2,3,4,1",
            computeFilamentMap(
                n = 5,
                numPhysical = 4,
                slotRemap = listOf(null, null, null, null, 7),
            ),
        )
    }

    @Test fun slotRemapWithinRangeBypassesModulo() {
        // User remapped filament 0 to physical slot 2 (T3 in 1-based).
        // Other filaments use identity-then-modulo.
        assertEquals(
            "3,2,3,4,1",
            computeFilamentMap(
                n = 5,
                numPhysical = 4,
                slotRemap = listOf(2),
            ),
        )
    }

    // ----------------------------------------------------------------
    // End-to-end Kotlin path. Pins the dragon-color-mapping bug fix:
    // when the user maps project filament 0 onto physical slot 1
    // ("yellow" T2 in the printer's 1-based UI), the helpers must
    // propagate that pick all the way through to the libslic3r
    // `filament_map` config key. The libslic3r-side patch
    // (patches/0027) then makes that map actually drive the gcode
    // T-command; this test guards the input side.
    // ----------------------------------------------------------------

    /**
     * Snapmaker U1-shaped profile: 4 physical extruders (`nozzle_diameter`
     * has 4 entries) with the per-extruder vectors libslic3r requires for
     * the toolchanger code path, plus a non-empty `before_layer_change_gcode`
     * so headless slices satisfy `Print::validate()` (libslic3r requires a
     * `G92 E0` under the relative-E mode the JNI shim forces — see GEMINI.md
     * gotcha #15). The exact temperature numbers don't matter for the
     * filament-map plumbing test; they just need to be plausible scalars
     * libslic3r will accept.
     */
    private fun u1ShapedProfile(): SlicerProfile = SlicerProfile(
        id = "test_u1_shaped",
        displayName = "Test U1-shaped",
        description = "4-extruder Klipper toolchanger config for filament-map plumbing tests",
        config = mapOf(
            "nozzle_diameter" to "0.4,0.4,0.4,0.4",
            "filament_diameter" to "1.75",
            "filament_type" to "PLA",
            "filament_density" to "1.24",
            "nozzle_temperature" to "215",
            "nozzle_temperature_initial_layer" to "220",
            "hot_plate_temp" to "60",
            "hot_plate_temp_initial_layer" to "65",
            "before_layer_change_gcode" to "G92 E0\n",
            "layer_height" to "0.20",
            "initial_layer_print_height" to "0.20",
        ),
    )

    @Test fun userMapsProjectFilament0OntoPhysicalT2DragonScenario() {
        // Reproduce the user's interaction verbatim:
        //   1. Project starts with 4 filaments (the dragon's authored
        //      colors). Identity mapping by default.
        //   2. User opens project filament 0's mapping picker and taps
        //      the printer's T2 swatch (slotIndex = 1, 0-based).
        //   3. mergedConfig is invoked at slice time with the resulting
        //      paddedSlotRemap.
        // The expected output is filament_map = "2,2,3,4" — slot 0
        // emits T-command for physical extruder 2 (libslic3r 1-based
        // = "2"), the rest stay identity. Without the picker push-
        // through, filament_map collapses to "1,2,3,4" and the dragon
        // body prints from physical T1 (black) instead of T2 (yellow).
        val initial = listOf(
            FilamentEntry(id = "f0", color = "#202020", slotIndex = 0, filamentType = "PLA"), // body
            FilamentEntry(id = "f1", color = "#FFC400", slotIndex = 1, filamentType = "PLA"),
            FilamentEntry(id = "f2", color = "#FF3030", slotIndex = 2, filamentType = "PLA"),
            FilamentEntry(id = "f3", color = "#3070FF", slotIndex = 3, filamentType = "PLA"),
        )

        val afterPick = applyMapToPhysical(initial, slot = 0, physicalSlot = 1)
        assertEquals(1, afterPick[0].physicalSlot)
        assertEquals(null, afterPick[1].physicalSlot)

        // MainActivity derives paddedSlots / paddedSlotRemap from the
        // filamentList. Mirror that derivation here so the test exercises
        // the full chain that mergedConfig sees on the slice path.
        val paddedSlots = afterPick.map { it.color }
        val paddedSlotRemap = afterPick.map { it.physicalSlot }

        val cfg = mergedConfig(
            profile = u1ShapedProfile(),
            layerHeightInput = "",
            slotColors = paddedSlots,
            slotRemap = paddedSlotRemap,
        )

        // The plumbing assertion the bug fix turns on: filament_map[0]
        // must be 2 (1-based libslic3r = physical extruder 2 = the
        // user's "T2 yellow"). The rest stay identity.
        assertEquals("2,2,3,4", cfg["filament_map"])
        // filament_map_mode must be "Manual" or Print::process auto-
        // recomputes the map at slice time and trashes our remap.
        assertEquals("Manual", cfg["filament_map_mode"])

        // The model's authored body color survives the mapping edit
        // — the user mapping the body onto physical T2 must NOT also
        // recolor the body to yellow on the gcode header. (The
        // physical print comes out yellow because that's what's loaded
        // at the destination slot, not because we lied to libslic3r
        // about the body's color.)
        assertEquals("#202020;#FFC400;#FF3030;#3070FF", cfg["filament_colour"])
        assertEquals("#202020;#FFC400;#FF3030;#3070FF", cfg["extruder_colour"])
    }

    @Test fun identityMappingProducesIdentityFilamentMap() {
        // Sanity-check the no-remap path. Without any picker activity,
        // mergedConfig must emit "1,2,3,4" so identity-numbered project
        // filaments hit identity-numbered physical extruders.
        val initial = listOf(
            FilamentEntry(id = "f0", color = "#202020", slotIndex = 0, filamentType = "PLA"),
            FilamentEntry(id = "f1", color = "#FFC400", slotIndex = 1, filamentType = "PLA"),
            FilamentEntry(id = "f2", color = "#FF3030", slotIndex = 2, filamentType = "PLA"),
            FilamentEntry(id = "f3", color = "#3070FF", slotIndex = 3, filamentType = "PLA"),
        )

        val cfg = mergedConfig(
            profile = u1ShapedProfile(),
            layerHeightInput = "",
            slotColors = initial.map { it.color },
            slotRemap = initial.map { it.physicalSlot },
        )

        assertEquals("1,2,3,4", cfg["filament_map"])
    }

    @Test fun applyChangeColorAfterMapDoesNotResetFilamentMap() {
        // Defends the Phase J split: a color edit on a row that already
        // has a physical-slot mapping must NOT clear that mapping. The
        // mergedConfig output must still carry the user's remap. This
        // is the exact scenario the original "dragon body printed black"
        // bug came from — the pre-Phase-J onChangeFilamentColor lambda
        // cleared physicalSlot as a side effect. The current pure
        // applyChangeColor does not, and this test guards that contract
        // at the slicer-input level rather than just the helper level.
        val initial = listOf(
            FilamentEntry(id = "f0", color = "#202020", slotIndex = 0, filamentType = "PLA"),
            FilamentEntry(id = "f1", color = "#FFC400", slotIndex = 1, filamentType = "PLA"),
            FilamentEntry(id = "f2", color = "#FF3030", slotIndex = 2, filamentType = "PLA"),
            FilamentEntry(id = "f3", color = "#3070FF", slotIndex = 3, filamentType = "PLA"),
        )
        val mapped = applyMapToPhysical(initial, slot = 0, physicalSlot = 1)
        // User then tweaks the body's authored shade.
        val recolored = applyChangeColor(mapped, slot = 0, hex = "#101010")

        val cfg = mergedConfig(
            profile = u1ShapedProfile(),
            layerHeightInput = "",
            slotColors = recolored.map { it.color },
            slotRemap = recolored.map { it.physicalSlot },
        )

        // Color edit propagated.
        assertEquals("#101010;#FFC400;#FF3030;#3070FF", cfg["filament_colour"])
        // Mapping survived the color edit.
        assertEquals("2,2,3,4", cfg["filament_map"])
    }
}
