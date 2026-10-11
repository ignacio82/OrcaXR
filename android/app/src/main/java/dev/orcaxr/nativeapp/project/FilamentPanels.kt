package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.FilamentAssignment
import dev.orcaxr.core.FilamentOption
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectView
import dev.orcaxr.nativeapp.R

/** A colour's swatch: filled with [color] when it is one the swatch can draw, the browser's grey otherwise. */
@Composable
fun FilamentSwatch(color: String, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    val argb = Filaments.argb(color) ?: 0xff808080
    Box(
        modifier.size(size)
            .background(Color(argb), CircleShape)
            .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape),
    )
}

/**
 * The browser's Filaments panel (its Filament tab's heads panel and extra
 * palette colours): one row per filament slot of the project — the slot's
 * colour (tapped to edit it), `H-n` for a printer head or `A-n` for an extra
 * palette colour, the filament's name and type, a head's nozzle and an extra
 * colour's Del — then "+", which adds a slot (refused past sixteen), and
 * "Open virtual filament library", where the project's mixed recipes are
 * authored. Each edit is one undoable "Update slicing
 * configuration". Edits wait for a chosen profile: an opened project slices
 * with its own filaments until one is chosen, as the browser's do.
 */
@Composable
fun FilamentList(
    view: ProjectView,
    profiles: ProfilesView,
    enabled: Boolean,
    onAdd: () -> Unit,
    onRemove: (Int) -> Unit,
    onColor: (Int, String) -> Unit,
    onNozzle: (Int, String) -> Unit,
    onOpenLibrary: () -> Unit,
) {
    if (!profiles.ready) return
    val editable = enabled && profiles.machine != null && !profiles.authored
    var editing by remember { mutableStateOf<Filaments.Slot?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.filament_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            val add = stringResource(R.string.filament_add)
            OutlinedButton(onClick = onAdd, enabled = editable, modifier = Modifier.semantics { contentDescription = add }) { Text("+") }
        }
        for (slot in Filaments.slots(view, profiles.extruders)) {
            Row(
                Modifier.fillMaxWidth().alpha(if (slot.enabled) 1f else 0.6f),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val colour = stringResource(if (slot.head) R.string.filament_head_colour else R.string.filament_palette_colour, slot.number)
                FilamentSwatch(
                    slot.color,
                    size = 28.dp,
                    modifier = Modifier
                        .clickable(enabled = editable) { editing = slot }
                        .semantics { contentDescription = colour; role = Role.Button },
                )
                Text(slot.label, style = MaterialTheme.typography.labelMedium)
                Column(Modifier.weight(1f)) {
                    Text(slot.name, style = MaterialTheme.typography.bodyMedium)
                    if (slot.type.isNotEmpty()) Text(slot.type, style = MaterialTheme.typography.bodySmall)
                }
                if (slot.head) {
                    NozzlePicker(slot, editable) { onNozzle(slot.index, it) }
                } else {
                    val remove = stringResource(R.string.filament_remove_slot, slot.number)
                    TextButton(onClick = { onRemove(slot.index) }, enabled = editable, modifier = Modifier.semantics { contentDescription = remove }) {
                        Text(stringResource(R.string.filament_remove))
                    }
                }
            }
        }
        // The heads panel's last control: the virtual filament library, where mixed recipes are authored.
        OutlinedButton(onClick = onOpenLibrary) { Text(stringResource(R.string.vf_open_library)) }
    }
    editing?.let { slot -> ColourDialog(slot, onClose = { editing = null }) { onColor(slot.index, it) } }
}

/** A head's nozzle: the browser's four choices. */
@Composable
private fun NozzlePicker(slot: Filaments.Slot, enabled: Boolean, onChoose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val description = stringResource(R.string.filament_head_nozzle, slot.number)
    Box {
        OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.semantics { contentDescription = description }) {
            Text(slot.nozzle.orEmpty())
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (nozzle in Filaments.NOZZLES) {
                DropdownMenuItem(text = { Text(nozzle) }, onClick = {
                    open = false
                    if (nozzle != slot.nozzle) onChoose(nozzle)
                })
            }
        }
    }
}

/**
 * A slot's colour, as the browser's colour input edits it: a swatch of the
 * palette's colours or a typed `#rrggbb`, applied in lower case.
 */
@Composable
private fun ColourDialog(slot: Filaments.Slot, onClose: () -> Unit, onApply: (String) -> Unit) {
    var typed by remember(slot) { mutableStateOf(Filaments.picked(slot.color) ?: slot.color) }
    val picked = Filaments.picked(typed)
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(stringResource(if (slot.head) R.string.filament_head_colour else R.string.filament_palette_colour, slot.number)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (swatch in Filaments.SWATCHES) {
                        FilamentSwatch(swatch, size = 36.dp, modifier = Modifier.clickable { typed = swatch }.semantics { contentDescription = swatch })
                    }
                }
                OutlinedTextField(
                    typed, { typed = it },
                    label = { Text(stringResource(R.string.filament_colour_hex)) },
                    singleLine = true,
                    isError = picked == null,
                    leadingIcon = { FilamentSwatch(picked ?: typed) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onClose()
                picked?.let(onApply)
            }, enabled = picked != null) { Text(stringResource(R.string.filament_colour_apply)) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.device_cancel)) } },
    )
}

