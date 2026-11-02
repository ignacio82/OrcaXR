package dev.orcaxr.nativeapp.ai

import android.graphics.Bitmap
import dev.orcaxr.nativeapp.mcp.McpContent
import dev.orcaxr.nativeapp.mcp.McpTool
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OrcaAiAssistantTest {
    class FakeEngine(
        val toolToReturn: LlmToolCall? = null,
        val textToReturn: String = "Test response",
    ) : LlmEngine {
        override val backendName: String = "FakeEngine (TPU)"
        override val backendKind: LlmBackend = LlmBackend.AICORE

        override suspend fun runInference(
            prompt: String,
            images: List<Bitmap>,
            profile: LlmInferenceProfile,
            onToken: ((String) -> Unit)?,
        ): String = textToReturn

        override suspend fun runToolCall(
            prompt: String,
            tools: List<LlmToolDefinition>,
            profile: LlmInferenceProfile,
        ): LlmToolCall? = toolToReturn

        override fun close() {}
    }

    @Test
    fun testToolCallDispatch() = runBlocking {
        val fakeCall = LlmToolCall(
            name = "remap_filaments",
            arguments = """{"mapping":{"1":"3","2":"4"}}""",
        )
        val engine = FakeEngine(toolToReturn = fakeCall)

        var executedArgs: Map<String, Any?>? = null
        val registry = McpToolRegistry()
        registry.registerTool(
            name = "remap_filaments",
            description = "Remap filaments",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                executedArgs = args
                McpToolResult.text("Filaments remapped: 1->3, 2->4")
            },
        )

        // Verify tool execution
        val result = registry.callTool(fakeCall.name, mapOf("mapping" to mapOf("1" to "3", "2" to "4")))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Filaments remapped: 1->3, 2->4", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testRemapFilamentsSingleSlotReplacement() = runBlocking {
        val fakeCall = LlmToolCall(
            name = "remap_filaments",
            arguments = """{"mapping":{"3":1},"scope":"model"}""",
        )
        val engine = FakeEngine(toolToReturn = fakeCall)

        val registry = McpToolRegistry()
        var receivedMapping: Map<*, *>? = null
        registry.registerTool(
            name = "remap_filaments",
            description = "Remap filaments",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                receivedMapping = args["mapping"] as? Map<*, *>
                McpToolResult.text("Slot 3 -> Slot 1 remapped")
            },
        )

        val result = registry.callTool("remap_filaments", mapOf("mapping" to mapOf("3" to 1), "scope" to "model"))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals(mapOf("3" to 1), receivedMapping)
        assertEquals("Slot 3 -> Slot 1 remapped", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testConversationalFallback() = runBlocking {
        val engine = FakeEngine(toolToReturn = null, textToReturn = "Here is some 3D printing advice.")
        val text = engine.runInference("How do I fix bed adhesion?")
        assertEquals("Here is some 3D printing advice.", text)
    }

    @Test
    fun testSmartPaintToolDispatch() = runBlocking {
        val fakeCall = LlmToolCall(
            name = "smart_paint",
            arguments = """{"prompt":"top and bottom","assignments":{"top":"blue","bottom":"white"}}""",
        )
        val registry = McpToolRegistry()
        var receivedArgs: Map<String, Any?>? = null
        registry.registerTool(
            name = "smart_paint",
            description = "Perform smart paint",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                receivedArgs = args
                McpToolResult.text("Successfully smart painted: 2 regions")
            },
        )

        val result = registry.callTool("smart_paint", mapOf("prompt" to "top and bottom", "assignments" to mapOf("top" to "blue", "bottom" to "white")))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Successfully smart painted: 2 regions", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testScaleModelToolDispatch() = runBlocking {
        val fakeCall = LlmToolCall(
            name = "scale_model",
            arguments = """{"percent":150}""",
        )
        val registry = McpToolRegistry()
        var receivedArgs: Map<String, Any?>? = null
        registry.registerTool(
            name = "scale_model",
            description = "Resize model",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                receivedArgs = args
                McpToolResult.text("Resized model to 150 percent.")
            },
        )

        val result = registry.callTool("scale_model", mapOf("percent" to 150))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Resized model to 150 percent.", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testTransformModelToolDispatch() = runBlocking {
        val fakeCall = LlmToolCall(
            name = "transform_model",
            arguments = """{"operation":"center"}""",
        )
        val registry = McpToolRegistry()
        var receivedArgs: Map<String, Any?>? = null
        registry.registerTool(
            name = "transform_model",
            description = "Transform model",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                receivedArgs = args
                McpToolResult.text("Centered model on the build plate.")
            },
        )

        val result = registry.callTool("transform_model", mapOf("operation" to "center"))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Centered model on the build plate.", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testDuplicateModelToolDispatch() = runBlocking {
        val registry = McpToolRegistry()
        registry.registerTool(
            name = "duplicate_model",
            description = "Duplicate model",
            inputSchema = mapOf("type" to "object"),
            handler = { args ->
                val count = (args["count"] as? Number)?.toInt() ?: 1
                McpToolResult.text("Created $count duplicates of the model.")
            },
        )

        val result = registry.callTool("duplicate_model", mapOf("count" to 3))
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Created 3 duplicates of the model.", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testArrangeBedToolDispatch() = runBlocking {
        val registry = McpToolRegistry()
        registry.registerTool(
            name = "arrange_bed",
            description = "Arrange bed",
            inputSchema = mapOf("type" to "object"),
            handler = { _ ->
                McpToolResult.text("Arranged all models on the build plate.")
            },
        )

        val result = registry.callTool("arrange_bed", emptyMap())
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Arranged all models on the build plate.", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testDeleteModelToolDispatch() = runBlocking {
        val registry = McpToolRegistry()
        registry.registerTool(
            name = "delete_model",
            description = "Delete model",
            inputSchema = mapOf("type" to "object"),
            handler = { _ ->
                McpToolResult.text("Deleted model from the build plate.")
            },
        )

        val result = registry.callTool("delete_model", emptyMap())
        assertNotNull(result)
        requireNotNull(result)
        assertFalse(result.isError)
        assertEquals("Deleted model from the build plate.", (result.content.first() as McpContent.Text).text)
    }

    @Test
    fun testSpeechQueryNormalization() {
        assertEquals("how long until the printer finishes", OrcaAiAssistant.normalizeSpeechQuery("how kong until the printer finishes"))
        assertEquals("how long until the print finishes", OrcaAiAssistant.normalizeSpeechQuery("how gong until the print finishes"))
        assertEquals("how long is the print", OrcaAiAssistant.normalizeSpeechQuery("how long is the print"))
    }

    @Test
    fun testIsPrinterStatusQuery() {
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("how long until the printer finishes"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("how kong until the printer finishes"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("when will the printer finish"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("when will the print finish"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("how much time left on the print"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("is the printer still printing"))
        assertTrue(OrcaAiAssistant.isPrinterStatusQuery("what is the printer status"))
        assertFalse(OrcaAiAssistant.isPrinterStatusQuery("how long will this plate take to print"))
        assertFalse(OrcaAiAssistant.isPrinterStatusQuery("scale model to 150%"))
        assertFalse(OrcaAiAssistant.isPrinterStatusQuery("smart paint the top half white"))
    }

    @Test
    fun testFormatDurationForSpeech() {
        assertEquals("1 hour and 4 minutes", OrcaAiAssistant.formatDurationForSpeech("1h 04m"))
        assertEquals("2 hours", OrcaAiAssistant.formatDurationForSpeech("2h 00m"))
        assertEquals("2 hours and 15 minutes", OrcaAiAssistant.formatDurationForSpeech("2h 15m"))
        assertEquals("15 minutes and 30 seconds", OrcaAiAssistant.formatDurationForSpeech("15m 30s"))
        assertEquals("45 seconds", OrcaAiAssistant.formatDurationForSpeech("45s"))
        assertEquals("1 hour", OrcaAiAssistant.formatDurationForSpeech("1h"))
        assertEquals("5 minutes", OrcaAiAssistant.formatDurationForSpeech("5m"))
        assertEquals("", OrcaAiAssistant.formatDurationForSpeech("—"))
        assertEquals("", OrcaAiAssistant.formatDurationForSpeech("-"))
        assertEquals("", OrcaAiAssistant.formatDurationForSpeech(""))
    }

    @Test
    fun testFormatPrinterStatusForTtsPrinting() {
        val json = """
            {
              "connected": true,
              "headline": "Printing 3DBenchy",
              "detail": "45% · about 1h 04m left",
              "progress_percent": 45.0,
              "facts": {
                "Left (approx.)": "1h 04m",
                "Layer": "12 / 150"
              },
              "tone": "Active"
            }
        """.trimIndent()
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("Printing 3DBenchy is 45 percent complete, with about 1 hour and 4 minutes remaining. On layer 12 of 150.", speech)
    }

    @Test
    fun testFormatPrinterStatusForTtsPrintingWithoutJobName() {
        val json = """
            {
              "connected": true,
              "headline": "Printing",
              "detail": "60% · about 25m left",
              "progress_percent": 60.0,
              "facts": {
                "Left (approx.)": "25m"
              },
              "tone": "Active"
            }
        """.trimIndent()
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("The print is 60 percent complete, with about 25 minutes remaining.", speech)
    }

    @Test
    fun testFormatPrinterStatusForTtsIdle() {
        val json = """
            {
              "connected": true,
              "headline": "Idle",
              "detail": "Nothing running",
              "tone": "Idle"
            }
        """.trimIndent()
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("The printer is idle and no print is currently running.", speech)
    }

    @Test
    fun testFormatPrinterStatusForTtsDisconnected() {
        val json = """{"connected": false}"""
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("The printer is not connected.", speech)
    }

    @Test
    fun testFormatPrinterStatusForTtsConnecting() {
        val json = """{"connected": false, "connecting": true}"""
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("The printer is currently connecting.", speech)
    }

    @Test
    fun testFormatPrinterStatusForTtsPaused() {
        val json = """
            {
              "connected": true,
              "headline": "Paused",
              "detail": "70% · about 20m left",
              "progress_percent": 70.0,
              "facts": {
                "Left (approx.)": "20m"
              },
              "tone": "Attention"
            }
        """.trimIndent()
        val speech = OrcaAiAssistant.formatPrinterStatusForTts(json)
        assertEquals("The print is currently paused at 70 percent with about 20 minutes remaining.", speech)
    }
}
