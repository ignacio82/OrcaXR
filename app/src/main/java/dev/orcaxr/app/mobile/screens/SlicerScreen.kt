package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoFixHigh
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.OrcaProfileLoader
import dev.orcaxr.app.Profiles
import dev.orcaxr.app.SliceResult
import dev.orcaxr.app.SlicerEngine
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.StlReader
import dev.orcaxr.app.mobile.EmptyStateCard
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileDestination
import dev.orcaxr.app.mobile.MobileMetric
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.StatusPill
import dev.orcaxr.app.mobile.formatBytes
import dev.orcaxr.app.mobile.formatDurationCompact
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private sealed interface SliceUi {
    data object Idle : SliceUi
    data class Slicing(val percent: Int, val message: String) : SliceUi
    data class Done(val outputPath: String, val sizeBytes: Long) : SliceUi
    data class Failed(val message: String) : SliceUi
}

/**
 * Slicer screen — file preview, profile picker, slice CTA, slice progress.
 *
 * 3D viewport: pure-Kotlin rasterizer ([AiRenderEngine.render]) emits a
 * still PNG of the model. Re-renders on file change. We chose this over
 * a real OpenGL viewer because (a) no XR coupling, (b) the rasterizer
 * already exists and ships in production paths, (c) good-enough fidelity
 * for "did I pick the right file?" decisions on a phone.
 *
 * Slice path: [SlicerEngine.slice] runs on its own dispatcher; UI watches
 * the [SliceUi] state. On success the user can hop to Preview to send to
 * a printer.
 */
