package dev.orcaxr.app.llm

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.llm.aicore.AICoreEngineHolder
import dev.orcaxr.app.llm.aicore.AICoreStatus
import dev.orcaxr.app.llm.local.Gemma4Catalog
import dev.orcaxr.app.llm.local.Gemma4DownloadRepository
import dev.orcaxr.app.llm.local.Gemma4Size
import dev.orcaxr.app.llm.runner.AgentRunner
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Chat panel for the in-app LLM assistant. Drops into the workspace as
 * a SpatialPanel; the host wires `onClose` to flip the visibility flag
 * in MainActivity.
 *
 * Conversation loop:
 *  1. User sends text (typed or dictated).
 *  2. Panel appends a [LlmTurn.User] turn and calls
 *     [LlmClient.respond] with the running history + the full
 *     OrcaXR tool surface from [LlmToolBridge.toolDefs].
 *  3. If the response carries tool calls, the panel runs each one
 *     through [LlmToolBridge.execute], appends the
 *     [LlmTurn.Assistant] + per-call [LlmTurn.ToolResult] turns, and
 *     re-invokes the client. Loop until the model returns a final
 *     text turn (or the safety cap below trips).
 *  4. Final text shows in the transcript.
 *
 * Safety cap: the loop bails out after [MAX_TOOL_HOPS] hops so a
 * misbehaving model can't burn the user's API budget. The default of
 * 12 covers every realistic OrcaXR workflow (load → arrange → paint →
 * slice → upload is 5 hops).
 *
 * History is kept in a Compose mutableStateList. Persistence across
 * sessions isn't a goal yet — the cost / value is poor (a 100-turn
 * transcript with embedded tool blobs is cheap to redo and expensive
 * to store / paginate). Add it when users actually ask.
 */
