package dev.orcaxr.nativeapp.workspace

import android.annotation.SuppressLint
import android.content.Context
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.ProjectSceneSummary
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import dev.orcaxr.nativeapp.theme.OrcaThemeTokens
import dev.orcaxr.nativeapp.theme.ThemeSwitch
import dev.orcaxr.renderer.CameraView
import dev.orcaxr.renderer.CameraViews
import dev.orcaxr.renderer.PreviewFraming
import dev.orcaxr.renderer.ProjectScene
import dev.orcaxr.renderer.SceneSync
import dev.orcaxr.renderer.filament.FilamentScene
import java.util.Locale
import kotlin.math.abs

/**
 * The Workspace area: the project's active plate and its objects, drawn by
 * the flat renderer from the session's own render deltas and mesh packets
 * (never a second copy of the project), on the bed the project's own
 * configuration states, each part in its filament's colour and its paint.
 * Drag orbits, pinch zooms; a tap selects the instance under the finger in
 * the project (Shift, Ctrl or Meta held toggles it, a tap on nothing
 * deselects all), as a click on a model does in the browser, and the scene
 * highlights the project's selection. While the Lay flat tool is on (the
 * Edit menu's), a tap lays the tapped facet on the bed instead; while the
 * paint tool is on (the toolbar's Paint), a drag that starts on a model
 * paints it, as the browser's painter does, and its panel chooses the
 * channel, palette row, tool and brush.
 *
 * It wears the theme's viewport wash and plate colours, and offers the
 * browser's theme switch at its top end. To an accessibility service the
 * view is the browser's "Build plate", says what stands on it and what is
 * selected ([ViewDescription]), and offers the browser's View menu camera
 * views as actions — the gestures' only other way to move the camera.
 */
