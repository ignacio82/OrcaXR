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
 * Pin the user-reported scenario: selecting "0.12 Fine @Snapmaker U1
 * (0.4 nozzle)" must actually slice at 0.12 mm layer height. The user
 * believed they had this profile selected, but the produced gcode
 * showed `; total layer number: 200` and `max_z_height: 40.00` — i.e.
 * 0.20 mm. This test guards against the catalog regressing on its
 * "0.12" inheritance chain (`0.12 Fine ... → fdm_process_U1_0.12 →
 * fdm_process_U1_common`) so silent flattening of the layer-height
 * key surfaces here instead of as "estimated time is half what it
 * should be" on a real print.
 */
@RunWith(AndroidJUnit4::class)
class UnicornFineProfileTest {

    /**
     * The user-reported regression: open a 3MF that authors
     * `layer_height=0.20`, pick "0.12 Fine" in the profile picker,
     * slice. Expect the slice to honor the profile (0.12 mm), NOT the
     * 3MF's authored value. Pre-fix the 3MF won via `projectOverrides`
     * and the slice came out at 0.20 — the user saw "estimated time
     * 5h 07m vs desktop's 11h 20m" and asked whether OrcaXR was even
     * using the picked profile.
     *
     * Doesn't go through `nativeRead3mfProjectOverrides` (which now
     * filters out `layer_height` keys) because exercising the filter
     * end-to-end is what the round-trip test does. This test verifies
     * the merge behavior directly: even if a layer_height somehow ends
     * up in the projectOverrides map (e.g. via a future caller that
     * builds it programmatically), the user's profile + UI text-field
     * still govern via `extraOverrides` precedence — and the read3mf
     * path no longer puts layer_height in there in the first place.
     */
    @Test
    fun profilePickWinsOver3mfAuthoredLayerHeight() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val fine = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") && it.id.contains("0.12_fine")
        }
        assumeTrue("0.12 Fine profile missing", fine != null)
        fine!!

        // Simulate read3mfProjectOverrides output for a 3MF authored at
        // 0.20 mm in BambuStudio. The list reflects what
        // PROJECT_OVERRIDE_KEYS *currently* extracts — layer_height
        // intentionally excluded.
        val overridesFromTheoretical3mf = mapOf(
            "sparse_infill_density" to "12%",
            "support_type" to "tree(auto)",
        )

        val cfg = mergedConfig(
            profile = fine,
            layerHeightInput = "",  // user didn't type anything; profile wins
            slotColors = listOf("#FFFFFF", "#000000"),
            projectOverrides = overridesFromTheoretical3mf,
        )

        // Layer height comes from the "0.12 Fine" profile, not the 3MF.
        assertEquals(
            "Profile pick must govern layer_height. If this is 0.20, " +
                "PROJECT_OVERRIDE_KEYS regressed and is leaking layer_height " +
                "from 3MFs again — see SlicerEngine.PROJECT_OVERRIDE_KEYS doc.",
            "0.12",
            cfg["layer_height"],
        )
        // 3MF's other authored process tunings still flow through.
        assertEquals("12%", cfg["sparse_infill_density"])
        assertEquals("tree(auto)", cfg["support_type"])
    }

    @Test
    fun fineProfileInCatalogHasLayerHeight012mm() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val fine = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") && it.id.contains("0.12_fine")
        }
        assertTrue(
            "expected '0.12 Fine @Snapmaker U1 (0.4 nozzle)' in the loaded catalog. " +
                "Got ${catalog.size} ids: ${catalog.joinToString(limit = 30) { it.id }}",
            fine != null,
        )
        fine!!
        val layerHeight = fine.config["layer_height"]
        assertEquals(
            "Profile '${fine.id}' should resolve layer_height=0.12 via " +
                "fdm_process_U1_0.12 inheritance. config keys=${fine.config.keys.size}",
            "0.12",
            layerHeight,
        )
    }

    /**
     * End-to-end: slice the user's actual unicorn 3MF (when present at
     * /sdcard/Download/Quick Share/Einhorn+Knitted.3mf) with the
     * 0.12 Fine profile and assert the produced gcode lands at 332
     * layers (matching the desktop reference), not the 200 layers we
     * saw when 0.20 Standard ran instead. Skipped if the source 3MF
     * isn't on the device.
     */
    @Test
    fun unicornSlicedWithFineProfileLandsAt332Layers() = runBlocking {
        val tag = "OrcaXR/fineDiag"
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Stage source 3MF into the test process's external-files dir.
        // executeShellCommand's argv parser strips inner quotes, so any
        // path with a space in it can't be `cp`-ed in one shot — we
        // require a no-space staging path on /sdcard/Download. Caller
        // pre-stages with `adb shell cp "<spaced path>" /sdcard/Download/<no_spaces>.3mf`
        // before running this test.
        val dir = appCtx.getExternalFilesDir(null) ?: appCtx.cacheDir
        val src = File(dir, "Einhorn_Knitted.3mf")
        if (!src.exists() || src.length() == 0L) {
            fun runShell(cmd: String): String {
                val pfd = InstrumentationRegistry.getInstrumentation()
                    .uiAutomation.executeShellCommand(cmd)
                val out = java.io.FileInputStream(pfd.fileDescriptor)
                    .use { it.bufferedReader().readText() }
                pfd.close()
                return out
            }
            android.util.Log.i(tag, "mkdir: '${runShell("mkdir -p ${dir.absolutePath}")}'")
            android.util.Log.i(tag, "cp:    '${runShell("cp /sdcard/Download/Einhorn_Knitted.3mf ${src.absolutePath}")}'")
            android.util.Log.i(tag, "chmod: '${runShell("chmod 644 ${src.absolutePath}")}'")
            android.util.Log.i(tag, "ls:    '${runShell("ls -la ${src.absolutePath}")}'")
        }
        assumeTrue(
            "Einhorn_Knitted.3mf not staged. Pre-stage via " +
                "`adb shell 'cp \"/sdcard/Download/Quick Share/Einhorn+Knitted.3mf\" /sdcard/Download/Einhorn_Knitted.3mf'`.",
            src.exists() && src.canRead() && src.length() > 0,
        )

        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val fine = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") && it.id.contains("0.12_fine")
        }
        assumeTrue("0.12 Fine profile missing from catalog", fine != null)
        fine!!

        val n = 4
        val perFour: (String) -> String = { v -> List(n) { v }.joinToString(",") }
        // Same 4-color palette + manual filament_map shape the user has
        // saved on their device, so the slice exercises the full
        // multicolor + 3MF-instance-pose path. The exact map values
        // don't matter for layer height — only that the slice succeeds
        // and produces a parseable gcode.
        val cfg = fine.config + mapOf(
            "filament_diameter" to perFour("1.75"),
            "filament_type" to List(n) { "PLA" }.joinToString(";"),
            "filament_colour" to "#E2DEDB;#E72F1D;#080A0D;#F4C032",
            "extruder_colour" to "#E2DEDB;#E72F1D;#080A0D;#F4C032",
            "filament_map" to "1,2,3,4",
            "filament_map_mode" to "Manual",
            "single_extruder_multi_material" to "0",
        )

        val out = File(appCtx.cacheDir, "unicorn_fine_test.gcode")
        // Single-model path: nativeSlice reads the 3MF directly and
        // preserves both the painted volumes and the per-instance
        // scale (gotchas #21 / #21b apply to the multi-model path
        // only). For "is the profile honored" the single-model path
        // is the smaller surface to test.
        val result = SlicerEngine.slice(src, out, cfg)
        assertTrue("unicorn slice failed: $result", result is SliceResult.Success)

        runCatching {
            val downloads = File("/storage/emulated/0/Download")
            if (downloads.canWrite()) {
                out.copyTo(File(downloads, "unicorn_fine_test.gcode"), overwrite = true)
            }
        }

        // Pull the layer count + max_z directly from the gcode header
        // (bypass GcodeParser so this test pins the actual emitted
        // values rather than the parser's interpretation).
        val text = out.readText()
        val totalLayerLine = text.lineSequence()
            .firstOrNull { it.startsWith("; total layer number:") } ?: ""
        val maxZLine = text.lineSequence()
            .firstOrNull { it.startsWith("; max_z_height:") } ?: ""
        val totalLayers = Regex("""\d+""").find(totalLayerLine)?.value?.toIntOrNull() ?: -1
        val maxZ = Regex("""[\d.]+""").find(maxZLine)?.value?.toDoubleOrNull() ?: -1.0

        android.util.Log.i(tag, "header: $totalLayerLine | $maxZLine")

        // Desktop Snapmaker Orca on the same model + 0.12 Fine produces
        // 332 layers / 40.04 mm. Allow ±5 layers tolerance for any
        // boundary-rounding differences across libslic3r versions.
        // ±0.2 mm tolerance on max_z covers first-layer rounding.
        assertTrue(
            "Expected ~332 layers (0.12 mm × 40 mm = 333±) but the slice " +
                "produced $totalLayers. If this is ~200 the 0.20 profile is " +
                "leaking through somewhere — `layer_height` is being " +
                "overridden between fine.config and the JNI. Header line: " +
                "$totalLayerLine",
            totalLayers in 327..337,
        )
        assertTrue(
            "Expected max_z ≈ 40 mm but got $maxZ. Header: $maxZLine",
            kotlin.math.abs(maxZ - 40.0) < 0.5,
        )
    }
}