@Composable
fun LlmAssistantPanel(
    onClose: () -> Unit,
    onRequestHomeSpaceMode: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val settings = remember { LlmSettings.get(context) }
    // The bridge is still used for the header tool-count display.
    // The runner has its own internal bridge for the actual loop;
    // both read the same process-singleton stores so they agree on
    // what tools exist.
    val bridge = remember { LlmToolBridge(context.applicationContext) }
    // P2: hoist the conversation + tool-loop into the AgentRunner
    // singleton so a turn survives the panel's dispose, the user
    // taking off the headset, and process death. The panel becomes
    // a pure observer + input forwarder — no in-flight Job here.
    val runner = remember { AgentRunner.get(context) }
    val scope = rememberCoroutineScope()

    val selected by settings.selectedProvider.collectAsState(initial = LlmProvider.Claude)
    val claudeKey by settings.claudeApiKey.collectAsState(initial = null)
    val geminiKey by settings.geminiApiKey.collectAsState(initial = null)
    val openAiKey by settings.openAiApiKey.collectAsState(initial = null)
    val claudeModel by settings.claudeModel.collectAsState(initial = null)
    val geminiModel by settings.geminiModel.collectAsState(initial = null)
    val openAiModel by settings.openAiModel.collectAsState(initial = null)
    val voiceEnabled by settings.voiceEnabled.collectAsState(initial = false)
    val localSize by settings.localModelSize.collectAsState(initial = Gemma4Size.E2B)

    // Local-backend readiness — the .litertlm has to be on disk for
    // [LocalLlmClient] to load it. We use the repository's
    // statusFlow for the active size; switching size flips this and
    // the send button updates accordingly.
    val localRepo = remember(localSize) {
        Gemma4DownloadRepository(context.applicationContext, Gemma4Catalog.forSize(localSize))
    }
    val localStatus by localRepo.statusFlow().collectAsState(
        initial = localRepo.status.value,
    )
    val localReady = localStatus is Gemma4DownloadRepository.Status.Complete

    // AICore readiness — re-probe whenever the user opens the panel
    // with AICore selected. Avoids stuck-Unknown after returning
    // from a background download triggered from the card.
    var aicoreStatus by remember { mutableStateOf<AICoreStatus>(AICoreStatus.Unknown) }
    LaunchedEffect(selected) {
        if (selected == LlmProvider.AICore) {
            aicoreStatus = AICoreEngineHolder.checkStatus(context)
        }
    }
    val aicoreReady = aicoreStatus is AICoreStatus.Ready

    val activeKey = when (selected) {
        LlmProvider.Claude -> claudeKey
        LlmProvider.Gemini -> geminiKey
        LlmProvider.OpenAI -> openAiKey
        LlmProvider.Local -> null
        LlmProvider.AICore -> null
    }?.takeIf { it.isNotBlank() }
    val activeModel = when (selected) {
        LlmProvider.Claude -> claudeModel
        LlmProvider.Gemini -> geminiModel
        LlmProvider.OpenAI -> openAiModel
        LlmProvider.Local -> null
        LlmProvider.AICore -> null
    }?.takeIf { it.isNotBlank() }
    /** Provider-agnostic readiness — true when the chat panel can
     *  send a message. Cloud needs a key; Local needs the bundle on
     *  disk; AICore needs the Gemini Nano feature pack provisioned. */
    val readyForSend = when (selected) {
        LlmProvider.Local -> localReady
        LlmProvider.AICore -> aicoreReady
        else -> activeKey != null
    }

    val turns by runner.turns.collectAsState()
    val runState by runner.runState.collectAsState()
    val isReplying = runState is AgentRunner.RunState.Replying
    val runnerLastError by runner.lastError.collectAsState()
    val interruptedOnLoad by runner.interruptedOnLoad.collectAsState()
    var draftText by remember { mutableStateOf("") }
    var voicePartial by remember { mutableStateOf<String?>(null) }
    /** Transient panel-local errors (mic permission denied, voice
     *  recogniser failures). Distinct from [runnerLastError]
     *  which surfaces agent-loop failures. Both render in the
     *  same banner. */
    var lastError by remember { mutableStateOf<String?>(null) }
    val effectiveError = lastError ?: runnerLastError

    val voice = remember { VoiceInput(context.applicationContext) }
    var voiceListening by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose { voice.release() }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!granted) lastError = "Microphone permission was denied."
    }

    fun startListening() {
        if (!VoiceInput.hasPermission(context)) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        voice.start(
            onPartial = { voicePartial = it },
            onFinal = { text ->
                voicePartial = null
                voiceListening = false
                if (text.isNotBlank()) runner.send(text)
            },
            onError = { msg ->
                voicePartial = null
                voiceListening = false
                lastError = msg
            },
        )
        voiceListening = true
    }

    fun stopListening() {
        voice.stop()
        voiceListening = false
    }

    Surface(
        color = Color(0xFF0A1422),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(modifier = Modifier.padding(20.dp).fillMaxSize()) {
            // Header.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Assistant",
                        color = Color.White,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "Talking to ${selected.displayName} · ${bridge.names().size} tools available",
                        color = Color(0xFFB6BEC8),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                IconButton(onClick = onClose) {
                    androidx.compose.material3.Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Close",
                        tint = Color(0xFFB6BEC8),
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            if (!readyForSend) {
                val (warningText, warningColor) = when (selected) {
                    LlmProvider.Local -> {
                        val status = localStatus
                        val msg = when (status) {
                            is Gemma4DownloadRepository.Status.Downloading -> {
                                val mb = status.bytesDownloaded / 1_048_576L
                                val total = status.bytesTotal / 1_048_576L
                                "Gemma 4 ${localSize.name} downloading… $mb / $total MB"
                            }
                            is Gemma4DownloadRepository.Status.Failed ->
                                "Gemma 4 ${localSize.name} download failed: ${status.reason}. " +
                                    "Retry from Devices → AI assistant."
                            else ->
                                "Gemma 4 ${localSize.name} not yet on disk. Download from " +
                                    "Devices → AI assistant to start chatting on-device."
                        }
                        msg to Color(0xFFE0B070)
                    }
                    LlmProvider.AICore -> {
                        val msg = when (val s = aicoreStatus) {
                            is AICoreStatus.Downloadable ->
                                "Gemini Nano not provisioned yet. Download it from " +
                                    "Devices → AI assistant to start chatting on-device."
                            is AICoreStatus.Downloading -> {
                                val mb = s.bytesDownloaded / 1_048_576L
                                if (mb > 0L) "Gemini Nano downloading… $mb MB"
                                else "Gemini Nano downloading…"
                            }
                            is AICoreStatus.Warming -> "Gemini Nano warming up…"
                            is AICoreStatus.Unavailable ->
                                "AICore unavailable on this device (${s.reason}). " +
                                    "Pick a different backend in Devices → AI assistant."
                            is AICoreStatus.Error ->
                                "AICore error: ${s.message}. Retry from Devices → AI assistant."
                            else -> "Checking AICore status…"
                        }
                        msg to Color(0xFFE0B070)
                    }
                    else -> "No ${selected.keyName} key set. Add one in Devices → AI assistant " +
                        "to start chatting." to Color(0xFFE0B070)
                }
                Surface(
                    color = Color(0xFF2A1F1A),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        warningText,
                        color = warningColor,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
            }

            // Transcript.
            val listState = rememberLazyListState()
            LaunchedEffect(turns.size) {
                if (turns.isNotEmpty()) listState.animateScrollToItem(turns.size - 1)
            }
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (turns.isEmpty()) {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(16.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            "Try one of these:",
                            color = Color(0xFFB6BEC8),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(8.dp))
                        for (suggestion in SUGGESTED_PROMPTS) {
                            SuggestionChip(suggestion) {
                                if (readyForSend) runner.send(suggestion)
                            }
                            Spacer(Modifier.height(6.dp))
                        }
                    }
                } else {
                    LazyColumn(
                        state = listState,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(turns.size) { idx ->
                            TranscriptRow(turns[idx])
                        }
                        if (isReplying) item { ReplyingRow() }
                    }
                }
            }

            voicePartial?.let { partial ->
                Spacer(Modifier.height(6.dp))
                Surface(
                    color = Color(0xFF1A2C42),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "🎙  $partial",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }
            // P2: surface "session was interrupted" once per load
            // so the user knows the previous turn didn't complete.
            // Acknowledging dismisses the banner; sending a new
            // message also dismisses it (runner clears the flag).
            if (interruptedOnLoad) {
                Spacer(Modifier.height(6.dp))
                Surface(
                    color = Color(0xFF2A1F1A),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp).fillMaxWidth(),
                    ) {
                        Text(
                            "Last turn was interrupted (process killed mid-turn). Send a new " +
                                "message to continue, or start a New chat.",
                            color = Color(0xFFE0B070),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.height(0.dp))
                        Text(
                            "Got it",
                            color = Color(0xFF7BC8FF),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.clickable { runner.acknowledgeInterruption() },
                        )
                    }
                }
            }
            effectiveError?.let { err ->
                Spacer(Modifier.height(6.dp))
                Surface(
                    color = Color(0xFF3A1A1A),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Text(
                            err,
                            color = Color(0xFFE07070),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(6.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            val ctx = androidx.compose.ui.platform.LocalContext.current
                            Text(
                                "Copy",
                                color = Color(0xFF7BC8FF),
                                style = MaterialTheme.typography.labelSmall,
                                modifier = Modifier.clickable {
                                    val cm =
                                        ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                                            as? android.content.ClipboardManager
                                    cm?.setPrimaryClip(
                                        android.content.ClipData.newPlainText(
                                            "OrcaXR LLM error",
                                            err,
                                        )
                                    )
                                    android.widget.Toast.makeText(
                                        ctx,
                                        "Error copied to clipboard",
                                        android.widget.Toast.LENGTH_SHORT,
                                    ).show()
                                },
                            )
                            Text(
                                "Dismiss",
                                color = Color(0xFFB6BEC8),
                                style = MaterialTheme.typography.labelSmall,
                                // Dismiss covers both panel-local mic
                                // errors and runner errors. The runner
                                // clears its lastError on the next
                                // successful send; explicit dismiss
                                // also nulls the panel-local copy.
                                modifier = Modifier.clickable { lastError = null },
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(10.dp))

            // Composer.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (voiceEnabled) {
                    Surface(
                        color = if (voiceListening) Color(0xFFC74848) else Color(0xFF1F4D6E),
                        shape = RoundedCornerShape(28.dp),
                        modifier = Modifier
                            .size(48.dp)
                            .clickable(enabled = readyForSend && !isReplying) {
                                if (voiceListening) stopListening() else startListening()
                            },
                    ) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            androidx.compose.material3.Icon(
                                imageVector = Icons.Default.Mic,
                                contentDescription = if (voiceListening) "Stop listening" else "Talk",
                                tint = Color.White,
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = draftText,
                    onValueChange = { draftText = it },
                    placeholder = { Text("Ask the assistant…", color = Color(0xFF6A7484)) },
                    enabled = readyForSend && !isReplying,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Send,
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
                    modifier = Modifier.weight(1f),
                )
                Surface(
                    color = if (draftText.isNotBlank() && !isReplying) Color(0xFF4F8FF7)
                        else Color(0xFF2A3A4F),
                    shape = RoundedCornerShape(28.dp),
                    modifier = Modifier
                        .size(48.dp)
                        .clickable(enabled = draftText.isNotBlank() && readyForSend && !isReplying) {
                            val msg = draftText.trim()
                            draftText = ""
                            runner.send(msg)
                        },
                ) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        androidx.compose.material3.Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Send",
                            tint = Color.White,
                        )
                    }
                }
            }

            if (turns.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(
                        "New chat",
                        color = Color(0xFF6A7484),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.clickable {
                            runner.newConversation()
                            lastError = null
                            voicePartial = null
                        },
                    )
                    if (isReplying) {
                        Text(
                            "Stop",
                            color = Color(0xFFE07070),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.clickable { runner.cancel(reason = "user") },
                        )
                    }
                }
            }
        }
    }
}

