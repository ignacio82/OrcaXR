package dev.orcaxr.app.mobile.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
    transform: SlicerEngine.ModelPlacement = SlicerEngine.ModelPlacement(),
    onSetTransform: (SlicerEngine.ModelPlacement) -> Unit = {},
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val userProfilesList by app.userProfiles.profiles.collectAsState(initial = emptyList())
    val bundledProfiles = remember { OrcaProfileLoader.loadCatalog(ctx) }
    val allProfiles = remember(userProfilesList, bundledProfiles) {
        bundledProfiles + Profiles.all + userProfilesList + listOf(Profiles.default)
    }
    // Narrow the profile picker to rows that match the actively-
    // selected printer + the project's shared material family. Mirrors
    // the XR shell's `OrcaProfileLoader.filterForContext` gate so the
    // user never sees a Snapmaker-U1 process listed when their
    // selected printer is an Elegoo, or a PETG process row when every
    // project filament is PLA. User-saved profiles (no machineName /
    // filamentName) always pass through; if filtering would empty the
    // list, the helper returns `allProfiles` unchanged so we never
    // strand the user with an empty dropdown.
    val printers by app.printers.printers.collectAsState(initial = emptyList())
    val activePrinter = remember(printers, app.prefs.lastPrinterId) {
        printers.firstOrNull { it.id == app.prefs.lastPrinterId } ?: printers.firstOrNull()
    }
    val filamentMap by app.filamentEntries.all.collectAsState(initial = emptyMap())
    val activeFilamentEntries = activePrinter?.id?.let(filamentMap::get).orEmpty()
    val displayedProfiles = remember(allProfiles, activePrinter, activeFilamentEntries) {
        val brand = OrcaProfileLoader.brandOfPrinter(activePrinter?.name)
        val model = OrcaProfileLoader.modelOfPrinter(activePrinter?.name)
        val sharedMaterial = OrcaProfileLoader.sharedMaterialFamily(
            activeFilamentEntries.map { it.filamentType },
        )
        OrcaProfileLoader.filterForContext(
            all = allProfiles,
            printerBrand = brand,
            sharedMaterial = sharedMaterial,
            printerModel = model,
        )
    }

    var selectedProfile by remember(displayedProfiles) {
        mutableStateOf(
            app.prefs.lastProfileId?.let { id -> displayedProfiles.firstOrNull { it.id == id } }
                ?: displayedProfiles.firstOrNull()
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
                    PreviewCard(
                        filePath = filePath,
                        profile = selectedProfile,
                        transform = transform,
                        onSetTransform = onSetTransform,
                        paintFilamentIndex = paintFilamentIndex,
                        fillRemaining = true,
                    )
                    SliceProgressCard(sliceState, onContinue = {
                        if (sliceState is SliceUi.Done) onNavigate(MobileDestination.Preview)
                    })
                }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    ProfileCard(displayedProfiles, selectedProfile, onSelect = { selectedProfile = it })
                    QuickOverridesCard(layerHeightOverride, onChange = { layerHeightOverride = it })
                    ToolsCard(
                        filePath = filePath,
                        cacheDir = ctx.cacheDir,
                        onSetFile = onSetFile,
                        onOpenPaint = onOpenPaint,
                        paintApplied = paintFilamentIndex != null,
                        transform = transform,
                        onSetTransform = onSetTransform,
                    )
                    TransformSheet(transform, onSetTransform)
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
                                    transform = transform,
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
                PreviewCard(
                    filePath = filePath,
                    profile = selectedProfile,
                    transform = transform,
                    onSetTransform = onSetTransform,
                    paintFilamentIndex = paintFilamentIndex,
                    fillRemaining = false,
                )
                ProfileCard(displayedProfiles, selectedProfile, onSelect = { selectedProfile = it })
                QuickOverridesCard(layerHeightOverride, onChange = { layerHeightOverride = it })
                ToolsCard(
                    filePath = filePath,
                    cacheDir = ctx.cacheDir,
                    onSetFile = onSetFile,
                    onOpenPaint = onOpenPaint,
                    paintApplied = paintFilamentIndex != null,
                    transform = transform,
                    onSetTransform = onSetTransform,
                    exportConfig = selectedProfile.config + buildMap {
                        layerHeightOverride.toFloatOrNull()
                            ?.takeIf { it > 0f }
                            ?.let { put("layer_height", it.toString()) }
                    },
                )
                TransformSheet(transform, onSetTransform)
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
                                transform = transform,
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

/**
 * Interactive 3D bed + model preview — drop-in replacement for the
 * static-PNG card. Builds an OpenGL ES 3 surface (ModelViewerView)
 * that renders the model on top of the active profile's bed
 * dimensions with a live grid; pinch-zoom / drag-orbit / two-finger-
 * pan gestures all just work. A toggle button switches single-finger
 * drag from "orbit camera" to "translate model on bed", which writes
 * the user's drag back into transform.translateXmm/Ymm so the
 * TransformSheet sliders stay in sync.
 *
 * GL viewer ported from u1-slicer-for-android (AGPL-3.0); see
 * NOTICE.md for attribution.
 */
@Composable
private fun PreviewCard(
    filePath: String,
    profile: SlicerProfile,
    transform: SlicerEngine.ModelPlacement,
    onSetTransform: (SlicerEngine.ModelPlacement) -> Unit,
    paintFilamentIndex: ByteArray?,
    fillRemaining: Boolean,
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    var mesh by remember(filePath) { mutableStateOf<dev.orcaxr.app.StlMesh?>(null) }
    var glMesh by remember(filePath) { mutableStateOf<dev.orcaxr.app.mobile.viewer.MeshData?>(null) }
    var loading by remember(filePath) { mutableStateOf(true) }
    var loadError by remember(filePath) { mutableStateOf<String?>(null) }
    var placementMode by remember { mutableStateOf(true) }
    var viewerView by
        remember(filePath) {
            mutableStateOf<dev.orcaxr.app.mobile.viewer.ModelViewerView?>(null)
        }
    val transformLive = androidx.compose.runtime.rememberUpdatedState(transform)
    val onSetTransformLive = androidx.compose.runtime.rememberUpdatedState(onSetTransform)

    // Phase 1: load the StlMesh on a background thread (same pipeline
    // as before — convertToStl for non-STL containers, then
    // StlReader.read).
    LaunchedEffect(filePath) {
        loading = true
        loadError = null
        runCatching {
            val source = File(filePath)
            val stl: File =
                if (source.extension.equals("stl", ignoreCase = true)) {
                    source
                } else {
                    val derived =
                        File(ctx.cacheDir, "mobile_preview_${source.nameWithoutExtension}.stl")
                    val ok =
                        withContext(Dispatchers.IO) { SlicerEngine.convertToStl(source, derived) }
                    if (!ok) {
                        error(
                            "libslic3r could not read ${source.name} — the file may be " +
                                "corrupt, unsupported, or a 3MF that requires Bambu / Orca " +
                                "metadata that's missing.",
                        )
                    }
                    derived
                }
            val parsed = withContext(Dispatchers.IO) { StlReader.read(stl) }
            if (parsed.triCount == 0) error("STL has 0 triangles — the file is empty or unparseable.")
            mesh = parsed
            glMesh =
                withContext(Dispatchers.Default) {
                    dev.orcaxr.app.mobile.viewer.MeshData.fromStlMesh(parsed)
                }
            loading = false
        }
            .onFailure {
                it.printStackTrace()
                loadError = "${it.javaClass.simpleName}: ${it.message ?: "no message"}"
                loading = false
            }
    }

    // Phase 2: hand the MeshData to the GL view once both are ready.
    LaunchedEffect(glMesh, viewerView) {
        val m = glMesh
        val v = viewerView
        if (m != null && v != null) v.setMesh(m)
    }

    // Phase 3: bed dimensions follow the active profile.
    LaunchedEffect(profile.id, viewerView) {
        val v = viewerView ?: return@LaunchedEffect
        val (w, d) = dev.orcaxr.app.BuildPlateGlb.sizeFor(profile)
        v.setBedSize(w, d)
    }

    // Phase 4: project the user's transform (translate + scale +
    // rotate) into the GL view's uniforms. The renderer treats
    // bedTranslationMm as a delta from "model centered on bed" and
    // recomputes the rotated/scaled bbox per frame, so the model
    // stays correctly placed under any rotation.
    LaunchedEffect(transform, glMesh, profile.id, viewerView) {
        val v = viewerView ?: return@LaunchedEffect
        glMesh ?: return@LaunchedEffect
        val sx = transform.scaleXPct / 100f
        val sy = transform.scaleYPct / 100f
        val sz = transform.scaleZPct / 100f
        v.setModelScale(sx, sy, sz)
        v.setModelRotation(transform.rotXdeg, transform.rotYdeg, transform.rotZdeg)
        v.setBedTranslation(transform.translateXmm, transform.translateYmm)
    }

    // Phase 5: per-paint-slot recoloring. When the user has painted
    // some triangles (paintFilamentIndex non-null), look up the
    // active printer's filament-slot colors via FilamentSlotsStore,
    // build an RGBA palette, and ask the renderer to recolor every
    // triangle. When paint is null/empty, revert to the uniform mint
    // fill.
    val slotsByPrinter by
        app.filamentSlots.all.collectAsState(initial = emptyMap<String, List<String>>())
    LaunchedEffect(paintFilamentIndex, glMesh, viewerView, slotsByPrinter) {
        val v = viewerView ?: return@LaunchedEffect
        glMesh ?: return@LaunchedEffect
        if (paintFilamentIndex == null) {
            v.clearPaint()
            return@LaunchedEffect
        }
        val printerId = app.prefs.lastPrinterId
        val saved = printerId?.let { slotsByPrinter[it] }
        // Use up to MAX_PAINT_SLOTS (32) slots — paint indices are
        // bytes so anything past 255 is impossible anyway.
        val padded = app.filamentSlots.pad(saved, count = 16)
        val palette =
            padded.map { hex ->
                val parsed = runCatching { android.graphics.Color.parseColor(hex) }.getOrNull()
                if (parsed != null) {
                    floatArrayOf(
                        android.graphics.Color.red(parsed) / 255f,
                        android.graphics.Color.green(parsed) / 255f,
                        android.graphics.Color.blue(parsed) / 255f,
                        1f,
                    )
                } else {
                    floatArrayOf(0.475f, 0.816f, 0.780f, 1f)
                }
            }
        v.setPaint(palette, paintFilamentIndex)
    }

    MobileCard {
        Column(
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = if (fillRemaining) Modifier.fillMaxHeight() else Modifier,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionKicker("3D preview")
                Spacer(Modifier.weight(1f))
                if (mesh != null) {
                    val toggleLabel = if (placementMode) "Orbit" else "Move model"
                    OutlinedButton(onClick = { placementMode = !placementMode }) {
                        Text(toggleLabel)
                    }
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .let {
                        if (fillRemaining) it.weight(1f).fillMaxHeight()
                        else it.aspectRatio(1f)
                    }
                    .background(
                        MaterialTheme.colorScheme.surfaceContainerHighest,
                        RoundedCornerShape(16.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                val err = loadError
                if (glMesh != null) {
                    androidx.compose.ui.viewinterop.AndroidView(
                        factory = { factoryCtx ->
                            dev.orcaxr.app.mobile.viewer.ModelViewerView(factoryCtx).also { v ->
                                viewerView = v
                                v.placementMode = placementMode
                                v.onObjectMoved = { dx, dy ->
                                    val cur = transformLive.value
                                    onSetTransformLive.value(
                                        cur.copy(
                                            translateXmm = cur.translateXmm + dx,
                                            translateYmm = cur.translateYmm + dy,
                                        )
                                    )
                                }
                            }
                        },
                        update = { v -> v.placementMode = placementMode },
                        modifier = Modifier.fillMaxSize(),
                    )
                } else if (err != null) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(20.dp),
                    ) {
                        Text(
                            "Preview failed",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Text(
                            err,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "You can still try to slice — the preview path is independent of the slicer pipeline.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else if (loading) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        LinearProgressIndicator(modifier = Modifier.width(120.dp))
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Building preview…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    Text(
                        "Preview unavailable",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            // Camera preset chips — apply a CameraViewState directly so
            // the GL view jumps to the requested viewpoint without a
            // re-render pipeline.
            val (bedW, bedD) = dev.orcaxr.app.BuildPlateGlb.sizeFor(profile)
            CameraPresetRow(
                bedWidthMm = bedW,
                bedDepthMm = bedD,
                onApply = { state -> viewerView?.applyCameraState(state) },
                onReset = { viewerView?.resetView() },
            )
            // Geometry stats — read from StlMesh; cheap, no BVH build.
            val m = mesh
            if (m != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    MobileMetric("Triangles", "${m.triCount}")
                    val sx = m.bboxMax.x - m.bboxMin.x
                    val sy = m.bboxMax.y - m.bboxMin.y
                    val sz = m.bboxMax.z - m.bboxMin.z
                    MobileMetric(
                        label = "BBox",
                        value =
                            String.format(
                                java.util.Locale.US,
                                "%.0f × %.0f × %.0f",
                                sx,
                                sy,
                                sz,
                            ),
                        unit = "mm",
                    )
                }
            }
        }
    }
}

/** Horizontal chip row for camera preset shortcuts (iso / front / etc).
 *  Each preset computes a CameraViewState pinned to the bed center and
 *  hands it to the GL view via applyCameraState. */
@Composable
private fun CameraPresetRow(
    bedWidthMm: Float,
    bedDepthMm: Float,
    onApply: (dev.orcaxr.app.mobile.viewer.CameraViewState) -> Unit,
    onReset: () -> Unit,
) {
    val targetX = bedWidthMm / 2.0
    val targetY = bedDepthMm / 2.0
    val dist = (maxOf(bedWidthMm, bedDepthMm) * 1.85).toDouble().coerceAtLeast(200.0)
    fun preset(azimuth: Double, elevation: Double) =
        dev.orcaxr.app.mobile.viewer.CameraViewState(
            azimuth = azimuth,
            elevation = elevation,
            distance = dist,
            panX = 0.0,
            panY = 0.0,
            targetX = targetX,
            targetY = targetY,
            targetZ = 0.0,
        )
    val presets =
        listOf(
            "Iso" to preset(-45.0, 35.0),
            "Front" to preset(-90.0, 15.0),
            "Right" to preset(0.0, 15.0),
            "Back" to preset(90.0, 15.0),
            "Left" to preset(180.0, 15.0),
            "Top" to preset(-90.0, 89.0),
        )
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(presets) { (label, state) ->
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(50),
                border =
                    androidx.compose.foundation.BorderStroke(
                        1.dp,
                        MaterialTheme.colorScheme.outlineVariant,
                    ),
                onClick = { onApply(state) },
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                )
            }
        }
        items(listOf("Reset")) { label ->
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(50),
                border =
                    androidx.compose.foundation.BorderStroke(
                        1.dp,
                        MaterialTheme.colorScheme.primary,
                    ),
                onClick = onReset,
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                )
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
                androidx.compose.material3.OutlinedButton(
                    onClick = { SlicerEngine.abort() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Cancel slice")
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
    transform: SlicerEngine.ModelPlacement,
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
    // Route through sliceMulti so the user's translate / rotate /
    // scale knobs are honored even for the single-model flow. When
    // the transform is identity, sliceMulti behaves identically to
    // the single-model `slice()` path.
    val isIdentity = transform == SlicerEngine.ModelPlacement()
    val result = if (isIdentity && paintFilamentIndex == null) {
        SlicerEngine.slice(
            stl = source,
            outGcode = out,
            config = effectiveConfig,
            paintFilamentIndex = paintFilamentIndex,
            onProgress = { percent, message -> onProgress(percent, message) },
        )
    } else {
        SlicerEngine.sliceMulti(
            models = listOf(source to transform),
            outGcode = out,
            config = effectiveConfig,
            paintFilamentIndices = listOf(paintFilamentIndex),
            onProgress = { percent, message -> onProgress(percent, message) },
        )
    }
    onResult(result)
}

@Composable
private fun TransformSheet(
    transform: SlicerEngine.ModelPlacement,
    onSet: (SlicerEngine.ModelPlacement) -> Unit,
) {
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            SectionKicker("Transform")
            NumericTransformField(
                label = "Rotate X",
                value = transform.rotXdeg,
                unit = "°",
                onChange = { onSet(transform.copy(rotXdeg = it)) },
                presets =
                    listOf(
                        "−90°" to -90f,
                        "0°" to 0f,
                        "+90°" to 90f,
                        "180°" to 180f,
                    ),
            )
            NumericTransformField(
                label = "Rotate Y",
                value = transform.rotYdeg,
                unit = "°",
                onChange = { onSet(transform.copy(rotYdeg = it)) },
                presets =
                    listOf(
                        "−90°" to -90f,
                        "0°" to 0f,
                        "+90°" to 90f,
                        "180°" to 180f,
                    ),
            )
            NumericTransformField(
                label = "Rotate Z",
                value = transform.rotZdeg,
                unit = "°",
                onChange = { onSet(transform.copy(rotZdeg = it)) },
                presets =
                    listOf(
                        "−90°" to -90f,
                        "0°" to 0f,
                        "+90°" to 90f,
                        "180°" to 180f,
                    ),
            )
            NumericTransformField(
                label = "Scale",
                value = transform.scaleXPct,
                unit = "%",
                onChange = {
                    onSet(
                        transform.copy(
                            scalePct = it,
                            scaleXPct = it,
                            scaleYPct = it,
                            scaleZPct = it,
                        )
                    )
                },
                presets =
                    listOf(
                        "50%" to 50f,
                        "100%" to 100f,
                        "150%" to 150f,
                        "200%" to 200f,
                    ),
            )
            NumericTransformField(
                label = "Translate X",
                value = transform.translateXmm,
                unit = "mm",
                onChange = { onSet(transform.copy(translateXmm = it)) },
                presets = listOf("0" to 0f),
            )
            NumericTransformField(
                label = "Translate Y",
                value = transform.translateYmm,
                unit = "mm",
                onChange = { onSet(transform.copy(translateYmm = it)) },
                presets = listOf("0" to 0f),
            )
            if (transform != SlicerEngine.ModelPlacement()) {
                androidx.compose.material3.OutlinedButton(
                    onClick = { onSet(SlicerEngine.ModelPlacement()) },
                    modifier = Modifier.align(androidx.compose.ui.Alignment.End),
                ) {
                    Text("Reset all")
                }
            }
        }
    }
}

/**
 * Numeric text field + quick-preset chips for a single transform axis.
 * Replaces the original slider so the user can type exact values like
 * "90" for rotation and tap a preset for the common cases. Decoupled
 * `value` (incoming) from the editable `text` (in-flight) so a typo
 * doesn't snap to 0 mid-keypress; the change only commits when the
 * field parses to a finite Float and differs from the current value.
 */
@Composable
private fun NumericTransformField(
    label: String,
    value: Float,
    unit: String,
    onChange: (Float) -> Unit,
    presets: List<Pair<String, Float>>,
) {
    val canonical =
        remember(value) { String.format(java.util.Locale.US, "%.2f", value) }
    var text by remember(value) { mutableStateOf(canonical) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = text,
                onValueChange = { v ->
                    text = v
                    val parsed = v.replace(',', '.').toFloatOrNull()
                    if (parsed != null && parsed.isFinite() && parsed != value) {
                        onChange(parsed)
                    }
                },
                singleLine = true,
                suffix = {
                    Text(
                        unit,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                keyboardOptions =
                    androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType =
                            androidx.compose.ui.text.input.KeyboardType.Number,
                        imeAction = androidx.compose.ui.text.input.ImeAction.Done,
                    ),
                textStyle = LocalMobileTextStyles.current.numeric,
                modifier = Modifier.width(140.dp),
            )
        }
        if (presets.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(presets) { (presetLabel, presetValue) ->
                    val isSel = kotlin.math.abs(value - presetValue) < 0.05f
                    Surface(
                        color =
                            if (isSel) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceContainerHigh,
                        shape = RoundedCornerShape(50),
                        border =
                            androidx.compose.foundation.BorderStroke(
                                1.dp,
                                if (isSel) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.outlineVariant,
                            ),
                        onClick = {
                            text =
                                String.format(java.util.Locale.US, "%.2f", presetValue)
                            if (presetValue != value) onChange(presetValue)
                        },
                    ) {
                        Text(
                            presetLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color =
                                if (isSel) MaterialTheme.colorScheme.onPrimaryContainer
                                else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolsCard(
    filePath: String,
    cacheDir: File,
    onSetFile: (String?) -> Unit,
    onOpenPaint: ((String) -> Unit)?,
    paintApplied: Boolean,
    transform: SlicerEngine.ModelPlacement,
    onSetTransform: (SlicerEngine.ModelPlacement) -> Unit,
    /**
     * Configuration to embed when exporting as 3MF. Empty map = the
     * 3MF carries only the mesh (no slicer settings); pass the
     * caller's resolved profile + overrides for a round-trippable
     * project file.
     */
    exportConfig: Map<String, String> = emptyMap(),
) {
    val ctx = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var repairing by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var orienting by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var exporting by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    var lastToolResult by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<String?>(null) }

    val saveStlLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("model/stl"),
    ) { uri: android.net.Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            exporting = true
            val src = File(filePath)
            val tmp = File(cacheDir, "export_${src.nameWithoutExtension}.stl")
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val baseStl = if (src.extension.equals("stl", ignoreCase = true)) src
                    else tmp.also { SlicerEngine.convertToStl(src, it) }
                    if (!baseStl.exists() || baseStl.length() == 0L) return@runCatching false
                    ctx.contentResolver.openOutputStream(uri)?.use { out ->
                        baseStl.inputStream().use { it.copyTo(out) }
                    } ?: return@runCatching false
                    true
                }.getOrElse { false }
            }
            exporting = false
            lastToolResult = if (ok) "Exported STL." else "Export STL failed."
        }
    }
    val save3mfLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("model/3mf"),
    ) { uri: android.net.Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            exporting = true
            val src = File(filePath)
            val tmp = File(cacheDir, "export_${src.nameWithoutExtension}.3mf")
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val wrote = SlicerEngine.saveAs3mf(input = src, outPath = tmp, config = exportConfig)
                    if (!wrote || !tmp.exists() || tmp.length() == 0L) return@runCatching false
                    ctx.contentResolver.openOutputStream(uri)?.use { out ->
                        tmp.inputStream().use { it.copyTo(out) }
                    } ?: return@runCatching false
                    true
                }.getOrElse { false }
            }
            exporting = false
            lastToolResult = if (ok) "Exported 3MF." else "Export 3MF failed."
        }
    }

    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionKicker("Tools")
            // Export row — STL strips paint + per-object config (binary
            // mesh only, the universal interchange format); 3MF keeps
            // the full project (mesh + paint + profile config) so it
            // can be re-opened in OrcaXR or desktop OrcaSlicer with
            // the same settings.
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        val stem = File(filePath).nameWithoutExtension.ifBlank { "model" }
                        saveStlLauncher.launch("$stem.stl")
                    },
                    enabled = !repairing && !orienting && !exporting,
                    modifier = Modifier.weight(1f),
                ) { Text(if (exporting) "Saving…" else "Save .stl") }
                androidx.compose.material3.OutlinedButton(
                    onClick = {
                        val stem = File(filePath).nameWithoutExtension.ifBlank { "model" }
                        save3mfLauncher.launch("$stem.3mf")
                    },
                    enabled = !repairing && !orienting && !exporting,
                    modifier = Modifier.weight(1f),
                ) { Text(if (exporting) "Saving…" else "Save .3mf") }
            }
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
                            if (euler == null || euler.size < 3) {
                                lastToolResult = "Auto-orient: no rotation needed (already optimal)."
                            } else {
                                val (rx, ry, rz) = Triple(euler[0], euler[1], euler[2])
                                if (kotlin.math.abs(rx) + kotlin.math.abs(ry) + kotlin.math.abs(rz) < 0.5f) {
                                    lastToolResult = "Auto-orient: already near-optimal."
                                } else {
                                    onSetTransform(
                                        transform.copy(
                                            rotXdeg = rx,
                                            rotYdeg = ry,
                                            rotZdeg = rz,
                                        ),
                                    )
                                    lastToolResult = "Auto-orient applied: X %.1f° / Y %.1f° / Z %.1f°".format(rx, ry, rz)
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
