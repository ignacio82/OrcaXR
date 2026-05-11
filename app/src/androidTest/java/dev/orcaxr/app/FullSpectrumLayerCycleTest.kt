package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 2 contract — LayerCycle alternating-extruder emission via the
 * FullSpectrum data-model + patch-0019 ToolOrdering integration that
 * already ship in libslic3r.
 *
 * Setup: 2 physical filaments + 1 virtual mixed-filament row
 * (component A=1, B=2, ratio 1:1, LayerCycle distribution). Force
 * every wall onto the virtual slot via `wall_filament=3` (1-based:
 * 2 physical + 1 virtual). After the slice, the emitted G-code must
 * contain alternating `T0` / `T1` toolchanges layer-over-layer because
 * `MixedFilamentManager::resolve(...)` cycles A → B → A → B per
 * `layer_index`. Catches regression in:
 *   - patch 0019 `LayerTools::resolve_mixed_1based` (ToolOrdering.cpp)
 *   - patch 0018 `m_mixed_filament_mgr.load_custom_entries(...)` (PrintApply.cpp)
 *   - patch 0017 `MixedFilamentManager` member on `Print` (Print.hpp)
 *   - patch 0015 `MixedFilamentManager::resolve` LayerCycle algorithm
 *     (MixedFilament.cpp ~ line 1980-1988)
 */
@RunWith(AndroidJUnit4::class)
class FullSpectrumLayerCycleTest {

    @Test
    fun layerCycleAlternatesT0T1AcrossEveryLayer() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val stl = File(appCtx.cacheDir, "fs_layercycle_cube.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val outGcode = File(appCtx.cacheDir, "fs_layercycle.gcode")

        // One virtual row mixing filaments 1+2, ratio 1:1, LayerCycle mode.
        val virtualRow = MixedFilamentEntry(
            id = "v1",
            componentA = 1,
            componentB = 2,
            ratioA = 1,
            ratioB = 1,
            distributionMode = 0,  // LayerCycle
            enabled = true,
            custom = true,
        )
        val mixedDefinitions = serializeMixedFilamentDefinitions(listOf(virtualRow))

        // Two physical filaments authored; wall_filament=3 picks the
        // virtual row (1-based: 2 physical + 1 virtual). Per-extruder
        // numeric vectors are sized to 2 so libslic3r's toolchanger
        // validators don't reject. Minimal print config so the slice
        // completes end-to-end on the 20mm cube fixture.
        val config = mapOf(
            "before_layer_change_gcode" to "G92 E0\n",
            "filament_colour" to "#FF0000;#0000FF",
            "filament_type" to "PLA;PLA",
            "filament_settings_id" to "PLA1;PLA2",
            "nozzle_diameter" to "0.4;0.4",
            "extruder_offset" to "0x0;0x0",
            "filament_diameter" to "1.75;1.75",
            "filament_density" to "1.24;1.24",
            "filament_max_volumetric_speed" to "22;22",
            "wall_filament" to "3",
            "sparse_infill_filament" to "3",
            "solid_infill_filament" to "3",
            "single_extruder_multi_material" to "0",
            "mixed_filament_definitions" to mixedDefinitions,
            "mixed_filament_advanced_dithering" to "1",
            "layer_height" to "0.2",
            "initial_layer_print_height" to "0.2",
            "wall_loops" to "2",
            "sparse_infill_density" to "10%",
            "enable_prime_tower" to "1",
        )

        val result = SlicerEngine.slice(stl, outGcode, config)
        assertTrue("Slice produced gcode (got: $result)", result is SliceResult.Success)
        assertTrue("Output gcode exists", outGcode.exists())

        val gcode = outGcode.readText()
        val t0Count = Regex("""^T0\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        val t1Count = Regex("""^T1\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        assertTrue(
            "LayerCycle must emit multiple T0 toolchanges (got $t0Count). " +
                "If 0, MixedFilamentManager::resolve isn't being consulted at " +
                "slice time — check patches 0017/0018/0019 still apply.",
            t0Count >= 5,
        )
        assertTrue(
            "LayerCycle must emit multiple T1 toolchanges (got $t1Count). " +
                "Per-layer alternation requires both extruders to fire across " +
                "the slice; only one means the resolver isn't cycling.",
            t1Count >= 5,
        )
    }
}
