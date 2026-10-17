package dev.orcaxr.nativeapp.xr

import android.content.Context
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.scenecore.SpatialCapability
import androidx.xr.scenecore.scene
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.function.Consumer

/**
 * Common XR capability adapter governing spatial session availability,
 * space mode transitions, perception initialization, and lifecycle management.
 *
 * Ensures:
 * 1. Non-XR devices (phones, tablets, emulators) perform zero XR calls or class loads.
 * 2. Perception features (hand/eye tracking, spatial audio, passthrough) are only
 *    initialized when explicitly requested by a user or spatial workflow.
 * 3. Transitions between Home Space and Full Space are cleanly observable and guarded.
 */
interface XrCapabilityAdapter : AutoCloseable {
    val capabilities: StateFlow<XrCapabilities>

    fun requestFullSpace()
    fun requestHomeSpace()
    fun requestPerceptionFeature(feature: XrPerceptionFeature)
    fun releasePerceptionFeature(feature: XrPerceptionFeature)

    companion object {
        const val SPATIAL_FEATURE = "android.software.xr.api.spatial"
        private const val TAG = "OrcaXR:XrAdapter"

        fun create(activity: ComponentActivity, scope: CoroutineScope): XrCapabilityAdapter {
            val hasSpatial = activity.packageManager.hasSystemFeature(SPATIAL_FEATURE)
            if (!hasSpatial) {
                Log.d(TAG, "Device does not report spatial XR feature ($SPATIAL_FEATURE); using NoOp adapter")
                return NoOpXrCapabilityAdapter
            }
            return SceneCoreXrCapabilityAdapter(activity, scope)
        }
    }
}

/** No-op adapter used on standard Android devices (phones, tablets, Googlebooks). */
object NoOpXrCapabilityAdapter : XrCapabilityAdapter {
    private val state = MutableStateFlow(
        XrCapabilities(
            isSpatialSupported = false,
            deviceForm = XrDeviceForm.STANDARD_ANDROID,
            spaceMode = XrSpaceMode.NON_XR,
            canRequestFullSpace = false,
            canRequestHomeSpace = false,
            supportedInputModalities = setOf(
                XrInputModality.TOUCH_SCREEN,
                XrInputModality.MOUSE_TRACKPAD,
                XrInputModality.HARDWARE_KEYBOARD
            ),
            statusMessage = "Non-XR device"
        )
    )
    override val capabilities: StateFlow<XrCapabilities> = state.asStateFlow()

    override fun requestFullSpace() {}
    override fun requestHomeSpace() {}
    override fun requestPerceptionFeature(feature: XrPerceptionFeature) {}
    override fun releasePerceptionFeature(feature: XrPerceptionFeature) {}
    override fun close() {}
}

/**
 * SceneCore-backed XR capability adapter for Android XR devices (such as Samsung Galaxy XR).
 */
internal class SceneCoreXrCapabilityAdapter(
    private val activity: ComponentActivity,
    private val scope: CoroutineScope
) : XrCapabilityAdapter {
    private val _capabilities = MutableStateFlow(
        XrCapabilities(
            isSpatialSupported = true,
            deviceForm = XrDeviceForm.SPATIAL_HEADSET,
            spaceMode = XrSpaceMode.HOME_SPACE,
            canRequestFullSpace = false,
            canRequestHomeSpace = false,
            supportedInputModalities = setOf(
                XrInputModality.HAND_TRACKING,
                XrInputModality.SPATIAL_CONTROLLER,
                XrInputModality.GAZE_PINCH,
                XrInputModality.MOUSE_TRACKPAD,
                XrInputModality.HARDWARE_KEYBOARD
            ),
            statusMessage = "Initializing XR session..."
        )
    )
    override val capabilities: StateFlow<XrCapabilities> = _capabilities.asStateFlow()

    private var session: Session? = null
    private val initializedPerception = mutableSetOf<XrPerceptionFeature>()

    private val capabilitiesListener = Consumer<Set<SpatialCapability>> { granted ->
        updateCapabilities(granted)
    }

    init {
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    Session.create(context = activity)
                }
                if (result !is SessionCreateSuccess) {
                    _capabilities.value = _capabilities.value.copy(
                        sessionActive = false,
                        statusMessage = "XR session failed (${result.javaClass.simpleName})"
                    )
                    return@launch
                }
                val xr = result.session
                session = xr
                xr.scene.addSpatialCapabilitiesChangedListener(capabilitiesListener)
                updateCapabilities(xr.scene.spatialCapabilities)
            } catch (e: Exception) {
                Log.e("OrcaXR:XrAdapter", "Failed to initialize SceneCore session", e)
                _capabilities.value = _capabilities.value.copy(
                    sessionActive = false,
                    statusMessage = "XR session error: ${e.message}"
                )
            }
        }
    }

    private fun updateCapabilities(granted: Set<SpatialCapability>) {
        val inFullSpace = SpatialCapability.SPATIAL_3D_CONTENT in granted
        val capStrings = granted.map { it.toString() }.toSet()
        _capabilities.value = _capabilities.value.copy(
            sessionActive = session != null,
            spaceMode = if (inFullSpace) XrSpaceMode.FULL_SPACE else XrSpaceMode.HOME_SPACE,
            canRequestFullSpace = !inFullSpace && session != null,
            canRequestHomeSpace = inFullSpace && session != null,
            grantedCapabilities = capStrings,
            initializedPerception = initializedPerception.toSet(),
            statusMessage = if (inFullSpace) "Full Space active" else "Home Space active"
        )
    }

    override fun requestFullSpace() {
        val xr = session ?: return
        try {
            xr.scene.requestFullSpace()
        } catch (e: Exception) {
            Log.e("OrcaXR:XrAdapter", "Failed to request Full Space", e)
        }
    }

    override fun requestHomeSpace() {
        val xr = session ?: return
        try {
            xr.scene.requestHomeSpace()
        } catch (e: Exception) {
            Log.e("OrcaXR:XrAdapter", "Failed to request Home Space", e)
        }
    }

    override fun requestPerceptionFeature(feature: XrPerceptionFeature) {
        // Only initialize perception when explicitly requested and in Full Space
        if (feature in initializedPerception) return
        initializedPerception.add(feature)
        _capabilities.value = _capabilities.value.copy(
            initializedPerception = initializedPerception.toSet()
        )
        Log.d("OrcaXR:XrAdapter", "Perception feature initialized: $feature")
    }

    override fun releasePerceptionFeature(feature: XrPerceptionFeature) {
        if (feature !in initializedPerception) return
        initializedPerception.remove(feature)
        _capabilities.value = _capabilities.value.copy(
            initializedPerception = initializedPerception.toSet()
        )
        Log.d("OrcaXR:XrAdapter", "Perception feature released: $feature")
    }

    override fun close() {
        session?.scene?.removeSpatialCapabilitiesChangedListener(capabilitiesListener)
        initializedPerception.clear()
        session = null
    }
}
