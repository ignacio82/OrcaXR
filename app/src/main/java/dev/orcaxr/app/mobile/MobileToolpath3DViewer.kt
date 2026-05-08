package dev.orcaxr.app.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.orcaxr.app.ParsedToolpath
import dev.orcaxr.app.ToolpathGlb
import dev.orcaxr.app.mobile.viewer.FilamentToolpathSurface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 3D toolpath preview rendered through Filament-android. Hosts a
 * [FilamentToolpathSurface] in an `AndroidView` and drives it from
 * Compose state — layer scrubber, color-mode picker, tubes toggle.
 *
 * Each state change re-bakes the GLB via [ToolpathGlb.write] (the
 * same bake the XR shell consumes) so the mobile and XR previews
 * agree pixel-for-pixel modulo lighting. Re-bake is debounced ~120 ms
 * so dragging the slider doesn't queue a thousand bake jobs.
 */
@Composable
fun MobileToolpath3DViewer(
    parsed: ParsedToolpath,
    extruderPalette: List<String>? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cacheDir = remember { File(context.cacheDir, "toolpath_glb_3d").apply { mkdirs() } }
    val glbFile = remember { File(cacheDir, "preview.glb") }

    val maxLayer = parsed.layerZs.lastIndex.coerceAtLeast(0)
    var layerIndex by remember(parsed) { mutableStateOf(maxLayer) }
    var colorMode by remember(parsed) { mutableStateOf(ToolpathGlb.ColorMode.Auto) }
    var tubes by remember(parsed) { mutableStateOf(false) }
    var includeTravels by remember(parsed) { mutableStateOf(false) }
    var bakeJob by remember { mutableStateOf<Job?>(null) }

    var surface by remember { mutableStateOf<FilamentToolpathSurface?>(null) }

    // Reactive bake: snapshotFlow over the four scrub-state fields,
    // distinctUntilChanged to coalesce duplicate emissions, then
    // collectLatest so an in-flight bake gets cancelled the moment
    // the user nudges the slider again.
    LaunchedEffect(parsed, surface) {
        val s = surface ?: return@LaunchedEffect
        snapshotFlow { Quad(layerIndex, colorMode, tubes, includeTravels) }
            .distinctUntilChanged()
            .collectLatest { (idx, mode, useTubes, withTravels) ->
                delay(120) // debounce slider drags
                val baked = withContext(Dispatchers.IO) {
                    runCatching {
                        ToolpathGlb.write(
                            toolpath = parsed,
                            out = glbFile,
                            maxLayerInclusive = idx,
                            includeTravels = withTravels,
                            extruderPalette = extruderPalette,
                            colorMode = mode,
                            tubes = useTubes,
                        )
                        glbFile
                    }.getOrNull()
                }
                if (baked != null) s.loadGlb(baked)
            }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(360.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp)),
        ) {
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
                bakeJob?.cancel()
                surface?.destroy()
                surface = null
            }
        }

        // Layer scrubber. Compose Slider is continuous; we round to the
        // nearest layer index so the model only re-bakes on integer
        // boundaries (cuts re-bake count ~60×).
        if (maxLayer > 0) {
            Column {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Layer ${layerIndex + 1} / ${maxLayer + 1}",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    val z = parsed.layerZs.getOrNull(layerIndex)
                    if (z != null) {
                        Text(
                            "Z = %.2f mm".format(z),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Slider(
                    value = layerIndex.toFloat(),
                    onValueChange = { layerIndex = it.toInt().coerceIn(0, maxLayer) },
                    valueRange = 0f..maxLayer.toFloat(),
                    steps = (maxLayer - 1).coerceAtLeast(0),
                )
            }
        }

        // Color-mode picker (Auto / Extruder / Feature). When the slice
        // is single-tool, Auto and Feature collapse to the same output —
        // we still expose all three for explicitness.
        val modes = listOf(
            ToolpathGlb.ColorMode.Auto to "Auto",
            ToolpathGlb.ColorMode.Extruder to "Extruder",
            ToolpathGlb.ColorMode.Feature to "Feature",
        )
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            modes.forEachIndexed { i, (mode, label) ->
                SegmentedButton(
                    selected = colorMode == mode,
                    onClick = { colorMode = mode },
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = modes.size),
                ) { Text(label) }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Switch(checked = tubes, onCheckedChange = { tubes = it })
                Text("Tubes", style = MaterialTheme.typography.labelMedium)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Switch(checked = includeTravels, onCheckedChange = { includeTravels = it })
                Text("Show travels", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/** Tiny tuple to make snapshotFlow's emission a single value. */
private data class Quad(
    val layerIndex: Int,
    val colorMode: ToolpathGlb.ColorMode,
    val tubes: Boolean,
    val includeTravels: Boolean,
)