@Composable
fun SlicerScreen(
    isTablet: Boolean,
    filePath: String?,
    onSetFile: (String?) -> Unit,
    outputPath: String?,
    onSetOutput: (String?) -> Unit,
    onNavigate: (MobileDestination) -> Unit,
    paintFilamentIndex: ByteArray? = null,
    onOpenPaint: ((String) -> Unit)? = null,
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val userProfilesList by app.userProfiles.profiles.collectAsState(initial = emptyList())
    val bundledProfiles = remember { OrcaProfileLoader.loadCatalog(ctx) }
    val allProfiles = remember(userProfilesList, bundledProfiles) {
        bundledProfiles + Profiles.all + userProfilesList + listOf(Profiles.default)
    }

    var selectedProfile by remember(allProfiles) {
        mutableStateOf(
            app.prefs.lastProfileId?.let { id -> allProfiles.firstOrNull { it.id == id } }
                ?: allProfiles.firstOrNull()
                ?: Profiles.default,
        )
    }
    var layerHeightOverride by remember { mutableStateOf(app.prefs.layerHeightOverride) }

    LaunchedEffect(selectedProfile.id) { app.prefs.lastProfileId = selectedProfile.id }
    LaunchedEffect(layerHeightOverride) { app.prefs.layerHeightOverride = layerHeightOverride }

    var sliceState by remember { mutableStateOf<SliceUi>(
        if (outputPath != null) SliceUi.Done(outputPath, runCatching { File(outputPath).length() }.getOrDefault(0L))
        else SliceUi.Idle
    ) }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Slicer",
            subtitle = filePath?.let { File(it).name } ?: "No model loaded",
        )
        if (filePath == null) {
            Box(Modifier.fillMaxSize().padding(20.dp)) {
                EmptyStateCard(
                    title = "Pick a model to slice",
                    body = "Open the Files tab to import a 3MF / STL / OBJ. Once a file is loaded you'll see a 3D preview, the profile picker, and the slice button here.",
                    cta = "Open Files",
                    onCta = { onNavigate(MobileDestination.Files) },
                )
            }
        } else if (isTablet) {
            Row(Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                Column(Modifier.weight(1.3f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    PreviewCard(filePath, fillRemaining = true)
                    SliceProgressCard(sliceState, onContinue = {
                        if (sliceState is SliceUi.Done) onNavigate(MobileDestination.Preview)
                    })
                }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    ProfileCard(allProfiles, selectedProfile, onSelect = { selectedProfile = it })
                    QuickOverridesCard(layerHeightOverride, onChange = { layerHeightOverride = it })
                    ToolsCard(
                        filePath = filePath,
                        cacheDir = ctx.cacheDir,
                        onSetFile = onSetFile,
                        onOpenPaint = onOpenPaint,
                        paintApplied = paintFilamentIndex != null,
                    )
                    SliceButton(
                        enabled = sliceState !is SliceUi.Slicing,
                        sliceState = sliceState,
                        onSlice = {
                            sliceState = SliceUi.Slicing(-1, "Starting…")
                            scope.launch {
                                runSlice(
                                    inputPath = filePath,
                                    profile = selectedProfile,
                                    layerHeightOverride = layerHeightOverride,
                                    cacheDir = ctx.cacheDir,
                                    paintFilamentIndex = paintFilamentIndex,
                                    onProgress = { p, m ->
                                        if (sliceState is SliceUi.Slicing) sliceState = SliceUi.Slicing(p, m)
                                    },
                                    onResult = { r ->
                                        sliceState = when (r) {
                                            is SliceResult.Success -> {
                                                onSetOutput(r.outputPath)
                                                SliceUi.Done(r.outputPath, r.sizeBytes)
                                            }
                                            is SliceResult.NativeError -> SliceUi.Failed("libslic3r error ${r.code}: ${r.message}")
                                            is SliceResult.Cancelled -> SliceUi.Failed("Cancelled")
                                        }
                                    },
                                )
                            }
                        },
                    )
                }
            }
        } else {
            Column(
                Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                PreviewCard(filePath, fillRemaining = false)
                ProfileCard(allProfiles, selectedProfile, onSelect = { selectedProfile = it })
                QuickOverridesCard(layerHeightOverride, onChange = { layerHeightOverride = it })
                ToolsCard(
                    filePath = filePath,
                    cacheDir = ctx.cacheDir,
                    onSetFile = onSetFile,
                    onOpenPaint = onOpenPaint,
                    paintApplied = paintFilamentIndex != null,
                )
                SliceButton(
                    enabled = sliceState !is SliceUi.Slicing,
                    sliceState = sliceState,
                    onSlice = {
                        sliceState = SliceUi.Slicing(-1, "Starting…")
                        scope.launch {
                            runSlice(
                                inputPath = filePath,
                                profile = selectedProfile,
                                layerHeightOverride = layerHeightOverride,
                                cacheDir = ctx.cacheDir,
                                paintFilamentIndex = paintFilamentIndex,
                                onProgress = { p, m ->
                                    if (sliceState is SliceUi.Slicing) sliceState = SliceUi.Slicing(p, m)
                                },
                                onResult = { r ->
                                    sliceState = when (r) {
                                        is SliceResult.Success -> {
                                            onSetOutput(r.outputPath)
                                            SliceUi.Done(r.outputPath, r.sizeBytes)
                                        }
                                        is SliceResult.NativeError -> SliceUi.Failed("libslic3r error ${r.code}: ${r.message}")
                                        is SliceResult.Cancelled -> SliceUi.Failed("Cancelled")
                                    }
                                },
                            )
                        }
                    },
                )
                SliceProgressCard(sliceState, onContinue = {
                    if (sliceState is SliceUi.Done) onNavigate(MobileDestination.Preview)
                })
            }
        }
    }
}

