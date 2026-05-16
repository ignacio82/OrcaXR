package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * "Add Magnets" end-to-end: a magnet placed as a NEGATIVE_VOLUME must
 * actually subtract material at slice time, and the auto-authored
 * PausePrint tick must reach the G-code exactly once. Exercises the
 * single-model `slice()` path (the only one that threads per-model
 * `extraVolumes` in v1) on a generated cube host.
 */
@RunWith(AndroidJUnit4::class)
class MagnetSliceTest {

    private val minValidConfig = mapOf(
        "before_layer_change_gcode" to "G92 E0\n",
    )

    /** Sum of relative-E extrusion increments — a robust proxy for the
     *  volume of filament the slice lays down. minValidConfig forces
     *  use_relative_e_distances, so each `G1 … E<v>` is an increment. */
    private fun extrudedLength(gcode: File): Double {
        var total = 0.0
        gcode.forEachLine { raw ->
            val line = raw.substringBefore(';').trim()
            if (!line.startsWith("G1 ")) return@forEachLine
            val e = Regex("""\bE(-?\d+(?:\.\d+)?)""").find(line)
                ?.groupValues?.get(1)?.toDoubleOrNull() ?: return@forEachLine
            if (e > 0.0) total += e
        }
        return total
    }

    @Test
    fun negativeVolumeSubtractsAndPauseTickReachesGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Host: a solid 40×40×20 cube.
        val host = File(appCtx.cacheDir, "magnet_host_cube.stl")
        assertTrue(
            "host cube build failed",
            SlicerEngine.buildPrimitiveStl(
                PrimitiveKind.CUBE, floatArrayOf(40f, 40f, 20f), host,
            ) != null,
        )

        // One large block magnet so the subtraction is unambiguous
        // (~25×25×10 ≈ 20% of the cube volume).
        val spec = MagnetSpec(
            count = 1,
            shape = MagnetShape.BLOCK,
            blockXmm = 25f, blockYmm = 25f, blockZmm = 10f,
            clearanceMm = 0.2f, roofThicknessMm = 0.8f, edgeMarginMm = 3f,
        )
        val placement = MagnetOp.placeCavities(40f, 40f, 20f, spec, 0.2f)
        assertEquals(1, placement.cavities.size)
        assertTrue("warnings: ${placement.warnings}", placement.warnings.isEmpty())

        val magnet = File(appCtx.cacheDir, "magnet_cavity.stl")
        assertTrue(
            "magnet primitive build failed",
            SlicerEngine.buildPrimitiveStl(
                placement.primitiveKind, placement.primitiveParams, magnet,
            ) != null,
        )

        val c = placement.cavities[0]
        val negVol = PlacedVolume(
            id = "magnet_0",
            source = magnet,
            type = ModelVolumeType.NEGATIVE_VOLUME,
            translateXmm = c.centerXmm,
            translateYmm = c.centerYmm,
            translateZmm = placement.floorZmm,
        )

        // Baseline: solid cube, no volumes, no ticks.
        val baseOut = File(appCtx.cacheDir, "magnet_base.gcode")
        val base = SlicerEngine.slice(host, baseOut, minValidConfig)
        assertTrue("baseline slice failed: $base", base is SliceResult.Success)
        assertTrue("baseline gcode missing PAUSE_PRINT unexpectedly",
            !baseOut.readText().contains("PAUSE_PRINT"))
        val baseLen = extrudedLength(baseOut)

        // With the magnet pocket + the auto pause tick.
        val magOut = File(appCtx.cacheDir, "magnet_with.gcode")
        val ticks = listOf(
            SlicerEngine.CustomGcodeTick(
                printZmm = placement.pauseZmm,
                kind = SlicerEngine.CustomGcodeKind.PausePrint,
                color = "Insert magnets",
            ),
        )
        val mag = SlicerEngine.slice(
            host, magOut, minValidConfig,
            extraVolumes = listOf(negVol),
            customGcodeTicks = ticks,
        )
        assertTrue("magnet slice failed: $mag", mag is SliceResult.Success)
        val magText = magOut.readText()

        // The negative volume actually removed material.
        val magLen = extrudedLength(magOut)
        assertTrue(
            "expected the magnet pocket to cut material: base=$baseLen with=$magLen",
            magLen < baseLen * 0.95,
        )

        // The pause tick reached the G-code exactly once.
        val pauseTags = magText.lineSequence().count { it.contains("PAUSE_PRINT") }
        assertEquals("expected exactly one PAUSE_PRINT tag", 1, pauseTags)
    }
}
