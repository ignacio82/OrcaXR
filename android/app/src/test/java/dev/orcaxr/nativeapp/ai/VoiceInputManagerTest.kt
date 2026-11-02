package dev.orcaxr.nativeapp.ai

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceInputManagerTest {

    @Test
    fun testStripEmojisAndSymbols() {
        val input = "✅ Successfully updated model filament colors. ⚠️ Warning: overhang detected! 🎃 🤖 🎨"
        val expected = "Successfully updated model filament colors. Warning: overhang detected!"
        assertEquals(expected, VoiceInputManager.sanitizeForTts(input))
    }

    @Test
    fun testStripMarkdownFormatting() {
        val input = """
            ### Slicing Status
            **Active Plate**: *Plate 1*
            • Layer count: 120
            - Filament used: 15.4g
            `code block`
            ```json
            {"key": "value"}
            ```
        """.trimIndent()
        val result = VoiceInputManager.sanitizeForTts(input)
        assert(!result.contains("#"))
        assert(!result.contains("*"))
        assert(!result.contains("•"))
        assert(!result.contains("`"))
        assert(!result.contains("{"))
        assert(!result.contains("json"))
    }

    @Test
    fun testExpandUnitsAndAbbreviations() {
        val input = "Resized model to 150% and moved 25mm along Z at 90deg."
        val expected = "Resized model to 150 percent and moved 25 millimeters along Z at 90 degrees."
        assertEquals(expected, VoiceInputManager.sanitizeForTts(input))
    }

    @Test
    fun testExpandTelemetryUnitsAndFractions() {
        val input = "Layer 12 / 150 · 45% · 1h 04m · 215°C · 45g"
        val sanitized = VoiceInputManager.sanitizeForTts(input)
        assertEquals("Layer 12 of 150 45 percent 1 hour and 4 minutes 215 degrees Celsius 45 grams", sanitized)
    }

    @Test
    fun testEmptyOrWhitespaceInput() {
        assertEquals("", VoiceInputManager.sanitizeForTts(""))
        assertEquals("", VoiceInputManager.sanitizeForTts("   "))
        assertEquals("", VoiceInputManager.sanitizeForTts("✅ ⚠️ 🎃"))
    }

    @Test
    fun testSpeechRecognitionErrorClassification() {
        // Error 11 (ERROR_SERVER_DISCONNECTED) and other benign timeouts must NOT produce an error banner
        assertEquals(null, VoiceInputManager.describeRecognitionError(11))
        assertEquals(null, VoiceInputManager.describeRecognitionError(7)) // ERROR_NO_MATCH
        assertEquals(null, VoiceInputManager.describeRecognitionError(6)) // ERROR_SPEECH_TIMEOUT
        assertEquals(null, VoiceInputManager.describeRecognitionError(5)) // ERROR_CLIENT

        assert(VoiceInputManager.isBenignRecognitionError(11))
        assert(VoiceInputManager.isBenignRecognitionError(7))
        assert(VoiceInputManager.isBenignRecognitionError(6))
        assert(VoiceInputManager.isBenignRecognitionError(5))

        // Fatal/actionable errors must produce clear spoken descriptions
        assertEquals("Audio recording error", VoiceInputManager.describeRecognitionError(3)) // ERROR_AUDIO
        assertEquals("Audio permission required", VoiceInputManager.describeRecognitionError(9)) // ERROR_INSUFFICIENT_PERMISSIONS
        assertEquals("Network connection error", VoiceInputManager.describeRecognitionError(2)) // ERROR_NETWORK
        assertEquals("Network timeout", VoiceInputManager.describeRecognitionError(1)) // ERROR_NETWORK_TIMEOUT
        assertEquals("Speech recognizer is busy", VoiceInputManager.describeRecognitionError(8)) // ERROR_RECOGNIZER_BUSY

        assert(!VoiceInputManager.isBenignRecognitionError(3))
        assert(!VoiceInputManager.isBenignRecognitionError(9))
    }
}
