package dev.orcaxr.nativeapp.workspace

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.AssemblyHint
import dev.orcaxr.core.AssemblyKind
import dev.orcaxr.core.AssemblyView
import dev.orcaxr.core.MeasureAnnotation
import dev.orcaxr.core.MeasureHint
import dev.orcaxr.core.MeasureRowLabel
import dev.orcaxr.core.ModelToolStatus
import dev.orcaxr.core.ProjectAssemblies
import dev.orcaxr.core.ProjectMeasures
import dev.orcaxr.core.SimplifyPreview
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectEditing
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.RenderSpace
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The measured line as the exploded view draws its parts: each end moved
 * with the part it was picked on ([offsets], by instance, in millimetres), as
 * the browser shifts its annotation; assembled, it is where it was measured.
 */
internal fun explodedAnnotation(annotation: MeasureAnnotation, firstInstance: String, secondInstance: String, offsets: Map<String, Point3>): MeasureAnnotation {
    fun moved(point: List<Double>, instance: String) = offsets[instance]?.let { listOf(point[0] + it.x, point[1] + it.y, point[2] + it.z) } ?: point
    return annotation.copy(from = moved(annotation.from, firstInstance), to = moved(annotation.to, secondInstance))
}

/** Where the measured line meets the screen: its two ends projected through [camera] into a [size] view, or null when either is behind it. */
internal fun measureLine(annotation: MeasureAnnotation, camera: OrbitCamera, size: IntSize): Pair<Offset, Offset>? {
    if (size.width <= 0 || size.height <= 0) return null
    fun end(mm: List<Double>) = camera.project(RenderSpace.point(Point3(mm[0], mm[1], mm[2])), size.width, size.height)
        ?.let { (x, y) -> Offset(x.toFloat(), y.toFloat()) }
    return (end(annotation.from) ?: return null) to (end(annotation.to) ?: return null)
}

/**
 * The measurement drawn on the model, as the browser's workspace draws it
 * (`drawMeasureAnnotation`): a line between the two points the core measured
 * between — over the model, so a dimension inside the geometry stays
 * readable — and the distance beside its middle.
 */
