package dev.orcaxr.nativeapp.preview

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.core.GcodeArtifactText
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.renderer.GcodeMoveFilter
import dev.orcaxr.renderer.GcodePreviewPlan
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.PreviewFraming
import dev.orcaxr.renderer.ToolpathGeometry
import dev.orcaxr.renderer.filament.FilamentScene
import java.util.Locale
import kotlin.math.abs

/**
 * The Preview area, as the browser's "Open G-code Viewer…": a G-code file's
 * toolpaths drawn by the flat renderer in the shared preview's colours, with
 * the browser panel's controls — View (colour mode), Top/Bottom layer, Single
 * layer, Moves and, for a print too large to load at once, Previous/Next moves.
 * Drag orbits and pinch zooms the toolpath view. The view is above the
 * controls, or — given a [panelWidth], in a wide window — beside them at the
 * end, as the browser's sidebar sits at the start of its viewport.
 */
@Composable
fun PreviewScreen(model: PreviewModel, modifier: Modifier = Modifier, panelWidth: Dp? = null) {
    val state = model.state
    // Any document: providers often report G-code only as bytes or text.
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::open) }
    val renderer = remember { PreviewRenderer() }
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
    LaunchedEffect(state.toolpath, state.generation) { renderer.show(state.toolpath?.geometry, state.generation) }

    val view = @Composable { place: Modifier ->
        AndroidView(factory = { context -> PreviewSurface(context).also(renderer::attach) }, place)
    }
    val controls = @Composable { place: Modifier ->
        Column(
            place.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(stringResource(R.string.preview_heading), style = MaterialTheme.typography.titleMedium)
            OutlinedButton(onClick = { open.launch(arrayOf("*/*")) }, enabled = !state.loading) {
                Text(stringResource(R.string.preview_open))
            }
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(status(state), style = MaterialTheme.typography.bodySmall)
            if (state.slice != null) Text(stringResource(R.string.preview_sliced), style = MaterialTheme.typography.bodySmall)
            model.message?.let { message ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(message, Modifier.weight(1f))
                        TextButton(onClick = model::dismissMessage) { Text(stringResource(R.string.device_dismiss)) }
                    }
                }
            }
            val bounds = state.layerBounds ?: return@Column
            ModeChooser(state.mode, enabled = !state.loading, onChoose = model::setMode)
            LayerControls(state, bounds, model)
            MoveFilters(state, model)
            state.unsupportedReason?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            state.summary?.let { Summary(it) }
            state.layerCount?.let { Text(stringResource(R.string.preview_layers, it), style = MaterialTheme.typography.bodyMedium) }
            if (state.legend.isNotEmpty()) Legend(state.legend)
            state.range?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            state.limitations.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
    if (panelWidth != null) {
        Row(modifier) {
            controls(Modifier.width(panelWidth).fillMaxHeight())
            view(Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(modifier) {
            view(Modifier.fillMaxWidth().weight(1f))
            controls(Modifier.fillMaxWidth().weight(1f))
        }
    }
}

/** The browser panel's status line (`GcodePreviewPanel.render`). */
@Composable
private fun status(state: PreviewState): String = when {
    state.loading -> stringResource(R.string.preview_loading)
    state.source != null && state.unsupportedReason != null -> stringResource(R.string.preview_unavailable, state.source)
    state.source != null ->
        state.layerLabel?.let { stringResource(R.string.preview_showing_layers, state.source, it) }
            ?: stringResource(R.string.preview_showing, state.source)
    else -> stringResource(R.string.preview_idle)
}

/** "View": the shared preview's colour modes, in the browser's order and wording (`label (unit)`). */
@Composable
private fun ModeChooser(mode: String, enabled: Boolean, onChoose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    fun name(id: String) = GcodePreviewModes.get(id).let { if (it.unit != null) "${it.label} (${it.unit})" else it.label }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.preview_view))
        Box {
            OutlinedButton(onClick = { expanded = true }, enabled = enabled) { Text(name(mode)) }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                for (id in GcodePreviewModes.ids) {
                    DropdownMenuItem(
                        text = { Text(name(id)) },
                        onClick = { expanded = false; if (id != mode) onChoose(id) },
                    )
                }
            }
        }
    }
}

