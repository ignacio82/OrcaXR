package dev.orcaxr.app.mobile.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import kotlinx.coroutines.launch

/**
 * Settings — theme, MCP server (HTTP / JSON-RPC for LLM-driven control),
 * and a couple of read-only metadata cards.
 */
@Composable
fun SettingsScreen(
    isTablet: Boolean,
    forceDark: Boolean?,
    onSetForceDark: (Boolean?) -> Unit,
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val mcpEnabled by app.mcpSettings.enabled.collectAsState(initial = false)
    val mcpPort by app.mcpSettings.port.collectAsState(initial = 7080)
    val mcpToken by app.mcpSettings.apiKey.collectAsState(initial = null)

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(title = "Settings")
        Column(
            Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Theme
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionKicker("Appearance")
                    Text(
                        when (forceDark) {
                            true -> "Dark theme"
                            false -> "Light theme"
                            null -> "Following system"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "Persisted across app restarts. Light mode uses M3 surfaces with the same teal accent; dark inherits the orcaxr.dev midnight palette.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    androidx.compose.foundation.layout.Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ThemePill("System", forceDark == null) { onSetForceDark(null) }
                        ThemePill("Light", forceDark == false) { onSetForceDark(false) }
                        ThemePill("Dark", forceDark == true) { onSetForceDark(true) }
                    }
                }
            }

            // MCP server
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionKicker("MCP server")
                    Text(
                        "Local HTTP / JSON-RPC endpoint that lets an LLM (Claude Desktop, the Anthropic SDK) drive every action a human can take in OrcaXR. Disabled by default.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    SwitchRow(
                        label = "Enable server",
                        sub = "Listens on 0.0.0.0:$mcpPort with bearer-token auth.",
                        checked = mcpEnabled,
                        onChange = { v ->
                            scope.launch {
                                if (v) app.mcpSettings.ensureApiKey()
                                app.mcpSettings.setEnabled(v)
                            }
                        },
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Port", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                            Text(
                                "$mcpPort",
                                style = LocalMobileTextStyles.current.numeric,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    val token = mcpToken
                    if (token != null) {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainerHigh,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("Bearer token", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(
                                    token,
                                    style = LocalMobileTextStyles.current.numeric,
                                    color = MaterialTheme.colorScheme.primary,
                                    overflow = TextOverflow.Visible,
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = {
                                        copyToClipboard(ctx, "OrcaXR MCP token", token)
                                    }) { Text("Copy") }
                                    OutlinedButton(onClick = {
                                        scope.launch { app.mcpSettings.rotateApiKey() }
                                    }) { Text("Rotate") }
                                }
                            }
                        }
                    } else if (mcpEnabled) {
                        Text(
                            "Generating bearer token…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // About / debug
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionKicker("About")
                    Text("OrcaXR Mobile", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
                    Text(
                        "Companion to the XR slicer. The same libslic3r engine, the same MCP surface, the same printer integration — just running on a phone or tablet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun SwitchRow(
    label: String,
    sub: String?,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

private fun copyToClipboard(ctx: Context, label: String, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

@Composable
private fun ThemePill(label: String, selected: Boolean, onClick: () -> Unit) {
    androidx.compose.material3.Surface(
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(50),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
        onClick = onClick,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
            modifier = androidx.compose.ui.Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}
