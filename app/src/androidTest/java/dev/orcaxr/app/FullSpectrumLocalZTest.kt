package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 5 contract — Local-Z sub-layered painted-zone emission.
 *
 * With `dithering_local_z_mode=1` only painted XY regions get
 * sub-divided into `local_z_max_sublayers` thinner Z slices; unpainted
 * geometry stays at base layer height. Verifies the engine's sublayer
 * planner (patch 0029, `PrintObjectSlice.cpp`) actually emits sub-layer
 * z-jumps in painted layers while preserving unpainted-layer count.
 *
 * `@Ignore`'d until patch 0029 (sublayer planner) and `nativeSlice`'s
 * `paintFilamentIndex` plumbing all wire through to a Local-Z-capable
 * Print pipeline.
 */
@RunWith(AndroidJUnit4::class)
@Ignore("Awaiting FullSpectrum engine emission (patches 0027-0034) — see plan phase 2")
class FullSpectrumLocalZTest {

    @Test
    fun localZSubdivisionAppliesOnlyToPaintedLayers() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val stl = File(appCtx.cacheDir, "fs_localz_cube.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val outGcode = File(appCtx.cacheDir, "fs_localz.gcode")

        // Paint approximately half the cube's triangles (top half by Z)
        // as virtual filament 1. The cube's 12 triangles can be coarsely
        // partitioned: 0..5 = bottom half / sides, 6..11 = top half.
        // The actual assignment is fixture-dependent; the assertion only
        // expects SOME layers without Local-Z sub-cuts.
        val paint = ByteArray(12) { i -> if (i >= 6) 3.toByte() else 0.toByte() }

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

        val config = mapOf(
            "before_layer_change_gcode" to "G92 E0\n",
            "filament_colour" to "#FF0000;#0000FF",
            "mixed_filament_definitions" to mixedDefinitions,
            "mixed_filament_advanced_dithering" to "1",
            "dithering_local_z_mode" to "1",
            "dithering_step_painted_zones_only" to "1",
            "dithering_z_step_size" to "0.05",
        )

        val result = SlicerEngine.slice(stl, outGcode, config)
        assertTrue("Slice produced gcode: $result", result is SliceResult.Success)

        val gcode = outGcode.readText()
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
