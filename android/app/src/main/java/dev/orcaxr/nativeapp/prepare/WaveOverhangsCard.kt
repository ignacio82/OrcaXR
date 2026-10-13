package dev.orcaxr.nativeapp.prepare

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ActionTooltip

/**
 * The Wave Overhangs Card: every option the engine's wave-overhang port defines,
 * laid out as upstream's own page and drawn from the shared table in [WaveOverhangs].
 * Displayed directly inside the Process section of the Prepare area, adjacent to
 * wipe tower auto-placement.
 */
@Composable
fun WaveOverhangsCard(project: ProjectModel, modifier: Modifier = Modifier) {
    LaunchedEffect(project.view.revision) {
        project.refreshWaveSettings()
    }

    val state = project.waveSettings ?: return
    var expanded by rememberSaveable { mutableStateOf(true) }
    var openGroups by remember { mutableStateOf(WaveOptionGroup.OPEN_BY_DEFAULT) }
    var aboutOpen by rememberSaveable { mutableStateOf(false) }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Header Row
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = if (expanded) "▾" else "▸",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = stringResource(R.string.wave_title),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                    Surface(
                        shape = MaterialTheme.shapes.small,
                        color = MaterialTheme.colorScheme.tertiaryContainer,
                    ) {
                        Text(
                            text = stringResource(R.string.wave_experimental),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onTertiaryContainer,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }

                if (state.hasOverrides) {
                    ActionTooltip(stringResource(R.string.wave_reset_hint)) {
                        TextButton(
                            onClick = project::resetWaveSettings,
                            enabled = !project.busy,
                        ) {
                            Text(stringResource(R.string.wave_reset))
                        }
                    }
                }
            }

            AnimatedVisibility(visible = expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    // Master Switch
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .toggleable(
                                value = state.enabled,
                                enabled = !project.busy,
                                role = Role.Switch,
                                onValueChange = { project.setWaveSetting(WaveOverhangs.MASTER_KEY, it) },
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Switch(
                            checked = state.enabled,
                            onCheckedChange = null,
                            enabled = !project.busy,
                        )
                        Text(
                            text = stringResource(R.string.wave_master_label),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                        )
                    }

                    // Notices
                    for (notice in state.notices) {
                        Surface(
                            shape = MaterialTheme.shapes.small,
                            color = MaterialTheme.colorScheme.errorContainer,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                modifier = Modifier.padding(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = stringResource(notice.messageRes),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                    modifier = Modifier.weight(1f),
                                )
                                if (notice.fixId != null) {
                                    Spacer(Modifier.width(8.dp))
                                    OutlinedButton(
                                        onClick = { project.fixWaveNotice(notice.fixId) },
                                        enabled = !project.busy,
                                    ) {
                                        Text(stringResource(notice.fixRes ?: R.string.wave_notice_turn_on))
                                    }
                                }
                            }
                        }
                    }

                    // Option Groups (visible when master switch is enabled)
                    if (state.enabled) {
                        for (group in WaveOptionGroup.ALL) {
                            val entries = state.options.filter {
                                it.option.group === group && it.option.key != WaveOverhangs.MASTER_KEY && it.applies
                            }
                            if (entries.isNotEmpty()) {
                                val isOpen = openGroups.contains(group)
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 2.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                openGroups = if (isOpen) openGroups - group else openGroups + group
                                            }
                                            .padding(vertical = 4.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        Text(
                                            text = if (isOpen) "▾" else "▸",
                                            style = MaterialTheme.typography.labelLarge,
                                        )
                                        Text(
                                            text = stringResource(group.labelRes),
                                            style = MaterialTheme.typography.labelLarge,
                                            fontWeight = FontWeight.SemiBold,
                                        )
                                    }

                                    AnimatedVisibility(visible = isOpen) {
                                        Column(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(start = 12.dp),
                                            verticalArrangement = Arrangement.spacedBy(8.dp),
                                        ) {
                                            for (optState in entries) {
                                                WaveOptionRow(
                                                    state = optState,
                                                    busy = project.busy,
                                                    onSet = { project.setWaveSetting(optState.option.key, it) },
                                                    onClear = { project.clearWaveSetting(optState.option.key) },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // About section
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { aboutOpen = !aboutOpen }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(
                                text = if (aboutOpen) "▾" else "▸",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                text = stringResource(R.string.wave_about),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }

                        AnimatedVisibility(visible = aboutOpen) {
                            Column(
                                modifier = Modifier.padding(start = 12.dp, top = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    text = stringResource(R.string.wave_about_how),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Text(
                                    text = stringResource(R.string.wave_about_material),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Text(
                                    text = stringResource(R.string.wave_about_span),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Text(
                                    text = stringResource(R.string.wave_about_floor),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WaveOptionRow(
    state: WaveOptionState,
    busy: Boolean,
    onSet: (Any) -> Unit,
    onClear: () -> Unit,
) {
    val option = state.option
    val disabled = busy || option.inert

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(option.labelRes) + (option.unit?.let { " ($it)" } ?: ""),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(state.source.labelRes),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                when (option.kind) {
                    WaveOptionKind.BOOL -> {
                        Switch(
                            checked = state.value == true,
                            onCheckedChange = onSet,
                            enabled = !disabled,
                        )
                    }
                    WaveOptionKind.ENUM -> {
                        EnumSelector(
                            value = state.value.toString(),
                            choices = option.choices ?: emptyList(),
                            enabled = !disabled,
                            onSelect = onSet,
                        )
                    }
                    WaveOptionKind.INT -> {
                        NumberField(
                            value = state.value.toString(),
                            isInteger = true,
                            enabled = !disabled,
                            onCommit = { onSet(it.toInt()) },
                        )
                    }
                    WaveOptionKind.FLOAT -> {
                        NumberField(
                            value = state.value.toString(),
                            isInteger = false,
                            enabled = !disabled,
                            onCommit = { onSet(it.toDouble()) },
                        )
                    }
                }

                if (state.source == WaveValueSource.OVERRIDE) {
                    ActionTooltip(stringResource(R.string.wave_clear)) {
                        IconButton(
                            onClick = onClear,
                            enabled = !busy,
                            modifier = Modifier.size(24.dp),
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_symbol_undo),
                                contentDescription = stringResource(R.string.wave_clear),
                                modifier = Modifier.size(16.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EnumSelector(
    value: String,
    choices: List<String>,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    OutlinedButton(
        onClick = { expanded = true },
        enabled = enabled,
    ) {
        Text(stringResource(WaveOverhangs.choiceLabelRes(value)))
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            for (choice in choices) {
                DropdownMenuItem(
                    text = { Text(stringResource(WaveOverhangs.choiceLabelRes(choice))) },
                    onClick = {
                        expanded = false
                        onSelect(choice)
                    },
                )
            }
        }
    }
}

@Composable
private fun NumberField(
    value: String,
    isInteger: Boolean,
    enabled: Boolean,
    onCommit: (String) -> Unit,
) {
    var draft by remember(value) { mutableStateOf(value) }

    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (isInteger) KeyboardType.Number else KeyboardType.Decimal,
        ),
        modifier = Modifier.width(90.dp),
        textStyle = MaterialTheme.typography.bodySmall,
    )

    LaunchedEffect(draft) {
        if (draft != value) {
            val parsed = if (isInteger) draft.toIntOrNull() else draft.toDoubleOrNull()
            if (parsed != null) {
                onCommit(draft)
            }
        }
    }
}
