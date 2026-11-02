package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

class VoiceInputManager(
    private val context: Context,
) {
    companion object {
        private const val TAG = "VoiceInputManager"
        @Volatile private var instance: VoiceInputManager? = null

        fun getInstance(context: Context): VoiceInputManager {
            return instance ?: synchronized(this) {
                instance ?: VoiceInputManager(context.applicationContext).also { instance = it }
            }
        }

        /**
         * Sanitizes text for natural, clean spoken output via Android TextToSpeech:
         * - Strips code blocks and bracketed metadata
         * - Removes emojis, pictographs, and decorative symbols
         * - Strips markdown syntax (headers, bold, italics, bullets, hashtags, backticks)
         * - Expands symbols/abbreviations into natural spoken words (e.g. "%" -> "percent", "mm" -> "millimeters", "deg" -> "degrees")
         * - Normalizes whitespace and ensures proper punctuation for natural pauses
         */
        fun sanitizeForTts(text: String): String {
            if (text.isBlank()) return ""
            var clean = text

            // 1. Strip markdown code blocks (```...```) and inline code (`...`)
            clean = clean.replace(Regex("```[\\s\\S]*?```"), "")
            clean = clean.replace(Regex("`[^`]*`"), "")

            // Expand temperature symbols (°C, °) and dot delimiters before generic symbol stripping
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*°C\\b", RegexOption.IGNORE_CASE), "$1 degrees Celsius")
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*(?:deg|°)\\b", RegexOption.IGNORE_CASE), "$1 degrees")
            clean = clean.replace("·", " ")

            // 2. Remove emojis and symbols (Unicode ranges: Emoticons, Symbols, Dingbats, Pictographs, Supplemental Symbols)
            // \p{So}: Other symbols (includes emojis like 🎃, 🤖, 🎨)
            // \p{Sk}: Modifier symbols
            // \p{Cs}: Surrogates
            // \u2600-\u27BF: Misc symbols, dingbats (✅, ⚠️, ❌, etc.)
            // \u1F300-\u1FAFF: Emoji range
            clean = clean.replace(Regex("[\\p{So}\\p{Sk}\\p{Cs}\\u2600-\\u27BF\\uFE00-\\uFE0F]"), "")
            clean = clean.replace(Regex("[\\uD83C-\\uD83E][\\uDC00-\\uDFFF]"), "")

            // 3. Remove Markdown headers (#, ##, ###), bold/italics (**, *), underscores (__), strikethroughs (~~)
            clean = clean.replace(Regex("[#*_~]"), "")

            // 4. Strip bullet points, dashed lists, arrows, and bracketed links
            clean = clean.replace(Regex("^[\\s•\\-*+>]+", RegexOption.MULTILINE), "")
            clean = clean.replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1") // [title](url) -> title
            clean = clean.replace(Regex("[-=]>"), " to ")

            // 5. Expand abbreviations and symbols into spoken words
            clean = clean.replace(Regex("(\\d+)\\s*%"), "$1 percent")
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*mm\\b", RegexOption.IGNORE_CASE), "$1 millimeters")
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*°C\\b", RegexOption.IGNORE_CASE), "$1 degrees Celsius")
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*(?:deg|°)\\b", RegexOption.IGNORE_CASE), "$1 degrees")
            clean = clean.replace(Regex("\\b(\\d+)\\s*h\\s*(\\d+)\\s*m\\b", RegexOption.IGNORE_CASE)) { match ->
                val h = match.groupValues[1].toIntOrNull() ?: 0
                val m = match.groupValues[2].toIntOrNull() ?: 0
                val hStr = if (h == 1) "1 hour" else "$h hours"
                val mStr = if (m == 1) "1 minute" else "$m minutes"
                if (m > 0) "$hStr and $mStr" else hStr
            }
            clean = clean.replace(Regex("\\b(\\d+)\\s*m\\s*(\\d+)\\s*s\\b", RegexOption.IGNORE_CASE)) { match ->
                val m = match.groupValues[1].toIntOrNull() ?: 0
                val s = match.groupValues[2].toIntOrNull() ?: 0
                val mStr = if (m == 1) "1 minute" else "$m minutes"
                val sStr = if (s == 1) "1 second" else "$s seconds"
                if (s > 0) "$mStr and $sStr" else mStr
            }
            clean = clean.replace(Regex("(\\d+(?:\\.\\d+)?)\\s*g\\b", RegexOption.IGNORE_CASE), "$1 grams")
            clean = clean.replace(Regex("(\\d+)\\s*/\\s*(\\d+)"), "$1 of $2")
            clean = clean.replace(Regex("\\bapprox\\.\\b", RegexOption.IGNORE_CASE), "approximately")
            clean = clean.replace(Regex("\\be\\.g\\.\\b", RegexOption.IGNORE_CASE), "for example")
            clean = clean.replace(Regex("\\bi\\.e\\.\\b", RegexOption.IGNORE_CASE), "that is")

            // 6. Normalize whitespace, remove stray punctuation at start, ensure proper spacing
            clean = clean.replace(Regex("\\s+"), " ").trim()
            clean = clean.removePrefix(":").removePrefix("-").trim()

            return clean
        }

        /**
         * Returns true if a SpeechRecognizer error code represents a normal, benign
         * lifecycle condition (such as silence timeouts, no speech detected, client cancellations,
         * or speech server disconnections like error 11) that should not be presented as a fatal error banner.
         */
        fun isBenignRecognitionError(error: Int): Boolean = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, // 7
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT, // 6
            SpeechRecognizer.ERROR_CLIENT, // 5
            11 -> true // SpeechRecognizer.ERROR_SERVER_DISCONNECTED
            else -> false
        }

        /**
         * Returns a user-friendly spoken description of fatal or actionable speech recognition errors,
         * or null if the error is benign and requires no user action.
         */
        fun describeRecognitionError(error: Int): String? {
            if (isBenignRecognitionError(error)) return null
            return when (error) {
                SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                SpeechRecognizer.ERROR_NETWORK -> "Network connection error"
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Audio permission required"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer is busy"
                12 -> "Speech language not supported"
                13 -> "Speech language unavailable"
                else -> "Speech recognition error ($error)"
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var isTtsReady = false

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _partialText = MutableStateFlow("")
    val partialText: StateFlow<String> = _partialText.asStateFlow()

    private val _soundLevel = MutableStateFlow(0f)
    val soundLevel: StateFlow<Float> = _soundLevel.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private var onResultCallback: ((String) -> Unit)? = null

    init {
        initTts()
    }

    private fun initTts() {
        try {
            tts = TextToSpeech(context) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val res = tts?.setLanguage(Locale.getDefault())
                    isTtsReady = res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED
                    Log.i(TAG, "TextToSpeech initialized successfully (ready: $isTtsReady)")
                } else {
                    Log.w(TAG, "TextToSpeech initialization failed with status: $status")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to instantiate TextToSpeech", t)
        }
    }

    fun speak(text: String) {
        if (!isTtsReady || text.isBlank()) return
        val sanitized = sanitizeForTts(text)
        if (sanitized.isBlank()) return
        try {
            tts?.speak(sanitized, TextToSpeech.QUEUE_FLUSH, null, "orca_ai_speech")
        } catch (t: Throwable) {
            Log.w(TAG, "TTS speak failed", t)
        }
    }

    fun stopSpeaking() {
        try {
            tts?.stop()
        } catch (_: Throwable) {}
    }

    val isRecognitionAvailable: Boolean
        get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun startListening(onResult: (String) -> Unit) {
        mainHandler.post {
            stopSpeaking()
            onResultCallback = onResult
            _lastError.value = null
            _partialText.value = ""
            _soundLevel.value = 0f

            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                _lastError.value = "Speech recognition is not available on this device"
                Log.w(TAG, "Speech recognition not available")
                return@post
            }

            try {
                recognizer?.destroy()
                recognizer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
                    Log.i(TAG, "Using on-device offline SpeechRecognizer")
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                } else {
                    Log.i(TAG, "Using standard SpeechRecognizer")
                    SpeechRecognizer.createSpeechRecognizer(context)
                }

                recognizer?.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        Log.i(TAG, "onReadyForSpeech")
                        _isListening.value = true
                    }

                    override fun onBeginningOfSpeech() {
                        Log.i(TAG, "onBeginningOfSpeech")
                    }

                    override fun onRmsChanged(rmsdB: Float) {
                        // Normalize -2dB..10dB to 0.0..1.0
                        val norm = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                        _soundLevel.value = norm
                    }

                    override fun onBufferReceived(buffer: ByteArray?) {}

                    override fun onEndOfSpeech() {
                        Log.i(TAG, "onEndOfSpeech")
                        _isListening.value = false
                        _soundLevel.value = 0f
                    }

                    override fun onError(error: Int) {
                        _isListening.value = false
                        _soundLevel.value = 0f

                        // Check if speech was captured before disconnection or timeout
                        val partial = _partialText.value.trim()
                        if (partial.isNotEmpty() && (error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_NO_MATCH || error == 11)) {
                            Log.i(TAG, "Speech session completed with partial transcript: '$partial'")
                            _partialText.value = partial
                            onResultCallback?.invoke(partial)
                            return
                        }

                        val msg = describeRecognitionError(error)
                        if (msg != null) {
                            Log.w(TAG, "Speech recognition error: $msg ($error)")
                            _lastError.value = msg
                        } else {
                            Log.i(TAG, "Speech recognition ended gracefully ($error)")
                        }
                    }

                    override fun onResults(results: Bundle?) {
                        _isListening.value = false
                        _soundLevel.value = 0f
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull()?.trim().orEmpty()
                        Log.i(TAG, "Speech final result: '$text'")
                        if (text.isNotEmpty()) {
                            _partialText.value = text
                            onResultCallback?.invoke(text)
                        }
                    }

                    override fun onPartialResults(partialResults: Bundle?) {
                        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull()?.trim().orEmpty()
                        if (text.isNotEmpty()) {
                            _partialText.value = text
                        }
                    }

                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
                    }
                }

                recognizer?.startListening(intent)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to start speech listening", t)
                _isListening.value = false
                _lastError.value = "Failed to start speech recognizer: ${t.message}"
            }
        }
    }

    fun stopListening() {
        mainHandler.post {
            try {
                recognizer?.stopListening()
            } catch (_: Throwable) {}
            _isListening.value = false
            _soundLevel.value = 0f
        }
    }

    fun clearError() {
        mainHandler.post {
            _lastError.value = null
        }
    }

    fun cancel() {
        mainHandler.post {
            try {
                recognizer?.cancel()
            } catch (_: Throwable) {}
            _isListening.value = false
            _soundLevel.value = 0f
            _lastError.value = null
            _partialText.value = ""
        }
    }

    fun destroy() {
        mainHandler.post {
            try {
                recognizer?.destroy()
            } catch (_: Throwable) {}
            recognizer = null

            try {
                tts?.stop()
                tts?.shutdown()
            } catch (_: Throwable) {}
            tts = null
            isTtsReady = false
        }
    }
}
