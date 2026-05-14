package dev.orcaxr.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.OrcaProfileLoader
import dev.orcaxr.app.SlicerProfile

/**
 * OrcaSlicer-style three-dropdown picker: Printer (with nozzle),
 * Process (resolution / layer height tier), Material.
 *
 * Backed by the existing flat [SlicerProfile] catalog — each catalog
 * row carries `machineName` / `processName` / `filamentName` metadata,
 * and we pivot on those three fields to produce three independent
 * dropdowns. When the user changes any one dropdown, the others
 * narrow to keep the (m, p, f) selection internally consistent: a
 * unique catalog row falls out the bottom and becomes [selected].
 *
 * "Resolution" reads the row's `layer_height` so a user looking at
 * "0.20 Standard" / "0.12 Fine" sees the actual layer height too —
 * mirrors OrcaSlicer's process dropdown which surfaces "0.20 mm
 * Standard" rather than the bare codename.
 *
 * This composable owns NONE of the persisted state — caller hoists
 * `selected` + `onSelect` so it can drop the same component into
 * mobile (SlicerScreen) and XR (MainActivity DevicesPanel) without
 * duplicate DataStore writes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrinterProcessFilamentPicker(
    profiles: List<SlicerProfile>,
    selected: SlicerProfile?,
    enabled: Boolean,
    onSelect: (SlicerProfile) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (profiles.isEmpty()) {
        Text(
            "No slicer profiles available",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
            modifier = modifier,
        )
        return
    }

    val printers = remember(profiles) { distinctPrinters(profiles) }
    val selectedPrinter = selected?.machineName ?: printers.firstOrNull() ?: ""

    val processes = remember(profiles, selectedPrinter) {
        distinctProcessesFor(profiles, selectedPrinter)
    }
    val selectedProcess = selected?.let { p -> processForRow(p) }
        ?: processes.firstOrNull() ?: ""

    val filaments = remember(profiles, selectedPrinter, selectedProcess) {
        distinctFilamentsFor(profiles, selectedPrinter, selectedProcess)
    }
    val selectedFilament = selected?.filamentName ?: filaments.firstOrNull() ?: ""

    fun pick(printer: String, process: String, filament: String) {
        val row = profiles.firstOrNull {
            (it.machineName ?: "") == printer &&
                processForRow(it) == process &&
                (it.filamentName ?: "") == filament
        }
            // Fall through any axis if the exact combination doesn't
            // exist (e.g. user picked a printer that has no Process
            // matching their previous selection) so the dropdown
            // never strands on an unselectable state.
            ?: profiles.firstOrNull {
                (it.machineName ?: "") == printer &&
                    processForRow(it) == process
            }
            ?: profiles.firstOrNull { (it.machineName ?: "") == printer }
            ?: profiles.firstOrNull()
        if (row != null) onSelect(row)
    }

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LabeledDropdown(
            label = "Printer / Nozzle",
            value = displayPrinterName(selected, selectedPrinter),
            options = printers,
            optionLabel = ::displayPrinterText,
            enabled = enabled && printers.size > 1,
            onPick = { picked -> pick(picked, selectedProcess, selectedFilament) },
        )
        LabeledDropdown(
            label = "Resolution",
            value = displayProcessName(selected, selectedProcess),
            options = processes,
            optionLabel = { it },
            enabled = enabled && processes.size > 1,
            onPick = { picked -> pick(selectedPrinter, picked, selectedFilament) },
        )
        LabeledDropdown(
            label = "Material",
            value = displayFilamentName(selected, selectedFilament),
            options = filaments,
            optionLabel = { it },
            enabled = enabled && filaments.size > 1,
            onPick = { picked -> pick(selectedPrinter, selectedProcess, picked) },
        )
        // Show the resolved row's quick description (layer height,
        // infill, temps) so the user sees what their three picks
        // actually compose to. Matches what the old single dropdown
        // surfaced beneath the chip.
        if (selected != null) {
            Text(
                selected.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LabeledDropdown(
    label: String,
    value: String,
    options: List<String>,
    optionLabel: (String) -> String,
    enabled: Boolean,
    onPick: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = !expanded },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = optionLabel(value),
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            singleLine = true,
            label = { Text(label) },
            trailingIcon = {
                ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled)
            },
            modifier = Modifier
                .menuAnchor(androidx.compose.material3.MenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (opt in options) {
                DropdownMenuItem(
                    text = { Text(optionLabel(opt)) },
                    onClick = {
                        expanded = false
                        onPick(opt)
                    },
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }
    }
}

private fun distinctPrinters(profiles: List<SlicerProfile>): List<String> =
    profiles
        .mapNotNull { it.machineName }
        .distinct()
        .sorted()

private fun distinctProcessesFor(
    profiles: List<SlicerProfile>,
    printer: String,
): List<String> = profiles
    .filter { (it.machineName ?: "") == printer }
    .map { processForRow(it) }
    .distinct()
    .sortedBy { sortKeyForProcess(it) }

private fun distinctFilamentsFor(
    profiles: List<SlicerProfile>,
    printer: String,
    process: String,
): List<String> = profiles
    .filter { (it.machineName ?: "") == printer && processForRow(it) == process }
    .mapNotNull { it.filamentName }
    .distinct()
    .sorted()

private fun processForRow(p: SlicerProfile): String {
    val raw = p.processName?.substringBefore('@')?.trim() ?: return ""
    // Surface the layer height alongside the codename so the user
    // sees "0.20 Standard (0.20 mm)" — matches OrcaSlicer's process
    // dropdown convention.
    val lh = p.config["layer_height"]
    return if (lh != null && !raw.contains(lh)) "$raw · ${lh} mm" else raw
}

private fun sortKeyForProcess(label: String): Double {
    // Pull the layer height number out of the label so the dropdown
    // orders from finest (0.08) to coarsest (0.36) regardless of
    // how the upstream profile names them.
    val match = Regex("""(\d+\.\d+)""").find(label)
    return match?.groupValues?.get(1)?.toDoubleOrNull() ?: Double.MAX_VALUE
}

private fun displayPrinterName(p: SlicerProfile?, fallback: String): String =
    p?.machineName ?: fallback

private fun displayPrinterText(machineName: String): String =
    machineName

private fun displayProcessName(p: SlicerProfile?, fallback: String): String =
    p?.let(::processForRow) ?: fallback

private fun displayFilamentName(p: SlicerProfile?, fallback: String): String =
    p?.filamentName ?: fallback
