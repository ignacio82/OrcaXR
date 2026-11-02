package dev.orcaxr.nativeapp.preview

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.orcaxr.core.GcodeArtifactText
import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.exports.ExportCommands
import dev.orcaxr.nativeapp.prepare.PrepareCommands
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.send.SendWords
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import dev.orcaxr.nativeapp.theme.OrcaThemeTokens
import dev.orcaxr.nativeapp.workspace.ViewDescription
import dev.orcaxr.renderer.CameraView
import dev.orcaxr.renderer.CameraViews
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.core.WorkspaceBed
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.workspace.ViewNavigation
import dev.orcaxr.nativeapp.prepare.PrepareWords
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.renderer.GcodeMoveFilter
import dev.orcaxr.renderer.GcodePreviewPlan
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.OrbitGestures
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
 * end, as the browser's sidebar sits at the start of its viewport. The
 * toolpaths sit on the project's [bed], grown to reach them.
 *
 * Slices from Prepare can be directly inspected, downloaded, re-sliced, or
 * dispatched directly to the active Moonraker printer via [device].
 */
@Composable
fun PreviewScreen(
    model: PreviewModel,
    modifier: Modifier = Modifier,
    panelWidth: Dp? = null,
    bed: WorkspaceBed = WorkspaceBed.DEFAULT,
    project: ProjectModel? = null,
    prepare: PrepareModel? = null,
    device: DeviceModel? = null,
    onNavigateToArea: ((Int) -> Unit)? = null,
) {
    val state = model.state
    val context = LocalContext.current
    // Any document: providers often report G-code only as bytes or text.
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::open) }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { prepare?.slice() }
    val slice: () -> Unit = {
        val ask = prepare != null && Build.VERSION.SDK_INT >= 33 &&
            prepare.state.connection.endpoint.isEmpty() &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            prepare.askNotifications()
        if (ask) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            prepare?.slice()
        }
    }

    val viewData = project?.view
    val plate = viewData?.activePlate
    val revision = viewData?.revision
    val result = prepare?.state?.result
    val hasSlice = result != null || state.slice != null
    val isOutOfDate = state.withdrawn || (result != null && revision != null && result.revision != revision)
    val isConnected = device?.state?.connected == true
    val sendState = device?.sendState
    val isSending = sendState?.busy == true
    val activePrinterName = device?.state?.activeId?.let { id ->
        device.state.printers.firstOrNull { it.id == id }?.name
    } ?: stringResource(R.string.prepare_printer)

    val facts = if (prepare != null && revision != null) {
        PrepareCommands.Facts.of(
            state = prepare.state,
            activePlateId = plate?.id,
            plateObjects = plate?.objects,
            revision = revision,
            connected = isConnected,
            sending = isSending,
        )
    } else null
    val canSend = facts?.let { PrepareCommands.canSend(it) } ?: (isConnected && !isSending && !isOutOfDate && prepare?.sendable() != null)
    val canSlice = facts?.let { PrepareCommands.canSlice(it) } ?: false
    val slicingJob = prepare?.state?.job
    val runAction = LocalActionRunner.current

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
    LaunchedEffect(bed.widthMm, bed.depthMm) { renderer.bed(bed.widthMm, bed.depthMm) }
    val theme = LocalOrcaTheme.current.tokens
    SideEffect { renderer.theme(theme) }
    val label = stringResource(R.string.workspace_view)
    val described = status(state)
    val cameras = ViewDescription.cameraActions(renderer::show)

    val view = @Composable { place: Modifier ->
        Box(place) {
            AndroidView(
                factory = { ctx -> PreviewSurface(ctx).also(renderer::attach) },
                modifier = Modifier.fillMaxSize(),
                update = { surface -> ViewDescription.describe(surface, label, described, cameras) },
            )
            // Floating Quick-Action Pill over the 3D toolpath viewport
            if (hasSlice) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    shape = RoundedCornerShape(24.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
                    shadowElevation = 6.dp,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val shortSummary = state.summary?.totals ?: result?.summary
                        if (!shortSummary.isNullOrBlank()) {
                            Text(
                                text = shortSummary,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                            )
                        }
                        if (isSending) {
                            LinearProgressIndicator(modifier = Modifier.width(64.dp))
                            TextButton(
                                onClick = { device?.cancelSend() },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                            ) {
                                Text(stringResource(R.string.send_cancel), style = MaterialTheme.typography.labelSmall)
                            }
                        } else if (isOutOfDate) {
                            FilledTonalButton(
                                onClick = slice,
                                enabled = canSlice,
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.ic_symbol_update),
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp).padding(end = 4.dp),
                                )
                                Text(stringResource(R.string.preview_reslice), style = MaterialTheme.typography.labelSmall)
                            }
                        } else if (canSend) {
                            Button(
                                onClick = { device?.send(prepare?.sendable()) },
                                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.ic_symbol_send),
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp).padding(end = 4.dp),
                                )
                                Text(
                                    stringResource(R.string.send_action),
                                    style = MaterialTheme.typography.labelMedium,
                                )
                            }
                        } else if (!isConnected) {
                            FilledTonalButton(
                                onClick = {
                                    if (device?.state?.activeId != null) device.connect()
                                    else onNavigateToArea?.invoke(R.string.nav_device)
                                },
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                            ) {
                                Text(
                                    stringResource(R.string.preview_connect_printer),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    val controls = @Composable { place: Modifier ->
        Column(
            place.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Dedicated Slice & Print Card when a slice is present
            if (hasSlice) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.weight(1f, fill = false),
                            ) {
                                Icon(
                                    painter = painterResource(R.drawable.ic_symbol_layers),
                                    contentDescription = null,
                                    modifier = Modifier.size(20.dp),
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                                Text(
                                    text = result?.plateName?.ifEmpty { null } ?: plate?.name ?: result?.name ?: stringResource(R.string.preview_heading),
                                    style = MaterialTheme.typography.titleMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (isOutOfDate) {
                                Surface(
                                    color = MaterialTheme.colorScheme.errorContainer,
                                    shape = RoundedCornerShape(8.dp),
                                ) {
                                    Text(
                                        text = stringResource(R.string.preview_modified_warning),
                                        color = MaterialTheme.colorScheme.onErrorContainer,
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                    )
                                }
                            } else if (canSend) {
                                Surface(
                                    color = MaterialTheme.colorScheme.primaryContainer,
                                    shape = RoundedCornerShape(8.dp),
                                ) {
                                    Text(
                                        text = stringResource(R.string.preview_ready_to_print),
                                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                    )
                                }
                            }
                        }

                        val totalsText = state.summary?.totals ?: result?.summary
                        if (!totalsText.isNullOrBlank()) {
                            Text(
                                text = totalsText,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }

                        if (slicingJob != null) {
                            val percent = slicingJob.percent
                            if (percent != null) {
                                LinearProgressIndicator(
                                    progress = { (percent / 100).toFloat().coerceIn(0f, 1f) },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            } else {
                                LinearProgressIndicator(Modifier.fillMaxWidth())
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = PrepareWords.progress(slicingJob.message),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                TextButton(onClick = { prepare.cancel() }) {
                                    Text(stringResource(R.string.prepare_cancel))
                                }
                            }
                        }

                        if (isSending || sendState?.status != null) {
                            val statusText = sendState?.status.orEmpty()
                            if (isSending) {
                                LinearProgressIndicator(Modifier.fillMaxWidth())
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = statusText,
                                    modifier = Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (isSending) {
                                    TextButton(onClick = { device.cancelSend() }) {
                                        Text(stringResource(R.string.send_cancel))
                                    }
                                } else {
                                    TextButton(onClick = { device.dismissSend() }) {
                                        Text(stringResource(R.string.device_dismiss))
                                    }
                                }
                            }
                        }

                        if (isOutOfDate) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Button(
                                    onClick = slice,
                                    enabled = canSlice,
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.ic_symbol_update),
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp).padding(end = 6.dp),
                                    )
                                    Text(stringResource(R.string.preview_reslice))
                                }
                                OutlinedButton(
                                    onClick = { onNavigateToArea?.invoke(R.string.nav_prepare) },
                                ) {
                                    Text(stringResource(R.string.preview_back_to_prepare))
                                }
                            }
                        } else {
                            if (canSend) {
                                Button(
                                    onClick = { device?.send(prepare?.sendable()) },
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = RoundedCornerShape(10.dp),
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.ic_symbol_send),
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp).padding(end = 6.dp),
                                    )
                                    Text(
                                        if (isConnected) "Send to $activePrinterName" else stringResource(R.string.send_action),
                                        style = MaterialTheme.typography.labelLarge,
                                    )
                                }
                            } else if (!isConnected && !isSending) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Button(
                                        onClick = {
                                            if (device?.state?.activeId != null) device.connect()
                                            else onNavigateToArea?.invoke(R.string.nav_device)
                                        },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(
                                            painter = painterResource(R.drawable.ic_symbol_send),
                                            contentDescription = null,
                                            modifier = Modifier.size(18.dp).padding(end = 6.dp),
                                        )
                                        Text(stringResource(R.string.preview_connect_printer))
                                    }
                                    OutlinedButton(
                                        onClick = { onNavigateToArea?.invoke(R.string.nav_device) },
                                    ) {
                                        Text(stringResource(R.string.nav_device))
                                    }
                                }
                                Text(
                                    text = SendWords.CONNECT_FIRST,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                OutlinedButton(
                                    onClick = { runAction(ExportCommands.DOWNLOAD) },
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.ic_symbol_download),
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp).padding(end = 6.dp),
                                    )
                                    Text(stringResource(R.string.export_download))
                                }
                                OutlinedButton(
                                    onClick = { onNavigateToArea?.invoke(R.string.nav_prepare) },
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(
                                        painter = painterResource(R.drawable.ic_symbol_tune),
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp).padding(end = 6.dp),
                                    )
                                    Text(stringResource(R.string.preview_back_to_prepare))
                                }
                            }
                        }
                    }
                }
            } else {
                Text(stringResource(R.string.preview_heading), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(onClick = { open.launch(arrayOf("*/*")) }, enabled = !state.loading, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.preview_open))
                    }
                    if (onNavigateToArea != null) {
                        Button(onClick = { onNavigateToArea(R.string.nav_prepare) }) {
                            Text(stringResource(R.string.nav_prepare))
                        }
                    }
                }
                Text(status(state), style = MaterialTheme.typography.bodySmall)
            }

            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())

            if (hasSlice) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(status(state), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { open.launch(arrayOf("*/*")) }, enabled = !state.loading) {
                        Text(stringResource(R.string.preview_open), style = MaterialTheme.typography.labelSmall)
                    }
                }
            }

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
            LayerControls(state, bounds, model, project)
            MoveFilters(state, model)
            if (state.ticks.isNotEmpty()) {
                TicksSection(state.ticks, state.layerRange?.second ?: bounds.second, model::jumpToLayer)
            }
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

