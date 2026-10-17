package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.shell.LocalCommandPalette
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs

/**
 * Spatial Menu Bar for Android XR Full Space, matching the WebXR XrMenuBar
 * design and physical layout parameters.
 *
 * Placed at eye level (0° azimuth, +18° elevation, 1.05 m radius, 0.88 m wide).
 * Hosts the five navigation destinations, quick actions (Save, Undo, Redo),
 * command palette trigger, space mode toggle, and spatial recenter.
 */
@Composable
fun SpatialMenuBar(
    activeArea: Int,
    onSelectArea: (Int) -> Unit,
    model: ProjectModel,
    modifier: Modifier = Modifier,
    onRecenter: () -> Unit = {}
) {
    val run = LocalActionRunner.current
    val openPalette = LocalCommandPalette.current
    val areas = listOf(
        R.string.nav_workspace,
        R.string.nav_prepare,
        R.string.nav_preview,
        R.string.nav_device,
        R.string.nav_project
    )

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = XrSpatialTokens.MinTouchTarget)
            .spatialPanel(),
        color = Color.Transparent,
        shape = RoundedCornerShape(XrSpatialTokens.CornerRadiusParent)
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 6.dp)
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            // Navigation tabs
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                for (areaRes in areas) {
                    val isSelected = areaRes == activeArea
                    val areaName = stringResource(areaRes)
                    Box(
                        modifier = Modifier
                            .heightIn(min = 44.dp)
                            .clip(RoundedCornerShape(XrSpatialTokens.CornerRadiusChild))
                            .spatialPanel(strong = isSelected, radius = XrSpatialTokens.CornerRadiusChild)
                            .clickable(role = Role.Tab) { onSelectArea(areaRes) }
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .semantics { contentDescription = areaName },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = areaName,
                            style = MaterialTheme.typography.titleSmall,
                            color = if (isSelected) XrSpatialTokens.ColorMintBright else XrSpatialTokens.ColorText
                        )
                    }
                }
            }

            // Quick actions & Spatial controls
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                // Save
                IconButton(
                    onClick = { run("file_save_project") },
                    enabled = !model.busy,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_symbol_save),
                        contentDescription = stringResource(R.string.project_save),
                        tint = XrSpatialTokens.ColorText
                    )
                }

                // Undo
                val canUndo = model.view.undo != null && !model.busy
                IconButton(
                    onClick = { run("edit_undo") },
                    enabled = canUndo,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_symbol_undo),
                        contentDescription = stringResource(R.string.project_undo),
                        tint = if (canUndo) XrSpatialTokens.ColorText else XrSpatialTokens.ColorTextDim
                    )
                }

                // Redo
                val canRedo = model.view.redo != null && !model.busy
                IconButton(
                    onClick = { run("edit_redo") },
                    enabled = canRedo,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_symbol_redo),
                        contentDescription = stringResource(R.string.project_redo),
                        tint = if (canRedo) XrSpatialTokens.ColorText else XrSpatialTokens.ColorTextDim
                    )
                }

                // Search / Command Palette
                IconButton(
                    onClick = openPalette,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(OrcaActionGlyphs.search),
                        contentDescription = stringResource(R.string.palette_open),
                        tint = XrSpatialTokens.ColorText
                    )
                }

                // Recenter Cockpit
                IconButton(
                    onClick = onRecenter,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_symbol_explore),
                        contentDescription = stringResource(R.string.xr_action_recenter),
                        tint = XrSpatialTokens.ColorMintBright
                    )
                }

                // Return to Home Space
                val xrAdapter = dev.orcaxr.nativeapp.xr.LocalXrAdapter.current
                IconButton(
                    onClick = { xrAdapter?.requestHomeSpace() },
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_symbol_view_in_ar),
                        contentDescription = stringResource(R.string.xr_action_home_space),
                        tint = XrSpatialTokens.ColorMint
                    )
                }
            }
        }
    }
}
