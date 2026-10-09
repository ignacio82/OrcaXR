package dev.orcaxr.nativeapp.workspace

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.renderer.SceneSync
import dev.orcaxr.renderer.filament.FilamentScene
import kotlin.math.abs

/**
 * The Workspace area: the project's active plate and its objects, drawn by
 * the flat renderer from the session's own render deltas and mesh packets
 * (never a second copy of the project). Drag orbits, pinch zooms, a tap
 * highlights the instance under the finger.
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
    Box(modifier) {
        AndroidView(factory = { context -> WorkspaceSurface(context).also(renderer::attach) }, Modifier.fillMaxSize())
        val view = model.view
        val objects = view.rows.count { it.kind == dev.orcaxr.core.ProjectIntents.ObjectTreeRowKind.Object }
        Text(
            if (objects == 0) stringResource(R.string.workspace_empty) else view.name,
            Modifier.align(Alignment.TopStart).padding(16.dp),
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
        )
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

    fun attach(view: WorkspaceSurface) {
        surface = view
        installTouch(view)
        start()
    }

    fun resume() {
        resumed = true
        start()
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
        val bed = ProjectWorkspace.PLACEMENT
        renderer.setBed(bed.bedWidthMm ?: BED_MM, bed.bedDepthMm ?: BED_MM)
        renderer.frame(bed.bedWidthMm ?: BED_MM, bed.bedDepthMm ?: BED_MM)
        renderer.setActive(true)
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
                    if (!dragged && !scaling) renderer.select(renderer.pick(event.x.toDouble(), event.y.toDouble())?.instanceId)
                    view.performClick()
                }
            }
            true
        }
    }

    companion object {
        /** The browser's plate without a printer profile. */
        private const val BED_MM = 200.0
        private const val TOUCH_SLOP = 8f
        private const val ORBIT_RADIANS_PER_PIXEL = .006
    }
}
