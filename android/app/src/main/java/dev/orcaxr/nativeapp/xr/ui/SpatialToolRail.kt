package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ActionTexts
import dev.orcaxr.nativeapp.shell.AppActions
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs

/**
 * Spatial Tool Rail for Android XR Full Space, matching the WebXR XrToolRail
 * design and physical ergonomic parameters.
 *
 * Placed under the operator's left hand at roughly -38° azimuth, -10° elevation, 0.9 m radius.
 * All four tool groups (Transform, Paint, Mesh, Plate) are exposed with 58 mm minimum targets,
 * labels, and active tool feedback.
 */
@Composable
fun SpatialToolRail(
    model: ProjectModel,
    modifier: Modifier = Modifier,
    isPinned: Boolean = false,
    onTogglePin: () -> Unit = {}
) {
    val run = LocalActionRunner.current

    Surface(
        modifier = modifier
            .width(260.dp)
            .spatialPanel(),
        color = Color.Transparent,
        shape = RoundedCornerShape(XrSpatialTokens.CornerRadiusParent)
    ) {
        Column(
            modifier = Modifier
                .padding(XrSpatialTokens.PanelPadding)
                .fillMaxHeight()
        ) {
            // Header with title and pin toggle
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = stringResource(R.string.xr_panel_tools),
                    style = MaterialTheme.typography.titleMedium,
                    color = XrSpatialTokens.ColorText,
                    modifier = Modifier.semantics { heading() }
                )
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
            }

            // Scrollable tool groups
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                ToolGroupSection(
                    title = stringResource(R.string.xr_rail_group_transform),
                    actionIds = listOf(
                        "tool_move",
                        "tool_rotate",
                        "tool_scale",
                        "tool_lay_on_face",
                        "edit_cut",
                        "tool_measure"
                    ),
                    model = model,
                    onAction = run
                )

                ToolGroupSection(
                    title = stringResource(R.string.xr_rail_group_paint),
                    actionIds = listOf(
                        "tool_paint",
                        "tool_support_paint",
                        "tool_seam_paint",
                        "tool_fuzzy_skin",
                        "tool_smart_paint"
                    ),
                    model = model,
                    onAction = run
                )

                ToolGroupSection(
                    title = stringResource(R.string.xr_rail_group_mesh),
                    actionIds = listOf(
                        "simplify_model",
                        "repair_model",
                        "split_to_parts",
                        "add_emboss",
                        "tool_brim_ears"
                    ),
                    model = model,
                    onAction = run
                )

                ToolGroupSection(
                    title = stringResource(R.string.xr_rail_group_plate),
                    actionIds = listOf(
                        "arrange_all",
                        "drop_to_bed",
                        "delete_models"
                    ),
                    model = model,
                    onAction = run
                )
            }
        }
    }
}

@Composable
private fun ToolGroupSection(
    title: String,
    actionIds: List<String>,
    model: ProjectModel,
    onAction: (String) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = XrSpatialTokens.ColorMint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)
        )

        for (id in actionIds) {
            val glyph = OrcaActionGlyphs.actions[id]
            val labelRes = ActionTexts.LABELS[id] ?: continue
            val label = stringResource(labelRes)
            val isTool = AppActions.isTool(id)
            val isActive = isTool && model.toolActive(id)
            val enabled = !model.busy

            SpatialToolButton(
                id = id,
                label = label,
                iconRes = glyph?.icon,
                isActive = isActive,
                enabled = enabled,
                onClick = { onAction(id) }
            )
        }
    }
}

@Composable
private fun SpatialToolButton(
    id: String,
    label: String,
    iconRes: Int?,
    isActive: Boolean,
    enabled: Boolean,
    onClick: () -> Unit
) {
    val bgColor = when {
        isActive -> XrSpatialTokens.ColorMint.copy(alpha = 0.25f)
        else -> XrSpatialTokens.ColorPanelSoft
    }
    val contentColor = when {
        !enabled -> XrSpatialTokens.ColorTextDim
        isActive -> XrSpatialTokens.ColorMintBright
        else -> XrSpatialTokens.ColorText
    }
    val borderStroke = when {
        isActive -> androidx.compose.foundation.BorderStroke(1.5.dp, XrSpatialTokens.ColorMint)
        else -> androidx.compose.foundation.BorderStroke(1.dp, XrSpatialTokens.ColorLine)
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = XrSpatialTokens.MinTouchTarget)
            .clip(RoundedCornerShape(XrSpatialTokens.CornerRadiusChild))
            .spatialPanel(strong = isActive, radius = XrSpatialTokens.CornerRadiusChild)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.CenterStart
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (iconRes != null) {
                Icon(
                    painter = painterResource(iconRes),
                    contentDescription = null,
                    tint = contentColor,
                    modifier = Modifier.size(24.dp)
                )
            }
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                color = contentColor
            )
        }
    }
}
