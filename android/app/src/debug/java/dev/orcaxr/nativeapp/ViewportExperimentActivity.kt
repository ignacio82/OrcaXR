package dev.orcaxr.nativeapp

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.SurfaceView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.orcaxr.core.GcodeSession
import dev.orcaxr.renderer.*
import dev.orcaxr.renderer.filament.FilamentViewport
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs

/** Fixture workbench only. No project import/edit/save or printer actions. */
class ViewportExperimentActivity : ComponentActivity() {
    var viewport: FilamentViewport? = null
        private set
    lateinit var surface: SurfaceView
        private set
    private val handler = Handler(Looper.getMainLooper())
    private val session = AtomicReference<GcodeSession?>()
    private var task: ExecutorService? = null
    private var resumed = false
    private var cells = 128
    private var status by mutableStateOf("Preparing viewport")
    private var ready by mutableStateOf(false)
    private var selected by mutableStateOf<FilamentViewport.Hit?>(null)
    private var clipped by mutableStateOf(false)
    private var transparent by mutableStateOf(false)
    private var instanced by mutableStateOf(false)
    private var toolpathRequested = false
    private var toolpathPending: ToolpathGeometry? = null
    private var toolpathError: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cells = savedInstanceState?.getInt("cells", 128) ?: 128
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Scaffold { padding ->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        Text("Viewport experiment", Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.titleLarge)
                        Text("Generated fixtures · display overlays only", Modifier.padding(horizontal = 12.dp))
                        Row(Modifier.horizontalScroll(rememberScrollState())) {
                            TextButton(onClick = { loadFixture(128) }) { Text("32K facets") }
                            TextButton(onClick = { loadFixture(1000) }) { Text("2M facets") }
                            TextButton(enabled = ready, onClick = {
                                instanced = !instanced; viewport?.showSecondInstance(instanced)
                            }) { Text(if (instanced) "One instance" else "Mirror instance") }
                            TextButton(enabled = ready, onClick = {
                                clipped = !clipped; viewport?.clipAboveMm(if (clipped) 30f else null)
                            }) { Text(if (clipped) "Unclip" else "Clip at 30 mm") }
                            TextButton(enabled = ready, onClick = {
                                transparent = !transparent; viewport?.setTransparent(transparent)
                            }) { Text(if (transparent) "Opaque" else "Transparent") }
                            TextButton(enabled = ready && selected != null, onClick = {
                                selected?.let { viewport?.paint(it.facet, 1, 0xffff3366.toInt()) }
                            }) { Text("Paint picked facet") }
                        }
                        Text(status, Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall)
                        Text(selected?.let { "Instance ${it.instance + 1} · original facet ${it.facet}" }
                            ?: "Drag to orbit; tap a facet to select", Modifier.padding(horizontal = 12.dp))
                        AndroidView(factory = { context -> FixtureSurface(context).also {
                            surface = it; installTouch(it); startViewport()
                        } }, modifier = Modifier.fillMaxWidth().weight(1f))
                    }
                }
            }
        }
    }

    override fun onResume() { super.onResume(); resumed = true; startViewport() }
    override fun onPause() {
        resumed = false
        handler.removeCallbacks(update)
        // Closing independently cancels JNI even while the executor owns a call.
        task?.shutdownNow(); task = null
        session.getAndSet(null)?.close()
        viewport?.close(); viewport = null
        toolpathPending = null; ready = false
        super.onPause()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("cells", cells)
        super.onSaveInstanceState(outState)
    }
    private fun startViewport() {
        if (!resumed || !::surface.isInitialized || viewport != null) return
        try {
            val renderer = FilamentViewport(surface)
            viewport = renderer
            renderer.setActive(true)
            renderer.loadGrid(cells)
            clipped = false; transparent = false; instanced = false; selected = null
            toolpathRequested = false; toolpathError = null
            task = Executors.newSingleThreadExecutor { action -> Thread(action, "OrcaXR preview fixture") }
            handler.post(update)
        } catch (_: RuntimeException) {
            viewport?.close(); viewport = null
            status = "Viewport unavailable on this device"
        } catch (_: LinkageError) {
            viewport?.close(); viewport = null
            status = "Renderer library unavailable"
        }
    }
    fun loadFixture(value: Int) {
        cells = value; selected = null; ready = false
        viewport?.loadGrid(value)
    }
    private val update = object : Runnable {
        override fun run() {
            val current = viewport ?: return
            val metrics = current.metrics()
            ready = metrics.state == "Ready" && metrics.pendingUploadBytes == 0L
            if (ready && !toolpathRequested) {
                toolpathRequested = true
                task?.execute {
                    val source = PreviewFixture.source
                    var prepared: ToolpathGeometry? = null
                    var failed = false
                    val owner = GcodeSession(source.length)
                    try {
                        if (Thread.currentThread().isInterrupted) return@execute
                        session.set(owner)
                        // Recheck after publication so pause cannot miss cancellation.
                        if (Thread.currentThread().isInterrupted) return@execute
                        owner.append(0, source.toCharArray()); owner.seal()
                        prepared = ToolpathGeometry.from(owner.whole(), owner.view(PreviewFixture.request))
                    } catch (_: Exception) { failed = true }
                    finally { session.compareAndSet(owner, null); owner.close() }
                    handler.post {
                        if (viewport !== current || !resumed) return@post
                        if (failed) toolpathError = "Rust toolpath fixture unavailable" else toolpathPending = prepared
                    }
                }
            }
            if (ready) toolpathPending?.let { current.setToolpath(it); toolpathPending = null; ready = false }
            status = "${metrics.state} · ${metrics.uploadedFacets} facets · ${metrics.drawEntities} draw entities\n" +
                "Buffers: ${metrics.gpuBufferBytes / 1_000_000} MB GPU estimate · ${metrics.sourceAndIndexBytes / 1_000_000} MB source/index · ${metrics.frames} frames" +
                (toolpathError?.let { "\n$it" } ?: "")
            handler.postDelayed(this, 250)
        }
    }

    private fun installTouch(view: FixtureSurface) {
        var downX = 0f; var downY = 0f; var lastX = 0f; var lastY = 0f; var dragged = false
        view.setOnTouchListener { _, event ->
            val renderer = viewport ?: return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y; lastX = downX; lastY = downY; dragged = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (abs(event.x - downX) + abs(event.y - downY) > 8) dragged = true
                    if (dragged) renderer.setCamera(renderer.cameraState().let { old ->
                        old.copy(yaw = old.yaw - (event.x - lastX) * .006,
                            pitch = (old.pitch + (event.y - lastY) * .006).coerceIn(.05, 1.5))
                    })
                    lastX = event.x; lastY = event.y; true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragged) { selected = renderer.pick(event.x.toDouble(), event.y.toDouble()); renderer.select(selected?.instance) }
                    view.performClick(); true
                }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }
}

object PreviewFixture {
    const val request = """{"version":1,"operation":"preview","window":[],"request":{"mode":"Feedrate"}}"""
    val source = buildString {
        append("G21\nG90\nM83\nG0 X-80 Y-80 Z60 F1200\n")
        for (row in 0..32) {
            val y = -80 + row * 5
            val x = if (row % 2 == 0) 80 else -80
            append("G1 X$x Y$y E2 F${600 + row * 120}\n")
        }
        append("G0 X20 Y0 Z65\nG3 X-20 Y0 I-20 J0 E1 F1200\n")
        append("G2 X20 Y0 I20 J0 E1 F2400\n")
    }
}

/** Keeps click accessibility events when the fixture touch handler picks a facet. */
private class FixtureSurface(context: android.content.Context) : SurfaceView(context) {
    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
