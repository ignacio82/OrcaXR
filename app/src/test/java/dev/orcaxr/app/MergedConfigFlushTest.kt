package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests the `flush_volumes_matrix` / `flush_multiplier` resolution in
 * [mergedConfig]. These keys drive `WipeTowerIntegration::plan_toolchange`
 * (Print.cpp:3240); the wrong size or value here directly inflates wipe-
 * tower volume on multi-color prints. Three resolution branches:
 *
 *   1. 3MF settings whose size matches `n × n × nozzle_count` pass
 *      through verbatim.
 *   2. 3MF settings of the wrong size fall back to a synthesized 30 mm³
 *      default (NEVER an OOB-sized vector — libslic3r would read past
 *      the end of values[] in `get_flush_volumes_matrix`).
 *   3. No 3MF settings → synthesized default. Same as the branch above
 *      because the synth happens at the same point in the resolution.
 *
 * Driven by [synthesizeFlushMatrix] (the helper) plus the merge logic
 * in [mergedConfig].
 */
class MergedConfigFlushTest {

    private val baseProfile = SlicerProfile(
        id = "test_profile",
        displayName = "Test profile",
        description = "Synthetic fixture for flush-settings resolution",
        // Carry a matching nozzle_diameter for numPhysical=1 so the
        // mergedConfig path takes the single-nozzle branch. Multi-
        // nozzle scenarios are covered explicitly below.
        config = mapOf(
            "layer_height" to "0.20",
            "nozzle_diameter" to "0.4",
        ),
    )

