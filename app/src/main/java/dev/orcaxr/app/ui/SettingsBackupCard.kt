package dev.orcaxr.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.SettingsBackup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * Roadmap B13 — Settings panel card with Export / Import buttons.
 *
 * Self-contained: writes JSON exports to `Downloads/orcaxr-settings-
 * <timestamp>.json`, reads imports back via Android's system file
 * picker (`ActivityResultContracts.OpenDocument` — `application/json`).
 * Status is held in local Composable state and shown inline below the
 * buttons so the user has confirmation feedback without opening logs.
 *
 * Drops into [SettingsPanel] alongside `McpServerCard` and
 * `LlmAssistantCard`.
 */
@Composable
fun SettingsBackupCard() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    // Picker for import. application/json + the Android-canonical
    // octet-stream fallback so an export written without an extension
    // still surfaces.
    val importPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            status = "Importing…"
            val report = withContext(Dispatchers.IO) {
                val text = runCatching {
                    ctx.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                }.getOrNull()
                if (text.isNullOrBlank()) {
                    null
                } else {
                    runCatching {
                        SettingsBackup.importJson(ctx, JSONObject(text), mode = "merge")
                    }.getOrNull()
                }
            }
            busy = false
            status = if (report == null) {
                "Import failed — file unreadable or not valid JSON."
            } else {
                "Imported. ${report.storesRestored} store(s), " +
                    "${report.sharedPrefKeysRestored} pref key(s). " +
                    "Restart OrcaXR for changes to take effect."
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1B2026), RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "Settings backup",
            style = MaterialTheme.typography.titleMedium,
            color = Color.White,
        )
        Text(
            "Export every persistent OrcaXR setting (printers, profiles, plates, filaments, " +
                "MCP server config, paint sessions, recents) as a single JSON bundle. " +
                "Import on another device or after a factory reset to restore everything in " +
                "one shot. Restart OrcaXR after import for changes to apply.",
            style = MaterialTheme.typography.bodySmall,
            color = Color(0xFFB6BEC8),
        )
        Spacer(Modifier.height(4.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        status = "Exporting…"
                        val out = withContext(Dispatchers.IO) {
                            runCatching {
                                val envelope = SettingsBackup.exportJson(ctx)
                                val downloads = android.os.Environment.getExternalStoragePublicDirectory(
                                    android.os.Environment.DIRECTORY_DOWNLOADS,
                                )
                                if (!downloads.exists()) downloads.mkdirs()
                                val ts = java.text.SimpleDateFormat(
                                    "yyyyMMdd-HHmmss",
                                    java.util.Locale.US,
                                ).format(java.util.Date())
                                val dest = File(downloads, "orcaxr-settings-$ts.json")
                                dest.writeText(envelope.toString(2))
                                dest
                            }.getOrNull()
                        }
                        busy = false
                        status = if (out == null) {
                            "Export failed — could not write to Downloads."
                        } else {
                            "Exported to ${out.name} (${out.length() / 1024} KB)."
                        }
                    }
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF2A8B6E),
                    contentColor = Color.White,
                ),
            ) {
                Text("Export to Downloads")
            }
            OutlinedButton(
                enabled = !busy,
                onClick = { importPicker.launch(arrayOf("application/json", "*/*")) },
            ) {
                Text("Import…", color = Color.White)
            }
        }

        status?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFF80E0C8),
            )
        }
    }
}
