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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
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

    val selected by settings.selectedProvider.collectAsState(initial = LlmProvider.Claude)
    val claudeKey by settings.claudeApiKey.collectAsState(initial = null)
    val geminiKey by settings.geminiApiKey.collectAsState(initial = null)
    val openAiKey by settings.openAiApiKey.collectAsState(initial = null)
    val voiceEnabled by settings.voiceEnabled.collectAsState(initial = false)

    val currentKey = when (selected) {
        LlmProvider.Claude -> claudeKey
        LlmProvider.Gemini -> geminiKey
        LlmProvider.OpenAI -> openAiKey
    }
    val anyKeySet = !claudeKey.isNullOrBlank() || !geminiKey.isNullOrBlank() ||
        !openAiKey.isNullOrBlank()

    var draftKey by remember(selected, currentKey) {
        mutableStateOf(currentKey ?: "")
    }
    var showKey by remember(selected) { mutableStateOf(false) }
    var lastSavedAt by remember(selected) { mutableStateOf<String?>(null) }

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
                "Optional. Talk to OrcaXR using Claude, Gemini, or OpenAI. " +
                    "Your key stays on this device and is billed to your own account.",
                color = Color(0xFFB6BEC8),
                style = MaterialTheme.typography.bodySmall,
            )

            Spacer(Modifier.height(12.dp))

            // Provider picker.
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                for (p in LlmProvider.entries) {
                    val isSelected = p == selected
                    val hasKey = when (p) {
                        LlmProvider.Claude -> !claudeKey.isNullOrBlank()
                        LlmProvider.Gemini -> !geminiKey.isNullOrBlank()
                        LlmProvider.OpenAI -> !openAiKey.isNullOrBlank()
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
                            if (hasKey) {
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
                Button(
                    onClick = {
                        scope.launch {
                            val v = draftKey.trim()
                            when (selected) {
                                LlmProvider.Claude -> settings.setClaudeApiKey(v.ifEmpty { null })
                                LlmProvider.Gemini -> settings.setGeminiApiKey(v.ifEmpty { null })
                                LlmProvider.OpenAI -> settings.setOpenAiApiKey(v.ifEmpty { null })
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
                enabled = !currentKey.isNullOrBlank(),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF4F8FF7)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (currentKey.isNullOrBlank()) "Add a key to open the assistant"
                    else "Open assistant",
                )
            }

            if (anyKeySet) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "The assistant can drive every action OrcaXR exposes through MCP " +
                        "(load models, slice, paint, control printers). It runs in-process; " +
                        "your prompts go directly to the selected provider, not through Anthropic.",
                    color = Color(0xFF9AA5B1),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}
