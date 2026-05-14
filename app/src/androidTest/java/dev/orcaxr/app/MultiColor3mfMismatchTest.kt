package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Regression for the 2026-05-14 Pixel 10 Pro SIGSEGV in
 * Slic3r::calc_filament_change_info_by_toolorder (ToolOrdering.cpp:248)
 * triggered when slicing a multi-color 3MF whose painted faces or
 * per-volume extruder assignments referenced more filaments than the
 * user's profile declared.
 *
 * The undersized cfg.filament_colour propagated into nozzle_flush_mtx as
 * an undersized matrix, and the inner ToolOrdering loop's
 * `flush_matrix[extruder_id][last_filament][item]` indexed past the end
 * — fault at 0x0 because the OOB read landed on an empty inner vector.
 *
 * Fix: slic3r_jni.cpp::clamp_filament_arrays_to_painted now extends every
 * per-filament list option (filament_colour, filament_map,
 * flush_volumes_matrix, …) to cover the highest filament ID the loaded
 * model actually references, before print.apply.
 *
 * This test deliberately mismatches the profile and the 3MF: a multi-
 * color hexagon 3MF (3 painted slots) sliced with a stripped-down
 * single-filament config. Without the fix this SIGSEGVs the test
 * process; with the fix it returns Success.
 */
@RunWith(AndroidJUnit4::class)
class MultiColor3mfMismatchTest {

    @Test
    fun multiColorThreemfWithSingleFilamentProfileDoesNotCrash() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        // Stage the multi-color 3MF asset to the app's cache dir so
        // libslic3r's loader sees a real filesystem path.
        val src = File(appCtx.cacheDir, "multicolor_hexagon.3mf").also { dst ->
            testCtx.assets.open("multicolor_hexagon.3mf").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(appCtx.cacheDir, "multicolor_hexagon.gcode")

        // Deliberately under-sized profile: one filament, no flush matrix.
        // This is the worst-case shape of the Pixel user's "default
        // profile loaded, multi-color 3MF dragged in" path.
        val minCfg = mapOf(
            "before_layer_change_gcode" to "G92 E0\n",
            "filament_colour" to "#FFFFFF",
        )

        val result = SlicerEngine.slice(src, out, minCfg)

        // The exact return value depends on whether libslic3r decides
        // the geometry is sliceable with our stripped config — what we
        // care about is that the call RETURNS rather than dying with a
        // SIGSEGV in the native layer. Both Success and a clean Failed
        // count as "the crash regression is gone"; only an OS-level
        // signal kill would fail this assertion (the test process
        // terminates and JUnit reports "process crashed").
        assertNotEquals(
            "unexpected Cancelled result — the test didn't request cancellation",
            SliceResult.Cancelled,
            result,
        )
        // Belt-and-suspenders: if the slice did succeed, the file must
        // exist and be non-empty so we know the fix isn't merely
        // suppressing a real error.
        if (result is SliceResult.Success) {
            assertTrue("output gcode missing", out.exists())
            assertTrue("output gcode empty", result.sizeBytes > 0)
        }
    }
}
