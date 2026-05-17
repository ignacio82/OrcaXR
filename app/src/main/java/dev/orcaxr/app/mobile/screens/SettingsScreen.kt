package dev.orcaxr.app.mobile.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.SubnetScanner
import dev.orcaxr.app.mcp.McpServer
import dev.orcaxr.app.mcp.RemoteMcpEndpoint
import dev.orcaxr.app.mcp.RemoteMcpProbe
import dev.orcaxr.app.mcp.buildShareSnippet
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
    onOpenAssistant: () -> Unit = {},
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val mcpEnabled by app.mcpSettings.enabled.collectAsState(initial = false)
    val mcpPort by app.mcpSettings.port.collectAsState(initial = 7080)
    val mcpToken by app.mcpSettings.apiKey.collectAsState(initial = null)
    val remoteEndpoint by app.remoteMcp.endpoint.collectAsState(initial = null)

    // LAN addresses for the local MCP Share snippet. Recomputed when
    // the server toggle flips so a new Wi-Fi network's address shows
    // up without needing to re-enter Settings.
    var lanAddresses by remember { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(mcpEnabled, mcpPort) {
        lanAddresses = if (mcpEnabled) McpServer.lanAddresses() else emptyList()
    }

    // Auto-run mDNS discovery while the Settings screen is composed,
    // so a user with one or more printers already configured can still
    // find more without going through onboarding. Stop on dispose so
    // we're not holding the NSD listener open in the background. The
    // subnet sweep fires once 600 ms after the screen lands — slow
    // enough that the user isn't paying for an unused scan when they
    // open Settings just to flip the theme, fast enough that "I went
    // to Settings to look for my printer" feels responsive.
    val discovered by app.discovery.services.collectAsState(initial = emptyList())
    val configuredHosts: Set<String> = app.printers.printers
        .collectAsState(initial = emptyList()).value.map { it.host }.toSet()
    val printersUnknown = discovered.filterNot { it.host in configuredHosts }
    var isScanning by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        runCatching { app.discovery.start() }
        isScanning = true
        kotlinx.coroutines.delay(600)
        runCatching {
            val hits = SubnetScanner.scanLan(ctx)
            app.discovery.addResults(hits)
        }
        isScanning = false
    }
    DisposableEffect(Unit) {
        onDispose { runCatching { app.discovery.stop() } }
    }

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
                                    OutlinedButton(
                                        enabled = mcpEnabled && lanAddresses.isNotEmpty(),
                                        onClick = {
                                            val firstIp = lanAddresses.firstOrNull()
                                                ?: return@OutlinedButton
                                            val primaryUrl = "http://$firstIp:$mcpPort/mcp"
                                            val snippet = buildShareSnippet(
                                                primaryUrl = primaryUrl,
                                                token = token,
                                                lanIps = lanAddresses,
                                                port = mcpPort,
                                            )
                                            copyToClipboard(ctx, "OrcaXR MCP grant", snippet)
                                            val send = Intent(Intent.ACTION_SEND).apply {
                                                type = "text/plain"
                                                putExtra(Intent.EXTRA_SUBJECT, "OrcaXR MCP server connection")
                                                putExtra(Intent.EXTRA_TEXT, snippet)
                                            }
                                            val chooser = Intent.createChooser(
                                                send, "Share via Quick Share",
                                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                            runCatching { ctx.startActivity(chooser) }
                                        },
                                    ) { Text("Share") }
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

            // Remote OrcaXR card — shown only after a Quick-Share
            // grant has landed in `RemoteMcpStore`. Lets the user
            // see what they're paired with, run a live "is the
            // headset reachable + does the token still work" probe,
            // rename the entry, and disconnect.
            remoteEndpoint?.let { endpoint ->
                RemoteMcpCard(
                    endpoint = endpoint,
                    onRename = { newLabel ->
                        scope.launch { app.remoteMcp.rename(newLabel) }
                    },
                    onDisconnect = {
                        scope.launch { app.remoteMcp.set(null) }
                    },
                )
            }

            // Discovered printers — auto-running mDNS + subnet scan
            // surfaces anything reachable on the LAN that the user
            // hasn't configured yet. One-tap add wires the row into
            // `PrintersStore`, the same path Onboarding uses.
            // Configured printers — rename / delete (the phone affordance
            // for update_printer / delete_printer; routed through the
            // same tools the MCP path uses).
            val configuredPrinters by app.printers.printers
                .collectAsState(initial = emptyList<dev.orcaxr.app.PrinterConfig>())
            if (configuredPrinters.isNotEmpty()) {
                ConfiguredPrintersCard(
                    printers = configuredPrinters,
                    onRename = { id, newName ->
                        scope.launch {
                            dev.orcaxr.app.mobile.MobileWorkspaceActions.updatePrinter(
                                ctx.applicationContext, id, newName, null, null, null,
                            )
                        }
                    },
                    onDelete = { id ->
                        scope.launch {
                            dev.orcaxr.app.mobile.MobileWorkspaceActions.deletePrinter(
                                ctx.applicationContext, id,
                            )
                        }
                    },
                )
            }

            DiscoveredPrintersCard(
                discovered = printersUnknown,
                isScanning = isScanning,
                onRescan = {
                    scope.launch {
                        isScanning = true
                        runCatching { app.discovery.stop() }
                        runCatching { app.discovery.start() }
                        runCatching {
                            val hits = SubnetScanner.scanLan(ctx)
                            app.discovery.addResults(hits)
                        }
                        isScanning = false
                    }
                },
                onAdd = { d ->
                    scope.launch {
                        val cfg = PrinterConfig(
                            id = "printer_${System.currentTimeMillis().toString(36)}",
                            name = d.sn?.let { "Snapmaker $it" } ?: d.name.ifBlank { d.host },
                            host = d.host,
                            port = d.port,
                            apiKey = null,
                        )
                        app.printers.upsert(cfg)
                    }
                },
            )

            // AI assistant — Claude / Gemini / OpenAI key entry, model
            // override, voice toggle, and "Open assistant" CTA. Same
            // card the XR Devices panel uses; reused verbatim because
            // the XR/mobile distinction is just chrome — keys, models,
            // and the chat surface itself are device-agnostic.
            dev.orcaxr.app.llm.LlmAssistantCard(
                onOpenAssistant = onOpenAssistant,
                modifier = androidx.compose.ui.Modifier.fillMaxWidth(),
            )

            SettingsBackupCard()

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
private fun RemoteMcpCard(
    endpoint: RemoteMcpEndpoint,
    onRename: (String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<RemoteMcpProbe.Status?>(null) }
    var probing by remember { mutableStateOf(false) }
    var showToken by remember { mutableStateOf(false) }
    var labelDraft by remember(endpoint.label) { mutableStateOf(endpoint.label) }
    var editingLabel by remember { mutableStateOf(false) }

    // First-render probe so the card opens with a live status. Cheap
    // — one HTTP POST to /mcp; failure is silently absorbed by the
    // probe and surfaces as Offline.
    LaunchedEffect(endpoint.url, endpoint.token) {
        probing = true
        status = RemoteMcpProbe.probe(endpoint)
        probing = false
    }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Remote OrcaXR")
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (editingLabel) {
                    androidx.compose.material3.OutlinedTextField(
                        value = labelDraft,
                        onValueChange = { labelDraft = it },
                        label = { Text("Label") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(onClick = {
                        onRename(labelDraft.ifBlank { endpoint.label })
                        editingLabel = false
                    }) { Text("Save") }
                } else {
                    Text(
                        endpoint.label,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(onClick = { editingLabel = true }) { Text("Rename") }
                }
            }
            Text(
                endpoint.url,
                style = LocalMobileTextStyles.current.numeric,
                color = MaterialTheme.colorScheme.primary,
                overflow = TextOverflow.Visible,
            )
            val statusLabel = when (val s = status) {
                null -> if (probing) "Checking…" else ""
                is RemoteMcpProbe.Status.Online -> "Online · ${s.toolCount} tools"
                RemoteMcpProbe.Status.Unauthorized -> "Token rejected — ask the headset for a fresh share."
                is RemoteMcpProbe.Status.Offline -> "Offline (${s.message})"
            }
            val statusColor = when (status) {
                is RemoteMcpProbe.Status.Online -> MaterialTheme.colorScheme.primary
                RemoteMcpProbe.Status.Unauthorized -> MaterialTheme.colorScheme.error
                is RemoteMcpProbe.Status.Offline -> MaterialTheme.colorScheme.onSurfaceVariant
                null -> MaterialTheme.colorScheme.onSurfaceVariant
            }
            if (statusLabel.isNotBlank()) {
                Text(
                    statusLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = statusColor,
                )
            }
            // Bearer token row.
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "Bearer token",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        if (showToken) endpoint.token
                        else "•".repeat(endpoint.token.length.coerceAtMost(32)),
                        style = LocalMobileTextStyles.current.numeric,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { showToken = !showToken }) {
                            Text(if (showToken) "Hide" else "Show")
                        }
                        OutlinedButton(onClick = {
                            copyToClipboard(ctx, "OrcaXR MCP token", endpoint.token)
                        }) { Text("Copy") }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    enabled = !probing,
                    onClick = {
                        scope.launch {
                            probing = true
                            status = RemoteMcpProbe.probe(endpoint)
                            probing = false
                        }
                    },
                ) { Text(if (probing) "Testing…" else "Test connection") }
                OutlinedButton(onClick = onDisconnect) { Text("Disconnect") }
            }
            Text(
                "Quick-Share another grant (Settings → MCP server → Share on the headset) " +
                    "to overwrite this entry.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DiscoveredPrintersCard(
    discovered: List<dev.orcaxr.app.DiscoveredPrinter>,
    isScanning: Boolean,
    onRescan: () -> Unit,
    onAdd: (dev.orcaxr.app.DiscoveredPrinter) -> Unit,
) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    SectionKicker("Printers nearby")
                    Text(
                        if (isScanning) "Scanning the LAN…"
                        else "${discovered.size} reachable on this Wi-Fi",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                OutlinedButton(enabled = !isScanning, onClick = onRescan) {
                    Text(if (isScanning) "…" else "Rescan")
                }
            }
            if (discovered.isEmpty() && !isScanning) {
                Text(
                    "No new Klipper / Moonraker hosts found. The first scan covers " +
                        "mDNS announcements + a /24 sweep on the active Wi-Fi; tap " +
                        "Rescan if you've just powered the printer on.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                for (svc in discovered) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                svc.name.ifBlank { svc.host },
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                "${svc.host}:${svc.port}",
                                style = LocalMobileTextStyles.current.numeric,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Button(onClick = { onAdd(svc) }) { Text("Add") }
                    }
                }
            }
        }
    }
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

