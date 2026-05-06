package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.mobile.EchoMark
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.SectionKicker
import kotlinx.coroutines.launch

/**
 * First-run onboarding. Two paths:
 *  - Pick a discovered Moonraker host from mDNS / subnet scan.
 *  - Manually enter host + port + (optional) API key.
 *
 * Either way produces a [PrinterConfig] persisted to PrintersStore;
 * once at least one printer exists the shell drops onboarding gating
 * and the user lands on the Home dashboard.
 */
@Composable
fun OnboardingScreen(
    onSkip: () -> Unit,
    onAdded: () -> Unit,
) {
    val app = LocalMobileAppState.current
    val scope = rememberCoroutineScope()
    val discovered by app.discovery.services.collectAsState()

    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("7125") }
    var apiKey by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        // Kick off mDNS / subnet discovery in the background.
        runCatching { app.discovery.start() }
    }
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose { runCatching { app.discovery.stop() } }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .systemBarsPadding()
            .imePadding(),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .background(MaterialTheme.colorScheme.primaryContainer, CircleShape)
                        .padding(16.dp),
                ) {
                    EchoMark(size = 32.dp, color = MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.width(16.dp))
                Column {
                    SectionKicker("Welcome")
                    Text(
                        "Echo, meet your printer.",
                        style = MaterialTheme.typography.displaySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }

            Text(
                "OrcaXR slices on-device using libslic3r and prints over your local Klipper / Moonraker network. " +
                    "Add a printer to start; you can configure more later.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Discovered printers
            if (discovered.isNotEmpty()) {
                MobileCard {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionKicker("On your network")
                        for (svc in discovered) {
                            Row(
                                Modifier.fillMaxWidth(),
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
                                Button(
                                    onClick = {
                                        scope.launch {
                                            saving = true
                                            val cfg = PrinterConfig(
                                                id = "p_${System.currentTimeMillis().toString(36)}",
                                                name = svc.name.ifBlank { svc.host },
                                                host = svc.host,
                                                port = svc.port,
                                                apiKey = null,
                                            )
                                            app.printers.upsert(cfg)
                                            app.prefs.lastPrinterId = cfg.id
                                            saving = false
                                            onAdded()
                                        }
                                    },
                                    enabled = !saving,
                                ) { Text("Add") }
                            }
                        }
                    }
                }
            }

            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionKicker("Manual setup")
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Friendly name") },
                        placeholder = { Text("Workshop U1") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = host,
                        onValueChange = { host = it },
                        label = { Text("Host") },
                        placeholder = { Text("192.168.1.42 or printer.local") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedTextField(
                            value = port,
                            onValueChange = { port = it.filter { c -> c.isDigit() } },
                            label = { Text("Port") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.width(140.dp),
                        )
                        OutlinedTextField(
                            value = apiKey,
                            onValueChange = { apiKey = it },
                            label = { Text("API key (optional)") },
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(
                            enabled = host.isNotBlank() && !saving,
                            onClick = {
                                scope.launch {
                                    saving = true
                                    val cfg = PrinterConfig(
                                        id = "p_${System.currentTimeMillis().toString(36)}",
                                        name = name.ifBlank { host },
                                        host = host.trim(),
                                        port = port.toIntOrNull() ?: 7125,
                                        apiKey = apiKey.trim().ifBlank { null },
                                    )
                                    app.printers.upsert(cfg)
                                    app.prefs.lastPrinterId = cfg.id
                                    saving = false
                                    onAdded()
                                }
                            },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primary,
                                contentColor = MaterialTheme.colorScheme.onPrimary,
                            ),
                        ) { Text(if (saving) "Adding…" else "Add printer") }
                        OutlinedButton(onClick = onSkip) { Text("I'll set up later") }
                    }
                }
            }

            TextButton(onClick = onSkip, modifier = Modifier.align(Alignment.End)) {
                Text("Skip onboarding")
            }
        }
    }
}
