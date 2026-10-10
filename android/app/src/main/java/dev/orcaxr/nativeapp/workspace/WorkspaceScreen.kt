package dev.orcaxr.nativeapp.workspace

import android.annotation.SuppressLint
import android.content.Context
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.renderer.PreviewFraming
import dev.orcaxr.renderer.SceneSync
import dev.orcaxr.renderer.filament.FilamentScene
import kotlin.math.abs

/**
 * The Workspace area: the project's active plate and its objects, drawn by
 * the flat renderer from the session's own render deltas and mesh packets
 * (never a second copy of the project), on the bed the project's own
 * configuration states. Drag orbits, pinch zooms; a tap selects the
 * instance under the finger in the project (Shift, Ctrl or Meta held
 * toggles it, a tap on nothing deselects all), as a click on a model does
 * in the browser, and the scene highlights the project's selection. While
 * the Lay flat tool is on (the Edit menu's), a tap lays the tapped facet on
 * the bed instead, as a click does with the browser's tool.
 */
@Composable
fun WorkspaceScreen(model: ProjectModel, modifier: Modifier = Modifier) {
    val renderer = remember { WorkspaceRenderer(model) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        // The renderer holds a GPU surface: it exists only while the screen is resumed.
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> renderer.resume()
                Lifecycle.Event.ON_PAUSE -> renderer.pause()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) renderer.resume()
        onDispose {
            lifecycle.removeObserver(observer)
            renderer.pause()
        }
    }
    val view = model.view
    // The canonical selection, wherever it was made (here, the Project area's tree, an edit).
    val selected = view.selection.instances
    SideEffect { renderer.highlight(selected) }
    LaunchedEffect(view.bed.widthMm, view.bed.depthMm) { renderer.bed(view.bed.widthMm, view.bed.depthMm) }
    Box(modifier) {
        AndroidView(factory = { context -> WorkspaceSurface(context).also(renderer::attach) }, Modifier.fillMaxSize())
        // Objects on every plate (the tree may show them collapsed).
        val objects = view.plateList.sumOf { it.objects }
        Text(
            if (objects == 0) stringResource(R.string.workspace_empty) else view.name,
            Modifier.align(Alignment.TopStart).padding(16.dp),
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (model.layingFlat) {
            // The Lay flat tool's status (the browser's), and the way out of it.
            Card(Modifier.align(Alignment.BottomCenter).padding(16.dp)) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(if (model.layFlatMissed) R.string.workspace_lay_flat_missed else R.string.workspace_lay_flat_hint),
                        Modifier.weight(1f, fill = false).semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    TextButton(onClick = { model.layFlat(false) }) { Text(stringResource(R.string.workspace_lay_flat_done)) }
                }
            }
        }
    }
}

/** Keeps click accessibility events when a tap picks an instance. */
private class WorkspaceSurface(context: Context) : SurfaceView(context) {
    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}

/** The Filament scene behind the Workspace, fed by the project model's scene updates. UI thread only. */
private class WorkspaceRenderer(private val model: ProjectModel) {
    private var surface: WorkspaceSurface? = null
    private var scene: FilamentScene? = null
    private var listening: AutoCloseable? = null
    private var resumed = false
    private var highlighted: Set<String> = emptySet()

    /** Highlights the project's selected instances, now and in a scene made later. */
    fun highlight(instances: Set<String>) {
        highlighted = instances
        scene?.select(instances)
    }
    /** The project's bed (mm), drawable sides: the browser's 200 mm plate until the project is read. */
    private var bed = 200.0 to 200.0

    fun attach(view: WorkspaceSurface) {
        surface = view
        installTouch(view)
        start()
    }

    fun resume() {
        resumed = true
        start()
    }

    /** Draws the project's bed of [widthMm] × [depthMm] and frames it when it changes. */
    fun bed(widthMm: Double, depthMm: Double) {
        val next = PreviewFraming.drawable(widthMm) to PreviewFraming.drawable(depthMm)
        if (next == bed) return
        bed = next
        scene?.let { renderer ->
            renderer.setBed(next.first, next.second)
            renderer.frame(next.first, next.second)
        }
    }

    fun pause() {
        resumed = false
        listening?.close()
        listening = null
        scene?.close()
        scene = null
    }

    private fun start() {
        if (!resumed || scene != null) return
        val view = surface ?: return
        val renderer = FilamentScene(view)
        scene = renderer
        renderer.setBed(bed.first, bed.second)
        renderer.frame(bed.first, bed.second)
        renderer.setActive(true)
        renderer.select(highlighted)
        // The first update is everything known; later ones are what changed.
        listening = model.listenScene { update -> if (scene === renderer) apply(renderer, update) }
    }

    private fun apply(renderer: FilamentScene, update: SceneSync.Update) {
        update.removed.forEach(renderer::removeMesh)
        update.meshes.forEach { (asset, mesh) -> renderer.setMesh(asset, mesh) }
        renderer.setDraws(update.draws)
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installTouch(view: WorkspaceSurface) {
        var downX = 0f
        var downY = 0f
        var lastX = 0f
        var lastY = 0f
        var dragged = false
        var scaling = false
        val pinch = ScaleGestureDetector(view.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val renderer = scene ?: return false
                renderer.setCamera(renderer.cameraState().let { old ->
                    old.copy(distance = (old.distance / detector.scaleFactor).coerceIn(.05, 4.5))
                })
                return true
            }
        })
        view.setOnTouchListener { _, event ->
            val renderer = scene ?: return@setOnTouchListener false
            pinch.onTouchEvent(event)
            if (event.pointerCount > 1) scaling = true
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y; lastX = downX; lastY = downY
                    dragged = false; scaling = false
                }
                MotionEvent.ACTION_MOVE -> if (!scaling) {
                    if (abs(event.x - downX) + abs(event.y - downY) > TOUCH_SLOP) dragged = true
                    if (dragged) renderer.setCamera(renderer.cameraState().let { old ->
                        old.copy(
                            yaw = old.yaw - (event.x - lastX) * ORBIT_RADIANS_PER_PIXEL,
                            pitch = (old.pitch + (event.y - lastY) * ORBIT_RADIANS_PER_PIXEL).coerceIn(.05, 1.5),
                        )
                    })
                    lastX = event.x; lastY = event.y
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragged && !scaling) {
                        val hit = renderer.pick(event.x.toDouble(), event.y.toDouble())
                        if (model.layingFlat) {
                            // The Lay flat tool owns the tap, as the browser's does: it never selects.
                            model.layFlatAt(hit?.instanceId, hit?.volumeId, hit?.facet ?: 0)
                        } else {
                            val extend = event.metaState and (KeyEvent.META_SHIFT_ON or KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON) != 0
                            model.selectInstance(hit?.instanceId, extend)
                        }
                    }
                    view.performClick()
                }
            }
            true
        }
    }

    companion object {
        private const val TOUCH_SLOP = 8f
        private const val ORBIT_RADIANS_PER_PIXEL = .006
    }
}
