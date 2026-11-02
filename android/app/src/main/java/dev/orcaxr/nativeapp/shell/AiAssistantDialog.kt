package dev.orcaxr.nativeapp.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.ai.AICoreStatus
import dev.orcaxr.nativeapp.ai.AssistantMessage
import dev.orcaxr.nativeapp.ai.DownloadState
import dev.orcaxr.nativeapp.ai.LlmBackend
import dev.orcaxr.nativeapp.ai.LlmModelManager
import dev.orcaxr.nativeapp.ai.OrcaAiAssistant
import dev.orcaxr.nativeapp.ai.VoiceInputManager
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AiAssistantDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val modelManager = remember { LlmModelManager.getInstance(context) }
    val assistant = remember { OrcaAiAssistant(context, modelManager) }

    val activeEngine by modelManager.activeEngine.collectAsState()
    val aiCoreStatus by modelManager.aiCoreStatus.collectAsState()
    val downloadState by modelManager.downloadState.collectAsState()

    val voiceManager = remember { VoiceInputManager.getInstance(context) }
    val isListening by voiceManager.isListening.collectAsState()
    val partialText by voiceManager.partialText.collectAsState()

    var inputText by remember { mutableStateOf("") }
    var isThinking by remember { mutableStateOf(false) }
    var showModelSettings by remember { mutableStateOf(false) }
    val messages = remember {
        mutableStateListOf(
            AssistantMessage(
                isUser = false,
                text = "Hi! I am Orca AI, your on-device 3D printing assistant. You can ask me to change filaments, slice plates, rotate objects, or check printer status completely offline.",
            )
        )
    }
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    fun submitPrompt(prompt: String) {
        if (prompt.isBlank() || isThinking) return
        val userMsg = prompt.trim()
        inputText = ""
        val historySnapshot = messages.toList()
        messages.add(AssistantMessage(isUser = true, text = userMsg))
        isThinking = true

        scope.launch {
            try {
                val res = assistant.query(userMsg, historySnapshot)
                messages.add(
                    AssistantMessage(
                        isUser = false,
                        text = res.text,
                        toolCall = res.toolCall,
                        toolResult = res.toolResultText,
                    )
                )
            } catch (t: Throwable) {
                messages.add(
                    AssistantMessage(
                        isUser = false,
                        text = "Error: ${t.message}",
                    )
                )
            } finally {
                isThinking = false
            }
        }
    }

    LaunchedEffect(partialText) {
        if (isListening && partialText.isNotBlank()) {
            inputText = partialText
        }
    }

    val micPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        if (isGranted) {
            voiceManager.startListening { spoken ->
                inputText = spoken
                submitPrompt(spoken)
            }
        }
    }

    fun toggleVoiceInput() {
        if (isListening) {
            voiceManager.stopListening()
        } else {
            val hasPermission = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED
            if (hasPermission) {
                voiceManager.startListening { spoken ->
                    inputText = spoken
                    submitPrompt(spoken)
                }
            } else {
                micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        painter = painterResource(id = R.drawable.ic_symbol_wand_stars),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Orca AI Assistant",
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp,
                    )
                }

                // Active engine indicator chip
                val (dotColor, label) = when {
                    activeEngine?.backendKind == LlmBackend.AICORE -> Color(0xFF4CAF50) to "Tensor TPU"
                    activeEngine?.backendKind == LlmBackend.LITERT -> Color(0xFF4CAF50) to "Gemma (${activeEngine?.backendName})"
                    downloadState is DownloadState.Downloading -> Color(0xFFFF9800) to "Downloading..."
                    aiCoreStatus is AICoreStatus.Downloading -> Color(0xFFFF9800) to "Downloading..."
                    else -> Color(0xFF9E9E9E) to "No Model"
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .clickable { showModelSettings = !showModelSettings }
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(dotColor)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = label,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 500.dp),
            ) {
                // Expandable Model & Hardware info
                if (showModelSettings || activeEngine == null) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    ) {
                        Column(modifier = Modifier.padding(10.dp)) {
                            Text(
                                text = "On-Device Hardware & Models",
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                            )
                            Spacer(modifier = Modifier.height(4.dp))

                            // Tensor TPU (AICore) row
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("Google Tensor TPU (Gemini Nano)", fontWeight = FontWeight.Medium, fontSize = 12.sp)
                                    val statusDesc = when (val s = aiCoreStatus) {
                                        is AICoreStatus.Ready -> "Ready & Active"
                                        is AICoreStatus.Downloadable -> "Available in system (download needed)"
                                        is AICoreStatus.Downloading -> "Downloading (${(s.progress * 100).toInt()}%)"
                                        is AICoreStatus.Warming -> "Warming up..."
                                        is AICoreStatus.Unavailable -> "Unavailable (${s.reason})"
                                        is AICoreStatus.Error -> "Error: ${s.message}"
                                        AICoreStatus.Unknown -> "Probing..."
                                    }
                                    Text(statusDesc, fontSize = 11.sp, color = Color.Gray)
                                }
                                if (aiCoreStatus is AICoreStatus.Downloadable) {
                                    TextButton(onClick = { modelManager.downloadAiCore() }) {
                                        Text("Download feature", fontSize = 11.sp)
                                    }
                                }
                            }

                            Spacer(modifier = Modifier.height(6.dp))

                            // Gemma (LiteRT) row
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("Gemma 4 E2B (.litertlm)", fontWeight = FontWeight.Medium, fontSize = 12.sp)
                                    val gemmaDesc = when (val s = downloadState) {
                                        is DownloadState.Ready -> "Ready (${s.file.name}, ${(s.file.length() / (1024 * 1024))} MB)"
                                        is DownloadState.Downloading -> "Downloading (${(s.progress * 100).toInt()}%)"
                                        is DownloadState.Idle -> "Not downloaded (2.6 GB)"
                                        is DownloadState.Error -> "Error: ${s.message}"
                                    }
                                    Text(gemmaDesc, fontSize = 11.sp, color = Color.Gray)
                                }
                                when (val s = downloadState) {
                                    is DownloadState.Idle -> {
                                        TextButton(onClick = { modelManager.downloadLiteRtModel() }) {
                                            Text("Download (2.6 GB)", fontSize = 11.sp)
                                        }
                                    }
                                    is DownloadState.Downloading -> {
                                        CircularProgressIndicator(
                                            progress = { s.progress },
                                            modifier = Modifier.size(20.dp),
                                            strokeWidth = 2.dp,
                                        )
                                    }
                                    is DownloadState.Ready -> {
                                        TextButton(onClick = { modelManager.downloadManager.deleteModel() }) {
                                            Text("Remove model", fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
                                        }
                                    }
                                    is DownloadState.Error -> {
                                        TextButton(onClick = { modelManager.downloadLiteRtModel() }) {
                                            Text("Retry", fontSize = 11.sp)
                                        }
                                    }
                                }
                            }

                            if (downloadState is DownloadState.Downloading) {
                                val prog = (downloadState as DownloadState.Downloading).progress
                                Spacer(modifier = Modifier.height(4.dp))
                                LinearProgressIndicator(
                                    progress = { prog },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                    }
                }

                // Chat Message List
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(messages) { msg ->
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalAlignment = if (msg.isUser) Alignment.End else Alignment.Start,
                        ) {
                            Box(
                                modifier = Modifier
                                    .clip(
                                        RoundedCornerShape(
                                            topStart = 12.dp,
                                            topEnd = 12.dp,
                                            bottomStart = if (msg.isUser) 12.dp else 2.dp,
                                            bottomEnd = if (msg.isUser) 2.dp else 12.dp,
                                        )
                                    )
                                    .background(
                                        if (msg.isUser) MaterialTheme.colorScheme.primaryContainer
                                        else MaterialTheme.colorScheme.surfaceVariant
                                    )
                                    .padding(horizontal = 12.dp, vertical = 8.dp)
                            ) {
                                Text(
                                    text = msg.text,
                                    fontSize = 13.sp,
                                    color = if (msg.isUser) MaterialTheme.colorScheme.onPrimaryContainer
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }

                            // If tool call details are attached
                            if (msg.toolCall != null) {
                                Spacer(modifier = Modifier.height(4.dp))
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth(0.95f)
                                        .padding(top = 2.dp),
                                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                                ) {
                                    Column(modifier = Modifier.padding(8.dp)) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(
                                                text = "⚡ Tool: ",
                                                fontWeight = FontWeight.Bold,
                                                fontSize = 11.sp,
                                                color = MaterialTheme.colorScheme.primary,
                                            )
                                            Text(
                                                text = msg.toolCall.name,
                                                fontFamily = FontFamily.Monospace,
                                                fontWeight = FontWeight.SemiBold,
                                                fontSize = 11.sp,
                                            )
                                        }
                                        if (msg.toolCall.arguments.isNotBlank() && msg.toolCall.arguments != "{}") {
                                            Spacer(modifier = Modifier.height(2.dp))
                                            Text(
                                                text = msg.toolCall.arguments,
                                                fontFamily = FontFamily.Monospace,
                                                fontSize = 10.sp,
                                                color = Color.DarkGray,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (isThinking) {
                        item {
                            Row(
                                modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(14.dp),
                                    strokeWidth = 2.dp,
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = "Orca AI is thinking...",
                                    fontSize = 12.sp,
                                    color = Color.Gray,
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                // Suggestion chips
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    SuggestionChip(
                        onClick = { submitPrompt("Resize the model to 150%") },
                        label = { Text("Resize to 150%", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Scale model to fit the build volume") },
                        label = { Text("Scale to fit bed", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Smart paint the top half white") },
                        label = { Text("Smart paint top white", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Paint model like Pikachu with full spectrum") },
                        label = { Text("Paint Pikachu (Full)", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Paint model like Pikachu using available filaments only") },
                        label = { Text("Paint Pikachu (Available)", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Change filament 1 for 3 and filament 2 for 4") },
                        label = { Text("Swap 1→3, 2→4", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Slice active plate") },
                        label = { Text("Slice plate", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Duplicate the model") },
                        label = { Text("Duplicate model", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Auto arrange all models on bed") },
                        label = { Text("Arrange bed", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("What is the estimated print time?") },
                        label = { Text("Print time?", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("What is the printer status?") },
                        label = { Text("Check printer", fontSize = 11.sp) },
                    )
                    SuggestionChip(
                        onClick = { submitPrompt("Center model on plate") },
                        label = { Text("Center model", fontSize = 11.sp) },
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                // Input Box
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = inputText,
                        onValueChange = { inputText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Ask Orca AI anything...", fontSize = 13.sp) },
                        maxLines = 3,
                        shape = RoundedCornerShape(20.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    IconButton(
                        onClick = ::toggleVoiceInput,
                        enabled = !isThinking,
                    ) {
                        Icon(
                            painter = painterResource(id = R.drawable.ic_symbol_mic),
                            contentDescription = "Voice Input",
                            tint = if (isListening) Color(0xFFE53935) else MaterialTheme.colorScheme.primary,
                        )
                    }
                    IconButton(
                        onClick = { submitPrompt(inputText) },
                        enabled = inputText.isNotBlank() && !isThinking,
                    ) {
                        Icon(
                            painter = painterResource(id = R.drawable.ic_symbol_send),
                            contentDescription = "Send",
                            tint = if (inputText.isNotBlank() && !isThinking) MaterialTheme.colorScheme.primary else Color.Gray,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Close")
            }
        },
    )
}
