package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.StlReader
import dev.orcaxr.app.mobile.ColorSwatch
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.parseHex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private val PRESETS = listOf("iso", "front", "right", "back", "left", "top")

enum class PaintScreenMode {
    Filament,
    Support,
}

/**
 * Touch paint screen. The user taps on a still rendering of the model
 * to mark which filament slot prints which triangles. The flow:
 *
 * 1. Load STL (deriving from 3MF / OBJ / etc. via SlicerEngine) and
 *    build a `MeshBvh`.
 * 2. Render the model in [AiRenderEngine.RenderMode.Paint] for visual
 *    feedback AND in [AiRenderEngine.RenderMode.TriangleId] for the
 *    per-pixel triangle-id map.
 * 3. Tap → look up triangleId at (px, py) → BVH radius BFS to grow
 *    the stamp → mark the touched triangles' bytes in
 *    `paintFilamentIndex`.
 * 4. Re-render the Paint view to surface the change.
 * 5. "Apply" hands the byteArray back to SlicerScreen, which passes
 *    it to `SlicerEngine.slice(paintFilamentIndex = ...)`.
 *
 * Coordinate frame: every primitive consumes mesh-local coords (the
 * BVH frame). Cross-screen state is the byteArray, sized to the
 * mesh's triangle count — same shape the JNI shim expects.
 *
 * Multi-view: 6 named camera presets (iso / front / right / back /
 * left / top). Switching cameras re-renders BOTH paint preview AND
 * triangle-id map; the byteArray is mesh-local so it survives the
 * camera change.
 */