@Composable
fun WorkspaceScreen(model: ProjectModel, modifier: Modifier = Modifier) {
    val renderer = remember { WorkspaceRenderer(model) }
    val resources = LocalResources.current
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
    val paint = model.paint
    // The canonical selection, wherever it was made (here, the Project area's tree, an edit).
    val selected = view.selection.instances
    SideEffect { renderer.highlight(selected) }
    LaunchedEffect(view.bed.widthMm, view.bed.depthMm) { renderer.bed(view.bed.widthMm, view.bed.depthMm) }
    val theme = LocalOrcaTheme.current.tokens
    SideEffect { renderer.theme(theme) }
    val words = ViewDescription.Words(
        plate = { name, count -> resources.getString(R.string.prepare_plate, name, count) },
        empty = stringResource(R.string.workspace_plate_empty),
        selection = stringResource(R.string.workspace_selection),
        nothingSelected = stringResource(R.string.workspace_nothing_selected),
    )
    val described = ViewDescription.workspace(ProjectSceneSummary.of(view), words)
    val label = stringResource(R.string.workspace_view)
    val cameras = ViewDescription.cameraActions(renderer::show)
    // The palette follows the project's filaments while painting.
    LaunchedEffect(view.revision, paint.state.active) { if (paint.state.active) paint.refreshPalette() }
    Box(modifier) {
        AndroidView(
            factory = { context -> WorkspaceSurface(context).also(renderer::attach) },
            Modifier.fillMaxSize().semantics {
                contentDescription = label
                stateDescription = described
                customActions = cameras
            },
        )
        // Objects on every plate (the tree may show them collapsed).
        val objects = view.plateList.sumOf { it.objects }
        Row(Modifier.align(Alignment.TopStart).fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (objects == 0) stringResource(R.string.workspace_empty) else view.name,
                Modifier.weight(1f).padding(vertical = 16.dp),
                color = MaterialTheme.colorScheme.onBackground,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!paint.state.active) {
                // The browser's toolbar Paint (`tool_paint`), enabled as the core enables it.
                FilledTonalButton(
                    onClick = { paint.start(PaintChannel.COLOR) },
                    enabled = paint.enabled(PaintChannel.COLOR.toolAction),
                    modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary),
                ) { Text(stringResource(R.string.workspace_paint)) }
            }
            // The browser's theme switch, which it keeps in the strip above its viewport.
            ThemeSwitch()
        }
        if (paint.state.active) {
            PaintPanel(paint, Modifier.align(Alignment.BottomCenter).padding(8.dp))
        } else if (model.layingFlat) {
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

/** What the painter says, in the browser's words. */
@Composable
private fun statusText(status: PaintStatus): String = when (status) {
    is PaintStatus.Tool -> stringResource(R.string.paint_status_tool, status.channel.label)
    is PaintStatus.Filament -> stringResource(R.string.paint_status_filament, status.name)
    PaintStatus.EraseToDefault -> stringResource(R.string.paint_status_erase_default)
    PaintStatus.NotInProject -> stringResource(R.string.paint_status_not_in_project)
    is PaintStatus.Unavailable -> status.reason ?: stringResource(R.string.paint_status_unavailable)
    is PaintStatus.ToolKind -> stringResource(R.string.paint_status_tool_kind, PaintNames.wire(status.tool))
    is PaintStatus.ChannelState -> stringResource(R.string.paint_status_channel_state, status.channel.label, status.state)
    is PaintStatus.Painted -> stringResource(R.string.paint_status_painted, status.channel.label)
    is PaintStatus.Erased -> stringResource(R.string.paint_status_erased, status.channel.label)
    is PaintStatus.Failed -> stringResource(R.string.paint_status_failed, status.message)
    is PaintStatus.EraseAllNeedsModel -> stringResource(R.string.paint_status_erase_needs_model, status.channel.label)
    is PaintStatus.ErasedAll -> stringResource(R.string.paint_status_erased_all, status.channel.label, status.parts.toString())
    PaintStatus.NothingPainted -> stringResource(R.string.paint_status_nothing)
}

/** The paint panel's most height: the model on the bed stays in sight above it, and the panel scrolls. */
private const val PANEL_SHARE = .32f

/** `#rrggbb` as a colour; grey for anything else. */
private fun swatch(text: String): Color = runCatching { Color(0xff000000 or text.removePrefix("#").toLong(16)) }.getOrDefault(Color.Gray)

/**
 * The browser's paint panel (`PaintPanel.ts`), at the Workspace's foot: the
 * channel, the palette (or the channel's states and Erase), the tool, its
 * brush parameters and Erase all painting on selection; every choice the
 * painter's, the palette rows and tools enabled as the core enables them.
 */
@Composable
private fun PaintPanel(paint: PaintModel, modifier: Modifier) {
    val state = paint.state
    val ring = MaterialTheme.colorScheme.primary
    val tall = LocalConfiguration.current.screenHeightDp
    Card(modifier.fillMaxWidth()) {
        Column(
            Modifier.heightIn(max = (tall * PANEL_SHARE).dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.paint_title), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                TextButton(onClick = paint::stop, modifier = Modifier.focusRing(ring)) { Text(stringResource(R.string.workspace_lay_flat_done)) }
            }
            Text(
                paint.status?.let { statusText(it) } ?: stringResource(R.string.paint_hint),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodySmall,
            )
            val channels = stringResource(R.string.paint_channels)
            FlowRow(Modifier.semantics { contentDescription = channels }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (channel in PaintChannel.entries) {
                    FilterChip(
                        selected = state.channel == channel,
                        onClick = { paint.chooseChannel(channel) },
                        enabled = state.channel == channel || paint.enabled(channel.toolAction),
                        label = { Text(stringResource(PaintNames.channel(channel))) },
                        modifier = Modifier.focusRing(ring),
                    )
                }
            }
            if (state.channel == PaintChannel.COLOR) {
                val filaments = stringResource(R.string.paint_filaments)
                FlowRow(Modifier.semantics { contentDescription = filaments }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (row in paint.palette) {
                        val chosen = if (row.filamentId == null) state.erasing() else state.mode == PaintMode.PAINT && state.filamentId == row.filamentId
                        val described = listOfNotNull(row.name, row.badge, row.recipe, row.unavailableReason).joinToString(" — ")
                        FilterChip(
                            selected = chosen,
                            onClick = { paint.chooseFilament(row.filamentId) },
                            enabled = row.selectable,
                            leadingIcon = {
                                val fill = if (row.gradient.size > 1) Modifier.background(Brush.horizontalGradient(row.gradient.map(::swatch)), RoundedCornerShape(4.dp))
                                else Modifier.background(swatch(row.color), RoundedCornerShape(4.dp))
                                Box(Modifier.size(18.dp).then(fill).border(1.dp, Color.Black.copy(alpha = .5f), RoundedCornerShape(4.dp)))
                            },
                            label = {
                                Column {
                                    Text(row.name)
                                    Text(
                                        row.keyboardNumber?.let { stringResource(R.string.paint_badge_key, row.badge, it.toString()) } ?: row.badge,
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                            },
                            modifier = Modifier.focusRing(ring).semantics { contentDescription = described },
                        )
                    }
                }
            } else {
                val states = stringResource(R.string.paint_states)
                FlowRow(Modifier.semantics { contentDescription = states }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (option in PaintToolState.CHANNEL_STATES[state.channel].orEmpty()) {
                        FilterChip(
                            selected = state.mode == PaintMode.PAINT && state.channelValues[state.channel] == option.value,
                            onClick = { paint.chooseChannelState(option.value) },
                            leadingIcon = { Box(Modifier.size(14.dp).background(Color(option.color), RoundedCornerShape(3.dp))) },
                            label = { Text(stringResource(PaintNames.state(option.key))) },
                            modifier = Modifier.focusRing(ring),
                        )
                    }
                    FilterChip(
                        selected = state.mode == PaintMode.ERASE,
                        onClick = paint::eraseChannel,
                        label = { Text(stringResource(R.string.paint_state_erase)) },
                        modifier = Modifier.focusRing(ring),
                    )
                }
            }
            val tools = stringResource(R.string.paint_tools)
            FlowRow(Modifier.semantics { contentDescription = tools }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (tool in PaintToolKind.entries) {
                    FilterChip(
                        selected = state.settings.tool == tool,
                        onClick = { paint.chooseTool(tool) },
                        label = { Text(stringResource(PaintNames.tool(tool))) },
                        modifier = Modifier.focusRing(ring),
                    )
                }
            }
            for (parameter in PaintToolState.parameters(state.settings.tool)) PaintParameterSlider(paint, parameter)
            OutlinedButton(
                onClick = paint::eraseAll,
                enabled = paint.enabled("paint_erase_all"),
                modifier = Modifier.focusRing(ring),
            ) { Text(stringResource(R.string.paint_erase_all)) }
        }
    }
}

/** One of the panel's number fields as a slider over its range and step, applied on release as the browser's `change` is. */
@Composable
private fun PaintParameterSlider(paint: PaintModel, parameter: PaintParameter) {
    val value = paint.state.value(parameter)
    var position by remember(value) { mutableFloatStateOf(value.toFloat()) }
    val label = stringResource(PaintNames.parameter(parameter))
    val shown = String.format(Locale.ROOT, if (parameter.step < 1) "%.1f" else "%.0f", position)
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            Text(shown, style = MaterialTheme.typography.bodySmall)
        }
        Slider(
            value = position,
            onValueChange = { position = it },
            onValueChangeFinished = { paint.chooseParameter(parameter, PaintNames.stepped(parameter, position.toDouble())) },
            valueRange = parameter.min.toFloat()..parameter.max.toFloat(),
            steps = PaintNames.steps(parameter),
            modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary)
                .semantics { contentDescription = label; stateDescription = shown },
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
    private var highlighted: Set<String> = emptySet()
    /** The draws shown, by key: what a paint gesture's part is. */
    private var draws: Map<String, ProjectScene.Draw> = emptyMap()

    /** Highlights the project's selected instances, now and in a scene made later. */
    fun highlight(instances: Set<String>) {
        highlighted = instances
        scene?.select(instances)
    }
    /** The project's bed (mm), drawable sides: the browser's 200 mm plate until the project is read. */
    private var bed = 200.0 to 200.0
    /** The theme's wash and plate, applied to every scene made. */
    private var theme: OrcaThemeTokens? = null

    /** Dresses the view in [tokens]: the viewport's wash behind it, the plate skin's lines for the bed. */
    fun theme(tokens: OrcaThemeTokens) {
        if (tokens == theme) return
        theme = tokens
        scene?.let { dress(it, tokens) }
    }

    private fun dress(renderer: FilamentScene, tokens: OrcaThemeTokens) {
        renderer.setBackdrop(tokens.viewportTop.toInt(), tokens.viewportBottom.toInt())
        renderer.setBedColors(tokens.plate.gridMajor.toInt(), tokens.plate.gridMinor.toInt())
    }

    /** Puts the camera on the browser's [view] of the project's bed. */
    fun show(view: CameraView) {
        scene?.setCamera(CameraViews.of(view, bed.first, bed.second))
    }

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
        model.paint.cancel()
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
        theme?.let { dress(renderer, it) }
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
        draws = update.draws.associateBy { it.key }
        // Paint changes colour bytes alone.
        update.paint.forEach(renderer::setPaint)
    }

    /** What a pick met, as the painter takes it; null without a hit in the part's own frame. */
    private fun touch(pick: FilamentScene.Pick?): PaintModel.Touch? {
        val local = pick?.localPoint ?: return null
        val eye = pick.localOrigin ?: return null
        val draw = draws[pick.key]
        return PaintModel.Touch(pick.key, pick.volumeId, draw?.role, pick.facet, local, eye, draw?.placement)
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installTouch(view: WorkspaceSurface) {
        var downX = 0f
        var downY = 0f
        var lastX = 0f
        var lastY = 0f
        var dragged = false
        var scaling = false
        var stroking = false
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
            val paint = model.paint
            pinch.onTouchEvent(event)
            if (event.pointerCount > 1) {
                scaling = true
                // A second finger zooms: the stroke in flight is dropped, as a cancelled pointer drops the browser's.
                if (stroking) { paint.cancel(); stroking = false }
            }
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y; lastX = downX; lastY = downY
                    dragged = false; scaling = false; stroking = false
                    // The paint tool owns a touch that starts on a model; one that starts on nothing orbits.
                    if (paint.state.active) touch(renderer.pick(event.x.toDouble(), event.y.toDouble()))?.let { stroking = paint.begin(it) }
                }
                MotionEvent.ACTION_MOVE -> if (stroking) {
                    // The stroke samples its own part alone, as the browser's painter intersects its display.
                    paint.painting?.let { key -> touch(renderer.pick(event.x.toDouble(), event.y.toDouble(), key))?.let(paint::move) }
                } else if (!scaling) {
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
                    if (stroking) {
                        stroking = false
                        paint.end()
                    } else if (!dragged && !scaling && !paint.state.active) {
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
                MotionEvent.ACTION_CANCEL -> if (stroking) {
                    stroking = false
                    paint.cancel()
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
