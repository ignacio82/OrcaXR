package dev.orcaxr.nativeapp.prepare

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.PresetOption
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProfilesView

/**
 * The browser's profile pickers: Printer, Process and Filament — one
 * filament per head on a printer with several (the browser keeps those, and
 * the palette's further colours, on its Filament tab) — over the catalog, with the
 * selection's own messages. With nothing chosen a picker says the project's
 * own settings are in use, never showing a printer nobody chose; an empty
 * list says no preset fits.
 */
@Composable
fun ProfilePickers(
    profiles: ProfilesView,
    enabled: Boolean,
    onMachine: (String) -> Unit,
    onProcess: (String) -> Unit,
    onFilament: (Int, String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        profiles.failure?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            return@Column
        }
        if (!profiles.ready) return@Column
        Picker(stringResource(R.string.prepare_printer), profiles.machines, profiles.machine, enabled, onMachine)
        Picker(stringResource(R.string.prepare_process), profiles.processes, profiles.process, enabled, onProcess)
        // As the browser: one printer head has the Filament picker, several have one each.
        if (profiles.extruders <= 1) {
            Picker(stringResource(R.string.prepare_filament), profiles.filaments, profiles.heads.firstOrNull(), enabled) { onFilament(0, it) }
        } else {
            for (index in 0 until profiles.extruders) {
                Picker(stringResource(R.string.prepare_head_filament, index + 1), profiles.filaments, profiles.heads.getOrNull(index), enabled) {
                    onFilament(index, it)
                }
            }
        }
        for (message in profiles.status) {
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = if (profiles.warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Picker(label: String, options: List<PresetOption>, selected: String?, enabled: Boolean, onChoose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val usable = enabled && options.isNotEmpty()
    val shown = when {
        options.isEmpty() -> stringResource(R.string.prepare_no_presets)
        else -> options.firstOrNull { it.id == selected }?.label ?: stringResource(R.string.prepare_own_settings)
    }
    ExposedDropdownMenuBox(expanded = open && usable, onExpandedChange = { open = it && usable }) {
        OutlinedTextField(
            value = shown,
            onValueChange = {},
            readOnly = true,
            enabled = usable,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open && usable) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable, usable),
        )
        ExposedDropdownMenu(expanded = open && usable, onDismissRequest = { open = false }) {
            for (option in options) {
                DropdownMenuItem(
                    text = { Text(option.label) },
                    onClick = {
                        open = false
                        if (option.id != selected) onChoose(option.id)
                    },
                )
            }
        }
    }
}
