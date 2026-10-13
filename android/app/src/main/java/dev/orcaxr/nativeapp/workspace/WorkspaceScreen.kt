package dev.orcaxr.nativeapp.workspace

import android.annotation.SuppressLint
import android.content.Context
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import android.view.ViewConfiguration
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.core.BrimEarState
import dev.orcaxr.core.GizmoEventKind
import dev.orcaxr.core.GizmoMode
import dev.orcaxr.core.GizmoState
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectSceneSummary
import dev.orcaxr.core.TransformGizmo
import dev.orcaxr.core.TransformProxy
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ShellLayout
import dev.orcaxr.nativeapp.shell.WidthClass
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import dev.orcaxr.nativeapp.theme.OrcaThemeTokens
import dev.orcaxr.nativeapp.theme.ThemeSwitch
import dev.orcaxr.renderer.CameraView
import dev.orcaxr.renderer.CameraViews
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.OrbitGestures
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.PreviewFraming
import dev.orcaxr.renderer.ProjectScene
import dev.orcaxr.renderer.SceneExplosion
import dev.orcaxr.renderer.SceneMarker
import dev.orcaxr.renderer.SceneSync
import dev.orcaxr.renderer.TriangleMesh
import dev.orcaxr.renderer.filament.FilamentScene
import java.util.Locale
import kotlin.math.abs