@Composable
internal fun MeasureAnnotationOverlay(annotation: MeasureAnnotation, camera: OrbitCamera?, size: IntSize) {
    val line = camera?.let { measureLine(annotation, it, size) } ?: return
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            drawLine(MEASURE_LINE, line.first, line.second, strokeWidth = 2.dp.toPx())
        }
        val middle = Offset((line.first.x + line.second.x) / 2, (line.first.y + line.second.y) / 2)
        Surface(
            color = MaterialTheme.colorScheme.surface.copy(alpha = .85f),
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.layout { measurable, constraints ->
                val placeable = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
                layout(placeable.width, placeable.height) {
                    placeable.place(IntOffset((middle.x - placeable.width / 2f).roundToInt(), (middle.y - placeable.height / 2f).roundToInt()))
                }
            },
        ) {
            Text(annotation.label, Modifier.padding(horizontal = 4.dp), style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** The browser's annotation colour (`0xffc107`). */
private val MEASURE_LINE = Color(0xffffc107)

/**
 * The browser's Measure panel (web/src/ui/dom/MeasurePanel.ts) while the
 * tool is on: the workspace's status, what to do next, the picked features,
 * the readout — distance (to the bounded features, or their line or
 * plane), its X/Y/Z parts, the angle and every circle's diameter, written to
 * three decimals as the browser writes them —, Clear and Done.
 */
@Composable
internal fun MeasureCard(model: ProjectModel, modifier: Modifier = Modifier) {
    val readout = model.measureReadout
    // A share of the window's height, as the paint panel bounds itself (unbounded until the window is measured).
    val tall = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    val bounded = if (tall > 0.dp) Modifier.heightIn(max = tall * PANEL_SHARE) else Modifier
    Card(modifier.padding(16.dp)) {
        Column(
            bounded.verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.project_measure), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                TextButton(onClick = model::clearMeasure) { Text(stringResource(R.string.measure_clear)) }
                TextButton(onClick = { model.measure(false) }) { Text(stringResource(R.string.workspace_lay_flat_done)) }
            }
            model.measureStatus?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium) }
            Text(
                stringResource(
                    when (readout?.hint ?: MeasureHint.FIRST) {
                        MeasureHint.FIRST -> R.string.measure_first
                        MeasureHint.SECOND -> R.string.measure_second
                        MeasureHint.NEXT -> R.string.measure_next
                        MeasureHint.CHOOSE_TOOL -> R.string.measure_choose
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
            )
            if (readout != null && readout.picks.isNotEmpty()) {
                val picked = stringResource(R.string.measure_picked_features)
                Column(Modifier.semantics { contentDescription = picked }) {
                    readout.picks.forEachIndexed { index, pick -> Text("${index + 1}. ${pick.summary}", style = MaterialTheme.typography.bodyMedium) }
                }
            }
            readout?.rows?.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        stringResource(
                            when (row.label) {
                                MeasureRowLabel.DISTANCE -> R.string.measure_distance
                                MeasureRowLabel.DISTANCE_INFINITE -> R.string.measure_distance_infinite
                                MeasureRowLabel.XYZ -> R.string.measure_xyz
                                MeasureRowLabel.ANGLE -> R.string.measure_angle
                                MeasureRowLabel.DIAMETER -> R.string.measure_diameter
                            },
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(row.value, style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (readout?.unsupported == true) Text(stringResource(R.string.measure_unsupported), style = MaterialTheme.typography.bodySmall)
            model.assemblyView?.let { AssemblySection(model, it) }
            if (model.assembling && ProjectEditing.enabled(model.view, "assembly_explode")) ExplodeSection(model)
        }
    }
}

/**
 * The Measure panel's Align section (the browser's `renderAssembly`), once
 * two features are picked: what to do — choose an alignment, or pick faces
 * on two models — and every alignment the core plans for the pair, each
 * enabled as the pair allows and only when the second pick's model can move:
 * Parallel, Centre coincidence, Flip over (about the second face), Set gap
 * with the Gap (mm) field (starting at the measured gap) and Turn about
 * centre with the Turn (°) field. Each moves the second model as one
 * undoable step; the fields hand over what was typed as a number input does.
 */
@Composable
private fun AssemblySection(model: ProjectModel, view: AssemblyView) {
    val available = view.available
    val enabled = view.movable && !model.busy
    val ring = MaterialTheme.colorScheme.primary
    Text(stringResource(R.string.assembly_align_heading), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    Text(
        stringResource(
            when (view.hint) {
                AssemblyHint.PICK -> R.string.assembly_hint_pick
                AssemblyHint.CHOOSE -> R.string.assembly_hint_choose
                AssemblyHint.DIFFERENT_MODELS -> R.string.assembly_hint_different
            },
        ),
        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodySmall,
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((kind, words, allowed) in listOf(
            Triple(AssemblyKind.PARALLEL, R.string.assembly_parallel, available?.canSetToParallel == true),
            Triple(AssemblyKind.CENTER_COINCIDENCE, R.string.assembly_center, available?.canSetToCenterCoincidence == true),
            Triple(AssemblyKind.REVERSE_ROTATION, R.string.assembly_flip, available?.canReverseFeature2 == true),
        )) {
            OutlinedButton(onClick = { model.align(kind) }, enabled = enabled && allowed, modifier = Modifier.focusRing(ring)) { Text(stringResource(words)) }
        }
    }
    val gap = ProjectMeasures.format(available?.parallelDistanceMm ?: 0.0)
    AlignField(stringResource(R.string.assembly_gap), gap, stringResource(R.string.assembly_set_gap), enabled && available?.hasParallelDistance == true) {
        model.align(AssemblyKind.PARALLEL_DISTANCE, it)
    }
    AlignField(stringResource(R.string.assembly_turn), "90", stringResource(R.string.assembly_turn_apply), enabled && available?.canRotateAroundFaceCenter == true) {
        model.align(AssemblyKind.AROUND_FACE_CENTER, it)
    }
}

/** One of the Align section's number fields, starting at [initial], and the button that aligns with what it holds. */
@Composable
private fun AlignField(label: String, initial: String, action: String, enabled: Boolean, apply: (Double) -> Unit) {
    var typed by remember(initial) { mutableStateOf(initial) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            label = { Text(label) },
            singleLine = true,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.weight(1f).semantics { contentDescription = label },
        )
        OutlinedButton(onClick = { apply(HtmlNumberInput.value(typed)) }, enabled = enabled, modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary)) {
            Text(action)
        }
    }
}

/**
 * Explode the assembly (`assembly_explode`): how far apart the Workspace
 * draws the plate's models, from 1 (assembled) to 3, as upstream's assemble
 * view slides it — the view alone; the project never moves.
 */
@Composable
private fun ExplodeSection(model: ProjectModel) {
    val label = stringResource(R.string.assembly_explode)
    val factor = model.explosionFactor
    val shown = ProjectMeasures.format(factor)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(shown, style = MaterialTheme.typography.bodyMedium)
    }
    Slider(
        value = factor.toFloat(),
        // Continuous, as upstream's slider; the factor kept to a twentieth.
        onValueChange = { model.explode(EXPLOSION_STEP * kotlin.math.round(it / EXPLOSION_STEP)) },
        valueRange = 1f..ProjectAssemblies.MAX_EXPLOSION.toFloat(),
        modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary)
            .semantics { contentDescription = label; stateDescription = shown },
    )
}