@Composable
private fun PreviewCard(filePath: String, fillRemaining: Boolean) {
    val ctx = LocalContext.current
    var renderBitmap by remember(filePath) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var summary by remember(filePath) { mutableStateOf<AiIntrospection.GeometrySummary?>(null) }
    var rendering by remember(filePath) { mutableStateOf(true) }

    LaunchedEffect(filePath) {
        rendering = true
        runCatching {
            val source = File(filePath)
            // Convert non-STL to STL through libslic3r so StlReader can read it.
            val stl: File = if (source.extension.equals("stl", ignoreCase = true)) {
                source
            } else {
                val derived = File(ctx.cacheDir, "mobile_preview_${source.nameWithoutExtension}.stl")
                val ok = withContext(Dispatchers.IO) { SlicerEngine.convertToStl(source, derived) }
                if (ok) derived else source
            }
            val mesh = withContext(Dispatchers.IO) { StlReader.read(stl) }
            val bvh = withContext(Dispatchers.Default) { MeshBvh.build(mesh) }
            val geom = withContext(Dispatchers.Default) { AiIntrospection.geometry(bvh) }
            val cam = AiRenderEngine.namedPreset("iso", geom.bboxCenteredPreview, 720, 720)
            val res = withContext(Dispatchers.Default) {
                AiRenderEngine.render(
                    bvh = bvh,
                    camera = cam,
                    mode = AiRenderEngine.RenderMode.Solid,
                    palette = listOf("#79D0C7"),
                    backgroundRgb = intArrayOf(15, 29, 48),
                )
            }
            val bmp = android.graphics.BitmapFactory.decodeByteArray(res.pngBytes, 0, res.pngBytes.size)
            renderBitmap = bmp
            summary = geom
        }.onFailure { it.printStackTrace() }
        rendering = false
    }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = if (fillRemaining) Modifier.fillMaxHeight() else Modifier) {
            SectionKicker("3D preview")
            Box(
                Modifier
                    .fillMaxWidth()
                    .let { if (fillRemaining) it.weight(1f).fillMaxHeight() else it.aspectRatio(1f) }
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                val bmp = renderBitmap
                if (bmp != null) {
                    Image(
                        bitmap = bmp.asImageBitmap(),
                        contentDescription = "3D preview",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else if (rendering) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        LinearProgressIndicator(modifier = Modifier.width(120.dp))
                        Spacer(Modifier.height(8.dp))
                        Text("Building preview…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else {
                    Text("Preview unavailable", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // Geometry stats
            val s = summary
            if (s != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    MobileMetric("Triangles", "${s.totalTriangleCount}")
                    MobileMetric(
                        label = "BBox",
                        value = "%.0f × %.0f × %.0f".format(s.bboxCenteredPreview.sizeX, s.bboxCenteredPreview.sizeY, s.bboxCenteredPreview.sizeZ),
                        unit = "mm",
                    )
                }
            }
        }
    }
}

@Composable
private fun ProfileCard(
    profiles: List<SlicerProfile>,
    selected: SlicerProfile,
    onSelect: (SlicerProfile) -> Unit,
) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionKicker("Profile")
            Text(
                selected.displayName,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                selected.description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(8.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(profiles) { p ->
                    val isSel = p.id == selected.id
                    Surface(
                        color = if (isSel) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                        shape = RoundedCornerShape(50),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                        ),
                        onClick = { onSelect(p) },
                    ) {
                        Text(
                            text = profileChipLabel(p),
                            style = MaterialTheme.typography.labelMedium,
                            color = if (isSel) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun profileChipLabel(p: SlicerProfile): String {
    // For bundled profiles the displayName is long; use the layer-height
    // tag from the description as a glanceable chip label, falling back
    // to the displayName when no layer info is available.
    val lh = p.config["layer_height"]
    val mat = p.filamentName?.takeIf { it.isNotBlank() }
    return when {
        lh != null && mat != null -> "$lh mm · $mat"
        lh != null -> "$lh mm"
        else -> p.displayName.take(28)
    }
}

@Composable
private fun QuickOverridesCard(layerHeight: String, onChange: (String) -> Unit) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionKicker("Quick overrides")
            OutlinedTextField(
                value = layerHeight,
                onValueChange = onChange,
                label = { Text("Layer height (mm)") },
                placeholder = { Text("e.g. 0.20 — leave blank to use profile") },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun SliceButton(
    enabled: Boolean,
    sliceState: SliceUi,
    onSlice: () -> Unit,
) {
    Button(
        onClick = onSlice,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(56.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
        Icon(Icons.Filled.PlayArrow, contentDescription = null, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            when (sliceState) {
                is SliceUi.Slicing -> "Slicing…"
                is SliceUi.Done -> "Slice again"
                else -> "Slice"
            },
            style = MaterialTheme.typography.titleMedium,
        )
    }
}

@Composable
private fun SliceProgressCard(state: SliceUi, onContinue: () -> Unit) {
    when (state) {
        is SliceUi.Idle -> {} // no card
        is SliceUi.Slicing -> MobileCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionKicker("Slicing")
                if (state.percent >= 0) {
                    LinearProgressIndicator(
                        progress = { (state.percent / 100f).coerceIn(0f, 1f) },
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    LinearProgressIndicator(
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Row {
                    Text(
                        "${state.percent.coerceAtLeast(0)}%",
                        style = LocalMobileTextStyles.current.numericLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(16.dp))
                    Text(
                        state.message.ifBlank { "Working…" },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        is SliceUi.Done -> MobileCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SectionKicker("Slice complete")
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    MobileMetric("File", File(state.outputPath).name.take(20))
                    MobileMetric("Size", formatBytes(state.sizeBytes))
                }
                OutlinedButton(onClick = onContinue, modifier = Modifier.fillMaxWidth()) {
                    Text("View G-code preview →")
                }
            }
        }
        is SliceUi.Failed -> MobileCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionKicker("Slice failed")
                Text(
                    state.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

private suspend fun runSlice(
    inputPath: String,
    profile: SlicerProfile,
    layerHeightOverride: String,
    cacheDir: File,
    paintFilamentIndex: ByteArray?,
    onProgress: (Int, String) -> Unit,
    onResult: (SliceResult) -> Unit,
) {
    val source = File(inputPath)
    val outDir = File(cacheDir, "gcode").apply { mkdirs() }
    val out = File(outDir, "${source.nameWithoutExtension}.gcode")
    val effectiveConfig = profile.config.toMutableMap()
    layerHeightOverride.toFloatOrNull()?.let { lh ->
        effectiveConfig["layer_height"] = lh.toString()
        effectiveConfig["initial_layer_print_height"] = lh.toString()
    }
    val result = SlicerEngine.slice(
        stl = source,
        outGcode = out,
        config = effectiveConfig,
        paintFilamentIndex = paintFilamentIndex,
        onProgress = { percent, message -> onProgress(percent, message) },
    )
    onResult(result)
}

@Composable
private fun ToolsCard(
    filePath: String,
    cacheDir: File,
    onSetFile: (String?) -> Unit,
    onOpenPaint: ((String) -> Unit)?,
    paintApplied: Boolean,
) {
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var repairing by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var orienting by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var lastToolResult by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<String?>(null) }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Tools")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        scope.launch {
                            repairing = true
                            val source = File(filePath)
                            val out = File(cacheDir, "repaired_${source.nameWithoutExtension}.3mf")
                            val r = withContext(Dispatchers.IO) {
                                runCatching { SlicerEngine.repairModel(source, out) }.getOrNull()
                            }
                            repairing = false
                            if (r != null) {
                                lastToolResult = "Repaired: ${r.openEdgesIn} → ${r.openEdgesOut} open edges, ${if (r.partial) "partial (CGAL skipped)" else "OK"}"
                                onSetFile(r.output.absolutePath)
                            } else {
                                lastToolResult = "Repair skipped — mesh already manifold or load failed."
                            }
                        }
                    },
                    enabled = !repairing && !orienting,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.Filled.AutoFixHigh, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (repairing) "Repairing…" else "Repair")
                }
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        scope.launch {
                            orienting = true
                            val euler = withContext(Dispatchers.IO) {
                                runCatching { SlicerEngine.autoOrient(File(filePath)) }.getOrNull()
                            }
                            orienting = false
                            lastToolResult = if (euler == null || euler.size < 3) {
                                "Auto-orient: no rotation needed (already optimal)."
                            } else {
                                val (rx, ry, rz) = Triple(euler[0], euler[1], euler[2])
                                if (kotlin.math.abs(rx) + kotlin.math.abs(ry) + kotlin.math.abs(rz) < 0.5f) {
                                    "Auto-orient: already near-optimal."
                                } else {
                                    "Auto-orient suggests X %.1f° / Y %.1f° / Z %.1f°".format(rx, ry, rz)
                                }
                            }
                        }
                    },
                    enabled = !repairing && !orienting,
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.Filled.Compress, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (orienting) "Analyzing…" else "Orient")
                }
            }
            if (onOpenPaint != null) {
                androidx.compose.material3.OutlinedButton(
                    onClick = { onOpenPaint(filePath) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.Brush, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (paintApplied) "Edit paint" else "Paint by slot")
                }
            }
            val msg = lastToolResult
            if (msg != null) {
                Text(
                    msg,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (paintApplied) {
                StatusPill("Paint applied", MaterialTheme.colorScheme.primary)
            }
        }
    }
}
