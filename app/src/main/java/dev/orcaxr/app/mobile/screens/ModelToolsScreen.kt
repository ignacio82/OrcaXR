package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.MobileWorkspaceActions
import dev.orcaxr.app.mobile.SectionKicker
import kotlinx.coroutines.launch

/**
 * Phone "Model tools" — the human affordance for the single-model
 * geometry / process WorkspaceTools the binding re-architecture wired
 * (cut, simplify, adaptive layer height, drop-to-bed, delete). Every
 * action is dispatched through [MobileWorkspaceActions] → the same MCP
 * tool the assistant uses ([[feedback_ui_mcp_parity]]); cut/simplify
 * reload the model (the shell navigates back to Slicer), so this
 * surface closes itself on success.
 */
@Composable
fun ModelToolsScreen(
    modelName: String,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var cutZ by remember { mutableStateOf("5") }
    var simplifyTarget by remember { mutableStateOf("20000") }
    var quality by remember { mutableStateOf(0.5f) }
    var running by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }

    fun fire(label: String, closeOnOk: Boolean, block: suspend () -> dev.orcaxr.app.ToolDispatch.Result) {
        running = true
        status = "$label…"
        scope.launch {
            val r = block()
            running = false
            status = r.toStatus()
            if (r.ok && closeOnOk) onClose()
        }
    }

    Column(Modifier.fillMaxSize()) {
        MobileTopBar(
            title = "Model tools",
            subtitle = modelName,
            actions = { TextButton(onClick = onClose) { Text("Close") } },
        )
        Column(
            Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionKicker("Cut at Z")
                    OutlinedTextField(
                        value = cutZ,
                        onValueChange = { cutZ = it.filter { c -> c.isDigit() || c == '.' } },
                        label = { Text("Plane Z (mm)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        enabled = !running && cutZ.toFloatOrNull() != null,
                        onClick = {
                            fire("Cutting", closeOnOk = true) {
                                MobileWorkspaceActions.cut(cutZ.toFloat())
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Cut model") }
                }
            }

            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionKicker("Simplify mesh")
                    OutlinedTextField(
                        value = simplifyTarget,
                        onValueChange = { simplifyTarget = it.filter(Char::isDigit) },
                        label = { Text("Target triangle count") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        enabled = !running && (simplifyTarget.toIntOrNull() ?: 0) > 4,
                        onClick = {
                            fire("Simplifying", closeOnOk = true) {
                                MobileWorkspaceActions.simplify(simplifyTarget.toInt(), 0f)
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Simplify") }
                }
            }

            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionKicker("Adaptive layer height")
                    Text(
                        "Quality: ${"%.2f".format(quality)} (higher = finer / slower)",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Slider(value = quality, onValueChange = { quality = it }, valueRange = 0f..1f)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(
                            enabled = !running,
                            onClick = {
                                fire("Computing", closeOnOk = false) {
                                    MobileWorkspaceActions.computeAdaptiveLayerHeights(quality)
                                }
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("Compute") }
                        OutlinedButton(
                            enabled = !running,
                            onClick = {
                                fire("Clearing", closeOnOk = false) {
                                    MobileWorkspaceActions.clearLayerHeightProfile()
                                }
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("Clear") }
                    }
                }
            }

            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionKicker("Placement")
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(
                            enabled = !running,
                            onClick = {
                                fire("Dropping to bed", closeOnOk = false) {
                                    MobileWorkspaceActions.dropToBed()
                                }
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("Drop to bed") }
                        OutlinedButton(
                            enabled = !running,
                            onClick = {
                                fire("Deleting", closeOnOk = true) {
                                    MobileWorkspaceActions.deleteModel()
                                }
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("Remove model") }
                    }
                }
            }

            status?.let {
                MobileCard {
                    Column {
                        SectionKicker("Result")
                        Text(it, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}