/** The explosion slider's step: a twentieth of the factor. */
private const val EXPLOSION_STEP = 0.05

/**
 * A simplify preview shown in the Workspace: the decimated parts are drawn in
 * place of the model's, with the browser's status and the Simplify panel's
 * Apply and Cancel, so the result can be judged and kept where it is seen.
 */
@Composable
internal fun SimplifyCard(model: ProjectModel, preview: SimplifyPreview, modifier: Modifier = Modifier) {
    Card(modifier.padding(16.dp)) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)) {
            Text(
                ModelToolStatus.previewing(preview.parts.size, preview.beforeTriangles, preview.afterTriangles, preview.stoppedOnError),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodyMedium,
            )
            Row {
                TextButton(onClick = model::applySimplify, enabled = !model.busy) { Text(stringResource(R.string.simplify_apply)) }
                TextButton(onClick = model::cancelSimplify, enabled = !model.busy) { Text(stringResource(R.string.device_cancel)) }
            }
        }
    }
}

/**
 * The browser's Variable Layer Height panel while the tool is on: Adaptive
 * quality factor slider and button, Smooth radius slider and button, Reset,
 * status message, and Done.
 */
@Composable
internal fun VariableLayerHeightCard(model: ProjectModel, modifier: Modifier = Modifier) {
    Card(modifier.padding(16.dp)) {
        Column(
            Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.workspace_variable_layer_height),
                    Modifier.weight(1f).semantics { heading() },
                    style = MaterialTheme.typography.titleSmall,
                )
                TextButton(onClick = { model.variableLayerHeight(false) }) {
                    Text(stringResource(R.string.workspace_lay_flat_done))
                }
            }
            model.vlhStatus?.let {
                Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium)
            }

            // Adaptive section: Quality/Speed slider + Adaptive button
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.vlh_quality), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                Text(String.format(Locale.US, "%.2f", model.vlhQuality), style = MaterialTheme.typography.bodySmall)
            }
            Slider(
                value = model.vlhQuality,
                onValueChange = { model.vlhQuality = it },
                valueRange = 0f..1f,
                modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = model::applyAdaptiveLayerHeight,
                    enabled = !model.busy,
                    modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary),
                ) {
                    Text(stringResource(R.string.vlh_adaptive))
                }
                OutlinedButton(
                    onClick = model::applyResetLayerHeight,
                    enabled = !model.busy,
                    modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary),
                ) {
                    Text(stringResource(R.string.vlh_reset))
                }
            }

            // Smooth section: Radius slider + Smooth button
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.vlh_radius), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                Text(String.format(Locale.US, "%.1f", model.vlhRadius), style = MaterialTheme.typography.bodySmall)
            }
            Slider(
                value = model.vlhRadius,
                onValueChange = { model.vlhRadius = it },
                valueRange = 1f..10f,
                modifier = Modifier.fillMaxWidth().focusRing(MaterialTheme.colorScheme.primary),
            )
            OutlinedButton(
                onClick = model::applySmoothLayerHeight,
                enabled = !model.busy,
                modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary),
            ) {
                Text(stringResource(R.string.vlh_smooth))
            }
        }
    }
}
