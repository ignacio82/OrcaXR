package dev.orcaxr.app.llm.local

import dev.orcaxr.app.llm.LlmToolDef
import dev.orcaxr.app.llm.LlmTurn
import dev.orcaxr.app.llm.ToolCall
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the pure helpers in [Gemma4Prompt] — prompt
 * construction, envelope parsing, and truncation heuristic. The
 * actual inference path (`LocalLlmClient.respond`) is exercised on
 * device only because it needs a Gemma 4 .litertlm bundle and a
 * working GPU/NPU dispatcher.
 *
 * The helpers are split out as top-level `internal` functions
 * specifically so they're testable here without constructing a
 * [LocalLlmClient] (which takes a Context and pulls in
 * com.google.ai.edge.litertlm types whose static initializers fail
 * outside an Android runtime).
 */
class LocalLlmClientTest {

    @Test
    fun `buildPrompt embeds system prompt and tool catalogue`() {
        val tools = listOf(
            LlmToolDef(
                name = "list_printers",
                description = "List the user's configured printers.",
                inputSchema = JSONObject("""{"type":"object","properties":{}}""")
            ),
            LlmToolDef(
                name = "paint_split_plane",
                description = "Paint the model on either side of a plane.",
                inputSchema = JSONObject(
                    """{"type":"object","properties":{
                        "model_id":{"type":"string"},
                        "plane_normal_x":{"type":"number"},
                        "tag_above":{"type":"string"}
                    },"required":["model_id","plane_normal_x"]}"""
                ),
            ),
        )
        val history = listOf(LlmTurn.User("List my printers."))
        val prompt = buildGemma4Prompt(history, tools, "You are the OrcaXR assistant.")

        assertTrue("system prompt present", prompt.contains("You are the OrcaXR assistant."))
        assertTrue("envelope instructions present", prompt.contains("\"tool\":\"<name>\""))
        assertTrue("final envelope explained", prompt.contains("\"final\":\"<your message"))
        assertTrue("list_printers in catalogue", prompt.contains("- list_printers(no args)"))
        assertTrue(
            "paint_split_plane required marked",
            prompt.contains("REQUIRED: model_id, plane_normal_x"),
        )
        assertTrue(
            "paint_split_plane optional marked",
            prompt.contains("OPTIONAL: tag_above"),
        )
        assertTrue("user turn rendered", prompt.contains("User: List my printers."))
        assertTrue("trailing Assistant: marker", prompt.trimEnd().endsWith("Assistant:"))
    }

    @Test
    fun `buildPrompt renders tool-call assistant turn as JSON envelope`() {
        val tools = emptyList<LlmToolDef>()
        val history = listOf(
            LlmTurn.User("List my printers."),
            LlmTurn.Assistant(
                text = null,
                toolCalls = listOf(
                    ToolCall(id = "call_1", name = "list_printers", args = JSONObject()),
                ),
            ),
            LlmTurn.ToolResult(
                callId = "call_1",
                name = "list_printers",
                content = "Snapmaker U1 (idle), Elegoo Centauri Carbon (printing).",
                isError = false,
            ),
        )
        val prompt = buildGemma4Prompt(history, tools, "")
        assertTrue(
            "tool-call envelope rendered",
            prompt.contains("Assistant: {") &&
                prompt.contains("\"tool\":\"list_printers\""),
        )
        assertTrue(
            "tool result rendered",
            prompt.contains("Tool result for list_printers: Snapmaker U1"),
        )
    }

    @Test
    fun `parseEnvelope reads canonical tool envelope`() {
        val raw = """{"tool":"list_printers","arguments":{}}"""
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Tool)
        parsed as ParsedEnvelope.Tool
        assertEquals("list_printers", parsed.toolName)

