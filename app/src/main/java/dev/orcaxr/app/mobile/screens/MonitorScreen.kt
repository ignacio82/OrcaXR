package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.MoonrakerClient
import dev.orcaxr.app.MoonrakerResult
import dev.orcaxr.app.PrintSnapshot
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.mobile.EmptyStateCard
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileMetric
import dev.orcaxr.app.mobile.MobileProgress
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.StatusPill
import dev.orcaxr.app.mobile.formatDurationCompact
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Live monitor for the active printer. Polls Moonraker every 1 s
 * (snapshot) and 3 s (webcam) while the screen is on top.
 *
 * Tablet: webcam fills the left column, controls + temps on the right.
 * Phone:  webcam, then progress, then controls, stacked.
 */
@Composable
fun MonitorScreen(isTablet: Boolean) {
    val app = LocalMobileAppState.current
    val printers by app.printers.printers.collectAsState(initial = emptyList())
    var selectedId by remember(printers) {
        mutableStateOf(app.prefs.lastPrinterId ?: printers.firstOrNull()?.id)
    }
    val active = printers.firstOrNull { it.id == selectedId } ?: printers.firstOrNull()

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Monitor",
            subtitle = active?.name ?: "No printer",
        )

        if (active == null) {
            Box(Modifier.fillMaxSize().padding(20.dp)) {
                EmptyStateCard(
                    title = "No printer to watch",
                    body = "Add a printer in onboarding to see live print state, controls, and webcam.",
                )
            }
        } else {

        // Printer chip row when more than one is configured.
        if (printers.size > 1) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 12.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (p in printers) PrinterChip(p, p.id == active.id) { selectedId = p.id }
            }
        }

        if (isTablet) {
            Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Column(Modifier.weight(1.2f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    WebcamCard(active)
                    ProgressCard(active)
                }
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    ControlsCard(active)
                    TempsCard(active)
                    InfoCard(active)
                }
            }
        } else {
            Column(
                Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                WebcamCard(active)
                ProgressCard(active)
                ControlsCard(active)
                TempsCard(active)
                InfoCard(active)
            }
        }
        } // active != null
    }
}