/** "Top layer" and "Bottom layer" sliders over the whole print, "Single layer", and Previous/Next moves when windowed. */
@Composable
private fun LayerControls(state: PreviewState, bounds: Pair<Int, Int>, model: PreviewModel) {
    val (low, high) = state.layerRange ?: bounds
    LayerSlider(stringResource(R.string.preview_top_layer), high, bounds, state.topZMm, !state.loading, model::setTopLayer)
    LayerSlider(stringResource(R.string.preview_bottom_layer), low, bounds, state.bottomZMm, !state.loading, model::setBottomLayer)
    LabelledCheckbox(stringResource(R.string.preview_single_layer), state.singleLayer, !state.loading, model::setSingleLayer)
    if (state.windowed) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { model.step(-1) }, enabled = !state.loading && state.hasPrevious) {
                Text(stringResource(R.string.preview_previous_moves))
            }
            OutlinedButton(onClick = { model.step(1) }, enabled = !state.loading && state.hasNext) {
                Text(stringResource(R.string.preview_next_moves))
            }
        }
    }
}

/**
 * One layer slider: it moves freely while dragged and applies on release, as
 * the browser's `change` event does; the view shown (which a bounded window
 * may narrow) puts it back once applied.
 */
@Composable
private fun LayerSlider(label: String, value: Int, bounds: Pair<Int, Int>, zMm: Double?, enabled: Boolean, apply: (Int) -> Unit) {
    val (minLayer, maxLayer) = bounds
    var position by remember(value, enabled) { mutableFloatStateOf(value.toFloat()) }
    val shown = GcodePreviewPlan.layerOf(position)
    val description = stringResource(R.string.preview_layer_of, shown, maxLayer)
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f))
            // The height is the shared inspection's, so only for the layer shown, not one being chosen.
            val height = if (shown == value && zMm != null) " · " + stringResource(R.string.preview_z_mm, String.format(Locale.ROOT, "%.2f", zMm)) else ""
            Text("$shown$height", style = MaterialTheme.typography.bodyMedium)
        }
        Slider(
            value = position.coerceIn(minLayer.toFloat(), maxLayer.toFloat()),
            onValueChange = { position = it },
            onValueChangeFinished = {
                val layer = GcodePreviewPlan.layerOf(position)
                if (layer != value) apply(layer)
            },
            valueRange = minLayer.toFloat()..maxOf(minLayer + 1, maxLayer).toFloat(),
            // One stop per layer; a tall print slides freely and rounds to a layer, as the browser's range input does.
            steps = (maxLayer - minLayer - 1).let { if (it in 0..MAX_SLIDER_TICKS) it else 0 },
            enabled = enabled && maxLayer > minLayer,
            // Material draws no focus on a slider: the ring shows where the arrow keys apply.
            modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary)
                .semantics { contentDescription = label; stateDescription = description },
        )
    }
}

/** "Moves": the move classes the browser lets a viewer hide. */
@Composable
private fun MoveFilters(state: PreviewState, model: PreviewModel) {
    Text(stringResource(R.string.preview_moves), style = MaterialTheme.typography.labelMedium)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (filter in GcodeMoveFilter.entries) {
            LabelledCheckbox(filter.label, filter in state.moves, !state.loading) { model.setMoveVisible(filter, it) }
        }
    }
}

/**
 * The file's own totals as the browser's panel shows them: the totals line,
 * then each tool that used filament, its colour a decorative swatch (the tool
 * number and material carry its identity, never the colour alone).
 */
