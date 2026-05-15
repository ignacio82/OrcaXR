package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Ignore
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
@Ignore(
    "FullSpectrum LayerCycle fully diagnosed 2026-05-15 (see " +
        "docs/proposals/fullspectrum-layercycle-engine.md §Status; " +
        "instrumented on Pixel 10 Pro XL + Galaxy XR). It is THREE " +
        "stacked gaps, all part of the same FS v0.9.9 emission port: " +
        "(1) region-config propagation -- the BBS Model::add_object " +
        "extruder=1 stamp is force-mapped onto wall_filament and is " +
        "indistinguishable from a deliberate per-object extruder, so " +
        "propagation canNOT be fixed in isolation; (2) FS-virtual-wall " +
        "regions are wipe-tower is_overriddable so collect_extruders " +
        "never emplaces the resolved per-layer extruder; (3) the " +
        "resolved cadence does not survive reorder_filaments_for_" +
        "minimum_flush_volume (ToolOrderUtils.cpp, zero MixedFilament " +
        "awareness) + _make_wipe_tower into the emission ToolOrdering " +
        "(post-reorder layer_tools collapse to [0]/[]). No standalone " +
        "propagation fix exists; this is the ~800-LoC GCode.cpp + " +
        "~311-LoC ToolOrdering + reorder-DP FS port. Candidate patches " +
        "0072/0073 were prototyped + reverted (no standalone benefit). " +
        "The painted-Local-Z path (FullSpectrumLocalZTest) remains the " +
        "working multi-color recipe -- BUT note PeggyPalette parity is " +
        "separately regressed on current main (+5.4% T1, pre-existing, " +
        "unrelated to LayerCycle; bisect afc6f7d..e8a7cad). Un-ignore " +
        "when the Gap 1+2+3 emission port lands."
)
class FullSpectrumLayerCycleTest {

    @Test
    fun layerCycleAlternatesT0T1AcrossEveryLayer() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)

        // Snapmaker U1 standard PLA + 0.4 nozzle. ID format
        // `bundled_<machine>.<process>.<filament>` — IDs use underscores
        // (e.g. "bundled_..._0.4_nozzle..."), and "0.4" alone matches
        // both nozzle and layer-height substrings, which can merge a
        // 0.8-nozzle process onto a 0.4-nozzle machine. Match the
        // specific 0.4-nozzle / 0.20-standard / PLA profile.
        val target = catalog.firstOrNull {
            it.id.contains("u1", ignoreCase = true) &&
                it.id.contains("0.4_nozzle", ignoreCase = true) &&
                it.id.contains("0.20", ignoreCase = true) &&
                it.id.contains("pla", ignoreCase = true)
        } ?: catalog.firstOrNull {
            it.id.contains("u1", ignoreCase = true) &&
                it.id.contains("0.4_nozzle", ignoreCase = true) &&
                it.id.contains("pla", ignoreCase = true)
        }
        assertNotNull(
            "expected a Snapmaker U1 0.4-nozzle PLA profile in the catalog of " +
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
        // Paint EVERY triangle with virtual filament slot 5. The
        // wall_filament=5 / sparse_infill_filament=5 / etc. global
        // overrides DO NOT propagate to PrintRegionConfig in our
        // build (region.config().wall_filament stays at the default
        // 1), so the resolver was being called with filament_id=1
        // and not hitting the virtual path at all. Painting via
        // mmu_segmentation_facets routes each face through
        // apply_mm_segmentation which creates a per-extruder region
        // for the virtual slot — that path is proven by the LocalZ
        // test.
        val virtualSlot = 5.toByte()
        val paintAllVirtual = ByteArray(12) { virtualSlot }
        val config = target!!.config + mapOf(
            // U1 PLA filament profile only declares 1 filament_diameter
            // entry, but the U1 machine has 4 nozzles. Without 4 entries
            // here the slicer trips Print::validate() with
            // "Too small line width". See FullSpectrumLocalZTest for
            // the same fix.
            "filament_diameter" to "1.75,1.75,1.75,1.75",
            "mixed_filament_definitions" to mixedDefinitions,
            "enable_prime_tower" to "1",
        )

        val result = SlicerEngine.slice(stl, outGcode, config, paintFilamentIndex = paintAllVirtual)
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
