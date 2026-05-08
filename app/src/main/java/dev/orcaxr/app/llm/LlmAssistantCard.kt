package dev.orcaxr.app.llm

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.llm.local.Gemma4Catalog
import dev.orcaxr.app.llm.local.Gemma4DownloadRepository
import dev.orcaxr.app.llm.local.Gemma4Size
import kotlinx.coroutines.launch

/**
 * Devices-panel card for the optional in-app LLM assistant. Mirrors
 * [dev.orcaxr.app.mcp.McpServerCard]'s style so the two cards read as
 * a related pair.
 *
 * Three controls:
 * - Provider picker (Claude / Gemini / OpenAI). Per-provider key field
 *   underneath; a key entered for one provider doesn't affect the
 *   others. The picker also writes [LlmSettings.selectedProvider] so
 *   the assistant panel knows which key to use.
 * - Voice toggle. Enabled separately from the assistant — the user
 *   may want text-only chat in a noisy environment.
 * - Open Assistant button. Opens the chat panel ([LlmAssistantPanel])
 *   via the `onOpenAssistant` callback. Disabled until the selected
 *   provider has a key.
 *
 * Self-contained — reads/writes [LlmSettings] directly, same pattern
 * as McpServerCard with McpController.
 */
@Composable
fun LlmAssistantCard(
    modifier: Modifier = Modifier,
    onOpenAssistant: () -> Unit,
) {
    val context = LocalContext.current
    val settings = remember { LlmSettings.get(context) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current

    val selected by settings.selectedProvider.collectAsState(initial = LlmProvider.Claude)
    val claudeKey by settings.claudeApiKey.collectAsState(initial = null)
    val geminiKey by settings.geminiApiKey.collectAsState(initial = null)
    val openAiKey by settings.openAiApiKey.collectAsState(initial = null)
    val claudeModel by settings.claudeModel.collectAsState(initial = null)
    val geminiModel by settings.geminiModel.collectAsState(initial = null)
    val openAiModel by settings.openAiModel.collectAsState(initial = null)
    val voiceEnabled by settings.voiceEnabled.collectAsState(initial = false)
    val localSize by settings.localModelSize.collectAsState(initial = Gemma4Size.E2B)

    // One repository per Gemma 4 size — switching size on the
    // picker rebinds the StateFlow and the download-status UI
    // updates. Cheap to construct (just a WorkManager handle).
    val localRepo = remember(localSize) {
        Gemma4DownloadRepository(context.applicationContext, Gemma4Catalog.forSize(localSize))
    }
    val localStatus by localRepo.statusFlow().collectAsState(
        initial = localRepo.status.value,
    )
    val localReady = localStatus is Gemma4DownloadRepository.Status.Complete

    val currentKey = when (selected) {
        LlmProvider.Claude -> claudeKey
        LlmProvider.Gemini -> geminiKey
        LlmProvider.OpenAI -> openAiKey
        LlmProvider.Local -> null
    }
    val currentModel = when (selected) {
        LlmProvider.Claude -> claudeModel
        LlmProvider.Gemini -> geminiModel
        LlmProvider.OpenAI -> openAiModel
        LlmProvider.Local -> null
    }
    /** True when the active provider can chat right now (cloud has a
     *  key, or local has the bundle downloaded). The Open-assistant
     *  button gates on this. */
    val activeReady = when (selected) {
        LlmProvider.Local -> localReady
        else -> !currentKey.isNullOrBlank()
    }
    val anyKeySet = !claudeKey.isNullOrBlank() || !geminiKey.isNullOrBlank() ||
        !openAiKey.isNullOrBlank()

    var draftKey by remember(selected, currentKey) {
        mutableStateOf(currentKey ?: "")
    }
    var draftModel by remember(selected, currentModel) {
        mutableStateOf(currentModel ?: "")
    }
    var showKey by remember(selected) { mutableStateOf(false) }
    var lastSavedAt by remember(selected) { mutableStateOf<String?>(null) }
    val defaultModelForProvider = when (selected) {
        LlmProvider.Claude -> dev.orcaxr.app.llm.ClaudeLlmClient.DEFAULT_MODEL
        LlmProvider.Gemini -> dev.orcaxr.app.llm.GeminiLlmClient.DEFAULT_MODEL
        LlmProvider.OpenAI -> dev.orcaxr.app.llm.OpenAiLlmClient.DEFAULT_MODEL
        LlmProvider.Local -> "Gemma 4"  // unused — Local takes the local-row branch below
    }

    Surface(
        color = Color(0xFF12253A),
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                "AI assistant",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                "Optional. Talk to OrcaXR using Claude, Gemini, OpenAI, or on-device Gemma 4. " +
                    "Cloud keys stay on this device and are billed to your own account; " +
                    "Local Gemma 4 runs entirely on the headset GPU with no per-token cost.",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(12.dp))

            // Provider picker. 4 tiles wrap onto one row at the
            // typical Devices panel width — the labels are short
            // enough that auto-weight keeps the typography legible.
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                for (p in LlmProvider.entries) {
                    val isSelected = p == selected
                    val isConfigured = when (p) {
                        LlmProvider.Claude -> !claudeKey.isNullOrBlank()
                        LlmProvider.Gemini -> !geminiKey.isNullOrBlank()
                        LlmProvider.OpenAI -> !openAiKey.isNullOrBlank()
                        // For Local, "configured" means the active
                        // size's bundle is on disk. Switching size
                        // on the picker re-evaluates this.
                        LlmProvider.Local -> localReady
                    }
                    Surface(
                        color = if (isSelected) Color(0xFF4F8FF7) else Color(0xFF0F1A28),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .weight(1f)
                            .height(44.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    scope.launch { settings.setSelectedProvider(p) }
                                }
                                .padding(horizontal = 8.dp),
                        ) {
                            Text(
                                p.displayName,
                                color = if (isSelected) Color.White else Color(0xFFB6BEC8),
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            if (isConfigured) {
                                Spacer(Modifier.height(0.dp))
                                Text(
                                    "  •",
                                    color = if (isSelected) Color.White else Color(0xFF4F8FF7),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(10.dp))

            // Local backend has its own configuration UI (model size
            // picker + download button), inline below. The cloud
            // path falls through to the existing API-key + model
            // override fields.
            if (selected == LlmProvider.Local) {
                LocalGemmaConfigRow(
                    selectedSize = localSize,
                    onSizeChange = { newSize ->
                        scope.launch { settings.setLocalModelSize(newSize) }
                    },
                    status = localStatus,
                    onDownload = { localRepo.start() },
                    onCancel = { localRepo.cancel() },
                    onDelete = { localRepo.deleteLocalCopy() },
                )
                Spacer(Modifier.height(12.dp))
            }

            // Hide the cloud key/model rows when Local is selected —
            // they're meaningless there. Voice toggle and Open
            // Assistant stay visible for both.
            if (selected != LlmProvider.Local) {
            Text(
                "${selected.keyName} API key",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = draftKey,
                onValueChange = { draftKey = it },
                placeholder = {
                    Text(
                        when (selected) {
                            LlmProvider.Claude -> "sk-ant-…"
                            LlmProvider.Gemini -> "AIza…"
                            LlmProvider.OpenAI -> "sk-…"
                            // Unreachable — this Composable subtree is gated on
                            // `selected != LlmProvider.Local` above. Compiler
                            // still needs the arm for exhaustiveness.
                            LlmProvider.Local -> ""
                        },
                        color = Color(0xFF6A7484),
                    )
                },
                singleLine = true,
                visualTransformation = if (showKey) VisualTransformation.None
                    else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (showKey) KeyboardType.Text else KeyboardType.Password,
                ),
                colors = TextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    focusedContainerColor = Color(0xFF0F1A28),
                    unfocusedContainerColor = Color(0xFF0F1A28),
                    focusedIndicatorColor = Color(0xFF4F8FF7),
                    unfocusedIndicatorColor = Color(0xFF2A3A4F),
                    cursorColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { showKey = !showKey },
                    shape = RoundedCornerShape(8.dp),
                ) { Text(if (showKey) "Hide" else "Show") }
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            val text = clipboard.getClipEntry()?.clipData?.getItemAt(0)?.text
                            if (!text.isNullOrBlank()) {
                                draftKey = text.toString().trim()
                            }
                        }
                    },
                    shape = RoundedCornerShape(8.dp),
                ) { Text("Paste") }
                Button(
                    onClick = {
                        scope.launch {
                            val v = draftKey.trim()
                            when (selected) {
                                LlmProvider.Claude -> settings.setClaudeApiKey(v.ifEmpty { null })
                                LlmProvider.Gemini -> settings.setGeminiApiKey(v.ifEmpty { null })
                                LlmProvider.OpenAI -> settings.setOpenAiApiKey(v.ifEmpty { null })
                                LlmProvider.Local -> Unit  // unreachable; cloud-only branch
                            }
                            lastSavedAt = if (v.isEmpty()) "Cleared." else "Saved."
                        }
                    },
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
                ) { Text("Save") }
                if (!currentKey.isNullOrBlank()) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                when (selected) {
                                    LlmProvider.Claude -> settings.setClaudeApiKey(null)
                                    LlmProvider.Gemini -> settings.setGeminiApiKey(null)
                                    LlmProvider.OpenAI -> settings.setOpenAiApiKey(null)
                                    LlmProvider.Local -> Unit  // unreachable; cloud-only branch
                                }
                                draftKey = ""
                                lastSavedAt = "Cleared."
                            }
                        },
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Clear") }
                }
            }
            lastSavedAt?.let { msg ->
                Spacer(Modifier.height(4.dp))
                Text(
                    msg,
                    color = Color(0xFF6FBF73),
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            Spacer(Modifier.height(12.dp))

            // Model override. Empty = use the per-provider DEFAULT_MODEL
            // constant from LlmClient.kt. Audit H_PIXEL10 (2026-05-08):
            // we made this user-overridable because each provider's
            // published model IDs rotate often and a 400 INVALID_ARGUMENT
            // is the typical symptom of a stale baked-in default. Letting
            // the user paste in whatever model id their key has access
            // to is cheaper than shipping a release for every model
            // family flip.
            Text(
                "Model (override; empty = $defaultModelForProvider)",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = draftModel,
                onValueChange = { draftModel = it },
                placeholder = {
                    Text(
                        defaultModelForProvider,
                        color = Color(0xFF6A7484),
                    )
                },
                singleLine = true,
                colors = TextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    focusedContainerColor = Color(0xFF0F1A28),
                    unfocusedContainerColor = Color(0xFF0F1A28),
                    focusedIndicatorColor = Color(0xFF4F8FF7),
                    unfocusedIndicatorColor = Color(0xFF2A3A4F),
                    cursorColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        scope.launch {
                            val v = draftModel.trim()
                            when (selected) {
                                LlmProvider.Claude -> settings.setClaudeModel(v.ifEmpty { null })
                                LlmProvider.Gemini -> settings.setGeminiModel(v.ifEmpty { null })
                                LlmProvider.OpenAI -> settings.setOpenAiModel(v.ifEmpty { null })
                                LlmProvider.Local -> Unit  // unreachable; cloud-only branch
                            }
                            lastSavedAt =
                                if (v.isEmpty()) "Reverted to $defaultModelForProvider."
                                else "Model: $v."
                        }
                    },
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
                ) { Text("Save model") }
                if (!currentModel.isNullOrBlank()) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                when (selected) {
                                    LlmProvider.Claude -> settings.setClaudeModel(null)
                                    LlmProvider.Gemini -> settings.setGeminiModel(null)
                                    LlmProvider.OpenAI -> settings.setOpenAiModel(null)
                                    LlmProvider.Local -> Unit  // unreachable; cloud-only branch
                                }
                                draftModel = ""
                                lastSavedAt = "Reverted to $defaultModelForProvider."
                            }
                        },
                        shape = RoundedCornerShape(8.dp),
                    ) { Text("Default") }
                }
            }

            Spacer(Modifier.height(12.dp))
            } // end `if (selected != LlmProvider.Local)` — cloud key/model rows

            // Voice toggle.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Voice commands",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "Use the headset microphone to dictate prompts. " +
                            "Asks for microphone permission the first time.",
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Switch(
                    checked = voiceEnabled,
                    onCheckedChange = { v ->
                        scope.launch { settings.setVoiceEnabled(v) }
                    },
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = Color(0xFF4F8FF7),
                        checkedThumbColor = Color.White,
                    ),
                )
            }

            Spacer(Modifier.height(12.dp))

            Button(
                onClick = onOpenAssistant,
                enabled = activeReady,
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    when {
                        activeReady -> "Open assistant"
                        selected == LlmProvider.Local ->
                            "Download Gemma 4 ${localSize.name} to open the assistant"
                        else -> "Add a key to open the assistant"
                    },
                )
            }

            if (anyKeySet || localReady) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "The assistant can drive every action OrcaXR exposes through MCP " +
                        "(load models, slice, paint, control printers). It runs in-process; " +
                        "cloud prompts go directly to the selected provider, and Local prompts " +
                        "never leave the headset.",
                    color = Color(0xFF9AA5B1),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}

