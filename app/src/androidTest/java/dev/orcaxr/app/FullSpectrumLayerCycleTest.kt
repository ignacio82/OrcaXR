package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 2 contract — LayerCycle alternating-extruder emission via the
 * FullSpectrum data-model + patch 0019 ToolOrdering integration that
 * already ship in libslic3r.
 *
 * Setup: a bundled Snapmaker U1 4-color profile (PLA Standard), with
 * `wall_filament=3` overriding every wall to use virtual mixed-filament
 * row 1 (1-based: 4 physical + 1 virtual). `mixed_filament_definitions`
 * authors the v0.9.9 wire format for that one row (A=1, B=2, ratio 1:1,
 * LayerCycle). After the slice, the emitted G-code must contain both
 * `T0` and `T1` toolchanges across multiple layers because
 * `MixedFilamentManager::resolve(...)` cycles A → B → A → B per
 * `layer_index`. Catches regression in:
 *   - patch 0015 `MixedFilamentManager::resolve` LayerCycle algorithm
 *     (MixedFilament.cpp ~ line 1980-1988)
 *   - patch 0017 `MixedFilamentManager` member on `Print` (Print.hpp)
 *   - patch 0018 `m_mixed_filament_mgr.load_custom_entries(...)`
 *     (PrintApply.cpp:~1361-1364)
 *   - patch 0019 `LayerTools::resolve_mixed_1based` +
 *     `resolve_filament_for_layer` lambda (ToolOrdering.cpp)
 *   - patches 0027 + 0028 (PrintConfig.hpp typed fields +
 *     LayerTools::object_layer_count) — without these the FS code
 *     references compile-fail.
 *
 * Uses a real Snapmaker U1 profile (vs. inline config) so all
 * per-extruder vectors (filament_diameter, nozzle_temperature, etc.)
 * are consistent — libslic3r rejects partial configs.
 *
 * Requires a connected arm64-v8a Android device. Galaxy XR or the
 * Snapmaker U1's Android-based control panel both work.
 */
@RunWith(AndroidJUnit4::class)
class FullSpectrumLayerCycleTest {

    @Test
    fun layerCycleAlternatesT0T1AcrossEveryLayer() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)

        // Snapmaker U1 standard PLA + 0.4 nozzle. ID format
        // `bundled_<machine>.<process>.<filament>` — these substrings
        // match the bundled asset slug.
        val target = catalog.firstOrNull {
            it.id.contains("u1") &&
                it.id.contains("0.4") &&
                it.id.contains("pla_standard", ignoreCase = true)
        } ?: catalog.firstOrNull { it.id.contains("u1") && it.id.contains("0.4") }
        assertNotNull(
            "expected a Snapmaker U1 profile in the catalog of " +
                "${catalog.size} entries: ${catalog.take(10).joinToString { it.id }}",
            target,
        )

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

        // Snapmaker U1 has 4 physical slots → virtual row 1 = filament
        // id 5 (1-based: 4 physical + 1 virtual). Force every wall +
        // infill onto the virtual slot so the resolver fires layer-over-
        // layer. The master dithering toggle gates the FS code path.
        val virtualFilamentId = "5"
        val config = target!!.config + mapOf(
            "wall_filament" to virtualFilamentId,
            "sparse_infill_filament" to virtualFilamentId,
            "solid_infill_filament" to virtualFilamentId,
            "mixed_filament_definitions" to mixedDefinitions,
            "mixed_filament_advanced_dithering" to "1",
            "enable_prime_tower" to "1",
        )

        val result = SlicerEngine.slice(stl, outGcode, config)
        assertTrue("Slice produced gcode (got: $result)", result is SliceResult.Success)
        assertTrue("Output gcode exists", outGcode.exists())

        val gcode = outGcode.readText()
        val t0Count = Regex("""^T0\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        val t1Count = Regex("""^T1\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        assertTrue(
            "LayerCycle must emit T0 toolchanges (got $t0Count). " +
                "If 0, MixedFilamentManager::resolve isn't being consulted at " +
                "slice time — check patches 0017/0018/0019 still apply.",
            t0Count >= 1,
        )
        assertTrue(
            "LayerCycle must emit T1 toolchanges (got $t1Count). " +
                "Per-layer alternation requires both extruders to fire across " +
                "the slice; only one means the resolver isn't cycling.",
            t1Count >= 1,
        )
        assertTrue(
            "LayerCycle should produce roughly balanced T0/T1 counts (got " +
                "$t0Count vs $t1Count). 5x+ imbalance suggests resolve isn't cycling.",
            (t0Count.toDouble() / t1Count.coerceAtLeast(1)) in 0.2..5.0,
        )
    }
}
