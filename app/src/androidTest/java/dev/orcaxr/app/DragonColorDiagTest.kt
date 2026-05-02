package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * End-to-end pin for the dragon-3MF "wrong colors" regression — load a
 * 4-color painted 3MF, hand it the same slotRemap a user produces by
 * picking a unique physical extruder for every filament, slice through
 * the JNI, and assert that every one of T0..T3 fires.
 *
 * Why this test and not [SlicerEngineTest.snapmakerU1DragonHonorsPhysicalSlotRemap]:
 * the existing test only checks that the *dominant* extruder matches the
 * remap target for the body filament. It would pass even if libslic3r
 * silently dropped two of the four tools (which is exactly what shipped
 * to the user when the picker let two project filaments share T0). This
 * test fails on that collapse pattern.
 *
 * Pairs with the picker uniqueness fix in
 * [applyMapToPhysical] — once the picker bumps prior occupants on
 * collision, no UI sequence can ever produce the collapsed-map state
 * libslic3r happily honors here.
 */
@RunWith(AndroidJUnit4::class)
class DragonColorDiagTest {

    @Test
    fun dragonAllFourToolsFireWithUniquePhysicalSlots() = runBlocking {
        val tag = "OrcaXR/dragonDiag"
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Stage dragon.3mf into the test process's external-files dir.
        // Same shell-cp dance as the existing dragon test — scoped storage
        // blocks the test process from reading /sdcard/Download directly.
        val dragonDir = appCtx.getExternalFilesDir(null) ?: appCtx.cacheDir
        val dragon = File(dragonDir, "dragon.3mf")
        if (!dragon.exists() || dragon.length() == 0L) {
            fun runShell(cmd: String) {
                val pfd = InstrumentationRegistry.getInstrumentation()
                    .uiAutomation.executeShellCommand(cmd)
                java.io.FileInputStream(pfd.fileDescriptor)
                    .use { it.bufferedReader().readText() }
                pfd.close()
            }
            runShell("mkdir -p ${dragonDir.absolutePath}")
            runShell("cp /sdcard/Download/dragon.3mf ${dragon.absolutePath}")
            runShell("chmod 644 ${dragon.absolutePath}")
        }
        assumeTrue(
            "dragon.3mf not on device at /sdcard/Download/. Push it via " +
                "`adb push <yourdragon>.3mf /sdcard/Download/dragon.3mf` " +
                "to enable this test.",
            dragon.exists() && dragon.canRead() && dragon.length() > 0,
        )

        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val u1Profile = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") &&
                it.id.contains("0.20_standard") &&
                it.id.contains("generic_pla")
        } ?: catalog.firstOrNull { it.id.contains("snapmaker_u1_0.4") }
        assumeTrue("no Snapmaker U1 0.4 profile in catalog", u1Profile != null)
        u1Profile!!

        // Mirror the on-device DataStore state captured during the bug
        // report: 4 project filaments (purple / black / white / yellow)
        // each pointing at a UNIQUE physical extruder. computeFilamentMap
        // turns this into "4,3,1,2" which routes:
        //   filament 0 (purple)  → physical T3
        //   filament 1 (black)   → physical T2
        //   filament 2 (white)   → physical T0
        //   filament 3 (yellow)  → physical T1
        val userSavedSlotRemap = listOf<Int?>(3, 2, 0, 1)
        val filamentMap = computeFilamentMap(4, 4, userSavedSlotRemap)
        assertEquals(
            "computeFilamentMap drift would invalidate the rest of this " +
                "test — fix the helper or update the expectation.",
            "4,3,1,2",
            filamentMap,
        )

        val n = 4
        val perFour: (String) -> String = { v -> List(n) { v }.joinToString(",") }
        val cfg = u1Profile.config + mapOf(
            "filament_diameter" to perFour("1.75"),
            "filament_type" to List(n) { "PLA" }.joinToString(";"),
            "filament_colour" to "#B366FF;#000000;#FFFFFF;#FFFF00",
            "extruder_colour" to "#B366FF;#000000;#FFFFFF;#FFFF00",
            "filament_map" to filamentMap,
            // Manual is mandatory — Auto modes re-run get_recommended_
            // filament_maps in Print::process and trash the explicit
            // remap. See GEMINI.md gotcha #34.
            "filament_map_mode" to "Manual",
            "single_extruder_multi_material" to "0",
        )

        val out = File(appCtx.cacheDir, "dragon_diag.gcode")
        val result = SlicerEngine.slice(dragon, out, cfg)
        assertTrue("Dragon slice failed: $result", result is SliceResult.Success)

        // Best-effort copy to /sdcard/Download for post-mortem inspection.
        runCatching {
            val downloads = File("/storage/emulated/0/Download")
            if (downloads.canWrite()) {
                out.copyTo(File(downloads, "dragon_diag.gcode"), overwrite = true)
            }
        }

        // Histogram of bare `Tn` toolchange lines in the gcode body.
        // The post-processor in slic3r_jni.cpp::postprocess_remap_tool_commands
        // rewrites these from project-filament IDs to physical extruder
        // IDs through filament_map. With unique mapping, all four
        // project filaments must produce at least one toolchange to a
        // distinct physical T.
        val gcodeText = out.readText()
        val tCounts = sortedMapOf<String, Int>()
        for (raw in gcodeText.lineSequence()) {
            val t = raw.trim()
            if (t.length >= 2 && t[0] == 'T' && t[1].isDigit()) {
                val name = t.takeWhile { it.isLetterOrDigit() }
                tCounts[name] = (tCounts[name] ?: 0) + 1
            }
        }

        val mmLine = gcodeText.lineSequence()
            .firstOrNull { it.startsWith("; filament used [mm]") } ?: ""
        val report = "filament_map=$filamentMap, T-counts=$tCounts, $mmLine"
        android.util.Log.i(tag, report)

        val firedTools = tCounts.filterValues { it > 0 }.keys
        val missing = setOf("T0", "T1", "T2", "T3") - firedTools
        assertTrue(
            "Multicolor regression: dragon slice should hit every one of " +
                "T0..T3 with unique physical-slot remap, but missing=$missing. " +
                "If only T0 and T2 fired (the original symptom), the picker " +
                "let two filaments share a physical extruder again — see " +
                "applyMapToPhysical's uniqueness invariant.\n$report",
            missing.isEmpty(),
        )
    }
}
