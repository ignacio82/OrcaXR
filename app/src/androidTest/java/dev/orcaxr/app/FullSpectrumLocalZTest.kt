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
 * Phase 5 contract — Local-Z sub-layered painted-zone emission.
 *
 * With `dithering_local_z_mode=1` only painted XY regions get
 * sub-divided into `local_z_max_sublayers` thinner Z slices; unpainted
 * geometry stays at base layer height. Verifies the engine's sublayer
 * planner (patch 0052 build_local_z_plan) actually emits sub-layer
 * z-jumps in painted layers via the LZ5g phase-b emit path (patches
 * 0065+0066+0067).
 *
 * Un-`@Ignore`'d 2026-05-11 — engine port complete via patches
 * 0044-0067. The original assertion only checked that the gcode
 * file was non-empty; that's too weak post-port. The strengthened
 * assertion looks for the LZ5g phase-b marker comment
 * `; local-z phase-b perimeter passes begin` which is only emitted
 * when build_local_z_plan produced non-empty SubLayerPlan records
 * AND the per-region clipping branch (patch 0065) populated
 * LocalZPassBucket::by_extruder AND the emit branch (patch 0066)
 * fired. If any link in that chain breaks, the marker is absent.
 */
@RunWith(AndroidJUnit4::class)
class FullSpectrumLocalZTest {

    @Test
    fun localZSubdivisionAppliesOnlyToPaintedLayers() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        // Start from a real Snapmaker U1 PLA profile so all the
        // extrusion widths / nozzle / temperature / etc. are populated.
        // Without that the bare config map below produces
        // "Flow::spacing() produced negative spacing" at slice time.
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        // Match the SPECIFIC 0.4-nozzle / 0.20-standard / PLA profile so
        // the merge produces a coherent layer_height vs nozzle_diameter
        // pair. A looser "any u1 + 0.4" pick once merged a 0.8-nozzle
        // process onto a 0.2-nozzle machine and tripped
        // "Layer height cannot exceed nozzle diameter".
        // Profile IDs use underscores (e.g.
        // "bundled_snapmaker_u1_0.4_nozzle.0.20_standard.snapmaker_pla_u1").
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

        val stl = File(appCtx.cacheDir, "fs_localz_cube.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val outGcode = File(appCtx.cacheDir, "fs_localz.gcode")

        // Paint approximately half the cube's triangles (top half by Z)
        // as virtual filament 1. The cube's 12 triangles can be coarsely
        // partitioned: 0..5 = bottom half / sides, 6..11 = top half.
        // Snapmaker U1 = 4 physical extruders; the virtual row below
        // gets filament ID 5 (4 + 1). For Local-Z to fire the painted
        // slot MUST be the virtual ID (mixed_mgr.is_mixed checks
        // filament_id > num_physical).
        val virtualSlot = 5.toByte()
        val paint = ByteArray(12) { i -> if (i >= 6) virtualSlot else 0.toByte() }

        val mixedDefinitions = MixedFilamentStore(appCtx).toMixedFilamentDefinitions(
            listOf(
                MixedFilamentEntry(
                    id = "v_localz",
                    componentA = 1,
                    componentB = 2,
                    ratioA = 1,
                    ratioB = 1,
                    distributionMode = 0,
                    localZMaxSublayers = 4,
                    enabled = true,
                    custom = true,
                ),
            ),
        )

        // The U1 PLA filament profile only declares 1 filament_diameter
        // entry, but the U1 machine has 4 nozzles. apply_mm_segmentation's
        // gate requires filament_diameter.size() > 1, so expand to match
        // the 4-nozzle layout (Snapmaker U1 standard PLA at 1.75 mm).
        val config = target!!.config + mapOf(
            "before_layer_change_gcode" to "G92 E0\n",
            "filament_diameter" to "1.75,1.75,1.75,1.75",
            "mixed_filament_definitions" to mixedDefinitions,
            "dithering_local_z_mode" to "1",
        )

        // patch 0068: pass paint through so apply_mm_segmentation
        // populates the painted segmentation that build_local_z_plan
        // consumes. Without this the LZ planner sees zero painted
        // intervals and skips emit.
        val result = SlicerEngine.slice(stl, outGcode, config, paintFilamentIndex = paint)
        assertTrue("Slice produced gcode: $result", result is SliceResult.Success)

        val gcode = outGcode.readText()

        // Strong signal: the LZ5g emit branch (patch 0066) emits a
        // comment marker every time it fires. Its presence proves the
        // full chain ran end-to-end: build_local_z_plan → SubLayerPlan
        // records → mixed_masks_union populated → per-region clipping
        // populated pass_buckets → local_z_pass_refs non-empty → emit.
        assertTrue(
            "Expected '; local-z phase-b perimeter passes begin' marker in gcode " +
                "(LZ5g emit didn't fire — check logcat for 'Local-Z context rejected' or " +
                "'phase-b enabled but produced no perimeter passes')",
            gcode.contains("; local-z phase-b perimeter passes begin"),
        )

        // Local-Z Z-jumps appear as G0/G1 Z<x> with smaller step than base layer.
        // Heuristic: at least one Z move with a sub-base step.
        val zMoves = Regex("""G[01].*Z([0-9.]+)""").findAll(gcode)
            .mapNotNull { it.groupValues[1].toFloatOrNull() }
            .toList()
        val deltas = zMoves.zipWithNext { a, b -> kotlin.math.abs(b - a) }.filter { it > 0.001f }
        assertTrue(
            "Expected sub-base Z-step from Local-Z (deltas: ${deltas.take(20)})",
            deltas.any { it < 0.15f },
        )
    }
}
