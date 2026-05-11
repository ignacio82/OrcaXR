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
 * Phase 5 contract — SameLayerPointillisme XY-stripe emission.
 *
 * With `distribution_mode=1` (Pointillisme) the cadence happens inside
 * each layer rather than between layers — the painted region splits
 * into XY stripes of `mixed_filament_pointillism_pixel_size` width,
 * separated by `_line_gap`, with each stripe assigned to component A
 * or B in turn. So we expect MORE toolchanges per layer (≥ stripe
 * count) than the layer-count baseline.
 *
 * `@Ignore`'d until patches 0029 (PrintObjectSlice sublayer planner)
 * and 0032 (GCode emission) land.
 */
@RunWith(AndroidJUnit4::class)
@Ignore("Awaiting FullSpectrum engine emission (patches 0027-0034) — see plan phase 2")
class FullSpectrumPointillismeTest {

    @Test
    fun pointillismeExceedsLayerToolchangeCount() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val stl = File(appCtx.cacheDir, "fs_pointillisme_cube.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val outGcode = File(appCtx.cacheDir, "fs_pointillisme.gcode")

        val mixedDefinitions = MixedFilamentStore(appCtx).toMixedFilamentDefinitions(
            listOf(
                MixedFilamentEntry(
                    id = "v_point",
                    componentA = 1,
                    componentB = 2,
                    ratioA = 1,
                    ratioB = 1,
                    distributionMode = 1,  // SameLayerPointillisme
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
            "mixed_filament_pointillism_pixel_size" to "0.4",
            "mixed_filament_pointillism_line_gap" to "0.4",
        )

        val result = SlicerEngine.slice(stl, outGcode, config)
        assertTrue("Slice produced gcode: $result", result is SliceResult.Success)

        val gcode = outGcode.readText()
        // Count layers + total toolchanges.
        val layerCount = Regex(""";LAYER_COUNT:(\d+)""").find(gcode)?.groupValues?.get(1)?.toIntOrNull()
            ?: Regex(""";LAYER_CHANGE""").findAll(gcode).count()
        val toolchanges = Regex("""^T[01]\s*$""", RegexOption.MULTILINE).findAll(gcode).count()
        assertTrue("Pointillisme should produce > layerCount toolchanges, got $toolchanges vs $layerCount layers",
            toolchanges > layerCount * 2)
    }
}
