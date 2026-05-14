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
 * Verifies the mobile preview's new "load 3MF with embedded paint +
 * palette" path: the JNI returns real per-triangle filament tags and
 * the 3MF's authored filament_colour palette. The prior preview
 * pipeline merged everything through convertToStl + StlReader and the
 * paint / palette signals were lost — user-visible as "I don't see
 * any colors when I load a 3mf that has colors in my pixel".
 */
@RunWith(AndroidJUnit4::class)
class Painted3mfPreviewTest {

    @Test
    fun readPainted3mfMeshExposesPaintAndPalette() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val src = File(appCtx.cacheDir, "preview_hexagon.3mf").also { dst ->
            testCtx.assets.open("multicolor_hexagon.3mf").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }

        val mesh = SlicerEngine.readPainted3mfMesh(src)
        assertNotNull("expected non-null Painted3mfMesh for a real 3MF", mesh)
        mesh!!

        assertTrue("triangle count must be > 0", mesh.triCount > 0)
        assertTrue(
            "positions array size must equal triCount * 9, got ${mesh.positions.size} vs ${mesh.triCount * 9}",
            mesh.positions.size == mesh.triCount * 9,
        )
        assertTrue(
            "paintFilament size must equal triCount, got ${mesh.paintFilament.size} vs ${mesh.triCount}",
            mesh.paintFilament.size == mesh.triCount,
        )

        // The hexagon is a known FullSpectrum multi-color asset — at
        // least two distinct filament ids must show up across its
        // painted triangles. If only one id is present, the JNI is
        // either dropping per-face state or every triangle landed in
        // the unpainted bucket — a regression of the bug we're fixing.
        val distinctFilaments = mesh.paintFilament.map { it.toInt() and 0xff }.toSet()
        assertTrue(
            "expected ≥2 distinct filament ids across painted triangles, got $distinctFilaments",
            distinctFilaments.size >= 2,
        )

        // Embedded palette: the asset's project_settings.config carries
        // a 16-entry filament_colour. Any non-empty palette is a pass;
        // we just want to confirm the wire passes it through.
        assertTrue(
            "expected non-empty palette, got ${mesh.palette.size} entries",
            mesh.palette.isNotEmpty(),
        )
        // Each palette entry should at least look like "#RRGGBB..." so
        // the SlicerScreen path can hand it to android.graphics.Color
        // .parseColor without a NumberFormatException.
        mesh.palette.forEach { hex ->
            assertTrue(
                "palette entry '$hex' is not a hex color",
                hex.startsWith("#") && hex.length >= 7,
            )
        }
    }
}