/**
 * Backup & restore — the phone affordance for the `export_settings` /
 * `import_settings` MCP tools (previously XR-voice-only / unreachable).
 * Routes through [dev.orcaxr.app.SettingsBackupRunner] so it's the same
 * logic the MCP path uses; SAF handles the content:// I/O the tool
 * can't. Every URI touch is runCatching+Toast per the phone-shell
 * crash-visibility rule.
 */
@Composable
private fun SettingsBackupCard() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var replace by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }

    val exportLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/json"),
    ) { uri: android.net.Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            runCatching {
                val (r, envelope) = dev.orcaxr.app.SettingsBackupRunner
                    .exportEnvelope(ctx.applicationContext)
                if (!r.ok || envelope == null) {
                    status = "✗ ${r.message}"
                    return@runCatching
                }
                ctx.contentResolver.openOutputStream(uri)?.use {
                    it.write(envelope.toByteArray())
                } ?: error("couldn't open destination")
                status = "✓ Settings exported."
            }.onFailure {
                android.util.Log.w("OrcaXR/backup", "export failed", it)
                android.widget.Toast.makeText(ctx, "Export failed.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    val importLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri: android.net.Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            runCatching {
                val text = ctx.contentResolver.openInputStream(uri)?.use {
                    it.readBytes().decodeToString()
                } ?: error("couldn't read file")
                val r = dev.orcaxr.app.SettingsBackupRunner
                    .importEnvelope(ctx.applicationContext, text, replace)
                status = if (r.ok) "✓ Imported (${if (replace) "replace" else "merge"}). " +
                    "Restart OrcaXR to apply." else "✗ ${r.message}"
            }.onFailure {
                android.util.Log.w("OrcaXR/backup", "import failed", it)
                android.widget.Toast.makeText(ctx, "Import failed.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionKicker("Backup & restore")
            Text(
                "Export every profile, printer, plate, filament, MCP and preference as one " +
                    "JSON file — restore it on another device or after a reinstall.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Switch(checked = replace, onCheckedChange = { replace = it })
                Text(
                    "Replace on import (default merges)",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { exportLauncher.launch("orcaxr-settings.json") },
                    modifier = androidx.compose.ui.Modifier.weight(1f),
                ) { Text("Export…") }
                OutlinedButton(
                    onClick = { importLauncher.launch(arrayOf("application/json", "*/*")) },
                    modifier = androidx.compose.ui.Modifier.weight(1f),
                ) { Text("Restore…") }
            }
            status?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/**
 * Configured-printers management — the phone affordance for
 * `update_printer` / `delete_printer` (rename inline; delete per row).
 * Discovery/add stays in [DiscoveredPrintersCard]; this is the
 * previously-missing "manage what I already added" surface.
 */
@Composable
private fun ConfiguredPrintersCard(
    printers: List<dev.orcaxr.app.PrinterConfig>,
    onRename: (id: String, newName: String) -> Unit,
    onDelete: (id: String) -> Unit,
) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Your printers")
            for (p in printers) {
                var draft by remember(p.id, p.name) { mutableStateOf(p.name) }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = androidx.compose.ui.Modifier.fillMaxWidth(),
                    )
                    Text(
                        "${p.host}:${p.port}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(
                            onClick = { if (draft.isNotBlank() && draft != p.name) onRename(p.id, draft) },
                            enabled = draft.isNotBlank() && draft != p.name,
                            modifier = androidx.compose.ui.Modifier.weight(1f),
                        ) { Text("Save name") }
                        OutlinedButton(
                            onClick = { onDelete(p.id) },
                            modifier = androidx.compose.ui.Modifier.weight(1f),
                        ) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
    }
}
