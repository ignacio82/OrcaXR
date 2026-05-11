package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 5 contract — 3MF round-trip of FullSpectrum mixed-filament rows.
 *
 * Authoring a virtual mixed-filament row in OrcaXR, saving as 3MF via
 * `nativeSaveAs3mf`, re-reading via `nativeRead3mfMixedFilamentDefinitions`,
 * must round-trip the v0.9.9 wire format byte-identically. Without this,
 * sharing a project across desktop OrcaSlicer / OrcaXR / other FS-aware
 * forks silently drops virtual rows on reopen.
 *
 * Less risky than the engine-emission tests — depends only on patches
 * 0034 (Format/bbs_3mf.cpp +48) round-trip + the Kotlin
 * `parseMixedDefinitionsForKotlin` parser. Run un-`@Ignore`'d once the
 * patch 0034 port lands.
 */
@RunWith(AndroidJUnit4::class)
class FullSpectrumRoundtripTest {

    @Test
    fun mixedFilamentDefinitionsRoundTripThrough3mf() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val stl = File(appCtx.cacheDir, "fs_roundtrip_cube.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }

        val rows = listOf(
            MixedFilamentEntry(
                id = "rt_v1",
                componentA = 1,
                componentB = 2,
                ratioA = 2,
                ratioB = 1,
                mixBPercent = 33,
                biasPercent = 25,
                distributionMode = 1,
                localZMaxSublayers = 3,
                manualPattern = "112",
                gradientComponentIds = "123",
                gradientComponentWeights = "50/30/20",
                enabled = true,
                custom = true,
            ),
        )
        val wireOriginal = MixedFilamentStore(appCtx).toMixedFilamentDefinitions(rows)

        val saved3mf = File(appCtx.cacheDir, "fs_roundtrip.3mf")
        val saveResult = SlicerEngine.saveAs3mf(
            stl,
            saved3mf,
            mapOf(
                "filament_colour" to "#FF0000;#00FF00;#0000FF",
                "mixed_filament_definitions" to wireOriginal,
            ),
        )
        assertTrue("3MF save succeeded: $saveResult", saveResult)

        val wireReadBack = SlicerEngine.read3mfMixedFilamentDefinitions(saved3mf)
        assertNotNull("Read-back returned a definitions string", wireReadBack)
        assertEquals("Wire format round-trips byte-identically", wireOriginal, wireReadBack)

        val parsedRows = parseMixedDefinitionsForKotlin(wireReadBack!!)
        assertEquals("Same number of rows after round-trip", rows.size, parsedRows.size)
        val parsed = parsedRows.first()
        val original = rows.first()
        assertEquals("componentA preserved", original.componentA, parsed.componentA)
        assertEquals("componentB preserved", original.componentB, parsed.componentB)
        assertEquals("distributionMode preserved", original.distributionMode, parsed.distributionMode)
        assertEquals("localZMaxSublayers preserved", original.localZMaxSublayers, parsed.localZMaxSublayers)
        assertEquals("manualPattern preserved", original.manualPattern, parsed.manualPattern)
        assertEquals("gradientComponentIds preserved", original.gradientComponentIds, parsed.gradientComponentIds)
        assertEquals("gradientComponentWeights preserved", original.gradientComponentWeights, parsed.gradientComponentWeights)
    }
}