@Composable
private fun Summary(summary: GcodeArtifactText) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(summary.totals, style = MaterialTheme.typography.bodyMedium)
        for (tool in summary.tools) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tool.colorHex?.let(::swatch)?.let { argb ->
                    Box(
                        Modifier.size(12.dp)
                            .background(Color(argb), RoundedCornerShape(2.dp))
                            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(2.dp)),
                    )
                }
                Text(tool.text, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** A CSS hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; the core passes no other) as ARGB. */
private fun swatch(hex: String): Int? {
    val digits = hex.removePrefix("#")
    val full = when (digits.length) {
        3, 4 -> digits.map { "$it$it" }.joinToString("")
        6, 8 -> digits
        else -> return null
    }
    val rgba = full.toLongOrNull(16) ?: return null
    return if (full.length == 6) (0xFF000000 or rgba).toInt() else ((rgba and 0xFF) shl 24 or (rgba ushr 8)).toInt()
}

/** The legend as the browser lists it: a decorative swatch, then `code · label`. */
@Composable
private fun Legend(entries: List<PreviewLegend>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (entry in entries) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = entry.accessibleLabel },
            ) {
                Box(Modifier.size(14.dp).background(Color(entry.argb), RoundedCornerShape(3.dp)))
                Text("${entry.code} · ${entry.label}", Modifier.widthIn(max = 480.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Keeps click accessibility events for the toolpath view's touches. */
private class PreviewSurface(context: Context) : SurfaceView(context) {
    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}

/** The Filament scene behind the Preview: the bed and the shared preview's toolpath. UI thread only. */
private class PreviewRenderer {
    private var surface: PreviewSurface? = null
    private var scene: FilamentScene? = null
    private var resumed = false
    private var toolpath: ToolpathGeometry? = null
    private var generation = -1L
    /** The file the camera was last framed for, and the viewer's orbit, kept while the scene is closed. */
    private var framed = Long.MIN_VALUE
    private var camera: OrbitCamera? = null
    private var bed: Pair<Double, Double>? = null

    fun attach(view: PreviewSurface) {
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
        scene?.let { camera = it.cameraState() }
        scene?.close()
        scene = null
        bed = null
    }

    /** Shows [value] (none clears it); a new [file] generation frames the camera on it. */
    fun show(value: ToolpathGeometry?, file: Long) {
        toolpath = value
        generation = file
        scene?.let(::present)
    }

    private fun start() {
        if (!resumed || scene != null) return
        val view = surface ?: return
        val renderer = FilamentScene(view)
        scene = renderer
        renderer.setActive(true)
        present(renderer)
        // The same file as before the pause: the viewer's orbit, not a fresh frame.
        camera?.takeIf { framed == generation }?.let(renderer::setCamera)
    }

    private fun present(renderer: FilamentScene) {
        val framing = PreviewFraming.of(toolpath)
        val size = framing.bedWidthMm to framing.bedDepthMm
        if (bed != size) {
            renderer.setBed(size.first, size.second)
            bed = size
        }
        renderer.setToolpath(toolpath)
        if (framed != generation) {
            framed = generation
            camera = null
            renderer.frameArea(framing.minXMm, framing.minYMm, framing.maxXMm, framing.maxYMm)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installTouch(view: PreviewSurface) {
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
                    old.copy(distance = (old.distance / detector.scaleFactor).coerceIn(.01, 4.5))
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
                MotionEvent.ACTION_UP -> view.performClick()
            }
            true
        }
    }

    companion object {
        private const val TOUCH_SLOP = 8f
        private const val ORBIT_RADIANS_PER_PIXEL = .006
    }
}

/** A slider with more layers than this has no tick marks. */
private const val MAX_SLIDER_TICKS = 200

/** A checkbox named by its label: the whole row toggles, and accessibility services read the label with it. */
@Composable
private fun LabelledCheckbox(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange).padding(end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Text(label)
    }
}