@Composable
private fun PrinterChip(p: PrinterConfig, selected: Boolean, onClick: () -> Unit) {
    androidx.compose.material3.Surface(
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(50),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        onClick = onClick,
    ) {
        Text(
            p.name,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun WebcamCard(cfg: PrinterConfig) {
    var bitmap by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var hasWebcam by remember(cfg.id) { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    // One session per printer-id — the session caches the discovered
    // snapshot URL across frames and runs the Snapmaker U1
    // `camera.start_monitor` keepalive that wakes the camera every
    // 2 s. Without that pulse the U1's monitor.jpg returns either a
    // stale frame from minutes ago or a 404; with it, we get a fresh
    // ~1 fps stream that's all the U1's firmware exposes.
    val session = remember(cfg.id) { MoonrakerClient(cfg).webcamSession() }
    DisposableEffect(cfg.id) {
        session.startWakePulse(scope)
        onDispose { session.stopWakePulse() }
    }
    LaunchedEffect(cfg.id) {
        var consecutive404 = 0
        while (true) {
            when (val r = session.fetchFrame()) {
                is MoonrakerResult.Ok -> {
                    runCatching {
                        val bytes = r.value
                        val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (bmp != null) bitmap = bmp
                    }
                    consecutive404 = 0
                    hasWebcam = true
                }
                is MoonrakerResult.NotFound -> {
                    consecutive404++
                    if (consecutive404 >= 5) hasWebcam = false
                }
                else -> { /* transient — keep trying */ }
            }
            // 500 ms poll cadence. Snapmaker U1's monitor.jpg is
            // refreshed about every 250 ms by the firmware, so we
            // capture roughly 2 fps live view. Mainsail/crowsnest
            // mjpg-streamer hosts comfortably handle this rate.
            delay(if (hasWebcam) 500 else 5_000)
        }
    }
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionKicker("Live view")
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(16f / 9f)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                val bmp = bitmap
                if (bmp != null) {
                    androidx.compose.foundation.Image(
                        bitmap = bmp.asImageBitmap(),
                        contentDescription = "Live webcam",
                        modifier = Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black, RoundedCornerShape(16.dp)),
                    )
                } else {
                    Text(
                        "Awaiting camera…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProgressCard(cfg: PrinterConfig) {
    val snap = remember { mutableStateOf<PrintSnapshot?>(null) }
    LaunchedEffect(cfg.id) {
        while (true) {
            val r = MoonrakerClient(cfg).queryStatus()
            if (r is MoonrakerResult.Ok) snap.value = r.value
            delay(1_000)
        }
    }
    val s = snap.value
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        s?.filename?.ifBlank { null } ?: "—",
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                    )
                    Text(
                        s?.message?.ifBlank { null } ?: "Waiting for print…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusPill(
                    label = (s?.state ?: "offline").replaceFirstChar { it.uppercase() },
                    color = when (s?.state) {
                        "printing" -> MaterialTheme.colorScheme.primary
                        "paused" -> MaterialTheme.colorScheme.tertiary
                        "complete" -> MaterialTheme.colorScheme.primary
                        "cancelled", "error" -> MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.secondary
                    },
                )
            }
            MobileProgress(progress = s?.progress ?: 0f)
            Row {
                Text(
                    "${((s?.progress ?: 0f) * 100).toInt()}%",
                    style = LocalMobileTextStyles.current.numericLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.weight(1f))
                Column(horizontalAlignment = Alignment.End) {
                    Text("ETA", style = LocalMobileTextStyles.current.sectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        formatDurationCompact(s?.etaSec),
                        style = LocalMobileTextStyles.current.numericLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                MobileMetric("Layer", "${s?.currentLayer ?: 0}", "/ ${s?.totalLayers ?: 0}")
                MobileMetric("Elapsed", formatDurationCompact(s?.printDurationSec))
            }
        }
    }
}

@Composable
private fun ControlsCard(cfg: PrinterConfig) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var lastError by remember { mutableStateOf<String?>(null) }

    fun fire(action: suspend (MoonrakerClient) -> MoonrakerResult<Unit>) {
        if (busy) return
        scope.launch {
            busy = true
            val r = action(MoonrakerClient(cfg))
            lastError = (r as? MoonrakerResult.HttpError)?.body
                ?: (r as? MoonrakerResult.IoError)?.message
            busy = false
        }
    }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Print controls")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ControlButton(
                    label = "Pause",
                    icon = Icons.Filled.Pause,
                    onClick = { fire { it.pausePrint() } },
                    modifier = Modifier.weight(1f),
                )
                ControlButton(
                    label = "Resume",
                    icon = Icons.Filled.PlayArrow,
                    onClick = { fire { it.resumePrint() } },
                    modifier = Modifier.weight(1f),
                )
            }
            Button(
                onClick = { fire { it.cancelPrint() } },
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Cancel, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (busy) "Working…" else "Cancel print")
            }
            val err = lastError
            if (err != null) {
                Text(
                    err,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun ControlButton(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    androidx.compose.material3.OutlinedButton(
        onClick = onClick,
        modifier = modifier.height(48.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text(label)
    }
}

@Composable
private fun TempsCard(cfg: PrinterConfig) {
    val snap = remember { mutableStateOf<PrintSnapshot?>(null) }
    LaunchedEffect(cfg.id) {
        while (true) {
            val r = MoonrakerClient(cfg).queryStatus()
            if (r is MoonrakerResult.Ok) snap.value = r.value
            delay(2_000)
        }
    }
    val s = snap.value
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Temperatures")
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                MobileMetric(
                    label = "Nozzle",
                    value = "${(s?.nozzleTemp ?: 0f).toInt()}°",
                    unit = if ((s?.nozzleTarget ?: 0f) > 0f) "→ ${s?.nozzleTarget?.toInt()}°" else null,
                )
                MobileMetric(
                    label = "Bed",
                    value = "${(s?.bedTemp ?: 0f).toInt()}°",
                    unit = if ((s?.bedTarget ?: 0f) > 0f) "→ ${s?.bedTarget?.toInt()}°" else null,
                )
            }
        }
    }
}

@Composable
private fun InfoCard(cfg: PrinterConfig) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionKicker("Connection")
            InfoRow("Host", "${cfg.host}:${cfg.port}")
            InfoRow("API key", if (cfg.apiKey.isNullOrBlank()) "—" else "•••${cfg.apiKey.takeLast(4)}")
            InfoRow("Printer ID", cfg.id)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.weight(1f))
        Text(
            value,
            style = LocalMobileTextStyles.current.numeric,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