private val SUGGESTED_PROMPTS = listOf(
    "What can you do?",
    "List my printers.",
    "Add an Orca cube and slice it.",
    "Show me the active plate.",
)

// The system prompt + tool-loop hops cap moved to AgentRunner in
// P2. The panel is now a pure UI surface; the runner singleton owns
// the conversation state and the loop.

@Composable
private fun TranscriptRow(turn: LlmTurn) {
    when (turn) {
        is LlmTurn.User -> BubbleRow(
            alignEnd = true,
            color = Color(0xFF4F8FF7),
            textColor = Color.White,
        ) { Text(turn.text, color = Color.White, style = MaterialTheme.typography.bodyMedium) }

        is LlmTurn.Assistant -> Column {
            if (!turn.text.isNullOrBlank()) BubbleRow(
                alignEnd = false,
                color = Color(0xFF1A2C42),
                textColor = Color.White,
            ) { Text(turn.text, color = Color.White, style = MaterialTheme.typography.bodyMedium) }
            for (call in turn.toolCalls) {
                Spacer(Modifier.height(4.dp))
                ToolCallChip(call.name, call.args)
            }
        }

        is LlmTurn.ToolResult -> {
            Spacer(Modifier.height(2.dp))
            ToolResultChip(turn.name, turn.content, turn.isError)
        }
    }
}

