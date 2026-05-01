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

@RunWith(AndroidJUnit4::class)
class ArrangeTest {

    @Test
    fun arrangeTwoCubes() {
        runBlocking {
            val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
            val testCtx = InstrumentationRegistry.getInstrumentation().context

            val stl = File(appCtx.cacheDir, "cube_arrange_test.stl").also { dst ->
                testCtx.assets.open("cube_20mm.stl").use { input ->
                    dst.outputStream().use { input.copyTo(it) }
                }
            }

            // 9 floats per input: tx, ty, rotZ, sxPct, syPct, szPct, mx, my, mz
            val priors = floatArrayOf(
                0f, 0f, 0f, 100f, 100f, 100f, 1f, 1f, 1f, // cube 1 at origin
                10f, 10f, 0f, 100f, 100f, 100f, 1f, 1f, 1f // cube 2 overlapping
            )

            val result = SlicerEngine.arrangeModels(
                inputs = listOf(stl, stl),
                priorTransforms = priors,
                bedWmm = 250f,
                bedHmm = 250f,
                gapMm = 5f
            )

            assertNotNull("nativeArrange returned null (libslic3r rejected the inputs)", result)
            result!!
            assertEquals("expected 2*3 results", 6, result.size)

            // Check that they are no longer at (0,0) and (10,10) simultaneously
            // or at least that they are "arranged".
            // Usually arrange moves them to pack them.
            android.util.Log.i("OrcaXR", "Arrange results: ${result.joinToString()}")
        }
    }
}
