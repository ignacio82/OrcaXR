package dev.orcaxr.xrexperiment

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.scenecore.SpatialCapability
import androidx.xr.scenecore.scene
import dev.orcaxr.renderer.scenecore.SceneCoreViewport
import java.util.function.Consumer
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest

/** Separate, local development application. Ordinary Android never enters Session.create. */
class SceneCoreExperimentActivity : ComponentActivity() {
    var sessionAttempts = 0; private set
    var status by mutableStateOf("Checking spatial support"); private set
    var observation by mutableStateOf(SceneCoreViewport.Metrics()); private set
    var viewport: SceneCoreViewport? = null; private set
    private var session: Session? = null
    private val spatialAvailable = MutableStateFlow(false)
    private val capabilities = Consumer<Set<SpatialCapability>> {
        spatialAvailable.value = SpatialCapability.SPATIAL_3D_CONTENT in it
    }
    private var cells = 128
    private var instances by mutableStateOf(false)
    private var transparent by mutableStateOf(false)
    private var selected by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cells = savedInstanceState?.getInt("cells", 128)?.takeIf { it in 1..1000 } ?: 128
        setContent {
            MaterialTheme {
                Scaffold { padding ->
                    Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("SceneCore viewport experiment", style = MaterialTheme.typography.titleLarge)
                        Text("Synthetic fixture — editing is not available yet.")
                        Text(status)
                        Text("${observation.state}: ${observation.facets} facets, ${observation.entities} visible mesh entities")
                        Text("Buffer payload ${observation.bufferPayloadBytes} B; largest upload chunk ${observation.largestChunkBytes} B")
                        Text("${observation.uploadCalls} copies, paint replacement ${observation.paintReplacementBytes} B")
                        Text("Longest synchronous submission: ${"%.2f".format(observation.maxSubmissionMs)} ms")
                        Button(onClick = { session?.scene?.requestFullSpace() }, enabled = session != null) { Text("Enter Full Space") }
                        Button(onClick = { session?.scene?.requestHomeSpace() }, enabled = session != null) { Text("Return to Home Space") }
                        Button(onClick = { loadFixture(128) }, enabled = viewport != null) { Text("32,768 facets") }
                        Button(onClick = { loadFixture(1000) }, enabled = viewport != null) { Text("2 million facets") }
                        Button(onClick = { viewport?.paintSample() }, enabled = observation.state == "Ready") { Text("Paint sample range") }
                        Button(onClick = { viewport?.rotate() }, enabled = viewport != null) { Text("Rotate fixture") }
                        Button(onClick = { instances = !instances; viewport?.setInstances(instances) }, enabled = viewport != null) { Text("Toggle second instance") }
                        Button(onClick = { transparent = !transparent; viewport?.setTransparent(transparent) }, enabled = viewport != null) { Text("Toggle transparency") }
                        Button(onClick = { selected = !selected; viewport?.setSelected(selected) }, enabled = viewport != null) { Text("Toggle selection tint") }
                        Text("Picking, clipping, nonuniform/mirrored transforms and toolpaths are not implemented in this candidate.")
                        Text("Payload counters exclude runtime and driver allocations; entity disposal is runtime managed.")
                    }
                }
            }
        }
        if (!packageManager.hasSystemFeature(SPATIAL_FEATURE)) {
            status = NON_XR_STATUS
            return
        }
        lifecycleScope.launch {
            try {
                sessionAttempts++
                status = "Opening XR session"
                // Name the Context overload: the more specific Activity overload
                // remains present but is library-restricted in runtime rc01.
                val result = withContext(Dispatchers.IO) {
                    Session.create(context = this@SceneCoreExperimentActivity)
                }
                if (result !is SessionCreateSuccess) {
                    status = "XR session unavailable (${result.javaClass.simpleName})"
                    return@launch
                }
                val xr = result.session
                session = xr
                xr.scene.addSpatialCapabilitiesChangedListener(capabilities)
                spatialAvailable.value = SpatialCapability.SPATIAL_3D_CONTENT in xr.scene.spatialCapabilities
                repeatOnLifecycle(Lifecycle.State.RESUMED) {
                    spatialAvailable.collectLatest { available ->
                        if (!available) {
                            status = "Home Space — enter Full Space to show the fixture"
                            return@collectLatest
                        }
                        status = "Full Space fixture"
                        val owned = SceneCoreViewport.create(xr) { observation = it }
                        try {
                            viewport = owned
                            owned.setInstances(instances); owned.setTransparent(transparent); owned.setSelected(selected)
                            owned.loadGrid(cells)
                            awaitCancellation()
                        } finally { viewport = null; owned.close() }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { status = "XR experiment unavailable" }
        }
    }
    fun loadFixture(value: Int) {
        require(value in 1..1000); cells = value; viewport?.loadGrid(value)
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("cells", cells); super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        session?.scene?.removeSpatialCapabilitiesChangedListener(capabilities)
        super.onDestroy()
    }
    companion object {
        const val SPATIAL_FEATURE = "android.software.xr.api.spatial"
        const val NON_XR_STATUS = "Spatial XR is unavailable on this device. No XR session was created."
    }
}
