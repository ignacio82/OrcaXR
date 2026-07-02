package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.FilamentEntry
import dev.orcaxr.app.MoonrakerClient
import dev.orcaxr.app.MoonrakerResult
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.mobile.ColorSwatch
import dev.orcaxr.app.mobile.EmptyStateCard
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.mobilePhysicalSlotCount
import dev.orcaxr.app.mobile.parseHex
import kotlinx.coroutines.launch

/**
 * Filament inventory — per-printer slot manager. Each row shows the
 * spool's color, label, and material. Tap to edit color or material.
 *
 * Tablet: two-column when there are >4 slots. Phone: single column.
 *
 * The Snapmaker U1 (4-toolchanger) and Centauri Carbon (single-extruder)
 * are wired through the same shape — the difference is just the count.
 */
@Composable
fun FilamentScreen(isTablet: Boolean) {
    val app = LocalMobileAppState.current
    val printers by app.printers.printers.collectAsState(initial = emptyList())
    var selectedId by remember(printers) {
        mutableStateOf(app.prefs.lastPrinterId ?: printers.firstOrNull()?.id)
    }
    val active = printers.firstOrNull { it.id == selectedId } ?: printers.firstOrNull()

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Filament",
            subtitle = active?.name?.let { "Slots · $it" } ?: "No printer",
        )

        if (active == null) {
            Box(Modifier.fillMaxSize().padding(20.dp)) {
                EmptyStateCard(
                    title = "No printer",
                    body = "Filament inventory is per-printer. Add one in onboarding to start tracking spools.",
                )
            }
        } else {
            FilamentSlots(active, isTablet)
        }
    }
}

