package dev.orcaxr.app.mobile.screens

import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.SmartPaintRunner
import kotlinx.coroutines.launch

/**
 * Phone Smart Paint surface. Pure UI — every action is dispatched
 * through [SmartPaintRunner], which calls the same MCP `Tool` the
 * network MCP server would (UI ⇄ MCP parity, [[feedback_ui_mcp_parity]]).
 * The applied paint flows back into the slicer via the shell's
 * workspace binding; this screen just triggers the tool and reports.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SmartPaintScreen(
    modelName: String,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val ws = remember { WorkspaceModel.get() }
    val palette by ws.previewPalette.collectAsState()
    val paletteSize = palette.count { it.isNotBlank() }.coerceAtLeast(1)

    var mode by remember { mutableStateOf(SmartPaintRunner.Mode.Auto) }
    var axis by remember { mutableStateOf("z") }
    var maxColors by remember { mutableStateOf(paletteSize.coerceAtMost(8)) }
    var useFs by remember { mutableStateOf(false) }
    var provider by remember { mutableStateOf("pollinations") }
    var imageBytes by remember { mutableStateOf<ByteArray?>(null) }
    var imageName by remember { mutableStateOf<String?>(null) }
    var running by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            runCatching {
                val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("couldn't read image")
                imageBytes = bytes
                imageName = uri.lastPathSegment?.substringAfterLast('/') ?: "image"
            }.onFailure {
                android.util.Log.w("OrcaXR/smartpaint", "image pick failed", it)
                Toast.makeText(ctx, "Couldn't read that image.", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun runTool(dryRun: Boolean) {
        running = true
        status = if (dryRun) "Previewing…" else "Painting…"
        scope.launch {
            val r = SmartPaintRunner.run(
                ctx.applicationContext,
                SmartPaintRunner.Params(
                    mode = mode,
                    axis = axis,
                    maxColors = maxColors,
                    useFullSpectrum = useFs,
                    imageBase64 = imageBytes?.let {
                        Base64.encodeToString(it, Base64.NO_WRAP)
                    },
                    provider = provider,
                    dryRun = dryRun,
                ),
            )
            running = false
            status = buildString {
                append(if (r.ok) "✓ " else "✗ ")
                append(r.message)
                r.structured?.let { s ->
                    s.optString("source").takeIf { it.isNotEmpty() }
                        ?.let { append("  ·  source=$it") }
                    if (s.has("slots_used")) append("  ·  ${s.optInt("slots_used")} slots")
                    if (s.has("final_score") && !s.isNull("final_score")) {
                        append("  ·  score=%.2f".format(s.optDouble("final_score")))
                    }
                    s.optJSONObject("full_spectrum")?.let {
                        append("  ·  FS:${it.optInt("virtual_rows_total")} blend rows")
                    }
                }
            }
            if (r.ok && !dryRun) onClose()
        }
    }

    Column(Modifier.fillMaxSize()) {
        MobileTopBar(
            title = "Smart Paint",
            subtitle = modelName,
            actions = { TextButton(onClick = onClose) { Text("Close") } },
        )
        Column(
            Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionKicker("Mode")
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        SmartPaintRunner.Mode.entries.forEach { m ->
                            FilterChip(
                                selected = mode == m,
                                onClick = { mode = m },
                                label = { Text(m.label) },
                            )
                        }
                    }
                    Text(
                        modeHint(mode),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionKicker("Options")
                    if (mode == SmartPaintRunner.Mode.HeightBands) {
                        Text("Axis", style = MaterialTheme.typography.bodyMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("x", "y", "z").forEach { a ->
                                FilterChip(
                                    selected = axis == a,
                                    onClick = { axis = a },
                                    label = { Text(a.uppercase()) },
                                )
                            }
                        }
                    }
                    Text(
                        "Max colours: $maxColors (palette has $paletteSize)",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    androidx.compose.material3.Slider(
                        value = maxColors.toFloat(),
                        onValueChange = { maxColors = it.toInt().coerceIn(1, 32) },
                        valueRange = 1f..paletteSize.coerceAtLeast(2).toFloat(),
                    )
                    if (mode.needsImage) {
                        OutlinedButton(
                            onClick = { picker.launch(arrayOf("image/*")) },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(imageName?.let { "Image: $it" } ?: "Choose target image…") }
                    }
                    if (mode == SmartPaintRunner.Mode.Label) {
                        Text("Provider", style = MaterialTheme.typography.bodyMedium)
                        FlowRow(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            listOf("pollinations", "gemini", "claude", "openai", "openrouter")
                                .forEach { pv ->
                                    FilterChip(
                                        selected = provider == pv,
                                        onClick = { provider = pv },
                                        label = { Text(pv) },
                                    )
                                }
                        }
                    }
                    if (mode.needsKey) {
                        Text(
                            if (mode == SmartPaintRunner.Mode.Label && provider == "pollinations")
                                "Pollinations is free — no API key needed."
                            else
                                "Needs an API key — set it in Settings → LLM (or use " +
                                    "provider 'pollinations' for the label mode).",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (mode == SmartPaintRunner.Mode.Image ||
                        mode == SmartPaintRunner.Mode.Label ||
                        mode == SmartPaintRunner.Mode.Reference
                    ) {
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Switch(checked = useFs, onCheckedChange = { useFs = it })
                            Spacer(Modifier.width(10.dp))
                            Text(
                                "FullSpectrum blends (experimental)",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        if (useFs) {
                            Text(
                                "Mixes two filaments to widen the palette; materializes " +
                                    "virtual rows for the active printer.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            status?.let {
                MobileCard {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SectionKicker("Result")
                        Text(it, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { runTool(dryRun = true) },
                    enabled = !running,
                    modifier = Modifier.weight(1f),
                ) { Text("Preview") }
                Button(
                    onClick = { runTool(dryRun = false) },
                    enabled = !running,
                    modifier = Modifier.weight(1f),
                ) { Text(if (running) "Working…" else "Apply") }
            }
        }
    }
}

private fun modeHint(m: SmartPaintRunner.Mode): String = when (m) {
    SmartPaintRunner.Mode.Auto ->
        "Respects existing paint, else colours each shell, else height bands. No API."
    SmartPaintRunner.Mode.HeightBands -> "Rainbow-by-height along the chosen axis. No API."
    SmartPaintRunner.Mode.Components -> "Each disconnected shell its own colour. No API."
    SmartPaintRunner.Mode.Cavity -> "Recessed/concave faces get a contrast colour. No API."
    SmartPaintRunner.Mode.Image ->
        "Projects a target image onto the model (perceptual colour match). No API."
    SmartPaintRunner.Mode.Label ->
        "Segments locally, then a vision model names + recolours each region."
    SmartPaintRunner.Mode.Reference ->
        "Repaints the whole model to resemble a reference photo, with an auto grade/refine loop."
}