@Composable
fun PaintScreen(
    filePath: String,
    mode: PaintScreenMode = PaintScreenMode.Filament,
    initialPaint: ByteArray?,
    onApply: (ByteArray) -> Unit,
    onCancel: () -> Unit,
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val printers by app.printers.printers.collectAsState(initial = emptyList())
    val activePrinterId = printers.firstOrNull { it.id == app.prefs.lastPrinterId }?.id
        ?: printers.firstOrNull()?.id
    val entries by app.filamentEntries.all.collectAsState(initial = emptyMap())
    val savedSlots by app.filamentSlots.all.collectAsState(initial = emptyMap())

    // Resolve the active palette: user's per-printer FilamentEntry
    // colors when present, else padded slot colors, else our default.
    val filamentPalette = remember(activePrinterId, entries, savedSlots) {
        val e = entries[activePrinterId]
        if (e != null && e.isNotEmpty()) {
            e.sortedBy { it.slotIndex ?: Int.MAX_VALUE }.map { it.color }
        } else {
            app.filamentSlots.pad(savedSlots[activePrinterId], 4)
        }
    }
    val palette = if (mode == PaintScreenMode.Support) {
        listOf("#F5A524", "#5B6472")
    } else {
        filamentPalette
    }

    var bvh by remember(filePath) { mutableStateOf<MeshBvh?>(null) }
    var bbox by remember(filePath) { mutableStateOf<AiIntrospection.Bbox?>(null) }
    var triCount by remember(filePath) { mutableStateOf(0) }
    var loading by remember(filePath) { mutableStateOf(true) }

    // Mesh-local per-triangle slot index. Initialized to [initialPaint]
    // when the user re-enters paint mode; cloned so commits don't
    // mutate the caller's array.
    var paintIndex by remember(filePath) { mutableStateOf<ByteArray?>(null) }

    var cameraName by remember { mutableStateOf("iso") }
    var renderPng by remember(filePath) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var triIdMap by remember(filePath) { mutableStateOf<IntArray?>(null) }
    var renderSize by remember(filePath) { mutableStateOf(IntSize.Zero) }
    var brushRadiusMm by remember { mutableStateOf(3f) }
    var slot by remember { mutableStateOf(1) }
    var supportTag by remember { mutableStateOf(1) }
    var rebakingPreview by remember { mutableStateOf(false) }

    // 1) Build BVH on first composition.
    LaunchedEffect(filePath) {
        loading = true
        runCatching {
            val source = File(filePath)
            val stl: File = if (source.extension.equals("stl", ignoreCase = true)) {
                source
            } else {
                val derived = File(ctx.cacheDir, "paint_${source.nameWithoutExtension}.stl")
                val ok = withContext(Dispatchers.IO) { SlicerEngine.convertToStl(source, derived) }
                if (ok) derived else source
            }
            val mesh = withContext(Dispatchers.IO) { StlReader.read(stl) }
            val newBvh = withContext(Dispatchers.Default) { MeshBvh.build(mesh) }
            val geom = withContext(Dispatchers.Default) { AiIntrospection.geometry(newBvh) }
            bvh = newBvh
            bbox = geom.bboxCenteredPreview
            triCount = newBvh.triCount
            paintIndex = (initialPaint?.takeIf { it.size == newBvh.triCount }?.copyOf())
                ?: ByteArray(newBvh.triCount)
        }
        loading = false
    }

    // 2) Re-render Paint + TriangleId on camera or paint state change.
    LaunchedEffect(bvh, cameraName, paintIndex?.contentHashCode()) {
        val b = bvh ?: return@LaunchedEffect
        val bb = bbox ?: return@LaunchedEffect
        rebakingPreview = true
        val W = 720
        val H = 720
        val cam = AiRenderEngine.namedPreset(cameraName, bb, W, H)
        val pngOut = withContext(Dispatchers.Default) {
            AiRenderEngine.render(
                bvh = b,
                camera = cam,
                mode = AiRenderEngine.RenderMode.Paint,
                palette = palette,
                paintFilamentIndex = paintIndex,
                backgroundRgb = intArrayOf(15, 29, 48),
            )
        }
        val idOut = withContext(Dispatchers.Default) {
            AiRenderEngine.render(
                bvh = b,
                camera = cam,
                mode = AiRenderEngine.RenderMode.TriangleId,
                palette = palette,
                paintFilamentIndex = paintIndex,
            )
        }
        val bmp = android.graphics.BitmapFactory.decodeByteArray(pngOut.pngBytes, 0, pngOut.pngBytes.size)
        renderPng = bmp
        triIdMap = idOut.triangleIdMap
        rebakingPreview = false
    }

    fun applyTap(canvasPx: Float, canvasPy: Float, canvasW: Int, canvasH: Int) {
        val idMap = triIdMap ?: return
        val b = bvh ?: return
        val pi = paintIndex ?: return
        // The TriangleId render is fixed at 720×720; the on-screen
        // canvas may be a different aspect (we render with a square
        // aspect ratio). Map proportionally.
        val nx = (canvasPx / canvasW).coerceIn(0f, 1f)
        val ny = (canvasPy / canvasH).coerceIn(0f, 1f)
        val mapW = 720
        val mapH = 720
        val px = (nx * mapW).toInt().coerceIn(0, mapW - 1)
        val py = (ny * mapH).toInt().coerceIn(0, mapH - 1)
        val triId = idMap[py * mapW + px]
        if (triId < 0) return
        val touched = b.radiusBfs(triId, brushRadiusMm)
        val updated = pi.copyOf()
        val tag = if (mode == PaintScreenMode.Support) supportTag else slot
        for (t in touched) updated[t] = tag.toByte()
        paintIndex = updated
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = if (mode == PaintScreenMode.Support) "Support paint" else "Paint",
            subtitle = File(filePath).name,
        )
        Column(
            Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Render canvas
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionKicker(
                        if (mode == PaintScreenMode.Support) "Tap supports" else "Tap to paint",
                    )
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .aspectRatio(1f)
                            .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp))
                            .onSizeChanged { renderSize = it }
                            .pointerInput(triIdMap, slot, supportTag, brushRadiusMm, mode) {
                                detectTapGestures(onTap = { offset ->
                                    if (renderSize.width > 0 && renderSize.height > 0) {
                                        applyTap(offset.x, offset.y, renderSize.width, renderSize.height)
                                    }
                                })
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        val bmp = renderPng
                        if (bmp != null) {
                            Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = "Paint preview",
                                contentScale = ContentScale.Fit,
                                modifier = Modifier.fillMaxSize(),
                            )
                        } else if (loading || rebakingPreview) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                LinearProgressIndicator(modifier = Modifier.width(120.dp))
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    if (loading) "Building BVH…" else "Rendering…",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }

                    // Camera presets row
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (p in PRESETS) {
                            CamPill(p, p == cameraName) { cameraName = p }
                        }
                    }
                }
            }

            // Slot / support-state picker + brush radius
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (mode == PaintScreenMode.Support) {
                        SectionKicker("Support mode")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(
                                selected = supportTag == 1,
                                onClick = { supportTag = 1 },
                                label = { Text("Force support") },
                            )
                            FilterChip(
                                selected = supportTag == 2,
                                onClick = { supportTag = 2 },
                                label = { Text("Block support") },
                            )
                        }
                    } else {
                        SectionKicker("Filament slot")
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            for ((i, hex) in palette.withIndex()) {
                                SlotPill(
                                    slotIdx = i + 1,
                                    hex = hex,
                                    selected = slot == i + 1,
                                    onClick = { slot = i + 1 },
                                )
                            }
                        }
                    }
                    SectionKicker("Brush radius (mm)")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Slider(
                            value = brushRadiusMm,
                            onValueChange = { brushRadiusMm = it },
                            valueRange = 0.5f..20f,
                            steps = 38,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            "%.1f".format(brushRadiusMm),
                            style = LocalMobileTextStyles.current.numeric,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            // Stats
            MobileCard {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionKicker("Coverage")
                    val pi = paintIndex
                    if (pi == null) {
                        Text("Loading mesh…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        val total = pi.size
                        val bucketCount = if (mode == PaintScreenMode.Support) 3 else palette.size + 2
                        val byBucket = IntArray(bucketCount)
                        for (b in pi) {
                            val v = b.toInt() and 0xff
                            if (v in 0 until byBucket.size) byBucket[v]++
                        }
                        Row {
                            Column {
                                Text("UNPAINTED", style = LocalMobileTextStyles.current.sectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(
                                    "${byBucket.getOrElse(0) { 0 }} / $total",
                                    style = LocalMobileTextStyles.current.numeric,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                            }
                            Spacer(Modifier.width(20.dp))
                            val maxBucket = if (mode == PaintScreenMode.Support) 2 else palette.size
                            for (i in 1..maxBucket) {
                                val n = byBucket.getOrElse(i) { 0 }
                                if (n == 0) continue
                                Column(Modifier.padding(end = 12.dp)) {
                                    Text(
                                        if (mode == PaintScreenMode.Support) {
                                            if (i == 1) "FORCED" else "BLOCKED"
                                        } else {
                                            "SLOT $i"
                                        },
                                        style = LocalMobileTextStyles.current.sectionLabel,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Text("$n", style = LocalMobileTextStyles.current.numeric, color = MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    }
                }
            }

            // Actions
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { paintIndex = ByteArray(triCount) },
                    modifier = Modifier.weight(1f),
                    enabled = paintIndex != null,
                ) {
                    Icon(Icons.Filled.Refresh, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Clear")
                }
                OutlinedButton(
                    onClick = onCancel,
                    modifier = Modifier.weight(1f),
                ) { Text("Cancel") }
                Button(
                    onClick = {
                        val pi = paintIndex
                        if (pi != null) onApply(pi)
                    },
                    enabled = paintIndex != null,
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                ) {
                    Icon(Icons.Filled.Check, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Apply")
                }
            }
        }
    }
}

@Composable
private fun CamPill(label: String, selected: Boolean, onClick: () -> Unit) {
    androidx.compose.material3.Surface(
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(50),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
        onClick = onClick,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun SlotPill(
    slotIdx: Int,
    hex: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val swatch = parseHex(hex) ?: MaterialTheme.colorScheme.surface
    Box(
        Modifier
            .size(if (selected) 52.dp else 40.dp)
            .background(swatch, CircleShape)
            .border(
                if (selected) 4.dp else 1.dp,
                if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                CircleShape,
            )
            .padding(4.dp),
        contentAlignment = Alignment.Center,
    ) {
        // Click target — wrapping Box has no built-in onClick; use a
        // transparent Surface for the ripple + pointer behavior.
        androidx.compose.material3.Surface(
            color = Color.Transparent,
            shape = CircleShape,
            onClick = onClick,
            modifier = Modifier.size(if (selected) 52.dp else 40.dp),
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.size(if (selected) 52.dp else 40.dp)) {
                Text(
                    "T${slotIdx - 1}",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (isDark(swatch)) Color.White else Color.Black,
                )
            }
        }
    }
}

private fun isDark(c: Color): Boolean {
    val luma = 0.299f * c.red + 0.587f * c.green + 0.114f * c.blue
    return luma < 0.5f
}
