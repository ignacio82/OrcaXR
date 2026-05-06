package dev.orcaxr.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mcp.WorkspaceAction

/**
 * Roadmap A10 — SpatialPanel for the variable / adaptive layer height
 * feature. JNI + MCP have shipped; this is the in-XR authoring UI.
 *
 * Layout mirrors `CustomGcodePanel`:
 *   - Header (title + close).
 *   - Brief explainer (1 line).
 *   - Per-model context line (label + current profile state).
 *   - Quality slider (0..1, default 0.5) — higher quality = finer
 *     layers over curved surfaces, coarser over vertical walls.
 *   - Smoothing radius slider (0..10) — 0 disables smoothing.
 *   - Keep-min checkbox — preserves the min-h spikes through the
 *     smoothing pass when on.
 *   - Compute button (emits [WorkspaceAction.ComputeAdaptiveLayerHeights]).
 *   - Clear-profile button (emits [WorkspaceAction.SetLayerHeightProfile]
 *     with profile=null).
 *   - Per-Z bar visualization of the current profile (when set).
 *
 * Stateless wrt persistence — the model's own `layerHeightProfile`
 * stored on `PlacedModel` (and round-tripped through 3MF via
 * `nativeSlice`/`nativeSliceMulti`) is the source of truth.
 */
@Composable
fun AdaptiveLayerPanel(
    /** The currently-selected `PlacedModel`, or null when nothing is
     *  selected (Compute is disabled in that case). */
    selected: PlacedModel?,
    onCompute: (modelId: String, quality: Float, smoothingRadius: Int, smoothingKeepMin: Boolean) -> Unit,
    onClear: (modelId: String) -> Unit,
    onClose: () -> Unit,
) {
    var quality by remember { mutableFloatStateOf(0.5f) }
    var smoothingRadius by remember { mutableIntStateOf(0) }
    var keepMin by remember { mutableStateOf(false) }

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Adaptive layer height",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                    )
                    Text(
                        when {
                            selected == null -> "No model selected. Pick a part on the bed first."
                            selected.layerHeightProfile == null -> "${selected.label} · no profile yet"
                            else -> "${selected.label} · ${selected.layerHeightProfile!!.size / 2} (z, h) pairs"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB6BEC8),
                    )
                }
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleMedium)
                }
            }

            Text(
                "Compute a per-Z layer-height profile that goes finer over curved surfaces " +
                    "and coarser over vertical walls. Bounds come from the active profile " +
                    "(min/max layer height). Round-trips through save_project_3mf.",
                color = Color(0xFF8E97A2),
                style = MaterialTheme.typography.labelSmall,
            )

            // Quality slider — 0..1, default 0.5.
            ParamSlider(
                label = "Quality",
                helper = "Higher = finer over curves, slower slice. " +
                    "Lower = closer to a flat fixed-height profile.",
                value = quality,
                valueRange = 0f..1f,
                steps = 19, // 0.05 increments
                onValueChange = { quality = it },
                valueLabel = "%.2f".format(quality),
            )

            // Smoothing radius — 0..10, default 0.
            ParamSlider(
                label = "Smoothing radius",
                helper = "Layer count to smooth over after compute. 0 disables.",
                value = smoothingRadius.toFloat(),
                valueRange = 0f..10f,
                steps = 9,
                onValueChange = { smoothingRadius = it.toInt() },
                valueLabel = "$smoothingRadius",
            )

            Surface(
                color = Color(0xFF1B1F23),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked = keepMin, onCheckedChange = { keepMin = it })
                    Spacer(Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            "Keep min-h spikes through smoothing",
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "Off = average naturally. On = preserve fine bands smoothing would erase.",
                            color = Color(0xFF8E97A2),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }

            // Action buttons.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    enabled = selected != null,
                    onClick = {
                        val sel = selected ?: return@Button
                        onCompute(sel.id, quality, smoothingRadius, keepMin)
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF2A8B6E),
                        contentColor = Color.White,
                    ),
                ) {
                    Text("Compute profile")
                }
                OutlinedButton(
                    enabled = selected?.layerHeightProfile != null,
                    onClick = {
                        val sel = selected ?: return@OutlinedButton
                        onClear(sel.id)
                    },
                ) {
                    Text(
                        "Clear profile",
                        color = if (selected?.layerHeightProfile != null) Color.White else Color(0xFF555B62),
                    )
                }
            }

            // Per-Z bar visualization of the current profile.
            val profile = selected?.layerHeightProfile
            if (profile != null && profile.size >= 4) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "Current profile",
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                LayerHeightBarChart(profile)
            }
        }
    }
}

@Composable
private fun ParamSlider(
    label: String,
    helper: String,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int,
    onValueChange: (Float) -> Unit,
    valueLabel: String,
) {
    Surface(
        color = Color(0xFF1B1F23),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(label, color = Color.White, style = MaterialTheme.typography.bodyMedium)
                Text(valueLabel, color = Color(0xFF80E0C8), style = MaterialTheme.typography.bodyMedium)
            }
            Slider(
                value = value,
                onValueChange = onValueChange,
                valueRange = valueRange,
                steps = steps,
            )
            Text(
                helper,
                color = Color(0xFF8E97A2),
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

/**
 * Render the (z, h) pairs as a vertical strip of horizontal bars
 * — one bar per layer band, width proportional to that band's
 * layer height. Cheap visualization that doesn't need a chart
 * library; reads as a vertical "thickness profile" at a glance.
 *
 * Profile is laid out as `[z0, h0, z1, h1, ...]`. Two consecutive
 * pairs `(z[i], h[i])` and `(z[i+1], h[i+1])` define a band from z[i]
 * to z[i+1] at height h[i]. Bands are rendered top-down (highest Z
 * first) so the chart reads like the printed model.
 */
@Composable
private fun LayerHeightBarChart(profile: FloatArray) {
    if (profile.size < 4) return
    val pairs = (profile.indices step 2).map { i ->
        val z = profile.getOrElse(i) { 0f }
        val h = profile.getOrElse(i + 1) { 0f }
        z to h
    }
    val maxH = (pairs.maxOfOrNull { it.second } ?: 0.3f).coerceAtLeast(0.04f)
    val totalZ = (pairs.maxOfOrNull { it.first } ?: 1f).coerceAtLeast(1f)

    Surface(
        color = Color(0xFF1B1F23),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                "Z 0..%.1f mm · h %.2f..%.2f mm".format(
                    totalZ,
                    pairs.minOf { it.second },
                    pairs.maxOf { it.second },
                ),
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.labelSmall,
            )
            // Render bands top-down. Cap the rendered count so a
            // 200-pair profile doesn't make the panel scroll forever.
            val rendered = pairs.takeLast(40).reversed()
            for ((z, h) in rendered) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "%.1f".format(z),
                        color = Color(0xFF8E97A2),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.width(36.dp),
                    )
                    val frac = (h / maxH).coerceIn(0.05f, 1f)
                    Box(
                        modifier = Modifier
                            .height(8.dp)
                            .fillMaxWidth(frac)
                            .background(
                                color = Color(0xFF80E0C8),
                                shape = RoundedCornerShape(2.dp),
                            ),
                    )
                    Text(
                        " %.3f mm".format(h),
                        color = Color(0xFF80E0C8),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
}
