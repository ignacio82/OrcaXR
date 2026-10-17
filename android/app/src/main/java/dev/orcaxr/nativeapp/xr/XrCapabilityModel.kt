package dev.orcaxr.nativeapp.xr

import androidx.compose.runtime.compositionLocalOf

/** The spatial operating mode of the application. */
enum class XrSpaceMode {
    /** Running on a standard phone, tablet, or display without XR spatial runtime. */
    NON_XR,
    /** Running inside the system Home Space as a spatial 2D window panel. */
    HOME_SPACE,
    /** Running in Full Space with full 3D spatial content boundaries granted. */
    FULL_SPACE
}

/** The hardware form factor hosting the application. */
enum class XrDeviceForm {
    /** Standard Android handheld device or desktop (phone, tablet, clamshell). */
    STANDARD_ANDROID,
    /** Standalone spatial XR headset (e.g., Samsung Galaxy XR). */
    SPATIAL_HEADSET,
    /** Tethered glasses connected to an Android host. */
    WIRED_GLASSES
}

/** Perception capabilities that require explicit initialization and optional permissions. */
enum class XrPerceptionFeature {
    SPATIAL_AUDIO,
    HEAD_TRACKING,
    HAND_TRACKING,
    EYE_TRACKING,
    SPATIAL_ANCHORS,
    PASSTHROUGH
}

/** Input modalities supported by the device platform. */
enum class XrInputModality {
    TOUCH_SCREEN,
    HAND_TRACKING,
    SPATIAL_CONTROLLER,
    GAZE_PINCH,
    MOUSE_TRACKPAD,
    HARDWARE_KEYBOARD
}

/**
 * Snapshot of the current XR runtime status and granted spatial capabilities.
 * Maintained immutably for Compose reactivity.
 */
data class XrCapabilities(
    val isSpatialSupported: Boolean = false,
    val deviceForm: XrDeviceForm = XrDeviceForm.STANDARD_ANDROID,
    val spaceMode: XrSpaceMode = XrSpaceMode.NON_XR,
    val canRequestFullSpace: Boolean = false,
    val canRequestHomeSpace: Boolean = false,
    val grantedCapabilities: Set<String> = emptySet(),
    val initializedPerception: Set<XrPerceptionFeature> = emptySet(),
    val supportedInputModalities: Set<XrInputModality> = emptySet(),
    val sessionActive: Boolean = false,
    val statusMessage: String = ""
)

/** CompositionLocal providing the current [XrCapabilities] state to the UI tree. */
val LocalXrCapabilities = compositionLocalOf { XrCapabilities() }

/** CompositionLocal providing the [XrCapabilityAdapter] instance to the UI tree. */
val LocalXrAdapter = compositionLocalOf<XrCapabilityAdapter?> { null }