/**
 * The Workspace area: the project's active plate and its objects, drawn by
 * the flat renderer from the session's own render deltas and mesh packets
 * (never a second copy of the project), on the bed the project's own
 * configuration states, each part in its filament's colour and its paint.
 * The camera moves as the browser's OrbitControls move it ([ViewNavigation]):
 * a drag orbits, two fingers pinch to zoom, a mouse's right button pans and
 * its middle button zooms, a wheel, a trackpad's scroll or a touchpad's
 * two-finger swipe zooms. A tap selects the instance under the finger in the
 * project (Shift, Ctrl or Meta held toggles it, a tap on nothing deselects
 * all), as a click on a model does in the browser, and the scene highlights
 * the project's selection; a secondary click (the mouse's right button, a
 * touchpad's two-finger click, a pen's button) or a long press opens the
 * browser's scene context menu where it was ([SceneMenu]). The strip at the
 * top carries the browser's quick actions, the command palette's search and
 * the theme switch; the model toolbar ([ModelToolbar]) floats under it over
 * the view's top edge, as the browser's does — across a phone's width, where
 * the tools' panels keep the foot (the browser's phone layout puts it at the
 * foot instead, where the app's bottom bar already is). One tool at a time owns the
 * touch, as the browser's `setTool` allows one: while the Lay flat tool is on
 * (the toolbar's or the Edit menu's), a tap lays the tapped facet on the bed
 * instead; while the Measure tool is on, a tap picks the feature under it,
 * the readout shows in the browser's Measure panel and the measured line is
 * drawn on the model; while a paint tool is on (the toolbar's Paint or a
 * channel's painting), a drag that starts on a model paints it, as the
 * browser's painter does, and its panel chooses the channel, palette row,
 * tool and brush; while the Brim Ears tool is on, a tap on the object ears go
 * on places an ear there, at the object's base, and the placed ears are drawn
 * as the browser's discs. The tool's panel — the paint panel, the Measure
 * panel, the Brim ears panel or the Lay flat card — takes the view's foot. A simplify preview draws the decimated parts in place of
 * the model's, with the Simplify panel's Apply and Cancel beneath the strip
 * at the view's top, whichever tool is on.
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
    // The gizmo stands over the selection, read again whenever the project or the selection changes (the browser's
    // syncTransformProxy) — not while its own drag edits the project, which reads it once as the drag ends.
    LaunchedEffect(view.revision, view.selection) { if (!renderer.gizmoPressed) model.refreshGizmo() }
    // Only Move, Rotate and Scale show it: under any other tool the gizmo stands over nothing.
    val proxy = if (model.gizmoShown) model.gizmoProxy else TransformProxy.None
    val gizmoMode = model.gizmoMode
    SideEffect { renderer.gizmo(proxy, gizmoMode) }
    LaunchedEffect(view.bed.widthMm, view.bed.depthMm) { renderer.bed(view.bed.widthMm, view.bed.depthMm) }
    // The Brim Ears tool reads what it shows again whenever the project or the selection changes, and draws its discs.
    LaunchedEffect(view.revision, view.selection, model.brimEaring) { if (model.brimEaring) model.refreshBrimEars() }
    val earsShown = model.brimEaring
    val ears = model.brimEarState
    SideEffect { renderer.brimEars(earsShown, ears) }
    // The Assembly tool's exploded view: the draws moved apart on screen, the project untouched.
    val explosion = model.explosionFactor
    SideEffect { renderer.explode(explosion) }
    // The wipe tower's ghost, read again whenever the project changes (the browser rebuilds it with the preflight).
    LaunchedEffect(view.revision) { model.refreshWipeTowerGhost() }
    val ghost = model.wipeTowerGhost
    SideEffect { renderer.wipeTowerGhost(ghost) }
    // The Emboss and SVG part tools read what applying acts on again whenever the project or the selection changes.
    val drawn = model.drawn
    LaunchedEffect(view.revision, view.selection, drawn.embossing, drawn.svgCutting) {
        if (drawn.embossing || drawn.svgCutting) drawn.refreshTarget()
    }
    // A simplify preview's meshes drawn in place of the previewed volumes' own.
    val previewed = model.simplifyMeshes
    SideEffect { renderer.preview(previewed) }
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
    // A camera view chosen elsewhere (the command palette's View menu entries).
    val camera = model.cameraRequest
    LaunchedEffect(camera) {
        camera ?: return@LaunchedEffect
        renderer.show(camera.view)
        model.cameraShown(camera)
    }
    // A secondary press, a pen's button or a long press on the view: the scene's context menu.
    var sceneMenu by remember { mutableStateOf<SceneMenuRequest?>(null) }
    SideEffect {
        renderer.onMenu = { request ->
            // As the browser's right-click: a model not yet selected is selected alone first, so the menu's
            // entries act on the model pressed; a press on nothing opens the plate's menu and keeps the selection.
            request.instanceId?.takeIf { it !in model.view.selection.instances }?.let { model.selectInstance(it, extend = false) }
            sceneMenu = request
        }
    }
    val width = LocalWindowInfo.current.containerDpSize.width.value.toInt()
    val compact = WidthClass.of(width) == WidthClass.Compact
    Box(modifier) {
        AndroidView(
            factory = { context -> WorkspaceSurface(context).also(renderer::attach) },
            Modifier.fillMaxSize().onSizeChanged { renderer.size = it },
            update = { surface -> ViewDescription.describe(surface, label, described, cameras) },
        )
        // The gizmo's handles, then the measured line, under every panel.
        renderer.gizmoView?.let { TransformGizmoOverlay(it, gizmoMode, renderer.camera, renderer.size) }
        if (model.measuring) model.measureReadout?.let { readout ->
            readout.annotation?.let { annotation ->
                // Each end on its part as the exploded view draws it.
                val drawn = if (readout.picks.size < 2) annotation
                else explodedAnnotation(annotation, readout.picks[0].instanceId, readout.picks[1].instanceId, renderer.explosionOffsets)
                MeasureAnnotationOverlay(drawn, renderer.camera, renderer.size)
            }
        }
        // Objects on every plate (the tree may show them collapsed).
        val objects = view.plateList.sumOf { it.objects }
        Column(Modifier.align(Alignment.TopStart).fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (objects == 0) stringResource(R.string.workspace_empty) else view.name,
                    Modifier.weight(1f).padding(vertical = 16.dp),
                    color = MaterialTheme.colorScheme.onBackground,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // The browser's menu strip: Save, Undo, Redo and the command palette's search, then its theme switch.
                StripActions(model, wide = width > ShellLayout.NARROW_SIDEBAR_UP_TO_DP, compact = compact)
                ThemeSwitch()
            }
            // The model toolbar over the view's top edge, as the browser's: centred, or across a phone's width.
            ModelToolbar(model, if (compact) Modifier.fillMaxWidth() else Modifier.align(Alignment.CenterHorizontally))
            // A simplify preview's Apply and Cancel, beneath the strip: clear of the tools' panels at the foot.
            model.simplifyPreview?.let { SimplifyCard(model, it, Modifier.align(Alignment.CenterHorizontally)) }
        }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            // The active tool's panel takes the view's foot: one tool at a time, as the browser's `setTool`.
            if (paint.state.active) {
                PaintPanel(paint, Modifier.padding(8.dp))
            } else if (model.measuring) {
                MeasureCard(model)
            } else if (model.brimEaring) {
                BrimEarsCard(model)
            } else if (drawn.embossing) {
                EmbossCard(model)
            } else if (drawn.svgCutting) {
                SvgPartCard(model)
            } else if (model.layingFlat) {
                // The Lay flat tool's status (the browser's), and the way out of it.
                Card(Modifier.padding(16.dp)) {
                    Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            stringResource(model.layFlatNote),
                            Modifier.weight(1f, fill = false).semantics { liveRegion = LiveRegionMode.Polite },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        TextButton(onClick = { model.layFlat(false) }) { Text(stringResource(R.string.workspace_lay_flat_done)) }
                    }
                }
            }
        }
        sceneMenu?.let { request -> SceneMenu(model, request) { sceneMenu = null } }
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
    PaintStatus.Previewed -> stringResource(R.string.simplify_preview_pick)
}

/** A tool panel's most height (paint, Measure): the model on the bed stays in sight above it, and the panel scrolls. */
internal const val PANEL_SHARE = .32f

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
    /** The project's draws as last delivered, by key: what a paint gesture's part is. */
    private var draws: Map<String, ProjectScene.Draw> = emptyMap()
    private var drawn: List<ProjectScene.Draw> = emptyList()
    /** The camera as the scene last moved it, and the view's size: what the measured line is projected through. */
    var camera by mutableStateOf<OrbitCamera?>(null)
        private set
    var size by mutableStateOf(IntSize.Zero)

    // ---- The transform gizmo: three.js's TransformControls, in the shared core ----

    /** Where the gizmo stands and what a drag carries, as last attached ([ProjectModel.gizmoProxy]). */
    private var placed: TransformProxy = TransformProxy.None
    /** Whether the gizmo has to stand again where the selection is: a drag of it ended. */
    private var replace = false
    /** The gizmo's state as the core last answered, while it stands over a selection. */
    private var gizmo by mutableStateOf<GizmoState?>(null)
    private var gizmoMode by mutableStateOf(GizmoMode.TRANSLATE)
    /** The drag of its handles in flight; null too once refused, while the finger that pressed is still down. */
    private var gizmoDrag: ProjectModel.GizmoDrag? = null
    /** Whether the press now down took a handle of the gizmo: the touch is the gizmo's until it lifts. */
    var gizmoPressed = false
        private set

    /** What the gizmo shows through the camera now, or null when it stands over nothing. */
    val gizmoView by derivedStateOf {
        val state = gizmo
        val scene = camera?.let { WorkspaceGizmo.scene(it, size, gizmoMode) }
        if (state == null || scene == null) null else TransformGizmo.present(scene, state)
    }

    /**
     * Stands the gizmo where [proxy] says (again on every read, as the
     * browser's `syncTransformProxy` after every change), with [mode]'s
     * handles — never under a drag in flight, which puts it back as it ends.
     * A new mode first ends a press on the gizmo, as the browser's `setTool`
     * cancels its gesture.
     */
    fun gizmo(proxy: TransformProxy, mode: GizmoMode) {
        if (mode != gizmoMode) {
            if (gizmoPressed) liftGizmo(0f, 0f)
            gizmoMode = mode
        }
        if (gizmoPressed || (proxy == placed && !replace)) return
        placed = proxy
        replace = false
        gizmo = (proxy as? TransformProxy.Placed)?.let { TransformGizmo.attach(it.pose) }
    }

    /** The gizmo's state after a pointer event of [kind] at ([x], [y]) in the view; null without a gizmo. */
    private fun stepGizmo(kind: GizmoEventKind, x: Float, y: Float): GizmoState? {
        val state = gizmo ?: return null
        val scene = camera?.let { WorkspaceGizmo.scene(it, size, gizmoMode) } ?: return null
        val (ndcX, ndcY) = WorkspaceGizmo.ndc(x, y, size)
        return TransformGizmo.step(scene, state, kind, ndcX, ndcY).also { gizmo = it }
    }

    /**
     * A press at ([x], [y]): whether it took a handle of the gizmo, which then
     * drags as the finger moves (TransformControls' `pointerdown`, a hover
     * first so the handle under it is the one).
     */
    private fun pressGizmo(x: Float, y: Float): Boolean {
        val state = stepGizmo(GizmoEventKind.PRESS, x, y) ?: return false
        val proxy = placed as? TransformProxy.Placed
        if (!state.dragging || proxy == null) return false
        gizmoPressed = true
        gizmoDrag = model.beginGizmoDrag(proxy, state.proxy)
        return true
    }

    /** The pressed finger moved to ([x], [y]): the handle drags, and what that changes goes to the drag's gesture. */
    private fun dragGizmo(x: Float, y: Float) {
        val drag = gizmoDrag ?: return
        val state = stepGizmo(GizmoEventKind.MOVE, x, y) ?: return
        if (state.changed && !model.dragGizmo(drag, state.proxy)) gizmoDrag = null
    }

    /** The press on the gizmo ends: the drag's last change lands, then the gizmo stands where the selection now is. */
    private fun liftGizmo(x: Float, y: Float) {
        gizmoPressed = false
        stepGizmo(GizmoEventKind.RELEASE, x, y)
        replace = true
        val drag = gizmoDrag
        gizmoDrag = null
        if (drag != null) model.endGizmoDrag(drag) else model.refreshGizmo()
    }

    /** A mouse or pen over the view without a button: the handle under it shows it would be taken. */
    private fun hoverGizmo(x: Float, y: Float) {
        if (!gizmoPressed) stepGizmo(GizmoEventKind.HOVER, x, y)
    }

    // ---- Markers: the wipe tower's ghost and the Brim Ears tool's discs ----

    private var earsShown = false
    private var ears = BrimEarState()
    /** The wipe tower's ghost as last read, and its markers. */
    private var ghost: ProjectIntents.WipeTowerGhost? = null
    private var ghostMarkers: List<SceneMarker> = emptyList()
    /** The markers drawn now, in every scene made later too. */
    private var markers: List<SceneMarker> = emptyList()

    /** Draws [state]'s ears as the browser's discs on every instance of their object while the tool is [on]; nothing otherwise. */
    fun brimEars(on: Boolean, state: BrimEarState) {
        if (on == earsShown && state == ears) return
        earsShown = on
        ears = state
        refreshMarkers()
    }

    /** Draws the active plate's wipe tower as the browser's ghost ([WipeTowerGhosts]); none without an enabled tower. */
    fun wipeTowerGhost(next: ProjectIntents.WipeTowerGhost?) {
        if (next == ghost) return
        ghost = next
        ghostMarkers = WipeTowerGhosts.markers(next)
        refreshMarkers()
    }

    /** The markers again: the ghost, then the discs from the tool's state and the draws as they stand (an instance moved, added or removed). */
    private fun refreshMarkers() {
        val next = ghostMarkers + if (earsShown) BrimEarDiscs.markers(ears, drawn, explosionOffsets) else emptyList()
        if (next.isEmpty() && markers.isEmpty()) return
        markers = next
        scene?.setMarkers(markers)
    }

    /**
     * A tap while placing brim ears (`placeBrimEar`): the nearest part of the
     * object ears go on that the tap meets — it alone, as the browser's ray
     * meets only that object's parts — takes an ear where the tap met it; a
     * part a simplify preview draws refuses it, a tap that meets none says
     * so, and with no single object in scope nothing can be placed.
     */
    private fun placeEar(renderer: FilamentScene, x: Float, y: Float) {
        val objectId = model.brimEarState.objectId ?: return model.brimEarMissed(inScope = false)
        var nearest: FilamentScene.Pick? = null
        for ((key, draw) in draws) {
            if (draw.objectId != objectId) continue
            val hit = renderer.pick(x.toDouble(), y.toDouble(), key) ?: continue
            if (nearest == null || hit.distanceMetres < nearest.distanceMetres) nearest = hit
        }
        when (val met = met(nearest)) {
            ToolPick.Missed -> model.brimEarMissed(inScope = true)
            ToolPick.Previewed -> model.refusePreviewedPick()
            is ToolPick.Part -> met.pick.localPoint?.let { point -> model.placeBrimEarAt(objectId, met.pick.volumeId, listOf(point.x, point.y, point.z)) }
                ?: model.brimEarMissed(inScope = true)
        }
    }

    // ---- The exploded view (the Assembly tool's) ----

    private var explosion = 1.0
    /** How far each instance of the active plate is drawn from where the project places it (mm); none when assembled. */
    var explosionOffsets by mutableStateOf<Map<String, Point3>>(emptyMap())
        private set

    /** Draws the active plate's models [factor] apart ([SceneExplosion]); 1 assembles them. */
    fun explode(factor: Double) {
        if (factor == explosion) return
        explosion = factor
        redraw()
    }

    /** The draws again, exploded as the factor says, with the discs that follow their parts. */
    private fun redraw() {
        explosionOffsets = SceneExplosion.offsets(drawn, explosion)
        scene?.setDraws(substituted(SceneExplosion.exploded(drawn, explosionOffsets)))
        if (earsShown) refreshMarkers()
    }

    /** A simplify preview's meshes, by volume, drawn in their volumes' place. */
    private var previewed: Map<String, TriangleMesh> = emptyMap()

    private fun previewKey(volumeId: String) = "simplify-preview:$volumeId"

    /**
     * Draws [meshes] (by volume) in place of those volumes' own meshes, until
     * none are given. A volume shown again is uploaded afresh from its own
     * mesh, so the paint the scene shows on it goes back on it.
     */
    fun preview(meshes: Map<String, TriangleMesh>) {
        if (meshes === previewed) return
        val before = previewed
        previewed = meshes
        val renderer = scene ?: return
        before.keys.forEach { renderer.removeMesh(previewKey(it)) }
        meshes.forEach { (volumeId, mesh) -> renderer.setMesh(previewKey(volumeId), mesh) }
        renderer.setDraws(substituted(SceneExplosion.exploded(drawn, explosionOffsets)))
        val restored = before.keys - meshes.keys
        if (restored.isNotEmpty()) model.sceneSnapshot { everything ->
            if (scene === renderer) everything.paint.filter { it.volumeId in restored && it.volumeId !in previewed }.forEach(renderer::setPaint)
        }
    }

    private fun substituted(draws: List<ProjectScene.Draw>) =
        if (previewed.isEmpty()) draws else draws.map { draw -> if (draw.volumeId in previewed) draw.copy(assetId = previewKey(draw.volumeId)) else draw }

    /** Moves the camera, and the measured line with it. */
    private fun move(renderer: FilamentScene, next: OrbitCamera) {
        renderer.setCamera(next)
        camera = renderer.cameraState()
    }

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

    /** A camera view asked for before the scene existed, taken once it does. */
    private var pendingView: CameraView? = null

    /** Opens the scene's context menu for a press: set by the screen. */
    var onMenu: (SceneMenuRequest) -> Unit = {}

    /** Puts the camera on the browser's [view] of the project's bed (as soon as there is a scene). */
    fun show(view: CameraView) {
        val renderer = scene
        if (renderer == null) pendingView = view else move(renderer, CameraViews.of(view, bed.first, bed.second))
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
            camera = renderer.cameraState()
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
        camera = renderer.cameraState()
        pendingView?.let { move(renderer, CameraViews.of(it, bed.first, bed.second)) }
        pendingView = null
        renderer.setActive(true)
        renderer.select(highlighted)
        renderer.setMarkers(markers)
        previewed.forEach { (volumeId, mesh) -> renderer.setMesh(previewKey(volumeId), mesh) }
        // The first update is everything known; later ones are what changed.
        listening = model.listenScene { update -> if (scene === renderer) apply(renderer, update) }
    }

    private fun apply(renderer: FilamentScene, update: SceneSync.Update) {
        update.removed.forEach(renderer::removeMesh)
        update.meshes.forEach { (asset, mesh) -> renderer.setMesh(asset, mesh) }
        drawn = update.draws
        draws = update.draws.associateBy { it.key }
        // The exploded view follows the project: its offsets from where the instances stand now.
        explosionOffsets = SceneExplosion.offsets(drawn, explosion)
        renderer.setDraws(substituted(SceneExplosion.exploded(drawn, explosionOffsets)))
        // The discs follow their object's instances.
        if (earsShown) refreshMarkers()
        // Paint changes colour bytes alone (a previewed volume's wait for its own mesh to show again).
        update.paint.forEach(renderer::setPaint)
    }

    /** What a tool's pick met: nothing, a previewed part (refused) or a part of the project. */
    private fun met(pick: FilamentScene.Pick?): ToolPick = ToolPick.of(pick, previewed.keys)

    /** What a pick met, as the painter takes it; null without a hit on the project's mesh in the part's own frame. */
    private fun touch(pick: FilamentScene.Pick?): PaintModel.Touch? {
        val hit = (met(pick) as? ToolPick.Part)?.pick ?: return null
        val local = hit.localPoint ?: return null
        val eye = hit.localOrigin ?: return null
        val draw = draws[hit.key]
        return PaintModel.Touch(hit.key, hit.volumeId, draw?.role, hit.facet, local, eye, draw?.placement)
    }

    /** The scene's context menu at ([x], [y]), on the model under it or the plate. */
    private fun menuAt(renderer: FilamentScene, x: Float, y: Float) {
        val hit = (met(renderer.pick(x.toDouble(), y.toDouble())) as? ToolPick.Part)?.pick
        onMenu(SceneMenuRequest(x, y, hit?.instanceId))
    }

    /**
     * A tap at the event's point with no drag: Lay flat lays the facet it met
     * on the bed, Measure picks the feature and Brim Ears places an ear, each
     * owning the tap as the browser's tools do; otherwise it selects the
     * model it met, or nothing (Shift, Ctrl or Meta extending the selection).
     */
    private fun tapTool(renderer: FilamentScene, event: MotionEvent) {
        // The Brim Ears tool meets only the object ears go on, whatever lies in front of it.
        if (model.brimEaring) return placeEar(renderer, event.x, event.y)
        val hit = renderer.pick(event.x.toDouble(), event.y.toDouble())
        // A tool's facet is the project's: a tap on a simplify preview's is refused.
        val met = met(hit)
        val exact = (met as? ToolPick.Part)?.pick
        if ((model.layingFlat || model.measuring) && met == ToolPick.Previewed) {
            model.refusePreviewedPick()
        } else if (model.layingFlat) {
            // The Lay flat tool owns the tap, as the browser's does: it never selects.
            model.layFlatAt(exact?.instanceId, exact?.volumeId, exact?.facet ?: 0)
        } else if (model.measuring) {
            // So does the Measure tool: the tap picks the feature it met.
            model.measureAt(exact?.instanceId, exact?.volumeId, exact?.facet ?: 0, exact?.localPoint?.let { listOf(it.x, it.y, it.z) })
        } else {
            val extend = event.metaState and (KeyEvent.META_SHIFT_ON or KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON) != 0
            model.selectInstance(hit?.instanceId, extend)
        }
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
        var drag = ViewNavigation.Drag.ROTATE
        // A press asking for the context menu (the right button, a pen's button), and a long press that opened it.
        var context = false
        var menuShown = false
        val navigation = ViewNavigation(view, LIMITS, { scene?.cameraState() }) { next -> scene?.let { move(it, next) } }
        val longPress = Runnable {
            val renderer = scene
            if (renderer != null && !dragged && !scaling && !stroking) {
                menuShown = true
                menuAt(renderer, downX, downY)
            }
        }
        val pinch = ScaleGestureDetector(view.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                if (scene == null) return false
                navigation.pinch(detector.scaleFactor)
                return true
            }
        })
        // A wheel or a trackpad's scroll zooms, as the browser's wheel does; a hover shows the gizmo's handle under it.
        view.setOnGenericMotionListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_HOVER_MOVE) hoverGizmo(event.x, event.y)
            scene != null && navigation.scroll(event)
        }
        view.setOnTouchListener { _, event ->
            val renderer = scene ?: return@setOnTouchListener false
            val paint = model.paint
            // A touchpad's two-finger swipe zooms; it never orbits, selects or paints.
            if (navigation.swipe(event)) return@setOnTouchListener true
            pinch.onTouchEvent(event)
            if (event.pointerCount > 1) {
                scaling = true
                view.removeCallbacks(longPress)
                // A second finger zooms: the stroke in flight is dropped, as a cancelled pointer drops the browser's,
                // and a drag of the gizmo ends where it is.
                if (stroking) { paint.cancel(); stroking = false }
                if (gizmoPressed) liftGizmo(event.x, event.y)
            }
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y; lastX = downX; lastY = downY
                    dragged = false; scaling = false; stroking = false; menuShown = false
                    context = ViewNavigation.isContextPress(event)
                    drag = navigation.dragFor(event)
                    // The paint tool owns a touch (or a left press) that starts on a model; one that starts on nothing,
                    // or on a part a simplify preview draws (refused, as the browser's painter refuses it), orbits.
                    if (paint.state.active && !context && drag == ViewNavigation.Drag.ROTATE) {
                        val pick = renderer.pick(event.x.toDouble(), event.y.toDouble())
                        if (met(pick) == ToolPick.Previewed) model.refusePreviewedPick()
                        else touch(pick)?.let { stroking = paint.begin(it) }
                    }
                    // Otherwise a press (a finger, a pen, the left button) on one of the gizmo's handles drags it, whatever
                    // the tool, as the browser's TransformControls takes its own presses.
                    if (!paint.state.active && !context && drag == ViewNavigation.Drag.ROTATE) pressGizmo(event.x, event.y)
                    // A finger or pen held still opens the scene's menu, as a long press does the tree's;
                    // a mouse has its right button for that.
                    if (!stroking && !gizmoPressed && !context && !ViewNavigation.isMouse(event)) {
                        view.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                    }
                }
                MotionEvent.ACTION_MOVE -> if (stroking) {
                    // The stroke samples its own part alone, as the browser's painter intersects its display.
                    paint.painting?.let { key -> touch(renderer.pick(event.x.toDouble(), event.y.toDouble(), key))?.let(paint::move) }
                } else if (gizmoPressed) {
                    if (abs(event.x - downX) + abs(event.y - downY) > TOUCH_SLOP) dragged = true
                    dragGizmo(event.x, event.y)
                } else if (!scaling && !menuShown) {
                    if (abs(event.x - downX) + abs(event.y - downY) > TOUCH_SLOP) {
                        dragged = true
                        view.removeCallbacks(longPress)
                    }
                    if (dragged) navigation.drag(drag, event.x - lastX, event.y - lastY)
                    lastX = event.x; lastY = event.y
                }
                MotionEvent.ACTION_UP -> {
                    view.removeCallbacks(longPress)
                    if (stroking) {
                        stroking = false
                        paint.end()
                    } else if (gizmoPressed) {
                        // A tap on a handle leaves the selection be ("Don't unselect if they clicked the transform gizmo
                        // directly"); the handles show only under Move, Rotate and Scale, so no other tool's tap meets one.
                        liftGizmo(event.x, event.y)
                    } else if (menuShown) {
                        // The long press opened the menu: lifting the finger chooses nothing.
                    } else if (context) {
                        // A secondary click opens the scene's menu where it was; a drag with it panned instead.
                        if (!dragged && !scaling) menuAt(renderer, event.x, event.y)
                    } else if (!dragged && !scaling && !paint.state.active) {
                        tapTool(renderer, event)
                    }
                    view.performClick()
                }
                MotionEvent.ACTION_CANCEL -> {
                    view.removeCallbacks(longPress)
                    if (stroking) {
                        stroking = false
                        paint.cancel()
                    }
                    if (gizmoPressed) liftGizmo(event.x, event.y)
                }
            }
            true
        }
    }

    companion object {
        private const val TOUCH_SLOP = 8f
        /** The Workspace camera's bounds: short of the poles, between 5 cm and 4.5 m from its target. */
        private val LIMITS = OrbitGestures.Limits(minPitch = .05, maxPitch = 1.5, minDistance = .05, maxDistance = 4.5)
    }
}
