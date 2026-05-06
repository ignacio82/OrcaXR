package dev.orcaxr.app.voice

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Roadmap C8 — Voice-to-Action SpatialPanel.
 *
 * UX flow:
 *   1. User taps Mic → [onStartListening] fires; [partial] streams in
 *      from the active SpeechRecognizer.
 *   2. Tapping Mic again (or releasing) → [onStopListening]; the
 *      recognizer endpoints and [final] is set.
 *   3. As soon as a [final] transcript arrives, [VoiceIntentMapper]
 *      runs and the result is shown.
 *      - Non-destructive intents auto-fire on first match (Slice,
 *        SetMode, AutoArrange, etc.).
 *      - Destructive intents (DeleteSelected, CancelSlice) display a
 *        Confirm button and wait for user tap.
 *      - Unrecognized utterances surface a "Couldn't map…" hint with
 *        a "Send to Assistant" fallback button.
 *
 * Stateless wrt audio capture — the caller owns the [VoiceInput]
 * lifecycle. The panel is just the visualization + intent-routing
 * layer.
 */
@Composable
fun VoiceCommandPanel(
    /** True while [VoiceInput] is actively streaming. */
    isListening: Boolean,
    /** Most-recent partial transcript, updated on every recognizer
     *  callback. Empty until the user has started speaking. */
    partial: String,
    /** Final transcript, set once the recognizer endpoints. Null
     *  while still listening / before the first session. */
    final: String?,
    /** Last error surfaced by the recognizer, if any. */
    error: String?,
    /** True iff the runtime has RECORD_AUDIO. The caller is expected
     *  to surface a permission-request flow when false; the panel
     *  shows a neutral "grant microphone access" message. */
    hasMicPermission: Boolean,
    onRequestPermission: () -> Unit,
    onStartListening: () -> Unit,
    onStopListening: () -> Unit,
    onClose: () -> Unit,
    /** Dispatch a recognized intent. Caller routes the typed
     *  [VoiceIntent] into the existing WorkspaceModel.emit / panel
     *  flips / etc. */
    onDispatch: (VoiceIntent) -> Unit,
    /** Send the raw utterance to the in-app LLM assistant for free-
     *  form interpretation. Used as the unrecognized-intent fallback. */
    onDispatchToAssistant: (String) -> Unit,
) {
    // Track which intent (if any) we're currently waiting on user
    // confirmation for. Reset whenever a fresh `final` arrives so the
    // last command's pending confirm doesn't shadow the next.
    val intent = remember(final) { final?.let { VoiceIntentMapper.map(it) } }
    var pendingConfirm by remember(final) {
        mutableStateOf<VoiceIntent?>(
            if (intent != null && intent.requiresConfirmation) intent else null,
        )
    }
    // Auto-fire non-destructive intents exactly once per `final`.
    var autoFired by remember(final) { mutableStateOf(false) }
    if (intent != null && !intent.requiresConfirmation && !autoFired) {
        // Composable-side dispatch is OK here because onDispatch is a
        // remembered lambda — the call lands once per `final` thanks
        // to the autoFired guard.
        onDispatch(intent)
        autoFired = true
    }

    Surface(
        color = Color(0xFF15181B),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "Voice command",
                        style = MaterialTheme.typography.titleLarge,
                        color = Color.White,
                    )
                    Text(
                        when {
                            !hasMicPermission -> "Grant microphone access to start."
                            isListening -> "Listening… speak now."
                            final != null -> "Heard you."
                            else -> "Tap the mic to talk to OrcaXR."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFB6BEC8),
                    )
                }
                IconButton(onClick = onClose) {
                    Text("✕", color = Color.Gray, style = MaterialTheme.typography.titleMedium)
                }
            }

            // Permission flow.
            if (!hasMicPermission) {
                Button(
                    onClick = onRequestPermission,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF2A8B6E),
                        contentColor = Color.White,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Grant microphone access") }
                return@Surface
            }

            // Mic toggle.
            Button(
                onClick = if (isListening) onStopListening else onStartListening,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isListening) Color(0xFFB55050) else Color(0xFF2A8B6E),
                    contentColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (isListening) "■  Stop listening" else "🎤  Tap to talk")
            }

            // Partial transcript while listening.
            if (isListening || partial.isNotBlank()) {
                Surface(
                    color = Color(0xFF1B1F23),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            "Live",
                            color = Color(0xFF8E97A2),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            partial.ifBlank { "(silence)" },
                            color = Color.White,
                            style = MaterialTheme.typography.bodyLarge,
                            fontStyle = if (partial.isBlank()) FontStyle.Italic else FontStyle.Normal,
                        )
                    }
                }
            }

            // Final transcript + matched intent.
            final?.let { f ->
                Surface(
                    color = Color(0xFF1B1F23),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            "Heard",
                            color = Color(0xFF8E97A2),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            "\"$f\"",
                            color = Color.White,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        Spacer(Modifier.height(8.dp))
                        when {
                            intent == null -> {
                                Text(
                                    "Couldn't map that to a command. Try \"slice\", \"auto arrange\", or " +
                                        "open the Settings → AI Assistant for free-form chat.",
                                    color = Color(0xFF8E97A2),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Spacer(Modifier.height(8.dp))
                                OutlinedButton(
                                    onClick = { onDispatchToAssistant(f) },
                                ) { Text("Send to Assistant", color = Color.White) }
                            }
                            pendingConfirm != null -> {
                                Text(
                                    summarize(intent),
                                    color = Color(0xFFFFA94A),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    "This action is destructive. Tap Confirm to run, " +
                                        "or close to cancel.",
                                    color = Color(0xFF8E97A2),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Spacer(Modifier.height(8.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Button(
                                        onClick = {
                                            pendingConfirm?.let { onDispatch(it) }
                                            pendingConfirm = null
                                        },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = Color(0xFFB55050),
                                            contentColor = Color.White,
                                        ),
                                    ) { Text("Confirm") }
                                    OutlinedButton(onClick = { pendingConfirm = null }) {
                                        Text("Cancel", color = Color.White)
                                    }
                                }
                            }
                            else -> {
                                Text(
                                    "✓ ${summarize(intent)}",
                                    color = Color(0xFF80E0C8),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                        }
                    }
                }
            }

            error?.let { e ->
                Text(
                    e,
                    color = Color(0xFFFFA94A),
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // Hint footer with example phrases.
            Spacer(Modifier.fillMaxWidth())
            Text(
                "Try:  \"slice\"  ·  \"auto arrange\"  ·  \"plate 2\"  ·  \"save gcode\"  ·  " +
                    "\"position the tower\"  ·  \"hide travels\"  ·  \"undo\"",
                color = Color(0xFF8E97A2),
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

/** Human-readable one-liner for [VoiceIntent], used in the panel's
 *  "✓ Sliced" / "Confirm" status lines. Centralized so the labels
 *  stay consistent across the auto-fire and confirm paths. */
internal fun summarize(intent: VoiceIntent): String = when (intent) {
    VoiceIntent.SliceActivePlate -> "Slicing active plate"
    is VoiceIntent.CancelSlice -> "Cancel running slice"
    VoiceIntent.SaveGcode -> "Save G-code to Downloads"
    VoiceIntent.SaveProjectAs3mf -> "Save project as 3MF"
    VoiceIntent.SaveModelAsStl -> "Save model as STL"
    is VoiceIntent.SetWorkspaceMode -> "Switch to ${intent.mode}"
    is VoiceIntent.SetPreference -> "Set ${intent.key} = ${intent.value}"
    is VoiceIntent.SetActivePlate -> "Switch to plate ${intent.plateId}"
    VoiceIntent.AutoArrangePlate -> "Auto-arrange plate"
    VoiceIntent.DropToBed -> "Drop selected models to bed"
    is VoiceIntent.DeleteSelected -> "Delete selected models"
    VoiceIntent.ClearSelection -> "Clear selection"
    VoiceIntent.AutoPositionWipeTower -> "Auto-position wipe tower"
    VoiceIntent.ExportSettings -> "Export settings"
    is VoiceIntent.AddHandyModel -> "Load ${intent.id}"
    VoiceIntent.ShowHelp -> "Open help"
    VoiceIntent.HideHelp -> "Close help"
    VoiceIntent.OpenSettings -> "Open settings"
    VoiceIntent.Undo -> "Undo"
    VoiceIntent.Redo -> "Redo"
}