        val resp = envelopeToLlmResponse(parsed)
        assertNull("no prose text on tool turn", resp.text)
        assertEquals(1, resp.toolCalls.size)
        assertEquals("list_printers", resp.toolCalls[0].name)
        assertEquals("tool_use", resp.stopReason)
    }

    @Test
    fun `parseEnvelope reads canonical final envelope`() {
        val raw = """{"final":"Done — the print is queued."}"""
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Final)
        parsed as ParsedEnvelope.Final
        assertEquals("Done — the print is queued.", parsed.text)

        val resp = envelopeToLlmResponse(parsed)
        assertEquals("Done — the print is queued.", resp.text)
        assertTrue(resp.toolCalls.isEmpty())
        assertEquals("end_turn", resp.stopReason)
    }

    @Test
    fun `parseEnvelope tolerates code fences`() {
        val raw = "```json\n{\"final\":\"Hello.\"}\n```"
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Final)
        assertEquals("Hello.", (parsed as ParsedEnvelope.Final).text)
    }

    @Test
    fun `parseEnvelope tolerates smart quotes`() {
        val raw = "{“final”:“Hi.”}"
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Final)
        assertEquals("Hi.", (parsed as ParsedEnvelope.Final).text)
    }

    @Test
    fun `parseEnvelope tolerates trailing comma before brace`() {
        val raw = """{"tool":"list_printers","arguments":{},}"""
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Tool)
        assertEquals("list_printers", (parsed as ParsedEnvelope.Tool).toolName)
    }

    @Test
    fun `parseEnvelope strips leading Assistant marker`() {
        val raw = "Assistant: {\"final\":\"OK.\"}"
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Final)
        assertEquals("OK.", (parsed as ParsedEnvelope.Final).text)
    }

    @Test
    fun `parseEnvelope ignores trailing prose after balanced object`() {
        val raw = "{\"tool\":\"list_printers\",\"arguments\":{}} <end_of_turn>"
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Tool)
        assertEquals("list_printers", (parsed as ParsedEnvelope.Tool).toolName)
    }

    @Test
    fun `parseEnvelope falls back on unrecognized JSON`() {
        // Recognized object shape but neither "tool" nor "final" — we
        // surface as Fallback so the caller can decide whether to
        // retry with a continuation prompt.
        val raw = """{"comment":"I don't know what to do."}"""
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Fallback)

        val resp = envelopeToLlmResponse(parsed)
        assertNotNull(resp.text)
        assertTrue(resp.toolCalls.isEmpty())
    }

    @Test
    fun `parseEnvelope falls back on garbage`() {
        val raw = "I think you should call list_printers."
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Fallback)
        assertEquals(raw, (parsed as ParsedEnvelope.Fallback).rawText)

        val resp = envelopeToLlmResponse(parsed)
        assertEquals(raw, resp.text)
    }

    @Test
    fun `parseEnvelope captures arguments`() {
        val raw = """
            {"tool":"paint_split_plane","arguments":{"model_id":"model_abc","plane_normal_x":1.0}}
        """.trimIndent()
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Tool)
        val args = (parsed as ParsedEnvelope.Tool).args
        assertEquals("model_abc", args.optString("model_id"))
        assertEquals(1.0, args.optDouble("plane_normal_x"), 1e-9)
    }

    @Test
    fun `parseEnvelope strips Gemma 4 thinking block`() {
        val raw = "<|think|>let me think about this<|/think|>{\"final\":\"OK.\"}"
        val parsed = parseGemma4Envelope(raw)
        assertTrue(parsed is ParsedEnvelope.Final)
        assertEquals("OK.", (parsed as ParsedEnvelope.Final).text)
    }

    // -------------- looksTruncated heuristic --------------

    @Test
    fun `looksTruncated true when output cuts off mid-token`() {
        val raw = "I think you should call list_print"
        assertTrue(looksTruncated(raw))
    }

    @Test
    fun `looksTruncated false when output ends with closing brace`() {
        // Even if it isn't a recognized envelope (e.g. comment
        // shape), a balanced object means we have a complete
        // structure — no continuation will help.
        val raw = """{"comment":"done"}"""
        assertFalse(looksTruncated(raw))
    }

    @Test
    fun `looksTruncated false when output ends with terminal punctuation`() {
        val raw = "I'm not sure what you mean."
        assertFalse(looksTruncated(raw))
    }

    @Test
    fun `looksTruncated false on empty input`() {
        assertFalse(looksTruncated(""))
    }
}
