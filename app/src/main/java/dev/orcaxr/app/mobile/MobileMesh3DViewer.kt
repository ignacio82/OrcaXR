package dev.orcaxr.app.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.orcaxr.app.mobile.viewer.FilamentToolpathSurface
import java.io.File

/**
 * Post-slice 3D mesh preview — mirrors what the XR shell shows on the
 * build plate via SceneCore's `GlbSceneEntity`. Loads the colored GLB
 * that [dev.orcaxr.app.mobile.screens.runSlice] bakes next to the
 * .gcode using [dev.orcaxr.app.SlicerEngine.writeColoredGlb], so per-
 * triangle paint colors (user paint + embedded 3MF MMU segmentation +
 * FullSpectrum virtual-row palette) render under the same unlit
 * material the XR preview uses.
 *
 * Reuses the existing [FilamentToolpathSurface] renderer — that class
 * loads any GLB, not just toolpath bakes, and its `KHR_materials_unlit`
 * codepath is what we want here so the baked vertex colors paint
 * directly without an IBL.
 */
@Composable
fun MobileMesh3DViewer(
    glbPath: File,
    modifier: Modifier = Modifier,
) {
    var surface by remember { mutableStateOf<FilamentToolpathSurface?>(null) }

    // Re-load whenever the file path or its mtime (last slice
    // timestamp) changes. mtime is part of the key because the
    // PreviewScreen re-uses `<basename>.colored.glb`; if the user
    // re-slices, the path is identical but the contents are fresh and
    // we need the renderer to pick the new bytes up.
    val loadKey = remember(glbPath) { glbPath.absolutePath to glbPath.lastModified() }
    LaunchedEffect(surface, loadKey) {
        val s = surface ?: return@LaunchedEffect
        if (glbPath.exists() && glbPath.length() > 0) s.loadGlb(glbPath)
    }

    Box(
        modifier
            .fillMaxWidth()
            .height(360.dp)
            .background(
                MaterialTheme.colorScheme.surfaceContainerHighest,
                RoundedCornerShape(16.dp),
            ),
    ) {
        if (!glbPath.exists() || glbPath.length() == 0L) {
            Text(
                "Colored mesh preview not available for this slice yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp).align(Alignment.Center),
            )
        } else {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    FilamentToolpathSurface(ctx).also {
                        it.resumeRendering()
                        surface = it
                    }
                },
            )
        }

        DisposableEffect(Unit) {
            onDispose {
                surface?.destroy()
                surface = null
            }
        }
    }
}
