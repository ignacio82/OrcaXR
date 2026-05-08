package dev.orcaxr.app.diagnostics

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.app.SlicerEngine
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Differential diagnostics goldens for `SlicerEngine.dumpModelJson`.
 *
 * Catches upstream-pick regressions in libslic3r's parsers
 * (`load_3mf`, `load_bbs_3mf`, `read_from_file`) at parser time —
 * before they amplify into a bad slice. When this test fails, the
 * diff between actual and expected JSON points directly at the
 * shape change (object count, volume bbox, painted-facet record
 * count, custom-gcode tick list, …) without requiring a reader to
 * reverse-engineer it from sliced G-code.
 *
 * Goldens live at `app/src/androidTest/assets/diagnostics_goldens/
 * <case>/expected.json` paired with the input fixture.
 *
 * Regenerating goldens — when the dump format intentionally changes
 * (new schema field, etc.) or a new fixture is added:
 *
 *   adb shell am instrument -w \
 *     -e class dev.orcaxr.app.diagnostics.ModelJsonGoldenTest \
 *     -e orcaxr.regenerateGoldens true \
 *     dev.orcaxr.app.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Then `adb pull /sdcard/Android/data/dev.orcaxr.app/files/
 * diagnostics_goldens_actual/` and copy the regenerated `.json`
 * files into `app/src/androidTest/assets/diagnostics_goldens/<case>/
 * expected.json`. Review the diff before committing — a regenerated
 * golden is only legitimate when the format change was deliberate.
 */
@RunWith(AndroidJUnit4::class)
class ModelJsonGoldenTest {

    @Test
    fun cube20mmStl() = runGolden(
        case = "cube_20mm",
        fixtureAssetPath = "cube_20mm.stl",
        fromAndroidTestAssets = true,
    )

    /**
     * Exercises the 3MF dispatcher (`load_mesh_container` →
     * `load_3mf` / `load_bbs_3mf`) using the OrcaCube v2 fixture
     * already shipped in the production APK assets — no test-APK
     * bloat. This is the case that catches BBS-vs-Prusa regressions.
     */
    @Test
    fun orcaCubeV2_3mf() = runGolden(
        case = "orca_cube_v2",
        fixtureAssetPath = "handy_models/OrcaCube_v2.3mf",
        fromAndroidTestAssets = false,
    )

    private fun runGolden(
        case: String,
        fixtureAssetPath: String,
        fromAndroidTestAssets: Boolean,
    ) = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        // STL fixtures live in the test APK; 3MF fixtures are read
        // from the production app's asset bundle to avoid duplicating
        // multi-hundred-KB blobs across both APKs.
        val sourceAssets = if (fromAndroidTestAssets) testCtx.assets else appCtx.assets
        val fixtureFile = File(appCtx.cacheDir, "diag_${case}_${File(fixtureAssetPath).name}").also { dst ->
            sourceAssets.open(fixtureAssetPath).use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }

        val actual = SlicerEngine.dumpModelJson(fixtureFile)
        assertNotNull("dumpModelJson returned null for $case", actual)
        actual!!

        val args = InstrumentationRegistry.getArguments()
        val regenerate = args.getString("orcaxr.regenerateGoldens")?.toBooleanStrictOrNull() == true
        if (regenerate) {
            // Write the regenerated golden to the app's external files
            // dir so it can be `adb pull`'d out without root. Fall back
            // to filesDir if external storage isn't mounted.
            val outRoot = appCtx.getExternalFilesDir(null) ?: appCtx.filesDir
            val outDir = File(outRoot, "diagnostics_goldens_actual/$case").apply { mkdirs() }
            File(outDir, "expected.json").writeText(prettyPrint(actual))
            android.util.Log.i(
                "OrcaXR",
                "ModelJsonGoldenTest[$case] regenerated golden at ${File(outDir, "expected.json").absolutePath}",
            )
            return@runBlocking
        }

        val expected = runCatching {
            testCtx.assets.open("diagnostics_goldens/$case/expected.json").bufferedReader().use { it.readText() }
        }.getOrElse { e ->
            error(
                "Missing golden for case '$case' (asset diagnostics_goldens/$case/expected.json). " +
                    "Regenerate with `-e orcaxr.regenerateGoldens true`. Underlying: $e",
            )
        }

        // Goldens are stored pretty-printed for human-diff-ability;
        // compare in canonical form so trailing-newline / formatting
        // differences don't break the test.
        assertEquals(
            "diagnostics dump diverged from golden for $case",
            canonicalize(expected),
            canonicalize(actual),
        )
    }

    private fun canonicalize(json: String): String {
        // Round-trip through org.json to normalize whitespace; the JNI
        // already emits sorted config keys and deterministic float
        // formatting, so structural equality is what we want here.
        return org.json.JSONObject(json).toString()
    }

    private fun prettyPrint(json: String): String {
        return org.json.JSONObject(json).toString(2) + "\n"
    }
}
