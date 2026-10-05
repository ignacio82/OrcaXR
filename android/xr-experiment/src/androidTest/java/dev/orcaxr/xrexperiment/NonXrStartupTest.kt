package dev.orcaxr.xrexperiment

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class NonXrStartupTest {
    @Test fun nonXrDeviceNeverOpensAROrSpatialSessionIncludingAfterRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertFalse("This test requires a non-XR device", context.packageManager.hasSystemFeature(SceneCoreExperimentActivity.SPATIAL_FEATURE))
        ActivityScenario.launch(SceneCoreExperimentActivity::class.java).use { scenario ->
            repeat(4) { iteration ->
                if (iteration > 0) scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals(SceneCoreExperimentActivity.NON_XR_STATUS, activity.status)
                    assertEquals(0, activity.sessionAttempts)
                    assertNull(activity.viewport)
                    assertEquals(0, activity.observation.uploadCalls)
                    val maps = File("/proc/self/maps").readText()
                    for (library in listOf("libimpress_api_jni", "libandroidx.xr", "libarcore_sdk", "libopenxr")) {
                        assertFalse("Optional XR native library loaded: $library", maps.contains(library))
                    }
                }
            }
        }
    }
}
