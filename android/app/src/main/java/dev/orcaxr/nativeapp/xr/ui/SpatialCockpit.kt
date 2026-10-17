package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.project.ProjectModel

/**
 * Ergonomic master Spatial Cockpit for Android XR Full Space.
 *
 * Implements the spatial cockpit layout defined in DESIGN.md and XrLayout:
 * 1. Menubar: Centered ahead at eye level (+18° elevation, 1.05 m radius).
 * 2. Tool Rail: Docked under the operator's left hand (-38° azimuth, -10° elevation, 0.9 m radius).
 * 3. 3D Viewport: Interactive bed and model editing at the center.
 * 4. Inspector / Objects: Docked on the operator's right (+37° azimuth, -11° elevation, 0.95 m radius).
 * 5. Scrubber: In Preview mode, docked low at the plate base (-28° elevation).
 *
 * Each panel supports independent pinning and collision-free ergonomic spacing.
 */
@Composable
fun SpatialCockpit(
    activeArea: Int,
    onSelectArea: (Int) -> Unit,
    projectModel: ProjectModel,
    previewModel: PreviewModel?,
    modifier: Modifier = Modifier,
    content: @Composable (Modifier) -> Unit
) {
    var isToolRailPinned by remember { mutableStateOf(false) }
    var isInspectorPinned by remember { mutableStateOf(false) }
    var isScrubberPinned by remember { mutableStateOf(false) }
    var showInspector by remember { mutableStateOf(true) }

    val onRecenter = {
        isToolRailPinned = false
        isInspectorPinned = false
        isScrubberPinned = false
        showInspector = true
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(XrSpatialTokens.ColorBgDeep)
    ) {
        // Center 3D Viewport / Content area
        content(Modifier.fillMaxSize())

        // Top Spatial Menu Bar
        SpatialMenuBar(
            activeArea = activeArea,
            onSelectArea = onSelectArea,
            model = projectModel,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 16.dp, start = 16.dp, end = 16.dp),
            onRecenter = onRecenter
        )

        // Left Spatial Tool Rail (Workspace & Prepare)
        if (activeArea == R.string.nav_workspace || activeArea == R.string.nav_prepare) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp, top = 80.dp, bottom = 24.dp)
            ) {
                SpatialToolRail(
                    model = projectModel,
                    isPinned = isToolRailPinned,
                    onTogglePin = { isToolRailPinned = !isToolRailPinned }
                )
            }
        }

        // Right Spatial Inspector (Workspace, Prepare, Project)
        if (showInspector && (activeArea == R.string.nav_workspace || activeArea == R.string.nav_prepare || activeArea == R.string.nav_project)) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 16.dp, top = 80.dp, bottom = 24.dp)
            ) {
                SpatialInspector(
                    model = projectModel,
                    isPinned = isInspectorPinned,
                    onTogglePin = { isInspectorPinned = !isInspectorPinned },
                    onClose = { showInspector = false }
                )
            }
        }

        // Bottom Spatial Preview Scrubber (Preview mode)
        if (activeArea == R.string.nav_preview && previewModel != null) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(start = 80.dp, end = 80.dp, bottom = 24.dp)
            ) {
                SpatialPreviewScrubber(
                    model = previewModel,
                    isPinned = isScrubberPinned,
                    onTogglePin = { isScrubberPinned = !isScrubberPinned }
                )
            }
        }
    }
}