/**
 * Local Gemma 4 configuration row — model size picker (E2B / E4B)
 * plus download / cancel / delete affordance with progress display.
 *
 * Lives in the same file as the parent card because it shares a lot
 * of the surrounding visual style (color palette, spacing, button
 * shapes) and is only used here.
 */
@Composable
private fun LocalGemmaConfigRow(
    selectedSize: Gemma4Size,
    onSizeChange: (Gemma4Size) -> Unit,
    status: Gemma4DownloadRepository.Status,
    onDownload: () -> Unit,
    onCancel: () -> Unit,
    onDelete: () -> Unit,
) {
    val activeSpec = Gemma4Catalog.forSize(selectedSize)
    Text(
        "Local Gemma 4 model",
        color = Color(0xFFB6BEC8),
        style = MaterialTheme.typography.labelSmall,
    )
    Spacer(Modifier.height(4.dp))
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        for (size in Gemma4Size.entries) {
            val isSelected = size == selectedSize
            val spec = Gemma4Catalog.forSize(size)
            Surface(
                color = if (isSelected) Color(0xFF1F4D6E) else Color(0xFF0F1A28),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .weight(1f)
                    .height(56.dp),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSizeChange(size) }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Text(
                        size.name,
                        color = if (isSelected) Color.White else Color(0xFFB6BEC8),
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        spec.displaySize,
                        color = Color(0xFF9AA5B1),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }
    }
    Spacer(Modifier.height(8.dp))
    when (status) {
        is Gemma4DownloadRepository.Status.Idle -> {
            Text(
                "Not downloaded. The first download is ${activeSpec.displaySize}; " +
                    "default constraint is unmetered Wi-Fi.",
                color = Color(0xFF9AA5B1),
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(6.dp))
            Button(
                onClick = onDownload,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
            ) { Text("Download Gemma 4 ${selectedSize.name}") }
        }
        is Gemma4DownloadRepository.Status.Downloading -> {
            val mb = status.bytesDownloaded / 1_048_576L
            val totalMb = status.bytesTotal / 1_048_576L
            val mbps = status.bytesPerSec / 1_048_576.0
            val pct = if (status.bytesTotal > 0) {
                ((status.bytesDownloaded * 100L) / status.bytesTotal).toInt().coerceIn(0, 100)
            } else 0
            Text(
                "Downloading… $pct%   $mb / $totalMb MB   %.1f MB/s".format(mbps),
                color = Color.White,
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(6.dp))
            OutlinedButton(
                onClick = onCancel,
                shape = RoundedCornerShape(8.dp),
            ) { Text("Cancel") }
        }
        is Gemma4DownloadRepository.Status.Complete -> {
            Text(
                "${activeSpec.displayName} ready (${activeSpec.displaySize}).",
                color = Color(0xFF8AE0A0),
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(6.dp))
            OutlinedButton(
                onClick = onDelete,
                shape = RoundedCornerShape(8.dp),
            ) { Text("Delete weights (free ${activeSpec.displaySize})") }
        }
        is Gemma4DownloadRepository.Status.Failed -> {
            Text(
                "Download failed: ${status.reason}",
                color = Color(0xFFE07070),
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(6.dp))
            Button(
                onClick = onDownload,
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
            ) { Text("Retry") }
        }
    }
}
