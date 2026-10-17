package dev.orcaxr.nativeapp.xr

import org.junit.Assert.*
import org.junit.Test

class XrCapabilityAdapterTest {
    @Test
    fun noOpAdapterReportsNonXrDefaults() {
        val adapter = NoOpXrCapabilityAdapter
        val caps = adapter.capabilities.value

        assertFalse("Spatial must not be supported on NoOp adapter", caps.isSpatialSupported)
        assertEquals(XrDeviceForm.STANDARD_ANDROID, caps.deviceForm)
        assertEquals(XrSpaceMode.NON_XR, caps.spaceMode)
        assertFalse("Cannot request full space", caps.canRequestFullSpace)
        assertFalse("Cannot request home space", caps.canRequestHomeSpace)
        assertFalse("Session not active", caps.sessionActive)
        assertTrue("No granted capabilities", caps.grantedCapabilities.isEmpty())
        assertTrue("No perception features initialized", caps.initializedPerception.isEmpty())

        // Ensure methods are safe no-ops
        adapter.requestFullSpace()
        adapter.requestHomeSpace()
        adapter.requestPerceptionFeature(XrPerceptionFeature.HAND_TRACKING)
        adapter.releasePerceptionFeature(XrPerceptionFeature.HAND_TRACKING)
        adapter.close()

        val after = adapter.capabilities.value
        assertEquals(caps, after)
    }

    @Test
    fun xrCapabilitiesDataClassCopiesCorrectly() {
        val initial = XrCapabilities(
            isSpatialSupported = true,
            deviceForm = XrDeviceForm.SPATIAL_HEADSET,
            spaceMode = XrSpaceMode.HOME_SPACE,
            canRequestFullSpace = true,
            canRequestHomeSpace = false
        )

        val transitioned = initial.copy(
            spaceMode = XrSpaceMode.FULL_SPACE,
            canRequestFullSpace = false,
            canRequestHomeSpace = true,
            grantedCapabilities = setOf("SPATIAL_3D_CONTENT")
        )

        assertEquals(XrSpaceMode.FULL_SPACE, transitioned.spaceMode)
        assertFalse(transitioned.canRequestFullSpace)
        assertTrue(transitioned.canRequestHomeSpace)
        assertTrue("SPATIAL_3D_CONTENT" in transitioned.grantedCapabilities)
    }
}
