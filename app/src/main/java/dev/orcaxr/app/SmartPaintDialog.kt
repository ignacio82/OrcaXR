package dev.orcaxr.app

import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mobile.SmartPaintRunner
import kotlinx.coroutines.launch

/**
 * XR-shell Smart Paint surface. A compact Material3 dialog that drives
 * the SAME [SmartPaintRunner] the phone screen and the network MCP
 * server use — UI ⇄ MCP parity in the XR shell too
 * ([[feedback_ui_mcp_parity]]). The committed paint flows back through
 * the XR workspace binding (`LoadPaintState` → `applyPaintMutation`),
 * identical to an MCP `auto_paint` call.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SmartPaintDialog(onDismiss: () -> Unit) {
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
                imageBytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("read")
                imageName = uri.lastPathSegment?.substringAfterLast('/') ?: "image"
            }.onFailure {
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
                    mode = mode, axis = axis, maxColors = maxColors,
                    useFullSpectrum = useFs,
                    imageBase64 = imageBytes?.let { Base64.encodeToString(it, Base64.NO_WRAP) },
                    provider = provider, dryRun = dryRun,
                ),
            )
            running = false
            status = (if (r.ok) "✓ " else "✗ ") + r.message
            if (r.ok && !dryRun) onDismiss()
        }
    }

    AlertDialog(
        onDismissRequest = { if (!running) onDismiss() },
        confirmButton = {
            TextButton(onClick = { runTool(false) }, enabled = !running) {
                Text(if (running) "Working…" else "Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = { runTool(true) }, enabled = !running) { Text("Preview") }
        },
        title = { Text("Smart Paint") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SmartPaintRunner.Mode.entries.forEach { m ->
                        FilterChip(
                            selected = mode == m,
                            onClick = { mode = m },
                            label = { Text(m.label) },
                        )
                    }
                }
                if (mode == SmartPaintRunner.Mode.HeightBands) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("x", "y", "z").forEach { a ->
                            FilterChip(
                                selected = axis == a,
                                onClick = { axis = a },
                                label = { Text(a.uppercase()) },
                            )
                        }
                    }
                }
                run {
                    val maxColorCap = paletteSize.coerceIn(1, 32)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "Max colours (of $maxColorCap)",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedButton(
                                onClick = { maxColors = (maxColors - 1).coerceIn(1, maxColorCap) },
                                enabled = maxColors > 1,
                                contentPadding = PaddingValues(0.dp),
                                modifier = Modifier.size(40.dp),
                            ) { Text("−", style = MaterialTheme.typography.titleMedium) }
                            Text(
                                "$maxColors",
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.widthIn(min = 40.dp),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                            OutlinedButton(
                                onClick = { maxColors = (maxColors + 1).coerceIn(1, maxColorCap) },
                                enabled = maxColors < maxColorCap,
                                contentPadding = PaddingValues(0.dp),
                                modifier = Modifier.size(40.dp),
                            ) { Text("+", style = MaterialTheme.typography.titleMedium) }
                        }
                    }
                    // Keep the value valid if the palette shrank.
                    if (maxColors > maxColorCap) maxColors = maxColorCap
                }
                if (mode.needsImage) {
                    OutlinedButton(
                        onClick = { picker.launch(arrayOf("image/*")) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(imageName?.let { "Image: $it" } ?: "Choose image…") }
                }
                if (mode == SmartPaintRunner.Mode.Label) {
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
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
                if (mode.needsImage || mode.needsKey) {
                    androidx.compose.foundation.layout.Row(
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        Switch(checked = useFs, onCheckedChange = { useFs = it })
                        Text("  FullSpectrum (experimental)")
                    }
                }
                status?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
    )
}