    private fun parseCsv(s: String?): List<String> =
        s.orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }

    @Test fun synthesizeFlushMatrixTwoFilamentsOneNozzleHasZeroDiagonal() {
        val out = parseCsv(synthesizeFlushMatrix(filaments = 2, nozzles = 1, defaultMm3 = 30.0))
        assertEquals(4, out.size)
        // Row 0: [0, 30]; Row 1: [30, 0].
        assertEquals(listOf("0", "30", "30", "0"), out)
    }

    @Test fun synthesizeFlushMatrixSizeIsFilamentsSquaredTimesNozzles() {
        // U1 toolchanger shape: 4 filaments × 4 independent nozzles.
        val out = parseCsv(synthesizeFlushMatrix(filaments = 4, nozzles = 4, defaultMm3 = 30.0))
        assertEquals(64, out.size)
        // First nozzle's block, first row: [0, 30, 30, 30].
        assertEquals(listOf("0", "30", "30", "30"), out.subList(0, 4))
        // Second nozzle's block starts at index 16, diagonal still 0.
        assertEquals("0", out[16])
        assertEquals("0", out[16 + 5])  // [1][1] in the second block
    }

    @Test fun synthesizeFlushMatrixHandlesFractionalDefault() {
        // Some authoring tools emit non-integer defaults like 27.5 mm³.
        // The CSV must round-trip without locale-induced commas in the
        // decimal — libslic3r reads `,` as a vector separator.
        val out = synthesizeFlushMatrix(filaments = 2, nozzles = 1, defaultMm3 = 27.5)
        // Body: [0, 27.500, 27.500, 0]
        assertTrue("expected dotted decimal in $out", out.contains("27.500"))
        assertEquals(4, parseCsv(out).size)
    }

    @Test fun mergedConfigUsesSynthesizedDefaultWhenNoFlushSettingsSupplied() {
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00"),
            flushFromProject = null,
        )
        val matrix = parseCsv(cfg["flush_volumes_matrix"])
        val multiplier = parseCsv(cfg["flush_multiplier"])
        // 2 filaments × 1 nozzle = 4 entries.
        assertEquals(4, matrix.size)
        assertEquals("0", matrix[0])
        assertEquals("30", matrix[1])
        // Multiplier sized to nozzle count (1), value 1.0 so the
        // matrix is the literal mm³.
        assertEquals(listOf("1.0"), multiplier)
    }

    @Test fun mergedConfigPassesThroughEmbeddedSettingsWhenSizeMatches() {
        val embedded = SlicerEngine.FlushSettings(
            matrix = "0,17,17,0",
            multiplier = "0.8",
        )
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00"),
            flushFromProject = embedded,
        )
        assertEquals("0,17,17,0", cfg["flush_volumes_matrix"])
        assertEquals("0.8", cfg["flush_multiplier"])
    }

    @Test fun mergedConfigFallsBackWhenEmbeddedMatrixSizeWrong() {
        // 3MF authored for 4 filaments (16 entries) but the project has
        // 5 slots — neither the n² shape (25 expected) nor the
        // n²×nozzles shape matches. Forwarding would OOB-read in
        // `WipeTowerIntegration::plan_toolchange`, so we synth a 25-
        // entry default instead.
        val mismatched = SlicerEngine.FlushSettings(
            matrix = (1..16).joinToString(",") { "99" },
            multiplier = "0.3",
        )
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#A", "#B", "#C", "#D", "#E"),
            flushFromProject = mismatched,
        )
        val matrix = parseCsv(cfg["flush_volumes_matrix"])
        assertEquals(25, matrix.size)
        // None of the embedded "99" values made it through.
        assertTrue("synth fallback must not contain embedded values: $matrix",
                   matrix.none { it == "99" })
        // Diagonal still zero.
        assertEquals("0", matrix[0])
        assertEquals("0", matrix[6])
    }

    @Test fun mergedConfigReplicatesSingleNozzleMatrixAcrossPhysicalNozzles() {
        // FullSpectrum / OrcaSlicer 3MFs commonly ship the matrix at
        // "single-nozzle" size (n²) — the per-filament-pair calibration
        // is identical across physical extruders, so the authoring
        // tool serializes one block. libslic3r's PresetBundle expands
        // it on desktop load (PresetBundle.cpp:4316-4350); mergedConfig
        // mirrors that expansion. Without it, a U1 toolchanger user
        // would silently see the 30 mm³ synth fallback even when
        // their 3MF carried tuned 233-800 mm³ values.
        val u1Profile = baseProfile.copy(
            config = baseProfile.config + ("nozzle_diameter" to "0.4,0.4,0.4,0.4"),
        )
        val singleNozzleMatrix = listOf(
            "0", "233", "729", "683",
            "551", "0", "703", "800",
            "405", "223", "0", "377",
            "399", "270", "450", "0",
        )
        val embedded = SlicerEngine.FlushSettings(
            matrix = singleNozzleMatrix.joinToString(","),
            multiplier = "0.9",  // single scalar — replicated per nozzle
        )
        val cfg = mergedConfig(
            profile = u1Profile,
            layerHeightInput = "0.20",
            slotColors = listOf("#A", "#B", "#C", "#D"),
            flushFromProject = embedded,
        )
        val matrix = parseCsv(cfg["flush_volumes_matrix"])
        // 4 filaments × 4 filaments × 4 nozzles = 64 entries.
        assertEquals(64, matrix.size)
        // First nozzle's block is the authored matrix.
        assertEquals(singleNozzleMatrix, matrix.subList(0, 16))
        // Subsequent nozzles' blocks are identical replicas.
        assertEquals(singleNozzleMatrix, matrix.subList(16, 32))
        assertEquals(singleNozzleMatrix, matrix.subList(48, 64))
        // Multiplier expanded to 4 entries, all 0.9.
        assertEquals(listOf("0.9", "0.9", "0.9", "0.9"), parseCsv(cfg["flush_multiplier"]))
    }

    @Test fun mergedConfigFallsBackWhenEmbeddedMultiplierSizeWrong() {
        // Mismatched multiplier (3 entries for a 1-nozzle profile)
        // still triggers the synth fallback for that field.
        val odd = SlicerEngine.FlushSettings(
            matrix = "0,17,17,0",  // valid for n=2, nozzles=1
            multiplier = "0.3,0.3,0.3",  // wrong: expected 1 entry
        )
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#FF0000", "#00FF00"),
            flushFromProject = odd,
        )
        // Matrix passes through (size matches).
        assertEquals("0,17,17,0", cfg["flush_volumes_matrix"])
        // Multiplier falls back to synthesized 1.0.
        assertEquals("1.0", cfg["flush_multiplier"])
    }

    @Test fun mergedConfigHonorsMultipleNozzlesInSynthesizedDefault() {
        // U1 toolchanger profile: 4 nozzle_diameter entries → 4 nozzles.
        val u1Profile = baseProfile.copy(
            config = baseProfile.config + ("nozzle_diameter" to "0.4,0.4,0.4,0.4"),
        )
        val cfg = mergedConfig(
            profile = u1Profile,
            layerHeightInput = "0.20",
            slotColors = listOf("#A", "#B", "#C", "#D"),
            flushFromProject = null,
        )
        val matrix = parseCsv(cfg["flush_volumes_matrix"])
        val multiplier = parseCsv(cfg["flush_multiplier"])
        // 4 filaments × 4 filaments × 4 nozzles = 64 entries.
        assertEquals(64, matrix.size)
        // 4 nozzles → 4 multiplier entries.
        assertEquals(4, multiplier.size)
        assertTrue("multiplier entries should all be 1.0: $multiplier",
                   multiplier.all { it == "1.0" })
    }

    @Test fun projectOverridesAppliedOverProfileButUnderUserExtras() {
        // 3MF authored layer_height=0.22, sparse_infill_density=5%,
        // sparse_infill_pattern=gyroid. UI knob (extraOverrides) only
        // touched layer_height = 0.18 — the user's runtime edit must
        // win over both the bundled profile AND the 3MF authoring.
        // Other 3MF-authored keys flow through unchanged.
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#A", "#B"),
            flushFromProject = null,
            projectOverrides = mapOf(
                "layer_height" to "0.22",
                "sparse_infill_density" to "5%",
                "sparse_infill_pattern" to "gyroid",
                "seam_position" to "back",
            ),
            extraOverrides = mapOf("layer_height" to "0.18"),
        )
        // UI wins for the one knob it touched.
        assertEquals("0.18", cfg["layer_height"])
        // 3MF wins over the bundled profile defaults for the rest.
        assertEquals("5%", cfg["sparse_infill_density"])
        assertEquals("gyroid", cfg["sparse_infill_pattern"])
        assertEquals("back", cfg["seam_position"])
    }

    @Test fun projectOverridesEmptyMapIsNoOp() {
        // STL/OBJ load — no 3MF, no overrides. Profile defaults +
        // layerHeightInput parameter alone control the layer_height.
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = listOf("#A", "#B"),
            flushFromProject = null,
            projectOverrides = emptyMap(),
        )
        assertEquals("0.200", cfg["layer_height"])
        // Nothing extra leaked into the merged config.
        assertEquals(null, cfg["sparse_infill_density"])
    }

    @Test fun projectOverridesAppliedInSingleSlotBranchToo() {
        // Single-color path (no slots) — the early-return branch must
        // also overlay projectOverrides + extraOverrides on top of
        // withLayer. STL prints with no multi-color paint still
        // benefit from 3MF-authored process tuning.
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = emptyList(),
            projectOverrides = mapOf("sparse_infill_density" to "5%"),
            extraOverrides = mapOf("seam_position" to "back"),
        )
        assertEquals("5%", cfg["sparse_infill_density"])
        assertEquals("back", cfg["seam_position"])
    }

    @Test fun singleSlotShortCircuitDoesNotInjectFlushKeys() {
        // Single-color path returns withLayer + extraOverrides without
        // touching flush_*_matrix. Single-extruder prints don't have
        // toolchanges, so the flush settings are inert; we shouldn't
        // pollute that config map with synthetic vectors that would
        // otherwise just shrink the wipe tower for a wipe tower that
        // doesn't get generated.
        val cfg = mergedConfig(
            profile = baseProfile,
            layerHeightInput = "0.20",
            slotColors = emptyList(),
            flushFromProject = SlicerEngine.FlushSettings(
                matrix = "0,30,30,0",
                multiplier = "1.0",
            ),
        )
        // Neither key set when slotColors is empty.
        assertEquals(null, cfg["flush_volumes_matrix"])
        assertEquals(null, cfg["flush_multiplier"])
    }
}
