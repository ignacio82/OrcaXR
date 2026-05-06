package dev.orcaxr.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mcp.WorkspaceAction
import kotlin.math.max
import kotlin.math.pow

/**
 * Roadmap D17 — SpatialPanel for the mesh-simplify (quadric edge
 * collapse) feature. JNI + MCP have shipped; this is the in-XR
 * authoring UI.
 *
 * Two parameters:
 *  - **Target triangle count** — log-scale slider 1k..1M, default 50k.
 *    Snaps to round values so users see "50,000" not "47,381".
 *  - **Max error (mm)** — caps the per-collapse Garland-Heckbert
 *    error. 0 = native default (no cap, only target-count gates).
 *    Useful for "I want fidelity X mm or better, even if that means
 *    not hitting the target count".
 *
 * Compute kicks off the same `runSimplify` path the MCP tool drives,
 * so paint state / supports / seams / fuzzy skin / brim ears /
 * per-volume metadata are dropped on apply (gotcha #28-style sweep).
 * The panel surfaces this in the helper text so the action isn't
 * surprising.
 */
@Composable
fun SimplifyPanel(
    selected: PlacedModel?,
    onSimplify: (modelId: String, targetTriangleCount: Int, maxError: Float) -> Unit,
    onClose: () -> Unit,
) {
    // Slider in log space so 1k → 1M sweeps naturally. Map slider's
    // 0..1 range to 1024..1_048_576 via 2^(10 + 10*t).
    var targetSliderT by remember { mutableFloatStateOf(0.55f) } // ≈ 50k
    var maxErrorMm by remember { mutableFloatStateOf(0f) }

    fun sliderToTarget(t: Float): Int {
        val exponent = 10f + 10f * t.coerceIn(0f, 1f)
        val raw = 2f.pow(exponent).toInt()
        // Snap to a clean rounded value so the readout doesn't
        // bounce between 49,876 and 51,221 as the user drags.
        return roundToNearestNice(raw)
    }
    val target = sliderToTarget(targetSliderT)

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
                        "Mesh simplify",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                    )
                    Text(
                        if (selected == null) "No model selected. Pick a part on the bed first."
                        else selected.label,
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB6BEC8),
                    )
                }
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleMedium)
                }
            }

            Text(
                "Reduce triangle count via quadric edge collapse. Useful for 1M+ tri scans " +
                    "that thrash paint / preview perf. Topology changes — paint, supports, " +
                    "seams, fuzzy skin, brim ears, and per-volume settings are cleared.",
                color = Color(0xFF8E97A2),
                style = MaterialTheme.typography.labelSmall,
            )

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
                        Text(
                            "Target triangles",
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            formatThousands(target),
                            color = Color(0xFF80E0C8),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Slider(
                        value = targetSliderT,
                        onValueChange = { targetSliderT = it },
                        valueRange = 0f..1f,
                    )
                    Text(
                        "1,024 (lossy preview) → 1,048,576 (no real reduction). " +
                            "Slider is log-scale so the middle is around 30k.",
                        color = Color(0xFF8E97A2),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }

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
                        Text(
                            "Max error",
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            if (maxErrorMm <= 0f) "auto" else "%.2f mm".format(maxErrorMm),
                            color = Color(0xFF80E0C8),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Slider(
                        value = maxErrorMm,
                        onValueChange = { maxErrorMm = it },
                        valueRange = 0f..1f,
                        steps = 19, // 0.05 mm increments
                    )
                    Text(
                        "Cap on the Garland-Heckbert error per collapse. 0 = no cap, " +
                            "let the target count drive everything. Tighten when the " +
                            "simplified silhouette starts to lose details you need.",
                        color = Color(0xFF8E97A2),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }

            Spacer(Modifier.fillMaxWidth())

            Button(
                enabled = selected != null,
                onClick = {
                    val sel = selected ?: return@Button
                    onSimplify(sel.id, target, maxErrorMm)
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF2A8B6E),
                    contentColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Simplify ${selected?.label ?: "—"}")
            }
        }
    }
}

/**
 * Snap an arbitrary triangle count to a "nice" round value so the
 * slider readout reads as 50,000 not 50,127. Picks the largest of
 * 1, 2, 5 × 10^k that's ≤ raw.
 */
private fun roundToNearestNice(raw: Int): Int {
    if (raw <= 1) return 1
    var pow = 1
    while (pow * 10 <= raw) pow *= 10
    val candidates = intArrayOf(pow, 2 * pow, 5 * pow, 10 * pow)
    var best = candidates[0]
    for (c in candidates) {
        if (c <= raw && c > best) best = c
    }
    return max(1, best)
}

/** Format an integer with thousands separators (e.g. 50000 → "50,000"). */
private fun formatThousands(n: Int): String {
    val abs = kotlin.math.abs(n)
    val s = abs.toString()
    val sb = StringBuilder()
    for (i in s.indices) {
        if (i > 0 && (s.length - i) % 3 == 0) sb.append(',')
        sb.append(s[i])
    }
    return if (n < 0) "-$sb" else sb.toString()
}

@Suppress("unused") // exposed for tests
internal object SimplifyPanelMath {
    fun roundToNearestNice(raw: Int): Int = dev.orcaxr.app.roundToNearestNice(raw)
    fun formatThousands(n: Int): String = dev.orcaxr.app.formatThousands(n)
}
