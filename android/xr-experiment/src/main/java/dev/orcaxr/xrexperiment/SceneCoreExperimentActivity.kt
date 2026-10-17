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
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        cells = savedInstanceState?.getInt("cells", 128)?.takeIf { it in 1..1000 } ?: 128
        val autoFullSpace = intent?.getBooleanExtra(EXTRA_AUTO_FULL_SPACE, false) == true
        val autoBenchmark = intent?.getBooleanExtra(EXTRA_AUTO_BENCHMARK, false) == true
        registerCommandReceiver()
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
                        Button(onClick = { runBenchmarkSuite() }, enabled = session != null) { Text("Run Full Benchmark") }
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
                if (autoFullSpace || autoBenchmark) {
                    xr.scene.requestFullSpace()
                }
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
                            if (autoBenchmark) {
                                lifecycleScope.launch { runBenchmarkSuite() }
                            }
                            awaitCancellation()
                        } finally { viewport = null; owned.close() }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { status = "XR experiment unavailable" }
        }
    }
    private var receiverRegistered = false
    private val commandReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context?, intent: android.content.Intent?) {
            when (intent?.action) {
                ACTION_FULL_SPACE -> session?.scene?.requestFullSpace()
                ACTION_HOME_SPACE -> session?.scene?.requestHomeSpace()
                ACTION_LOAD_FIXTURE -> {
                    val count = intent.getIntExtra("cells", 128)
                    if (count in 1..1000) loadFixture(count)
                }
                ACTION_PAINT_SAMPLE -> viewport?.paintSample()
                ACTION_ROTATE -> viewport?.rotate()
                ACTION_INSTANCES -> { instances = !instances; viewport?.setInstances(instances) }
                ACTION_RUN_BENCHMARK -> runBenchmarkSuite()
            }
        }
    }
    private fun registerCommandReceiver() {
        val filter = android.content.IntentFilter().apply {
            addAction(ACTION_FULL_SPACE)
            addAction(ACTION_HOME_SPACE)
            addAction(ACTION_LOAD_FIXTURE)
            addAction(ACTION_PAINT_SAMPLE)
            addAction(ACTION_ROTATE)
            addAction(ACTION_INSTANCES)
            addAction(ACTION_RUN_BENCHMARK)
        }
        androidx.core.content.ContextCompat.registerReceiver(
            this, commandReceiver, filter, androidx.core.content.ContextCompat.RECEIVER_EXPORTED
        )
        receiverRegistered = true
    }
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_AUTO_FULL_SPACE, false)) session?.scene?.requestFullSpace()
        if (intent.getBooleanExtra(EXTRA_AUTO_BENCHMARK, false)) runBenchmarkSuite()
    }
    private suspend fun waitForState(target: String, timeoutMs: Long = 30000): Boolean {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            if (observation.state == target) return true
            delay(50)
        }
        return false
    }
    private var benchmarkRunning = false
    fun runBenchmarkSuite() {
        if (benchmarkRunning) return
        benchmarkRunning = true
        lifecycleScope.launch {
            try {
                android.util.Log.i(TAG_BENCHMARK, "=== STARTING SCENECORE BENCHMARK SUITE ===")
                if (!spatialAvailable.value) {
                    android.util.Log.i(TAG_BENCHMARK, "Requesting Full Space...")
                    session?.scene?.requestFullSpace()
                    var waited = 0
                    while (!spatialAvailable.value && waited < 10000) {
                        delay(100)
                        waited += 100
                    }
                    if (!spatialAvailable.value) {
                        android.util.Log.e(TAG_BENCHMARK, "FAILED: Did not enter Full Space within 10s")
                        return@launch
                    }
                }
                android.util.Log.i(TAG_BENCHMARK, "In Full Space. Waiting for viewport...")
                var waited = 0
                while (viewport == null && waited < 5000) {
                    delay(100)
                    waited += 100
                }
                val vp = viewport
                if (vp == null) {
                    android.util.Log.e(TAG_BENCHMARK, "FAILED: Viewport not available")
                    return@launch
                }

                // 1. 32k facets
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 1: Load 32,768 facets (128 cells) ---")
                val t0 = System.nanoTime()
                loadFixture(128)
                if (!waitForState("Ready", 30000)) {
                    android.util.Log.e(TAG_BENCHMARK, "FAILED: 32k fixture timed out waiting for Ready")
                    return@launch
                }
                val t32kLoadMs = (System.nanoTime() - t0) / 1e6
                android.util.Log.i(TAG_BENCHMARK, "[METRIC 32K_LOAD] facets=${observation.facets}, entities=${observation.entities}, bufferBytes=${observation.bufferPayloadBytes}, largestChunk=${observation.largestChunkBytes}, uploadCalls=${observation.uploadCalls}, maxSubMs=${"%.2f".format(observation.maxSubmissionMs)}, totalLoadMs=${"%.2f".format(t32kLoadMs)}")

                // 2. Rotate
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 2: Rotate fixture ---")
                repeat(4) { vp.rotate(); delay(100) }

                // 3. Instances
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 3: Toggle instances ---")
                instances = true
                vp.setInstances(true)
                delay(200)
                android.util.Log.i(TAG_BENCHMARK, "[METRIC INSTANCES] entities=${observation.entities}")

                // 4. Sample paint on 32k
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 4: Sample paint replacement on 32k ---")
                val p0 = System.nanoTime()
                vp.paintSample()
                if (!waitForState("Ready", 15000)) {
                    android.util.Log.e(TAG_BENCHMARK, "FAILED: 32k paint timed out waiting for Ready")
                    return@launch
                }
                val t32kPaintMs = (System.nanoTime() - p0) / 1e6
                android.util.Log.i(TAG_BENCHMARK, "[METRIC 32K_PAINT] paintReplacementBytes=${observation.paintReplacementBytes}, uploadCalls=${observation.uploadCalls}, maxSubMs=${"%.2f".format(observation.maxSubmissionMs)}, paintDurationMs=${"%.2f".format(t32kPaintMs)}")

                // 5. 2M facets
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 5: Load 2,000,000 facets (1000 cells) ---")
                val t2m0 = System.nanoTime()
                loadFixture(1000)
                if (!waitForState("Ready", 60000)) {
                    android.util.Log.e(TAG_BENCHMARK, "FAILED: 2M fixture timed out waiting for Ready")
                    return@launch
                }
                val t2mLoadMs = (System.nanoTime() - t2m0) / 1e6
                android.util.Log.i(TAG_BENCHMARK, "[METRIC 2M_LOAD] facets=${observation.facets}, entities=${observation.entities}, bufferBytes=${observation.bufferPayloadBytes}, largestChunk=${observation.largestChunkBytes}, uploadCalls=${observation.uploadCalls}, maxSubMs=${"%.2f".format(observation.maxSubmissionMs)}, totalLoadMs=${"%.2f".format(t2mLoadMs)}")

                // 6. Sample paint on 2M
                android.util.Log.i(TAG_BENCHMARK, "--- STEP 6: Sample paint replacement on 2M ---")
                val p2m0 = System.nanoTime()
                vp.paintSample()
                if (!waitForState("Ready", 20000)) {
                    android.util.Log.e(TAG_BENCHMARK, "FAILED: 2M paint timed out waiting for Ready")
                    return@launch
                }
                val t2mPaintMs = (System.nanoTime() - p2m0) / 1e6
                android.util.Log.i(TAG_BENCHMARK, "[METRIC 2M_PAINT] paintReplacementBytes=${observation.paintReplacementBytes}, uploadCalls=${observation.uploadCalls}, maxSubMs=${"%.2f".format(observation.maxSubmissionMs)}, paintDurationMs=${"%.2f".format(t2mPaintMs)}")

                android.util.Log.i(TAG_BENCHMARK, "=== SCENECORE BENCHMARK SUITE COMPLETE ===")
            } finally {
                benchmarkRunning = false
            }
        }
    }
    fun loadFixture(value: Int) {
        require(value in 1..1000); cells = value; viewport?.loadGrid(value)
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("cells", cells); super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        if (receiverRegistered) {
            try { unregisterReceiver(commandReceiver) } catch (_: Exception) {}
            receiverRegistered = false
        }
        session?.scene?.removeSpatialCapabilitiesChangedListener(capabilities)
        super.onDestroy()
    }
    companion object {
        const val SPATIAL_FEATURE = "android.software.xr.api.spatial"
        const val NON_XR_STATUS = "Spatial XR is unavailable on this device. No XR session was created."
        const val TAG_BENCHMARK = "SceneCoreBenchmark"
        const val EXTRA_AUTO_FULL_SPACE = "auto_full_space"
        const val EXTRA_AUTO_BENCHMARK = "auto_benchmark"
        const val ACTION_FULL_SPACE = "dev.orcaxr.xrexperiment.ACTION_FULL_SPACE"
        const val ACTION_HOME_SPACE = "dev.orcaxr.xrexperiment.ACTION_HOME_SPACE"
        const val ACTION_LOAD_FIXTURE = "dev.orcaxr.xrexperiment.ACTION_LOAD_FIXTURE"
        const val ACTION_PAINT_SAMPLE = "dev.orcaxr.xrexperiment.ACTION_PAINT_SAMPLE"
        const val ACTION_ROTATE = "dev.orcaxr.xrexperiment.ACTION_ROTATE"
        const val ACTION_INSTANCES = "dev.orcaxr.xrexperiment.ACTION_INSTANCES"
        const val ACTION_RUN_BENCHMARK = "dev.orcaxr.xrexperiment.ACTION_RUN_BENCHMARK"
    }
}
