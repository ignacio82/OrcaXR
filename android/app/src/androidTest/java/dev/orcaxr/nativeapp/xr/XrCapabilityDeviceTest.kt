package dev.orcaxr.nativeapp.xr

import androidx.lifecycle.lifecycleScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.nativeapp.MainActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class XrCapabilityDeviceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun detectsSpatialCapabilityAndTransitionsSpaceModeOnGalaxyXr() {
        val hasSpatial = context.packageManager.hasSystemFeature(XrCapabilityAdapter.SPATIAL_FEATURE)
        if (!hasSpatial) {
            // Running on non-XR device or emulator: verify NoOp adapter cleanly
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val adapterRef = AtomicReference<XrCapabilityAdapter>()
                scenario.onActivity { activity ->
                    adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
                }
                val adapter = adapterRef.get()
                assertFalse("Non-XR device must not report spatial support", adapter.capabilities.value.isSpatialSupported)
                assertEquals(XrSpaceMode.NON_XR, adapter.capabilities.value.spaceMode)
            }
            return
        }

        // Running on Galaxy XR hardware
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val adapterRef = AtomicReference<XrCapabilityAdapter>()
            scenario.onActivity { activity ->
                adapterRef.set(XrCapabilityAdapter.create(activity, activity.lifecycleScope))
            }
            val adapter = adapterRef.get()
            assertNotNull("Adapter must be created", adapter)

            // Wait for initial session initialization
            val initial = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.sessionActive }
                }
            }
            assertNotNull("XR Session must become active on Galaxy XR", initial)
            assertTrue("Galaxy XR must report spatial support", initial!!.isSpatialSupported)
            assertEquals("Start mode must be Home Space", XrSpaceMode.HOME_SPACE, initial.spaceMode)
            assertTrue("Home space allows requesting Full Space", initial.canRequestFullSpace)
            assertTrue("No perception features initialized by default", initial.initializedPerception.isEmpty())

            // Request Full Space
            adapter.requestFullSpace()
            val fullSpace = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.spaceMode == XrSpaceMode.FULL_SPACE }
                }
            }
            assertNotNull("Must transition to Full Space on Galaxy XR", fullSpace)
            assertEquals(XrSpaceMode.FULL_SPACE, fullSpace!!.spaceMode)
            assertTrue("Can request return to Home Space", fullSpace.canRequestHomeSpace)

            // Explicitly request a perception feature while in Full Space
            adapter.requestPerceptionFeature(XrPerceptionFeature.PASSTHROUGH)
            val withPerception = adapter.capabilities.value
            assertTrue("Perception feature must be recorded", XrPerceptionFeature.PASSTHROUGH in withPerception.initializedPerception)

            // Return to Home Space
            adapter.requestHomeSpace()
            val homeSpace = runBlocking {
                withTimeoutOrNull(10_000) {
                    adapter.capabilities.first { it.spaceMode == XrSpaceMode.HOME_SPACE }
                }
            }
            assertNotNull("Must transition back to Home Space on Galaxy XR", homeSpace)
            assertEquals(XrSpaceMode.HOME_SPACE, homeSpace!!.spaceMode)

            // Release perception and close
            adapter.releasePerceptionFeature(XrPerceptionFeature.PASSTHROUGH)
            adapter.close()
        }
    }
}
