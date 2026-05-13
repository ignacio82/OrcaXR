package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import dev.orcaxr.app.ExtrusionRole
import dev.orcaxr.app.GcodeParser
import dev.orcaxr.app.MoonrakerClient
import dev.orcaxr.app.ParsedToolpath
import dev.orcaxr.app.PrintOptions
import dev.orcaxr.app.SendAndPrintOptionsPanel
import dev.orcaxr.app.applyPrintOptionsToGcode
import dev.orcaxr.app.mobile.GcodeThumbnailReader
import dev.orcaxr.app.mobile.MobileToolpath3DViewer
import dev.orcaxr.app.mobile.ToolpathLayerView
import dev.orcaxr.app.mobile.ToolpathRolesLegend
import dev.orcaxr.app.MoonrakerResult
import dev.orcaxr.app.PrinterConfig
import dev.orcaxr.app.mobile.EmptyStateCard
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
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

/**
 * Slice result preview. Reads metadata from the produced G-code
 * (estimated time, filament use, layer count) and offers an upload
 * + start-print CTA against the configured printers.
 *
 * Phone: vertical stack. Tablet: side-by-side stats / actions.
 */
@Composable
fun PreviewScreen(isTablet: Boolean) {
    val app = LocalMobileAppState.current
    val printers by app.printers.printers.collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()

    // The Slicer screen wrote `outputPath` into shell-scoped state;
    // for cross-screen reuse we re-derive from the cache directory's
    // most recent .gcode. Keeps Preview working when the user navigates
    // here directly without going through Slicer in this composition.
    val gcodeFile = remember {
        val dir = File(app.app.cacheDir, "gcode")
        if (!dir.exists()) null
        else dir.listFiles { f -> f.extension == "gcode" }?.maxByOrNull { it.lastModified() }
    }

    var meta by remember(gcodeFile?.absolutePath) { mutableStateOf<GcodeMeta?>(null) }
    var thumbnail by remember(gcodeFile?.absolutePath) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var toolpath by remember(gcodeFile?.absolutePath) { mutableStateOf<ParsedToolpath?>(null) }
    var parsing by remember(gcodeFile?.absolutePath) { mutableStateOf(false) }
    LaunchedEffect(gcodeFile?.absolutePath) {
        val f = gcodeFile ?: return@LaunchedEffect
        meta = withContext(Dispatchers.IO) { parseGcodeMeta(f) }
        thumbnail = withContext(Dispatchers.IO) { GcodeThumbnailReader.extractLargest(f) }
        parsing = true
        // Toolpath parse is the heavyweight bit (segments + travels for
        // a multi-million-line G-code can run a few seconds). Do it on
        // the IO dispatcher so the rest of the screen renders in the
        // meantime and the user sees the metadata + thumbnail
        // immediately.
        toolpath = withContext(Dispatchers.IO) {
            runCatching { GcodeParser.parse(f) }.getOrNull()
        }
        parsing = false
    }

    var uploadingId by remember { mutableStateOf<String?>(null) }
    var lastResult by remember { mutableStateOf<String?>(null) }

    // Pending Send & Print request — non-null while the options dialog
    // is on screen. Tapping "Send & Print" opens it, Confirm runs the
    // upload, Cancel just clears it.
    var pendingSendPrinter by remember { mutableStateOf<PrinterConfig?>(null) }
    // Cached "moonraker-timelapse installed" probe, per printer id.
    var timelapseSupported by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }

    fun upload(p: PrinterConfig, andStart: Boolean, options: PrintOptions = PrintOptions.Default) {
        val f = gcodeFile ?: return
        scope.launch {
            uploadingId = p.id
            val client = MoonrakerClient(p)
            // Apply g-code injections (no-op when options are all off).
            val injected = withContext(Dispatchers.IO) {
                runCatching { applyPrintOptionsToGcode(f, options) }.getOrDefault(f)
            }
            // Toggle the moonraker-timelapse component on/off to match
            // the user's pick. Errors are non-fatal — log via lastResult
            // append, but proceed to the upload.
            if (andStart) {
                runCatching { client.setTimelapseEnabled(options.timelapse) }
            }
            val r = client.uploadGcode(injected, injected.name)
            uploadingId = null
            lastResult = when (r) {
                is MoonrakerResult.Ok -> {
                    if (andStart) {
                        val s = client.startPrint(r.value)
                        if (s is MoonrakerResult.Ok) "Print started on ${p.name}." else "Uploaded; start failed."
                    } else "Uploaded to ${p.name}."
                }
                is MoonrakerResult.HttpError -> "HTTP ${r.code}: ${r.body.take(120)}"
                is MoonrakerResult.IoError -> "Upload failed: ${r.message}"
                else -> "Upload failed."
            }
            if (injected != f) withContext(Dispatchers.IO) { injected.delete() }
        }
    }

    // Render the options sheet as a Material AlertDialog when a Send &
    // Print request is pending. Confirm dispatches `upload(p, true, opts)`.
    val pending = pendingSendPrinter
    if (pending != null) {
        AlertDialog(
            onDismissRequest = { pendingSendPrinter = null },
            confirmButton = {},
            dismissButton = {},
            text = {
                SendAndPrintOptionsPanel(
                    printerName = pending.name,
                    initialOptions = PrintOptions.Default,
                    timelapseAvailable = timelapseSupported[pending.id] == true,
                    onCancel = { pendingSendPrinter = null },
                    onConfirm = { picked ->
                        pendingSendPrinter = null
                        upload(pending, andStart = true, options = picked)
                    },
                )
            },
        )
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Print preview",
            subtitle = gcodeFile?.name ?: "No slice",
        )
        if (gcodeFile == null) {
            Box(Modifier.fillMaxSize().padding(20.dp)) {
                EmptyStateCard(
                    title = "Nothing to preview",
                    body = "Slice a model from the Slicer tab to see the G-code summary, estimated time, and print/upload buttons here.",
                )
            }
        } else {
            Column(
                Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                MobileCard {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionKicker("Slice ready")
                        Text(
                            gcodeFile.name,
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                            MobileMetric("File size", formatBytes(gcodeFile.length()))
                            MobileMetric("ETA", formatDurationCompact(meta?.timeSeconds))
                            MobileMetric("Filament", meta?.filamentMm?.let { "%.0f mm".format(it) } ?: "—")
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                            MobileMetric("Layers", meta?.layerCount?.toString() ?: "—")
                            MobileMetric("Bed area", "—")
                        }
                    }
                }

                val bmp = thumbnail
                if (bmp != null) {
                    MobileCard {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionKicker("Slicer thumbnail")
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .aspectRatio(1f)
                                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(16.dp)),
                                contentAlignment = androidx.compose.ui.Alignment.Center,
                            ) {
                                Image(
                                    bitmap = bmp.asImageBitmap(),
                                    contentDescription = "Slicer-embedded thumbnail",
                                    contentScale = ContentScale.Fit,
                                    modifier = Modifier.fillMaxSize().padding(8.dp),
                                )
                            }
                            Text(
                                "Embedded ${bmp.width}×${bmp.height} preview from libslic3r",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                val tp = toolpath
                if (tp != null && tp.layerZs.isNotEmpty()) {
                    var view3D by remember(tp) { mutableStateOf(false) }
                    MobileCard {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionKicker("Toolpath")
                                SingleChoiceSegmentedButtonRow {
                                    val labels = listOf("2D layers", "3D")
                                    labels.forEachIndexed { i, label ->
                                        SegmentedButton(
                                            selected = if (i == 0) !view3D else view3D,
                                            onClick = { view3D = i == 1 },
                                            shape = SegmentedButtonDefaults.itemShape(index = i, count = labels.size),
                                        ) { Text(label) }
                                    }
                                }
                            }
                            if (view3D) {
                                MobileToolpath3DViewer(parsed = tp)
                            } else {
                                ToolpathLayerView(parsed = tp)
                                val activeRoles = remember(tp) { tp.segments.map { it.role }.toSet() }
                                ToolpathRolesLegend(activeRoles)
                            }
                        }
                    }
                } else if (parsing) {
                    MobileCard {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionKicker("Toolpath")
                            Text(
                                "Parsing G-code…",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            androidx.compose.material3.LinearProgressIndicator(
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                MobileCard {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionKicker("Send to printer")
                        if (printers.isEmpty()) {
                            Text(
                                "No printers configured. Add one from Onboarding to upload.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            for (p in printers) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(p.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                                        Text(
                                            "${p.host}:${p.port}",
                                            style = LocalMobileTextStyles.current.numeric,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Button(
                                            onClick = {
                                                pendingSendPrinter = p
                                                // Probe moonraker-timelapse availability
                                                // for this printer if we haven't yet.
                                                if (!timelapseSupported.containsKey(p.id)) {
                                                    scope.launch {
                                                        val ok = runCatching { MoonrakerClient(p).timelapseSupported() }
                                                            .getOrDefault(false)
                                                        timelapseSupported = timelapseSupported + (p.id to ok)
                                                    }
                                                }
                                            },
                                            enabled = uploadingId == null,
                                            colors = ButtonDefaults.buttonColors(
                                                containerColor = MaterialTheme.colorScheme.primary,
                                                contentColor = MaterialTheme.colorScheme.onPrimary,
                                            ),
                                        ) {
                                            Icon(Icons.Filled.CloudUpload, contentDescription = null)
                                            Spacer(Modifier.width(8.dp))
                                            Text(if (uploadingId == p.id) "Sending…" else "Send & print")
                                        }
                                        OutlinedButton(
                                            onClick = { upload(p, andStart = false) },
                                            enabled = uploadingId == null,
                                        ) { Text("Upload only") }
                                    }
                                }
                            }
                        }
                        val lr = lastResult
                        if (lr != null) {
                            StatusPill(
                                label = lr,
                                color = if (lr.startsWith("Print started") || lr.startsWith("Uploaded"))
                                    MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        }
    }
}

private data class GcodeMeta(
    val timeSeconds: Float?,
    val filamentMm: Float?,
    val layerCount: Int?,
)

/** Cheap header parser — read the first ~64 KB of the .gcode and grep
 *  the `; estimated printing time` / `; total filament used` / total
 *  layer markers libslic3r emits. Fast, no full parse needed. */
private fun parseGcodeMeta(file: File): GcodeMeta {
    val head = runCatching {
        file.inputStream().use { it.readNBytes(64 * 1024).toString(Charsets.UTF_8) }
    }.getOrDefault("")
    val tail = runCatching {
        val len = file.length()
        if (len > 64 * 1024) {
            file.inputStream().use { stream ->
                stream.skip(len - 64 * 1024)
                stream.readBytes().toString(Charsets.UTF_8)
            }
        } else head
    }.getOrDefault(head)
    val all = head + "\n" + tail

    val timeRegex = Regex("estimated printing time \\(normal mode\\) = (.+)")
    val filamentRegex = Regex("total filament used \\[mm\\] = ([0-9.]+)")
    val layerRegex = Regex("total layer number: (\\d+)")

    val time = timeRegex.find(all)?.groupValues?.get(1)?.let(::parseDuration)
    val filament = filamentRegex.find(all)?.groupValues?.get(1)?.toFloatOrNull()
    val layers = layerRegex.find(all)?.groupValues?.get(1)?.toIntOrNull()

    return GcodeMeta(time, filament, layers)
}

private fun parseDuration(raw: String): Float? {
    // libslic3r writes "1d 2h 3m 4s" / "2h 3m" / "45m 12s" / "12s"
    var total = 0f
    val regex = Regex("(\\d+)([dhms])")
    var matched = false
    for (m in regex.findAll(raw)) {
        matched = true
        val n = m.groupValues[1].toFloatOrNull() ?: continue
        when (m.groupValues[2]) {
            "d" -> total += n * 86400f
            "h" -> total += n * 3600f
            "m" -> total += n * 60f
            "s" -> total += n
        }
    }
    return if (matched) total else null
}
