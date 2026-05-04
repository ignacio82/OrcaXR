package dev.orcaxr.app.llm

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Thin wrapper around Android's on-device [SpeechRecognizer]. Surfaces
 * partial + final transcripts plus error / state callbacks. We don't
 * try to be smart about endpointing — `EXTRA_PARTIAL_RESULTS=true`
 * keeps a live stream coming, and the chat panel sends on stop()
 * (mic button release) using whatever the latest final transcript is.
 *
 * Threading: all callbacks fire on the main thread (Android contract).
 * The chat panel uses them directly to drive Compose state.
 *
 * Why not the gRPC streaming Cloud Speech-to-Text or the LLM provider's
 * own audio endpoints? Those need a separate auth flow and bill per
 * minute even for low-utilization users; the on-device recognizer is
 * free, works offline on Android XR's ASR-capable runtime, and the
 * chat panel already routes the resulting text through whichever LLM
 * the user has chosen. Cleaner separation of "how the user inputs"
 * from "which model answers."
 */
class VoiceInput(private val ctx: Context) {

    private val tag = "OrcaXR/llm/voice"
    private var recognizer: SpeechRecognizer? = null

    /** True while a recognition session is open. */
    var isListening: Boolean = false
        private set

    /** Latest partial transcript, updated on every result. Null between sessions. */
    var partialTranscript: String? = null
        private set

    /**
     * Begin recognition. Calls [onPartial] as utterances arrive,
     * [onFinal] once when the recognizer endpoints, and [onError] on
     * any failure (no permission, no recognizer present, etc.).
     *
     * No-op if already listening, or if [hasPermission] is false (the
     * caller is expected to have requested RECORD_AUDIO first).
     */
    fun start(
        onPartial: (String) -> Unit,
        onFinal: (String) -> Unit,
        onError: (String) -> Unit,
    ) {
        if (isListening) return
        if (!hasPermission(ctx)) {
            onError("Microphone permission not granted.")
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            onError("No speech recognizer available on this device.")
            return
        }
        val rec = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = rec
        partialTranscript = null
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val list = partialResults
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val first = list?.firstOrNull() ?: return
                partialTranscript = first
                onPartial(first)
            }

            override fun onResults(results: Bundle?) {
                isListening = false
                val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val first = list?.firstOrNull()
                if (first.isNullOrBlank()) {
                    onError("Couldn't make out any speech.")
                } else {
                    partialTranscript = first
                    onFinal(first)
                }
                cleanup()
            }

            override fun onError(error: Int) {
                isListening = false
                val msg = errorString(error)
                Log.w(tag, "Recognizer error $error: $msg")
                onError(msg)
                cleanup()
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Talk to OrcaXR")
            // Default to the device's locale; the user's choice in
            // system settings wins. EXTRA_LANGUAGE only when we want
            // to force one — we don't.
        }
        try {
            rec.startListening(intent)
            isListening = true
        } catch (t: Throwable) {
            Log.e(tag, "startListening threw", t)
            onError("Couldn't start the microphone: ${t.message ?: t.javaClass.simpleName}")
            cleanup()
        }
    }

    /**
     * Force the current session to wrap up. The recognizer fires
     * onResults shortly after with the final transcript captured so
     * far. Safe to call when not listening.
     */
    fun stop() {
        recognizer?.let { runCatching { it.stopListening() } }
    }

    /** Abort without producing a final transcript. */
    fun cancel() {
        recognizer?.let { runCatching { it.cancel() } }
        cleanup()
    }

    fun release() {
        cleanup()
    }

    private fun cleanup() {
        recognizer?.let { runCatching { it.destroy() } }
        recognizer = null
        isListening = false
    }

    private fun errorString(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error."
        SpeechRecognizer.ERROR_CLIENT -> "Recognizer client error."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission denied."
        SpeechRecognizer.ERROR_NETWORK -> "Recognizer network error."
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Recognizer network timeout."
        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy — try again."
        SpeechRecognizer.ERROR_SERVER -> "Recognizer server error."
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech detected."
        else -> "Recognizer error ($code)."
    }

    companion object {
        fun hasPermission(ctx: Context): Boolean =
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }
}