@Composable
private fun FilamentSlots(active: PrinterConfig, isTablet: Boolean) {
    val app = LocalMobileAppState.current
    val scope = rememberCoroutineScope()
    val slotsAll by app.filamentSlots.all.collectAsState(initial = emptyMap())
    val entriesAll by app.filamentEntries.all.collectAsState(initial = emptyMap())

    val savedColors = slotsAll[active.id]
    val savedEntries = entriesAll[active.id].orEmpty()
    val defaultSlotCount = remember(active, savedColors) {
        mobilePhysicalSlotCount(
            printer = active,
            profile = null,
            savedPhysicalColors = savedColors,
        )
    }

    // Slot count is the physical printer inventory only. Project
    // FilamentEntry rows may be longer when a 3MF carries more authored
    // colors than the printer has loaded tools.
    var slotCount by remember(active.id) {
        mutableStateOf(defaultSlotCount)
    }

    LaunchedEffect(active.id, defaultSlotCount) {
        slotCount = defaultSlotCount
    }

    // Build effective slot list: prefer FilamentEntry, fall back to
    // padded slot colors from the legacy store.
    val padded = remember(savedColors, slotCount) { app.filamentSlots.pad(savedColors, slotCount) }
    val effective = remember(savedEntries, padded, slotCount) {
        (0 until slotCount).map { idx ->
            val entry = savedEntries.firstOrNull { it.slotIndex == idx }
            entry ?: FilamentEntry(
                id = "auto_$idx",
                color = padded.getOrNull(idx) ?: "#FFFFFF",
                slotIndex = idx,
                filamentType = "Generic PLA",
            )
        }
    }

    var editingSlot by remember { mutableStateOf<Int?>(null) }
    var probingPrinter by remember { mutableStateOf(false) }
    var probedSlots by remember { mutableStateOf<List<String>?>(null) }
    var probeError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(active.id) {
        // Probe the printer's loaded filaments once on entry — gives
        // us an authoritative view if Klipper's print_task_config is
        // wired up. Failures are silent (offline printer).
        probingPrinter = true
        val r = MoonrakerClient(active).queryFilamentSlots()
        probingPrinter = false
        when (r) {
            is MoonrakerResult.Ok -> {
                probedSlots = r.value.map { it.colorHex }
                probeError = null
            }
            is MoonrakerResult.HttpError -> probeError = "HTTP ${r.code}"
            is MoonrakerResult.IoError -> probeError = "Offline"
            else -> probeError = "Unavailable"
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (probedSlots != null && probedSlots!!.isNotEmpty()) {
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionKicker("Loaded on printer")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((i, hex) in probedSlots!!.withIndex()) {
                            ColorSwatch(hex = hex, label = "T$i", size = 36.dp)
                        }
                    }
                }
            }
        }
        MobileCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionKicker("Printer slots")
                    Spacer(Modifier.weight(1f))
                    SlotCountStepper(slotCount, onChange = {
                        slotCount = it.coerceIn(1, 8)
                    })
                }
                if (isTablet) {
                    val rows = effective.chunked(2)
                    for (chunk in rows) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            for ((i, e) in chunk.withIndex()) {
                                Box(Modifier.weight(1f)) {
                                    SlotRow(idx = effective.indexOf(e), entry = e, onClick = { editingSlot = effective.indexOf(e) })
                                }
                            }
                            if (chunk.size == 1) Box(Modifier.weight(1f))
                        }
                    }
                } else {
                    for ((i, e) in effective.withIndex()) {
                        SlotRow(idx = i, entry = e, onClick = { editingSlot = i })
                    }
                }
            }
        }
        if (probeError != null) {
            Text(
                "Printer probe: $probeError",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    val editingIdx = editingSlot
    if (editingIdx != null) {
        EditSlotDialog(
            slotIndex = editingIdx,
            current = effective.getOrNull(editingIdx) ?: return,
            onDismiss = { editingSlot = null },
            onSave = { updated ->
                scope.launch {
                    val newList = (0 until slotCount).map { i ->
                        if (i == editingIdx) updated.copy(slotIndex = i)
                        else effective.getOrNull(i)?.copy(slotIndex = i) ?: FilamentEntry(
                            id = "auto_$i",
                            color = "#FFFFFF",
                            slotIndex = i,
                        )
                    }
                    val preservedProjectRows = savedEntries.filter { (it.slotIndex ?: -1) >= slotCount }
                    app.filamentEntries.set(active.id, newList + preservedProjectRows)
                    // Mirror into legacy slots store for any code path
                    // that still reads colors from there (XR shell does).
                    app.filamentSlots.set(active.id, newList.map { it.color })
                }
                editingSlot = null
            },
        )
    }
}

@Composable
private fun SlotRow(idx: Int, entry: FilamentEntry, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ColorSwatch(hex = entry.color, size = 40.dp, showLabel = false)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Slot T$idx", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                Text(
                    entry.filamentType,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                entry.color.uppercase(),
                style = LocalMobileTextStyles.current.numeric,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SlotCountStepper(value: Int, onChange: (Int) -> Unit) {
    Row(
        Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = { onChange(value - 1) }) { Text("−") }
        Text("$value slots", style = LocalMobileTextStyles.current.numeric, color = MaterialTheme.colorScheme.onSurface)
        TextButton(onClick = { onChange(value + 1) }) { Text("+") }
    }
}

@Composable
private fun EditSlotDialog(
    slotIndex: Int,
    current: FilamentEntry,
    onDismiss: () -> Unit,
    onSave: (FilamentEntry) -> Unit,
) {
    var color by remember { mutableStateOf(current.color) }
    var material by remember { mutableStateOf(current.filamentType) }

    val swatches = listOf(
        "#FF6B00", "#FFD27B", "#7BFFB1", "#7BC8FF",
        "#C77DFF", "#FF7B7B", "#FFFFFF", "#1B1F23",
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Slot T$slotIndex") },
        confirmButton = {
            Button(onClick = { onSave(current.copy(color = color, filamentType = material)) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionKicker("Color")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (sw in swatches) {
                        val sel = sw.equals(color, ignoreCase = true)
                        Box(
                            Modifier
                                .size(36.dp)
                                .background(parseHex(sw) ?: MaterialTheme.colorScheme.surface, CircleShape)
                                .border(
                                    if (sel) 3.dp else 1.dp,
                                    if (sel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                                    CircleShape,
                                )
                                .clickable { color = sw },
                        )
                    }
                }
                OutlinedTextField(
                    value = color,
                    onValueChange = { color = it },
                    label = { Text("Hex") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = material,
                    onValueChange = { material = it },
                    label = { Text("Material") },
                    placeholder = { Text("Generic PLA / PETG / ABS …") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
    )
}
