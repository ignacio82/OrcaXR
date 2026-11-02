package dev.orcaxr.nativeapp.ai

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import dev.orcaxr.nativeapp.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A sleek floating microphone button that appears when an on-device local LLM
 * (Google Tensor TPU Gemini Nano or LiteRT Gemma) is active and available.
 *
 * Tapping the microphone activates voice listening with real-time speech transcription
 * and direct offline command execution via [OrcaAiAssistant].
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun FloatingVoiceAssistant(
    modifier: Modifier = Modifier,
    onOpenFullAssistant: () -> Unit = {},
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val modelManager = remember { LlmModelManager.getInstance(context) }
    val voiceManager = remember { VoiceInputManager.getInstance(context) }
    val assistant = remember { OrcaAiAssistant(context, modelManager) }
    val conversationHistory = remember { mutableStateListOf<AssistantMessage>() }

    val activeEngine by modelManager.activeEngine.collectAsState()
    val aiCoreStatus by modelManager.aiCoreStatus.collectAsState()
    val downloadState by modelManager.downloadState.collectAsState()

    val isModelAvailable = activeEngine != null ||
            aiCoreStatus is AICoreStatus.Ready ||
            downloadState is DownloadState.Ready

    if (!isModelAvailable) return

    val isListening by voiceManager.isListening.collectAsState()
    val partialText by voiceManager.partialText.collectAsState()
    val soundLevel by voiceManager.soundLevel.collectAsState()
    val lastError by voiceManager.lastError.collectAsState()

    var isExecuting by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf<String?>(null) }
    var isErrorOutcome by remember { mutableStateOf(false) }
    var outcomeTimer by remember { mutableStateOf(0L) }

    // Auto-dismiss outcome pill or transient error after 4.5 seconds
    LaunchedEffect(outcomeTimer, lastError) {
        if (lastError != null || outcomeTimer > 0L) {
            delay(4500)
            if (!isListening && !isExecuting) {
                statusText = null
                voiceManager.clearError()
            }
        }
    }

    fun handleSpeechResult(spokenPrompt: String) {
        if (spokenPrompt.isBlank() || isExecuting) return
        isExecuting = true
        statusText = "Processing: \"$spokenPrompt\""
        isErrorOutcome = false

        scope.launch {
            try {
                val historySnapshot = conversationHistory.toList()
                val res = assistant.query(spokenPrompt, historySnapshot)
                conversationHistory.add(AssistantMessage(isUser = true, text = spokenPrompt))
                conversationHistory.add(AssistantMessage(isUser = false, text = res.text, toolCall = res.toolCall, toolResult = res.toolResultText))
                if (conversationHistory.size > 8) {
                    conversationHistory.removeRange(0, conversationHistory.size - 8)
                }

                statusText = res.text
                isErrorOutcome = res.isError
                voiceManager.speak(res.text)
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                outcomeTimer = System.currentTimeMillis()
            } catch (t: Throwable) {
                statusText = "Error: ${t.message}"
                isErrorOutcome = true
                outcomeTimer = System.currentTimeMillis()
            } finally {
                isExecuting = false
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        if (isGranted) {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            voiceManager.startListening(::handleSpeechResult)
        } else {
            statusText = "Microphone permission required for voice interaction"
            isErrorOutcome = true
            outcomeTimer = System.currentTimeMillis()
        }
    }

    fun toggleVoice() {
        if (isListening) {
            voiceManager.stopListening()
            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        } else if (isExecuting) {
            // currently thinking, open full dialog
            onOpenFullAssistant()
        } else {
            statusText = null
            val hasPermission = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED

            if (hasPermission) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                voiceManager.startListening(::handleSpeechResult)
            } else {
                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    // Sound wave pulse animation while listening
    val pulseTransition = rememberInfiniteTransition(label = "micPulse")
    val pulseScale by pulseTransition.animateFloat(
        initialValue = 1.0f,
        targetValue = 1.25f,
        animationSpec = infiniteRepeatable(
            animation = tween(600),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulseScale",
    )
    val dynamicScale by animateFloatAsState(
        targetValue = if (isListening) (pulseScale + soundLevel * 0.35f) else 1.0f,
        label = "dynamicScale",
    )

    Column(
        modifier = modifier.animateContentSize(),
        horizontalAlignment = Alignment.End,
    ) {
        // Expandable voice interaction status / transcription pill
        AnimatedVisibility(
            visible = isListening || isExecuting || statusText != null || lastError != null,
            enter = fadeIn() + slideInVertically { it / 2 },
            exit = fadeOut() + slideOutVertically { it / 2 },
        ) {
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = when {
                    isErrorOutcome || lastError != null -> MaterialTheme.colorScheme.errorContainer
                    isListening -> MaterialTheme.colorScheme.primaryContainer
                    isExecuting -> MaterialTheme.colorScheme.secondaryContainer
                    else -> MaterialTheme.colorScheme.surfaceVariant
                },
                shadowElevation = 6.dp,
                modifier = Modifier
                    .padding(bottom = 8.dp)
                    .widthIn(min = 140.dp, max = 340.dp),
            ) {
                Row(
                    modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .clickable { onOpenFullAssistant() }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (isExecuting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        } else if (isListening) {
                            Box(
                                modifier = Modifier
                                    .size(10.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFFE53935))
                                    .scale(dynamicScale),
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }

                        val displayText = when {
                            isListening && partialText.isNotBlank() -> partialText
                            isListening -> "Listening… speak command"
                            isExecuting -> statusText ?: "Thinking…"
                            lastError != null -> lastError ?: "Audio error"
                            else -> statusText ?: ""
                        }

                        Text(
                            text = displayText,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            color = when {
                                isErrorOutcome || lastError != null -> MaterialTheme.colorScheme.onErrorContainer
                                isListening -> MaterialTheme.colorScheme.onPrimaryContainer
                                isExecuting -> MaterialTheme.colorScheme.onSecondaryContainer
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }

                    Spacer(modifier = Modifier.width(6.dp))

                    // Cancel / dismiss button with accessible, reliable touch target
                    IconButton(
                        onClick = {
                            voiceManager.cancel()
                            voiceManager.clearError()
                            statusText = null
                            isExecuting = false
                        },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Text(
                            text = "✕",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = when {
                                isErrorOutcome || lastError != null -> MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.8f)
                                else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            },
                        )
                    }
                }
            }
        }

        // Floating Action Mic Button
        TooltipBox(
            positionProvider = TooltipDefaults.rememberTooltipPositionProvider(androidx.compose.material3.TooltipAnchorPosition.Above),
            tooltip = {
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = MaterialTheme.colorScheme.inverseSurface,
                ) {
                    Text(
                        text = if (isListening) "Stop Listening" else "Ask Orca AI with Voice",
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                    )
                }
            },
            state = rememberTooltipState(),
        ) {
            Surface(
                onClick = ::toggleVoice,
                shape = CircleShape,
                color = when {
                    isListening -> Color(0xFFE53935)
                    isExecuting -> MaterialTheme.colorScheme.secondary
                    else -> MaterialTheme.colorScheme.primary
                },
                shadowElevation = 8.dp,
                modifier = Modifier
                    .size(52.dp)
                    .scale(if (isListening) dynamicScale else 1.0f)
                    .border(
                        width = if (isListening) 2.dp else 1.dp,
                        color = if (isListening) Color.White.copy(alpha = 0.8f) else Color.Transparent,
                        shape = CircleShape,
                    ),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(id = if (isListening) R.drawable.ic_symbol_mic else R.drawable.ic_symbol_mic),
                        contentDescription = "Voice Assistant",
                        tint = Color.White,
                        modifier = Modifier.size(26.dp),
                    )
                }
            }
        }
    }
}
