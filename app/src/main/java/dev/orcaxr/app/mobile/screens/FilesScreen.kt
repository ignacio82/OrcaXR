package dev.orcaxr.app.mobile.screens

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.FilePresent
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.RecentFile
import dev.orcaxr.app.SharedIntentHandler
import dev.orcaxr.app.mobile.EmptyStateCard
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.formatBytes
import kotlinx.coroutines.launch
import java.io.File
import java.text.DateFormat
import java.util.Date

/**
 * File library — recent imports + import button. Tapping a row pushes
 * the file into the Slicer screen so the user can pick a profile and
 * slice. Long-press deletes from the recents list (the underlying
 * file in cache stays put — the next slice will rebuild it).
 *
 * Tablet: two-column row layout when there are >4 recents.
 * Phone:  single-column LazyColumn.
 */
@Composable
fun FilesScreen(
    isTablet: Boolean,
    onOpenInSlicer: (String) -> Unit,
    /**
     * "Start with an empty plate" CTA — clear the active file and
     * jump to the slicer screen with no model loaded. Useful when
     * the user wants to import via a primitive / shared intent /
     * starting a fresh project after a previous slice. Null hides
     * the button.
     */
    onStartEmptyPlate: (() -> Unit)? = null,
) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val recents by app.recentFiles.validRecents.collectAsState(initial = emptyList())

    val pickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri: Uri? ->
        if (uri != null) {
            // Audit H_PIXEL10 (2026-05-07) — wrap the import body in
            // runCatching so a single bad URI / DataStore IOException
            // / staging-timeout doesn't crash the process. Coroutine
            // failures inside `rememberCoroutineScope().launch` reach
            // the dispatcher's default handler (Thread uncaught →
            // CrashReporter → OS kill); the user just sees the app
            // close. Surface the failure as a Toast and a recoverable
            // log line instead.
            scope.launch {
                runCatching {
                    val staged = stageUriBounded(ctx, uri)
                    if (staged != null) {
                        app.recentFiles.add(staged)
                        onOpenInSlicer(staged.absolutePath)
                        true
                    } else {
                        false
                    }
                }.onSuccess { loaded ->
                    if (!loaded) {
                        android.widget.Toast.makeText(
                            ctx,
                            "Unsupported or empty file — only STL / 3MF / OBJ / AMF / STEP up to 500 MB.",
                            android.widget.Toast.LENGTH_LONG,
                        ).show()
                    }
                }.onFailure { t ->
                    android.util.Log.w(
                        "OrcaXR/files",
                        "import failed for $uri: ${t.javaClass.simpleName}: ${t.message}",
                        t,
                    )
                    android.widget.Toast.makeText(
                        ctx,
                        "Couldn't open file: ${t.javaClass.simpleName}: ${t.message ?: "unknown error"}",
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Files",
            subtitle = "Recent imports · ${recents.size}",
            actions = {
                if (onStartEmptyPlate != null) {
                    androidx.compose.material3.OutlinedButton(
                        onClick = onStartEmptyPlate,
                    ) { Text("Empty plate") }
                    Spacer(Modifier.width(8.dp))
                }
                Button(
                    onClick = {
                        pickerLauncher.launch(arrayOf(
                            "model/3mf", "application/x-3mf",
                            "model/stl", "application/sla",
                            "model/obj", "model/amf",
                            "application/octet-stream",
                            "*/*",
                        ))
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                ) {
                    Icon(Icons.Outlined.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Import")
                }
            },
        )

        if (recents.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(20.dp)) {
                EmptyStateCard(
                    title = "No models imported yet",
                    body = "Tap Import to pick a 3MF / STL / OBJ / AMF / STEP from your device. Files shared from MakerWorld, Bambu Handy, or any browser will also land here.",
                    cta = "Import file",
                    onCta = { pickerLauncher.launch(arrayOf("*/*")) },
                )
            }
        } else {
            LazyColumn(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { HandyModelsCard() }
                if (isTablet) {
                    items(recents.chunked(2)) { chunk ->
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            for (r in chunk) Box(Modifier.weight(1f)) {
                                FileRow(r, onOpenInSlicer = onOpenInSlicer, onRemove = {
                                    scope.launch { app.recentFiles.remove(r.path) }
                                })
                            }
                            if (chunk.size == 1) Box(Modifier.weight(1f))
                        }
                    }
                } else {
                    items(recents) { r ->
                        FileRow(r, onOpenInSlicer = onOpenInSlicer, onRemove = {
                            scope.launch { app.recentFiles.remove(r.path) }
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun FileRow(
    r: RecentFile,
    onOpenInSlicer: (String) -> Unit,
    onRemove: () -> Unit,
) {
    val file = remember(r.path) { File(r.path) }
    val sizeText = remember(r.path) { runCatching { formatBytes(file.length()) }.getOrDefault("—") }
    val openedText = remember(r.openedAtMs) {
        if (r.openedAtMs > 0L) DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(r.openedAtMs))
        else "—"
    }
    MobileCard(onClick = { onOpenInSlicer(r.path) }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(44.dp)
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.FilePresent,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    r.label,
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "$sizeText · $openedText",
                    style = LocalMobileTextStyles.current.numeric,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "Remove from recents",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Copy the bytes behind [uri] into cacheDir/shared/<hash>.<ext>. */
private suspend fun stageUriBounded(ctx: Context, uri: Uri): File? {
    val sharedDir = File(ctx.cacheDir, "shared").apply { mkdirs() }
    return SharedIntentHandler.stageUriBounded(ctx.contentResolver, uri, sharedDir)
}

/**
 * Bundled "handy models" picker — the phone affordance for the
 * `add_handy_model` MCP tool (was XR-voice-only, absent on phone).
 * Routes through [dev.orcaxr.app.mobile.HandyModelRunner] →
 * `add_handy_model`, which emits LoadModelFromPath; the shell binding
 * then navigates to the Slicer automatically. ([[feedback_ui_mcp_parity]])
 */
@Composable
private fun HandyModelsCard() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<String?>(null) }
    MobileCard {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionKicker("Handy models")
            Text(
                "Bundled test & calibration meshes — tap to load into the slicer.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            for (m in dev.orcaxr.app.mobile.HandyModelRunner.entries()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = busy == null) {
                            busy = m.id
                            scope.launch {
                                runCatching {
                                    val r = dev.orcaxr.app.mobile.HandyModelRunner
                                        .add(ctx.applicationContext, m.id, replace = true)
                                    if (!r.ok) {
                                        android.widget.Toast.makeText(
                                            ctx, r.message, android.widget.Toast.LENGTH_LONG,
                                        ).show()
                                    }
                                }.onFailure {
                                    android.util.Log.w("OrcaXR/handy", "load failed", it)
                                    android.widget.Toast.makeText(
                                        ctx, "Couldn't load ${m.displayName}.",
                                        android.widget.Toast.LENGTH_LONG,
                                    ).show()
                                }
                                busy = null
                            }
                        }
                        .padding(vertical = 6.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            m.displayName,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            m.hint,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (busy == m.id) {
                        Text("…", style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }
}
