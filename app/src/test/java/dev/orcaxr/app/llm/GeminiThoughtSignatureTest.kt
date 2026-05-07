package dev.orcaxr.app.llm

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression for the second Gemini 400 (2026-05-08):
 *
 * ```
 * Function call is missing a thought_signature in functionCall parts.
 * This is required for tools to work correctly...
 *   function call `default_api:get_workspace_state`, position 2.
 * ```
 *
 * Gemini 3 / 2.5 thinking models attach a base64 `thoughtSignature` to
 * every emitted `functionCall` part. The signature MUST round-trip to
 * the next-turn request body or the API rejects the conversation as
 * tampered-with. We were stripping it.
 *
 * The fix lives in two places: the response parser captures the
 * signature into [ToolCall.providerMeta], and [GeminiLlmClient
 * .toGeminiContents] re-attaches it (on both the outer part AND the
 * inner `functionCall` object — Google has shipped both shapes;
 * sending both is robust against future server-side changes).
 *
 * These tests pin the round-trip so a refactor that drops
 * `providerMeta` plumbing fails CI.
 */
class GeminiThoughtSignatureTest {

    private val sut = GeminiLlmClient(apiKey = "test-key-not-used")

    @Test
    fun toolCallWithSignatureLandsOnOuterPartOnly() {
        // 2026-05-08: the field 400 evolved twice. First Gemini said
        // "missing thought_signature" → we added it. Then it said
        //   `Unknown name "thoughtSignature" at
        //     contents[N].parts[M].function_call: Cannot find field`
        // when we put the signature INSIDE the functionCall object.
        // The corrected shape: outer part only, never on the inner
        // functionCall.
        val sig = "abc123_signature_blob"
        val history =
            listOf(
                LlmTurn.User("hello"),
                LlmTurn.Assistant(
                    text = null,
                    toolCalls =
                        listOf(
                            ToolCall(
                                id = "gemini_xyz",
                                name = "get_workspace_state",
                                args = JSONObject(),
                                providerMeta = JSONObject().put("thoughtSignature", sig),
                            )
                        ),
                ),
            )
        val contents = sut.toGeminiContents(history)
        assertEquals("user + model turns", 2, contents.size)

        val modelParts = contents[1].getJSONArray("parts")
        assertEquals(1, modelParts.length())
        val part = modelParts.getJSONObject(0)

        // Outer part carries the signature.
        assertEquals(
            "outer part signature",
            sig,
            part.getString("thoughtSignature"),
        )
        // Inner functionCall must NOT carry it — Gemini's schema
        // validator rejects the nested placement.
        val fc = part.getJSONObject("functionCall")
        assertTrue(
            "inner functionCall must NOT carry signature",
            !fc.has("thoughtSignature"),
        )
        assertEquals("name preserved", "get_workspace_state", fc.getString("name"))
    }

    @Test
    fun toolCallWithoutSignatureSerializesCleanly() {
        // Non-thinking models (or older Gemini Flash variants) don't
        // emit thoughtSignature. The history serializer must NOT
        // synthesize one — we'd be sending a key Gemini didn't ask
        // for, AND lying about a thinking trace we didn't have.
        val history =
            listOf(
                LlmTurn.Assistant(
                    text = null,
                    toolCalls =
                        listOf(
                            ToolCall(
                                id = "gemini_no_sig",
                                name = "get_workspace_state",
                                args = JSONObject(),
                                providerMeta = null,
                            )
                        ),
                )
            )
        val contents = sut.toGeminiContents(history)
        val part = contents[0].getJSONArray("parts").getJSONObject(0)
        assertTrue(
            "no outer signature when meta absent",
            !part.has("thoughtSignature"),
        )
        val fc = part.getJSONObject("functionCall")
        assertTrue(
            "no inner signature when meta absent",
            !fc.has("thoughtSignature"),
        )
    }

    @Test
    fun toolResultRoundTripUsesFunctionResponseShape() {
        // Sanity: the tool-result echo back to Gemini stays in the
        // `functionResponse` shape (different from functionCall) and
        // doesn't accidentally pick up a signature from somewhere.
        val history =
            listOf(
                LlmTurn.ToolResult(
                    callId = "gemini_xyz",
                    name = "get_workspace_state",
                    content = "{ \"ok\": true }",
                    isError = false,
                )
            )
        val contents = sut.toGeminiContents(history)
        val part = contents[0].getJSONArray("parts").getJSONObject(0)
        assertNotNull(part.optJSONObject("functionResponse"))
        assertTrue(
            "no signature on functionResponse",
            !part.has("thoughtSignature"),
        )
    }

    @Test
    fun providerMetaSurvivesDataClassCopy() {
        // A defensive check that ToolCall.providerMeta is a normal
        // field of the data class (not @Transient or otherwise
        // skipped). If a future refactor accidentally drops it, this
        // test fails before the wire test does.
        val original =
            ToolCall(
                id = "x",
                name = "n",
                args = JSONObject(),
                providerMeta = JSONObject().put("thoughtSignature", "sig"),
            )
        val copied = original.copy(name = "n2")
        assertEquals("sig", copied.providerMeta?.optString("thoughtSignature"))
    }
}
