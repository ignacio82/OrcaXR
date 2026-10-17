package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.LocalActionRunner

private fun text(units: List<Int>): String = String(CharArray(units.size) { units[it].toChar() })

/**
 * Spatial Inspector and Object Tree for Android XR Full Space, matching
 * the WebXR XrObjectsPanel and inspector design.
 *
 * Placed on the operator's right (+37° azimuth, -11° elevation, 0.95 m radius).
 * Displays active plate selection, object hierarchy with printability toggles,
 * with 58 mm minimum interactive touch targets.
 */
@Composable
fun SpatialInspector(
    model: ProjectModel,
    modifier: Modifier = Modifier,
    isPinned: Boolean = false,
    onTogglePin: () -> Unit = {},
    onClose: () -> Unit = {}
) {
    val run = LocalActionRunner.current
    val view = model.view
    val plates = view.plateList
    val rows = view.rows

    Surface(
        modifier = modifier
            .width(320.dp)
            .spatialPanel(),
        color = Color.Transparent,
        shape = RoundedCornerShape(XrSpatialTokens.CornerRadiusParent)
    ) {
        Column(
            modifier = Modifier
                .padding(XrSpatialTokens.PanelPadding)
                .fillMaxHeight()
        ) {
            // Header with Title, Pin toggle, and Close button
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = stringResource(R.string.xr_panel_inspector),
                    style = MaterialTheme.typography.titleMedium,
                    color = XrSpatialTokens.ColorText,
                    modifier = Modifier.semantics { heading() }
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(
                        onClick = onTogglePin,
                        modifier = Modifier.size(40.dp)
                    ) {
                        Icon(
                            painter = painterResource(
                                if (isPinned) R.drawable.ic_symbol_commit else R.drawable.ic_symbol_crop_free
                            ),
                            contentDescription = stringResource(
                                if (isPinned) R.string.xr_action_unpin else R.string.xr_action_pin
                            ),
                            tint = if (isPinned) XrSpatialTokens.ColorMint else XrSpatialTokens.ColorTextMuted
                        )
                    }
                    IconButton(
                        onClick = onClose,
                        modifier = Modifier.size(40.dp)
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_symbol_disabled_by_default),
                            contentDescription = stringResource(R.string.inspector_close),
                            tint = XrSpatialTokens.ColorTextMuted
                        )
                    }
                }
            }

            // Scrollable contents
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                // Section: Plates
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Plates (${plates.size})",
                            style = MaterialTheme.typography.labelMedium,
                            color = XrSpatialTokens.ColorMint
                        )
                        IconButton(
                            onClick = { run("add_plate") },
                            enabled = !model.busy,
                            modifier = Modifier.size(32.dp)
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_symbol_add),
                                contentDescription = "Add plate",
                                tint = XrSpatialTokens.ColorMintBright
                            )
                        }
                    }

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        for (p in plates) {
                            val isActive = p.active
                            FilterChip(
                                selected = isActive,
                                onClick = { if (!isActive) model.activatePlate(p.id) },
                                label = { Text(p.name.ifEmpty { stringResource(R.string.xr_rail_group_plate) }) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = XrSpatialTokens.ColorMint.copy(alpha = 0.25f),
                                    selectedLabelColor = XrSpatialTokens.ColorMintBright,
                                    containerColor = XrSpatialTokens.ColorPanelSoft,
                                    labelColor = XrSpatialTokens.ColorText
                                )
                            )
                        }
                    }
                }

                // Section: Hierarchy & Objects
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Objects (${rows.size})",
                        style = MaterialTheme.typography.labelMedium,
                        color = XrSpatialTokens.ColorMint
                    )

                    if (rows.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 12.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = "No objects in project",
                                style = MaterialTheme.typography.bodySmall,
                                color = XrSpatialTokens.ColorTextDim
                            )
                        }
                    } else {
                        for (row in rows) {
                            val isSelected = row.selected
                            val rowKey = text(row.key)
                            val rowLabel = text(row.label)
                            val isPrintable = row.indicators.printable != ProjectIntents.ObjectTreePrintable.NotPrintable

                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = XrSpatialTokens.MinTouchTarget)
                                    .clip(RoundedCornerShape(XrSpatialTokens.CornerRadiusChild))
                                    .spatialPanel(strong = isSelected, radius = XrSpatialTokens.CornerRadiusChild)
                                    .clickable { model.selectRow(rowKey, ProjectRowSelection.Replace) }
                                    .padding(horizontal = 12.dp, vertical = 8.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(
                                        text = rowLabel.ifEmpty { "Item" },
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (isSelected) XrSpatialTokens.ColorMintBright else XrSpatialTokens.ColorText
                                    )

                                    IconButton(
                                        onClick = { run("toggle_printable") },
                                        enabled = !model.busy,
                                        modifier = Modifier.size(36.dp)
                                    ) {
                                        Icon(
                                            painter = painterResource(
                                                if (isPrintable) R.drawable.ic_symbol_check else R.drawable.ic_symbol_disabled_by_default
                                            ),
                                            contentDescription = "Toggle printability",
                                            tint = if (isPrintable) XrSpatialTokens.ColorMint else XrSpatialTokens.ColorWarn
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
