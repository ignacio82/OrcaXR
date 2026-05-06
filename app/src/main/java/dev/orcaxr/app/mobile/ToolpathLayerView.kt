package dev.orcaxr.app.mobile

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.ExtrusionRole
import dev.orcaxr.app.ExtrusionSegment
import dev.orcaxr.app.ParsedToolpath
import dev.orcaxr.app.RoleColors
import kotlin.math.max
import kotlin.math.min

/**
 * 2D layer scrubber for a parsed G-code toolpath. Renders one layer at
 * a time with extrusion role coloring (matches RoleColors palette so
 * the visual language is consistent with XR's GLB toolpath). User drags
 * the slider to pick a layer; up/down ticks are bound to discrete
 * `parsed.layerZs` indices, not continuous Z mm.
 *
 * The view is intentionally cheap: O(segments-on-current-layer) per
 * frame, which on a typical 200-layer print is a few hundred segments
 * → far below 16 ms. No GPU, no GLB, no XR coupling.
 */
@Composable
fun ToolpathLayerView(
    parsed: ParsedToolpath,
    showTravels: Boolean = false,
    modifier: Modifier = Modifier,
) {
    if (parsed.layerZs.isEmpty()) {
        Box(
            modifier
                .fillMaxWidth()
                .height(220.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(16.dp)),
            contentAlignment = androidx.compose.ui.Alignment.Center,
        ) {
            Text(
                "Toolpath has no layers",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    var layerIdx by remember(parsed.layerZs.size) { mutableStateOf(parsed.layerZs.size - 1) }

    // Pre-bucket segments by their layer index. O(segments) one-shot
    // per parsed-toolpath identity — saves per-scrub re-binarySearch on
    // every segment.
    val segmentsByLayer = remember(parsed) {
        val zToIdx = HashMap<Float, Int>(parsed.layerZs.size * 2).also { m ->
            parsed.layerZs.forEachIndexed { i, z -> m[z] = i }
        }
        val out = Array(parsed.layerZs.size) { mutableListOf<ExtrusionSegment>() }
        for (s in parsed.segments) {
            val li = zToIdx[s.z] ?: parsed.layerZs.binarySearch(s.z).let { if (it < 0) -it - 2 else it }
            if (li in 0 until out.size) out[li].add(s)
        }
        out.map { it.toList() }
    }

    val activeSegments = segmentsByLayer.getOrNull(layerIdx).orEmpty()
    val bbox = remember(parsed) {
        val xs = parsed.segments.flatMap { listOf(it.start.x, it.end.x) }
        val ys = parsed.segments.flatMap { listOf(it.start.y, it.end.y) }
        if (xs.isEmpty()) ToolpathBbox(0f, 0f, 1f, 1f)
        else ToolpathBbox(xs.min(), ys.min(), xs.max(), ys.max())
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(
                "Layer ${layerIdx + 1} / ${parsed.layerZs.size}",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "z = %.2f mm".format(parsed.layerZs[layerIdx]),
                style = LocalMobileTextStyles.current.numeric,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "${activeSegments.size} segs",
                style = LocalMobileTextStyles.current.numeric,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp)),
        ) {
            Canvas(Modifier.fillMaxSize().padding(16.dp)) {
                if (activeSegments.isEmpty()) return@Canvas
                val w = size.width
                val h = size.height
                val bedW = max(bbox.maxX - bbox.minX, 1f)
                val bedH = max(bbox.maxY - bbox.minY, 1f)
                val scale = min(w / bedW, h / bedH)
                val drawW = bedW * scale
                val drawH = bedH * scale
                val ox = (w - drawW) / 2f
                val oy = (h - drawH) / 2f
                fun mapX(x: Float) = ox + (x - bbox.minX) * scale
                // Flip Y so +Y points up in the rendered image (printer
                // bed convention) — Canvas Y is screen-down by default.
                fun mapY(y: Float) = oy + drawH - (y - bbox.minY) * scale

                if (showTravels) {
                    val travelColor = Color(0x66B0BAC9)
                    for (t in parsed.travels) {
                        if (t.z != parsed.layerZs[layerIdx]) continue
                        drawLine(
                            color = travelColor,
                            start = Offset(mapX(t.start.x), mapY(t.start.y)),
                            end = Offset(mapX(t.end.x), mapY(t.end.y)),
                            strokeWidth = 1.0f,
                            cap = StrokeCap.Round,
                        )
                    }
                }
                for (s in activeSegments) {
                    val rgb = RoleColors.colorFor(s.role)
                    drawLine(
                        color = Color(rgb.r, rgb.g, rgb.b, 1f),
                        start = Offset(mapX(s.start.x), mapY(s.start.y)),
                        end = Offset(mapX(s.end.x), mapY(s.end.y)),
                        strokeWidth = 2.5f,
                        cap = StrokeCap.Round,
                    )
                }
            }
        }
        Slider(
            value = layerIdx.toFloat(),
            onValueChange = { layerIdx = it.toInt().coerceIn(0, parsed.layerZs.size - 1) },
            valueRange = 0f..(parsed.layerZs.size - 1).toFloat().coerceAtLeast(0f),
            steps = (parsed.layerZs.size - 2).coerceAtLeast(0),
        )
    }
}

private data class ToolpathBbox(val minX: Float, val minY: Float, val maxX: Float, val maxY: Float)

/**
 * Roles-legend chip row — small swatch + label per active role.
 * Used under [ToolpathLayerView] so the user can decode the colors.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ToolpathRolesLegend(roles: Set<ExtrusionRole>, modifier: Modifier = Modifier) {
    val ordered = ExtrusionRole.entries.filter { it in roles && it != ExtrusionRole.Unknown }
    if (ordered.isEmpty()) return
    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (r in ordered) {
            val rgb = RoleColors.colorFor(r)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(10.dp)
                        .background(Color(rgb.r, rgb.g, rgb.b, 1f), RoundedCornerShape(2.dp)),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    r.tag,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