/**
 * The browser's selection filament bar: shown only while the selection can
 * take a filament, it names what it changes (the one scope, or "n
 * selected"), lists the project's heads and mixed filaments — colour, number
 * and name, the one every scope already prints with pressed — and "Default",
 * which removes the local assignment, each assigning on the first press as
 * one undoable step; then what the last press did.
 */
@Composable
fun SelectionFilamentBar(assignment: FilamentAssignment, status: Filaments.Status?, busy: Boolean, onAssign: (String?, String) -> Unit) {
    if (!Filaments.shown(assignment)) return
    val assigning = busy || status == Filaments.Status.Assigning
    val current = Filaments.uniform(assignment)
    val title = stringResource(R.string.filament_bar_title)
    Column(
        Modifier.fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
            .padding(10.dp)
            .semantics { contentDescription = title },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            Filaments.scopeLabel(assignment) ?: "${assignment.scopes.size} ${stringResource(R.string.filament_bar_selected)}",
            style = MaterialTheme.typography.labelLarge,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val head = stringResource(R.string.filament_bar_head)
            val mixed = stringResource(R.string.filament_bar_mixed)
            for (option in Filaments.chips(assignment)) {
                val describe = chipDescription(option, head, mixed)
                FilterChip(
                    selected = current == Filaments.Choice.Filament(option.id),
                    onClick = { onAssign(option.id, option.name) },
                    enabled = Filaments.chipEnabled(option, assigning),
                    leadingIcon = { FilamentSwatch(option.color, size = 16.dp) },
                    label = {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(Filaments.chipIndex(option), fontWeight = FontWeight.Bold)
                            Text(option.name)
                        }
                    },
                    modifier = Modifier.semantics { contentDescription = describe },
                )
            }
            val default = stringResource(R.string.filament_bar_default)
            val hint = stringResource(R.string.filament_bar_default_hint)
            FilterChip(
                selected = current == Filaments.Choice.Default,
                onClick = { onAssign(null, default) },
                enabled = !assigning,
                label = { Text(default) },
                modifier = Modifier.semantics { contentDescription = "$default · $hint" },
            )
        }
        status?.let { now ->
            val (words, error) = when (now) {
                Filaments.Status.Assigning -> stringResource(R.string.filament_bar_assigning) to false
                is Filaments.Status.Assigned -> "${now.name} ${stringResource(R.string.filament_bar_assigned)}" to false
                Filaments.Status.Cleared -> stringResource(R.string.filament_bar_cleared) to false
                is Filaments.Status.Failed -> now.message to true
            }
            Text(
                words,
                style = MaterialTheme.typography.bodySmall,
                color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A chip's title, as the browser's: "Head n · name", or "Mixed · name", then its warnings. */
private fun chipDescription(option: FilamentOption, head: String, mixed: String): String {
    val who = if (!option.mixed && option.toolId != null) "$head ${option.toolId!! + 1}" else mixed
    return listOf("$who · ${option.name}", option.warnings.joinToString(" ")).filter { it.isNotEmpty() }.joinToString(" · ")
}

/** A tree row's indicators as the browser's Objects panel lists them, its filament with a swatch. */
@Composable
fun TreeIndicators(row: ProjectIntents.ObjectTreeRow) {
    val indicators = Filaments.indicators(row)
    if (indicators.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for ((position, indicator) in indicators.withIndex()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (indicator is Filaments.Indicator.Filament) FilamentSwatch(indicator.color, size = 12.dp)
                val words = when (indicator) {
                    Filaments.Indicator.NotPrintable -> stringResource(R.string.tree_not_printable)
                    is Filaments.Indicator.Role -> indicator.name
                    is Filaments.Indicator.Filament -> when {
                        indicator.mixed -> stringResource(R.string.tree_filament_mixed, indicator.name)
                        indicator.inherited -> stringResource(R.string.tree_filament_inherited, indicator.name)
                        else -> indicator.name
                    }
                    is Filaments.Indicator.ColorFacets -> stringResource(R.string.tree_color_facets, indicator.count.toString())
                    is Filaments.Indicator.SupportFacets -> stringResource(R.string.tree_support_facets, indicator.count.toString())
                    is Filaments.Indicator.Settings -> stringResource(R.string.tree_settings, indicator.count.toString())
                }
                Text(if (position < indicators.size - 1) "$words ·" else words, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
