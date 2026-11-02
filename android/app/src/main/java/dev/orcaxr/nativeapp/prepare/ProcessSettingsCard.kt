package dev.orcaxr.nativeapp.prepare

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import dev.orcaxr.nativeapp.project.InspectorPanel
import dev.orcaxr.nativeapp.project.ProjectModel

/**
 * The Process & Slicing Settings card: exposes essential slicing adjustments
 * (Brim / Bed Adhesion, Supports, Infill, Walls) directly in the Prepare screen,
 * exactly matching desktop OrcaSlicer's Process section and the browser's Process card.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProcessSettingsCard(project: ProjectModel, modifier: Modifier = Modifier) {
    LaunchedEffect(project.view.revision) {
        project.refreshPrintSettings()
    }

    val settings = project.printSettings
    var expanded by rememberSaveable { mutableStateOf(true) }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
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
                        text = stringResource(R.string.prepare_process_settings),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                    Surface(
                        shape = MaterialTheme.shapes.small,
                        color = if (settings.hasOverrides) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.outlineVariant,
                    ) {
                        Text(
                            text = if (settings.hasOverrides) {
                                stringResource(R.string.settings_badge_overrides, settings.totalOverridesCount)
                            } else {
                                stringResource(R.string.settings_badge_profile)
                            },
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (settings.hasOverrides) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (settings.hasOverrides) {
                        TextButton(onClick = project::resetPrintSettings) {
                            Text(stringResource(R.string.settings_reset_overrides), style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    OutlinedButton(onClick = { project.inspector.open(InspectorPanel.Settings("project")) }) {
                        Text(stringResource(R.string.prepare_all_settings), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }

            AnimatedVisibility(visible = expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // ---- Section 1: Brim / Bed Adhesion ----
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                            Text(
                                text = stringResource(R.string.settings_group_brim),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.semantics { heading() },
                            )

                            // Prominent One-Tap Disable / Enable Brim Button
                            if (settings.isBrimDisabled) {
                                Button(
                                    onClick = { project.setPrintSetting(ProcessSettings.KEY_BRIM_TYPE, ProcessSettings.BRIM_TYPE_AUTO) },
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                                ) {
                                    Text(stringResource(R.string.settings_brim_enable), style = MaterialTheme.typography.labelSmall)
                                }
                            } else {
                                OutlinedButton(
                                    onClick = { project.setPrintSetting(ProcessSettings.KEY_BRIM_TYPE, ProcessSettings.BRIM_TYPE_NO_BRIM) },
                                ) {
                                    Text(stringResource(R.string.settings_brim_disable), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }

                        // Brim Type Dropdown
                        var brimMenuOpen by remember { mutableStateOf(false) }
                        val currentBrimLabelRes = ProcessSettings.BRIM_TYPES.firstOrNull { it.first == settings.brimType }?.second
                            ?: R.string.settings_brim_type_auto

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = stringResource(R.string.settings_brim_type),
                                modifier = Modifier.width(100.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Row(modifier = Modifier.weight(1f)) {
                                OutlinedButton(
                                    onClick = { brimMenuOpen = true },
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Text(stringResource(currentBrimLabelRes), Modifier.weight(1f))
                                    Text("▾")
                                }
                                DropdownMenu(
                                    expanded = brimMenuOpen,
                                    onDismissRequest = { brimMenuOpen = false },
                                ) {
                                    for ((typeKey, labelRes) in ProcessSettings.BRIM_TYPES) {
                                        DropdownMenuItem(
                                            text = {
                                                Text(
                                                    stringResource(labelRes),
                                                    fontWeight = if (typeKey == settings.brimType) FontWeight.Bold else FontWeight.Normal,
                                                )
                                            },
                                            onClick = {
                                                brimMenuOpen = false
                                                project.setPrintSetting(ProcessSettings.KEY_BRIM_TYPE, typeKey)
                                            },
                                        )
                                    }
                                }
                            }
                        }

                        // Brim Width (only active when brim is enabled)
                        if (!settings.isBrimDisabled) {
                            var widthText by remember(settings.brimWidthMm) { mutableStateOf(settings.brimWidthMm.toString()) }
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = stringResource(R.string.settings_brim_width),
                                    modifier = Modifier.width(100.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                OutlinedTextField(
                                    value = widthText,
                                    onValueChange = { input ->
                                        widthText = input
                                        input.toDoubleOrNull()?.let {
                                            project.setPrintSetting(ProcessSettings.KEY_BRIM_WIDTH, it)
                                        }
                                    },
                                    suffix = { Text("mm") },
                                    singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                    // ---- Section 2: Supports ----
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier
                                .fillMaxWidth()
                                .toggleable(
                                    value = settings.enableSupport,
                                    role = Role.Switch,
                                    onValueChange = { project.setPrintSetting(ProcessSettings.KEY_ENABLE_SUPPORT, if (it) "1" else "0") },
                                ),
                        ) {
                            Text(
                                text = stringResource(R.string.settings_support_enable),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.semantics { heading() },
                            )
                            Switch(
                                checked = settings.enableSupport,
                                onCheckedChange = null,
                            )
                        }

                        if (settings.enableSupport) {
                            // Support Type Dropdown
                            var typeMenuOpen by remember { mutableStateOf(false) }
                            val currentTypeLabelRes = ProcessSettings.SUPPORT_TYPES.firstOrNull { it.first == settings.supportType }?.second
                                ?: R.string.settings_support_type_normal_auto

                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = stringResource(R.string.settings_support_type),
                                    modifier = Modifier.width(100.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Row(modifier = Modifier.weight(1f)) {
                                    OutlinedButton(
                                        onClick = { typeMenuOpen = true },
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Text(stringResource(currentTypeLabelRes), Modifier.weight(1f))
                                        Text("▾")
                                    }
                                    DropdownMenu(
                                        expanded = typeMenuOpen,
                                        onDismissRequest = { typeMenuOpen = false },
                                    ) {
                                        for ((typeKey, labelRes) in ProcessSettings.SUPPORT_TYPES) {
                                            DropdownMenuItem(
                                                text = {
                                                    Text(
                                                        stringResource(labelRes),
                                                        fontWeight = if (typeKey == settings.supportType) FontWeight.Bold else FontWeight.Normal,
                                                    )
                                                },
                                                onClick = {
                                                    typeMenuOpen = false
                                                    project.setPrintSetting(ProcessSettings.KEY_SUPPORT_TYPE, typeKey)
                                                },
                                            )
                                        }
                                    }
                                }
                            }

                            // Support Style Dropdown
                            var styleMenuOpen by remember { mutableStateOf(false) }
                            val currentStyleLabelRes = ProcessSettings.SUPPORT_STYLES.firstOrNull { it.first == settings.supportStyle }?.second
                                ?: R.string.settings_support_style_default

                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = stringResource(R.string.settings_support_style),
                                    modifier = Modifier.width(100.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Row(modifier = Modifier.weight(1f)) {
                                    OutlinedButton(
                                        onClick = { styleMenuOpen = true },
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Text(stringResource(currentStyleLabelRes), Modifier.weight(1f))
                                        Text("▾")
                                    }
                                    DropdownMenu(
                                        expanded = styleMenuOpen,
                                        onDismissRequest = { styleMenuOpen = false },
                                    ) {
                                        for ((styleKey, labelRes) in ProcessSettings.SUPPORT_STYLES) {
                                            DropdownMenuItem(
                                                text = {
                                                    Text(
                                                        stringResource(labelRes),
                                                        fontWeight = if (styleKey == settings.supportStyle) FontWeight.Bold else FontWeight.Normal,
                                                    )
                                                },
                                                onClick = {
                                                    styleMenuOpen = false
                                                    project.setPrintSetting(ProcessSettings.KEY_SUPPORT_STYLE, styleKey)
                                                },
                                            )
                                        }
                                    }
                                }
                            }

                            // On build plate only
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .toggleable(
                                        value = settings.supportOnBuildPlateOnly,
                                        role = Role.Switch,
                                        onValueChange = { project.setPrintSetting(ProcessSettings.KEY_SUPPORT_ON_BUILD_PLATE_ONLY, if (it) "1" else "0") },
                                    ),
                            ) {
                                Text(
                                    text = stringResource(R.string.settings_support_on_plate_only),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Switch(
                                    checked = settings.supportOnBuildPlateOnly,
                                    onCheckedChange = null,
                                )
                            }
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                    // ---- Section 3: Infill & Quality ----
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = stringResource(R.string.settings_group_quality_infill),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.semantics { heading() },
                        )

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            var infillText by remember(settings.sparseInfillDensity) { mutableStateOf(settings.sparseInfillDensity) }
                            OutlinedTextField(
                                value = infillText,
                                onValueChange = {
                                    infillText = it
                                    val formatted = if (it.endsWith("%")) it else "$it%"
                                    project.setPrintSetting(ProcessSettings.KEY_SPARSE_INFILL_DENSITY, formatted)
                                },
                                label = { Text(stringResource(R.string.settings_infill_density)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                                modifier = Modifier.weight(1f),
                            )

                            var wallsText by remember(settings.wallLoops) { mutableStateOf(settings.wallLoops.toString()) }
                            OutlinedTextField(
                                value = wallsText,
                                onValueChange = {
                                    wallsText = it
                                    it.toIntOrNull()?.let { count ->
                                        project.setPrintSetting(ProcessSettings.KEY_WALL_LOOPS, count)
                                    }
                                },
                                label = { Text(stringResource(R.string.settings_wall_loops)) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        }
    }
}
