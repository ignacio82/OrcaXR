package dev.orcaxr.nativeapp.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orcaxr.nativeapp.mcp.McpManager

@Composable
fun McpSettingsDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = remember { context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager }

    val auth = McpManager.auth
    var isRunning by remember { mutableStateOf(McpManager.isRunning) }
    var allowLan by remember { mutableStateOf(auth?.allowLan ?: false) }
    var token by remember { mutableStateOf(auth?.token ?: "") }
    var clientCount by remember { mutableIntStateOf(McpManager.clientCount) }
    val port = McpManager.port

    fun copyToClipboard(label: String, text: String) {
        clipboard?.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(context, "$label copied to clipboard", Toast.LENGTH_SHORT).show()
    }

    val claudeConfig = """
{
  "mcpServers": {
    "orcaxr-android": {
      "command": "node",
      "args": ["tools/mcp/adb-mcp-bridge.mjs"]
    }
  }
}
""".trimIndent()

    val adbCmd = auth?.adbForwardCommand() ?: "adb forward tcp:8765 tcp:8765"

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "Model Context Protocol (MCP) Server",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "Connect AI agents (Claude, Codex, Antigravity) to inspect and control OrcaXR directly.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // Status card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(12.dp)
                                        .clip(CircleShape)
                                        .background(if (isRunning) Color(0xFF4CAF50) else Color(0xFF9E9E9E)),
                                )
                                Text(
                                    if (isRunning) "Server Active" else "Server Stopped",
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Switch(
                                checked = isRunning,
                                onCheckedChange = { enable ->
                                    auth?.serverEnabled = enable
                                    if (enable) {
                                        McpManager.start()
                                    } else {
                                        McpManager.stop()
                                    }
                                    isRunning = McpManager.isRunning
                                    clientCount = McpManager.clientCount
                                },
                            )
                        }

                        if (isRunning) {
                            val hostStr = if (allowLan) "0.0.0.0 (LAN & Loopback)" else "127.0.0.1 (Loopback only)"
                            Text("Endpoint: ws://$hostStr:$port/mcp/ws", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                            Text("Active Connected AI Clients: $clientCount", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                        }
                    }
                }

                // Bearer token card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Authentication Bearer Token", fontWeight = FontWeight.SemiBold)
                        Text(
                            token,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            maxLines = 2,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
                                .padding(8.dp),
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            OutlinedButton(
                                onClick = { copyToClipboard("Bearer Token", token) },
                                modifier = Modifier.weight(1f),
                            ) {
                                Text("Copy Token")
                            }
                            OutlinedButton(
                                onClick = {
                                    val newToken = auth?.regenerateToken() ?: ""
                                    token = newToken
                                    Toast.makeText(context, "Regenerated Bearer Token", Toast.LENGTH_SHORT).show()
                                },
                                modifier = Modifier.weight(1f),
                            ) {
                                Text("Regenerate")
                            }
                        }
                    }
                }

                // Quick Setup Guide
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("How to Connect Your Desktop AI Agent", fontWeight = FontWeight.SemiBold)

                        Text("1. Forward USB/Wi-Fi Port via ADB:", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                        Text(
                            adbCmd,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
                                .padding(6.dp),
                        )
                        OutlinedButton(
                            onClick = { copyToClipboard("ADB Command", adbCmd) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Copy ADB Command")
                        }

                        Text("2. Add to Claude Desktop or Antigravity Config:", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                        Text(
                            claudeConfig,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
                                .padding(6.dp),
                        )
                        OutlinedButton(
                            onClick = { copyToClipboard("MCP Agent Config", claudeConfig) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Copy MCP Agent Config JSON")
                        }
                    }
                }

                // Example Prompts Card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("What You Can Ask Your AI Agent", fontWeight = FontWeight.SemiBold)
                        Text("• \"What models and filaments are on the build plate?\"", style = MaterialTheme.typography.bodySmall)
                        Text("• \"Change filament 1 for 3 and filament 2 for 4\"", style = MaterialTheme.typography.bodySmall)
                        Text("• \"Rotate the pumpkin 90 degrees around Z\"", style = MaterialTheme.typography.bodySmall)
                        Text("• \"Slice plate 1 and check if there are any warnings\"", style = MaterialTheme.typography.bodySmall)
                        Text("• \"Take a screenshot of the 3D viewport\"", style = MaterialTheme.typography.bodySmall)
                        Text("• \"Send the sliced G-code to the Snapmaker U1 printer\"", style = MaterialTheme.typography.bodySmall)
                    }
                }

                // LAN toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = allowLan,
                        onCheckedChange = { checked ->
                            allowLan = checked
                            auth?.allowLan = checked
                            if (isRunning) {
                                McpManager.restart()
                                isRunning = McpManager.isRunning
                            }
                        },
                    )
                    Column(modifier = Modifier.padding(start = 8.dp)) {
                        Text("Allow Local Network (LAN) Connections", fontWeight = FontWeight.Medium)
                        Text(
                            "Binds to 0.0.0.0. Protected by Bearer token.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Close")
            }
        },
    )
}