/** "Top layer" and "Bottom layer" sliders over the whole print, "Single layer", layer events, and Previous/Next moves when windowed. */
@Composable
private fun LayerControls(state: PreviewState, bounds: Pair<Int, Int>, model: PreviewModel, project: ProjectModel? = null) {
    val (low, high) = state.layerRange ?: bounds
    LayerSlider(stringResource(R.string.preview_top_layer), high, bounds, state.topZMm, !state.loading, model::setTopLayer)
    LayerSlider(stringResource(R.string.preview_bottom_layer), low, bounds, state.bottomZMm, !state.loading, model::setBottomLayer)
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        LabelledCheckbox(stringResource(R.string.preview_single_layer), state.singleLayer, !state.loading, model::setSingleLayer)
        if (state.singleLayer || low != bounds.first || high != bounds.second) {
            TextButton(
                onClick = {
                    if (state.singleLayer) model.setSingleLayer(false)
                    model.setBottomLayer(bounds.first)
                    model.setTopLayer(bounds.second)
                },
                enabled = !state.loading,
            ) {
                Text(stringResource(R.string.preview_reset_layers), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
    val topZ = state.topZMm
    if (project != null && topZ != null) {
        LayerEventsSection(project, topZ)
    }
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

/** Layer events at the currently inspected height [topZMm]. */
@Composable
private fun LayerEventsSection(project: ProjectModel, topZMm: Double) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.preview_layer_events), style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    project.addLayerEvent(
                        dev.orcaxr.core.ProjectIntents.LayerEventType.Pause,
                        topZMm,
                    )
                },
                enabled = !project.busy,
            ) {
                Text(stringResource(R.string.preview_add_pause))
            }
            OutlinedButton(
                onClick = {
                    project.addLayerEvent(
                        dev.orcaxr.core.ProjectIntents.LayerEventType.Custom,
                        topZMm,
                        code = String.format(Locale.ROOT, "M117 layer at %.2f mm", topZMm),
                    )
                },
                enabled = !project.busy,
            ) {
                Text(stringResource(R.string.preview_add_custom_gcode))
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

/** Events the artifact contains, located by layer and height (the browser panel's `renderTicks`). */
@Composable
private fun TicksSection(
    ticks: List<PreviewTick>,
    currentLayer: Int,
    onSelectLayer: (Int) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val heading = if (ticks.size == 1) {
                stringResource(R.string.preview_ticks_heading_single)
            } else {
                stringResource(R.string.preview_ticks_heading, ticks.size)
            }
            Text(heading, style = MaterialTheme.typography.titleSmall)
            Column(
                Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (tick in ticks) {
                    val active = currentLayer == tick.layer
                    OutlinedButton(
                        onClick = { onSelectLayer(tick.layer) },
                        modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary),
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "${tick.label} — layer ${tick.layer}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                String.format(Locale.ROOT, "%.2f mm", tick.zMm),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
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
    /** The project's bed (mm), drawable sides. */
    private var projectBed = 200.0 to 200.0
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
        renderer.setBedColors(
            tokens.plate.gridMajor.toInt(),
            tokens.plate.gridMinor.toInt(),
            tokens.plate.origin.toInt(),
            tokens.plate.fill.toInt(),
        )
    }

    /** Puts the camera on the browser's [view] of the bed drawn under the toolpaths. */
    fun show(view: CameraView) {
        val (width, depth) = bed ?: projectBed
        scene?.setCamera(CameraViews.of(view, width, depth))
    }

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

    /** Draws the toolpaths on a bed of [widthMm] × [depthMm] (the project's), grown to reach them. */
    fun bed(widthMm: Double, depthMm: Double) {
        projectBed = PreviewFraming.drawable(widthMm) to PreviewFraming.drawable(depthMm)
        scene?.let(::present)
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
        theme?.let { dress(renderer, it) }
        renderer.setActive(true)
        present(renderer)
        // The same file as before the pause: the viewer's orbit, not a fresh frame.
        camera?.takeIf { framed == generation }?.let(renderer::setCamera)
    }

    private fun present(renderer: FilamentScene) {
        val framing = PreviewFraming.of(toolpath, projectBed.first, projectBed.second)
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

    /**
     * The browser's OrbitControls over the toolpaths ([ViewNavigation]): a drag
     * orbits, two fingers pinch to zoom, a mouse's right button pans and its
     * middle button zooms, a wheel, a trackpad's scroll or a touchpad's
     * two-finger swipe zooms.
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun installTouch(view: PreviewSurface) {
        var downX = 0f
        var downY = 0f
        var lastX = 0f
        var lastY = 0f
        var dragged = false
        var scaling = false
        var drag = ViewNavigation.Drag.ROTATE
        val navigation = ViewNavigation(view, LIMITS, { scene?.cameraState() }) { next -> scene?.setCamera(next) }
        val pinch = ScaleGestureDetector(view.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                if (scene == null) return false
                navigation.pinch(detector.scaleFactor)
                return true
            }
        })
        view.setOnGenericMotionListener { _, event -> scene != null && navigation.scroll(event) }
        view.setOnTouchListener { _, event ->
            if (scene == null) return@setOnTouchListener false
            if (navigation.swipe(event)) return@setOnTouchListener true
            pinch.onTouchEvent(event)
            if (event.pointerCount > 1) scaling = true
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y; lastX = downX; lastY = downY
                    dragged = false; scaling = false
                    drag = navigation.dragFor(event)
                }
                MotionEvent.ACTION_MOVE -> if (!scaling) {
                    if (abs(event.x - downX) + abs(event.y - downY) > TOUCH_SLOP) dragged = true
                    if (dragged) navigation.drag(drag, event.x - lastX, event.y - lastY)
                    lastX = event.x; lastY = event.y
                }
                MotionEvent.ACTION_UP -> view.performClick()
            }
            true
        }
    }

    companion object {
        private const val TOUCH_SLOP = 8f
        /**
         * The toolpath camera's bounds: short of the poles, and between 3 cm (the
         * closest a camera can be; it zoomed to 1 cm before, which the camera refuses)
         * and 4.5 m from its target.
         */
        private val LIMITS = OrbitGestures.Limits(minPitch = .05, maxPitch = 1.5, minDistance = .03, maxDistance = 4.5)
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
