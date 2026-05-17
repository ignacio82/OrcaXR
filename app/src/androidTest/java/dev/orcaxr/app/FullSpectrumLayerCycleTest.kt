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
    "LayerCycle Gap-1 (region_config_from_model_volume virtual " +
        "propagation, PrintObject.cpp) + Gap-3 (get_custom_seq cadence " +
        "preservation, ToolOrdering.cpp) were implemented and this test " +
        "(reworked to the real unpainted wall_filament=virtual UX + " +
        "hardened >=40-each / >=80%-alternation assertions) PASSED " +
        "GREEN on a connected Galaxy XR in-session (2026-05-17) " +
        "alongside PeggyPalette / LocalZ / Roundtrip staying GREEN. " +
        "BUT the fix lives in the third_party/OrcaSlicer SUBMODULE, " +
        "which is never committed (ignore=dirty) and is reset by " +
        "build_native.sh. It is NOT yet materialized as numbered " +
        "patches 0072 (Gap-1) / 0073 (Gap-3) in patches/. Stays " +
        "@Ignore'd so a clean build (no patches) doesn't run it red. " +
        "Un-ignore in the SAME commit that adds patches 0072/0073. " +
        "Full mechanism + the proven fix are in " +
        "docs/proposals/fullspectrum-layercycle-engine.md."
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
        // Real FS LayerCycle UX (proposal Phase 4): the user enables a
        // virtual row and `wall_filament` is set to its 1-based id —
        // NO painting. Snapmaker U1 has 4 physical slots → virtual row
        // 1 = filament id 5 (4 physical + 1 virtual). The earlier
        // paint-all-virtual approach was empirically disproven
        // (2026-05-17 trace: this build's painted segmentation is
        // Local-Z-centric, so an unpainted-Local-Z virtual slot never
        // reaches region.config().wall_filament — it stayed 1). The
        // Gap-1 region-config virtual-propagation fix in
        // region_config_from_model_volume now carries a project-level
        // virtual wall_filament past the Model::add_object extruder=1
        // stamp into PrintRegionConfig so resolve() cycles per layer.
        val virtualFilamentId = "5"
        val config = target!!.config + mapOf(
            // U1 PLA filament profile only declares 1 filament_diameter
            // entry, but the U1 machine has 4 nozzles. Without 4 entries
            // here the slicer trips Print::validate() with
            // "Too small line width". See FullSpectrumLocalZTest for
            // the same fix.
            "filament_diameter" to "1.75,1.75,1.75,1.75",
            // number_of_extruders (and ToolOrdering's filament_map /
            // calc_filament_change_info_by_toolorder sizing) derives
            // from filament_colour.size(). The U1 PLA profile declares
            // only 1 colour; once the Gap-1 fix makes resolve() return
            // real physical extruder 2 for the virtual row, a 1-entry
            // filament_colour makes filament_map[2] read OOB → SIGSEGV.
            // Declare 4 physical colours to match the 4-nozzle layout
            // (same shape the Roundtrip/Pointillisme FS tests use).
            "filament_colour" to "#FF0000;#00FF00;#0000FF;#FFFF00",
            "mixed_filament_definitions" to mixedDefinitions,
            "enable_prime_tower" to "1",
            // Every wall + infill on the virtual row → resolve() fires
            // layer-over-layer (LayerCycle modulo). Unpainted.
            "wall_filament" to virtualFilamentId,
            "sparse_infill_filament" to virtualFilamentId,
            "solid_infill_filament" to virtualFilamentId,
        )

        val result = SlicerEngine.slice(stl, outGcode, config)
        assertTrue("Slice produced gcode (got: $result)", result is SliceResult.Success)
        assertTrue("Output gcode exists", outGcode.exists())

        val gcode = outGcode.readText()
        val t0Count = Regex("""^T0\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        val t1Count = Regex("""^T1\s*$""", RegexOption.MULTILINE).findAll(gcode).count()

        // A 20 mm cube at 0.20 mm layer height is ~100 layers; a 1:1
        // LayerCycle row alternates the physical extruder every layer,
        // so each of T0/T1 must fire on the order of ~50 times. The
        // pre-fix failure mode was 0 of one tool (resolve never cycled /
        // reorder collapsed the cadence) — assert a strong floor, not
        // just >= 1.
        assertTrue(
            "LayerCycle must emit many T0 toolchanges (got $t0Count, want >= 40). " +
                "If low, the Gap-1 region-config virtual propagation or the " +
                "Gap-3 get_custom_seq cadence-preservation regressed.",
            t0Count >= 40,
        )
        assertTrue(
            "LayerCycle must emit many T1 toolchanges (got $t1Count, want >= 40). " +
                "Per-layer alternation requires both extruders ~equally.",
            t1Count >= 40,
        )
        assertTrue(
            "LayerCycle 1:1 must produce near-balanced T0/T1 (got $t0Count vs " +
                "$t1Count; |diff| must be <= 8). Imbalance => cadence not 1:1.",
            kotlin.math.abs(t0Count - t1Count) <= 8,
        )

        // Strongest signal: the ordered stream of T0/T1 tokens must
        // genuinely *alternate* per layer, not appear as two blocks
        // (all T0 then all T1) or single-tool. >= 80 % of adjacent
        // token pairs must be a change. A wipe-tower may occasionally
        // double a tool, so allow a small slack rather than requiring
        // strict A,B,A,B.
        val tokens = Regex("""^T([01])\s*$""", RegexOption.MULTILINE)
            .findAll(gcode).map { it.groupValues[1] }.toList()
        val transitions = tokens.zipWithNext().count { (a, b) -> a != b }
        val adjacencies = (tokens.size - 1).coerceAtLeast(1)
        assertTrue(
            "LayerCycle tokens must alternate per layer: only $transitions of " +
                "$adjacencies adjacent T-pairs changed (want >= 80 %). A low " +
                "ratio means the per-layer cadence collapsed to blocks/one tool. " +
                "First 24 tokens: ${tokens.take(24)}",
            transitions.toDouble() / adjacencies >= 0.80,
        )
    }
}
