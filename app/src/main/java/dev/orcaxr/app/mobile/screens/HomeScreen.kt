package dev.orcaxr.app.mobile.screens

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Architecture
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.MoonrakerClient
import dev.orcaxr.app.MoonrakerResult
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.PrintSnapshot
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileDestination
import dev.orcaxr.app.mobile.MobileProgress
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.StatusPill
import dev.orcaxr.app.mobile.formatDurationCompact
import kotlinx.coroutines.delay

/**
 * Workshop dashboard. Shows every configured printer with its live
 * Moonraker snapshot (state, temps, progress). Tablet uses two
 * columns when there's >1 printer; phone is single-column.
 *
 * Quick-action grid below routes the user into Slicer / Files /
 * Monitor — the three high-frequency entry points.
 */
@Composable
fun HomeScreen(
    isTablet: Boolean,
    onNavigate: (MobileDestination) -> Unit,
) {
    val app = LocalMobileAppState.current
    val printers by app.printers.printers.collectAsState(initial = emptyList())
    val snapshots = remember { mutableStateMapOf<String, PrintSnapshot?>() }

    // Poll every 5 s while the screen is composed.
    LaunchedEffect(printers.map { it.id }) {
        while (true) {
            for (p in printers) {
                val client = MoonrakerClient(p)
                snapshots[p.id] = (client.queryStatus() as? MoonrakerResult.Ok)?.value
            }
            delay(5_000)
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "OrcaXR",
            subtitle = "Workshop · ${printers.size} printer${if (printers.size == 1) "" else "s"}",
        )
        LazyColumn(
            contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionKicker("Quick start")
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        QuickAction(
                            label = "Slice",
                            icon = Icons.Outlined.Architecture,
                            onClick = { onNavigate(MobileDestination.Slicer) },
                            modifier = Modifier.weight(1f),
                        )
                        QuickAction(
                            label = "Files",
                            icon = Icons.Outlined.Folder,
                            onClick = { onNavigate(MobileDestination.Files) },
                            modifier = Modifier.weight(1f),
                        )
                        QuickAction(
                            label = "Monitor",
                            icon = Icons.Outlined.Videocam,
                            onClick = { onNavigate(MobileDestination.Monitor) },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
            item { SectionKicker("Printers") }

            if (isTablet) {
                // Two-column on tablet
                items(printers.chunked(2)) { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        for (p in row) {
                            Box(Modifier.weight(1f)) {
                                PrinterCard(
                                    cfg = p,
                                    snap = snapshots[p.id],
                                    onMonitor = { onNavigate(MobileDestination.Monitor) },
                                )
                            }
                        }
                        if (row.size == 1) Box(Modifier.weight(1f))
                    }
                }
            } else {
                items(printers) { p ->
                    PrinterCard(
                        cfg = p,
                        snap = snapshots[p.id],
                        onMonitor = { onNavigate(MobileDestination.Monitor) },
                    )
                }
            }
        }
    }
}

@Composable
private fun QuickAction(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    androidx.compose.material3.Surface(
        modifier = modifier.height(110.dp),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
        onClick = onClick,
    ) {
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Box(
                Modifier
                    .size(38.dp)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = label, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            }
            Text(
                label,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}

@Composable
private fun PrinterCard(
    cfg: PrinterConfig,
    snap: PrintSnapshot?,
    onMonitor: () -> Unit,
) {
    val state = snap?.state ?: "offline"
    val (statusLabel, statusColor) = when (state) {
        "printing" -> "Printing" to MaterialTheme.colorScheme.primary
        "paused" -> "Paused" to MaterialTheme.colorScheme.tertiary
        "complete" -> "Complete" to MaterialTheme.colorScheme.primary
        "cancelled" -> "Cancelled" to MaterialTheme.colorScheme.error
        "error" -> "Error" to MaterialTheme.colorScheme.error
        "standby" -> "Idle" to MaterialTheme.colorScheme.secondary
        else -> "Offline" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    MobileCard(onClick = onMonitor) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        cfg.name,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "${cfg.host}:${cfg.port}",
                        style = LocalMobileTextStyles.current.numeric,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusPill(statusLabel, statusColor)
            }
            if (snap != null && snap.isActive) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        snap.filename.ifBlank { "Untitled job" },
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    MobileProgress(progress = snap.progress)
                    Row {
                        Text(
                            "${(snap.progress * 100).toInt()}%",
                            style = LocalMobileTextStyles.current.numeric,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.weight(1f))
                        Text(
                            "ETA ${formatDurationCompact(snap.etaSec)}",
                            style = LocalMobileTextStyles.current.numeric,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                TempCell("Nozzle", snap?.nozzleTemp, snap?.nozzleTarget)
                TempCell("Bed", snap?.bedTemp, snap?.bedTarget)
                if (snap?.currentLayer != null && snap.totalLayers != null) {
                    Column {
                        Text(
                            "LAYER",
                            style = LocalMobileTextStyles.current.sectionLabel,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "${snap.currentLayer} / ${snap.totalLayers}",
                            style = LocalMobileTextStyles.current.numeric,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TempCell(label: String, current: Float?, target: Float?) {
    Column {
        Text(
            label.uppercase(),
            style = LocalMobileTextStyles.current.sectionLabel,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            buildString {
                append((current ?: 0f).toInt())
                append("°")
                if ((target ?: 0f) > 0f) {
                    append(" / ${target?.toInt()}°")
                }
            },
            style = LocalMobileTextStyles.current.numeric,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
