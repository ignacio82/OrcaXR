package dev.orcaxr.nativeapp.project

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.orcaxr.core.VirtualFilamentLibrary
import dev.orcaxr.nativeapp.R
import java.util.Locale

@Composable
fun RecreateModelColorsDialog(
    plan: RecreateModelColorsPlan,
    library: VirtualFilamentLibrary?,
    onApply: (Map<String, String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val overrides = remember { mutableStateMapOf<String, String>() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(R.string.dialog_recreate_model_colors_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.dialog_recreate_model_colors_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 380.dp)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f), RoundedCornerShape(8.dp))
                        .padding(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(plan.matches, key = { it.source.color }) { match ->
                        MatchRow(
                            match = match,
                            library = library,
                            currentOverride = overrides[match.source.color],
                            onSelectOverride = { chosenId ->
                                if (chosenId == null) {
                                    overrides.remove(match.source.color)
                                } else {
                                    overrides[match.source.color] = chosenId
                                }
                            },
                        )
                    }
                }

                val avgStr = String.format(Locale.US, "%.1f", plan.averageDeltaE2000)
                val maxStr = String.format(Locale.US, "%.1f", plan.maxDeltaE2000)
                val count = plan.matches.size
                Text(
                    "Avg ΔE: $avgStr (Max: $maxStr) across $count color(s)",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            Button(onClick = { onApply(overrides.toMap()) }) {
                Text(stringResource(R.string.dialog_recreate_model_colors_apply))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.dialog_recreate_model_colors_cancel))
            }
        },
    )
}

@Composable
private fun MatchRow(
    match: ModelColorMatchRow,
    library: VirtualFilamentLibrary?,
    currentOverride: String?,
    onSelectOverride: (String?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    // Resolve current destination name and display color based on override
    val (destName, destColor) = remember(currentOverride, match, library) {
        if (currentOverride == null) {
            match.destination.name to match.destination.displayColor
        } else {
            val phys = library?.physical?.firstOrNull { it.id == currentOverride }
            val mixed = library?.rows?.firstOrNull { it.id == currentOverride }
            when {
                phys != null -> "Physical: ${phys.name} (T${phys.toolId + 1})" to phys.color
                mixed != null -> "Virtual: ${mixed.name}" to mixed.displayColor
                else -> match.destination.name to match.destination.displayColor
            }
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(6.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Source color swatch & info
        FilamentSwatch(match.source.color, size = 24.dp)
        Column(modifier = Modifier.weight(0.35f)) {
            Text(
                match.source.color,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
            )
            val label = match.source.sourceMaterialName
                ?: match.source.sampleNames.firstOrNull()
                ?: "${match.source.usageCount} refs"
            Text(
                label,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // Arrow
        Text(
            "→",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // Destination color swatch & dropdown selector
        FilamentSwatch(destColor, size = 24.dp)
        Box(modifier = Modifier.weight(0.45f)) {
            Text(
                destName,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = true }
                    .padding(vertical = 4.dp),
            )

            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
                // Default auto match
                DropdownMenuItem(
                    text = { Text("Auto: ${match.destination.name}") },
                    onClick = {
                        onSelectOverride(null)
                        expanded = false
                    },
                )

                // Physical choices
                library?.physical?.filter { it.enabled }?.forEach { phys ->
                    DropdownMenuItem(
                        text = { Text("Physical: ${phys.name} (T${phys.toolId + 1}) - ${phys.color}") },
                        onClick = {
                            onSelectOverride(phys.id)
                            expanded = false
                        },
                    )
                }

                // Existing virtual choices
                library?.rows?.filter { it.enabled }?.forEach { row ->
                    DropdownMenuItem(
                        text = { Text("Virtual: ${row.name} - ${row.displayColor}") },
                        onClick = {
                            onSelectOverride(row.id)
                            expanded = false
                        },
                    )
                }
            }
        }

        // DeltaE badge
        val deltaVal = match.destination.deltaE2000
        val badgeBg = when {
            deltaVal <= 1.5 -> Color(0xFF2E7D32).copy(alpha = 0.15f)
            deltaVal <= 4.0 -> Color(0xFFF57F17).copy(alpha = 0.15f)
            else -> Color(0xFFC62828).copy(alpha = 0.15f)
        }
        val badgeBorder = when {
            deltaVal <= 1.5 -> Color(0xFF2E7D32)
            deltaVal <= 4.0 -> Color(0xFFF57F17)
            else -> Color(0xFFC62828)
        }

        Box(
            modifier = Modifier
                .background(badgeBg, RoundedCornerShape(4.dp))
                .border(1.dp, badgeBorder, RoundedCornerShape(4.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        ) {
            Text(
                "ΔE ${String.format(Locale.US, "%.1f", deltaVal)}",
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