@Composable
private fun BubbleRow(
    alignEnd: Boolean,
    color: Color,
    textColor: Color,
    content: @Composable () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (alignEnd) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = color,
            shape = RoundedCornerShape(
                topStart = 12.dp, topEnd = 12.dp,
                bottomStart = if (alignEnd) 12.dp else 2.dp,
                bottomEnd = if (alignEnd) 2.dp else 12.dp,
            ),
            modifier = Modifier.widthIn(max = 480.dp),
        ) {
            Box(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { content() }
        }
    }
}

@Composable
private fun ToolCallChip(name: String, args: JSONObject) {
    val argsBlurb = if (args.length() == 0) "()"
        else args.toString().take(120).let { if (it.length >= 120) "$it…" else it }
    Surface(
        color = Color(0xFF14223A),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                "→ $name",
                color = Color(0xFF8AC0FF),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                argsBlurb,
                color = Color(0xFF6A7484),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun ToolResultChip(name: String, content: String, isError: Boolean) {
    val (bg, fg) = if (isError) Color(0xFF2A1010) to Color(0xFFE07070)
        else Color(0xFF0F2A14) to Color(0xFF8AE0A0)
    val short = content.take(160).let { if (content.length > 160) "$it…" else it }
    Surface(
        color = bg,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                "← $name${if (isError) " (error)" else ""}",
                color = fg,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                short,
                color = Color(0xFFB6BEC8),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun ReplyingRow() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(vertical = 6.dp),
    ) {
        CircularProgressIndicator(
            color = Color(0xFF4F8FF7),
            strokeWidth = 2.dp,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.height(0.dp))
        Text(
            "  thinking…",
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun SuggestionChip(text: String, onClick: () -> Unit) {
    Surface(
        color = Color(0xFF1A2C42),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.clickable { onClick() },
    ) {
        Text(
            text,
            color = Color(0xFFB6BEC8),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}
