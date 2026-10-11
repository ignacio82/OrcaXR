package dev.orcaxr.nativeapp.workspace

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.MeasureAnnotation
import dev.orcaxr.core.MeasureHint
import dev.orcaxr.core.MeasureRowLabel
import dev.orcaxr.core.ModelToolStatus
import dev.orcaxr.core.SimplifyPreview
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.renderer.OrbitCamera
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.RenderSpace
import kotlin.math.roundToInt

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
        }
    }
}

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
